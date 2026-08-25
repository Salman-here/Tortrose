'use strict';

const mongoose = require('mongoose');
const StripePaymentRiskState = require('../models/StripePaymentRiskState');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const { fromMinorUnits, toMinorUnits } = require('./moneyMath');
const {
  projectStoredWalletBalanceMinor,
  requireStoredWalletCurrency,
  readStoredWalletBalance,
  readStoredWalletBalanceMinor,
} = require('./walletStoredMoneyService');

const balancePath = currency => `balances.${currency}`;
const balanceMinorExpression = path => ({
  $round: [{ $multiply: [{ $ifNull: [`$${path}`, 0] }, 100] }, 0],
});
const changeBalance = (path, deltaMinor) => ([{
  $set: {
    [path]: {
      $divide: [{ $add: [balanceMinorExpression(path), deltaMinor] }, 100],
    },
  },
}]);

const liabilityScope = (walletId, currency = null) => ({
  wallet: walletId,
  type: 'reversal',
  direction: 'debit',
  status: { $in: ['pending', 'completed'] },
  'metadata.sourceType': 'wallet_top_up',
  ...(currency ? { currency } : {}),
});

const legacyLiabilityCandidateScope = (walletId, currency = null) => ({
  wallet: walletId,
  type: 'reversal',
  direction: 'debit',
  status: { $in: ['pending', 'completed'] },
  referenceType: { $in: ['stripe_refund', 'stripe_dispute'] },
  idempotencyKey: /^wallet-risk:/,
  $or: [
    { 'metadata.sourceType': { $exists: false } },
    { 'metadata.sourceType': null },
  ],
  'metadata.sourceTopUpTransactionId': { $type: 'string' },
  'metadata.stripeEventId': { $type: 'string' },
  'metadata.stripeEventType': { $type: 'string' },
  ...(currency ? { currency } : {}),
});

const isPaymentRiskLockReason = reason => (
  /^Stripe payment-risk liability/.test(String(reason || ''))
  || /^Stripe dispute funds are held/.test(String(reason || ''))
  || /^Stripe reported a (refund|card dispute)/.test(String(reason || ''))
  || /^Wallet payment-risk legacy ledger quarantine/.test(String(reason || ''))
);

const isWalletPaymentRiskLock = wallet => Boolean(
  wallet?.status === 'locked'
  && isPaymentRiskLockReason(wallet.lockedReason)
  && (!wallet.lockSource || wallet.lockSource === 'payment_risk')
);

const liabilityLedgerError = (row, message) => {
  const error = new Error(`Wallet payment-risk liability ${message}.`);
  error.code = 'WALLET_PAYMENT_RISK_LEDGER_INVALID';
  error.statusCode = 409;
  error.walletTransactionId = row?._id ? String(row._id) : null;
  return error;
};

const requireLiabilityMinor = (row, field, { positive = false } = {}) => {
  const value = row?.metadata?.[field];
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || (positive && value <= 0)
  ) {
    throw liabilityLedgerError(row, `has an invalid ${field}`);
  }
  try {
    fromMinorUnits(value);
  } catch (_error) {
    throw liabilityLedgerError(row, `has an out-of-range ${field}`);
  }
  return value;
};

const addLiabilityMinor = (row, left, right) => {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw liabilityLedgerError(row, 'exceeds the supported accounting range');
  }
  try {
    fromMinorUnits(total);
  } catch (_error) {
    throw liabilityLedgerError(row, 'exceeds reversible minor-unit storage');
  }
  return total;
};

const requireOperationMinor = (value, field, { positive = false } = {}) => {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || (positive && value <= 0)
  ) {
    throw liabilityLedgerError(null, `received an invalid ${field}`);
  }
  try {
    fromMinorUnits(value);
  } catch (_error) {
    throw liabilityLedgerError(null, `received an out-of-range ${field}`);
  }
  return value;
};

