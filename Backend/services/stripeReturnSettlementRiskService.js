'use strict';

const Order = require('../models/Order');
const ReturnRequest = require('../models/ReturnRequest');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');
const { getAccountingOrderCurrency, getOrderExchangeRates } = require('./orderMoneyService');
const { fromMinorUnits, toMinorUnits } = require('./moneyMath');
const { runInTransaction } = require('./walletService');
const {
  applySellerStripeRiskLedger,
  FINANCIAL_DISPUTE_STATUSES,
  INQUIRY_DISPUTE_STATUSES,
} = require('./stripeOrderPaymentRiskService');
const {
  createSellerPaymentRiskHolds,
  resolveSellerPaymentRiskHolds,
  resolveWonDisputeSellerPaymentRiskHolds,
} = require('./sellerPaymentRiskHoldService');
const {
  enqueueStripeReturnSettlementRiskNotifications,
  persistStripeSourceDisputeEvent,
  reconcileStripeSourceRefundEvidence,
} = require('./stripePaymentRiskNotificationService');

const riskError = (message, code, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const findReturnSettlementForPaymentIntent = paymentIntentId => ReturnRequest.findOne({
  status: 'returned',
  'settlement.status': 'completed',
  'settlement.stripePaymentIntentId': paymentIntentId,
});

const readRawReturnRequest = (requestId, session = null) => ReturnRequest.collection.findOne(
  { _id: requestId },
  session ? { session } : {},
);

const readRawOrder = (orderId, session = null) => Order.collection.findOne(
  { _id: orderId },
  session ? { session } : {},
);

const requireStripeEventCurrency = value => {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || !isSupportedCurrency(value)
  ) {
    throw riskError(
      'Stripe return-settlement currency is unsupported or malformed.',
      'RETURN_PAYMENT_RISK_CURRENCY_INVALID',
      400,
    );
  }
  return normalizeCurrency(value);
};

const requireStoredReturnCurrency = request => {
  const value = request?.currency;
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value !== normalizeCurrency(value)
    || !isSupportedCurrency(value)
  ) {
    throw riskError(
      'The stored return-settlement currency is unsupported or malformed.',
      'RETURN_PAYMENT_RISK_CURRENCY_INVALID',
      409,
    );
  }
  return value;
};

const requireStoredReturnTotalMinor = request => {
  const value = request?.refund?.totalAmount;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw riskError('The stored return refund total is invalid.', 'RETURN_PAYMENT_RISK_AMOUNT_INVALID', 409);
  }
  const minor = toMinorUnits(value);
  if (!Number.isSafeInteger(minor) || minor <= 0 || fromMinorUnits(minor) !== value) {
    throw riskError(
      'The stored return refund total is not an exact minor-unit amount.',
      'RETURN_PAYMENT_RISK_AMOUNT_INVALID',
      409,
    );
  }
  return minor;
};

const validateReturnOrderIdentity = ({ request, order, sourceCurrency }) => {
  if (
    !order
    || String(request?.order || '') !== String(order._id || '')
    || String(request?.orderId || '') !== String(order.orderId || '')
    || String(request?.buyer || '') !== String(order.user || '')
    || getAccountingOrderCurrency(order) !== sourceCurrency
    || !(order.orderItems || []).some(item => String(item?.seller || '') === String(request?.seller || ''))
  ) {
    throw riskError(
      'The return settlement does not match its authoritative original order.',
      'RETURN_PAYMENT_RISK_ORDER_MISMATCH',
      409,
    );
  }
  return true;
};

const returnContextImpact = ({ request, sourceCurrency, amountMinor, action, direction }) => ({
  sellerId: String(request.seller),
  action,
  direction,
  sourceAmountMinor: amountMinor,
  sourceCurrency,
  amountUSDMinor: sourceCurrency === 'USD' ? amountMinor : 0,
});

