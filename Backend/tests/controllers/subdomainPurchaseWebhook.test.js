const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../controllers/mailController', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));

const Notification = require('../../models/Notification');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Store = require('../../models/Store');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const User = require('../../models/User');
const { sendEmail } = require('../../controllers/mailController');
const { addUtcCalendarYears } = require('../../services/utcCalendarService');
const {
  handleSubdomainPurchaseWebhook,
  processSubdomainRemovals,
} = require('../../controllers/subdomainPurchaseController');

let mongoServer;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  mode: 'payment',
  payment_status: 'paid',
  amount_total: 1500,
  currency: 'usd',
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
  await NotificationOutbox.init();
});

afterEach(async () => {
  await Promise.all([
    Notification.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    StripeEntitlementPayment.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
  ]);
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
      addUtcCalendarYears(originalExpiry, 3).getTime(),
    );
    expect(afterRetry.subdomainPurchase.expiresAt.getTime()).toBe(afterFirst.subdomainPurchase.expiresAt.getTime());
    expect(afterRetry.subdomainPurchase.processedPaymentIds).toEqual(['pi_subdomain_once']);
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    const payment = await StripeEntitlementPayment.findOne({ paymentIntentId: 'pi_subdomain_once' });
    const receipts = await NotificationOutbox.find({
      aggregateId: String(payment._id),
      eventType: 'subdomain.payment_received',
    }).lean();
    expect(receipts).toHaveLength(4);
    expect(receipts.every(row => (
      row.money?.[0]?.amountMinor === 1500
      && row.money?.[0]?.currency === 'USD'
      && row.payload.data?.type === 'subdomain_payment_received'
    ))).toBe(true);
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

  test('outboxes a completed purchase without direct confirmation delivery', async () => {
    const seller = await createSeller('email-failure');
    const store = await createStore(seller, 'email-failure');

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
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    const payment = await StripeEntitlementPayment.findOne({ paymentIntentId: 'pi_email_failure' });
    await expect(NotificationOutbox.countDocuments({
      aggregateId: String(payment._id),
      eventType: 'subdomain.payment_received',
    })).resolves.toBe(4);
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

  test('natural expiry preserves payment identity and schedules removal for an already-blocked store', async () => {
    const seller = await createSeller('natural-expiry');
    const expiredAt = new Date(Date.now() - DAY_MS);
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Webhook Store natural-expiry',
      storeSlug: 'webhook-store-natural-expiry',
      isActive: false,
      blockedAt: new Date(Date.now() - 30 * DAY_MS),
      subdomainPurchase: {
        isPurchased: true,
        purchasedAt: new Date(expiredAt.getTime() - 3 * 365 * DAY_MS),
        expiresAt: expiredAt,
        stripePaymentId: 'pi_natural_expiry',
        processedPaymentIds: ['pi_natural_expiry'],
      },
    });
    const before = Date.now();

    await processSubdomainRemovals();

    const updated = await Store.findById(store._id);
    expect(updated.subdomainPurchase.isPurchased).toBe(false);
    expect(updated.subdomainPurchase.stripePaymentId).toBe('pi_natural_expiry');
    expect(updated.subdomainPurchase.processedPaymentIds).toContain('pi_natural_expiry');
    expect(updated.subdomainPurchase.removalScheduledAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(updated.subdomainPurchase.removalScheduledAt.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);
    await expect(StripeEntitlementPayment.countDocuments({
      store: store._id,
      paymentIntentId: 'pi_natural_expiry',
    })).resolves.toBe(1);
    const notices = await NotificationOutbox.find({
      aggregateId: String(store._id),
      eventType: 'subdomain.ownership_expired',
    }).lean();
    expect(notices).toHaveLength(4);
    expect(new Set(notices.map(row => row.channel))).toEqual(
      new Set(['inapp', 'push', 'email', 'whatsapp']),
    );
    expect(notices.every(row => row.financial === false && row.money.length === 0)).toBe(true);
    expect(notices.find(row => row.channel === 'email').payload.text)
      .toContain('current price and currency are shown before checkout');
    expect(notices.find(row => row.channel === 'email').payload.text).not.toContain('$15');
    expect(updated.subdomainPurchase.expiryNotice.notificationEnqueuedAt).toBeTruthy();
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();

    await processSubdomainRemovals();
    await expect(NotificationOutbox.countDocuments({
      aggregateId: String(store._id),
      eventType: 'subdomain.ownership_expired',
    })).resolves.toBe(4);
  });

  test('never releases a slug while a payable Checkout owns it, then removes it after that lock expires', async () => {
    const seller = await createSeller('removal-checkout-lock');
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Webhook Store removal-checkout-lock',
      storeSlug: 'webhook-store-removal-checkout-lock',
      isActive: false,
      blockedAt: new Date(Date.now() - 10 * DAY_MS),
      subdomainPurchase: {
        isPurchased: false,
        removalScheduledAt: new Date(Date.now() - DAY_MS),
      },
      subdomainResourceLock: {
        kind: 'checkout',
        token: 'checkout-removal-owner',
        expiresAt: new Date(Date.now() + DAY_MS),
      },
    });

    await processSubdomainRemovals();
    let protectedStore = await Store.findById(store._id);
    expect(protectedStore.storeSlug).toBe('webhook-store-removal-checkout-lock');
    expect(protectedStore.subdomainPurchase.removalScheduledAt).not.toBeNull();

    await Store.updateOne({ _id: store._id }, {
      $set: { 'subdomainResourceLock.expiresAt': new Date(Date.now() - 1000) },
    });
    await processSubdomainRemovals();

    protectedStore = await Store.findById(store._id);
    expect(protectedStore.storeSlug).toMatch(/^removed-/);
    expect(protectedStore.subdomainPurchase.removalScheduledAt).toBeNull();
    expect(protectedStore.subdomainPurchase.removalNotice).toMatchObject({
      previousSlug: 'webhook-store-removal-checkout-lock',
    });
    expect(protectedStore.subdomainPurchase.removalNotice.removedAt).toBeTruthy();
    expect(protectedStore.subdomainPurchase.removalNotice.notificationEnqueuedAt).toBeTruthy();
    const notices = await NotificationOutbox.find({
      aggregateId: String(store._id),
      eventType: 'subdomain.removed',
    }).lean();
    expect(notices).toHaveLength(4);
    expect(new Set(notices.map(row => row.channel))).toEqual(
      new Set(['inapp', 'push', 'email', 'whatsapp']),
    );
    await expect(Notification.countDocuments({ user: seller._id })).resolves.toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('repairs an interrupted natural-expiry outbox enqueue on the next cron run', async () => {
    const seller = await createSeller('expiry-outbox-repair');
    const expiredAt = new Date(Date.now() - DAY_MS);
    const store = await createStore(seller, 'expiry-outbox-repair', {
      isPurchased: true,
      purchasedAt: addUtcCalendarYears(expiredAt, -3),
      expiresAt: expiredAt,
      stripePaymentId: 'pi_expiry_outbox_repair',
      processedPaymentIds: ['pi_expiry_outbox_repair'],
    });
    const outboxFailure = jest.spyOn(NotificationOutbox, 'findOneAndUpdate')
      .mockImplementation(() => ({
        select: () => Promise.reject(new Error('temporary outbox outage')),
      }));

    await processSubdomainRemovals();
    outboxFailure.mockRestore();

    let interrupted = await Store.findById(store._id);
    expect(interrupted.subdomainPurchase.isPurchased).toBe(false);
    expect(interrupted.subdomainPurchase.expiryNotice.notificationEnqueuedAt).toBeNull();
    await expect(NotificationOutbox.countDocuments({ aggregateId: String(store._id) })).resolves.toBe(0);

    await processSubdomainRemovals();

    interrupted = await Store.findById(store._id);
    expect(interrupted.subdomainPurchase.expiryNotice.notificationEnqueuedAt).toBeTruthy();
    await expect(NotificationOutbox.countDocuments({
      aggregateId: String(store._id),
      eventType: 'subdomain.ownership_expired',
    })).resolves.toBe(4);
  });

  test('a stale removal schedule can never release an active store slug', async () => {
    const seller = await createSeller('active-removal-guard');
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Webhook Store active-removal-guard',
      storeSlug: 'webhook-store-active-removal-guard',
      isActive: true,
      blockedAt: null,
      subdomainPurchase: {
        isPurchased: false,
        removalScheduledAt: new Date(Date.now() - DAY_MS),
      },
    });

    await processSubdomainRemovals();

    const activeStore = await Store.findById(store._id);
    expect(activeStore.storeSlug).toBe('webhook-store-active-removal-guard');
  });
});
