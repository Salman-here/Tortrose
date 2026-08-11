const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../controllers/mailController', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

const Notification = require('../../models/Notification');
const Store = require('../../models/Store');
const User = require('../../models/User');
const { sendEmail } = require('../../controllers/mailController');
const { handleSubdomainPurchaseWebhook } = require('../../controllers/subdomainPurchaseController');

let mongoServer;

const createSeller = (suffix) => User.create({
  username: `subdomain-webhook-${suffix}`,
  email: `subdomain-webhook-${suffix}@example.com`,
  role: 'seller',
  isVerified: true,
});

const createStore = (seller, suffix, subdomainPurchase = {}) => Store.create({
  seller: seller._id,
  storeName: `Webhook Store ${suffix}`,
  storeSlug: `webhook-store-${suffix}`,
  subdomainPurchase,
});

const checkoutSession = ({ sellerId, storeId, storeSlug, paymentReference, renewal = true }) => ({
  id: `cs_${paymentReference}`,
  payment_intent: paymentReference,
  metadata: {
    type: 'subdomain_purchase',
    sellerId: sellerId.toString(),
    storeId: storeId.toString(),
    storeSlug,
    isRenewal: renewal ? 'true' : 'false',
  },
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all([Notification.deleteMany({}), Store.deleteMany({}), User.deleteMany({})]);
  jest.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('subdomain purchase webhook', () => {
  test('applies a renewal once when Stripe retries the same completion', async () => {
    const seller = await createSeller('renewal');
    const originalExpiry = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
    const store = await createStore(seller, 'renewal', {
      isPurchased: true,
      purchasedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      expiresAt: originalExpiry,
    });
    const session = checkoutSession({
      sellerId: seller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_subdomain_once',
    });

    await expect(Promise.all([
      handleSubdomainPurchaseWebhook(session),
      handleSubdomainPurchaseWebhook(session),
    ])).resolves.toEqual([true, true]);
    const afterFirst = await Store.findById(store._id);
    await expect(handleSubdomainPurchaseWebhook(session)).resolves.toBe(true);
    const afterRetry = await Store.findById(store._id);

    expect(afterFirst.subdomainPurchase.expiresAt.getTime()).toBe(
      originalExpiry.getTime() + 3 * 365 * 24 * 60 * 60 * 1000,
    );
    expect(afterRetry.subdomainPurchase.expiresAt.getTime()).toBe(afterFirst.subdomainPurchase.expiresAt.getTime());
    expect(afterRetry.subdomainPurchase.processedPaymentIds).toEqual(['pi_subdomain_once']);
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  test('recognizes a legacy latest payment reference without extending it again', async () => {
    const seller = await createSeller('legacy');
    const originalExpiry = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000);
    const store = await createStore(seller, 'legacy', {
      isPurchased: true,
      purchasedAt: new Date(),
      expiresAt: originalExpiry,
      stripePaymentId: 'pi_legacy_retry',
    });

    await expect(handleSubdomainPurchaseWebhook(checkoutSession({
      sellerId: seller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_legacy_retry',
    }))).resolves.toBe(true);

    const unchanged = await Store.findById(store._id);
    expect(unchanged.subdomainPurchase.expiresAt.getTime()).toBe(originalExpiry.getTime());
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(0);
  });

  test('does not mutate a store when webhook seller ownership does not match', async () => {
    const owner = await createSeller('owner');
    const otherSeller = await createSeller('other');
    const originalExpiry = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const store = await createStore(owner, 'ownership', {
      isPurchased: true,
      purchasedAt: new Date(),
      expiresAt: originalExpiry,
    });

    await expect(handleSubdomainPurchaseWebhook(checkoutSession({
      sellerId: otherSeller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_wrong_owner',
    }))).rejects.toMatchObject({ code: 'SUBDOMAIN_CHECKOUT_STORE_MISMATCH' });

    const unchanged = await Store.findById(store._id);
    expect(unchanged.subdomainPurchase.expiresAt.getTime()).toBe(originalExpiry.getTime());
    expect(unchanged.subdomainPurchase.stripePaymentId).toBe('');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('keeps a completed purchase successful if confirmation email delivery fails', async () => {
    const seller = await createSeller('email-failure');
    const store = await createStore(seller, 'email-failure');
    sendEmail.mockRejectedValueOnce(new Error('mail unavailable'));

    await expect(handleSubdomainPurchaseWebhook(checkoutSession({
      sellerId: seller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_email_failure',
      renewal: false,
    }))).resolves.toBe(true);

    const updated = await Store.findById(store._id);
    expect(updated.subdomainPurchase.isPurchased).toBe(true);
    expect(updated.subdomainPurchase.processedPaymentIds).toContain('pi_email_failure');
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(1);
  });

  test('does not apply a stale Checkout after the seller changes subdomains', async () => {
    const seller = await createSeller('stale-slug');
    const store = await createStore(seller, 'stale-slug');
    const staleSession = checkoutSession({
      sellerId: seller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_stale_slug',
      renewal: false,
    });
    store.storeSlug = 'replacement-subdomain';
    await store.save();

    await expect(handleSubdomainPurchaseWebhook(staleSession)).rejects.toMatchObject({
      code: 'SUBDOMAIN_CHECKOUT_STORE_MISMATCH',
    });

    const unchanged = await Store.findById(store._id);
    expect(unchanged.storeSlug).toBe('replacement-subdomain');
    expect(unchanged.subdomainPurchase.isPurchased).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('propagates a transient database failure so Stripe can retry', async () => {
    const seller = await createSeller('db-retry');
    const store = await createStore(seller, 'db-retry');
    const databaseError = new Error('temporary replica-set failure');
    const updateSpy = jest.spyOn(Store, 'findOneAndUpdate').mockRejectedValueOnce(databaseError);

    await expect(handleSubdomainPurchaseWebhook(checkoutSession({
      sellerId: seller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_db_retry',
    }))).rejects.toBe(databaseError);

    updateSpy.mockRestore();
    const unchanged = await Store.findById(store._id);
    expect(unchanged.subdomainPurchase.isPurchased).toBe(false);
  });

  test('returns false only for unrelated Checkout session types', async () => {
    await expect(handleSubdomainPurchaseWebhook({
      metadata: { type: 'subscription' },
    })).resolves.toBe(false);
  });

  test('honors an already-open legacy session without a slug snapshot using seller and store ownership', async () => {
    const seller = await createSeller('legacy-open');
    const store = await createStore(seller, 'legacy-open');
    const session = checkoutSession({
      sellerId: seller._id,
      storeId: store._id,
      storeSlug: store.storeSlug,
      paymentReference: 'pi_legacy_open',
    });
    delete session.metadata.storeSlug;

    await expect(handleSubdomainPurchaseWebhook(session)).resolves.toBe(true);

    const updated = await Store.findById(store._id);
    expect(updated.subdomainPurchase.isPurchased).toBe(true);
    expect(updated.subdomainPurchase.processedPaymentIds).toContain('pi_legacy_open');
  });
});
