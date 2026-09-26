'use strict';
const { readSafepayConfig } = require('../config/safepay');

const CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);
const providerError = (message, code, statusCode = 502, extra = {}) => Object.assign(new Error(message), { code, statusCode, ...extra });
const requireId = (value, prefix) => {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-zA-Z0-9-]{8,100}$`).test(value)) throw providerError('Invalid Safepay reference.', 'SAFEPAY_REFERENCE_INVALID', 400);
  return value;
};
const requireMoney = (amountMinor, currency, { allowZero = false } = {}) => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < (allowZero ? 0 : 1) || !CURRENCIES.has(currency)) throw providerError('Safepay requires an exact amount and supported currency.', 'SAFEPAY_MONEY_INVALID', 400);
};
const readMinor = value => {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0) throw providerError('Safepay returned invalid money.', 'SAFEPAY_RESPONSE_INVALID');
  return value;
};
const trackerReference = tracker => {
  const metadata = tracker?.metadata?.data || tracker?.metadata;
  const reference = metadata?.order_id;
  return typeof reference === 'string' ? reference : reference?.value;
};
// Mongoose document fields are getters, not enumerable own properties.
// Select the immutable contract explicitly instead of spreading a document.
const trackerExpectation = (expected, tracker) => ({ tracker, amountMinor: expected.amountMinor,
  currency: expected.currency, reference: expected.reference, providerMode: expected.providerMode,
  customerId: expected.customerId });

function requireTracker(data, expected, config) {
  const tracker = data?.tracker || data;
  requireId(tracker?.token, 'track');
  const merchant = typeof tracker.client === 'string' ? tracker.client : tracker.client?.api_key;
  const quote = tracker.purchase_totals?.quote_amount;
  const expectedMode = expected.providerMode || 'payment';
  const customer = typeof tracker.customer === 'string' ? tracker.customer : tracker.customer?.token;
  if (tracker.environment !== config.environment || merchant !== config.publicKey
    || (expected.tracker && tracker.token !== expected.tracker)
    || (expected.reference && trackerReference(tracker) !== expected.reference)
    || !['payment', 'instrument', 'subscription'].includes(expectedMode) || tracker.mode !== expectedMode
    || (expectedMode === 'subscription' && tracker.entry_mode !== 'mit')
    || (expected.customerId && customer !== expected.customerId)
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
      const mode = purpose === 'card_setup' ? 'instrument' : purpose === 'subscription' ? 'subscription' : 'payment';
      requireMoney(amountMinor, currency, { allowZero: mode === 'instrument' });
      if (mode === 'instrument' && amountMinor !== 0) throw providerError('Card verification must not charge a purchase amount.', 'SAFEPAY_MONEY_INVALID', 400);
      if (typeof reference !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(reference)
        || !['order', 'wallet_top_up', 'subdomain', 'return_settlement', 'card_setup', 'subscription'].includes(purpose)) throw providerError('Invalid payment correlation.', 'SAFEPAY_REFERENCE_INVALID', 400);
      if (customerId) requireId(customerId, 'cus');
      if (mode !== 'payment' && !customerId) throw providerError('An owned customer is required for saved-card operations.', 'SAFEPAY_CUSTOMER_REQUIRED', 400);
      const data = await request('POST', '/order/payments/v3/', {
        // Leave entry_mode to the hosted checkout's supported default. This
        // merchant's current sandbox uses "flex"; forcing legacy "raw" fails.
        merchant_api_key: config.publicKey, intent: 'CYBERSOURCE', mode,
        ...(mode === 'instrument' ? { is_account_verification: true } : { amount: amountMinor }),
        ...(mode === 'subscription' ? { entry_mode: 'mit' } : {}),
        currency, include_fees: false, ...(customerId ? { user: customerId } : {}),
        // The current API rejects arbitrary metadata keys with HTTP 500.
        // The immutable reference binds to our own purpose/user/money record.
        metadata: { order_id: reference, source: 'mobile' },
      });
      return requireTracker(data, { amountMinor, currency, reference, customerId, providerMode: mode }, config);
    },
    async getTracker(tracker, expected) {
      requireId(tracker, 'track'); requireMoney(expected.amountMinor, expected.currency, { allowZero: expected.providerMode === 'instrument' });
      const data = await request('GET', `/reporter/api/v1/payments/${encodeURIComponent(tracker)}`);
      return requireTracker(data, trackerExpectation(expected, tracker), config);
    },
    async createAuthToken() {
      const token = await request('POST', '/client/passport/v1/token', {});
      if (typeof token !== 'string' || token.length < 16 || token.length > 4096 || /[\r\n]/.test(token)) throw providerError('Invalid checkout authorization.', 'SAFEPAY_RESPONSE_INVALID');
      return token;
    },
    async findTrackerByReference(expected) {
      // An uncertain create is never repeated. Search the reporter and then
      // retrieve the full, merchant-owned object before attaching it locally.
      // A bounded/incomplete search is not proof that no payment was created.
      const matches = new Set();
      for (let page = 1; page <= 20; page++) {
        const query = new URLSearchParams({ limit: '30', page: String(page), direction: 'DESC',
          'meta_keys[0]': 'order_id', 'meta_values[0]': expected.reference });
        ['TRACKER_STARTED', 'TRACKER_ENROLLED', 'TRACKER_AUTHORIZED', 'TRACKER_ENDED', 'TRACKER_CANCELLED',
          'TRACKER_EXPIRED', 'TRACKER_REFUNDED', 'TRACKER_PARTIAL_REFUND', 'TRACKER_DISPUTED',
          'TRACKER_REVERSED', 'TRACKER_VOIDED'].forEach((state, index) => query.set(`states[${index}]`, state));
        const data = await request('GET', '/reporter/api/v2/payments?' + query);
        if (data === null || (Array.isArray(data) && !data.length)) break;
        if (!Array.isArray(data.list)) throw providerError('Safepay search was incomplete.', 'SAFEPAY_RESPONSE_INVALID');
        for (const row of data.list) if (trackerReference(row) === expected.reference) matches.add(requireId(row.token, 'track'));
        if (matches.size > 1) throw providerError('More than one payment matches this checkout. Support must reconcile it.', 'SAFEPAY_DUPLICATE_REFERENCE', 409);
        if (data.list.length < 30) break;
        if (page === 20) throw providerError('Payment recovery is still pending.', 'SAFEPAY_RECOVERY_PENDING', 503);
      }
      if (!matches.size) return null;
      return this.getTracker([...matches][0], expected);
    },
    buildPaymentCheckoutUrl({ tracker, authToken, reference, redirectUrl, cancelUrl, customerId, source = 'hosted' }) {
      requireId(tracker, 'track');
      if (customerId) requireId(customerId, 'cus');
      for (const value of [redirectUrl, cancelUrl]) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw providerError('Invalid payment return URL.', 'SAFEPAY_RETURN_URL_INVALID', 500);
      }
      if (typeof authToken !== 'string' || authToken.length < 16 || !reference) throw providerError('Invalid checkout authorization.', 'SAFEPAY_RESPONSE_INVALID');
      if (!['hosted', 'mobile'].includes(source)) throw providerError('Invalid checkout presentation.', 'SAFEPAY_CHECKOUT_SOURCE_INVALID', 400);
      // Mobile source exposes the provider's documented embedded exit paths.
      const url = new URL('/embedded/', config.checkoutHost);
      url.search = new URLSearchParams({ environment: config.environment, tracker, tbt: authToken,
        source, order_id: reference, redirect_url: redirectUrl, cancel_url: cancelUrl,
        ...(customerId ? { user_id: customerId } : {}) }).toString();
      return url.toString();
    },
    async createCustomer(contact) {
      const { first_name, last_name, email, phone_number, country } = contact;
      const data = await request('POST', '/user/customers/v1/', { first_name, last_name, email, phone_number, country, is_guest: false });
      return requireCustomer(data, config);
    },
    async getCustomer(customerId) {
      requireId(customerId, 'cus');
      return requireCustomer(await request('GET', `/user/customers/v1/${customerId}`), config, customerId);
    },
    async listCards(customerId) {
      requireId(customerId, 'cus');
      const cards = [];
      for (let page = 1; page <= 20; page++) {
        const data = await request('GET', `/user/customers/v1/${customerId}/wallet/?limit=30&page=${page}`);
        if (!Array.isArray(data?.wallet)) throw providerError('Saved cards could not be verified.', 'SAFEPAY_RESPONSE_INVALID');
        for (const card of data.wallet) cards.push(requireOwnedCard(card, customerId, config));
        if (data.wallet.length < 30) return cards;
      }
      throw providerError('Saved card listing was incomplete.', 'SAFEPAY_CARD_LIST_INCOMPLETE', 503);
    },
    async getCard(customerId, cardId) {
      requireId(customerId, 'cus'); requireId(cardId, 'pm');
      const card = await request('GET', `/user/customers/v1/${customerId}/wallet/${cardId}`);
      return requireOwnedCard(card, customerId, config, cardId);
    },
    async deleteCard(customerId, cardId) {
      await this.getCard(customerId, cardId);
      // A delete timeout is not retried as a different operation. A subsequent
      // owned list can confirm whether the same card is already removed.
      return request('DELETE', `/user/customers/v1/${customerId}/wallet/${cardId}`);
    },
    async chargeRecurring(trackerId, expected, cardId) {
      if (expected.providerMode !== 'subscription' || !expected.customerId) throw providerError('Invalid recurring charge binding.', 'SAFEPAY_RECURRING_BINDING_INVALID', 409);
      const tracker = await this.getTracker(trackerId, expected);
      if (tracker.state === 'TRACKER_ENDED') return tracker;
      if (tracker.state !== 'TRACKER_STARTED') throw providerError('This recurring payment cannot be submitted again.', 'SAFEPAY_RECURRING_STATE_INVALID', 409);
      const card = await this.getCard(expected.customerId, cardId);
      requireReusableCard(card);
      const data = await request('POST', `/order/payments/v3/${trackerId}`, { payload: {
        authorization: { do_capture: true }, payment_method: { tokenized_card: { token: card.token } },
      }, use_action_chaining: true });
      try { return requireTracker(data, trackerExpectation(expected, trackerId), config); }
      catch (error) { error.outcomeUnknown = true; throw error; }
    },
    async getSubscription(subscriptionId) {
      requireId(subscriptionId, 'sub');
      return request('GET', `/client/subscriptions/v1/${encodeURIComponent(subscriptionId)}`);
    },
    async refundRemainingPayment(trackerId, expected) {
      const tracker = await this.getTracker(trackerId, expected);
      if (tracker.state === 'TRACKER_REFUNDED') return tracker;
      const charge = tracker.charge;
      if (!['TRACKER_ENDED', 'TRACKER_PARTIAL_REFUND'].includes(tracker.state)
        || charge?.tracker !== trackerId || charge.amount?.currency !== expected.currency
        || readMinor(charge.amount.amount) !== expected.amountMinor || charge.balance?.currency !== expected.currency
        || readMinor(charge.balance.amount) <= 0 || readMinor(charge.balance.amount) > expected.amountMinor) {
        throw providerError('The remaining original-currency refund could not be verified.', 'SAFEPAY_REFUND_EVIDENCE_INVALID', 409);
      }
      const data = await request('POST', `/order/payments/v3/${trackerId}/refund`, { amount: readMinor(charge.balance.amount), currency: expected.currency });
      try { return requireTracker(data, trackerExpectation(expected, trackerId), config); }
      catch (error) { error.outcomeUnknown = true; throw error; }
    },
    async getPlan(planId) {
      requireId(planId, 'plan');
      return request('GET', `/client/plans/v1/${encodeURIComponent(planId)}/`);
    },
  };
}

function requireCustomer(data, config, expectedId) {
  const customer = data?.customer || data;
  requireId(customer?.token, 'cus');
  if ((expectedId && customer.token !== expectedId) || customer.merchant_api_key !== config.publicKey
      || customer.is_guest !== false || customer.is_deleted === true) throw providerError('Safepay customer ownership is invalid.', 'SAFEPAY_CUSTOMER_MISMATCH', 409);
  return customer;
}
function requireOwnedCard(data, customerId, config, expectedId) {
  const card = data?.payment_method || data;
  requireId(card?.token, 'pm');
  if ((expectedId && card.token !== expectedId) || card.customer !== customerId || card.merchant_api_key !== config.publicKey
      || card.is_deleted !== false) throw providerError('The saved card does not belong to this account.', 'SAFEPAY_CARD_MISMATCH', 409);
  return card;
}
function requireReusableCard(card, at = new Date()) {
  const expiry = card?.expires_at?.seconds;
  if (card?.max_usage !== -1 || !card.cybersource?.token || !/^\d{4}$/.test(card.cybersource.last_four || '')
    || !Number.isFinite(Number(expiry)) || Number(expiry) * 1000 <= at.getTime()) {
    throw providerError('Please add a reusable card and explicitly choose to save it for future payments.', 'SAFEPAY_REUSABLE_CARD_REQUIRED', 409);
  }
  return card;
}
module.exports = { createSafepayClient, requireTracker, requireMoney, readMinor, requireId, requireOwnedCard, requireReusableCard };
