'use strict';

const {
  isSupportedCurrency,
  normalizeCurrency,
} = require('./currencyService');
const { requireSellerProductCurrency } = require('./storeProductCurrencyService');

const LEGACY_SELLER_SIGNUP_PRODUCT_CURRENCY = 'USD';

const hasOwn = (value, key) => (
  Boolean(value)
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key)
);

const invalidRequestedCurrency = () => {
  const error = new Error('Choose a supported product currency: USD, PKR, EUR, or GBP.');
  error.status = 400;
  error.statusCode = 400;
  error.code = 'SELLER_PRODUCT_CURRENCY_INVALID';
  return error;
};

const invalidFrozenCurrency = () => {
  const error = new Error('The seller signup product currency record is invalid. Please request a new verification code.');
  error.status = 409;
  error.statusCode = 409;
  error.code = 'SELLER_SIGNUP_PRODUCT_CURRENCY_INVALID';
  return error;
};

function normalizeRequestedSellerProductCurrency(value) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || !isSupportedCurrency(value)
  ) {
    throw invalidRequestedCurrency();
  }
  return normalizeCurrency(value);
}

/**
 * Existing buyers already have an authoritative display/account currency. A
 * seller may explicitly choose another supported listing currency during
 * onboarding; if the field is omitted by an older client, never infer from an
 * address or an arbitrary request field.
 */
function productCurrencyForBecomeSeller(user, requestBody = {}) {
  if (hasOwn(requestBody, 'productCurrency')) {
    return normalizeRequestedSellerProductCurrency(requestBody.productCurrency);
  }
  return requireSellerProductCurrency(user);
}

/**
 * Direct seller signup has no persisted User yet. Preserve compatibility with
 * older clients by selecting the documented legacy default once, then freeze
 * that exact canonical value in the OTP record before the code is sent.
 */
function productCurrencyForSellerSignupOtp(requestBody = {}) {
  if (!hasOwn(requestBody, 'productCurrency') || requestBody.productCurrency === undefined) {
    return LEGACY_SELLER_SIGNUP_PRODUCT_CURRENCY;
  }
  return normalizeRequestedSellerProductCurrency(requestBody.productCurrency);
}

/**
 * Verification must use only the value frozen with the OTP. The verify request
 * is intentionally not accepted here, so a client cannot swap currencies after
 * proving control of the email address.
 */
function productCurrencyFromSellerSignupOtp(userData) {
  if (!hasOwn(userData, 'productCurrency') || userData.productCurrency === undefined) {
    return LEGACY_SELLER_SIGNUP_PRODUCT_CURRENCY;
  }
  try {
    return normalizeRequestedSellerProductCurrency(userData.productCurrency);
  } catch (_error) {
    throw invalidFrozenCurrency();
  }
}

module.exports = {
  LEGACY_SELLER_SIGNUP_PRODUCT_CURRENCY,
  normalizeRequestedSellerProductCurrency,
  productCurrencyForBecomeSeller,
  productCurrencyForSellerSignupOtp,
  productCurrencyFromSellerSignupOtp,
};
