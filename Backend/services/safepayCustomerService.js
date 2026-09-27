'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Customer = require('../models/SafepayCustomer');
const User = require('../models/User');
const Payment = require('../models/SafepayPayment');
const SellerSubscription = require('../models/SellerSubscription');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient, requireReusableCard } = require('./safepayClient');
const { canonicalizeShippingPhone } = require('./orderBuyerContactService');
const { ensurePayment, prepareCheckout, fingerprint } = require('./safepayPaymentService');
const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const clean = value => typeof value === 'string' ? value.trim() : '';
const CUSTOMER_LEASE_MS = 90000;
const CONTACT_FIELDS = ['first_name', 'last_name', 'email', 'phone_number', 'country'];
const billingError = (message, fields = []) => Object.assign(
  fail(message, 'SAFEPAY_BILLING_PROFILE_REQUIRED', 400), { fields }
);

function billingContactDraft(user) {
  const shipping = user.savedShippingInfo || {};
  const seller = user.sellerInfo || {};
  const fromShipping = Boolean(shipping.phone && shipping.fullName);
  return {
    fullName: clean(fromShipping ? shipping.fullName : user.username),
    phone: clean(fromShipping ? shipping.phone : seller.phoneNumber || seller.whatsappNumber),
    countryCode: clean(fromShipping ? shipping.countryCode : seller.countryCode).toUpperCase(),
    country: clean(fromShipping ? shipping.country : seller.country),
  };
}

function billingContact(user, supplied = {}) {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
    throw billingError('Enter your billing name, phone number and country.');
  }
  const draft = billingContactDraft(user);
  // An explicitly cleared/invalid input must not fall back to stale profile data.
  const value = key => clean(Object.prototype.hasOwnProperty.call(supplied, key) ? supplied[key] : draft[key]);
  const fullName = value('fullName').replace(/\s+/g, ' ');
  const [first, ...last] = fullName.split(' ');
  if (!first || !last.join(' ') || fullName.length > 160) {
    throw billingError('Enter your billing first and last name as shown on your card. Safepay requires both names.', ['fullName']);
  }
  const phone = value('phone');
  const countryCode = value('countryCode').toUpperCase();
  const country = value('country');
  if (!clean(user.email)) throw fail('Verify your account email before saving a card.', 'SAFEPAY_BILLING_EMAIL_REQUIRED', 400);
  if (!phone || (!countryCode && !country)) {
    throw billingError('Enter your billing phone number and select your country.', [!phone ? 'phone' : 'country']);
  }
  let normalized;
  try { normalized = canonicalizeShippingPhone({ phone, countryCode, country }); }
  catch (_) { throw billingError('Enter a valid billing phone number and country.', ['phone', 'country']); }
  if (!/^[A-Z]{2}$/.test(normalized.countryCode || '')) throw billingError('Choose your billing country.', ['country']);
  return { first_name: first, last_name: last.join(' '), email: clean(user.email).toLowerCase(),
    phone_number: normalized.e164, country: normalized.countryCode };
}

function profileWaitError(link, uncertain = false) {
  const remaining = Math.ceil((new Date(link?.leaseUntil || 0).getTime() - Date.now()) / 1000);
  const retryAfterSeconds = Math.min(90, Math.max(1, remaining || 1));
  return Object.assign(fail(uncertain
    ? 'Safepay has not confirmed your payment profile yet. Wait before retrying; no card setup has started.'
    : 'Another request is already setting up your payment profile. Please wait before retrying.',
  uncertain ? 'SAFEPAY_CUSTOMER_UNCERTAIN' : 'CHECKOUT_IN_PROGRESS', uncertain ? 503 : 409), { retryAfterSeconds });
}

function customerFailureForUser(error) {
  const fields = error.providerValidationFields || [];
  if (fields.includes('first_name') || fields.includes('last_name')) {
    return billingError('Enter your billing first and last name as shown on your card. Safepay requires both names.', ['fullName']);
  }
  if (fields.includes('email')) return fail('Safepay did not accept your account email. Check the email in your Profile before trying again.', 'SAFEPAY_BILLING_EMAIL_REJECTED', 400);
  if (fields.includes('phone_number')) return billingError('Safepay did not accept this billing phone number. Check the country code and number.', ['phone']);
  if (fields.includes('country')) return billingError('Safepay did not accept this billing country. Select your country again.', ['country']);
  if ([400, 422].includes(error.providerStatus)) return billingError('Safepay did not accept the billing details. Review your name, phone number and country before trying again.');
  return fail('Card setup is temporarily unavailable. Please try again later.', 'SAFEPAY_CUSTOMER_UNAVAILABLE', 503);
}

