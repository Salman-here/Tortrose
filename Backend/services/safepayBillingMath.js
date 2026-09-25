'use strict';
const error = message => Object.assign(new Error(message), { code: 'SUBSCRIPTION_BILLING_TERMS_INVALID', statusCode: 409 });
const instant = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (value === null || value === undefined || !Number.isFinite(date.getTime())) throw error(`Invalid ${label}.`);
  return date;
};
const minor = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw error('Subscription amounts must be exact non-negative minor units.');
  return value;
};
const roundedRatio = (amount, numerator, denominator) => {
  const n = BigInt(minor(amount)) * BigInt(numerator), d = BigInt(denominator);
  const result = Number((n * 2n + d) / (d * 2n));
  if (!Number.isSafeInteger(result)) throw error('Subscription amount exceeds the supported range.');
  return result;
};

// Always calculate from the original anchor. Advancing February 28 directly
// would otherwise turn a January 31 subscription into a permanent 28th cycle.
function monthlyBoundary(anchorValue, offset) {
  const anchor = instant(anchorValue, 'billing anchor');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1200) throw error('Invalid billing cycle.');
  const year = anchor.getUTCFullYear(), month = anchor.getUTCMonth() + offset;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), last), anchor.getUTCHours(),
    anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

function proratedPlanChange({ sourceMinor, targetMinor, periodStart, periodEnd, at }) {
  minor(sourceMinor); minor(targetMinor);
  const start = Math.floor(instant(periodStart, 'period start').getTime() / 1000);
  const end = Math.floor(instant(periodEnd, 'period end').getTime() / 1000);
  const requested = Math.floor(instant(at, 'plan change date').getTime() / 1000);
  if (end <= start || requested < start || requested >= end) throw error('The subscription billing period is no longer current.');
  const remaining = end - requested, duration = end - start;
  // Preserve separately auditable unused-time credit and remaining-time
  // charge. No floating-point multiplication or current exchange rate.
  const unusedCreditMinor = roundedRatio(sourceMinor, remaining, duration);
  const remainingChargeMinor = roundedRatio(targetMinor, remaining, duration);
  const net = remainingChargeMinor - unusedCreditMinor;
  return { unusedCreditMinor, remainingChargeMinor, dueMinor: Math.max(0, net), creditMinor: Math.max(0, -net),
    periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000), calculatedAt: new Date(requested * 1000) };
}

function renewalPeriod({ anchorAt, cycle, now = new Date() }) {
  const start = monthlyBoundary(anchorAt, cycle), end = monthlyBoundary(anchorAt, cycle + 1);
  const current = instant(now, 'renewal time');
  return { start, end, due: current >= start && current < end, missed: current >= end };
}

function applyBillingCredit(dueMinor, creditMinor) {
  minor(dueMinor); minor(creditMinor);
  const appliedCreditMinor = Math.min(dueMinor, creditMinor);
  return { grossMinor: dueMinor, appliedCreditMinor, chargeMinor: dueMinor - appliedCreditMinor, remainingCreditMinor: creditMinor - appliedCreditMinor };
}
module.exports = { monthlyBoundary, proratedPlanChange, renewalPeriod, applyBillingCredit };
