'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const Address = require('../../models/SafepayCheckoutAddress');
const { checkoutAddress, ensureCheckoutAddress } = require('../../services/safepayCheckoutAddressService');
let mongo, user, client, sequence;
const input = { address: ' 1 Test Street ', city: ' Lahore ', state: 'Punjab', postalCode: '54000', countryCode: 'PK' };
const expected = { street1: '1 Test Street', street2: '', city: 'Lahore', state: 'Punjab', postal_code: '54000', country: 'PK' };
const config = { environment: 'sandbox' };
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Address.init(); }, 90000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  await User.deleteMany({}); await Address.deleteMany({});
  user = await User.create({ username: 'Billing Tester', email: 'billing@example.com', status: 'active' }); sequence = 0;
  const addresses = new Map();
  client = { createCheckoutAddress: jest.fn(async value => { const result = { ...value, token: 'address_billing-test-' + (++sequence) }; addresses.set(result.token, result); return result; }),
    getCheckoutAddress: jest.fn(async id => addresses.get(id)) };
});
const ensure = (value = input, options = {}) => ensureCheckoutAddress(user._id, value, { config, client, ...options });
test('uses the supplied billing address and reuses a verified reference without caching raw address data', async () => {
  expect(checkoutAddress(input)).toEqual(expected);
  const first = await ensure(), second = await ensure(); expect(String(first._id)).toBe(String(second._id));
  expect(client.createCheckoutAddress).toHaveBeenCalledTimes(1); expect(client.createCheckoutAddress).toHaveBeenCalledWith(expected);
  expect(JSON.stringify(await Address.findOne().lean())).not.toContain('Test Street');
});
test.each([{ city: '' }, { address: '' }, { countryCode: '' }, { address: {} }, { city: 'x'.repeat(101) }])('rejects invalid billing data before creating a provider address: %j', async patch => {
  await expect(ensure({ ...input, ...patch })).rejects.toMatchObject({ statusCode: 400, code: 'SAFEPAY_BILLING_ADDRESS_REQUIRED' });
  expect(client.createCheckoutAddress).not.toHaveBeenCalled(); expect(await Address.countDocuments()).toBe(0);
});
test('new billing details and environments do not mutate an older reference', async () => {
  const first = await ensure(), second = await ensure({ ...input, city: 'Islamabad' }), third = await ensure(input, { config: { environment: 'production' } });
  expect(new Set([first.addressId, second.addressId, third.addressId]).size).toBe(3);
  expect((await Address.findById(first._id)).addressHash).toBe(first.addressHash);
});
test('concurrent requests and uncertain outcomes do not immediately repeat address creation', async () => {
  let started, finish;
  const entered = new Promise(resolve => { started = resolve; });
  client.createCheckoutAddress.mockImplementationOnce(value => { started(); return new Promise(resolve => { finish = () => resolve({ ...value, token: 'address_concurrent-billing' }); }); });
  const first = ensure(); await entered;
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_ADDRESS_PENDING' }); finish(); await first;
  expect(client.createCheckoutAddress).toHaveBeenCalledTimes(1);
  await Address.deleteMany({}); client.createCheckoutAddress.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'SAFEPAY_REQUEST_UNCERTAIN', outcomeUnknown: true }));
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_ADDRESS_PENDING' });
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_ADDRESS_PENDING' });
  expect(client.createCheckoutAddress).toHaveBeenCalledTimes(2);
});
test('a definite rejection unlocks only that lease; a verified GET mismatch never overwrites the old address', async () => {
  client.createCheckoutAddress.mockRejectedValueOnce(Object.assign(new Error('private upstream body'), { code: 'SAFEPAY_REQUEST_FAILED', providerStatus: 400, outcomeUnknown: false }));
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_BILLING_ADDRESS_REQUIRED' });
  const link = await ensure(); expect(link.status).toBe('ready');
  client.getCheckoutAddress.mockResolvedValueOnce({ ...expected, city: 'Someone Else' });
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_ADDRESS_MISMATCH' });
  expect((await Address.findById(link._id)).addressId).toBe(link.addressId);
});