const liabilityAmounts = row => {
  // Mixed metadata bypasses Mongoose Number casting. Treat these durable
  // counters as a ledger, not optional presentation hints: a boolean/string
  // must never turn an outstanding liability into zero and unlock a Wallet.
  const liabilityMinor = requireLiabilityMinor(row, 'liabilityMinor', { positive: true });
  const heldMinor = requireLiabilityMinor(row, 'heldMinor');
  const collectedMinor = requireLiabilityMinor(row, 'collectedMinor');
  const writtenOffMinor = requireLiabilityMinor(row, 'writtenOffMinor');
  const outstandingMinor = requireLiabilityMinor(row, 'outstandingMinor');
  const accountedMinor = [heldMinor, collectedMinor, writtenOffMinor, outstandingMinor]
    .reduce((sum, value) => addLiabilityMinor(row, sum, value), 0);
  if (accountedMinor !== liabilityMinor) {
    throw liabilityLedgerError(row, 'does not reconcile to its original amount');
  }
  return { liabilityMinor, heldMinor, collectedMinor, writtenOffMinor, outstandingMinor };
};

const runLiabilityTransaction = async work => {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => { result = await work(session); }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const getWalletPaymentRiskSummary = async (walletId, { session = null } = {}) => {
  if (!session) {
    // Legacy classification can create/collect a liability during what used to
    // be a read. Commit the corresponding Wallet lock in the same transaction,
    // otherwise callers can observe `restricted: true` while the Wallet remains
    // spendable until some unrelated later credit refreshes it.
    return runLiabilityTransaction(async transactionSession => (
      (await refreshWalletPaymentRiskStatus(walletId, transactionSession)).summary
    ));
  }
  await classifyLegacyWalletPaymentLiabilities({ walletId, session });
  let query = WalletTransaction.find(liabilityScope(walletId)).sort({ createdAt: 1, _id: 1 });
  if (session) query = query.session(session);
  const rows = await query.lean();
  const byCurrency = {};
  let provisionalCount = 0;
  for (const row of rows) {
    requireStoredWalletCurrency(row.currency);
    const amounts = liabilityAmounts(row);
    const currency = row.currency;
    if (!byCurrency[currency]) {
      byCurrency[currency] = {
        heldMinor: 0,
        outstandingMinor: 0,
        held: 0,
        outstanding: 0,
      };
    }
    if (row?.metadata?.liabilityState === 'provisional') {
      provisionalCount += 1;
      byCurrency[currency].heldMinor = addLiabilityMinor(
        row,
        byCurrency[currency].heldMinor,
        amounts.heldMinor,
      );
    }
    byCurrency[currency].outstandingMinor = addLiabilityMinor(
      row,
      byCurrency[currency].outstandingMinor,
      amounts.outstandingMinor,
    );
  }
  for (const values of Object.values(byCurrency)) {
    values.held = fromMinorUnits(values.heldMinor);
    values.outstanding = fromMinorUnits(values.outstandingMinor);
  }
  const outstandingMinor = Object.values(byCurrency)
    .reduce((sum, values) => addLiabilityMinor(null, sum, values.outstandingMinor), 0);
  const heldMinor = Object.values(byCurrency)
    .reduce((sum, values) => addLiabilityMinor(null, sum, values.heldMinor), 0);
  const quarantinedLegacyCount = await WalletTransaction.countDocuments(
    legacyLiabilityCandidateScope(walletId),
  ).session(session);
  return {
    restricted: provisionalCount > 0 || outstandingMinor > 0 || quarantinedLegacyCount > 0,
    provisionalCount,
    quarantinedLegacyCount,
    outstandingMinor,
    heldMinor,
    byCurrency,
  };
};

const refreshWalletPaymentRiskStatus = async (walletId, session) => {
  const summary = await getWalletPaymentRiskSummary(walletId, { session });
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) return { wallet: null, summary };
  if (summary.restricted) {
    const riskReason = summary.quarantinedLegacyCount > 0
      ? 'Wallet payment-risk legacy ledger quarantine requires manual reconciliation.'
      : summary.outstandingMinor > 0
      ? 'Stripe payment-risk liability is outstanding. New credits will settle it before becoming available.'
      : 'Stripe dispute funds are held until the card dispute is resolved.';
    // Payment risk composes with operational/manual locks. Never replace a
    // pre-existing fraud/admin reason, otherwise resolving the Stripe event
    // could later reactivate a Wallet that an independent control still locks.
    if (wallet.status === 'active' || isWalletPaymentRiskLock(wallet)) {
      wallet.status = 'locked';
      wallet.lockedReason = riskReason;
      wallet.lockSource = 'payment_risk';
    }
  } else if (
    isWalletPaymentRiskLock(wallet)
  ) {
    wallet.status = 'active';
    wallet.lockedReason = '';
    wallet.lockSource = null;
  }
  await wallet.save({ session });
  return { wallet, summary };
};

