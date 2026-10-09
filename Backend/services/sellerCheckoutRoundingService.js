'use strict';

const { isDeepStrictEqual } = require('node:util');
const { allocateCheckoutMinorUnitsByRates, allocateMinorUnitsByWeights, fromMinorUnits, sumMoney, toMinorUnits, multiplyMoney, convertMoneyByRates } = require('./moneyMath');
const { getAccountingOrderCurrency, getOrderExchangeRates, buildNativeSellerCurrencyComponents,
  sellerCurrencyItemRows, sellerNativeShipping, sellerNativeDiscount } = require('./orderMoneyService');

const POLICY_VERSION = 1;
const RULE = 'seller_total_ceiling';
const id = value => String(value?._id || value || '');
const fail = message => Object.assign(new Error(message), { code: 'SELLER_CHECKOUT_ROUNDING_INVALID', statusCode: 409 });

function sellerQuote(row, currency, rates, buyerTaxMinor) {
  if (!rates || !(rates[currency] > 0) || !(rates[row.currency] > 0)) throw fail('Trusted checkout rates are required for seller pricing.');
  if (!Number.isSafeInteger(buyerTaxMinor) || buyerTaxMinor < 0
      || toMinorUnits(convertMoneyByRates(fromMinorUnits(buyerTaxMinor),rates[currency],rates[row.currency])) !== row.taxMinor) {
    throw fail('The seller tax does not match its frozen buyer tax allocation.');
  }
  const nativeSale = sumMoney([fromMinorUnits(row.subtotalMinor),fromMinorUnits(row.shippingMinor),-fromMinorUnits(row.discountMinor)]);
  const result = allocateCheckoutMinorUnitsByRates([
    { key: row.seller, amount:nativeSale, sourceRate:rates[row.currency] },
    // Admin tax is already priced in buyer cents. Preserve those tax cents;
    // converting a rounded native tax BACK to the buyer would round it twice.
    { key:'tax', amount:fromMinorUnits(buyerTaxMinor), sourceRate:rates[currency] },
  ], rates[currency]);
  return { seller: id(row.seller), nativeCurrency: row.currency, nativeTotalMinor: row.totalMinor,
    buyerTotalMinor: result.totalMinor, exactBuyerMinor: result.exactTotalMinor, remainderMinor: result.remainderMinor };
}

function componentQuote(order, row, quote) {
  const currency = getAccountingOrderCurrency(order), rates = getOrderExchangeRates(order);
  const items = order.orderItems.filter(item => id(item.seller) === id(row.seller));
  const itemRows = sellerCurrencyItemRows(order, items, row.currency);
  if (itemRows.some(item => item.sourceAmount !== multiplyMoney(item.item.sourcePrice, item.item.quantity))
      || toMinorUnits(sumMoney(itemRows.map(item => item.targetAmount))) !== row.subtotalMinor
      || toMinorUnits(sellerNativeShipping(order, row.seller, row.currency, { shippingCost:0 })) !== row.shippingMinor
      || toMinorUnits(sellerNativeDiscount(order, row.seller, row.currency, { couponDiscount:0 })) !== row.discountMinor) {
    throw fail('The native order components do not match their original product, shipping and coupon amounts.');
  }
  const components = allocateCheckoutMinorUnitsByRates([
    ...itemRows.map(item => ({ key: `item:${item.orderIndex}`, amount: item.targetAmount, sourceRate: rates[row.currency] })),
    { key:'shipping', amount:fromMinorUnits(row.shippingMinor), sourceRate:rates[row.currency] },
    { key:'tax', amount:fromMinorUnits(quote.buyerTaxMinor), sourceRate:rates[currency] },
    { key:'discount', amount:-fromMinorUnits(row.discountMinor), sourceRate:rates[row.currency] },
  ], rates[currency], 2, { targetTotalMinor:quote.buyerTotalMinor });
  const buyerComponents = {
    subtotalMinor:toMinorUnits(sumMoney(itemRows.map(item => fromMinorUnits(components.allocations.get(`item:${item.orderIndex}`))))),
    shippingMinor:components.allocations.get('shipping') || 0,
    taxMinor:components.allocations.get('tax') || 0,
    discountMinor:-(components.allocations.get('discount') || 0),
  };
  return { itemRows, components, buyerComponents };
}

function buildSnapshot(order, rows, taxBySeller = null) {
  const currency = getAccountingOrderCurrency(order), rates = getOrderExchangeRates(order);
  const sellers = [...rows].sort((a, b) => id(a.seller).localeCompare(id(b.seller))).map(row => {
    const buyerTaxMinor = taxBySeller ? taxBySeller.get(id(row.seller))
      : order.checkoutRoundingSnapshot?.sellers?.find(entry => entry.seller === id(row.seller))?.buyerComponents?.taxMinor;
    const quote = { ...sellerQuote(row,currency,rates,buyerTaxMinor), buyerTaxMinor };
    const { buyerTaxMinor: ignoredTaxBasis, ...record } = quote;
    return { ...record, buyerComponents:componentQuote(order,row,quote).buyerComponents };
  });
  const totalMinor = toMinorUnits(sumMoney(sellers.map(row => fromMinorUnits(row.buyerTotalMinor))));
  return { version: POLICY_VERSION, rule: RULE, currency, collector: order.paymentMethod === 'cash_on_delivery' ? 'seller' : 'platform', totalMinor, sellers };
}

