'use strict';
const crypto = require('node:crypto');
const Address = require('../models/SafepayCheckoutAddress');
const User = require('../models/User');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient } = require('./safepayClient');
const { resolveCountryCode } = require('./locationCatalogService');
const POLICY = 'hosted-checkout-address-v1';
const fail = (message, code = 'SAFEPAY_CHECKOUT_ADDRESS_UNAVAILABLE', statusCode = 503) => Object.assign(new Error(message), { code, statusCode });
function checkoutAddress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Enter your billing address.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
  const text = (field, limit) => {
    const input = value[field];
    if (input !== undefined && input !== null && typeof input !== 'string') throw fail('Enter a valid billing address.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
    const result = (input || '').trim().replace(/\s+/g, ' ');
    if (result.length > limit || /[\u0000-\u001f]/.test(result)) throw fail('Check the length of your billing address.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
    return result;
  };
  const result = { street1: text('address', 200), street2: text('address2', 200), city: text('city', 100),
    state: text('state', 100), postal_code: text('postalCode', 20), country: resolveCountryCode({ countryCode: value.countryCode, country: value.country }) };
  if (!result.street1 || !result.city || !/^[A-Z]{2}$/.test(result.country || '')) throw fail('Enter your billing street address, city and country.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
  return result;
}
const addressHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches = (address, expected) => Object.entries(expected).every(([key, value]) => (address?.[key] || '') === value);
const pending = () => fail('Your billing address is still being prepared. Please retry shortly.', 'SAFEPAY_CHECKOUT_ADDRESS_PENDING');
async function ensureCheckoutAddress(userId, billing, { config = readSafepayConfig(process.env, { requireWebhook: true }), client = createSafepayClient({ config }) } = {}) {
  const details = checkoutAddress(billing);
  if (!await User.exists({ _id: userId, status: 'active' })) throw fail('This account cannot start checkout.', 'SAFEPAY_ACCOUNT_UNAVAILABLE', 403);
  await Address.init();
  const identity = { user: userId, environment: config.environment, addressHash: addressHash(details) };
  let link = await Address.findOne(identity);
  if (link?.addressId) {
    if (!matches(await client.getCheckoutAddress(link.addressId), details)) throw fail('The billing address could not be verified.', 'SAFEPAY_CHECKOUT_ADDRESS_MISMATCH');
    return link;
  }
  if (!link) {
    try { link = await Address.create(identity); }
    catch (error) { if (error.code !== 11000) throw error; link = await Address.findOne(identity); }
  }
  const lease = crypto.randomUUID(), at = new Date();
  const claimed = await Address.findOneAndUpdate({ ...identity, addressId: null,
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: at } }] }, { $set: { status: 'creating', leaseToken: lease,
    leaseUntil: new Date(at.getTime() + 90000), outcomeUnknown: false, lastErrorCode: '' } }, { new: true });
  if (!claimed) {
    const current = await Address.findOne(identity);
    if (current?.addressId) return current;
    throw pending();
  }
  let address;
  try {
    address = await client.createCheckoutAddress(details);
    if (!matches(address, details)) throw fail('The provider did not confirm the billing address.', 'SAFEPAY_CHECKOUT_ADDRESS_MISMATCH');
  } catch (error) {
    const definite = error.code === 'SAFEPAY_REQUEST_FAILED' && error.outcomeUnknown === false
      && error.providerStatus >= 400 && error.providerStatus < 500 && error.providerStatus !== 408;
    await Address.updateOne({ _id: claimed._id, leaseToken: lease, addressId: null, status: 'creating' }, { $set: {
      outcomeUnknown: !definite, lastErrorCode: definite ? 'ADDRESS_REJECTED' : 'ADDRESS_UNCERTAIN',
      ...(definite ? { status: 'new', leaseToken: '', leaseUntil: null } : {}),
    } });
    if (definite) throw fail('Check your billing street address, city and country.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
    // No payment exists yet. Keep a bounded lease after an uncertain address
    // creation rather than immediately repeating the provider mutation.
    throw pending();
  }
  const ready = await Address.findOneAndUpdate({ _id: claimed._id, leaseToken: lease, addressId: null, status: 'creating' },
    { $set: { addressId: address.token, status: 'ready', leaseToken: '', leaseUntil: null, outcomeUnknown: false, lastErrorCode: '' } }, { new: true });
  if (!ready) throw pending();
  return ready;
}
module.exports = { POLICY, checkoutAddress, addressHash, ensureCheckoutAddress };
