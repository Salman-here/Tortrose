'use strict';

const crypto = require('crypto');
const SellerPaymentRiskHold = require('../models/SellerPaymentRiskHold');
const SellerSettlementLock = require('../models/SellerSettlementLock');
const StripePaymentRiskState = require('../models/StripePaymentRiskState');
const { runInTransaction } = require('./walletService');

const uniqueSellerIds = sellerIds => [...new Set(
  (sellerIds || []).map(value => String(value || '')).filter(Boolean),
)].sort();

const lockSellers = async (sellerIds, session) => {
  const generations = new Map();
  for (const sellerId of uniqueSellerIds(sellerIds)) {
    const lock = await SellerSettlementLock.findOneAndUpdate(
      { seller: sellerId },
      { $setOnInsert: { seller: sellerId }, $inc: { version: 1 } },
      { upsert: true, new: true, session },
    );
    const generation = Number(lock?.version);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      const error = new Error('Seller payment-risk generation could not be allocated safely.');
      error.code = 'SELLER_PAYMENT_RISK_GENERATION_INVALID';
      error.statusCode = 503;
      throw error;
    }
    generations.set(String(sellerId), generation);
  }
  return generations;
};

const riskTrackKeyFor = ({ riskTrack, disputeId = null }) => (
  riskTrack === 'dispute' ? `dispute:${String(disputeId || '').trim()}` : 'refund'
);

const exposureFingerprintFor = details => crypto.createHash('sha256').update(JSON.stringify({
  sourceType: String(details.sourceType || ''),
  sourceReferenceId: String(details.sourceReferenceId || ''),
  paymentIntentId: String(details.paymentIntentId || ''),
  chargeId: String(details.chargeId || ''),
  eventId: String(details.eventId || ''),
  eventType: String(details.eventType || ''),
  riskTrackKey: riskTrackKeyFor(details),
  exposureMinor: details.unknownExposure === true ? null : Number(details.exposureMinor),
  unknownExposure: details.unknownExposure === true,
})).digest('hex');

