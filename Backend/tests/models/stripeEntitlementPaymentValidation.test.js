'use strict';

const mongoose = require('mongoose');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const SellerSubscription = require('../../models/SellerSubscription');

const validPayment = overrides => new StripeEntitlementPayment({
  entitlementType: 'subscription',
  sourceKey: `invoice:${new mongoose.Types.ObjectId()}`,
  seller: new mongoose.Types.ObjectId(),
  currency: 'usd',
  capturedMinor: 1000,
  refundedMinor: 100,
  disputeAmountMinor: 0,
  grantStart: new Date('2026-08-01T00:00:00.000Z'),
  grantEnd: new Date('2026-09-01T00:00:00.000Z'),
  effectiveGrantEnd: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

describe('Stripe entitlement financial persistence validation', () => {
  test('requires the captured minor-unit source of truth', async () => {
    const payment = validPayment();
    payment.capturedMinor = undefined;
    await expect(payment.validate()).rejects.toThrow(/capturedMinor|required/);
  });

  test.each([true, '', 'eur'])('rejects malformed or unsupported billing currency %p', async (currency) => {
    await expect(validPayment({ currency }).validate()).rejects.toBeDefined();
  });

  test.each([true, false, '', '1000', 1.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed captured minor units %p',
    async (capturedMinor) => {
      await expect(validPayment({ capturedMinor }).validate()).rejects.toBeDefined();
    },
  );

  test('rejects aggregate and Invoice Payment refunds beyond captured money', async () => {
    await expect(validPayment({ capturedMinor: 100, refundedMinor: 101 }).validate())
      .rejects.toThrow(/refundedMinor|cannot exceed/);
    await expect(validPayment({
      chargeTracks: [{
        invoicePaymentId: 'inpay_validation',
        paymentType: 'charge',
        chargeId: 'ch_validation',
        capturedMinor: 100,
        refundedMinor: 101,
        currency: 'usd',
      }],
    }).validate()).rejects.toThrow(/chargeTracks|cannot exceed/);
  });

  test.each([true, '500', 0.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed price minor snapshots %p',
    async (value) => {
      await expect(validPayment({
        unitAmountMinorSnapshots: [value],
        fundedUnitAmountMinor: value,
      }).validate()).rejects.toBeDefined();
    },
  );

  test('accepts exact safe payment and price snapshots', async () => {
    await expect(validPayment({
      unitAmountMinorSnapshots: [500, 1299],
      fundedUnitAmountMinor: 1299,
      predecessorUnitAmountMinor: 500,
      stripeEventCreated: 1787500000,
    }).validate()).resolves.toBeUndefined();
  });
});

describe('Seller subscription durable numeric validation', () => {
  test.each([true, false, '', '40', -1, 100.001, Number.POSITIVE_INFINITY])(
    'rejects malformed founder discount %p',
    async (discountPercent) => {
      const subscription = new SellerSubscription({
        seller: new mongoose.Types.ObjectId(),
        founderOffer: { discountPercent },
      });
      await expect(subscription.validate()).rejects.toBeDefined();
    },
  );

  test.each([true, '500', 0, 0.5, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed positive plan-change price %p',
    async (sourceUnitAmountMinor) => {
      const subscription = new SellerSubscription({
        seller: new mongoose.Types.ObjectId(),
        planChangeAttempt: { sourceUnitAmountMinor },
      });
      await expect(subscription.validate()).rejects.toBeDefined();
    },
  );

  test('accepts exact founder and plan-change numeric snapshots', async () => {
    const subscription = new SellerSubscription({
      seller: new mongoose.Types.ObjectId(),
      founderOffer: { discountPercent: 40 },
      paymentRisk: { latestFailureEventCreated: 1787500000 },
      planChangeAttempt: {
        sourceUnitAmountMinor: 500,
        targetUnitAmountMinor: 1299,
        fundedPlanSync: { unitAmountMinor: 1299 },
      },
    });
    await expect(subscription.validate()).resolves.toBeUndefined();
  });
});
