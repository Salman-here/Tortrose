const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

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
      update: jest.fn(),
    },
    products: { create: jest.fn(), retrieve: jest.fn() },
    prices: { create: jest.fn(), retrieve: jest.fn() },
    invoices: { retrieve: jest.fn(), listLineItems: jest.fn(), voidInvoice: jest.fn() },
    invoicePayments: { list: jest.fn() },
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
const { sendEmail } = require('../../controllers/mailController');
const { notifySeller } = require('../../services/whatsapp/sellerNotificationService');
const { ensureStripeCustomerForUser } = require('../../services/stripeCustomerService');
const SellerSubscription = require('../../models/SellerSubscription');
const SellerCheckoutClaim = require('../../models/SellerCheckoutClaim');
const StripeEntitlementPayment = require('../../models/StripeEntitlementPayment');
const StripeSubscriptionCleanup = require('../../models/StripeSubscriptionCleanup');
const User = require('../../models/User');
const Store = require('../../models/Store');
const Notification = require('../../models/Notification');
const NotificationOutbox = require('../../models/NotificationOutbox');
const ExpoPushTokenRegistration = require('../../models/ExpoPushTokenRegistration');
const subdomainPurchaseController = require('../../controllers/subdomainPurchaseController');
const { buildPlanPricing } = require('../../services/subscriptionPricingService');
const { addUtcCalendarMonths } = require('../../services/utcCalendarService');
const { hashPushToken } = require('../../utils/expoPush');
const {
  createCheckout,
  getSubscriptionStatus,
  handleWebhook,
  upgradeToElite,
  cancelSubscription,
  downgradeToStarter,
  processTrialExpirations,
} = require('../../controllers/subscriptionController');

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

const stripeSubscriptionWithPrice = ({
  subscriptionId,
  customerId,
  unitAmount,
  subscriptionItemId = 'si_subscription_plan',
  priceId = `price_${subscriptionId}_${unitAmount}`,
  planChangeToken = null,
  productId = `prod_${planChangeToken || 'current'}`,
  invoiceId = `in_${subscriptionId}_${unitAmount}`,
  includeMetaAds = false,
  status = 'active',
  invoiceStatus = 'paid',
  amountPaid = null,
  lineAmount = null,
  pendingUpdate = null,
  confirmationSecret = null,
  paymentIntentStatus = invoiceStatus === 'paid' ? 'succeeded' : null,
  currentPeriodStart = null,
  currentPeriodEnd = null,
  startDate = null,
  trialStart = null,
  trialEnd = null,
}) => {
  const periodStart = currentPeriodStart ?? (Math.floor(Date.now() / 1000) - 60);
  const periodEnd = currentPeriodEnd ?? (periodStart + (30 * 24 * 60 * 60));
  const authoritativeTrialEnd = trialEnd ?? (status === 'trialing' ? periodEnd : null);
  const authoritativeTrialStart = trialStart
    ?? (authoritativeTrialEnd ? authoritativeTrialEnd - (30 * 24 * 60 * 60) : null);
  const subscriptionStart = startDate ?? authoritativeTrialStart ?? periodStart;
  const settledAmount = invoiceStatus === 'paid' ? (amountPaid ?? unitAmount) : 0;
  const settledLineAmount = lineAmount ?? unitAmount;
  return ({
  id: subscriptionId,
  customer: customerId,
  status,
  start_date: subscriptionStart,
  collection_method: 'charge_automatically',
  pause_collection: null,
  pending_update: pendingUpdate,
  cancel_at_period_end: false,
  trial_start: authoritativeTrialStart,
  trial_end: authoritativeTrialEnd,
  discounts: [],
  metadata: planChangeToken ? {
    planChangeToken,
    plan: 'elite',
    includeMetaAds: String(includeMetaAds),
  } : {},
  items: {
    has_more: false,
    data: [{
      id: subscriptionItemId,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      quantity: 1,
      discounts: [],
      price: {
        id: priceId,
        product: { id: productId },
        currency: 'usd',
        unit_amount: unitAmount,
        recurring: { interval: 'month' },
        active: true,
      },
    }],
  },
  latest_invoice: {
    id: invoiceId,
    customer: customerId,
    subscription: subscriptionId,
    status: invoiceStatus,
    currency: 'usd',
    billing_reason: 'subscription_update',
    amount_paid: settledAmount,
    amount_remaining: invoiceStatus === 'paid' ? 0 : unitAmount,
    period_start: periodStart,
    period_end: periodEnd,
    confirmation_secret: confirmationSecret ? {
      type: 'payment_intent',
      client_secret: confirmationSecret,
    } : null,
    parent: {
      subscription_details: {
        subscription: subscriptionId,
        metadata: planChangeToken ? {
          planChangeToken,
          plan: 'elite',
          includeMetaAds: String(includeMetaAds),
        } : {},
      },
    },
    lines: {
      has_more: false,
      data: [{
        id: `il_${invoiceId}`,
        amount: settledLineAmount,
        currency: 'usd',
        quantity: 1,
        parent: {
          subscription_item_details: {
            subscription: subscriptionId,
            subscription_item: subscriptionItemId,
            proration: true,
          },
        },
        pricing: {
          unit_amount_decimal: String(unitAmount),
          price_details: { price: priceId, product: productId },
        },
        period: { start: periodStart, end: periodEnd },
      }],
    },
    payments: {
      has_more: false,
      data: paymentIntentStatus ? [{
        id: `inpay_${invoiceId}`,
        invoice: invoiceId,
        status: 'paid',
        amount_paid: settledAmount,
        currency: 'usd',
        created: periodStart,
        status_transitions: { paid_at: periodStart },
        payment: {
          type: 'payment_intent',
          payment_intent: {
            id: `pi_${invoiceId}`,
            status: paymentIntentStatus,
            client_secret: confirmationSecret,
            created: periodStart,
          },
        },
      }] : [],
    },
  },
  });
};

const recurringInvoiceFor = ({ subscription, seller, invoiceId, paid }) => {
  const amount = buildPlanPricing('starter').unitAmount;
  const invoice = stripeSubscriptionWithPrice({
    subscriptionId: subscription.stripeSubscriptionId,
    customerId: subscription.stripeCustomerId,
    subscriptionItemId: 'si_subscription_plan',
    unitAmount: amount,
    priceId: subscription.stripePriceId,
    productId: subscription.stripeProductId,
    invoiceId,
    invoiceStatus: paid ? 'paid' : 'open',
    paymentIntentStatus: paid ? 'succeeded' : null,
  }).latest_invoice;
  invoice.billing_reason = 'subscription_cycle';
  invoice.parent.subscription_details.metadata = { sellerId: seller._id.toString() };
  invoice.lines.data[0].parent.type = 'subscription_item_details';
  if (!paid) {
    invoice.status = 'open';
    invoice.amount_paid = 0;
    invoice.amount_remaining = amount;
    invoice.payments = { has_more: false, data: [] };
  }
  return invoice;
};

const paymentNotificationFixture = async suffix => {
  const seller = await User.create({
    username: `payment-notification-${suffix}`,
    email: `payment-notification-${suffix}@example.com`,
    role: 'seller',
    isVerified: true,
  });
  const subscription = await SellerSubscription.create({
    seller: seller._id,
    status: 'active',
    plan: 'starter',
    planName: 'Rozare Starter',
    stripeCustomerId: `cus_payment_notification_${suffix}`,
    stripeSubscriptionId: `sub_payment_notification_${suffix}`,
    stripeProductId: `prod_payment_notification_${suffix}`,
    stripePriceId: `price_payment_notification_${suffix}`,
    hasUsedFreePeriod: true,
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: `Payment Notification ${suffix}`,
    storeSlug: `merchant-notification-${suffix}`,
    isActive: true,
  });
  const invoiceId = `in_payment_notification_${suffix}`;
  return {
    seller,
    subscription,
    store,
    invoiceId,
    failedInvoice: recurringInvoiceFor({ subscription, seller, invoiceId, paid: false }),
    paidInvoice: recurringInvoiceFor({ subscription, seller, invoiceId, paid: true }),
  };
};

const mockPaidPlanChangeUpdate = ({
  customerId,
  invoiceStatus = 'paid',
  pending = false,
  confirmationSecret = null,
  paymentIntentStatus = invoiceStatus === 'paid' ? 'succeeded' : null,
  status = 'active',
} = {}) => {
  stripe.subscriptions.update.mockImplementation(async (subscriptionId, params) => {
    const priceId = params.items[0].price;
    const priceParams = stripe.prices.create.mock.calls
      .map(call => call[0])
      .find(candidate => `price_${candidate.metadata.planChangeToken}` === priceId)
      || stripe.prices.create.mock.calls.at(-1)?.[0];
    const unitAmount = priceParams?.unit_amount;
    const planChangeToken = priceParams?.metadata?.planChangeToken;
    const productId = priceParams?.product;
    return stripeSubscriptionWithPrice({
      subscriptionId,
      customerId,
      unitAmount,
      priceId,
      productId,
      planChangeToken,
      includeMetaAds: priceParams?.metadata?.includeMetaAds === 'true',
      invoiceStatus,
      status,
      confirmationSecret,
      paymentIntentStatus,
      pendingUpdate: pending ? {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{ id: params.items[0].id, price: priceId, quantity: 1, discounts: [] }],
      } : null,
    });
  });
};

beforeAll(async () => {
  process.env.FRONTEND_URL = 'https://rozare.com';
  process.env.BACKEND_PUBLIC_URL = 'https://rozare.up.railway.app';
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await SellerCheckoutClaim.init();
  await StripeEntitlementPayment.init();
  await NotificationOutbox.init();
}, 60000);

beforeEach(() => {
  stripe.checkout.sessions.create.mockReset();
  stripe.subscriptions.create.mockReset();
  stripe.subscriptions.retrieve.mockReset().mockImplementation(async subscriptionId => {
    for (let index = stripe.subscriptions.create.mock.results.length - 1; index >= 0; index -= 1) {
      const created = await Promise.resolve(stripe.subscriptions.create.mock.results[index]?.value);
      if (created?.id !== subscriptionId) continue;
      const params = stripe.subscriptions.create.mock.calls[index]?.[0];
      return stripeSubscriptionWithPrice({
        subscriptionId,
        customerId: params.customer,
        unitAmount: params.items[0].price_data.unit_amount,
        status: created.status,
        invoiceStatus: created.status === 'active' ? 'paid' : 'open',
      });
    }
    const local = await SellerSubscription.findOne({ stripeSubscriptionId: subscriptionId }).lean();
    if (!local) return null;
    return stripeSubscriptionWithPrice({
      subscriptionId,
      customerId: local.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
      status: 'trialing',
      invoiceStatus: 'open',
    });
  });
  stripe.subscriptions.update.mockReset();
  stripe.products.create.mockReset().mockImplementation(async params => ({
    id: `prod_${params.metadata.planChangeToken}`,
    active: true,
    ...params,
  }));
  stripe.products.retrieve.mockReset().mockImplementation(async productId => {
    const params = stripe.products.create.mock.calls
      .map(call => call[0])
      .find(candidate => `prod_${candidate.metadata.planChangeToken}` === productId);
    return params ? { id: productId, active: true, ...params } : null;
  });
  stripe.prices.create.mockReset().mockImplementation(async params => ({
    id: `price_${params.metadata.planChangeToken}`,
    active: true,
    ...params,
  }));
  stripe.prices.retrieve.mockReset().mockImplementation(async priceId => {
    const params = stripe.prices.create.mock.calls
      .map(call => call[0])
      .find(candidate => `price_${candidate.metadata.planChangeToken}` === priceId);
    return params ? { id: priceId, active: true, ...params } : null;
  });
  stripe.invoices.retrieve.mockReset();
  stripe.invoices.listLineItems.mockReset().mockResolvedValue({ data: [], has_more: false });
  stripe.invoices.voidInvoice.mockReset().mockResolvedValue({ status: 'void' });
  stripe.invoicePayments.list.mockReset().mockResolvedValue({ data: [], has_more: false });
  ensureStripeCustomerForUser.mockResolvedValue({ customer: { id: 'cus_checkout_claim' } });
  stripe.checkout.sessions.list.mockResolvedValue({ data: [] });
  stripe.checkout.sessions.expire.mockResolvedValue({ status: 'expired' });
  stripe.subscriptions.list.mockResolvedValue({ data: [] });
  stripe.subscriptions.cancel.mockImplementation(async subscriptionId => ({
    id: subscriptionId,
    status: 'canceled',
  }));
  stripe.customers.retrieve.mockResolvedValue({ invoice_settings: { default_payment_method: 'pm_default' } });
  stripe.customers.update.mockResolvedValue({});
});

afterEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await Promise.all([
    SellerSubscription.deleteMany({}),
    SellerCheckoutClaim.deleteMany({}),
    StripeEntitlementPayment.deleteMany({}),
    StripeSubscriptionCleanup.deleteMany({}),
    User.deleteMany({}),
    Store.deleteMany({}),
    Notification.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    ExpoPushTokenRegistration.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('subscription billing idempotency', () => {
  test('checkout rejects string Meta ads booleans before any billable Stripe work', async () => {
    const response = responseMock();

    await createCheckout({
      user: { id: new mongoose.Types.ObjectId().toString(), role: 'seller' },
      body: { plan: 'starter', includeMetaAds: 'false', checkoutClient: 'web' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      msg: 'Meta ads selection must be a boolean.',
      code: 'INVALID_META_ADS_SELECTION',
    });
    expect(stripe.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

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

  test('precheckout cancellation uncertainty blocks a second billable Checkout, escalates durably, and resumes after confirmed recovery', async () => {
    const seller = await User.create({
      username: 'subscription-preflight-cleanup',
      email: 'subscription-preflight-cleanup@example.com',
      role: 'seller',
      status: 'active',
      isVerified: true,
    });
    const admin = await User.create({
      username: 'subscription-preflight-cleanup-admin',
      email: 'subscription-preflight-cleanup-admin@example.com',
      role: 'admin',
      status: 'active',
      isVerified: true,
    });
    await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_preflight_cleanup',
      trialEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    ensureStripeCustomerForUser.mockResolvedValue({ customer: { id: 'cus_preflight_cleanup' } });
    const staleSubscription = {
      id: 'sub_preflight_cleanup_stale',
      customer: 'cus_preflight_cleanup',
      status: 'active',
      metadata: {},
    };
    stripe.subscriptions.list.mockImplementation(async params => ({
      data: params.status === 'active' ? [staleSubscription] : [],
      has_more: false,
    }));
    stripe.subscriptions.cancel
      .mockRejectedValueOnce(Object.assign(
        new Error('Connection ended after cancellation may have reached Stripe.'),
        { type: 'StripeConnectionError', code: 'ECONNRESET' },
      ))
      .mockResolvedValue({
        id: staleSubscription.id,
        customer: 'cus_preflight_cleanup',
        status: 'canceled',
      });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_preflight_cleanup_recovered',
      url: 'https://checkout.stripe.com/cs_preflight_cleanup_recovered',
    });
    const request = {
      user: { id: seller._id.toString(), role: 'seller' },
      body: { plan: 'starter', checkoutClient: 'web' },
    };
    const firstResponse = responseMock();

    await createCheckout(request, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(409);
    expect(firstResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SUBSCRIPTION_STALE_CLEANUP_PENDING',
    }));
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    let cleanup = await StripeSubscriptionCleanup.findOne({
      staleStripeSubscriptionId: staleSubscription.id,
    });
    expect(cleanup).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastErrorCode: 'ECONNRESET',
      reason: 'precheckout_stale_subscription',
    });
    expect(cleanup.manualReview.requiredAt).toBeInstanceOf(Date);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
      'recipient.user': admin._id,
    })).toBe(4);

    // Make the bounded retry due. The next identical seller request reuses
    // the same cleanup identity and creates Checkout only after Stripe returns
    // a confirmed cancellation response.
    await StripeSubscriptionCleanup.updateOne({ _id: cleanup._id }, {
      $set: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const retryResponse = responseMock();
    await createCheckout(request, retryResponse);

    expect(retryResponse.status).not.toHaveBeenCalled();
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'cs_preflight_cleanup_recovered',
    }));
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    cleanup = await StripeSubscriptionCleanup.findById(cleanup._id);
    expect(cleanup).toMatchObject({ status: 'completed', attempts: 2 });
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_resolved',
      'recipient.user': admin._id,
    })).toBe(4);
  });

  test.each([
    ['Checkout sessions', () => {
      stripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: true });
    }],
    ['active subscriptions', () => {
      stripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: false });
      stripe.subscriptions.list.mockImplementation(async params => (
        params.status === 'active'
          ? { data: [], has_more: true }
          : { data: [], has_more: false }
      ));
    }],
  ])('fails closed when Stripe returns an incomplete %s preflight list', async (_label, arrange) => {
    const suffix = _label.toLowerCase().replace(/\s+/g, '-');
    const seller = await User.create({
      username: `preflight-incomplete-${suffix}`,
      email: `preflight-incomplete-${suffix}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    arrange();
    const response = responseMock();

    await createCheckout({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { plan: 'starter', checkoutClient: 'web' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SUBSCRIPTION_STRIPE_PREFLIGHT_INCOMPLETE',
    }));
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(await SellerCheckoutClaim.countDocuments({ seller: seller._id })).toBe(0);
  });

  test('fails closed when an earlier open subscription Checkout cannot be expired', async () => {
    const seller = await User.create({
      username: 'preflight-expire-failure',
      email: 'preflight-expire-failure@example.com',
      role: 'seller',
      isVerified: true,
    });
    await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    stripe.checkout.sessions.list.mockResolvedValue({
      data: [{
        id: 'cs_preflight_unexpired',
        status: 'open',
        mode: 'subscription',
        metadata: {},
      }],
      has_more: false,
    });
    stripe.checkout.sessions.expire.mockRejectedValue(Object.assign(
      new Error('Stripe Checkout expiration is temporarily unavailable.'),
      { code: 'ECONNRESET' },
    ));
    const response = responseMock();

    await createCheckout({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { plan: 'starter', checkoutClient: 'web' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ECONNRESET' }));
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(await SellerCheckoutClaim.countDocuments({ seller: seller._id })).toBe(0);
  });

  test('recovers an ambiguous timeout with the same durable claim and Stripe idempotency key', async () => {
    const seller = await User.create({
      username: 'subscription-timeout-recovery',
      email: 'subscription-timeout-recovery@example.com',
      role: 'seller',
      isVerified: true,
    });
    await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    stripe.checkout.sessions.create
      .mockRejectedValueOnce(Object.assign(new Error('socket timed out after request write'), {
        type: 'StripeConnectionError',
        code: 'ECONNRESET',
      }))
      .mockResolvedValueOnce({
        id: 'cs_subscription_timeout_recovered',
        url: 'https://checkout.stripe.com/cs_subscription_timeout_recovered',
      });
    const remotelyCreatedSubscription = {
      id: 'sub_created_before_timeout_response',
      metadata: {},
    };
    stripe.subscriptions.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockImplementation(async () => ({ data: [remotelyCreatedSubscription] }));
    const request = {
      user: { id: seller._id.toString(), role: 'seller' },
      body: { plan: 'starter', checkoutClient: 'mobile' },
    };
    const firstResponse = responseMock();

    await createCheckout(request, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(503);
    expect(firstResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_RECOVERY_PENDING',
    }));
    const retainedClaim = await SellerCheckoutClaim.findOne({
      seller: seller._id,
      flow: 'subscription',
    }).lean();
    remotelyCreatedSubscription.metadata.checkoutClaimToken = retainedClaim.token;
    expect(retainedClaim).toMatchObject({
      creationState: 'recoverable',
      sessionId: '',
      sessionUrl: '',
    });
    const firstIdempotencyKey = stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey;

    const retryResponse = responseMock();
    await createCheckout(request, retryResponse);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalledWith(
      remotelyCreatedSubscription.id,
    );
    expect(stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey).toBe(firstIdempotencyKey);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'cs_subscription_timeout_recovered',
    }));
    await expect(SellerCheckoutClaim.findOne({ seller: seller._id }).lean()).resolves.toMatchObject({
      token: retainedClaim.token,
      creationState: 'attached',
      sessionId: 'cs_subscription_timeout_recovered',
    });
  });

  test('terminal payment loss can start a fresh Checkout without reactivating the store first', async () => {
    const seller = await User.create({
      username: 'terminal-loss-checkout',
      email: 'terminal-loss-checkout@example.com',
      role: 'seller',
      isVerified: true,
    });
    await SellerSubscription.create({
      seller: seller._id,
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_terminal_loss_checkout',
      stripeSubscriptionId: 'sub_terminal_loss_old',
      hasUsedFreePeriod: true,
      blockedAt: new Date(),
      blockedReason: 'Stripe payment reversal removed the payment funding the current subscription period.',
      paymentRisk: {
        suspended: false,
        reason: '',
        previousStatus: null,
      },
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Terminal Loss Store',
      storeSlug: 'terminal-loss-store',
      isActive: false,
      blockedAt: new Date(),
    });
    stripe.checkout.sessions.create.mockResolvedValue({
      id: 'cs_terminal_loss_fresh',
      url: 'https://checkout.stripe.com/cs_terminal_loss_fresh',
    });
    const response = responseMock();

    await createCheckout({
      user: { id: seller._id.toString(), role: 'seller' },
      body: { plan: 'starter', checkoutClient: 'web' },
    }, response);

    expect(response.status).not.toHaveBeenCalledWith(423);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'cs_terminal_loss_fresh',
    }));
    expect((await Store.findById(store._id)).isActive).toBe(false);
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

    resolveStarterSubscription({ id: 'sub_starter_single', status: 'active' });
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
    expect(updated.activationNotification).toMatchObject({
      kind: 'automatic_downgrade',
      sourceReference: 'sub_elite_ended',
      stripeSubscriptionId: 'sub_starter_single',
      recurringAmountMinor: 999,
      currency: 'USD',
      freePeriodDays: 0,
    });
    expect(await NotificationOutbox.countDocuments({
      aggregateId: original._id.toString(),
      eventType: 'subscription.activated',
    })).toBe(4);

    await expect(handleWebhook(event)).resolves.toBeUndefined();
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: original._id.toString(),
      eventType: 'subscription.activated',
    })).toBe(4);
  });

  test('an incomplete automatic downgrade stays past_due and blocks the store until its invoice succeeds', async () => {
    const seller = await User.create({
      username: 'downgrade-incomplete-seller',
      email: 'downgrade-incomplete@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_incomplete',
      stripeSubscriptionId: 'sub_elite_incomplete_ended',
      pendingDowngrade: { toPlan: 'starter', scheduledAt: new Date() },
      paymentRisk: {
        latestFailureInvoiceId: 'in_old_subscription_future_failure',
        latestFailurePeriodStart: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        latestFailureEventCreated: 999,
        latestSuccessfulInvoiceId: 'in_old_subscription_success',
        latestSuccessfulPeriodStart: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        latestSuccessfulEventCreated: 500,
      },
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Downgrade Incomplete Store',
      storeSlug: 'downgrade-incomplete-store',
      isActive: true,
      blockedAt: null,
    });
    stripe.subscriptions.create.mockResolvedValue({
      id: 'sub_starter_incomplete',
      status: 'incomplete',
    });

    await handleWebhook({
      id: 'evt_downgrade_incomplete',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_elite_incomplete_ended' } },
    });

    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(updated.status).toBe('past_due');
    expect(updated.stripeSubscriptionId).toBe('sub_starter_incomplete');
    expect(updated.paymentRisk.suspended).toBe(true);
    expect(updated.paymentRisk.latestFailureInvoiceId).toBe('');
    expect(updated.paymentRisk.latestFailurePeriodStart).toBeNull();
    expect(updated.paymentRisk.latestFailureEventCreated).toBe(0);
    expect(updated.paymentRisk.latestSuccessfulInvoiceId).toBe('');
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.subscriptionPaymentRiskLock.stripeSubscriptionId)
      .toBe('sub_starter_incomplete');
    expect(updated.pendingDowngrade.activationPending).toBe(true);
    expect(updated.bonusFeaturesActive).toBe(false);
    expect(updated.starterBonusPeriodUsed).toBe(false);

    const periodStart = new Date(Date.now() - 1000);
    const periodEnd = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    await handleWebhook({
      id: 'evt_downgrade_invoice_paid',
      created: 200,
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_downgrade_invoice_paid',
          customer: 'cus_downgrade_incomplete',
          parent: {
            subscription_details: {
              subscription: 'sub_starter_incomplete',
              metadata: { sellerId: seller._id.toString() },
            },
          },
          payment_intent: 'pi_downgrade_invoice_paid',
          charge: 'ch_downgrade_invoice_paid',
          amount_paid: 999,
          amount_remaining: 0,
          currency: 'usd',
          status: 'paid',
          billing_reason: 'subscription_create',
          period_start: Math.floor(periodStart.getTime() / 1000),
          period_end: Math.floor(periodEnd.getTime() / 1000),
          payments: {
            has_more: false,
            data: [{
              id: 'inpay_downgrade_invoice_paid',
              invoice: 'in_downgrade_invoice_paid',
              status: 'paid',
              amount_paid: 999,
              currency: 'usd',
              created: Math.floor(periodStart.getTime() / 1000),
              status_transitions: { paid_at: Math.floor(periodStart.getTime() / 1000) },
              payment: {
                type: 'payment_intent',
                payment_intent: 'pi_downgrade_invoice_paid',
              },
            }],
          },
          lines: {
            data: [{
              id: 'il_downgrade_invoice_paid',
              amount: 999,
              currency: 'usd',
              quantity: 1,
              parent: {
                type: 'subscription_item_details',
                subscription_item_details: {
                  subscription: 'sub_starter_incomplete',
                  subscription_item: 'si_subscription_plan',
                  proration: false,
                },
              },
              pricing: {
                type: 'price_details',
                price_details: {
                  price: updated.stripePriceId,
                  product: updated.stripeProductId,
                },
                unit_amount_decimal: '999',
              },
              period: {
                start: Math.floor(periodStart.getTime() / 1000),
                end: Math.floor(periodEnd.getTime() / 1000),
              },
            }],
          },
        },
      },
    });
    const [recovered, recoveredStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(recovered.status).toBe('active');
    expect(recovered.paymentRisk.suspended).toBe(false);
    expect(recoveredStore.isActive).toBe(true);
    expect(recovered.pendingDowngrade.activationPending).toBe(false);
    expect(recovered.bonusFeaturesActive).toBe(true);
    expect(recovered.starterBonusPeriodUsed).toBe(true);
    expect(recovered.bonusExpiryDate.getTime()).toBeGreaterThan(Date.now() + 179 * 24 * 60 * 60 * 1000);
  });

  test('deleted subscription clears its old payment-risk lock without reactivating the store', async () => {
    const seller = await User.create({
      username: 'deleted-risk-seller',
      email: 'deleted-risk@example.com',
      role: 'seller',
      isVerified: true,
    });
    const lockedAt = new Date(Date.now() - 1000);
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'past_due',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_deleted_risk',
      stripeSubscriptionId: 'sub_deleted_risk',
      paymentRisk: {
        suspended: true,
        reason: 'Stripe payment dispute is under financial review.',
        previousStatus: 'active',
        stripeSubscriptionId: 'sub_deleted_risk',
        updatedAt: lockedAt,
      },
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Deleted Risk Store',
      storeSlug: 'deleted-risk-store',
      isActive: false,
      blockedAt: lockedAt,
      subscriptionPaymentRiskLock: {
        stripeSubscriptionId: 'sub_deleted_risk',
        lockedAt,
      },
    });

    await handleWebhook({
      id: 'evt_deleted_risk',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_deleted_risk' } },
    });

    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(updated.status).toBe('blocked');
    expect(updated.paymentRisk.suspended).toBe(false);
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.subscriptionPaymentRiskLock?.stripeSubscriptionId || '').toBe('');
  });

  test('concurrent and later ordinary-cancellation replays preserve one timeline and one durable alert per channel', async () => {
    const seller = await User.create({
      username: 'cancel-replay-seller',
      email: 'cancel-replay@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_replay',
      stripeSubscriptionId: 'sub_cancel_replay',
      bonusFeaturesActive: true,
      bonusFeaturesExpiredPermanently: false,
      bonusExpiryDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Cancellation Replay Store',
      storeSlug: 'cancellation-replay-store',
      isActive: true,
      blockedAt: null,
    });
    const firstEvent = {
      id: 'evt_cancel_replay_first',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_cancel_replay' } },
    };

    await Promise.all([handleWebhook(firstEvent), handleWebhook(firstEvent)]);
    const first = await SellerSubscription.findById(subscription._id).lean();
    const firstStore = await Store.findById(store._id).lean();
    const firstTimeline = {
      cancelledAt: first.cancellationTransition.cancelledAt.getTime(),
      blockedAt: first.cancellationTransition.blockedAt.getTime(),
      bonusGraceDeadline: first.cancellationTransition.bonusGraceDeadline.getTime(),
      subdomainRemovalScheduledAt: first.cancellationTransition.subdomainRemovalScheduledAt.getTime(),
      storeRemovalScheduledAt: firstStore.subdomainPurchase.removalScheduledAt.getTime(),
    };

    await handleWebhook({ ...firstEvent, id: 'evt_cancel_replay_duplicate' });

    const [replayed, replayedStore, outboxRows] = await Promise.all([
      SellerSubscription.findById(subscription._id).lean(),
      Store.findById(store._id).lean(),
      NotificationOutbox.find({
        aggregateType: 'SellerSubscription',
        aggregateId: subscription._id.toString(),
        eventType: 'subscription.cancelled',
      }).lean(),
    ]);
    expect(replayed.status).toBe('blocked');
    expect(replayed.cancellationTransition.firstEventId).toBe(firstEvent.id);
    expect(replayed.cancellationTransition.completedAt).toBeTruthy();
    expect(replayed.cancellationTransition.notificationEnqueuedAt).toBeTruthy();
    expect({
      cancelledAt: replayed.cancellationTransition.cancelledAt.getTime(),
      blockedAt: replayed.cancellationTransition.blockedAt.getTime(),
      bonusGraceDeadline: replayed.cancellationTransition.bonusGraceDeadline.getTime(),
      subdomainRemovalScheduledAt: replayed.cancellationTransition.subdomainRemovalScheduledAt.getTime(),
      storeRemovalScheduledAt: replayedStore.subdomainPurchase.removalScheduledAt.getTime(),
    }).toEqual(firstTimeline);
    expect(outboxRows).toHaveLength(4);
    expect(new Set(outboxRows.map(row => row.channel))).toEqual(
      new Set(['inapp', 'push', 'email', 'whatsapp'])
    );
  });

  test('ordinary cancellation resumes failed Store projection without extending deadlines', async () => {
    const seller = await User.create({
      username: 'cancel-projection-retry',
      email: 'cancel-projection-retry@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_cancel_projection_retry',
      stripeSubscriptionId: 'sub_cancel_projection_retry',
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Cancellation Projection Retry',
      storeSlug: 'cancellation-projection-retry',
      isActive: true,
    });
    const event = {
      id: 'evt_cancel_projection_first',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_cancel_projection_retry' } },
    };
    jest.spyOn(Store, 'findOneAndUpdate').mockRejectedValueOnce(new Error('temporary cancellation Store failure'));

    await expect(handleWebhook(event)).rejects.toThrow('temporary cancellation Store failure');
    const partial = await SellerSubscription.findById(subscription._id).lean();
    const originalCancelledAt = partial.cancellationTransition.cancelledAt.getTime();
    const originalRemovalAt = partial.cancellationTransition.subdomainRemovalScheduledAt.getTime();
    expect(partial.cancellationTransition.storeAppliedAt).toBeNull();
    expect(await NotificationOutbox.countDocuments({ aggregateId: subscription._id.toString() })).toBe(0);

    await handleWebhook({ ...event, id: 'evt_cancel_projection_retry' });
    const [recovered, recoveredStore] = await Promise.all([
      SellerSubscription.findById(subscription._id).lean(),
      Store.findOne({ seller: seller._id }).lean(),
    ]);
    expect(recovered.cancellationTransition.cancelledAt.getTime()).toBe(originalCancelledAt);
    expect(recovered.cancellationTransition.subdomainRemovalScheduledAt.getTime()).toBe(originalRemovalAt);
    expect(recovered.cancellationTransition.storeAppliedAt).toBeTruthy();
    expect(recovered.cancellationTransition.completedAt).toBeTruthy();
    expect(recoveredStore.isActive).toBe(false);
    expect(recoveredStore.subdomainPurchase.removalScheduledAt.getTime()).toBe(originalRemovalAt);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: subscription._id.toString(),
      eventType: 'subscription.cancelled',
    })).toBe(4);
  });

  test('an old cancellation retry never alerts or re-blocks a newly active subscription', async () => {
    const seller = await User.create({
      username: 'cancel-stale-alert',
      email: 'cancel-stale-alert@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_stale_alert',
      stripeSubscriptionId: 'sub_cancel_stale_old',
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Cancellation Stale Alert',
      storeSlug: 'cancellation-stale-alert',
      isActive: true,
    });
    const event = {
      id: 'evt_cancel_stale_first',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_cancel_stale_old' } },
    };
    const originalOutboxUpsert = NotificationOutbox.findOneAndUpdate.bind(NotificationOutbox);
    jest.spyOn(NotificationOutbox, 'findOneAndUpdate').mockImplementationOnce((...args) => {
      const query = originalOutboxUpsert(...args);
      query.exec = jest.fn().mockRejectedValue(new Error('temporary outbox write failure'));
      return query;
    });

    await expect(handleWebhook(event)).rejects.toThrow('temporary outbox write failure');
    expect(await NotificationOutbox.countDocuments({ aggregateId: subscription._id.toString() })).toBe(0);

    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        status: 'active',
        stripeSubscriptionId: 'sub_cancel_stale_new',
        cancelledAt: null,
        blockedAt: null,
        blockedReason: '',
      },
    });
    await Store.updateOne({ _id: store._id }, {
      $set: { isActive: true, blockedAt: null, 'subdomainPurchase.removalScheduledAt': null },
    });

    await handleWebhook({ ...event, id: 'evt_cancel_stale_retry' });
    const [current, currentStore] = await Promise.all([
      SellerSubscription.findById(subscription._id).lean(),
      Store.findById(store._id).lean(),
    ]);
    expect(current.status).toBe('active');
    expect(current.stripeSubscriptionId).toBe('sub_cancel_stale_new');
    expect(current.cancellationTransition.completedAt).toBeTruthy();
    expect(current.cancellationTransition.notificationEnqueuedAt).toBeNull();
    expect(currentStore.isActive).toBe(true);
    expect(currentStore.subdomainPurchase.removalScheduledAt).toBeNull();
    expect(await NotificationOutbox.countDocuments({ aggregateId: subscription._id.toString() })).toBe(0);
  });

  test('a status read preserves current paid-cycle coverage instead of overwriting it as past_due', async () => {
    const seller = await User.create({
      username: 'paid-cycle-status-read',
      email: 'paid-cycle-status-read@example.com',
      role: 'seller',
      isVerified: true,
    });
    const now = Date.now();
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'free_period',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_paid_cycle_status',
      stripeSubscriptionId: 'sub_paid_cycle_status',
      freePeriodEndDate: new Date(now - 1000),
      hasUsedFreePeriod: true,
    });
    await StripeEntitlementPayment.create({
      entitlementType: 'subscription',
      sourceKey: 'subscription:in_paid_cycle_status',
      seller: seller._id,
      invoiceId: 'in_paid_cycle_status',
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      currency: 'usd',
      capturedMinor: 999,
      grantStart: new Date(now - 1000),
      grantEnd: new Date(now + 30 * 24 * 60 * 60 * 1000),
      effectiveGrantEnd: new Date(now + 30 * 24 * 60 * 60 * 1000),
      billingReason: 'subscription_cycle',
      completionState: 'confirmed',
    });
    const response = responseMock();

    await getSubscriptionStatus({ user: { id: seller._id.toString() } }, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      subscription: expect.objectContaining({ status: 'active' }),
    }));
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      status: 'active',
    });
  });

  test('a status read treats an absent legacy founder discount as zero without numeric coercion', async () => {
    const seller = await User.create({
      username: 'legacy-founder-discount-absent',
      email: 'legacy-founder-discount-absent@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialStartDate: new Date(),
      trialEndDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await SellerSubscription.collection.updateOne(
      { _id: subscription._id },
      { $unset: { 'founderOffer.discountPercent': '' } },
    );
    const response = responseMock();

    await getSubscriptionStatus({ user: { id: seller._id.toString() } }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      subscription: expect.objectContaining({
        founderOffer: expect.objectContaining({ discountPercent: 0 }),
      }),
    }));
  });

  test.each([
    ['blank text', ''],
    ['numeric text', '40'],
    ['boolean', true],
    ['excess precision', 40.001],
    ['out of range', 101],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe finite magnitude', Number.MAX_VALUE],
  ])('a status read fails closed for a stored %s founder discount', async (_label, storedValue) => {
    const suffix = crypto.randomUUID();
    const seller = await User.create({
      username: `invalid-founder-discount-${suffix}`,
      email: `invalid-founder-discount-${suffix}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialStartDate: new Date(),
      trialEndDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    await SellerSubscription.collection.updateOne(
      { _id: subscription._id },
      { $set: { 'founderOffer.discountPercent': storedValue } },
    );
    const response = responseMock();

    await getSubscriptionStatus({ user: { id: seller._id.toString() } }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      msg: 'Subscription pricing data requires recovery before it can be displayed safely.',
      code: 'SUBSCRIPTION_FOUNDER_OFFER_INVALID',
    });
  });

  test('checkout completion retries finish Store activation without consuming a second free period', async () => {
    const seller = await User.create({
      username: 'checkout-store-sync-retry',
      email: 'checkout-store-sync-retry@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_checkout_store_sync',
      trialEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Checkout Store Sync',
      storeSlug: 'checkout-store-sync',
      isActive: false,
      blockedAt: new Date(),
    });
    const event = {
      id: 'evt_checkout_store_sync',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_store_sync',
          mode: 'subscription',
          subscription: 'sub_checkout_store_sync',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            checkoutClaimToken: 'claim_checkout_store_sync',
          },
        },
      },
    };
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_checkout_store_sync',
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
      status: 'trialing',
      invoiceStatus: 'open',
    }));
    jest.spyOn(Store, 'findOneAndUpdate').mockRejectedValueOnce(new Error('transient Store write failure'));

    await expect(handleWebhook(event)).rejects.toThrow('transient Store write failure');
    const partiallyApplied = await SellerSubscription.findById(subscription._id);
    expect(partiallyApplied.processedCheckoutSessionIds).toEqual(['cs_checkout_store_sync']);
    expect(partiallyApplied.pendingStoreSync.kind).toBe('checkout_activation');
    expect(partiallyApplied.hasUsedFreePeriod).toBe(true);

    await expect(handleWebhook(event)).resolves.toBeUndefined();

    const [recovered, recoveredStore, activationRows] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
      NotificationOutbox.find({
        aggregateId: subscription._id.toString(),
        eventType: 'subscription.activated',
      }).lean(),
    ]);
    expect(recovered.processedCheckoutSessionIds).toEqual(['cs_checkout_store_sync']);
    expect(recovered.pendingStoreSync.kind).toBeNull();
    expect(recovered.status).toBe('free_period');
    expect(recovered.activationNotification).toMatchObject({
      kind: 'checkout_activation',
      sourceReference: 'cs_checkout_store_sync',
      stripeSubscriptionId: 'sub_checkout_store_sync',
      recurringAmountMinor: 999,
      currency: 'USD',
      freePeriodDays: 30,
    });
    expect(recovered.activationNotification.notificationEnqueuedAt).toBeTruthy();
    expect(recovered.activationNotification.completedAt).toBeTruthy();
    expect(recoveredStore.isActive).toBe(true);
    expect(recoveredStore.blockedAt).toBeNull();
    expect(activationRows).toHaveLength(4);
    for (const row of activationRows) {
      expect(row.financial).toBe(true);
      expect(row.money).toEqual([
        expect.objectContaining({ key: 'recurring_price', amountMinor: 999, currency: 'USD' }),
      ]);
    }

    await handleWebhook(event);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: subscription._id.toString(),
      eventType: 'subscription.activated',
    })).toBe(4);
  });

  test('checkout activation receipts use the signed Checkout price snapshot, not a later catalog value', async () => {
    const seller = await User.create({
      username: 'checkout-price-snapshot',
      email: 'checkout-price-snapshot@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_checkout_price_snapshot',
      hasUsedFreePeriod: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Checkout Price Snapshot',
      storeSlug: 'checkout-price-snapshot',
      isActive: false,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_checkout_price_snapshot',
      customerId: 'cus_checkout_price_snapshot',
      unitAmount: 599,
      status: 'active',
      invoiceStatus: 'paid',
    }));

    await handleWebhook({
      id: 'evt_checkout_price_snapshot',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_price_snapshot',
          mode: 'subscription',
          subscription: 'sub_checkout_price_snapshot',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            recurringAmountMinor: '599',
            recurringCurrency: 'USD',
          },
        },
      },
    });

    const [updated, rows] = await Promise.all([
      SellerSubscription.findById(subscription._id).lean(),
      NotificationOutbox.find({
        aggregateId: subscription._id.toString(),
        eventType: 'subscription.activated',
      }).lean(),
    ]);
    expect(updated.activationNotification.recurringAmountMinor).toBe(599);
    expect(rows).toHaveLength(4);
    expect(rows.every(row => (
      row.money.length === 1
      && row.money[0].amountMinor === 599
      && row.money[0].currency === 'USD'
    ))).toBe(true);
  });

  test('legacy Checkout activation derives exact historical price and trial days from Stripe', async () => {
    const seller = await User.create({
      username: 'legacy-checkout-authority',
      email: 'legacy-checkout-authority@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_legacy_checkout_authority',
      hasUsedFreePeriod: false,
      // Simulate a seller who already received the pre-subscription trial
      // warning. Activation must reset the separate ending-warning lifecycle.
      warningEmailSent: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Legacy Checkout Authority',
      storeSlug: 'legacy-checkout-authority',
      isActive: false,
    });
    const trialStart = Math.floor(Date.now() / 1000) - 60;
    const trialEnd = trialStart + 28 * 24 * 60 * 60;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_legacy_checkout_authority',
      customerId: 'cus_legacy_checkout_authority',
      // Deliberately differs from today's catalog. A legacy webhook must use
      // the immutable provider Price, not strand a valid old Checkout.
      unitAmount: 777,
      status: 'trialing',
      invoiceStatus: 'open',
      startDate: trialStart,
      trialStart,
      trialEnd,
      currentPeriodStart: trialStart,
      currentPeriodEnd: trialEnd,
    }));

    await handleWebhook({
      id: 'evt_legacy_checkout_authority',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_legacy_checkout_authority',
          mode: 'subscription',
          subscription: 'sub_legacy_checkout_authority',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            // recurringAmountMinor and introductoryPeriodDays were added
            // later and are intentionally absent on this legacy session.
          },
        },
      },
    });

    const [updated, rows] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      NotificationOutbox.find({
        aggregateId: subscription._id.toString(),
        eventType: 'subscription.activated',
      }).lean(),
    ]);
    expect(updated).toMatchObject({
      status: 'free_period',
      hasUsedFreePeriod: true,
      warningEmailSent: false,
    });
    expect(updated.freePeriodEndDate).toEqual(new Date(trialEnd * 1000));
    expect(updated.activationNotification).toMatchObject({
      recurringAmountMinor: 777,
      currency: 'USD',
      freePeriodDays: 28,
      freePeriodEndDate: new Date(trialEnd * 1000),
    });
    expect(rows).toHaveLength(4);
    expect(rows.every(row => (
      row.money.length === 1
      && row.money[0].amountMinor === 777
      && row.money[0].currency === 'USD'
    ))).toBe(true);
  });

  test('legacy Stripe trial evidence cannot grant a second introductory period', async () => {
    const seller = await User.create({
      username: 'legacy-checkout-trial-reuse',
      email: 'legacy-checkout-trial-reuse@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_legacy_checkout_trial_reuse',
      stripeSubscriptionId: 'sub_legacy_checkout_previous',
      hasUsedFreePeriod: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Legacy Trial Reuse',
      storeSlug: 'legacy-trial-reuse',
      isActive: false,
    });
    const trialStart = Math.floor(Date.now() / 1000) - 60;
    const trialEnd = trialStart + 30 * 24 * 60 * 60;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_legacy_checkout_trial_reuse',
      customerId: 'cus_legacy_checkout_trial_reuse',
      unitAmount: 999,
      status: 'trialing',
      invoiceStatus: 'open',
      startDate: trialStart,
      trialStart,
      trialEnd,
      currentPeriodStart: trialStart,
      currentPeriodEnd: trialEnd,
    }));

    await expect(handleWebhook({
      id: 'evt_legacy_checkout_trial_reuse',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_legacy_checkout_trial_reuse',
          mode: 'subscription',
          subscription: 'sub_legacy_checkout_trial_reuse',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
          },
        },
      },
    })).rejects.toMatchObject({ code: 'CHECKOUT_SUBSCRIPTION_TRIAL_ALREADY_USED' });

    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(unchanged).toMatchObject({
      status: 'trial',
      plan: 'free_trial',
      stripeSubscriptionId: 'sub_legacy_checkout_previous',
      hasUsedFreePeriod: true,
    });
    expect(unchanged.processedCheckoutSessionIds).toHaveLength(0);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: subscription._id.toString(),
      eventType: 'subscription.activated',
    })).toBe(0);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  test.each([28, 29, 31])(
    'checkout activation persists Stripe item period exactly for a %i-day billing month',
    async periodDays => {
      const seller = await User.create({
        username: `stripe-period-${periodDays}`,
        email: `stripe-period-${periodDays}@example.com`,
        role: 'seller',
        isVerified: true,
      });
      const subscription = await SellerSubscription.create({
        seller: seller._id,
        status: 'trial',
        plan: 'free_trial',
        stripeCustomerId: `cus_stripe_period_${periodDays}`,
        hasUsedFreePeriod: true,
      });
      await Store.create({
        seller: seller._id,
        storeName: `Stripe Period ${periodDays}`,
        storeSlug: `gateway-period-${periodDays}`,
        isActive: false,
      });
      const currentPeriodStart = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;
      const currentPeriodEnd = currentPeriodStart + periodDays * 24 * 60 * 60;
      stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
        subscriptionId: `sub_stripe_period_${periodDays}`,
        customerId: `cus_stripe_period_${periodDays}`,
        unitAmount: 999,
        status: 'active',
        invoiceStatus: 'paid',
        currentPeriodStart,
        currentPeriodEnd,
      }));

      await handleWebhook({
        id: `evt_stripe_period_${periodDays}`,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_stripe_period_${periodDays}`,
            mode: 'subscription',
            subscription: `sub_stripe_period_${periodDays}`,
            metadata: {
              sellerId: seller._id.toString(),
              plan: 'starter',
              includeMetaAds: 'false',
              recurringAmountMinor: '999',
              recurringCurrency: 'USD',
            },
          },
        },
      });

      const updated = await SellerSubscription.findById(subscription._id);
      expect(updated.status).toBe('active');
      expect(updated.subscribedAt).toEqual(new Date(currentPeriodStart * 1000));
      expect(updated.currentPeriodStart).toEqual(new Date(currentPeriodStart * 1000));
      expect(updated.currentPeriodEnd).toEqual(new Date(currentPeriodEnd * 1000));
      expect(updated.currentPeriodEnd - updated.currentPeriodStart)
        .toBe(periodDays * 24 * 60 * 60 * 1000);
      expect(updated.bonusExpiryDate).toEqual(addUtcCalendarMonths(
        new Date(currentPeriodStart * 1000),
        6,
      ));
    },
  );

  test('a delayed introductory Checkout uses Stripe item period and trial_end, never webhook time', async () => {
    const seller = await User.create({
      username: 'stripe-delayed-trial-period',
      email: 'stripe-delayed-trial-period@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_stripe_delayed_trial',
      hasUsedFreePeriod: false,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Stripe Delayed Trial',
      storeSlug: 'gateway-delayed-trial',
      isActive: false,
    });
    const currentPeriodStart = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;
    const trialEnd = currentPeriodStart + 30 * 24 * 60 * 60;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_stripe_delayed_trial',
      customerId: 'cus_stripe_delayed_trial',
      unitAmount: 999,
      status: 'trialing',
      invoiceStatus: 'open',
      currentPeriodStart,
      currentPeriodEnd: trialEnd,
      trialEnd,
    }));

    await handleWebhook({
      id: 'evt_stripe_delayed_trial',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_stripe_delayed_trial',
          mode: 'subscription',
          subscription: 'sub_stripe_delayed_trial',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            recurringAmountMinor: '999',
            recurringCurrency: 'USD',
            introductoryPeriodDays: '30',
          },
        },
      },
    });

    const updated = await SellerSubscription.findById(subscription._id);
    expect(updated.status).toBe('free_period');
    expect(updated.subscribedAt).toEqual(new Date(currentPeriodStart * 1000));
    expect(updated.currentPeriodStart).toEqual(new Date(currentPeriodStart * 1000));
    expect(updated.currentPeriodEnd).toEqual(new Date(trialEnd * 1000));
    expect(updated.freePeriodEndDate).toEqual(new Date(trialEnd * 1000));
    expect(updated.activationNotification.freePeriodEndDate).toEqual(new Date(trialEnd * 1000));
    expect(updated.freePeriodEndDate.getTime()).toBeLessThan(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    );
  });

  test('a Checkout delivered after its introductory trial ended activates paid state without a false free-period receipt', async () => {
    const seller = await User.create({
      username: 'stripe-elapsed-trial-period',
      email: 'stripe-elapsed-trial-period@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_stripe_elapsed_trial',
      hasUsedFreePeriod: false,
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Stripe Elapsed Trial',
      storeSlug: 'gateway-elapsed-trial',
      isActive: false,
    });
    const paidPeriodStart = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;
    const paidPeriodEnd = paidPeriodStart + 31 * 24 * 60 * 60;
    const trialStart = paidPeriodStart - 30 * 24 * 60 * 60;
    const trialEnd = paidPeriodStart;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_stripe_elapsed_trial',
      customerId: 'cus_stripe_elapsed_trial',
      unitAmount: 999,
      status: 'active',
      invoiceStatus: 'paid',
      startDate: trialStart,
      trialStart,
      trialEnd,
      currentPeriodStart: paidPeriodStart,
      currentPeriodEnd: paidPeriodEnd,
    }));

    await handleWebhook({
      id: 'evt_stripe_elapsed_trial',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_stripe_elapsed_trial',
          mode: 'subscription',
          subscription: 'sub_stripe_elapsed_trial',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            recurringAmountMinor: '999',
            recurringCurrency: 'USD',
            introductoryPeriodDays: '30',
          },
        },
      },
    });

    const [updated, activationRows] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      NotificationOutbox.find({
        aggregateId: String(subscription._id),
        eventType: 'subscription.activated',
      }).lean(),
    ]);
    expect(updated.status).toBe('active');
    expect(updated.hasUsedFreePeriod).toBe(true);
    expect(updated.subscribedAt).toEqual(new Date(trialStart * 1000));
    expect(updated.currentPeriodStart).toEqual(new Date(paidPeriodStart * 1000));
    expect(updated.currentPeriodEnd).toEqual(new Date(paidPeriodEnd * 1000));
    expect(updated.freePeriodEndDate).toBeNull();
    expect(updated.bonusExpiryDate).toEqual(addUtcCalendarMonths(
      new Date(trialStart * 1000),
      6,
    ));
    expect(updated.activationNotification).toMatchObject({
      freePeriodDays: 0,
      freePeriodEndDate: null,
    });
    expect(activationRows).toHaveLength(4);
    expect(activationRows.every(row => ![
      row.payload?.body,
      row.payload?.text,
      row.payload?.html,
      row.payload?.message,
    ].filter(Boolean).join(' ').includes('introductory period'))).toBe(true);
  });

  test.each([
    ['missing item start', remote => { delete remote.items.data[0].current_period_start; }],
    ['boolean item start', remote => { remote.items.data[0].current_period_start = true; }],
    ['overflowing item start', remote => { remote.items.data[0].current_period_start = Number.MAX_SAFE_INTEGER; }],
    ['non-increasing item period', remote => {
      remote.items.data[0].current_period_end = remote.items.data[0].current_period_start;
    }],
    ['overlong monthly item period', remote => {
      remote.items.data[0].current_period_end = remote.items.data[0].current_period_start
        + (33 * 24 * 60 * 60);
    }],
  ])('checkout activation rejects a %s instead of projecting a local 30-day period', async (suffix, corrupt) => {
    const safeSuffix = suffix.replace(/\W+/g, '-');
    const seller = await User.create({
      username: `stripe-invalid-period-${safeSuffix}`,
      email: `stripe-invalid-period-${safeSuffix}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: `cus_stripe_invalid_period_${safeSuffix}`,
      stripeSubscriptionId: `sub_previous_stripe_invalid_period_${safeSuffix}`,
      hasUsedFreePeriod: true,
    });
    await Store.create({
      seller: seller._id,
      storeName: `Stripe Invalid Period ${safeSuffix}`,
      storeSlug: `gateway-invalid-period-${safeSuffix}`,
      isActive: false,
    });
    const remote = stripeSubscriptionWithPrice({
      subscriptionId: `sub_stripe_invalid_period_${safeSuffix}`,
      customerId: `cus_stripe_invalid_period_${safeSuffix}`,
      unitAmount: 999,
      status: 'active',
      invoiceStatus: 'paid',
    });
    corrupt(remote);
    stripe.subscriptions.retrieve.mockResolvedValue(remote);

    await expect(handleWebhook({
      id: `evt_stripe_invalid_period_${safeSuffix}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: `cs_stripe_invalid_period_${safeSuffix}`,
          mode: 'subscription',
          subscription: `sub_stripe_invalid_period_${safeSuffix}`,
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            recurringAmountMinor: '999',
            recurringCurrency: 'USD',
          },
        },
      },
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_PERIOD_INVALID' });

    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(unchanged.status).toBe('trial');
    expect(unchanged.plan).toBe('free_trial');
    expect(unchanged.stripeSubscriptionId)
      .toBe(`sub_previous_stripe_invalid_period_${safeSuffix}`);
    expect(unchanged.processedCheckoutSessionIds).toHaveLength(0);
    expect(unchanged.currentPeriodStart).toBeUndefined();
    expect(unchanged.currentPeriodEnd).toBeUndefined();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  test('a delayed checkout Store-sync retry never erases a newer payment-risk block', async () => {
    const seller = await User.create({
      username: 'checkout-newer-risk',
      email: 'checkout-newer-risk@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      stripeCustomerId: 'cus_checkout_newer_risk',
      trialEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Checkout Newer Risk',
      storeSlug: 'checkout-newer-risk',
      isActive: false,
      blockedAt: new Date(),
    });
    const event = {
      id: 'evt_checkout_newer_risk',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_newer_risk',
          mode: 'subscription',
          subscription: 'sub_checkout_newer_risk',
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
          },
        },
      },
    };
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: 'sub_checkout_newer_risk',
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
      status: 'trialing',
      invoiceStatus: 'open',
    }));
    jest.spyOn(Store, 'findOneAndUpdate').mockRejectedValueOnce(new Error('first Store activation failed'));
    await expect(handleWebhook(event)).rejects.toThrow('first Store activation failed');

    const riskLockedAt = new Date();
    await Promise.all([
      SellerSubscription.updateOne({ _id: subscription._id }, {
        $set: {
          status: 'past_due',
          'paymentRisk.suspended': true,
          'paymentRisk.stripeSubscriptionId': 'sub_checkout_newer_risk',
          'paymentRisk.updatedAt': riskLockedAt,
        },
      }),
      Store.updateOne({ _id: store._id }, {
        $set: {
          isActive: false,
          blockedAt: riskLockedAt,
          'subscriptionPaymentRiskLock.stripeSubscriptionId': 'sub_checkout_newer_risk',
          'subscriptionPaymentRiskLock.lockedAt': riskLockedAt,
        },
      }),
    ]);

    await handleWebhook(event);

    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(updated.pendingStoreSync.kind).toBeNull();
    expect(updated.status).toBe('past_due');
    expect(updatedStore.isActive).toBe(false);
    expect(updatedStore.blockedAt).toEqual(riskLockedAt);
    expect(updatedStore.subscriptionPaymentRiskLock.stripeSubscriptionId)
      .toBe('sub_checkout_newer_risk');
  });

  test('automatic downgrade retries finish an incomplete-payment Store block without a second Stripe subscription', async () => {
    const seller = await User.create({
      username: 'downgrade-store-sync-retry',
      email: 'downgrade-store-sync-retry@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_store_sync',
      stripeSubscriptionId: 'sub_elite_store_sync_ended',
      pendingDowngrade: { toPlan: 'starter', scheduledAt: new Date() },
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Downgrade Store Sync',
      storeSlug: 'downgrade-store-sync',
      isActive: true,
      blockedAt: null,
    });
    stripe.subscriptions.create.mockResolvedValue({
      id: 'sub_starter_store_sync_incomplete',
      status: 'incomplete',
    });
    const event = {
      id: 'evt_downgrade_store_sync',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_elite_store_sync_ended' } },
    };
    jest.spyOn(Store, 'findOneAndUpdate').mockRejectedValueOnce(new Error('transient downgrade Store failure'));

    await expect(handleWebhook(event)).rejects.toThrow('transient downgrade Store failure');
    const partiallyApplied = await SellerSubscription.findById(subscription._id);
    expect(partiallyApplied.stripeSubscriptionId).toBe('sub_starter_store_sync_incomplete');
    expect(partiallyApplied.pendingStoreSync.kind).toBe('downgrade_block');

    await expect(handleWebhook(event)).resolves.toBeUndefined();

    const [recovered, recoveredStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(recovered.pendingStoreSync.kind).toBeNull();
    expect(recovered.status).toBe('past_due');
    expect(recoveredStore.isActive).toBe(false);
    expect(recoveredStore.subscriptionPaymentRiskLock.stripeSubscriptionId)
      .toBe('sub_starter_store_sync_incomplete');
  });

  test('a delayed downgrade block is skipped after a newer paid recovery', async () => {
    const seller = await User.create({
      username: 'downgrade-newer-recovery',
      email: 'downgrade-newer-recovery@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_newer_recovery',
      stripeSubscriptionId: 'sub_elite_newer_recovery_ended',
      pendingDowngrade: { toPlan: 'starter', scheduledAt: new Date() },
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Downgrade Newer Recovery',
      storeSlug: 'downgrade-newer-recovery',
      isActive: true,
      blockedAt: null,
    });
    stripe.subscriptions.create.mockResolvedValue({
      id: 'sub_starter_newer_recovery',
      status: 'incomplete',
    });
    const event = {
      id: 'evt_downgrade_newer_recovery',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_elite_newer_recovery_ended' } },
    };
    jest.spyOn(Store, 'findOneAndUpdate').mockRejectedValueOnce(new Error('first downgrade block failed'));
    await expect(handleWebhook(event)).rejects.toThrow('first downgrade block failed');

    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        status: 'active',
        'paymentRisk.suspended': false,
        'paymentRisk.reason': '',
        'paymentRisk.stripeSubscriptionId': '',
      },
    });
    await handleWebhook(event);

    const [updated, updatedStore] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
    ]);
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1);
    expect(updated.pendingStoreSync.kind).toBeNull();
    expect(updated.status).toBe('active');
    expect(updatedStore.isActive).toBe(true);
    expect(updatedStore.blockedAt).toBeNull();
  });

  test('an immediate paid Stripe invoice is required before an active Starter upgrade grants Elite', async () => {
    const seller = await User.create({
      username: 'paid-elite-upgrade',
      email: 'paid-elite-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_paid_elite_upgrade',
      stripeSubscriptionId: 'sub_paid_elite_upgrade',
      hasUsedFreePeriod: true,
    });
    const starterAmount = buildPlanPricing('starter').unitAmount;
    const eliteAmount = buildPlanPricing('elite', true).unitAmount;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: starterAmount,
    }));
    mockPaidPlanChangeUpdate({ customerId: subscription.stripeCustomerId });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: true },
    }, response);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      subscription.stripeSubscriptionId,
      expect.objectContaining({
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        expand: expect.arrayContaining([
          'items.data.price.product',
          'latest_invoice.confirmation_secret',
        ]),
        items: [expect.objectContaining({
          price: expect.stringMatching(/^price_/),
          quantity: 1,
        })],
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^rozare-plan-change-/),
      }),
    );
    expect(stripe.subscriptions.update.mock.calls[0][1].expand).not.toContain(
      'latest_invoice.payments.data.payment.payment_intent',
    );
    expect(stripe.subscriptions.update.mock.calls[0][1]).not.toHaveProperty('metadata');
    expect(stripe.subscriptions.update.mock.calls[0][1]).not.toHaveProperty('cancel_at_period_end');
    const updated = await SellerSubscription.findById(subscription._id);
    expect(updated.plan).toBe('elite');
    expect(updated.metaAdsIncluded).toBe(true);
    expect(updated.planChangeAttempt.state).toBe('applied');
    expect(updated.planChangeAttempt.stripePriceId).toMatch(/^price_/);
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'usd',
        unit_amount: eliteAmount,
        recurring: { interval: 'month' },
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^rozare-plan-change-price-/) }),
    );
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId: updated.planChangeAttempt.stripeInvoiceId,
    })).toBe(1);
    expect(response.status).not.toHaveBeenCalled();
  });

  test.each([
    ['requires_action', 'pi_action_secret_test', 409, 'PLAN_CHANGE_ACTION_REQUIRED', true],
    ['requires_confirmation', 'pi_confirmation_secret_test', 409, 'PLAN_CHANGE_PROCESSING', false],
    ['processing', null, 409, 'PLAN_CHANGE_PROCESSING', false],
    ['requires_payment_method', null, 402, 'PLAN_CHANGE_PAYMENT_REQUIRED', false],
  ])('keeps entitlement disabled while pending payment is %s', async (
    paymentState,
    confirmationSecret,
    expectedStatus,
    expectedCode,
    actionRequired,
  ) => {
    const suffix = paymentState.replace('_', '-');
    const seller = await User.create({
      username: `closed-upgrade-${suffix}`,
      email: `closed-upgrade-${suffix}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: `cus_closed_${suffix}`,
      stripeSubscriptionId: `sub_closed_${suffix}`,
      hasUsedFreePeriod: true,
    });
    const starterAmount = buildPlanPricing('starter').unitAmount;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: starterAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
      confirmationSecret,
      paymentIntentStatus: paymentState,
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);

    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(response.status).toHaveBeenCalledWith(expectedStatus);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: expectedCode,
      pending: true,
      actionRequired,
      ...(paymentState === 'requires_action' ? { clientSecret: confirmationSecret } : {}),
    }));
    expect(unchanged.plan).toBe('starter');
    expect(unchanged.metaAdsIncluded).toBe(false);
    expect(unchanged.bonusFeaturesActive).toBe(false);
    expect(unchanged.planChangeAttempt.state).toBe('pending_payment');
    expect(unchanged.planChangeAttempt.stripeSubscriptionItemId).toBe('si_subscription_plan');
    expect(unchanged.planChangeAttempt.stripeProductId).toMatch(/^prod_/);
    expect(unchanged.planChangeAttempt.stripePriceId).toMatch(/^price_/);
    expect(unchanged.planChangeAttempt.stripeInvoiceId).toMatch(/^in_/);
    expect(unchanged.planChangeAttempt.pendingUpdateExpiresAt).toBeInstanceOf(Date);
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);
  });

  test('concurrent identical upgrades share one durable Stripe mutation and retries return the applied result', async () => {
    const seller = await User.create({
      username: 'concurrent-elite-upgrade',
      email: 'concurrent-elite-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_concurrent_elite_upgrade',
      stripeSubscriptionId: 'sub_concurrent_elite_upgrade',
      hasUsedFreePeriod: true,
    });
    const starterAmount = buildPlanPricing('starter').unitAmount;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: starterAmount,
    }));
    let resolveStripeUpdate;
    stripe.subscriptions.update.mockReturnValue(new Promise(resolve => {
      resolveStripeUpdate = resolve;
    }));
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    const firstResponse = responseMock();
    const first = upgradeToElite(request, firstResponse);
    await waitUntilCalled(stripe.subscriptions.update);

    const parallelResponse = responseMock();
    await upgradeToElite(request, parallelResponse);
    expect(parallelResponse.status).toHaveBeenCalledWith(409);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);

    const [, updateParams] = stripe.subscriptions.update.mock.calls[0];
    const createdPrice = stripe.prices.create.mock.calls[0][0];
    resolveStripeUpdate(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: createdPrice.unit_amount,
      priceId: updateParams.items[0].price,
      productId: createdPrice.product,
      planChangeToken: createdPrice.metadata.planChangeToken,
      includeMetaAds: false,
    }));
    await first;

    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      metaAdsIncluded: false,
      planChangeAttempt: expect.objectContaining({ state: 'applied' }),
    });
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_completed',
    })).toBe(4);
  });

  test.each([
    ['fresh', Date.now(), 'PLAN_CHANGE_ENTITLEMENT_SYNC_IN_PROGRESS'],
    ['stale', Date.now() - (11 * 60 * 1000), 'PLAN_CHANGE_ENTITLEMENT_SYNC_RETRY'],
  ])('%s funded-plan reconciliation lease blocks a different plan fingerprint without being stolen', async (
    _leaseAge,
    acquiredAtMs,
    expectedCode,
  ) => {
    const seller = await User.create({
      username: `funded-sync-lease-${new mongoose.Types.ObjectId()}`,
      email: `funded-sync-lease-${new mongoose.Types.ObjectId()}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    const currentAmount = buildPlanPricing('elite', false).unitAmount;
    const processingToken = [
      'entitlement-plan-sync',
      'v1',
      'applied',
      acquiredAtMs,
      '11111111-1111-4111-8111-111111111111',
    ].join(':');
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      metaAdsIncluded: false,
      stripeCustomerId: `cus_funded_sync_${seller._id}`,
      stripeSubscriptionId: `sub_funded_sync_${seller._id}`,
      stripeProductId: 'prod_funded_sync_current',
      stripePriceId: 'price_funded_sync_current',
      hasUsedFreePeriod: true,
      planChangeAttempt: {
        idempotencyToken: `token_funded_sync_${seller._id}`,
        requestFingerprint: `old_fingerprint_${seller._id}`,
        changeKind: 'upgrade',
        stripeSubscriptionId: `sub_funded_sync_${seller._id}`,
        stripeSubscriptionItemId: 'si_subscription_plan',
        stripeProductId: 'prod_funded_sync_current',
        stripePriceId: 'price_funded_sync_current',
        stripeInvoiceId: 'in_funded_sync_current',
        sourcePlan: 'starter',
        sourcePlanName: 'Rozare Starter',
        sourceIncludeMetaAds: false,
        sourceUnitAmountMinor: buildPlanPricing('starter').unitAmount,
        sourceStripeProductId: 'prod_funded_sync_source',
        sourceStripePriceId: 'price_funded_sync_source',
        targetPlan: 'elite',
        targetPlanName: 'Rozare Elite',
        targetIncludeMetaAds: false,
        targetUnitAmountMinor: currentAmount,
        state: 'processing',
        processingToken,
        // Deliberately unrelated: entitlement leases use the encoded epoch,
        // while startedAt remains the original plan-change chronology.
        startedAt: new Date(Date.now() - (24 * 60 * 60 * 1000)),
      },
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: true },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: expectedCode,
      retryAfterSeconds: expect.any(Number),
    }));
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      metaAdsIncluded: false,
      planChangeAttempt: expect.objectContaining({
        idempotencyToken: `token_funded_sync_${seller._id}`,
        requestFingerprint: `old_fingerprint_${seller._id}`,
        state: 'processing',
        processingToken,
      }),
    });
  });

  test('an ambiguous Stripe timeout retries with the same durable plan-change idempotency key', async () => {
    const seller = await User.create({
      username: 'recoverable-elite-upgrade',
      email: 'recoverable-elite-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_recoverable_elite_upgrade',
      stripeSubscriptionId: 'sub_recoverable_elite_upgrade',
      hasUsedFreePeriod: true,
    });
    const starterAmount = buildPlanPricing('starter').unitAmount;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: starterAmount,
    }));
    let updateCalls = 0;
    stripe.subscriptions.update.mockImplementation(async (subscriptionId, params) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        throw Object.assign(new Error('connection lost after request write'), {
          type: 'StripeConnectionError',
          code: 'ECONNRESET',
        });
      }
      return stripeSubscriptionWithPrice({
        subscriptionId,
        customerId: subscription.stripeCustomerId,
        unitAmount: stripe.prices.create.mock.calls[0][0].unit_amount,
        priceId: params.items[0].price,
        productId: stripe.prices.create.mock.calls[0][0].product,
        planChangeToken: stripe.prices.create.mock.calls[0][0].metadata.planChangeToken,
        includeMetaAds: false,
      });
    });
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    const firstResponse = responseMock();

    await upgradeToElite(request, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(503);
    expect((await SellerSubscription.findById(subscription._id)).planChangeAttempt.state)
      .toBe('recoverable');
    const firstKey = stripe.subscriptions.update.mock.calls[0][2].idempotencyKey;

    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);

    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(retryResponse.status).not.toHaveBeenCalled();
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      planChangeAttempt: expect.objectContaining({ state: 'applied' }),
    });
  });

  test('a Stripe card decline never grants Elite and retains the exact-replay attempt', async () => {
    const seller = await User.create({
      username: 'declined-elite-upgrade',
      email: 'declined-elite-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_declined_elite_upgrade',
      stripeSubscriptionId: 'sub_declined_elite_upgrade',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    let updateCalls = 0;
    stripe.subscriptions.update.mockImplementation(async (subscriptionId, params) => {
      updateCalls += 1;
      if (updateCalls === 1) {
        throw Object.assign(new Error('card declined'), {
          type: 'StripeCardError',
          statusCode: 402,
        });
      }
      return stripeSubscriptionWithPrice({
        subscriptionId,
        customerId: subscription.stripeCustomerId,
        unitAmount: stripe.prices.create.mock.calls[0][0].unit_amount,
        priceId: params.items[0].price,
        productId: stripe.prices.create.mock.calls[0][0].product,
        planChangeToken: stripe.prices.create.mock.calls[0][0].metadata.planChangeToken,
        includeMetaAds: false,
      });
    });
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    const firstResponse = responseMock();

    await upgradeToElite(request, firstResponse);

    const unchanged = await SellerSubscription.findById(subscription._id);
    const firstKey = stripe.subscriptions.update.mock.calls[0][2].idempotencyKey;
    const attemptToken = unchanged.planChangeAttempt.idempotencyToken;
    expect(firstResponse.status).toHaveBeenCalledWith(402);
    expect(unchanged.plan).toBe('starter');
    expect(unchanged.planChangeAttempt.state).toBe('recoverable');
    expect(firstKey).toBe(`rozare-plan-change-${subscription._id}-${attemptToken}`);

    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);

    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(retryResponse.status).not.toHaveBeenCalled();
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      planChangeAttempt: expect.objectContaining({
        state: 'applied',
        idempotencyToken: attemptToken,
      }),
    });
  });

  test('a declined pending-update invoice remains durable and never grants Elite', async () => {
    const seller = await User.create({
      username: 'declined-pending-elite-upgrade',
      email: 'declined-pending-elite-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_declined_pending_elite_upgrade',
      stripeSubscriptionId: 'sub_declined_pending_elite_upgrade',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);

    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(response.status).toHaveBeenCalledWith(402);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_PAYMENT_REQUIRED',
      pending: true,
      actionRequired: false,
    }));
    expect(unchanged.plan).toBe('starter');
    expect(unchanged.planChangeAttempt.state).toBe('pending_payment');
    expect(unchanged.planChangeAttempt.stripeInvoiceId).toMatch(/^in_/);
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);
  });

  test('a pending attempt keeps its immutable amount when seller pricing eligibility changes', async () => {
    const seller = await User.create({
      username: 'immutable-pending-plan-amount',
      email: 'immutable-pending-plan-amount@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_immutable_pending_plan_amount',
      stripeSubscriptionId: 'sub_immutable_pending_plan_amount',
      hasUsedFreePeriod: true,
      founderOffer: { active: false },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    await upgradeToElite(request, responseMock());
    const first = await SellerSubscription.findById(subscription._id);
    const attempt = first.planChangeAttempt;
    expect(attempt.targetUnitAmountMinor).toBe(buildPlanPricing('elite').unitAmount);

    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        'founderOffer.active': true,
        'founderOffer.code': 'FIRST100',
      },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'open',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: attempt.stripeSubscriptionItemId,
          price: attempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    }));
    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);

    expect(retryResponse.status).toHaveBeenCalledWith(409);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_PENDING',
    }));
    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(unchanged.plan).toBe('starter');
    expect(unchanged.planChangeAttempt.idempotencyToken).toBe(attempt.idempotencyToken);
    expect(unchanged.planChangeAttempt.targetUnitAmountMinor).toBe(attempt.targetUnitAmountMinor);
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  test('Meta Ads removal is authoritative but never demands a new payment', async () => {
    const seller = await User.create({
      username: 'meta-removal',
      email: 'meta-removal@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite + Meta Ads',
      metaAdsIncluded: true,
      stripeCustomerId: 'cus_meta_removal',
      stripeSubscriptionId: 'sub_meta_removal',
      hasUsedFreePeriod: true,
      bonusFeaturesActive: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('elite', true).unitAmount,
    }));
    stripe.subscriptions.update.mockImplementation(async (subscriptionId, params) => {
      const targetPrice = stripe.prices.create.mock.calls
        .map(call => call[0])
        .find(candidate => `price_${candidate.metadata.planChangeToken}` === params.items[0].price);
      return stripeSubscriptionWithPrice({
        subscriptionId,
        customerId: subscription.stripeCustomerId,
        unitAmount: targetPrice.unit_amount,
        priceId: params.items[0].price,
        productId: targetPrice.product,
        planChangeToken: targetPrice.metadata.planChangeToken,
        invoiceStatus: 'open',
      });
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);

    const [, params] = stripe.subscriptions.update.mock.calls[0];
    expect(params.proration_behavior).toBe('create_prorations');
    expect(params.payment_behavior).toBeUndefined();
    expect((await SellerSubscription.findById(subscription._id)).metaAdsIncluded).toBe(false);
    expect(response.status).not.toHaveBeenCalled();
  });

  test('Meta Ads addition remains disabled until its Stripe update invoice is paid', async () => {
    const seller = await User.create({
      username: 'meta-addition-pending',
      email: 'meta-addition-pending@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      metaAdsIncluded: false,
      stripeCustomerId: 'cus_meta_addition_pending',
      stripeSubscriptionId: 'sub_meta_addition_pending',
      hasUsedFreePeriod: true,
      bonusFeaturesActive: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('elite', false).unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: true },
    }, response);

    expect(response.status).toHaveBeenCalledWith(402);
    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(unchanged.plan).toBe('elite');
    expect(unchanged.metaAdsIncluded).toBe(false);
    expect(unchanged.planChangeAttempt.state).toBe('pending_payment');
    expect(unchanged.planChangeAttempt.targetIncludeMetaAds).toBe(true);
  });

  test('webhooks alone converge a pending plan change once, despite pending-first, replayed, and stale events', async () => {
    const seller = await User.create({
      username: 'webhook-only-elite-upgrade',
      email: 'webhook-only-elite-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_webhook_only_elite_upgrade',
      stripeSubscriptionId: 'sub_webhook_only_elite_upgrade',
      hasUsedFreePeriod: true,
    });
    const oldStripeSubscription = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    const predecessorStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const predecessorEnd = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);
    await StripeEntitlementPayment.create({
      entitlementType: 'subscription',
      sourceKey: 'invoice:in_webhook_predecessor_cycle',
      seller: seller._id,
      invoiceId: 'in_webhook_predecessor_cycle',
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      currency: 'usd',
      capturedMinor: buildPlanPricing('starter').unitAmount,
      grantStart: predecessorStart,
      grantEnd: predecessorEnd,
      effectiveGrantEnd: predecessorEnd,
      billingReason: 'subscription_cycle',
      priceIds: [oldStripeSubscription.items.data[0].price.id],
      unitAmountMinorSnapshots: [buildPlanPricing('starter').unitAmount],
      fundedPlan: 'starter',
      fundedPlanName: 'Rozare Starter',
      fundedMetaAdsIncluded: false,
      fundedStripePriceId: oldStripeSubscription.items.data[0].price.id,
      fundedStripeProductId: oldStripeSubscription.items.data[0].price.product.id,
      fundedSubscriptionItemId: oldStripeSubscription.items.data[0].id,
      fundedUnitAmountMinor: buildPlanPricing('starter').unitAmount,
      fundedBonusFeaturesActive: false,
      completionState: 'confirmed',
    });
    stripe.subscriptions.retrieve.mockResolvedValue(oldStripeSubscription);
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });

    const pendingResponse = responseMock();
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: true },
    }, pendingResponse);
    expect(pendingResponse.status).toHaveBeenCalledWith(402);

    const pendingLocal = await SellerSubscription.findById(subscription._id);
    const attempt = pendingLocal.planChangeAttempt;
    const pendingStripeSubscription = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: true,
      invoiceStatus: 'open',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: attempt.stripeSubscriptionItemId,
          price: attempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(pendingStripeSubscription);

    await handleWebhook({
      id: 'evt_plan_change_pending_first',
      created: 100,
      type: 'customer.subscription.updated',
      data: { object: { id: subscription.stripeSubscriptionId } },
    });
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      metaAdsIncluded: false,
      planChangeAttempt: expect.objectContaining({ state: 'pending_payment' }),
    });
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId: attempt.stripeInvoiceId,
    })).toBe(0);

    const appliedStripeSubscription = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: true,
      invoiceStatus: 'paid',
    });
    stripe.subscriptions.retrieve.mockResolvedValue(appliedStripeSubscription);
    const appliedEvent = {
      id: 'evt_plan_change_subscription_applied',
      created: 101,
      type: 'customer.subscription.pending_update_applied',
      data: { object: { id: subscription.stripeSubscriptionId } },
    };
    await handleWebhook(appliedEvent);

    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      status: 'active',
      plan: 'elite',
      metaAdsIncluded: true,
      bonusFeaturesActive: true,
      stripePriceId: attempt.stripePriceId,
      planChangeAttempt: expect.objectContaining({
        state: 'applied',
        idempotencyToken: attempt.idempotencyToken,
        stripeInvoiceId: attempt.stripeInvoiceId,
      }),
    });
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId: attempt.stripeInvoiceId,
    })).toBe(1);

    await handleWebhook(appliedEvent);
    await handleWebhook({
      id: 'evt_plan_change_invoice_paid_replay',
      created: 102,
      type: 'invoice.paid',
      data: { object: appliedStripeSubscription.latest_invoice },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(pendingStripeSubscription);
    await handleWebhook({
      id: 'evt_plan_change_stale_pending_after_paid',
      created: 99,
      type: 'customer.subscription.updated',
      data: { object: { id: subscription.stripeSubscriptionId } },
    });

    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      metaAdsIncluded: true,
      planChangeAttempt: expect.objectContaining({ state: 'applied' }),
    });
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId: attempt.stripeInvoiceId,
    })).toBe(1);
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_completed',
    })).toBe(4);
  });

  test('an exact pending Price applies when Stripe settles the update invoice at zero due', async () => {
    const seller = await User.create({
      username: 'zero-due-plan-change',
      email: 'zero-due-plan-change@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_zero_due_plan_change',
      stripeSubscriptionId: 'sub_zero_due_plan_change',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, responseMock());
    const pending = await SellerSubscription.findById(subscription._id);
    const attempt = pending.planChangeAttempt;
    const zeroDueApplied = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'paid',
      amountPaid: 0,
      lineAmount: 0,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(zeroDueApplied);

    await handleWebhook({
      id: 'evt_zero_due_pending_update_applied',
      created: 150,
      type: 'customer.subscription.pending_update_applied',
      data: { object: zeroDueApplied },
    });

    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      status: 'active',
      plan: 'elite',
      metaAdsIncluded: false,
      bonusFeaturesActive: true,
      stripePriceId: attempt.stripePriceId,
      planChangeAttempt: expect.objectContaining({
        state: 'applied',
        stripeInvoiceId: attempt.stripeInvoiceId,
      }),
    });
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);
  });

  test('a retry retrieves the bound update invoice when Stripe latest_invoice has advanced', async () => {
    const seller = await User.create({
      username: 'advanced-latest-invoice-plan-change',
      email: 'advanced-latest-invoice-plan-change@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_advanced_latest_invoice_plan_change',
      stripeSubscriptionId: 'sub_advanced_latest_invoice_plan_change',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    await upgradeToElite(request, responseMock());
    const pending = await SellerSubscription.findById(subscription._id);
    const attempt = pending.planChangeAttempt;
    const exactApplied = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'paid',
    });
    const advancedInvoice = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: 'in_later_subscription_cycle',
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'paid',
    }).latest_invoice;
    advancedInvoice.billing_reason = 'subscription_cycle';
    exactApplied.latest_invoice = advancedInvoice;
    stripe.subscriptions.retrieve.mockResolvedValue(exactApplied);
    stripe.invoices.retrieve.mockResolvedValue(
      stripeSubscriptionWithPrice({
        subscriptionId: subscription.stripeSubscriptionId,
        customerId: subscription.stripeCustomerId,
        unitAmount: attempt.targetUnitAmountMinor,
        subscriptionItemId: attempt.stripeSubscriptionItemId,
        priceId: attempt.stripePriceId,
        invoiceId: attempt.stripeInvoiceId,
        planChangeToken: attempt.idempotencyToken,
        includeMetaAds: false,
        invoiceStatus: 'paid',
      }).latest_invoice,
    );

    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);

    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(
      attempt.stripeInvoiceId,
      { expand: ['parent.subscription_details.subscription'] },
    );
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      planChangeAttempt: expect.objectContaining({ state: 'applied' }),
    });
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId: attempt.stripeInvoiceId,
    })).toBe(1);
  });

  test('paid convergence requires the exact durable Stripe item, Price, and invoice', async () => {
    const seller = await User.create({
      username: 'exact-plan-change-binding',
      email: 'exact-plan-change-binding@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_exact_plan_change_binding',
      stripeSubscriptionId: 'sub_exact_plan_change_binding',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, responseMock());
    const pending = await SellerSubscription.findById(subscription._id);
    const attempt = pending.planChangeAttempt;
    const exact = overrides => stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'paid',
      ...overrides,
    });
    const malformedExact = mutate => {
      const stripeSubscription = exact({});
      mutate(stripeSubscription);
      return stripeSubscription;
    };

    for (const [eventId, stripeSubscription] of [
      ['evt_wrong_plan_change_item', exact({ subscriptionItemId: 'si_different_item' })],
      ['evt_wrong_plan_change_price', exact({ priceId: 'price_different_target' })],
      ['evt_wrong_plan_change_invoice', exact({ invoiceId: 'in_different_plan_change' })],
      ['evt_boolean_plan_change_line_amount', malformedExact(remote => { remote.latest_invoice.lines.data[0].amount = true; })],
      ['evt_boolean_plan_change_line_quantity', malformedExact(remote => { remote.latest_invoice.lines.data[0].quantity = true; })],
      ['evt_string_plan_change_amount_remaining', malformedExact(remote => { remote.latest_invoice.amount_remaining = '0'; })],
      ['evt_boolean_unit_amount_decimal', malformedExact(remote => { remote.latest_invoice.lines.data[0].pricing.unit_amount_decimal = true; })],
    ]) {
      stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscription);
      await handleWebhook({
        id: eventId,
        created: 200,
        type: 'customer.subscription.updated',
        data: { object: { id: subscription.stripeSubscriptionId } },
      });
      await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
        plan: 'starter',
        planChangeAttempt: expect.objectContaining({ state: 'pending_payment' }),
      });
      expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);
    }

    const authoritative = exact({});
    stripe.subscriptions.retrieve.mockResolvedValue(authoritative);
    await handleWebhook({
      id: 'evt_exact_plan_change_binding',
      created: 201,
      type: 'customer.subscription.updated',
      data: { object: { id: subscription.stripeSubscriptionId } },
    });
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      metaAdsIncluded: false,
      planChangeAttempt: expect.objectContaining({ state: 'applied' }),
    });
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(1);
  });

  test('a superseded pending update is cleared and a later retry uses a fresh durable intent', async () => {
    const seller = await User.create({
      username: 'superseded-plan-change',
      email: 'superseded-plan-change@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_superseded_plan_change',
      stripeSubscriptionId: 'sub_superseded_plan_change',
      hasUsedFreePeriod: true,
    });
    const oldStripeSubscription = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(oldStripeSubscription);
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    await upgradeToElite(request, responseMock());
    const firstAttempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;

    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: firstAttempt.targetUnitAmountMinor,
      subscriptionItemId: firstAttempt.stripeSubscriptionItemId,
      priceId: firstAttempt.stripePriceId,
      invoiceId: firstAttempt.stripeInvoiceId,
      planChangeToken: firstAttempt.idempotencyToken,
      invoiceStatus: 'open',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{ id: 'si_superseding_item', price: firstAttempt.stripePriceId, quantity: 1, discounts: [] }],
      },
    }));
    await handleWebhook({
      id: 'evt_plan_change_superseded',
      created: 300,
      type: 'customer.subscription.updated',
      data: { object: { id: subscription.stripeSubscriptionId } },
    });
    const cleared = await SellerSubscription.findById(subscription._id);
    expect(cleared.plan).toBe('starter');
    expect(cleared.planChangeAttempt.state).toBeNull();
    expect(cleared.planChangeAttempt.lastError).toMatch(/superseded/i);

    stripe.subscriptions.retrieve.mockResolvedValue(oldStripeSubscription);
    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);
    const retried = await SellerSubscription.findById(subscription._id);
    expect(retryResponse.status).toHaveBeenCalledWith(402);
    expect(retried.plan).toBe('starter');
    expect(retried.planChangeAttempt.state).toBe('pending_payment');
    expect(retried.planChangeAttempt.idempotencyToken).not.toBe(firstAttempt.idempotencyToken);
    expect(stripe.products.create).toHaveBeenCalledTimes(2);
    expect(stripe.prices.create).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
  });

  test('an expired pending update is abandoned before a fresh idempotent payment attempt', async () => {
    const seller = await User.create({
      username: 'expired-plan-change',
      email: 'expired-plan-change@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_expired_plan_change',
      stripeSubscriptionId: 'sub_expired_plan_change',
      hasUsedFreePeriod: true,
    });
    const oldStripeSubscription = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(oldStripeSubscription);
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
    });
    const request = {
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    };
    await upgradeToElite(request, responseMock());
    const firstAttempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;
    await SellerSubscription.updateOne({ _id: subscription._id }, {
      $set: {
        'planChangeAttempt.pendingUpdateExpiresAt': new Date(Date.now() - 60_000),
        'planChangeAttempt.state': 'processing',
        'planChangeAttempt.processingToken': 'crashed-before-pending-persist',
      },
    });

    const expiredEvent = {
      id: 'evt_pending_update_expired',
      created: 400,
      type: 'customer.subscription.pending_update_expired',
      data: {
        object: stripeSubscriptionWithPrice({
          subscriptionId: subscription.stripeSubscriptionId,
          customerId: subscription.stripeCustomerId,
          unitAmount: firstAttempt.targetUnitAmountMinor,
          subscriptionItemId: firstAttempt.stripeSubscriptionItemId,
          priceId: firstAttempt.stripePriceId,
          invoiceId: firstAttempt.stripeInvoiceId,
          planChangeToken: firstAttempt.idempotencyToken,
          includeMetaAds: false,
          invoiceStatus: 'open',
        }),
      },
    };
    await handleWebhook(expiredEvent);
    const expired = await SellerSubscription.findById(subscription._id);
    expect(expired.plan).toBe('starter');
    expect(expired.planChangeAttempt.state).toBeNull();
    expect(expired.planChangeAttempt.lastError).toMatch(/expired/i);

    const retryResponse = responseMock();
    await upgradeToElite(request, retryResponse);
    const retried = await SellerSubscription.findById(subscription._id);
    expect(retryResponse.status).toHaveBeenCalledWith(402);
    expect(retried.plan).toBe('starter');
    expect(retried.planChangeAttempt.state).toBe('pending_payment');
    expect(retried.planChangeAttempt.idempotencyToken).not.toBe(firstAttempt.idempotencyToken);
    expect(stripe.products.create).toHaveBeenCalledTimes(2);
    expect(stripe.prices.create).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);

    const freshAttempt = retried.planChangeAttempt;
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: freshAttempt.targetUnitAmountMinor,
      subscriptionItemId: freshAttempt.stripeSubscriptionItemId,
      priceId: freshAttempt.stripePriceId,
      invoiceId: freshAttempt.stripeInvoiceId,
      planChangeToken: freshAttempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'open',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: freshAttempt.stripeSubscriptionItemId,
          price: freshAttempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    }));
    await handleWebhook(expiredEvent);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      planChangeAttempt: expect.objectContaining({
        state: 'pending_payment',
        idempotencyToken: freshAttempt.idempotencyToken,
      }),
    });
  });

  test('paid additions are not applied locally or remotely during the introductory free period', async () => {
    const seller = await User.create({
      username: 'free-period-upgrade',
      email: 'free-period-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'free_period',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_free_period_upgrade',
      stripeSubscriptionId: 'sub_free_period_upgrade',
      freePeriodEndDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      hasUsedFreePeriod: true,
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: true },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      status: 'free_period',
      plan: 'starter',
      metaAdsIncluded: false,
      planChangeAttempt: expect.objectContaining({ state: null }),
    });
  });

  test('3DS-required upgrades return an explicit non-entitled action response', async () => {
    const seller = await User.create({
      username: 'action-required-upgrade',
      email: 'action-required-upgrade@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_action_required_upgrade',
      stripeSubscriptionId: 'sub_action_required_upgrade',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
      confirmationSecret: 'pi_action_secret_test',
      paymentIntentStatus: 'requires_action',
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_ACTION_REQUIRED',
      actionRequired: true,
      clientSecret: 'pi_action_secret_test',
    }));
    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(unchanged.plan).toBe('starter');
    expect(unchanged.planChangeAttempt.state).toBe('pending_payment');

    const attempt = unchanged.planChangeAttempt;
    const retryPendingStripeSubscription = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      invoiceId: attempt.stripeInvoiceId,
      planChangeToken: attempt.idempotencyToken,
      includeMetaAds: false,
      invoiceStatus: 'open',
      confirmationSecret: 'pi_action_secret_test',
      paymentIntentStatus: 'requires_action',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: attempt.stripeSubscriptionItemId,
          price: attempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    });
    retryPendingStripeSubscription.items.data[0].price = {
      id: attempt.sourceStripePriceId,
      product: { id: attempt.sourceStripeProductId },
      currency: 'usd',
      unit_amount: attempt.sourceUnitAmountMinor,
      recurring: { interval: 'month' },
      active: true,
    };
    stripe.subscriptions.retrieve.mockResolvedValue(retryPendingStripeSubscription);
    const retryResponse = responseMock();
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, retryResponse);
    expect(retryResponse.status).toHaveBeenCalledWith(409);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_ACTION_REQUIRED',
      clientSecret: 'pi_action_secret_test',
    }));
    expect(stripe.products.create).toHaveBeenCalledTimes(1);
    expect(stripe.prices.create).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      planChangeAttempt: expect.objectContaining({
        state: 'pending_payment',
        idempotencyToken: attempt.idempotencyToken,
      }),
    });
  });

  test.each([
    ['truncated item list', remote => { remote.items.has_more = true; }],
    ['multiple items', remote => { remote.items.data.push({ ...remote.items.data[0], id: 'si_extra' }); }],
    ['non-unit quantity', remote => { remote.items.data[0].quantity = 2; }],
    ['boolean quantity', remote => { remote.items.data[0].quantity = true; }],
    ['string unit amount', remote => { remote.items.data[0].price.unit_amount = String(remote.items.data[0].price.unit_amount); }],
    ['subscription discount', remote => { remote.discounts = [{ id: 'di_unauthorized' }]; }],
  ])('rejects %s before creating a Product, Price, or Stripe update', async (_label, mutateRemote) => {
    const seller = await User.create({
      username: `preflight-${new mongoose.Types.ObjectId()}`,
      email: `preflight-${new mongoose.Types.ObjectId()}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    const sourceAmount = buildPlanPricing('starter').unitAmount;
    const remote = stripeSubscriptionWithPrice({
      subscriptionId: `sub_preflight_${seller._id}`,
      customerId: `cus_preflight_${seller._id}`,
      unitAmount: sourceAmount,
    });
    mutateRemote(remote);
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: remote.customer,
      stripeSubscriptionId: remote.id,
      stripeProductId: remote.items.data[0].price.product.id,
      stripePriceId: remote.items.data[0].price.id,
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(remote);
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_SOURCE_MISMATCH',
    }));
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      planChangeAttempt: expect.objectContaining({ state: null }),
    });
  });

  test.each([
    ['boolean pending quantity', remote => { remote.pending_update.subscription_items[0].quantity = true; }],
    ['boolean invoice amount', remote => { remote.latest_invoice.lines.data[0].amount = true; }],
    ['boolean invoice quantity', remote => { remote.latest_invoice.lines.data[0].quantity = true; }],
    ['string amount remaining', remote => { remote.latest_invoice.amount_remaining = String(remote.latest_invoice.amount_remaining); }],
    ['boolean unit amount decimal', remote => { remote.latest_invoice.lines.data[0].pricing.unit_amount_decimal = true; }],
    [
      'a boolean expiry timestamp',
      remote => { remote.pending_update.expires_at = true; },
      503,
      'PLAN_CHANGE_RECOVERY_PENDING',
      'recoverable',
    ],
    [
      'an overflowing expiry timestamp',
      remote => { remote.pending_update.expires_at = Number.MAX_SAFE_INTEGER; },
      503,
      'PLAN_CHANGE_RECOVERY_PENDING',
      'recoverable',
    ],
  ])('rejects a pending update with %s instead of adopting its invoice', async (
    _label,
    mutatePending,
    expectedStatus = 409,
    expectedCode = 'PLAN_CHANGE_SUPERSEDED',
    expectedState = null,
  ) => {
    const seller = await User.create({
      username: `pending-shape-${new mongoose.Types.ObjectId()}`,
      email: `pending-shape-${new mongoose.Types.ObjectId()}@example.com`,
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: `cus_pending_shape_${seller._id}`,
      stripeSubscriptionId: `sub_pending_shape_${seller._id}`,
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
      paymentIntentStatus: 'requires_payment_method',
    });
    const exactUpdate = stripe.subscriptions.update.getMockImplementation();
    stripe.subscriptions.update.mockImplementation(async (...args) => {
      const remote = await exactUpdate(...args);
      mutatePending(remote);
      return remote;
    });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);

    expect(response.status).toHaveBeenCalledWith(expectedStatus);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: expectedCode,
    }));
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      planChangeAttempt: expect.objectContaining({ state: expectedState }),
    });
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);
  });

  test('same item and Price with a replacement invoice terminalizes the bound generation without adopting the new invoice', async () => {
    const seller = await User.create({
      username: 'immutable-plan-change-invoice',
      email: 'immutable-plan-change-invoice@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_immutable_invoice',
      stripeSubscriptionId: 'sub_immutable_invoice',
      hasUsedFreePeriod: true,
    });
    const sourceRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(sourceRemote);
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
      paymentIntentStatus: 'requires_payment_method',
    });
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, responseMock());
    const pending = await SellerSubscription.findById(subscription._id);
    const attempt = pending.planChangeAttempt;
    const originalInvoiceId = attempt.stripeInvoiceId;
    const replaced = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      productId: attempt.stripeProductId,
      invoiceId: 'in_replacement_same_price',
      invoiceStatus: 'open',
      paymentIntentStatus: 'requires_payment_method',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: attempt.stripeSubscriptionItemId,
          price: attempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    });
    replaced.items.data[0].price = sourceRemote.items.data[0].price;
    stripe.subscriptions.retrieve.mockResolvedValue(replaced);
    const retryResponse = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, retryResponse);

    expect(retryResponse.status).toHaveBeenCalledWith(409);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_SUPERSEDED',
      invoiceId: originalInvoiceId,
    }));
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      planChangeAttempt: expect.objectContaining({
        state: null,
        idempotencyToken: attempt.idempotencyToken,
        stripeInvoiceId: originalInvoiceId,
      }),
    });
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  test('a webhook repairs a Meta removal after Stripe succeeded but the HTTP process crashed before local save', async () => {
    const seller = await User.create({
      username: 'meta-removal-crash-recovery',
      email: 'meta-removal-crash-recovery@example.com',
      role: 'seller',
      isVerified: true,
    });
    const sourceAmount = buildPlanPricing('elite', true).unitAmount;
    const targetAmount = buildPlanPricing('elite', false).unitAmount;
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite + Meta Ads',
      metaAdsIncluded: true,
      stripeCustomerId: 'cus_meta_removal_crash',
      stripeSubscriptionId: 'sub_meta_removal_crash',
      stripeProductId: 'prod_meta_source',
      stripePriceId: 'price_meta_source',
      bonusFeaturesActive: true,
      planChangeAttempt: {
        idempotencyToken: 'token_meta_removal_crash',
        requestFingerprint: 'fingerprint_meta_removal_crash',
        changeKind: 'meta_removal',
        stripeSubscriptionId: 'sub_meta_removal_crash',
        stripeSubscriptionItemId: 'si_subscription_plan',
        stripeProductId: 'prod_meta_target',
        stripePriceId: 'price_meta_target',
        sourcePlan: 'elite',
        sourcePlanName: 'Rozare Elite + Meta Ads',
        sourceIncludeMetaAds: true,
        sourceUnitAmountMinor: sourceAmount,
        sourceStripeProductId: 'prod_meta_source',
        sourceStripePriceId: 'price_meta_source',
        sourceBonusFeaturesActive: true,
        targetPlan: 'elite',
        targetPlanName: 'Rozare Elite',
        targetIncludeMetaAds: false,
        targetUnitAmountMinor: targetAmount,
        state: 'recoverable',
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: targetAmount,
      productId: 'prod_meta_target',
      priceId: 'price_meta_target',
      invoiceStatus: 'open',
    }));

    await handleWebhook({
      id: 'evt_meta_removal_crash_recovery',
      created: 400,
      type: 'customer.subscription.updated',
      data: { object: { id: subscription.stripeSubscriptionId } },
    });

    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      planName: 'Rozare Elite',
      metaAdsIncluded: false,
      stripeProductId: 'prod_meta_target',
      stripePriceId: 'price_meta_target',
      planChangeAttempt: expect.objectContaining({ state: 'applied' }),
    });
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_completed',
    })).toBe(4);
  });

  test('plan-change completion is handed to four exact-money outbox channels once', async () => {
    const seller = await User.create({
      username: 'plan-notification-outbox',
      email: 'plan-notification-outbox@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_plan_notification_outbox',
      stripeSubscriptionId: 'sub_plan_notification_outbox',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({ customerId: subscription.stripeCustomerId });

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, responseMock());

    let current = await SellerSubscription.findById(subscription._id);
    expect(current.planChangeAttempt).toMatchObject({
      state: 'applied',
      notificationState: 'outboxed',
      notificationEmailState: 'outboxed',
      notificationInAppState: 'outboxed',
      notificationPushState: 'outboxed',
      notificationWhatsAppState: 'outboxed',
    });
    let rows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_completed',
    }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => (
      row.recipient.audienceRole === 'seller'
      && row.money?.[0]?.amountMinor === buildPlanPricing('elite').unitAmount
      && row.money?.[0]?.currency === 'USD'
      && [row.payload.body, row.payload.text, row.payload.html, row.payload.message]
        .join(' ').includes('$21.65')
    ))).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);

    const retryResponse = responseMock();
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, retryResponse);
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    rows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_completed',
    }).lean();
    expect(rows).toHaveLength(4);
    current = await SellerSubscription.findById(subscription._id);
    expect(current.planChangeAttempt.notificationState).toBe('outboxed');
  });

  test('failed subscription payment freezes the exact outstanding amount and outboxes four channels once', async () => {
    const fixture = await paymentNotificationFixture('failure-outbox');
    const event = {
      id: 'evt_payment_notification_failure_outbox',
      created: 100,
      type: 'invoice.payment_failed',
      data: { object: fixture.failedInvoice },
    };

    await handleWebhook(event);

    let [subscription, store] = await Promise.all([
      SellerSubscription.findById(fixture.subscription._id),
      Store.findById(fixture.store._id),
    ]);
    expect(subscription.status).toBe('past_due');
    expect(subscription.paymentRisk.suspended).toBe(true);
    expect(subscription.paymentRisk.failureNotification).toMatchObject({
      invoiceId: fixture.invoiceId,
      state: 'outboxed',
      amountDueMinor: fixture.failedInvoice.amount_remaining,
      currency: 'USD',
      occurredAt: expect.any(Date),
      emailState: 'outboxed',
      inAppState: 'outboxed',
      pushState: 'outboxed',
      whatsAppState: 'outboxed',
    });
    expect(store.isActive).toBe(false);
    let rows = await NotificationOutbox.find({
      aggregateId: String(fixture.subscription._id),
      eventType: 'subscription.payment_failed',
    }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => (
      row.recipient.audienceRole === 'seller'
      && row.recipient.allowBlocked === true
      && row.money?.[0]?.amountMinor === fixture.failedInvoice.amount_remaining
      && row.money?.[0]?.currency === 'USD'
      && [row.payload.body, row.payload.text, row.payload.html, row.payload.message]
        .join(' ').includes('$9.99')
    ))).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ user: fixture.seller._id })).toBe(0);

    await handleWebhook(event);
    rows = await NotificationOutbox.find({
      aggregateId: String(fixture.subscription._id),
      eventType: 'subscription.payment_failed',
    }).lean();
    expect(rows).toHaveLength(4);
    subscription = await SellerSubscription.findById(fixture.subscription._id);
    expect(subscription.paymentRisk.failureNotification.state).toBe('outboxed');
  });
  test('a recovered payment is handed to the exact-amount outbox without legacy channel duplicates', async () => {
    const fixture = await paymentNotificationFixture('recovery-retry');
    const failedEvent = {
      id: 'evt_payment_notification_recovery_failed',
      created: 100,
      type: 'invoice.payment_failed',
      data: { object: fixture.failedInvoice },
    };
    await handleWebhook(failedEvent);
    sendEmail.mockClear();
    notifySeller.mockClear();

    const recoveredEvent = {
      id: 'evt_payment_notification_recovered',
      created: 101,
      type: 'invoice.payment_succeeded',
      data: { object: fixture.paidInvoice },
    };
    await expect(handleWebhook(recoveredEvent)).resolves.toBeUndefined();

    let [subscription, store, payment] = await Promise.all([
      SellerSubscription.findById(fixture.subscription._id),
      Store.findById(fixture.store._id),
      StripeEntitlementPayment.findOne({ invoiceId: fixture.invoiceId }),
    ]);
    expect(subscription.status).toBe('active');
    expect(subscription.paymentRisk.suspended).toBe(false);
    expect(store.isActive).toBe(true);
    expect(payment.recoveryNotification).toMatchObject({
      state: 'outboxed',
      failureInvoiceId: fixture.invoiceId,
    });
    expect(payment.paymentNotification).toMatchObject({
      kind: 'recovered',
      occurredAt: expect.any(Date),
      outboxEnqueuedAt: expect.any(Date),
    });
    let receiptRows = await NotificationOutbox.find({
      aggregateId: String(payment._id),
      eventType: 'subscription.payment_recovered',
    }).lean();
    expect(receiptRows).toHaveLength(4);
    expect(receiptRows.every(row => (
      row.money?.[0]?.amountMinor === 999
      && row.money?.[0]?.currency === 'USD'
    ))).toBe(true);
    expect(await Notification.countDocuments({ user: fixture.seller._id })).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();

    await handleWebhook(recoveredEvent);

    payment = await StripeEntitlementPayment.findOne({ invoiceId: fixture.invoiceId });
    expect(payment.recoveryNotification.state).toBe('outboxed');
    receiptRows = await NotificationOutbox.find({
      aggregateId: String(payment._id),
      eventType: 'subscription.payment_recovered',
    }).lean();
    expect(receiptRows).toHaveLength(4);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ user: fixture.seller._id })).toBe(0);

    const deliveryCounts = {
      email: sendEmail.mock.calls.length,
      whatsApp: notifySeller.mock.calls.length,
    };
    await handleWebhook(failedEvent);
    expect(sendEmail).toHaveBeenCalledTimes(deliveryCounts.email);
    expect(notifySeller).toHaveBeenCalledTimes(deliveryCounts.whatsApp);
  });

  test('cancellation winning after plan preflight voids the late unpaid update and never resumes cancellation', async () => {
    const seller = await User.create({
      username: 'cancel-plan-race',
      email: 'cancel-plan-race@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_plan_race',
      stripeSubscriptionId: 'sub_cancel_plan_race',
      hasUsedFreePeriod: true,
    });
    const sourceRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(sourceRemote);
    let resolvePlanMutation;
    stripe.subscriptions.update.mockImplementation(async (_subscriptionId, params) => {
      if (!params.items) return { id: subscription.stripeSubscriptionId, cancel_at_period_end: true };
      return new Promise(resolve => { resolvePlanMutation = resolve; });
    });
    const upgradeResponse = responseMock();
    const upgradePromise = upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, upgradeResponse);
    await waitUntilCalled(stripe.subscriptions.update);

    const cancelResponse = responseMock();
    await cancelSubscription({ user: { id: seller._id.toString() } }, cancelResponse);
    expect(cancelResponse.status).not.toHaveBeenCalled();
    const racedAttempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;
    const targetPrice = stripe.prices.create.mock.calls[0][0];
    resolvePlanMutation(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: targetPrice.unit_amount,
      subscriptionItemId: racedAttempt.stripeSubscriptionItemId,
      priceId: racedAttempt.stripePriceId,
      productId: racedAttempt.stripeProductId,
      invoiceStatus: 'open',
      paymentIntentStatus: 'requires_payment_method',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: racedAttempt.stripeSubscriptionItemId,
          price: racedAttempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    }));
    await upgradePromise;

    expect(upgradeResponse.status).toHaveBeenCalledWith(409);
    expect(upgradeResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_SUPERSEDED',
    }));
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.update.mock.calls.some(([, params]) => params.cancel_at_period_end === false)).toBe(false);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      cancelledAt: expect.any(Date),
      planChangeAttempt: expect.objectContaining({ state: null }),
    });
  });

  test('cancellation winning after plan preflight still records an exact already-paid update without resuming cancellation', async () => {
    const seller = await User.create({
      username: 'cancel-paid-plan-race',
      email: 'cancel-paid-plan-race@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_paid_plan_race',
      stripeSubscriptionId: 'sub_cancel_paid_plan_race',
      hasUsedFreePeriod: true,
    });
    const sourceRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(sourceRemote);
    let resolvePlanMutation;
    stripe.subscriptions.update.mockImplementation(async (_subscriptionId, params) => {
      if (!params.items) return { id: subscription.stripeSubscriptionId, cancel_at_period_end: true };
      return new Promise(resolve => { resolvePlanMutation = resolve; });
    });
    const upgradeResponse = responseMock();
    const upgradePromise = upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, upgradeResponse);
    await waitUntilCalled(stripe.subscriptions.update);

    await cancelSubscription(
      { user: { id: seller._id.toString() } },
      responseMock(),
    );
    const racedAttempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;
    const paidRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: racedAttempt.targetUnitAmountMinor,
      subscriptionItemId: racedAttempt.stripeSubscriptionItemId,
      priceId: racedAttempt.stripePriceId,
      productId: racedAttempt.stripeProductId,
      invoiceStatus: 'paid',
      paymentIntentStatus: 'succeeded',
    });
    stripe.subscriptions.retrieve.mockResolvedValue(paidRemote);
    resolvePlanMutation(paidRemote);
    await upgradePromise;

    expect(upgradeResponse.status).not.toHaveBeenCalled();
    expect(upgradeResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      cancellationScheduled: true,
      subscription: expect.objectContaining({ plan: 'elite' }),
    }));
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update.mock.calls.some(([, params]) => params.cancel_at_period_end === false)).toBe(false);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      cancelledAt: expect.any(Date),
      planChangeAttempt: expect.objectContaining({
        state: 'applied',
        idempotencyToken: racedAttempt.idempotencyToken,
      }),
    });
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(1);
  });

  test('post-mutation compensation converges payment that wins the exact pending-invoice void race', async () => {
    const seller = await User.create({
      username: 'cancel-compensation-void-race',
      email: 'cancel-compensation-void-race@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_compensation_void_race',
      stripeSubscriptionId: 'sub_cancel_compensation_void_race',
      hasUsedFreePeriod: true,
    });
    const sourceRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(sourceRemote);
    let resolvePlanMutation;
    stripe.subscriptions.update.mockImplementation(async (_subscriptionId, params) => {
      if (!params.items) return { id: subscription.stripeSubscriptionId, cancel_at_period_end: true };
      return new Promise(resolve => { resolvePlanMutation = resolve; });
    });
    const upgradeResponse = responseMock();
    const upgradePromise = upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, upgradeResponse);
    await waitUntilCalled(stripe.subscriptions.update);
    await cancelSubscription(
      { user: { id: seller._id.toString() } },
      responseMock(),
    );

    const racedAttempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;
    const invoiceId = 'in_cancel_compensation_void_race';
    const stalePending = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: racedAttempt.targetUnitAmountMinor,
      subscriptionItemId: racedAttempt.stripeSubscriptionItemId,
      priceId: racedAttempt.stripePriceId,
      productId: racedAttempt.stripeProductId,
      invoiceId,
      invoiceStatus: 'open',
      paymentIntentStatus: 'processing',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: racedAttempt.stripeSubscriptionItemId,
          price: racedAttempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    });
    stalePending.items.data[0].price = sourceRemote.items.data[0].price;
    const paidWinner = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: racedAttempt.targetUnitAmountMinor,
      subscriptionItemId: racedAttempt.stripeSubscriptionItemId,
      priceId: racedAttempt.stripePriceId,
      productId: racedAttempt.stripeProductId,
      invoiceId,
      invoiceStatus: 'paid',
      paymentIntentStatus: 'succeeded',
    });
    const paidConflict = new Error('Invoice is no longer open and cannot be voided.');
    paidConflict.code = 'invoice_not_open';
    paidConflict.statusCode = 400;
    stripe.invoices.voidInvoice.mockRejectedValueOnce(paidConflict);
    stripe.subscriptions.retrieve.mockResolvedValue(paidWinner);
    resolvePlanMutation(stalePending);
    await upgradePromise;

    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      invoiceId,
      {},
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^rozare-plan-change-void-/) }),
    );
    expect(upgradeResponse.status).not.toHaveBeenCalled();
    expect(upgradeResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      cancellationScheduled: true,
      subscription: expect.objectContaining({ plan: 'elite' }),
    }));
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      cancelledAt: expect.any(Date),
      planChangeAttempt: expect.objectContaining({
        state: 'applied',
        stripeInvoiceId: invoiceId,
        idempotencyToken: racedAttempt.idempotencyToken,
      }),
    });
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId,
    })).toBe(1);
  });

  test('cancellation supersession converges payment that wins after the exact pending-invoice preflight', async () => {
    const seller = await User.create({
      username: 'cancel-supersede-void-race',
      email: 'cancel-supersede-void-race@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_supersede_void_race',
      stripeSubscriptionId: 'sub_cancel_supersede_void_race',
      hasUsedFreePeriod: true,
    });
    const sourceRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(sourceRemote);
    mockPaidPlanChangeUpdate({
      customerId: subscription.stripeCustomerId,
      invoiceStatus: 'open',
      pending: true,
      paymentIntentStatus: 'processing',
    });
    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, responseMock());
    const attempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;
    const stalePending = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      productId: attempt.stripeProductId,
      invoiceId: attempt.stripeInvoiceId,
      invoiceStatus: 'open',
      paymentIntentStatus: 'processing',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: attempt.stripeSubscriptionItemId,
          price: attempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    });
    stalePending.items.data[0].price = sourceRemote.items.data[0].price;
    const paidWinner = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      productId: attempt.stripeProductId,
      invoiceId: attempt.stripeInvoiceId,
      invoiceStatus: 'paid',
      paymentIntentStatus: 'succeeded',
    });
    stripe.subscriptions.update.mockResolvedValue({
      id: subscription.stripeSubscriptionId,
      cancel_at_period_end: true,
    });
    stripe.subscriptions.retrieve
      .mockResolvedValueOnce(stalePending)
      .mockResolvedValueOnce(paidWinner);
    const paidConflict = new Error('Invoice is already paid.');
    paidConflict.code = 'invoice_not_open';
    paidConflict.statusCode = 400;
    stripe.invoices.voidInvoice.mockRejectedValueOnce(paidConflict);
    const cancelResponse = responseMock();

    await cancelSubscription({ user: { id: seller._id.toString() } }, cancelResponse);

    expect(cancelResponse.status).not.toHaveBeenCalled();
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.update.mock.calls.some(([, params]) => params.cancel_at_period_end === false)).toBe(false);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'elite',
      cancelledAt: expect.any(Date),
      planChangeAttempt: expect.objectContaining({
        state: 'applied',
        stripeInvoiceId: attempt.stripeInvoiceId,
        idempotencyToken: attempt.idempotencyToken,
      }),
    });
    expect(await StripeEntitlementPayment.countDocuments({
      seller: seller._id,
      invoiceId: attempt.stripeInvoiceId,
    })).toBe(1);
  });

  test('a persisted cancellation intent resumes the same Stripe scheduling operation after a crash', async () => {
    const seller = await User.create({
      username: 'cancel-crash-resume',
      email: 'cancel-crash-resume@example.com',
      role: 'seller',
      isVerified: true,
    });
    const cancelledAt = new Date(Date.now() - 5_000);
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_crash_resume',
      stripeSubscriptionId: 'sub_cancel_crash_resume',
      cancelledAt,
    });
    stripe.subscriptions.update.mockResolvedValue({
      id: subscription.stripeSubscriptionId,
      cancel_at_period_end: true,
    });
    const response = responseMock();

    await cancelSubscription({ user: { id: seller._id.toString() } }, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `rozare-cancel-${subscription._id}-${cancelledAt.getTime()}` },
    );
  });

  test('a persisted downgrade intent resumes Stripe cancellation and supersedes its exact pending add-on invoice', async () => {
    const seller = await User.create({
      username: 'downgrade-crash-resume',
      email: 'downgrade-crash-resume@example.com',
      role: 'seller',
      isVerified: true,
    });
    const scheduledAt = new Date(Date.now() - 5_000);
    const sourceAmount = buildPlanPricing('elite', false).unitAmount;
    const targetAmount = buildPlanPricing('elite', true).unitAmount;
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      metaAdsIncluded: false,
      stripeCustomerId: 'cus_downgrade_crash_resume',
      stripeSubscriptionId: 'sub_downgrade_crash_resume',
      stripeProductId: 'prod_downgrade_source',
      stripePriceId: 'price_downgrade_source',
      cancelledAt: scheduledAt,
      pendingDowngrade: { toPlan: 'starter', scheduledAt, activationPending: false },
      planChangeAttempt: {
        idempotencyToken: 'token_downgrade_pending',
        requestFingerprint: 'fingerprint_downgrade_pending',
        changeKind: 'meta_addition',
        stripeSubscriptionId: 'sub_downgrade_crash_resume',
        stripeSubscriptionItemId: 'si_subscription_plan',
        stripeProductId: 'prod_downgrade_target',
        stripePriceId: 'price_downgrade_target',
        stripeInvoiceId: 'in_downgrade_pending',
        sourcePlan: 'elite',
        sourcePlanName: 'Rozare Elite',
        sourceIncludeMetaAds: false,
        sourceUnitAmountMinor: sourceAmount,
        sourceStripeProductId: 'prod_downgrade_source',
        sourceStripePriceId: 'price_downgrade_source',
        targetPlan: 'elite',
        targetPlanName: 'Rozare Elite + Meta Ads',
        targetIncludeMetaAds: true,
        targetUnitAmountMinor: targetAmount,
        state: 'pending_payment',
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    const pendingRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: targetAmount,
      productId: 'prod_downgrade_target',
      priceId: 'price_downgrade_target',
      invoiceId: 'in_downgrade_pending',
      invoiceStatus: 'open',
      paymentIntentStatus: 'requires_payment_method',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: 'si_subscription_plan',
          price: 'price_downgrade_target',
          quantity: 1,
          discounts: [],
        }],
      },
    });
    pendingRemote.items.data[0].price = {
      id: 'price_downgrade_source',
      product: { id: 'prod_downgrade_source' },
      currency: 'usd',
      unit_amount: sourceAmount,
      recurring: { interval: 'month' },
      active: true,
    };
    const afterVoid = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: sourceAmount,
      productId: 'prod_downgrade_source',
      priceId: 'price_downgrade_source',
    });
    stripe.subscriptions.retrieve
      .mockResolvedValueOnce(pendingRemote)
      .mockResolvedValueOnce(afterVoid);
    stripe.subscriptions.update.mockResolvedValue({
      id: subscription.stripeSubscriptionId,
      cancel_at_period_end: true,
    });
    const response = responseMock();

    await downgradeToStarter({ user: { id: seller._id.toString() } }, response);

    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(
      'in_downgrade_pending',
      {},
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^rozare-plan-change-void-/) }),
    );
    const persistedDowngrade = await SellerSubscription.findById(subscription._id);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `rozare-downgrade-schedule-${subscription._id}-${persistedDowngrade.pendingDowngrade.operationKey}` },
    );
    expect(persistedDowngrade.toObject()).toMatchObject({
      cancelledAt: scheduledAt,
      pendingDowngrade: expect.objectContaining({
        toPlan: 'starter',
        targetUnitAmountMinor: buildPlanPricing('starter').unitAmount,
        targetCurrency: 'usd',
        notificationCompletedAt: expect.any(Date),
      }),
      planChangeAttempt: expect.objectContaining({ state: null }),
    });
  });

  test('concurrent downgrade schedules freeze one founder quote and one durable notification generation', async () => {
    const seller = await User.create({
      username: 'downgrade-quote-concurrent',
      email: 'downgrade-quote-concurrent@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_quote_concurrent',
      stripeSubscriptionId: 'sub_downgrade_quote_concurrent',
      starterBonusPeriodUsed: false,
      founderOffer: {
        active: true,
        code: 'FIRST100',
        // Eligibility is persisted, but a stale descriptive percentage must
        // never change the canonical founder price or its notification quote.
        discountPercent: 12.34,
        claimedAt: new Date(),
        source: 'coupon',
      },
    });
    stripe.subscriptions.update.mockResolvedValue({
      id: subscription.stripeSubscriptionId,
      cancel_at_period_end: true,
    });
    const firstResponse = responseMock();
    const secondResponse = responseMock();

    await Promise.all([
      downgradeToStarter({ user: { id: seller._id.toString() } }, firstResponse),
      downgradeToStarter({ user: { id: seller._id.toString() } }, secondResponse),
    ]);

    expect(firstResponse.status).not.toHaveBeenCalled();
    expect(secondResponse.status).not.toHaveBeenCalled();
    const persisted = await SellerSubscription.findById(subscription._id);
    expect(persisted.pendingDowngrade).toMatchObject({
      toPlan: 'starter',
      sourceStripeSubscriptionId: subscription.stripeSubscriptionId,
      targetPlanName: 'Rozare Starter',
      targetUnitAmountMinor: buildPlanPricing('starter', false, true).unitAmount,
      targetCurrency: 'usd',
      founderRateApplied: true,
      founderDiscountPercent: 40,
      founderOfferCode: 'FIRST100',
      starterBonusEligible: true,
      scheduledAt: expect.any(Date),
      quoteFrozenAt: expect.any(Date),
      stripeScheduledAt: expect.any(Date),
      notificationCompletedAt: expect.any(Date),
    });
    expect(String(persisted.pendingDowngrade.operationKey)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    const idempotencyKeys = stripe.subscriptions.update.mock.calls.map(call => call[2].idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(1);

    const rows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.downgrade_scheduled',
    }).lean();
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => (
      row.recipient.audienceRole === 'seller'
      && row.money?.[0]?.amountMinor === buildPlanPricing('starter', false, true).unitAmount
      && row.money?.[0]?.currency === 'USD'
      && [row.payload.body, row.payload.text, row.payload.html, row.payload.message]
        .join(' ').includes('$5.99')
    ))).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
  });

  test('trial-expiration scan never mislabels a scheduled Elite to Starter downgrade as cancellation', async () => {
    const seller = await User.create({
      username: 'downgrade-warning-scope',
      email: 'downgrade-warning-scope@example.com',
      role: 'seller',
      isVerified: true,
    });
    const scheduledAt = new Date();
    const periodEnd = new Date(scheduledAt.getTime() + 24 * 60 * 60 * 1000);
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_warning_scope',
      stripeSubscriptionId: 'sub_downgrade_warning_scope',
      currentPeriodStart: new Date(scheduledAt.getTime() - 27 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: periodEnd,
      cancelledAt: scheduledAt,
      warningEmailSent: false,
      founderOffer: {
        active: true,
        code: 'FIRST100',
        discountPercent: 40,
        claimedAt: scheduledAt,
        source: 'coupon',
      },
      pendingDowngrade: {
        toPlan: 'starter',
        scheduledAt,
        activationPending: false,
      },
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Downgrade Warning Scope',
      storeSlug: 'downgrade-warning-scope',
      isActive: true,
    });

    await processTrialExpirations();

    const unchanged = await SellerSubscription.findById(subscription._id);
    expect(unchanged.warningEmailSent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: String(subscription._id),
      eventType: 'subscription.ending_soon',
    })).toBe(0);
  });

  test('trial-expiration outbox does not re-offer an introductory period the seller already used', async () => {
    const seller = await User.create({
      username: 'trial-warning-intro-exhausted',
      email: 'trial-warning-intro-exhausted@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialStartDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      trialEndDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      hasUsedFreePeriod: true,
      warningEmailSent: false,
    });
    // Legacy rows can predate persistence of schema defaults.
    await SellerSubscription.updateOne(
      { _id: subscription._id },
      { $unset: { warningEmailSent: 1 } },
    );
    await Store.create({
      seller: seller._id,
      storeName: 'Intro Exhausted Warning',
      storeSlug: 'intro-exhausted-warning',
      isActive: true,
    });

    await processTrialExpirations();

    const rows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.trial_expiring',
    }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => (
      row.money?.find(money => money.key === 'starter_standard')?.amountMinor === 999
      && row.money?.find(money => money.key === 'starter_founder')?.amountMinor === 599
    ))).toBe(true);
    const content = rows.map(row => (
      [row.payload.body, row.payload.text, row.payload.html, row.payload.message].join(' ')
    )).join(' ');
    expect(content).toContain('$9.99');
    expect(content).toContain('already used the one-time introductory period');
    expect(content).not.toContain('still available after Checkout');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    const current = await SellerSubscription.findById(subscription._id);
    expect(current.warningEmailSent).toBe(true);
    expect(current.lifecyclePricing.trialExpiring).toMatchObject({
      eventAt: subscription.trialEndDate,
      starterStandardAmountMinor: 999,
      starterFounderAmountMinor: 599,
      starterFreePeriodDays: 30,
    });
    expect(rows.every(row => row.money.every(money => (
      money.sourceModel === 'SellerSubscription'
      && money.sourceDocumentId === String(subscription._id)
      && money.sourcePath.startsWith('lifecyclePricing.trialExpiring.')
    )))).toBe(true);
  });

  test('trial warning freezes pricing before outbox work and resumes a partial four-channel enqueue', async () => {
    const seller = await User.create({
      username: 'trial-warning-partial-replay',
      email: 'trial-warning-partial-replay@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialStartDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      trialEndDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      hasUsedFreePeriod: false,
      warningEmailSent: false,
    });

    const originalFindOneAndUpdate = NotificationOutbox.findOneAndUpdate.bind(NotificationOutbox);
    let outboxWrites = 0;
    const outboxFailure = jest.spyOn(NotificationOutbox, 'findOneAndUpdate')
      .mockImplementation((...args) => {
        outboxWrites += 1;
        if (outboxWrites === 2) {
          return {
            select: () => Promise.reject(new Error('simulated second-channel outbox outage')),
          };
        }
        return originalFindOneAndUpdate(...args);
      });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await processTrialExpirations();

    const interrupted = await SellerSubscription.findById(subscription._id);
    expect(interrupted.warningEmailSent).toBe(false);
    expect(interrupted.lifecyclePricing.trialExpiring).toMatchObject({
      eventAt: subscription.trialEndDate,
      starterStandardAmountMinor: 999,
      starterFounderAmountMinor: 599,
      starterFreePeriodDays: 30,
    });
    expect(await NotificationOutbox.countDocuments({
      aggregateId: String(subscription._id),
      eventType: 'subscription.trial_expiring',
    })).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(
      'Process trial expirations error:',
      expect.objectContaining({ message: 'simulated second-channel outbox outage' }),
    );

    outboxFailure.mockRestore();
    consoleError.mockRestore();
    await processTrialExpirations();
    await processTrialExpirations();

    const [current, rows] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      NotificationOutbox.find({
        aggregateId: String(subscription._id),
        eventType: 'subscription.trial_expiring',
      }).select('+dedupeKey').lean(),
    ]);
    expect(current.warningEmailSent).toBe(true);
    expect(current.lifecyclePricing.trialExpiring).toMatchObject(
      interrupted.lifecyclePricing.trialExpiring.toObject(),
    );
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(new Set(rows.map(row => row.dedupeKey)).size).toBe(4);
  });

  test('bonus-expiry outbox uses persisted founder eligibility and never re-offers an exhausted Elite intro', async () => {
    const seller = await User.create({
      username: 'bonus-warning-founder-price',
      email: 'bonus-warning-founder-price@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      hasUsedFreePeriod: true,
      bonusFeaturesActive: true,
      bonusExpiryDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      bonusExpiryWarningEmailSent: false,
      founderOffer: {
        active: true,
        code: 'FIRST100',
        discountPercent: 40,
        claimedAt: new Date(),
        source: 'coupon',
      },
    });
    // Simulate a pre-workflow record where this default was never persisted.
    await SellerSubscription.updateOne(
      { _id: subscription._id },
      { $unset: { bonusExpiryWarningEmailSent: 1 } },
    );
    await Store.create({
      seller: seller._id,
      storeName: 'Founder Bonus Warning',
      storeSlug: 'founder-bonus-warning',
      isActive: true,
    });

    await processTrialExpirations();

    const rows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.bonus_expiring',
    }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => (
      row.money?.[0]?.amountMinor === 1299
      && row.money?.[0]?.currency === 'USD'
    ))).toBe(true);
    const content = rows.map(row => (
      [row.payload.body, row.payload.text, row.payload.html, row.payload.message].join(' ')
    )).join(' ');
    expect(content).toContain('$12.99');
    expect(content).not.toContain('$21.65');
    expect(content).toContain('No new introductory period will be added');
    expect(content).not.toContain('45-day Elite introductory period remains available');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    const current = await SellerSubscription.findById(subscription._id);
    expect(current.bonusExpiryWarningEmailSent).toBe(true);
    expect(current.lifecyclePricing.bonusExpiring).toMatchObject({
      eventAt: subscription.bonusExpiryDate,
      eliteAmountMinor: 1299,
      eliteFreePeriodDays: 45,
    });
    expect(rows.every(row => row.money?.[0]?.sourcePath === 'lifecyclePricing.bonusExpiring.eliteAmountMinor')).toBe(true);
  });

  test('ordinary subscription-ending warning outboxes four seller channels and excludes no downgrade truth', async () => {
    const seller = await User.create({
      username: 'ordinary-ending-warning',
      email: 'ordinary-ending-warning@example.com',
      role: 'seller',
      isVerified: true,
    });
    const now = new Date();
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeSubscriptionId: 'sub_ordinary_ending_warning',
      currentPeriodStart: new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      cancelledAt: now,
      warningEmailSent: false,
      pendingDowngrade: { toPlan: null, scheduledAt: null, activationPending: false },
      founderOffer: {
        active: true,
        code: 'FIRST100',
        discountPercent: 40,
        claimedAt: now,
        source: 'coupon',
      },
    });
    // Legacy rows can predate persistence of schema defaults.
    await SellerSubscription.updateOne(
      { _id: subscription._id },
      { $unset: { warningEmailSent: 1 } },
    );

    await processTrialExpirations();

    const rows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.ending_soon',
    }).lean();
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => row.recipient.audienceRole === 'seller')).toBe(true);
    expect(rows.map(row => (
      [row.payload.body, row.payload.text, row.payload.html, row.payload.message].join(' ')
    )).join(' ')).toContain('founder rate is forfeited only when this subscription actually ends');
    expect((await SellerSubscription.findById(subscription._id)).warningEmailSent).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
  });

  test('expired seller trial blocks once and outboxes four channels without a false free-period offer', async () => {
    const seller = await User.create({
      username: 'trial-block-outbox',
      email: 'trial-block-outbox@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'trial',
      plan: 'free_trial',
      trialStartDate: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000),
      trialEndDate: new Date(Date.now() - 60 * 1000),
      hasUsedFreePeriod: true,
    });
    const store = await Store.create({
      seller: seller._id,
      storeName: 'Trial Block Outbox',
      storeSlug: 'trial-block-outbox',
      isActive: true,
    });

    await processTrialExpirations();
    await processTrialExpirations();

    const [current, currentStore, rows] = await Promise.all([
      SellerSubscription.findById(subscription._id),
      Store.findById(store._id),
      NotificationOutbox.find({
        aggregateId: String(subscription._id),
        eventType: 'subscription.trial_blocked',
      }).lean(),
    ]);
    expect(current).toMatchObject({
      status: 'blocked',
      trialBlockedNotificationEventAt: expect.any(Date),
      trialBlockedNotificationEnqueuedAt: expect.any(Date),
    });
    expect(currentStore.isActive).toBe(false);
    expect(rows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(rows.every(row => row.recipient.allowBlocked === true)).toBe(true);
    const content = rows.map(row => (
      [row.payload.body, row.payload.text, row.payload.html, row.payload.message].join(' ')
    )).join(' ');
    expect(content).toContain('already used');
    expect(content).not.toContain('remains available at Checkout');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
  });

  test('bonus and grace expiries freeze persisted founder pricing and outbox each transition once', async () => {
    const [founderSeller, standardSeller] = await Promise.all([
      User.create({
        username: 'bonus-expired-founder',
        email: 'bonus-expired-founder@example.com',
        role: 'seller',
        isVerified: true,
      }),
      User.create({
        username: 'bonus-grace-standard',
        email: 'bonus-grace-standard@example.com',
        role: 'seller',
        isVerified: true,
      }),
    ]);
    const past = new Date(Date.now() - 60 * 1000);
    const [expiredBonus, expiredGrace] = await Promise.all([
      SellerSubscription.create({
        seller: founderSeller._id,
        status: 'active',
        plan: 'starter',
        planName: 'Rozare Starter',
        hasUsedFreePeriod: true,
        bonusFeaturesActive: true,
        bonusExpiryDate: past,
        founderOffer: {
          active: true,
          code: 'FIRST100',
          discountPercent: 40,
          claimedAt: new Date(),
          source: 'coupon',
        },
      }),
      SellerSubscription.create({
        seller: standardSeller._id,
        status: 'blocked',
        plan: 'starter',
        planName: 'Rozare Starter',
        hasUsedFreePeriod: true,
        bonusFeaturesActive: true,
        bonusGraceDeadline: past,
        bonusFeaturesExpiredPermanently: false,
      }),
    ]);

    await processTrialExpirations();
    await processTrialExpirations();

    const [bonusRows, graceRows, currentBonus, currentGrace] = await Promise.all([
      NotificationOutbox.find({
        aggregateId: String(expiredBonus._id),
        eventType: 'subscription.bonus_expired',
      }).lean(),
      NotificationOutbox.find({
        aggregateId: String(expiredGrace._id),
        eventType: 'subscription.bonus_removed',
      }).lean(),
      SellerSubscription.findById(expiredBonus._id),
      SellerSubscription.findById(expiredGrace._id),
    ]);
    expect(bonusRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(graceRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(bonusRows.every(row => row.money?.[0]?.amountMinor === 1299)).toBe(true);
    expect(graceRows.every(row => row.money?.[0]?.amountMinor === 2165)).toBe(true);
    expect(currentBonus).toMatchObject({
      bonusFeaturesActive: false,
      bonusFeaturesExpiredPermanently: true,
      bonusExpiredNotificationEventAt: expect.any(Date),
      bonusExpiredNotificationEnqueuedAt: expect.any(Date),
      lifecyclePricing: {
        bonusExpired: {
          eventAt: past,
          eliteAmountMinor: 1299,
          eliteFreePeriodDays: 45,
        },
      },
    });
    expect(currentGrace).toMatchObject({
      bonusFeaturesActive: false,
      bonusFeaturesExpiredPermanently: true,
      bonusGraceDeadline: null,
      bonusGraceExpiredNotificationEventAt: expect.any(Date),
      bonusGraceExpiredNotificationEnqueuedAt: expect.any(Date),
      lifecyclePricing: {
        bonusRemoved: {
          eventAt: past,
          eliteAmountMinor: 2165,
          eliteFreePeriodDays: 45,
        },
      },
    });
  });

  test('automatic downgrade charges the frozen quote even when the live catalog differs', async () => {
    const seller = await User.create({
      username: 'downgrade-catalog-drift',
      email: 'downgrade-catalog-drift@example.com',
      role: 'seller',
      isVerified: true,
    });
    const scheduledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const frozenAmountMinor = 777;
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_catalog_drift',
      stripeSubscriptionId: 'sub_downgrade_catalog_drift_ended',
      starterBonusPeriodUsed: true,
      pendingDowngrade: {
        toPlan: 'starter',
        scheduledAt,
        operationKey: 'frozen-catalog-drift-operation',
        sourceStripeSubscriptionId: 'sub_downgrade_catalog_drift_ended',
        targetPlanName: 'Rozare Starter',
        targetUnitAmountMinor: frozenAmountMinor,
        targetCurrency: 'usd',
        founderRateApplied: false,
        founderDiscountPercent: 0,
        founderOfferCode: null,
        starterBonusEligible: false,
        quoteFrozenAt: scheduledAt,
        stripeScheduledAt: scheduledAt,
      },
    });
    expect(buildPlanPricing('starter').unitAmount).not.toBe(frozenAmountMinor);
    stripe.subscriptions.create.mockResolvedValue({
      id: 'sub_downgrade_catalog_drift_new',
      status: 'active',
    });

    await handleWebhook({
      id: 'evt_downgrade_catalog_drift',
      type: 'customer.subscription.deleted',
      data: { object: { id: subscription.stripeSubscriptionId } },
    });

    const [createParams] = stripe.subscriptions.create.mock.calls[0];
    expect(createParams.items[0].price_data.unit_amount).toBe(frozenAmountMinor);
    expect(createParams.items[0].price_data.currency).toBe('usd');
    expect(createParams.metadata).toEqual(expect.objectContaining({
      downgradeOperationKey: 'frozen-catalog-drift-operation',
      targetUnitAmountMinor: String(frozenAmountMinor),
      targetCurrency: 'usd',
      founderRateApplied: 'false',
    }));
    const updated = await SellerSubscription.findById(subscription._id);
    expect(updated).toMatchObject({
      plan: 'starter',
      stripeSubscriptionId: 'sub_downgrade_catalog_drift_new',
      activationNotification: expect.objectContaining({
        recurringAmountMinor: frozenAmountMinor,
        currency: 'USD',
      }),
    });
    const activationRows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.activated',
    }).lean();
    expect(activationRows).toHaveLength(4);
    expect(activationRows.every(row => row.money?.[0]?.amountMinor === frozenAmountMinor)).toBe(true);
  });

  test('Checkout replacement terminalizes an active attempt bound to the old Stripe subscription', async () => {
    const seller = await User.create({
      username: 'checkout-replacement-stale-attempt',
      email: 'checkout-replacement-stale-attempt@example.com',
      role: 'seller',
      isVerified: true,
    });
    const oldSubscriptionId = 'sub_checkout_replacement_old';
    const newSubscriptionId = 'sub_checkout_replacement_new';
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_checkout_replacement',
      stripeSubscriptionId: oldSubscriptionId,
      hasUsedFreePeriod: true,
      planChangeAttempt: {
        idempotencyToken: 'token_checkout_replacement_old',
        requestFingerprint: 'fingerprint_checkout_replacement_old',
        changeKind: 'upgrade',
        stripeSubscriptionId: oldSubscriptionId,
        stripeSubscriptionItemId: 'si_old',
        stripeProductId: 'prod_old_target',
        stripePriceId: 'price_old_target',
        targetPlan: 'elite',
        targetPlanName: 'Rozare Elite',
        targetIncludeMetaAds: false,
        targetUnitAmountMinor: buildPlanPricing('elite').unitAmount,
        state: 'recoverable',
        startedAt: new Date(Date.now() - 60_000),
      },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: newSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
      productId: 'prod_checkout_replacement_new',
      priceId: 'price_checkout_replacement_new',
    }));

    await handleWebhook({
      id: 'evt_checkout_replacement_new',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_replacement_new',
          mode: 'subscription',
          subscription: newSubscriptionId,
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
          },
        },
      },
    });

    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      stripeSubscriptionId: newSubscriptionId,
      stripeProductId: 'prod_checkout_replacement_new',
      stripePriceId: 'price_checkout_replacement_new',
      planChangeAttempt: expect.objectContaining({
        state: null,
        idempotencyToken: 'token_checkout_replacement_old',
        lastError: expect.stringMatching(/replaced/i),
      }),
    });
    await expect(StripeSubscriptionCleanup.findOne({
      staleStripeSubscriptionId: oldSubscriptionId,
    }).lean()).resolves.toMatchObject({
      seller: seller._id,
      replacementStripeSubscriptionId: newSubscriptionId,
      reason: 'replacement_activation',
      status: 'completed',
      attempts: 1,
      providerStatus: 'canceled',
    });
  });

  test('a webhook replay reconstructs predecessor cleanup after a crash immediately after the atomic replacement claim', async () => {
    const seller = await User.create({
      username: 'checkout-replacement-cleanup-replay',
      email: 'checkout-replacement-cleanup-replay@example.com',
      role: 'seller',
      isVerified: true,
    });
    const oldSubscriptionId = 'sub_checkout_cleanup_replay_old';
    const newSubscriptionId = 'sub_checkout_cleanup_replay_new';
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_checkout_cleanup_replay',
      stripeSubscriptionId: oldSubscriptionId,
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: newSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
      productId: 'prod_checkout_cleanup_replay',
      priceId: 'price_checkout_cleanup_replay',
    }));
    const event = {
      id: 'evt_checkout_cleanup_replay',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_cleanup_replay',
          mode: 'subscription',
          subscription: newSubscriptionId,
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
          },
        },
      },
    };
    const crash = new Error('database unavailable immediately after replacement claim');
    const createSpy = jest.spyOn(StripeSubscriptionCleanup, 'create')
      .mockRejectedValueOnce(crash);

    await expect(handleWebhook(event)).rejects.toBe(crash);
    createSpy.mockRestore();
    const claimed = await SellerSubscription.findById(subscription._id).lean();
    expect(claimed).toMatchObject({
      stripeSubscriptionId: newSubscriptionId,
      pendingStoreSync: expect.objectContaining({
        kind: 'checkout_activation',
        eventId: 'cs_checkout_cleanup_replay',
        stripeSubscriptionId: newSubscriptionId,
        previousStripeSubscriptionId: oldSubscriptionId,
      }),
    });
    expect(claimed.processedCheckoutSessionIds).toHaveLength(0);
    expect(await StripeSubscriptionCleanup.countDocuments()).toBe(0);

    await expect(handleWebhook(event)).resolves.toBeUndefined();

    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      oldSubscriptionId,
      {},
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^subscription-cleanup:/) }),
    );
    await expect(StripeSubscriptionCleanup.findOne({
      staleStripeSubscriptionId: oldSubscriptionId,
    }).lean()).resolves.toMatchObject({
      replacementStripeSubscriptionId: newSubscriptionId,
      reason: 'replacement_activation',
      status: 'completed',
      attempts: 1,
    });
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      stripeSubscriptionId: newSubscriptionId,
      processedCheckoutSessionIds: ['cs_checkout_cleanup_replay'],
    });
  });

  test('an invalid founder Checkout durably restores prior authority before cancelling the rejected incoming subscription', async () => {
    const seller = await User.create({
      username: 'invalid-founder-cleanup-order',
      email: 'invalid-founder-cleanup-order@example.com',
      role: 'seller',
      isVerified: true,
    });
    const oldSubscriptionId = 'sub_invalid_founder_cleanup_old';
    const rejectedSubscriptionId = 'sub_invalid_founder_cleanup_incoming';
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_invalid_founder_cleanup',
      stripeSubscriptionId: oldSubscriptionId,
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: rejectedSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter', false, true).unitAmount,
      productId: 'prod_invalid_founder_cleanup',
      priceId: 'price_invalid_founder_cleanup',
    }));

    await expect(handleWebhook({
      id: 'evt_invalid_founder_cleanup',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_invalid_founder_cleanup',
          mode: 'subscription',
          subscription: rejectedSubscriptionId,
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
            founderCouponCode: 'FIRST100',
            founderReservationToken: '00000000-0000-4000-8000-000000000000',
          },
        },
      },
    })).resolves.toBeUndefined();

    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      rejectedSubscriptionId,
      {},
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^subscription-cleanup:/) }),
    );
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      stripeSubscriptionId: oldSubscriptionId,
      status: 'blocked',
      processedCheckoutSessionIds: [],
    });
    await expect(StripeSubscriptionCleanup.findOne({
      staleStripeSubscriptionId: rejectedSubscriptionId,
    }).lean()).resolves.toMatchObject({
      replacementStripeSubscriptionId: oldSubscriptionId,
      reason: 'invalid_founder_checkout',
      status: 'completed',
      attempts: 1,
      providerStatus: 'canceled',
    });
  });

  test('a failed stale-subscription cancellation is durably escalated while replacement activation succeeds once', async () => {
    const [seller, admin] = await Promise.all([
      User.create({
        username: 'checkout-replacement-cleanup-failure',
        email: 'checkout-replacement-cleanup-failure@example.com',
        role: 'seller',
        isVerified: true,
      }),
      User.create({
        username: 'checkout-replacement-cleanup-admin',
        email: 'checkout-replacement-cleanup-admin@example.com',
        role: 'admin',
        status: 'active',
        isVerified: true,
      }),
    ]);
    const oldSubscriptionId = 'sub_checkout_cleanup_failure_old';
    const newSubscriptionId = 'sub_checkout_cleanup_failure_new';
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'blocked',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_checkout_cleanup_failure',
      stripeSubscriptionId: oldSubscriptionId,
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: newSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
      productId: 'prod_checkout_cleanup_failure',
      priceId: 'price_checkout_cleanup_failure',
    }));
    stripe.subscriptions.cancel.mockRejectedValueOnce(Object.assign(
      new Error('connection lost after Stripe accepted the cancellation request'),
      { type: 'StripeConnectionError', code: 'ECONNRESET' },
    ));
    const event = {
      id: 'evt_checkout_cleanup_failure',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_checkout_cleanup_failure',
          mode: 'subscription',
          subscription: newSubscriptionId,
          metadata: {
            sellerId: seller._id.toString(),
            plan: 'starter',
            includeMetaAds: 'false',
          },
        },
      },
    };

    await expect(handleWebhook(event)).resolves.toBeUndefined();
    const cleanup = await StripeSubscriptionCleanup.findOne({
      staleStripeSubscriptionId: oldSubscriptionId,
    }).lean();
    expect(cleanup).toMatchObject({
      seller: seller._id,
      replacementStripeSubscriptionId: newSubscriptionId,
      reason: 'replacement_activation',
      status: 'retry',
      attempts: 1,
      lastErrorCode: 'ECONNRESET',
    });
    expect(cleanup.manualReview.requiredAt).toBeTruthy();
    expect(cleanup.manualReview.notificationEnqueuedAt).toBeTruthy();
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      stripeSubscriptionId: newSubscriptionId,
      status: 'active',
    });
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
      'recipient.user': admin._id,
    })).toBe(4);

    await expect(handleWebhook({ ...event, id: 'evt_checkout_cleanup_failure_replay' }))
      .resolves.toBeUndefined();
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(await StripeSubscriptionCleanup.countDocuments({
      staleStripeSubscriptionId: oldSubscriptionId,
    })).toBe(1);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
    })).toBe(4);
  });

  test('an outcome-indeterminate cancellation keeps its durable intent and retries the same Stripe operation', async () => {
    const seller = await User.create({
      username: 'cancel-timeout-durable',
      email: 'cancel-timeout-durable@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_timeout_durable',
      stripeSubscriptionId: 'sub_cancel_timeout_durable',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.update
      .mockRejectedValueOnce(Object.assign(new Error('connection lost after request write'), {
        type: 'StripeConnectionError',
        code: 'ECONNRESET',
      }))
      .mockResolvedValueOnce({
        id: subscription.stripeSubscriptionId,
        cancel_at_period_end: true,
      });

    const firstResponse = responseMock();
    await cancelSubscription({ user: { id: seller._id.toString() } }, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(500);
    const retained = await SellerSubscription.findById(subscription._id);
    expect(retained.cancelledAt).toEqual(expect.any(Date));
    const firstKey = stripe.subscriptions.update.mock.calls[0][2].idempotencyKey;

    const retryResponse = responseMock();
    await cancelSubscription({ user: { id: seller._id.toString() } }, retryResponse);

    expect(retryResponse.status).not.toHaveBeenCalled();
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    expect(stripe.subscriptions.update.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    expect((await SellerSubscription.findById(subscription._id)).cancelledAt.getTime())
      .toBe(retained.cancelledAt.getTime());
  });

  test('a Stripe 429 keeps the durable cancellation intent for an exact replay', async () => {
    const seller = await User.create({
      username: 'cancel-rate-limit-durable',
      email: 'cancel-rate-limit-durable@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_cancel_rate_limit_durable',
      stripeSubscriptionId: 'sub_cancel_rate_limit_durable',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.update.mockRejectedValueOnce(Object.assign(
      new Error('Stripe temporarily rate limited the mutation'),
      { type: 'StripeRateLimitError', statusCode: 429 },
    ));
    const response = responseMock();

    await cancelSubscription({ user: { id: seller._id.toString() } }, response);

    expect(response.status).toHaveBeenCalledWith(500);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      cancelledAt: expect.any(Date),
    });
  });

  test('an outcome-indeterminate downgrade keeps Starter intent and retries the same Stripe operation', async () => {
    const seller = await User.create({
      username: 'downgrade-timeout-durable',
      email: 'downgrade-timeout-durable@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'elite',
      planName: 'Rozare Elite',
      stripeCustomerId: 'cus_downgrade_timeout_durable',
      stripeSubscriptionId: 'sub_downgrade_timeout_durable',
      hasUsedFreePeriod: true,
    });
    stripe.subscriptions.update
      .mockRejectedValueOnce(Object.assign(new Error('upstream timed out after accepting request'), {
        type: 'StripeAPIError',
        statusCode: 500,
      }))
      .mockResolvedValueOnce({
        id: subscription.stripeSubscriptionId,
        cancel_at_period_end: true,
      });

    const firstResponse = responseMock();
    await downgradeToStarter({ user: { id: seller._id.toString() } }, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(500);
    const retained = await SellerSubscription.findById(subscription._id);
    expect(retained.cancelledAt).toEqual(expect.any(Date));
    expect(retained.pendingDowngrade.toPlan).toBe('starter');
    const firstKey = stripe.subscriptions.update.mock.calls[0][2].idempotencyKey;

    const retryResponse = responseMock();
    await downgradeToStarter({ user: { id: seller._id.toString() } }, retryResponse);

    expect(retryResponse.status).not.toHaveBeenCalled();
    expect(retryResponse.json).toHaveBeenCalledWith(expect.objectContaining({ reused: true }));
    expect(stripe.subscriptions.update.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      cancelledAt: retained.cancelledAt,
      pendingDowngrade: expect.objectContaining({
        toPlan: 'starter',
        scheduledAt: retained.pendingDowngrade.scheduledAt,
      }),
    });
  });

  test('invoice.payment_action_required binds the exact pending generation without stealing or granting the HTTP claim', async () => {
    const pushToken = 'ExpoPushToken[plan-action-required-seller]';
    const seller = await User.create({
      username: 'action-webhook-race',
      email: 'action-webhook-race@example.com',
      role: 'seller',
      isVerified: true,
      expoPushTokens: [pushToken],
    });
    await ExpoPushTokenRegistration.create({
      tokenHash: hashPushToken(pushToken),
      revocationHash: 'c'.repeat(64),
      user: seller._id,
    });
    const expoFetch = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        data: [{ status: 'ok', id: 'expo-ticket-plan-action' }],
      }),
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_action_webhook_race',
      stripeSubscriptionId: 'sub_action_webhook_race',
      stripeProductId: 'prod_action_webhook_source',
      stripePriceId: 'price_action_webhook_source',
      hasUsedFreePeriod: true,
    });
    const sourceAmount = buildPlanPricing('starter').unitAmount;
    const sourceRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: sourceAmount,
      productId: subscription.stripeProductId,
      priceId: subscription.stripePriceId,
    });
    stripe.subscriptions.retrieve.mockResolvedValue(sourceRemote);
    let resolvePlanMutation;
    stripe.subscriptions.update.mockReturnValue(new Promise(resolve => {
      resolvePlanMutation = resolve;
    }));
    const response = responseMock();
    const upgradePromise = upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: false },
    }, response);
    await waitUntilCalled(stripe.subscriptions.update);

    const attempt = (await SellerSubscription.findById(subscription._id)).planChangeAttempt;
    const pendingRemote = stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: attempt.targetUnitAmountMinor,
      subscriptionItemId: attempt.stripeSubscriptionItemId,
      priceId: attempt.stripePriceId,
      productId: attempt.stripeProductId,
      invoiceId: 'in_action_webhook_race',
      invoiceStatus: 'open',
      confirmationSecret: 'pi_action_webhook_secret',
      paymentIntentStatus: 'requires_action',
      pendingUpdate: {
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        subscription_items: [{
          id: attempt.stripeSubscriptionItemId,
          price: attempt.stripePriceId,
          quantity: 1,
          discounts: [],
        }],
      },
    });
    pendingRemote.items.data[0].price = sourceRemote.items.data[0].price;
    stripe.subscriptions.retrieve.mockResolvedValue(pendingRemote);

    await handleWebhook({
      id: 'evt_action_webhook_race',
      type: 'invoice.payment_action_required',
      created: Math.floor(Date.now() / 1000),
      data: { object: pendingRemote.latest_invoice },
    });
    resolvePlanMutation(pendingRemote);
    await upgradePromise;

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_CHANGE_ACTION_REQUIRED',
      actionRequired: true,
      clientSecret: 'pi_action_webhook_secret',
      invoiceId: 'in_action_webhook_race',
    }));
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled();
    expect(await StripeEntitlementPayment.countDocuments({ seller: seller._id })).toBe(0);
    await expect(SellerSubscription.findById(subscription._id).lean()).resolves.toMatchObject({
      plan: 'starter',
      metaAdsIncluded: false,
      planChangeAttempt: expect.objectContaining({
        idempotencyToken: attempt.idempotencyToken,
        stripeInvoiceId: 'in_action_webhook_race',
        state: 'pending_payment',
        processingToken: null,
        lastError: expect.stringMatching(/authentication/i),
        notificationState: 'outboxed',
        notificationEmailState: 'outboxed',
        notificationInAppState: 'outboxed',
        notificationPushState: 'outboxed',
        notificationWhatsAppState: 'outboxed',
      }),
    });
    let actionRows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_action_required',
    }).lean();
    expect(actionRows.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push', 'whatsapp']);
    expect(actionRows.every(row => (
      row.recipient.audienceRole === 'seller'
      && row.money?.[0]?.amountMinor === buildPlanPricing('elite').unitAmount
      && row.money?.[0]?.currency === 'USD'
      && [row.payload.body, row.payload.text, row.payload.html, row.payload.message]
        .join(' ').includes('$21.65')
    ))).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notifySeller).not.toHaveBeenCalled();
    expect(expoFetch).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);

    await handleWebhook({
      id: 'evt_action_webhook_race_retry',
      type: 'invoice.payment_action_required',
      created: Math.floor(Date.now() / 1000),
      data: { object: pendingRemote.latest_invoice },
    });
    actionRows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_action_required',
    }).lean();
    expect(actionRows).toHaveLength(4);
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);

    await handleWebhook({
      id: 'evt_action_webhook_unrelated_invoice',
      type: 'invoice.payment_action_required',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          ...pendingRemote.latest_invoice,
          id: 'in_action_webhook_unrelated_invoice',
        },
      },
    });
    actionRows = await NotificationOutbox.find({
      aggregateId: String(subscription._id),
      eventType: 'subscription.plan_change_action_required',
    }).lean();
    expect(actionRows).toHaveLength(4);
    expect(await Notification.countDocuments({ user: seller._id })).toBe(0);
  });

  test('a changed request reclaims a stale generation that provably never reached a Stripe subscription update', async () => {
    const seller = await User.create({
      username: 'stale-pre-mutation-reclaim',
      email: 'stale-pre-mutation-reclaim@example.com',
      role: 'seller',
      isVerified: true,
    });
    const subscription = await SellerSubscription.create({
      seller: seller._id,
      status: 'active',
      plan: 'starter',
      planName: 'Rozare Starter',
      stripeCustomerId: 'cus_stale_pre_mutation_reclaim',
      stripeSubscriptionId: 'sub_stale_pre_mutation_reclaim',
      hasUsedFreePeriod: true,
      planChangeAttempt: {
        idempotencyToken: 'token_stale_pre_mutation',
        requestFingerprint: 'fingerprint_for_previous_options',
        changeKind: 'upgrade',
        stripeSubscriptionId: 'sub_stale_pre_mutation_reclaim',
        targetPlan: 'elite',
        targetPlanName: 'Rozare Elite',
        targetIncludeMetaAds: false,
        targetUnitAmountMinor: buildPlanPricing('elite', false).unitAmount,
        state: 'processing',
        processingToken: 'processing_stale_pre_mutation',
        startedAt: new Date(Date.now() - (11 * 60 * 1000)),
      },
    });
    stripe.subscriptions.retrieve.mockResolvedValue(stripeSubscriptionWithPrice({
      subscriptionId: subscription.stripeSubscriptionId,
      customerId: subscription.stripeCustomerId,
      unitAmount: buildPlanPricing('starter').unitAmount,
    }));
    mockPaidPlanChangeUpdate({ customerId: subscription.stripeCustomerId });
    const response = responseMock();

    await upgradeToElite({
      user: { id: seller._id.toString() },
      body: { includeMetaAds: true },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    const updated = await SellerSubscription.findById(subscription._id);
    expect(updated.plan).toBe('elite');
    expect(updated.metaAdsIncluded).toBe(true);
    expect(updated.planChangeAttempt.state).toBe('applied');
    expect(updated.planChangeAttempt.idempotencyToken).not.toBe('token_stale_pre_mutation');
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
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
