'use strict';
const { readSafepayConfig } = require('../../config/safepay');
const { createSafepayClient, requireTracker, requireMoney, requireReusableCard } = require('../../services/safepayClient');
const env = { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_sandbox-fixture', SAFEPAY_SANDBOX_SECRET_KEY: 'private-test-secret-never-log' };
const config = readSafepayConfig(env);
const tracker = { token: 'track_checkout-fixture', environment: 'sandbox', client: config.publicKey, mode: 'payment', metadata: { data: { order_id: 'order:fixture123' } }, state: 'TRACKER_STARTED', purchase_totals: { quote_amount: { amount: 10000, currency: 'PKR' } } };

test('environment selection cannot fall back to production or Stripe credentials', () => {
  expect(config.apiHost).toBe('https://sandbox.api.getsafepay.com');
  expect(() => readSafepayConfig({ ...env, SAFEPAY_ENV: 'production' })).toThrow();
  expect(() => readSafepayConfig({ ...env, SAFEPAY_ENV: 'https://attacker.example' })).toThrow();
  expect(() => readSafepayConfig(env, { requireWebhook: true })).toThrow();
});
test('valid tracker setup uses exact minor units and owned correlation without adding buyer fees', async () => {
  const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { tracker } }) }));
  const client = createSafepayClient({ config, fetchImpl });
  expect(await client.createTracker({ amountMinor: 10000, currency: 'PKR', reference: 'order:fixture123', purpose: 'order' })).toEqual(tracker);
  const [url, request] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://sandbox.api.getsafepay.com/order/payments/v3/');
  expect(JSON.parse(request.body)).toMatchObject({ amount: 10000, currency: 'PKR', include_fees: false, metadata: { order_id: 'order:fixture123', source: 'mobile' } });
  expect(JSON.parse(request.body).entry_mode).toBeUndefined();
  expect(request.redirect).toBe('error');
});
test.each([0, -1, 1.5, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid minor units %s', amount => {
  expect(() => requireMoney(amount, 'PKR')).toThrow();
});
test.each(['pkr', 'CAD', '', null])('rejects unsupported/noncanonical app currency %s', currency => {
  expect(() => requireMoney(10000, currency)).toThrow();
});
test('refuses a mismatched merchant, amount, currency, tracker or environment', () => {
  for (const candidate of [
    { ...tracker, environment: 'production' }, { ...tracker, client: 'sec_someone-else' },
    { ...tracker, token: 'track_someone-else' },
    { ...tracker, purchase_totals: { quote_amount: { amount: 9999, currency: 'PKR' } } },
    { ...tracker, purchase_totals: { quote_amount: { amount: 10000, currency: 'USD' } } },
  ]) expect(() => requireTracker(candidate, { tracker: tracker.token, amountMinor: 10000, currency: 'PKR' }, config)).toThrow();
});
test('uncertain create errors are not retried and never expose the secret or upstream body', async () => {
  const fetchImpl = jest.fn(async () => { throw new Error(config.secretKey); });
  await expect(createSafepayClient({ config, fetchImpl }).createTracker({ amountMinor: 10000, currency: 'PKR', reference: 'order:fixture123', purpose: 'order' })).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN', outcomeUnknown: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('requires the immutable checkout reference, including reporter metadata shape', () => {
  const expected = { amountMinor: 10000, currency: 'PKR', reference: 'order:fixture123' };
  expect(requireTracker({ ...tracker, metadata: { order_id: { value: expected.reference } } }, expected, config)).toBeTruthy();
  expect(() => requireTracker({ ...tracker, metadata: { data: { order_id: 'another-order' } } }, expected, config)).toThrow();
  expect(() => requireTracker({ ...tracker, mode: 'instrument' }, expected, config)).toThrow();
});

test('validates a persisted Mongoose payment without losing getter-backed money and owner fields', async () => {
  const Payment = require('../../models/SafepayPayment');
  const payment = new Payment({ user: new (require('mongoose').Types.ObjectId)(), environment: 'sandbox',
    purpose: 'order', reference: 'order:fixture123', requestKey: 'checkout-fixture', amountMinor: 10000,
    currency: 'PKR', tracker: tracker.token, fingerprint: 'a'.repeat(64) });
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ data: tracker }) }));
  await expect(createSafepayClient({ config, fetchImpl }).getTracker(tracker.token, payment)).resolves.toEqual(tracker);
});

