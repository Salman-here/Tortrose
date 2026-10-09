'use strict';
// Real checkout, customer ownership, payment reconciliation and provider-client
// source against an isolated Mongo replica set. Only HTTP transport is faked:
// the provider can apply a mutation and then lose its reply, like a real timeout.
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const Customer = require('../../models/SafepayCustomer');
const User = require('../../models/User');
const mockFetch = jest.fn();
jest.mock('../../services/safepayClient', () => {
  const actual = jest.requireActual('../../services/safepayClient');
  return { ...actual, createSafepayClient: options => actual.createSafepayClient({ ...options, fetchImpl: mockFetch }) };
});
const service = require('../../services/safepaySavedCardCheckoutService');
const env = { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_sandbox-fixture',
  SAFEPAY_SANDBOX_SECRET_KEY: 'private-recovery-fixture', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-webhook-fixture',
  SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-data' };
const billing = { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' };
const previousEnv = {};
let repl, payment, ticket, grant, provider;
const result = data => ({ ok: true, status: 200, json: async () => ({ data }) });
const mutations = method => mockFetch.mock.calls.filter(([url, options]) => new URL(url).pathname === `/order/payments/v3/${payment.tracker}` && options.method === method);
const call = options => service.authenticate(String(payment._id), `Bearer ${ticket}`, billing, grant, options);
const view = () => service.viewContext(String(payment._id), `Bearer ${ticket}`, grant);
const stored = () => Payment.findById(payment._id).select('+cardId +savedCardAuthentication.encryptedContext +savedCardAuthentication.operationToken');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) { previousEnv[key] = process.env[key]; process.env[key] = value; }
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri()); await Promise.all([Payment.init(), Customer.init()]);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect(); await repl.stop();
  for (const key of Object.keys(env)) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
});
beforeEach(async () => {
  await Promise.all([Payment.deleteMany({}), Customer.deleteMany({}), User.deleteMany({})]);
  const owner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: owner, status: 'active', savedShippingInfo: { address: billing.street_1, city: billing.city, countryCode: 'PK' } });
  payment = await Payment.create({ user: owner, environment: 'sandbox', purpose: 'wallet_top_up', reference: 'wallet:recovery-fixture',
    requestKey: 'recovery-attempt-fixture', fingerprint: 'a'.repeat(64), amountMinor: 200, currency: 'USD',
    providerMode: 'payment', providerEntryMode: 'tms', customerId: 'cus_recovery-fixture', cardId: 'pm_recovery-fixture',
    tracker: 'track_recovery-fixture', status: 'ready' });
  await Customer.create({ user: owner, environment: 'sandbox', customerId: payment.customerId, status: 'ready' });
  const checkout = service.buildCheckoutContext(payment, 'web');
  ticket = new URL(checkout.checkoutUrl).hash.slice('#ticket='.length); grant = checkout.checkoutSessionGrant;
  provider = { setupCalls: 0, resetCalls: 0, setupOutcome: 'ok', resetOutcome: 'ok', setupGate: null, resetGate: null,
    tracker: { token: payment.tracker, environment: 'sandbox', client: env.SAFEPAY_SANDBOX_PUBLIC_KEY,
      mode: 'payment', entry_mode: 'tms', customer: payment.customerId, metadata: { data: { order_id: payment.reference } },
      state: 'TRACKER_STARTED', next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_SETUP' } },
      purchase_totals: { quote_amount: { amount: 200, currency: 'USD' } }, charge: null },
    card: { token: payment.cardId, customer: payment.customerId, merchant_api_key: env.SAFEPAY_SANDBOX_PUBLIC_KEY,
      is_deleted: false, max_usage: -1, expires_at: { seconds: 2200000000 }, cybersource: { token: 'tms_recovery-fixture', scheme: 1, last_four: '1111' } } };
  mockFetch.mockReset().mockImplementation(async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'GET' && path === `/reporter/api/v1/payments/${payment.tracker}`) return result(structuredClone(provider.tracker));
    if (options.method === 'GET' && path === `/user/customers/v1/${payment.customerId}/wallet/${payment.cardId}`) return result(structuredClone(provider.card));
    if (options.method === 'POST' && path === '/client/passport/v1/token') return result('private-recovery-checkout-auth-token');
    if (path === `/order/payments/v3/${payment.tracker}` && options.method === 'PUT') {
      provider.resetCalls++;
      if (provider.resetOutcome !== 'lost-unapplied') {
        provider.tracker.state = 'TRACKER_STARTED'; provider.tracker.next_actions.CYBERSOURCE.kind = 'PAYER_AUTH_SETUP';
      }
      if (provider.resetGate) { provider.resetGate.started.resolve(); await provider.resetGate.finish.promise; }
      if (provider.resetOutcome.startsWith('lost')) throw new Error('test reset reply lost');
      return result({ tracker: structuredClone(provider.tracker) });
    }
    if (path === `/order/payments/v3/${payment.tracker}` && options.method === 'POST') {
      const count = ++provider.setupCalls;
      expect(JSON.parse(options.body)).toEqual({ payload: { payment_method: { tokenized_card: { token: payment.cardId } } }, use_action_chaining: false });
      provider.tracker.next_actions.CYBERSOURCE.kind = 'PAYER_AUTH_ENROLLMENT';
      if (provider.setupGate) { provider.setupGate.started.resolve(); await provider.setupGate.finish.promise; }
      if (provider.setupOutcome === 'lost') throw new Error('test first setup reply lost');
      if (provider.setupOutcome === 'malformed') return result({ tracker: structuredClone(provider.tracker) });
      return result({ tracker: structuredClone(provider.tracker), action: { payer_authentication_setup: {
        access_token: `private-device-collection-fixture-${count}`, device_data_collection_url: 'https://centinelapistag.cardinalcommerce.com/V1/Cruise/Collect',
      } } });
    }
    throw new Error(`Unexpected test provider request: ${options.method} ${path}`);
  });
});

