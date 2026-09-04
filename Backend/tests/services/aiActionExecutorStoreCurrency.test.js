'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../controllers/mailController', () => ({
  sendEmail: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/whatsapp/queue', () => ({
  enqueueOrderConfirmation: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/whatsapp/sellerNotificationService', () => ({
  notifySeller: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/currencyService', () => {
  const actual = jest.requireActual('../../services/currencyService');
  return {
    ...actual,
    getExchangeRateSnapshot: jest.fn().mockResolvedValue({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: '2026-08-20T00:00:00.000Z',
      source: 'test-live',
      fallback: false,
    }),
    formatMoney: jest.fn(async (amount, currency) => `${currency} ${Number(amount).toFixed(2)}`),
  };
});

const Product = require('../../models/Product');
const AIActionReceipt = require('../../models/AIActionReceipt');
const Coupon = require('../../models/Coupon');
const ShippingMethod = require('../../models/ShippingMethod');
const Store = require('../../models/Store');
const TaxConfig = require('../../models/TaxConfig');
const User = require('../../models/User');
const { getExchangeRateSnapshot, formatMoney } = require('../../services/currencyService');
const { executeToolCall } = require('../../services/aiActionExecutor');

let replicaSet;

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
  await AIActionReceipt.init();
}, 60000);

