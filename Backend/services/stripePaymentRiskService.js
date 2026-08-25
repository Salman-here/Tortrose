'use strict';

const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
const Store = require('../models/Store');
const WalletTransaction = require('../models/WalletTransaction');
const StripeEntitlementPayment = require('../models/StripeEntitlementPayment');
const { getExpectedStripeTotalMinor } = require('./stripeOrderPaymentService');
const { toMinorUnits } = require('./moneyMath');
const { recoverRiskBlockedWalletTopUpCompletion } = require('./walletService');
const {
  flagStripeOrderPaymentRisk,
} = require('./stripeOrderPaymentRiskService');
const {
  flagStripeReturnSettlementRisk,
} = require('./stripeReturnSettlementRiskService');
const {
  flagWalletCreditPaymentRisk,
  paymentIntentIdOf,
} = require('./walletPaymentRiskService');
const {
  flagStripeEntitlementPaymentRisk,
} = require('./stripeEntitlementPaymentService');
const {
  isStripePreCompletionDisputeResolved,
  recordStripePreCompletionRisk,
  resolveStripePreCompletionDispute,
} = require('./stripePaymentRiskMarkerService');
const {
  FINANCIAL_DISPUTE_STATUSES,
} = require('./stripeOrderPaymentRiskService');
const {
  enqueueOrderStockRefundBuyerNotifications,
} = require('./financialNotificationOutboxService');
const {
  enqueueReturnSafetyRefundSellerNotification,
  recordStripePaymentRiskManualReview,
  resolveStripePaymentRiskReviews,
} = require('./stripePaymentRiskNotificationService');

const KNOWN_SOURCE_TYPES = new Set([
  'order_payment',
  'wallet_top_up',
  'return_settlement',
  'subdomain_purchase',
  'subscription_invoice',
]);