const consumeWalletBalanceForLiability = async ({ walletId, currency, liabilityMinor, session }) => {
  requireStoredWalletCurrency(currency);
  requireOperationMinor(liabilityMinor, 'liability amount', { positive: true });
  const wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) throw new Error('Wallet not found while applying payment-risk liability.');
  const availableMinor = readStoredWalletBalanceMinor(wallet, currency);
  const consumedMinor = Math.min(availableMinor, liabilityMinor);
  if (consumedMinor > 0) {
    await Wallet.findByIdAndUpdate(
      walletId,
      changeBalance(balancePath(currency), -consumedMinor),
      { new: true, session },
    );
  }
  return {
    consumedMinor,
    outstandingMinor: liabilityMinor - consumedMinor,
  };
};

const classifyLegacyWalletPaymentLiabilities = async ({
  walletId,
  currency = null,
  session,
  disputeHint = null,
  sourceTransactionId = null,
}) => {
  const candidates = await WalletTransaction.find(
    legacyLiabilityCandidateScope(walletId, currency),
  ).sort({ createdAt: 1, _id: 1 }).session(session);
  let classified = 0;
  let superseded = 0;
  for (const row of candidates) {
    requireStoredWalletCurrency(row.currency);
    const persistedRow = await WalletTransaction.collection.findOne(
      { _id: row._id },
      { session },
    );
    if (!persistedRow) continue;
    const sourceId = String(persistedRow.metadata?.sourceTopUpTransactionId || '').trim();
    const eventId = String(persistedRow.metadata?.stripeEventId || '').trim();
    const eventType = String(persistedRow.metadata?.stripeEventType || '').trim();
    if (
      !mongoose.isValidObjectId(sourceId)
      || !eventId
      || row.referenceId !== eventId
      || row.idempotencyKey !== `wallet-risk:${eventId}`
    ) continue;
    const source = await WalletTransaction.findOne({
      _id: sourceId,
      wallet: walletId,
      user: row.user,
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      currency: row.currency,
    }).session(session);
    if (!source) continue;
    const persistedSource = await WalletTransaction.collection.findOne(
      { _id: source._id },
      { session },
    );
    if (!persistedSource) continue;
    const paymentIntentId = String(source.stripePaymentIntentId || '').trim();
    const chargeId = String(row.stripeChargeId || '').trim();
    if (
      !paymentIntentId
      || !chargeId
      || String(source.stripeChargeId || '').trim() !== chargeId
    ) continue;
    const isRefund = row.referenceType === 'stripe_refund' && eventType === 'charge.refunded';
    const isDispute = row.referenceType === 'stripe_dispute' && eventType.startsWith('charge.dispute.');
    if (!isRefund && !isDispute) continue;
    const liabilityMinor = persistedRow.metadata?.amountMinor;
    const sourceMinor = typeof persistedSource.amount === 'number' && Number.isFinite(persistedSource.amount)
      ? toMinorUnits(persistedSource.amount)
      : null;
    if (
      !Number.isSafeInteger(liabilityMinor) || liabilityMinor <= 0
      || !Number.isSafeInteger(sourceMinor) || sourceMinor <= 0
      || fromMinorUnits(sourceMinor) !== persistedSource.amount
      || liabilityMinor > sourceMinor
      || typeof persistedRow.amount !== 'number' || !Number.isFinite(persistedRow.amount)
      || fromMinorUnits(liabilityMinor) !== persistedRow.amount
      || toMinorUnits(persistedRow.amount) !== liabilityMinor
    ) continue;

    const normalizedReplay = await WalletTransaction.findOne({
      _id: { $ne: row._id },
      wallet: walletId,
      type: 'reversal',
      direction: 'debit',
      'metadata.sourceType': 'wallet_top_up',
      'metadata.sourcePaymentTransactionId': sourceId,
      'metadata.stripeEventId': eventId,
      'metadata.riskTrack': isRefund ? 'refund' : 'dispute',
    }).session(session);
    if (normalizedReplay) {
      row.status = 'reversed';
      row.metadata = {
        ...(row.metadata || {}),
        sourceType: 'wallet_top_up',
        sourcePaymentTransactionId: sourceId,
        stripePaymentIntentId: paymentIntentId,
        legacyLiabilityClassified: true,
        legacyLiabilitySupersededBy: String(normalizedReplay._id),
        liabilityState: 'superseded',
        liabilityMinor: 0,
        heldMinor: 0,
        collectedMinor: 0,
        outstandingMinor: 0,
        writtenOffMinor: 0,
      };
      row.markModified('metadata');
      await row.save({ session });
      superseded += 1;
      continue;
    }

    let liabilityState = isRefund ? 'terminal' : 'provisional';
    let disputeId = null;
    let disputeResolution = null;
    let requiresManualDisputeIdentity = false;
    if (isDispute) {
      const durableStates = await StripePaymentRiskState.find({
        sourceType: 'wallet_top_up',
        sourceReferenceId: sourceId,
        paymentIntentId,
        chargeId,
      }).session(session).lean();
      let state = durableStates.length === 1 ? durableStates[0] : null;
      const sourceDisputeCandidates = candidates.filter(candidate => (
        candidate.referenceType === 'stripe_dispute'
        && String(candidate.metadata?.sourceTopUpTransactionId || '') === sourceId
        && String(candidate.stripeChargeId || '') === chargeId
      ));
      if (
        !state
        && sourceDisputeCandidates.length === 1
        && disputeHint
        && String(disputeHint.disputeId || '').trim()
      ) {
        state = {
          disputeId: String(disputeHint.disputeId),
          status: disputeHint.status,
          terminal: ['won', 'lost'].includes(disputeHint.status),
        };
      }
      disputeId = String(state?.disputeId || `legacy-unresolved:${row._id}`);
      if (state?.terminal && state.status === 'won') {
        disputeResolution = 'won';
        liabilityState = 'resolved';
      } else if (state?.terminal && state.status === 'lost') {
        disputeResolution = 'lost';
        liabilityState = 'terminal';
      } else if (!state) {
        requiresManualDisputeIdentity = true;
      }
    }

    let collection = { consumedMinor: 0, outstandingMinor: liabilityMinor };
    if (liabilityState !== 'resolved') {
      collection = await consumeWalletBalanceForLiability({
        walletId,
        currency: row.currency,
        liabilityMinor,
        session,
      });
    }
    const authoritativeWallet = await Wallet.findById(walletId).session(session);
    row.status = liabilityState === 'resolved'
      ? 'reversed'
      : (liabilityState === 'terminal' ? 'completed' : 'pending');
    row.completedAt = liabilityState === 'terminal' ? new Date() : row.completedAt;
    row.balanceAfter = readStoredWalletBalance(authoritativeWallet, row.currency);
    row.metadata = {
      ...(row.metadata || {}),
      sourceType: 'wallet_top_up',
      sourcePaymentTransactionId: sourceId,
      sourceTopUpTransactionId: sourceId,
      stripePaymentIntentId: paymentIntentId,
      legacyLiabilityClassified: true,
      liabilityState,
      liabilityMinor: liabilityState === 'resolved' ? 0 : liabilityMinor,
      heldMinor: liabilityState === 'provisional' ? collection.consumedMinor : 0,
      collectedMinor: liabilityState === 'terminal' ? collection.consumedMinor : 0,
      outstandingMinor: liabilityState === 'resolved' ? 0 : collection.outstandingMinor,
      writtenOffMinor: 0,
      riskTrack: isRefund ? 'refund' : 'dispute',
      riskTrackKey: isRefund ? 'refund' : `dispute:${disputeId}`,
      chargeAmountMinor: sourceMinor,
      ...(isRefund ? { refundExposureMinor: liabilityMinor } : {
        disputeId,
        disputeExposureMinor: liabilityMinor,
        disputeResolution,
        requiresManualDisputeIdentity,
      }),
    };
    row.markModified('metadata');
    await row.save({ session });
    classified += 1;
  }
  let reboundDisputeIdentity = 0;
  const hintedDisputeId = String(disputeHint?.disputeId || '').trim();
  const hintedSourceId = String(sourceTransactionId || '').trim();
  if (hintedDisputeId && hintedSourceId) {
    // Old rows did not store Stripe's dispute ID. If a signed later webhook
    // supplies it, bind only when there is exactly one already-quarantined row
    // for this immutable top-up/charge scope; multiple rows remain manual.
    const unresolvedRows = await WalletTransaction.find({
      ...liabilityScope(walletId, currency),
      'metadata.sourcePaymentTransactionId': hintedSourceId,
      'metadata.riskTrack': 'dispute',
      'metadata.requiresManualDisputeIdentity': true,
      'metadata.disputeId': /^legacy-unresolved:/,
    }).sort({ createdAt: 1, _id: 1 }).session(session);
    if (unresolvedRows.length === 1) {
      const row = unresolvedRows[0];
      row.metadata = {
        ...(row.metadata || {}),
        disputeId: hintedDisputeId,
        riskTrackKey: `dispute:${hintedDisputeId}`,
        requiresManualDisputeIdentity: false,
        legacyDisputeIdentityBoundAt: new Date(),
      };
      row.markModified('metadata');
      await row.save({ session });
      reboundDisputeIdentity = 1;
    }
  }
  return { classified, superseded, reboundDisputeIdentity };
};

