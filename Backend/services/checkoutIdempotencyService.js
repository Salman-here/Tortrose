'use strict';

const crypto = require('crypto');
const { normalizeCurrency } = require('./currencyService');

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

const checkoutRequestFingerprint = (order, paymentFlow, clientSurface) => {
  const items = (order?.orderItems || []).map(item => ({
    id: String(item.id || item.productId || ''),
    quantity: Math.max(1, Number(item.quantity) || 1),
    selectedColor: item.selectedColor || null,
    selectedOptions: canonicalize(item.selectedOptions || {}),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const coupons = (order?.appliedCoupons || []).map(coupon => ({
    id: String(coupon.couponId || coupon._id || ''),
    code: String(coupon.code || '').trim().toUpperCase(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const payload = canonicalize({
    items,
    coupons,
    currency: normalizeCurrency(order?.currency || 'USD'),
    shippingInfo: order?.shippingInfo || {},
    shippingMethod: order?.shippingMethod || {},
    sellerShipping: order?.sellerShipping || [],
    paymentMethod: order?.paymentMethod || '',
    paymentFlow,
    clientSurface,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

module.exports = { checkoutRequestFingerprint };
