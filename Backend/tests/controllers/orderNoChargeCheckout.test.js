'use strict';

const mockEnsureStripeCustomerForUser = jest.fn();
const mockPaymentIntentCreate = jest.fn();
const mockCheckoutSessionCreate = jest.fn();
const mockStripeCouponCreate = jest.fn();
const mockRemoveFulfilledOrderItemsFromCart = jest.fn().mockResolvedValue({ removed: true });
const mockGetExchangeRateSnapshot = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    paymentIntents: {
      create: mockPaymentIntentCreate,
      retrieve: jest.fn(),
      cancel: jest.fn(),
    },
    checkout: {
      sessions: {
        create: mockCheckoutSessionCreate,
        retrieve: jest.fn(),
        expire: jest.fn(),
      },
    },
    coupons: { create: mockStripeCouponCreate },
  },
  STRIPE_MODE: 'test',
}));

jest.mock('../../services/stripeCustomerService', () => ({
  ensureStripeCustomerForUser: mockEnsureStripeCustomerForUser,
  createMobileCustomerAccess: jest.fn(),
  getStripeMobileConfig: jest.fn().mockReturnValue({
    publishableKey: 'pk_test_no_charge',
    merchantCountryCode: 'PK',
  }),
}));

jest.mock('../../services/currencyService', () => {
  const rates = { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 };
  const normalizeCurrency = value => String(value || 'USD').trim().toUpperCase();
  const convert = (amount, from, to) => (
    (Number(amount) / rates[normalizeCurrency(from)]) * rates[normalizeCurrency(to)]
  );
  return {
    CURRENCIES: {
      USD: { code: 'USD', symbol: '$' },
      PKR: { code: 'PKR', symbol: 'Rs' },
      EUR: { code: 'EUR', symbol: 'EUR' },
      GBP: { code: 'GBP', symbol: 'GBP' },
    },
    normalizeCurrency,
    normalizeRates: value => value,
    isSupportedCurrency: value => Object.prototype.hasOwnProperty.call(rates, normalizeCurrency(value)),
    getExchangeRateSnapshot: mockGetExchangeRateSnapshot,
    convertAmountWithRates: (amount, from, to) => convert(amount, from, to),
    convertAmount: async (amount, from, to) => convert(amount, from, to),
    convertAmountSync: (amount, from, to) => convert(amount, from, to),
    formatMoneySync: (amount, currency) => `${normalizeCurrency(currency)} ${Number(amount).toFixed(2)}`,
    exchangeRatesUnavailableError: () => Object.assign(new Error('Rates unavailable'), {
      code: 'EXCHANGE_RATES_UNAVAILABLE', statusCode: 503,
    }),
  };
});

jest.mock('../../controllers/mailController', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
jest.mock('../../services/whatsapp/queue', () => ({
  enqueueOrderConfirmation: jest.fn(),
  enqueueOrderPlacedInfo: jest.fn().mockResolvedValue(true),
  enqueueTextNotification: jest.fn(),
}));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
  notifySeller: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../services/tiktokEventsApi', () => ({
  trackOrderEvent: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../services/cartFulfillmentService', () => ({
  removeFulfilledOrderItemsFromCart: mockRemoveFulfilledOrderItemsFromCart,
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Coupon = require('../../models/Coupon');
const CouponRedemption = require('../../models/CouponRedemption');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const ShippingMethod = require('../../models/ShippingMethod');
const Store = require('../../models/Store');
const TaxConfig = require('../../models/TaxConfig');
const User = require('../../models/User');
const WalletTransaction = require('../../models/WalletTransaction');
const { placeOrder } = require('../../controllers/orderController');

let replicaSet;

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
});