const reconcileReturnSettlementNotifications = async ({
  session,
  request,
  sourceCurrency,
  payload,
  ledger,
}) => {
  const result = { refund: { notified: false, replay: true }, disputes: [] };
  if (ledger.refundDeltaMinor > 0) {
    result.refund = await reconcileStripeSourceRefundEvidence({
      session,
      payload,
      sourceType: 'return_settlement',
      sourceDocument: request,
      sourceCurrency,
      classification: 'return_refund',
      eventKeyPrefix: `return:${request._id}`,
      refundDeltaMinor: ledger.refundDeltaMinor,
      sellerImpacts: ledger.sellerImpacts.filter(impact => impact.action === 'refund_debited'),
      evidenceConflictsWithSource: refund => (
        ['order_inventory_refund', 'return_settlement_safety_refund'].includes(refund.metadataType)
        || ['order_payment', 'wallet_top_up'].includes(refund.metadataType)
        || (refund.metadataReturnRequestId
          && refund.metadataReturnRequestId !== String(request._id))
        || (refund.metadataOrderId && refund.metadataOrderId !== String(request.order))
        || Boolean(refund.metadataWalletTransactionId)
      ),
    });
    if (result.refund.notified) {
      result.refund.notifications = await enqueueStripeReturnSettlementRiskNotifications({
        event: result.refund.persisted.event,
        returnRequest: request,
        session,
      });
    }
  }
  if (!payload.eventType.startsWith('charge.dispute.')) return result;

  let candidate = null;
  if (
    payload.eventType === 'charge.dispute.created'
    && INQUIRY_DISPUTE_STATUSES.has(payload.disputeStatus)
  ) {
    candidate = {
      classification: 'return_dispute_inquiry',
      impacts: [returnContextImpact({
        request,
        sourceCurrency,
        amountMinor: payload.disputeExposureMinor,
        action: 'dispute_inquiry',
        direction: 'none',
      })],
    };
  } else if (
    ledger.disputeTransition?.terminalTransition
    && ledger.disputeTransition?.resolution === 'won'
  ) {
    const impacts = ledger.sellerImpacts.filter(impact => impact.action === 'dispute_released');
    const hadAuthoritativeReserve = ledger.disputeTransition.previous.exposureMinor > 0;
    candidate = hadAuthoritativeReserve
      ? { classification: 'return_dispute_won', impacts }
      : {
        classification: 'return_dispute_won_no_reserve',
        impacts: [returnContextImpact({
          request,
          sourceCurrency,
          amountMinor: payload.disputeExposureMinor,
          action: 'dispute_won_no_reserve',
          direction: 'none',
        })],
      };
  } else if (
    ledger.disputeTransition?.terminalTransition
    && ledger.disputeTransition?.resolution === 'lost'
  ) {
    candidate = {
      classification: 'return_dispute_lost',
      impacts: ledger.sellerImpacts.filter(impact => impact.action === 'dispute_finalized'),
    };
  } else if (ledger.disputeTransition?.financialExposureIncreased) {
    candidate = {
      classification: 'return_dispute_opened',
      impacts: ledger.sellerImpacts.filter(impact => impact.action === 'dispute_reserved'),
    };
  }
  if (!candidate) return result;
  const persisted = await persistStripeSourceDisputeEvent({
    session,
    payload,
    sourceType: 'return_settlement',
    sourceDocument: request,
    sourceCurrency,
    classification: candidate.classification,
    eventKeyPrefix: `return:${request._id}`,
    sellerImpacts: candidate.impacts,
  });
  if (persisted.notified) {
    result.disputes.push({
      persisted,
      notifications: await enqueueStripeReturnSettlementRiskNotifications({
        event: persisted.persisted.event,
        returnRequest: request,
        session,
      }),
    });
  } else {
    result.disputes.push({ persisted, notifications: [] });
  }
  return result;
};

