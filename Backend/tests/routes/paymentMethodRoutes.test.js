const express = require('express');
const request = require('supertest');
const paymentMethodRoutes = require('../../routes/paymentMethodRoutes');

describe('payment method route authentication boundaries', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/payment-methods', paymentMethodRoutes);

  test('publishable Stripe config is public while customer data remains authenticated', async () => {
    const configResponse = await request(app).get('/api/payment-methods/config');
    expect(configResponse.status).not.toBe(401);

    const listResponse = await request(app).get('/api/payment-methods');
    expect(listResponse.status).toBe(401);

    const cancelSetupResponse = await request(app)
      .post('/api/payment-methods/setup/seti_123ABC/cancel')
      .send({ closeReason: 'payment_sheet_initialize' });
    expect(cancelSetupResponse.status).toBe(401);
  });
});
