'use strict';
const express = require('express');
const request = require('supertest');
jest.mock('../../config/safepay', () => ({ readSafepayConfig: jest.fn(() => ({ environment: 'sandbox' })) }));
jest.mock('../../models/SafepayPayment', () => ({ findOne: jest.fn() }));
jest.mock('../../services/safepayCustomerService', () => ({ startCardSetup: jest.fn() }));
jest.mock('../../services/safepayPaymentService', () => {
  const actual = jest.requireActual('../../services/safepayPaymentService');
  return { ...actual, prepareCheckout: jest.fn() };
});
const service = require('../../services/safepayPaymentService');
const Payment = require('../../models/SafepayPayment');
const cards = require('../../services/safepayCustomerService');
const controller = require('../../controllers/safepayController');
const { buildReturnUrl } = require('../../services/safepayReturnNavigation');
const app = express();
app.use(express.json(), (req, res, next) => { req.user = { id: '6ab6e12cba71edafe4fc6c5b' }; next(); });
app.get('/return', controller.returnToApp);
app.get('/return/:surface/:purpose/:attempt/:outcome', controller.returnToApp);
app.post('/cards/setup', controller.startCardSetup);
app.post('/payments/:paymentId/reopen', controller.reopenPayment);
const id = '6ab6e29eba71edafe4fc7596';
const original = { web: process.env.SAFEPAY_WEB_ENABLED, mobile: process.env.SAFEPAY_MOBILE_ENABLED };
afterEach(() => { jest.clearAllMocks();
  for (const [key, value] of [['SAFEPAY_WEB_ENABLED', original.web], ['SAFEPAY_MOBILE_ENABLED', original.mobile]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
test('web enablement is independent of mobile and invalid surfaces fail closed', () => {
  process.env.SAFEPAY_MOBILE_ENABLED = 'true'; delete process.env.SAFEPAY_WEB_ENABLED;
  expect(() => service.requireMobileSafepay('mobile')).not.toThrow();
  expect(() => service.requireMobileSafepay('web')).toThrow();
  process.env.SAFEPAY_WEB_ENABLED = 'true'; process.env.SAFEPAY_MOBILE_ENABLED = 'false';
  expect(() => service.requireMobileSafepay('web')).not.toThrow();
  expect(() => service.requireMobileSafepay('mobile')).toThrow();
  for (const value of [undefined, '', 'desktop', 'WEB', true]) expect(() => service.requireMobileSafepay(value)).toThrow();
});
test('disabled web setup cannot create a customer or payment', async () => {
  delete process.env.SAFEPAY_WEB_ENABLED;
  const result = await request(app).post('/cards/setup').send({ clientSurface: 'web', consentToSave: true });
  expect(result.status).toBe(503); expect(cards.startCardSetup).not.toHaveBeenCalled();
});
test('web card setup passes the exact authenticated owner and surface', async () => {
  process.env.SAFEPAY_WEB_ENABLED = 'true'; cards.startCardSetup.mockResolvedValue({ paymentId: id });
  const body = { clientSurface: 'web', consentToSave: true, requestKey: 'web-fixture-key' };
  expect((await request(app).post('/cards/setup').send(body)).status).toBe(200);
  expect(cards.startCardSetup).toHaveBeenCalledWith('6ab6e12cba71edafe4fc6c5b', body);
});
test('payment reopen cannot access another user payment and retains web surface for owned attempts', async () => {
  process.env.SAFEPAY_WEB_ENABLED = 'true'; Payment.findOne.mockResolvedValueOnce(null);
  expect((await request(app).post(`/payments/${id}/reopen`).send({ clientSurface: 'web' })).status).toBe(404);
  expect(service.prepareCheckout).not.toHaveBeenCalled();
  expect(Payment.findOne).toHaveBeenCalledWith({ _id: id, user: '6ab6e12cba71edafe4fc6c5b' });
  Payment.findOne.mockResolvedValueOnce({ _id: id }); service.prepareCheckout.mockResolvedValueOnce({ paymentId: id, status: 'pending' });
  expect((await request(app).post(`/payments/${id}/reopen`).send({ clientSurface: 'web' })).status).toBe(200);
  expect(service.prepareCheckout).toHaveBeenCalledWith(id, { clientSurface: 'web' });
});
test('web return ignores forged success and redirect URLs and does not mark paid', async () => {
  const result = await request(app).get('/return').query({ surface: 'web', attempt: id, purpose: 'order', outcome: 'success', redirect: 'https://evil.test/' });
  expect(result.status).toBe(303);
  expect(result.headers.location).toBe(`https://rozare.com/safepay/return?paymentId=${id}`);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(Payment.findOne).not.toHaveBeenCalled();
  expect(service.prepareCheckout).not.toHaveBeenCalled();
});
test('bad return references fail; mobile bridge remains an app return', async () => {
  expect((await request(app).get('/return').query({ surface: 'web', attempt: 'bad', purpose: 'order' })).status).toBe(400);
  expect((await request(app).get('/return').query({ surface: 'web', attempt: id, purpose: 'bad' })).status).toBe(400);
  const response = await request(app).get('/return').query({ attempt: id, purpose: 'order' });
  expect(response.status).toBe(200); expect(response.text).toContain('rozare://safepay-return?');
  expect(response.text).not.toContain('payment verified');
});

test.each(['order', 'wallet_top_up', 'subdomain', 'card_setup', 'return_settlement'])('path callback keeps %s on web after provider appends a query', async purpose => {
  const result = await request(app).get(`/return/web/${purpose}/${id}/return?order_id=fixture&tracker=forged&outcome=success&redirect=https://evil.test`);
  expect(result.status).toBe(303);
  expect(result.headers.location).toBe(`https://rozare.com/safepay/return?paymentId=${id}`);
  expect(Payment.findOne).not.toHaveBeenCalled();
});

test.each(['return', 'cancel'])('mobile path callback preserves %s without granting payment', async outcome => {
  const result = await request(app).get(`/return/mobile/order/${id}/${outcome}?order_id=fixture&tracker=forged&surface=web`);
  expect(result.status).toBe(200);
  expect(result.text).toContain(`paymentId=${id}&amp;purpose=order&amp;outcome=${outcome}`);
  expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(Payment.findOne).not.toHaveBeenCalled();
});

test('legacy provider-appended callback retains web surface and mobile purpose/cancel', async () => {
  const web = await request(app).get(`/return?attempt=${id}&purpose=order&surface=web?order_id=fixture&tracker=fixture`);
  expect(web.status).toBe(303);
  const mobile = await request(app).get(`/return?attempt=${id}&purpose=wallet_top_up?order_id=fixture`);
  expect(mobile.status).toBe(200); expect(mobile.text).toContain('purpose=wallet_top_up');
  const cancel = await request(app).get(`/return?attempt=${id}&purpose=order&surface=mobile&outcome=cancel?order_id=fixture`);
  expect(cancel.text).toContain('outcome=cancel');
});

test.each(['return', 'cancel'])('new mobile %s URL remains compatible with installed sheets and provider-appended metadata', async outcome => {
  const url = new URL(buildReturnUrl({ backendOrigin: 'https://rozare.up.railway.app', surface: 'mobile',
    purpose: 'wallet_top_up', attempt: id, outcome }));
  expect(url.pathname).toBe('/api/safepay/return');
  const result = await request(app).get(url.pathname.replace('/api/safepay', '') + url.search + '?order_id=fixture&tracker=fixture');
  expect(result.status).toBe(200);
  expect(result.text).toContain(`paymentId=${id}&amp;purpose=wallet_top_up&amp;outcome=${outcome}`);
});

test.each([
  `/return/web/order/bad/return`, `/return/desktop/order/${id}/return`,
  `/return/web/bad/${id}/return`, `/return/web/order/${id}/success`,
  `/return?attempt=${id}&purpose=order&surface=web?evil=value`,
  `/return?attempt=${id}&purpose=order&surface=web&surface=mobile`,
])('invalid callback fails closed: %s', async url => {
  expect((await request(app).get(url)).status).toBe(400);
  expect(Payment.findOne).not.toHaveBeenCalled();
});
