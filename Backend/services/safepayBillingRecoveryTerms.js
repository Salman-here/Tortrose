'use strict';
const testPolicy = require('./subscriptionBillingTestPolicy');
const POLICY = 'rozare-test-recovery-current-cycle-v1';
const fail = () => Object.assign(new Error('That billing period has ended. Review a current billing quote before paying.'),
  { code: 'SUBSCRIPTION_MISSED_PERIOD_REVIEW', statusCode: 409 });

// Normal monthly invoices keep their original price and funded period. Only an
// explicitly enabled $1 test can restart an expired, definitively unpaid cycle.
// This is a new immutable invoice; neither the failed invoice nor payment moves.
function retryTerms(previous, sub, at = new Date()) {
  const terms = previous.terms, end = testPolicy.timestamp(terms.periodEnd), now = testPolicy.timestamp(at);
  if (end === null || now === null) throw fail();
  if (end > now) return { ...terms };
  const stamp = terms.billingTest, clock = sub.safepayBilling?.testClock;
  if (!stamp || !testPolicy.authorized(stamp, at) || clock?.id !== stamp.id || clock.stoppedAt || clock.restoredAt
    || terms.currency !== 'USD' || terms.dueMinor !== 100 || terms.monthlyMinor !== 100
    || !Number.isSafeInteger(terms.cycle) || terms.cycle < 0 || terms.cycle !== sub.safepayBilling.cycle
    || terms.sourceContractId !== sub.safepayBilling.contractId) throw fail();
  const anchor = new Date(now - terms.cycle * stamp.renewalMinutes * testPolicy.MINUTE);
  if (testPolicy.timestamp(anchor) === null) throw fail();
  const restarted = { ...terms, periodStart: new Date(now), periodEnd: testPolicy.boundary(at, 1, stamp),
    billingTestRecovery: { policy: POLICY, sourceOperation: String(previous._id),
      sourcePeriodStart: terms.periodStart, sourcePeriodEnd: terms.periodEnd, anchorAt: anchor } };
  recoveryAnchor(restarted);
  return restarted;
}

// Applied only after the exact provider-verified payment succeeds. Reanchoring
// prevents the worker from collecting missed 20-minute cycles as catch-up fees.
function recoveryAnchor(terms) {
  const recovery = terms.billingTestRecovery;
  if (!recovery) return null;
  const stamp = terms.billingTest;
  if (!stamp || recovery.policy !== POLICY || !/^[a-f\d]{24}$/.test(recovery.sourceOperation || '')
    || terms.currency !== 'USD' || terms.dueMinor !== 100 || terms.monthlyMinor !== 100
    || testPolicy.timestamp(recovery.sourcePeriodEnd) === null
    || testPolicy.timestamp(recovery.sourcePeriodEnd) > testPolicy.timestamp(terms.periodStart)
    || testPolicy.timestamp(recovery.anchorAt) === null) throw fail();
  if (testPolicy.boundary(recovery.anchorAt, terms.cycle, stamp).getTime() !== testPolicy.timestamp(terms.periodStart)
    || testPolicy.boundary(recovery.anchorAt, terms.cycle + 1, stamp).getTime() !== testPolicy.timestamp(terms.periodEnd)) throw fail();
  return new Date(recovery.anchorAt);
}

module.exports = { retryTerms, recoveryAnchor };
