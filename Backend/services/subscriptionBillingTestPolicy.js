'use strict';
// Operator-controlled, global QA window. Never infer it from NODE_ENV or a client.
const crypto = require('node:crypto');
const MINUTE = 60000;
const invalid = () => Object.assign(new Error('The temporary billing test configuration is invalid.'), { code: 'BILLING_TEST_CONFIGURATION_INVALID', statusCode: 503 });
const timestamp = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : null;
function readWindow(env = process.env, at = new Date()) {
  const raw = env.SAFEPAY_SUBSCRIPTION_TEST_WINDOW;
  if (!raw) return null;
  let value; try { value = JSON.parse(raw); } catch { throw invalid(); }
  const start = timestamp(value.startsAt), end = timestamp(value.expiresAt), now = timestamp(at);
  if (start === null || end === null || end <= start || end - start > 120 * MINUTE || now === null) throw invalid();
  if (now < start || now >= end) return null;
  return { id: crypto.createHash('sha256').update(`${start}:${end}`).digest('hex').slice(0, 32),
    startsAt: new Date(start).toISOString(), expiresAt: new Date(end).toISOString(),
    amountMinor: 100, currency: 'USD', starterIntroMinutes: 10, eliteIntroMinutes: 15, renewalMinutes: 20 };
}
function validateStamp(value) {
  const start = timestamp(value?.startsAt), end = timestamp(value?.expiresAt);
  if (!value || !/^[a-f\d]{32}$/.test(value.id || '') || start === null || end === null || end <= start
    || end - start > 120 * MINUTE || value.amountMinor !== 100 || value.currency !== 'USD'
    || value.starterIntroMinutes !== 10 || value.eliteIntroMinutes !== 15 || value.renewalMinutes !== 20
    || crypto.createHash('sha256').update(`${start}:${end}`).digest('hex').slice(0,32) !== value.id) throw invalid();
  return value;
}
function authorized(stamp, at = new Date()) {
  if (!stamp) return false;
  validateStamp(stamp);
  const window = readWindow(process.env, at);
  return window?.id === stamp.id;
}
function introMinutes(stamp, plan) {
  validateStamp(stamp);
  if (!['starter','elite'].includes(plan)) throw invalid();
  return plan === 'starter' ? stamp.starterIntroMinutes : stamp.eliteIntroMinutes;
}
function boundary(anchor, offset, stamp) {
  validateStamp(stamp);
  const time = timestamp(anchor);
  if (time === null || !Number.isSafeInteger(offset) || offset < 0 || offset > 1200) throw invalid();
  return new Date(time + offset * stamp.renewalMinutes * MINUTE);
}
function period({ anchorAt, cycle, now = new Date(), stamp }) {
  const start = boundary(anchorAt, cycle, stamp), end = boundary(anchorAt, cycle + 1, stamp);
  return { start, end, due: new Date(now) >= start && new Date(now) < end, missed: new Date(now) >= end };
}
function terms(stamp, plan, hasIntro) {
  validateStamp(stamp);
  return `Temporary live billing test: authorize 1 USD${hasIntro ? ` after ${introMinutes(stamp, plan)} free minutes, then` : ','} every 20 minutes until ${stamp.expiresAt}. This is real Safepay billing, not sandbox. Both plans and any selected Meta Ads add-on total 1 USD per test cycle; no founder discount is deducted from that test price. Automatic test billing stops at the cutoff. A new test subscription will not switch to a higher regular price automatically; review normal billing before subscribing again. Cancel renewal at any time in Subscription.`;
}
module.exports = { MINUTE, readWindow, validateStamp, authorized, introMinutes, boundary, period, terms, timestamp };
