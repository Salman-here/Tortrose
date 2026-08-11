const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/stripe', () => ({
  STRIPE_MODE: 'test',
  stripe: {
    checkout: {
      sessions: {
        create: jest.fn(),
        list: jest.fn(),
        expire: jest.fn(),
      },
    },
    subscriptions: {
      list: jest.fn(),
      cancel: jest.fn(),
      create: jest.fn(),
      retrieve: jest.fn(),
    },
    customers: {
      retrieve: jest.fn(),
      update: jest.fn(),
    },
  },
}));
jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('../../services/stripeCustomerService', () => ({
  ensureStripeCustomerForUser: jest.fn(),
}));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
  notifySeller: jest.fn().mockResolvedValue(true),
}));

const { stripe } = require('../../config/stripe');
const { ensureStripeCustomerForUser } = require('../../services/stripeCustomerService');
const SellerSubscription = require('../../models/SellerSubscription');
const SellerCheckoutClaim = require('../../models/SellerCheckoutClaim');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Notification = require('../../models/Notification');
const subdomainPurchaseController = require('../../controllers/subdomainPurchaseController');
const { createCheckout, handleWebhook } = require('../../controllers/subscriptionController');

let mongoServer;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

const waitUntilCalled = async (mockFn) => {
  while (mockFn.mock.calls.length === 0) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

beforeAll(async () => {
  process.env.FRONTEND_URL = 'https://rozare.com';
  process.env.BACKEND_PUBLIC_URL = 'https://rozare.up.railway.app';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await SellerCheckoutClaim.init();
}, 60000);

beforeEach(() => {
  stripe.checkout.sessions.create.mockReset();
  stripe.subscriptions.create.mockReset();
  ensureStripeCustomerForUser.mockResolvedValue({ customer: { id: 'cus_checkout_claim' } });
  stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
  stripe.checkout.sessions.expire.mockResolvedValue({ status: 'expired' });
  stripe.subscriptions.list.mockResolvedValue({ data: [] });
  stripe.subscriptions.cancel.mockResolvedValue({ status: 'canceled' });
  stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_default' } });
  stripe.customers.update.mockResolvedValue({});
});

afterEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await Promise.all([
    SellerSubscription.deleteMany({}),
    SellerCheckoutClaim.deleteMany({}),
    User.deleteMany({}),
    Store.deleteMany({}),
    Notification.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('subscription billing idempotency', () => {
  test('concurrent subscription Checkout requests create one Stripe session and later reuse it', async () => {
    const seller = await User.create({
      username: 'subscription-checkout-seller',
      email: 'subscription-checkout@example.com',
      role: 'seller',
      isVerified: true,
    });
    await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    let resolveStripeCheckout;
    stripe.checkout.sessions.create.mockReturnValue(new Promise(resolve => {
      resolveStripeCheckout = resolve;
    }));
    const request = {
      user: { id: seller._id.toString(), role: 'seller' },
      body: { plan: 'starter', checkoutClient: 'mobile' },
    };
    const firstResponse = responseMock();
    const first = createCheckout(request, firstResponse);
    await waitUntilCalled(stripe.checkout.sessions.create);

    const parallelResponse = responseMock();
    await createCheckout(request, parallelResponse);
    expect(parallelResponse.status).toHaveBeenCalledWith(409);
    expect(parallelResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_PENDING',
    }));
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);

    resolveStripeCheckout({
      id: 'cs_subscription_single',
      url: 'https://checkout.stripe.com/cs_subscription_single',
    });
    await first;

    const [checkoutConfig, requestOptions] = stripe.checkout.sessions.create.mock.calls[0];
    expect(checkoutConfig.metadata.checkoutClaimToken).toEqual(expect.any(String));
    expect(checkoutConfig.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 60);
    expect(requestOptions).toEqual({
      idempotencyKey: expect.stringMatching(/^rozare-subscription-checkout-/),
    });

    const retryResponse = responseMock();
    await createCheckout(request, retryResponse);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(retryResponse.json).toHaveBeenCalledWith({
      url: 'https://checkout.stripe.com/cs_subscription_single',
      sessionId: 'cs_subscription_single',
      founderOfferReserved: false,
      reused: true,
    });
  });

  test('concurrent deleted-subscription deliveries create one Starter subscription', async () => {
    const seller = await User.create({
      username: 'downgrade-seller',
      email: 'downgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const original = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade',
      stripeSubscriptionId: 'sub_elite_ended',
      pendingDowngrade: { toPlan: 'starter', scheduledAt: new Date() },
    });
    let resolveStarterSubscription;
    stripe.subscriptions.create.mockReturnValue(new Promise(resolve => {
      resolveStarterSubscription = resolve;
    }));
    const event = {
      id: 'evt_subscription_deleted_once',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_elite_ended' } },
    };

    const first = handleWebhook(event);
    await waitUntilCalled(stripe.subscriptions.create);
    await expect(handleWebhook(event)).rejects.toMatchObject({
      code: 'DOWNGRADE_TRANSITION_IN_PROGRESS',
    });
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);

    resolveStarterSubscription({ id: 'sub_starter_single' });
    await first;

    const [, requestOptions] = stripe.subscriptions.create.mock.calls[0];
    expect(requestOptions).toEqual({
      idempotencyKey: `rozare-downgrade-${original._id}-sub_elite_ended`,
    });
    const updated = await SellerSubscription.findById(original._id);
    expect(updated).toMatchObject({
      status: 'active',
      plan: 'starter',
      stripeSubscriptionId: 'sub_starter_single',
    });
    expect(updated.pendingDowngrade.toPlan).toBeNull();

    await expect(handleWebhook(event)).resolves.toBeUndefined();
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
  });

  test('propagates subdomain processing failures to the Stripe webhook route', async () => {
    const processingError = new Error('temporary database outage');
    jest.spyOn(subdomainPurchaseController, 'handleSubdomainPurchaseWebhook')
      .mockRejectedValueOnce(processingError);

    await expect(handleWebhook({
      id: 'evt_subdomain_failure',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_subdomain_failure',
          mode: 'payment',
          metadata: {
            type: 'subdomain_purchase',
            sellerId: new mongoose.Types.ObjectId().toString(),
          },
        },
      },
    })).rejects.toBe(processingError);
  });
});
