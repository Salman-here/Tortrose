'use strict';
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Payment = require('../models/SafepayPayment');
const User = require('../models/User');
const { readSafepayConfig } = require('../config/safepay');
const { createSafepayClient, canResetSavedCardAuthentication } = require('./safepayClient');
const { buildReturnUrl } = require('./safepayReturnNavigation');

const AUDIENCE = 'rozare-safepay-saved-card-v1';
const fail = (message, code = 'SAFEPAY_SAVED_CARD_UNAVAILABLE', statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const origin = () => {
  const url = new URL(process.env.PUBLIC_BACKEND_URL || 'https://rozare.up.railway.app');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/') throw fail('Secure payment service is unavailable.');
  return url.origin;
};
const scopedKey = (config, scope) => crypto.createHmac('sha256', config.secretKey).update(`${AUDIENCE}:${config.environment}:${scope}`).digest();

function buildCheckoutContext(payment, surface) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  if (!payment.user || payment.environment !== config.environment || payment.providerEntryMode !== 'tms'
    || !['web', 'mobile'].includes(surface)) throw fail('Saved-card checkout is unavailable.');
  const binding = crypto.randomBytes(24).toString('base64url');
  const data = { paymentId: String(payment._id), environment: payment.environment, surface, binding };
  const ticket = jwt.sign(data,
    scopedKey(config, 'ticket'), { algorithm: 'HS256', subject: String(payment.user), audience: AUDIENCE, expiresIn: '15m' });
  const checkoutSessionGrant = jwt.sign(data, scopedKey(config, 'grant'),
    { algorithm: 'HS256', subject: String(payment.user), audience: `${AUDIENCE}:grant`, expiresIn: '15m' });
  // Fragment is not sent in HTTP access logs, referrers, or server page requests.
  return { checkoutUrl: `${origin()}/api/safepay/saved-checkout/${payment._id}#ticket=${encodeURIComponent(ticket)}`, checkoutSessionGrant };
}
const buildCheckoutUrl = (payment, surface) => buildCheckoutContext(payment, surface).checkoutUrl;

function verifySessionGrant(paymentId, grant) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  try {
    const claims = jwt.verify(grant, scopedKey(config, 'grant'), { algorithms: ['HS256'], audience: `${AUDIENCE}:grant` });
    if (claims.paymentId !== String(paymentId) || claims.environment !== config.environment) throw new Error('binding');
    return claims;
  } catch (_) { throw fail('Open this payment from your signed-in Rozare account.', 'SAFEPAY_CHECKOUT_SESSION_REQUIRED', 401); }
}
async function ownedContext(paymentId, authorization, grant) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  let claims;
  try { claims = jwt.verify(String(authorization || '').replace(/^Bearer /, ''), scopedKey(config, 'ticket'), { algorithms: ['HS256'], audience: AUDIENCE }); }
  catch (_) { throw fail('This payment screen expired. Close it and reopen the same payment in Rozare.', 'SAFEPAY_CHECKOUT_TICKET_EXPIRED', 401); }
  const session = verifySessionGrant(paymentId, grant);
  if (session.binding !== claims.binding || session.sub !== claims.sub || session.surface !== claims.surface) throw fail('This payment screen belongs to another session.', 'SAFEPAY_CHECKOUT_SESSION_REQUIRED', 401);
  if (!mongoose.isValidObjectId(paymentId) || claims.paymentId !== String(paymentId) || claims.environment !== config.environment
    || !mongoose.isValidObjectId(claims.sub) || !['web', 'mobile'].includes(claims.surface)) throw fail('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
  const payment = await Payment.findOne({ _id: paymentId, user: claims.sub, environment: config.environment,
    providerMode: 'payment', providerEntryMode: 'tms' }).select('+cardId +savedCardAuthentication.encryptedContext');
  if (!payment?.cardId) throw fail('Payment not found.', 'PAYMENT_NOT_FOUND', 404);
  if (!await User.exists({ _id: payment.user, status: 'active' })) throw fail('This account cannot start a saved-card payment.', 'SAFEPAY_ACCOUNT_UNAVAILABLE', 403);
  return { config, claims, payment, client: createSafepayClient({ config }) };
}