async function loseFirstSetup() {
  provider.setupOutcome = 'lost';
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN', outcomeUnknown: true });
  provider.setupOutcome = 'ok';
  const current = await stored();
  expect(current.savedCardAuthentication.setupStartedAt).toBeInstanceOf(Date);
  expect(current.savedCardAuthentication.encryptedContext).toBe('');
  expect(current.savedCardAuthentication.operationLeaseUntil).toBeNull();
}

test('original lost-first-setup counterexample now exposes explicit same-tracker recovery without an encrypted context', async () => {
  await loseFirstSetup();
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.setupCalls).toBe(1);
  expect(await view()).toMatchObject({ canAuthenticate: true, canRestartAuthentication: true });
  const recovered = await call({ restartAuthentication: true });
  expect(recovered).toMatchObject({ tracker: payment.tracker, user: payment.customerId, environment: 'sandbox', billing });
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(2);
  expect(mutations('PUT')[0][1].body).toBe('{}');
  const current = await stored();
  expect(service.unsealContext(current.savedCardAuthentication.encryptedContext, require('../../config/safepay').readSafepayConfig(), payment._id).deviceDataCollectionJWT).toBe(recovered.deviceDataCollectionJWT);
  expect(current.savedCardAuthentication.resetStartedAt).toBeNull();
  expect(current.capturedMinor).toBe(0); expect(current.appliedAt).toBeNull(); expect(current.status).toBe('ready');
  expect(await Payment.countDocuments()).toBe(1);
});

test('invalid first setup body also preserves intent and uses an explicit reset rather than a blind setup retry', async () => {
  provider.setupOutcome = 'malformed';
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_INVALID', outcomeUnknown: true });
  provider.setupOutcome = 'ok';
  await call({ restartAuthentication: true });
  expect(provider.setupCalls).toBe(2); expect(provider.resetCalls).toBe(1);
});

