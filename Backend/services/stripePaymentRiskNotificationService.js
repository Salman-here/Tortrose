'use strict';

const crypto = require('crypto');
const StripePaymentRiskEvent = require('../models/StripePaymentRiskEvent');
const StripePaymentRiskReview = require('../models/StripePaymentRiskReview');
const User = require('../models/User');
const { escapeHtml } = require('../utils/orderPresentation');
const { enqueueNotificationEvent, outboxError } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const { tryOrderBuyerPhoneE164 } = require('./orderBuyerContactService');
const { fromMinorUnits, toMinorUnits } = require('./moneyMath');

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const safeText = (value, max = 300) => String(value || '').trim().slice(0, max);
const asDate = (value, field) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) {
    throw outboxError(`${field} is invalid.`, 'STRIPE_RISK_NOTIFICATION_EVENT_TIME_INVALID');
  }
  return date;
};
const canonicalValue = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (!['_id', '__v', 'createdAt', 'updatedAt', 'contentHash'].includes(key)) {
        result[key] = canonicalValue(value[key]);
      }
      return result;
    }, {});
  }
  return value;
};
const contentHash = value => crypto.createHash('sha256')
  .update(JSON.stringify(canonicalValue(value)))
  .digest('hex');
const markTransactionRetryable = error => {
  if (typeof error?.addErrorLabel === 'function') {
    error.addErrorLabel('TransientTransactionError');
    return error;
  }
  if (!Array.isArray(error?.errorLabels)) error.errorLabels = [];
  if (!error.errorLabels.includes('TransientTransactionError')) {
    error.errorLabels.push('TransientTransactionError');
  }
  return error;
};

const impactDirectionForAction = action => ({
  refund_debited: 'debit',
  dispute_reserved: 'debit',
  dispute_released: 'credit',
  dispute_finalized: 'none',
  dispute_inquiry: 'none',
  dispute_won_no_reserve: 'none',
}[action] || 'none');

const normalizeRiskEventInput = payload => {
  const sourceType = payload.sourceType || 'order_payment';
  const sourceDocument = {
    order_payment: payload.order,
    wallet_top_up: payload.walletTopUp,
    return_settlement: payload.returnRequest,
  }[sourceType];
  return ({
  eventKey: safeText(payload.eventKey, 300),
  stripeEventId: safeText(payload.stripeEventId, 200),
  stripeEventType: safeText(payload.stripeEventType, 100),
  occurredAt: asDate(payload.occurredAt, 'Stripe risk event timestamp'),
  classification: payload.classification,
  sourceType,
  sourceReferenceId: toId(sourceDocument),
  order: sourceType === 'order_payment' ? (payload.order?._id || payload.order) : null,
  walletTopUp: sourceType === 'wallet_top_up'
    ? (payload.walletTopUp?._id || payload.walletTopUp)
    : null,
  returnRequest: sourceType === 'return_settlement'
    ? (payload.returnRequest?._id || payload.returnRequest)
    : null,
  paymentIntentId: safeText(payload.paymentIntentId, 200),
  chargeId: safeText(payload.chargeId, 200),
  currency: payload.currency,
  chargeAmountMinor: payload.chargeAmountMinor,
  refundExposureMinor: payload.refundExposureMinor ?? 0,
  refundDeltaMinor: payload.refundDeltaMinor ?? 0,
  refunds: [...(payload.refunds || [])]
    .map(entry => ({
      refundId: safeText(entry.refundId, 200),
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      createdAt: asDate(entry.createdAt, 'Stripe refund timestamp'),
      metadataType: safeText(entry.metadataType, 100),
      metadataOrderId: safeText(entry.metadataOrderId, 200),
      metadataWalletTransactionId: safeText(entry.metadataWalletTransactionId, 200),
      metadataReturnRequestId: safeText(entry.metadataReturnRequestId, 200),
    }))
    .sort((left, right) => left.refundId.localeCompare(right.refundId)),
  disputeId: safeText(payload.disputeId, 200),
  disputeStatus: safeText(payload.disputeStatus, 80),
  disputeExposureMinor: payload.disputeExposureMinor ?? 0,
  accountImpact: payload.accountImpact
    ? {
      user: payload.accountImpact.userId || payload.accountImpact.user,
      action: payload.accountImpact.action,
      direction: payload.accountImpact.direction
        || impactDirectionForAction(payload.accountImpact.action),
      sourceAmountMinor: payload.accountImpact.sourceAmountMinor,
      sourceCurrency: payload.accountImpact.sourceCurrency,
    }
    : null,
  sellerImpacts: [...(payload.sellerImpacts || [])]
    .map(entry => ({
      seller: entry.sellerId || entry.seller,
      action: entry.action,
      direction: entry.direction || impactDirectionForAction(entry.action),
      sourceAmountMinor: entry.sourceAmountMinor,
      sourceCurrency: entry.sourceCurrency,
      amountUSDMinor: entry.amountUSDMinor,
    }))
    .sort((left, right) => toId(left.seller).localeCompare(toId(right.seller))),
  });
};

async function persistStripePaymentRiskEvent(payload, { session = null } = {}) {
  const normalized = normalizeRiskEventInput(payload);
  const candidate = new StripePaymentRiskEvent({
    ...normalized,
    contentHash: 'pending',
  });
  await candidate.validate();
  const snapshot = candidate.toObject({ depopulate: true });
  candidate.contentHash = contentHash(snapshot);
  const insertSnapshot = candidate.toObject({ depopulate: true });

  // Do not recover from an E11000 after Model.create() inside a transaction:
  // MongoDB has already aborted that transaction, so the recovery read cannot
  // succeed. A set-on-insert upsert makes an identical event-key replay a read
  // of the durable row without aborting the caller's accounting transaction.
  // Refund event keys are derived from the sorted provider Refund ids, while a
  // separate unique multikey index fences any impossible overlapping evidence.
  let result;
  try {
    result = await StripePaymentRiskEvent.findOneAndUpdate(
      { eventKey: normalized.eventKey },
      { $setOnInsert: insertSnapshot },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
        includeResultMetadata: true,
        session,
      },
    ).select('+contentHash');
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    if (session?.inTransaction?.()) throw markTransactionRetryable(error);
    // Outside a transaction, a concurrent overlapping-refund insert can be
    // inspected safely. Inside one, rethrow so withTransaction retries from a
    // fresh snapshot rather than continuing an aborted transaction.
    const refundIds = normalized.refunds.map(entry => entry.refundId);
    const conflictFilter = refundIds.length
      ? { $or: [{ eventKey: normalized.eventKey }, { 'refunds.refundId': { $in: refundIds } }] }
      : { eventKey: normalized.eventKey };
    const existing = await StripePaymentRiskEvent.findOne(conflictFilter)
      .select('+contentHash');
    if (!existing || existing.contentHash !== candidate.contentHash) {
      throw outboxError(
        'Stripe risk event replay conflicts with the immutable provider or ledger snapshot.',
        'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT',
      );
    }
    return { event: existing, created: false };
  }

  const event = result?.value || result;
  if (!event || event.contentHash !== candidate.contentHash) {
    throw outboxError(
      'Stripe risk event replay conflicts with the immutable provider or ledger snapshot.',
      'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT',
    );
  }
  return {
    event,
    created: result?.lastErrorObject?.updatedExisting === false,
  };
}

