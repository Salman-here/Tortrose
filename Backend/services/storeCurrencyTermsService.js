'use strict';

const crypto = require('crypto');
const ShippingMethod = require('../models/ShippingMethod');
const Coupon = require('../models/Coupon');
const { isSupportedCurrency, convertAmountUsingTrustedRates } = require('./currencyService');
const { roundMoney } = require('./moneyMath');
const { canonicalCouponTerms } = require('./couponTermsService');

const plain = value => value?.toObject ? value.toObject() : value;
const conflict = (message) => Object.assign(new Error(message), {
  status: 409, statusCode: 409, code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT',
});
const currency = value => {
  if (!isSupportedCurrency(value) || value !== String(value).toUpperCase()) {
    throw conflict('Stored shipping or coupon currency is invalid. Correct it before changing store currency.');
  }
  return value;
};
const amount = (value, label, nullable = false) => {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || roundMoney(value) !== value) {
    throw conflict(`Stored ${label} is invalid. No store prices were changed.`);
  }
  return value;
};
const shippingTerms = doc => doc ? {
  id: String(doc._id),
  methods: (plain(doc).methods || []).map(method => ({
    id: String(method._id || ''), type: method.type, cost: method.cost,
    currency: method.currency, costCurrency: method.costCurrency,
    costInputAmount: method.costInputAmount, deliveryDays: method.deliveryDays, isActive: method.isActive,
  })),
} : null;
const fingerprint = ({ shipping, coupons }) => crypto.createHash('sha256').update(JSON.stringify({
  shipping: shippingTerms(shipping),
  coupons: coupons.map(canonicalCouponTerms).sort((a, b) => a.couponId.localeCompare(b.couponId)),
})).digest('hex');

async function readStoreCurrencyTerms(sellerId, session = null) {
  const query = value => session ? value.session(session) : value;
  const [shipping, coupons] = await Promise.all([
    query(ShippingMethod.findOne({ seller: sellerId })).lean(),
    query(Coupon.find({ seller: sellerId })).lean(),
  ]);
  return { shipping, coupons, fingerprint: fingerprint({ shipping, coupons }) };
}

async function convertStoreCurrencyTerms(terms, targetCurrency, rateSnapshot) {
  const convert = async (value, source, label, nullable = false) => {
    const input = amount(value, label, nullable);
    if (input === null) return null;
    const output = await convertAmountUsingTrustedRates(input, currency(source), targetCurrency, rateSnapshot);
    if (input > 0 && output <= 0) throw conflict(`${label} would round to zero. Adjust it before changing store currency.`);
    return output;
  };
  let shipping = null;
  const shippingExamples = [];
  if (terms.shipping) {
    if (!Array.isArray(terms.shipping.methods) || !terms.shipping.methods.length) throw conflict('Stored shipping methods are invalid.');
    shipping = { id: String(terms.shipping._id), methods: [] };
    for (const method of terms.shipping.methods) {
      // Currency-less legacy shipping was denominated in USD, never the new store currency.
      const source = currency(method.currency ?? method.costCurrency ?? 'USD');
      if (method.costCurrency && method.costCurrency !== source) throw conflict('Shipping currency metadata conflicts.');
      const sourceCost = amount(method.cost, 'shipping fee');
      if (method.costInputAmount != null && method.costInputAmount !== sourceCost) throw conflict('Shipping fee metadata conflicts.');
      const cost = await convert(sourceCost, source, `${method.type} shipping`);
      shipping.methods.push({ ...method, cost, currency: targetCurrency, costCurrency: targetCurrency, costInputAmount: cost });
      shippingExamples.push({ type: method.type, fromCurrency: source, fromAmount: sourceCost, toAmount: cost, isActive: method.isActive });
    }
    await new ShippingMethod({ ...terms.shipping, methods: shipping.methods }).validate();
  }
  const coupons = [];
  for (const doc of terms.coupons) {
    const source = currency(doc.currency);
    if (!['fixed', 'percentage'].includes(doc.discountType) || typeof doc.discountValue !== 'number'
        || !Number.isFinite(doc.discountValue) || doc.discountValue <= 0
        || doc.discountType === 'percentage' && (doc.discountValue > 100 || roundMoney(doc.discountValue, 6) !== doc.discountValue)) {
      throw conflict('Stored coupon discount is invalid. Correct it before changing store currency.');
    }
    const changes = {
      currency: targetCurrency,
      discountValue: doc.discountType === 'fixed'
        ? await convert(doc.discountValue, source, `Coupon ${doc.code} discount`) : doc.discountValue,
      minOrderAmount: await convert(doc.minOrderAmount ?? 0, source, `Coupon ${doc.code} minimum`),
      maxDiscountAmount: await convert(doc.maxDiscountAmount, source, `Coupon ${doc.code} cap`, true),
    };
    await new Coupon({ ...doc, ...changes }).validate();
    coupons.push({ id: String(doc._id), code: doc.code, discountType: doc.discountType, fromCurrency: source,
      from: { discountValue: doc.discountValue, minOrderAmount: doc.minOrderAmount, maxDiscountAmount: doc.maxDiscountAmount }, changes });
  }
  return { fingerprint: terms.fingerprint, shipping, coupons, shippingExamples, couponExamples: coupons.slice(0, 3) };
}

async function commitStoreCurrencyTerms(sellerId, plan, session) {
  if (!plan) throw conflict('This preview predates shipping/coupon conversion. Review a fresh store-currency preview.');
  const current = await readStoreCurrencyTerms(sellerId, session);
  if (current.fingerprint !== plan.fingerprint) throw conflict('Shipping or coupon settings changed after preview. Review a fresh preview; nothing was converted.');
  if (plan.shipping) {
    const result = await ShippingMethod.updateOne({ _id: plan.shipping.id, seller: sellerId }, {
      $set: { methods: plan.shipping.methods }, $inc: { __v: 1 },
    }, { session, runValidators: true });
    if (result.matchedCount !== 1) throw conflict('Shipping changed during conversion. No prices were changed.');
  }
  for (const coupon of plan.coupons) {
    // Preserve live redemption counters and all non-money coupon terms.
    const result = await Coupon.updateOne({ _id: coupon.id, seller: sellerId }, {
      $set: coupon.changes, $inc: { __v: 1 },
    }, { session, runValidators: false }); // Full merged documents validated in preview; term fingerprint checked above.
    if (result.matchedCount !== 1) throw conflict('A coupon changed during conversion. No prices were changed.');
  }
}

module.exports = { readStoreCurrencyTerms, convertStoreCurrencyTerms, commitStoreCurrencyTerms };
