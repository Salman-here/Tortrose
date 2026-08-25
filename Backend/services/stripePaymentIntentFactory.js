'use strict';

const { isSupportedCurrency, normalizeCurrency } = require('./currencyService');

// Stripe documents an eight-digit charge ceiling for every currency this
// application supports (USD, PKR, EUR, and GBP). Keep the provider boundary
// in minor units so 999,999.99 is accepted and 1,000,000.00 is rejected
// identically for all four two-decimal currencies.
const STRIPE_MAX_CHARGE_AMOUNT_MINOR = 99_999_999;

const invalidPaymentIntentParams = message => {
  const error = new TypeError(message);
  error.code = 'STRIPE_PAYMENT_INTENT_PARAMS_INVALID';
  throw error;
};

/**
 * Build a customer-initiated PaymentIntent without pre-authorizing future use.
 * Stripe PaymentSheet adds setup_future_usage only when the buyer explicitly
 * checks its save-card control, as configured by the CustomerSession.
 */
const buildCustomerInitiatedPaymentIntentParams = ({
  amountMinor,
  currency,
  customerId,
  receiptEmail,
  metadata,
}) => {
  if (
    !Number.isSafeInteger(amountMinor)
    || amountMinor <= 0
    || amountMinor > STRIPE_MAX_CHARGE_AMOUNT_MINOR
  ) {
    invalidPaymentIntentParams('Stripe PaymentIntent amount is outside the supported positive minor-unit range.');
  }
  if (
    typeof currency !== 'string'
    || currency !== currency.trim()
    || currency !== currency.toUpperCase()
    || !isSupportedCurrency(currency)
  ) {
    invalidPaymentIntentParams('Stripe PaymentIntent currency is invalid.');
  }
  if (typeof customerId !== 'string' || !customerId.trim()) {
    invalidPaymentIntentParams('Stripe PaymentIntent customer is required.');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    invalidPaymentIntentParams('Stripe PaymentIntent metadata is required.');
  }
  return {
    amount: amountMinor,
    currency: normalizeCurrency(currency).toLowerCase(),
    customer: customerId,
    ...(receiptEmail ? { receipt_email: receiptEmail } : {}),
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    metadata,
  };
};

const isDefinitiveStripeCreationError = (error) => {
  const type = String(error?.type || '');
  if ([
    'StripeAPIError',
    'StripeConnectionError',
    'StripeUnknownError',
    // A prior request may already have created a live object under this key.
    'StripeIdempotencyError',
  ].includes(type)) return false;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN'].includes(error?.code)) return false;
  // Creation is unconfirmed for rate-limit, conflict, external-dependency,
  // card, and generic 4xx classes. Only these explicit pre-mutation classes
  // are safe for the sole fresh creator to close locally.
  return ['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError']
    .includes(type);
};

// Stripe guarantees that an API v1 idempotency result remains available for
// at least 24 hours. Keep a one-hour safety margin: within this window, an
// InvalidRequest response to the exact same account/endpoint/parameters/key
// proves that no earlier endpoint execution was cached. Authentication,
// permission, connection, API and idempotency errors never prove that an
// earlier ambiguous request failed to create an external object.
const STRIPE_IDEMPOTENT_REPLAY_AUTHORITY_MS = 23 * 60 * 60 * 1000;
const isStripeIdempotentReplayWithinAuthorityWindow = ({
  createdAt,
  now = new Date(),
} = {}) => {
  const createdAtMs = new Date(createdAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - createdAtMs;
  return ageMs >= 0 && ageMs <= STRIPE_IDEMPOTENT_REPLAY_AUTHORITY_MS;
};
const isAuthoritativeStripeIdempotentReplayRejection = (
  error,
  { createdAt, now = new Date() } = {},
) => {
  if (String(error?.type || '') !== 'StripeInvalidRequestError') return false;
  return isStripeIdempotentReplayWithinAuthorityWindow({ createdAt, now });
};

module.exports = {
  STRIPE_MAX_CHARGE_AMOUNT_MINOR,
  buildCustomerInitiatedPaymentIntentParams,
  isDefinitiveStripeCreationError,
  isStripeIdempotentReplayWithinAuthorityWindow,
  isAuthoritativeStripeIdempotentReplayRejection,
};
