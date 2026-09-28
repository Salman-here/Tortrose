'use strict';
const express = require('express');
const request = require('supertest');
const fs = require('node:fs');
const path = require('node:path');
const { assertCurrentCardProvider, legacyCheckoutGuard } = require('../../middleware/safepayCutoverGuard');
const previous = process.env.SAFEPAY_WEB_ENABLED;
afterEach(() => { if (previous === undefined) delete process.env.SAFEPAY_WEB_ENABLED; else process.env.SAFEPAY_WEB_ENABLED = previous; });
test('cutover rejects retired creation before a financial write, with a provider-neutral recovery message', async () => {
  process.env.SAFEPAY_WEB_ENABLED = 'true';
  const create = jest.fn((req, res) => res.json({ created: true }));
  const app = express(); app.post('/old-checkout', legacyCheckoutGuard, create);
  const response = await request(app).post('/old-checkout');
  expect(response.status).toBe(409); expect(response.body.code).toBe('PAYMENT_PROVIDER_CHANGED');
  expect(response.body.msg).toContain('Safepay'); expect(response.body.msg).not.toContain('Stripe');
  expect(create).not.toHaveBeenCalled();
});
test.each(['safepay', 'wallet', 'cash_on_delivery'])('cutover preserves current %s methods', provider => {
  process.env.SAFEPAY_WEB_ENABLED = 'true'; expect(() => assertCurrentCardProvider(provider)).not.toThrow();
});
test('the undeployed cutover flag does not change the previously deployed checkout', () => {
  delete process.env.SAFEPAY_WEB_ENABLED; expect(() => assertCurrentCardProvider('stripe')).not.toThrow();
});
test('every old creation entry point is guarded without disabling receipts or cancellation', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
  const subscriptions = read('routes/subscriptionRoutes.js');
  for (const route of ['/create-checkout', '/upgrade-to-elite', '/subdomain/purchase']) {
    expect(subscriptions.split('\n').find(line => line.includes(`post('${route}'`))).toContain('legacyCheckoutGuard');
  }
  expect(subscriptions.split('\n').find(line => line.includes("post('/cancel'"))).not.toContain('legacyCheckoutGuard');
  expect(read('routes/paymentMethodRoutes.js')).toContain("post('/setup', legacyCheckoutGuard");
  for (const controller of ['orderController.js', 'walletController.js', 'returnController.js']) {
    expect(read(`controllers/${controller}`)).toContain('assertCurrentCardProvider(');
  }
});
