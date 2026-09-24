'use strict';
const crypto = require('node:crypto');
const { verifySafepayWebhook } = require('../../services/safepayWebhookVerification');
const config = { environment: 'sandbox', publicKey: 'sec_merchant-fixture', webhookSecret: 'fixture-private-signing-secret', webhookScheme: 'sha512-raw' };
const event = { token: 'evt_event-fixture', version: '2.0.0', type: 'payment.succeeded', merchant_api_key: config.publicKey, data: { tracker: 'track_payment-fixture', amount: 10000, currency: 'PKR' } };
const raw = Buffer.from(JSON.stringify(event));
const sign = (body, algorithm = 'sha512') => crypto.createHmac(algorithm, config.webhookSecret).update(body).digest('hex');

test('verifies the exact configured protocol with constant-time signatures', () => {
  expect(verifySafepayWebhook(raw, sign(raw), config).event).toEqual(event);
  expect(() => verifySafepayWebhook(raw, sign(raw, 'sha256'), config)).toThrow();
  expect(verifySafepayWebhook(raw, sign(raw, 'sha256'), { ...config, webhookScheme: 'sha256-raw' }).event).toEqual(event);
});
test('does not accept a signature for a different body, merchant, protocol or missing secret', () => {
  for (const signature of ['', ' ', 'zz'.repeat(64), sign(raw).slice(2), sign(raw).slice(0, -1) + (sign(raw).endsWith('a') ? 'b' : 'a')]) expect(() => verifySafepayWebhook(raw, signature, config)).toThrow();
  const foreign = Buffer.from(JSON.stringify({ ...event, merchant_api_key: 'sec_other-merchant' }));
  expect(() => verifySafepayWebhook(foreign, sign(foreign), config)).toThrow();
  expect(() => verifySafepayWebhook(raw, sign(raw), { ...config, webhookSecret: '' })).toThrow();
  expect(() => verifySafepayWebhook(raw, sign(raw), { ...config, webhookScheme: 'guess' })).toThrow();
});
test('data-only legacy protocol must be selected explicitly and is not treated as full-envelope authentication', () => {
  const signature = sign(Buffer.from(JSON.stringify(event.data)));
  expect(() => verifySafepayWebhook(raw, signature, config)).toThrow();
  expect(verifySafepayWebhook(raw, signature, { ...config, webhookScheme: 'sha512-data' }).event.data).toEqual(event.data);
});
test('rejects malformed/oversized bodies and invalid event identities before persistence', () => {
  for (const body of [Buffer.from('{bad'), Buffer.alloc(512 * 1024 + 1), Buffer.from([0xc3, 0x28]), Buffer.from('null')]) expect(() => verifySafepayWebhook(body, sign(body), config)).toThrow();
  for (const invalid of [{ ...event, token: '' }, { ...event, data: [] }, { ...event, version: '1.0.0' }]) {
    const body = Buffer.from(JSON.stringify(invalid)); expect(() => verifySafepayWebhook(body, sign(body), config)).toThrow();
  }
});
