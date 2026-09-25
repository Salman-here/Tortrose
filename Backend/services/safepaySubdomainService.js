'use strict';
const Store = require('../models/Store');
const User = require('../models/User');
const Payment = require('../models/SafepayPayment');
const Grant = require('../models/SafepaySubdomainGrant');
const Claim = require('../models/SellerCheckoutClaim');
const payments = require('./safepayPaymentService');
const { readSafepayConfig } = require('../config/safepay');
const { isProtectedStoreSlug } = require('../utils/storeSlug');
const { addUtcCalendarYears } = require('./utcCalendarService');
const { claimSellerCheckout, releaseSellerCheckoutClaim } = require('./sellerCheckoutClaimService');
const { acquireSubdomainCheckoutLock, releaseSubdomainResourceLock } = require('./subdomainResourceLockService');
const { ensureSubdomainLegacyLedger, loadSubdomainGrants, aggregateSubdomainPayments, recomputeSubdomainEntitlement, SUBDOMAIN_PRICE_MINOR } = require('./stripeEntitlementPaymentService');
const { enqueueNotificationEvent } = require('./notificationOutboxService');
const { snapshotMinorMoney } = require('./notificationMoneySnapshotService');
const id = value => String(value?._id || value || '');
const fail = (message, code, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

async function startPurchase(sellerId, body) {
  const config = readSafepayConfig(process.env, { requireWebhook: true });
  if (typeof body.requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,160}$/.test(body.requestKey)) throw fail('A payment attempt key is required.', 'INVALID_IDEMPOTENCY_KEY', 400);
  const user = await User.findOne({ _id: sellerId, role: 'seller', status: 'active' }).select('_id');
  if (!user) throw fail('An active seller account is required.', 'SELLER_REQUIRED', 403);
  await Promise.all([Payment.init(), Grant.init()]);
  const previous = await Payment.findOne({ user: sellerId, environment: config.environment, purpose: 'subdomain', requestKey: body.requestKey });
  if (previous) {
    if (body.storeSlug !== previous.terms.storeSlug) throw fail('This attempt belongs to a different subdomain.', 'IDEMPOTENCY_CONFLICT');
    if (['cancelled', 'failed', 'refunded', 'manual_review'].includes(previous.status)) return payments.paymentResponse(previous);
    return payments.prepareCheckout(previous._id);
  }
  const store = await Store.findOne({ seller: sellerId, storeSlug: body.storeSlug });
  if (!store) throw fail('Refresh the current store subdomain before paying.', 'SUBDOMAIN_CHECKOUT_STORE_MISMATCH');
  if (isProtectedStoreSlug(store.storeSlug)) throw fail('This subdomain is reserved.', 'RESERVED_SUBDOMAIN', 400);
  if (store.subdomainPurchase?.paymentRiskState === 'open') throw fail('Resolve the payment review before renewing this subdomain.', 'SUBDOMAIN_PAYMENT_RISK_OPEN', 423);
  const open = await Payment.findOne({ store: store._id, purpose: 'subdomain',
    status: { $nin: ['paid', 'cancelled', 'failed', 'refunded'] } });
  if (open) throw fail('An earlier subdomain payment is still being checked. Resume that checkout before creating another.', 'CHECKOUT_PENDING');
  const fingerprint = payments.fingerprint({ store: id(store), slug: store.storeSlug, requestKey: body.requestKey, provider: 'safepay' });
  const claim = await claimSellerCheckout({ sellerId, flow: 'subdomain', provider: 'safepay', requestFingerprint: fingerprint });
  if (!claim.acquired) throw fail('A subdomain checkout is already being prepared.', 'CHECKOUT_PENDING');
  let saved = null, locked = null;
  try {
    locked = await acquireSubdomainCheckoutLock({ storeId: store._id, sellerId, storeSlug: store.storeSlug,
      token: claim.claim.token, checkoutClaimExpiry: claim.claim.expiresAt, provider: 'safepay' });
    if (!locked) throw fail('A checkout or subdomain change is already in progress.', 'SUBDOMAIN_RESOURCE_LOCKED', 423);
    await ensureSubdomainLegacyLedger(locked);
    saved = await payments.ensurePayment({ user: sellerId, purpose: 'subdomain', store: store._id,
      requestKey: body.requestKey, reference: `subdomain:${store._id}:${payments.fingerprint(body.requestKey).slice(0, 24)}`,
      amountMinor: SUBDOMAIN_PRICE_MINOR, currency: 'USD', terms: { storeSlug: store.storeSlug,
        ownershipYears: 3, checkoutClaimToken: claim.claim.token } });
    return await payments.prepareCheckout(saved._id);
  } catch (error) {
    // Before a durable payment exists no provider checkout could have been
    // created. After that point retain the lock until a verified outcome.
    if (!saved) {
      await releaseSellerCheckoutClaim({ sellerId, flow: 'subdomain', token: claim.claim.token });
      if (locked) await releaseSubdomainResourceLock({ storeId: store._id, sellerId, token: claim.claim.token });
    }
    throw error;
  }
}

