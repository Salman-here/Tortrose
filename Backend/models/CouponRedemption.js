'use strict';

const mongoose = require('mongoose');
const { roundMoney } = require('../services/moneyMath');
const { parseStrictFiniteNumber } = require('../services/numericInputService');

const strictNumberSetter = value => {
  if (value === null || value === undefined) return value;
  const parsed = parseStrictFiniteNumber(value);
  return parsed === null ? Number.NaN : parsed;
};

const isExactPositiveMoney = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return false;
  try {
    return roundMoney(value) === value;
  } catch (_) {
    return false;
  }
};

const couponRedemptionSchema = new mongoose.Schema({
  coupon: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Coupon',
    required: true,
    immutable: true,
  },
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    immutable: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
  },
  status: {
    type: String,
    enum: ['reserved', 'consumed', 'released'],
    required: true,
    default: 'reserved',
    index: true,
  },
  couponTermsFingerprint: {
    type: String,
    required: true,
    immutable: true,
    minlength: 64,
    maxlength: 64,
    match: /^[a-f0-9]{64}$/,
  },
  couponCode: {
    type: String,
    required: true,
    immutable: true,
    uppercase: true,
    trim: true,
    match: /^[A-Z0-9_-]{3,32}$/,
  },
  appliedDiscountAmount: {
    type: Number,
    required: true,
    min: 0.01,
    immutable: true,
    set: strictNumberSetter,
    validate: {
      validator: isExactPositiveMoney,
      message: 'Coupon redemption amount must be finite, safe, positive, and exact to cents',
    },
  },
  currency: {
    type: String,
    required: true,
    enum: ['USD', 'PKR', 'EUR', 'GBP'],
    uppercase: true,
    trim: true,
    immutable: true,
  },
  reservedAt: { type: Date, required: true, default: Date.now, immutable: true },
  consumedAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  releaseReason: { type: String, default: '', maxlength: 500 },
}, { timestamps: true });

couponRedemptionSchema.index(
  { coupon: 1, order: 1 },
  { unique: true, name: 'uniq_coupon_order_redemption' },
);
couponRedemptionSchema.index({ order: 1, status: 1 });
couponRedemptionSchema.index({ coupon: 1, user: 1, status: 1 });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
