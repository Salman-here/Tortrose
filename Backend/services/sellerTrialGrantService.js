'use strict';

const TRIAL_UNITS = new Set(['days', 'months']);
const TRIAL_MODES = new Set(['reset', 'extend']);
const TRIAL_LIMITS = Object.freeze({ days: 3650, months: 120 });

const trialGrantError = (message, code, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const parsePositiveInteger = (value, label) => {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    throw trialGrantError(
      `${label} must be a positive whole number.`,
      'ADMIN_TRIAL_DURATION_INVALID',
    );
  }
  return value;
};

const normalizeTrialGrantInput = (body = {}) => {
  // Keep the old request shape valid for clients deployed before the new
  // admin modal. Unlike the old controller, malformed input never silently
  // becomes a 15-day grant.
  const isLegacy = body.amount === undefined
    && body.unit === undefined
    && body.mode === undefined
    && body.extensionDays !== undefined;
  const amount = parsePositiveInteger(
    isLegacy ? body.extensionDays : body.amount,
    'Trial duration',
  );
  const unit = isLegacy ? 'days' : String(body.unit || '').trim().toLowerCase();
  const mode = isLegacy ? 'reset' : String(body.mode || '').trim().toLowerCase();

  if (!TRIAL_UNITS.has(unit)) {
    throw trialGrantError(
      'Trial duration unit must be days or months.',
      'ADMIN_TRIAL_UNIT_INVALID',
    );
  }
  if (!TRIAL_MODES.has(mode)) {
    throw trialGrantError(
      'Trial mode must be reset or extend.',
      'ADMIN_TRIAL_MODE_INVALID',
    );
  }
  if (amount > TRIAL_LIMITS[unit]) {
    throw trialGrantError(
      `Trial duration cannot exceed ${TRIAL_LIMITS[unit]} ${unit}.`,
      'ADMIN_TRIAL_DURATION_TOO_LARGE',
    );
  }

  return { amount, unit, mode };
};

const addCalendarMonthsUtc = (date, months) => {
  const result = new Date(date);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
};

const calculateTrialPeriod = ({
  currentTrialEndDate = null,
  amount,
  unit,
  mode,
  now = new Date(),
}) => {
  const currentEnd = currentTrialEndDate ? new Date(currentTrialEndDate) : null;
  const hasFutureEnd = currentEnd && Number.isFinite(currentEnd.getTime()) && currentEnd > now;
  const startsAt = mode === 'extend' && hasFutureEnd ? currentEnd : new Date(now);
  const endsAt = unit === 'months'
    ? addCalendarMonthsUtc(startsAt, amount)
    : (() => {
      const end = new Date(startsAt);
      end.setUTCDate(end.getUTCDate() + amount);
      return end;
    })();

  return {
    startsAt,
    endsAt,
    extendedExistingTrial: mode === 'extend' && Boolean(hasFutureEnd),
  };
};

const assertTrialGrantDoesNotReplacePaidEntitlement = subscription => {
  if (!subscription) return;
  const paidPlan = subscription.plan && subscription.plan !== 'free_trial';
  const paidEntitlementStatus = ['active', 'free_period', 'past_due'].includes(subscription.status);
  if (paidPlan && paidEntitlementStatus) {
    throw trialGrantError(
      'This seller currently has a paid-plan entitlement. End or cancel that entitlement before granting a free trial.',
      'ADMIN_TRIAL_ACTIVE_PAID_ENTITLEMENT',
      409,
    );
  }
};

module.exports = {
  TRIAL_LIMITS,
  addCalendarMonthsUtc,
  assertTrialGrantDoesNotReplacePaidEntitlement,
  calculateTrialPeriod,
  normalizeTrialGrantInput,
  trialGrantError,
};
