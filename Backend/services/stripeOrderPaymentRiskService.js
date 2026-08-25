'use strict';

const Order = require('../models/Order');
const Product = require('../models/Product');
const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');
const {
  allocateSellerSettlementUsdTargets,
  ensureOrderSellerSettlement,
  ensureOrderExchangeRateSnapshot,
  getAccountingOrderCurrency,
  getOrderExchangeRates,
} = require('./orderMoneyService');
const {
  allocateConvertedMinorUnitsByRates,
  allocateHouseMonotoneMinorUnits,
  fromMinorUnits,
  toMinorUnits,
} = require('./moneyMath');
const { runInTransaction } = require('./walletService');
const { getExpectedStripeTotalMinor } = require('./stripeOrderPaymentService');
const {
  getDurableDisputeExposures,
  recordStripeDisputeState,
} = require('./stripeDisputeStateService');
const {
  createSellerPaymentRiskHolds,
  resolveSellerPaymentRiskHolds,
  resolveWonDisputeSellerPaymentRiskHolds,
} = require('./sellerPaymentRiskHoldService');
const {
  enqueueStripeOrderDisputeNotifications,
  enqueueStripeOrderRefundNotifications,
  persistStripeSourceDisputeEvent,
  reconcileStripeSourceRefundEvidence,
} = require('./stripePaymentRiskNotificationService');

