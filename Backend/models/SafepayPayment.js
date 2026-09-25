'use strict';
const mongoose = require('mongoose');
const strictInteger = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : Number.NaN;
const schema = new mongoose.Schema({
  // Guest order ownership remains on the order's existing email-scoped key.
  // Every non-order purpose is authenticated at its entry point.
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, immutable: true },
  environment: { type: String, enum: ['sandbox', 'production'], required: true, immutable: true },
  purpose: { type: String, enum: ['order', 'wallet_top_up', 'subdomain', 'subscription', 'return_settlement', 'card_setup'], required: true, immutable: true },
  reference: { type: String, required: true, immutable: true, maxlength: 160 },
  requestKey: { type: String, required: true, immutable: true, maxlength: 160, select: false },
  fingerprint: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
  amountMinor: { type: Number, required: true, min: 0, set: strictInteger, validate: Number.isSafeInteger, immutable: true },
  currency: { type: String, enum: ['PKR', 'USD', 'EUR', 'GBP'], required: true, immutable: true },
  providerMode: { type: String, enum: ['payment', 'instrument', 'subscription'], default: 'payment', immutable: true },
  customerId: { type: String, default: null, match: /^cus_[a-zA-Z0-9-]+$/, immutable: true },
  cardId: { type: String, default: null, match: /^pm_[a-zA-Z0-9-]+$/, select: false, immutable: true },
  chargeStartedAt: { type: Date, default: null },
  chargeCompletedAt: { type: Date, default: null },
  chargeOutcome: { type: String, enum: ['not_started', 'pending', 'declined', 'unknown', 'paid'], default: 'not_started' },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, immutable: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null, immutable: true },
  returnRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'ReturnRequest', default: null, immutable: true },
  tracker: { type: String, default: null, match: /^track_[a-zA-Z0-9-]+$/ },
  providerSubscriptionId: { type: String, default: null, match: /^sub_[a-zA-Z0-9-]+$/ },
  providerPlanId: { type: String, default: null, match: /^plan_[a-zA-Z0-9-]+$/ },
  status: { type: String, enum: ['new', 'creating', 'ready', 'authorized', 'paid', 'cancel_requested', 'cancelled', 'failed', 'refund_pending', 'refunded', 'manual_review'], default: 'new', index: true },
  // Sensitive URL contains a short-lived provider auth token; never include
  // it in public order/profile serializers or notification payloads.
  checkoutUrl: { type: String, default: '', select: false },
  checkoutExpiresAt: { type: Date, default: null },
  creationStartedAt: { type: Date, default: null },
  providerState: { type: String, default: '' },
  paidAt: { type: Date, default: null },
  appliedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  localCancelledAt: { type: Date, default: null },
  safetyRefund: {
    reasonCode: { type: String, default: '' },
    requestedAt: { type: Date, default: null },
    submitStartedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    outcome: { type: String, enum: ['not_started', 'unknown', 'confirmed', 'failed'], default: 'not_started' },
  },
  capturedMinor: { type: Number, default: 0, min: 0, set: strictInteger, validate: Number.isSafeInteger },
  refundedMinor: { type: Number, default: 0, min: 0, set: strictInteger, validate: Number.isSafeInteger },
  lastErrorCode: { type: String, default: '', maxlength: 120 },
  processingToken: { type: String, default: '', select: false },
  leaseUntil: { type: Date, default: null },
  lastReconciledAt: { type: Date, default: null },
  nextReconcileAt: { type: Date, default: Date.now, index: true },
  reconcileAttempts: { type: Number, default: 0, min: 0 },
  riskPending: { type: Boolean, default: false, index: true },
  // Server-generated immutable terms (slug/years, plan/price/trial/promotion).
  terms: { type: mongoose.Schema.Types.Mixed, default: {}, immutable: true },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ environment: 1, reference: 1 }, { unique: true });
schema.index({ environment: 1, user: 1, purpose: 1, requestKey: 1 }, { unique: true });
schema.index({ environment: 1, tracker: 1 }, { unique: true, partialFilterExpression: { tracker: { $type: 'string' } } });
schema.index({ environment: 1, status: 1, updatedAt: 1 });
module.exports = mongoose.model('SafepayPayment', schema);
