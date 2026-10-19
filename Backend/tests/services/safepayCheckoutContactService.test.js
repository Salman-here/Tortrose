'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const Contact = require('../../models/SafepayCheckoutContact');
const Customer = require('../../models/SafepayCustomer');
const Payment = require('../../models/SafepayPayment');
const { checkoutContact, contactHash, ensureCheckoutContact } = require('../../services/safepayCheckoutContactService');
const shipping = { fullName: '  Checkout   van der Meer ', email: ' Shipping@Example.com ', phone: '0300 1234567', country: 'Pakistan', countryCode: 'PK' };
const details = { first_name: 'Checkout', last_name: 'van der Meer', email: 'shipping@example.com', phone_number: '+923001234567', country: 'PK' };
const config = { environment: 'sandbox' };
let mongo, user, client, counter;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await Promise.all([User, Contact, Customer, Payment].map(model => model.init()));
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
  await Promise.all([User, Contact, Customer, Payment].map(model => model.deleteMany({})));
  user = await User.create({ username: 'Checkout Buyer', email: 'account-not-shipping@example.com', status: 'active' });
  counter = 0;
  const guests = new Map();
  client = { createCheckoutGuest: jest.fn(async value => {
    const guest = { ...value, token: 'cus_checkout-fixture-' + (++counter), is_guest: true };
    guests.set(guest.token, guest); return guest;
  }), getCheckoutGuest: jest.fn(async id => guests.get(id)) };
});
const ensure = (value = shipping, opts = {}) => ensureCheckoutContact(user._id, value, { config, client, ...opts });

test('prefills the exact shipping contact, not account email; reuses a verified guest without Saved Cards consent', async () => {
  expect(checkoutContact(shipping)).toEqual(details);
  const first = await ensure(), second = await ensure();
  expect(String(second._id)).toBe(String(first._id));
  expect(client.createCheckoutGuest).toHaveBeenCalledTimes(1);
  expect(client.createCheckoutGuest).toHaveBeenCalledWith(details);
  expect(client.getCheckoutGuest).toHaveBeenCalledWith(first.customerId);
  expect(first.contactHash).toBe(contactHash(details));
  expect(await Customer.countDocuments()).toBe(0);
  expect(await Payment.countDocuments()).toBe(0);
  const stored = JSON.stringify(await Contact.findOne().lean());
  expect(stored).not.toContain(details.email); expect(stored).not.toContain(details.phone_number);
  expect((await User.findById(user._id)).email).toBe('account-not-shipping@example.com');
});
test.each([{ fullName: 'Another Buyer' }, { email: 'another@example.com' }, { phone: '+442079460018' }, { country: 'United Kingdom', countryCode: 'GB' }])(
  'a changed shipping contact creates its own reference without mutating the previous one: %j', async patch => {
    const first = await ensure(), second = await ensure({ ...shipping, ...patch });
    expect(second.customerId).not.toBe(first.customerId);
    expect((await Contact.findById(first._id)).contactHash).toBe(first.contactHash);
    expect(client.createCheckoutGuest).toHaveBeenCalledTimes(2);
  });
test('guest references are isolated by account and environment', async () => {
  const first = await ensure();
  const other = await User.create({ username: 'Other Buyer', email: 'other@example.com', status: 'active' });
  const second = await ensureCheckoutContact(other._id, shipping, { config, client });
  const third = await ensure(shipping, { config: { environment: 'production' } });
  expect(new Set([first.customerId, second.customerId, third.customerId]).size).toBe(3);
});
test.each([{ fullName: 'Buyer' }, { email: '' }, { email: 'broken' }, { phone: '' }, { country: 'Unknown', countryCode: '' }])(
  'invalid contact fails before any profile or provider creation: %j', async patch => {
    await expect(ensure({ ...shipping, ...patch })).rejects.toMatchObject({ statusCode: 400 });
    expect(await Contact.countDocuments()).toBe(0); expect(client.createCheckoutGuest).not.toHaveBeenCalled();
  });
test('blocked accounts cannot start checkout', async () => {
  await User.updateOne({ _id: user._id }, { $set: { status: 'blocked' } });
  await expect(ensure()).rejects.toMatchObject({ statusCode: 403 });
  expect(client.createCheckoutGuest).not.toHaveBeenCalled();
});
test('concurrent requests create only one guest contact', async () => {
  let began, finish;
  const entered = new Promise(resolve => { began = resolve; });
  client.createCheckoutGuest.mockImplementationOnce(value => { began(); return new Promise(resolve => { finish = () => resolve({ ...value, token: 'cus_concurrent-fixture' }); }); });
  const first = ensure(); await entered;
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CONTACT_PENDING', retryAfterSeconds: expect.any(Number) });
  finish(); expect((await first).status).toBe('ready');
  expect(client.createCheckoutGuest).toHaveBeenCalledTimes(1);
});
test('definite provider rejection exposes only safe field corrections and permits retry', async () => {
  client.createCheckoutGuest.mockRejectedValueOnce(Object.assign(new Error('private provider body'), {
    code: 'SAFEPAY_REQUEST_FAILED', providerStatus: 400, outcomeUnknown: false, providerValidationFields: ['last_name', 'card_number'],
  }));
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CONTACT_REQUIRED', fields: ['fullName'] });
  expect((await Contact.findOne()).leaseUntil).toBeNull();
  expect((await ensure()).status).toBe('ready');
  expect(client.createCheckoutGuest).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(await Contact.findOne().lean())).not.toContain('private provider body');
});
test('an uncertain creation is not blindly repeated', async () => {
  client.createCheckoutGuest.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'SAFEPAY_REQUEST_UNCERTAIN', outcomeUnknown: true }));
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CONTACT_PENDING' });
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CONTACT_PENDING' });
  expect(client.createCheckoutGuest).toHaveBeenCalledTimes(1);
  expect((await Contact.findOne()).outcomeUnknown).toBe(true);
  expect(await Payment.countDocuments()).toBe(0);
});
test('a provider contact mismatch cannot silently change the checkout identity', async () => {
  await ensure();
  client.getCheckoutGuest.mockResolvedValueOnce({ ...details, email: 'someone-else@example.com' });
  await expect(ensure()).rejects.toMatchObject({ code: 'SAFEPAY_CHECKOUT_CONTACT_MISMATCH' });
  expect(client.createCheckoutGuest).toHaveBeenCalledTimes(1);
});
