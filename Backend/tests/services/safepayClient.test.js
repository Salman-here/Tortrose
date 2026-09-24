'use strict';
const { readSafepayConfig } = require('../../config/safepay');
const { createSafepayClient, requireTracker, requireMoney } = require('../../services/safepayClient');
const env = { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_sandbox-fixture', SAFEPAY_SANDBOX_SECRET_KEY: 'private-test-secret-never-log' };
const config = readSafepayConfig(env);
const tracker = { token: 'track_checkout-fixture', environment: 'sandbox', client: config.publicKey, state: 'TRACKER_STARTED', purchase_totals: { quote_amount: { amount: 10000, currency: 'PKR' } } };

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
