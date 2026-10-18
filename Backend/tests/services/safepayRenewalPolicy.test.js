'use strict';
const policy = require('../../services/safepayRenewalPolicy');
const due = new Date('2026-10-18T02:00:00.000Z');
test('four scheduled attempts use days 1, 3, 5 and 7, with cancellation only after the last day', () => {
  const r = { startedAt: due, cancelAt: policy.cancellationDeadline(due), attempts: 1 };
  expect(r.cancelAt.toISOString()).toBe('2026-10-24T19:00:00.000Z');
  expect(policy.nextRetry(r, due).toISOString()).toBe('2026-10-20T04:00:00.000Z');
  r.attempts = 2;
  expect(policy.nextRetry(r, new Date('2026-10-20T04:00:00Z')).toISOString()).toBe('2026-10-22T04:00:00.000Z');
  r.attempts = 3;
  expect(policy.nextRetry(r, new Date('2026-10-22T04:00:00Z')).toISOString()).toBe('2026-10-24T04:00:00.000Z');
  r.attempts = 4;
  expect(policy.nextRetry(r)).toBeNull();
});
test('a near-midnight first failure still sends the last warning at 9am on day 7', () => {
  const start = new Date('2026-10-18T18:59:59Z');
  const r = { startedAt: start, cancelAt: policy.cancellationDeadline(start), attempts: 1 };
  expect(policy.nextRetry(r, start).toISOString()).toBe('2026-10-20T04:00:00.000Z');
  r.attempts = 3;
  expect(policy.nextRetry(r, new Date('2026-10-22T18:59:59Z')).toISOString()).toBe('2026-10-24T04:00:00.000Z');
});
test('late failures skip a calendar day and never compress missed attempts past the deadline', () => {
  const r = { startedAt: due, cancelAt: policy.cancellationDeadline(due), attempts: 2 };
  expect(policy.nextRetry(r, new Date('2026-10-22T10:00:00Z')).toISOString()).toBe('2026-10-24T04:00:00.000Z');
  expect(policy.nextRetry(r, new Date('2026-10-24T04:00:00Z'))).toBeNull();
  expect(policy.nextRetry({ attempts: 1, cancelAt: r.cancelAt }, due)).toBeNull();
});
test.each(['2026-01-29T02:00:00Z', '2028-02-26T02:00:00Z', '2026-12-28T02:00:00Z'])(
  'retry deadlines cross month, leap-year and year boundaries safely: %s', value => {
    const end = policy.cancellationDeadline(value);
    expect(end - new Date(value)).toBeGreaterThan(6 * policy.DAY_MS);
    expect(end - new Date(value)).toBeLessThanOrEqual(7 * policy.DAY_MS);
    expect(end.getUTCHours()).toBe(19);
  });
test('grace belongs to one current contract/cycle and ends at the exact exclusive deadline', () => {
  const s = { billingProvider: 'safepay', status: 'active', currentPeriodEnd: due,
    safepayBilling: { contractId: 'contract-a', cycle: 1, autoRenew: true,
      recovery: { rootOperation: 'invoice-a', contractId: 'contract-a', cycle: 1,
        policyVersion: policy.POLICY_VERSION, startedAt: due, attempts: 1, cancelAt: policy.cancellationDeadline(due) } } };
  expect(policy.hasGraceAccess(s, new Date('2026-10-24T18:59:59Z'))).toBe(true);
  expect(policy.hasGraceAccess(s, new Date('2026-10-24T19:00:00Z'))).toBe(false);
  s.safepayBilling.recovery.cycle = 0;
  expect(policy.ownsRecovery(s)).toBe(false);
  s.status = 'past_due';
  expect(policy.hasGraceAccess(s, due)).toBe(false);
});
