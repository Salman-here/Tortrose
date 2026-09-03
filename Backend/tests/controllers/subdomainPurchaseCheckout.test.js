const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/stripe', () => ({
  stripe: {
    checkout: {
      sessions: {
        create: jest.fn(),
        expire: jest.fn(),
      },
    },
  },
}));
jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn() }));

const Store = require('../../models/Store');
const User = require('../../models/User');
const SellerCheckoutClaim = require('../../models/SellerCheckoutClaim');
const { stripe } = require('../../config/stripe');
const {
  getSubdomainOwnership,
  purchaseSubdomain,
} = require('../../controllers/subdomainPurchaseController');

let mongoServer;
const previousFrontendUrl = process.env.FRONTEND_URL;
const previousBackendUrl = process.env.BACKEND_PUBLIC_URL;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

beforeAll(async () => {
  process.env.FRONTEND_URL = 'https://rozare.com';
  process.env.BACKEND_PUBLIC_URL = 'https://rozare.up.railway.app';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(() => {
  stripe.checkout.sessions.create.mockReset();
  stripe.checkout.sessions.expire.mockReset().mockResolvedValue({ status: 'expired' });
});

afterEach(async () => {
  await Promise.all([Store.deleteMany({}), User.deleteMany({}), SellerCheckoutClaim.deleteMany({})]);
  jest.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
  if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = previousFrontendUrl;
  if (previousBackendUrl === undefined) delete process.env.BACKEND_PUBLIC_URL;
  else process.env.BACKEND_PUBLIC_URL = previousBackendUrl;
});

describe('subdomain Stripe Checkout creation', () => {
  test('returns an explicit false ownership flag for an unpurchased subdomain', async () => {
    const seller = await User.create({
      username: 'unowned-subdomain-seller',
      email: 'unowned-subdomain-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Unowned Store',
      storeSlug: 'unowned-store',
    });
    const response = responseMock();

    await getSubdomainOwnership({ user: { id: seller._id.toString() } }, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ownership: expect.objectContaining({
        isPurchased: false,
        isOwned: false,
        daysRemaining: 0,
      }),
    }));
  });

  test('returns an explicit true ownership flag only while the frozen purchase is valid', async () => {
    const seller = await User.create({
      username: 'owned-subdomain-seller',
      email: 'owned-subdomain-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Owned Store',
      storeSlug: 'owned-store',
      subdomainPurchase: {
        isPurchased: true,
        purchasedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      },
    });
    const response = responseMock();

    await getSubdomainOwnership({ user: { id: seller._id.toString() } }, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ownership: expect.objectContaining({
        isPurchased: true,
        isOwned: true,
        daysRemaining: 2,
      }),
    }));
  });

  test('refuses to sell or renew a protected legacy hostname', async () => {
    const seller = await User.create({
      username: 'protected-hostname-seller',
      email: 'protected-hostname-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    await Store.collection.insertOne({
      seller: seller._id,
      storeName: 'Legacy Reserved Store',
      storeSlug: 'rozare-legacy-store',
      isActive: true,
      blockedAt: null,
    });
    const response = responseMock();

    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'web' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'RESERVED_SUBDOMAIN',
    }));
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('binds the paid slug and uses the fixed mobile return bridge', async () => {
    const seller = await User.create({
      username: 'checkout-seller',
      email: 'checkout-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Checkout Store',
      storeSlug: 'checkout-store',
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_subdomain_mobile',
      url: 'https://checkout.stripe.com/example',
    });
    const response = responseMock();

    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'mobile' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    const checkoutConfig = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(checkoutConfig.success_url).toBe(
      'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subdomain&result=success',
    );
    expect(checkoutConfig.cancel_url).toBe(
      'https://rozare.up.railway.app/api/subscription/mobile-return?flow=subdomain&result=cancelled',
    );
    expect(checkoutConfig.metadata).toMatchObject({
      sellerId: seller._id.toString(),
      storeId: store._id.toString(),
      storeSlug: store.storeSlug,
      type: 'subdomain_purchase',
      checkoutClaimToken: expect.any(String),
    });
    expect(checkoutConfig.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 60);
    expect(stripe.checkout.sessions.create.mock.calls[0][1]).toEqual({
      idempotencyKey: expect.stringMatching(/^rozare-subdomain-checkout-/),
    });
    expect(response.json).toHaveBeenCalledWith({
      url: 'https://checkout.stripe.com/example',
      sessionId: 'cs_subdomain_mobile',
      isRenewal: false,
    });
  });

  test('concurrent requests create one payable Stripe session and an identical retry reuses it', async () => {
    const seller = await User.create({
      username: 'concurrent-checkout-seller',
      email: 'concurrent-checkout-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Concurrent Store',
      storeSlug: 'concurrent-store',
    });

    let resolveStripeCheckout;
    stripe.checkout.sessions.create.mockReturnValue(new Promise(resolve => {
      resolveStripeCheckout = resolve;
    }));
    const firstResponse = responseMock();
    const firstRequest = purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'mobile' },
    }, firstResponse);

    while (stripe.checkout.sessions.create.mock.calls.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }

    const parallelResponse = responseMock();
    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'mobile' },
    }, parallelResponse);

    expect(parallelResponse.status).toHaveBeenCalledWith(409);
    expect(parallelResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_PENDING',
    }));
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);

    resolveStripeCheckout({
      id: 'cs_single_subdomain',
      url: 'https://checkout.stripe.com/cs_single_subdomain',
    });
    await firstRequest;

    const retryResponse = responseMock();
    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'mobile' },
    }, retryResponse);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(retryResponse.json).toHaveBeenCalledWith({
      url: 'https://checkout.stripe.com/cs_single_subdomain',
      sessionId: 'cs_single_subdomain',
      isRenewal: false,
      reused: true,
    });
  });

  test('retains and reuses an attached session when local delivery fails and Stripe expiry is ambiguous', async () => {
    const seller = await User.create({
      username: 'failed-expiry-checkout-seller',
      email: 'failed-expiry-checkout-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Failed Expiry Store',
      storeSlug: 'failed-expiry-store',
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_failed_expiry_recoverable',
      url: 'https://checkout.stripe.com/cs_failed_expiry_recoverable',
    });
    stripe.checkout.sessions.expire.mockRejectedValue(Object.assign(
      new Error('expiry response timed out'),
      { type: 'StripeConnectionError', code: 'ETIMEDOUT' },
    ));
    const firstResponse = responseMock();
    firstResponse.json.mockImplementationOnce(() => {
      throw new Error('client connection closed before response delivery');
    });

    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'mobile' },
    }, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(503);
    expect(firstResponse.json).toHaveBeenLastCalledWith(expect.objectContaining({
      code: 'CHECKOUT_RECOVERY_PENDING',
    }));
    const retainedClaim = await SellerCheckoutClaim.findOne({ seller: seller._id }).lean();
    expect(retainedClaim).toMatchObject({
      flow: 'subdomain',
      creationState: 'recoverable',
      sessionId: 'cs_failed_expiry_recoverable',
      sessionUrl: 'https://checkout.stripe.com/cs_failed_expiry_recoverable',
    });
    expect((await Store.findById(store._id)).subdomainResourceLock).toMatchObject({
      kind: 'checkout',
      token: retainedClaim.token,
    });

    const retryResponse = responseMock();
    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'mobile' },
    }, retryResponse);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(retryResponse.json).toHaveBeenCalledWith({
      url: 'https://checkout.stripe.com/cs_failed_expiry_recoverable',
      sessionId: 'cs_failed_expiry_recoverable',
      isRenewal: false,
      reused: true,
    });
  });

  test('returns a retryable lock response without opening Stripe Checkout during a slug change', async () => {
    const seller = await User.create({
      username: 'locked-checkout-seller',
      email: 'locked-checkout-seller@example.com',
      role: 'seller',
      isVerified: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Locked Checkout Store',
      storeSlug: 'locked-checkout-store',
      subdomainResourceLock: {
        kind: 'slug_change',
        token: 'active-slug-change',
        expiresAt: new Date(Date.now() + 60 * 1000),
      },
    });
    const response = responseMock();

    await purchaseSubdomain({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { checkoutClient: 'web' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(423);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SUBDOMAIN_RESOURCE_LOCKED',
    }));
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    await expect(SellerCheckoutClaim.countDocuments({ seller: seller._id })).resolves.toBe(0);
  });
});
