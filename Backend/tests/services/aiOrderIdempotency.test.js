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

const Order = require('../../models/Order');
const Cart = require('../../models/Cart');
const Product = require('../../models/Product');
const ShippingMethod = require('../../models/ShippingMethod');
const Store = require('../../models/Store');
const TaxConfig = require('../../models/TaxConfig');
const User = require('../../models/User');
const { getExchangeRateSnapshot } = require('../../services/currencyService');
const checkoutPricingService = require('../../services/checkoutPricingService');
const allocateCheckoutAmountsBySourceActual = checkoutPricingService.allocateCheckoutAmountsBySource;
const allocateCheckoutAmountsBySourceMock = jest
  .spyOn(checkoutPricingService, 'allocateCheckoutAmountsBySource')
  .mockImplementation(allocateCheckoutAmountsBySourceActual);
const { executeToolCall } = require('../../services/aiActionExecutor');

let replSet;

const shippingInfo = {
  fullName: 'AI Buyer',
  email: 'ai-buyer@example.com',
  phone: '+923001234567',
  address: '1 Test Street',
  city: 'Lahore',
  state: 'Punjab',
  postalCode: '54000',
  country: 'Pakistan',
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await Order.syncIndexes();
}, 60000);

beforeEach(() => {
  allocateCheckoutAmountsBySourceMock
    .mockReset()
    .mockImplementation(allocateCheckoutAmountsBySourceActual);
  getExchangeRateSnapshot.mockResolvedValue({
    base: 'USD',
    rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
    capturedAt: '2026-08-20T00:00:00.000Z',
    source: 'test-live',
    fallback: false,
  });
});

