'use strict';

const crypto = require('crypto');
const { canonicalizeShippingPhone } = require('./orderBuyerContactService');
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return typeof value === 'string' ? value.trim() : value;
};

const requestedQuantity = value => (
  value === undefined || value === null || value === '' ? 1 : Number(value)
);

const canonicalShippingInfo = shippingInfo => {
  const normalized = canonicalize(shippingInfo || {});
  if (typeof normalized.email === 'string') {
    // Email identity is case-insensitive. Match the guest idempotency scope so
    // a case-only retry cannot look like a different checkout payload.
    normalized.email = normalized.email.toLowerCase();
  }
  try {
    const phone = canonicalizeShippingPhone(normalized);
    normalized.phone = phone.e164;
    normalized.countryCode = phone.countryCode;
  } catch (_) {
    // Validation still owns malformed input. Retaining the raw canonical value
    // here keeps fingerprint construction non-throwing while valid formatting
    // variants converge on the same checkout attempt identity.
  }
  return normalized;
};

const checkoutRequestFingerprint = (
  order,
  paymentFlow,
  clientSurface,
  { resolvedCurrency } = {},
) => {
  const items = (Array.isArray(order?.orderItems) ? order.orderItems : []).map(item => ({
    id: String(item?.id || item?.productId || ''),
    quantity: requestedQuantity(item?.quantity),
    selectedColor: item?.selectedColor || null,
    selectedOptions: canonicalize(item?.selectedOptions || {}),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const coupons = (Array.isArray(order?.appliedCoupons) ? order.appliedCoupons : []).map(coupon => ({
    id: String(coupon?.couponId || coupon?._id || ''),
    code: String(coupon?.code || '').trim().toUpperCase(),
    applicableProductIds: [...new Set((Array.isArray(coupon?.applicableProductIds) ? coupon.applicableProductIds : [])
      .map(id => String(id || '').trim())
      .filter(Boolean))].sort(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const sellerShipping = (Array.isArray(order?.sellerShipping) ? order.sellerShipping : []).map(entry => ({
    seller: String(entry?.seller || ''),
    method: String(entry?.shippingMethod?.name || entry?.shippingMethod?.type || '').trim().toLowerCase(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const payload = canonicalize({
    items,
    coupons,
    currency: String(resolvedCurrency ?? order?.currency ?? 'USD').trim().toUpperCase(),
    shippingInfo: canonicalShippingInfo(order?.shippingInfo),
    buyerLocation: order?.buyerLocation || {},
    shippingMethod: {
      seller: String(order?.shippingMethod?.seller || ''),
      method: String(order?.shippingMethod?.name || order?.shippingMethod?.type || '').trim().toLowerCase(),
    },
    sellerShipping,
    paymentMethod: order?.paymentMethod || '',
    instructions: order?.instructions || '',
    paymentFlow,
    clientSurface,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

module.exports = { checkoutRequestFingerprint };