test('recovery only adopts an exact owned reference and does not create a new tracker', async () => {
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { list: [{ token: tracker.token, metadata: { order_id: 'order:fixture123' } }] } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: tracker }) });
  expect(await createSafepayClient({ config, fetchImpl }).findTrackerByReference({ amountMinor: 10000, currency: 'PKR', reference: 'order:fixture123' })).toEqual(tracker);
  expect(fetchImpl.mock.calls.every(([, args]) => args.method === 'GET')).toBe(true);
});

test('hosted checkout uses the selected environment and safely encodes return URLs', () => {
  const url = new URL(createSafepayClient({ config }).buildPaymentCheckoutUrl({ tracker: tracker.token,
    authToken: 'private-fixture-auth', reference: 'order:fixture123',
    redirectUrl: 'https://rozare.up.railway.app/api/safepay/return?attempt=123',
    cancelUrl: 'https://rozare.up.railway.app/api/safepay/return?attempt=123&outcome=cancel' }));
  expect(url.origin).toBe('https://sandbox.api.getsafepay.com');
  expect(url.searchParams.get('source')).toBe('hosted');
  expect(url.searchParams.get('cancel_url')).toContain('&outcome=cancel');
  expect(url.searchParams.has('secret_key')).toBe(false);
});

test('merchant-managed customer creation never creates or forwards a password', async () => {
  const customer = { token: 'cus_owned-fixture', merchant_api_key: config.publicKey, is_guest: false, is_deleted: false };
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ data: customer }) }));
  const result = await createSafepayClient({ config, fetchImpl }).createCustomer({ first_name: 'Test', last_name: 'Seller',
    email: 'test@example.com', phone_number: '+12025550123', country: 'US', password: 'must-not-forward', is_guest: true });
  expect(result).toEqual(customer);
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body.is_guest).toBe(false);
  expect(body.password).toBeUndefined();
});

test('zero-value instrument setup binds its merchant customer and cannot be mistaken for a paid order', async () => {
  const instrument = { ...tracker, mode: 'instrument', customer: 'cus_owned-fixture', purchase_totals: { quote_amount: { amount: 0, currency: 'PKR' } } };
  const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ data: { tracker: instrument } }) }));
  await createSafepayClient({ config, fetchImpl }).createTracker({ amountMinor: 0, currency: 'PKR', reference: 'order:fixture123', purpose: 'card_setup', customerId: 'cus_owned-fixture' });
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ mode: 'instrument', is_account_verification: true, user: 'cus_owned-fixture' });
  expect(() => requireTracker(instrument, { amountMinor: 0, currency: 'PKR' }, config)).toThrow();
});

test('a recurring payment uses a freshly ownership-checked reusable token and no shopper password', async () => {
  const recurring = { ...tracker, mode: 'subscription', entry_mode: 'mit', customer: 'cus_owned-fixture' };
  const card = { token: 'pm_owned-fixture', customer: 'cus_owned-fixture', merchant_api_key: config.publicKey, is_deleted: false,
    max_usage: -1, expires_at: { seconds: 2200000000 }, cybersource: { token: 'tms_owned-fixture', last_four: '1111' } };
  const fetchImpl = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: recurring }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: card }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { tracker: { ...recurring, state: 'TRACKER_ENDED' } } }) });
  const result = await createSafepayClient({ config, fetchImpl }).chargeRecurring(tracker.token,
    { amountMinor: 10000, currency: 'PKR', reference: 'order:fixture123', customerId: 'cus_owned-fixture', providerMode: 'subscription' }, card.token);
  expect(result.state).toBe('TRACKER_ENDED');
  expect(fetchImpl.mock.calls.map(([, args]) => args.method)).toEqual(['GET', 'GET', 'POST']);
  expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ payload: { authorization: { do_capture: true }, payment_method: { tokenized_card: { token: card.token } } }, use_action_chaining: true });
});

test('single-use tokens and expired tokens cannot be used for automatic renewals', () => {
  const card = { max_usage: 1, expires_at: { seconds: 2200000000 }, cybersource: { token: 'tms_owned-fixture', last_four: '1111' } };
  expect(() => requireReusableCard(card)).toThrow();
  expect(() => requireReusableCard({ ...card, max_usage: -1, expires_at: { seconds: 1 } })).toThrow();
  expect(() => requireReusableCard({ ...card, max_usage: -1 })).not.toThrow();
});
