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
const { purchaseSubdomain } = require('../../controllers/subdomainPurchaseController');

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
});
