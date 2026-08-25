'use strict';

const mongoose = require('mongoose');
const SellerBalanceTransaction = require('../../models/SellerBalanceTransaction');
const SellerWithdrawalRequest = require('../../models/SellerWithdrawalRequest');
const SellerSubscription = require('../../models/SellerSubscription');

const objectId = () => new mongoose.Types.ObjectId();

const balanceTransaction = overrides => new SellerBalanceTransaction({
  seller: objectId(),
  type: 'return_refund',
  direction: 'debit',
  status: 'completed',
  amountUSD: 1,
  sourceAmount: 280,
  sourceCurrency: 'PKR',
  referenceType: 'return_request',
  referenceId: 'return-1',
  ...overrides,
});

const withdrawal = overrides => new SellerWithdrawalRequest({
  seller: objectId(),
  amount: 5,
  currency: 'USD',
  requestedAmount: 1400,
  requestedCurrency: 'PKR',
  payoutAmount: 1400,
  payoutCurrency: 'PKR',
  paymentAccountSnapshotVersion: 0,
  ...overrides,
});

describe('seller financial persistence validation', () => {
  test.each([true, '', Number.POSITIVE_INFINITY, 1.001, Number.MAX_SAFE_INTEGER])(
    'rejects unsafe seller ledger amount %p before persistence',
    async amountUSD => {
      await expect(balanceTransaction({ amountUSD }).validate())
        .rejects.toThrow(/amountUSD|Seller balance USD amount/);
    },
  );

  test('permits one zero cross-currency ledger component but not an empty row', async () => {
    await expect(balanceTransaction({ amountUSD: 0, sourceAmount: 0.01 }).validate())
      .resolves.toBeUndefined();
    await expect(balanceTransaction({ amountUSD: 0, sourceAmount: 0 }).validate())
      .rejects.toThrow(/sourceAmount|must move source or USD money/);
  });

  test.each([
    ['amount', true],
    ['amount', Number.POSITIVE_INFINITY],
    ['amount', 5.001],
    ['requestedAmount', ''],
    ['requestedAmount', 1400.001],
    ['payoutAmount', Number.POSITIVE_INFINITY],
    ['payoutAmount', 1400.001],
  ])('rejects unsafe withdrawal %s %p before persistence', async (field, value) => {
    await expect(withdrawal({ [field]: value }).validate())
      .rejects.toThrow(new RegExp(field));
  });

  test('requires positive frozen amounts for a version 1 payout request', async () => {
    await expect(withdrawal({
      paymentAccountSnapshotVersion: 1,
      paymentAccountSnapshotEnvelope: 'v1.test',
      requestedAmount: 0,
      payoutAmount: 0,
    }).validate()).rejects.toThrow(/paymentAccountSnapshotVersion/);
  });

  test('rejects a version 1 processing state without one auditable active attempt', async () => {
    await expect(withdrawal({
      payoutWorkflowVersion: 1,
      status: 'processing',
    }).validate()).rejects.toThrow(/activePayoutAttemptId/);
  });

  test('rejects a paid payout attempt without matching transfer proof', async () => {
    const attemptId = 'model-paid-attempt';
    await expect(withdrawal({
      payoutWorkflowVersion: 1,
      status: 'paid',
      payoutAttempts: [{
        attemptId,
        sequence: 1,
        provider: 'Test provider',
        status: 'paid',
        initiatedBy: objectId(),
        startedAt: new Date(),
        updatedAt: new Date(),
      }],
      paidPayoutAttemptId: attemptId,
    }).validate()).rejects.toThrow(/payoutAttempts|paidPayoutAttemptId/);
  });

  test.each([
    40.001,
    -0.01,
    100.01,
    Number.POSITIVE_INFINITY,
    Number.MAX_VALUE,
    true,
    '40',
  ])(
    'rejects an imprecise pending-downgrade founder discount %p',
    async founderDiscountPercent => {
      const stripeSubscriptionId = 'sub_precise_founder_discount';
      const subscription = new SellerSubscription({
        seller: objectId(),
        status: 'active',
        plan: 'elite',
        stripeSubscriptionId,
        pendingDowngrade: {
          toPlan: 'starter',
          scheduledAt: new Date(),
          operationKey: 'precise-founder-discount',
          sourceStripeSubscriptionId: stripeSubscriptionId,
          targetPlanName: 'Rozare Starter',
          targetUnitAmountMinor: 599,
          targetCurrency: 'usd',
          founderRateApplied: true,
          founderDiscountPercent,
          founderOfferCode: 'FIRST100',
          starterBonusEligible: true,
          quoteFrozenAt: new Date(),
        },
      });
      await expect(subscription.validate()).rejects.toThrow(/founderDiscountPercent|founder discount/i);
    },
  );

  test.each([
    40.001,
    -0.01,
    100.01,
    Number.POSITIVE_INFINITY,
    Number.MAX_VALUE,
    true,
    '40',
  ])('rejects an unsafe persisted founder offer discount %p', async discountPercent => {
    const subscription = new SellerSubscription({
      seller: objectId(),
      founderOffer: {
        active: true,
        code: 'FIRST100',
        discountPercent,
        claimedAt: new Date(),
        source: 'coupon',
      },
    });
    await expect(subscription.validate()).rejects.toThrow(/discountPercent|Founder discount/i);
  });

  test('rejects malformed and overflowed lifecycle money snapshots at every persistence path', async () => {
    const amountPaths = [
      ['trialExpiring', 'starterStandardAmountMinor'],
      ['trialExpiring', 'starterFounderAmountMinor'],
      ['bonusExpiring', 'eliteAmountMinor'],
      ['bonusExpired', 'eliteAmountMinor'],
      ['bonusRemoved', 'eliteAmountMinor'],
    ];
    const invalidValues = [true, '', 0, 1.5, Number.POSITIVE_INFINITY, Number.MAX_VALUE];
    for (const [section, field] of amountPaths) {
      for (const value of invalidValues) {
        const subscription = new SellerSubscription({
          seller: objectId(),
          lifecyclePricing: { [section]: { [field]: value } },
        });
        await expect(subscription.validate()).rejects.toThrow(/lifecyclePricing|price snapshot/i);
      }
    }
  });

  test('rejects malformed lifecycle period snapshots at every persistence path', async () => {
    const sections = ['trialExpiring', 'bonusExpiring', 'bonusExpired', 'bonusRemoved'];
    const fieldFor = section => (section === 'trialExpiring'
      ? 'starterFreePeriodDays'
      : 'eliteFreePeriodDays');
    const invalidValues = [true, '', -1, 1.5, 366, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER];
    for (const section of sections) {
      for (const value of invalidValues) {
        const subscription = new SellerSubscription({
          seller: objectId(),
          lifecyclePricing: { [section]: { [fieldFor(section)]: value } },
        });
        await expect(subscription.validate()).rejects.toThrow(/lifecyclePricing|period snapshot/i);
      }
    }
  });
});
