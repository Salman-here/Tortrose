'use strict';

const mongoose = require('mongoose');

const CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];

const strictMinorSetter = value => (
  typeof value === 'number' ? value : Number.NaN
);
const isSafeMinor = value => Number.isSafeInteger(value) && value >= 0;
const isPositiveSafeMinor = value => Number.isSafeInteger(value) && value > 0;

const refundEvidenceSchema = new mongoose.Schema({
  refundId: {
    type: String,
    required: true,
    trim: true,
    match: /^re_[A-Za-z0-9_]+$/,
  },
  amountMinor: {
    type: Number,
    required: true,
    set: strictMinorSetter,
    validate: { validator: isPositiveSafeMinor, message: 'Stripe refund money must be a positive safe integer' },
  },
  currency: { type: String, enum: CURRENCIES, required: true },
  createdAt: { type: Date, required: true },
  metadataType: { type: String, trim: true, maxlength: 100, default: '' },
  metadataOrderId: { type: String, trim: true, maxlength: 200, default: '' },
  metadataWalletTransactionId: { type: String, trim: true, maxlength: 200, default: '' },
  metadataReturnRequestId: { type: String, trim: true, maxlength: 200, default: '' },
}, { _id: false });

const sellerImpactSchema = new mongoose.Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  action: {
    type: String,
    enum: [
      'refund_debited',
      'dispute_reserved',
      'dispute_released',
      'dispute_finalized',
      'dispute_inquiry',
      'dispute_won_no_reserve',
    ],
    required: true,
  },
  direction: {
    type: String,
    enum: ['debit', 'credit', 'none'],
    required: true,
  },
  sourceAmountMinor: {
    type: Number,
    required: true,
    set: strictMinorSetter,
    validate: { validator: isSafeMinor, message: 'Seller risk source money must be a safe integer' },
  },
  sourceCurrency: { type: String, enum: CURRENCIES, required: true },
  amountUSDMinor: {
    type: Number,
    required: true,
    set: strictMinorSetter,
    validate: { validator: isSafeMinor, message: 'Seller risk USD money must be a safe integer' },
  },
}, { _id: false });

const accountImpactSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  action: {
    type: String,
    enum: [
      'refund_debited',
      'dispute_reserved',
      'dispute_released',
      'dispute_finalized',
      'dispute_inquiry',
      'dispute_won_no_reserve',
    ],
    required: true,
  },
  direction: {
    type: String,
    enum: ['debit', 'credit', 'none'],
    required: true,
  },
  sourceAmountMinor: {
    type: Number,
    required: true,
    set: strictMinorSetter,
    validate: { validator: isPositiveSafeMinor, message: 'Account risk source money must be a positive safe integer' },
  },
  sourceCurrency: { type: String, enum: CURRENCIES, required: true },
}, { _id: false });

/**
 * Immutable provider-and-ledger snapshot used by refund/dispute notifications.
 * NotificationOutbox rows reference this document's exact integer amounts;
 * delivery never reads mutable order lines or live exchange rates.
 */
const stripePaymentRiskEventSchema = new mongoose.Schema({
  eventKey: { type: String, required: true, trim: true, unique: true, index: true },
  stripeEventId: { type: String, required: true, trim: true, index: true },
  stripeEventType: { type: String, required: true, trim: true },
  occurredAt: { type: Date, required: true },
  classification: {
    type: String,
    enum: [
      'order_refund',
      'order_dispute_opened',
      'order_dispute_won',
      'order_dispute_lost',
      'order_dispute_inquiry',
      'order_dispute_won_no_reserve',
      'wallet_refund',
      'wallet_dispute_opened',
      'wallet_dispute_won',
      'wallet_dispute_lost',
      'wallet_dispute_inquiry',
      'wallet_dispute_won_no_reserve',
      'return_refund',
      'return_dispute_opened',
      'return_dispute_won',
      'return_dispute_lost',
      'return_dispute_inquiry',
      'return_dispute_won_no_reserve',
    ],
    required: true,
    index: true,
  },
  sourceType: {
    type: String,
    enum: ['order_payment', 'wallet_top_up', 'return_settlement'],
    required: true,
  },
  sourceReferenceId: { type: String, required: true, trim: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  walletTopUp: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WalletTransaction',
    default: null,
    index: true,
  },
  returnRequest: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ReturnRequest',
    default: null,
    index: true,
  },
  paymentIntentId: { type: String, required: true, trim: true, index: true },
  chargeId: { type: String, required: true, trim: true, index: true },
  currency: { type: String, enum: CURRENCIES, required: true },
  chargeAmountMinor: {
    type: Number,
    required: true,
    set: strictMinorSetter,
    validate: { validator: isPositiveSafeMinor, message: 'Stripe charge money must be a positive safe integer' },
  },
  refundExposureMinor: {
    type: Number,
    default: 0,
    set: strictMinorSetter,
    validate: { validator: isSafeMinor, message: 'Stripe refund exposure must be a safe integer' },
  },
  refundDeltaMinor: {
    type: Number,
    default: 0,
    set: strictMinorSetter,
    validate: { validator: isSafeMinor, message: 'Stripe refund delta must be a safe integer' },
  },
  refunds: { type: [refundEvidenceSchema], default: [] },
  disputeId: { type: String, trim: true, default: '' },
  disputeStatus: { type: String, trim: true, default: '' },
  disputeExposureMinor: {
    type: Number,
    default: 0,
    set: strictMinorSetter,
    validate: { validator: isSafeMinor, message: 'Stripe dispute exposure must be a safe integer' },
  },
  accountImpact: { type: accountImpactSchema, default: null },
  sellerImpacts: { type: [sellerImpactSchema], default: [] },
  contentHash: { type: String, required: true, select: false },
}, { timestamps: true });

