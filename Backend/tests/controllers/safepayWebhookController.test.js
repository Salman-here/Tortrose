'use strict';
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createSafepayWebhookHandler } = require('../../controllers/safepayWebhookController');
const config = { environment: 'sandbox', publicKey: 'sec_test-merchant', webhookSecret: 'private-fixture-signing-key', webhookScheme: 'sha512-raw' };
const event = { token: 'evt_event-identifier', version: '2.0.0', merchant_api_key: config.publicKey, type: 'payment.succeeded', data: { tracker: 'track_test-payment', amount: 10000, currency: 'PKR' } };
const sign = raw => crypto.createHmac('sha512', config.webhookSecret).update(raw).digest('hex');
let app, Event, connect, logs;
beforeEach(() => {
  logs = []; connect = jest.fn();
  Event = { init: jest.fn(), create: jest.fn(), findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })) };
  app = express(); app.post('/hook', express.raw({ type: 'application/json' }), createSafepayWebhookHandler({ configFor: () => config, probeId: () => 'evt_controlled-probe', model: () => Event, connect, log: line => logs.push(line) }));
});
const send = async (payload = event, sig) => {
  const raw = JSON.stringify(payload); return request(app).post('/hook').set('Content-Type','application/json').set('x-sfpy-signature', sig ?? sign(raw)).send(raw);
};
test('persists a verified event before acknowledgment', async () => {
  expect((await send()).status).toBe(200);
  expect(Event.create).toHaveBeenCalledWith(expect.objectContaining({ eventId: event.token, environment: 'sandbox', payload: event }));
});
test('forged signatures do not reach the database', async () => {
  expect((await send(event, '0'.repeat(128))).status).toBe(401); expect(connect).not.toHaveBeenCalled(); expect(Event.create).not.toHaveBeenCalled();
});
test('persistence failures are retryable rather than acknowledged and lost', async () => {
  Event.create.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'DATABASE_UNAVAILABLE' }));
  expect((await send()).status).toBe(503);
});
test('controlled signature diagnostics never enter the financial event queue or disclose signatures', async () => {
  expect((await send({ ...event, token: 'evt_controlled-probe' })).body).toMatchObject({ received: true, probe: true });
  expect(Event.create).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  expect(logs[0]).toContain('sha512-raw'); expect(logs[0]).not.toContain(config.webhookSecret);
});
