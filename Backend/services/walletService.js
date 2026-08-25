'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const Order = require('../models/Order');
const Product = require('../models/Product');
const ReturnRequest = require('../models/ReturnRequest');
const { formatMoneySync } = require('./currencyService');
const { stripe, STRIPE_MODE } = require('../config/stripe');
const { fromMinorUnits, roundMoney, toMinorUnits } = require('./moneyMath');
const { consumeOrderCoupons } = require('./couponUsageService');
const {
  buildCustomerInitiatedPaymentIntentParams,
  isAuthoritativeStripeIdempotentReplayRejection,
} = require('./stripePaymentIntentFactory');
const {
  applyAdminWalletLiabilityResolution,
  applyIncomingWalletCredit,
  getWalletPaymentRiskSummary,
  isWalletPaymentRiskLock,
} = require('./walletPaymentLiabilityService');
const {
  claimStripePaymentCompletion,
  markStripePaymentCompletionDone,
  markerError,
} = require('./stripePaymentRiskMarkerService');
const {
  allocateHouseMonotoneMinorUnits,
} = require('./moneyMath');
const {
  attachReturnedWalletFundingProvenance,
} = require('./walletOrderFundingRiskService');
const {
  ensureOrderSellerSettlement,
  getAccountingOrderCurrency,
  sellerSettlementUsdTargetForSource,
} = require('./orderMoneyService');
const {
  enqueuePaidOrderBuyerNotifications,
  enqueuePaidOrderSellerNotifications,
  enqueueWalletTransactionNotification,
} = require('./financialNotificationOutboxService');
const { resolveOrderReference } = require('./orderReferenceService');
const {
  WALLET_CURRENCIES,
  requireStoredWalletCurrency,
  readStoredWalletBalance,
} = require('./walletStoredMoneyService');

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const walletPaymentError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const normalizeWalletMoneyInput = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw walletPaymentError(`${label} must be a finite numeric amount.`, 'WALLET_MONEY_INVALID');
  }
  try {
    return roundMoney(value);
  } catch (_error) {
    throw walletPaymentError(`${label} is outside the supported money range.`, 'WALLET_MONEY_INVALID');
  }
};