const makeCheckout = async paymentMethod => {
  const slugToken = paymentMethod.replace(/_/g, '-');
  const seller = await User.create({
    username: `seller-${paymentMethod}`,
    email: `seller-${paymentMethod}@example.com`,
    role: 'seller',
  });
  const buyer = await User.create({
    username: `buyer-${paymentMethod}`,
    email: `buyer-${paymentMethod}@example.com`,
    role: 'user',
    currency: 'USD',
  });
  await Store.create({
    seller: seller._id,
    storeName: `Free ${paymentMethod} Store`,
    storeSlug: `free-${slugToken}-store`,
    visibility: { mode: 'global', label: 'Worldwide' },
    paymentPolicy: paymentMethod === 'cash_on_delivery' ? 'online_and_cod' : 'advance_only',
    isActive: true,
  });
  await ShippingMethod.create({
    seller: seller._id,
    methods: [{ type: 'free', cost: 0, currency: 'USD', deliveryDays: 5, isActive: true }],
  });
  const product = await Product.create({
    name: `100 percent coupon ${paymentMethod}`,
    description: 'Controller no-charge checkout fixture',
    price: 100,
    currency: 'USD',
    priceCurrency: 'USD',
    category: 'Test',
    brand: 'Test',
    stock: 5,
    image: 'https://example.com/no-charge-controller.jpg',
    images: [{ url: 'https://example.com/no-charge-controller.jpg' }],
    seller: seller._id,
  });
  const coupon = await Coupon.create({
    seller: seller._id,
    code: `FREE${paymentMethod.toUpperCase()}`,
    discountType: 'percentage',
    discountValue: 100,
    currency: 'USD',
    applicableTo: 'all',
    maxUses: 10,
    maxUsesPerUser: 2,
    startDate: new Date(Date.now() - 60_000),
    expiryDate: new Date(Date.now() + 3_600_000),
    isActive: true,
  });
  const key = `controller-free:${paymentMethod}:${new mongoose.Types.ObjectId()}`;
  const order = {
    idempotencyKey: key,
    orderItems: [{ id: product._id.toString(), quantity: 1 }],
    shippingInfo: {
      fullName: 'No Charge Buyer',
      email: buyer.email,
      phone: '+923001234567',
      address: '1 Test Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
      countryCode: 'PK',
    },
    buyerLocation: { country: 'Pakistan', countryCode: 'PK', city: 'Lahore' },
    paymentMethod,
    currency: 'USD',
    shippingMethod: { name: 'free', price: 999, estimatedDays: 1 },
    sellerShipping: [{
      seller: seller._id.toString(),
      shippingMethod: { name: 'free', price: 999, estimatedDays: 1 },
    }],
    // The checkout summary is the exact quote the buyer reviewed. The
    // controller now rejects any server-side reprice before it mutates stock,
    // coupons, wallet funds, or Stripe state.
    orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 100, totalAmount: 0 },
    appliedCoupons: [{
      couponId: coupon._id.toString(),
      code: coupon.code,
      applicableProductIds: [product._id.toString()],
    }],
  };
  return { buyer, coupon, key, order, product };
};

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
  await Promise.all([CouponRedemption.syncIndexes(), Order.syncIndexes()]);
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 120000);

