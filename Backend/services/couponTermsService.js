'use strict';

const crypto = require('crypto');

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const toIso = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};
const optionalNumber = value => (
  value === null || value === undefined || value === '' ? null : Number(value)
);

const canonicalCouponTerms = coupon => ({
  couponId: toId(coupon?._id),
  seller: toId(coupon?.seller),
  code: String(coupon?.code || '').trim().toUpperCase(),
  discountType: String(coupon?.discountType || ''),
  discountValue: Number(coupon?.discountValue || 0),
  currency: String(coupon?.currency || 'USD').trim().toUpperCase(),
  applicableTo: String(coupon?.applicableTo || 'all'),
  applicableProducts: [...new Set((coupon?.applicableProducts || []).map(toId).filter(Boolean))].sort(),
  maxUses: optionalNumber(coupon?.maxUses),
  maxUsesPerUser: Number(coupon?.maxUsesPerUser || 1),
  minOrderAmount: Number(coupon?.minOrderAmount || 0),
  maxDiscountAmount: optionalNumber(coupon?.maxDiscountAmount),
  startDate: toIso(coupon?.startDate),
  expiryDate: toIso(coupon?.expiryDate),
  isActive: coupon?.isActive === true,
});

const couponTermsFingerprint = coupon => crypto
  .createHash('sha256')
  .update(JSON.stringify(canonicalCouponTerms(coupon)))
  .digest('hex');

module.exports = {
  canonicalCouponTerms,
  couponTermsFingerprint,
};