const riskError = (message, code, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const stripeObjectId = value => (
  typeof value === 'string' ? value : (typeof value?.id === 'string' ? value.id : '')
);

const stripeEventDate = ({ eventCreatedAt, charge }) => {
  if (eventCreatedAt instanceof Date && Number.isFinite(eventCreatedAt.getTime())) return eventCreatedAt;
  if (Number.isSafeInteger(eventCreatedAt) && eventCreatedAt > 0) return new Date(eventCreatedAt * 1000);
  if (Number.isSafeInteger(charge?.created) && charge.created > 0) return new Date(charge.created * 1000);
  return null;
};

const incompleteRefundEvidence = (reasonCode, reason) => ({
  complete: false,
  reasonCode,
  reason,
  refunds: [],
});

/**
 * A Charge exposes cumulative `amount_refunded`; it does not identify the new
 * refund delta by itself. Only a complete, non-paginated list of succeeded
 * Refund objects can support a customer receipt. Anything weaker is carried
 * to accounting as cumulative exposure but quarantined from notifications.
 */
const refundEvidenceFromCharge = charge => {
  const cumulative = charge?.amount_refunded ?? 0;
  if (cumulative === 0) return { complete: true, refunds: [], totalMinor: 0 };
  const list = charge?.refunds;
  if (!list || !Array.isArray(list.data)) {
    return incompleteRefundEvidence(
      'STRIPE_REFUND_OBJECTS_MISSING',
      'The Charge did not include the provider Refund objects needed to identify the exact new refund.',
    );
  }
  if (list.has_more !== false) {
    return incompleteRefundEvidence(
      'STRIPE_REFUND_OBJECTS_INCOMPLETE',
      'The Charge refund list was paginated or did not prove that it was complete.',
    );
  }

  const refunds = [];
  const seen = new Set();
  for (const refund of list.data) {
    if (String(refund?.status || '') !== 'succeeded') continue;
    const refundId = safeProviderId(refund?.id, 're_');
    const chargeId = stripeObjectId(refund?.charge);
    const paymentIntentId = stripeObjectId(refund?.payment_intent);
    const amountMinor = refund?.amount;
    const currency = typeof refund?.currency === 'string'
      ? refund.currency.trim().toUpperCase()
      : '';
    const createdAt = Number.isSafeInteger(refund?.created) && refund.created > 0
      ? new Date(refund.created * 1000)
      : null;
    if (
      !refundId
      || seen.has(refundId)
      || chargeId !== stripeObjectId(charge?.id)
      || paymentIntentId !== paymentIntentIdOf(charge)
      || !Number.isSafeInteger(amountMinor)
      || amountMinor <= 0
      || !['USD', 'PKR', 'EUR', 'GBP'].includes(currency)
      || !createdAt
    ) {
      return incompleteRefundEvidence(
        'STRIPE_REFUND_OBJECT_INVALID',
        'At least one succeeded Stripe Refund object was malformed or did not belong to this Charge.',
      );
    }
    seen.add(refundId);
    refunds.push({
      refundId,
      amountMinor,
      currency,
      createdAt,
      metadataType: String(refund?.metadata?.type || '').trim(),
      metadataOrderId: String(refund?.metadata?.mongoOrderId || '').trim(),
      metadataWalletTransactionId: String(refund?.metadata?.walletTransactionId || '').trim(),
      metadataReturnRequestId: String(refund?.metadata?.returnRequestId || '').trim(),
    });
  }
  refunds.sort((left, right) => left.refundId.localeCompare(right.refundId));
  const totalMinor = refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
  if (!Number.isSafeInteger(totalMinor) || totalMinor !== cumulative) {
    return incompleteRefundEvidence(
      'STRIPE_REFUND_OBJECT_TOTAL_MISMATCH',
      'Succeeded Stripe Refund objects did not exactly reconcile to Charge.amount_refunded.',
    );
  }
  return { complete: true, refunds, totalMinor };
};

const safeProviderId = (value, prefix) => {
  const id = typeof value === 'string' ? value.trim() : '';
  return new RegExp(`^${prefix}[A-Za-z0-9_]+$`).test(id) ? id : '';
};

const riskPayload = ({ charge, eventId, eventType, eventCreatedAt }) => ({
  paymentIntentId: paymentIntentIdOf(charge),
  chargeId: charge?.id,
  eventId,
  eventType,
  eventOccurredAt: stripeEventDate({ eventCreatedAt, charge }),
  chargeAmountMinor: charge?.amount,
  refundExposureMinor: charge?.amount_refunded ?? 0,
  refundEvidence: refundEvidenceFromCharge(charge),
  disputeId: charge?.disputeId || null,
  disputeExposureMinor: charge?.disputeAmount ?? 0,
  disputeStatus: charge?.disputeStatus ?? '',
  currency: charge?.currency,
});

const ignoredStockRefundOrder = async paymentIntentId => {
  if (!paymentIntentId) return null;
  return Order.findOne({
    paymentMethod: 'stripe',
    isPaid: false,
    orderStatus: 'cancelled',
    'paymentResult.stockRefundStatus': 'succeeded',
    $or: [
      { stripePaymentIntentId: paymentIntentId },
      { 'paymentResult.paymentIntentId': paymentIntentId },
    ],
  }).lean();
};

const completedReturnSafetyRefund = paymentIntentId => ReturnRequest.findOne({
  'settlement.stripePaymentIntentId': paymentIntentId,
  'settlement.riskRefundStatus': 'succeeded',
  'settlement.riskRefundId': { $type: 'string', $ne: '' },
});

const persistedRiskOwnershipCandidates = async ({ paymentIntentId, chargeId, invoiceId = '' }) => {
  const entitlementClauses = [
    ...(paymentIntentId ? [
      { paymentIntentId },
      { 'chargeTracks.paymentIntentId': paymentIntentId },
    ] : []),
    ...(chargeId ? [
      { chargeIds: chargeId },
      { 'chargeTracks.chargeId': chargeId },
    ] : []),
  ];
  const [orders, walletTopUps, returnSettlements, entitlementPayments, historicalStore] = await Promise.all([
    paymentIntentId
      ? Order.find({
        paymentMethod: 'stripe',
        isPaid: true,
        $or: [
          { stripePaymentIntentId: paymentIntentId },
          { 'paymentResult.paymentIntentId': paymentIntentId },
        ],
      }).select('_id').limit(2).lean()
      : [],
    paymentIntentId
      ? WalletTransaction.find({
        type: 'top_up',
        status: 'completed',
        stripePaymentIntentId: paymentIntentId,
      }).select('_id').limit(2).lean()
      : [],
    paymentIntentId
      ? ReturnRequest.find({
        status: 'returned',
        'settlement.status': 'completed',
        'settlement.stripePaymentIntentId': paymentIntentId,
      }).select('_id').limit(2).lean()
      : [],
    entitlementClauses.length
      ? StripeEntitlementPayment.find({ $or: entitlementClauses })
        .select('_id entitlementType seller')
        .limit(20)
        .lean()
      : [],
    paymentIntentId
      ? Store.findOne({
        $or: [
          { 'subdomainPurchase.stripePaymentId': paymentIntentId },
          { 'subdomainPurchase.processedPaymentIds': paymentIntentId },
        ],
      }).select('_id').lean()
      : null,
  ]);
  const candidates = [
    ...orders.map(row => ({ sourceType: 'order_payment', sourceReferenceId: String(row._id) })),
    ...walletTopUps.map(row => ({ sourceType: 'wallet_top_up', sourceReferenceId: String(row._id) })),
    ...returnSettlements.map(row => ({ sourceType: 'return_settlement', sourceReferenceId: String(row._id) })),
  ];
  if (entitlementPayments.length || historicalStore) {
    candidates.push({
      sourceType: 'entitlement_payment',
      sourceReferenceId: entitlementPayments.length
        ? entitlementPayments.map(row => String(row._id)).sort().join(',').slice(0, 200)
        : `store:${historicalStore._id}`,
    });
  } else if (invoiceId && candidates.length) {
    // An Invoice-backed Charge cannot simultaneously be an ordinary
    // order/Wallet/return PaymentIntent. Treat that impossible collision as
    // ambiguous even before a legacy entitlement row is materialized.
    candidates.push({
      sourceType: 'possible_entitlement_invoice',
      sourceReferenceId: invoiceId,
    });
  }
  return candidates;
};

const quarantineAmbiguousRiskOwnership = async ({ payload, candidates }) => {
  const ownerFingerprint = candidates
    .map(candidate => `${candidate.sourceType}:${candidate.sourceReferenceId}`)
    .sort()
    .join(',')
    .slice(0, 200);
  const review = await manualReviewForPayload(payload, {
    sourceType: 'ambiguous_local_payment',
    sourceReferenceId: ownerFingerprint,
    reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_AMBIGUOUS',
    reason: 'The signed Stripe event matched more than one durable local payment owner. No customer, seller, Wallet, return, or entitlement outcome was inferred.',
  });
  return {
    handled: true,
    sourceType: 'ambiguous_local_payment',
    manualReview: review.review,
  };
};

const quarantineConflictingRiskOwnership = async ({
  payload,
  metadataType,
  metadataReferenceId,
  candidates,
}) => {
  const durableFingerprint = candidates
    .map(candidate => `${candidate.sourceType}:${candidate.sourceReferenceId}`)
    .sort()
    .join(',')
    .slice(0, 200);
  const review = await manualReviewForPayload(payload, {
    sourceType: 'conflicting_payment_metadata',
    sourceReferenceId: durableFingerprint,
    reasonCode: 'STRIPE_PAYMENT_RISK_OWNER_MISMATCH',
    reason: `Signed Stripe metadata declared ${metadataType}:${metadataReferenceId}, but the PaymentIntent already belongs to a different durable local source. No outcome was inferred.`,
  });
  return {
    handled: true,
    sourceType: 'conflicting_payment_metadata',
    manualReview: review.review,
  };
};

const manualReviewForPayload = (payload, {
  sourceType,
  sourceReferenceId = '',
  reasonCode,
  reason,
}) => recordStripePaymentRiskManualReview({
  stripeEventId: payload.eventId,
  stripeEventType: payload.eventType,
  occurredAt: payload.eventOccurredAt || new Date(0),
  sourceType,
  sourceReferenceId,
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
});

const exactInternalRefundEvidence = ({ payload, refundId, metadataType, sourceReferenceId }) => {
  if (!payload.refundEvidence?.complete) return true;
  const refunds = payload.refundEvidence.refunds || [];
  if (refunds.length !== 1 || refunds[0].refundId !== refundId) return false;
  const evidence = refunds[0];
  if (evidence.metadataType && evidence.metadataType !== metadataType) return false;
  const evidenceReference = metadataType === 'order_inventory_refund'
    ? evidence.metadataOrderId
    : evidence.metadataReturnRequestId;
  return !evidenceReference || evidenceReference === String(sourceReferenceId);
};

const classifyCompletedInternalRefund = async payload => {
  if (payload.eventType !== 'charge.refunded' || !(payload.refundExposureMinor > 0)) return null;

  const stockOrder = await ignoredStockRefundOrder(payload.paymentIntentId);
  if (stockOrder) {
    let expectedAmountMinor;
    try {
      expectedAmountMinor = getExpectedStripeTotalMinor(stockOrder);
    } catch (_error) {
      expectedAmountMinor = null;
    }
    const refundId = String(stockOrder.paymentResult?.stockRefundId || '').trim();
    const storedAmountMinor = stockOrder.paymentResult?.stockRefundAmountMinor;
    const amountMinor = Number.isSafeInteger(storedAmountMinor)
      ? storedAmountMinor
      : expectedAmountMinor;
    const currency = String(
      stockOrder.paymentResult?.stockRefundCurrency || stockOrder.currency || '',
    ).trim().toUpperCase();
    const exact = (
      /^re_[A-Za-z0-9_]+$/.test(refundId)
      && Number.isSafeInteger(expectedAmountMinor)
      && expectedAmountMinor > 0
      && amountMinor === expectedAmountMinor
      && currency === stockOrder.currency
      && payload.chargeAmountMinor === expectedAmountMinor
      && payload.refundExposureMinor === expectedAmountMinor
      && String(payload.currency || '').trim().toUpperCase() === currency
      && exactInternalRefundEvidence({
        payload,
        refundId,
        metadataType: 'order_inventory_refund',
        sourceReferenceId: stockOrder._id,
      })
    );
    if (!exact) {
      const review = await manualReviewForPayload(payload, {
        sourceType: 'order_inventory_refund',
        sourceReferenceId: stockOrder._id,
        reasonCode: 'ORDER_STOCK_REFUND_EVIDENCE_MISMATCH',
        reason: 'The signed Charge refund did not exactly match the persisted stock-loss refund.',
      });
      return { handled: true, sourceType: 'order_inventory_refund', manualReview: review.review };
    }
    if (!Number.isSafeInteger(storedAmountMinor) || !stockOrder.paymentResult?.stockRefundCurrency) {
      await Order.updateOne({
        _id: stockOrder._id,
        'paymentResult.stockRefundId': refundId,
        'paymentResult.stockRefundStatus': 'succeeded',
        $or: [
          { 'paymentResult.stockRefundAmountMinor': null },
          { 'paymentResult.stockRefundCurrency': { $in: [null, ''] } },
        ],
      }, {
        $set: {
          'paymentResult.stockRefundAmountMinor': expectedAmountMinor,
          'paymentResult.stockRefundCurrency': currency,
        },
      }, { runValidators: true });
    }
    const current = await Order.findById(stockOrder._id);
    await enqueueOrderStockRefundBuyerNotifications(current);
    return { handled: true, sourceType: 'order_inventory_refund', order: current };
  }

  const safetyRefund = await completedReturnSafetyRefund(payload.paymentIntentId);
  if (safetyRefund) {
    let expectedAmountMinor;
    try {
      expectedAmountMinor = toMinorUnits(safetyRefund.refund?.totalAmount);
    } catch (_error) {
      expectedAmountMinor = null;
    }
    const refundId = String(safetyRefund.settlement?.riskRefundId || '').trim();
    const storedAmountMinor = safetyRefund.settlement?.riskRefundAmountMinor;
    const amountMinor = Number.isSafeInteger(storedAmountMinor)
      ? storedAmountMinor
      : expectedAmountMinor;
    const currency = String(
      safetyRefund.settlement?.riskRefundCurrency || safetyRefund.currency || '',
    ).trim().toUpperCase();
    const exact = (
      /^re_[A-Za-z0-9_]+$/.test(refundId)
      && Number.isSafeInteger(expectedAmountMinor)
      && expectedAmountMinor > 0
      && amountMinor === expectedAmountMinor
      && currency === safetyRefund.currency
      && payload.chargeAmountMinor === expectedAmountMinor
      && payload.refundExposureMinor === expectedAmountMinor
      && String(payload.currency || '').trim().toUpperCase() === currency
      && exactInternalRefundEvidence({
        payload,
        refundId,
        metadataType: 'return_settlement_safety_refund',
        sourceReferenceId: safetyRefund._id,
      })
    );
    if (!exact) {
      const review = await manualReviewForPayload(payload, {
        sourceType: 'return_settlement_safety_refund',
        sourceReferenceId: safetyRefund._id,
        reasonCode: 'RETURN_SAFETY_REFUND_EVIDENCE_MISMATCH',
        reason: 'The signed Charge refund did not exactly match the persisted return safety refund.',
      });
      return { handled: true, sourceType: 'return_settlement_safety_refund', manualReview: review.review };
    }
    if (!Number.isSafeInteger(storedAmountMinor) || !safetyRefund.settlement?.riskRefundCurrency) {
      await ReturnRequest.updateOne({
        _id: safetyRefund._id,
        'settlement.riskRefundId': refundId,
        'settlement.riskRefundStatus': 'succeeded',
        $or: [
          { 'settlement.riskRefundAmountMinor': null },
          { 'settlement.riskRefundCurrency': { $in: [null, ''] } },
        ],
      }, {
        $set: {
          'settlement.riskRefundAmountMinor': expectedAmountMinor,
          'settlement.riskRefundCurrency': currency,
        },
      }, { runValidators: true });
    }
    const current = await ReturnRequest.findById(safetyRefund._id);
    await enqueueReturnSafetyRefundSellerNotification(current);
    return { handled: true, sourceType: 'return_settlement_safety_refund', returnRequest: current };
  }
  return null;
};

const quarantineInternalRefundDispute = async payload => {
  if (!payload.eventType.startsWith('charge.dispute.')) return null;
  const stockOrder = await ignoredStockRefundOrder(payload.paymentIntentId);
  if (stockOrder) {
    const review = await manualReviewForPayload(payload, {
      sourceType: 'order_inventory_refund',
      sourceReferenceId: stockOrder._id,
      reasonCode: 'DISPUTE_AFTER_ORDER_STOCK_REFUND',
      reason: 'Stripe reported a dispute after the captured order had already been fully refunded for unavailable inventory. No buyer refund or seller outcome was inferred.',
    });
    return { handled: true, sourceType: 'order_inventory_refund', manualReview: review.review };
  }
  const safetyRefund = await completedReturnSafetyRefund(payload.paymentIntentId);
  if (safetyRefund) {
    const review = await manualReviewForPayload(payload, {
      sourceType: 'return_settlement_safety_refund',
      sourceReferenceId: safetyRefund._id,
      reasonCode: 'DISPUTE_AFTER_RETURN_SAFETY_REFUND',
      reason: 'Stripe reported a dispute after the seller return-funding charge had already been safety-refunded. No buyer refund or seller ledger outcome was inferred.',
    });
    return { handled: true, sourceType: 'return_settlement_safety_refund', manualReview: review.review };
  }
  return null;
};

const sourceReferenceFromMetadata = metadata => {
  const sourceType = String(metadata?.type || '').trim();
  if (sourceType === 'order_payment') {
    return String(metadata?.mongoOrderId || '').trim();
  }
  if (sourceType === 'wallet_top_up') {
    return String(metadata?.walletTransactionId || '').trim();
  }
  if (sourceType === 'return_settlement') {
    return String(metadata?.returnRequestId || '').trim();
  }
  if (sourceType === 'subdomain_purchase') {
    return String(metadata?.storeId || metadata?.sellerId || '').trim();
  }
  if (sourceType === 'subscription_invoice') {
    return String(
      metadata?.invoiceId
      || metadata?.stripeSubscriptionId
      || metadata?.sellerId
      || '',
    ).trim();
  }
  return '';
};

const isBlockingFinancialRiskEvent = ({ eventType, charge }) => (
  (
    eventType === 'charge.refunded'
    && Number.isSafeInteger(charge?.amount_refunded)
    && charge.amount_refunded > 0
  )
  || eventType === 'charge.dispute.funds_withdrawn'
  || (
    eventType === 'charge.dispute.created'
    && FINANCIAL_DISPUTE_STATUSES.has(String(charge?.disputeStatus || ''))
  )
  || (
    eventType === 'charge.dispute.closed'
    && String(charge?.disputeStatus || '') === 'lost'
  )
);

const hasCompletedLocalSource = async ({ sourceType, sourceReferenceId, paymentIntentId }) => {
  if (sourceType === 'wallet_top_up') {
    return Boolean(await WalletTransaction.exists({
      _id: sourceReferenceId,
      type: 'top_up',
      status: 'completed',
      stripePaymentIntentId: paymentIntentId,
    }));
  }
  if (sourceType === 'order_payment') {
    return Boolean(await Order.exists({
      _id: sourceReferenceId,
      paymentMethod: 'stripe',
      isPaid: true,
      $or: [
        { stripePaymentIntentId: paymentIntentId },
        { 'paymentResult.paymentIntentId': paymentIntentId },
      ],
    }));
  }
  if (sourceType === 'return_settlement') {
    return Boolean(await ReturnRequest.exists({
      _id: sourceReferenceId,
      status: 'returned',
      'settlement.status': 'completed',
      'settlement.stripePaymentIntentId': paymentIntentId,
    }));
  }
  return false;
};

/**
 * Classify a signed Stripe reversal by immutable payment metadata, with a
 * persisted-reference fallback for historical charges. Recognized commerce
 * payments fail retryably when their source cannot be reconciled; unrelated
 * Stripe integrations are deliberately ignored.
 */
const processStripePaymentRisk = async ({ charge, eventId, eventType, eventCreatedAt = null }) => {
  const payload = riskPayload({ charge, eventId, eventType, eventCreatedAt });
  if (!payload.paymentIntentId || !payload.chargeId || !eventId) {
    throw riskError('Stripe reversal references are incomplete.', 'STRIPE_PAYMENT_RISK_REFERENCE_MISSING', 400);
  }
  const completedInternalRefund = await classifyCompletedInternalRefund(payload);
  if (completedInternalRefund) return completedInternalRefund;
  const internalRefundDispute = await quarantineInternalRefundDispute(payload);
  if (internalRefundDispute) return internalRefundDispute;
  const metadataType = String(charge?.metadata?.type || '').trim();
  const disputeWonEvent = payload.disputeStatus === 'won'
    || eventType === 'charge.dispute.funds_reinstated';

  // Stripe can deliver a refund/dispute before its success webhook. Persist a
  // linearizable ownership marker before querying only completed local rows.
  // If this write wins, later completion must close without granting value; if
  // completion already claimed the marker, ordinary risk accounting retries
  // after that completion commits.
  if (['order_payment', 'wallet_top_up', 'return_settlement'].includes(metadataType)) {
    const sourceReferenceId = sourceReferenceFromMetadata(charge?.metadata);
    if (sourceReferenceId) {
      const completedCandidates = await persistedRiskOwnershipCandidates({
        paymentIntentId: payload.paymentIntentId,
        chargeId: payload.chargeId,
        invoiceId: stripeObjectId(charge?.invoice),
      });
      const declaredOwnerIsDurable = completedCandidates.some(candidate => (
        candidate.sourceType === metadataType
        && candidate.sourceReferenceId === sourceReferenceId
      ));
      if (completedCandidates.length && !declaredOwnerIsDurable) {
        return quarantineConflictingRiskOwnership({
          payload,
          metadataType,
          metadataReferenceId: sourceReferenceId,
          candidates: completedCandidates,
        });
      }
      if (
        eventType.startsWith('charge.dispute.')
        && payload.disputeId
        && await isStripePreCompletionDisputeResolved({
          paymentIntentId: payload.paymentIntentId,
          sourceType: metadataType,
          sourceReferenceId,
          disputeId: payload.disputeId,
        })
        && !disputeWonEvent
      ) {
        return {
          handled: true,
          sourceType: metadataType,
          preCompletionResolved: true,
          ignoredOutOfOrder: true,
        };
      }
      const alreadyCompleted = await hasCompletedLocalSource({
        sourceType: metadataType,
        sourceReferenceId,
        paymentIntentId: payload.paymentIntentId,
      });
      if (!alreadyCompleted) {
        if (
          eventType.startsWith('charge.dispute.')
          && disputeWonEvent
        ) {
          const resolution = await resolveStripePreCompletionDispute({
            paymentIntentId: payload.paymentIntentId,
            sourceType: metadataType,
            sourceReferenceId,
            chargeId: payload.chargeId,
            disputeId: payload.disputeId,
            eventId,
          });
          let recovery = null;
          if (
            metadataType === 'wallet_top_up'
            && resolution.stillBlocked !== true
          ) {
            recovery = await recoverRiskBlockedWalletTopUpCompletion({
              paymentIntentId: payload.paymentIntentId,
              eventId,
            });
          }
          return {
            handled: true,
            sourceType: metadataType,
            preCompletionResolved: resolution.resolvedBeforeCompletion,
            stillBlocked: resolution.stillBlocked === true,
            marker: resolution.marker,
            recovery,
          };
        }
        if (!isBlockingFinancialRiskEvent({ eventType, charge })) {
          return {
            handled: true,
            sourceType: metadataType,
            preCompletionDeferred: true,
          };
        }
        const marker = await recordStripePreCompletionRisk({
          paymentIntentId: payload.paymentIntentId,
          sourceType: metadataType,
          sourceReferenceId,
          chargeId: payload.chargeId,
          eventId,
          eventType,
          currency: payload.currency,
          chargeAmountMinor: payload.chargeAmountMinor,
          disputeId: payload.disputeId,
        });
        if (marker.blockedBeforeCompletion) {
          return {
            handled: true,
            sourceType: metadataType,
            preCompletionBlocked: true,
            marker: marker.marker,
          };
        }
        if (marker.ignoredResolvedDispute) {
          return {
            handled: true,
            sourceType: metadataType,
            preCompletionResolved: true,
            ignoredOutOfOrder: true,
            marker: marker.marker,
          };
        }
      }
    } else {
      // Historical Charges may identify the payment domain without carrying
      // the local Mongo reference. A single durable owner in that domain is
      // still deterministic; two rows sharing one PaymentIntent are not.
      // Quarantine before the domain service can select an arbitrary findOne.
      const sameDomainCandidates = (await persistedRiskOwnershipCandidates({
        paymentIntentId: payload.paymentIntentId,
        chargeId: payload.chargeId,
        invoiceId: stripeObjectId(charge?.invoice),
      })).filter(candidate => candidate.sourceType === metadataType);
      if (sameDomainCandidates.length > 1) {
        return quarantineAmbiguousRiskOwnership({
          payload,
          candidates: sameDomainCandidates,
        });
      }
    }
  }

  if (metadataType === 'order_payment') {
    const result = await flagStripeOrderPaymentRisk(payload);
    if (result) return result;
    const stockRefund = await ignoredStockRefundOrder(payload.paymentIntentId);
    if (stockRefund) {
      return { handled: true, sourceType: 'order_inventory_refund', order: stockRefund };
    }
    throw riskError('Stripe reversed a paid order that could not be found.', 'STRIPE_ORDER_RISK_SOURCE_MISSING');
  }
  if (metadataType === 'wallet_top_up') {
    const result = await flagWalletCreditPaymentRisk({
      ...payload,
      sourceType: metadataType,
    });
    if (result) return result;
    throw riskError(
      `Stripe reversed a completed ${metadataType} payment that could not be found.`,
      'WALLET_PAYMENT_RISK_SOURCE_MISSING',
    );
  }
  if (metadataType === 'return_settlement') {
    const result = await flagStripeReturnSettlementRisk(payload);
    if (result) return result;
    throw riskError(
      'Stripe reversed a completed return_settlement payment that could not be found.',
      'RETURN_PAYMENT_RISK_SOURCE_MISSING',
    );
  }
  if (metadataType === 'subdomain_purchase' || metadataType === 'subscription_invoice') {
    const durableCandidates = await persistedRiskOwnershipCandidates({
      paymentIntentId: payload.paymentIntentId,
      chargeId: payload.chargeId,
      invoiceId: stripeObjectId(charge?.invoice),
    });
    const nonEntitlementCandidates = durableCandidates.filter(candidate => (
      ['order_payment', 'wallet_top_up', 'return_settlement'].includes(candidate.sourceType)
    ));
    if (nonEntitlementCandidates.length) {
      // Signed metadata is strong routing evidence, but it cannot override a
      // contradictory completed local ledger. Never let one illegally reused
      // PaymentIntent reverse both an ordinary commerce payment and an
      // entitlement; quarantine before either domain mutates.
      if (durableCandidates.length > 1) {
        return quarantineAmbiguousRiskOwnership({
          payload,
          candidates: durableCandidates,
        });
      }
      return quarantineConflictingRiskOwnership({
        payload,
        metadataType,
        metadataReferenceId: sourceReferenceFromMetadata(charge?.metadata),
        candidates: durableCandidates,
      });
    }
    const result = await flagStripeEntitlementPaymentRisk({
      charge,
      eventId,
      eventType,
      eventOccurredAt: payload.eventOccurredAt,
      refundEvidence: payload.refundEvidence,
    });
    if (result) return result;
    throw riskError(
      `Stripe reversed a completed ${metadataType} payment that could not be found.`,
      'STRIPE_ENTITLEMENT_RISK_SOURCE_MISSING',
    );
  }

  // Older charges can lack copied metadata. Resolve every persisted owner
  // before mutating any one ledger; sequentially accepting the first match
  // would guess when a corrupt/duplicated PaymentIntent belongs to two local
  // payment domains.
  const entitlementInput = {
    charge,
    eventId,
    eventType,
    eventOccurredAt: payload.eventOccurredAt,
    refundEvidence: payload.refundEvidence,
  };
  const resolveCandidates = () => persistedRiskOwnershipCandidates({
    paymentIntentId: payload.paymentIntentId,
    chargeId: payload.chargeId,
    invoiceId: stripeObjectId(charge?.invoice),
  });
  const dispatchCandidate = async candidate => {
    if (candidate.sourceType === 'wallet_top_up') {
      const result = await flagWalletCreditPaymentRisk({ ...payload, sourceType: null });
      if (result) return result;
      throw riskError('The resolved Wallet payment owner disappeared.', 'WALLET_PAYMENT_RISK_SOURCE_MISSING');
    }
    if (candidate.sourceType === 'return_settlement') {
      const result = await flagStripeReturnSettlementRisk(payload);
      if (result) return result;
      throw riskError('The resolved return payment owner disappeared.', 'RETURN_PAYMENT_RISK_SOURCE_MISSING');
    }
    if (candidate.sourceType === 'order_payment') {
      const result = await flagStripeOrderPaymentRisk(payload);
      if (result) return result;
      throw riskError('The resolved order payment owner disappeared.', 'STRIPE_ORDER_RISK_SOURCE_MISSING');
    }
    const result = await flagStripeEntitlementPaymentRisk(entitlementInput);
    if (result) return result;
    throw riskError('The resolved entitlement payment owner disappeared.', 'STRIPE_ENTITLEMENT_RISK_SOURCE_MISSING');
  };

  let candidates = await resolveCandidates();
  if (candidates.length > 1) {
    return quarantineAmbiguousRiskOwnership({ payload, candidates });
  }
  if (candidates.length === 1) return dispatchCandidate(candidates[0]);

  // Entitlement ownership can be reconstructed from Stripe Invoice Payment
  // evidence when a historical local ledger row does not exist yet. Only try
  // that mutating reconstruction after proving no other persisted owner.
  const entitlementResult = await flagStripeEntitlementPaymentRisk(entitlementInput);
  if (entitlementResult) return entitlementResult;

  // Close the small race in which a completed owner committed while the
  // metadata-less entitlement lookup was running.
  candidates = await resolveCandidates();
  if (candidates.length > 1) {
    return quarantineAmbiguousRiskOwnership({ payload, candidates });
  }
  if (candidates.length === 1) return dispatchCandidate(candidates[0]);

  if (metadataType && KNOWN_SOURCE_TYPES.has(metadataType)) {
    throw riskError('Stripe payment-risk source could not be reconciled.', 'STRIPE_PAYMENT_RISK_SOURCE_MISSING');
  }
  return null;
};

const notificationResultRequiresReview = value => Boolean(
  value?.manualReview
  || value?.persisted?.manualReview
);

const stripeRiskResultRequiresReview = result => Boolean(
  result?.manualReview
  || notificationResultRequiresReview(result?.refundNotifications)
  || (Array.isArray(result?.disputeNotifications)
    && result.disputeNotifications.some(notificationResultRequiresReview))
  || notificationResultRequiresReview(result?.riskNotifications?.refund)
  || result?.riskNotifications?.allocationReview?.review
  || (Array.isArray(result?.riskNotifications?.disputes)
    && result.riskNotifications.disputes.some(notificationResultRequiresReview))
);

const flagStripePaymentRisk = async input => {
  const result = await processStripePaymentRisk(input);
  if (result?.handled && !stripeRiskResultRequiresReview(result)) {
    // A temporary provider/database anomaly may have created an open admin
    // review on an earlier delivery. Close it only after this same signed event
    // reaches an authoritative terminal/deferred local result. Delivery-time
    // authority then suppresses any stale queued alert.
    await resolveStripePaymentRiskReviews({ stripeEventId: input?.eventId });
  }
  return result;
};

const recordFailedStripePaymentRiskReview = async ({
  charge,
  eventId,
  eventType,
  eventCreatedAt = null,
  error,
}) => {
  const metadataType = String(charge?.metadata?.type || '').trim();
  if (!eventId || !eventType) return null;
  const payload = riskPayload({ charge, eventId, eventType, eventCreatedAt });
  let sourceType = metadataType;
  let sourceReferenceId = sourceReferenceFromMetadata(charge?.metadata);

  // A legacy or mistyped metadata.type must not suppress review when the
  // PaymentIntent is durably owned by this application. Conversely, do not
  // create admin incidents for unrelated Stripe integrations merely because a
  // malformed external Charge caused a fallback parser to reject it.
  if (!KNOWN_SOURCE_TYPES.has(metadataType)) {
    const entitlementOwnershipClauses = [
      ...(payload.paymentIntentId ? [
        { paymentIntentId: payload.paymentIntentId },
        { 'chargeTracks.paymentIntentId': payload.paymentIntentId },
      ] : []),
      ...(payload.chargeId ? [
        { chargeIds: payload.chargeId },
        { 'chargeTracks.chargeId': payload.chargeId },
      ] : []),
    ];
    const [order, walletTopUp, returnSettlement, entitlementPayments] = await Promise.all([
      payload.paymentIntentId
        ? Order.findOne({
          paymentMethod: 'stripe',
          isPaid: true,
          $or: [
            { stripePaymentIntentId: payload.paymentIntentId },
            { 'paymentResult.paymentIntentId': payload.paymentIntentId },
          ],
        }).select('_id').lean()
        : Promise.resolve(null),
      payload.paymentIntentId
        ? WalletTransaction.findOne({
          type: 'top_up',
          status: 'completed',
          stripePaymentIntentId: payload.paymentIntentId,
        }).select('_id').lean()
        : Promise.resolve(null),
      payload.paymentIntentId
        ? ReturnRequest.findOne({
          status: 'returned',
          'settlement.status': 'completed',
          'settlement.stripePaymentIntentId': payload.paymentIntentId,
        }).select('_id').lean()
        : Promise.resolve(null),
      entitlementOwnershipClauses.length
        ? StripeEntitlementPayment.find({ $or: entitlementOwnershipClauses })
          .select('_id entitlementType')
          // More than one row can legitimately contribute to one provider
          // payment. The review keeps every row visible, while the cap avoids
          // an unbounded incident payload if persisted ownership is corrupt.
          .limit(20)
          .lean()
        : Promise.resolve([]),
    ]);
    const ownedSources = [
      order && { sourceType: 'order_payment', sourceReferenceId: String(order._id) },
      walletTopUp && { sourceType: 'wallet_top_up', sourceReferenceId: String(walletTopUp._id) },
      returnSettlement && { sourceType: 'return_settlement', sourceReferenceId: String(returnSettlement._id) },
      ...entitlementPayments.map(payment => ({
        sourceType: payment.entitlementType === 'subdomain'
          ? 'subdomain_purchase'
          : 'subscription_invoice',
        sourceReferenceId: String(payment._id),
      })),
    ].filter(Boolean);
    if (!ownedSources.length) return null;
    if (ownedSources.length === 1) {
      [{ sourceType, sourceReferenceId }] = ownedSources;
    } else {
      sourceType = 'ambiguous_local_payment';
      sourceReferenceId = ownedSources
        .map(source => `${source.sourceType}:${source.sourceReferenceId}`)
        .sort()
        .join(',')
        .slice(0, 200);
    }
  }
  const rawCode = String(error?.code || 'STRIPE_PAYMENT_RISK_PROCESSING_FAILED').toUpperCase();
  const reasonCode = rawCode.replace(/[^A-Z0-9_]/g, '_').slice(0, 100)
    || 'STRIPE_PAYMENT_RISK_PROCESSING_FAILED';
  return manualReviewForPayload(payload, {
    sourceType: sourceType || 'unknown',
    sourceReferenceId,
    reasonCode,
    reason: `Automatic Stripe payment-risk processing failed: ${String(error?.message || 'unknown error').slice(0, 400)}`,
  });
};

module.exports = {
  refundEvidenceFromCharge,
  sourceReferenceFromMetadata,
  isBlockingFinancialRiskEvent,
  hasCompletedLocalSource,
  flagStripePaymentRisk,
  recordFailedStripePaymentRiskReview,
};
