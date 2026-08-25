'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Store = require('../../models/Store');
const User = require('../../models/User');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const {
  changeStoreSlug,
  releaseExpiredStoreSlug,
} = require('../../services/subdomainSlugMutationService');
const {
  recomputeSubdomainEntitlement,
} = require('../../services/stripeEntitlementPaymentService');
const { adminUpdateSubdomain } = require('../../controllers/subdomainController');
const { executeToolCall } = require('../../services/aiActionExecutor');

let mongoServer;

const makeSellerStore = async (overrides = {}) => {
  const token = new mongoose.Types.ObjectId().toString().slice(-8);
  const seller = await User.create({
    username: `slug-owner-${token}`,
    email: `slug-owner-${token}@example.com`,
    role: 'seller',
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: `Slug Owner ${token}`,
    storeSlug: `slug-owner-${token}`,
    isActive: true,
    ...overrides,
  });
  return { seller, store };
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([Store.syncIndexes(), StripeEntitlementPayment.syncIndexes()]);
}, 60000);

afterEach(async () => {
  await Promise.all([
    Store.deleteMany({}),
    User.deleteMany({}),
    StripeEntitlementPayment.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('canonical subdomain slug mutation', () => {
  test('every caller is blocked while a payable Checkout owns the slug', async () => {
    const { seller, store } = await makeSellerStore({
      subdomainResourceLock: {
        kind: 'checkout',
        token: 'live-checkout-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(changeStoreSlug({
      storeId: store._id,
      sellerId: seller._id,
      expectedSlug: store.storeSlug,
      newSlug: 'replacement-hostname',
      actor: { type: 'admin', id: new mongoose.Types.ObjectId() },
    })).rejects.toMatchObject({
      code: 'SUBDOMAIN_RESOURCE_LOCKED',
      statusCode: 423,
    });

    const unchanged = await Store.findById(store._id);
    expect(unchanged.storeSlug).toBe(store.storeSlug);
    expect(unchanged.subdomainResourceLock.token).toBe('live-checkout-token');
    expect(unchanged.subdomainSlugHistory).toHaveLength(0);
  });

  test('admin and AI entry points both honor the canonical Checkout lock', async () => {
    const { seller, store } = await makeSellerStore({
      subdomainResourceLock: {
        kind: 'checkout',
        token: 'entrypoint-checkout-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const adminId = new mongoose.Types.ObjectId();
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    await adminUpdateSubdomain({
      user: { id: adminId.toString(), role: 'admin' },
      params: { storeId: store._id.toString() },
      body: { newSlug: 'admin-cannot-race-checkout' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(423);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SUBDOMAIN_RESOURCE_LOCKED',
    }));

    const aiResult = await executeToolCall('update_store', {
      storeSlug: 'ai-cannot-race-checkout',
    }, { _id: seller._id, role: 'seller' });
    expect(aiResult).toMatchObject({
      success: false,
      code: 'SUBDOMAIN_RESOURCE_LOCKED',
    });

    const unchanged = await Store.findById(store._id);
    expect(unchanged.storeSlug).toBe(store.storeSlug);
    expect(unchanged.subdomainResourceLock.token).toBe('entrypoint-checkout-token');
    expect(unchanged.subdomainSlugHistory).toHaveLength(0);
  });

  test('requires explicit paid-ownership forfeiture and releases the failed change lock', async () => {
    const { seller, store } = await makeSellerStore({
      subdomainPurchase: {
        isPurchased: true,
        purchasedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        stripePaymentId: 'pi_paid_slug_confirmation',
        processedPaymentIds: ['pi_paid_slug_confirmation'],
      },
    });

    await expect(changeStoreSlug({
      storeId: store._id,
      sellerId: seller._id,
      expectedSlug: store.storeSlug,
      newSlug: 'replacement-hostname',
      actor: { type: 'seller', id: seller._id },
    })).rejects.toMatchObject({
      code: 'SUBDOMAIN_PURCHASE_FORFEIT_CONFIRMATION_REQUIRED',
      requiresConfirmation: true,
      currentSubdomain: store.storeSlug,
      newSubdomain: 'replacement-hostname',
    });

    const unchanged = await Store.findById(store._id);
    expect(unchanged.storeSlug).toBe(store.storeSlug);
    expect(unchanged.subdomainPurchase.isPurchased).toBe(true);
    expect(unchanged.subdomainResourceLock.token).toBe('');
  });

  test('binds forfeited payment history to the old slug and audits the actor', async () => {
    const { seller, store } = await makeSellerStore({
      subdomainPurchase: {
        isPurchased: true,
        purchasedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        stripePaymentId: 'pi_paid_old_slug',
        processedPaymentIds: ['pi_paid_old_slug'],
      },
    });
    const oldSlug = store.storeSlug;

    const result = await changeStoreSlug({
      storeId: store._id,
      sellerId: seller._id,
      expectedSlug: oldSlug,
      newSlug: 'replacement-hostname',
      confirmPurchasedForfeit: true,
      actor: {
        type: 'ai',
        id: seller._id,
        reason: 'Explicit seller confirmation in assistant',
      },
    });

    expect(result.forfeitedPurchasedOwnership).toBe(true);
    const [updated, oldLedger] = await Promise.all([
      Store.findById(store._id),
      StripeEntitlementPayment.findOne({ paymentIntentId: 'pi_paid_old_slug' }),
    ]);
    expect(updated).toMatchObject({
      storeSlug: 'replacement-hostname',
      subdomainPurchase: {
        isPurchased: false,
        purchasedAt: null,
        expiresAt: null,
        stripePaymentId: '',
      },
      subdomainResourceLock: { kind: null, token: '', expiresAt: null },
    });
    expect(updated.subdomainPurchase.processedPaymentIds).toContain('pi_paid_old_slug');
    expect(updated.subdomainSlugHistory).toHaveLength(1);
    expect(updated.subdomainSlugHistory[0]).toMatchObject({
      fromSlug: oldSlug,
      toSlug: 'replacement-hostname',
      actorType: 'ai',
      actorId: seller._id,
      reason: 'Explicit seller confirmation in assistant',
      purchasedOwnershipForfeited: true,
    });
    expect(oldLedger).toMatchObject({
      entitlementType: 'subdomain',
      store: store._id,
      resourceKey: oldSlug,
      paymentIntentId: 'pi_paid_old_slug',
    });

    // A later old-payment reversal/recomputation can never re-grant or suspend
    // ownership of the replacement resource.
    oldLedger.refundedMinor = oldLedger.capturedMinor;
    await oldLedger.save();
    await recomputeSubdomainEntitlement(store._id);
    const afterOldReversal = await Store.findById(store._id);
    expect(afterOldReversal.storeSlug).toBe('replacement-hostname');
    expect(afterOldReversal.subdomainPurchase.isPurchased).toBe(false);
    expect(afterOldReversal.subdomainPurchase.expiresAt).toBeNull();
  });

  test('serializes competing slug writes with a compare-and-set', async () => {
    const { seller, store } = await makeSellerStore();
    const attempts = await Promise.allSettled([
      changeStoreSlug({
        storeId: store._id,
        sellerId: seller._id,
        expectedSlug: store.storeSlug,
        newSlug: 'first-competing-hostname',
        actor: { type: 'seller', id: seller._id },
      }),
      changeStoreSlug({
        storeId: store._id,
        sellerId: seller._id,
        expectedSlug: store.storeSlug,
        newSlug: 'second-competing-hostname',
        actor: { type: 'ai', id: seller._id },
      }),
    ]);

    expect(attempts.filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(entry => entry.status === 'rejected')).toHaveLength(1);
    expect(attempts.find(entry => entry.status === 'rejected').reason).toMatchObject({
      code: expect.stringMatching(/^SUBDOMAIN_(RESOURCE_LOCKED|CHANGE_STALE)$/),
    });
    const updated = await Store.findById(store._id);
    expect(['first-competing-hostname', 'second-competing-hostname']).toContain(updated.storeSlug);
    expect(updated.subdomainSlugHistory).toHaveLength(1);
  });

  test('system release re-checks inactivity after locking and does not impose a seller cooldown', async () => {
    const removalScheduledAt = new Date(Date.now() - 60_000);
    const { seller, store } = await makeSellerStore({
      isActive: true,
      subdomainPurchase: { removalScheduledAt },
    });
    const oldSlug = store.storeSlug;

    const staleRelease = await releaseExpiredStoreSlug({
      storeId: store._id,
      sellerId: seller._id,
      expectedSlug: oldSlug,
      now: new Date(),
    });
    expect(staleRelease.released).toBe(false);
    expect((await Store.findById(store._id)).storeSlug).toBe(oldSlug);

    await Store.updateOne({ _id: store._id }, { $set: { isActive: false } });
    const release = await releaseExpiredStoreSlug({
      storeId: store._id,
      sellerId: seller._id,
      expectedSlug: oldSlug,
      now: new Date(),
      releasedPrefix: 'removed',
    });
    expect(release.released).toBe(true);
    const updated = await Store.findById(store._id);
    expect(updated.storeSlug).toMatch(/^removed-/);
    expect(updated.lastSlugChangeAt).toBeNull();
    expect(updated.subdomainPurchase.removalScheduledAt).toBeNull();
    expect(updated.subdomainSlugHistory[0]).toMatchObject({
      fromSlug: oldSlug,
      toSlug: updated.storeSlug,
      actorType: 'system',
    });
  });
});
