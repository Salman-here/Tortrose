'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const { createSafepayClient } = require('../../services/safepayClient');
const { createSafepayPaymentService } = require('../../services/safepayPaymentService');
let replica;
let clock;
let client;
let settle;
let quarantine;
let service;
let providerState;
const config = { environment: 'sandbox', publicKey: 'sec_fixture-sandbox', secretKey: 'private-fixture', checkoutHost: 'https://sandbox.api.getsafepay.com' };
const buyer = new mongoose.Types.ObjectId();
const input = () => ({ user: buyer, purpose: 'wallet_top_up', reference: 'wallet:fixture-reference', requestKey: 'attempt-fixture-key', amountMinor: 12345, currency: 'PKR' });

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Payment.init();
}, 60000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Payment.deleteMany({});
  await mongoose.connection.collection('safepay_test_effects').deleteMany({});
  clock = new Date('2026-09-25T10:00:00Z');
  providerState = 'TRACKER_STARTED';
  const tracker = () => ({ token: 'track_fixture-owned-payment', state: providerState });
  client = { createTracker: jest.fn(async () => tracker()), getTracker: jest.fn(async () => tracker()),
    findTrackerByReference: jest.fn(async () => tracker()), createAuthToken: jest.fn(async () => 'temporary-checkout-token'),
    buildPaymentCheckoutUrl: createSafepayClient({ config }).buildPaymentCheckoutUrl };
  settle = jest.fn(async (payment, provider, session) => {
    await mongoose.connection.collection('safepay_test_effects').insertOne({ _id: payment._id, amount: payment.amountMinor }, { session });
  });
  quarantine = jest.fn(async () => {});
  service = createSafepayPaymentService({ configFor: () => config, clientFor: () => client, settle, quarantine, close: async () => {}, now: () => clock });
});

test('same attempt is reused and any amount or currency change is rejected', async () => {
  const payment = await service.ensurePayment(input());
  expect(String((await service.ensurePayment(input()))._id)).toBe(String(payment._id));
  for (const patch of [{ amountMinor: 12346 }, { currency: 'USD' }, { reference: 'different-reference' }]) {
    await expect(service.ensurePayment({ ...input(), ...patch })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  }
  expect(await Payment.countDocuments()).toBe(1);
});
test('simultaneous setup creates only one payable tracker', async () => {
  const payment = await service.ensurePayment(input());
  const results = await Promise.allSettled([service.prepareCheckout(payment._id), service.prepareCheckout(payment._id)]);
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  expect(results.some(row => row.status === 'fulfilled' && row.value.checkoutUrl)).toBe(true);
  expect((await Payment.findById(payment._id)).status).toBe('ready');
});
test('unknown create outcome is recovered by reference without another mutation', async () => {
  const payment = await service.ensurePayment(input());
  client.createTracker.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'SAFEPAY_REQUEST_UNCERTAIN' }));
  await expect(service.prepareCheckout(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  expect((await Payment.findById(payment._id)).status).toBe('creating');
  clock = new Date(clock.getTime() + 30000);
  expect((await service.prepareCheckout(payment._id)).status).toBe('pending');
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  expect(client.findTrackerByReference).toHaveBeenCalledTimes(1);
});
test('concurrent and repeated completion has exactly one transactional financial effect', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id);
  providerState = 'TRACKER_ENDED';
  await Promise.all([service.reconcilePayment(payment._id), service.reconcilePayment(payment._id)]);
  await service.reconcilePayment(payment._id);
  expect(await mongoose.connection.collection('safepay_test_effects').countDocuments()).toBe(1);
  expect((await Payment.findById(payment._id)).status).toBe('paid');
  expect(settle).toHaveBeenCalledTimes(1);
});
test('failed local settlement rolls back financial effects and remains retryable', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id);
  providerState = 'TRACKER_ENDED';
  settle.mockImplementationOnce(async (p, t, session) => {
    await mongoose.connection.collection('safepay_test_effects').insertOne({ _id: p._id }, { session });
    throw Object.assign(new Error('notification persistence failed'), { code: 'OUTBOX_FAILED' });
  });
  await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: 'OUTBOX_FAILED' });
  expect(await mongoose.connection.collection('safepay_test_effects').countDocuments()).toBe(0);
  expect((await Payment.findById(payment._id)).appliedAt).toBeNull();
  await service.reconcilePayment(payment._id);
  expect(await mongoose.connection.collection('safepay_test_effects').countDocuments()).toBe(1);
});
test('refund before completion and a later stale paid event do not grant funds', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id);
  providerState = 'TRACKER_REFUNDED';
  await service.reconcilePayment(payment._id);
  providerState = 'TRACKER_ENDED';
  await service.reconcilePayment(payment._id);
  expect(settle).not.toHaveBeenCalled();
  expect(quarantine).toHaveBeenCalled();
  expect((await Payment.findById(payment._id)).status).toBe('manual_review');
});
test('sandbox payment cannot be replayed against production credentials', async () => {
  const payment = await service.ensurePayment(input());
  const production = createSafepayPaymentService({ configFor: () => ({ ...config, environment: 'production' }), clientFor: () => client });
  await expect(production.prepareCheckout(payment._id)).rejects.toMatchObject({ code: 'SAFEPAY_ENVIRONMENT_MISMATCH' });
  expect(client.createTracker).not.toHaveBeenCalled();
});
