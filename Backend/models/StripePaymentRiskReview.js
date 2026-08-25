'use strict';

const mongoose = require('mongoose');

const CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];
const nullableStrictMinorSetter = value => (
  value === null || value === undefined
    ? null
    : (typeof value === 'number' ? value : Number.NaN)
);
const isNullableSafeMinor = value => value === null || (Number.isSafeInteger(value) && value >= 0);

/**
 * Durable fail-closed queue for signed Stripe events whose financial owner,
 * provider delta, or seller allocation cannot be proven automatically.
 */
const stripePaymentRiskReviewSchema = new mongoose.Schema({
  reviewKey: { type: String, required: true, trim: true, unique: true, index: true },
  stripeEventId: { type: String, required: true, trim: true, index: true },
  stripeEventType: { type: String, required: true, trim: true },
  occurredAt: { type: Date, required: true },
  sourceType: { type: String, trim: true, default: 'unknown', index: true },
  sourceReferenceId: { type: String, trim: true, default: '' },
  paymentIntentId: { type: String, trim: true, default: '', index: true },
  chargeId: { type: String, trim: true, default: '', index: true },
  reasonCode: {
    type: String,
    required: true,
    trim: true,
    match: /^[A-Z][A-Z0-9_]{2,99}$/,
    index: true,
  },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  currency: { type: String, enum: [...CURRENCIES, ''], default: '' },
  chargeAmountMinor: {
    type: Number,
    default: null,
    set: nullableStrictMinorSetter,
    validate: { validator: isNullableSafeMinor, message: 'Review charge money must be a safe integer or null' },
  },
  refundExposureMinor: {
    type: Number,
    default: null,
    set: nullableStrictMinorSetter,
    validate: { validator: isNullableSafeMinor, message: 'Review refund money must be a safe integer or null' },
  },
  disputeId: { type: String, trim: true, default: '' },
  disputeStatus: { type: String, trim: true, default: '' },
  disputeExposureMinor: {
    type: Number,
    default: null,
    set: nullableStrictMinorSetter,
    validate: { validator: isNullableSafeMinor, message: 'Review dispute money must be a safe integer or null' },
  },
  status: { type: String, enum: ['open', 'resolved'], default: 'open', required: true, index: true },
  resolvedAt: { type: Date, default: null },
  resolutionNote: { type: String, trim: true, maxlength: 1000, default: '' },
  contentHash: { type: String, required: true, select: false },
}, { timestamps: true });

stripePaymentRiskReviewSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('StripePaymentRiskReview', stripePaymentRiskReviewSchema);
