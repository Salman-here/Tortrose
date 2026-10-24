'use strict';
const { retryTerms, recoveryAnchor } = require('../../services/safepayBillingRecoveryTerms');
const policy = require('../../services/subscriptionBillingTestPolicy');
const at = new Date('2026-10-24T09:00:00.000Z');
let original;
beforeEach(() => {
  original = process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
  process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW = JSON.stringify({ startsAt: '2026-10-24T06:00:00.000Z', untilDisabled: true });
});
afterEach(() => { if (original === undefined) delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW; else process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW = original; });
function fixture(cycle = 4) {
  const stamp = policy.readWindow(process.env, at);
  const previous = { _id: '6adc63509e097ab97b394ba7', terms: { billingTest: stamp, currency: 'USD', dueMinor: 100, monthlyMinor: 100,
    cycle, sourceContractId: 'owned-contract', periodStart: new Date('2026-10-24T07:50:00.000Z'), periodEnd: new Date('2026-10-24T08:10:00.000Z') } };
  const sub = { safepayBilling: { contractId: 'owned-contract', cycle, testClock: { ...stamp } } };
  return { previous, sub };
}
test.each([0, 4, 1201])('expired authorized test cycle %i restarts once without growing its amount or changing source history', cycle => {
  const { previous, sub } = fixture(cycle), saved = JSON.stringify(previous);
  const terms = retryTerms(previous, sub, at);
  expect(JSON.stringify(previous)).toBe(saved);
  expect(terms).toMatchObject({ dueMinor: 100, monthlyMinor: 100, currency: 'USD', cycle });
  expect(terms.periodStart).toEqual(at);
  expect(terms.periodEnd).toEqual(new Date(at.getTime() + 20 * 60000));
  expect(policy.boundary(recoveryAnchor(terms), cycle, terms.billingTest)).toEqual(at);
});
test('a still-current invoice is copied with its exact original dates and no reanchoring', () => {
  const { previous, sub } = fixture(); previous.terms.periodEnd = new Date(at.getTime() + 60000);
  const terms = retryTerms(previous, sub, at);
  expect(terms).toEqual(previous.terms); expect(terms).not.toBe(previous.terms); expect(recoveryAnchor(terms)).toBeNull();
});
test('an expired normal monthly invoice remains fenced', () => {
  const { previous, sub } = fixture(); delete previous.terms.billingTest;
  expect(() => retryTerms(previous, sub, at)).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION_MISSED_PERIOD_REVIEW' }));
});
test.each(['disabled', 'different-window', 'stopped', 'restored', 'wrong-contract', 'wrong-cycle', 'wrong-amount'])('%s cannot reauthorize an expired test invoice', kind => {
  const { previous, sub } = fixture();
  if (kind === 'disabled') delete process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
  if (kind === 'different-window') process.env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW = JSON.stringify({ startsAt: '2026-10-24T06:01:00.000Z', untilDisabled: true });
  if (kind === 'stopped') sub.safepayBilling.testClock.stoppedAt = at;
  if (kind === 'restored') sub.safepayBilling.testClock.restoredAt = at;
  if (kind === 'wrong-contract') sub.safepayBilling.contractId = 'different-contract';
  if (kind === 'wrong-cycle') sub.safepayBilling.cycle += 1;
  if (kind === 'wrong-amount') previous.terms.dueMinor = 200;
  expect(() => retryTerms(previous, sub, at)).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION_MISSED_PERIOD_REVIEW' }));
});
test.each(['periodStart', 'periodEnd', 'anchorAt', 'sourceOperation', 'price'])('corrupt recovery %s is rejected before charge/application', field => {
  const { previous, sub } = fixture(), terms = retryTerms(previous, sub, at);
  if (field === 'periodStart' || field === 'periodEnd') terms[field] = new Date(at.getTime() + 60000);
  if (field === 'anchorAt') terms.billingTestRecovery.anchorAt = at;
  if (field === 'sourceOperation') terms.billingTestRecovery.sourceOperation = 'not-an-operation';
  if (field === 'price') terms.monthlyMinor = 200;
  expect(() => recoveryAnchor(terms)).toThrow(expect.objectContaining({ code: 'SUBSCRIPTION_MISSED_PERIOD_REVIEW' }));
});