stripePaymentRiskEventSchema.pre('validate', function validateRiskEvent(next) {
  const classification = String(this.classification || '');
  const refundEvent = classification.endsWith('_refund');
  const disputeEvent = classification.includes('_dispute_');
  const refundIds = (this.refunds || []).map(entry => entry.refundId);
  const sellerIds = (this.sellerImpacts || []).map(entry => String(entry.seller || ''));
  const sellerSourceTotalMinor = (this.sellerImpacts || []).reduce(
    (sum, entry) => sum + entry.sourceAmountMinor,
    0,
  );
  const signedSellerSourceTotalMinor = (this.sellerImpacts || []).reduce(
    (sum, entry) => sum + (entry.direction === 'credit' ? -1 : 1) * entry.sourceAmountMinor,
    0,
  );
  const accountSourceMinor = this.accountImpact?.sourceAmountMinor || 0;
  const signedAccountSourceMinor = this.accountImpact
    ? (this.accountImpact.direction === 'credit' ? -accountSourceMinor : accountSourceMinor)
    : 0;
  const sourceDocument = {
    order_payment: this.order,
    wallet_top_up: this.walletTopUp,
    return_settlement: this.returnRequest,
  }[this.sourceType];
  const sourcePrefix = {
    order_payment: 'order_',
    wallet_top_up: 'wallet_',
    return_settlement: 'return_',
  }[this.sourceType];

  if (!sourceDocument || String(sourceDocument) !== this.sourceReferenceId) {
    this.invalidate('sourceReferenceId', 'Risk event source reference does not match its immutable source document');
  }
  const populatedSources = [this.order, this.walletTopUp, this.returnRequest].filter(Boolean);
  if (populatedSources.length !== 1) {
    this.invalidate('sourceType', 'Risk event must reference exactly one source document');
  }
  if (!String(this.classification || '').startsWith(sourcePrefix || '__invalid__')) {
    this.invalidate('classification', 'Risk event classification does not match its source type');
  }

  if (new Set(refundIds).size !== refundIds.length) {
    this.invalidate('refunds', 'Stripe refund ids must be unique inside an event');
  }
  if (new Set(sellerIds).size !== sellerIds.length) {
    this.invalidate('sellerImpacts', 'A seller may appear only once inside a risk event');
  }
  if ((this.refunds || []).some(entry => entry.currency !== this.currency)) {
    this.invalidate('refunds', 'Stripe refund evidence currency must match the charge currency');
  }
  if ((this.sellerImpacts || []).some(entry => (
    entry.sourceAmountMinor === 0 && entry.amountUSDMinor === 0
  ))) {
    this.invalidate('sellerImpacts', 'A seller risk impact must move source or USD money');
  }
  if ((this.sellerImpacts || []).some(entry => entry.sourceCurrency !== this.currency)) {
    this.invalidate('sellerImpacts', 'Seller risk source currency must match the provider charge currency');
  }
  if (this.accountImpact && this.accountImpact.sourceCurrency !== this.currency) {
    this.invalidate('accountImpact', 'Account risk source currency must match the provider charge currency');
  }
  if (!Number.isSafeInteger(sellerSourceTotalMinor)) {
    this.invalidate('sellerImpacts', 'Seller risk source allocations are too large');
  }
  if (this.refundExposureMinor > this.chargeAmountMinor) {
    this.invalidate('refundExposureMinor', 'Stripe refund exposure cannot exceed the charge');
  }
  if (this.disputeExposureMinor > this.chargeAmountMinor) {
    this.invalidate('disputeExposureMinor', 'Stripe dispute exposure cannot exceed the charge');
  }

  if (refundEvent) {
    const evidenceTotal = (this.refunds || []).reduce(
      (sum, entry) => sum + entry.amountMinor,
      0,
    );
    if (!isPositiveSafeMinor(this.refundDeltaMinor) || evidenceTotal !== this.refundDeltaMinor) {
      this.invalidate('refundDeltaMinor', 'Refund evidence must exactly equal the positive refund delta');
    }
    if (this.stripeEventType !== 'charge.refunded') {
      this.invalidate('stripeEventType', 'A refund receipt requires a Stripe charge.refunded event');
    }
    if (this.refundExposureMinor < this.refundDeltaMinor) {
      this.invalidate('refundExposureMinor', 'Cumulative refund exposure cannot be smaller than its new refund delta');
    }
    if (!(this.refunds || []).length) {
      this.invalidate('refunds', 'A refund receipt requires provider refund evidence');
    }
    if (this.disputeId || this.disputeStatus || this.disputeExposureMinor) {
      this.invalidate('disputeId', 'A refund event cannot contain a dispute outcome');
    }
    if ((this.sellerImpacts || []).some(entry => (
      entry.action !== 'refund_debited' || entry.direction === 'none'
    ))) {
      this.invalidate('sellerImpacts', 'Refund events require refund-debit seller impacts');
    }
    if (this.accountImpact && (
      this.accountImpact.action !== 'refund_debited'
      || this.accountImpact.direction === 'none'
    )) {
      this.invalidate('accountImpact', 'Refund events require a refund-debit account impact');
    }
    if (signedSellerSourceTotalMinor + signedAccountSourceMinor !== this.refundDeltaMinor) {
      this.invalidate('sellerImpacts', 'Refund internal allocations must exactly conserve the provider refund delta');
    }
  }

  if (disputeEvent) {
    if (!String(this.stripeEventType || '').startsWith('charge.dispute.')) {
      this.invalidate('stripeEventType', 'A dispute alert requires a Stripe charge.dispute event');
    }
    if (!/^dp_[A-Za-z0-9_]+$/.test(this.disputeId || '')) {
      this.invalidate('disputeId', 'A dispute event requires the Stripe dispute id');
    }
    if (!isPositiveSafeMinor(this.disputeExposureMinor)) {
      this.invalidate('disputeExposureMinor', 'A dispute alert requires positive provider exposure');
    }
    if (this.refundDeltaMinor || (this.refunds || []).length) {
      this.invalidate('refundDeltaMinor', 'A dispute event cannot contain refund receipt evidence');
    }
    const expectedAction = {
      order_dispute_opened: 'dispute_reserved',
      order_dispute_won: 'dispute_released',
      order_dispute_lost: 'dispute_finalized',
      order_dispute_inquiry: 'dispute_inquiry',
      order_dispute_won_no_reserve: 'dispute_won_no_reserve',
      wallet_dispute_opened: 'dispute_reserved',
      wallet_dispute_won: 'dispute_released',
      wallet_dispute_lost: 'dispute_finalized',
      wallet_dispute_inquiry: 'dispute_inquiry',
      wallet_dispute_won_no_reserve: 'dispute_won_no_reserve',
      return_dispute_opened: 'dispute_reserved',
      return_dispute_won: 'dispute_released',
      return_dispute_lost: 'dispute_finalized',
      return_dispute_inquiry: 'dispute_inquiry',
      return_dispute_won_no_reserve: 'dispute_won_no_reserve',
    }[this.classification];
    const expectedDirection = {
      dispute_reserved: 'debit',
      dispute_released: 'credit',
      dispute_finalized: 'none',
      dispute_inquiry: 'none',
      dispute_won_no_reserve: 'none',
    }[expectedAction];
    if ((this.sellerImpacts || []).some(
      entry => entry.action !== expectedAction || entry.direction !== expectedDirection,
    )) {
      this.invalidate('sellerImpacts', 'Dispute alerts require exact seller impacts for their state');
    }
    if (this.accountImpact && (
      this.accountImpact.action !== expectedAction
      || this.accountImpact.direction !== expectedDirection
    )) {
      this.invalidate('accountImpact', 'Dispute alerts require an exact account impact for their state');
    }
    if (!this.accountImpact && !(this.sellerImpacts || []).length) {
      this.invalidate('sellerImpacts', 'Dispute alerts require an exact internal allocation');
    }
    if (sellerSourceTotalMinor + accountSourceMinor !== this.disputeExposureMinor) {
      this.invalidate('sellerImpacts', 'Dispute internal allocations must exactly conserve the provider exposure');
    }
  }
  next();
});

stripePaymentRiskEventSchema.index({ 'refunds.refundId': 1 }, {
  unique: true,
  sparse: true,
  name: 'uniq_stripe_order_refund_receipt',
});
stripePaymentRiskEventSchema.index({ order: 1, occurredAt: -1 });
stripePaymentRiskEventSchema.index({ walletTopUp: 1, occurredAt: -1 });
stripePaymentRiskEventSchema.index({ returnRequest: 1, occurredAt: -1 });

module.exports = mongoose.model('StripePaymentRiskEvent', stripePaymentRiskEventSchema);