const persistStripeOrderRiskEvent = persistStripePaymentRiskEvent;

const riskEventDateOrNull = value => {
  const date = value instanceof Date ? value : new Date(value);
  return value && Number.isFinite(date.getTime()) ? date : null;
};

const sourceDocumentForType = ({ sourceType, sourceDocument }) => ({
  order_payment: { order: sourceDocument },
  wallet_top_up: { walletTopUp: sourceDocument },
  return_settlement: { returnRequest: sourceDocument },
}[sourceType] || {});

const reviewStripeSourceRisk = ({ payload, sourceType, sourceDocument, reasonCode, reason, session }) => (
  recordStripePaymentRiskManualReview({
    stripeEventId: payload.eventId,
    stripeEventType: payload.eventType,
    occurredAt: riskEventDateOrNull(payload.eventOccurredAt) || new Date(0),
    sourceType,
    sourceReferenceId: toId(sourceDocument),
    paymentIntentId: payload.paymentIntentId,
    chargeId: payload.chargeId,
    reasonCode,
    reason,
    currency: payload.currency,
    chargeAmountMinor: payload.chargeAmountMinor,
    refundExposureMinor: payload.refundExposureMinor,
    disputeId: payload.disputeId,
    disputeStatus: payload.disputeStatus,
    disputeExposureMinor: payload.disputeExposureMinor,
  }, { session })
);

const knownStripeRefundEvidenceById = async ({ session, chargeId }) => {
  const events = await StripePaymentRiskEvent.find({
    chargeId,
    classification: { $in: ['order_refund', 'wallet_refund', 'return_refund'] },
  }).select('refunds').session(session).lean();
  const known = new Map();
  for (const event of events) {
    for (const refund of event.refunds || []) {
      const snapshot = {
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        createdAt: riskEventDateOrNull(refund.createdAt)?.toISOString() || '',
        metadataType: refund.metadataType || '',
        metadataOrderId: refund.metadataOrderId || '',
        metadataWalletTransactionId: refund.metadataWalletTransactionId || '',
        metadataReturnRequestId: refund.metadataReturnRequestId || '',
      };
      const existing = known.get(refund.refundId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
        throw outboxError(
          'Persisted Stripe refund evidence conflicts across immutable risk events.',
          'STRIPE_RISK_NOTIFICATION_EVIDENCE_CONFLICT',
        );
      }
      known.set(refund.refundId, snapshot);
    }
  }
  return known;
};

async function reconcileStripeSourceRefundEvidence({
  session,
  payload,
  sourceType,
  sourceDocument,
  sourceCurrency,
  classification,
  eventKeyPrefix,
  refundDeltaMinor,
  sellerImpacts = [],
  accountImpact = null,
  evidenceConflictsWithSource = () => false,
}) {
  if (!Number.isSafeInteger(refundDeltaMinor) || refundDeltaMinor < 0) {
    throw outboxError(
      'Stripe refund exposure moved backwards.',
      'STRIPE_RISK_NOTIFICATION_LEDGER_MISMATCH',
    );
  }
  if (refundDeltaMinor === 0) return { notified: false, replay: true };
  const occurredAt = riskEventDateOrNull(payload.eventOccurredAt);
  if (!occurredAt) {
    const manualReview = await reviewStripeSourceRisk({
      payload,
      sourceType,
      sourceDocument,
      reasonCode: 'STRIPE_EVENT_TIMESTAMP_MISSING',
      reason: 'The signed Stripe refund event did not include an authoritative provider timestamp.',
      session,
    });
    return { notified: false, manualReview };
  }
  const evidence = payload.refundEvidence;
  if (!evidence?.complete) {
    const manualReview = await reviewStripeSourceRisk({
      payload,
      sourceType,
      sourceDocument,
      reasonCode: evidence?.reasonCode || 'STRIPE_REFUND_OBJECTS_MISSING',
      reason: evidence?.reason || 'The provider refund delta could not be identified safely.',
      session,
    });
    return { notified: false, manualReview };
  }
  const known = await knownStripeRefundEvidenceById({ session, chargeId: payload.chargeId });
  let evidenceConflict = false;
  for (const refund of evidence.refunds || []) {
    const stored = known.get(refund.refundId);
    if (stored && (
      stored.amountMinor !== refund.amountMinor
      || stored.currency !== refund.currency
      || stored.createdAt !== riskEventDateOrNull(refund.createdAt)?.toISOString()
      || stored.metadataType !== (refund.metadataType || '')
      || stored.metadataOrderId !== (refund.metadataOrderId || '')
      || stored.metadataWalletTransactionId !== (refund.metadataWalletTransactionId || '')
      || stored.metadataReturnRequestId !== (refund.metadataReturnRequestId || '')
    )) {
      evidenceConflict = true;
      break;
    }
  }
  const newRefunds = (evidence.refunds || []).filter(refund => !known.has(refund.refundId));
  const newEvidenceMinor = newRefunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  if (
    evidenceConflict
    || newRefunds.some(evidenceConflictsWithSource)
    || !newRefunds.length
    || !Number.isSafeInteger(newEvidenceMinor)
    || newEvidenceMinor !== refundDeltaMinor
    || newRefunds.some(refund => refund.currency !== sourceCurrency)
  ) {
    const manualReview = await reviewStripeSourceRisk({
      payload,
      sourceType,
      sourceDocument,
      reasonCode: 'STRIPE_REFUND_DELTA_EVIDENCE_MISMATCH',
      reason: 'Provider Refund ids and amounts did not exactly match the new internal refund allocation.',
      session,
    });
    return { notified: false, manualReview };
  }
  const refundIdentity = newRefunds.map(refund => refund.refundId).sort().join(':');
  let persisted;
  try {
    persisted = await persistStripePaymentRiskEvent({
      eventKey: `${eventKeyPrefix}:refund:${crypto.createHash('sha256').update(refundIdentity).digest('hex')}`,
      stripeEventId: payload.eventId,
      stripeEventType: payload.eventType,
      occurredAt,
      classification,
      sourceType,
      ...sourceDocumentForType({ sourceType, sourceDocument }),
      paymentIntentId: payload.paymentIntentId,
      chargeId: payload.chargeId,
      currency: sourceCurrency,
      chargeAmountMinor: payload.chargeAmountMinor,
      refundExposureMinor: payload.refundExposureMinor,
      refundDeltaMinor,
      refunds: newRefunds,
      accountImpact,
      sellerImpacts,
    }, { session });
  } catch (error) {
    if (!['ValidationError', 'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT'].includes(error?.name)
      && error?.code !== 'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT') throw error;
    const manualReview = await reviewStripeSourceRisk({
      payload,
      sourceType,
      sourceDocument,
      reasonCode: 'STRIPE_REFUND_INTERNAL_ALLOCATION_MISMATCH',
      reason: 'The exact internal allocation did not conserve the provider-confirmed refund delta.',
      session,
    });
    return { notified: false, manualReview };
  }
  return { notified: true, persisted };
}