afterEach(async () => {
  await Promise.all([
    Order.deleteMany({}),
    Cart.deleteMany({}),
    Product.deleteMany({}),
    ShippingMethod.deleteMany({}),
    Store.deleteMany({}),
    TaxConfig.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 60000);

async function createCatalog() {
  const [buyer, seller] = await Promise.all([
    User.create({ username: 'ai-buyer', email: 'ai-buyer@example.com', role: 'user', currency: 'USD' }),
    User.create({ username: 'ai-seller', email: 'ai-seller@example.com', role: 'seller', currency: 'USD' }),
  ]);
  await Store.create({
    seller: seller._id,
    storeName: 'AI Order Store',
    storeSlug: `ai-order-${seller._id}`,
    logo: 'https://example.com/ai-order-store-logo.png',
    productCurrency: 'USD',
    isActive: true,
    paymentPolicy: 'online_and_cod',
  });
  const product = await Product.create({
    seller: seller._id,
    name: 'Idempotent Shirt',
    description: 'A product used to verify safe AI order replays.',
    price: 12.34,
    currency: 'USD',
    priceCurrency: 'USD',
    category: 'Test',
    brand: 'Rozare',
    stock: 5,
    image: 'https://example.com/idempotent-shirt.jpg',
    images: [{ url: 'https://example.com/idempotent-shirt.jpg' }],
  });
  return { buyer, product };
}

const placeArgs = (product, overrides = {}) => ({
  productId: product._id.toString(),
  quantity: 2,
  shippingInfo,
  paymentMethod: 'cash_on_delivery',
  _chatRequestKey: 'once:stable-logical-request',
  ...overrides,
});

describe('AI COD order idempotency', () => {
  test('requires a server-provided logical request key before any order is written', async () => {
    const { buyer, product } = await createCatalog();
    const args = placeArgs(product);
    delete args._chatRequestKey;

    await expect(executeToolCall('place_order', args, buyer)).resolves.toMatchObject({
      success: false,
      code: 'AI_ORDER_IDEMPOTENCY_REQUIRED',
    });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test('replays the same order without another stock decrement', async () => {
    const { buyer, product } = await createCatalog();
    const args = placeArgs(product);

    const first = await executeToolCall('place_order', args, buyer);
    const replay = await executeToolCall('place_order', args, buyer);

    expect(first).toMatchObject({ success: true, reused: false, data: { total: 24.68, currency: 'USD' } });
    expect(replay).toMatchObject({
      success: true,
      reused: true,
      data: { orderId: first.data.orderId, total: 24.68, currency: 'USD' },
    });
    await expect(Order.countDocuments()).resolves.toBe(1);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 3, totalSales: 2 });
    await expect(Order.findOne({ orderId: first.data.orderId }).lean()).resolves.toMatchObject({
      inventoryCommitted: true,
      awaitingPayment: false,
      checkoutIdempotencyKey: expect.stringMatching(/^ai-[a-f0-9]{64}$/),
      shippingInfo: expect.objectContaining({
        phone: '+923001234567',
        phoneE164: '+923001234567',
        countryCode: 'PK',
      }),
      sellerPolicies: [expect.objectContaining({
        storeName: 'AI Order Store',
        storeLogo: 'https://example.com/ai-order-store-logo.png',
      })],
    });
  });

  test('atomically repairs inventory and cart for a saved legacy uncommitted cart order', async () => {
    const { buyer, product } = await createCatalog();
    const args = {
      shippingInfo,
      paymentMethod: 'cash_on_delivery',
      _chatRequestKey: 'ai:recover-saved-uncommitted-cart-order',
    };
    await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 2 }],
    });

    const first = await executeToolCall('place_order', args, buyer);
    expect(first).toMatchObject({ success: true, reused: false });
    const order = await Order.findOne({ orderId: first.data.orderId }).lean();

    // Recreate the durable state left by a pre-transaction deployment that
    // saved an order before reserving stock or cleaning its authenticated cart.
    await Promise.all([
      Order.updateOne(
        { _id: order._id },
        { $set: { inventoryCommitted: false, awaitingPayment: true, cartCleanupCompletedAt: null } },
      ),
      Product.updateOne(
        { _id: product._id },
        { $set: { stock: 5, totalSales: 0 } },
      ),
      Cart.collection.updateOne(
        { user: buyer._id },
        {
          $set: {
            cartItems: [{
              _id: new mongoose.Types.ObjectId(),
              product: product._id,
              qty: 2,
              selectedColor: null,
            }],
            fulfilledOrderIds: [],
          },
        },
      ),
    ]);
    await expect(Order.findOne({
      _id: order._id,
      awaitingPayment: { $ne: true },
    })).resolves.toBeNull();

    const replay = await executeToolCall('place_order', args, buyer);

    expect(replay).toMatchObject({
      success: true,
      reused: true,
      data: { orderId: first.data.orderId },
    });
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({
      stock: 3,
      totalSales: 2,
    });
    const repairedCart = await Cart.findOne({ user: buyer._id })
      .select('+fulfilledOrderIds')
      .lean();
    expect(repairedCart.cartItems).toHaveLength(0);
    expect(repairedCart.fulfilledOrderIds.map(String)).toContain(String(order._id));
    await expect(Order.findById(order._id).lean()).resolves.toMatchObject({
      inventoryCommitted: true,
      awaitingPayment: false,
      cartCleanupCompletedAt: expect.any(Date),
    });
  });

  test('treats a raw currency-less legacy product as canonical USD even when its store is PKR', async () => {
    const { buyer, product } = await createCatalog();
    await Promise.all([
      Store.updateOne(
        { seller: product.seller },
        { $set: { productCurrency: 'PKR', productCurrencyStatus: 'active' } },
      ),
      Product.collection.updateOne(
        { _id: product._id },
        { $unset: { currency: '', priceCurrency: '', discountedPriceCurrency: '' } },
      ),
    ]);

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: 'ai:legacy-canonical-usd' }),
      buyer,
    );

    expect(result).toMatchObject({
      success: true,
      data: { total: 12.34, currency: 'USD' },
    });
    await expect(Order.findOne().lean()).resolves.toMatchObject({
      orderItems: [expect.objectContaining({
        sourcePrice: 12.34,
        sourceCurrency: 'USD',
        sourceLineSubtotal: 12.34,
        lineSubtotal: 12.34,
      })],
      orderSummary: expect.objectContaining({ subtotal: 12.34, totalAmount: 12.34 }),
    });
  });

  test('treats raw currency-less legacy shipping as USD in a PKR-native checkout', async () => {
    const { buyer, product } = await createCatalog();
    buyer.currency = 'PKR';
    await buyer.save();
    await Promise.all([
      Store.updateOne(
        { seller: product.seller },
        { $set: { productCurrency: 'PKR', productCurrencyStatus: 'active' } },
      ),
      Product.updateOne(
        { _id: product._id },
        { $set: { price: 3500, currency: 'PKR', priceCurrency: 'PKR', priceInputAmount: 3500 } },
      ),
    ]);
    const shipping = await ShippingMethod.create({
      seller: product.seller,
      methods: [{
        type: 'standard',
        cost: 10,
        currency: 'USD',
        costCurrency: 'USD',
        costInputAmount: 10,
        deliveryDays: 4,
        isActive: true,
      }],
    });
    await ShippingMethod.collection.updateOne(
      { _id: shipping._id },
      {
        $unset: {
          'methods.0.currency': '',
          'methods.0.costCurrency': '',
          'methods.0.costInputAmount': '',
        },
      },
    );

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: 'ai:legacy-shipping-usd' }),
      buyer,
    );

    expect(result).toMatchObject({
      success: true,
      data: { total: 6300, currency: 'PKR' },
    });
    await expect(Order.findOne().lean()).resolves.toMatchObject({
      sellerShipping: [expect.objectContaining({
        shippingMethod: expect.objectContaining({
          sourceCost: 10,
          sourceCurrency: 'USD',
          price: 2800,
        }),
      })],
      orderSummary: expect.objectContaining({
        subtotal: 3500,
        shippingCost: 2800,
        totalAmount: 6300,
      }),
    });
  });

  test.each([
    ['unsupported currency', { currency: 'CAD' }, 'PRODUCT_CURRENCY_METADATA_INVALID'],
    ['null currency', { currency: null }, 'PRODUCT_CURRENCY_METADATA_INVALID'],
    ['blank currency', { currency: '' }, 'PRODUCT_CURRENCY_METADATA_INVALID'],
    ['non-string currency', { currency: false }, 'PRODUCT_CURRENCY_METADATA_INVALID'],
    ['conflicting currency', { currency: 'PKR', priceCurrency: 'USD' }, 'PRODUCT_CURRENCY_METADATA_INVALID'],
    ['non-finite price', { price: Number.POSITIVE_INFINITY }, 'PRODUCT_PRICE_INVALID'],
    ['sub-cent price', { price: 0.001 }, 'PRODUCT_PRICE_INVALID'],
  ])('fails closed before writing an AI order for persisted product %s', async (_label, corruption, code) => {
    const { buyer, product } = await createCatalog();
    await Product.collection.updateOne({ _id: product._id }, { $set: corruption });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: `ai:corrupt-product:${_label}` }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test.each([
    ['boolean stock', true],
    ['string stock', '5'],
    ['negative stock', -1],
    ['fractional stock', 1.5],
    ['non-finite stock', Number.POSITIVE_INFINITY],
  ])('fails closed before writing an AI order for persisted product %s', async (_label, stock) => {
    const { buyer, product } = await createCatalog();
    await Product.collection.updateOne({ _id: product._id }, { $set: { stock } });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: `ai:corrupt-stock:${_label}` }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code: 'PRODUCT_STOCK_INVALID' });
    await expect(Order.countDocuments()).resolves.toBe(0);
  });

  test.each([
    ['unsupported currency', { 'methods.0.currency': 'CAD' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['null currency', { 'methods.0.currency': null }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['blank currency', { 'methods.0.currency': '' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['lowercase currency', { 'methods.0.currency': 'usd' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['padded currency', { 'methods.0.currency': ' USD ' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['non-string currency', { 'methods.0.currency': false }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['conflicting currency', { 'methods.0.currency': 'PKR', 'methods.0.costCurrency': 'USD' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['sub-cent cost', { 'methods.0.cost': 0.001 }, 'SHIPPING_COST_INVALID'],
    ['sub-cent input amount', { 'methods.0.costInputAmount': 0.001 }, 'SHIPPING_COST_INVALID'],
    ['non-boolean active status', { 'methods.0.isActive': 'true' }, 'SHIPPING_METHOD_INVALID'],
  ])('fails closed before writing an AI order for persisted shipping %s', async (_label, corruption, code) => {
    const { buyer, product } = await createCatalog();
    const shipping = await ShippingMethod.create({
      seller: product.seller,
      methods: [{
        type: 'standard',
        cost: 10,
        currency: 'USD',
        costCurrency: 'USD',
        costInputAmount: 10,
        deliveryDays: 4,
        isActive: true,
      }],
    });
    await ShippingMethod.collection.updateOne({ _id: shipping._id }, { $set: corruption });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: `ai:corrupt-shipping:${_label}` }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test.each([
    ['zero delivery days', 0],
    ['boolean delivery days', false],
    ['string delivery days', '4'],
    ['fractional delivery days', 1.5],
    ['non-finite delivery days', Number.POSITIVE_INFINITY],
    ['unsafe-integer delivery days', Number.MAX_SAFE_INTEGER + 1],
  ])('fails closed before writing an AI order for persisted shipping %s', async (_label, deliveryDays) => {
    const { buyer, product } = await createCatalog();
    const shipping = await ShippingMethod.create({
      seller: product.seller,
      methods: [{
        type: 'standard',
        cost: 10,
        currency: 'USD',
        costCurrency: 'USD',
        costInputAmount: 10,
        deliveryDays: 4,
        isActive: true,
      }],
    });
    await ShippingMethod.collection.updateOne(
      { _id: shipping._id },
      { $set: { 'methods.0.deliveryDays': deliveryDays } },
    );

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: `ai:corrupt-shipping-days:${_label}` }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code: 'SHIPPING_DELIVERY_DAYS_INVALID' });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test.each([
    ['zero quantity', 0],
    ['boolean quantity', false],
    ['string quantity', '2'],
    ['blank quantity', ''],
    ['fractional quantity', 1.5],
    ['non-finite quantity', Number.NaN],
    ['unsafe-integer quantity', Number.MAX_SAFE_INTEGER + 1],
  ])('fails closed before writing an AI cart order for persisted %s', async (_label, quantity) => {
    const { buyer, product } = await createCatalog();
    const cart = await Cart.create({
      user: buyer._id,
      cartItems: [{ product: product._id, qty: 1 }],
    });
    await Cart.collection.updateOne(
      { _id: cart._id },
      { $set: { 'cartItems.0.qty': quantity } },
    );

    const result = await executeToolCall('place_order', {
      shippingInfo,
      paymentMethod: 'cash_on_delivery',
      _chatRequestKey: `ai:corrupt-cart-quantity:${_label}`,
    }, buyer);

    expect(result).toMatchObject({ success: false, code: 'ORDER_QUANTITY_INVALID' });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test.each([
    ['missing allocated price', null],
    ['boolean allocated price', false],
    ['string allocated price', '0'],
    ['sub-cent allocated price', 0.001],
    ['non-finite allocated price', Number.NaN],
  ])('fails closed before writing an AI order for %s', async (_label, targetAmount) => {
    const { buyer, product } = await createCatalog();
    allocateCheckoutAmountsBySourceMock.mockImplementationOnce(async ({ entries }) => (
      entries.map(entry => ({ ...entry, targetAmount }))
    ));

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: `ai:corrupt-allocated-shipping:${_label}` }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code: 'AI_FINANCIAL_DATA_INVALID' });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test('keeps nullish legacy cart quantity and shipping-day defaults without accepting present corruption', async () => {
    const { buyer, product } = await createCatalog();
    const [cart, shipping] = await Promise.all([
      Cart.create({
        user: buyer._id,
        cartItems: [{ product: product._id, qty: 1 }],
      }),
      ShippingMethod.create({
        seller: product.seller,
        methods: [{
          type: 'standard',
          cost: 10,
          currency: 'USD',
          costCurrency: 'USD',
          costInputAmount: 10,
          deliveryDays: 4,
          isActive: true,
        }],
      }),
    ]);
    await Promise.all([
      Cart.collection.updateOne(
        { _id: cart._id },
        { $unset: { 'cartItems.0.qty': '' } },
      ),
      ShippingMethod.collection.updateOne(
        { _id: shipping._id },
        { $unset: { 'methods.0.deliveryDays': '' } },
      ),
    ]);

    const result = await executeToolCall('place_order', {
      shippingInfo,
      paymentMethod: 'cash_on_delivery',
      _chatRequestKey: 'ai:nullish-legacy-checkout-defaults',
    }, buyer);

    expect(result).toMatchObject({ success: true, data: { total: 22.34, currency: 'USD' } });
    await expect(Order.findOne().lean()).resolves.toMatchObject({
      orderItems: [expect.objectContaining({ quantity: 1 })],
      shippingMethod: expect.objectContaining({ estimatedDays: 5 }),
      orderSummary: expect.objectContaining({ shippingCost: 10, totalAmount: 22.34 }),
    });
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 4, totalSales: 1 });
  });

  test.each([
    ['unsupported type', { type: 'bogus' }],
    ['unsupported currency', { currency: 'CAD' }],
    ['null currency', { currency: null }],
    ['blank currency', { currency: '' }],
    ['lowercase currency', { currency: 'usd' }],
    ['padded currency', { currency: ' USD ' }],
    ['non-string currency', { currency: false }],
    ['non-finite fixed value', { value: Number.POSITIVE_INFINITY }],
    ['sub-cent fixed value', { value: 0.001 }],
    ['over-precise percentage', { type: 'percentage', value: 7.1234567 }],
  ])('fails closed before writing an AI order for persisted tax %s', async (_label, corruption) => {
    const { buyer, product } = await createCatalog();
    const tax = await TaxConfig.create({ type: 'fixed', value: 1, currency: 'USD', isActive: true });
    await TaxConfig.collection.updateOne({ _id: tax._id }, { $set: corruption });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: `ai:corrupt-tax:${_label}` }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code: 'TAX_CONFIG_INVALID' });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test('rolls back the order insert when inventory commit fails and succeeds on the same-key retry', async () => {
    const { buyer, product } = await createCatalog();
    const args = placeArgs(product, { _chatRequestKey: 'ai:inventory-failure-retry' });
    const stockUpdate = jest.spyOn(Product, 'updateOne')
      .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });

    const failed = await executeToolCall('place_order', args, buyer);
    stockUpdate.mockRestore();

    expect(failed).toMatchObject({ success: false, code: 'ORDER_STOCK_CHANGED' });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });

    const retried = await executeToolCall('place_order', args, buyer);
    expect(retried).toMatchObject({ success: true, reused: false });
    await expect(Order.countDocuments()).resolves.toBe(1);
    await expect(Order.findOne().lean()).resolves.toMatchObject({ inventoryCommitted: true });
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 3, totalSales: 2 });
  });

  test('refuses same-currency PKR checkout when seller settlement FX cannot be frozen', async () => {
    const { buyer, product } = await createCatalog();
    buyer.currency = 'PKR';
    await buyer.save();
    await Promise.all([
      Store.updateOne({ seller: product.seller }, { $set: { productCurrency: 'PKR' } }),
      Product.updateOne({ _id: product._id }, {
        $set: { price: 3500, currency: 'PKR', priceCurrency: 'PKR', priceInputAmount: 3500 },
      }),
    ]);
    getExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: '2026-08-20T00:00:00.000Z',
      source: 'fallback',
      fallback: true,
    });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: 'ai:pkr-fallback' }),
      buyer
    );

    expect(result).toMatchObject({ success: false, code: 'EXCHANGE_RATES_UNAVAILABLE' });
    await expect(Order.countDocuments()).resolves.toBe(0);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 5, totalSales: 0 });
  });

  test('does not require FX for an exact-zero foreign fixed tax', async () => {
    const { buyer, product } = await createCatalog();
    await TaxConfig.create({
      type: 'fixed',
      value: 0,
      currency: 'PKR',
      isActive: true,
    });
    getExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: '2026-08-20T00:00:00.000Z',
      source: 'fallback',
      fallback: true,
    });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: 'ai:zero-fixed-tax' }),
      buyer,
    );

    expect(result).toMatchObject({ success: true, data: { total: 12.34, currency: 'USD' } });
    await expect(Order.findOne().lean()).resolves.toMatchObject({
      orderSummary: expect.objectContaining({ tax: 0, totalAmount: 12.34 }),
    });
  });

  test('still requires trusted FX for one positive foreign source cent even when target rounds to zero', async () => {
    const { buyer, product } = await createCatalog();
    await TaxConfig.create({
      type: 'fixed',
      value: 0.01,
      currency: 'PKR',
      isActive: true,
    });
    getExchangeRateSnapshot.mockResolvedValueOnce({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: '2026-08-20T00:00:00.000Z',
      source: 'fallback',
      fallback: true,
    });

    const result = await executeToolCall(
      'place_order',
      placeArgs(product, { quantity: 1, _chatRequestKey: 'ai:positive-fixed-tax' }),
      buyer,
    );

    expect(result).toMatchObject({ success: false, code: 'EXCHANGE_RATES_UNAVAILABLE' });
    await expect(Order.countDocuments()).resolves.toBe(0);
  });

  test('rejects reuse of one request key with different order details', async () => {
    const { buyer, product } = await createCatalog();
    const first = await executeToolCall('place_order', placeArgs(product), buyer);
    const conflicting = await executeToolCall('place_order', placeArgs(product, { quantity: 1 }), buyer);

    expect(first.success).toBe(true);
    expect(conflicting).toMatchObject({ success: false, code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(Order.countDocuments()).resolves.toBe(1);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 3, totalSales: 2 });
  });

  test('concurrent delivery of one logical request creates and reserves stock once', async () => {
    const { buyer, product } = await createCatalog();
    const args = placeArgs(product, { _chatRequestKey: 'whatsapp:one-inbound-message' });

    const results = await Promise.all([
      executeToolCall('place_order', args, buyer),
      executeToolCall('place_order', args, buyer),
    ]);

    expect(results.every(result => result.success)).toBe(true);
    expect(new Set(results.map(result => result.data.orderId)).size).toBe(1);
    await expect(Order.countDocuments()).resolves.toBe(1);
    await expect(Product.findById(product._id).lean()).resolves.toMatchObject({ stock: 3, totalSales: 2 });
  });
});
