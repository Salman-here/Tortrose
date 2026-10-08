'use strict';
const express = require('express');
const request = require('supertest');
jest.mock('../../models/SafepayPayment', () => ({ findOne: jest.fn() }));
jest.mock('../../services/safepayCustomerService', () => ({ startCardSetup: jest.fn(), setDefaultCard: jest.fn(), deleteCard: jest.fn() }));
jest.mock('../../services/safepayBillingService', () => ({ createQuote: jest.fn(), acceptQuote: jest.fn() }));
jest.mock('../../services/safepayBillingLifecycleService', () => ({ cancel: jest.fn(), resume: jest.fn(), scheduleDowngrade: jest.fn(), cancelDowngrade: jest.fn() }));
jest.mock('../../services/safepayBillingRecoveryService', () => ({ retryQuote: jest.fn(), changeCard: jest.fn() }));
jest.mock('../../services/safepaySubdomainService', () => ({ startPurchase: jest.fn() }));
jest.mock('../../services/safepayPaymentService', () => ({ ...jest.requireActual('../../services/safepayPaymentService'),
  prepareCheckout: jest.fn(), reconcilePayment: jest.fn(), paymentResponse: jest.fn(value => value) }));
const Payment = require('../../models/SafepayPayment');
const payments = require('../../services/safepayPaymentService');
const cards = require('../../services/safepayCustomerService');
const billing = require('../../services/safepayBillingService');
const lifecycle = require('../../services/safepayBillingLifecycleService');
const recovery = require('../../services/safepayBillingRecoveryService');
const domains = require('../../services/safepaySubdomainService');
const controller = require('../../controllers/safepayController');
const billingController = require('../../controllers/safepayBillingController');
const app = express();
app.use(express.json(), (req, res, next) => { req.user = { id: '6ab6e12cba71edafe4fc6c5b' }; next(); });
app.get('/config', controller.getConfig);
app.get('/payments/:paymentId', controller.getPayment);
app.post('/payments/:paymentId/reopen', controller.reopenPayment);
app.post('/cards/setup', controller.startCardSetup);
app.patch('/cards/:cardId/default', controller.setDefaultCard);
app.delete('/cards/:cardId', controller.deleteCard);
app.post('/subdomain/purchase', controller.purchaseSubdomain);
for (const action of ['quote', 'accept', 'cancel', 'resume', 'downgrade', 'cancelDowngrade', 'retryQuote', 'changeCard']) {
  app.post(`/subscription/${action}`, billingController[action]);
}
const paymentId = '6ab6e29eba71edafe4fc7596';
const previous = { ...process.env };
beforeEach(() => {
  jest.resetAllMocks();
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_WEB_ENABLED: 'false', SAFEPAY_MOBILE_ENABLED: 'false',
    SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_pause-fixture', SAFEPAY_SANDBOX_SECRET_KEY: 'private-pause-fixture-secret',
    SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-pause-fixture-webhook', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  payments.paymentResponse.mockImplementation(value => value);
});
afterAll(() => { process.env = previous; });

test.each(['web', 'mobile'])('paused %s rejects all new agreement/setup routes before mutations', async clientSurface => {
  for (const route of ['/cards/setup', '/subdomain/purchase', '/subscription/quote', '/subscription/accept', '/subscription/retryQuote']) {
    const response = await request(app).post(route).send({ clientSurface });
    expect(response.status).toBe(503); expect(response.body.code).toBe('SAFEPAY_NOT_ENABLED');
  }
  for (const fn of [cards.startCardSetup, domains.startPurchase, billing.createQuote, billing.acceptQuote, recovery.retryQuote]) expect(fn).not.toHaveBeenCalled();
  expect((await request(app).get('/config').query({ clientSurface })).body.enabled).toBe(false);
});

test.each(['web', 'mobile'])('paused %s retains owned verification, same-attempt resume and card management', async clientSurface => {
  Payment.findOne.mockResolvedValue({ _id: paymentId });
  payments.prepareCheckout.mockResolvedValue({ paymentId, status: 'pending' });
  payments.reconcilePayment.mockResolvedValue({ paymentId, status: 'pending' });
  cards.setDefaultCard.mockResolvedValue({ success: true }); cards.deleteCard.mockResolvedValue({ success: true });
  expect((await request(app).get(`/payments/${paymentId}`)).status).toBe(200);
  expect((await request(app).post(`/payments/${paymentId}/reopen`).send({ clientSurface })).status).toBe(200);
  expect(payments.prepareCheckout).toHaveBeenCalledWith(paymentId, { clientSurface });
  expect((await request(app).patch('/cards/pm_owned-fixture/default').send({ clientSurface })).status).toBe(200);
  expect((await request(app).delete('/cards/pm_owned-fixture').send({ clientSurface })).status).toBe(200);
  expect(Payment.findOne).toHaveBeenCalledWith({ _id: paymentId, user: '6ab6e12cba71edafe4fc6c5b' });
});

test.each(['web', 'mobile'])('paused %s retains existing subscription management, especially cancellation', async clientSurface => {
  for (const [action, fn] of [['cancel', lifecycle.cancel], ['resume', lifecycle.resume], ['downgrade', lifecycle.scheduleDowngrade],
    ['cancelDowngrade', lifecycle.cancelDowngrade], ['changeCard', recovery.changeCard]]) {
    fn.mockResolvedValue({ success: true });
    expect((await request(app).post(`/subscription/${action}`).send({ clientSurface })).status).toBe(200);
    expect(fn.mock.calls[0][0]).toBe('6ab6e12cba71edafe4fc6c5b');
  }
});

test('paused management never bypasses ownership, provider configuration or surface validation', async () => {
  Payment.findOne.mockResolvedValue(null);
  expect((await request(app).post(`/payments/${paymentId}/reopen`).send({ clientSurface: 'web' })).status).toBe(404);
  expect(payments.prepareCheckout).not.toHaveBeenCalled();
  expect((await request(app).post('/subscription/cancel').send({ clientSurface: 'invalid' })).status).toBe(400);
  process.env.SAFEPAY_ENV = 'production';
  delete process.env.SAFEPAY_PRODUCTION_PUBLIC_KEY;
  expect((await request(app).post('/subscription/cancel').send({ clientSurface: 'web' })).status).toBe(503);
  expect(lifecycle.cancel).not.toHaveBeenCalled();
});