async function persistStripeSourceDisputeEvent({
  session,
  payload,
  sourceType,
  sourceDocument,
  sourceCurrency,
  classification,
  eventKeyPrefix,
  sellerImpacts = [],
  accountImpact = null,
}) {
  const occurredAt = riskEventDateOrNull(payload.eventOccurredAt);
  if (!occurredAt) {
    const manualReview = await reviewStripeSourceRisk({
      payload,
      sourceType,
      sourceDocument,
      reasonCode: 'STRIPE_EVENT_TIMESTAMP_MISSING',
      reason: 'The signed Stripe dispute event did not include an authoritative provider timestamp.',
      session,
    });
    return { notified: false, manualReview };
  }
  try {
    const persisted = await persistStripePaymentRiskEvent({
      eventKey: `${eventKeyPrefix}:dispute:${payload.disputeId}:${classification}:${payload.eventId}`,
      stripeEventId: payload.eventId,
      stripeEventType: payload.eventType,
      occurredAt,
      classification,
      sourceType,
      ...sourceDocumentForType({ sourceType, sourceDocument }),
      paymentIntentId: payload.paymentIntentId,
      chargeId: payload.chargeId,
      currency: sourceCurrency,
      chargeAmountMinor: payload.chargeAmountMinor,
      refundExposureMinor: payload.refundExposureMinor,
      disputeId: payload.disputeId,
      disputeStatus: payload.disputeStatus,
      disputeExposureMinor: payload.disputeExposureMinor,
      accountImpact,
      sellerImpacts,
    }, { session });
    return { notified: true, persisted };
  } catch (error) {
    if (!['ValidationError', 'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT'].includes(error?.name)
      && error?.code !== 'STRIPE_RISK_NOTIFICATION_IDEMPOTENCY_CONFLICT') throw error;
    const manualReview = await reviewStripeSourceRisk({
      payload,
      sourceType,
      sourceDocument,
      reasonCode: 'STRIPE_DISPUTE_INTERNAL_ALLOCATION_MISMATCH',
      reason: 'The exact internal allocation did not conserve the provider dispute exposure.',
      session,
    });
    return { notified: false, manualReview };
  }
}

const riskMoneySnapshot = ({ event, amountMinor, currency, key, label, sourcePath }) => (
  snapshotMinorMoney({
    key,
    label,
    amountMinor,
    currency,
    sourceModel: 'StripePaymentRiskEvent',
    sourceDocumentId: event._id,
    sourcePath,
  })
);

const orderNumberOf = order => safeText(order?.orderId || toId(order), 100);

const orderBuyerTarget = order => {
  const user = toId(order?.user);
  const email = typeof order?.shippingInfo?.email === 'string'
    && order.shippingInfo.email === order.shippingInfo.email.trim()
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.shippingInfo.email)
    ? order.shippingInfo.email
    : '';
  const phone = tryOrderBuyerPhoneE164(order);
  const recipient = user
    ? {
      kind: 'user',
      audienceRole: 'buyer',
      user,
      destinationPolicy: 'event_snapshot',
      email,
      phone,
    }
    : {
      kind: 'guest',
      audienceRole: 'buyer',
      guestKey: `order:${toId(order?._id)}`,
      destinationPolicy: 'event_snapshot',
      email,
      phone,
    };
  const channels = user ? ['inapp', 'push'] : [];
  if (email) channels.push('email');
  if (phone) channels.push('whatsapp');
  return { recipient, channels };
};

const buyerRefundTemplates = orderNumber => ({
  inapp: {
    title: 'Card refund completed',
    body: `Stripe confirmed a {{money.refund_delta}} refund for order #${orderNumber} to the original payment method. Bank posting times may vary.`,
  },
  push: {
    title: 'Card refund completed',
    body: `Order #${orderNumber}: Stripe confirmed a {{money.refund_delta}} refund. Bank posting times may vary.`,
  },
  email: {
    subject: `Card refund completed - ${orderNumber}`,
    text: `Stripe confirmed a {{money.refund_delta}} refund for order #${orderNumber} to the original payment method. Your bank may take additional time to display it.`,
    html: `<p>Stripe confirmed a <strong>{{money.refund_delta}}</strong> refund for order <strong>#${escapeHtml(orderNumber)}</strong> to the original payment method.</p><p>Your bank may take additional time to display it.</p>`,
  },
  whatsapp: {
    message: `Rozare Card Refund Completed\n\nOrder: #${orderNumber}\nRefund confirmed by Stripe: {{money.refund_delta}}\n\nThe refund was sent to the original payment method. Your bank may take additional time to display it.`,
  },
});

