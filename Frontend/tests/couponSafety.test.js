import test from 'node:test';
import assert from 'node:assert/strict';
import {
  couponAnalyticsResponseIsValid,
  inspectCouponPresentation,
  isExactCouponMoneyInput,
  isExactCouponPercentageInput,
  isPositiveCouponCountInput,
} from '../src/utils/couponSafety.js';

const coupon = (overrides = {}) => ({
  _id: '64b000000000000000000001',
  code: 'SAVE20',
  discountType: 'fixed',
  discountValue: 20,
  currency: 'PKR',
  applicableTo: 'selected',
  applicableProducts: [{ _id: '64b000000000000000000002' }],
  maxUses: 10,
  usedCount: 2,
  maxUsesPerUser: 1,
  minOrderAmount: 100,
  maxDiscountAmount: null,
  startDate: '2026-08-01T00:00:00.000Z',
  expiryDate: '2026-09-01T00:00:00.000Z',
  isActive: true,
  ...overrides,
});

const analytics = () => ({
  summary: {
    currency: 'PKR',
    totalCoupons: 1,
    activeCoupons: 1,
    totalUses: 2,
    totalRevenueFromCoupons: 1500.25,
    totalDiscountGiven: 100.25,
    topCouponCode: 'SAVE',
  },
  analytics: [{
    _id: 'coupon-1',
    code: 'SAVE',
    discountType: 'fixed',
    discountValue: 50.25,
    currency: 'PKR',
    usedCount: 2,
    maxUses: 10,
    ordersGenerated: 2,
    uniqueUsers: 2,
    totalRevenue: 1500.25,
    totalDiscount: 100.25,
    avgOrderValue: 750.13,
    conversionRate: 20,
  }],
});

test('coupon input predicates reject sub-cent money and fractional counts', () => {
  assert.equal(isExactCouponMoneyInput('1.23'), true);
  assert.equal(isExactCouponMoneyInput('1.234'), false);
  assert.equal(isExactCouponMoneyInput('0', { allowZero: true }), true);
  assert.equal(isExactCouponPercentageInput('0.010001'), true);
  assert.equal(isExactCouponPercentageInput('0.0100001'), false);
  assert.equal(isPositiveCouponCountInput('2'), true);
  assert.equal(isPositiveCouponCountInput('2.5'), false);
});

test('coupon analytics require the requested currency and exact internally consistent money', () => {
  const valid = analytics();
  assert.equal(couponAnalyticsResponseIsValid(valid, 'PKR'), true);
  assert.equal(couponAnalyticsResponseIsValid(valid, 'USD'), false);
  assert.equal(couponAnalyticsResponseIsValid({
    ...valid,
    summary: { ...valid.summary, totalRevenueFromCoupons: 1500.251 },
  }, 'PKR'), false);
  assert.equal(couponAnalyticsResponseIsValid({
    ...valid,
    analytics: [{ ...valid.analytics[0], totalDiscount: '100.25' }],
  }, 'PKR'), false);
});

test('coupon cards require a complete exact native-money and usage snapshot', () => {
  assert.equal(inspectCouponPresentation(coupon()).valid, true);
  for (const invalid of [
    coupon({ discountValue: '20' }),
    coupon({ currency: 'USD', discountValue: 20.001 }),
    coupon({ usedCount: '2' }),
    coupon({ usedCount: 11 }),
    coupon({ applicableProducts: [{ _id: 'product-1' }] }),
    coupon({ expiryDate: '2026-07-01T00:00:00.000Z' }),
  ]) {
    const result = inspectCouponPresentation(invalid);
    assert.equal(result.valid, false);
    assert.equal(result.currency, null);
    assert.equal(result.discountValue, null);
  }
});