test.each([['TRACKER_STARTED', 'PAYER_AUTH_ENROLLMENT'], ['TRACKER_ENROLLED', 'PAYER_AUTH_VALIDATION']])('missing context after a crashed process recovers only after its lease expires: %s/%s', async (state, kind) => {
  provider.tracker.state = state; provider.tracker.next_actions.CYBERSOURCE.kind = kind;
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.setupStartedAt': new Date(),
    'savedCardAuthentication.operationToken': 'crashed-process', 'savedCardAuthentication.operationLeaseUntil': new Date(Date.now() + 60000) } });
  expect(await view()).toMatchObject({ canAuthenticate: false, canRestartAuthentication: false, authenticationInProgress: true });
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.resetCalls).toBe(0); expect(provider.setupCalls).toBe(0);
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.operationLeaseUntil': new Date(0) } });
  expect((await view()).canRestartAuthentication).toBe(true);
  await call({ restartAuthentication: true });
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(1);
});

test('a crash before setup dispatch recovers from proved initial provider state only on explicit approval', async () => {
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.setupStartedAt': new Date() } });
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect((await view()).canRestartAuthentication).toBe(true);
  await call({ restartAuthentication: true });
  expect(provider.resetCalls).toBe(0); expect(provider.setupCalls).toBe(1);
});

test('a lost reset response recovers by fresh GET proof without resending the reset', async () => {
  await loseFirstSetup(); provider.resetOutcome = 'lost-applied';
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  expect((await stored()).savedCardAuthentication.resetStartedAt).toBeInstanceOf(Date);
  expect((await view()).canRestartAuthentication).toBe(true);
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  provider.resetOutcome = 'ok';
  await call({ restartAuthentication: true });
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(2);
});

test('an unknown unapplied reset remains GET-only until its lease expires, then requires fresh evidence and explicit approval', async () => {
  await call(); provider.resetOutcome = 'lost-unapplied';
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  expect(await view()).toMatchObject({ canAuthenticate: false, canRestartAuthentication: false, authenticationInProgress: true });
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(1);
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.resetLeaseUntil': new Date(0) } });
  expect((await view()).canRestartAuthentication).toBe(true);
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  provider.resetOutcome = 'ok';
  await call({ restartAuthentication: true });
  expect(provider.resetCalls).toBe(2); expect(provider.setupCalls).toBe(2);
});

test('a crash after reset intent but before PUT is recoverable only after the old lease expires', async () => {
  await loseFirstSetup();
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.resetStartedAt': new Date(),
    'savedCardAuthentication.resetLeaseUntil': new Date(Date.now() + 60000),
    'savedCardAuthentication.resetFromState': provider.tracker.state,
    'savedCardAuthentication.resetFromAction': provider.tracker.next_actions.CYBERSOURCE.kind } });
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.resetCalls).toBe(0);
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.resetLeaseUntil': new Date(0) } });
  await call({ restartAuthentication: true });
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(2);
});

test('expired reset lease cannot authorize replay if the provider bank-setup state changed', async () => {
  await loseFirstSetup(); provider.resetOutcome = 'lost-unapplied';
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.resetLeaseUntil': new Date(0) } });
  provider.tracker.state = 'TRACKER_ENROLLED'; provider.tracker.next_actions.CYBERSOURCE.kind = 'PAYER_AUTH_VALIDATION';
  expect((await view()).canRestartAuthentication).toBe(false);
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(1);
});

test('a process crash after reset success resumes setup from the provider-proved reset state', async () => {
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.setupStartedAt': new Date(),
    'savedCardAuthentication.resetStartedAt': new Date(), 'savedCardAuthentication.operationToken': 'crashed-reset',
    'savedCardAuthentication.operationLeaseUntil': new Date(0) } });
  await call({ restartAuthentication: true });
  expect(provider.resetCalls).toBe(0); expect(provider.setupCalls).toBe(1);
});