const sellerRiskTemplates = ({ orderNumber, classification }) => {
  if (classification === 'order_refund') {
    return {
      title: 'Order refund revenue adjustment',
      body: `Stripe completed a buyer refund for order #${orderNumber}. Your frozen order revenue was reduced by {{money.seller_risk_impact}}. This is a completed adjustment.`,
      emailDetail: `Stripe completed a buyer refund for order #${orderNumber}. Your frozen order-currency revenue was reduced by {{money.seller_risk_impact}}. This is a completed seller-ledger adjustment, not a live-FX estimate.`,
      whatsappDetail: `Order Refund Revenue Adjustment\n\nOrder: #${orderNumber}\nCompleted seller-ledger reduction: {{money.seller_risk_impact}}\n\nThis is your exact frozen order-currency adjustment, not a live-FX estimate.`,
    };
  }
  if (classification === 'order_dispute_opened') {
    return {
      title: 'Card dispute opened - funds reserved',
      body: `Stripe opened a card dispute for order #${orderNumber}. {{money.seller_risk_impact}} is reserved from your frozen order allocation while Stripe reviews it. No final outcome has been decided.`,
      emailDetail: `Stripe opened a card dispute for order #${orderNumber}. {{money.seller_risk_impact}} is temporarily reserved from your frozen order allocation while Stripe reviews it. This is not a refund and no final dispute outcome has been decided.`,
      whatsappDetail: `Card Dispute Opened\n\nOrder: #${orderNumber}\nTemporarily reserved: {{money.seller_risk_impact}}\n\nStripe is reviewing the dispute. This is not a refund and no final outcome has been decided.`,
    };
  }
  if (classification === 'order_dispute_won') {
    return {
      title: 'Card dispute won - reserve released',
      body: `Stripe marked the dispute for order #${orderNumber} as won. The {{money.seller_risk_impact}} temporary reserve was released. This does not record a new payment or refund.`,
      emailDetail: `Stripe marked the card dispute for order #${orderNumber} as won. The {{money.seller_risk_impact}} temporary reserve was released. This describes the dispute resolution only; it does not record a new buyer payment or refund.`,
      whatsappDetail: `Card Dispute Won\n\nOrder: #${orderNumber}\nTemporary reserve released: {{money.seller_risk_impact}}\n\nThis describes the dispute resolution only; it is not a new payment or refund.`,
    };
  }
  if (classification === 'order_dispute_won_no_reserve') {
    return {
      title: 'Card dispute won - no seller reserve moved',
      body: `Stripe marked the dispute concerning {{money.seller_risk_impact}} of order #${orderNumber} as won. No seller funds were reserved or released by this event. This is not a new payment or refund.`,
      emailDetail: `Stripe marked the card dispute concerning {{money.seller_risk_impact}} of order #${orderNumber} as won. No seller funds were reserved or released by this event. This describes the dispute resolution only; it is not a new buyer payment or refund.`,
      whatsappDetail: `Card Dispute Won\n\nOrder: #${orderNumber}\nDispute allocation: {{money.seller_risk_impact}}\nNo seller funds were reserved or released by this event. This is not a new payment or refund.`,
    };
  }
  if (classification === 'order_dispute_inquiry') {
    return {
      title: 'Card dispute inquiry opened - no funds reserved',
      body: `Stripe opened an inquiry concerning {{money.seller_risk_impact}} of order #${orderNumber}. No seller funds were reserved by this event and no outcome has been decided.`,
      emailDetail: `Stripe opened a card inquiry concerning {{money.seller_risk_impact}} of order #${orderNumber}. No seller funds were reserved by this event. This is not a refund, and no dispute outcome has been decided.`,
      whatsappDetail: `Card Dispute Inquiry Opened\n\nOrder: #${orderNumber}\nDispute allocation: {{money.seller_risk_impact}}\nNo seller funds were reserved by this event. This is not a refund, and no outcome has been decided.`,
    };
  }
  return {
    title: 'Card dispute lost - reversal finalized',
    body: `Stripe marked the dispute for order #${orderNumber} as lost. Your exact {{money.seller_risk_impact}} allocation is now a completed seller-ledger reversal. This is a dispute result, not a new refund.`,
    emailDetail: `Stripe marked the card dispute for order #${orderNumber} as lost. Your exact {{money.seller_risk_impact}} allocation is now a completed seller-ledger reversal. This describes the dispute outcome and does not claim a separate buyer refund.`,
    whatsappDetail: `Card Dispute Lost\n\nOrder: #${orderNumber}\nFinalized seller-ledger reversal: {{money.seller_risk_impact}}\n\nThis is the dispute outcome, not a separate buyer refund.`,
  };
};

const sellerTemplatesByChannel = copy => ({
  inapp: { title: copy.title, body: copy.body },
  push: { title: copy.title, body: copy.body },
  email: {
    subject: copy.title,
    text: copy.emailDetail,
    html: `<p>${escapeHtml(copy.emailDetail).replace('{{money.seller_risk_impact}}', '<strong>{{money.seller_risk_impact}}</strong>')}</p>`,
  },
  whatsapp: { message: copy.whatsappDetail },
});

const assertRiskEventOwnsOrder = (event, order) => {
  if (
    event?.sourceType !== 'order_payment'
    || toId(event?.order) !== toId(order?._id)
    || event?.sourceReferenceId !== toId(order?._id)
  ) {
    throw outboxError(
      'Stripe payment-risk notification does not own the supplied order.',
      'STRIPE_RISK_NOTIFICATION_ORDER_MISMATCH',
    );
  }
};

async function enqueueStripeOrderRefundNotifications({
  event,
  order,
  buyerTarget = null,
  sellerChannels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
}) {
  assertRiskEventOwnsOrder(event, order);
  if (event.classification !== 'order_refund') {
    throw outboxError('Stripe refund notification requires an order-refund risk event.');
  }
  const id = toId(order._id);
  const orderNumber = orderNumberOf(order);
  const resolvedBuyerTarget = buyerTarget || orderBuyerTarget(order);
  const refundMoney = riskMoneySnapshot({
    event,
    amountMinor: event.refundDeltaMinor,
    currency: event.currency,
    key: 'refund_delta',
    label: 'Provider-confirmed order refund',
    sourcePath: 'refundDeltaMinor',
  });
  const buyer = resolvedBuyerTarget?.channels?.length
    ? await enqueueNotificationEvent({
      eventKey: `stripe-risk:${event.eventKey}:buyer:v1`,
      eventType: 'order.payment_refund_completed',
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: event._id,
      occurredAt: event.occurredAt,
      financial: true,
      recipient: resolvedBuyerTarget.recipient.kind === 'user'
        ? { ...resolvedBuyerTarget.recipient, allowBlocked: true }
        : resolvedBuyerTarget.recipient,
      channels: resolvedBuyerTarget.channels,
      templates: buyerRefundTemplates(orderNumber),
      metadata: {
        category: 'payment',
        linkTo: `/user-dashboard/order/detail/${id}`,
        channelId: 'orders',
        relatedOrder: id,
        data: {
          type: 'order_payment_refund_completed',
          orderId: id,
          riskEventId: toId(event._id),
          providerReferences: event.refunds.map(entry => entry.refundId),
        },
      },
      money: [refundMoney],
      session,
    })
    : [];

  const sellers = [];
  for (let index = 0; index < event.sellerImpacts.length; index += 1) {
    const impact = event.sellerImpacts[index];
    const useSource = impact.sourceAmountMinor > 0;
    const impactMoney = riskMoneySnapshot({
      event,
      amountMinor: useSource ? impact.sourceAmountMinor : impact.amountUSDMinor,
      currency: useSource ? impact.sourceCurrency : 'USD',
      key: 'seller_risk_impact',
      label: useSource ? 'Seller order-currency refund adjustment' : 'Seller USD-ledger rounding adjustment',
      sourcePath: `sellerImpacts[${index}].${useSource ? 'sourceAmountMinor' : 'amountUSDMinor'}`,
    });
    const copy = sellerRiskTemplates({ orderNumber, classification: event.classification });
    sellers.push(...await enqueueNotificationEvent({
      eventKey: `stripe-risk:${event.eventKey}:seller:${toId(impact.seller)}:v1`,
      eventType: 'order.payment_refund_completed',
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: event._id,
      occurredAt: event.occurredAt,
      financial: true,
      recipient: {
        kind: 'user',
        audienceRole: 'seller',
        user: impact.seller,
        destinationPolicy: 'current_user',
        allowBlocked: true,
      },
      channels: sellerChannels,
      templates: sellerTemplatesByChannel(copy),
      metadata: {
        category: 'payment',
        linkTo: `/seller-dashboard/order-management?orderId=${encodeURIComponent(id)}`,
        channelId: 'seller',
        whatsappCategory: 'payment_risk',
        relatedOrder: id,
        data: {
          type: 'order_payment_refund_adjustment',
          orderId: id,
          riskEventId: toId(event._id),
          providerReferences: event.refunds.map(entry => entry.refundId),
        },
      },
      money: [impactMoney],
      session,
    }));
  }
  return { buyer, sellers };
}

