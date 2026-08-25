const mongoose = require('mongoose');

/**
 * Fail-closed withdrawal hold created before reversal accounting begins. It
 * remains pending if trusted FX or Mongo is unavailable, so a seller cannot
 * withdraw revenue while Stripe retries the webhook.
 */
const sellerPaymentRiskHoldSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sourceType: {
      type: String,
      enum: ['order_payment', 'return_settlement', 'wallet_top_up'],
      required: true,
      index: true,
    },
    sourceReferenceId: { type: String, required: true, trim: true },
    paymentIntentId: { type: String, required: true, trim: true, index: true },
    chargeId: { type: String, required: true, trim: true, index: true },
    eventId: { type: String, required: true, trim: true, index: true },
    eventType: { type: String, required: true, trim: true },
    riskTrack: { type: String, enum: ['refund', 'dispute'], required: true },
    riskTrackKey: { type: String, required: true, trim: true, index: true },
    disputeId: { type: String, default: null, index: true },
    // A seller-wide monotonic fence allocated while SellerSettlementLock is
    // held. A resolver may cover older generations, but can never clear a hold
    // created by a newer webhook worker.
    exposureGeneration: { type: Number, default: null, min: 1, index: true },
    exposureMinor: { type: Number, default: null, min: 0 },
    exposureFingerprint: { type: String, default: null, trim: true },
    unknownExposure: { type: Boolean, default: false, required: true },
    status: {
      type: String,
      enum: ['pending', 'resolved'],
      default: 'pending',
      required: true,
      index: true,
    },
    resolvedAt: { type: Date, default: null },
    resolvedByEventId: { type: String, default: null, trim: true },
    resolvedExposureMinor: { type: Number, default: null, min: 0 },
  },
  { timestamps: true },
);

sellerPaymentRiskHoldSchema.index(
  { seller: 1, eventId: 1, riskTrackKey: 1 },
  { unique: true, name: 'uniq_seller_stripe_risk_event_track' },
);
sellerPaymentRiskHoldSchema.index({ seller: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SellerPaymentRiskHold', sellerPaymentRiskHoldSchema);
