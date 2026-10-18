import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { subscriptionRecoveryNotice } from '../src/utils/subscriptionRecovery.js';
import { subscriptionStatusConfirmsEntitlement } from '../src/utils/subscriptionPlanChange.js';
const fixture = () => ({ status: 'active', renewalRecovery: { active: true, graceActive: true, attempts: 1,
  maxAttempts: 4, failedAt: '2026-10-18T02:00:00Z', cancelAt: '2026-10-24T19:00:00Z',
  nextRetryAt: '2026-10-20T04:00:00Z', timeZone: 'Asia/Karachi' } });
test('web and mobile share identical recovery presentation', () => {
  assert.equal(readFileSync(new URL('../src/utils/subscriptionRecovery.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/subscriptionRecovery.js', import.meta.url), 'utf8'));
});
test('first failure gives the next retry and an exact end-of-day deadline', () => {
  const notice = subscriptionRecoveryNotice(fixture(), new Date('2026-10-18T03:00:00Z'));
  assert.match(notice.title, /needs attention/); assert.match(notice.body, /1 of 4/);
  assert.match(notice.body, /20 Oct 2026, 09:00/); assert.match(notice.body, /24 Oct 2026, 23:59/);
});
test('day 7 warns today and never promises a fifth attempt', () => {
  const sub = fixture(); sub.renewalRecovery.attempts = 4; sub.renewalRecovery.nextRetryAt = null;
  const notice = subscriptionRecoveryNotice(sub, new Date('2026-10-24T04:00:00Z'));
  assert.equal(notice.title, 'Subscription cancels today'); assert.match(notice.body, /No further automatic/);
});
test('pending verification and an expired window never prompt a second payment', () => {
  const sub = fixture(); sub.pendingBillingOperation = 'pending-invoice';
  assert.match(subscriptionRecoveryNotice(sub, new Date('2026-10-18T03:00:00Z')).body, /No additional automatic charge/);
  assert.match(subscriptionRecoveryNotice(sub, new Date('2026-10-24T19:00:00Z')).body, /do not start a second payment/);
});
test('paid recovery removes the banner; grace is never mistaken for a paid checkout confirmation', () => {
  const sub = fixture(); assert.equal(subscriptionStatusConfirmsEntitlement(sub), false);
  sub.renewalRecovery = null;
  assert.equal(subscriptionRecoveryNotice(sub), null); assert.equal(subscriptionStatusConfirmsEntitlement(sub), true);
  sub.pendingBillingOperation = 'invoice'; assert.equal(subscriptionStatusConfirmsEntitlement(sub), false);
});