const ACTIVE_RISK_STATUSES = ['reserved', 'completed'];
const FINANCIAL_DISPUTE_STATUSES = new Set(['needs_response', 'under_review', 'lost']);
const INQUIRY_DISPUTE_STATUSES = new Set([
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'prevented',
]);

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const riskError = (message, code, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const assertSafeStripeMinor = (value, name, { allowZero = true } = {}) => {
  const amount = value;
  if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) {
    throw riskError(`Stripe ${name} is invalid.`, 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  return amount;
};

const requireStripeEventCurrency = value => {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || !isSupportedCurrency(value)
  ) {
    throw riskError(
      'Stripe reversal currency is unsupported or malformed.',
      'STRIPE_PAYMENT_RISK_CURRENCY_INVALID',
      400,
    );
  }
  return normalizeCurrency(value);
};

const roundProductRatio = (left, right, denominator) => {
  const denominatorBig = BigInt(denominator);
  if (denominatorBig <= 0n) return 0;
  const numerator = BigInt(left) * BigInt(right);
  const rounded = (numerator * 2n + denominatorBig) / (denominatorBig * 2n);
  const numeric = Number(rounded);
  if (!Number.isSafeInteger(numeric)) {
    throw riskError('Stripe payment-risk allocation is too large.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  return numeric;
};

const findStripeOrderForPaymentIntent = paymentIntentId => Order.findOne({
  paymentMethod: 'stripe',
  isPaid: true,
  $or: [
    { stripePaymentIntentId: paymentIntentId },
    { 'paymentResult.paymentIntentId': paymentIntentId },
  ],
});

// Mongoose casts stored Number paths while hydrating. A raw BSON boolean such
// as `true` would otherwise become `1` and could masquerade as a valid $1.00
// total. Financial validation must therefore inspect the persisted BSON values
// before using the hydrated document for accounting mutations.
const readRawOrder = (orderId, session = null) => Order.collection.findOne(
  { _id: orderId },
  session ? { session } : {},
);

const sellerGroupsForOrder = async (order, session) => {
  const legacyProductIds = (order.orderItems || [])
    .filter(item => !item?.seller && item?.productId)
    .map(item => item.productId);
  const legacyProducts = legacyProductIds.length
    ? await Product.find({ _id: { $in: legacyProductIds } }).select('_id seller').session(session).lean()
    : [];
  const legacySellerByProduct = new Map(
    legacyProducts.map(product => [toId(product._id), toId(product.seller)]),
  );
  const groups = new Map();
  for (const item of order.orderItems || []) {
    const sellerId = toId(item?.seller) || legacySellerByProduct.get(toId(item?.productId)) || '';
    if (!sellerId) continue;
    if (!groups.has(sellerId)) groups.set(sellerId, []);
    groups.get(sellerId).push(item);
  }
  return groups;
};

const sellerEntitlementsForOrder = async (order, session) => {
  const settlement = await ensureOrderSellerSettlement(order, {
    session,
    requireOrderTotal: true,
  });
  return settlement.map(entry => ({
    seller: entry.seller,
    sellerId: entry.seller,
    sourceCurrency: entry.sourceCurrency,
    sourceAmountMinor: entry.sourceAmountMinor,
    amountUSDMinor: entry.amountUSDMinor,
    // Compatibility aliases used by the generic risk allocator.
    sourceMinor: entry.sourceAmountMinor,
    usdMinor: entry.amountUSDMinor,
  }));
};

const normalizeRiskSellerEntitlements = ({ sellerEntitlements, sourceCurrency, rates }) => {
  const entries = (sellerEntitlements || []).map(entry => {
    const sellerId = toId(entry.sellerId || entry.seller);
    const sourceMinor = entry.sourceAmountMinor ?? entry.sourceMinor;
    const suppliedUsdMinor = entry.amountUSDMinor ?? entry.usdMinor;
    if (!sellerId || !Number.isSafeInteger(sourceMinor) || sourceMinor < 0) {
      throw riskError('Stripe seller entitlement is invalid.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
    }
    return {
      seller: sellerId,
      sellerId,
      sourceCurrency,
      sourceAmountMinor: sourceMinor,
      sourceMinor,
      amountUSDMinor: Number.isSafeInteger(suppliedUsdMinor) && suppliedUsdMinor >= 0
        ? suppliedUsdMinor
        : null,
    };
  }).filter(entry => entry.sourceMinor > 0)
    .sort((left, right) => left.sellerId.localeCompare(right.sellerId));
  const seen = new Set();
  if (entries.some(entry => seen.has(entry.sellerId) || !seen.add(entry.sellerId))) {
    throw riskError('Stripe seller entitlements contain a duplicate seller.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  if (entries.every(entry => Number.isSafeInteger(entry.amountUSDMinor))) return entries;
  if (!rates) {
    throw riskError(
      'A foreign-currency Stripe reversal has no trusted checkout exchange-rate snapshot.',
      'STRIPE_PAYMENT_RISK_EXCHANGE_RATE_MISSING',
    );
  }
  const allocated = sourceCurrency === 'USD'
    ? new Map(entries.map(entry => [entry.sellerId, entry.sourceMinor]))
    : allocateConvertedMinorUnitsByRates(
      entries.map(entry => ({
        key: entry.sellerId,
        amount: fromMinorUnits(entry.sourceMinor),
        sourceRate: rates[sourceCurrency],
      })),
      rates.USD,
    ).allocations;
  return entries.map(entry => ({
    ...entry,
    amountUSDMinor: allocated.get(entry.sellerId) || 0,
  }));
};

const sellerContextImpactsForExposure = ({
  sellerEntitlements,
  sourceCurrency,
  rates,
  exposureMinor,
  chargeAmountMinor,
  action,
}) => {
  const normalized = normalizeRiskSellerEntitlements({ sellerEntitlements, sourceCurrency, rates });
  const entitlementTotalMinor = normalized.reduce((sum, entry) => sum + entry.sourceMinor, 0);
  if (!entitlementTotalMinor || !Number.isSafeInteger(exposureMinor) || exposureMinor <= 0) return [];
  const targetTotalMinor = roundProductRatio(
    entitlementTotalMinor,
    exposureMinor,
    chargeAmountMinor,
  );
  const sourceTargets = allocateHouseMonotoneMinorUnits(
    targetTotalMinor,
    normalized.map(entry => ({ key: entry.sellerId, weight: entry.sourceMinor })),
  );
  const usdTargets = allocateSellerSettlementUsdTargets({
    settlementEntries: normalized,
    sourceTargets,
  });
  return normalized.map(entry => ({
    sellerId: entry.sellerId,
    action,
    sourceAmountMinor: sourceTargets.get(entry.sellerId) || 0,
    sourceCurrency,
    amountUSDMinor: usdTargets.get(entry.sellerId) || 0,
  })).filter(entry => entry.sourceAmountMinor > 0 || entry.amountUSDMinor > 0);
};

const reconcileOrderRefundNotificationEvidence = async ({
  session,
  order,
  sourceCurrency,
  payload,
  ledger,
}) => {
  const sellerImpacts = ledger.sellerImpacts.filter(impact => impact.action === 'refund_debited');
  const result = await reconcileStripeSourceRefundEvidence({
    session,
    payload,
    sourceType: 'order_payment',
    sourceDocument: order,
    sourceCurrency,
    classification: 'order_refund',
    eventKeyPrefix: `order:${order._id}`,
    refundDeltaMinor: ledger.refundDeltaMinor,
    sellerImpacts,
    evidenceConflictsWithSource: refund => (
      [
        'order_inventory_refund',
        'return_settlement_safety_refund',
        'wallet_top_up',
        'return_settlement',
      ].includes(refund.metadataType)
      || (refund.metadataOrderId && refund.metadataOrderId !== String(order._id))
      || Boolean(refund.metadataWalletTransactionId)
      || Boolean(refund.metadataReturnRequestId)
    ),
  });
  if (result.notified) {
    result.notifications = await enqueueStripeOrderRefundNotifications({
      event: result.persisted.event,
      order,
      session,
    });
  }
  return result;
};

const reconcileOrderDisputeNotifications = async ({
  session,
  order,
  sourceCurrency,
  sellerEntitlements,
  rates,
  payload,
  ledger,
}) => {
  if (!payload.eventType.startsWith('charge.dispute.')) return [];
  const notifications = [];
  let candidate = null;
  if (
    payload.eventType === 'charge.dispute.created'
    && INQUIRY_DISPUTE_STATUSES.has(payload.disputeStatus)
  ) {
    candidate = {
      classification: 'order_dispute_inquiry',
      action: 'dispute_inquiry',
      impacts: sellerContextImpactsForExposure({
        sellerEntitlements,
        sourceCurrency,
        rates,
        exposureMinor: payload.disputeExposureMinor,
        chargeAmountMinor: payload.chargeAmountMinor,
        action: 'dispute_inquiry',
      }),
    };
  } else if (
    ledger.disputeTransition?.terminalTransition
    && ledger.disputeTransition?.resolution === 'won'
  ) {
    const impacts = ledger.sellerImpacts.filter(impact => impact.action === 'dispute_released');
    const hadAuthoritativeReserve = ledger.disputeTransition.previous.exposureMinor > 0;
    candidate = hadAuthoritativeReserve
      ? { classification: 'order_dispute_won', action: 'dispute_released', impacts }
      : {
        classification: 'order_dispute_won_no_reserve',
        action: 'dispute_won_no_reserve',
        impacts: sellerContextImpactsForExposure({
          sellerEntitlements,
          sourceCurrency,
          rates,
          exposureMinor: payload.disputeExposureMinor,
          chargeAmountMinor: payload.chargeAmountMinor,
          action: 'dispute_won_no_reserve',
        }),
      };
  } else if (
    ledger.disputeTransition?.terminalTransition
    && ledger.disputeTransition?.resolution === 'lost'
  ) {
    candidate = {
      classification: 'order_dispute_lost',
      action: 'dispute_finalized',
      impacts: ledger.sellerImpacts.filter(impact => impact.action === 'dispute_finalized'),
    };
  } else if (ledger.disputeTransition?.financialExposureIncreased) {
    candidate = {
      classification: 'order_dispute_opened',
      action: 'dispute_reserved',
      impacts: ledger.sellerImpacts.filter(impact => impact.action === 'dispute_reserved'),
    };
  }
  if (!candidate) return notifications;

  const persisted = await persistStripeSourceDisputeEvent({
    session,
    payload,
    sourceType: 'order_payment',
    sourceDocument: order,
    sourceCurrency,
    classification: candidate.classification,
    eventKeyPrefix: `order:${order._id}`,
    sellerImpacts: candidate.impacts,
  });
  if (persisted.notified) {
    notifications.push({
      persisted,
      records: await enqueueStripeOrderDisputeNotifications({
        event: persisted.persisted.event,
        order,
        session,
      }),
    });
  } else {
    notifications.push({ persisted, records: [] });
  }
  return notifications;
};

const riskMetadataMinor = (row, field) => {
  const value = row?.metadata?.[field];
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw riskError(
      `Persisted Stripe payment-risk ${field} is malformed.`,
      'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
    );
  }
  return value;
};

const maxMetadataMinor = (rows, field) => rows.reduce(
  (maximum, row) => Math.max(maximum, riskMetadataMinor(row, field)),
  0,
);

const activeDisputeExposures = rows => {
  const exposureByDispute = new Map();
  for (const row of rows) {
    if (row?.metadata?.riskTrack !== 'dispute') continue;
    const disputeId = String(row?.metadata?.disputeId || 'legacy-dispute');
    const exposureMinor = riskMetadataMinor(row, 'disputeExposureMinor');
    exposureByDispute.set(
      disputeId,
      Math.max(exposureByDispute.get(disputeId) || 0, exposureMinor),
    );
  }
  return exposureByDispute;
};

const netRiskRowsBySeller = (rows, sourceCurrency) => {
  const totals = new Map();
  for (const row of rows) {
    const sellerId = toId(row?.seller);
    if (!sellerId || row?.sourceCurrency !== sourceCurrency) {
      throw riskError(
        'A Stripe dispute reserve has an invalid seller or source currency.',
        'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
      );
    }
    const current = totals.get(sellerId) || { sourceAmountMinor: 0, amountUSDMinor: 0 };
    const sign = row.direction === 'credit' ? -1 : 1;
    current.sourceAmountMinor += sign * toMinorUnits(row.sourceAmount);
    current.amountUSDMinor += sign * toMinorUnits(row.amountUSD);
    totals.set(sellerId, current);
  }
  for (const total of totals.values()) {
    if (
      !Number.isSafeInteger(total.sourceAmountMinor)
      || !Number.isSafeInteger(total.amountUSDMinor)
      || total.sourceAmountMinor < 0
      || total.amountUSDMinor < 0
    ) {
      throw riskError(
        'A Stripe dispute reserve has an invalid net seller allocation.',
        'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
      );
    }
  }
  return totals;
};

const lockSellers = async (sellerIds, session) => {
  for (const sellerId of [...new Set(sellerIds)].sort()) {
    await SellerSettlementLock.findOneAndUpdate(
      { seller: sellerId },
      { $setOnInsert: { seller: sellerId }, $inc: { version: 1 } },
      { upsert: true, new: true, session },
    );
  }
};

/**
 * Apply one Stripe exposure snapshot to a seller liability ledger. Refund and
 * dispute tracks remain distinct, then combine with a hard cap at the original
 * charge. This makes refund 30 + withdrawn dispute 70 equal 100, while a won
 * dispute releases only its provisional rows and preserves the refund 30.
 */
const applySellerStripeRiskLedger = async ({
  session,
  sourceType,
  sourceReferenceId,
  orderId = null,
  orderLabel,
  sellerEntitlements,
  sourceCurrency,
  rates,
  paymentIntentId,
  chargeId,
  eventId,
  eventType,
  chargeAmountMinor,
  refundExposureMinor = 0,
  disputeId = null,
  disputeExposureMinor = 0,
  disputeStatus = '',
  disputeTransitionOverride = undefined,
  directTrackTargets = false,
  directSellerTargets = null,
  directSellerUsdTargets = null,
}) => {
  const normalizedEntitlements = normalizeRiskSellerEntitlements({
    sellerEntitlements,
    sourceCurrency,
    rates,
  });
  const scope = {
    type: 'reversal',
    referenceType: 'stripe_payment',
    stripePaymentIntentId: paymentIntentId,
    'metadata.sourceType': sourceType,
    'metadata.sourceReferenceId': String(sourceReferenceId),
  };
  let activeRows = await SellerBalanceTransaction.find({
    ...scope,
    status: { $in: ACTIVE_RISK_STATUSES },
  }).session(session).lean();
  await lockSellers([
    ...normalizedEntitlements.map(entry => entry.sellerId),
    ...activeRows.map(row => toId(row.seller)),
  ].filter(Boolean), session);

  const inquiryOnly = INQUIRY_DISPUTE_STATUSES.has(disputeStatus);
  const rawFinancialDisputeEvent = eventType === 'charge.dispute.funds_withdrawn'
    || (
      eventType === 'charge.dispute.created'
      && FINANCIAL_DISPUTE_STATUSES.has(disputeStatus)
    );
  const disputeEvent = eventType.startsWith('charge.dispute.');
  let disputeTransition = null;
  let ignoredOutOfOrder = false;
  const sellerImpacts = [];
  if (disputeEvent) {
    disputeTransition = disputeTransitionOverride !== undefined
      ? disputeTransitionOverride
      : await recordStripeDisputeState({
        session,
        sourceType,
        sourceReferenceId,
        paymentIntentId,
        chargeId,
        disputeId,
        eventId,
        eventType,
        disputeStatus,
        disputeExposureMinor,
        financialEvent: rawFinancialDisputeEvent || disputeStatus === 'lost',
      });
    if (disputeTransition?.ignoredFinancialEvent) {
      ignoredOutOfOrder = true;
    }
  }

  const disputeResolution = disputeTransition?.resolution || null;
  if (disputeResolution) {
    const reservedResolutionRows = activeRows.filter(row => (
      row?.status === 'reserved'
      && row?.metadata?.riskTrack === 'dispute'
      && (!disputeId || String(row?.metadata?.disputeId || '') === String(disputeId))
    ));
    const resolutionBySeller = disputeTransition?.terminalTransition
      ? netRiskRowsBySeller(reservedResolutionRows, sourceCurrency)
      : new Map();
    if (disputeResolution === 'won') {
      await SellerBalanceTransaction.updateMany(
        {
          ...scope,
          status: 'reserved',
          'metadata.riskTrack': 'dispute',
          ...(disputeId ? { 'metadata.disputeId': disputeId } : {}),
        },
        {
          $set: {
            status: 'reversed',
            'metadata.disputeResolution': 'won',
            'metadata.resolutionEventId': eventId,
          },
        },
        { session },
      );
    } else if (disputeResolution === 'lost') {
      await SellerBalanceTransaction.updateMany(
        {
          ...scope,
          status: 'reserved',
          'metadata.riskTrack': 'dispute',
          ...(disputeId ? { 'metadata.disputeId': disputeId } : {}),
        },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            'metadata.disputeResolution': 'lost',
            'metadata.resolutionEventId': eventId,
          },
        },
        { session },
      );
    }
    activeRows = await SellerBalanceTransaction.find({
      ...scope,
      status: { $in: ACTIVE_RISK_STATUSES },
    }).session(session).lean();
    for (const [sellerId, impact] of resolutionBySeller) {
      if (!impact.sourceAmountMinor && !impact.amountUSDMinor) continue;
      sellerImpacts.push({
        sellerId,
        action: disputeResolution === 'won' ? 'dispute_released' : 'dispute_finalized',
        direction: disputeResolution === 'won' ? 'credit' : 'none',
        sourceAmountMinor: impact.sourceAmountMinor,
        sourceCurrency,
        amountUSDMinor: impact.amountUSDMinor,
      });
    }
  }

  // A lost closure can arrive before funds_withdrawn/created. Materialize its
  // completed seller liability immediately; the terminal state then makes
  // delayed financial events harmless.
  const financialDisputeEvent = !ignoredOutOfOrder
    && (rawFinancialDisputeEvent || disputeResolution === 'lost');

  const persistedRefundExposure = maxMetadataMinor(activeRows, 'refundExposureMinor');
  const effectiveRefundExposure = directTrackTargets
    ? refundExposureMinor
    : Math.min(
      chargeAmountMinor,
      Math.max(persistedRefundExposure, refundExposureMinor),
    );
  const disputeExposures = activeDisputeExposures(activeRows);
  const durableDisputeExposures = directTrackTargets
    ? new Map()
    : await getDurableDisputeExposures({
      session,
      sourceType,
      sourceReferenceId,
      paymentIntentId,
      chargeId,
    });
  for (const [key, amount] of durableDisputeExposures) {
    disputeExposures.set(key, Math.max(disputeExposures.get(key) || 0, amount));
  }
  const effectiveDisputeExposure = [...disputeExposures.values()]
    .reduce((sum, amount) => sum + amount, 0);
  const combinedExposureMinor = effectiveRefundExposure + effectiveDisputeExposure;
  if (!Number.isSafeInteger(effectiveDisputeExposure) || !Number.isSafeInteger(combinedExposureMinor)) {
    throw riskError('Stripe reversal exposure is too large.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  const totalEntitlementMinor = normalizedEntitlements.reduce(
    (sum, entry) => sum + entry.sourceMinor,
    0,
  );
  if (!Number.isSafeInteger(totalEntitlementMinor)) {
    throw riskError('Stripe seller entitlement is too large.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  if (!totalEntitlementMinor || (!combinedExposureMinor && !directTrackTargets)) {
    return {
      handled: true,
      created: 0,
      inquiryOnly,
      ignoredOutOfOrder,
      rows: activeRows,
      previousRefundExposureMinor: persistedRefundExposure,
      refundExposureMinor: effectiveRefundExposure,
      refundDeltaMinor: effectiveRefundExposure - persistedRefundExposure,
      disputeExposureMinor: disputeExposures.get(String(disputeId || '')) || 0,
      disputeTransition,
      sellerImpacts,
    };
  }

  // Refunds and every dispute are independent liability tracks. Rebalancing a
  // combined target can tag a seller credit to the wrong track, so winning a
  // dispute would leave a malformed refund allocation. Each track therefore
  // owns and reconciles only its exact cumulative proportional target.
  const tracks = [];
  if (
    effectiveRefundExposure > 0
    || (directTrackTargets && eventType === 'charge.refunded' && directSellerTargets)
  ) {
    tracks.push({ riskTrack: 'refund', trackKey: 'refund', exposureMinor: effectiveRefundExposure });
  }
  if (financialDisputeEvent) {
    tracks.push({
      riskTrack: 'dispute',
      trackKey: `dispute:${disputeId}`,
      exposureMinor: durableDisputeExposures.get(disputeId) || disputeExposureMinor,
    });
  }

  let created = 0;
  for (const track of tracks) {
    const targetTrackTotalMinor = directTrackTargets
      ? track.exposureMinor
      : roundProductRatio(
        totalEntitlementMinor,
        track.exposureMinor,
        chargeAmountMinor,
      );
    if (targetTrackTotalMinor > totalEntitlementMinor) {
      throw riskError(
        'Stripe reversal target exceeds the seller funding entitlement.',
        'STRIPE_PAYMENT_RISK_AMOUNT_INVALID',
        400,
      );
    }
    const trackRows = activeRows.filter(row => (
      row?.metadata?.riskTrack === track.riskTrack
      && (
        track.riskTrack === 'refund'
        || String(row?.metadata?.disputeId || '') === String(disputeId || '')
      )
    ));
    const priorBySeller = new Map(normalizedEntitlements.map(entry => [entry.sellerId, {
      sourceMinor: 0,
      usdMinor: 0,
    }]));
    for (const row of trackRows) {
      const sellerId = toId(row.seller);
      const prior = priorBySeller.get(sellerId);
      if (!prior) {
        throw riskError(
          'A prior Stripe reversal belongs to a seller outside the frozen settlement.',
          'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
        );
      }
      const sign = row.direction === 'credit' ? -1 : 1;
      prior.sourceMinor += sign * toMinorUnits(row.sourceAmount);
      prior.usdMinor += sign * toMinorUnits(row.amountUSD);
    }
    const priorTrackSourceMinor = [...priorBySeller.values()].reduce(
      (sum, entry) => sum + entry.sourceMinor,
      0,
    );
    if (
      !Number.isSafeInteger(priorTrackSourceMinor)
      || priorTrackSourceMinor < 0
      || (!directTrackTargets && priorTrackSourceMinor > targetTrackTotalMinor)
    ) {
      throw riskError(
        'Cumulative Stripe reversal exposure moved backwards.',
        'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
      );
    }
    for (const entitlement of normalizedEntitlements) {
      const prior = priorBySeller.get(entitlement.sellerId);
      if (
        !Number.isSafeInteger(prior.sourceMinor)
        || !Number.isSafeInteger(prior.usdMinor)
        || prior.sourceMinor < 0
        || prior.usdMinor < 0
        || prior.sourceMinor > entitlement.sourceMinor
        || prior.usdMinor > entitlement.amountUSDMinor
      ) {
        throw riskError(
          'A prior Stripe reversal exceeds the seller frozen settlement.',
          'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
        );
      }
    }
    // Highest-averages allocation is deterministic from the cumulative target
    // and house-monotone. Staged events and one-shot delivery therefore reach
    // the same seller targets without an Alabama-paradox credit adjustment.
    const targets = directSellerTargets
      ? new Map(normalizedEntitlements.map(entry => [
        entry.sellerId,
        directSellerTargets.get?.(entry.sellerId) ?? directSellerTargets[entry.sellerId] ?? 0,
      ]))
      : allocateHouseMonotoneMinorUnits(
        targetTrackTotalMinor,
        normalizedEntitlements.map(entry => ({
          key: entry.sellerId,
          weight: entry.sourceMinor,
        })),
      );
    const suppliedTargetTotal = [...targets.values()].reduce((sum, value) => sum + value, 0);
    if (
      [...targets.values()].some(value => !Number.isSafeInteger(value) || value < 0)
      || suppliedTargetTotal !== targetTrackTotalMinor
    ) {
      throw riskError('Direct seller risk targets do not conserve cents.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
    }
    for (const entitlement of normalizedEntitlements) {
      if (
        !directTrackTargets
        && (targets.get(entitlement.sellerId) || 0) < priorBySeller.get(entitlement.sellerId).sourceMinor
      ) {
        throw riskError(
          'Increasing Stripe exposure cannot reduce a seller source target.',
          'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
        );
      }
    }
    const targetUsdBySeller = directSellerUsdTargets
      ? new Map(normalizedEntitlements.map(entry => [
        entry.sellerId,
        directSellerUsdTargets.get?.(entry.sellerId) ?? directSellerUsdTargets[entry.sellerId] ?? 0,
      ]))
      : allocateSellerSettlementUsdTargets({
        settlementEntries: normalizedEntitlements,
        sourceTargets: targets,
      });
    for (const entitlement of normalizedEntitlements) {
      const priorUsdMinor = priorBySeller.get(entitlement.sellerId).usdMinor;
      const priorSourceMinor = priorBySeller.get(entitlement.sellerId).sourceMinor;
      const targetSourceMinor = targets.get(entitlement.sellerId) || 0;
      const targetUsdMinor = targetUsdBySeller.get(entitlement.sellerId) || 0;
      if (
        !Number.isSafeInteger(targetSourceMinor) || targetSourceMinor < 0
        || !Number.isSafeInteger(targetUsdMinor) || targetUsdMinor < 0
        || targetSourceMinor > entitlement.sourceMinor
        || targetUsdMinor > entitlement.amountUSDMinor
      ) {
        throw riskError('Direct seller risk target exceeds its frozen entitlement.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
      }
      const deltaUsdMinor = targetUsdMinor - priorUsdMinor;
      const deltaSourceMinor = targetSourceMinor - priorSourceMinor;
      if (!directTrackTargets && (deltaSourceMinor < 0 || deltaUsdMinor < 0)) {
        throw riskError(
          'Increasing Stripe exposure cannot release a previously reserved seller cent.',
          'STRIPE_PAYMENT_RISK_LEDGER_MISMATCH',
        );
      }
      if (!deltaSourceMinor && !deltaUsdMinor) continue;
      const completedDispute = track.riskTrack === 'dispute' && disputeResolution === 'lost';
      sellerImpacts.push({
        sellerId: entitlement.sellerId,
        action: track.riskTrack === 'refund'
          ? 'refund_debited'
          : (completedDispute ? 'dispute_finalized' : 'dispute_reserved'),
        direction: completedDispute
          ? 'none'
          : ((deltaSourceMinor || deltaUsdMinor) < 0 ? 'credit' : 'debit'),
        sourceAmountMinor: Math.abs(deltaSourceMinor),
        sourceCurrency,
        amountUSDMinor: Math.abs(deltaUsdMinor),
      });
      const components = [];
      if (
        deltaSourceMinor
        && deltaUsdMinor
        && Math.sign(deltaSourceMinor) === Math.sign(deltaUsdMinor)
      ) {
        components.push({
          key: 'combined',
          direction: deltaSourceMinor < 0 ? 'credit' : 'debit',
          sourceMinor: Math.abs(deltaSourceMinor),
          usdMinor: Math.abs(deltaUsdMinor),
        });
      } else {
        if (deltaSourceMinor) {
          components.push({
            key: 'source',
            direction: deltaSourceMinor < 0 ? 'credit' : 'debit',
            sourceMinor: Math.abs(deltaSourceMinor),
            usdMinor: 0,
          });
        }
        if (deltaUsdMinor) {
          components.push({
            key: 'usd',
            direction: deltaUsdMinor < 0 ? 'credit' : 'debit',
            sourceMinor: 0,
            usdMinor: Math.abs(deltaUsdMinor),
          });
        }
      }
      for (const component of components) {
        await SellerBalanceTransaction.create([{
          seller: entitlement.sellerId,
          ...(orderId ? { order: orderId } : {}),
          type: 'reversal',
          direction: component.direction,
          status: track.riskTrack === 'refund' || completedDispute ? 'completed' : 'reserved',
          amountUSD: fromMinorUnits(component.usdMinor),
          sourceAmount: fromMinorUnits(component.sourceMinor),
          sourceCurrency,
          referenceType: 'stripe_payment',
          referenceId: components.length === 1
            ? `${eventId}:${track.trackKey}`
            : `${eventId}:${track.trackKey}:${component.key}`,
          stripeEventId: eventId,
          stripeEventType: eventType,
          stripeChargeId: chargeId,
          stripePaymentIntentId: paymentIntentId,
          description: component.direction === 'credit'
            ? `Stripe reversal allocation adjustment for ${orderLabel}`
            : track.riskTrack === 'refund'
              ? `Stripe refund reversal for ${orderLabel}`
              : `Stripe dispute reserve for ${orderLabel}`,
          completedAt: track.riskTrack === 'refund' || completedDispute ? new Date() : null,
          metadata: {
            sourceType,
            sourceReferenceId: String(sourceReferenceId),
            riskTrack: track.riskTrack,
            riskTrackKey: track.trackKey,
            ledgerComponent: component.key,
            trackExposureMinor: track.exposureMinor,
            chargeAmountMinor,
            combinedExposureMinor,
            refundExposureMinor: effectiveRefundExposure,
            allocationAdjustment: component.direction === 'credit',
            ...(track.riskTrack === 'dispute' ? {
              disputeId,
              disputeExposureMinor: track.exposureMinor,
              disputeStatus,
            } : {}),
          },
        }], { session });
        created += 1;
      }
    }
  }
  return {
    handled: true,
    created,
    combinedExposureMinor,
    ignoredOutOfOrder,
    previousRefundExposureMinor: persistedRefundExposure,
    refundExposureMinor: effectiveRefundExposure,
    refundDeltaMinor: effectiveRefundExposure - persistedRefundExposure,
    disputeExposureMinor: tracks.find(track => track.riskTrack === 'dispute')?.exposureMinor || 0,
    disputeTransition,
    sellerImpacts,
  };
};

const flagStripeOrderPaymentRisk = async payload => {
  const {
    paymentIntentId,
    chargeId,
    eventId,
    eventType,
    currency,
  } = payload;
  if (!paymentIntentId || !eventId || !chargeId) {
    throw riskError('Stripe order reversal references are incomplete.', 'STRIPE_PAYMENT_RISK_REFERENCE_MISSING', 400);
  }
  const chargeAmountMinor = assertSafeStripeMinor(payload.chargeAmountMinor, 'charge amount', { allowZero: false });
  const refundExposureMinor = assertSafeStripeMinor(payload.refundExposureMinor ?? 0, 'refunded amount');
  const disputeExposureMinor = assertSafeStripeMinor(payload.disputeExposureMinor ?? 0, 'dispute amount');
  if (refundExposureMinor > chargeAmountMinor || disputeExposureMinor > chargeAmountMinor) {
    throw riskError('Stripe reversal exposure exceeds the original charge.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  const rawFinancialDisputeEvent = eventType === 'charge.dispute.funds_withdrawn'
    || (eventType === 'charge.dispute.created' && FINANCIAL_DISPUTE_STATUSES.has(payload.disputeStatus));
  if ((rawFinancialDisputeEvent || payload.disputeStatus === 'lost') && disputeExposureMinor <= 0) {
    throw riskError('Stripe financial dispute amount is invalid.', 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  const identified = await findStripeOrderForPaymentIntent(paymentIntentId);
  if (!identified) return null;
  const sellerIds = [...(await sellerGroupsForOrder(identified, null)).keys()];
  const disputeEvent = eventType.startsWith('charge.dispute.');
  const wonEvent = payload.disputeStatus === 'won'
    || eventType === 'charge.dispute.funds_reinstated';
  const riskTrack = (eventType === 'charge.refunded' && refundExposureMinor > 0)
    || (wonEvent && refundExposureMinor > 0)
    ? 'refund'
    : (rawFinancialDisputeEvent || payload.disputeStatus === 'lost' ? 'dispute' : null);
  const preliminaryHolds = riskTrack
    ? await createSellerPaymentRiskHolds({
      sellerIds,
      sourceType: 'order_payment',
      sourceReferenceId: identified._id,
      paymentIntentId,
      chargeId,
      eventId,
      eventType,
      riskTrack,
      disputeId: riskTrack === 'dispute' ? payload.disputeId : null,
      exposureMinor: riskTrack === 'refund' ? refundExposureMinor : disputeExposureMinor,
    })
    : [];

  const identifiedRaw = await readRawOrder(identified._id);
  if (!identifiedRaw) {
    throw riskError('The paid Stripe order disappeared before reversal validation.', 'STRIPE_ORDER_RISK_SOURCE_MISSING');
  }
  const identifiedCurrency = getAccountingOrderCurrency(identifiedRaw);
  const eventCurrency = requireStripeEventCurrency(currency);
  if (eventCurrency !== identifiedCurrency) {
    throw riskError('Stripe reversal currency does not match the paid order.', 'STRIPE_PAYMENT_RISK_CURRENCY_MISMATCH', 400);
  }
  if (getExpectedStripeTotalMinor(identifiedRaw) !== chargeAmountMinor) {
    throw riskError('Stripe reversal amount does not match the paid order total.', 'STRIPE_PAYMENT_RISK_CHARGE_MISMATCH', 400);
  }

  const result = await runInTransaction(async session => {
    const order = await findStripeOrderForPaymentIntent(paymentIntentId).session(session);
    if (!order) throw riskError('The paid Stripe order disappeared during reversal accounting.', 'STRIPE_ORDER_RISK_SOURCE_MISSING');
    const rawOrder = await readRawOrder(order._id, session);
    if (!rawOrder) throw riskError('The paid Stripe order disappeared during reversal accounting.', 'STRIPE_ORDER_RISK_SOURCE_MISSING');
    const sourceCurrency = getAccountingOrderCurrency(rawOrder);
    if (requireStripeEventCurrency(currency) !== sourceCurrency) {
      throw riskError('Stripe reversal currency does not match the paid order.', 'STRIPE_PAYMENT_RISK_CURRENCY_MISMATCH', 400);
    }
    if (getExpectedStripeTotalMinor(rawOrder) !== chargeAmountMinor) {
      throw riskError('Stripe reversal amount does not match the paid order total.', 'STRIPE_PAYMENT_RISK_CHARGE_MISMATCH', 400);
    }
    let rates = getOrderExchangeRates(rawOrder);
    const requiresTrustedRates = sourceCurrency !== 'USD'
      && (
        refundExposureMinor > 0
        || rawFinancialDisputeEvent
        || payload.disputeStatus === 'lost'
      );
    if (!rates && requiresTrustedRates) {
      rates = await ensureOrderExchangeRateSnapshot(order, { session });
      if (!rates) {
        throw riskError(
          'This legacy foreign-currency order has no checkout exchange-rate snapshot. Stripe reversal accounting requires an audited backfill.',
          'STRIPE_PAYMENT_RISK_HISTORICAL_RATE_MISSING',
        );
      }
    }
    let sellerEntitlements;
    try {
      sellerEntitlements = await sellerEntitlementsForOrder(order, session);
    } catch (error) {
      if (error?.code === 'SELLER_SETTLEMENT_HISTORICAL_RATE_MISSING') {
        throw riskError(
          'This legacy foreign-currency order has no checkout exchange-rate snapshot. Stripe reversal accounting requires an audited backfill.',
          'STRIPE_PAYMENT_RISK_HISTORICAL_RATE_MISSING',
        );
      }
      if (error?.code === 'SELLER_SETTLEMENT_EXCHANGE_RATE_MISSING') {
        throw riskError(
          'Trusted exchange rates are temporarily unavailable for Stripe reversal accounting.',
          'STRIPE_PAYMENT_RISK_EXCHANGE_RATE_MISSING',
        );
      }
      throw error;
    }
    const ledger = await applySellerStripeRiskLedger({
      session,
      sourceType: 'order_payment',
      sourceReferenceId: order._id,
      orderId: order._id,
      orderLabel: `order ${order.orderId}`,
      sellerEntitlements,
      sourceCurrency,
      rates,
      ...payload,
      chargeAmountMinor,
      refundExposureMinor,
      disputeExposureMinor,
    });
    const refundNotifications = ledger.refundDeltaMinor > 0
      ? await reconcileOrderRefundNotificationEvidence({
        session,
        order,
        sourceCurrency,
        payload,
        ledger,
      })
      : { notified: false, replay: true };
    const disputeNotifications = await reconcileOrderDisputeNotifications({
      session,
      order,
      sourceCurrency,
      sellerEntitlements,
      rates,
      payload,
      ledger,
    });
    return {
      ...ledger,
      sourceType: 'order_payment',
      order,
      refundNotifications,
      disputeNotifications,
    };
  });

  if (refundExposureMinor > 0 && !INQUIRY_DISPUTE_STATUSES.has(payload.disputeStatus)) {
    await resolveSellerPaymentRiskHolds({
      holds: preliminaryHolds,
      sourceType: 'order_payment',
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
      sourceType: 'order_payment',
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
      sourceType: 'order_payment',
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
  ACTIVE_RISK_STATUSES,
  FINANCIAL_DISPUTE_STATUSES,
  INQUIRY_DISPUTE_STATUSES,
  applySellerStripeRiskLedger,
  findStripeOrderForPaymentIntent,
  flagStripeOrderPaymentRisk,
};