const flagStripeReturnSettlementRisk = async payload => {
  const { paymentIntentId, chargeId, eventId, currency } = payload;
  if (!paymentIntentId || !chargeId || !eventId) {
    throw riskError('Return-settlement reversal references are incomplete.', 'RETURN_PAYMENT_RISK_REFERENCE_MISSING', 400);
  }
  const identified = await findReturnSettlementForPaymentIntent(paymentIntentId);
  if (!identified) return null;

  const chargeAmountMinor = payload.chargeAmountMinor;
  const refundExposureMinor = payload.refundExposureMinor ?? 0;
  const disputeExposureMinor = payload.disputeExposureMinor ?? 0;
  if (
    !Number.isSafeInteger(chargeAmountMinor) || chargeAmountMinor <= 0
    || !Number.isSafeInteger(refundExposureMinor) || refundExposureMinor < 0
    || !Number.isSafeInteger(disputeExposureMinor) || disputeExposureMinor < 0
    || refundExposureMinor > chargeAmountMinor
    || disputeExposureMinor > chargeAmountMinor
  ) {
    throw riskError('Return-settlement reversal amount is invalid.', 'RETURN_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  const rawFinancialDisputeEvent = payload.eventType === 'charge.dispute.funds_withdrawn'
    || (
      payload.eventType === 'charge.dispute.created'
      && FINANCIAL_DISPUTE_STATUSES.has(payload.disputeStatus)
    );
  if ((rawFinancialDisputeEvent || payload.disputeStatus === 'lost') && disputeExposureMinor <= 0) {
    throw riskError('Return-settlement dispute amount is invalid.', 'RETURN_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  const disputeEvent = payload.eventType.startsWith('charge.dispute.');
  const wonEvent = payload.disputeStatus === 'won'
    || payload.eventType === 'charge.dispute.funds_reinstated';
  const riskTrack = (
    (payload.eventType === 'charge.refunded' && refundExposureMinor > 0)
    || (wonEvent && refundExposureMinor > 0)
  )
    ? 'refund'
    : (rawFinancialDisputeEvent || payload.disputeStatus === 'lost' ? 'dispute' : null);
  const sellerIds = [String(identified.seller)];
  const preliminaryHolds = riskTrack
    ? await createSellerPaymentRiskHolds({
      sellerIds,
      sourceType: 'return_settlement',
      sourceReferenceId: identified._id,
      paymentIntentId,
      chargeId,
      eventId,
      eventType: payload.eventType,
      riskTrack,
      disputeId: riskTrack === 'dispute' ? payload.disputeId : null,
      exposureMinor: riskTrack === 'refund' ? refundExposureMinor : disputeExposureMinor,
    })
    : [];
  const identifiedRaw = await readRawReturnRequest(identified._id);
  if (!identifiedRaw) {
    throw riskError('The completed return settlement disappeared before reversal validation.', 'RETURN_PAYMENT_RISK_SOURCE_MISSING');
  }
  const sourceCurrency = requireStoredReturnCurrency(identifiedRaw);
  if (requireStripeEventCurrency(currency) !== sourceCurrency) {
    throw riskError('Stripe reversal currency does not match the return settlement.', 'RETURN_PAYMENT_RISK_CURRENCY_MISMATCH', 400);
  }
  if (requireStoredReturnTotalMinor(identifiedRaw) !== chargeAmountMinor) {
    throw riskError('Stripe reversal amount does not match the return settlement.', 'RETURN_PAYMENT_RISK_CHARGE_MISMATCH', 400);
  }
  const identifiedOrder = identifiedRaw.order ? await readRawOrder(identifiedRaw.order) : null;
  validateReturnOrderIdentity({ request: identifiedRaw, order: identifiedOrder, sourceCurrency });

  const result = await runInTransaction(async session => {
    const request = await findReturnSettlementForPaymentIntent(paymentIntentId).session(session);
    if (!request) {
      throw riskError('The completed return settlement disappeared during reversal accounting.', 'RETURN_PAYMENT_RISK_SOURCE_MISSING');
    }
    const rawRequest = await readRawReturnRequest(request._id, session);
    if (!rawRequest) {
      throw riskError('The completed return settlement disappeared during reversal accounting.', 'RETURN_PAYMENT_RISK_SOURCE_MISSING');
    }
    const sourceCurrency = requireStoredReturnCurrency(rawRequest);
    if (requireStripeEventCurrency(currency) !== sourceCurrency) {
      throw riskError('Stripe reversal currency does not match the return settlement.', 'RETURN_PAYMENT_RISK_CURRENCY_MISMATCH', 400);
    }
    if (requireStoredReturnTotalMinor(rawRequest) !== chargeAmountMinor) {
      throw riskError('Stripe reversal amount does not match the return settlement.', 'RETURN_PAYMENT_RISK_CHARGE_MISMATCH', 400);
    }
    const rawOrder = rawRequest.order
      ? await readRawOrder(rawRequest.order, session)
      : null;
    validateReturnOrderIdentity({ request: rawRequest, order: rawOrder, sourceCurrency });
    let rates = sourceCurrency === 'USD' ? { USD: 1 } : getOrderExchangeRates(rawOrder);
    const requiresTrustedRates = sourceCurrency !== 'USD'
      && (
        refundExposureMinor > 0
        || rawFinancialDisputeEvent
        || payload.disputeStatus === 'lost'
      );
    if (requiresTrustedRates && !rates) {
      throw riskError(
        'The legacy return settlement has no checkout exchange-rate snapshot and requires an audited backfill.',
        'RETURN_PAYMENT_RISK_HISTORICAL_RATE_MISSING',
      );
    }

    const ledger = await applySellerStripeRiskLedger({
      session,
      sourceType: 'return_settlement',
      sourceReferenceId: request._id,
      orderId: request.order || null,
      orderLabel: `seller-funded return ${request.returnNumber || request._id}`,
      sellerEntitlements: [{
        sellerId: String(request.seller),
        sourceMinor: chargeAmountMinor,
      }],
      sourceCurrency,
      rates,
      ...payload,
      chargeAmountMinor,
    });
    const riskNotifications = await reconcileReturnSettlementNotifications({
      session,
      request,
      sourceCurrency,
      payload,
      ledger,
    });
    return {
      ...ledger,
      sourceType: 'return_settlement',
      returnRequest: request,
      // The buyer's completed return refund remains valid. Liability belongs
      // to the seller/cardholder who funded it, not the innocent buyer Wallet.
      buyerWalletAffected: false,
      riskNotifications,
    };
  });

  if (refundExposureMinor > 0 && !INQUIRY_DISPUTE_STATUSES.has(payload.disputeStatus)) {
    await resolveSellerPaymentRiskHolds({
      holds: preliminaryHolds,
      sourceType: 'return_settlement',
      sourceReferenceId: identified._id,
      paymentIntentId,
      chargeId,
      riskTrack: 'refund',
      coveredExposureMinor: result?.refundExposureMinor ?? refundExposureMinor,
      resolutionEventId: eventId,
    });
  }
  if (disputeEvent) {
    await resolveSellerPaymentRiskHolds({
      holds: preliminaryHolds,
      sourceType: 'return_settlement',
      sourceReferenceId: identified._id,
      paymentIntentId,
      chargeId,
      riskTrack: 'dispute',
      disputeId: payload.disputeId,
      coveredExposureMinor: result?.disputeExposureMinor ?? disputeExposureMinor,
      resolutionEventId: eventId,
    });
    await resolveWonDisputeSellerPaymentRiskHolds({
      sellerIds,
      sourceType: 'return_settlement',
      sourceReferenceId: identified._id,
      paymentIntentId,
      chargeId,
      disputeId: payload.disputeId,
      coveredExposureMinor: chargeAmountMinor,
      resolutionEventId: eventId,
    });
  }
  return result;
};

module.exports = {
  findReturnSettlementForPaymentIntent,
  flagStripeReturnSettlementRisk,
};
