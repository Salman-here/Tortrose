'use strict';

const SellerBalanceTransaction = require('../models/SellerBalanceTransaction');
const WalletTransaction = require('../models/WalletTransaction');
const { toMinorUnits } = require('./moneyMath');

const withSession = (query, session) => (session ? query.session(session) : query);

const provenanceError = (message, code = 'WALLET_FUNDING_PROVENANCE_INVALID', statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const roundProductRatio = (left, right, denominator) => {
  if (!Number.isSafeInteger(left) || left < 0
    || !Number.isSafeInteger(right) || right < 0
    || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw provenanceError('Returned Wallet funding contains an invalid ratio.');
  }
  const denominatorBig = BigInt(denominator);
  const numerator = BigInt(left) * BigInt(right);
  const rounded = (numerator * 2n + denominatorBig) / (denominatorBig * 2n);
  const numeric = Number(rounded);
  if (!Number.isSafeInteger(numeric)) {
    throw provenanceError('Returned Wallet funding is too large to calculate safely.');
  }
  return numeric;
};

/** Fail closed when a Wallet-paid order contains card-top-up principal which
 * Stripe has already refunded or financially disputed. Crediting another
 * Wallet return refund would otherwise pay the buyer twice and debit a seller
 * whose original revenue has already been removed/reserved. */
const assertWalletOrderFundingReturnable = async ({ orderId, session = null }) => {
  const orderPayment = await withSession(WalletTransaction.findOne({
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    referenceId: String(orderId),
  }), session);
  const sourceIds = [...new Set((orderPayment?.metadata?.fundingProvenance || [])
    .filter(entry => entry?.sourceType === 'wallet_top_up')
    .map(entry => String(entry?.sourceTransactionId || ''))
    .filter(Boolean))];
  if (!sourceIds.length) return { returnable: true, sourceIds: [] };

  const [buyerRisk, sellerRisk] = await Promise.all([
    withSession(WalletTransaction.exists({
      type: 'reversal',
      direction: 'debit',
      status: { $in: ['pending', 'completed'] },
      'metadata.sourceType': 'wallet_top_up',
      'metadata.sourcePaymentTransactionId': { $in: sourceIds },
      $or: [
        { 'metadata.refundExposureMinor': { $gt: 0 } },
        { 'metadata.riskTrack': 'dispute' },
      ],
    }), session),
    withSession(SellerBalanceTransaction.exists({
      type: 'reversal',
      status: { $in: ['reserved', 'completed'] },
      'metadata.sourceType': 'wallet_top_up',
      'metadata.sourceReferenceId': { $in: sourceIds },
    }), session),
  ]);
  if (buyerRisk || sellerRisk) {
    const error = new Error(
      'This order was funded by a card top-up that Stripe has reversed. A second Wallet refund is blocked for payment review.',
    );
    error.statusCode = 409;
    error.code = 'RETURN_EXTERNAL_FUNDING_REVERSAL';
    error.sourceTransactionIds = sourceIds;
    throw error;
  }
  return { returnable: true, sourceIds };
};

/**
 * Move exact top-up-funded seller principal back to the buyer when a return is
 * completed. The original order provenance remains append-only; this return
 * credit appends a counter-movement. Later top-up risk snapshots net the two,
 * so the seller cannot be debited twice and any re-spend follows the restored
 * top-up lot to its new seller.
 */
const attachReturnedWalletFundingProvenance = async ({
  walletTransaction,
  orderId,
  sellerId,
  returnRequestId,
  refundAmount,
  currency,
  session,
}) => {
  if (!walletTransaction) {
    throw provenanceError('The Wallet return credit is missing.', 'WALLET_RETURN_CREDIT_MISSING', 500);
  }
  const existingMovements = walletTransaction.metadata?.fundingProvenanceReturns;
  if (Array.isArray(existingMovements)) return existingMovements;
  const normalizedSeller = String(sellerId || '');
  const normalizedOrder = String(orderId || '');
  const normalizedReturn = String(returnRequestId || walletTransaction.referenceId || '');
  const normalizedCurrency = String(currency || walletTransaction.currency || '').toUpperCase();
  if (typeof refundAmount !== 'number' || !Number.isFinite(refundAmount)) {
    throw provenanceError('The returned Wallet funding amount is invalid.');
  }
  const refundMinor = toMinorUnits(refundAmount);
  if (!normalizedSeller || !normalizedOrder || !normalizedReturn || refundMinor <= 0) {
    throw provenanceError('The returned Wallet funding identity is incomplete.');
  }
  if (String(walletTransaction.currency || '').toUpperCase() !== normalizedCurrency) {
    throw provenanceError('The Wallet return credit currency does not match its order.');
  }

  const orderPayment = await withSession(WalletTransaction.findOne({
    type: 'order_payment',
    direction: 'debit',
    status: 'completed',
    referenceId: normalizedOrder,
    currency: normalizedCurrency,
  }), session);
  const originalLots = new Map();
  for (const provenance of orderPayment?.metadata?.fundingProvenance || []) {
    if (provenance?.sourceType !== 'wallet_top_up') continue;
    const sourceTransactionId = String(provenance?.sourceTransactionId || '');
    if (!sourceTransactionId) continue;
    for (const allocation of provenance?.sellerAllocations || []) {
      if (String(allocation?.seller || '') !== normalizedSeller) continue;
      const sourceAmountMinor = allocation?.sourceAmountMinor;
      const amountUSDMinor = allocation?.amountUSDMinor;
      if (
        typeof sourceAmountMinor !== 'number'
        || !Number.isSafeInteger(sourceAmountMinor) || sourceAmountMinor < 0
        || typeof amountUSDMinor !== 'number'
        || !Number.isSafeInteger(amountUSDMinor) || amountUSDMinor < 0
      ) {
        throw provenanceError('The original Wallet seller funding is malformed.');
      }
      const current = originalLots.get(sourceTransactionId) || {
        sourceTransactionId,
        sourceAmountMinor: 0,
        amountUSDMinor: 0,
      };
      current.sourceAmountMinor += sourceAmountMinor;
      current.amountUSDMinor += amountUSDMinor;
      if (!Number.isSafeInteger(current.sourceAmountMinor) || !Number.isSafeInteger(current.amountUSDMinor)) {
        throw provenanceError('The original Wallet seller funding is too large.');
      }
      originalLots.set(sourceTransactionId, current);
    }
  }
  if (!originalLots.size) {
    walletTransaction.metadata = {
      ...(walletTransaction.metadata || {}),
      fundingProvenanceReturns: [],
    };
    walletTransaction.markModified('metadata');
    await walletTransaction.save({ session });
    return [];
  }

  const priorRows = await withSession(WalletTransaction.find({
    _id: { $ne: walletTransaction._id },
    type: 'return_refund',
    direction: 'credit',
    status: 'completed',
    currency: normalizedCurrency,
    'metadata.fundingProvenanceReturns': {
      $elemMatch: { orderId: normalizedOrder, seller: normalizedSeller },
    },
  }).sort({ completedAt: 1, _id: 1 }), session);
  const priorBySource = new Map();
  for (const row of priorRows) {
    for (const movement of row?.metadata?.fundingProvenanceReturns || []) {
      if (
        String(movement?.orderId || '') !== normalizedOrder
        || String(movement?.seller || '') !== normalizedSeller
      ) continue;
      const sourceTransactionId = String(movement?.sourceTransactionId || '');
      const amountMinor = movement?.amountMinor;
      const amountUSDMinor = movement?.amountUSDMinor;
      if (
        !originalLots.has(sourceTransactionId)
        || typeof amountMinor !== 'number'
        || !Number.isSafeInteger(amountMinor) || amountMinor < 0
        || typeof amountUSDMinor !== 'number'
        || !Number.isSafeInteger(amountUSDMinor) || amountUSDMinor < 0
      ) {
        throw provenanceError('A prior Wallet return funding movement is malformed.');
      }
      const current = priorBySource.get(sourceTransactionId) || { amountMinor: 0, amountUSDMinor: 0 };
      current.amountMinor += amountMinor;
      current.amountUSDMinor += amountUSDMinor;
      priorBySource.set(sourceTransactionId, current);
    }
  }

  let remainingRefundMinor = refundMinor;
  const movements = [];
  for (const lot of originalLots.values()) {
    if (remainingRefundMinor <= 0) break;
    const prior = priorBySource.get(lot.sourceTransactionId) || { amountMinor: 0, amountUSDMinor: 0 };
    if (
      prior.amountMinor > lot.sourceAmountMinor
      || prior.amountUSDMinor > lot.amountUSDMinor
      || prior.amountUSDMinor !== roundProductRatio(
        lot.amountUSDMinor,
        prior.amountMinor,
        lot.sourceAmountMinor,
      )
    ) {
      throw provenanceError('Prior Wallet returns exceed their original top-up funding.');
    }
    const movedMinor = Math.min(remainingRefundMinor, lot.sourceAmountMinor - prior.amountMinor);
    if (!movedMinor) continue;
    const cumulativeMovedMinor = prior.amountMinor + movedMinor;
    const cumulativeUsdMinor = roundProductRatio(
      lot.amountUSDMinor,
      cumulativeMovedMinor,
      lot.sourceAmountMinor,
    );
    movements.push({
      sourceType: 'wallet_top_up',
      sourceTransactionId: lot.sourceTransactionId,
      amountMinor: movedMinor,
      amountUSDMinor: cumulativeUsdMinor - prior.amountUSDMinor,
      seller: normalizedSeller,
      orderId: normalizedOrder,
      returnRequestId: normalizedReturn,
      availableRestoredMinor: 0,
    });
    remainingRefundMinor -= movedMinor;
  }

  const availableCreditedMinor = walletTransaction.metadata?.availableCreditedMinor;
  if (
    typeof availableCreditedMinor !== 'number'
    || !Number.isSafeInteger(availableCreditedMinor)
    || availableCreditedMinor < 0
  ) {
    throw provenanceError('The Wallet return credit has invalid available-funding metadata.');
  }
  let availableToRestore = Math.min(
    availableCreditedMinor,
    movements.reduce((sum, movement) => sum + movement.amountMinor, 0),
  );
  for (const movement of movements) {
    if (availableToRestore <= 0) break;
    movement.availableRestoredMinor = Math.min(availableToRestore, movement.amountMinor);
    availableToRestore -= movement.availableRestoredMinor;
  }

  for (const movement of movements) {
    const source = await withSession(WalletTransaction.findOne({
      _id: movement.sourceTransactionId,
      user: walletTransaction.user,
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      currency: normalizedCurrency,
    }), session);
    if (!source) throw provenanceError('A returned Wallet top-up source is missing.');
    const remainingMinor = source.metadata?.fundingRemainingMinor;
    const originalMinor = source.metadata?.fundingOriginalAvailableMinor;
    if (
      typeof remainingMinor !== 'number'
      || !Number.isSafeInteger(remainingMinor) || remainingMinor < 0
      || typeof originalMinor !== 'number'
      || !Number.isSafeInteger(originalMinor) || originalMinor < 0
      || remainingMinor + movement.availableRestoredMinor > originalMinor
    ) {
      throw provenanceError('Returned Wallet funding exceeds its top-up principal.');
    }
    if (movement.availableRestoredMinor > 0) {
      source.metadata.fundingRemainingMinor = remainingMinor + movement.availableRestoredMinor;
      source.markModified('metadata');
      await source.save({ session });
    }
  }
  walletTransaction.metadata = {
    ...(walletTransaction.metadata || {}),
    fundingProvenanceReturns: movements,
    untrackedReturnedFundingMinor: refundMinor
      - movements.reduce((sum, movement) => sum + movement.amountMinor, 0),
  };
  walletTransaction.markModified('metadata');
  await walletTransaction.save({ session });
  return movements;
};

module.exports = {
  assertWalletOrderFundingReturnable,
  attachReturnedWalletFundingProvenance,
};