async function enqueueStripeOrderDisputeNotifications({
  event,
  order,
  sellerChannels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
}) {
  assertRiskEventOwnsOrder(event, order);
  if (!event.classification.startsWith('order_dispute_')) {
    throw outboxError('Stripe dispute notification requires an order-dispute risk event.');
  }
  const id = toId(order._id);
  const orderNumber = orderNumberOf(order);
  const copy = sellerRiskTemplates({ orderNumber, classification: event.classification });
  const eventType = {
    order_dispute_opened: 'order.payment_dispute_opened',
    order_dispute_won: 'order.payment_dispute_won',
    order_dispute_lost: 'order.payment_dispute_lost',
    order_dispute_inquiry: 'order.payment_dispute_opened',
    order_dispute_won_no_reserve: 'order.payment_dispute_won',
  }[event.classification];
  const records = [];
  for (let index = 0; index < event.sellerImpacts.length; index += 1) {
    const impact = event.sellerImpacts[index];
    const useSource = impact.sourceAmountMinor > 0;
    const money = riskMoneySnapshot({
      event,
      amountMinor: useSource ? impact.sourceAmountMinor : impact.amountUSDMinor,
      currency: useSource ? impact.sourceCurrency : 'USD',
      key: 'seller_risk_impact',
      label: useSource ? 'Seller card-dispute allocation' : 'Seller USD-ledger rounding allocation',
      sourcePath: `sellerImpacts[${index}].${useSource ? 'sourceAmountMinor' : 'amountUSDMinor'}`,
    });
    records.push(...await enqueueNotificationEvent({
      eventKey: `stripe-risk:${event.eventKey}:seller:${toId(impact.seller)}:v1`,
      eventType,
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: event._id,
      occurredAt: event.occurredAt,
      financial: true,
      recipient: {
        kind: 'user',
        audienceRole: 'seller',
        user: impact.seller,
        destinationPolicy: 'current_user',
        allowBlocked: true,
      },
      channels: sellerChannels,
      templates: sellerTemplatesByChannel(copy),
      metadata: {
        category: 'payment',
        linkTo: `/seller-dashboard/order-management?orderId=${encodeURIComponent(id)}`,
        channelId: 'seller',
        whatsappCategory: 'payment_risk',
        relatedOrder: id,
        data: {
          type: eventType.replaceAll('.', '_'),
          orderId: id,
          riskEventId: toId(event._id),
          state: event.classification.slice('order_dispute_'.length),
          providerReference: event.disputeId,
        },
      },
      money: [money],
      session,
    }));
  }
  return records;
}

const sourceEventType = classification => {
  const source = classification.startsWith('wallet_') ? 'wallet' : 'return';
  if (classification.endsWith('_refund')) return `${source}.payment_refund_completed`;
  if (classification.endsWith('_dispute_won') || classification.endsWith('_dispute_won_no_reserve')) {
    return `${source}.payment_dispute_won`;
  }
  if (classification.endsWith('_dispute_lost')) return `${source}.payment_dispute_lost`;
  return `${source}.payment_dispute_opened`;
};

const providerMoneyForSourceEvent = event => riskMoneySnapshot({
  event,
  amountMinor: event.classification.endsWith('_refund')
    ? event.refundDeltaMinor
    : event.disputeExposureMinor,
  currency: event.currency,
  key: 'provider_amount',
  label: event.classification.endsWith('_refund')
    ? 'Provider-confirmed card refund'
    : 'Stripe card-dispute exposure',
  sourcePath: event.classification.endsWith('_refund')
    ? 'refundDeltaMinor'
    : 'disputeExposureMinor',
});

const walletBuyerCopy = ({ classification, reference, hasAccountImpact, accountDirection }) => {
  const accountSentence = hasAccountImpact
    ? accountDirection === 'credit'
      ? ' An exact {{money.account_impact}} of prior Wallet-side liability was released as an allocation correction; this does not claim the same amount became newly spendable cash.'
      : ' The exact Wallet-side liability allocation for this event is {{money.account_impact}}.'
    : ' This event assigned no new Wallet-side liability to your account.';
  if (classification === 'wallet_refund') {
    return {
      title: 'Wallet top-up card refund completed',
      body: `Stripe confirmed a {{money.provider_amount}} refund for Wallet top-up ${reference} to the original payment method.${accountSentence} Bank posting times may vary.`,
    };
  }
  if (classification === 'wallet_dispute_opened') {
    return {
      title: 'Wallet top-up card dispute opened',
      body: `Stripe opened a dispute for {{money.provider_amount}} from Wallet top-up ${reference}.${accountSentence} This is not a refund, and no final outcome has been decided.`,
    };
  }
  if (classification === 'wallet_dispute_inquiry') {
    return {
      title: 'Wallet top-up card inquiry opened',
      body: `Stripe opened an inquiry concerning {{money.provider_amount}} from Wallet top-up ${reference}. No Wallet funds were reserved by this event, and no outcome has been decided. This is not a refund.`,
    };
  }
  if (classification === 'wallet_dispute_won_no_reserve') {
    return {
      title: 'Wallet top-up card dispute won',
      body: `Stripe marked the {{money.provider_amount}} dispute for Wallet top-up ${reference} as won. No Wallet liability was reserved or released by this event. This is not a new payment or refund.`,
    };
  }
  if (classification === 'wallet_dispute_won') {
    return {
      title: 'Wallet top-up card dispute won',
      body: `Stripe marked the {{money.provider_amount}} dispute for Wallet top-up ${reference} as won.${hasAccountImpact ? ' The Wallet-side liability allocation resolved by this outcome is {{money.account_impact}}; this does not claim that the same amount was newly credited as spendable cash.' : ' No Wallet-side liability was released for your account.'} This is not a new payment or refund.`,
    };
  }
  return {
    title: 'Wallet top-up card dispute lost',
    body: `Stripe marked the {{money.provider_amount}} dispute for Wallet top-up ${reference} as lost.${hasAccountImpact ? ' The Wallet-side liability allocation finalized by this outcome is {{money.account_impact}}.' : ' No Wallet-side liability was assigned to your account.'} This is a dispute result, not a separate refund.`,
  };
};