async function ensureCustomer(userId, contact = {}) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  await Customer.init();
  const identity = { user: userId, environment: config.environment };
  let link = await Customer.findOne(identity).select('+defaultCardId');
  if (link?.status === 'deleted') throw fail('This payment profile has been closed.', 'SAFEPAY_CUSTOMER_CLOSED', 423);
  if (link?.customerId) return link;
  const user = await User.findById(userId).select('username email status savedShippingInfo sellerInfo').lean();
  if (!user || user.status !== 'active') throw fail('This account cannot create a payment profile.', 'SAFEPAY_ACCOUNT_UNAVAILABLE', 403);
  const details = billingContact(user, contact);
  if (!link) {
    try { link = await Customer.create({ ...identity, createdForCardConsentAt: new Date() }); }
    catch (error) { if (error.code !== 11000) throw error; link = await Customer.findOne(identity); }
  }
  const lease = crypto.randomUUID();
  const claim = await Customer.findOneAndUpdate({ ...identity, customerId: null, status: { $ne: 'deleted' },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] },
  { $set: { status: 'creating', leaseToken: lease, leaseUntil: new Date(Date.now() + CUSTOMER_LEASE_MS), lastSetupError: null } }, { new: true });
  if (!claim) {
    const current = await Customer.findOne(identity).select('+defaultCardId');
    if (current?.status === 'deleted') throw fail('This payment profile has been closed.', 'SAFEPAY_CUSTOMER_CLOSED', 423);
    if (current?.customerId) return current;
    throw profileWaitError(current, current?.lastSetupError?.outcomeUnknown === true);
  }
  // No payment, card, subscription or checkout can exist through an unknown
  // customer id. Retrying an expired *customer creation* lease can at most
  // leave an unused contact record, never a duplicate payable transaction.
  let created;
  try {
    created = await createSafepayClient({ config }).createCustomer(details);
  } catch (error) {
    // Only a definite provider rejection may unlock immediately. Timeouts,
    // unreadable successes and identity mismatches retain the bounded lease.
    const definite = error.code === 'SAFEPAY_REQUEST_FAILED' && error.outcomeUnknown === false
      && error.providerStatus >= 400 && error.providerStatus < 500 && error.providerStatus !== 408;
    const providerStatus = Number.isInteger(error.providerStatus) && error.providerStatus >= 100 && error.providerStatus <= 599
      ? error.providerStatus : null;
    const fields = Array.isArray(error.providerValidationFields)
      ? error.providerValidationFields.filter(field => CONTACT_FIELDS.includes(field)) : [];
    await Customer.updateOne({ _id: claim._id, leaseToken: lease, customerId: null, status: 'creating' }, {
      $set: { lastSetupError: {
        code: definite ? 'SAFEPAY_CUSTOMER_REJECTED' : 'SAFEPAY_CUSTOMER_UNCERTAIN', providerStatus,
        fields, outcomeUnknown: !definite, at: new Date(),
      }, ...(definite ? { status: 'new', leaseToken: '', leaseUntil: null } : {}) },
    });
    throw definite ? customerFailureForUser(error) : profileWaitError(claim, true);
  }
  const saved = await Customer.findOneAndUpdate({ _id: claim._id, leaseToken: lease, customerId: null, status: 'creating' },
    { $set: { customerId: created.token, status: 'ready', leaseToken: '', leaseUntil: null, lastSetupError: null } }, { new: true }).select('+defaultCardId');
  if (!saved) throw fail('Payment profile recovery is required.', 'SAFEPAY_CUSTOMER_RECOVERY_PENDING', 503);
  return saved;
}

async function ownedCustomer(userId) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  const link = await Customer.findOne({ user: userId, environment: config.environment, status: 'ready' }).select('+defaultCardId +deletingCardId');
  return { config, link, client: createSafepayClient({ config }) };
}
const cardPresentation = card => ({ id: card.token, brand: card.cybersource?.scheme === 1 ? 'visa'
  : card.cybersource?.scheme === 2 ? 'mastercard' : 'card', last4: card.cybersource.last_four,
  expMonth: Number(card.cybersource.expiry_month), expYear: Number(card.cybersource.expiry_year), provider: 'safepay',
  usable: (() => { try { requireReusableCard(card); return true; } catch (_) { return false; } })() });