const holdError = (message, code, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const createSellerPaymentRiskHolds = async ({ sellerIds, ...details }) => {
  const sellers = uniqueSellerIds(sellerIds);
  if (!sellers.length) return [];
  const riskTrackKey = riskTrackKeyFor(details);
  const unknownExposure = details.unknownExposure === true;
  const exposureMinor = Number(details.exposureMinor);
  if (
    !['refund', 'dispute'].includes(details.riskTrack)
    || (details.riskTrack === 'dispute' && !String(details.disputeId || '').trim())
    || (!unknownExposure && (!Number.isSafeInteger(exposureMinor) || exposureMinor <= 0))
  ) {
    throw holdError(
      'Seller payment-risk hold exposure is incomplete or malformed.',
      'SELLER_PAYMENT_RISK_EXPOSURE_INVALID',
      400,
    );
  }
  const exposureFingerprint = exposureFingerprintFor({ ...details, exposureMinor, unknownExposure });
  return runInTransaction(async session => {
    const generations = await lockSellers(sellers, session);
    const holds = [];
    for (const seller of sellers) {
      const hold = await SellerPaymentRiskHold.findOneAndUpdate(
        { seller, eventId: details.eventId, riskTrackKey },
        {
          $setOnInsert: {
            seller,
            sourceType: details.sourceType,
            sourceReferenceId: String(details.sourceReferenceId),
            paymentIntentId: details.paymentIntentId,
            chargeId: details.chargeId,
            eventId: details.eventId,
            eventType: details.eventType,
            riskTrack: details.riskTrack,
            riskTrackKey,
            disputeId: details.disputeId || null,
            exposureGeneration: generations.get(seller),
            exposureMinor: unknownExposure ? null : exposureMinor,
            exposureFingerprint,
            unknownExposure,
            status: 'pending',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );
      if (
        String(hold?.exposureFingerprint || '') !== exposureFingerprint
        || hold?.riskTrackKey !== riskTrackKey
      ) {
        throw holdError(
          'A Stripe event was replayed with different seller-risk exposure details.',
          'SELLER_PAYMENT_RISK_EVENT_MISMATCH',
        );
      }
      holds.push(hold);
    }
    return holds;
  });
};

/** Resolve only generations which the successful accounting result covers.
 * The per-seller fence prevents an older worker from clearing a newer hold;
 * the exposure ceiling prevents a smaller event from clearing a larger one. */
const resolveSellerPaymentRiskHolds = async ({
  holds,
  sourceType,
  sourceReferenceId,
  paymentIntentId,
  chargeId,
  riskTrack,
  disputeId = null,
  coveredExposureMinor,
  resolutionEventId,
}) => {
  const tokens = (holds || []).filter(Boolean);
  if (!tokens.length) return 0;
  const coveredMinor = Number(coveredExposureMinor);
  if (!Number.isSafeInteger(coveredMinor) || coveredMinor < 0 || !String(resolutionEventId || '').trim()) {
    throw holdError(
      'Seller payment-risk resolution coverage is incomplete or malformed.',
      'SELLER_PAYMENT_RISK_RESOLUTION_INVALID',
      400,
    );
  }
  const riskTrackKey = riskTrackKeyFor({ riskTrack, disputeId });
  const sellers = uniqueSellerIds(tokens.map(hold => hold.seller));
  return runInTransaction(async session => {
    await lockSellers(sellers, session);
    let modifiedCount = 0;
    for (const seller of sellers) {
      const token = tokens.find(hold => (
        String(hold.seller) === seller
        && hold.riskTrackKey === riskTrackKey
      ));
      const generation = Number(token?.exposureGeneration);
      if (!Number.isSafeInteger(generation) || generation <= 0) continue;
      const result = await SellerPaymentRiskHold.updateMany(
        {
          seller,
          sourceType,
          sourceReferenceId: String(sourceReferenceId),
          paymentIntentId,
          chargeId,
          riskTrackKey,
          status: 'pending',
          unknownExposure: { $ne: true },
          exposureGeneration: { $lte: generation },
          exposureMinor: { $lte: coveredMinor },
          exposureFingerprint: { $type: 'string' },
          ...(riskTrack === 'dispute' ? { disputeId } : {}),
        },
        {
          $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedByEventId: String(resolutionEventId),
            resolvedExposureMinor: coveredMinor,
          },
        },
        { session },
      );
      modifiedCount += result.modifiedCount;
    }
    return modifiedCount;
  });
};

/**
 * A financial-dispute webhook creates its withdrawal hold before the seller
 * ledger transaction begins. If that transaction rolls back, a later won
 * event has no per-event hold token with which to release the fail-closed
 * hold. Resolve that orphan only after the exact dispute identity is durably
 * terminal-won. The authoritative charge ceiling prevents a corrupt/oversized
 * hold from being released, while the newly allocated seller generation means
 * this worker can clear only holds which existed before its terminal fence.
 *
 * A financial event racing after this fence receives a newer generation. Its
 * own successful, terminal-state-aware retry will acquire another fence and
 * resolve that hold; this worker can never clear it prematurely.
 */
const resolveWonDisputeSellerPaymentRiskHolds = async ({
  sellerIds,
  sourceType,
  sourceReferenceId,
  paymentIntentId,
  chargeId,
  disputeId,
  coveredExposureMinor,
  resolutionEventId,
}) => {
  const sellers = uniqueSellerIds(sellerIds);
  const coveredMinor = Number(coveredExposureMinor);
  if (
    !sellers.length
    || !sourceType
    || !String(sourceReferenceId || '').trim()
    || !String(paymentIntentId || '').trim()
    || !String(chargeId || '').trim()
    || !String(disputeId || '').trim()
    || !Number.isSafeInteger(coveredMinor)
    || coveredMinor <= 0
    || !String(resolutionEventId || '').trim()
  ) {
    throw holdError(
      'Terminal seller payment-risk resolution coverage is incomplete or malformed.',
      'SELLER_PAYMENT_RISK_TERMINAL_RESOLUTION_INVALID',
      400,
    );
  }
  const identity = {
    sourceType,
    sourceReferenceId: String(sourceReferenceId),
    paymentIntentId,
    chargeId,
    disputeId,
  };
  const riskTrackKey = riskTrackKeyFor({ riskTrack: 'dispute', disputeId });
  return runInTransaction(async session => {
    const terminalState = await StripePaymentRiskState.findOne({
      ...identity,
      terminal: true,
      status: 'won',
      terminalEventId: { $type: 'string', $ne: '' },
    }).session(session).lean();
    if (!terminalState) return 0;

    const generations = await lockSellers(sellers, session);
    let modifiedCount = 0;
    for (const seller of sellers) {
      const generation = generations.get(seller);
      const result = await SellerPaymentRiskHold.updateMany(
        {
          seller,
          ...identity,
          riskTrack: 'dispute',
          riskTrackKey,
          status: 'pending',
          unknownExposure: { $ne: true },
          exposureGeneration: { $lte: generation },
          exposureMinor: { $lte: coveredMinor },
          exposureFingerprint: { $type: 'string' },
        },
        {
          $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedByEventId: String(resolutionEventId),
            resolvedExposureMinor: coveredMinor,
          },
        },
        { session },
      );
      modifiedCount += result.modifiedCount;
    }
    return modifiedCount;
  });
};

module.exports = {
  exposureFingerprintFor,
  riskTrackKeyFor,
  createSellerPaymentRiskHolds,
  resolveSellerPaymentRiskHolds,
  resolveWonDisputeSellerPaymentRiskHolds,
};
