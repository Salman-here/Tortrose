'use strict';
const mongoose = require('mongoose');
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : Number.NaN;
const minor = (extra = {}) => ({ type: Number, min: 0, set: integer, validate: Number.isSafeInteger, ...extra });

// A human-confirmed provider decision is a distinct authority from a payment
// status or a webhook delivery. Private evidence never enters order DTOs.
const schema = new mongoose.Schema({
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SafepayPayment', required: true, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  tracker: { type: String, required: true, immutable: true, match: /^track_[a-zA-Z0-9-]+$/ },
  purpose: { type: String, enum: ['order', 'wallet_top_up', 'return_settlement'], required: true, immutable: true },
  providerFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  providerState: { type: String, required: true },
  chargeId: { type: String, required: true, immutable: true, match: /^ch_[a-zA-Z0-9-]+$/ },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], required: true, immutable: true },
  originalAmountMinor: minor({ required: true, min: 1, immutable: true }),
  status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending', required: true, index: true },
  revision: minor({ required: true, default: 0 }),
  sellers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  orders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],
  holdIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'SellerPaymentRiskHold' }],
  principalMinor: minor({ default: 0 }),
  platformPrincipalMinor: minor({ default: 0 }),
  fundingAccounted: { type: Boolean, default: false },
  buyerAllocations: [{
    wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction', required: true },
    amountMinor: minor({ required: true }),
  }],
  sellerTotals: [{
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountMinor: minor({ required: true }),
  }],
  sellerAllocations: [{
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    amountMinor: minor({ required: true }),
  }],
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  authority: { type: String, enum: ['admin_reviewed_provider_evidence'], default: undefined },
  // Only authenticated admin reads may explicitly select these fields.
  providerCaseReference: { type: String, default: undefined, maxlength: 160, select: false },
  evidenceText: { type: String, default: undefined, maxlength: 12000, select: false },
  evidenceFingerprint: { type: String, default: undefined, match: /^[a-f0-9]{64}$/, select: false },
  resolutionKey: { type: String, default: undefined, maxlength: 160, select: false },
  resolutionFingerprint: { type: String, default: undefined, match: /^[a-f0-9]{64}$/, select: false },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ payment: 1, providerFingerprint: 1 }, { unique: true });
schema.index({ environment: 1, providerCaseReference: 1 }, {
  unique: true, partialFilterExpression: { providerCaseReference: { $type: 'string' } },
});
schema.index({ status: 1, createdAt: -1 });
module.exports = mongoose.model('SafepayPaymentReview', schema);
