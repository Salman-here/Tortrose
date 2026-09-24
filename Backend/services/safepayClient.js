'use strict';
const { readSafepayConfig } = require('../config/safepay');

const CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const providerError = (message, code, statusCode = 502, extra = {}) => Object.assign(new Error(message), { code, statusCode, ...extra });
const requireId = (value, prefix) => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-zA-Z0-9-]{8,100}$`).test(value)) throw providerError('Invalid Safepay reference.', 'SAFEPAY_REFERENCE_INVALID', 400);
  return value;
};
const requireMoney = (amountMinor, currency) => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !CURRENCIES.has(currency)) throw providerError('Safepay requires an exact positive amount and supported currency.', 'SAFEPAY_MONEY_INVALID', 400);
};
const readMinor = value => {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) throw providerError('Safepay returned invalid money.', 'SAFEPAY_RESPONSE_INVALID');
  return value;
};

function requireTracker(data, expected, config) {
  const tracker = data?.tracker || data;
  requireId(tracker?.token, 'track');
  const merchant = typeof tracker.client === 'string' ? tracker.client : tracker.client?.api_key;
  const quote = tracker.purchase_totals?.quote_amount;
  if (tracker.environment !== config.environment || merchant !== config.publicKey
    || (expected.tracker && tracker.token !== expected.tracker)
    || quote?.currency !== expected.currency || readMinor(quote?.amount) !== expected.amountMinor) {
    throw providerError('Safepay payment identity or amount does not match this checkout.', 'SAFEPAY_PAYMENT_MISMATCH', 409);
  }
  return tracker;
}

function createSafepayClient({ config = readSafepayConfig(), fetchImpl = fetch } = {}) {
  async function request(method, path, payload) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n]/.test(path)) throw providerError('Invalid provider path.', 'SAFEPAY_PATH_INVALID', 400);
    let response;
    try {
      response = await fetchImpl(config.apiHost + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-SFPY-MERCHANT-SECRET': config.secretKey },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    } catch (_) {
      // No automatic retry of mutations: a timed-out create may have succeeded.
      throw providerError('Safepay could not confirm this request. Keep the same payment attempt while it is reconciled.', 'SAFEPAY_REQUEST_UNCERTAIN', 503, { outcomeUnknown: method !== 'GET' });
    }
    let body;
    try { body = await response.json(); } catch (_) { throw providerError('Safepay returned an unreadable response.', 'SAFEPAY_RESPONSE_INVALID', 502, { outcomeUnknown: method !== 'GET' }); }
    if (!response.ok || body?.status?.errors?.length || body?.ok === false) {
      throw providerError('Safepay could not complete this request.', 'SAFEPAY_REQUEST_FAILED', response.status >= 500 ? 503 : 502,
        { providerStatus: response.status, outcomeUnknown: method !== 'GET' && (response.status >= 500 || response.status === 408) });
    }
    if (body?.data === undefined) throw providerError('Safepay response was incomplete.', 'SAFEPAY_RESPONSE_INVALID', 502, { outcomeUnknown: method !== 'GET' });
    return body.data;
  }

  return {
    environment: config.environment,
    async createTracker({ amountMinor, currency, reference, purpose, customerId }) {
      requireMoney(amountMinor, currency);
      if (typeof reference !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(reference)
        || !['order', 'wallet_top_up', 'subdomain'].includes(purpose)) throw providerError('Invalid payment correlation.', 'SAFEPAY_REFERENCE_INVALID', 400);
      if (customerId) requireId(customerId, 'cus');
      const data = await request('POST', '/order/payments/v3/', {
        // Leave entry_mode to the hosted checkout's supported default. This
        // merchant's current sandbox uses "flex"; forcing legacy "raw" fails.
        merchant_api_key: config.publicKey, intent: 'CYBERSOURCE', mode: 'payment',
        amount: amountMinor, currency, include_fees: false, ...(customerId ? { user: customerId } : {}),
        // The current API rejects arbitrary metadata keys with HTTP 500.
        // The immutable reference binds to our own purpose/user/money record.
        metadata: { order_id: reference, source: 'mobile' },
      });
      return requireTracker(data, { amountMinor, currency }, config);
    },
    async getTracker(tracker, expected) {
      requireId(tracker, 'track'); requireMoney(expected.amountMinor, expected.currency);
      const data = await request('GET', `/reporter/api/v1/payments/${encodeURIComponent(tracker)}`);
      return requireTracker(data, { ...expected, tracker }, config);
    },
    async createAuthToken() {
      const token = await request('POST', '/client/passport/v1/token', {});
      if (typeof token !== 'string' || token.length < 16 || token.length > 4096 || /[\r\n]/.test(token)) throw providerError('Invalid checkout authorization.', 'SAFEPAY_RESPONSE_INVALID');
      return token;
    },
    async getSubscription(subscriptionId) {
      requireId(subscriptionId, 'sub');
      return request('GET', `/client/subscriptions/v1/${encodeURIComponent(subscriptionId)}`);
    },
    async getPlan(planId) {
      requireId(planId, 'plan');
      return request('GET', `/client/plans/v1/${encodeURIComponent(planId)}`);
    },
  };
}

module.exports = { createSafepayClient, requireTracker, requireMoney, readMinor, requireId };