/** Apply a real incoming credit FIFO: terminal debt is collected, while an
 * unresolved dispute moves the credit into held funds. Only the remainder is
 * added to the buyer's available Wallet balance. */
const applyIncomingWalletCredit = async ({ walletId, currency, creditMinor, session }) => {
  requireStoredWalletCurrency(currency);
  requireOperationMinor(creditMinor, 'incoming credit', { positive: true });
  await classifyLegacyWalletPaymentLiabilities({ walletId, currency, session });
  let remainingMinor = creditMinor;
  let appliedMinor = 0;
  const rows = await WalletTransaction.find({
    ...liabilityScope(walletId, currency),
  }).sort({ createdAt: 1, _id: 1 }).session(session);

  for (const row of rows) {
    if (remainingMinor <= 0) break;
    const amounts = liabilityAmounts(row);
    if (amounts.outstandingMinor <= 0) continue;
    const applied = Math.min(remainingMinor, amounts.outstandingMinor);
    if (!applied) continue;
    const provisional = row.metadata?.liabilityState === 'provisional';
    row.metadata = {
      ...(row.metadata || {}),
      liabilityMinor: amounts.liabilityMinor,
      outstandingMinor: amounts.outstandingMinor - applied,
      heldMinor: amounts.heldMinor + (provisional ? applied : 0),
      collectedMinor: amounts.collectedMinor + (provisional ? 0 : applied),
      writtenOffMinor: amounts.writtenOffMinor,
      lastCreditAppliedAt: new Date(),
    };
    await row.save({ session });
    remainingMinor -= applied;
    appliedMinor += applied;
  }

  let wallet = await Wallet.findById(walletId).session(session);
  if (!wallet) throw new Error('Wallet not found while applying a credit.');
  if (remainingMinor > 0) {
    // Distinguish a legitimate missing legacy bucket from a present corrupt
    // value before the aggregation pipeline's `$ifNull` can touch it, and
    // prove the resulting major-unit Number can still preserve every cent.
    projectStoredWalletBalanceMinor(wallet, currency, remainingMinor);
    wallet = await Wallet.findByIdAndUpdate(
      walletId,
      changeBalance(balancePath(currency), remainingMinor),
      { new: true, session },
    );
  }
  const refreshed = await refreshWalletPaymentRiskStatus(walletId, session);
  return {
    wallet: refreshed.wallet || wallet,
    appliedMinor,
    creditedMinor: remainingMinor,
    remainingLiabilityMinor: refreshed.summary.byCurrency[currency]?.outstandingMinor ?? 0,
    riskSummary: refreshed.summary,
  };
};

