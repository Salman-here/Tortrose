'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Customer = require('../../models/SafepayCustomer');
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
  await Customer.deleteMany({});
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

test.each(['order', 'wallet_top_up', 'subdomain', 'return_settlement'])('authenticated %s checkout attaches only its own consented saved-card profile', async purpose => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture',
    status: 'ready', createdForCardConsentAt: clock });
  await Customer.create({ user: new mongoose.Types.ObjectId(), environment: 'sandbox', customerId: 'cus_other-fixture',
    status: 'ready', createdForCardConsentAt: clock });
  const payment = await service.ensurePayment({ ...input(), purpose });
  expect(payment.customerId).toBe('cus_owned-fixture');
  // This unit fixture has no catalog order; test its binding separately from
  // the real-order inventory/settlement suites.
  const orderUpdate = purpose === 'order' ? jest.spyOn(require('../../models/Order'), 'updateOne')
    .mockResolvedValue({ matchedCount: 1 }) : null;
  let checkout;
  try { checkout = await service.prepareCheckout(payment._id); }
  finally { orderUpdate?.mockRestore(); }
  expect(client.createTracker.mock.calls[0][0].customerId).toBe('cus_owned-fixture');
  expect(new URL(checkout.checkoutUrl).searchParams.get('user_id')).toBe('cus_owned-fixture');
  expect(payment.providerMode).toBe('payment');
  expect(payment.chargeStartedAt).toBeNull();
});

test.each(['new', 'creating', 'deleted'])('a %s profile is never attached to a new purchase', async status => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status,
    createdForCardConsentAt: clock });
  expect((await service.ensurePayment(input())).customerId).toBeNull();
});

test('guest, unconsented and other-environment profiles never expose stored cards', async () => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_unconsented-fixture', status: 'ready' });
  await Customer.create({ user: buyer, environment: 'production', customerId: 'cus_live-fixture', status: 'ready', createdForCardConsentAt: clock });
  expect((await service.ensurePayment(input())).customerId).toBeNull();
  expect((await service.ensurePayment({ ...input(), user: null, purpose: 'order', reference: 'order:guest-fixture' })).customerId).toBeNull();
});

test('an existing checkout retains its profile after profile changes and cannot be rebound to another customer', async () => {
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready', createdForCardConsentAt: clock });
  const payment = await service.ensurePayment(input());
  await Customer.updateOne({ user: buyer }, { $set: { customerId: 'cus_replacement-fixture' } });
  expect(String((await service.ensurePayment(input()))._id)).toBe(String(payment._id));
  await expect(service.ensurePayment({ ...input(), customerId: 'cus_replacement-fixture' })).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_MISMATCH' });
  await expect(service.ensurePayment({ ...input(), cardId: 'pm_unapproved-fixture' })).rejects.toMatchObject({ code: 'SAFEPAY_CARD_SELECTION_INVALID' });
});

test('adding a saved-card profile does not alter an older guest-style payment binding', async () => {
  const payment = await service.ensurePayment(input());
  await Customer.create({ user: buyer, environment: 'sandbox', customerId: 'cus_owned-fixture', status: 'ready', createdForCardConsentAt: clock });
  expect(String((await service.ensurePayment(input()))._id)).toBe(String(payment._id));
  expect((await Payment.findById(payment._id)).customerId).toBeNull();
});
test('simultaneous setup creates only one payable tracker', async () => {
  const payment = await service.ensurePayment(input());
  const results = await Promise.allSettled([service.prepareCheckout(payment._id), service.prepareCheckout(payment._id)]);
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  expect(client.createTracker.mock.calls[0][1]).toEqual({ clientSurface: 'mobile' });
  expect(results.some(row => row.status === 'fulfilled' && row.value.checkoutUrl)).toBe(true);
  expect((await Payment.findById(payment._id)).status).toBe('ready');
});
test('web checkout uses the hosted source and fixed web bridge without creating a second tracker on reopen', async () => {
  const payment = await service.ensurePayment(input());
  const mobile = await service.prepareCheckout(payment._id);
  const web = await service.prepareCheckout(payment._id, { clientSurface: 'web' });
  expect(mobile.paymentId).toBe(web.paymentId);
  expect(client.createTracker).toHaveBeenCalledTimes(1);
  const url = new URL(web.checkoutUrl);
  expect(url.searchParams.get('source')).toBe('hosted');
  const redirect = new URL(url.searchParams.get('redirect_url'));
  expect(redirect.hostname).toBe('rozare.up.railway.app');
  expect(redirect.pathname).toBe(`/api/safepay/return/web/wallet_top_up/${payment._id}/return`);
  expect(redirect.search).toBe('');
  expect(new URL(url.searchParams.get('cancel_url')).pathname).toBe(`/api/safepay/return/web/wallet_top_up/${payment._id}/cancel`);
  const mobileReturn = new URL(new URL(mobile.checkoutUrl).searchParams.get('redirect_url'));
  expect(mobileReturn.pathname).toBe('/api/safepay/return');
  expect(mobileReturn.searchParams.get('attempt')).toBe(String(payment._id));
  expect(mobileReturn.searchParams.get('purpose')).toBe('wallet_top_up');
  expect(mobileReturn.searchParams.get('surface')).toBe('mobile');
  expect(mobileReturn.searchParams.get('outcome')).toBe('return');
  expect(new URL(mobile.checkoutUrl).searchParams.get('source')).toBe('mobile');
});

test('initial web tracker creation carries web provenance and reopening never creates another tracker', async () => {
  const payment = await service.ensurePayment(input());
  await service.prepareCheckout(payment._id, { clientSurface: 'web' });
  expect(client.createTracker.mock.calls[0][1]).toEqual({ clientSurface: 'web' });
  await service.prepareCheckout(payment._id, { clientSurface: 'mobile' });
  expect(client.createTracker).toHaveBeenCalledTimes(1);
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