const sellerSourceRiskCopy = ({ classification, reference, direction, sourceLabel }) => {
  if (classification.endsWith('_refund')) {
    const movement = direction === 'credit'
      ? 'was restored as an exact allocation correction by {{money.seller_impact}}'
      : 'was reduced by {{money.seller_impact}}';
    return {
      title: `${sourceLabel} refund adjustment`,
      body: `Stripe completed a {{money.provider_amount}} card refund for ${reference}. Your frozen source-currency revenue ${movement}. This is not a live-FX estimate.`,
    };
  }
  if (classification.endsWith('_dispute_opened')) {
    return {
      title: `${sourceLabel} dispute opened - funds reserved`,
      body: `Stripe opened a {{money.provider_amount}} card dispute for ${reference}. {{money.seller_impact}} is temporarily reserved from your exact frozen allocation. This is not a refund, and no final outcome has been decided.`,
    };
  }
  if (classification.endsWith('_dispute_inquiry')) {
    return {
      title: `${sourceLabel} dispute inquiry opened`,
      body: `Stripe opened an inquiry concerning {{money.provider_amount}} for ${reference}. Your allocation is {{money.seller_impact}}, but no seller funds were reserved by this event. This is not a refund, and no outcome has been decided.`,
    };
  }
  if (classification.endsWith('_dispute_won_no_reserve')) {
    return {
      title: `${sourceLabel} dispute won`,
      body: `Stripe marked the {{money.provider_amount}} dispute for ${reference} as won. Your allocation is {{money.seller_impact}}, but no seller funds were reserved or released by this event. This is not a new payment or refund.`,
    };
  }
  if (classification.endsWith('_dispute_won')) {
    return {
      title: `${sourceLabel} dispute won - reserve released`,
      body: `Stripe marked the {{money.provider_amount}} dispute for ${reference} as won. Your {{money.seller_impact}} temporary reserve was released. This describes the dispute outcome only; it is not a new payment or refund.`,
    };
  }
  return {
    title: `${sourceLabel} dispute lost - reversal finalized`,
    body: `Stripe marked the {{money.provider_amount}} dispute for ${reference} as lost. Your exact {{money.seller_impact}} allocation is now a finalized ledger reversal. This is a dispute result, not a separate refund.`,
  };
};

const templatesFromSimpleCopy = copy => ({
  inapp: copy,
  push: copy,
  email: {
    subject: copy.title,
    text: copy.body,
    html: `<p>${escapeHtml(copy.body)
      .replace('{{money.provider_amount}}', '<strong>{{money.provider_amount}}</strong>')
      .replace('{{money.account_impact}}', '<strong>{{money.account_impact}}</strong>')
      .replace('{{money.seller_impact}}', '<strong>{{money.seller_impact}}</strong>')}</p>`,
  },
  whatsapp: { message: `${copy.title}\n\n${copy.body}` },
});

const assertSourceOwnership = ({ event, sourceType, sourceDocument, sourceField }) => {
  if (
    event?.sourceType !== sourceType
    || toId(event?.[sourceField]) !== toId(sourceDocument?._id)
    || event?.sourceReferenceId !== toId(sourceDocument?._id)
  ) {
    throw outboxError(
      'Stripe payment-risk notification does not own the supplied source.',
      'STRIPE_RISK_NOTIFICATION_SOURCE_MISMATCH',
    );
  }
};

async function enqueueStripeWalletRiskNotifications({
  event,
  walletTopUp,
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
}) {
  assertSourceOwnership({
    event,
    sourceType: 'wallet_top_up',
    sourceDocument: walletTopUp,
    sourceField: 'walletTopUp',
  });
  if (!event.classification.startsWith('wallet_')) {
    throw outboxError('Wallet payment-risk notification requires a Wallet risk event.');
  }
  const sourceId = toId(walletTopUp._id);
  const userId = toId(walletTopUp.user);
  if (!userId) throw outboxError('Wallet payment-risk source has no buyer owner.');
  const reference = sourceId.slice(-8).toUpperCase();
  const eventType = sourceEventType(event.classification);
  const providerMoney = providerMoneyForSourceEvent(event);
  const buyerMoney = [providerMoney];
  if (event.accountImpact) {
    buyerMoney.push(riskMoneySnapshot({
      event,
      amountMinor: event.accountImpact.sourceAmountMinor,
      currency: event.accountImpact.sourceCurrency,
      key: 'account_impact',
      label: 'Wallet-side risk allocation',
      sourcePath: 'accountImpact.sourceAmountMinor',
    }));
  }
  const buyerCopy = walletBuyerCopy({
    classification: event.classification,
    reference,
    hasAccountImpact: Boolean(event.accountImpact),
    accountDirection: event.accountImpact?.direction,
  });
  const buyer = await enqueueNotificationEvent({
    eventKey: `stripe-risk:${event.eventKey}:buyer:v1`,
    eventType,
    aggregateType: 'StripePaymentRiskEvent',
    aggregateId: event._id,
    occurredAt: event.occurredAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'buyer',
      user: userId,
      destinationPolicy: 'current_user',
      allowBlocked: true,
    },
    channels,
    templates: templatesFromSimpleCopy(buyerCopy),
    metadata: {
      category: 'payment',
      linkTo: '/user-dashboard/wallet',
      channelId: 'wallet',
      whatsappCategory: 'payment_risk',
      data: {
        type: eventType.replaceAll('.', '_'),
        walletTransactionId: sourceId,
        riskEventId: toId(event._id),
        ...(event.classification.endsWith('_refund')
          ? { providerReferences: event.refunds.map(refund => refund.refundId) }
          : { providerReference: event.disputeId }),
      },
    },
    money: buyerMoney,
    session,
  });

  const sellers = [];
  for (let index = 0; index < event.sellerImpacts.length; index += 1) {
    const impact = event.sellerImpacts[index];
    const useSource = impact.sourceAmountMinor > 0;
    const sellerMoney = riskMoneySnapshot({
      event,
      amountMinor: useSource ? impact.sourceAmountMinor : impact.amountUSDMinor,
      currency: useSource ? impact.sourceCurrency : 'USD',
      key: 'seller_impact',
      label: 'Seller Wallet-funded risk allocation',
      sourcePath: `sellerImpacts[${index}].${useSource ? 'sourceAmountMinor' : 'amountUSDMinor'}`,
    });
    const copy = sellerSourceRiskCopy({
      classification: event.classification,
      reference: `Wallet-funded commerce from top-up ${reference}`,
      direction: impact.direction,
      sourceLabel: 'Wallet-funded payment',
    });
    sellers.push(...await enqueueNotificationEvent({
      eventKey: `stripe-risk:${event.eventKey}:seller:${toId(impact.seller)}:v1`,
      eventType,
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: event._id,
      occurredAt: event.occurredAt,
      financial: true,
      recipient: {
        kind: 'user', audienceRole: 'seller', user: impact.seller,
        destinationPolicy: 'current_user', allowBlocked: true,
      },
      channels,
      templates: templatesFromSimpleCopy(copy),
      metadata: {
        category: 'payment',
        linkTo: '/seller-dashboard/payments',
        channelId: 'seller',
        whatsappCategory: 'payment_risk',
        data: {
          type: eventType.replaceAll('.', '_'),
          walletTransactionId: sourceId,
          riskEventId: toId(event._id),
          ...(event.classification.endsWith('_refund')
            ? { providerReferences: event.refunds.map(refund => refund.refundId) }
            : { providerReference: event.disputeId }),
        },
      },
      money: [providerMoney, sellerMoney],
      session,
    }));
  }
  return { buyer, sellers };
}

