'use strict';
const crypto = require('node:crypto');
const Contact = require('../models/SafepayCheckoutContact');
const User = require('../models/User');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient } = require('./safepayClient');
const { canonicalizeShippingName, canonicalizeShippingPhone } = require('./orderBuyerContactService');
const POLICY = 'hosted-checkout-contact-v1';
const LEASE_MS = 90000;
const fail = (message, code = 'SAFEPAY_CHECKOUT_CONTACT_UNAVAILABLE', statusCode = 503, extra = {}) => Object.assign(new Error(message), { code, statusCode, ...extra });

function checkoutContact(shipping) {
  const name = canonicalizeShippingName(shipping?.fullName);
  const email = typeof shipping?.email === 'string' ? shipping.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw fail('Enter a valid email address.', 'SAFEPAY_CHECKOUT_CONTACT_REQUIRED', 400, { fields: ['email'] });
  }
  const phone = canonicalizeShippingPhone(shipping);
  if (!/^[A-Z]{2}$/.test(phone.countryCode || '')) throw fail('Select your shipping country.', 'SAFEPAY_CHECKOUT_CONTACT_REQUIRED', 400, { fields: ['country'] });
  const [first_name, ...last] = name.split(' ');
  return { first_name, last_name: last.join(' '), email, phone_number: phone.e164, country: phone.countryCode };
}
const contactHash = details => crypto.createHash('sha256').update(JSON.stringify(details)).digest('hex');
const matches = (customer, details) => Object.entries(details).every(([field, value]) => customer[field] === value);
const wait = link => fail('Checkout contact details are still being prepared. Please retry this same attempt shortly.',
  'SAFEPAY_CHECKOUT_CONTACT_PENDING', 503, { retryAfterSeconds: Math.min(90, Math.max(1, Math.ceil((new Date(link.leaseUntil || 0) - Date.now()) / 1000))) });

async function ensureCheckoutContact(userId, shipping, { config = readSafepayConfig(process.env, { requireWebhook: true }), client = createSafepayClient({ config }) } = {}) {
  const details = checkoutContact(shipping);
  if (!await User.exists({ _id: userId, status: 'active' })) throw fail('This account cannot start checkout.', 'SAFEPAY_ACCOUNT_UNAVAILABLE', 403);
  await Contact.init();
  const identity = { user: userId, environment: config.environment, contactHash: contactHash(details) };
  let link = await Contact.findOne(identity);
  if (link?.customerId) {
    const customer = await client.getCheckoutGuest(link.customerId);
    if (!matches(customer, details)) throw fail('The saved checkout contact could not be verified. Please contact support.', 'SAFEPAY_CHECKOUT_CONTACT_MISMATCH');
    return link;
  }
  if (!link) {
    try { link = await Contact.create(identity); }
    catch (error) { if (error.code !== 11000) throw error; link = await Contact.findOne(identity); }
  }
  const lease = crypto.randomUUID(), at = new Date();
  const claimed = await Contact.findOneAndUpdate({ ...identity, customerId: null,
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: at } }] },
  { $set: { status: 'creating', leaseToken: lease, leaseUntil: new Date(at.getTime() + LEASE_MS), lastErrorCode: '', outcomeUnknown: false } }, { new: true });
  if (!claimed) {
    const current = await Contact.findOne(identity);
    if (current?.customerId) return current;
    throw wait(current || link);
  }
  let customer;
  try {
    customer = await client.createCheckoutGuest(details);
    if (!matches(customer, details)) throw fail('The provider did not confirm the checkout contact.', 'SAFEPAY_CHECKOUT_CONTACT_MISMATCH');
  } catch (error) {
    const definite = error.code === 'SAFEPAY_REQUEST_FAILED' && error.outcomeUnknown === false
      && error.providerStatus >= 400 && error.providerStatus < 500 && error.providerStatus !== 408;
    await Contact.updateOne({ _id: claimed._id, leaseToken: lease, customerId: null, status: 'creating' }, { $set: {
      lastErrorCode: definite ? 'SAFEPAY_CHECKOUT_CONTACT_REJECTED' : 'SAFEPAY_CHECKOUT_CONTACT_UNCERTAIN', outcomeUnknown: !definite,
      ...(definite ? { status: 'new', leaseUntil: null, leaseToken: '' } : {}),
    } });
    // An expired contact-creation lease may leave an unused guest reference,
    // never a second payment. There is no payment or charge until it is bound.
    if (definite) {
      const fields = (error.providerValidationFields || []).map(field => ({ first_name: 'fullName', last_name: 'fullName',
        email: 'email', phone_number: 'phone', country: 'country' })[field]).filter(Boolean);
      throw fail(fields.includes('fullName') ? 'Enter your first name and last name.' : 'Check your name, email, phone number and country.',
        'SAFEPAY_CHECKOUT_CONTACT_REQUIRED', 400, { fields: [...new Set(fields)] });
    }
    throw wait(claimed);
  }
  const ready = await Contact.findOneAndUpdate({ _id: claimed._id, leaseToken: lease, customerId: null, status: 'creating' },
    { $set: { customerId: customer.token, status: 'ready', leaseToken: '', leaseUntil: null, lastErrorCode: '', outcomeUnknown: false } }, { new: true });
  if (!ready) throw fail('Checkout contact recovery is required.', 'SAFEPAY_CHECKOUT_CONTACT_PENDING');
  return ready;
}

module.exports = { POLICY, checkoutContact, contactHash, ensureCheckoutContact };