test('parallel initial approvals cannot dispatch two setup operations', async () => {
  provider.setupGate = { started: deferred(), finish: deferred() };
  const first = call(); await provider.setupGate.started.promise;
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  provider.setupGate.finish.resolve(); await first;
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test('parallel recovery clicks cannot reset/clear an active setup twice', async () => {
  await loseFirstSetup(); provider.resetGate = { started: deferred(), finish: deferred() };
  const first = call({ restartAuthentication: true }); await provider.resetGate.started.promise;
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  provider.resetGate.finish.resolve(); await first;
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(2);
});

test('an expired old process cannot overwrite the new recovery context or clear its lease', async () => {
  const oldGate = { started: deferred(), finish: deferred() }; provider.setupGate = oldGate;
  const old = call().catch(error => error); await oldGate.started.promise;
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.operationLeaseUntil': new Date(0) } });
  const currentGate = { started: deferred(), finish: deferred() }; provider.setupGate = currentGate;
  const recovering = call({ restartAuthentication: true }); await currentGate.started.promise;
  const newClaim = await stored();
  oldGate.finish.resolve();
  expect(await old).toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  const stillOwned = await stored();
  expect(stillOwned.savedCardAuthentication.operationToken).toBe(newClaim.savedCardAuthentication.operationToken);
  expect(stillOwned.savedCardAuthentication.operationLeaseUntil).toEqual(newClaim.savedCardAuthentication.operationLeaseUntil);
  expect(stillOwned.savedCardAuthentication.encryptedContext).toBe('');
  currentGate.finish.resolve(); const current = await recovering;
  expect(service.unsealContext((await stored()).savedCardAuthentication.encryptedContext,
    require('../../config/safepay').readSafepayConfig(), payment._id).deviceDataCollectionJWT).toBe(current.deviceDataCollectionJWT);
  expect(provider.setupCalls).toBe(2); expect(provider.resetCalls).toBe(1);
});

test('a delayed reset response from an expired process cannot overwrite or unlock the later explicit recovery', async () => {
  await loseFirstSetup();
  const oldGate = { started: deferred(), finish: deferred() }; provider.resetGate = oldGate;
  const old = call({ restartAuthentication: true }).catch(error => error); await oldGate.started.promise;
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.operationLeaseUntil': new Date(0),
    'savedCardAuthentication.resetLeaseUntil': new Date(0) } });
  provider.resetGate = null;
  const currentGate = { started: deferred(), finish: deferred() }; provider.setupGate = currentGate;
  const recovering = call({ restartAuthentication: true }); await currentGate.started.promise;
  const newClaim = await stored();
  oldGate.finish.resolve();
  expect(await old).toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS', outcomeUnknown: true });
  const stillOwned = await stored();
  expect(stillOwned.savedCardAuthentication.operationToken).toBe(newClaim.savedCardAuthentication.operationToken);
  expect(stillOwned.savedCardAuthentication.operationLeaseUntil).toEqual(newClaim.savedCardAuthentication.operationLeaseUntil);
  expect(stillOwned.savedCardAuthentication.encryptedContext).toBe('');
  currentGate.finish.resolve(); await recovering;
  expect(provider.resetCalls).toBe(1); expect(provider.setupCalls).toBe(2);
});

