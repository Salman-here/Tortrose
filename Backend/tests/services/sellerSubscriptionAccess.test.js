'use strict';

const { hasSellerPlanAccess, hasSellerBonusAccess } = require('../../services/sellerSubscriptionAccess');
const renewal = require('../../services/safepayRenewalPolicy');

const due = new Date('2026-10-18T05:00:00Z');
const cancelAt = renewal.cancellationDeadline(due);
const base = { status: 'active', plan: 'starter', billingProvider: 'safepay', currentPeriodEnd: due,
  bonusFeaturesActive: true, bonusExpiryDate: new Date('2027-04-18T00:00:00Z'),
  safepayBilling: { autoRenew: true, contractId: 'contract', cycle: 2, consentedAt: due,
    recovery: { rootOperation: 'invoice', contractId: 'contract', cycle: 2,
      policyVersion: renewal.POLICY_VERSION, cancelAt } } };

test.each(['cancelled', 'blocked', 'past_due', 'expired'])('preserved bonus time never grants %s access', status => {
  const sub = { ...base, status };
  expect(hasSellerPlanAccess(sub, { now: due })).toBe(false);
  expect(hasSellerBonusAccess(sub, { now: due })).toBe(false);
  expect(sub.bonusFeaturesActive).toBe(true);
  expect(sub.bonusExpiryDate).toEqual(base.bonusExpiryDate);
});

test.each(['starter', 'elite'])('%s retains paid and seven-day recovery access, but not a millisecond after its cutoff', plan => {
  const sub = { ...base, plan };
  for (const now of [new Date(due - 1), due, new Date(cancelAt - 1)]) {
    expect(hasSellerPlanAccess(sub, { now })).toBe(true);
    expect(hasSellerBonusAccess(sub, { now })).toBe(true);
  }
  expect(hasSellerPlanAccess(sub, { now: cancelAt })).toBe(false);
  expect(hasSellerBonusAccess(sub, { now: cancelAt })).toBe(false);
});

test('payment-risk suspension and ended contracts cannot inherit the recovery allowance', () => {
  expect(hasSellerPlanAccess({ ...base, paymentRisk: { suspended: true } }, { now: due })).toBe(false);
  expect(hasSellerPlanAccess({ ...base, safepayBilling: { ...base.safepayBilling, endedAt: due } }, { now: due })).toBe(false);
});

test('bonus expiry is independent of paid Starter access; Elite restores growth tools while active', () => {
  const sub = { ...base, bonusFeaturesActive: false, bonusFeaturesExpiredPermanently: true };
  expect(hasSellerPlanAccess(sub, { now: due })).toBe(true);
  expect(hasSellerBonusAccess(sub, { now: due })).toBe(false);
  expect(hasSellerBonusAccess({ ...sub, plan: 'elite' }, { now: due })).toBe(true);
});

test('trial fallback expires exactly after fifteen days and legacy past-due handling stays explicit', () => {
  const sub = { status: 'trial', trialStartDate: due };
  expect(hasSellerPlanAccess(sub, { now: due })).toBe(true);
  expect(hasSellerPlanAccess(sub, { now: new Date(+due + 15 * 86400000) })).toBe(false);
  expect(hasSellerPlanAccess({ status: 'past_due', billingProvider: 'stripe' }, { allowLegacyPastDue: true })).toBe(true);
  expect(hasSellerPlanAccess({ ...base, status: 'past_due' }, { allowLegacyPastDue: true })).toBe(false);
});
