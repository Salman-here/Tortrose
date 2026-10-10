'use strict';
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { createSafepayWebhookHandler } = require('../../controllers/safepayWebhookController');
const config = { environment: 'production', publicKey: 'sec_production-diagnostic-fixture',
  webhookSecret: 'private-production-diagnostic-signing-fixture', webhookScheme: 'sha512-data' };
const event = { token: 'evt_diagnostic-private-identity', version: '2.0.0', merchant_api_key: config.publicKey,
  type: 'payment.succeeded', data: { tracker: 'track_private-identity-fixture', amount: 1000, currency: 'PKR',
    contact: 'private-contact@example.invalid', url: 'https://private-url.invalid/secret-path' } };
const sign = (payload, scheme) => crypto.createHmac(scheme.startsWith('sha512') ? 'sha512' : 'sha256', config.webhookSecret)
  .update(scheme === 'sha512-data' ? JSON.stringify(payload.data) : JSON.stringify(payload)).digest('hex');
const previousFlag = process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS;
let app, Event, connect, logs;

function fixture(overrides = {}) {
  logs = []; connect = jest.fn();
  Event = { init: jest.fn(), create: jest.fn(), findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })) };
  app = express();
  app.post('/hook', express.raw({ type: 'application/json', limit: '1mb' }), createSafepayWebhookHandler({
    configFor: () => config, probeId: () => '', model: () => Event, connect, log: line => logs.push(line), ...overrides,
  }));
}
beforeEach(() => { delete process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS; fixture(); });
afterAll(() => { if (previousFlag === undefined) delete process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS; else process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = previousFlag; });
const send = (payload = event, signature = '0'.repeat(128)) => request(app).post('/hook')
  .set('Content-Type', 'application/json').set('x-sfpy-signature', signature).send(JSON.stringify(payload));
function noFinancialEntry() {
  expect(connect).not.toHaveBeenCalled(); expect(Event.init).not.toHaveBeenCalled();
  expect(Event.findOne).not.toHaveBeenCalled(); expect(Event.create).not.toHaveBeenCalled();
}
function loggedMetadata() {
  expect(logs).toHaveLength(1);
  return JSON.parse(logs[0].replace('[safepay-webhook-rejection-diagnostics] ', ''));
}

test('diagnostics are off by default and invalid production events remain HTTP401 without database access', async () => {
  expect((await send()).status).toBe(401); expect(logs).toEqual([]); noFinancialEntry();
});

test.each(['false', 'TRUE', '1', 'yes', ''])('non-exact diagnostics flag %j cannot enable logging or verification', async flag => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = flag;
  expect((await send()).status).toBe(401); expect(logs).toEqual([]); noFinancialEntry();
});

test.each(['sha512-raw', 'sha256-raw'])('a valid alternative %s match is diagnostic only; the wrong configured pin still rejects it', async scheme => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  const signature = sign(event, scheme);
  expect((await send(event, signature)).status).toBe(401);
  expect(loggedMetadata()).toEqual({ matches: [scheme], signatureLength: signature.length,
    merchantMatches: true, versionMatches: true, typeFormat: true, tokenFormat: true });
  noFinancialEntry();
  for (const privateValue of [signature, config.webhookSecret, config.publicKey, event.token, event.data.tracker, event.data.contact, event.data.url]) {
    expect(logs[0]).not.toContain(privateValue);
  }
});

test('a correct pinned signature with invalid placeholder metadata logs only booleans and stays rejected', async () => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  const placeholder = { ...event, token: 'private-test-placeholder', version: 'unexpected-private-version',
    type: 'Unexpected/private/type', merchant_api_key: 'sec_foreign-private-merchant' };
  expect((await send(placeholder, sign(placeholder, 'sha512-data'))).status).toBe(401);
  expect(loggedMetadata()).toEqual({ matches: ['sha512-data'], signatureLength: 128,
    merchantMatches: false, versionMatches: false, typeFormat: false, tokenFormat: false });
  noFinancialEntry();
  expect(logs[0]).not.toContain('private-test-placeholder'); expect(logs[0]).not.toContain('unexpected-private-version');
});

test('forged signature produces no matching algorithm and cannot enter the event queue', async () => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  expect((await send()).status).toBe(401);
  expect(loggedMetadata()).toEqual({ matches: [], signatureLength: 128,
    merchantMatches: true, versionMatches: true, typeFormat: true, tokenFormat: true });
  noFinancialEntry();
});

test.each(['z'.repeat(128), '0'.repeat(65), 'not-a-signature'])('malformed signature %j is not interpreted as another accepted protocol', async signature => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  expect((await send(event, signature)).status).toBe(401);
  expect(loggedMetadata().matches).toEqual([]); noFinancialEntry();
});

test('normally verified events use only their configured pin and do not emit rejection diagnostics', async () => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  expect((await send(event, sign(event, 'sha512-data'))).status).toBe(200);
  expect(logs).toEqual([]);
  expect(Event.create).toHaveBeenCalledTimes(1);
  expect(Event.create).toHaveBeenCalledWith(expect.objectContaining({ environment: 'production', eventId: event.token }));
});

test('diagnostic logger failure cannot acknowledge an invalid event or grant financial effects', async () => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  fixture({ log: () => { throw new Error('diagnostic sink unavailable'); } });
  expect((await send(event, sign(event, 'sha256-raw'))).status).toBe(401); noFinancialEntry();
});

test('non-JSON bodies are still bad requests, not rejection diagnostics', async () => {
  process.env.SAFEPAY_WEBHOOK_DIAGNOSTICS = 'true';
  const response = await request(app).post('/hook').set('Content-Type', 'application/json').set('x-sfpy-signature', '0'.repeat(128)).send('{not-json');
  expect(response.status).toBe(400); expect(logs).toEqual([]); noFinancialEntry();
});
