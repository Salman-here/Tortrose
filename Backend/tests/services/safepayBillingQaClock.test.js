'use strict';
const { clockTerms } = require('../../scripts/prepareSafepayBillingQaClock');
const fixture = () => ({ billingProvider: 'safepay', status: 'free_period', plan: 'starter',
  currentPeriodStart: new Date('2026-09-26T06:58:14Z'), safepayBilling: { environment: 'sandbox', autoRenew: true,
    contractId: 'qa-original-contract', consentedAt: new Date('2026-09-26T06:58:14Z'), consentVersion: 'original-consent',
    cycle: 0, monthlyMinor: 999 } });
const at = new Date('2026-10-08T03:00:00Z');
test('QA clock accelerates time only and preserves money, consent, cycle, invoice history and original period start', () => {
  const sub = fixture(), before = JSON.stringify(sub), result = clockTerms(sub, at);
  expect(JSON.stringify(sub)).toBe(before);
  expect(Object.keys(result).sort()).toEqual(['currentPeriodEnd', 'freePeriodEndDate', 'safepayBilling.anchorAt', 'safepayBilling.nextChargeAt'].sort());
  expect(result.currentPeriodEnd).toEqual(new Date('2026-10-08T02:59:59Z'));
});
test('a later cycle retains its key and produces a due monthly boundary without resetting the cycle', () => {
  const sub = fixture(); sub.status = 'active'; sub.safepayBilling.cycle = 2;
  const result = clockTerms(sub, at);
  const boundary = require('../../services/safepayBillingMath').monthlyBoundary(result['safepayBilling.anchorAt'], 2);
  expect(boundary).toEqual(result.currentPeriodEnd); expect(result.freePeriodEndDate).toBeUndefined();
  expect(result['safepayBilling.cycle']).toBeUndefined();
});
test.each([
  sub => { sub.safepayBilling.environment = 'production'; },
  sub => { sub.status = 'past_due'; },
  sub => { sub.safepayBilling.autoRenew = false; },
  sub => { sub.safepayBilling.pendingOperation = 'pending'; },
  sub => { sub.safepayBilling.monthlyMinor = 405100; },
  sub => { sub.safepayBilling.consentedAt = null; },
  sub => { sub.cancelledAt = at; },
  sub => { sub.paymentRisk = { suspended: true }; },
])('unsafe or non-standard fixtures are rejected before any write', mutate => {
  const sub = fixture(); mutate(sub); expect(() => clockTerms(sub, at)).toThrow('QA_CLOCK_STATE_UNSAFE');
});
