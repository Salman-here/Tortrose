'use strict';

// A renewal has four scheduled collection attempts on days 1, 3, 5 and 7.
// Pakistan time is the frozen billing calendar; clients display its exact
// deadline too, so a seller in another time zone never has to guess midnight.
const DAY_MS = 86400000;
const ATTEMPT_DAYS = Object.freeze([1, 3, 5, 7]);
const BILLING_TIME_ZONE = 'Asia/Karachi';
const BILLING_OFFSET_MS = 5 * 3600000;
const RETRY_HOUR_LOCAL = 9;
const POLICY_VERSION = 'rozare-renewal-days-1-3-5-7-v1';
const time = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;
const id = value => String(value?._id || value || '');

function cancellationDeadline(startedAt) {
  const start = time(startedAt);
  if (start === null) throw new TypeError('A valid renewal due date is required.');
  const localDay = Math.floor((start + BILLING_OFFSET_MS) / DAY_MS);
  return new Date((localDay + 7) * DAY_MS - BILLING_OFFSET_MS);
}

function ownsRecovery(sub) {
  const b = sub?.safepayBilling, r = b?.recovery;
  return sub?.billingProvider === 'safepay' && Boolean(r?.rootOperation)
    && r.contractId === b.contractId && r.cycle === b.cycle
    && r.policyVersion === POLICY_VERSION && time(r.cancelAt) !== null;
}

function graceDeadline(sub) {
  const b = sub?.safepayBilling;
  if (sub?.billingProvider !== 'safepay' || !b?.autoRenew || b.endedAt || sub.paymentRisk?.suspended
    || sub.cancelledAt && !sub.pendingDowngrade?.toPlan) return null;
  if (ownsRecovery(sub)) return new Date(b.recovery.cancelAt);
  // A read immediately after period end must not remove access while the
  // worker is still preparing the first invoice. It never authorizes a charge.
  if (!['active', 'free_period'].includes(sub.status) || b.lastFailedOperation || !b.contractId
    || !b.consentedAt || !time(sub.currentPeriodEnd)) return null;
  return cancellationDeadline(sub.currentPeriodEnd);
}

function hasGraceAccess(sub, at = new Date()) {
  const end = graceDeadline(sub), now = time(at), due = time(sub?.currentPeriodEnd);
  return Boolean(end && now !== null && due !== null && now >= due && now < end.getTime());
}

function nextRetry(recovery, failedAt = new Date()) {
  if (!Number.isSafeInteger(recovery?.attempts) || recovery.attempts < 1 || recovery.attempts >= ATTEMPT_DAYS.length) return null;
  const start = time(recovery.startedAt), failed = time(failedAt), end = time(recovery.cancelAt);
  if (start === null || failed === null || end === null) return null;
  const localDay = value => Math.floor((value + BILLING_OFFSET_MS) / DAY_MS);
  // Retry at 09:00 Pakistan time, leaving the whole remaining final day to
  // fix a card even when the first renewal was due shortly before midnight.
  // A delayed worker still skips a calendar day instead of bunching charges.
  const retryDay = Math.max(localDay(start) + ATTEMPT_DAYS[recovery.attempts] - 1, localDay(failed) + 2);
  const next = retryDay * DAY_MS + RETRY_HOUR_LOCAL * 3600000 - BILLING_OFFSET_MS;
  return next < time(recovery.cancelAt) ? new Date(next) : null;
}

function failureNotice(sub, op, at = new Date()) {
  const r = sub.safepayBilling.recovery;
  const finalDay = Math.floor((time(at) + BILLING_OFFSET_MS) / DAY_MS)
    === Math.floor((time(r.cancelAt) - 1 + BILLING_OFFSET_MS) / DAY_MS);
  const format = value => new Intl.DateTimeFormat('en-GB', { timeZone: BILLING_TIME_ZONE,
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  const due = `Your ${op.terms.planName} renewal payment of {{money.charged}} was unsuccessful.`;
  const retry = r.nextRetryAt ? ` We will retry on ${format(r.nextRetryAt)} (Pakistan time).` : ' No further automatic attempts are scheduled for this renewal.';
  const cutoff = new Date(time(r.cancelAt) - 1);
  const ending = time(at) >= time(r.cancelAt) ? ' The seven-day recovery period has ended. Your renewal remains unpaid and cancellation is being finalized.'
    : finalDay ? ` Your subscription will be cancelled today at the end of the day (${format(cutoff)}, Pakistan time).`
    : ` Your subscription remains active through ${format(cutoff)} (Pakistan time) and will be cancelled afterward if the renewal is still unpaid.`;
  return { title: finalDay ? 'Subscription cancels today — update your payment card' : 'Subscription renewal payment unsuccessful',
    body: `${due}${retry}${ending} Update your subscription card or retry payment in Subscription. A successful payment stops the remaining reminders and automatic attempts.`,
    snapshot: { policyVersion: POLICY_VERSION, rootOperation: id(r.rootOperation), attempt: r.attempts,
      maxAttempts: ATTEMPT_DAYS.length, nextRetryAt: r.nextRetryAt || null, cancelAt: r.cancelAt,
      timeZone: BILLING_TIME_ZONE, finalDay } };
}

function presentation(sub, at = new Date()) {
  if (!ownsRecovery(sub)) return null;
  const r = sub.safepayBilling.recovery;
  return { active: Boolean(sub.safepayBilling.autoRenew && !sub.safepayBilling.endedAt),
    graceActive: hasGraceAccess(sub, at), attempts: r.attempts, maxAttempts: ATTEMPT_DAYS.length,
    attemptDays: [...ATTEMPT_DAYS], nextRetryAt: r.nextRetryAt || null, cancelAt: r.cancelAt,
    timeZone: BILLING_TIME_ZONE, failedAt: r.lastFailureAt || null, cancelledAt: r.cancelledAt || null };
}

module.exports = { DAY_MS, ATTEMPT_DAYS, BILLING_TIME_ZONE, POLICY_VERSION,
  cancellationDeadline, ownsRecovery, graceDeadline, hasGraceAccess, nextRetry, failureNotice, presentation };