function sealContext(value, config, paymentId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', scopedKey(config, 'context'), iv);
  cipher.setAAD(Buffer.from(String(paymentId)));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64')).join('.');
}
function unsealContext(value, config, paymentId) {
  try {
    const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', scopedKey(config, 'context'), iv);
    decipher.setAAD(Buffer.from(String(paymentId))); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
  } catch (_) { throw fail('Bank verification is being reconciled. Close this screen and check the same payment.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS'); }
}
function validateBilling(value) {
  const clean = (raw, max) => typeof raw === 'string' && raw.trim().length <= max ? raw.trim() : '';
  const billing = { street_1: clean(value?.street_1, 200), city: clean(value?.city, 100),
    country: clean(value?.country, 2).toUpperCase(), state: clean(value?.state, 100), postal_code: clean(value?.postal_code, 20) };
  if (!billing.street_1 || !billing.city || !require('country-state-city').Country.getCountryByCode(billing.country)) {
    throw fail('Enter your billing street address, city and country.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
  }
  if ((value?.state && !billing.state) || (value?.postal_code && !billing.postal_code)) throw fail('Check your billing state and postal code.', 'SAFEPAY_BILLING_ADDRESS_REQUIRED', 400);
  return billing;
}
async function viewContext(paymentId, authorization, grant) {
  const { payment, config, client, claims } = await ownedContext(paymentId, authorization, grant);
  const { card } = await require('./safepayCustomerService').requireOwnedReusableCard(payment.user, payment.cardId);
  const tracker = await client.getTracker(payment.tracker, payment);
  const user = await User.findById(payment.user).select('savedShippingInfo sellerInfo').lean();
  const order = payment.purpose === 'order' ? await require('../models/Order').findById(payment.order).select('shippingInfo').lean() : null;
  const address = order?.shippingInfo || user?.savedShippingInfo || user?.sellerInfo || {};
  return { paymentId: String(payment._id), amountMinor: payment.amountMinor, currency: payment.currency,
    environment: config.environment, providerState: tracker.state,
    canAuthenticate: payment.status === 'ready' && !payment.localCancelledAt && !payment.appliedAt,
    // An interrupted device-collection page can stall before enrollment too.
    // Explicit retry resets only that uncaptured setup, never the payment.
    canRestartAuthentication: canResetSavedCardAuthentication(tracker) && !!payment.savedCardAuthentication?.encryptedContext,
    returnUrl: buildReturnUrl({ backendOrigin: origin(), attempt: String(payment._id), purpose: payment.purpose, surface: claims.surface, outcome: 'return' }),
    card: { brand: card.cybersource?.scheme === 1 ? 'Visa' : card.cybersource?.scheme === 2 ? 'Mastercard' : 'Card', last4: card.cybersource.last_four },
    billing: { street_1: address.address || '', city: address.city || '', country: address.countryCode || '', state: address.state || '', postal_code: address.postalCode || '' } };
}
async function authenticate(paymentId, authorization, suppliedBilling, grant, { restartAuthentication = false } = {}) {
  let { payment, config, client, claims } = await ownedContext(paymentId, authorization, grant);
  const billing = validateBilling(suppliedBilling);
  await require('./safepayCustomerService').requireOwnedReusableCard(payment.user, payment.cardId);
  payment = await require('./safepayPaymentService').reconcilePayment(payment._id);
  if (payment.appliedAt || payment.status !== 'ready' || payment.localCancelledAt) throw fail('This payment has advanced. Close this screen to verify its current status.', 'SAFEPAY_CHECKOUT_CLOSED');
  payment = await Payment.findById(paymentId).select('+cardId +savedCardAuthentication.encryptedContext');
  if (payment.purpose === 'order' && payment.terms?.settlementPolicy === 'revalidate-on-payment-v1') {
    await mongoose.connection.transaction(session => require('./safepayOrderAvailabilityService').assertOrderAvailable(payment, session));
  }
  if (restartAuthentication) {
    const tracker = await client.getTracker(payment.tracker, payment);
    const prior = payment.savedCardAuthentication;
    if (!prior?.encryptedContext) throw fail('The previous bank setup is still being reconciled. Keep this same payment.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
    const alreadyReset = prior.resetStartedAt && tracker.state === 'TRACKER_STARTED'
      && tracker.next_actions?.CYBERSOURCE?.kind === 'PAYER_AUTH_SETUP' && !tracker.charge;
    if (!alreadyReset) {
      const claim = await Payment.findOneAndUpdate({ _id: payment._id, status: 'ready', appliedAt: null, localCancelledAt: null,
        'savedCardAuthentication.resetStartedAt': null, 'savedCardAuthentication.encryptedContext': prior.encryptedContext },
      { $set: { 'savedCardAuthentication.resetStartedAt': new Date() } }, { new: true });
      if (!claim) throw fail('Bank verification recovery is already being checked. Keep this same payment.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
      try { await client.resetSavedCardAuthentication(payment.tracker, payment); }
      catch (error) {
        if (!error.outcomeUnknown) await Payment.updateOne({ _id: payment._id,
          'savedCardAuthentication.resetStartedAt': claim.savedCardAuthentication.resetStartedAt },
        { $set: { 'savedCardAuthentication.resetStartedAt': null } });
        throw error;
      }
    }
    await Payment.updateOne({ _id: payment._id, status: 'ready', appliedAt: null, localCancelledAt: null },
    { $set: { 'savedCardAuthentication.setupStartedAt': null, 'savedCardAuthentication.encryptedContext': '',
      'savedCardAuthentication.expiresAt': null, 'savedCardAuthentication.resetStartedAt': null } });
    payment = await Payment.findById(payment._id).select('+cardId +savedCardAuthentication.encryptedContext');
  }
  let setup;
  if (payment.savedCardAuthentication?.encryptedContext && payment.savedCardAuthentication.expiresAt > new Date()) {
    setup = unsealContext(payment.savedCardAuthentication.encryptedContext, config, payment._id);
  } else {
    // Setup is not a capture, but claim it once so concurrent screens and lost
    // responses cannot race separate authentication journeys on one tracker.
    const claim = await Payment.findOneAndUpdate({ _id: payment._id, status: 'ready',
      'savedCardAuthentication.setupStartedAt': null },
    { $set: { 'savedCardAuthentication.setupStartedAt': new Date() } }, { new: true }).select('+cardId');
    if (!claim) throw fail('Bank verification is already in progress. Keep this payment and check its status.', 'SAFEPAY_AUTHENTICATION_IN_PROGRESS');
    try { setup = await client.setupSavedCardAuthentication(payment.tracker, payment, payment.cardId); }
    catch (error) {
      if (!error.outcomeUnknown) await Payment.updateOne({ _id: payment._id, status: 'ready',
        'savedCardAuthentication.setupStartedAt': claim.savedCardAuthentication.setupStartedAt },
      { $set: { 'savedCardAuthentication.setupStartedAt': null } });
      throw error;
    }
    await Payment.updateOne({ _id: payment._id, status: 'ready' }, { $set: {
      'savedCardAuthentication.encryptedContext': sealContext(setup, config, payment._id),
      'savedCardAuthentication.expiresAt': new Date(Date.now() + 10 * 60 * 1000),
    } });
  }
  const backendOrigin = origin();
  return { ...setup, authToken: await client.createAuthToken(), tracker: payment.tracker,
    user: payment.customerId, environment: payment.environment, billing,
    returnUrl: buildReturnUrl({ backendOrigin, attempt: String(payment._id), purpose: payment.purpose, surface: claims.surface, outcome: 'return' }) };
}
module.exports = { buildCheckoutUrl, buildCheckoutContext, verifySessionGrant, ownedContext, viewContext, authenticate, validateBilling, sealContext, unsealContext };
