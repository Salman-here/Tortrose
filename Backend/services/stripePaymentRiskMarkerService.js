'use strict';

const StripePaymentRiskMarker = require('../models/StripePaymentRiskMarker');

const markerError = (message, code, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const cleanIdentity = ({ paymentIntentId, sourceType, sourceReferenceId }) => {
  const identity = {
    paymentIntentId: String(paymentIntentId || '').trim(),
    sourceType: String(sourceType || '').trim(),
    sourceReferenceId: String(sourceReferenceId || '').trim(),
  };
  if (!identity.paymentIntentId || !identity.sourceType || !identity.sourceReferenceId) {
    throw markerError(
      'Stripe payment-risk ownership metadata is incomplete.',
      'STRIPE_PAYMENT_RISK_OWNERSHIP_MISSING',
      400,
    );
  }
  return identity;
};

const assertMarkerIdentity = (marker, identity) => {
  if (
    !marker
    || marker.paymentIntentId !== identity.paymentIntentId
    || marker.sourceType !== identity.sourceType
    || marker.sourceReferenceId !== identity.sourceReferenceId
  ) {
    throw markerError(
      'Stripe payment-risk ownership conflicts with the persisted payment marker.',
      'STRIPE_PAYMENT_RISK_OWNERSHIP_MISMATCH',
      400,
    );
  }
  return marker;
};

const withSession = (query, session) => (session ? query.session(session) : query);

const isStripePreCompletionDisputeResolved = async ({
  paymentIntentId,
  sourceType,
  sourceReferenceId,
  disputeId,
}) => {
  const identity = cleanIdentity({ paymentIntentId, sourceType, sourceReferenceId });
  const normalizedDisputeId = String(disputeId || '').trim();
  if (!normalizedDisputeId) return false;
  return Boolean(await StripePaymentRiskMarker.exists({
    ...identity,
    wonDisputeIds: normalizedDisputeId,
  }));
};

/** Persist an early financial-risk event before looking for a completed local
 * source. `completionState=claimed` is the only state in which completion won
 * the race and the caller must retry ordinary post-completion accounting. */
const recordStripePreCompletionRisk = async ({
  paymentIntentId,
  sourceType,
  sourceReferenceId,
  chargeId,
  eventId,
  eventType,
  currency,
  chargeAmountMinor,
  disputeId = null,
}) => {
  const identity = cleanIdentity({ paymentIntentId, sourceType, sourceReferenceId });
  const normalizedCurrency = String(currency || '').trim().toUpperCase();
  const normalizedAmount = Number(chargeAmountMinor);
  const riskTrack = eventType === 'charge.refunded' ? 'refund' : 'dispute';
  const normalizedDisputeId = riskTrack === 'dispute'
    ? String(disputeId || `unknown:${chargeId || paymentIntentId}`).trim()
    : null;
  let marker;
  try {
    marker = await StripePaymentRiskMarker.findOneAndUpdate(
      identity,
      {
        $setOnInsert: {
          ...identity,
          completionState: 'unclaimed',
          blocked: false,
          refundBlocked: false,
          blockedDisputeIds: [],
          wonDisputeIds: [],
        },
        $addToSet: { chargeIds: String(chargeId || '').trim() },
        $set: {
          ...(normalizedCurrency ? { currency: normalizedCurrency } : {}),
          ...(Number.isSafeInteger(normalizedAmount) && normalizedAmount >= 0
            ? { chargeAmountMinor: normalizedAmount }
            : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    marker = await StripePaymentRiskMarker.findOne({ paymentIntentId: identity.paymentIntentId });
  }
  assertMarkerIdentity(marker, identity);

  if (marker.completionState === 'claimed' || marker.completionState === 'completed') {
    return { marker, blockedBeforeCompletion: false, completionWon: true };
  }
  if (
    riskTrack === 'dispute'
    && (marker.wonDisputeIds || []).map(String).includes(normalizedDisputeId)
  ) {
    return {
      marker,
      blockedBeforeCompletion: false,
      completionWon: false,
      ignoredResolvedDispute: true,
    };
  }

  marker = await StripePaymentRiskMarker.findOneAndUpdate(
    {
      ...identity,
      completionState: { $in: ['unclaimed', 'blocked'] },
      ...(riskTrack === 'dispute' ? { wonDisputeIds: { $ne: normalizedDisputeId } } : {}),
    },
    {
      $set: {
        completionState: 'blocked',
        blocked: true,
        blockingEventId: String(eventId || '').trim() || null,
        blockingEventType: String(eventType || '').trim(),
        ...(riskTrack === 'refund' ? { refundBlocked: true } : {}),
      },
      $addToSet: {
        chargeIds: String(chargeId || '').trim(),
        ...(riskTrack === 'dispute' ? { blockedDisputeIds: normalizedDisputeId } : {}),
      },
    },
    { new: true },
  );
  if (marker) return { marker, blockedBeforeCompletion: true, completionWon: false };

  const current = await StripePaymentRiskMarker.findOne({ paymentIntentId: identity.paymentIntentId });
  assertMarkerIdentity(current, identity);
  return {
    marker: current,
    blockedBeforeCompletion: current.completionState === 'blocked' || current.blocked,
    completionWon: ['claimed', 'completed'].includes(current.completionState),
    ignoredResolvedDispute: riskTrack === 'dispute'
      && (current.wonDisputeIds || []).map(String).includes(normalizedDisputeId),
  };
};

/** A won/reinstated dispute removes only its own early blocker. A prior refund
 * or another active dispute continues to block completion. A won event which
 * arrives first is also durable, so a delayed financial event for that exact
 * dispute cannot re-block and grant/revoke value out of order. */
const resolveStripePreCompletionDispute = async ({
  paymentIntentId,
  sourceType,
  sourceReferenceId,
  chargeId,
  disputeId,
  eventId,
}) => {
  const identity = cleanIdentity({ paymentIntentId, sourceType, sourceReferenceId });
  const normalizedDisputeId = String(disputeId || '').trim();
  if (!normalizedDisputeId) {
    throw markerError(
      'Stripe dispute resolution is missing its dispute ID.',
      'STRIPE_PAYMENT_RISK_OWNERSHIP_MISSING',
      400,
    );
  }
  let marker;
  try {
    marker = await StripePaymentRiskMarker.findOneAndUpdate(
      identity,
      {
        $setOnInsert: {
          ...identity,
          completionState: 'unclaimed',
          blocked: false,
          refundBlocked: false,
        },
        $addToSet: {
          wonDisputeIds: normalizedDisputeId,
          chargeIds: String(chargeId || '').trim(),
        },
        $pull: { blockedDisputeIds: normalizedDisputeId },
        $set: {
          lastResolutionEventId: String(eventId || '').trim() || null,
          lastResolvedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: false },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    marker = await StripePaymentRiskMarker.findOne({ paymentIntentId: identity.paymentIntentId });
  }
  assertMarkerIdentity(marker, identity);
  if (['claimed', 'completed'].includes(marker.completionState)) {
    return { marker, resolvedBeforeCompletion: false, completionWon: true };
  }

  const hasBlockers = marker.refundBlocked === true
    || (marker.blockedDisputeIds || []).length > 0;
  if (!hasBlockers) {
    await StripePaymentRiskMarker.updateOne(
      {
        _id: marker._id,
        completionState: { $in: ['unclaimed', 'blocked'] },
        refundBlocked: { $ne: true },
        blockedDisputeIds: { $size: 0 },
      },
      {
        $set: {
          blocked: false,
          completionState: 'unclaimed',
          blockingEventId: null,
          blockingEventType: '',
        },
      },
    );
  } else {
    await StripePaymentRiskMarker.updateOne(
      { _id: marker._id, completionState: { $in: ['unclaimed', 'blocked'] } },
      { $set: { blocked: true, completionState: 'blocked' } },
    );
  }
  const current = await StripePaymentRiskMarker.findById(marker._id);
  assertMarkerIdentity(current, identity);
  return {
    marker: current,
    resolvedBeforeCompletion: !current.blocked,
    completionWon: false,
    stillBlocked: current.blocked,
  };
};

/** Atomically claim the right to apply a captured payment. A blocked marker is
 * terminal for this exact PaymentIntent and source; callers must close their
 * local pending object without granting inventory, revenue, or Wallet funds. */
const claimStripePaymentCompletion = async ({
  paymentIntentId,
  sourceType,
  sourceReferenceId,
  eventId = null,
  session = null,
}) => {
  const identity = cleanIdentity({ paymentIntentId, sourceType, sourceReferenceId });
  let marker = await StripePaymentRiskMarker.findOneAndUpdate(
    { paymentIntentId: identity.paymentIntentId },
    {
      $setOnInsert: {
        ...identity,
        completionState: 'unclaimed',
        blocked: false,
        refundBlocked: false,
        blockedDisputeIds: [],
        wonDisputeIds: [],
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  );
  assertMarkerIdentity(marker, identity);
  if (marker.blocked || marker.completionState === 'blocked') {
    throw markerError(
      'Stripe reversed this payment before local completion. No value can be granted.',
      'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION',
    );
  }
  if (marker.completionState === 'completed') return marker;
  marker = await StripePaymentRiskMarker.findOneAndUpdate(
    {
      _id: marker._id,
      blocked: { $ne: true },
      completionState: { $in: ['unclaimed', 'claimed'] },
    },
    {
      $set: {
        completionState: 'claimed',
        completionEventId: eventId ? String(eventId) : null,
        completionClaimedAt: new Date(),
      },
    },
    { new: true, session },
  );
  if (!marker) {
    const current = await withSession(
      StripePaymentRiskMarker.findOne({ paymentIntentId: identity.paymentIntentId }),
      session,
    );
    assertMarkerIdentity(current, identity);
    if (current.blocked || current.completionState === 'blocked') {
      throw markerError(
        'Stripe reversed this payment before local completion. No value can be granted.',
        'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION',
      );
    }
    if (current.completionState === 'completed') return current;
    throw markerError(
      'Stripe payment completion could not claim its durable risk marker.',
      'STRIPE_PAYMENT_COMPLETION_CLAIM_MISSING',
      503,
    );
  }
  return marker;
};

const markStripePaymentCompletionDone = async ({
  paymentIntentId,
  sourceType,
  sourceReferenceId,
  session = null,
}) => {
  const identity = cleanIdentity({ paymentIntentId, sourceType, sourceReferenceId });
  const query = StripePaymentRiskMarker.findOneAndUpdate(
    {
      ...identity,
      blocked: { $ne: true },
      completionState: { $in: ['claimed', 'completed'] },
    },
    {
      $set: {
        completionState: 'completed',
        completionCompletedAt: new Date(),
      },
    },
    { new: true, session },
  );
  const marker = await query;
  if (!marker) {
    throw markerError(
      'Stripe payment completion lost its durable risk claim.',
      'STRIPE_PAYMENT_COMPLETION_CLAIM_MISSING',
      503,
    );
  }
  return marker;
};

module.exports = {
  markerError,
  isStripePreCompletionDisputeResolved,
  recordStripePreCompletionRisk,
  resolveStripePreCompletionDispute,
  claimStripePaymentCompletion,
  markStripePaymentCompletionDone,
};