test('an authorized provider tracker rejects reuse of a cached bank context even before capture', async () => {
  await call(); provider.tracker.state = 'TRACKER_AUTHORIZED';
  expect((await view()).canAuthenticate).toBe(false);
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test('expired encrypted context needs explicit recovery and never automatically resubmits setup', async () => {
  await call();
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.expiresAt': new Date(0) } });
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  await call({ restartAuthentication: true });
  expect(provider.setupCalls).toBe(2); expect(provider.resetCalls).toBe(1);
});

test.each([
  ['merchant', tracker => { tracker.client = 'sec_foreign-fixture'; }],
  ['customer', tracker => { tracker.customer = 'cus_foreign-fixture'; }],
  ['amount', tracker => { tracker.purchase_totals.quote_amount.amount++; }],
  ['currency', tracker => { tracker.purchase_totals.quote_amount.currency = 'PKR'; }],
  ['reference', tracker => { tracker.metadata.data.order_id = 'wallet:foreign-fixture'; }],
  ['environment', tracker => { tracker.environment = 'production'; }],
  ['entry mode', tracker => { tracker.entry_mode = 'raw'; }],
  ['tracker token', tracker => { tracker.token = 'track_foreign-fixture'; }],
])('recovery never touches a tracker whose %s binding changed', async (_, alter) => {
  await loseFirstSetup(); alter(provider.tracker);
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_PAYMENT_MISMATCH' });
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test.each([
  ['cancelled', { localCancelledAt: new Date() }], ['paid', { status: 'paid', appliedAt: new Date(), capturedMinor: 200 }],
  ['risk hold', { riskPending: true }], ['refunded amount', { refundedMinor: 1 }],
])('a %s payment rejects cached bank context and explicit recovery', async (_, fields) => {
  await call(); await Payment.updateOne({ _id: payment._id }, { $set: fields });
  await expect(call()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CLOSED' });
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CLOSED' });
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test.each(['TRACKER_CANCELLED', 'TRACKER_EXPIRED'])('provider %s closes the same payment and cannot start authentication again', async state => {
  await loseFirstSetup(); provider.tracker.state = state;
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CLOSED' });
  expect((await stored()).status).toBe('cancelled');
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test('a bank setup carrying a charge never restarts even when local status is still ready', async () => {
  await loseFirstSetup(); provider.tracker.charge = { token: 'chg_existing-fixture' };
  expect((await view()).canAuthenticate).toBe(false);
  await expect(call({ restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test('local cancellation during setup prevents returning an authentication token/context', async () => {
  provider.setupGate = { started: deferred(), finish: deferred() };
  const first = call().catch(error => error); await provider.setupGate.started.promise;
  await Payment.updateOne({ _id: payment._id }, { $set: { localCancelledAt: new Date() } });
  provider.setupGate.finish.resolve();
  expect(await first).toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect((await stored()).savedCardAuthentication.encryptedContext).toBe('');
  expect(mockFetch.mock.calls.some(([url]) => new URL(url).pathname === '/client/passport/v1/token')).toBe(false);
});

test('expired ticket and mismatched session grants cannot trigger recovery on an otherwise valid payment', async () => {
  await loseFirstSetup();
  const fresh = service.buildCheckoutContext(payment, 'web');
  await expect(service.authenticate(String(payment._id), `Bearer ${ticket}`, billing, fresh.checkoutSessionGrant,
    { restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_SESSION_REQUIRED' });
  const key = crypto.createHmac('sha256', env.SAFEPAY_SANDBOX_SECRET_KEY).update('rozare-safepay-saved-card-v1:sandbox:ticket').digest();
  const expired = jwt.sign({ paymentId: String(payment._id), environment: 'sandbox', surface: 'web', binding: 'expired-fixture' }, key,
    { algorithm: 'HS256', audience: 'rozare-safepay-saved-card-v1', subject: String(payment.user), expiresIn: -1 });
  await expect(service.authenticate(String(payment._id), `Bearer ${expired}`, billing, grant,
    { restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_TICKET_EXPIRED' });
  expect(provider.setupCalls).toBe(1); expect(provider.resetCalls).toBe(0);
});

test('new signed-in checkout session can explicitly recover the original tracker; no new payment is created', async () => {
  await loseFirstSetup();
  const fresh = service.buildCheckoutContext(payment, 'mobile');
  await service.authenticate(String(payment._id), `Bearer ${new URL(fresh.checkoutUrl).hash.slice('#ticket='.length)}`, billing,
    fresh.checkoutSessionGrant, { restartAuthentication: true });
  expect(provider.setupCalls).toBe(2); expect(provider.resetCalls).toBe(1);
  expect(await Payment.countDocuments()).toBe(1);
  expect((await stored()).tracker).toBe(payment.tracker);
});
