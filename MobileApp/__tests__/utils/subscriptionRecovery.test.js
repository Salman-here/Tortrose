import { subscriptionRecoveryNotice } from '../../src/utils/subscriptionRecovery';
const fixture = () => ({ status: 'active', renewalRecovery: { active: true, graceActive: true, attempts: 1,
  maxAttempts: 4, failedAt: '2026-10-18T02:00:00Z', cancelAt: '2026-10-24T19:00:00Z',
  nextRetryAt: '2026-10-20T04:00:00Z', timeZone: 'Asia/Karachi' } });
test('mobile recovery uses Pakistan time with a visible retry and deadline', () => {
  const n = subscriptionRecoveryNotice(fixture(), new Date('2026-10-18T03:00:00Z'));
  expect(n.title).toBe('Renewal payment needs attention'); expect(n.body).toContain('1 of 4');
  expect(n.body).toContain('20 Oct 2026, 09:00'); expect(n.body).toContain('24 Oct 2026, 23:59');
});
test('last day warns of cancellation with no extra automatic attempt', () => {
  const sub = fixture(); sub.renewalRecovery.attempts = 4; sub.renewalRecovery.nextRetryAt = null;
  const n = subscriptionRecoveryNotice(sub, new Date('2026-10-24T04:00:00Z'));
  expect(n.title).toBe('Subscription cancels today'); expect(n.body).toContain('No further automatic attempts');
});
test('unknown in-flight result does not invite a duplicate payment', () => {
  const sub = fixture(); sub.pendingBillingOperation = 'pending';
  expect(subscriptionRecoveryNotice(sub, new Date('2026-10-24T19:00:00Z')).body).toContain('do not start a second payment');
});
test('successful or cancelled recovery hides the warning', () => {
  expect(subscriptionRecoveryNotice({ renewalRecovery: null })).toBeNull();
  const sub = fixture(); sub.renewalRecovery.active = false;
  expect(subscriptionRecoveryNotice(sub)).toBeNull();
});
