'use strict';
const mockCreateCustomer = jest.fn();
const mockListCards = jest.fn();
jest.mock('../../services/safepayClient', () => ({
  ...jest.requireActual('../../services/safepayClient'),
  createSafepayClient: () => ({ createCustomer: mockCreateCustomer, listCards: mockListCards }),
}));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const Customer = require('../../models/SafepayCustomer');
const Payment = require('../../models/SafepayPayment');
const { billingContact, ensureCustomer, startCardSetup, listCards } = require('../../services/safepayCustomerService');
let mongo, user;
const validContact = { fullName: 'Test Seller', phone: '+923001234567', country: 'Pakistan', countryCode: 'PK' };
const providerCustomer = { token: 'cus_customer-fixture' };
const providerRejection = fields => Object.assign(new Error('Do not persist upstream contact/secret data'), {
  code: 'SAFEPAY_REQUEST_FAILED', providerStatus: 400, outcomeUnknown: false, providerValidationFields: fields,
});

beforeAll(async () => {
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_customer-test',
    SAFEPAY_SANDBOX_SECRET_KEY: 'customer-test-private', SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'customer-test-webhook',
    SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User, Customer, Payment].map(model => model.init()));
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  await Promise.all([User, Customer, Payment].map(model => model.deleteMany({})));
  mockCreateCustomer.mockReset().mockResolvedValue(providerCustomer);
  mockListCards.mockReset().mockResolvedValue([]);
  user = await User.create({ username: 'Seller', email: 'customer-fixture@example.com', status: 'active', role: 'seller',
    savedShippingInfo: { ...validContact, fullName: 'SingleName' } });
});

test('new-account card listing supplies owned contact details without creating a provider profile', async () => {
  expect(await listCards(user._id)).toMatchObject({ cards: [], billingProfileReady: false,
    billingContact: { ...validContact, fullName: 'SingleName' } });
  expect(await Customer.countDocuments()).toBe(0);
  expect(mockCreateCustomer).not.toHaveBeenCalled();
});

test.each(['SingleName', '', '   ', 'a'.repeat(161)])('rejects incomplete billing name before acquiring a lease: %s', async fullName => {
  await expect(ensureCustomer(user._id, { ...validContact, fullName })).rejects.toMatchObject({
    code: 'SAFEPAY_BILLING_PROFILE_REQUIRED', statusCode: 400, fields: ['fullName'],
  });
  expect(mockCreateCustomer).not.toHaveBeenCalled();
  expect(await Customer.countDocuments()).toBe(0);
  expect(await Payment.countDocuments()).toBe(0);
});

test('single-word saved name gets a useful first/last-name error rather than being sent to Safepay', async () => {
  await expect(ensureCustomer(user._id)).rejects.toThrow('first and last name');
  expect(mockCreateCustomer).not.toHaveBeenCalled();
});

test('explicitly cleared fields cannot silently fall back to saved contact details', () => {
  for (const contact of [{ fullName: '' }, { phone: '' }, { countryCode: '', country: '' }]) {
    expect(() => billingContact(user.toObject(), { ...validContact, ...contact })).toThrow();
  }
  expect(() => billingContact(user.toObject(), null)).toThrow();
  expect(() => billingContact(user.toObject(), [])).toThrow();
});

test('supports Unicode/multipart names and creates one owned profile after correction', async () => {
  const ready = await ensureCustomer(user._id, { ...validContact, fullName: '  Élodie   van der Meer  ' });
  expect(mockCreateCustomer).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Élodie', last_name: 'van der Meer', country: 'PK' }));
  expect(ready).toMatchObject({ status: 'ready', customerId: providerCustomer.token, leaseUntil: null, lastSetupError: null });
  expect((await User.findById(user._id)).savedShippingInfo.fullName).toBe('SingleName');
  expect(await Payment.countDocuments()).toBe(0);
  expect(await listCards(user._id)).toMatchObject({ billingProfileReady: true, cards: [] });
  await ensureCustomer(user._id, { fullName: 'SingleName' });
  expect(mockCreateCustomer).toHaveBeenCalledTimes(1);
});

test('definite rejection clears only its lease and permits an immediate corrected retry', async () => {
  mockCreateCustomer.mockRejectedValueOnce(providerRejection(['last_name']));
  await expect(ensureCustomer(user._id, validContact)).rejects.toMatchObject({
    code: 'SAFEPAY_BILLING_PROFILE_REQUIRED', fields: ['fullName'],
  });
  const rejected = await Customer.findOne({ user: user._id }).select('+leaseToken').lean();
  expect(rejected).toMatchObject({ status: 'new', customerId: null, leaseUntil: null, leaseToken: '',
    lastSetupError: { code: 'SAFEPAY_CUSTOMER_REJECTED', providerStatus: 400, fields: ['last_name'], outcomeUnknown: false } });
  expect(JSON.stringify(rejected)).not.toContain('upstream contact/secret');
  expect((await ensureCustomer(user._id, validContact)).status).toBe('ready');
  expect(mockCreateCustomer).toHaveBeenCalledTimes(2);
  expect(await Payment.countDocuments()).toBe(0);
});

