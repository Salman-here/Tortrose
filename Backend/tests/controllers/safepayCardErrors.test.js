'use strict';
const express = require('express');
const request = require('supertest');
jest.mock('../../services/safepayCustomerService', () => ({ startCardSetup: jest.fn() }));
jest.mock('../../services/safepayPaymentService', () => ({ requireMobileSafepay: jest.fn() }));
const cards = require('../../services/safepayCustomerService');
const controller = require('../../controllers/safepayController');
const app = express();
app.use(express.json(), (req, res, next) => { req.user = { id: 'seller-fixture' }; next(); });
app.post('/cards/setup', controller.startCardSetup);
afterEach(() => jest.clearAllMocks());

test('billing validation returns useful public fields without upstream diagnostics', async () => {
  cards.startCardSetup.mockRejectedValue(Object.assign(new Error('Enter your billing first and last name.'), {
    code: 'SAFEPAY_BILLING_PROFILE_REQUIRED', statusCode: 400, fields: ['fullName', 'unsafe'],
    providerValidationFields: ['last_name'], secret: 'do-not-expose',
  }));
  const response = await request(app).post('/cards/setup').send({ clientSurface: 'mobile' });
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ code: 'SAFEPAY_BILLING_PROFILE_REQUIRED', msg: 'Enter your billing first and last name.', fields: ['fullName'] });
});

test.each(['CHECKOUT_IN_PROGRESS', 'SAFEPAY_CUSTOMER_UNCERTAIN'])('bounded %s wait is returned in body and Retry-After', async code => {
  cards.startCardSetup.mockRejectedValue(Object.assign(new Error('Wait before retrying.'), { code, statusCode: 409, retryAfterSeconds: 80 }));
  const response = await request(app).post('/cards/setup').send({ clientSurface: 'mobile' });
  expect(response.status).toBe(409);
  expect(response.headers['retry-after']).toBe('80');
  expect(response.body.retryAfterSeconds).toBe(80);
});