function validateSellerCheckoutRounding(order, rows) {
  const expected = buildSnapshot(order, rows);
  if (!isDeepStrictEqual(order.checkoutRoundingSnapshot, expected)
      || toMinorUnits(order.orderSummary.totalAmount) !== expected.totalMinor
      || expected.sellers.some(row => rows.find(entry => id(entry.seller) === row.seller)?.buyerTotalMinor !== row.buyerTotalMinor)) {
    throw fail('The saved checkout rounding does not match the frozen native seller amounts.');
  }
  for (const row of rows) {
    const quote = expected.sellers.find(entry => entry.seller === id(row.seller));
    const { itemRows, components } = componentQuote(order,row,{ ...quote,buyerTaxMinor:quote.buyerComponents.taxMinor });
    const shipping = (order.sellerShipping || []).find(entry => id(entry.seller) === id(row.seller));
    const coupons = (order.appliedCoupons || []).filter(entry => id(entry.seller) === id(row.seller));
    if (itemRows.some(item => toMinorUnits(item.item.lineSubtotal) !== components.allocations.get(`item:${item.orderIndex}`))
        || toMinorUnits(shipping?.shippingMethod?.price || 0) !== quote.buyerComponents.shippingMinor
        || toMinorUnits(sumMoney(coupons.map(coupon => coupon.appliedDiscountAmount))) !== quote.buyerComponents.discountMinor) {
      throw fail('The frozen buyer invoice does not match its seller allocation.');
    }
  }
  for (const [field, component] of [['subtotal','subtotalMinor'],['shippingCost','shippingMinor'],['tax','taxMinor'],['couponDiscount','discountMinor']]) {
    if (toMinorUnits(order.orderSummary[field]) !== toMinorUnits(sumMoney(expected.sellers.map(row => fromMinorUnits(row.buyerComponents[component]))))) {
      throw fail('The frozen buyer summary does not match its seller components.');
    }
  }
  return expected;
}

// Called only for NEW checkout quotes/orders. Products, shipping, tax and
// native coupon discounts are frozen before each complete seller portion is
// converted directly and rounded upward once. Buyer components are apportioned
// to that budget, so every visible sum reconciles without an extra fee label.
function priceSellerNativeCheckout(order) {
  order = order.toObject ? order.toObject() : order;
  const currency = getAccountingOrderCurrency(order), rates = getOrderExchangeRates(order);
  const groups = new Map();
  (order.orderItems || []).forEach(item => {
    const seller = id(item.seller);
    if (!seller) throw fail('Every new checkout item needs a seller owner.');
    if (!groups.has(seller)) groups.set(seller, []);
    groups.get(seller).push(item);
  });
  const nativeGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([seller, items]) =>
    buildNativeSellerCurrencyComponents(order, seller, items));
  const snapshot = buildSnapshot(order,nativeGroups.map(group => group.row),new Map(nativeGroups.map(group => [group.row.seller,group.buyerTaxMinor])));
  const orderItems = (order.orderItems || []).map(item => ({ ...item }));
  const sellerShipping = (order.sellerShipping || []).map(row => ({ ...row, shippingMethod: { ...row.shippingMethod } }));
  const appliedCoupons = (order.appliedCoupons || []).map(row => ({ ...row }));
  const buyerTax = [];
  const sellerCurrencyMoney = nativeGroups.map(({ row, itemRows }) => {
    const quote = snapshot.sellers.find(entry => entry.seller === row.seller);
    const { components } = componentQuote(order,row,{ ...quote,buyerTaxMinor:quote.buyerComponents.taxMinor });
    itemRows.forEach(item => { orderItems[item.orderIndex].lineSubtotal = fromMinorUnits(components.allocations.get(`item:${item.orderIndex}`)); });
    const shipping = sellerShipping.find(entry => id(entry.seller) === row.seller);
    const shippingMinor = components.allocations.get('shipping') || 0;
    if (!shipping && shippingMinor) throw fail('Seller shipping has no durable owner.');
    if (shipping) shipping.shippingMethod.price = fromMinorUnits(shippingMinor);
    buyerTax.push(fromMinorUnits(components.allocations.get('tax') || 0));
    const discounts = appliedCoupons.filter(coupon => id(coupon.seller) === row.seller);
    const buyerDiscountMinor = -(components.allocations.get('discount') || 0);
    if (!discounts.length && buyerDiscountMinor) throw fail('The seller discount has no durable coupon owner.');
    const allocated = allocateMinorUnitsByWeights(buyerDiscountMinor, discounts.map(coupon =>
      ({ key: id(coupon.couponId), weight: coupon.appliedDiscountAmount })));
    discounts.forEach(coupon => {
      coupon.appliedDiscountAmount = fromMinorUnits(allocated.get(id(coupon.couponId)) || 0);
      if (coupon.appliedDiscountAmount <= 0) throw fail('This coupon is too small in the selected checkout currency.');
    });
    return { ...row, buyerTotalMinor: quote.buyerTotalMinor };
  });
  const summary = {
    subtotal: sumMoney(orderItems.map(item => item.lineSubtotal)),
    shippingCost: sumMoney(sellerShipping.map(row => row.shippingMethod.price)),
    tax: sumMoney(buyerTax), couponDiscount: sumMoney(appliedCoupons.map(row => row.appliedDiscountAmount)),
    totalAmount: fromMinorUnits(snapshot.totalMinor),
  };
  if (summary.couponDiscount > summary.subtotal || sumMoney([summary.subtotal, summary.shippingCost, summary.tax, -summary.couponDiscount]) !== summary.totalAmount) {
    throw fail('Checkout components do not reconcile with the seller portions.');
  }
  return { orderItems, sellerShipping, appliedCoupons, orderSummary: summary,
    sellerCurrencyMoney, checkoutRoundingSnapshot: snapshot };
}

module.exports = { POLICY_VERSION, RULE, priceSellerNativeCheckout, validateSellerCheckoutRounding };