async function enqueueStripeReturnSettlementRiskNotifications({
  event,
  returnRequest,
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
}) {
  assertSourceOwnership({
    event,
    sourceType: 'return_settlement',
    sourceDocument: returnRequest,
    sourceField: 'returnRequest',
  });
  if (!event.classification.startsWith('return_')) {
    throw outboxError('Return payment-risk notification requires a return risk event.');
  }
  const requestId = toId(returnRequest._id);
  const returnNumber = safeText(returnRequest.returnNumber || requestId, 100);
  const eventType = sourceEventType(event.classification);
  const providerMoney = providerMoneyForSourceEvent(event);
  const records = [];
  for (let index = 0; index < event.sellerImpacts.length; index += 1) {
    const impact = event.sellerImpacts[index];
    const useSource = impact.sourceAmountMinor > 0;
    const sellerMoney = riskMoneySnapshot({
      event,
      amountMinor: useSource ? impact.sourceAmountMinor : impact.amountUSDMinor,
      currency: useSource ? impact.sourceCurrency : 'USD',
      key: 'seller_impact',
      label: 'Seller-funded return risk allocation',
      sourcePath: `sellerImpacts[${index}].${useSource ? 'sourceAmountMinor' : 'amountUSDMinor'}`,
    });
    const copy = sellerSourceRiskCopy({
      classification: event.classification,
      reference: `return ${returnNumber}`,
      direction: impact.direction,
      sourceLabel: 'Seller-funded return payment',
    });
    records.push(...await enqueueNotificationEvent({
      eventKey: `stripe-risk:${event.eventKey}:seller:${toId(impact.seller)}:v1`,
      eventType,
      aggregateType: 'StripePaymentRiskEvent',
      aggregateId: event._id,
      occurredAt: event.occurredAt,
      financial: true,
      recipient: {
        kind: 'user', audienceRole: 'seller', user: impact.seller,
        destinationPolicy: 'current_user', allowBlocked: true,
      },
      channels,
      templates: templatesFromSimpleCopy(copy),
      metadata: {
        category: 'payment',
        linkTo: `/seller-dashboard/order-management?tab=returns&returnId=${encodeURIComponent(requestId)}`,
        channelId: 'seller',
        whatsappCategory: 'payment_risk',
        relatedOrder: returnRequest.order,
        data: {
          type: eventType.replaceAll('.', '_'),
          returnRequestId: requestId,
          orderId: toId(returnRequest.order),
          riskEventId: toId(event._id),
          ...(event.classification.endsWith('_refund')
            ? { providerReferences: event.refunds.map(refund => refund.refundId) }
            : { providerReference: event.disputeId }),
        },
      },
      money: [providerMoney, sellerMoney],
      session,
    }));
  }
  return records;
}

async function enqueueReturnSafetyRefundSellerNotification(returnRequest, {
  channels = ['inapp', 'push', 'email', 'whatsapp'],
  session = null,
} = {}) {
  const settlement = returnRequest?.settlement;
  const requestId = toId(returnRequest?._id);
  const sellerId = toId(returnRequest?.seller);
  const refundId = safeText(settlement?.riskRefundId, 200);
  const refundMinor = settlement?.riskRefundAmountMinor;
  const currency = settlement?.riskRefundCurrency;
  if (
    !requestId
    || !sellerId
    || settlement?.riskRefundStatus !== 'succeeded'
    || !/^re_[A-Za-z0-9_]+$/.test(refundId)
    || !Number.isSafeInteger(refundMinor)
    || refundMinor <= 0
    || currency !== returnRequest?.currency
  ) {
    throw outboxError(
      'Return safety-refund notification requires exact completed provider evidence.',
      'RETURN_SAFETY_REFUND_NOTIFICATION_INVALID',
    );
  }
  let expectedMinor = null;
  try {
    expectedMinor = toMinorUnits(returnRequest?.refund?.totalAmount);
  } catch (_error) {
    expectedMinor = null;
  }
  if (
    !Number.isSafeInteger(expectedMinor)
    || expectedMinor <= 0
    || expectedMinor !== refundMinor
    || fromMinorUnits(expectedMinor) !== returnRequest?.refund?.totalAmount
  ) {
    throw outboxError(
      'Return safety-refund notification does not match the frozen return funding.',
      'RETURN_SAFETY_REFUND_NOTIFICATION_MONEY_MISMATCH',
    );
  }
  const returnNumber = safeText(returnRequest?.returnNumber || requestId, 100);
  const orderNumber = safeText(returnRequest?.orderId || toId(returnRequest?.order), 100);
  const occurredAt = asDate(settlement?.riskRefundedAt, 'Return safety-refund timestamp');
  const money = snapshotMinorMoney({
    key: 'safety_refund',
    label: 'Seller card safety refund',
    amountMinor: refundMinor,
    currency,
    sourceModel: 'ReturnRequest',
    sourceDocumentId: requestId,
    sourcePath: 'settlement.riskRefundAmountMinor',
  });
  const title = 'Seller card payment refunded';
  const detail = `Stripe refunded {{money.safety_refund}} from return ${returnNumber} to your original card because the underlying buyer Wallet funding had already been reversed. This return payment attempt did not create another buyer Wallet credit. Bank posting times may vary.`;
  return enqueueNotificationEvent({
    eventKey: `return:${requestId}:safety-refund:${crypto.createHash('sha256').update(refundId).digest('hex')}:seller:v1`,
    eventType: 'return.safety_refund_completed',
    aggregateType: 'ReturnRequest',
    aggregateId: requestId,
    occurredAt,
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'seller',
      user: sellerId,
      destinationPolicy: 'current_user',
      allowBlocked: true,
    },
    channels,
    templates: {
      inapp: { title, body: detail },
      push: { title, body: detail },
      email: {
        subject: `${title} - ${returnNumber}`,
        text: `${detail} Original order: #${orderNumber}.`,
        html: `<p>Stripe refunded <strong>{{money.safety_refund}}</strong> from return <strong>${escapeHtml(returnNumber)}</strong> to your original card because the underlying buyer Wallet funding had already been reversed.</p><p>This return payment attempt did not create another buyer Wallet credit. Bank posting times may vary.</p><p>Original order: <strong>#${escapeHtml(orderNumber)}</strong>.</p>`,
      },
      whatsapp: {
        message: `Seller Card Payment Refunded\n\nReturn: ${returnNumber}\nOrder: #${orderNumber}\nRefunded to your original card: {{money.safety_refund}}\n\nThe underlying buyer Wallet funding had already been reversed, so this payment attempt did not create another buyer Wallet credit. Bank posting times may vary.`,
      },
    },
    metadata: {
      category: 'payment',
      linkTo: `/seller-dashboard/order-management?tab=returns&returnId=${encodeURIComponent(requestId)}`,
      channelId: 'seller',
      whatsappCategory: 'payment_risk',
      relatedOrder: returnRequest?.order,
      data: {
        type: 'return_safety_refund_completed',
        returnRequestId: requestId,
        orderId: toId(returnRequest?.order),
        providerReference: refundId,
      },
    },
    money: [money],
    session,
  });
}