const readStoredTransactionMoney = (transaction, field, { nullable = false, positive = false } = {}) => {
  const value = transaction?.[field];
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw walletPaymentError(
      `Stored Wallet transaction money is invalid at ${field}.`,
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  let normalized;
  try {
    normalized = roundMoney(value);
  } catch (_error) {
    throw walletPaymentError(
      `Stored Wallet transaction money is invalid at ${field}.`,
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  if (Math.abs(normalized - value) > 1e-9) {
    throw walletPaymentError(
      `Stored Wallet transaction money is invalid at ${field}.`,
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  if (positive && normalized <= 0) {
    throw walletPaymentError(
      `Stored Wallet transaction money is invalid at ${field}.`,
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  return normalized;
};

const readOptionalTransactionMinor = (transaction, field) => {
  const metadata = transaction?.metadata;
  if (metadata === undefined) return 0;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw walletPaymentError(
      'Stored Wallet transaction metadata is invalid.',
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, field) || metadata[field] === undefined) return 0;
  const value = metadata[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw walletPaymentError(
      `Stored Wallet transaction money is invalid at metadata.${field}.`,
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  try {
    fromMinorUnits(value);
  } catch (_error) {
    throw walletPaymentError(
      `Stored Wallet transaction money is invalid at metadata.${field}.`,
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  return value;
};

const balancePath = (currency) => `balances.${normalizeWalletCurrency(currency)}`;

// Wallet balances are stored as Numbers for backwards compatibility, but every
// mutation is performed as integer minor units inside MongoDB.  Normalizing the
// existing value to cents before adding the delta prevents binary floating-point
// residue from accumulating across repeated credits/debits while keeping the
// read/check/write operation atomic.
const balanceMinorUnitsExpression = (path) => ({
  $round: [
    {
      $multiply: [
        { $ifNull: [`$${path}`, 0] },
        100,
      ],
    },
    0,
  ],
});

const atomicBalanceUpdate = (path, deltaMinorUnits) => ([
  {
    $set: {
      [path]: {
        $divide: [
          { $add: [balanceMinorUnitsExpression(path), deltaMinorUnits] },
          100,
        ],
      },
    },
  },
]);

const hasSufficientBalanceExpression = (path, requiredMinorUnits) => ({
  $gte: [balanceMinorUnitsExpression(path), requiredMinorUnits],
});

const normalizeWalletCurrency = (value) => {
  const raw = value === null || value === undefined ? 'USD' : value;
  if (typeof raw !== 'string' || !raw.trim()) {
    const error = new Error('This currency is not supported by Rozare Wallet.');
    error.statusCode = 400;
    error.code = 'WALLET_CURRENCY_NOT_SUPPORTED';
    throw error;
  }
  const currency = raw.trim().toUpperCase();
  if (!WALLET_CURRENCIES.includes(currency)) {
    const error = new Error('This currency is not supported by Rozare Wallet.');
    error.statusCode = 400;
    error.code = 'WALLET_CURRENCY_NOT_SUPPORTED';
    throw error;
  }
  return currency;
};

const formatWalletMoney = (amount, currency) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  return formatMoneySync(roundMoney(amount), normalizedCurrency, {
    sourceCurrency: normalizedCurrency,
  });
};

const walletTopUpDescription = (amount, currency) =>
  `Rozare Wallet top-up of ${formatWalletMoney(amount, currency)}`;

const getWalletTransactionDescription = (transaction) => {
  if (transaction?.type === 'top_up') {
    return walletTopUpDescription(transaction.amount, transaction.currency);
  }
  return String(transaction?.description || '').trim();
};

const toStripeMinorUnits = (amount, currency) => {
  const normalized = normalizeWalletCurrency(currency);
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw walletPaymentError('Wallet money amount is invalid.', 'WALLET_MONEY_INVALID', 400);
  }
  return toMinorUnits(amount, ZERO_DECIMAL_CURRENCIES.has(normalized) ? 0 : 2);
};

const fromStripeMinorUnits = (amount, currency) => {
  const normalized = normalizeWalletCurrency(currency);
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
    throw walletPaymentError('Stripe minor-unit amount is invalid.', 'WALLET_MONEY_INVALID', 400);
  }
  return ZERO_DECIMAL_CURRENCIES.has(normalized)
    ? fromMinorUnits(amount, 0)
    : fromMinorUnits(amount, 2);
};

const runInTransaction = async (work, existingSession = null) => {
  if (existingSession) return work(existingSession);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const ensureWallet = async (userId, session = null) => Wallet.findOneAndUpdate(
  { user: userId },
  { $setOnInsert: { user: userId, status: 'active' } },
  { new: true, upsert: true, setDefaultsOnInsert: true, session }
);

const creditWalletInSession = async ({
  userId,
  amount,
  currency,
  type,
  referenceType,
  referenceId,
  idempotencyKey,
  description,
  metadata = {},
  allowLocked = false,
}, session) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  const normalizedAmount = normalizeWalletMoneyInput(amount, 'Wallet credit amount');
  const normalizedMinorUnits = toMinorUnits(normalizedAmount);
  if (normalizedAmount <= 0) {
    const error = new Error('Wallet credit amount must be greater than zero.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
  if (existing?.status === 'completed') return existing;
  if (existing) {
    const error = new Error('A wallet transaction with this reference is already pending.');
    error.statusCode = 409;
    error.code = 'WALLET_TRANSACTION_PENDING';
    throw error;
  }

  const wallet = await ensureWallet(userId, session);
  if (wallet.status !== 'active' && !allowLocked) {
    const error = new Error('Your Rozare Wallet is currently locked. Please contact support.');
    error.statusCode = 423;
    error.code = 'WALLET_LOCKED';
    throw error;
  }
  readStoredWalletBalance(wallet, normalizedCurrency);

  const creditResult = await applyIncomingWalletCredit({
    walletId: wallet._id,
    currency: normalizedCurrency,
    creditMinor: normalizedMinorUnits,
    session,
  });
  const updatedWallet = creditResult.wallet;

  const [transaction] = await WalletTransaction.create([{
    user: userId,
    wallet: wallet._id,
    type,
    direction: 'credit',
    status: 'completed',
    amount: normalizedAmount,
    currency: normalizedCurrency,
    balanceAfter: readStoredWalletBalance(updatedWallet, normalizedCurrency),
    description,
    referenceType,
    referenceId: String(referenceId),
    idempotencyKey,
    metadata: {
      ...metadata,
      liabilityAppliedMinor: creditResult.appliedMinor,
      availableCreditedMinor: creditResult.creditedMinor,
      remainingLiabilityMinor: creditResult.remainingLiabilityMinor,
    },
    completedAt: new Date(),
  }], { session });

  return transaction;
};

const debitWalletInSession = async ({
  userId,
  amount,
  currency,
  type,
  referenceType,
  referenceId,
  idempotencyKey,
  description,
  metadata = {},
}, session) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  const normalizedAmount = normalizeWalletMoneyInput(amount, 'Wallet debit amount');
  const normalizedMinorUnits = toMinorUnits(normalizedAmount);
  if (normalizedAmount <= 0) {
    const error = new Error('Wallet debit amount must be greater than zero.');
    error.statusCode = 400;
    throw error;
  }

  const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
  if (existing?.status === 'completed') return existing;
  if (existing) {
    const error = new Error('A wallet transaction with this reference is already pending.');
    error.statusCode = 409;
    error.code = 'WALLET_TRANSACTION_PENDING';
    throw error;
  }

  const wallet = await ensureWallet(userId, session);
  if (wallet.status !== 'active') {
    const error = new Error('Your Rozare Wallet is currently locked. Please contact support.');
    error.statusCode = 423;
    error.code = 'WALLET_LOCKED';
    throw error;
  }
  const availableBeforeDebit = readStoredWalletBalance(wallet, normalizedCurrency);

  await materializeLegacyWalletTopUpFunding({
    walletId: wallet._id,
    userId,
    currency: normalizedCurrency,
    session,
  });

  const path = balancePath(normalizedCurrency);
  const updatedWallet = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      status: 'active',
      $expr: hasSufficientBalanceExpression(path, normalizedMinorUnits),
    },
    atomicBalanceUpdate(path, -normalizedMinorUnits),
    { new: true, session }
  );

  if (!updatedWallet) {
    const available = availableBeforeDebit;
    const error = new Error(`Insufficient Rozare Wallet balance. Available: ${available} ${normalizedCurrency}.`);
    error.statusCode = 400;
    error.code = 'INSUFFICIENT_WALLET_BALANCE';
    error.availableBalance = available;
    error.currency = normalizedCurrency;
    throw error;
  }

  // Consume durable Stripe top-up lots before untracked/legacy Wallet funds.
  // The exact allocation is stored on the debit so a later card reversal can
  // pursue the seller revenue which received those cents instead of locking
  // only an already-empty buyer Wallet.
  let remainingFundingMinor = normalizedMinorUnits;
  const fundingProvenance = [];
  const topUpLots = await WalletTransaction.find({
    user: userId,
    wallet: wallet._id,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    currency: normalizedCurrency,
    // Include every non-zero BSON representation so corrupt strings/booleans
    // are inspected and quarantined instead of disappearing behind Mongo's
    // numeric type bracketing.
    'metadata.fundingRemainingMinor': { $exists: true, $ne: 0 },
  }).sort({ completedAt: 1, _id: 1 }).session(session);
  for (const topUp of topUpLots) {
    if (remainingFundingMinor <= 0) break;
    const availableMinor = topUp.metadata?.fundingRemainingMinor;
    if (typeof availableMinor !== 'number' || !Number.isSafeInteger(availableMinor) || availableMinor <= 0) {
      throw walletPaymentError(
        'Wallet top-up funding metadata is invalid.',
        'WALLET_FUNDING_PROVENANCE_INVALID',
        503,
      );
    }
    const consumedMinor = Math.min(remainingFundingMinor, availableMinor);
    const updated = await WalletTransaction.updateOne(
      {
        _id: topUp._id,
        status: 'completed',
        'metadata.fundingRemainingMinor': { $gte: consumedMinor },
      },
      { $inc: { 'metadata.fundingRemainingMinor': -consumedMinor } },
      { session },
    );
    if (updated.modifiedCount !== 1) {
      throw walletPaymentError(
        'Wallet funding provenance changed concurrently. Retry the payment.',
        'WALLET_FUNDING_PROVENANCE_CONFLICT',
        503,
      );
    }
    fundingProvenance.push({
      sourceType: 'wallet_top_up',
      sourceTransactionId: String(topUp._id),
      amountMinor: consumedMinor,
    });
    remainingFundingMinor -= consumedMinor;
  }

  const [transaction] = await WalletTransaction.create([{
    user: userId,
    wallet: wallet._id,
    type,
    direction: 'debit',
    status: 'completed',
    amount: normalizedAmount,
    currency: normalizedCurrency,
    balanceAfter: readStoredWalletBalance(updatedWallet, normalizedCurrency),
    description,
    referenceType,
    referenceId: String(referenceId),
    idempotencyKey,
    metadata: {
      ...metadata,
      ...(fundingProvenance.length ? { fundingProvenance } : {}),
      untrackedFundingMinor: remainingFundingMinor,
    },
    completedAt: new Date(),
  }], { session });

  return transaction;
};

/** Allocate all tracked funding for one order in one pass. Re-running a
 * largest-remainder allocation independently for every top-up lot can award
 * the same tie-breaking seller repeatedly. The transportation matrix below
 * conserves every lot row and the one-shot seller columns exactly. USD is a
 * cumulative frozen-target delta, so partial foreign-currency lots can never
 * duplicate a rounded USD cent. */
const allocateFundingProvenanceToSellerSettlement = ({
  fundingProvenance,
  settlementEntries,
  orderId,
}) => {
  const rows = (fundingProvenance || []).map((entry, index) => {
    const amountMinor = entry?.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw walletPaymentError(
        'Wallet funding provenance contains an invalid lot.',
        'WALLET_FUNDING_PROVENANCE_INVALID',
        500,
      );
    }
    return { entry, index, remainingMinor: amountMinor, allocations: [] };
  });
  if (!rows.length) return [];

  const sellers = (settlementEntries || []).map(entry => ({
    entry,
    seller: String(entry?.seller || ''),
    fullSourceAmountMinor: entry?.sourceAmountMinor,
    allocationCapacityMinor: entry?.allocationCapacityMinor ?? entry?.sourceAmountMinor,
    sourceOffsetMinor: entry?.allocationSourceOffsetMinor ?? 0,
  })).filter(entry => entry.seller && entry.fullSourceAmountMinor > 0)
    .sort((left, right) => left.seller.localeCompare(right.seller));
  if (sellers.some(seller => (
    !Number.isSafeInteger(seller.fullSourceAmountMinor)
    || seller.fullSourceAmountMinor <= 0
    || !Number.isSafeInteger(seller.allocationCapacityMinor)
    || seller.allocationCapacityMinor < 0
    || !Number.isSafeInteger(seller.sourceOffsetMinor)
    || seller.sourceOffsetMinor < 0
    || seller.sourceOffsetMinor > seller.fullSourceAmountMinor
    || seller.allocationCapacityMinor > seller.fullSourceAmountMinor - seller.sourceOffsetMinor
  ))) {
    throw walletPaymentError(
      'Wallet funding seller capacity is malformed.',
      'WALLET_FUNDING_PROVENANCE_INVALID',
      500,
    );
  }
  const totalFundingMinor = rows.reduce((sum, row) => sum + row.remainingMinor, 0);
  const orderSettlementMinor = sellers.reduce((sum, seller) => sum + seller.fullSourceAmountMinor, 0);
  const priorFundingMinor = sellers.reduce((sum, seller) => sum + seller.sourceOffsetMinor, 0);
  const cumulativeFundingMinor = priorFundingMinor + totalFundingMinor;
  if (
    !Number.isSafeInteger(totalFundingMinor)
    || !Number.isSafeInteger(priorFundingMinor)
    || !Number.isSafeInteger(cumulativeFundingMinor)
    || cumulativeFundingMinor > orderSettlementMinor
  ) {
    throw walletPaymentError(
      'Wallet funding provenance exceeds the frozen seller settlement.',
      'WALLET_FUNDING_PROVENANCE_INVALID',
      500,
    );
  }
  const sellerWeights = sellers.map(seller => ({
    key: seller.seller,
    weight: seller.fullSourceAmountMinor,
  }));
  const priorColumns = allocateHouseMonotoneMinorUnits(priorFundingMinor, sellerWeights);
  const cumulativeColumns = allocateHouseMonotoneMinorUnits(cumulativeFundingMinor, sellerWeights);
  const sellerColumns = new Map();
  for (const seller of sellers) {
    const canonicalPrior = priorColumns.get(seller.seller) ?? 0;
    const canonicalCumulative = cumulativeColumns.get(seller.seller) ?? 0;
    const delta = canonicalCumulative - canonicalPrior;
    // Residual migrations must extend the same one-shot apportionment used by
    // a fresh order. Re-apportioning only the residual capacities can award a
    // tie cent to the wrong seller (for example A=2/B=1 with a prior A cent).
    if (
      canonicalPrior !== seller.sourceOffsetMinor
      || delta < 0
      || delta > seller.allocationCapacityMinor
    ) {
      throw walletPaymentError(
        'Wallet funding seller offsets conflict with the canonical frozen allocation.',
        'WALLET_FUNDING_PROVENANCE_INVALID',
        500,
      );
    }
    sellerColumns.set(seller.seller, delta);
  }

  let rowIndex = 0;
  for (const seller of sellers) {
    let sellerRemaining = sellerColumns.get(seller.seller) ?? 0;
    while (sellerRemaining > 0) {
      while (rowIndex < rows.length && rows[rowIndex].remainingMinor === 0) rowIndex += 1;
      if (rowIndex >= rows.length) {
        throw walletPaymentError(
          'Wallet funding provenance could not conserve seller columns.',
          'WALLET_FUNDING_PROVENANCE_INVALID',
          500,
        );
      }
      const moved = Math.min(sellerRemaining, rows[rowIndex].remainingMinor);
      rows[rowIndex].allocations.push({ seller: seller.seller, sourceAmountMinor: moved });
      rows[rowIndex].remainingMinor -= moved;
      sellerRemaining -= moved;
    }
  }
  if (rows.some(row => row.remainingMinor !== 0)) {
    throw walletPaymentError(
      'Wallet funding provenance did not conserve every top-up lot.',
      'WALLET_FUNDING_PROVENANCE_INVALID',
      500,
    );
  }

  const cumulativeSource = new Map(sellers.map(seller => [seller.seller, 0]));
  const sellerEntry = new Map(sellers.map(seller => [seller.seller, seller.entry]));
  const sellerOffset = new Map(sellers.map(seller => [seller.seller, seller.sourceOffsetMinor]));
  return rows.sort((left, right) => left.index - right.index).map(row => ({
    ...row.entry,
    orderId: String(orderId),
    sellerAllocations: row.allocations.map(allocation => {
      const previousSource = cumulativeSource.get(allocation.seller) ?? 0;
      const nextSource = previousSource + allocation.sourceAmountMinor;
      const sourceOffset = sellerOffset.get(allocation.seller) ?? 0;
      const nextUsd = sellerSettlementUsdTargetForSource(
        sellerEntry.get(allocation.seller),
        sourceOffset + nextSource,
      );
      const previousUsd = sellerSettlementUsdTargetForSource(
        sellerEntry.get(allocation.seller),
        sourceOffset + previousSource,
      );
      const amountUSDMinor = nextUsd - previousUsd;
      if (amountUSDMinor < 0) {
        throw walletPaymentError(
          'Wallet funding USD provenance moved backwards.',
          'WALLET_FUNDING_PROVENANCE_INVALID',
          500,
        );
      }
      cumulativeSource.set(allocation.seller, nextSource);
      return { ...allocation, amountUSDMinor };
    }),
  }));
};

const legacyFundingQuarantine = (message, details = {}) => {
  const error = walletPaymentError(
    message,
    'WALLET_FUNDING_PROVENANCE_QUARANTINED',
    503,
  );
  error.quarantineSellerIds = [...new Set((details.sellerIds || []).map(String).filter(Boolean))].sort();
  error.sourceTransactionIds = [...new Set((details.sourceTransactionIds || []).map(String).filter(Boolean))].sort();
  error.walletId = details.walletId ? String(details.walletId) : null;
  return error;
};

const transactionTime = transaction => {
  const date = transaction?.completedAt || transaction?.createdAt;
  const time = date instanceof Date ? date.getTime() : new Date(date || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : null;
};

const compareFundingEvents = (left, right) => (
  left.time - right.time
  || left.kind.localeCompare(right.kind) // `source` sorts before `spend`.
  || String(left.document._id).localeCompare(String(right.document._id))
);

const candidateSellerIdsForOrder = async (order, session) => {
  const sellers = new Set((order?.orderItems || []).map(item => String(item?.seller || '')).filter(Boolean));
  const missingProductIds = (order?.orderItems || [])
    .filter(item => !item?.seller && item?.productId)
    .map(item => item.productId);
  if (missingProductIds.length) {
    const products = await Product.find({ _id: { $in: missingProductIds } })
      .select('_id seller')
      .session(session)
      .lean();
    products.forEach(product => {
      if (product?.seller) sellers.add(String(product.seller));
    });
  }
  return [...sellers].sort();
};

const findOrderForWalletDebit = async (debit, session) => {
  const referenceId = String(debit?.referenceId || '').trim();
  const publicOrderId = String(debit?.metadata?.orderId || '').trim();
  if (!referenceId && !publicOrderId) return null;
  const scope = debit?.user ? { user: debit.user } : {};
  const resolve = async reference => {
    if (!reference) return null;
    try {
      return await resolveOrderReference({ reference, scope, session });
    } catch (error) {
      if (error?.code !== 'ORDER_REFERENCE_AMBIGUOUS') throw error;
      throw legacyFundingQuarantine(
        'A historical Wallet debit has an ambiguous public order id. No funding ownership was inferred.',
        {
          sourceTransactionIds: [debit?._id],
          walletId: debit?.wallet,
        }
      );
    }
  };

  const primaryOrder = await resolve(referenceId);
  // A Mongo-looking reference is immutable authority. Never recover an
  // unknown _id by selecting a public display id from metadata.
  if (referenceId && mongoose.isValidObjectId(referenceId) && !primaryOrder) return null;
  const metadataOrder = publicOrderId && publicOrderId !== referenceId
    ? await resolve(publicOrderId)
    : primaryOrder;
  if (primaryOrder && metadataOrder && String(primaryOrder._id) !== String(metadataOrder._id)) {
    throw legacyFundingQuarantine(
      'A historical Wallet debit names conflicting immutable and public order references.',
      {
        sourceTransactionIds: [debit?._id],
        walletId: debit?.wallet,
      }
    );
  }
  return primaryOrder || metadataOrder || null;
};

/** Best-effort fail-closed ownership discovery used only after a legacy
 * provenance replay has rejected its accounting state. It does not infer
 * money: it identifies every seller durably named by the affected historical
 * Wallet orders so withdrawal holds can survive the failed replay. */
const findLegacyWalletFundingCandidateSellerIds = async ({
  walletId,
  userId,
  currency,
  session = null,
}) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  let debitQuery = WalletTransaction.find({
    wallet: walletId,
    user: userId,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    currency: normalizedCurrency,
  });
  if (session) debitQuery = debitQuery.session(session);
  const debits = await debitQuery;
  const sellers = new Set();
  for (const debit of debits) {
    const referenceId = String(debit?.referenceId || '').trim();
    const publicOrderId = String(debit?.metadata?.orderId || '').trim();
    const scope = debit?.user ? { user: debit.user } : {};
    const candidates = [];
    if (referenceId && mongoose.isValidObjectId(referenceId)) {
      let query = Order.findOne({ ...scope, _id: referenceId });
      if (session) query = query.session(session);
      const immutableOrder = await query;
      if (immutableOrder) candidates.push(immutableOrder);
    }
    const publicReferences = [...new Set([
      ...(!mongoose.isValidObjectId(referenceId) ? [referenceId] : []),
      publicOrderId,
    ].filter(Boolean))];
    if (publicReferences.length) {
      let query = Order.find({ ...scope, orderId: { $in: publicReferences } }).limit(1000);
      if (session) query = query.session(session);
      candidates.push(...await query);
    }
    for (const order of new Map(candidates.map(row => [String(row._id), row])).values()) {
      (await candidateSellerIdsForOrder(order, session)).forEach(seller => sellers.add(seller));
    }
  }
  return [...sellers].sort();
};

const historicalReturnAvailableMinor = row => {
  if (typeof row?.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0) {
    throw legacyFundingQuarantine('A historical Wallet return credit has an invalid stored amount.', {
      walletId: row?.wallet,
    });
  }
  const refundMinor = toMinorUnits(row.amount);
  if (!Number.isSafeInteger(refundMinor) || refundMinor <= 0 || fromMinorUnits(refundMinor) !== row.amount) {
    throw legacyFundingQuarantine('A historical Wallet return credit is not stored in exact minor units.', {
      walletId: row?.wallet,
    });
  }
  const rawAvailable = row.metadata?.availableCreditedMinor;
  const rawApplied = row.metadata?.liabilityAppliedMinor;
  const hasAvailable = rawAvailable !== undefined;
  const hasApplied = rawApplied !== undefined;
  const appliedMinor = hasApplied ? rawApplied : 0;
  const availableMinor = hasAvailable ? rawAvailable : refundMinor - appliedMinor;
  if (
    !Number.isSafeInteger(appliedMinor) || appliedMinor < 0
    || !Number.isSafeInteger(availableMinor) || availableMinor < 0
    || appliedMinor + availableMinor > refundMinor
  ) {
    throw legacyFundingQuarantine('A historical Wallet return credit has malformed liability allocation.', {
      walletId: row.wallet,
    });
  }
  return { refundMinor, appliedMinor, availableMinor };
};

const historicalReturnIdentity = async (row, session) => {
  let request = null;
  if (row.referenceType === 'return_request' && mongoose.isValidObjectId(row.referenceId)) {
    request = await ReturnRequest.findById(row.referenceId).session(session);
  }
  if (request && (
    String(request.buyer || '') !== String(row.user || '')
    || String(request.currency || '') !== String(row.currency || '')
  )) {
    throw legacyFundingQuarantine('A historical Wallet return does not match its immutable return request.', {
      sellerIds: [request.seller],
      walletId: row.wallet,
    });
  }
  let order = request?.order ? await Order.findById(request.order).session(session) : null;
  const hasStrongLegacyReference = (
    row.referenceType === 'return_request'
    && String(row.referenceId || '').trim()
    && row.idempotencyKey === `return-refund:${String(row.referenceId)}`
    && String(row.metadata?.sellerId || '').trim()
  );
  if (!order && (!request && hasStrongLegacyReference)) {
    const storedOrder = String(row.metadata?.orderId || '').trim();
    if (storedOrder) {
      try {
        order = await resolveOrderReference({
          reference: storedOrder,
          scope: row?.user ? { user: row.user } : {},
          session,
        });
      } catch (error) {
        if (error?.code !== 'ORDER_REFERENCE_AMBIGUOUS') throw error;
        throw legacyFundingQuarantine(
          'A historical Wallet return has an ambiguous public order id. No refund funding was inferred.',
          {
            sellerIds: [row.metadata?.sellerId],
            sourceTransactionIds: [row?._id],
            walletId: row?.wallet,
          }
        );
      }
    }
  }
  if (order && (
    String(order.user || '') !== String(row.user || '')
    || (request && String(request.orderId || '') !== String(order.orderId || ''))
  )) {
    throw legacyFundingQuarantine('A historical Wallet return does not match its immutable paid order.', {
      sellerIds: [request?.seller || row.metadata?.sellerId],
      walletId: row.wallet,
    });
  }
  return {
    order,
    sellerId: String(request?.seller || row.metadata?.sellerId || '').trim(),
    returnRequestId: String(request?._id || row.referenceId || row._id),
  };
};

const legacyTopUpOriginalMinor = topUp => {
  if (typeof topUp?.amount !== 'number' || !Number.isFinite(topUp.amount) || topUp.amount <= 0) {
    throw legacyFundingQuarantine('A legacy Wallet top-up has an invalid stored amount.', {
      sourceTransactionIds: [topUp?._id],
      walletId: topUp?.wallet,
    });
  }
  const topUpMinor = toMinorUnits(topUp.amount);
  if (!Number.isSafeInteger(topUpMinor) || topUpMinor <= 0 || fromMinorUnits(topUpMinor) !== topUp.amount) {
    throw legacyFundingQuarantine('A legacy Wallet top-up is not stored in exact minor units.', {
      sourceTransactionIds: [topUp?._id],
      walletId: topUp?.wallet,
    });
  }
  const metadata = topUp.metadata || {};
  const hasAvailable = Object.prototype.hasOwnProperty.call(metadata, 'availableCreditedMinor')
    && metadata.availableCreditedMinor !== undefined;
  const hasApplied = Object.prototype.hasOwnProperty.call(metadata, 'liabilityAppliedMinor')
    && metadata.liabilityAppliedMinor !== undefined;
  const availableMinor = hasAvailable ? metadata.availableCreditedMinor : null;
  const appliedMinor = hasApplied ? metadata.liabilityAppliedMinor : 0;
  if (
    (hasAvailable && (
      typeof availableMinor !== 'number'
      || !Number.isSafeInteger(availableMinor)
      || availableMinor < 0
      || availableMinor > topUpMinor
    ))
    || (hasApplied && (
      typeof appliedMinor !== 'number'
      || !Number.isSafeInteger(appliedMinor)
      || appliedMinor < 0
      || appliedMinor > topUpMinor
    ))
    || (hasAvailable && hasApplied && availableMinor + appliedMinor > topUpMinor)
  ) {
    throw legacyFundingQuarantine('A legacy Wallet top-up has malformed credited-liability metadata.', {
      sourceTransactionIds: [topUp._id],
      walletId: topUp.wallet,
    });
  }
  return {
    topUpMinor,
    originalMinor: hasAvailable ? availableMinor : topUpMinor - appliedMinor,
    basis: hasAvailable ? 'availableCreditedMinor' : (hasApplied ? 'topUpMinusLiability' : 'legacyFullTopUp'),
  };
};

const enrichLegacyOrderFundingProvenance = async ({
  debit,
  debitAmount = debit?.amount,
  provenance,
  legacySourceIds,
  session,
}) => {
  const order = await findOrderForWalletDebit(debit, session);
  let candidateSellerIds = [];
  if (order) candidateSellerIds = await candidateSellerIdsForOrder(order, session);
  const quarantine = message => legacyFundingQuarantine(message, {
    sellerIds: candidateSellerIds,
    sourceTransactionIds: [...legacySourceIds],
    walletId: debit.wallet,
  });
  if (!order) throw quarantine('A historical Wallet order payment cannot be linked to its order.');
  if (
    String(order.user || '') !== String(debit.user || '')
    || order.paymentMethod !== 'wallet'
    || order.isPaid !== true
    || getAccountingOrderCurrency(order) !== debit.currency
  ) {
    throw quarantine('A historical Wallet order payment does not match its authoritative paid order.');
  }
  let settlement;
  try {
    settlement = await ensureOrderSellerSettlement(order, { session, requireOrderTotal: true });
  } catch (error) {
    error.quarantineSellerIds = candidateSellerIds;
    error.sourceTransactionIds = [...legacySourceIds];
    error.walletId = String(debit.wallet || '');
    if (!error.code) error.code = 'WALLET_FUNDING_PROVENANCE_QUARANTINED';
    throw error;
  }
  const settlementBySeller = new Map(settlement.map(entry => [String(entry.seller), entry]));
  const existingSourceBySeller = new Map();
  const existingUsdBySeller = new Map();
  const targetIndexes = [];
  for (let index = 0; index < provenance.length; index += 1) {
    const entry = provenance[index];
    const amountMinor = entry?.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw quarantine('Historical Wallet funding provenance contains an invalid lot.');
    }
    const allocations = Array.isArray(entry?.sellerAllocations) ? entry.sellerAllocations : [];
    const isLegacyTarget = legacySourceIds.has(String(entry?.sourceTransactionId || ''));
    if (!allocations.length) {
      if (isLegacyTarget) targetIndexes.push(index);
      continue;
    }
    let allocatedMinor = 0;
    for (const allocation of allocations) {
      const seller = String(allocation?.seller || '');
      const sourceMinor = allocation?.sourceAmountMinor;
      const usdMinor = allocation?.amountUSDMinor;
      if (
        !settlementBySeller.has(seller)
        || !Number.isSafeInteger(sourceMinor) || sourceMinor < 0
        || !Number.isSafeInteger(usdMinor) || usdMinor < 0
      ) {
        throw quarantine('Historical Wallet seller provenance is malformed.');
      }
      allocatedMinor += sourceMinor;
      existingSourceBySeller.set(seller, (existingSourceBySeller.get(seller) ?? 0) + sourceMinor);
      existingUsdBySeller.set(seller, (existingUsdBySeller.get(seller) ?? 0) + usdMinor);
    }
    if (allocatedMinor !== amountMinor) {
      throw quarantine('Historical Wallet seller provenance does not conserve its funding lot.');
    }
  }
  if (!targetIndexes.length) return provenance;
  const residualSettlement = settlement.map(entry => {
    const seller = String(entry.seller);
    const sourceOffset = existingSourceBySeller.get(seller) ?? 0;
    const usdOffset = existingUsdBySeller.get(seller) ?? 0;
    if (
      sourceOffset > entry.sourceAmountMinor
      || usdOffset !== sellerSettlementUsdTargetForSource(entry, sourceOffset)
    ) {
      throw quarantine('Historical Wallet seller provenance conflicts with the frozen settlement.');
    }
    return {
      ...entry,
      allocationCapacityMinor: entry.sourceAmountMinor - sourceOffset,
      allocationSourceOffsetMinor: sourceOffset,
    };
  });
  const allocatedTargets = allocateFundingProvenanceToSellerSettlement({
    fundingProvenance: targetIndexes.map(index => provenance[index]),
    settlementEntries: residualSettlement,
    orderId: order._id,
  });
  const enriched = [...provenance];
  targetIndexes.forEach((index, targetIndex) => { enriched[index] = allocatedTargets[targetIndex]; });
  const debitMinor = toMinorUnits(debitAmount);
  const settlementMinor = settlement.reduce((sum, entry) => sum + entry.sourceAmountMinor, 0);
  if (debitMinor !== settlementMinor) {
    throw quarantine('Historical Wallet debit does not equal the strict frozen order total.');
  }
  return enriched;
};

/** Normalize historical Stripe top-ups before any new spend or reversal. The
 * replay uses only append-only Wallet debits and authoritative order seller
 * settlements. Ambiguous ownership/FX/amount state fails closed. */
const materializeLegacyWalletTopUpFunding = async ({
  walletId,
  userId,
  currency,
  session,
}) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  const wallet = await Wallet.findOne({ _id: walletId, user: userId }).session(session);
  if (!wallet) throw legacyFundingQuarantine('The Wallet for legacy funding migration was not found.', { walletId });
  // Missing legacy buckets are zero; a present corrupt balance must quarantine
  // the replay before it can alter durable provenance counters.
  readStoredWalletBalance(wallet, normalizedCurrency);
  const topUps = await WalletTransaction.find({
    user: userId,
    wallet: walletId,
    type: 'top_up',
    direction: 'credit',
    status: 'completed',
    currency: normalizedCurrency,
  }).session(session);
  const rawTopUps = topUps.length
    ? await WalletTransaction.collection.find(
      { _id: { $in: topUps.map(topUp => topUp._id) } },
      { session },
    ).toArray()
    : [];
  const rawTopUpById = new Map(rawTopUps.map(topUp => [String(topUp._id), topUp]));
  const legacy = [];
  let trackedRemainingMinor = 0;
  for (const topUp of topUps) {
    const persistedTopUp = rawTopUpById.get(String(topUp._id));
    if (!persistedTopUp) {
      throw legacyFundingQuarantine('A Wallet top-up disappeared during funding migration.', {
        sourceTransactionIds: [topUp._id], walletId,
      });
    }
    const rawRemaining = persistedTopUp.metadata?.fundingRemainingMinor;
    const rawOriginal = persistedTopUp.metadata?.fundingOriginalAvailableMinor;
    const hasRemaining = rawRemaining !== undefined;
    const hasOriginal = rawOriginal !== undefined;
    if (hasRemaining !== hasOriginal) {
      throw legacyFundingQuarantine('A Wallet top-up has partially persisted funding counters.', {
        sourceTransactionIds: [topUp._id], walletId,
      });
    }
    if (hasRemaining) {
      const remainingMinor = rawRemaining;
      const originalMinor = rawOriginal;
      const availableMinor = persistedTopUp.metadata?.availableCreditedMinor;
      if (
        !Number.isSafeInteger(remainingMinor) || remainingMinor < 0
        || !Number.isSafeInteger(originalMinor) || originalMinor < 0
        || remainingMinor > originalMinor
        || !Number.isSafeInteger(availableMinor) || availableMinor !== originalMinor
      ) {
        throw legacyFundingQuarantine('A Wallet top-up has invalid durable funding counters.', {
          sourceTransactionIds: [topUp._id], walletId,
        });
      }
      trackedRemainingMinor += remainingMinor;
      if (!Number.isSafeInteger(trackedRemainingMinor)) {
        throw legacyFundingQuarantine('Wallet funding counters exceed the safe accounting range.', { walletId });
      }
      continue;
    }
    if (
      !['stripe_checkout', 'stripe_payment_intent'].includes(persistedTopUp.referenceType)
      || !(String(persistedTopUp.stripePaymentIntentId || '').trim() || String(persistedTopUp.stripeSessionId || '').trim())
    ) {
      throw legacyFundingQuarantine('A legacy Wallet top-up has no immutable Stripe funding evidence.', {
        sourceTransactionIds: [topUp._id], walletId,
      });
    }
    const amounts = legacyTopUpOriginalMinor(persistedTopUp);
    const time = transactionTime(topUp);
    if (!time) {
      throw legacyFundingQuarantine('A legacy Wallet top-up has no deterministic completion time.', {
        sourceTransactionIds: [topUp._id], walletId,
      });
    }
    legacy.push({ document: topUp, time, ...amounts, availableMinor: 0, adjustmentMinor: 0, debitIds: [] });
  }
  if (!legacy.length) return { materialized: 0, sourceIds: [] };

  // Force every Wallet balance mutation (debit, return credit, top-up credit,
  // or risk collection) to conflict with this snapshot replay. Without a
  // shared write fence, a concurrent return could commit an empty provenance
  // row after our snapshot read while the migration still commits counters.
  const walletVersion = Number.isSafeInteger(wallet.__v) ? wallet.__v : 0;
  const walletFence = await Wallet.updateOne(
    {
      _id: wallet._id,
      ...(Number.isSafeInteger(wallet.__v)
        ? { __v: walletVersion }
        : { $or: [{ __v: { $exists: false } }, { __v: null }] }),
    },
    { $inc: { __v: 1 } },
    { session },
  );
  if (walletFence.modifiedCount !== 1) {
    throw legacyFundingQuarantine('Wallet funding migration lost its balance-version fence.', {
      sourceTransactionIds: legacy.map(source => source.document._id),
      walletId,
    });
  }
  wallet.__v = walletVersion + 1;

  const legacyById = new Map(legacy.map(source => [String(source.document._id), source]));
  const debits = await WalletTransaction.find({
    user: userId,
    wallet: walletId,
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    currency: normalizedCurrency,
  }).session(session);
  const rawDebits = debits.length
    ? await WalletTransaction.collection.find(
      { _id: { $in: debits.map(debit => debit._id) } },
      { session },
    ).toArray()
    : [];
  const rawDebitById = new Map(rawDebits.map(debit => [String(debit._id), debit]));
  const events = [
    ...legacy.map(source => ({ kind: 'source', time: source.time, document: source.document })),
    ...debits.map(debit => ({ kind: 'spend', time: transactionTime(debit), document: debit })),
  ];
  if (events.some(event => !event.time)) {
    throw legacyFundingQuarantine('A historical Wallet debit has no deterministic completion time.', {
      sourceTransactionIds: [...legacyById.keys()], walletId,
    });
  }
  events.sort(compareFundingEvents);
  const activeSources = [];
  for (const event of events) {
    if (event.kind === 'source') {
      const source = legacyById.get(String(event.document._id));
      source.availableMinor = source.originalMinor;
      activeSources.push(source);
      continue;
    }
    const debit = event.document;
    const persistedDebit = rawDebitById.get(String(debit._id));
    const debitAmount = persistedDebit?.amount;
    const debitMinor = typeof debitAmount === 'number' && Number.isFinite(debitAmount)
      ? toMinorUnits(debitAmount)
      : null;
    if (!Number.isSafeInteger(debitMinor) || debitMinor <= 0 || fromMinorUnits(debitMinor) !== debitAmount) {
      throw legacyFundingQuarantine('A historical Wallet debit has an invalid exact-cent amount.', {
        sourceTransactionIds: [...legacyById.keys()], walletId,
      });
    }
    const provenance = Array.isArray(persistedDebit?.metadata?.fundingProvenance)
      ? persistedDebit.metadata.fundingProvenance.map(entry => ({ ...entry }))
      : [];
    let provenanceMinor = 0;
    for (const entry of provenance) {
      const entryMinor = entry?.amountMinor;
      if (!Number.isSafeInteger(entryMinor) || entryMinor <= 0) {
        throw legacyFundingQuarantine('A historical Wallet debit has malformed funding provenance.', {
          sourceTransactionIds: [...legacyById.keys()], walletId,
        });
      }
      provenanceMinor += entryMinor;
      const source = legacyById.get(String(entry?.sourceTransactionId || ''));
      if (source) {
        if (!activeSources.includes(source) || source.availableMinor < entryMinor) {
          throw legacyFundingQuarantine('Historical Wallet provenance spends a top-up before or beyond its principal.', {
            sourceTransactionIds: [source.document._id], walletId,
          });
        }
        source.availableMinor -= entryMinor;
        source.debitIds.push(String(debit._id));
      }
    }
    if (!Number.isSafeInteger(provenanceMinor) || provenanceMinor > debitMinor) {
      throw legacyFundingQuarantine('Historical Wallet funding provenance exceeds its debit.', {
        sourceTransactionIds: [...legacyById.keys()], walletId,
      });
    }
    const inferredUntrackedMinor = debitMinor - provenanceMinor;
    const rawUntracked = persistedDebit?.metadata?.untrackedFundingMinor;
    const hasUntracked = rawUntracked !== undefined;
    if (hasUntracked && (!Number.isSafeInteger(rawUntracked) || rawUntracked !== inferredUntrackedMinor)) {
      throw legacyFundingQuarantine('Historical Wallet untracked funding does not conserve its debit.', {
        sourceTransactionIds: [...legacyById.keys()], walletId,
      });
    }
    let untrackedMinor = inferredUntrackedMinor;
    const appended = [];
    for (const source of activeSources) {
      if (untrackedMinor <= 0) break;
      const consumedMinor = Math.min(untrackedMinor, source.availableMinor);
      if (!consumedMinor) continue;
      appended.push({
        sourceType: 'wallet_top_up',
        sourceTransactionId: String(source.document._id),
        amountMinor: consumedMinor,
        legacyMaterialized: true,
      });
      source.availableMinor -= consumedMinor;
      source.debitIds.push(String(debit._id));
      untrackedMinor -= consumedMinor;
    }
    const legacyEntriesNeedingAllocation = provenance.some(entry => (
      legacyById.has(String(entry?.sourceTransactionId || ''))
      && !(Array.isArray(entry?.sellerAllocations) && entry.sellerAllocations.length)
    ));
    if (appended.length || legacyEntriesNeedingAllocation) {
      const enriched = await enrichLegacyOrderFundingProvenance({
        debit,
        debitAmount,
        provenance: [...provenance, ...appended],
        legacySourceIds: new Set(legacyById.keys()),
        session,
      });
      debit.metadata = {
        ...(debit.metadata || {}),
        fundingProvenance: enriched,
        untrackedFundingMinor: untrackedMinor,
        legacyFundingMaterializationVersion: 1,
      };
      debit.markModified('metadata');
      await debit.save({ session });
    }
  }

  // Make the reconstructed lots visible to the ordinary append-only return
  // provenance routine. These writes and every return movement below share the
  // caller's Mongo transaction, so any ambiguity rolls the whole migration
  // back instead of leaving partially normalized counters.
  for (const source of legacy) {
    source.document.metadata = {
      ...(source.document.metadata || {}),
      availableCreditedMinor: source.originalMinor,
      fundingOriginalAvailableMinor: source.originalMinor,
      fundingRemainingMinor: source.availableMinor,
    };
    source.document.markModified('metadata');
    await source.document.save({ session });
  }

  const historicalReturnCredits = await WalletTransaction.find({
    user: userId,
    wallet: walletId,
    type: 'return_refund',
    direction: 'credit',
    status: 'completed',
    currency: normalizedCurrency,
    'metadata.legacyFundingReturnMaterializationVersion': { $ne: 1 },
  }).sort({ completedAt: 1, _id: 1 }).session(session);
  for (const credit of historicalReturnCredits) {
    const identity = await historicalReturnIdentity(credit, session);
    if (!identity.order) continue;
    const orderPayment = debits.find(debit => (
      String(debit.referenceId || '') === String(identity.order._id)
      || String(debit.referenceId || '') === String(identity.order.orderId)
      || String(debit.metadata?.orderId || '') === String(identity.order.orderId)
    ));
    if (!orderPayment) continue;
    const legacyFundingEntries = (orderPayment.metadata?.fundingProvenance || []).filter(entry => (
      legacyById.has(String(entry?.sourceTransactionId || ''))
    ));
    if (!legacyFundingEntries.length) continue;
    if (!identity.sellerId) {
      throw legacyFundingQuarantine('A historical Wallet return cannot be linked to its durable seller.', {
        sellerIds: await candidateSellerIdsForOrder(identity.order, session),
        sourceTransactionIds: legacyFundingEntries.map(entry => entry.sourceTransactionId),
        walletId,
      });
    }
    const existingMovements = Array.isArray(credit.metadata?.fundingProvenanceReturns)
      ? credit.metadata.fundingProvenanceReturns
      : [];
    // A return completed after tracked provenance existed but before legacy
    // lots were materialized may contain only the tracked share (or an empty
    // array). Roll back its prior counter restoration, then recompute the full
    // row once against the enriched immutable order funding.
    for (const movement of existingMovements) {
      const sourceId = String(movement?.sourceTransactionId || '');
      const restoredMinor = movement?.availableRestoredMinor;
      if (!sourceId || !Number.isSafeInteger(restoredMinor) || restoredMinor < 0) {
        throw legacyFundingQuarantine('A historical Wallet return has malformed existing provenance.', {
          sellerIds: [identity.sellerId],
          sourceTransactionIds: [sourceId].filter(Boolean),
          walletId,
        });
      }
      if (!restoredMinor || legacyById.has(sourceId)) continue;
      const trackedSource = await WalletTransaction.findOne({
        _id: sourceId,
        user: userId,
        wallet: walletId,
        type: 'top_up',
        direction: 'credit',
        status: 'completed',
        currency: normalizedCurrency,
      }).session(session);
      const remainingMinor = trackedSource?.metadata?.fundingRemainingMinor;
      if (!trackedSource || !Number.isSafeInteger(remainingMinor) || remainingMinor < restoredMinor) {
        throw legacyFundingQuarantine('Historical Wallet return counters cannot be replayed safely.', {
          sellerIds: [identity.sellerId],
          sourceTransactionIds: [sourceId],
          walletId,
        });
      }
      trackedSource.metadata.fundingRemainingMinor = remainingMinor - restoredMinor;
      trackedSource.markModified('metadata');
      await trackedSource.save({ session });
      trackedRemainingMinor -= restoredMinor;
      if (trackedRemainingMinor < 0) {
        throw legacyFundingQuarantine('Historical Wallet return counters moved below zero.', {
          sellerIds: [identity.sellerId],
          sourceTransactionIds: [sourceId],
          walletId,
        });
      }
    }
    const { refundMinor, appliedMinor, availableMinor } = historicalReturnAvailableMinor(credit);
    credit.metadata = {
      ...(credit.metadata || {}),
      liabilityAppliedMinor: appliedMinor,
      availableCreditedMinor: availableMinor,
    };
    delete credit.metadata.fundingProvenanceReturns;
    credit.markModified('metadata');
    await credit.save({ session });
    const movements = await attachReturnedWalletFundingProvenance({
      walletTransaction: credit,
      orderId: identity.order._id,
      sellerId: identity.sellerId,
      returnRequestId: identity.returnRequestId,
      refundAmount: fromMinorUnits(refundMinor),
      currency: normalizedCurrency,
      session,
    });
    const movedLegacyMinor = movements.reduce((sum, movement) => (
      sum + (legacyById.has(String(movement.sourceTransactionId || '')) ? movement.amountMinor : 0)
    ), 0);
    if (movedLegacyMinor === 0) {
      throw legacyFundingQuarantine('A historical Wallet return does not match its reconstructed seller funding.', {
        sellerIds: [identity.sellerId],
        sourceTransactionIds: legacyFundingEntries.map(entry => entry.sourceTransactionId),
        walletId,
      });
    }
    for (const movement of movements) {
      const restoredMinor = movement.availableRestoredMinor;
      if (typeof restoredMinor !== 'number' || !Number.isSafeInteger(restoredMinor) || restoredMinor < 0) {
        throw legacyFundingQuarantine('Historical Wallet return funding is malformed.', {
          sourceTransactionIds: [movement.sourceTransactionId],
          walletId,
        });
      }
      if (!restoredMinor) continue;
      const legacySource = legacyById.get(String(movement.sourceTransactionId || ''));
      if (legacySource) {
        legacySource.availableMinor += restoredMinor;
        if (
          !Number.isSafeInteger(legacySource.availableMinor)
          || legacySource.availableMinor > legacySource.originalMinor
        ) {
          throw legacyFundingQuarantine('Historical Wallet returns exceed their reconstructed top-up principal.', {
            sellerIds: [identity.sellerId],
            sourceTransactionIds: [movement.sourceTransactionId],
            walletId,
          });
        }
      } else {
        trackedRemainingMinor += restoredMinor;
        if (!Number.isSafeInteger(trackedRemainingMinor)) {
          throw legacyFundingQuarantine('Historical Wallet return funding exceeds the safe accounting range.', {
            walletId,
          });
        }
      }
    }
    credit.metadata = {
      ...(credit.metadata || {}),
      legacyFundingReturnMaterializationVersion: 1,
    };
    credit.markModified('metadata');
    await credit.save({ session });
  }

  const walletBalanceMinor = toMinorUnits(readStoredWalletBalance(wallet, normalizedCurrency));
  if (!Number.isSafeInteger(walletBalanceMinor) || walletBalanceMinor < 0 || trackedRemainingMinor > walletBalanceMinor) {
    throw legacyFundingQuarantine('Wallet balance cannot reconcile with its durable top-up funding lots.', {
      sourceTransactionIds: [...legacyById.keys()], walletId,
    });
  }
  let excessLegacyMinor = Math.max(
    0,
    legacy.reduce((sum, source) => sum + source.availableMinor, 0)
      - (walletBalanceMinor - trackedRemainingMinor),
  );
  for (const source of legacy) {
    if (excessLegacyMinor <= 0) break;
    const adjustment = Math.min(excessLegacyMinor, source.availableMinor);
    source.availableMinor -= adjustment;
    source.adjustmentMinor += adjustment;
    excessLegacyMinor -= adjustment;
  }
  if (excessLegacyMinor !== 0) {
    throw legacyFundingQuarantine('Legacy Wallet balance replay could not conserve its funding principal.', {
      sourceTransactionIds: [...legacyById.keys()], walletId,
    });
  }
  for (const source of legacy) {
    const audit = {
      version: 1,
      basis: source.basis,
      originalMinor: source.originalMinor,
      remainingMinor: source.availableMinor,
      balanceAdjustmentMinor: source.adjustmentMinor,
      debitIds: [...new Set(source.debitIds)].sort(),
    };
    audit.fingerprint = crypto.createHash('sha256').update(JSON.stringify(audit)).digest('hex');
    source.document.metadata = {
      ...(source.document.metadata || {}),
      availableCreditedMinor: source.originalMinor,
      fundingOriginalAvailableMinor: source.originalMinor,
      fundingRemainingMinor: source.availableMinor,
      legacyFundingMaterialization: audit,
    };
    source.document.markModified('metadata');
    await source.document.save({ session });
  }
  return { materialized: legacy.length, sourceIds: [...legacyById.keys()] };
};

const stripeLivemodeMatches = (stripeObject, stripeMode) => (
  typeof stripeObject?.livemode === 'boolean'
  && stripeObject.livemode === (stripeMode === 'live')
);

const validateWalletTopUpPaymentIntent = (
  transaction,
  paymentIntent,
  { allowMissingReference = false } = {},
) => {
  if (!transaction || transaction.paymentFlow !== 'payment_sheet') {
    throw walletPaymentError('This is not a native Wallet top-up.', 'NOT_PAYMENT_SHEET_TOP_UP');
  }
  const metadata = paymentIntent?.metadata || {};
  const customerId = typeof paymentIntent?.customer === 'string'
    ? paymentIntent.customer
    : paymentIntent?.customer?.id;
  if (
    !paymentIntent?.id
    || (
      transaction.stripePaymentIntentId
        ? paymentIntent.id !== transaction.stripePaymentIntentId
        : !allowMissingReference
    )
    || metadata.type !== 'wallet_top_up'
    || metadata.paymentFlow !== 'payment_sheet'
    || String(metadata.walletTransactionId || '') !== String(transaction._id || '')
    || String(metadata.userId || '') !== String(transaction.user || '')
  ) {
    throw walletPaymentError('Wallet top-up ownership is invalid.', 'TOP_UP_TRANSACTION_MISMATCH');
  }
  if (!transaction.stripeCustomerId || customerId !== transaction.stripeCustomerId) {
    throw walletPaymentError('Wallet top-up customer ownership is invalid.', 'TOP_UP_CUSTOMER_MISMATCH');
  }
  const expectedMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
  if (
    !Number.isSafeInteger(paymentIntent.amount)
    || paymentIntent.amount !== expectedMinor
    || metadata.amountMinor !== String(expectedMinor)
    || String(paymentIntent.currency || '').toUpperCase() !== transaction.currency
  ) {
    throw walletPaymentError('Wallet top-up amount or currency is invalid.', 'TOP_UP_AMOUNT_MISMATCH');
  }
  if (
    !transaction.stripeMode
    || metadata.stripeMode !== transaction.stripeMode
    || !stripeLivemodeMatches(paymentIntent, transaction.stripeMode)
  ) {
    throw walletPaymentError('Wallet top-up Stripe mode is invalid.', 'TOP_UP_MODE_MISMATCH');
  }
  return true;
};

const validateWalletTopUpCheckoutSession = (
  transaction,
  checkoutSession,
  { allowMissingReference = false } = {},
) => {
  const metadata = checkoutSession?.metadata || {};
  const customerId = typeof checkoutSession?.customer === 'string'
    ? checkoutSession.customer
    : checkoutSession?.customer?.id;
  if (
    !transaction
    || transaction.paymentFlow !== 'checkout_session'
    || (
      transaction.stripeSessionId
        ? checkoutSession?.id !== transaction.stripeSessionId
        : !allowMissingReference
    )
    || checkoutSession?.mode !== 'payment'
    || metadata.type !== 'wallet_top_up'
    || metadata.paymentFlow !== 'checkout_session'
    || String(metadata.walletTransactionId || '') !== String(transaction._id || '')
    || String(metadata.userId || '') !== String(transaction.user || '')
  ) {
    throw walletPaymentError('Wallet top-up Checkout ownership is invalid.', 'TOP_UP_TRANSACTION_MISMATCH');
  }
  if (!transaction.stripeCustomerId || customerId !== transaction.stripeCustomerId) {
    throw walletPaymentError('Wallet top-up customer ownership is invalid.', 'TOP_UP_CUSTOMER_MISMATCH');
  }
  if (
    !Number.isSafeInteger(checkoutSession.amount_total)
    || checkoutSession.amount_total !== toStripeMinorUnits(transaction.amount, transaction.currency)
    || String(checkoutSession.currency || '').toUpperCase() !== transaction.currency
  ) {
    throw walletPaymentError('Wallet top-up amount or currency is invalid.', 'TOP_UP_AMOUNT_MISMATCH');
  }
  if (
    !transaction.stripeMode
    || metadata.stripeMode !== transaction.stripeMode
    || !stripeLivemodeMatches(checkoutSession, transaction.stripeMode)
  ) {
    throw walletPaymentError('Wallet top-up Stripe mode is invalid.', 'TOP_UP_MODE_MISMATCH');
  }
  return true;
};

const WALLET_SETUP_RECOVERY_MAX_AGE_MS = 23 * 60 * 60 * 1000;

const walletSetupError = (message, code, statusCode = 503) => (
  walletPaymentError(message, code, statusCode)
);

const walletReferenceField = (paymentFlow) => (
  paymentFlow === 'payment_sheet' ? 'stripePaymentIntentId' : 'stripeSessionId'
);

const walletOtherReferenceField = (paymentFlow) => (
  paymentFlow === 'payment_sheet' ? 'stripeSessionId' : 'stripePaymentIntentId'
);

const missingStringField = (field) => ({
  $or: [
    { [field]: null },
    { [field]: '' },
    { [field]: { $exists: false } },
  ],
});

const walletStripeIdempotencyKey = (transaction) => (
  transaction.paymentFlow === 'payment_sheet'
    ? `wallet-topup-pi:${transaction.stripeMode || STRIPE_MODE}:${transaction._id}`
    : `wallet-topup-checkout:${transaction.stripeMode || STRIPE_MODE}:${transaction._id}`
);

const createNativeWalletTopUpPaymentIntent = (transaction) => {
  if (!stripe) throw walletSetupError('Card payments are not configured.', 'STRIPE_NOT_CONFIGURED');
  const amountMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
  return stripe.paymentIntents.create({
    ...buildCustomerInitiatedPaymentIntentParams({
      amountMinor,
      currency: transaction.currency,
      customerId: transaction.stripeCustomerId,
      receiptEmail: transaction.metadata?.receiptEmail,
      metadata: {
        type: 'wallet_top_up',
        paymentFlow: 'payment_sheet',
        walletTransactionId: String(transaction._id),
        userId: String(transaction.user),
        amountMinor: String(amountMinor),
        currency: transaction.currency,
        stripeMode: transaction.stripeMode || STRIPE_MODE,
      },
    }),
    description: walletTopUpDescription(transaction.amount, transaction.currency),
  }, {
    idempotencyKey: walletStripeIdempotencyKey(transaction),
  });
};

const createHostedWalletTopUpCheckoutSession = (transaction) => {
  if (!stripe) throw walletSetupError('Card payments are not configured.', 'STRIPE_NOT_CONFIGURED');
  const frontendUrl = process.env.FRONTEND_URL || 'https://rozare.com';
  const isMobile = transaction.clientSurface === 'mobile';
  const amountMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
  const metadata = {
    type: 'wallet_top_up',
    walletTransactionId: String(transaction._id),
    userId: String(transaction.user),
    amountMinor: String(amountMinor),
    currency: transaction.currency,
    stripeMode: transaction.stripeMode || STRIPE_MODE,
    paymentFlow: 'checkout_session',
  };
  return stripe.checkout.sessions.create({
    mode: 'payment',
    // Hosted Wallet top-ups are intentionally card-only. This makes a
    // complete/unpaid session terminal and keeps expiry reconciliation safe.
    payment_method_types: ['card'],
    customer: transaction.stripeCustomerId,
    saved_payment_method_options: {
      payment_method_save: 'enabled',
      payment_method_remove: 'disabled',
    },
    payment_intent_data: { metadata },
    client_reference_id: String(transaction._id),
    line_items: [{
      price_data: {
        currency: transaction.currency.toLowerCase(),
        product_data: {
          name: 'Rozare Wallet top-up',
          description: 'Balance added to your Rozare Wallet after payment confirmation.',
        },
        unit_amount: amountMinor,
      },
      quantity: 1,
    }],
    success_url: isMobile
      ? `rozare://wallet?top_up=success&transactionId=${transaction._id}&session_id={CHECKOUT_SESSION_ID}`
      : `${frontendUrl}/user-dashboard/wallet?top_up=success&transactionId=${transaction._id}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: isMobile
      ? `rozare://wallet?top_up=cancelled&transactionId=${transaction._id}`
      : `${frontendUrl}/user-dashboard/wallet?top_up=cancelled&transactionId=${transaction._id}`,
    expires_at: Math.floor(new Date(transaction.paymentExpiresAt).getTime() / 1000),
    metadata,
  }, {
    idempotencyKey: walletStripeIdempotencyKey(transaction),
  });
};

const claimWalletTopUpSetup = async (transaction) => {
  if (!transaction || transaction.type !== 'top_up') {
    throw walletSetupError('Wallet top-up setup was not found.', 'TOP_UP_TRANSACTION_NOT_FOUND', 404);
  }
  const referenceField = walletReferenceField(transaction.paymentFlow);
  const otherReferenceField = walletOtherReferenceField(transaction.paymentFlow);
  if (transaction[referenceField]) return transaction;
  if (transaction.status !== 'pending') {
    throw walletSetupError('This Wallet top-up attempt is already closed.', 'WALLET_TOP_UP_RETRY_REQUIRED', 409);
  }
  if (transaction.paymentSetupState === 'creating' && !transaction.paymentSetupStartedAt) {
    throw walletSetupError(
      'This Wallet top-up has no trustworthy Stripe replay window and requires reconciliation.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
    );
  }

  const startedAt = transaction.paymentSetupStartedAt || new Date();
  const claimed = await WalletTransaction.findOneAndUpdate(
    {
      _id: transaction._id,
      user: transaction.user,
      type: 'top_up',
      status: 'pending',
      paymentFlow: transaction.paymentFlow,
      paymentSetupState: { $in: ['not_started', 'creating'] },
      $and: [
        missingStringField(referenceField),
        missingStringField(otherReferenceField),
      ],
    },
    {
      $set: {
        paymentSetupState: 'creating',
        paymentSetupStartedAt: startedAt,
      },
    },
    { new: true, runValidators: true, context: 'query' },
  );
  if (claimed) return claimed;

  const current = await WalletTransaction.findById(transaction._id);
  if (current?.[referenceField]) return current;
  if (!current || current.status !== 'pending' || current.paymentSetupState === 'closed') {
    throw walletSetupError(
      'This Wallet top-up attempt was closed before Stripe setup began.',
      'WALLET_TOP_UP_RETRY_REQUIRED',
      409,
    );
  }
  throw walletSetupError(
    'Secure Wallet top-up setup is being recovered. Retry with the same requestKey.',
    'PAYMENT_ATTEMPT_RECOVERY_PENDING',
  );
};

const attachStripeWalletTopUpReference = async ({ transaction, stripeObject, paymentFlow }) => {
  if (!transaction || !['payment_sheet', 'checkout_session'].includes(paymentFlow)) {
    throw walletSetupError('Wallet top-up setup is invalid.', 'TOP_UP_TRANSACTION_MISMATCH', 400);
  }
  const referenceField = walletReferenceField(paymentFlow);
  const otherReferenceField = walletOtherReferenceField(paymentFlow);
  const validate = paymentFlow === 'payment_sheet'
    ? validateWalletTopUpPaymentIntent
    : validateWalletTopUpCheckoutSession;

  if (transaction[referenceField]) {
    validate(transaction, stripeObject);
    return transaction;
  }
  if (transaction.paymentFlow !== paymentFlow || transaction.paymentSetupState !== 'creating') {
    throw walletSetupError(
      'This Stripe Wallet reference cannot be attached in the current setup state.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
    );
  }
  validate(transaction, stripeObject, { allowMissingReference: true });

  const attachedAt = new Date();
  const attached = await WalletTransaction.findOneAndUpdate(
    {
      _id: transaction._id,
      user: transaction.user,
      type: 'top_up',
      status: 'pending',
      paymentFlow,
      paymentSetupState: 'creating',
      stripeCustomerId: transaction.stripeCustomerId,
      stripeMode: transaction.stripeMode,
      $and: [
        missingStringField(referenceField),
        missingStringField(otherReferenceField),
      ],
    },
    {
      $set: {
        [referenceField]: stripeObject.id,
        paymentSetupState: 'ready',
        paymentSetupCompletedAt: attachedAt,
      },
    },
    { new: true, runValidators: true, context: 'query' },
  );
  if (attached) return attached;

  // A webhook, replay, cancellation, or settlement may have won the atomic
  // attachment race. Accept only the exact same validated external object.
  const current = await WalletTransaction.findById(transaction._id);
  if (current?.[referenceField] === stripeObject.id) {
    validate(current, stripeObject);
    return current;
  }
  throw walletSetupError(
    'Wallet top-up reference attachment requires reconciliation.',
    'PAYMENT_SETUP_RECOVERY_REQUIRED',
  );
};

const closeDefinitivelyRejectedWalletSetup = async (transaction, error) => (
  WalletTransaction.findOneAndUpdate(
    {
      _id: transaction._id,
      user: transaction.user,
      type: 'top_up',
      status: 'pending',
      paymentSetupState: 'creating',
      $and: [
        missingStringField('stripeSessionId'),
        missingStringField('stripePaymentIntentId'),
      ],
    },
    {
      $set: {
        status: 'failed',
        paymentSetupState: 'closed',
        paymentSetupCompletedAt: new Date(),
        failureReason: String(error?.message || error || 'Stripe rejected payment setup.').slice(0, 500),
      },
    },
    { new: true, runValidators: true, context: 'query' },
  )
);

const isDefinitiveWalletTopUpSetupRejection = (error, transaction, now = new Date()) => {
  // Authentication, permission, connection, API, and idempotency errors do
  // not prove that a previous request under this key failed to create an
  // object. Within Stripe's cached idempotency window, only the exact replay's
  // invalid-request response proves that this deterministic request produced
  // no payable object.
  return isAuthoritativeStripeIdempotentReplayRejection(error, {
    createdAt: transaction?.paymentSetupStartedAt,
    now,
  });
};

const recoverWalletTopUpStripeSetup = async (transaction) => {
  const referenceField = walletReferenceField(transaction?.paymentFlow);
  if (transaction?.[referenceField]) {
    const stripeObject = transaction.paymentFlow === 'payment_sheet'
      ? await stripe.paymentIntents.retrieve(transaction.stripePaymentIntentId)
      : await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
    const validate = transaction.paymentFlow === 'payment_sheet'
      ? validateWalletTopUpPaymentIntent
      : validateWalletTopUpCheckoutSession;
    validate(transaction, stripeObject);
    return { transaction, stripeObject, recovered: false };
  }

  const claimed = await claimWalletTopUpSetup(transaction);
  if (claimed[referenceField]) {
    const stripeObject = claimed.paymentFlow === 'payment_sheet'
      ? await stripe.paymentIntents.retrieve(claimed.stripePaymentIntentId)
      : await stripe.checkout.sessions.retrieve(claimed.stripeSessionId);
    const validate = claimed.paymentFlow === 'payment_sheet'
      ? validateWalletTopUpPaymentIntent
      : validateWalletTopUpCheckoutSession;
    validate(claimed, stripeObject);
    return { transaction: claimed, stripeObject, recovered: false };
  }
  const startedAt = new Date(claimed.paymentSetupStartedAt || claimed.updatedAt || Date.now()).getTime();
  const setupAge = Date.now() - startedAt;
  if (!Number.isFinite(setupAge) || setupAge < 0 || setupAge > WALLET_SETUP_RECOVERY_MAX_AGE_MS) {
    throw walletSetupError(
      'This Wallet top-up setup is too old for safe automatic Stripe replay and requires reconciliation.',
      'PAYMENT_SETUP_RECOVERY_REQUIRED',
    );
  }

  let stripeObject;
  try {
    stripeObject = claimed.paymentFlow === 'payment_sheet'
      ? await createNativeWalletTopUpPaymentIntent(claimed)
      : await createHostedWalletTopUpCheckoutSession(claimed);
  } catch (error) {
    if (isDefinitiveWalletTopUpSetupRejection(error, claimed)) {
      const closed = await closeDefinitivelyRejectedWalletSetup(claimed, error);
      if (closed) {
        error.walletSetupDefinitivelyRejected = true;
      } else {
        // A concurrent attachment/settlement may have won. Never report a
        // safe local rejection unless that close transition actually committed.
        error.code = 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
      }
    } else {
      error.code = error.code || 'PAYMENT_ATTEMPT_RECOVERY_PENDING';
    }
    throw error;
  }

  const attached = await attachStripeWalletTopUpReference({
    transaction: claimed,
    stripeObject,
    paymentFlow: claimed.paymentFlow,
  });
  return { transaction: attached, stripeObject, recovered: true };
};

const closeWalletTopUpWithoutStripeReference = async (
  transaction,
  { status = 'cancelled', reason = 'Payment was cancelled.', requireExpired = false, now = new Date() } = {},
) => {
  if (!transaction || transaction.type !== 'top_up') return null;
  if (transaction.stripeSessionId || transaction.stripePaymentIntentId) {
    return { status: 'reference_attached', transaction };
  }
  if (transaction.status !== 'pending') return { status: 'already_closed', transaction };
  if (requireExpired && (!transaction.paymentExpiresAt || transaction.paymentExpiresAt > now)) {
    return { status: 'not_expired', transaction };
  }

  const safeStatus = ['cancelled', 'expired', 'failed'].includes(status) ? status : 'cancelled';
  const closed = await WalletTransaction.findOneAndUpdate(
    {
      _id: transaction._id,
      user: transaction.user,
      type: 'top_up',
      status: 'pending',
      paymentSetupState: 'not_started',
      ...(requireExpired ? { paymentExpiresAt: { $lte: now } } : {}),
      $and: [
        missingStringField('stripeSessionId'),
        missingStringField('stripePaymentIntentId'),
      ],
    },
    {
      $set: {
        status: safeStatus,
        paymentSetupState: 'closed',
        paymentSetupCompletedAt: now,
        failureReason: String(reason).slice(0, 500),
      },
    },
    { new: true, runValidators: true, context: 'query' },
  );
  if (closed) return { status: safeStatus, transaction: closed };

  const current = await WalletTransaction.findById(transaction._id);
  if (!current || current.status !== 'pending') return { status: 'already_closed', transaction: current };
  if (current.stripeSessionId || current.stripePaymentIntentId) {
    return { status: 'reference_attached', transaction: current };
  }
  if (current.paymentSetupState === 'creating') {
    return { status: 'setup_recovery_pending', transaction: current };
  }
  return { status: 'unsafe_without_reference', transaction: current };
};

const settleWalletTopUp = async ({
  transactionId,
  stripeObjectId,
  paymentIntentId,
  chargeId,
  customerId,
  amountMinor,
  currency,
  userId,
  stripeMode,
  eventId,
  sourceField,
  stripeObject,
}) => {
  if (!transactionId) return null;
  const settled = await runInTransaction(async (session) => {
    const transaction = await WalletTransaction.findOne({
      _id: transactionId,
      type: 'top_up',
      [sourceField]: stripeObjectId,
    }).session(session);

    if (!transaction) {
      const error = new Error(`Wallet top-up transaction ${transactionId} was not found.`);
      error.code = 'TOP_UP_TRANSACTION_NOT_FOUND';
      throw error;
    }
    if (transaction.status === 'completed') {
      await enqueueWalletTransactionNotification(transaction, { session });
      return transaction;
    }
    const recoverableRiskBlockedTopUp = (
      transaction.status === 'reversed'
      && transaction.metadata?.paymentRiskBlockedBeforeCompletion === true
      && transaction.paymentSetupState === 'closed'
    );
    if (!recoverableRiskBlockedTopUp && !['pending', 'failed', 'cancelled', 'expired'].includes(transaction.status)) {
      const error = new Error(`Wallet top-up cannot complete from status ${transaction.status}.`);
      error.code = 'INVALID_TOP_UP_STATUS';
      throw error;
    }

    const expectedMinor = toStripeMinorUnits(transaction.amount, transaction.currency);
    const receivedCurrency = String(currency || '').toUpperCase();
    if (!Number.isSafeInteger(amountMinor) || amountMinor !== expectedMinor || receivedCurrency !== transaction.currency) {
      throw walletPaymentError(
        'Stripe top-up amount or currency did not match the stored transaction.',
        'TOP_UP_AMOUNT_MISMATCH',
      );
    }
    if (String(userId || '') !== String(transaction.user)) {
      throw walletPaymentError('Stripe top-up user ownership is invalid.', 'TOP_UP_USER_MISMATCH');
    }
    if (transaction.stripeCustomerId && String(customerId || '') !== transaction.stripeCustomerId) {
      throw walletPaymentError('Stripe top-up customer ownership is invalid.', 'TOP_UP_CUSTOMER_MISMATCH');
    }
    const expectedMode = transaction.stripeMode || stripeMode || STRIPE_MODE;
    if (
      (transaction.paymentFlow === 'payment_sheet' && stripeMode !== expectedMode)
      || (transaction.paymentFlow !== 'payment_sheet' && stripeMode && stripeMode !== expectedMode)
    ) {
      throw walletPaymentError('Stripe top-up mode is invalid.', 'TOP_UP_MODE_MISMATCH');
    }
    if (!stripeLivemodeMatches(stripeObject, expectedMode)) {
      throw walletPaymentError('Stripe top-up live mode is invalid.', 'TOP_UP_MODE_MISMATCH');
    }

    try {
      await claimStripePaymentCompletion({
        paymentIntentId,
        sourceType: 'wallet_top_up',
        sourceReferenceId: transaction._id,
        eventId,
        session,
      });
    } catch (error) {
      if (error?.code !== 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION') throw error;
      transaction.status = 'reversed';
      transaction.paymentSetupState = 'closed';
      transaction.paymentSetupCompletedAt = new Date();
      transaction.stripePaymentIntentId = paymentIntentId || transaction.stripePaymentIntentId || null;
      transaction.stripeChargeId = chargeId || transaction.stripeChargeId || null;
      transaction.stripeCustomerId = customerId || transaction.stripeCustomerId || null;
      transaction.stripeWebhookEventId = eventId || transaction.stripeWebhookEventId || null;
      transaction.failureReason = 'Stripe reversed this card payment before Wallet credit completed.';
      transaction.metadata = {
        ...(transaction.metadata || {}),
        paymentRiskBlockedBeforeCompletion: true,
      };
      await transaction.save({ session });
      return transaction;
    }

    const wallet = await ensureWallet(transaction.user, session);
    readStoredWalletBalance(wallet, transaction.currency);
    const topUpAmount = readStoredTransactionMoney(transaction, 'amount', { positive: true });
    const topUpMinorUnits = toMinorUnits(topUpAmount);
    // Stripe has already captured the money. Credit even if an operational
    // lock was added while payment was in flight; the lock still prevents use.
    const creditResult = await applyIncomingWalletCredit({
      walletId: wallet._id,
      currency: transaction.currency,
      creditMinor: topUpMinorUnits,
      session,
    });
    const updatedWallet = creditResult.wallet;

    transaction.wallet = wallet._id;
    transaction.status = 'completed';
    transaction.balanceAfter = readStoredWalletBalance(updatedWallet, transaction.currency);
    transaction.stripePaymentIntentId = paymentIntentId || transaction.stripePaymentIntentId || null;
    transaction.stripeChargeId = chargeId || transaction.stripeChargeId || null;
    transaction.stripeCustomerId = customerId || transaction.stripeCustomerId || null;
    transaction.stripeWebhookEventId = eventId || transaction.stripeWebhookEventId || null;
    transaction.failureReason = '';
    transaction.completedAt = new Date();
    transaction.paymentSetupState = 'complete';
    transaction.paymentSetupCompletedAt = transaction.completedAt;
    transaction.metadata = {
      ...(transaction.metadata || {}),
      liabilityAppliedMinor: creditResult.appliedMinor,
      availableCreditedMinor: creditResult.creditedMinor,
      remainingLiabilityMinor: creditResult.remainingLiabilityMinor,
      fundingOriginalAvailableMinor: creditResult.creditedMinor,
      fundingRemainingMinor: creditResult.creditedMinor,
      ...(recoverableRiskBlockedTopUp ? {
        paymentRiskBlockedBeforeCompletionResolved: true,
        paymentRiskBlockedBeforeCompletionResolvedAt: new Date(),
        paymentRiskRecoveryEventId: eventId || null,
      } : {}),
    };
    await transaction.save({ session });
    await enqueueWalletTransactionNotification(transaction, { session });
    await markStripePaymentCompletionDone({
      paymentIntentId,
      sourceType: 'wallet_top_up',
      sourceReferenceId: transaction._id,
      session,
    });
    return transaction;
  });
  if (settled?.status === 'reversed' && settled?.metadata?.paymentRiskBlockedBeforeCompletion) {
    throw markerError(
      'Stripe reversed this Wallet top-up before completion. No Wallet balance was added.',
      'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION',
    );
  }
  return settled;
};

const attachWalletTopUpFromStripeObject = async (stripeObject, paymentFlow) => {
  const metadata = stripeObject?.metadata || {};
  if (
    metadata.type !== 'wallet_top_up'
    || metadata.paymentFlow !== paymentFlow
    || !metadata.walletTransactionId
    || !metadata.userId
  ) {
    throw walletPaymentError('Stripe top-up metadata is invalid.', 'TOP_UP_TYPE_MISMATCH');
  }
  const transaction = await WalletTransaction.findOne({
    _id: metadata.walletTransactionId,
    user: metadata.userId,
    type: 'top_up',
    paymentFlow,
  });
  if (!transaction) {
    throw walletPaymentError('Wallet top-up ownership is invalid.', 'TOP_UP_TRANSACTION_NOT_FOUND');
  }
  return attachStripeWalletTopUpReference({ transaction, stripeObject, paymentFlow });
};

const completeWalletTopUp = async (stripeSession, eventId = null) => {
  if (stripeSession?.payment_status !== 'paid') {
    throw walletPaymentError('Stripe has not marked this wallet top-up as paid.', 'TOP_UP_NOT_PAID', 409);
  }
  if (
    stripeSession.metadata?.type !== 'wallet_top_up'
    || stripeSession.metadata?.paymentFlow !== 'checkout_session'
  ) {
    throw walletPaymentError('Stripe top-up metadata type is invalid.', 'TOP_UP_TYPE_MISMATCH');
  }
  await attachWalletTopUpFromStripeObject(stripeSession, 'checkout_session');
  return settleWalletTopUp({
    transactionId: stripeSession?.metadata?.walletTransactionId,
    stripeObjectId: stripeSession?.id,
    paymentIntentId: typeof stripeSession?.payment_intent === 'string'
      ? stripeSession.payment_intent
      : stripeSession?.payment_intent?.id,
    chargeId: null,
    customerId: typeof stripeSession?.customer === 'string'
      ? stripeSession.customer
      : stripeSession?.customer?.id,
    amountMinor: stripeSession?.amount_total,
    currency: stripeSession?.currency,
    userId: stripeSession?.metadata?.userId,
    stripeMode: stripeSession?.metadata?.stripeMode,
    eventId,
    sourceField: 'stripeSessionId',
    stripeObject: stripeSession,
  });
};

const completeWalletTopUpFromPaymentIntent = async (paymentIntent, eventId = null) => {
  if (paymentIntent?.status !== 'succeeded') {
    throw walletPaymentError('Stripe has not confirmed this Wallet top-up.', 'TOP_UP_NOT_PAID', 409);
  }
  if (
    paymentIntent.metadata?.type !== 'wallet_top_up'
    || paymentIntent.metadata?.paymentFlow !== 'payment_sheet'
  ) {
    throw walletPaymentError('Stripe top-up metadata is invalid.', 'TOP_UP_TYPE_MISMATCH');
  }
  const amountReceived = paymentIntent.amount_received;
  if (
    !Number.isSafeInteger(amountReceived)
    || amountReceived < 0
    || !Number.isSafeInteger(paymentIntent.amount)
    || paymentIntent.amount < 0
    || amountReceived !== paymentIntent.amount
  ) {
    throw walletPaymentError('Stripe did not capture the complete Wallet top-up.', 'TOP_UP_AMOUNT_MISMATCH');
  }
  await attachWalletTopUpFromStripeObject(paymentIntent, 'payment_sheet');
  return settleWalletTopUp({
    transactionId: paymentIntent.metadata.walletTransactionId,
    stripeObjectId: paymentIntent.id,
    paymentIntentId: paymentIntent.id,
    chargeId: typeof paymentIntent.latest_charge === 'string'
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id,
    customerId: typeof paymentIntent.customer === 'string'
      ? paymentIntent.customer
      : paymentIntent.customer?.id,
    amountMinor: amountReceived,
    currency: paymentIntent.currency,
    userId: paymentIntent.metadata.userId,
    stripeMode: paymentIntent.metadata.stripeMode,
    eventId,
    sourceField: 'stripePaymentIntentId',
    stripeObject: paymentIntent,
  });
};

const recoverRiskBlockedWalletTopUpCompletion = async ({
  paymentIntentId,
  eventId = null,
}) => {
  const transaction = await WalletTransaction.findOne({
    type: 'top_up',
    stripePaymentIntentId: paymentIntentId,
  });
  if (!transaction) return { recovered: false, reason: 'not_found' };
  if (transaction.status === 'completed') {
    return { recovered: true, alreadyCompleted: true, transaction };
  }
  if (
    transaction.metadata?.paymentRiskBlockedBeforeCompletion !== true
    && transaction.status !== 'pending'
  ) {
    return { recovered: false, reason: 'not_recoverable', transaction };
  }
  if (!stripe) return { recovered: false, deferred: true, reason: 'stripe_unavailable', transaction };
  const recoveryEventId = eventId ? `wallet-risk-recovery:${eventId}` : null;
  if (transaction.paymentFlow === 'checkout_session') {
    if (!transaction.stripeSessionId) {
      throw walletPaymentError(
        'A hosted Wallet top-up cannot recover without its Checkout Session.',
        'TOP_UP_RECOVERY_REFERENCE_MISSING',
        503,
      );
    }
    const checkoutSession = await stripe.checkout.sessions.retrieve(transaction.stripeSessionId);
    const sessionPaymentIntentId = typeof checkoutSession?.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : checkoutSession?.payment_intent?.id;
    if (sessionPaymentIntentId !== paymentIntentId) {
      throw walletPaymentError(
        'The recovered Checkout Session belongs to a different PaymentIntent.',
        'TOP_UP_TRANSACTION_MISMATCH',
      );
    }
    return {
      recovered: true,
      transaction: await completeWalletTopUp(checkoutSession, recoveryEventId),
    };
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  return {
    recovered: true,
    transaction: await completeWalletTopUpFromPaymentIntent(paymentIntent, recoveryEventId),
  };
};

const failWalletTopUp = async (
  stripeSession,
  reason = 'Stripe checkout expired or failed.',
  eventId = null,
) => {
  const transactionId = stripeSession?.metadata?.walletTransactionId;
  if (!transactionId) return null;
  const transaction = await attachWalletTopUpFromStripeObject(stripeSession, 'checkout_session');
  const status = stripeSession?.status === 'expired' ? 'expired' : 'failed';
  return WalletTransaction.findOneAndUpdate(
    { _id: transaction._id, type: 'top_up', status: 'pending', stripeSessionId: stripeSession.id },
    {
      $set: {
        status,
        paymentSetupState: 'closed',
        paymentSetupCompletedAt: new Date(),
        failureReason: String(reason).slice(0, 500),
        ...(eventId ? { stripeWebhookEventId: eventId } : {}),
      },
    },
    { new: true, runValidators: true, context: 'query' }
  );
};

const recordWalletTopUpPaymentFailure = async (paymentIntent, eventId = null) => {
  if (
    paymentIntent?.metadata?.type !== 'wallet_top_up'
    || paymentIntent?.metadata?.paymentFlow !== 'payment_sheet'
  ) return null;
  const transaction = await attachWalletTopUpFromStripeObject(paymentIntent, 'payment_sheet');

  // A failed attempt can return to requires_payment_method and then succeed.
  // Keep the transaction pending and reusable until explicit cancel/expiry.
  return WalletTransaction.findOneAndUpdate(
    { _id: transaction._id, type: 'top_up', status: 'pending', stripePaymentIntentId: paymentIntent.id },
    {
      $set: {
        failureReason: String(
          paymentIntent.last_payment_error?.message || 'The card was declined. Try another payment method.'
        ).slice(0, 500),
        ...(eventId ? { stripeWebhookEventId: eventId } : {}),
      },
    },
    { new: true, runValidators: true, context: 'query' },
  );
};

const cancelWalletTopUpFromPaymentIntent = async (
  paymentIntent,
  { eventId = null, status = 'cancelled', reason = 'Payment was cancelled.' } = {},
) => {
  if (
    paymentIntent?.metadata?.type !== 'wallet_top_up'
    || paymentIntent?.metadata?.paymentFlow !== 'payment_sheet'
  ) return null;
  const transaction = await attachWalletTopUpFromStripeObject(paymentIntent, 'payment_sheet');
  const closed = await WalletTransaction.findOneAndUpdate(
    {
      _id: transaction._id,
      status: 'pending',
    },
    {
      $set: {
        status,
        paymentSetupState: 'closed',
        paymentSetupCompletedAt: new Date(),
        failureReason: String(reason).slice(0, 500),
        ...(eventId ? { stripeWebhookEventId: eventId } : {}),
      },
    },
    { new: true, runValidators: true, context: 'query' },
  );
  return closed || WalletTransaction.findById(transaction._id);
};

const payOrderWithWallet = async ({ orderId, userId, session: existingSession = null }) => runInTransaction(async (session) => {
  const order = await Order.findOne({ _id: orderId, user: userId }).session(session);
  if (!order) {
    const error = new Error('Order not found.');
    error.statusCode = 404;
    throw error;
  }
  if (order.paymentMethod !== 'wallet') {
    const error = new Error('This order is not configured for wallet payment.');
    error.statusCode = 400;
    throw error;
  }
  if (order.isPaid && !order.awaitingPayment) {
    const existingSettlement = await ensureOrderSellerSettlement(order, {
      session,
      requireOrderTotal: true,
    });
    await enqueuePaidOrderBuyerNotifications(order, { session });
    for (const sellerId of [...new Set(
      (existingSettlement || []).map(entry => String(entry?.seller || '')).filter(Boolean)
    )]) {
      await enqueuePaidOrderSellerNotifications(order, sellerId, { session });
    }
    return order;
  }
  if (order.orderStatus === 'cancelled' || order.confirmation?.declinedAt) {
    const error = new Error('This order was cancelled and can no longer be paid.');
    error.statusCode = 409;
    error.code = 'ORDER_CANCELLED';
    throw error;
  }
  if (!order.awaitingPayment) {
    const error = new Error('This order is not awaiting Wallet payment.');
    error.statusCode = 409;
    error.code = 'ORDER_NOT_AWAITING_PAYMENT';
    throw error;
  }

  // Strict persisted totals, coupon ownership, seller ownership, and frozen
  // currency allocation are financial preconditions even when every Wallet
  // cent happens to come from legacy/untracked funds.
  const settlement = await ensureOrderSellerSettlement(order, {
    session,
    requireOrderTotal: true,
  });

  const transaction = await debitWalletInSession({
    userId,
    amount: order.orderSummary.totalAmount,
    currency: order.currency,
    type: 'order_payment',
    referenceType: 'order',
    referenceId: order._id,
    idempotencyKey: `wallet-order:${order._id}`,
    description: `Payment for order ${order.orderId}`,
    metadata: { orderId: order.orderId },
  }, session);

  if (Array.isArray(transaction.metadata?.fundingProvenance)) {
    transaction.metadata.fundingProvenance = allocateFundingProvenanceToSellerSettlement({
      fundingProvenance: transaction.metadata.fundingProvenance,
      settlementEntries: settlement,
      orderId: order._id,
    });
    transaction.markModified('metadata');
    await transaction.save({ session });
  }

  if (!order.inventoryCommitted) {
    for (const item of order.orderItems || []) {
      const result = await Product.updateOne(
        { _id: item.productId, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity, totalSales: item.quantity } },
        { session }
      );
      if (result.modifiedCount !== 1) {
        const error = new Error(`There is no longer enough stock for ${item.name || 'an item'} in this order.`);
        error.statusCode = 409;
        error.code = 'ORDER_STOCK_CHANGED';
        throw error;
      }
    }
    order.inventoryCommitted = true;
  }

  order.awaitingPayment = false;
  order.isPaid = true;
  order.paidAt = new Date();
  order.orderStatus = 'confirmed';
  for (const fulfillment of order.sellerFulfillment || []) {
    if (fulfillment.status === 'pending') {
      fulfillment.status = 'confirmed';
      fulfillment.updatedAt = new Date();
    }
  }
  order.paymentResult = order.paymentResult || {};
  order.paymentResult.walletTransactionId = transaction._id;
  order.paymentFulfilledAt = order.paymentFulfilledAt || new Date();
  order.confirmation = order.confirmation || {};
  order.confirmation.confirmedAt = order.confirmation.confirmedAt || new Date();
  order.confirmation.confirmedVia = 'wallet_payment';
  await order.save({ session });
  await enqueuePaidOrderBuyerNotifications(order, { session });
  for (const sellerId of [...new Set(
    (settlement || []).map(entry => String(entry?.seller || '')).filter(Boolean)
  )]) {
    await enqueuePaidOrderSellerNotifications(order, sellerId, { session });
  }
  if (order.appliedCoupons?.length) {
    await consumeOrderCoupons({ orderId: order._id, session });
  }
  return order;
}, existingSession);

const getWalletSummary = async (userId, { limit = 50 } = {}) => {
  const wallet = await ensureWallet(userId);
  // Risk classification can consume legacy balance and change the Wallet lock
  // inside its own transaction. Read the presentation Wallet only after that
  // accounting commits; returning the pre-classification document would show
  // stale spendable funds while correctly reporting `restricted: true`.
  const paymentRisk = await getWalletPaymentRiskSummary(wallet._id);
  const [transactions, authoritativeWallet] = await Promise.all([
    WalletTransaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
      .lean(),
    Wallet.findById(wallet._id),
  ]);
  const currentWallet = authoritativeWallet || wallet;
  return {
    wallet: {
      _id: currentWallet._id,
      balances: {
        USD: readStoredWalletBalance(currentWallet, 'USD'),
        PKR: readStoredWalletBalance(currentWallet, 'PKR'),
        EUR: readStoredWalletBalance(currentWallet, 'EUR'),
        GBP: readStoredWalletBalance(currentWallet, 'GBP'),
      },
      status: currentWallet.status,
      lockedReason: currentWallet.lockedReason || '',
      lockSource: currentWallet.lockSource || null,
      updatedAt: currentWallet.updatedAt,
      paymentRisk: {
        restricted: paymentRisk.restricted,
        provisionalCount: paymentRisk.provisionalCount,
        byCurrency: paymentRisk.byCurrency,
        canTopUpForSettlement: paymentRisk.outstandingMinor > 0
          && isWalletPaymentRiskLock(currentWallet),
      },
    },
    transactions: transactions.map(serializeWalletTransaction),
  };
};

const reconcileWalletPaymentLiability = async ({
  userId,
  adminId,
  amount,
  currency,
  action,
  note,
  idempotencyKey,
}) => {
  const normalizedCurrency = normalizeWalletCurrency(currency);
  const normalizedAmount = normalizeWalletMoneyInput(amount, 'Wallet liability amount');
  const amountMinor = toMinorUnits(normalizedAmount);
  if (amountMinor <= 0 || !['external_collection', 'write_off'].includes(action)) {
    throw walletPaymentError(
      'Enter a valid liability amount and resolution action.',
      'WALLET_LIABILITY_RESOLUTION_INVALID',
    );
  }
  if (!idempotencyKey) {
    throw walletPaymentError(
      'An idempotency key is required for Wallet liability reconciliation.',
      'IDEMPOTENCY_KEY_REQUIRED',
    );
  }
  const reconciliationFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    userId: String(userId),
    currency: normalizedCurrency,
    amountMinor,
    action,
  })).digest('hex');
  const assertMatchingReconciliation = existing => {
    if (!existing) return null;
    const legacyMatches = (
      String(existing.user) === String(userId)
      && existing.currency === normalizedCurrency
      && toMinorUnits(existing.amount) === amountMinor
      && existing.metadata?.action === action
      && existing.metadata?.paymentRiskResolution === true
    );
    const persistedFingerprint = String(existing.metadata?.reconciliationFingerprint || '');
    if (
      (persistedFingerprint && persistedFingerprint !== reconciliationFingerprint)
      || (!persistedFingerprint && !legacyMatches)
    ) {
      throw walletPaymentError(
        'This idempotency key was already used for different Wallet liability details.',
        'IDEMPOTENCY_CONFLICT',
        409,
      );
    }
    return existing;
  };
  const execute = () => runInTransaction(async session => {
    const existing = await WalletTransaction.findOne({ idempotencyKey }).session(session);
    if (existing) return assertMatchingReconciliation(existing);
    const wallet = await ensureWallet(userId, session);
    readStoredWalletBalance(wallet, normalizedCurrency);
    const resolution = await applyAdminWalletLiabilityResolution({
      walletId: wallet._id,
      currency: normalizedCurrency,
      amountMinor,
      action,
      session,
    });
    const [audit] = await WalletTransaction.create([{
      user: userId,
      wallet: wallet._id,
      type: 'admin_adjustment',
      direction: 'debit',
      status: 'completed',
      amount: normalizedAmount,
      currency: normalizedCurrency,
      balanceAfter: readStoredWalletBalance(resolution.wallet, normalizedCurrency),
      description: String(note || (
        action === 'write_off'
          ? 'Admin wrote off terminal Stripe Wallet liability.'
          : 'Admin recorded external collection of terminal Stripe Wallet liability.'
      )).trim().slice(0, 300),
      referenceType: 'admin',
      referenceId: String(idempotencyKey),
      idempotencyKey: String(idempotencyKey),
      metadata: {
        paymentRiskResolution: true,
        action,
        adminId: String(adminId),
        resolvedMinor: amountMinor,
        reconciliationFingerprint,
        remainingLiabilityMinor: resolution.summary.byCurrency[normalizedCurrency]?.outstandingMinor ?? 0,
      },
      completedAt: new Date(),
    }], { session });
    return audit;
  });
  try {
    return await execute();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Two exact requests may race at the unique ledger key. The losing Mongo
    // transaction is rolled back (including liability mutations), then binds
    // to the committed payload or rejects a different payload with 409.
    const existing = await WalletTransaction.findOne({ idempotencyKey });
    if (!existing) {
      throw walletPaymentError(
        'The Wallet liability reconciliation raced with another request. Retry safely with the same idempotency key.',
        'WALLET_LIABILITY_RECONCILIATION_RETRY',
        503,
      );
    }
    return assertMatchingReconciliation(existing);
  }
};

const serializeWalletTransaction = (transaction) => {
  const amount = readStoredTransactionMoney(transaction, 'amount', { positive: true });
  const balanceAfter = readStoredTransactionMoney(transaction, 'balanceAfter', { nullable: true });
  let currency;
  try {
    currency = requireStoredWalletCurrency(transaction?.currency);
  } catch (_error) {
    throw walletPaymentError(
      'Stored Wallet transaction currency is invalid.',
      'WALLET_TRANSACTION_MONEY_INVALID',
      503,
    );
  }
  const availableCreditedMinor = readOptionalTransactionMinor(transaction, 'availableCreditedMinor');
  const liabilityAppliedMinor = readOptionalTransactionMinor(transaction, 'liabilityAppliedMinor');
  const remainingLiabilityMinor = readOptionalTransactionMinor(transaction, 'remainingLiabilityMinor');
  const authoritativeTransaction = { ...transaction, amount, currency };
  return {
    _id: transaction._id,
    type: transaction.type,
    direction: transaction.direction,
    status: transaction.status,
    amount,
    currency,
    balanceAfter,
    description: getWalletTransactionDescription(authoritativeTransaction),
    referenceType: transaction.referenceType,
    failureReason: transaction.failureReason || '',
    completedAt: transaction.completedAt || null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    creditedAmount: fromMinorUnits(availableCreditedMinor),
    appliedToLiability: fromMinorUnits(liabilityAppliedMinor),
    remainingLiability: fromMinorUnits(remainingLiabilityMinor),
  };
};

module.exports = {
  WALLET_CURRENCIES,
  roundMoney,
  normalizeWalletCurrency,
  formatWalletMoney,
  walletTopUpDescription,
  getWalletTransactionDescription,
  toStripeMinorUnits,
  fromStripeMinorUnits,
  atomicBalanceUpdate,
  hasSufficientBalanceExpression,
  runInTransaction,
  ensureWallet,
  creditWalletInSession,
  debitWalletInSession,
  allocateFundingProvenanceToSellerSettlement,
  findOrderForWalletDebit,
  findLegacyWalletFundingCandidateSellerIds,
  historicalReturnIdentity,
  materializeLegacyWalletTopUpFunding,
  completeWalletTopUp,
  completeWalletTopUpFromPaymentIntent,
  recoverRiskBlockedWalletTopUpCompletion,
  failWalletTopUp,
  recordWalletTopUpPaymentFailure,
  cancelWalletTopUpFromPaymentIntent,
  payOrderWithWallet,
  getWalletSummary,
  reconcileWalletPaymentLiability,
  serializeWalletTransaction,
  validateWalletTopUpPaymentIntent,
  validateWalletTopUpCheckoutSession,
  walletStripeIdempotencyKey,
  createNativeWalletTopUpPaymentIntent,
  createHostedWalletTopUpCheckoutSession,
  claimWalletTopUpSetup,
  attachStripeWalletTopUpReference,
  recoverWalletTopUpStripeSetup,
  closeWalletTopUpWithoutStripeReference,
  isDefinitiveWalletTopUpSetupRejection,
};