test.each([
  [['phone_number'], 'SAFEPAY_BILLING_PROFILE_REQUIRED', 'phone'],
  [['country'], 'SAFEPAY_BILLING_PROFILE_REQUIRED', 'country'],
  [['email'], 'SAFEPAY_BILLING_EMAIL_REJECTED', null],
  [[], 'SAFEPAY_BILLING_PROFILE_REQUIRED', null],
])('maps safe provider validation fields %j into an actionable error', async (fields, code, field) => {
  mockCreateCustomer.mockRejectedValueOnce(providerRejection(fields));
  await expect(ensureCustomer(user._id, validContact)).rejects.toMatchObject({ code, ...(field ? { fields: [field] } : {}) });
  expect((await Customer.findOne({ user: user._id })).leaseUntil).toBeNull();
});

test.each([
  { code: 'SAFEPAY_REQUEST_UNCERTAIN', outcomeUnknown: true },
  { code: 'SAFEPAY_REQUEST_FAILED', providerStatus: 500, outcomeUnknown: true },
  { code: 'SAFEPAY_RESPONSE_INVALID', outcomeUnknown: true },
  { code: 'SAFEPAY_CUSTOMER_MISMATCH' },
  { code: 'SAFEPAY_REQUEST_FAILED', providerStatus: 200, outcomeUnknown: false },
])('uncertain response %j retains the bounded lock without immediate duplicate creation', async details => {
  mockCreateCustomer.mockRejectedValueOnce(Object.assign(new Error('uncertain provider data'), details));
  await expect(ensureCustomer(user._id, validContact)).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_UNCERTAIN', retryAfterSeconds: expect.any(Number) });
  const uncertain = await Customer.findOne({ user: user._id });
  expect(uncertain.status).toBe('creating');
  expect(uncertain.leaseUntil.getTime()).toBeGreaterThan(Date.now());
  expect(uncertain.lastSetupError.outcomeUnknown).toBe(true);
  await expect(ensureCustomer(user._id, validContact)).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_UNCERTAIN' });
  expect(mockCreateCustomer).toHaveBeenCalledTimes(1);
});

test('concurrent requests share one profile creation and report a bounded retry time', async () => {
  let finish, entered;
  const began = new Promise(resolve => { entered = resolve; });
  mockCreateCustomer.mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const first = ensureCustomer(user._id, validContact);
  await began;
  await expect(ensureCustomer(user._id, validContact)).rejects.toMatchObject({ code: 'CHECKOUT_IN_PROGRESS', retryAfterSeconds: expect.any(Number) });
  finish(providerCustomer);
  await first;
  expect((await ensureCustomer(user._id, validContact)).customerId).toBe(providerCustomer.token);
  expect(mockCreateCustomer).toHaveBeenCalledTimes(1);
});

test('a stale failed request cannot clear a newer worker lease', async () => {
  let reject, entered;
  const began = new Promise(resolve => { entered = resolve; });
  mockCreateCustomer.mockImplementationOnce(() => { entered(); return new Promise((_, fail) => { reject = fail; }); });
  const request = ensureCustomer(user._id, validContact);
  const failed = expect(request).rejects.toMatchObject({ code: 'SAFEPAY_BILLING_PROFILE_REQUIRED' });
  await began;
  await Customer.updateOne({ user: user._id }, { $set: { leaseToken: 'newer-lease' } });
  reject(providerRejection(['last_name']));
  await failed;
  expect(await Customer.findOne({ user: user._id }).select('+leaseToken')).toMatchObject({ status: 'creating', leaseToken: 'newer-lease', lastSetupError: null });
});

test('a delayed provider success cannot reopen a closed profile', async () => {
  let finish, entered;
  const began = new Promise(resolve => { entered = resolve; });
  mockCreateCustomer.mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
  const request = ensureCustomer(user._id, validContact);
  const failed = expect(request).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_RECOVERY_PENDING' });
  await began;
  await Customer.updateOne({ user: user._id }, { $set: { status: 'deleted' } });
  finish(providerCustomer);
  await failed;
  expect(await Customer.findOne({ user: user._id })).toMatchObject({ status: 'deleted', customerId: null });
});

test('existing closed profiles and missing consent cannot initiate provider work', async () => {
  await Customer.create({ user: user._id, environment: 'sandbox', status: 'deleted' });
  await expect(ensureCustomer(user._id, validContact)).rejects.toMatchObject({ code: 'SAFEPAY_CUSTOMER_CLOSED' });
  await expect(startCardSetup(user._id, { consentToSave: false })).rejects.toMatchObject({ code: 'CARD_STORAGE_CONSENT_REQUIRED' });
  expect(mockCreateCustomer).not.toHaveBeenCalled();
});
