'use strict';

const mongoose = require('mongoose');
const Coupon = require('../../models/Coupon');
const CouponRedemption = require('../../models/CouponRedemption');

const baseCoupon = overrides => new Coupon({
  seller: new mongoose.Types.ObjectId(),
  code: 'VALID10',
  discountType: 'percentage',
  discountValue: 10,
  expiryDate: new Date(Date.now() + 60_000),
  ...overrides,
});

describe('coupon usage schema integrity', () => {
  test.each([
    [{ maxUses: 1.5 }, 'maxUses'],
    [{ maxUsesPerUser: 0 }, 'maxUsesPerUser'],
    [{ usedCount: -1 }, 'usedCount'],
    [{ usedBy: [{ user: new mongoose.Types.ObjectId(), count: 0 }] }, 'usedBy.0.count'],
  ])('rejects invalid usage counters: %p', (override, expectedPath) => {
    const error = baseCoupon(override).validateSync();
    expect(error?.errors?.[expectedPath]).toBeDefined();
  });

  test('requires an authenticated user on every redemption', () => {
    const redemption = new CouponRedemption({
      coupon: new mongoose.Types.ObjectId(),
      order: new mongoose.Types.ObjectId(),
      status: 'reserved',
      couponTermsFingerprint: 'a'.repeat(64),
      couponCode: 'VALID10',
      appliedDiscountAmount: 10,
      currency: 'USD',
    });
    expect(redemption.validateSync()?.errors).toHaveProperty('user');
  });

  test.each([true, '', Number.POSITIVE_INFINITY, 10.001, Number.MAX_SAFE_INTEGER])(
    'rejects unsafe coupon redemption amount %p',
    value => {
      const redemption = new CouponRedemption({
        coupon: new mongoose.Types.ObjectId(),
        order: new mongoose.Types.ObjectId(),
        user: new mongoose.Types.ObjectId(),
        status: 'reserved',
        couponTermsFingerprint: 'a'.repeat(64),
        couponCode: 'VALID10',
        appliedDiscountAmount: value,
        currency: 'USD',
      });
      expect(redemption.validateSync()?.errors).toHaveProperty('appliedDiscountAmount');
    },
  );

  test.each(['CAD', ''])('rejects unsupported redemption currency %p', currency => {
    const redemption = new CouponRedemption({
      coupon: new mongoose.Types.ObjectId(),
      order: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
      status: 'reserved',
      couponTermsFingerprint: 'a'.repeat(64),
      couponCode: 'VALID10',
      appliedDiscountAmount: 10,
      currency,
    });
    expect(redemption.validateSync()?.errors).toHaveProperty('currency');
  });

  test.each([
    [{ currency: 'CAD' }, 'currency'],
    [{ discountType: 'percentage', discountValue: 100.01 }, 'discountValue'],
    [{ code: 'not valid!' }, 'code'],
    [{ minOrderAmount: -0.01 }, 'minOrderAmount'],
    [{ minOrderAmount: 0.001 }, 'minOrderAmount'],
    [{ maxDiscountAmount: 0 }, 'maxDiscountAmount'],
    [{ maxDiscountAmount: 1.001 }, 'maxDiscountAmount'],
    [{ discountType: 'fixed', discountValue: 1.001 }, 'discountValue'],
    [{ discountType: 'fixed', discountValue: true }, 'discountValue'],
    [{ discountType: 'percentage', discountValue: 10.0000001 }, 'discountValue'],
    [{ startDate: new Date(Date.now() + 120_000), expiryDate: new Date(Date.now() + 60_000) }, 'expiryDate'],
  ])('rejects invalid coupon money/terms: %p', (override, expectedPath) => {
    const error = baseCoupon(override).validateSync();
    expect(error?.errors?.[expectedPath]).toBeDefined();
  });

  test('preserves an exact fixed coupon amount at the model boundary', async () => {
    const coupon = baseCoupon({ discountType: 'fixed', discountValue: 1.01 });
    await expect(coupon.validate()).resolves.toBeUndefined();
    expect(coupon.discountValue).toBe(1.01);
  });
});
