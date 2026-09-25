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

function billingContact(user, supplied = {}) {
  const shipping = user.savedShippingInfo || {};
  const seller = user.sellerInfo || {};
  const fromShipping = Boolean(shipping.phone && shipping.fullName);
  const fullName = clean(supplied.fullName || (fromShipping ? shipping.fullName : user.username));
  const phone = clean(supplied.phone || (fromShipping ? shipping.phone : seller.phoneNumber || seller.whatsappNumber));
  const countryCode = clean(supplied.countryCode || (fromShipping ? shipping.countryCode : seller.countryCode)).toUpperCase();
  const country = clean(supplied.country || (fromShipping ? shipping.country : seller.country));
  if (!fullName || fullName.length > 160 || !clean(user.email) || !phone || (!countryCode && !country)) {
    throw fail('Add your name, phone number and country in your Rozare billing contact before saving a card.', 'SAFEPAY_BILLING_PROFILE_REQUIRED', 400);
  }
  let normalized;
  try { normalized = canonicalizeShippingPhone({ phone, countryCode, country }); }
  catch (_) { throw fail('Enter a valid billing phone number and country.', 'SAFEPAY_BILLING_PROFILE_REQUIRED', 400); }
  if (!/^[A-Z]{2}$/.test(normalized.countryCode || '')) throw fail('Choose your billing country.', 'SAFEPAY_BILLING_PROFILE_REQUIRED', 400);
  const [first, ...last] = fullName.split(/\s+/);
  return { first_name: first, last_name: last.join(' '), email: clean(user.email).toLowerCase(),
    phone_number: normalized.e164, country: normalized.countryCode };
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
  { $set: { status: 'creating', leaseToken: lease, leaseUntil: new Date(Date.now() + 90000) } }, { new: true });
  if (!claim) throw fail('Your payment profile is being prepared. Please retry shortly.', 'CHECKOUT_IN_PROGRESS');
  // No payment, card, subscription or checkout can exist through an unknown
  // customer id. Retrying an expired *customer creation* lease can at most
  // leave an unused contact record, never a duplicate payable transaction.
  const created = await createSafepayClient({ config }).createCustomer(details);
  const saved = await Customer.findOneAndUpdate({ _id: claim._id, leaseToken: lease, customerId: null },
    { $set: { customerId: created.token, status: 'ready', leaseToken: '', leaseUntil: null } }, { new: true }).select('+defaultCardId');
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
  if (!link) return { cards: [], defaultPaymentMethodId: null, provider: 'safepay', environment: config.environment };
  const all = await client.listCards(link.customerId);
  const cards = all.filter(card => card.max_usage === -1 && card.cybersource && /^\d{4}$/.test(card.cybersource.last_four || '')).map(cardPresentation);
  const selected = cards.some(card => card.id === link.defaultCardId && card.usable) ? link.defaultCardId : null;
  return { cards, defaultPaymentMethodId: selected, provider: 'safepay', environment: config.environment };
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
module.exports = { billingContact, ensureCustomer, ownedCustomer, listCards, requireOwnedReusableCard, startCardSetup, setDefaultCard, deleteCard, cardPresentation };
