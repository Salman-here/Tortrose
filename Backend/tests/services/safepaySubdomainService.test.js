'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Store = require('../../models/Store');
const User = require('../../models/User');
const Payment = require('../../models/SafepayPayment');
const Grant = require('../../models/SafepaySubdomainGrant');
const StripeGrant = require('../../models/StripeEntitlementPayment');
const Outbox = require('../../models/NotificationOutbox');
const Claim = require('../../models/SellerCheckoutClaim');
const { createSafepayPaymentService } = require('../../services/safepayPaymentService');
const { recomputeSubdomainEntitlement, ensureSubdomainLegacyLedger } = require('../../services/stripeEntitlementPaymentService');
const { acquireSubdomainCheckoutLock, acquireSubdomainSlugChangeLock } = require('../../services/subdomainResourceLockService');
let replica, service, store, seller, providerState;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri());
  await Promise.all([Store, User, Payment, Grant, StripeGrant, Outbox, Claim].map(model => model.init()));
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica.stop(); });
beforeEach(async () => {
  for (const model of [Store, User, Payment, Grant, StripeGrant, Outbox, Claim]) await model.deleteMany({});
  seller = await User.create({ username: 'Subdomain Sandbox', email: 'subdomain@example.com', role: 'seller', status: 'active' });
  store = await Store.create({ seller: seller._id, storeName: 'Subdomain Sandbox', storeSlug: 'subdomain-sandbox-store', isActive: false });
  providerState = 'TRACKER_ENDED';
  service = createSafepayPaymentService({ configFor: () => ({ environment: 'sandbox' }),
    clientFor: () => ({ getTracker: async () => ({ state: providerState }) }) });
});
async function attempt(index = 1) {
  const token = `sandbox-lock-${index}`;
  expect(await acquireSubdomainCheckoutLock({ storeId: store._id, sellerId: seller._id, storeSlug: store.storeSlug,
    token, provider: 'safepay' })).toBeTruthy();
  const payment = await service.ensurePayment({ user: seller._id, store: store._id, purpose: 'subdomain',
    amountMinor: 1500, currency: 'USD', requestKey: `subdomain-test-${index}`, reference: `subdomain:test:${index}`,
    terms: { storeSlug: store.storeSlug, ownershipYears: 3, checkoutClaimToken: token } });
  payment.status = 'ready'; payment.tracker = `track_subdomain-sandbox-${index}`; await payment.save();
  return payment;
}

test('verified payment grants exactly three calendar years once and sends one durable receipt', async () => {
  const payment = await attempt();
  await service.reconcilePayment(payment._id);
  const first = await Store.findById(store._id);
  await service.reconcilePayment(payment._id);
  expect(first.subdomainPurchase.isPurchased).toBe(true);
  expect(first.subdomainPurchase.expiresAt.getUTCFullYear() - first.subdomainPurchase.purchasedAt.getUTCFullYear()).toBe(3);
  expect(first.subdomainPurchase.stripePaymentId).toBe('');
  expect(first.subdomainPurchase.processedPaymentIds).toHaveLength(0);
  expect(await Grant.countDocuments()).toBe(1);
  expect(await Outbox.countDocuments()).toBe(4); // One receipt per channel, not per replay.
  expect(first.isActive).toBe(false); // Ownership is not a paid store subscription.
  expect((await Store.findById(store._id)).subdomainPurchase.expiresAt).toEqual(first.subdomainPurchase.expiresAt);
});

test('shared website/cron recomputation neither drops Safepay ownership nor creates an irreversible legacy grant', async () => {
  const payment = await attempt(); await service.reconcilePayment(payment._id);
  const first = await Store.findById(store._id);
  await ensureSubdomainLegacyLedger(first);
  const second = await recomputeSubdomainEntitlement(store._id);
  expect(await StripeGrant.countDocuments()).toBe(0);
  expect(second.subdomainPurchase.expiresAt).toEqual(first.subdomainPurchase.expiresAt);
});

test('renewal extends existing Stripe ownership rather than overlapping it', async () => {
  const start = new Date(); const end = new Date(start); end.setUTCFullYear(end.getUTCFullYear() + 3);
  await StripeGrant.create({ entitlementType: 'subdomain', sourceKey: 'subdomain:pi_existing', seller: seller._id, store: store._id,
    resourceKey: store.storeSlug, paymentIntentId: 'pi_existing', capturedMinor: 1500, currency: 'usd',
    grantStart: start, grantEnd: end, effectiveGrantEnd: end, completionState: 'confirmed' });
  const payment = await attempt(); await service.reconcilePayment(payment._id);
  const grant = await Grant.findOne(); expect(grant.grantStart).toEqual(end);
  expect(grant.grantEnd.getUTCFullYear()).toBe(end.getUTCFullYear() + 3);
  const current = await Store.findById(store._id);
  expect(current.subdomainPurchase.processedPaymentIds).toEqual(['pi_existing']);
});

test('an unpaid Safepay checkout keeps the slug locked until provider-confirmed closure', async () => {
  const payment = await attempt(); providerState = 'TRACKER_STARTED';
  await service.reconcilePayment(payment._id);
  expect((await acquireSubdomainSlugChangeLock({ storeId: store._id, sellerId: seller._id, expectedSlug: store.storeSlug })).acquired).toBe(false);
  providerState = 'TRACKER_EXPIRED'; await service.reconcilePayment(payment._id);
  expect((await Store.findById(store._id)).subdomainResourceLock.token).toBe('');
  expect(await Grant.countDocuments()).toBe(0);
});

test('a provider-confirmed full refund revokes only the Safepay contribution', async () => {
  const payment = await attempt(); await service.reconcilePayment(payment._id);
  providerState = 'TRACKER_REFUNDED'; await service.reconcilePayment(payment._id);
  expect((await Grant.findOne()).refundedMinor).toBe(1500);
  expect((await Store.findById(store._id)).subdomainPurchase.isPurchased).toBe(false);
  expect(await Outbox.countDocuments()).toBe(4);
});

test('an ownership identity change cannot grant the replacement slug', async () => {
  const payment = await attempt();
  await Store.updateOne({ _id: store._id }, { $set: { storeSlug: 'different-test-slug' } });
  await expect(service.reconcilePayment(payment._id)).rejects.toMatchObject({ code: 'SUBDOMAIN_PAYMENT_MISMATCH' });
  expect(await Grant.countDocuments()).toBe(0);
});