async function listCards(userId) {
  const { config, link, client } = await ownedCustomer(userId);
  if (!link) {
    const user = await User.findById(userId).select('username savedShippingInfo sellerInfo').lean();
    return { cards: [], defaultPaymentMethodId: null, provider: 'safepay', environment: config.environment,
      billingProfileReady: false, billingContact: billingContactDraft(user || {}) };
  }
  const all = await client.listCards(link.customerId);
  const cards = all.filter(card => card.max_usage === -1 && card.cybersource && /^\d{4}$/.test(card.cybersource.last_four || '')).map(cardPresentation);
  const selected = cards.some(card => card.id === link.defaultCardId && card.usable) ? link.defaultCardId : null;
  return { cards, defaultPaymentMethodId: selected, provider: 'safepay', environment: config.environment, billingProfileReady: true };
}
async function requireOwnedReusableCard(userId, cardId) {
  const { link, client, config } = await ownedCustomer(userId);
  if (!link || !cardId) throw fail('Add and choose a reusable payment card first.', 'SAFEPAY_REUSABLE_CARD_REQUIRED');
  if (link.deletingCardId === cardId) throw fail('This card is being removed. Choose another card.', 'CARD_REMOVAL_PENDING');
  const card = await client.getCard(link.customerId, cardId);
  requireReusableCard(card);
  return { link, card, client, config };
}
async function startCardSetup(userId, body) {
  if (body?.consentToSave !== true) throw fail('Please authorize Safepay to securely save your card.', 'CARD_STORAGE_CONSENT_REQUIRED', 400);
  const link = await ensureCustomer(userId, body.billingContact);
  await Payment.init();
  const requestKey = clean(body.requestKey);
  const payment = await ensurePayment({ user: userId, purpose: 'card_setup', requestKey,
    reference: `card:${userId}:${fingerprint(requestKey).slice(0, 24)}`, amountMinor: 0, currency: 'PKR', customerId: link.customerId,
    terms: { consentVersion: 'safepay-card-storage-v1', reusableRequired: true } });
  return prepareCheckout(payment._id);
}
async function setDefaultCard(userId, cardId) {
  const { link } = await requireOwnedReusableCard(userId, cardId);
  await Customer.updateOne({ _id: link._id, customerId: link.customerId }, { $set: { defaultCardId: cardId } });
  return { success: true, defaultPaymentMethodId: cardId };
}
async function deleteCard(userId, cardId) {
  const { link, client, config } = await ownedCustomer(userId);
  if (!link || !/^pm_[a-zA-Z0-9-]{8,100}$/.test(cardId || '')) throw fail('Saved card not found.', 'CARD_NOT_FOUND', 404);
  await mongoose.connection.transaction(async session => {
    const locked = await Customer.findOne({ _id: link._id, status: 'ready' }).select('+deletingCardId').session(session);
    if (!locked || (locked.deletingCardId && locked.deletingCardId !== cardId)) throw fail('Another card removal is being reconciled.', 'CARD_REMOVAL_PENDING');
    const subscription = await SellerSubscription.exists({ seller: userId, billingProvider: 'safepay', 'safepayBilling.cardId': cardId,
        'safepayBilling.environment': config.environment, 'safepayBilling.autoRenew': true,
        status: { $in: ['free_period', 'active', 'past_due'] } }).session(session);
    const inFlight = await Payment.exists({ user: userId, environment: config.environment, cardId, purpose: 'subscription', status: { $in: ['new', 'creating', 'ready'] } }).session(session);
    if (subscription || inFlight) throw fail('Change your subscription card or cancel renewal before removing this card. Pending payments must finish first.', 'CARD_IN_USE');
    locked.deletingCardId = cardId; locked.deletionStartedAt = locked.deletionStartedAt || new Date();
    await locked.save({ session });
  });
  const before = await client.listCards(link.customerId);
  if (before.some(card => card.token === cardId)) await client.deleteCard(link.customerId, cardId);
  const after = await client.listCards(link.customerId);
  if (after.some(card => card.token === cardId)) throw fail('Card removal is still being confirmed.', 'CARD_REMOVAL_PENDING', 503);
  await Customer.updateOne({ _id: link._id, deletingCardId: cardId, defaultCardId: cardId }, { $set: { defaultCardId: null } });
  await Customer.updateOne({ _id: link._id, deletingCardId: cardId }, { $set: { deletingCardId: null, deletionStartedAt: null } });
  return { success: true };
}
module.exports = { billingContact, billingContactDraft, ensureCustomer, ownedCustomer, listCards, requireOwnedReusableCard, startCardSetup, setDefaultCard, deleteCard, cardPresentation };
