const mongoose = require('mongoose');

/**
 * Linearization record shared by payment completion and refund/dispute
 * webhooks. A financial reversal which reaches Mongo first blocks completion;
 * a completion claim which reaches Mongo first lets the ordinary post-payment
 * risk ledger handle the event. This closes the webhook-ordering window where
 * an already-reversed payment could otherwise credit a Wallet or fulfill an
 * order after the risk webhook had been acknowledged.
 */
const stripePaymentRiskMarkerSchema = new mongoose.Schema(
  {
    paymentIntentId: { type: String, required: true, trim: true, unique: true, index: true },
    sourceType: {
      type: String,
      enum: ['order_payment', 'wallet_top_up', 'return_settlement'],
      required: true,
      index: true,
    },
    sourceReferenceId: { type: String, required: true, trim: true, index: true },
    completionState: {
      type: String,
      enum: ['unclaimed', 'claimed', 'completed', 'blocked'],
      default: 'unclaimed',
      required: true,
      index: true,
    },
    completionEventId: { type: String, default: null },
    completionClaimedAt: { type: Date, default: null },
    completionCompletedAt: { type: Date, default: null },
    blocked: { type: Boolean, default: false, required: true, index: true },
    blockingEventId: { type: String, default: null, index: true },
    blockingEventType: { type: String, default: '' },
    refundBlocked: { type: Boolean, default: false, required: true },
    blockedDisputeIds: [{ type: String, trim: true }],
    wonDisputeIds: [{ type: String, trim: true }],
    lastResolutionEventId: { type: String, default: null },
    lastResolvedAt: { type: Date, default: null },
    chargeIds: [{ type: String, trim: true }],
    currency: { type: String, enum: ['USD', 'PKR', 'EUR', 'GBP'], default: null },
    chargeAmountMinor: { type: Number, default: null, min: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('StripePaymentRiskMarker', stripePaymentRiskMarkerSchema);
