'use strict';

const StripePaymentRiskState = require('../models/StripePaymentRiskState');

const VALID_STATE_STATUSES = new Set(['active', 'won', 'lost', 'warning_closed']);

const disputeStateError = (message, code, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const requireDisputeExposureMinor = (value, { stored = false } = {}) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw disputeStateError(
      stored
        ? 'The stored Stripe dispute exposure is invalid.'
        : 'Stripe dispute exposure must be a non-negative safe integer.',
      stored
        ? 'STRIPE_PAYMENT_RISK_STATE_INVALID'
        : 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID',
      stored ? 409 : 400,
    );
  }
  return value;
};

const assertStoredStripeDisputeState = (state) => {
  if (
    !state
    || typeof state.terminal !== 'boolean'
    || typeof state.status !== 'string'
    || !VALID_STATE_STATUSES.has(state.status)
    || state.terminal !== (state.status !== 'active')
    || typeof state.disputeId !== 'string'
    || !state.disputeId.trim()
    || state.disputeId !== state.disputeId.trim()
  ) {
    throw disputeStateError(
      'The stored Stripe dispute state is invalid.',
      'STRIPE_PAYMENT_RISK_STATE_INVALID',
      409,
    );
  }
  return {
    terminal: state.terminal,
    status: state.status,
    disputeId: state.disputeId,
    exposureMinor: requireDisputeExposureMinor(state.exposureMinor, { stored: true }),
  };
};

const readRawDisputeState = async (stateId, session) => {
  const state = await StripePaymentRiskState.collection.findOne(
    { _id: stateId },
    session ? { session } : {},
  );
  return assertStoredStripeDisputeState(state);
};

const terminalResolutionForEvent = ({ eventType, disputeStatus }) => {
  if (eventType === 'charge.dispute.funds_reinstated' || disputeStatus === 'won') return 'won';
  if (disputeStatus === 'lost') return 'lost';
  if (disputeStatus === 'warning_closed') return 'warning_closed';
  return null;
};

const stateIdentity = ({
  sourceType,
  sourceReferenceId,
  paymentIntentId,
  chargeId,
  disputeId,
}) => ({
  sourceType,
  sourceReferenceId: String(sourceReferenceId),
  paymentIntentId,
  chargeId,
  disputeId,
});

const ensureDisputeState = async (payload, session) => {
  const identity = stateIdentity(payload);
  return StripePaymentRiskState.findOneAndUpdate(
    identity,
    {
      $setOnInsert: {
        ...identity,
        status: 'active',
        terminal: false,
        exposureMinor: 0,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
      session,
    },
  );
};

/**
 * Serializes one dispute transition and persists terminal resolutions. Once a
 * dispute is terminal, delayed financial events are deliberately ignored.
 * The caller performs this in the same transaction as its liability ledger.
 */
const recordStripeDisputeState = async ({
  session,
  sourceType,
  sourceReferenceId,
  paymentIntentId,
  chargeId,
  disputeId,
  eventId,
  eventType,
  disputeStatus = '',
  disputeExposureMinor = 0,
  financialEvent = false,
}) => {
  if (!disputeId) {
    const error = new Error('Stripe dispute accounting requires a dispute reference.');
    error.code = 'STRIPE_PAYMENT_RISK_DISPUTE_REFERENCE_MISSING';
    error.statusCode = 400;
    throw error;
  }
  requireDisputeExposureMinor(disputeExposureMinor);
  const payload = {
    sourceType,
    sourceReferenceId,
    paymentIntentId,
    chargeId,
    disputeId,
  };
  let state = await ensureDisputeState(payload, session);
  let storedState = await readRawDisputeState(state._id, session);
  const previous = {
    terminal: storedState.terminal,
    status: storedState.status,
    exposureMinor: storedState.exposureMinor,
  };
  const terminalResolution = terminalResolutionForEvent({ eventType, disputeStatus });

  if (storedState.terminal) {
    return {
      state,
      terminal: true,
      ignoredFinancialEvent: financialEvent,
      resolution: storedState.status,
      terminalTransition: false,
      financialExposureIncreased: false,
      previous,
    };
  }

  if (terminalResolution) {
    const terminalExposureMinor = terminalResolution === 'lost'
      ? disputeExposureMinor
      : 0;
    const resolved = await StripePaymentRiskState.findOneAndUpdate(
      { _id: state._id, terminal: false },
      {
        $max: { exposureMinor: terminalExposureMinor },
        $set: {
          status: terminalResolution,
          terminal: true,
          lastEventId: eventId,
          lastEventType: eventType,
          terminalEventId: eventId,
          terminalEventType: eventType,
          terminalAt: new Date(),
        },
      },
      { new: true, runValidators: true, session },
    );
    const terminalTransition = Boolean(resolved);
    state = resolved || await StripePaymentRiskState.findById(state._id).session(session);
    storedState = await readRawDisputeState(state._id, session);
    return {
      state,
      terminal: true,
      ignoredFinancialEvent: false,
      resolution: storedState.status,
      terminalTransition,
      financialExposureIncreased: false,
      previous,
    };
  }

  if (financialEvent) {
    const updated = await StripePaymentRiskState.findOneAndUpdate(
      { _id: state._id, terminal: false },
      {
        $max: { exposureMinor: disputeExposureMinor },
        $set: {
          lastEventId: eventId,
          lastEventType: eventType,
        },
      },
      { new: true, runValidators: true, session },
    );
    state = updated || await StripePaymentRiskState.findById(state._id).session(session);
    storedState = await readRawDisputeState(state._id, session);
    return {
      state,
      terminal: storedState.terminal,
      ignoredFinancialEvent: storedState.terminal,
      resolution: storedState.status,
      terminalTransition: false,
      financialExposureIncreased: !storedState.terminal
        && storedState.exposureMinor > previous.exposureMinor,
      previous,
    };
  }

  return {
    state,
    terminal: false,
    ignoredFinancialEvent: false,
    resolution: null,
    terminalTransition: false,
    financialExposureIncreased: false,
    previous,
  };
};

const getDurableDisputeExposures = async ({
  session,
  sourceType,
  sourceReferenceId,
  paymentIntentId,
  chargeId,
}) => {
  const states = await StripePaymentRiskState.collection.find({
    sourceType,
    sourceReferenceId: String(sourceReferenceId),
    paymentIntentId,
    chargeId,
  }, session ? { session } : {}).toArray();
  const exposures = new Map();
  for (const rawState of states) {
    const state = assertStoredStripeDisputeState(rawState);
    if (state.status !== 'active' && state.status !== 'lost') continue;
    if (exposures.has(state.disputeId)) {
      throw disputeStateError(
        'Duplicate durable Stripe dispute states were found.',
        'STRIPE_PAYMENT_RISK_STATE_INVALID',
        409,
      );
    }
    exposures.set(state.disputeId, state.exposureMinor);
  }
  return exposures;
};

module.exports = {
  terminalResolutionForEvent,
  assertStoredStripeDisputeState,
  requireDisputeExposureMinor,
  recordStripeDisputeState,
  getDurableDisputeExposures,
};