async function releaseCheckout(payment, session) {
  await Store.updateOne({ _id: payment.store, seller: payment.user, 'subdomainResourceLock.token': payment.terms.checkoutClaimToken },
    { $set: { 'subdomainResourceLock.kind': null, 'subdomainResourceLock.token': '', 'subdomainResourceLock.expiresAt': null } }, { session });
  await Claim.deleteOne({ seller: payment.user, flow: 'subdomain', provider: 'safepay', token: payment.terms.checkoutClaimToken }).session(session);
}

async function settle(payment, tracker, session) {
  const store = await Store.findOne({ _id: payment.store, seller: payment.user, storeSlug: payment.terms.storeSlug }).session(session);
  if (!store || payment.currency !== 'USD' || payment.amountMinor !== SUBDOMAIN_PRICE_MINOR || payment.terms.ownershipYears !== 3) {
    throw fail('The captured payment does not match the frozen ownership purchase.', 'SUBDOMAIN_PAYMENT_MISMATCH');
  }
  let grant = await Grant.findOne({ payment: payment._id }).session(session);
  if (!grant) {
    if (store.subdomainResourceLock?.token !== payment.terms.checkoutClaimToken) throw fail('The paid subdomain lock changed. Review is required.', 'SUBDOMAIN_RESOURCE_LOCKED');
    const before = aggregateSubdomainPayments(await loadSubdomainGrants(store, { session }));
    const now = new Date();
    const start = before.expiresAt && before.expiresAt > now ? before.expiresAt : now;
    const end = addUtcCalendarYears(start, 3);
    [grant] = await Grant.create([{ payment: payment._id, environment: payment.environment,
      sourceKey: `safepay:${payment.environment}:${payment._id}`, seller: payment.user, store: payment.store,
      resourceKey: payment.terms.storeSlug, capturedMinor: payment.amountMinor, grantStart: start, grantEnd: end, effectiveGrantEnd: end }], { session });
  }
  await recomputeSubdomainEntitlement(store._id, { session });
  const title = 'Subdomain ownership payment received';
  const message = `Payment of {{money.paid}} protects ${grant.resourceKey}.rozare.com through ${grant.grantEnd.toISOString().slice(0, 10)}. View current ownership in Seller Dashboard > Subdomain.`;
  await enqueueNotificationEvent({ eventKey: `safepay-subdomain:${payment._id}:received:v1`, eventType: 'subdomain.payment_received',
    aggregateType: 'SafepaySubdomainGrant', aggregateId: grant._id, occurredAt: grant.createdAt, financial: true,
    recipient: { kind: 'user', audienceRole: 'seller', user: payment.user, destinationPolicy: 'current_user', allowBlocked: true },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: { inapp: { title, body: message }, push: { title, body: message }, email: { subject: title, text: message }, whatsapp: { message } },
    money: [snapshotMinorMoney({ key: 'paid', label: 'Subdomain ownership payment', amountMinor: payment.amountMinor, currency: 'USD',
      sourceModel: 'SafepaySubdomainGrant', sourceDocumentId: grant._id, sourcePath: 'capturedMinor' })],
    metadata: { category: 'payment', channelId: 'seller', whatsappCategory: 'subdomain_payment', linkTo: '/seller-dashboard/subdomain',
      data: { type: 'subdomain_payment_received', storeId: id(store), paymentId: id(payment) } }, session });
  await releaseCheckout(payment, session);
}

async function hold(payment, tracker, session) {
  const grant = await Grant.findOne({ payment: payment._id }).session(session);
  if (grant) {
    if (['TRACKER_REFUNDED', 'TRACKER_REVERSED', 'TRACKER_VOIDED'].includes(tracker.state)) {
      grant.refundedMinor = grant.capturedMinor; grant.riskSuspended = false;
    } else grant.riskSuspended = true;
    await grant.save({ session });
    await recomputeSubdomainEntitlement(payment.store, { session });
  }
  // Unknown/partial/disputed outcomes keep the slug reserved for support.
  // A full provider-confirmed reversal cannot continue granting ownership.
  if (['TRACKER_REFUNDED', 'TRACKER_REVERSED', 'TRACKER_VOIDED'].includes(tracker.state)) await releaseCheckout(payment, session);
}
module.exports = { startPurchase, settle, hold, releaseCheckout };
