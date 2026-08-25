const PAYMENT_INTENT_CLIENT_SECRET_PATTERN = /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/;
const STRIPE_PUBLISHABLE_KEY_PATTERN = /^pk_(?:test|live)_[A-Za-z0-9]+$/;

export const isPaymentIntentClientSecret = (value) => (
  typeof value === 'string'
  && value === value.trim()
  && PAYMENT_INTENT_CLIENT_SECRET_PATTERN.test(value)
);

export const isStripePublishableKey = (value) => (
  typeof value === 'string'
  && value === value.trim()
  && STRIPE_PUBLISHABLE_KEY_PATTERN.test(value)
);

export const isPlanChangeActionRequired = (error) => (
  Number(error?.response?.status) === 409
  && error?.response?.data?.code === 'PLAN_CHANGE_ACTION_REQUIRED'
  && error?.response?.data?.actionRequired === true
);

export const getPlanChangeActionClientSecret = (error) => {
  if (!isPlanChangeActionRequired(error)) return null;
  const clientSecret = error?.response?.data?.clientSecret;
  return isPaymentIntentClientSecret(clientSecret) ? clientSecret : null;
};

export const canRetryPlanChangeAfterStripeAction = (result) => {
  if (result?.error) return false;
  const status = String(result?.paymentIntent?.status || '').toLowerCase();
  // `processing` remains server-authoritative: the retry may still return a
  // recoverable pending response, but the client never grants features.
  return ['succeeded', 'processing'].includes(status);
};

export const subscriptionStatusConfirmsEntitlement = (subscription) => (
  ['active', 'free_period'].includes(String(subscription?.status || '').toLowerCase())
);

const addUtcMonthsClamped = (value, months) => {
  const source = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(source.getTime()) || !Number.isSafeInteger(months)) return null;

  const targetMonthIndex = source.getUTCFullYear() * 12 + source.getUTCMonth() + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const targetDay = Math.min(
    source.getUTCDate(),
    new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate(),
  );
  const result = new Date(source.getTime());
  result.setUTCFullYear(targetYear, targetMonth, targetDay);
  return Number.isFinite(result.getTime()) ? result : null;
};

// A promised calendar-month benefit cannot be presented by dividing days by
// 30: for example, January 31 to July 31 is exactly six calendar months but is
// 181 days. Round only a genuine partial calendar month upward.
export const calendarMonthsRemaining = (expiryValue, nowValue = new Date()) => {
  const expiry = expiryValue instanceof Date ? expiryValue : new Date(expiryValue);
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(expiry.getTime()) || !Number.isFinite(now.getTime()) || expiry <= now) {
    return 0;
  }

  let months = (
    (expiry.getUTCFullYear() - now.getUTCFullYear()) * 12
    + expiry.getUTCMonth()
    - now.getUTCMonth()
  );
  if (months < 0) return 0;
  const wholeMonthAnchor = addUtcMonthsClamped(now, months);
  if (!wholeMonthAnchor) return 0;
  if (wholeMonthAnchor < expiry) months += 1;
  return months;
};
