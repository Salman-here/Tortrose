'use strict';

const mongoose = require('mongoose');

const CLEANUP_STATUSES = Object.freeze([
  'pending',
  'processing',
  'retry',
  'manual_review',
  'completed',
]);

const CLEANUP_REASONS = Object.freeze([
  'replacement_activation',
  'duplicate_checkout',
  'invalid_founder_checkout',
  'precheckout_stale_subscription',
]);

const strictString = value => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') throw new TypeError('Stripe subscription cleanup text fields require strings.');
  return value;
};

const safeAttemptCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 25;

const stripeSubscriptionCleanupSchema = new mongoose.Schema({
  cleanupKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
    immutable: true,
    maxlength: 64,
    match: /^[a-f0-9]{64}$/,
    set: strictString,
  },
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
    index: true,
  },
  staleStripeSubscriptionId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    immutable: true,
    maxlength: 255,
    match: /^sub_[A-Za-z0-9_]+$/,
    set: strictString,
  },
  replacementStripeSubscriptionId: {
    type: String,
    default: '',
    immutable: true,
    maxlength: 255,
    match: /^$|^sub_[A-Za-z0-9_]+$/,
    set: strictString,
  },
  stripeCustomerId: {
    type: String,
    default: '',
    immutable: true,
    maxlength: 255,
    match: /^$|^cus_[A-Za-z0-9_]+$/,
    set: strictString,
  },
  reason: {
    type: String,
    enum: CLEANUP_REASONS,
    required: true,
    immutable: true,
  },
  sourceReference: {
    type: String,
    required: true,
    immutable: true,
    maxlength: 255,
    set: strictString,
  },
  occurredAt: { type: Date, required: true, immutable: true },
  status: {
    type: String,
    enum: CLEANUP_STATUSES,
    default: 'pending',
    required: true,
    index: true,
  },
  attempts: {
    type: Number,
    default: 0,
    min: 0,
    max: 25,
    validate: { validator: safeAttemptCount, message: 'Cleanup attempts must be a safe integer from 0 to 25.' },
  },
  maxAttempts: {
    type: Number,
    default: 6,
    min: 1,
    max: 25,
    immutable: true,
    validate: {
      validator: value => Number.isSafeInteger(value) && value >= 1 && value <= 25,
      message: 'Cleanup maxAttempts must be a safe integer from 1 to 25.',
    },
  },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseToken: { type: String, default: null, select: false, maxlength: 80, set: strictString },
  leaseOwner: { type: String, default: '', maxlength: 120, set: strictString },
  leaseExpiresAt: { type: Date, default: null, index: true },
  firstFailureAt: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  providerStatus: { type: String, default: '', maxlength: 80, set: strictString },
  lastErrorCode: { type: String, default: '', maxlength: 120, set: strictString },
  lastError: { type: String, default: '', maxlength: 1000, set: strictString },
  manualReview: {
    requiredAt: { type: Date, default: null },
    reasonCode: { type: String, default: '', maxlength: 120, set: strictString },
    notificationEnqueuedAt: { type: Date, default: null },
    notificationLastError: { type: String, default: '', maxlength: 1000, set: strictString },
    resolvedAt: { type: Date, default: null },
    resolutionNotificationEnqueuedAt: { type: Date, default: null },
    resolutionNotificationLastError: { type: String, default: '', maxlength: 1000, set: strictString },
  },
}, {
  timestamps: true,
  strict: 'throw',
  optimisticConcurrency: true,
});

stripeSubscriptionCleanupSchema.index({ status: 1, nextAttemptAt: 1, leaseExpiresAt: 1, createdAt: 1 });
stripeSubscriptionCleanupSchema.index({ seller: 1, status: 1, createdAt: -1 });

stripeSubscriptionCleanupSchema.pre('validate', function validateCleanupState() {
  if (
    this.replacementStripeSubscriptionId
    && this.replacementStripeSubscriptionId === this.staleStripeSubscriptionId
  ) {
    this.invalidate(
      'replacementStripeSubscriptionId',
      'A replacement subscription cannot be the subscription being cancelled.',
    );
  }
  if (this.attempts > this.maxAttempts) {
    this.invalidate('attempts', 'Cleanup attempts cannot exceed maxAttempts.');
  }
  if (this.status === 'manual_review' && !this.manualReview?.requiredAt) {
    this.invalidate('manualReview.requiredAt', 'Manual-review cleanup records require an escalation timestamp.');
  }
  if (this.status === 'completed' && (!this.cancelledAt || !this.completedAt)) {
    this.invalidate('completedAt', 'Completed cleanup records require cancellation and completion timestamps.');
  }
});

module.exports = mongoose.model('StripeSubscriptionCleanup', stripeSubscriptionCleanupSchema);
module.exports.CLEANUP_REASONS = CLEANUP_REASONS;
module.exports.CLEANUP_STATUSES = CLEANUP_STATUSES;