afterEach(async () => {
  await Promise.all([
    Coupon.deleteMany({}),
    AIActionReceipt.deleteMany({}),
    Product.deleteMany({}),
    ShippingMethod.deleteMany({}),
    Store.deleteMany({}),
    TaxConfig.deleteMany({}),
    User.deleteMany({}),
  ]);
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 60000);

async function createPkrSeller() {
  const seller = await User.create({
    username: `ai-pkr-seller-${Date.now()}`,
    email: `ai-pkr-seller-${Date.now()}@example.com`,
    role: 'seller',
    // Account/display currency may differ from the store's native catalog.
    currency: 'USD',
  });
  await Store.create({
    seller: seller._id,
    storeName: 'PKR Native AI Store',
    storeSlug: `pkr-native-ai-${seller._id}`,
    productCurrency: 'PKR',
    productCurrencyStatus: 'active',
    isActive: true,
  });
  return seller;
}

async function createProduct(seller, overrides = {}) {
  return Product.create({
    seller: seller._id,
    name: `PKR Product ${Date.now()}`,
    description: 'PKR-native product used to verify AI money writes.',
    price: 6000,
    currency: 'PKR',
    priceCurrency: 'PKR',
    priceInputAmount: 6000,
    category: 'Test',
    brand: 'Rozare',
    stock: 5,
    image: 'https://example.com/pkr-ai-product.jpg',
    images: [{ url: 'https://example.com/pkr-ai-product.jpg' }],
    ...overrides,
  });
}

describe('AI seller-native money writes', () => {
  test('wishlist product cards preserve native currency, stock, and review metadata', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller, {
      name: 'Native PKR Wishlist Product',
      price: 1850,
      discountedPrice: 1690,
      discountedPriceCurrency: 'PKR',
      stock: 27,
      rating: 4.5,
      numReviews: 8,
    });
    await User.findByIdAndUpdate(seller._id, { $addToSet: { wishlist: product._id } });

    const result = await executeToolCall('get_wishlist', {}, seller);

    expect(result).toMatchObject({
      success: true,
      data: {
        count: 1,
        items: [{
          _id: product._id,
          name: 'Native PKR Wishlist Product',
          price: 1850,
          discountedPrice: 1690,
          currency: 'PKR',
          priceCurrency: 'PKR',
          discountedPriceCurrency: 'PKR',
          stock: 27,
          inStock: true,
          rating: 4.5,
          numReviews: 8,
        }],
      },
    });
  });

  test.each([0.001, 0.005, 10.001])(
    'rejects non-exact-cent product create, edit, and bulk money before persistence: %s', async invalidAmount => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller);

    const createResult = await executeToolCall('add_product', {
      name: 'Sub-cent AI product',
      description: 'Must never be persisted as a free product.',
      price: invalidAmount,
      currency: 'USD',
      category: 'Test',
      brand: 'Rozare',
      stock: 1,
      image: 'https://example.com/sub-cent.jpg',
    }, seller);
    const editResult = await executeToolCall('edit_product', {
      productId: product._id.toString(),
      updates: { price: invalidAmount, currency: 'USD' },
    }, seller);
    const bulkSetResult = await executeToolCall('bulk_price_update', {
      productIds: [product._id.toString()],
      updateType: 'set',
      value: invalidAmount,
      currency: 'USD',
    }, seller);
    const bulkFixedResult = await executeToolCall('bulk_price_update', {
      productIds: [product._id.toString()],
      updateType: 'fixed',
      value: invalidAmount,
      currency: 'USD',
      _chatRequestKey: `sub-cent-fixed:${invalidAmount}`,
      _chatToolOrdinal: 0,
    }, seller);

    for (const result of [createResult, editResult, bulkSetResult, bulkFixedResult]) {
      expect(result).toMatchObject({ success: false });
    }
    await expect(Product.countDocuments({ seller: seller._id })).resolves.toBe(1);
    await expect(Product.findById(product._id).then(doc => doc.price)).resolves.toBe(6000);
    }
  );

  test('plain edit input uses active store currency and converts a retained legacy discount atomically', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller, {
      price: 10,
      currency: 'USD',
      priceCurrency: 'USD',
      priceInputAmount: 10,
      discountedPrice: 0.5,
      discountedPriceCurrency: 'USD',
      discountedPriceInputAmount: 0.5,
    });

    const result = await executeToolCall('edit_product', {
      productId: product._id.toString(),
      updates: { price: 5000 },
      _lastUserText: 'Set this product price to 5000',
    }, seller);

    expect(result.success).toBe(true);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      price: 5000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      priceInputAmount: 5000,
      discountedPrice: 140,
      discountedPriceCurrency: 'PKR',
      discountedPriceInputAmount: 140,
      priceVersion: 2,
    });
  });

  test('discount-only edit and removal preserve the final price invariant', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller);

    const editResult = await executeToolCall('edit_product', {
      productId: product._id.toString(),
      updates: { discountedPrice: 500 },
    }, seller);
    expect(editResult.success).toBe(true);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      price: 6000,
      discountedPrice: 500,
      discountedPriceInputAmount: 500,
      currency: 'PKR',
    });

    const removeResult = await executeToolCall('remove_discount', {
      productIds: [product._id.toString()],
    }, seller);
    expect(removeResult.success).toBe(true);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      price: 6000,
      discountedPrice: 0,
      discountedPriceInputAmount: 0,
    });
  });

  test('plain bulk set and fixed discount amounts stay in the active store currency', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller);

    const priceResult = await executeToolCall('bulk_price_update', {
      productIds: [product._id.toString()],
      updateType: 'set',
      value: 7000,
      _lastUserText: 'Set this price to 7000',
    }, seller);
    expect(priceResult.success).toBe(true);

    const discountResult = await executeToolCall('bulk_discount', {
      productIds: [product._id.toString()],
      discountType: 'fixed',
      discountValue: 500,
      _lastUserText: 'Give it a 500 discount',
    }, seller);
    expect(discountResult.success).toBe(true);

    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      price: 7000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      discountedPrice: 6500,
      discountedPriceCurrency: 'PKR',
    });
  });

  test('converts an explicitly USD-denominated product write into the active PKR store currency', async () => {
    const seller = await createPkrSeller();

    const result = await executeToolCall('add_product', {
      name: 'Explicit USD Input Bag',
      description: 'A durable bag used to verify explicit source-currency conversion.',
      price: 10,
      currency: 'USD',
      category: 'Accessories',
      brand: 'Rozare',
      stock: 5,
      image: 'https://example.com/explicit-usd-input-bag.jpg',
    }, seller);

    expect(result.success).toBe(true);
    await expect(Product.findOne({ seller: seller._id, name: 'Explicit USD Input Bag' }).lean()).resolves.toMatchObject({
      price: 2800,
      currency: 'PKR',
      priceCurrency: 'PKR',
      priceInputAmount: 2800,
    });
  });

  test('converts an explicitly USD-denominated bulk set into the active PKR store currency', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller);

    const result = await executeToolCall('bulk_price_update', {
      productIds: [product._id.toString()],
      updateType: 'set',
      value: 10,
      currency: 'USD',
    }, seller);

    expect(result.success).toBe(true);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      price: 2800,
      currency: 'PKR',
      priceCurrency: 'PKR',
      priceInputAmount: 2800,
    });
  });

  test('converts a legacy USD bulk percentage update once and replays its transactional receipt', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller, {
      price: 10,
      discountedPrice: 5,
      currency: 'USD',
      priceCurrency: 'USD',
      discountedPriceCurrency: 'USD',
      priceInputAmount: null,
      discountedPriceInputAmount: null,
    });
    await Product.collection.updateOne(
      { _id: product._id },
      {
        $unset: {
          currency: '',
          priceCurrency: '',
          discountedPriceCurrency: '',
        },
      },
    );
    const args = {
      productIds: [product._id.toString()],
      updateType: 'percentage',
      value: 10,
      _chatRequestKey: 'once:bulk-price-lost-response',
      _chatToolOrdinal: 0,
    };

    const first = await executeToolCall('bulk_price_update', args, seller);
    const replay = await executeToolCall('bulk_price_update', args, seller);

    expect(first).toEqual(expect.objectContaining({ success: true }));
    expect(replay).toEqual(first);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      price: 3080,
      currency: 'PKR',
      priceCurrency: 'PKR',
      priceInputAmount: 3080,
      discountedPrice: 1400,
      discountedPriceCurrency: 'PKR',
      discountedPriceInputAmount: 1400,
    });
    await expect(AIActionReceipt.countDocuments({ user: seller._id })).resolves.toBe(1);

    const conflict = await executeToolCall('bulk_price_update', {
      ...args,
      value: 20,
    }, seller);
    expect(conflict).toMatchObject({
      success: false,
      code: 'AI_ACTION_IDEMPOTENCY_CONFLICT',
    });
    await expect(Product.findById(product._id).then(doc => doc.price)).resolves.toBe(3080);
  });

  test('fails closed before a relative bulk price update without an idempotency key', async () => {
    const seller = await createPkrSeller();
    const product = await createProduct(seller);

    const result = await executeToolCall('bulk_price_update', {
      productIds: [product._id.toString()],
      updateType: 'fixed',
      value: 100,
    }, seller);

    expect(result).toMatchObject({
      success: false,
      code: 'AI_ACTION_IDEMPOTENCY_REQUIRED',
    });
    await expect(Product.findById(product._id).then(doc => doc.price)).resolves.toBe(6000);
  });

  test('cost-only shipping edits retain existing currency and new methods use store currency', async () => {
    const seller = await createPkrSeller();
    await ShippingMethod.create({
      seller: seller._id,
      methods: [{
        type: 'standard',
        cost: 500,
        currency: 'PKR',
        costCurrency: 'PKR',
        costInputAmount: 500,
        deliveryDays: 4,
        isActive: true,
      }],
    });

    const editResult = await executeToolCall('update_shipping', {
      method: 'standard',
      cost: 600,
    }, seller);
    expect(editResult.success).toBe(true);

    const newResult = await executeToolCall('update_shipping', {
      method: 'fast',
      cost: 900,
      deliveryDays: 2,
    }, seller);
    expect(newResult.success).toBe(true);

    const shipping = await ShippingMethod.findOne({ seller: seller._id }).lean();
    expect(shipping.methods.find(method => method.type === 'standard')).toMatchObject({
      cost: 600,
      currency: 'PKR',
      costCurrency: 'PKR',
      costInputAmount: 600,
    });
    expect(shipping.methods.find(method => method.type === 'fast')).toMatchObject({
      cost: 900,
      currency: 'PKR',
      costCurrency: 'PKR',
      costInputAmount: 900,
    });
  });

  test('AI can read an unconfigured inactive paid shipping slot with zero cost', async () => {
    const seller = await createPkrSeller();
    await ShippingMethod.create({
      seller: seller._id,
      methods: [
        {
          type: 'standard',
          cost: 500,
          currency: 'PKR',
          costCurrency: 'PKR',
          costInputAmount: 500,
          deliveryDays: 3,
          isActive: true,
        },
        {
          type: 'fast',
          cost: 0,
          currency: 'PKR',
          costCurrency: 'PKR',
          costInputAmount: 0,
          deliveryDays: 2,
          isActive: false,
        },
      ],
    });

    const result = await executeToolCall('get_shipping_methods', {}, seller);

    expect(result.success).toBe(true);
    expect(result.data.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'fast',
        cost: 0,
        costInputAmount: 0,
        currency: 'PKR',
        isActive: false,
      }),
    ]));
  });

  test('AI can deactivate a paid shipping method and reset its unused cost to zero', async () => {
    const seller = await createPkrSeller();
    await ShippingMethod.create({
      seller: seller._id,
      methods: [
        {
          type: 'standard',
          cost: 300,
          currency: 'PKR',
          costCurrency: 'PKR',
          costInputAmount: 300,
          deliveryDays: 3,
          isActive: true,
        },
        {
          type: 'fast',
          cost: 500,
          currency: 'PKR',
          costCurrency: 'PKR',
          costInputAmount: 500,
          deliveryDays: 1,
          isActive: true,
        },
      ],
    });

    const deactivate = await executeToolCall('update_shipping', {
      method: 'fast',
      cost: 0,
      currency: 'PKR',
      deliveryDays: 2,
      isActive: false,
    }, seller);

    expect(deactivate.success).toBe(true);
    await expect(ShippingMethod.findOne({ seller: seller._id }).lean()).resolves.toMatchObject({
      methods: expect.arrayContaining([expect.objectContaining({
        type: 'fast',
        cost: 0,
        costInputAmount: 0,
        deliveryDays: 2,
        isActive: false,
      })]),
    });

    const invalidReactivate = await executeToolCall('update_shipping', {
      method: 'fast',
      isActive: true,
    }, seller);
    expect(invalidReactivate).toMatchObject({
      success: false,
      error: expect.stringContaining('active paid shipping method'),
    });
  });

  test('AI shipping preserves an explicit supported currency different from store currency', async () => {
    const seller = await createPkrSeller();

    const result = await executeToolCall('update_shipping', {
      method: 'standard',
      cost: 10,
      currency: 'USD',
    }, seller);

    expect(result.success).toBe(true);
    await expect(ShippingMethod.findOne({ seller: seller._id }).lean()).resolves.toMatchObject({
      methods: [expect.objectContaining({
        type: 'standard',
        cost: 10,
        currency: 'USD',
        costCurrency: 'USD',
        costInputAmount: 10,
      })],
    });
  });

  test('plain fixed-coupon amounts use store currency instead of account currency', async () => {
    const seller = await createPkrSeller();

    const result = await executeToolCall('create_coupon', {
      code: 'PKR500',
      discountType: 'fixed',
      discountValue: 500,
      expiryDate: '2027-08-20T00:00:00.000Z',
      _lastUserText: 'Create a coupon for 500 off',
    }, seller);

    expect(result.success).toBe(true);
    await expect(Coupon.findOne({ seller: seller._id }).lean()).resolves.toMatchObject({
      code: 'PKR500',
      discountType: 'fixed',
      discountValue: 500,
      currency: 'PKR',
    });
  });

  test('AI coupon creation converts an explicit foreign amount into the active store currency', async () => {
    const seller = await createPkrSeller();

    const result = await executeToolCall('create_coupon', {
      code: 'USD10',
      discountType: 'fixed',
      discountValue: 10,
      currency: 'USD',
      expiryDate: '2027-08-20T00:00:00.000Z',
    }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    await expect(Coupon.findOne({ seller: seller._id }).lean()).resolves.toMatchObject({
      code: 'USD10',
      discountType: 'fixed',
      discountValue: 2800,
      currency: 'PKR',
    });
  });

  test('AI coupon currency change converts all retained USD amounts to PKR from one snapshot', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'USDTERMS',
      discountType: 'fixed',
      discountValue: 10,
      currency: 'USD',
      minOrderAmount: 20,
      maxDiscountAmount: 5,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });

    const result = await executeToolCall('update_coupon', {
      couponId: coupon._id.toString(),
      updates: { currency: 'PKR' },
    }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    await expect(Coupon.findById(coupon._id).lean()).resolves.toMatchObject({
      currency: 'PKR',
      discountValue: 2800,
      minOrderAmount: 5600,
      maxDiscountAmount: 1400,
    });
  });

  test('AI coupon update keeps explicit PKR discount and converts only retained USD terms', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'MIXEDTERMS',
      discountType: 'fixed',
      discountValue: 10,
      currency: 'USD',
      minOrderAmount: 20,
      maxDiscountAmount: 5,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });

    const result = await executeToolCall('update_coupon', {
      couponId: coupon._id.toString(),
      updates: { currency: 'PKR', discountValue: 500 },
    }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    await expect(Coupon.findById(coupon._id).lean()).resolves.toMatchObject({
      currency: 'PKR',
      discountValue: 500,
      minOrderAmount: 5600,
      maxDiscountAmount: 1400,
    });
  });

  test('AI coupon update rejects a positive minimum that would silently round to zero', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'TINYMIN',
      discountType: 'fixed',
      discountValue: 500,
      currency: 'PKR',
      minOrderAmount: 10,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });

    const result = await executeToolCall('update_coupon', {
      couponId: coupon._id.toString(),
      updates: { minOrderAmount: 0.004 },
    }, seller);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('at least 0.01'),
    });
    await expect(Coupon.findById(coupon._id).lean()).resolves.toMatchObject({
      minOrderAmount: 10,
    });
  });

  test('AI coupon currency change fails closed when retained terms lack trusted rates', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'FXCLOSED',
      discountType: 'fixed',
      discountValue: 10,
      currency: 'USD',
      minOrderAmount: 20,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });
    getExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
      capturedAt: '2026-08-24T00:00:00.000Z',
      source: 'fallback',
      fallback: true,
    });

    const result = await executeToolCall('update_coupon', {
      couponId: coupon._id.toString(),
      updates: { currency: 'PKR' },
    }, seller);

    expect(result).toMatchObject({
      success: false,
      code: 'EXCHANGE_RATES_UNAVAILABLE',
    });
    await expect(Coupon.findById(coupon._id).lean()).resolves.toMatchObject({
      currency: 'USD',
      discountValue: 10,
      minOrderAmount: 20,
    });
  });

  test('AI coupon currency change rejects a target other than the active store currency', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'NOEUR',
      discountType: 'fixed',
      discountValue: 10,
      currency: 'USD',
      minOrderAmount: 20,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });

    const result = await executeToolCall('update_coupon', {
      couponId: coupon._id.toString(),
      updates: { currency: 'EUR' },
    }, seller);

    expect(result).toMatchObject({
      success: false,
      code: 'COUPON_CURRENCY_STORE_MISMATCH',
    });
    expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
    await expect(Coupon.findById(coupon._id).lean()).resolves.toMatchObject({
      currency: 'USD',
      discountValue: 10,
      minOrderAmount: 20,
    });
  });

  test('AI coupon update exposes an optimistic write conflict as retryable', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'STALEUPDATE',
      discountType: 'fixed',
      discountValue: 500,
      currency: 'PKR',
      expiryDate: '2027-08-20T00:00:00.000Z',
    });
    const saveSpy = jest.spyOn(Coupon.prototype, 'save').mockRejectedValueOnce(
      Object.assign(new Error('stale coupon version'), { name: 'VersionError' }),
    );

    try {
      const result = await executeToolCall('update_coupon', {
        couponId: coupon._id.toString(),
        updates: { description: 'New description' },
      }, seller);

      expect(result).toMatchObject({
        success: false,
        code: 'COUPON_UPDATE_CONFLICT',
      });
    } finally {
      saveSpy.mockRestore();
    }
  });

  test('AI coupon update converts an explicitly USD-denominated replacement into existing PKR currency', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'TEXTUSD',
      discountType: 'fixed',
      discountValue: 500,
      currency: 'PKR',
      minOrderAmount: 2000,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });

    const result = await executeToolCall('update_coupon', {
      couponId: coupon._id.toString(),
      updates: { discountValue: '$5' },
    }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    await expect(Coupon.findById(coupon._id).lean()).resolves.toMatchObject({
      currency: 'PKR',
      discountValue: 1400,
      minOrderAmount: 2000,
    });
  });

  test('AI fixed-tax currency change converts a retained USD value to PKR with trusted rates', async () => {
    const seller = await createPkrSeller();
    await TaxConfig.create({ type: 'fixed', value: 10, currency: 'USD', isActive: true });

    const result = await executeToolCall('update_tax_config', { currency: 'PKR' }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).toHaveBeenCalledTimes(1);
    await expect(TaxConfig.findOne({ isActive: true }).lean()).resolves.toMatchObject({
      type: 'fixed',
      value: 2800,
      currency: 'PKR',
    });
  });

  test('AI fixed-tax update interprets an explicit replacement in the requested new currency', async () => {
    const seller = await createPkrSeller();
    await TaxConfig.create({ type: 'fixed', value: 10, currency: 'USD', isActive: true });

    const result = await executeToolCall('update_tax_config', {
      currency: 'PKR',
      value: 500,
    }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
    await expect(TaxConfig.findOne({ isActive: true }).lean()).resolves.toMatchObject({
      type: 'fixed',
      value: 500,
      currency: 'PKR',
    });
  });

  test('AI fixed-tax retained conversion fails closed on fallback rates', async () => {
    const seller = await createPkrSeller();
    await TaxConfig.create({ type: 'fixed', value: 10, currency: 'USD', isActive: true });
    getExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 },
      capturedAt: '2026-08-24T00:00:00.000Z',
      source: 'fallback',
      fallback: true,
    });

    const result = await executeToolCall('update_tax_config', { currency: 'PKR' }, seller);

    expect(result).toMatchObject({ success: false, code: 'EXCHANGE_RATES_UNAVAILABLE' });
    await expect(TaxConfig.findOne({ isActive: true }).lean()).resolves.toMatchObject({
      value: 10,
      currency: 'USD',
    });
  });

  test('AI fixed-tax currency change keeps an exact zero without requesting FX', async () => {
    const seller = await createPkrSeller();
    await TaxConfig.create({ type: 'fixed', value: 0, currency: 'USD', isActive: true });

    const result = await executeToolCall('update_tax_config', { currency: 'PKR' }, seller);

    expect(result.success).toBe(true);
    expect(getExchangeRateSnapshot).not.toHaveBeenCalled();
    await expect(TaxConfig.findOne({ isActive: true }).lean()).resolves.toMatchObject({
      type: 'fixed',
      value: 0,
      currency: 'PKR',
    });
  });

  test('AI tax type change cannot reinterpret a percentage as money without a new value', async () => {
    const seller = await createPkrSeller();
    await TaxConfig.create({ type: 'percentage', value: 10, currency: 'USD', isActive: true });

    const result = await executeToolCall('update_tax_config', {
      type: 'fixed',
      currency: 'PKR',
    }, seller);

    expect(result).toMatchObject({
      success: false,
      code: 'TAX_VALUE_REQUIRED_FOR_TYPE_CHANGE',
    });
    await expect(TaxConfig.findOne({ isActive: true }).lean()).resolves.toMatchObject({
      type: 'percentage',
      value: 10,
    });
  });

  test('replays a lost toggle-coupon response without toggling the coupon back', async () => {
    const seller = await createPkrSeller();
    const coupon = await Coupon.create({
      seller: seller._id,
      code: 'TOGGLEONCE',
      discountType: 'percentage',
      discountValue: 10,
      currency: 'PKR',
      isActive: true,
      expiryDate: '2027-08-20T00:00:00.000Z',
    });
    const args = {
      couponId: coupon._id.toString(),
      _chatRequestKey: 'once:toggle-coupon-lost-response',
      _chatToolOrdinal: 0,
    };

    const first = await executeToolCall('toggle_coupon', args, seller);
    // Simulate a response that reached the server but was lost before the
    // client observed it: retry the exact logical request and execution slot.
    const replay = await executeToolCall('toggle_coupon', args, seller);

    expect(first).toEqual(expect.objectContaining({ success: true }));
    expect(replay).toEqual(first);
    await expect(Coupon.findById(coupon._id).then(doc => doc.isActive)).resolves.toBe(false);
    await expect(AIActionReceipt.countDocuments({ user: seller._id })).resolves.toBe(1);
  });

  test('replays a lost add-product response without creating a duplicate listing', async () => {
    const seller = await createPkrSeller();
    const args = {
      name: 'Replay Guard Handbag',
      description: 'A durable leather handbag with a secure zipper and reinforced shoulder strap.',
      price: 6500,
      category: 'Accessories',
      brand: 'Replay Guard',
      stock: 4,
      image: 'https://example.com/replay-guard-handbag.jpg',
      _chatRequestKey: 'once:add-product-lost-response',
      _chatToolOrdinal: 0,
    };

    const first = await executeToolCall('add_product', args, seller);
    const replay = await executeToolCall('add_product', args, seller);

    expect(first).toEqual(expect.objectContaining({ success: true }));
    expect(replay).toEqual(first);
    await expect(Product.countDocuments({ seller: seller._id, name: args.name })).resolves.toBe(1);
    await expect(AIActionReceipt.countDocuments({ user: seller._id })).resolves.toBe(1);
  });

  test('retains an add-product claim after an ambiguous post-save failure', async () => {
    const seller = await createPkrSeller();
    const args = {
      name: 'Ambiguous Commit Handbag',
      description: 'A production catalog item used to verify safe recovery after a lost response.',
      price: 7200,
      category: 'Accessories',
      brand: 'Replay Guard',
      stock: 3,
      image: 'https://example.com/ambiguous-commit-handbag.jpg',
      _chatRequestKey: 'once:add-product-ambiguous-result',
      _chatToolOrdinal: 0,
    };
    formatMoney.mockRejectedValueOnce(new Error('simulated response formatting failure'));

    const first = await executeToolCall('add_product', args, seller);
    const retry = await executeToolCall('add_product', args, seller);

    expect(first).toMatchObject({ success: false, code: 'AI_ACTION_PENDING' });
    expect(retry).toMatchObject({ success: false, code: 'AI_ACTION_PENDING' });
    await expect(Product.countDocuments({ seller: seller._id, name: args.name })).resolves.toBe(1);
    await expect(AIActionReceipt.findOne({ user: seller._id }).lean()).resolves.toMatchObject({
      action: 'add_product',
      status: 'processing',
    });
  });
});
