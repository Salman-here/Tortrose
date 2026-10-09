'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const User = require('../../models/User');
const mockClient = { getTracker: jest.fn(), getCard: jest.fn(), setupSavedCardAuthentication: jest.fn(), resetSavedCardAuthentication: jest.fn(), createAuthToken: jest.fn() };
jest.mock('../../services/safepayClient', () => ({ ...jest.requireActual('../../services/safepayClient'), createSafepayClient: () => mockClient }));
jest.mock('../../services/safepayCustomerService', () => ({ requireOwnedReusableCard: jest.fn(async () => ({ card: { cybersource: { scheme: 1, last_four: '1111' } } })) }));
jest.mock('../../services/safepayPaymentService', () => ({ reconcilePayment: async id => require('../../models/SafepayPayment').findById(id) }));
const service = require('../../services/safepaySavedCardCheckoutService');
const config = require('../../config/safepay');
let repl, payment, token, grant;
const previousEnv = {};
const testEnv = { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_sandbox-fixture',
  SAFEPAY_SANDBOX_SECRET_KEY: 'private-test-secret-never-log', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-webhook-fixture',
  SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-data' };
beforeAll(async () => {
  for (const [key, value] of Object.entries(testEnv)) { previousEnv[key] = process.env[key]; process.env[key] = value; }
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(repl.getUri()); await Payment.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect(); await repl.stop();
  for (const key of Object.keys(testEnv)) { if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key]; }
});
beforeEach(async () => {
  await Payment.deleteMany({}); await User.deleteMany({});
  const owner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: owner, status: 'active', savedShippingInfo: { address: '1 Test Lane', city: 'Lahore', countryCode: 'PK' } });
  payment = await Payment.create({ user: owner, environment: 'sandbox', purpose: 'wallet_top_up', reference: 'wallet:saved-card-fixture',
    requestKey: 'saved-card-attempt-fixture', fingerprint: 'a'.repeat(64), amountMinor: 200, currency: 'USD',
    providerMode: 'payment', providerEntryMode: 'tms', customerId: 'cus_owned-fixture', cardId: 'pm_owned-fixture',
    tracker: 'track_saved-card-fixture', status: 'ready' });
  const checkout = service.buildCheckoutContext(payment, 'web');
  token = new URL(checkout.checkoutUrl).hash.slice('#ticket='.length);
  grant = checkout.checkoutSessionGrant;
  jest.clearAllMocks();
  mockClient.getTracker.mockResolvedValue({ state: 'TRACKER_STARTED', next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_SETUP' } } });
  mockClient.setupSavedCardAuthentication.mockResolvedValue({ deviceDataCollectionJWT: 'private-ddc-fixture-token', deviceDataCollectionURL: 'https://centinelapistag.cardinalcommerce.com/V1/Cruise/Collect' });
  mockClient.createAuthToken.mockResolvedValue('temporary-provider-auth-fixture');
  mockClient.resetSavedCardAuthentication.mockImplementation(async () => {
    const reset = { state: 'TRACKER_STARTED', next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_SETUP' } } };
    mockClient.getTracker.mockResolvedValue(reset);
    return reset;
  });
});
test('ticket is short-lived, fragment-only and restricted to its exact account, payment and environment', async () => {
  const url = new URL(service.buildCheckoutUrl(payment, 'web'));
  expect(url.search).toBe(''); expect(url.pathname).toBe(`/api/safepay/saved-checkout/${payment._id}`);
  expect(url.hash).not.toContain(testEnv.SAFEPAY_SANDBOX_SECRET_KEY);
  const owned = await service.ownedContext(String(payment._id), `Bearer ${token}`, grant);
  expect(owned.claims.exp - owned.claims.iat).toBe(900);
  await expect(service.ownedContext(String(new mongoose.Types.ObjectId()), `Bearer ${token}`, grant)).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_SESSION_REQUIRED' });
  await expect(service.ownedContext(String(payment._id), 'Bearer forged', grant)).rejects.toMatchObject({ statusCode: 401 });
  await Payment.updateOne({ _id: payment._id }, { $set: { status: 'ready' } });
  await User.updateOne({ _id: payment.user }, { $set: { status: 'blocked' } });
  await expect(service.ownedContext(String(payment._id), `Bearer ${token}`, grant)).rejects.toMatchObject({ code: 'SAFEPAY_ACCOUNT_UNAVAILABLE' });
});
test('reading the review returns only masked card and frozen money, never starts authentication or a capture', async () => {
  const view = await service.viewContext(String(payment._id), `Bearer ${token}`, grant);
  expect(view).toMatchObject({ amountMinor: 200, currency: 'USD', card: { brand: 'Visa', last4: '1111' }, canAuthenticate: true,
    billing: { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' } });
  expect(view.authToken).toBeUndefined(); expect(view.tracker).toBeUndefined();
  expect(mockClient.setupSavedCardAuthentication).not.toHaveBeenCalled();
});

test('a copied checkout URL alone cannot reveal or charge a saved card', async () => {
  await expect(service.viewContext(String(payment._id), `Bearer ${token}`)).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_SESSION_REQUIRED' });
  const otherSession = service.buildCheckoutContext(payment, 'web');
  await expect(service.viewContext(String(payment._id), `Bearer ${token}`, otherSession.checkoutSessionGrant)).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_SESSION_REQUIRED' });
  expect(mockClient.setupSavedCardAuthentication).not.toHaveBeenCalled();
});
test('explicit approval initializes owned-card authentication once and stores its context encrypted', async () => {
  const billing = { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' };
  const first = await service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant);
  const second = await service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant);
  expect(first).toMatchObject({ tracker: payment.tracker, user: payment.customerId, environment: 'sandbox', billing: { country: 'PK' } });
  expect(second.deviceDataCollectionJWT).toBe(first.deviceDataCollectionJWT);
  expect(mockClient.setupSavedCardAuthentication).toHaveBeenCalledTimes(1);
  const stored = await Payment.findById(payment._id).select('+savedCardAuthentication.encryptedContext');
  expect(stored.savedCardAuthentication.encryptedContext).not.toContain(first.deviceDataCollectionJWT);
  expect(stored.chargeStartedAt).toBeNull(); expect(stored.capturedMinor).toBe(0); expect(stored.appliedAt).toBeNull();
  expect((await Payment.findById(payment._id).lean()).savedCardAuthentication.encryptedContext).toBeUndefined();
});
test('unknown setup response remains claimed instead of being silently retried', async () => {
  mockClient.setupSavedCardAuthentication.mockRejectedValueOnce(Object.assign(new Error('uncertain'), { outcomeUnknown: true, code: 'SAFEPAY_REQUEST_UNCERTAIN' }));
  const billing = { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' };
  await expect(service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant)).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  await expect(service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant)).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(mockClient.setupSavedCardAuthentication).toHaveBeenCalledTimes(1);
});

test.each([['TRACKER_ENROLLED', 'PAYER_AUTH_VALIDATION'], ['TRACKER_STARTED', 'PAYER_AUTH_ENROLLMENT']])('explicit retry recovers the incomplete %s/%s bank journey, preserves identity and performs a new 3DS setup', async (state, kind) => {
  const billing = { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' };
  await service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant);
  mockClient.getTracker.mockResolvedValue({ state, next_actions: { CYBERSOURCE: { kind } } });
  await Payment.updateOne({ _id: payment._id }, { $set: { 'savedCardAuthentication.expiresAt': new Date(0) } });
  expect((await service.viewContext(String(payment._id), `Bearer ${token}`, grant)).canRestartAuthentication).toBe(true);
  await service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant, { restartAuthentication: true });
  expect(mockClient.resetSavedCardAuthentication).toHaveBeenCalledTimes(1);
  expect(mockClient.setupSavedCardAuthentication).toHaveBeenCalledTimes(2);
  expect(await Payment.countDocuments()).toBe(1);
  const unchanged = await Payment.findById(payment._id);
  expect(unchanged.amountMinor).toBe(200); expect(unchanged.tracker).toBe(payment.tracker);
  expect(unchanged.appliedAt).toBeNull(); expect(unchanged.capturedMinor).toBe(0);
});

test('unknown reset response is never automatically submitted again', async () => {
  const billing = { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' };
  await service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant);
  mockClient.getTracker.mockResolvedValue({ state: 'TRACKER_ENROLLED', next_actions: { CYBERSOURCE: { kind: 'PAYER_AUTH_VALIDATION' } } });
  mockClient.resetSavedCardAuthentication.mockRejectedValueOnce(Object.assign(new Error('uncertain'), { outcomeUnknown: true, code: 'SAFEPAY_REQUEST_UNCERTAIN' }));
  await expect(service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant, { restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_REQUEST_UNCERTAIN' });
  await expect(service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant, { restartAuthentication: true })).rejects.toMatchObject({ code: 'SAFEPAY_AUTHENTICATION_IN_PROGRESS' });
  expect(mockClient.resetSavedCardAuthentication).toHaveBeenCalledTimes(1);
});
test('paid and locally cancelled payments cannot start a second authentication journey', async () => {
  const billing = { street_1: '1 Test Lane', city: 'Lahore', country: 'PK' };
  await Payment.updateOne({ _id: payment._id }, { $set: { status: 'paid', appliedAt: new Date() } });
  await expect(service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant)).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CLOSED' });
  await Payment.updateOne({ _id: payment._id }, { $set: { status: 'ready', appliedAt: null, localCancelledAt: new Date() } });
  await expect(service.authenticate(String(payment._id), `Bearer ${token}`, billing, grant)).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CLOSED' });
  expect(mockClient.setupSavedCardAuthentication).not.toHaveBeenCalled();
});
test('encrypted bank context is bound to the payment and rejects modification', () => {
  const cfg = config.readSafepayConfig();
  const sealed = service.sealContext({ token: 'private-bank-token' }, cfg, payment._id);
  expect(service.unsealContext(sealed, cfg, payment._id)).toEqual({ token: 'private-bank-token' });
  expect(() => service.unsealContext(sealed, cfg, 'different-payment')).toThrow();
  expect(() => service.unsealContext(sealed.slice(0, -4) + 'bad!', cfg, payment._id)).toThrow();
});
test('the review HTML never collects PAN/CVC or infers payment success from a callback', () => {
  const html = require('../../services/safepaySavedCardCheckoutHtml').renderSavedCardCheckout({ nonce: 'abcdefghijklmnopqrstuvwx' });
  expect(html).toContain('/api/safepay/assets/atoms-0.3.7.js');
  expect(html).toContain('do_capture:true,do_card_on_file:false');
  expect(html).toContain('Return to Rozare and check payment');
  expect(html).not.toContain('name="card_number"'); expect(html).not.toContain('name="cvv"');
  expect(html).not.toContain('localStorage'); expect(html).not.toContain('isPaid:true');
  const script = html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new (require('node:vm').Script)(script)).not.toThrow();
});
