'use strict';

const mongoose = require('mongoose');
const StripePaymentRiskState = require('../../models/StripePaymentRiskState');
const {
  assertStoredStripeDisputeState,
  requireDisputeExposureMinor,
} = require('../../services/stripeDisputeStateService');

const validState = overrides => ({
  _id: new mongoose.Types.ObjectId(),
  sourceType: 'order_payment',
  sourceReferenceId: String(new mongoose.Types.ObjectId()),
  paymentIntentId: 'pi_state_validation',
  chargeId: 'ch_state_validation',
  disputeId: 'dp_state_validation',
  status: 'active',
  terminal: false,
  exposureMinor: 1234,
  ...overrides,
});

describe('Stripe dispute-state money boundary', () => {
  test.each([true, false, '', '1234', null, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed incoming exposure %p',
    value => {
      expect(() => requireDisputeExposureMinor(value)).toThrow(
        expect.objectContaining({
          code: 'STRIPE_PAYMENT_RISK_AMOUNT_INVALID',
          statusCode: 400,
        }),
      );
    },
  );

  test.each([true, false, '', '1234', null, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'quarantines malformed stored exposure %p instead of coercing it',
    value => {
      expect(() => assertStoredStripeDisputeState(validState({ exposureMinor: value }))).toThrow(
        expect.objectContaining({
          code: 'STRIPE_PAYMENT_RISK_STATE_INVALID',
          statusCode: 409,
        }),
      );
    },
  );

  test.each([
    [{ status: 'active', terminal: true }],
    [{ status: 'won', terminal: false }],
    [{ status: 'unknown', terminal: false }],
    [{ disputeId: ' dp_state_validation' }],
  ])('quarantines internally inconsistent stored state %p', overrides => {
    expect(() => assertStoredStripeDisputeState(validState(overrides))).toThrow(
      expect.objectContaining({ code: 'STRIPE_PAYMENT_RISK_STATE_INVALID' }),
    );
  });

  test('accepts exact active and terminal durable snapshots', () => {
    expect(assertStoredStripeDisputeState(validState())).toEqual({
      terminal: false,
      status: 'active',
      disputeId: 'dp_state_validation',
      exposureMinor: 1234,
    });
    expect(assertStoredStripeDisputeState(validState({
      status: 'lost',
      terminal: true,
      exposureMinor: 5000,
    }))).toMatchObject({ status: 'lost', terminal: true, exposureMinor: 5000 });
  });
});

describe('StripePaymentRiskState persistence validation', () => {
  test.each([true, false, '', '1234', -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed exposure %p before persistence',
    async exposureMinor => {
      await expect(new StripePaymentRiskState(validState({ exposureMinor })).validate())
        .rejects.toThrow(/exposureMinor|Stripe dispute exposure/);
    },
  );

  test.each([
    [{ status: 'active', terminal: true }],
    [{ status: 'won', terminal: false }],
  ])('rejects status/terminal mismatch %p before persistence', async overrides => {
    await expect(new StripePaymentRiskState(validState(overrides)).validate())
      .rejects.toThrow(/terminal|agree with its status/);
  });

  test('accepts exact safe exposure and consistent terminal state', async () => {
    await expect(new StripePaymentRiskState(validState({
      status: 'won',
      terminal: true,
      exposureMinor: 0,
    })).validate()).resolves.toBeUndefined();
  });
});
