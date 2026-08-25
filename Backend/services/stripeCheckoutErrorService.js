'use strict';

/**
 * Stripe owns minimum-charge policy because it depends on the account's
 * settlement currency and payment-method configuration. Trust only Stripe's
 * structured API rejection; never infer the current minimum from a message or
 * duplicate Stripe's mutable currency table in application code.
 */
const isAuthoritativeStripeAmountTooSmallError = error => {
  const code = String(error?.code || error?.raw?.code || '');
  const type = String(error?.type || '');
  const rawType = String(error?.raw?.type || '');
  const statusCode = Number(error?.statusCode || error?.raw?.statusCode || error?.status);
  const param = String(error?.param || error?.raw?.param || '').toLowerCase();
  const amountParam = Boolean(param)
    && /(?:^|\[|\.|_)(?:amount|amount_off|line_items|price_data|unit_amount)(?:$|\]|\.|_)/.test(param);

  return code === 'amount_too_small'
    && statusCode === 400
    && amountParam
    && (type === 'StripeInvalidRequestError' || rawType === 'invalid_request_error');
};

const isAuthoritativeStripeResourceMissingError = error => {
  const code = String(error?.code || error?.raw?.code || '');
  const type = String(error?.type || '');
  const rawType = String(error?.raw?.type || '');
  const statusCode = Number(error?.statusCode || error?.raw?.statusCode || error?.status);
  return code === 'resource_missing'
    && statusCode === 404
    && (type === 'StripeInvalidRequestError' || rawType === 'invalid_request_error');
};

module.exports = {
  isAuthoritativeStripeAmountTooSmallError,
  isAuthoritativeStripeResourceMissingError,
};
