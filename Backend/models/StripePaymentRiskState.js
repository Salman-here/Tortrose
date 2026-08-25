const mongoose = require('mongoose');

const strictMinorSetter = value => (
  typeof value === 'number' ? value : Number.NaN
);
const isSafeMinor = value => Number.isSafeInteger(value) && value >= 0;

/**
 * Durable Stripe dispute state. Webhook delivery is at-least-once and can be
 * out of order, so seller/Wallet ledger rows alone cannot act as a terminal
 * marker: a won dispute has no active row after its reserve is released.
 */
const stripePaymentRiskStateSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: [
        'order_payment',
        'return_settlement',
        'wallet_top_up',
        'subdomain_purchase',
        'subscription_invoice',
      ],
      required: true,
      index: true,
    },
    sourceReferenceId: { type: String, required: true, trim: true },
    paymentIntentId: { type: String, required: true, trim: true, index: true },
    chargeId: { type: String, required: true, trim: true, index: true },
    disputeId: { type: String, required: true, trim: true, index: true },
    status: {
      type: String,
      enum: ['active', 'won', 'lost', 'warning_closed'],
      default: 'active',
      required: true,
      index: true,
    },
    terminal: { type: Boolean, default: false, required: true, index: true },
    exposureMinor: {
      type: Number,
      default: 0,
      required: true,
      set: strictMinorSetter,
      validate: {
        validator: isSafeMinor,
        message: 'Stripe dispute exposure must be a non-negative safe integer',
      },
    },
    lastEventId: { type: String, default: null },
    lastEventType: { type: String, default: '' },
    terminalEventId: { type: String, default: null },
    terminalEventType: { type: String, default: '' },
    terminalAt: { type: Date, default: null },
  },
  { timestamps: true },
);

stripePaymentRiskStateSchema.pre('validate', function validateTerminalState(next) {
  const expectedTerminal = this.status !== 'active';
  if (this.terminal !== expectedTerminal) {
    this.invalidate(
      'terminal',
      'Stripe dispute terminal state must agree with its status',
      this.terminal,
    );
  }
  next();
});

stripePaymentRiskStateSchema.index(
  {
    sourceType: 1,
    sourceReferenceId: 1,
    paymentIntentId: 1,
    chargeId: 1,
    disputeId: 1,
  },
  { unique: true, name: 'uniq_stripe_payment_risk_dispute' },
);

module.exports = mongoose.model('StripePaymentRiskState', stripePaymentRiskStateSchema);