const resolveWonWalletDispute = async ({
  walletId,
  sourceTransactionId,
  disputeId,
  currency,
  eventId,
  session,
}) => {
  await classifyLegacyWalletPaymentLiabilities({
    walletId,
    currency,
    session,
    disputeHint: { disputeId, status: 'won' },
    sourceTransactionId,
  });
  const rows = await WalletTransaction.find({
    ...liabilityScope(walletId, currency),
    status: 'pending',
    'metadata.sourcePaymentTransactionId': String(sourceTransactionId),
    'metadata.riskTrack': 'dispute',
    'metadata.disputeId': disputeId,
  }).sort({ createdAt: 1, _id: 1 }).session(session);
  let releasedMinor = 0;
  for (const row of rows) {
    const amounts = liabilityAmounts(row);
    releasedMinor = addLiabilityMinor(row, releasedMinor, amounts.heldMinor);
    row.status = 'reversed';
    row.metadata = {
      ...(row.metadata || {}),
      liabilityMinor: 0,
      liabilityState: 'resolved',
      heldMinor: 0,
      collectedMinor: 0,
      writtenOffMinor: 0,
      outstandingMinor: 0,
      disputeResolution: 'won',
      resolutionEventId: eventId,
    };
    await row.save({ session });
  }
  if (releasedMinor > 0) {
    const result = await applyIncomingWalletCredit({
      walletId,
      currency,
      creditMinor: releasedMinor,
      session,
    });
    return { ...result, releasedMinor };
  }
  return { ...(await refreshWalletPaymentRiskStatus(walletId, session)), releasedMinor: 0, creditedMinor: 0 };
};

