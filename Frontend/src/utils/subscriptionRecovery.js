export function subscriptionRecoveryNotice(subscription, now = new Date()) {
  const r = subscription?.renewalRecovery;
  if (!r?.active || !r.failedAt) return null;
  const end = new Date(r.cancelAt).getTime();
  if (!Number.isFinite(end) || !Number.isSafeInteger(r.attempts) || r.attempts < 1 || r.attempts > 4) return null;
  const format = value => new Intl.DateTimeFormat('en-GB', { timeZone: r.timeZone || 'Asia/Karachi',
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  const finalDay = Math.floor((new Date(now).getTime() + 5 * 3600000) / 86400000)
    === Math.floor((end - 1 + 5 * 3600000) / 86400000);
  if (end <= new Date(now).getTime()) return { title: 'Renewal payment is being checked',
    body: 'Your recovery period has ended. We are verifying an existing payment before any final cancellation. Check the billing status; do not start a second payment while verification is pending.' };
  const next = subscription.pendingBillingOperation ? 'A payment is being verified. No additional automatic charge will start while its result is unknown.'
    : r.nextRetryAt ? `Next automatic attempt: ${format(r.nextRetryAt)} (Pakistan time).`
      : 'No further automatic attempts are scheduled for this renewal.';
  return { title: finalDay ? 'Subscription cancels today' : 'Renewal payment needs attention',
    body: `${r.attempts} of ${r.maxAttempts || 4} scheduled attempts started. ${next} Your plan and store remain active through ${format(end - 1)} (Pakistan time). Update your subscription card or retry payment before then to avoid cancellation.` };
}
