'use strict';

const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const {
  findLegacyWalletFundingCandidateSellerIds,
  materializeLegacyWalletTopUpFunding,
  runInTransaction,
} = require('./walletService');
const { fromMinorUnits, toMinorUnits } = require('./moneyMath');
const {
  readStoredWalletBalance,
  readStoredWalletBalanceMinor,
} = require('./walletStoredMoneyService');
const {
  FINANCIAL_DISPUTE_STATUSES,
  INQUIRY_DISPUTE_STATUSES,
} = require('./stripeOrderPaymentRiskService');
const {
  getDurableDisputeExposures,
  recordStripeDisputeState,
} = require('./stripeDisputeStateService');
const {
  applyIncomingWalletCredit,
  classifyLegacyWalletPaymentLiabilities,
  consumeWalletBalanceForLiability,
  finalizeLostWalletDispute,
  liabilityAmounts,
  refreshWalletPaymentRiskStatus,
  resolveWonWalletDispute,
} = require('./walletPaymentLiabilityService');
const {
  applySellerStripeRiskLedger,
} = require('./stripeOrderPaymentRiskService');
const {
  createSellerPaymentRiskHolds,
  resolveSellerPaymentRiskHolds,
} = require('./sellerPaymentRiskHoldService');
const {
  enqueueStripeWalletRiskNotifications,
  persistStripeSourceDisputeEvent,
  reconcileStripeSourceRefundEvidence,
  reviewStripeSourceRisk,
} = require('./stripePaymentRiskNotificationService');