const reviewInput = payload => {
  const currency = typeof payload.currency === 'string'
    && ['USD', 'PKR', 'EUR', 'GBP'].includes(payload.currency.toUpperCase())
    ? payload.currency.toUpperCase()
    : '';
  const safeMinor = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const stripeEventId = safeText(payload.stripeEventId, 200);
  const reasonCode = safeText(payload.reasonCode || 'STRIPE_PAYMENT_RISK_REVIEW_REQUIRED', 100).toUpperCase();
  const occurredAt = asDate(payload.occurredAt, 'Stripe risk review timestamp');
  const reviewKey = crypto.createHash('sha256')
    .update(`${stripeEventId}:${reasonCode}`)
    .digest('hex');
  return {
    reviewKey,
    stripeEventId,
    stripeEventType: safeText(payload.stripeEventType, 100),
    occurredAt,
    sourceType: safeText(payload.sourceType || 'unknown', 80),
    sourceReferenceId: safeText(payload.sourceReferenceId, 200),
    paymentIntentId: safeText(payload.paymentIntentId, 200),
    chargeId: safeText(payload.chargeId, 200),
    reasonCode,
    reason: safeText(payload.reason || 'The signed Stripe event could not be reconciled automatically.', 500),
    currency,
    chargeAmountMinor: safeMinor(payload.chargeAmountMinor),
    refundExposureMinor: safeMinor(payload.refundExposureMinor),
    disputeId: safeText(payload.disputeId, 200),
    disputeStatus: safeText(payload.disputeStatus, 80),
    disputeExposureMinor: safeMinor(payload.disputeExposureMinor),
    status: 'open',
  };
};

async function recordStripePaymentRiskManualReview(payload, { session = null } = {}) {
  const normalized = reviewInput(payload);
  const candidate = new StripePaymentRiskReview({ ...normalized, contentHash: 'pending' });
  await candidate.validate();
  candidate.contentHash = contentHash(candidate.toObject({ depopulate: true }));
  let result;
  try {
    result = await StripePaymentRiskReview.findOneAndUpdate(
      { reviewKey: normalized.reviewKey },
      { $setOnInsert: candidate.toObject({ depopulate: true }) },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
        session,
      },
    ).select('+contentHash');
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    if (session?.inTransaction?.()) throw markTransactionRetryable(error);
    result = await StripePaymentRiskReview.findOne({ reviewKey: normalized.reviewKey })
      .select('+contentHash');
  }
  const review = result;
  if (!review || review.contentHash !== candidate.contentHash) {
    throw outboxError(
      'Stripe payment-risk review replay conflicts with its immutable evidence.',
      'STRIPE_RISK_REVIEW_IDEMPOTENCY_CONFLICT',
    );
  }

  const admins = await User.find({ role: 'admin', status: 'active' })
    .select('_id')
    .session(session)
    .lean();
  const title = 'Stripe payment risk requires manual review';
  const body = `Signed Stripe event ${safeText(review.stripeEventId, 100)} could not be safely classified (${safeText(review.reasonCode, 100)}). A durable review record was created; no customer or seller outcome notification was inferred.`;
  const notifications = [];
  for (const admin of admins) {
    notifications.push(...await enqueueNotificationEvent({
      eventKey: `stripe-risk-review:${review.reviewKey}:admin:${toId(admin._id)}:v1`,
      eventType: 'payment.risk_review_required',
      aggregateType: 'StripePaymentRiskReview',
      aggregateId: review._id,
      occurredAt: review.occurredAt,
      financial: false,
      recipient: {
        kind: 'user', audienceRole: 'admin', user: admin._id, destinationPolicy: 'current_user',
      },
      channels: ['inapp', 'push', 'email', 'whatsapp'],
      templates: {
        inapp: { title, body },
        push: { title, body },
        email: {
          subject: title,
          text: `${body} Open Admin Payments for related balance context, then investigate provider event ${safeText(review.stripeEventId, 100)} before changing any ledger or messaging.`,
          html: `<p>${escapeHtml(body)}</p><p>Open <strong>Admin Payments</strong> for related balance context, then investigate provider event <strong>${escapeHtml(safeText(review.stripeEventId, 100))}</strong> before changing any ledger or messaging.</p>`,
        },
        whatsapp: {
          message: `${title}\n\n${body}\n\nOpen Admin Payments for related balance context and investigate provider event ${safeText(review.stripeEventId, 100)} before changing any ledger or messaging.`,
        },
      },
      metadata: {
        category: 'payment',
        linkTo: '/admin-dashboard/payments',
        channelId: 'general',
        whatsappCategory: 'payment_risk',
        data: {
          type: 'stripe_payment_risk_review_required',
          reviewId: toId(review._id),
          sourceType: review.sourceType,
          reasonCode: review.reasonCode,
          providerEvent: review.stripeEventId,
        },
      },
      session,
    }));
  }
  return { review, notifications };
}

async function resolveStripePaymentRiskReviews({
  stripeEventId,
  resolutionNote = 'Automatic signed-event processing later completed with authoritative evidence.',
  session = null,
} = {}) {
  const normalizedEventId = safeText(stripeEventId, 200);
  if (!normalizedEventId) {
    throw outboxError(
      'Stripe payment-risk review resolution requires an event id.',
      'STRIPE_RISK_REVIEW_EVENT_ID_REQUIRED',
    );
  }
  const resolvedAt = new Date();
  const update = await StripePaymentRiskReview.updateMany({
    stripeEventId: normalizedEventId,
    status: 'open',
  }, {
    $set: {
      status: 'resolved',
      resolvedAt,
      resolutionNote: safeText(resolutionNote, 1000),
    },
  }, { session, runValidators: true });
  return {
    matchedCount: update.matchedCount ?? update.n ?? 0,
    modifiedCount: update.modifiedCount ?? update.nModified ?? 0,
    resolvedAt,
  };
}

module.exports = {
  enqueueReturnSafetyRefundSellerNotification,
  enqueueStripeOrderDisputeNotifications,
  enqueueStripeOrderRefundNotifications,
  enqueueStripeReturnSettlementRiskNotifications,
  enqueueStripeWalletRiskNotifications,
  persistStripePaymentRiskEvent,
  persistStripeOrderRiskEvent,
  persistStripeSourceDisputeEvent,
  reconcileStripeSourceRefundEvidence,
  recordStripePaymentRiskManualReview,
  resolveStripePaymentRiskReviews,
  reviewStripeSourceRisk,
};