const finalizeLostWalletDispute = async ({
  walletId,
  sourceTransactionId,
  disputeId,
  currency,
  eventId,
  session,
}) => {
  await classifyLegacyWalletPaymentLiabilities({
    walletId,
    currency,
    session,
    disputeHint: { disputeId, status: 'lost' },
    sourceTransactionId,
  });
  const rows = await WalletTransaction.find({
    ...liabilityScope(walletId, currency),
    status: 'pending',
    'metadata.sourcePaymentTransactionId': String(sourceTransactionId),
    'metadata.riskTrack': 'dispute',
    'metadata.disputeId': disputeId,
  }).session(session);
  for (const row of rows) {
    const amounts = liabilityAmounts(row);
    row.status = 'completed';
    row.completedAt = new Date();
    row.metadata = {
      ...(row.metadata || {}),
      liabilityState: 'terminal',
      heldMinor: 0,
      collectedMinor: amounts.collectedMinor + amounts.heldMinor,
      outstandingMinor: amounts.outstandingMinor,
      disputeResolution: 'lost',
      resolutionEventId: eventId,
    };
    await row.save({ session });
  }
  return refreshWalletPaymentRiskStatus(walletId, session);
};

const applyAdminWalletLiabilityResolution = async ({
  walletId,
  currency,
  amountMinor,
  action,
  session,
}) => {
  requireStoredWalletCurrency(currency);
  requireOperationMinor(amountMinor, 'admin resolution amount', { positive: true });
  await classifyLegacyWalletPaymentLiabilities({ walletId, currency, session });
  const rows = await WalletTransaction.find({
    ...liabilityScope(walletId, currency),
    'metadata.liabilityState': 'terminal',
  }).sort({ createdAt: 1, _id: 1 }).session(session);
  const availableMinor = rows.reduce(
    (sum, row) => addLiabilityMinor(row, sum, liabilityAmounts(row).outstandingMinor),
    0,
  );
  if (amountMinor > availableMinor) {
    const error = new Error('The reconciliation amount exceeds the terminal Wallet liability.');
    error.statusCode = 400;
    error.code = 'WALLET_LIABILITY_AMOUNT_EXCEEDED';
    error.outstandingAmount = fromMinorUnits(availableMinor);
    error.currency = currency;
    throw error;
  }
  let remaining = amountMinor;
  for (const row of rows) {
    if (remaining <= 0) break;
    const amounts = liabilityAmounts(row);
    const applied = Math.min(remaining, amounts.outstandingMinor);
    row.metadata = {
      ...(row.metadata || {}),
      outstandingMinor: amounts.outstandingMinor - applied,
      collectedMinor: amounts.collectedMinor + (action === 'external_collection' ? applied : 0),
      writtenOffMinor: amounts.writtenOffMinor + (action === 'write_off' ? applied : 0),
      lastAdminResolutionAt: new Date(),
    };
    await row.save({ session });
    remaining -= applied;
  }
  const refreshed = await refreshWalletPaymentRiskStatus(walletId, session);
  return { appliedMinor: amountMinor, ...refreshed };
};

module.exports = {
  isPaymentRiskLockReason,
  isWalletPaymentRiskLock,
  liabilityAmounts,
  getWalletPaymentRiskSummary,
  refreshWalletPaymentRiskStatus,
  consumeWalletBalanceForLiability,
  classifyLegacyWalletPaymentLiabilities,
  applyIncomingWalletCredit,
  resolveWonWalletDispute,
  finalizeLostWalletDispute,
  applyAdminWalletLiabilityResolution,
};