const paymentIntentIdOf = charge => (
  typeof charge?.payment_intent === 'string'
    ? charge.payment_intent
    : charge?.payment_intent?.id
);
const riskError = (message, code, statusCode = 503) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const roundProductRatio = (left, right, denominator) => {
  const denominatorBig = BigInt(denominator);
  if (denominatorBig <= 0n) return 0;
  const numerator = BigInt(left) * BigInt(right);
  const rounded = (numerator * 2n + denominatorBig) / (denominatorBig * 2n);
  const numeric = Number(rounded);
  if (!Number.isSafeInteger(numeric)) {
    throw riskError('Wallet payment-risk amount is too large.', 'WALLET_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  return numeric;
};

const findCompletedWalletTopUp = paymentIntentId => WalletTransaction.findOne({
  type: 'top_up',
  status: 'completed',
  stripePaymentIntentId: paymentIntentId,
});

const resolveWalletPaymentRiskSource = async ({ paymentIntentId, sourceType = null, session = null }) => {
  if (sourceType && sourceType !== 'wallet_top_up') return null;
  let query = findCompletedWalletTopUp(paymentIntentId);
  if (session) query = query.session(session);
  const transaction = await query;
  return transaction ? { sourceType: 'wallet_top_up', transaction } : null;
};

const riskMetadataMinor = (row, field) => {
  const value = row?.metadata?.[field];
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw riskError(
      `Persisted Wallet payment-risk ${field} is malformed.`,
      'WALLET_PAYMENT_RISK_LEDGER_MISMATCH',
      400,
    );
  }
  return value;
};

const maxMetadataMinor = (rows, field) => rows.reduce(
  (maximum, row) => Math.max(maximum, riskMetadataMinor(row, field)),
  0,
);

const activeDisputeExposures = rows => {
  const exposures = new Map();
  for (const row of rows) {
    if (row?.metadata?.riskTrack !== 'dispute') continue;
    const key = String(row?.metadata?.disputeId || 'legacy-dispute');
    exposures.set(key, Math.max(
      exposures.get(key) ?? 0,
      riskMetadataMinor(row, 'disputeExposureMinor'),
    ));
  }
  return exposures;
};

const fundingRowsForTopUp = (sourceTransactionId, session) => WalletTransaction.find({
  type: 'order_payment',
  direction: 'debit',
  status: 'completed',
  'metadata.fundingProvenance': {
    $elemMatch: {
      sourceType: 'wallet_top_up',
      sourceTransactionId: String(sourceTransactionId),
    },
  },
}).sort({ completedAt: 1, _id: 1 }).session(session);

const returnedFundingRowsForTopUp = (sourceTransactionId, session) => WalletTransaction.find({
  type: 'return_refund',
  direction: 'credit',
  status: 'completed',
  'metadata.fundingProvenanceReturns': {
    $elemMatch: {
      sourceType: 'wallet_top_up',
      sourceTransactionId: String(sourceTransactionId),
    },
  },
}).sort({ completedAt: 1, _id: 1 }).session(session);

const sellerIdsFromFundingRows = (rows, sourceTransactionId) => [...new Set(
  (rows || []).flatMap(row => (row?.metadata?.fundingProvenance || [])
    .filter(entry => (
      entry?.sourceType === 'wallet_top_up'
      && String(entry?.sourceTransactionId || '') === String(sourceTransactionId)
    ))
    .flatMap(entry => (entry?.sellerAllocations || []).map(allocation => String(allocation?.seller || ''))))
    .filter(Boolean),
)].sort();

const validateFundingSnapshot = (snapshot, sourceMinor) => {
  if (snapshot?.version !== 1) return null;
  const buyerPrincipalMinor = snapshot.buyerPrincipalMinor;
  const sellers = (snapshot.sellers || []).map(entry => ({
    seller: String(entry?.seller || ''),
    sellerId: String(entry?.seller || ''),
    sourceCurrency: String(entry?.sourceCurrency || ''),
    sourceAmountMinor: entry?.sourceAmountMinor,
    amountUSDMinor: entry?.amountUSDMinor,
  }));
  const sellerLots = (snapshot.sellerLots || []).map((entry, index) => ({
    sequence: index,
    seller: String(entry?.seller || ''),
    sourceAmountMinor: entry?.sourceAmountMinor,
    amountUSDMinor: entry?.amountUSDMinor,
    orderId: String(entry?.orderId || ''),
  }));
  if (
    !Number.isSafeInteger(buyerPrincipalMinor) || buyerPrincipalMinor < 0
    || sellers.some(entry => (
      !entry.seller
      || !Number.isSafeInteger(entry.sourceAmountMinor) || entry.sourceAmountMinor < 0
      || !Number.isSafeInteger(entry.amountUSDMinor) || entry.amountUSDMinor < 0
    ))
    || sellerLots.some(entry => (
      !entry.seller
      || !Number.isSafeInteger(entry.sourceAmountMinor) || entry.sourceAmountMinor <= 0
      || !Number.isSafeInteger(entry.amountUSDMinor) || entry.amountUSDMinor < 0
    ))
  ) {
    throw riskError('Wallet funding provenance snapshot is malformed.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
  }
  const sellerPrincipalMinor = sellers.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0);
  const lotPrincipalMinor = sellerLots.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0);
  const lotBySeller = new Map();
  for (const lot of sellerLots) {
    const current = lotBySeller.get(lot.seller) || { source: 0, usd: 0 };
    current.source += lot.sourceAmountMinor;
    current.usd += lot.amountUSDMinor;
    lotBySeller.set(lot.seller, current);
  }
  if (
    !Number.isSafeInteger(sellerPrincipalMinor)
    || lotPrincipalMinor !== sellerPrincipalMinor
    || buyerPrincipalMinor + sellerPrincipalMinor !== sourceMinor
    || sellers.some(entry => {
      const lots = lotBySeller.get(entry.seller) || { source: 0, usd: 0 };
      return lots.source !== entry.sourceAmountMinor || lots.usd !== entry.amountUSDMinor;
    })
  ) {
    throw riskError('Wallet funding provenance does not conserve the top-up.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
  }
  return { version: 1, buyerPrincipalMinor, sellerPrincipalMinor, sellers, sellerLots };
};

const freezeFundingSnapshot = async ({ source, session }) => {
  const sourceMinor = toMinorUnits(source.amount);
  // Recompute from the append-only order-payment provenance on every event.
  // A terminal partial refund may unlock the Wallet and the remaining valid
  // top-up cents can then fund another seller; an immutable first-event
  // snapshot would miss that later holder.
  const [rows, returnedRows] = await Promise.all([
    fundingRowsForTopUp(source._id, session),
    returnedFundingRowsForTopUp(source._id, session),
  ]);
  const lotMap = new Map();
  let lotSequence = 0;
  for (const row of rows) {
    for (const provenance of row?.metadata?.fundingProvenance || []) {
      if (
        provenance?.sourceType !== 'wallet_top_up'
        || String(provenance?.sourceTransactionId || '') !== String(source._id)
      ) continue;
      const provenanceMinor = provenance.amountMinor;
      const allocations = provenance.sellerAllocations || [];
      const allocatedMinor = allocations.reduce((sum, allocation) => {
        const value = allocation?.sourceAmountMinor;
        return Number.isSafeInteger(value) && value >= 0 ? sum + value : Number.NaN;
      }, 0);
      if (
        !Number.isSafeInteger(provenanceMinor) || provenanceMinor <= 0
        || !Number.isSafeInteger(allocatedMinor) || allocatedMinor < 0
        || allocatedMinor > provenanceMinor
      ) {
        throw riskError('Wallet order funding provenance is malformed.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
      }
      for (const allocation of allocations) {
        const seller = String(allocation?.seller || '');
        const sourceAmountMinor = allocation?.sourceAmountMinor;
        const amountUSDMinor = allocation?.amountUSDMinor;
        if (
          !seller
          || !Number.isSafeInteger(sourceAmountMinor) || sourceAmountMinor < 0
          || !Number.isSafeInteger(amountUSDMinor) || amountUSDMinor < 0
        ) {
          throw riskError('Wallet seller funding provenance is malformed.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
        }
        if (sourceAmountMinor === 0 && amountUSDMinor === 0) continue;
        const orderId = String(provenance?.orderId || row?.referenceId || '');
        const lotKey = `${seller}\u0000${orderId}`;
        const current = lotMap.get(lotKey) || {
          sequence: lotSequence++,
          seller,
          orderId,
          sourceAmountMinor: 0,
          amountUSDMinor: 0,
        };
        current.sourceAmountMinor += sourceAmountMinor;
        current.amountUSDMinor += amountUSDMinor;
        if (!Number.isSafeInteger(current.sourceAmountMinor) || !Number.isSafeInteger(current.amountUSDMinor)) {
          throw riskError('Wallet seller funding provenance is too large.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
        }
        lotMap.set(lotKey, current);
      }
    }
  }
  for (const row of returnedRows) {
    for (const movement of row?.metadata?.fundingProvenanceReturns || []) {
      if (
        movement?.sourceType !== 'wallet_top_up'
        || String(movement?.sourceTransactionId || '') !== String(source._id)
      ) continue;
      const seller = String(movement?.seller || '');
      const orderId = String(movement?.orderId || '');
      const amountMinor = movement?.amountMinor;
      const amountUSDMinor = movement?.amountUSDMinor;
      const lot = lotMap.get(`${seller}\u0000${orderId}`);
      if (
        !seller || !orderId || !lot
        || !Number.isSafeInteger(amountMinor) || amountMinor < 0
        || !Number.isSafeInteger(amountUSDMinor) || amountUSDMinor < 0
        || amountMinor > lot.sourceAmountMinor
        || amountUSDMinor > lot.amountUSDMinor
      ) {
        throw riskError('Returned Wallet funding provenance is malformed.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
      }
      lot.sourceAmountMinor -= amountMinor;
      lot.amountUSDMinor -= amountUSDMinor;
    }
  }
  const sellerLots = [...lotMap.values()]
    .filter(lot => lot.sourceAmountMinor > 0 || lot.amountUSDMinor > 0)
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ sequence, ...lot }) => lot);
  const sellerMap = new Map();
  for (const lot of sellerLots) {
    if (lot.sourceAmountMinor <= 0) {
      throw riskError('Returned Wallet funding left an impossible USD-only seller lot.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
    }
    const current = sellerMap.get(lot.seller) || { sourceAmountMinor: 0, amountUSDMinor: 0 };
    current.sourceAmountMinor += lot.sourceAmountMinor;
    current.amountUSDMinor += lot.amountUSDMinor;
    sellerMap.set(lot.seller, current);
  }
  const sellers = [...sellerMap.entries()].map(([seller, amounts]) => ({
    seller,
    sourceCurrency: source.currency,
    ...amounts,
  })).filter(entry => entry.sourceAmountMinor > 0 || entry.amountUSDMinor > 0)
    .sort((left, right) => left.seller.localeCompare(right.seller));
  const sellerPrincipalMinor = sellers.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0);
  if (!Number.isSafeInteger(sellerPrincipalMinor) || sellerPrincipalMinor > sourceMinor) {
    throw riskError('Wallet seller funding exceeds the top-up.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
  }
  // Any legacy/unattributed principal remains a buyer liability. For new
  // transactions, seller allocations plus the source lot's remaining cents
  // make this equality exact; the conservative legacy branch cannot expose a
  // seller whose identity was never persisted.
  const snapshot = {
    version: 1,
    buyerPrincipalMinor: sourceMinor - sellerPrincipalMinor,
    sellers,
    sellerLots,
    orderIds: [...new Set(rows.map(row => String(row?.referenceId || '')).filter(Boolean))].sort(),
  };
  source.metadata = {
    ...(source.metadata || {}),
    paymentRiskFundingSnapshot: snapshot,
  };
  source.markModified('metadata');
  await source.save({ session });
  return validateFundingSnapshot(snapshot, sourceMinor);
};

const allocateTopUpRiskTracks = ({
  sourceMinor,
  chargeAmountMinor,
  fundingSnapshot,
  trackOrder,
  exposureByTrack,
}) => {
  const buyerCap = fundingSnapshot.buyerPrincipalMinor;
  const sellerStart = buyerCap;
  let lotCursor = sellerStart;
  const positionedLots = fundingSnapshot.sellerLots.map(lot => {
    const positioned = { ...lot, start: lotCursor, end: lotCursor + lot.sourceAmountMinor };
    lotCursor = positioned.end;
    return positioned;
  });
  if (lotCursor !== sourceMinor) {
    throw riskError('Wallet holder positions do not conserve the top-up.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
  }

  let exposureCursor = 0;
  const tracks = [];
  for (const trackKey of trackOrder) {
    const exposureMinor = exposureByTrack.get(trackKey) ?? 0;
    if (!Number.isSafeInteger(exposureMinor) || exposureMinor < 0) {
      throw riskError('Wallet risk-track exposure is invalid.', 'WALLET_PAYMENT_RISK_AMOUNT_INVALID', 400);
    }
    if (!exposureMinor) continue;
    const trackTarget = roundProductRatio(sourceMinor, exposureMinor, chargeAmountMinor);
    const start = exposureCursor;
    const end = exposureCursor + trackTarget;
    exposureCursor = end;
    let buyerTargetMinor = Math.max(0, Math.min(end, buyerCap) - Math.min(start, buyerCap));
    // Stripe can refund part of a payment and later withdraw a full dispute.
    // Exposure beyond original principal is a separate buyer liability; seller
    // recovery remains capped at the exact revenue funded by this top-up.
    buyerTargetMinor += Math.max(0, end - Math.max(start, sourceMinor));
    const sellerSourceTargets = new Map();
    const sellerUsdTargets = new Map();
    for (const lot of positionedLots) {
      const overlapStart = Math.max(start, lot.start);
      const overlapEnd = Math.min(end, lot.end);
      if (overlapEnd <= overlapStart) continue;
      const localStart = overlapStart - lot.start;
      const localEnd = overlapEnd - lot.start;
      const sourceDelta = localEnd - localStart;
      const usdAtStart = roundProductRatio(lot.amountUSDMinor, localStart, lot.sourceAmountMinor);
      const usdAtEnd = roundProductRatio(lot.amountUSDMinor, localEnd, lot.sourceAmountMinor);
      sellerSourceTargets.set(
        lot.seller,
        (sellerSourceTargets.get(lot.seller) ?? 0) + sourceDelta,
      );
      sellerUsdTargets.set(
        lot.seller,
        (sellerUsdTargets.get(lot.seller) ?? 0) + (usdAtEnd - usdAtStart),
      );
    }
    const sellerTargetMinor = [...sellerSourceTargets.values()].reduce((sum, value) => sum + value, 0);
    if (buyerTargetMinor + sellerTargetMinor !== trackTarget) {
      throw riskError('Wallet holder risk targets do not conserve exposure.', 'WALLET_FUNDING_PROVENANCE_INVALID', 400);
    }
    tracks.push({
      trackKey,
      riskTrack: trackKey === 'refund' ? 'refund' : 'dispute',
      disputeId: trackKey === 'refund' ? null : trackKey.slice('dispute:'.length),
      exposureMinor,
      trackTarget,
      buyerTargetMinor,
      sellerTargetMinor,
      sellerSourceTargets,
      sellerUsdTargets,
    });
  }
  return tracks;
};

const buyerTrackLiabilityMinor = ({ rows, riskTrack, disputeId = null }) => {
  const total = (rows || []).filter(row => (
    row?.metadata?.riskTrack === riskTrack
    && (riskTrack !== 'dispute'
      || String(row?.metadata?.disputeId || '') === String(disputeId || ''))
  )).reduce((sum, row) => sum + liabilityAmounts(row).liabilityMinor, 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw riskError(
      'Wallet buyer risk allocation is malformed.',
      'WALLET_PAYMENT_RISK_LEDGER_MISMATCH',
      400,
    );
  }
  return total;
};

const walletAccountImpact = ({ source, action, direction, amountMinor }) => (
  amountMinor > 0
    ? {
      userId: String(source.user),
      action,
      direction,
      sourceAmountMinor: amountMinor,
      sourceCurrency: source.currency,
    }
    : null
);

const walletContextAllocation = ({
  source,
  fundingSnapshot,
  chargeAmountMinor,
  disputeId,
  disputeExposureMinor,
  action,
  direction,
}) => {
  const [track] = allocateTopUpRiskTracks({
    sourceMinor: toMinorUnits(source.amount),
    chargeAmountMinor,
    fundingSnapshot,
    trackOrder: [`dispute:${disputeId}`],
    exposureByTrack: new Map([[`dispute:${disputeId}`, disputeExposureMinor]]),
  });
  if (!track) return { accountImpact: null, sellerImpacts: [] };
  const sellerImpacts = fundingSnapshot.sellers.map(entry => ({
    sellerId: entry.seller,
    action,
    direction,
    sourceAmountMinor: track.sellerSourceTargets.get(entry.seller) ?? 0,
    sourceCurrency: source.currency,
    amountUSDMinor: track.sellerUsdTargets.get(entry.seller) ?? 0,
  })).filter(impact => impact.sourceAmountMinor > 0 || impact.amountUSDMinor > 0);
  return {
    accountImpact: walletAccountImpact({
      source,
      action,
      direction,
      amountMinor: track.buyerTargetMinor,
    }),
    sellerImpacts,
  };
};

const walletRefundEvidenceConflicts = (refund, sourceId) => (
  ['order_inventory_refund', 'return_settlement_safety_refund', 'order_payment', 'return_settlement']
    .includes(refund.metadataType)
  || Boolean(refund.metadataOrderId)
  || (refund.metadataWalletTransactionId
    && refund.metadataWalletTransactionId !== String(sourceId))
  || Boolean(refund.metadataReturnRequestId)
);

const reconcileWalletRiskNotifications = async ({
  session,
  source,
  fundingSnapshot,
  payload,
  effectiveRefundExposureMinor,
  previousRefundExposureMinor,
  priorRefundBuyerMinor,
  priorDisputeBuyerMinor,
  tracks,
  sellerResults,
  disputeTransition,
}) => {
  const result = { refund: { notified: false, replay: true }, disputes: [] };
  const refundTrack = tracks.find(track => track.trackKey === 'refund');
  const providerRefundDeltaMinor = effectiveRefundExposureMinor - previousRefundExposureMinor;
  if (!Number.isSafeInteger(providerRefundDeltaMinor) || providerRefundDeltaMinor < 0) {
    throw riskError(
      'Wallet provider refund delta is malformed.',
      'WALLET_PAYMENT_RISK_LEDGER_MISMATCH',
      400,
    );
  }
  const buyerRefundDeltaMinor = (refundTrack?.buyerTargetMinor ?? 0) - priorRefundBuyerMinor;
  const refundSellerImpacts = sellerResults
    .flatMap(entry => entry?.sellerImpacts || [])
    .filter(impact => impact.action === 'refund_debited');
  if (providerRefundDeltaMinor > 0) {
    result.refund = await reconcileStripeSourceRefundEvidence({
      session,
      payload,
      sourceType: 'wallet_top_up',
      sourceDocument: source,
      sourceCurrency: source.currency,
      classification: 'wallet_refund',
      eventKeyPrefix: `wallet:${source._id}`,
      refundDeltaMinor: providerRefundDeltaMinor,
      accountImpact: walletAccountImpact({
        source,
        action: 'refund_debited',
        direction: buyerRefundDeltaMinor < 0 ? 'credit' : 'debit',
        amountMinor: Math.abs(buyerRefundDeltaMinor),
      }),
      sellerImpacts: refundSellerImpacts,
      evidenceConflictsWithSource: refund => walletRefundEvidenceConflicts(refund, source._id),
    });
    if (result.refund.notified) {
      result.refund.notifications = await enqueueStripeWalletRiskNotifications({
        event: result.refund.persisted.event,
        walletTopUp: source,
        session,
      });
    }
  } else if (buyerRefundDeltaMinor !== 0 || refundSellerImpacts.length) {
    result.allocationReview = await reviewStripeSourceRisk({
      payload,
      sourceType: 'wallet_top_up',
      sourceDocument: source,
      reasonCode: 'WALLET_RISK_ALLOCATION_REBALANCED',
      reason: 'An existing Wallet refund liability was reallocated without a new provider refund delta. No customer or seller money outcome was inferred from that internal rebalancing.',
      session,
    });
  }
  if (!payload.eventType.startsWith('charge.dispute.') || disputeTransition?.ignoredFinancialEvent) {
    return result;
  }

  const disputeTrack = tracks.find(track => track.disputeId === payload.disputeId);
  const allSellerImpacts = sellerResults.flatMap(entry => entry?.sellerImpacts || []);
  let classification = null;
  let action = null;
  let direction = null;
  let accountAmountMinor = 0;
  let sellerImpacts = [];

  if (
    payload.eventType === 'charge.dispute.created'
    && INQUIRY_DISPUTE_STATUSES.has(payload.disputeStatus)
  ) {
    classification = 'wallet_dispute_inquiry';
    action = 'dispute_inquiry';
    direction = 'none';
  } else if (disputeTransition?.terminalTransition && disputeTransition.resolution === 'won') {
    sellerImpacts = allSellerImpacts.filter(impact => impact.action === 'dispute_released');
    if (sellerImpacts.length || priorDisputeBuyerMinor > 0) {
      classification = 'wallet_dispute_won';
      action = 'dispute_released';
      direction = 'credit';
      accountAmountMinor = priorDisputeBuyerMinor;
    } else {
      classification = 'wallet_dispute_won_no_reserve';
      action = 'dispute_won_no_reserve';
      direction = 'none';
    }
  } else if (disputeTransition?.terminalTransition && disputeTransition.resolution === 'lost') {
    classification = 'wallet_dispute_lost';
    action = 'dispute_finalized';
    direction = 'none';
    sellerImpacts = allSellerImpacts.filter(impact => impact.action === 'dispute_finalized');
    // A lost-first delivery has no prior buyer row, so use its newly computed
    // target. Otherwise the notification describes the liability that was
    // already held. Keep this selection explicit instead of a coercive money
    // fallback which could conceal malformed numeric state.
    accountAmountMinor = priorDisputeBuyerMinor > 0
      ? priorDisputeBuyerMinor
      : (disputeTrack?.buyerTargetMinor ?? 0);
  } else if (disputeTransition?.financialExposureIncreased) {
    classification = 'wallet_dispute_opened';
    action = 'dispute_reserved';
    direction = 'debit';
    sellerImpacts = allSellerImpacts.filter(impact => impact.action === 'dispute_reserved');
    accountAmountMinor = Math.max(0, (disputeTrack?.buyerTargetMinor ?? 0) - priorDisputeBuyerMinor);
  }
  if (!classification) return result;

  if (classification.endsWith('_inquiry') || classification.endsWith('_won_no_reserve')) {
    const context = walletContextAllocation({
      source,
      fundingSnapshot,
      chargeAmountMinor: payload.chargeAmountMinor,
      disputeId: payload.disputeId,
      disputeExposureMinor: payload.disputeExposureMinor,
      action,
      direction,
    });
    accountAmountMinor = context.accountImpact?.sourceAmountMinor ?? 0;
    sellerImpacts = context.sellerImpacts;
  }
  const persisted = await persistStripeSourceDisputeEvent({
    session,
    payload,
    sourceType: 'wallet_top_up',
    sourceDocument: source,
    sourceCurrency: source.currency,
    classification,
    eventKeyPrefix: `wallet:${source._id}`,
    accountImpact: walletAccountImpact({ source, action, direction, amountMinor: accountAmountMinor }),
    sellerImpacts,
  });
  if (persisted.notified) {
    result.disputes.push({
      persisted,
      notifications: await enqueueStripeWalletRiskNotifications({
        event: persisted.persisted.event,
        walletTopUp: source,
        session,
      }),
    });
  } else {
    result.disputes.push({ persisted, notifications: [] });
  }
  return result;
};

const consumeBuyerTopUpFunding = async ({
  source,
  wallet,
  currency,
  liabilityMinor,
  session,
}) => {
  const trackedRemaining = source.metadata?.fundingRemainingMinor;
  const trackedOriginal = source.metadata?.fundingOriginalAvailableMinor;
  const hasRemaining = trackedRemaining !== undefined;
  const hasOriginal = trackedOriginal !== undefined;
  if (!hasRemaining && !hasOriginal) {
    // Historical top-ups predate funding lots. Preserve their established
    // behavior: collect available buyer funds and carry an audited shortfall.
    return consumeWalletBalanceForLiability({
      walletId: wallet._id,
      currency,
      liabilityMinor,
      session,
    });
  }
  if (
    hasRemaining !== hasOriginal
    || !Number.isSafeInteger(trackedRemaining) || trackedRemaining < 0
    || !Number.isSafeInteger(trackedOriginal) || trackedOriginal < 0
    || trackedRemaining > trackedOriginal
  ) {
    throw riskError(
      'Wallet top-up funding counters are malformed.',
      'WALLET_FUNDING_PROVENANCE_INVALID',
      400,
    );
  }
  const currentWallet = await Wallet.findById(wallet._id).session(session);
  if (!currentWallet) throw riskError('The Wallet for this top-up was not found.', 'WALLET_PAYMENT_RISK_WALLET_MISSING');
  const availableMinor = readStoredWalletBalanceMinor(currentWallet, currency);
  const consumedMinor = Math.min(availableMinor, trackedRemaining, liabilityMinor);
  if (consumedMinor > 0) {
    const path = `balances.${currency}`;
    const updated = await Wallet.findOneAndUpdate(
      {
        _id: wallet._id,
        $expr: {
          $gte: [
            { $round: [{ $multiply: [{ $ifNull: [`$${path}`, 0] }, 100] }, 0] },
            consumedMinor,
          ],
        },
      },
      [{
        $set: {
          [path]: {
            $divide: [{
              $subtract: [
                { $round: [{ $multiply: [{ $ifNull: [`$${path}`, 0] }, 100] }, 0] },
                consumedMinor,
              ],
            }, 100],
          },
        },
      }],
      { new: true, session },
    );
    if (!updated) {
      throw riskError('Wallet balance changed during reversal accounting.', 'WALLET_PAYMENT_RISK_CONFLICT');
    }
    source.metadata.fundingRemainingMinor = trackedRemaining - consumedMinor;
    source.markModified('metadata');
    await source.save({ session });
  }
  return { consumedMinor, outstandingMinor: liabilityMinor - consumedMinor };
};

const restoreTrackedTopUpFunding = ({ source, creditedMinor }) => {
  const restoredMinor = creditedMinor ?? 0;
  if (!Number.isSafeInteger(restoredMinor) || restoredMinor < 0) {
    throw riskError(
      'Wallet top-up funding restoration is malformed.',
      'WALLET_FUNDING_PROVENANCE_INVALID',
      400,
    );
  }
  if (!restoredMinor) return;
  const rawRemaining = source.metadata?.fundingRemainingMinor;
  const rawOriginal = source.metadata?.fundingOriginalAvailableMinor;
  const hasRemaining = rawRemaining !== undefined;
  const hasOriginal = rawOriginal !== undefined;
  // Historical top-ups predate spendable-lot tracking. Their released cash is
  // still returned through the Wallet waterfall, but there is no trustworthy
  // lot counter to restore.
  if (!hasRemaining && !hasOriginal) return;
  const trackedRemaining = rawRemaining;
  const trackedOriginal = rawOriginal;
  if (
    !Number.isSafeInteger(trackedRemaining) || trackedRemaining < 0
    || !Number.isSafeInteger(trackedOriginal) || trackedOriginal < 0
    || trackedRemaining + restoredMinor > trackedOriginal
  ) {
    throw riskError(
      'Wallet top-up funding restoration exceeds its durable principal.',
      'WALLET_FUNDING_PROVENANCE_INVALID',
      400,
    );
  }
  source.metadata.fundingRemainingMinor = trackedRemaining + restoredMinor;
  source.markModified('metadata');
};

/**
 * Reduce one buyer risk track without rewriting its append-only ledger amount.
 * The debit row keeps the original event amount for audit, while its mutable
 * liability components record the still-effective target and a separate
 * credit adjustment records the exact released allocation. Outstanding debt
 * is released before real held/collected cash; any released cash flows through
 * the normal incoming-credit waterfall so another simultaneously growing risk
 * track can consume it atomically instead of briefly becoming spendable.
 */
const reduceBuyerRiskTrack = async ({
  source,
  wallet,
  track,
  targetMinor,
  currentMinor,
  paymentIntentId,
  chargeId,
  eventId,
  eventType,
  session,
}) => {
  let remainingReduction = currentMinor - targetMinor;
  if (remainingReduction <= 0) return { releasedMinor: 0, creditedMinor: 0 };
  const rows = await WalletTransaction.find({
    type: 'reversal',
    direction: 'debit',
    status: { $in: ['pending', 'completed'] },
    'metadata.sourcePaymentTransactionId': String(source._id),
    'metadata.riskTrack': track.riskTrack,
    ...(track.riskTrack === 'dispute'
      ? { 'metadata.disputeId': track.disputeId }
      : {}),
  }).sort({ createdAt: -1, _id: -1 }).session(session);
  let releasedCashMinor = 0;
  let releasedLiabilityMinor = 0;
  for (const row of rows) {
    if (remainingReduction <= 0) break;
    const amounts = liabilityAmounts(row);
    const reduction = Math.min(remainingReduction, amounts.liabilityMinor);
    if (!reduction) continue;
    let componentReduction = reduction;
    const reduceComponent = (value, { cash = false } = {}) => {
      const reduced = Math.min(value, componentReduction);
      componentReduction -= reduced;
      if (cash) releasedCashMinor += reduced;
      return value - reduced;
    };
    const outstandingMinor = reduceComponent(amounts.outstandingMinor);
    const writtenOffMinor = reduceComponent(amounts.writtenOffMinor);
    const heldMinor = reduceComponent(amounts.heldMinor, { cash: true });
    const collectedMinor = reduceComponent(amounts.collectedMinor, { cash: true });
    if (componentReduction !== 0) {
      throw riskError(
        'Wallet liability components do not conserve their risk target.',
        'WALLET_PAYMENT_RISK_LEDGER_MISMATCH',
        400,
      );
    }
    const liabilityMinor = amounts.liabilityMinor - reduction;
    row.metadata = {
      ...(row.metadata || {}),
      liabilityMinor,
      outstandingMinor,
      writtenOffMinor,
      heldMinor,
      collectedMinor,
      allocationRebalancedAt: new Date(),
      allocationRebalancedEventId: eventId,
    };
    if (liabilityMinor === 0) {
      row.status = 'reversed';
      row.metadata.liabilityState = 'rebalanced';
    }
    row.markModified('metadata');
    await row.save({ session });
    remainingReduction -= reduction;
    releasedLiabilityMinor += reduction;
  }
  if (remainingReduction !== 0) {
    throw riskError(
      'Wallet reversal target could not release its prior allocation exactly.',
      'WALLET_PAYMENT_RISK_LEDGER_MISMATCH',
      400,
    );
  }

  let creditResult = { creditedMinor: 0 };
  if (releasedCashMinor > 0) {
    creditResult = await applyIncomingWalletCredit({
      walletId: wallet._id,
      currency: source.currency,
      creditMinor: releasedCashMinor,
      session,
    });
    restoreTrackedTopUpFunding({ source, creditedMinor: creditResult.creditedMinor });
    await source.save({ session });
  }
  const authoritativeWallet = await Wallet.findById(wallet._id).session(session);
  await WalletTransaction.create([{
    user: source.user,
    wallet: wallet._id,
    type: 'reversal',
    direction: 'credit',
    status: 'completed',
    amount: fromMinorUnits(releasedLiabilityMinor),
    currency: source.currency,
    balanceAfter: readStoredWalletBalance(authoritativeWallet, source.currency),
    description: `Wallet payment-risk allocation adjustment for top-up ${source._id}`,
    referenceType: 'system',
    referenceId: `${eventId}:${track.trackKey}:buyer-adjustment`,
    idempotencyKey: `wallet-risk-adjustment:wallet_top_up:${eventId}:${track.trackKey}:${currentMinor}:${targetMinor}`,
    stripeChargeId: chargeId,
    stripeCustomerId: source.stripeCustomerId || null,
    stripeMode: source.stripeMode || null,
    metadata: {
      sourcePaymentTransactionId: String(source._id),
      sourceTopUpTransactionId: String(source._id),
      sourceType: 'wallet_top_up',
      riskTrack: track.riskTrack,
      riskTrackKey: track.trackKey,
      stripeEventType: eventType,
      stripeEventId: eventId,
      stripePaymentIntentId: paymentIntentId,
      allocationAdjustment: true,
      releasedLiabilityMinor,
      releasedCashMinor,
      availableCreditedMinor: creditResult.creditedMinor,
      ...(track.riskTrack === 'dispute' ? { disputeId: track.disputeId } : {}),
    },
    completedAt: new Date(),
  }], { session });
  return {
    releasedMinor: releasedLiabilityMinor,
    creditedMinor: creditResult.creditedMinor,
  };
};

const flagWalletCreditPaymentRisk = async payload => {
  const {
    paymentIntentId,
    chargeId,
    eventId,
    eventType,
    currency,
    disputeId = null,
    disputeStatus = '',
  } = payload;
  if (!paymentIntentId || !chargeId || !eventId) {
    throw riskError('Wallet payment-risk references are incomplete.', 'WALLET_PAYMENT_RISK_REFERENCE_MISSING', 400);
  }
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
    throw riskError('Wallet payment-risk amount is invalid.', 'WALLET_PAYMENT_RISK_AMOUNT_INVALID', 400);
  }
  const identified = await resolveWalletPaymentRiskSource({ paymentIntentId, sourceType: payload.sourceType });
  if (!identified) return null;

  const provisionalFinancialDispute = eventType === 'charge.dispute.funds_withdrawn'
    || (eventType === 'charge.dispute.created' && FINANCIAL_DISPUTE_STATUSES.has(disputeStatus))
    || disputeStatus === 'lost';
  const provisionalRiskTrack = eventType === 'charge.refunded' && refundExposureMinor > 0
    ? 'refund'
    : (provisionalFinancialDispute ? 'dispute' : null);
  try {
    await runInTransaction(async session => {
      const source = await WalletTransaction.findById(identified.transaction._id).session(session);
      const wallet = source ? await Wallet.findOne({ user: source.user }).session(session) : null;
      if (!source || !wallet) {
        throw riskError(
          'The Wallet top-up disappeared during legacy provenance preparation.',
          'WALLET_PAYMENT_RISK_SOURCE_MISSING',
        );
      }
      const semanticDisputeStatus = eventType === 'charge.dispute.funds_reinstated'
        ? 'won'
        : disputeStatus;
      await classifyLegacyWalletPaymentLiabilities({
        walletId: wallet._id,
        currency: source.currency,
        session,
        disputeHint: disputeId ? { disputeId, status: semanticDisputeStatus } : null,
        sourceTransactionId: source._id,
      });
      await materializeLegacyWalletTopUpFunding({
        walletId: wallet._id,
        userId: source.user,
        currency: source.currency,
        session,
      });
    });
  } catch (error) {
    let quarantineSellerIds = error?.quarantineSellerIds || [];
    if (!quarantineSellerIds.length && provisionalRiskTrack) {
      try {
        quarantineSellerIds = await findLegacyWalletFundingCandidateSellerIds({
          walletId: identified.transaction.wallet,
          userId: identified.transaction.user,
          currency: identified.transaction.currency,
        });
      } catch (_) {
        // The original replay error remains authoritative. If even immutable
        // order ownership cannot be read, the buyer Wallet lock below still
        // quarantines the source for manual reconciliation.
      }
    }
    if (quarantineSellerIds.length && provisionalRiskTrack) {
      await createSellerPaymentRiskHolds({
        sellerIds: quarantineSellerIds,
        sourceType: 'wallet_top_up',
        sourceReferenceId: identified.transaction._id,
        paymentIntentId,
        chargeId,
        eventId,
        eventType,
        riskTrack: provisionalRiskTrack,
        disputeId: provisionalRiskTrack === 'dispute' ? disputeId : null,
        exposureMinor: provisionalRiskTrack === 'refund' ? refundExposureMinor : disputeExposureMinor,
        unknownExposure: true,
      });
    }
    const sourceWalletId = identified.transaction.wallet;
    if (sourceWalletId) {
      await Wallet.updateOne(
        {
          _id: sourceWalletId,
          $or: [{ status: 'active' }, { lockSource: 'payment_risk' }],
        },
        {
          $set: {
            status: 'locked',
            lockSource: 'payment_risk',
            lockedReason: 'Wallet payment-risk legacy funding quarantine requires manual reconciliation.',
          },
        },
      );
    }
    throw error;
  }

  const preliminaryFundingRows = await fundingRowsForTopUp(identified.transaction._id, null);
  const preliminarySellerIds = sellerIdsFromFundingRows(
    preliminaryFundingRows,
    identified.transaction._id,
  );
  const preliminaryFinancialDispute = eventType === 'charge.dispute.funds_withdrawn'
    || (eventType === 'charge.dispute.created' && FINANCIAL_DISPUTE_STATUSES.has(disputeStatus))
    || disputeStatus === 'lost';
  const preliminaryRiskTrack = eventType === 'charge.refunded' && refundExposureMinor > 0
    ? 'refund'
    : (preliminaryFinancialDispute ? 'dispute' : null);
  const preliminaryHolds = preliminaryRiskTrack && preliminarySellerIds.length
    ? await createSellerPaymentRiskHolds({
      sellerIds: preliminarySellerIds,
      sourceType: 'wallet_top_up',
      sourceReferenceId: identified.transaction._id,
      paymentIntentId,
      chargeId,
      eventId,
      eventType,
      riskTrack: preliminaryRiskTrack,
      disputeId: preliminaryRiskTrack === 'dispute' ? disputeId : null,
      exposureMinor: preliminaryRiskTrack === 'refund' ? refundExposureMinor : disputeExposureMinor,
    })
    : [];

  const result = await runInTransaction(async session => {
    const resolved = await resolveWalletPaymentRiskSource({
      paymentIntentId,
      sourceType: payload.sourceType,
      session,
    });
    if (!resolved) throw riskError('The completed Wallet top-up disappeared.', 'WALLET_PAYMENT_RISK_SOURCE_MISSING');
    const source = resolved.transaction;
    if (String(source.currency || '').toUpperCase() !== String(currency || '').toUpperCase()) {
      throw riskError('Stripe reversal currency does not match the Wallet top-up.', 'WALLET_PAYMENT_RISK_CURRENCY_MISMATCH', 400);
    }
    if (toMinorUnits(source.amount) !== chargeAmountMinor) {
      throw riskError('Stripe reversal amount does not match the Wallet top-up.', 'WALLET_PAYMENT_RISK_CHARGE_MISMATCH', 400);
    }
    const wallet = await Wallet.findOne({ user: source.user }).session(session);
    if (!wallet) throw riskError('The Wallet for this top-up was not found.', 'WALLET_PAYMENT_RISK_WALLET_MISSING');
    const fundingSnapshot = await freezeFundingSnapshot({ source, session });

    const scope = {
      type: 'reversal',
      direction: 'debit',
      'metadata.sourcePaymentTransactionId': String(source._id),
    };
    let activeRows = await WalletTransaction.find({
      ...scope,
      status: { $in: ['pending', 'completed'] },
    }).session(session).lean();
    const priorRefundBuyerMinor = buyerTrackLiabilityMinor({
      rows: activeRows,
      riskTrack: 'refund',
    });
    const priorDisputeBuyerMinor = disputeId
      ? buyerTrackLiabilityMinor({ rows: activeRows, riskTrack: 'dispute', disputeId })
      : 0;

    const inquiryOnly = INQUIRY_DISPUTE_STATUSES.has(disputeStatus);
    const rawFinancialDisputeEvent = eventType === 'charge.dispute.funds_withdrawn'
      || (eventType === 'charge.dispute.created' && FINANCIAL_DISPUTE_STATUSES.has(disputeStatus));
    if ((rawFinancialDisputeEvent || disputeStatus === 'lost') && disputeExposureMinor <= 0) {
      throw riskError('Wallet financial dispute amount is invalid.', 'WALLET_PAYMENT_RISK_AMOUNT_INVALID', 400);
    }
    const disputeEvent = eventType.startsWith('charge.dispute.');
    let disputeTransition = null;
    if (disputeEvent) {
      disputeTransition = await recordStripeDisputeState({
        session,
        sourceType: 'wallet_top_up',
        sourceReferenceId: source._id,
        paymentIntentId,
        chargeId,
        disputeId,
        eventId,
        eventType,
        disputeStatus,
        disputeExposureMinor,
        financialEvent: rawFinancialDisputeEvent || disputeStatus === 'lost',
      });
      if (disputeTransition.ignoredFinancialEvent) {
        const refreshed = await refreshWalletPaymentRiskStatus(wallet._id, session);
        return {
          handled: true,
          created: false,
          terminal: true,
          ignoredOutOfOrder: true,
          source,
          wallet: refreshed.wallet,
        };
      }
    }

    const disputeResolution = disputeTransition?.resolution || null;
    if (disputeResolution) {
      if (disputeResolution === 'won') {
        const resolution = await resolveWonWalletDispute({
          walletId: wallet._id,
          sourceTransactionId: source._id,
          disputeId,
          currency: source.currency,
          eventId,
          session,
        });
        if (!Number.isSafeInteger(resolution.creditedMinor) || resolution.creditedMinor < 0) {
          throw riskError(
            'Wallet dispute resolution returned a malformed credit amount.',
            'WALLET_PAYMENT_RISK_LEDGER_MISMATCH',
            400,
          );
        }
        if (resolution.creditedMinor > 0) {
          restoreTrackedTopUpFunding({ source, creditedMinor: resolution.creditedMinor });
          await source.save({ session });
        }
      } else if (disputeResolution === 'lost') {
        await finalizeLostWalletDispute({
          walletId: wallet._id,
          sourceTransactionId: source._id,
          disputeId,
          currency: source.currency,
          eventId,
          session,
        });
      }
      activeRows = await WalletTransaction.find({
        ...scope,
        status: { $in: ['pending', 'completed'] },
      }).session(session).lean();
    }

    // A lost closure can be the first delivered event. Debit it as completed
    // immediately, then let the terminal state suppress stale financial events.
    const financialDisputeEvent = !disputeTransition?.ignoredFinancialEvent
      && (rawFinancialDisputeEvent || disputeResolution === 'lost');
    const refundEvent = eventType === 'charge.refunded' && refundExposureMinor > 0;
    const wonCatchup = disputeResolution === 'won' && refundExposureMinor > 0;
    const noNewFinancialTrack = inquiryOnly
      || (!financialDisputeEvent && !refundEvent && !wonCatchup);

    const previousRefundExposureMinor = Math.max(
      riskMetadataMinor({ metadata: source.metadata }, 'paymentRiskRefundExposureMinor'),
      maxMetadataMinor(activeRows, 'refundExposureMinor'),
    );
    const effectiveRefundExposure = Math.min(
      chargeAmountMinor,
      Math.max(
        previousRefundExposureMinor,
        refundExposureMinor,
      ),
    );
    const disputeExposures = activeDisputeExposures(activeRows);
    const durableDisputeExposures = await getDurableDisputeExposures({
      session,
      sourceType: 'wallet_top_up',
      sourceReferenceId: source._id,
      paymentIntentId,
      chargeId,
    });
    for (const [key, amount] of durableDisputeExposures) {
      disputeExposures.set(key, Math.max(disputeExposures.get(key) ?? 0, amount));
    }
    const effectiveDisputeExposure = [...disputeExposures.values()]
      .reduce((sum, amount) => sum + amount, 0);
    const combinedExposureMinor = effectiveRefundExposure + effectiveDisputeExposure;
    if (!Number.isSafeInteger(effectiveDisputeExposure) || !Number.isSafeInteger(combinedExposureMinor)) {
      throw riskError('Wallet payment-risk exposure is too large.', 'WALLET_PAYMENT_RISK_AMOUNT_INVALID', 400);
    }
    const sourceLabel = `Wallet top-up ${source._id}`;
    const existingTrackOrder = Array.isArray(source.metadata?.paymentRiskTrackOrder)
      ? source.metadata.paymentRiskTrackOrder.map(value => String(value || '')).filter(Boolean)
      : [];
    const trackOrder = [...new Set(existingTrackOrder)];
    const appendTrack = key => {
      if (key && !trackOrder.includes(key)) trackOrder.push(key);
    };
    if (!noNewFinancialTrack && refundEvent) appendTrack('refund');
    if (!noNewFinancialTrack && financialDisputeEvent) {
      // A dispute snapshot may already report a prior refund whose webhook was
      // delayed. Preserve that known chronological predecessor before the new
      // dispute; otherwise append later events in first-financial-seen order.
      if (effectiveRefundExposure > 0 && !trackOrder.includes('refund')) appendTrack('refund');
      appendTrack(`dispute:${disputeId}`);
    }
    if (effectiveRefundExposure > 0) appendTrack('refund');
    [...disputeExposures.keys()].sort().forEach(id => appendTrack(`dispute:${id}`));
    source.metadata = {
      ...(source.metadata || {}),
      paymentRiskTrackOrder: trackOrder,
      paymentRiskRefundExposureMinor: Math.max(
        riskMetadataMinor({ metadata: source.metadata }, 'paymentRiskRefundExposureMinor'),
        effectiveRefundExposure,
      ),
    };
    source.markModified('metadata');
    await source.save({ session });

    const exposureByTrack = new Map();
    if (effectiveRefundExposure > 0) exposureByTrack.set('refund', effectiveRefundExposure);
    for (const [id, amount] of disputeExposures) {
      if (amount > 0) exposureByTrack.set(`dispute:${id}`, amount);
    }
    const tracks = allocateTopUpRiskTracks({
      sourceMinor: toMinorUnits(source.amount),
      chargeAmountMinor,
      fundingSnapshot,
      trackOrder,
      exposureByTrack,
    });

    let created = 0;
    let review = null;
    for (const track of tracks) {
      const trackRows = activeRows.filter(row => (
        row?.metadata?.riskTrack === track.riskTrack
        && (
          track.riskTrack === 'refund'
          || String(row?.metadata?.disputeId || '') === String(track.disputeId || '')
        )
      ));
      const priorTrackMinor = trackRows.reduce(
        (sum, row) => sum + liabilityAmounts(row).liabilityMinor,
        0,
      );
      const deltaMinor = track.buyerTargetMinor - priorTrackMinor;
      if (!deltaMinor) continue;

      if (deltaMinor < 0) {
        await reduceBuyerRiskTrack({
          source,
          wallet,
          track,
          targetMinor: track.buyerTargetMinor,
          currentMinor: priorTrackMinor,
          paymentIntentId,
          chargeId,
          eventId,
          eventType,
          session,
        });
        created += 1;
        continue;
      }

      const completedDispute = track.riskTrack === 'dispute' && (
        (track.disputeId === disputeId && disputeResolution === 'lost')
        || trackRows.some(row => row.status === 'completed')
      );
      const liabilityState = track.riskTrack === 'refund' || completedDispute
        ? 'terminal'
        : 'provisional';
      const idempotencyKey = `wallet-risk:wallet_top_up:${eventId}:${track.trackKey}`;
      const existingEvent = await WalletTransaction.findOne({ idempotencyKey }).session(session);
      if (existingEvent) continue;
      const collection = await consumeBuyerTopUpFunding({
        source,
        wallet,
        currency: source.currency,
        liabilityMinor: deltaMinor,
        session,
      });
      const authoritativeWallet = await Wallet.findById(wallet._id).session(session);
      const reason = track.riskTrack === 'dispute'
        ? `Stripe reported a card dispute for ${sourceLabel}. Reconciliation is required.`
        : `Stripe reported a refund for ${sourceLabel}. Reconciliation is required.`;
      [review] = await WalletTransaction.create([{
        user: source.user,
        wallet: wallet._id,
        type: 'reversal',
        direction: 'debit',
        status: liabilityState === 'terminal' ? 'completed' : 'pending',
        amount: fromMinorUnits(deltaMinor),
        currency: source.currency,
        balanceAfter: readStoredWalletBalance(authoritativeWallet, source.currency),
        description: reason,
        referenceType: track.riskTrack === 'refund' ? 'stripe_refund' : 'stripe_dispute',
        referenceId: `${eventId}:${track.trackKey}`,
        idempotencyKey,
        stripeChargeId: chargeId,
        stripeCustomerId: source.stripeCustomerId || null,
        stripeMode: source.stripeMode || null,
        metadata: {
          sourcePaymentTransactionId: String(source._id),
          sourceTopUpTransactionId: String(source._id),
          sourceType: 'wallet_top_up',
          riskTrack: track.riskTrack,
          riskTrackKey: track.trackKey,
          stripeEventType: eventType,
          stripeEventId: eventId,
          stripePaymentIntentId: paymentIntentId,
          chargeAmountMinor,
          combinedExposureMinor,
          refundExposureMinor: effectiveRefundExposure,
          liabilityState,
          liabilityMinor: deltaMinor,
          heldMinor: liabilityState === 'provisional' ? collection.consumedMinor : 0,
          collectedMinor: liabilityState === 'terminal' ? collection.consumedMinor : 0,
          outstandingMinor: collection.outstandingMinor,
          writtenOffMinor: 0,
          ...(track.riskTrack === 'dispute' ? {
            disputeId: track.disputeId || 'unknown',
            disputeExposureMinor: track.exposureMinor,
            disputeStatus,
          } : {}),
        },
        completedAt: liabilityState === 'terminal' ? new Date() : null,
      }], { session });
      activeRows.push(review.toObject());
      created += 1;
    }

    const sellerResults = [];
    let sellerLedger = null;
    if (fundingSnapshot.sellerPrincipalMinor > 0) {
      const refundTrack = tracks.find(track => track.trackKey === 'refund');
      if (refundTrack || effectiveRefundExposure > 0) {
        sellerResults.push(await applySellerStripeRiskLedger({
          session,
          sourceType: 'wallet_top_up',
          sourceReferenceId: source._id,
          orderLabel: `Wallet-funded commerce from top-up ${source._id}`,
          sellerEntitlements: fundingSnapshot.sellers,
          sourceCurrency: source.currency,
          rates: null,
          paymentIntentId,
          chargeId,
          eventId,
          eventType: 'charge.refunded',
          chargeAmountMinor: fundingSnapshot.sellerPrincipalMinor,
          refundExposureMinor: refundTrack?.sellerTargetMinor ?? 0,
          directTrackTargets: true,
          directSellerTargets: refundTrack?.sellerSourceTargets || new Map(),
          directSellerUsdTargets: refundTrack?.sellerUsdTargets || new Map(),
        }));
      }
      for (const track of tracks.filter(entry => entry.riskTrack === 'dispute')) {
        sellerResults.push(await applySellerStripeRiskLedger({
          session,
          sourceType: 'wallet_top_up',
          sourceReferenceId: source._id,
          orderLabel: `Wallet-funded commerce from top-up ${source._id}`,
          sellerEntitlements: fundingSnapshot.sellers,
          sourceCurrency: source.currency,
          rates: null,
          paymentIntentId,
          chargeId,
          eventId,
          eventType: 'charge.dispute.funds_withdrawn',
          chargeAmountMinor: fundingSnapshot.sellerPrincipalMinor,
          refundExposureMinor: 0,
          disputeId: track.disputeId,
          disputeExposureMinor: track.sellerTargetMinor,
          disputeStatus: track.disputeId === disputeId ? disputeStatus : 'under_review',
          disputeTransitionOverride: track.disputeId === disputeId ? disputeTransition : null,
          directTrackTargets: true,
          directSellerTargets: track.sellerSourceTargets,
          directSellerUsdTargets: track.sellerUsdTargets,
        }));
      }
      // A won dispute is absent from active targets, but its reserved seller
      // rows still need the exact terminal transition before other tracks are
      // rebalanced.
      if (disputeResolution === 'won' && !tracks.some(track => track.disputeId === disputeId)) {
        sellerResults.push(await applySellerStripeRiskLedger({
          session,
          sourceType: 'wallet_top_up',
          sourceReferenceId: source._id,
          orderLabel: `Wallet-funded commerce from top-up ${source._id}`,
          sellerEntitlements: fundingSnapshot.sellers,
          sourceCurrency: source.currency,
          rates: null,
          paymentIntentId,
          chargeId,
          eventId,
          eventType,
          chargeAmountMinor: fundingSnapshot.sellerPrincipalMinor,
          refundExposureMinor: 0,
          disputeId,
          disputeExposureMinor: 0,
          disputeStatus,
          disputeTransitionOverride: disputeTransition,
          directTrackTargets: true,
          directSellerTargets: new Map(),
          directSellerUsdTargets: new Map(),
        }));
      }
      sellerLedger = sellerResults;
    }
    const riskNotifications = await reconcileWalletRiskNotifications({
      session,
      source,
      fundingSnapshot,
      payload,
      effectiveRefundExposureMinor: effectiveRefundExposure,
      previousRefundExposureMinor,
      priorRefundBuyerMinor,
      priorDisputeBuyerMinor,
      tracks,
      sellerResults,
      disputeTransition,
    });
    const refreshed = await refreshWalletPaymentRiskStatus(wallet._id, session);
    return {
      review,
      handled: true,
      created,
      wallet: refreshed.wallet,
      paymentRisk: refreshed.summary,
      sellerLedger,
      sellerIds: fundingSnapshot.sellers.map(entry => entry.seller),
      riskNotifications,
      holdCoverage: {
        refund: effectiveRefundExposure,
        dispute: disputeExposures.get(String(disputeId || '')) ?? 0,
      },
    };
  });

  if (refundExposureMinor > 0) {
    await resolveSellerPaymentRiskHolds({
      holds: preliminaryHolds,
      sourceType: 'wallet_top_up',
      sourceReferenceId: identified.transaction._id,
      paymentIntentId,
      chargeId,
      riskTrack: 'refund',
      coveredExposureMinor: result?.holdCoverage?.refund ?? refundExposureMinor,
      resolutionEventId: eventId,
    });
  }
  if (eventType.startsWith('charge.dispute.')) {
    await resolveSellerPaymentRiskHolds({
      holds: preliminaryHolds,
      sourceType: 'wallet_top_up',
      sourceReferenceId: identified.transaction._id,
      paymentIntentId,
      chargeId,
      riskTrack: 'dispute',
      disputeId,
      coveredExposureMinor: result?.holdCoverage?.dispute ?? disputeExposureMinor,
      resolutionEventId: eventId,
    });
  }
  return result;
};

const flagWalletTopUpPaymentRisk = async ({ charge, eventId, eventType }) => (
  flagWalletCreditPaymentRisk({
    paymentIntentId: paymentIntentIdOf(charge),
    sourceType: 'wallet_top_up',
    chargeId: charge?.id,
    eventId,
    eventType,
    chargeAmountMinor: charge?.amount,
    refundExposureMinor: charge?.amount_refunded ?? 0,
    disputeId: charge?.disputeId || null,
    disputeExposureMinor: charge?.disputeAmount ?? 0,
    disputeStatus: charge?.disputeStatus || '',
    currency: charge?.currency,
  })
);

module.exports = {
  paymentIntentIdOf,
  resolveWalletPaymentRiskSource,
  flagWalletCreditPaymentRisk,
  flagWalletTopUpPaymentRisk,
};