beforeEach(async () => {
  jest.clearAllMocks();
  mockGetExchangeRateSnapshot.mockResolvedValue({
    base: 'USD',
    rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
    capturedAt: new Date('2026-08-20T00:00:00.000Z'),
    source: 'test',
    fallback: false,
  });
  mockRemoveFulfilledOrderItemsFromCart.mockResolvedValue({ removed: true });
  await Promise.all([
    Coupon.deleteMany({}),
    CouponRedemption.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    ShippingMethod.deleteMany({}),
    Store.deleteMany({}),
    TaxConfig.deleteMany({}),
    User.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

describe('initial zero-value and provider-minimum checkout boundaries', () => {
  test('persists a domestic buyer phone in the selected country, never a server default country', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    fixture.order.shippingInfo = {
      ...fixture.order.shippingInfo,
      phone: '020 7946 0018',
      country: 'United Kingdom',
      countryCode: 'GB',
      city: 'London',
      state: 'England',
      postalCode: 'SW1A 1AA',
    };
    fixture.order.buyerLocation = { country: 'United Kingdom', countryCode: 'GB', city: 'London' };
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    await expect(Order.findOne({ checkoutIdempotencyKey: fixture.key }).lean()).resolves.toMatchObject({
      shippingInfo: expect.objectContaining({
        phone: '+442079460018',
        phoneE164: '+442079460018',
        countryCode: 'GB',
      }),
    });
  });

  test('rejects an ambiguous domestic buyer phone before creating an order', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    fixture.order.shippingInfo.phone = '0300 1234567';
    fixture.order.shippingInfo.country = '';
    fixture.order.shippingInfo.countryCode = '';
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SHIPPING_PHONE_INVALID' }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
  });

  test.each([
    ['subtotal', 99],
    ['shippingCost', 1],
    ['tax', 1],
    ['couponDiscount', 99],
    ['totalAmount', 1],
  ])('rejects a stale reviewed %s before any checkout mutation', async (field, staleValue) => {
    const fixture = await makeCheckout('wallet');
    fixture.order.orderSummary[field] = staleValue;
    const res = response();

    await placeOrder({
      body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CHECKOUT_REPRICE_REQUIRED',
      currency: 'USD',
      changedFields: [field],
      orderSummary: {
        subtotal: 100,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 100,
        totalAmount: 0,
      },
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ coupon: fixture.coupon._id })).toBe(0);
    expect(await WalletTransaction.countDocuments({ user: fixture.buyer._id })).toBe(0);
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test.each([true, '', 'not-money', Number.NaN, Number.POSITIVE_INFINITY, {}, []])(
    'rejects invalid reviewed money %p before any checkout mutation',
    async invalidValue => {
      const fixture = await makeCheckout('cash_on_delivery');
      fixture.order.orderSummary.totalAmount = invalidValue;
      const res = response();

      await placeOrder({
        body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
        headers: { 'x-idempotency-key': fixture.key },
        user: { id: fixture.buyer._id.toString(), role: 'user' },
      }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'CHECKOUT_EXPECTED_TOTAL_INVALID',
      }));
      expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
      expect((await Product.findById(fixture.product._id)).stock).toBe(5);
      expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
    },
  );

  test('requires a second explicit confirmation after a product price changes', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    await Product.updateOne({ _id: fixture.product._id }, { $set: { price: 101 } });
    const first = response();

    await placeOrder({
      body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, first);

    expect(first.status).toHaveBeenCalledWith(409);
    const refreshed = first.json.mock.calls[0][0].orderSummary;
    expect(refreshed).toEqual({
      subtotal: 101,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 101,
      totalAmount: 0,
    });
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);

    fixture.order.orderSummary = refreshed;
    const confirmed = response();
    await placeOrder({
      body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, confirmed);

    expect(confirmed.status).toHaveBeenCalledWith(200);
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(1);
    expect((await Product.findById(fixture.product._id)).stock).toBe(4);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(1);
  });

  test('rejects a same-currency non-USD order when checkout cannot freeze trusted seller-settlement FX', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    fixture.order.currency = 'PKR';
    mockGetExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: new Date('2026-08-20T00:00:00.000Z'),
      source: 'fallback',
      fallback: true,
    });
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: {},
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    }));
    expect(await Order.countDocuments({ user: fixture.buyer._id })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
  });

  test('does not require FX for an exact-zero foreign fixed tax', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    await TaxConfig.create({ type: 'fixed', value: 0, currency: 'PKR', isActive: true });
    mockGetExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: new Date('2026-08-20T00:00:00.000Z'),
      source: 'fallback',
      fallback: true,
    });
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const stored = await Order.findOne({ checkoutIdempotencyKey: fixture.key }).lean();
    expect(stored.orderSummary.tax).toBe(0);
  });

  test('still requires trusted FX for a foreign source cent that converts below one checkout cent', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    await TaxConfig.create({ type: 'fixed', value: 0.01, currency: 'PKR', isActive: true });
    mockGetExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: new Date('2026-08-20T00:00:00.000Z'),
      source: 'fallback',
      fallback: true,
    });
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
  });

  test.each([
    ['fixed-tax currency', { type: 'fixed', value: 10, currency: 'CAD' }],
    ['lowercase fixed-tax currency', { type: 'fixed', value: 10, currency: 'usd' }],
    ['padded fixed-tax currency', { type: 'fixed', value: 10, currency: ' USD ' }],
    ['null fixed-tax currency', { type: 'fixed', value: 10, currency: null }],
    ['tax type', { type: 'bogus', value: 10, currency: 'USD' }],
    ['non-finite percentage', { type: 'percentage', value: Number.POSITIVE_INFINITY, currency: 'USD' }],
    ['sub-cent fixed value', { type: 'fixed', value: 0.001, currency: 'USD' }],
    ['nonzero disabled value', { type: 'none', value: 10, currency: 'USD' }],
  ])('fails closed instead of reinterpreting corrupt %s configuration', async (_label, corruptConfig) => {
    const fixture = await makeCheckout('cash_on_delivery');
    await TaxConfig.collection.insertOne({
      ...corruptConfig,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'TAX_CONFIG_INVALID',
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
  });

  test.each([
    ['unsupported currency', { currency: 'CAD' }],
    ['conflicting currencies', { currency: 'PKR', priceCurrency: 'USD' }],
  ])('fails closed for product %s metadata before checkout mutation', async (_label, corruptFields) => {
    const fixture = await makeCheckout('cash_on_delivery');
    await Product.collection.updateOne(
      { _id: fixture.product._id },
      { $set: corruptFields },
    );
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_METADATA_INVALID',
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
  });

  test('rejects a persisted 1.004 product price instead of rounding it into a free order', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    await Product.collection.updateOne(
      { _id: fixture.product._id },
      { $set: { price: 1.004 } },
    );
    fixture.order.orderSummary = {
      subtotal: 1,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 1,
      totalAmount: 0,
    };
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_PRICE_INVALID',
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
  });

  test.each([
    ['cost', { cost: 0.004, costInputAmount: 0.01 }],
    ['costInputAmount', { cost: 1, costInputAmount: 0.004 }],
  ])('rejects a paid shipping method with corrupt persisted %s before checkout mutation', async (_label, money) => {
    const fixture = await makeCheckout('cash_on_delivery');
    await ShippingMethod.collection.updateOne(
      { seller: fixture.product.seller },
      { $set: { methods: [{
        type: 'standard',
        ...money,
        currency: 'USD',
        costCurrency: 'USD',
        deliveryDays: 5,
        isActive: true,
      }] } },
    );
    fixture.order.shippingMethod.name = 'standard';
    fixture.order.sellerShipping[0].shippingMethod.name = 'standard';
    const res = response();

    await placeOrder({
      body: { order: fixture.order },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SHIPPING_COST_INVALID',
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
  });

  test.each(['cash_on_delivery', 'stripe', 'wallet'])('requires an idempotency key before any zero-total %s order is written', async paymentMethod => {
    const fixture = await makeCheckout(paymentMethod);
    delete fixture.order.idempotencyKey;
    const res = response();

    await placeOrder({
      body: {
        order: fixture.order,
        ...(paymentMethod === 'stripe' ? { paymentFlow: 'checkout_session', clientSurface: 'web' } : {}),
      },
      headers: {},
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    }));
    expect(await Order.countDocuments({ user: fixture.buyer._id })).toBe(0);
    expect((await Product.findById(fixture.product._id)).stock).toBe(5);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test.each(['stripe', 'wallet'])('completes and replays a zero-total %s order without opening its payment rail', async paymentMethod => {
    const fixture = await makeCheckout(paymentMethod);
    const req = {
      body: {
        order: fixture.order,
        ...(paymentMethod === 'stripe' ? { paymentFlow: 'payment_sheet', clientSurface: 'mobile' } : {}),
      },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    };
    const firstResponse = response();

    await placeOrder(req, firstResponse);

    expect(firstResponse.status).toHaveBeenCalledWith(200);
    const firstBody = firstResponse.json.mock.calls[0][0];
    expect(firstBody).toMatchObject({
      isPaid: true,
      completed: true,
      noPaymentRequired: true,
      idempotentReplay: false,
      paymentMethod,
    });
    expect(firstBody.orderId).toBeTruthy();
    expect(firstBody.order.totalAmount).toBe(0);

    const stored = await Order.findOne({ user: fixture.buyer._id, checkoutIdempotencyKey: fixture.key });
    const [productAfterFirst, couponAfterFirst, redemptionAfterFirst] = await Promise.all([
      Product.findById(fixture.product._id),
      Coupon.findById(fixture.coupon._id),
      CouponRedemption.findOne({ order: stored._id }),
    ]);
    expect(stored).toMatchObject({
      isPaid: true,
      awaitingPayment: false,
      inventoryCommitted: true,
      orderStatus: 'confirmed',
      paymentSetupState: 'complete',
    });
    expect(productAfterFirst.stock).toBe(4);
    expect(productAfterFirst.totalSales).toBe(1);
    expect(couponAfterFirst.usedCount).toBe(1);
    expect(redemptionAfterFirst.status).toBe('consumed');
    expect(await WalletTransaction.countDocuments({ referenceId: stored._id })).toBe(0);
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(mockStripeCouponCreate).not.toHaveBeenCalled();

    const replayResponse = response();
    await placeOrder(req, replayResponse);

    expect(replayResponse.status).toHaveBeenCalledWith(200);
    expect(replayResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      isPaid: true,
      completed: true,
      noPaymentRequired: true,
      idempotentReplay: true,
      paymentMethod,
      orderId: stored.orderId,
    }));
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(1);
    expect((await Product.findById(fixture.product._id)).stock).toBe(4);
    expect((await Product.findById(fixture.product._id)).totalSales).toBe(1);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ order: stored._id })).toBe(1);
    expect(await WalletTransaction.countDocuments({ referenceId: stored._id })).toBe(0);
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(mockStripeCouponCreate).not.toHaveBeenCalled();
  });

  test.each(['stripe', 'wallet'])('serializes concurrent zero-total %s requests into one completed order', async paymentMethod => {
    const fixture = await makeCheckout(paymentMethod);
    const req = {
      body: {
        order: fixture.order,
        ...(paymentMethod === 'stripe' ? { paymentFlow: 'payment_sheet', clientSurface: 'mobile' } : {}),
      },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    };
    const first = response();
    const second = response();

    await Promise.all([placeOrder(req, first), placeOrder(req, second)]);

    expect(first.status).toHaveBeenCalledWith(200);
    expect(second.status).toHaveBeenCalledWith(200);
    expect([first, second].map(result => result.json.mock.calls[0][0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ noPaymentRequired: true, idempotentReplay: false }),
        expect.objectContaining({ noPaymentRequired: true, idempotentReplay: true }),
      ]),
    );
    const stored = await Order.find({
      user: fixture.buyer._id,
      checkoutIdempotencyKey: fixture.key,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      isPaid: true,
      awaitingPayment: false,
      inventoryCommitted: true,
      paymentSetupState: 'complete',
    });
    expect((await Product.findById(fixture.product._id)).stock).toBe(4);
    expect((await Product.findById(fixture.product._id)).totalSales).toBe(1);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(1);
    expect(await CouponRedemption.countDocuments({ order: stored[0]._id, status: 'consumed' })).toBe(1);
    expect(await WalletTransaction.countDocuments({ referenceId: stored[0]._id })).toBe(0);
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test('keeps a zero-total COD order unpaid and awaiting delivery recognition', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    const res = response();

    await placeOrder({
      body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const stored = await Order.findOne({ user: fixture.buyer._id, checkoutIdempotencyKey: fixture.key });
    expect(stored).toMatchObject({
      paymentMethod: 'cash_on_delivery',
      isPaid: false,
      awaitingPayment: false,
      inventoryCommitted: true,
      orderStatus: 'pending',
    });
    expect(stored.paidAt ?? null).toBeNull();
    expect(stored.paymentFulfilledAt ?? null).toBeNull();
    expect((await Product.findById(fixture.product._id)).stock).toBe(4);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(1);
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test('treats a raw currency-less legacy product as canonical USD even when its store is PKR', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    await Promise.all([
      Store.updateOne(
        { seller: fixture.product.seller },
        { $set: { productCurrency: 'PKR', productCurrencyStatus: 'active' } },
      ),
      Product.collection.updateOne(
        { _id: fixture.product._id },
        {
          $unset: {
            currency: '',
            priceCurrency: '',
            discountedPriceCurrency: '',
          },
        },
      ),
    ]);
    const res = response();

    await placeOrder({
      body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const stored = await Order.findOne({ checkoutIdempotencyKey: fixture.key }).lean();
    expect(stored.orderItems[0]).toMatchObject({
      sourcePrice: 100,
      sourceCurrency: 'USD',
      sourceLineSubtotal: 100,
      lineSubtotal: 100,
    });
    expect(stored.orderSummary).toMatchObject({ subtotal: 100, totalAmount: 0 });
  });

  test('scopes guest COD retries by normalized email without cross-guest key collisions', async () => {
    const fixture = await makeCheckout('cash_on_delivery');
    fixture.order.appliedCoupons = [];
    fixture.order.orderSummary = {
      subtotal: 100,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 100,
    };
    const rawKey = 'guest-shared-device-attempt';
    fixture.order.idempotencyKey = rawKey;
    fixture.order.shippingInfo.email = 'First.Guest@Example.com ';
    const firstRequest = {
      body: { order: fixture.order, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': rawKey },
    };
    const first = response();

    await placeOrder(firstRequest, first);
    expect(first.status).toHaveBeenCalledWith(200);

    const replay = response();
    await placeOrder({
      ...firstRequest,
      body: {
        ...firstRequest.body,
        order: {
          ...fixture.order,
          shippingInfo: { ...fixture.order.shippingInfo, email: 'first.guest@example.com' },
        },
      },
    }, replay);
    expect(replay.status).toHaveBeenCalledWith(200);
    expect(replay.json.mock.calls[0][0].orderId).toBe(first.json.mock.calls[0][0].orderId);

    const secondOrder = {
      ...fixture.order,
      shippingInfo: { ...fixture.order.shippingInfo, email: 'second.guest@example.com' },
    };
    const second = response();
    await placeOrder({
      body: { order: secondOrder, paymentFlow: 'checkout_session', clientSurface: 'web' },
      headers: { 'x-idempotency-key': rawKey },
    }, second);

    expect(second.status).toHaveBeenCalledWith(200);
    expect(second.json.mock.calls[0][0].orderId).not.toBe(first.json.mock.calls[0][0].orderId);
    const stored = await Order.find({ user: null }).sort({ guestEmail: 1 }).lean();
    expect(stored).toHaveLength(2);
    expect(stored.map(order => order.guestEmail)).toEqual([
      'first.guest@example.com',
      'second.guest@example.com',
    ]);
    expect(new Set(stored.map(order => order.checkoutIdempotencyKey)).size).toBe(2);
    expect(stored.every(order => order.checkoutIdempotencyKey.startsWith('guest:'))).toBe(true);
    expect((await Product.findById(fixture.product._id)).stock).toBe(3);
  });

  test('never creates a payable Stripe object when stock=1 is consumed before reservation', async () => {
    const fixture = await makeCheckout('stripe');
    fixture.product.stock = 1;
    await fixture.product.save();
    fixture.order.appliedCoupons = [];
    fixture.order.orderSummary = {
      subtotal: 100,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 100,
    };
    mockEnsureStripeCustomerForUser.mockImplementation(async () => {
      await Product.updateOne(
        { _id: fixture.product._id, stock: 1 },
        { $set: { stock: 0 }, $inc: { totalSales: 1 } },
      );
      return {
        customer: { id: 'cus_stock_race' },
        user: { email: fixture.buyer.email },
      };
    });
    const res = response();

    await placeOrder({
      body: {
        order: fixture.order,
        paymentFlow: 'payment_sheet',
        clientSurface: 'mobile',
      },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_STOCK_CHANGED',
    }));
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(await Order.countDocuments({ checkoutIdempotencyKey: fixture.key })).toBe(0);
    expect(await Product.findById(fixture.product._id).lean()).toMatchObject({ stock: 0, totalSales: 1 });
    expect(await CouponRedemption.countDocuments({ order: { $ne: null } })).toBe(0);
  });

  test.each([
    ['payment_sheet', 'mobile', mockPaymentIntentCreate, 'amount'],
    ['checkout_session', 'web', mockCheckoutSessionCreate, 'line_items[0][price_data][unit_amount]'],
  ])('returns a clean 400 and restores inventory when Stripe rejects a positive %s total as too small', async (
    paymentFlow,
    clientSurface,
    create,
    param,
  ) => {
    const fixture = await makeCheckout('stripe');
    fixture.product.price = 0.1;
    fixture.product.discountedPrice = null;
    await fixture.product.save();
    fixture.order.appliedCoupons = [];
    fixture.order.orderSummary = {
      subtotal: 0.1,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 0.1,
    };
    mockEnsureStripeCustomerForUser.mockResolvedValue({
      customer: { id: 'cus_small_checkout' },
      user: { email: fixture.buyer.email },
    });
    create.mockRejectedValue(Object.assign(new Error('Amount is below the provider minimum'), {
      type: 'StripeInvalidRequestError',
      statusCode: 400,
      code: 'amount_too_small',
      param,
    }));
    const res = response();

    await placeOrder({
      body: { order: fixture.order, paymentFlow, clientSurface },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_AMOUNT_TOO_SMALL',
      currency: 'USD',
      totalAmount: 0.1,
    }));
    expect(await Order.countDocuments({ user: fixture.buyer._id })).toBe(0);
    const restoredProduct = await Product.findById(fixture.product._id);
    expect(restoredProduct.stock).toBe(5);
    expect(restoredProduct.totalSales || 0).toBe(0);
    expect((await Coupon.findById(fixture.coupon._id)).usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ user: fixture.buyer._id })).toBe(0);
    expect(mockEnsureStripeCustomerForUser).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['payment_sheet', 'mobile'],
    ['checkout_session', 'web'],
  ])('rejects an over-limit %s order before persistence, inventory, or Stripe mutation', async (
    paymentFlow,
    clientSurface,
  ) => {
    const fixture = await makeCheckout('stripe');
    fixture.product.price = 1_000_000;
    fixture.product.discountedPrice = null;
    await fixture.product.save();
    fixture.order.appliedCoupons = [];
    fixture.order.orderSummary = {
      subtotal: 1_000_000,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 1_000_000,
    };
    const res = response();

    await placeOrder({
      body: { order: fixture.order, paymentFlow, clientSurface },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_AMOUNT_TOO_LARGE',
    }));
    expect(await Order.countDocuments({ user: fixture.buyer._id })).toBe(0);
    expect(await Product.findById(fixture.product._id).lean()).toMatchObject({
      stock: 5,
    });
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(await CouponRedemption.countDocuments({ user: fixture.buyer._id })).toBe(0);
  });

  test('converts a cheap bulk PKR line once and charges its exact USD line total', async () => {
    const fixture = await makeCheckout('stripe');
    fixture.product.price = 1;
    fixture.product.currency = 'PKR';
    fixture.product.priceCurrency = 'PKR';
    fixture.product.discountedPrice = null;
    fixture.product.stock = 1000;
    await fixture.product.save();
    fixture.order.orderItems[0].quantity = 1000;
    fixture.order.appliedCoupons = [];
    fixture.order.orderSummary = {
      subtotal: 3.57,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 3.57,
    };
    mockEnsureStripeCustomerForUser.mockResolvedValue({
      customer: { id: 'cus_bulk_pkr' },
      user: { email: fixture.buyer.email },
    });
    mockPaymentIntentCreate.mockImplementation(async params => ({
      id: 'pi_bulk_pkr',
      client_secret: 'pi_bulk_pkr_secret',
      status: 'requires_payment_method',
      amount: params.amount,
      amount_received: 0,
      currency: params.currency,
      customer: params.customer,
      livemode: false,
      metadata: params.metadata,
    }));
    const res = response();

    await placeOrder({
      body: {
        order: fixture.order,
        paymentFlow: 'payment_sheet',
        clientSurface: 'mobile',
      },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPaymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 357, currency: 'usd' }),
      expect.any(Object),
    );
    const stored = await Order.findOne({
      user: fixture.buyer._id,
      checkoutIdempotencyKey: fixture.key,
    });
    expect(stored.orderItems[0]).toMatchObject({
      quantity: 1000,
      sourcePrice: 1,
      sourceCurrency: 'PKR',
      sourceLineSubtotal: 1000,
      lineSubtotal: 3.57,
    });
    expect(stored.orderSummary).toMatchObject({ subtotal: 3.57, totalAmount: 3.57 });
  });

  test('charges one exact PKR Stripe total for native PKR and converted USD seller lines', async () => {
    const fixture = await makeCheckout('stripe');
    fixture.buyer.currency = 'PKR';
    await fixture.buyer.save();

    fixture.product.price = 100;
    fixture.product.currency = 'PKR';
    fixture.product.priceCurrency = 'PKR';
    fixture.product.discountedPrice = null;
    await fixture.product.save();
    await Promise.all([
      Store.updateOne(
        { seller: fixture.product.seller },
        { $set: { productCurrency: 'PKR', productCurrencyStatus: 'active' } },
      ),
      ShippingMethod.updateOne(
        { seller: fixture.product.seller },
        { $set: { 'methods.0.currency': 'PKR' } },
      ),
    ]);

    const usdSeller = await User.create({
      username: 'seller-stripe-usd-mixed',
      email: 'seller-stripe-usd-mixed@example.com',
      role: 'seller',
      currency: 'USD',
    });
    await Store.create({
      seller: usdSeller._id,
      storeName: 'Mixed USD Store',
      storeSlug: 'mixed-usd-store',
      visibility: { mode: 'global', label: 'Worldwide' },
      paymentPolicy: 'advance_only',
      productCurrency: 'USD',
      productCurrencyStatus: 'active',
      isActive: true,
    });
    await ShippingMethod.create({
      seller: usdSeller._id,
      methods: [{ type: 'free', cost: 0, currency: 'USD', deliveryDays: 5, isActive: true }],
    });
    const usdProduct = await Product.create({
      name: 'USD seller product in PKR checkout',
      description: 'Mixed seller currency controller checkout fixture',
      price: 2,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 5,
      image: 'https://example.com/mixed-usd-controller.jpg',
      images: [{ url: 'https://example.com/mixed-usd-controller.jpg' }],
      seller: usdSeller._id,
    });

    fixture.order.currency = 'PKR';
    fixture.order.orderItems = [
      { id: fixture.product._id.toString(), quantity: 2 },
      { id: usdProduct._id.toString(), quantity: 3 },
    ];
    fixture.order.sellerShipping.push({
      seller: usdSeller._id.toString(),
      shippingMethod: { name: 'free', price: 999, estimatedDays: 1 },
    });
    fixture.order.appliedCoupons = [];
    // PKR 100 x 2 remains PKR 200. USD 2 x 3 converts exactly once at
    // PKR 280/USD to PKR 1,680, for a conserved PKR 1,880 charge.
    fixture.order.orderSummary = {
      subtotal: 1880,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: 1880,
    };
    mockEnsureStripeCustomerForUser.mockResolvedValue({
      customer: { id: 'cus_mixed_pkr_usd' },
      user: { email: fixture.buyer.email },
    });
    mockPaymentIntentCreate.mockImplementation(async params => ({
      id: 'pi_mixed_pkr_usd',
      client_secret: 'pi_mixed_pkr_usd_secret',
      status: 'requires_payment_method',
      amount: params.amount,
      amount_received: 0,
      currency: params.currency,
      customer: params.customer,
      livemode: false,
      metadata: params.metadata,
    }));
    const res = response();

    await placeOrder({
      body: {
        order: fixture.order,
        paymentFlow: 'payment_sheet',
        clientSurface: 'mobile',
      },
      headers: { 'x-idempotency-key': fixture.key },
      user: { id: fixture.buyer._id.toString(), role: 'user' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPaymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 188000, currency: 'pkr' }),
      expect.any(Object),
    );
    const stored = await Order.findOne({
      user: fixture.buyer._id,
      checkoutIdempotencyKey: fixture.key,
    }).lean();
    expect(stored.currency).toBe('PKR');
    expect(stored.orderItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: fixture.product._id,
        quantity: 2,
        price: 100,
        sourcePrice: 100,
        sourceCurrency: 'PKR',
        sourceLineSubtotal: 200,
        lineSubtotal: 200,
      }),
      expect.objectContaining({
        productId: usdProduct._id,
        quantity: 3,
        price: 560,
        sourcePrice: 2,
        sourceCurrency: 'USD',
        sourceLineSubtotal: 6,
        lineSubtotal: 1680,
      }),
    ]));
    expect(stored.orderSummary).toMatchObject({ subtotal: 1880, totalAmount: 1880 });
  });
});
