'use strict';
const mongoose = require('mongoose');
const money = { type: Number, required: true, min: 0, validate: Number.isSafeInteger, immutable: true };
const schema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true },
  buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  paymentMethod: { type: String, enum: ['wallet', 'safepay', 'cash_on_delivery'], required: true, immutable: true },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SafepayPayment', default: null, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production', null], default: null, immutable: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], required: true, immutable: true },
  amountMinor: money,
  refundAmountMinor: { ...money, required: false, default: undefined },
  deductionMinor: { ...money, required: false, default: undefined },
  policyVersion: { type: Number, enum: [1], default: undefined, immutable: true },
  quoteId: { type: String, default: '', immutable: true },
  sellerCurrency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], required: true, immutable: true },
  sellerAmountMinor: money,
  refundStatus: { type: String, enum: ['not_required', 'pending', 'processing', 'refunded', 'manual_review'], required: true },
  refundDestination: { type: String, enum: ['none', 'wallet', 'original_card'], required: true, immutable: true },
  requestedAt: { type: Date, required: true, immutable: true },
  refundedAt: { type: Date, default: null },
  walletTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', default: null },
  submitStartedAt: { type: Date, default: null },
  refundBaselineMinor: { type: Number, default: null, min: 0, validate: value => value === null || Number.isSafeInteger(value) },
  refundTargetMinor: { type: Number, default: null, min: 0, validate: value => value === null || Number.isSafeInteger(value) },
  previousRefundTokens: { type: [String], default: [] },
  providerRefundTokens: { type: [String], default: [] },
  lastErrorCode: { type: String, default: '', maxlength: 120 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });
schema.index({ order: 1, seller: 1 }, { unique: true });
schema.index({ payment: 1, refundStatus: 1, createdAt: 1 });
schema.index({ environment: 1, refundStatus: 1, createdAt: 1 });
schema.pre('validate', function validateRefundMoney(next) {
  if (this.policyVersion === 1 && (!Number.isSafeInteger(this.refundAmountMinor) || !Number.isSafeInteger(this.deductionMinor)
    || this.refundAmountMinor < 0 || this.deductionMinor < 0
    || (this.refundDestination !== 'none' && this.refundAmountMinor + this.deductionMinor !== this.amountMinor)
    || (this.refundDestination !== 'original_card' && this.deductionMinor !== 0))) {
    return next(Object.assign(new Error('Cancellation refund and deduction do not reconcile.'), { code: 'CANCELLATION_REFUND_MONEY_INVALID' }));
  }
  next();
});
module.exports = mongoose.model('OrderCancellation', schema);
