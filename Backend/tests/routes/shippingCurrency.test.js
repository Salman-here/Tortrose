const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

const shippingRoutes = require('../../routes/shippingRoutes');
const Product = require('../../models/Product');
const ShippingMethod = require('../../models/ShippingMethod');
const Store = require('../../models/Store');
const User = require('../../models/User');

let mongoServer;
let app;

const tokenFor = (user) =>
  `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}`;

const createSeller = () =>
  User.create({
    username: `seller-${Date.now()}-${Math.random()}`,
    email: `seller-${Date.now()}-${Math.random()}@test.com`,
    password: 'password123',
    role: 'seller',
    currency: 'PKR',
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'shipping-currency-test-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/shipping', shippingRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([
    Product.deleteMany({}),
    ShippingMethod.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
}, 60000);

describe('shipping currency', () => {
  test('stores seller shipping cost in the seller selected currency', async () => {
    const seller = await createSeller();

    const res = await request(app)
      .put('/api/shipping/methods')
      .set('Authorization', tokenFor(seller))
      .send({
        currency: 'PKR',
        methods: [
          { type: 'standard', cost: 500, currency: 'PKR', deliveryDays: 5, isActive: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.shippingMethods.methods[0]).toMatchObject({
      type: 'standard',
      cost: 500,
      currency: 'PKR',
      costCurrency: 'PKR',
      costInputAmount: 500,
    });

    const saved = await ShippingMethod.findOne({ seller: seller._id }).lean();
    expect(saved.methods[0]).toMatchObject({
      cost: 500,
      currency: 'PKR',
      costCurrency: 'PKR',
      costInputAmount: 500,
    });
  });

  test('returns native shipping currency for checkout', async () => {
    const seller = await createSeller();
    await Store.create({
      seller: seller._id,
      storeName: 'Advance Bags',
      storeSlug: `advance-bags-${Date.now()}`,
      paymentPolicy: 'advance_only',
      visibility: { mode: 'global' },
    });
    const product = await Product.create({
      name: 'Native Shipping Product',
      description: 'Product for checkout shipping currency',
      price: 1000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Test',
      brand: 'Test Brand',
      stock: 5,
      image: 'https://example.com/product.jpg',
      images: [{ url: 'https://example.com/product.jpg' }],
      seller: seller._id,
    });
    await ShippingMethod.create({
      seller: seller._id,
      methods: [
        { type: 'standard', cost: 500, currency: 'PKR', costCurrency: 'PKR', costInputAmount: 500, deliveryDays: 5, isActive: true },
      ],
    });

    const res = await request(app)
      .post('/api/shipping/cart')
      .send({ cartItems: [{ productId: product._id.toString() }] });

    expect(res.status).toBe(200);
    expect(res.body.shippingMethods[seller._id.toString()].methods[0]).toMatchObject({
      type: 'standard',
      cost: 500,
      currency: 'PKR',
      costCurrency: 'PKR',
    });
    expect(res.body.shippingMethods[seller._id.toString()]).toMatchObject({
      paymentPolicy: 'advance_only',
      allowsCashOnDelivery: false,
      store: expect.objectContaining({ storeName: 'Advance Bags' }),
    });
  });

  test('stores disabled unconfigured paid slots without exposing them at checkout', async () => {
    const seller = await createSeller();
    const product = await Product.create({
      name: 'Inactive Shipping Slot Product',
      description: 'Regression fixture for dashboard shipping configuration',
      price: 1000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Test',
      brand: 'Test Brand',
      stock: 5,
      image: 'https://example.com/product.jpg',
      images: [{ url: 'https://example.com/product.jpg' }],
      seller: seller._id,
    });

    const saveResponse = await request(app)
      .put('/api/shipping/methods')
      .set('Authorization', tokenFor(seller))
      .send({
        currency: 'PKR',
        methods: [
          { type: 'standard', cost: 300, currency: 'PKR', deliveryDays: 3, isActive: true },
          { type: 'fast', cost: 0, currency: 'PKR', deliveryDays: 2, isActive: false },
        ],
      });

    expect(saveResponse.status).toBe(200);
    expect(saveResponse.body.shippingMethods.methods[1]).toMatchObject({
      type: 'fast',
      cost: 0,
      costInputAmount: 0,
      currency: 'PKR',
      isActive: false,
    });

    const checkoutResponse = await request(app)
      .post('/api/shipping/cart')
      .send({ cartItems: [{ productId: product._id.toString() }] });

    expect(checkoutResponse.status).toBe(200);
    expect(checkoutResponse.body.shippingMethods[seller._id.toString()].methods).toEqual([
      expect.objectContaining({ type: 'standard', cost: 300, isActive: true }),
    ]);
  });

  test('returns a raw currency-less legacy shipping cost as canonical USD', async () => {
    const seller = await createSeller();
    await Store.create({
      seller: seller._id,
      storeName: 'PKR Store With Legacy Shipping',
      storeSlug: `legacy-shipping-${Date.now()}`,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      visibility: { mode: 'global' },
    });
    const product = await Product.create({
      name: 'Legacy Shipping Product',
      description: 'Product for legacy shipping currency regression',
      price: 1000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Test',
      brand: 'Test Brand',
      stock: 5,
      image: 'https://example.com/product.jpg',
      images: [{ url: 'https://example.com/product.jpg' }],
      seller: seller._id,
    });
    const shipping = await ShippingMethod.create({
      seller: seller._id,
      methods: [{
        type: 'standard',
        cost: 500,
        currency: 'USD',
        costCurrency: 'USD',
        costInputAmount: 500,
        deliveryDays: 5,
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

    const res = await request(app)
      .post('/api/shipping/cart')
      .send({ cartItems: [{ productId: product._id.toString() }] });

    expect(res.status).toBe(200);
    expect(res.body.shippingMethods[seller._id.toString()].methods[0]).toMatchObject({
      type: 'standard',
      cost: 500,
      currency: 'USD',
      costCurrency: 'USD',
      costInputAmount: 500,
    });
  });

  test('defaults omitted shipping currency to store product currency instead of account currency', async () => {
    const seller = await User.create({
      username: `usd-account-${Date.now()}`,
      email: `usd-account-${Date.now()}@test.com`,
      password: 'password123',
      role: 'seller',
      currency: 'USD',
    });
    await Store.create({
      seller: seller._id,
      storeName: 'PKR Shipping Store',
      storeSlug: `pkr-shipping-${Date.now()}`,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      visibility: { mode: 'global' },
    });

    const res = await request(app)
      .put('/api/shipping/methods')
      .set('Authorization', tokenFor(seller))
      .send({
        methods: [
          { type: 'standard', cost: 500, deliveryDays: 5, isActive: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.shippingMethods.methods[0]).toMatchObject({
      cost: 500,
      currency: 'PKR',
      costCurrency: 'PKR',
      costInputAmount: 500,
    });
  });

  test('preserves an explicit supported shipping currency different from the store currency', async () => {
    const seller = await createSeller();
    await Store.create({
      seller: seller._id,
      storeName: 'PKR Store With USD Shipping',
      storeSlug: `pkr-store-usd-shipping-${Date.now()}`,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      visibility: { mode: 'global' },
    });

    const res = await request(app)
      .put('/api/shipping/methods')
      .set('Authorization', tokenFor(seller))
      .send({
        currency: 'USD',
        methods: [
          { type: 'standard', cost: 10, currency: 'USD', deliveryDays: 5, isActive: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.shippingMethods.methods[0]).toMatchObject({
      cost: 10,
      currency: 'USD',
      costCurrency: 'USD',
      costInputAmount: 10,
    });
  });

  test.each([
    ['boolean cost', { type: 'standard', cost: true, currency: 'PKR', deliveryDays: 5, isActive: true }],
    ['nonzero free cost', { type: 'free', cost: 100, currency: 'PKR', deliveryDays: 5, isActive: true }],
    ['boolean delivery days', { type: 'standard', cost: 500, currency: 'PKR', deliveryDays: true, isActive: true }],
    ['array cost', { type: 'standard', cost: [500], currency: 'PKR', deliveryDays: 5, isActive: true }],
    ['array delivery days', { type: 'standard', cost: 500, currency: 'PKR', deliveryDays: [5], isActive: true }],
    ['sub-cent paid cost', { type: 'standard', cost: 0.004, currency: 'PKR', deliveryDays: 5, isActive: true }],
    ['unsafe cost', { type: 'standard', cost: Number.MAX_VALUE, currency: 'PKR', deliveryDays: 5, isActive: true }],
    ['boolean currency', { type: 'standard', cost: 500, currency: false, deliveryDays: 5, isActive: true }],
    ['blank currency', { type: 'standard', cost: 500, currency: ' ', deliveryDays: 5, isActive: true }],
    ['unsupported currency', { type: 'standard', cost: 500, currency: 'CAD', deliveryDays: 5, isActive: true }],
    ['boolean cost currency', { type: 'standard', cost: 500, currency: 'PKR', costCurrency: true, deliveryDays: 5, isActive: true }],
  ])('rejects %s without persisting a shipping configuration', async (_label, method) => {
    const seller = await createSeller();

    const res = await request(app)
      .put('/api/shipping/methods')
      .set('Authorization', tokenFor(seller))
      .send({ currency: 'PKR', methods: [method] });

    expect(res.status).toBe(400);
    expect(await ShippingMethod.findOne({ seller: seller._id })).toBeNull();
  });

  test.each([
    ['unsupported currency', { 'methods.0.currency': 'CAD' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['blank cost currency', { 'methods.0.costCurrency': '' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['conflicting currencies', { 'methods.0.currency': 'PKR', 'methods.0.costCurrency': 'USD' }, 'SHIPPING_CURRENCY_METADATA_INVALID'],
    ['sub-cent cost', { 'methods.0.cost': 0.004 }, 'SHIPPING_COST_INVALID'],
    ['fractional delivery days', { 'methods.0.deliveryDays': 1.5 }, 'SHIPPING_DATA_INVALID'],
  ])('fails closed when a stored shipping method has %s', async (_label, mutation, expectedCode) => {
    const seller = await createSeller();
    const product = await Product.create({
      name: `Corrupt Shipping Product ${Date.now()} ${Math.random()}`,
      description: 'Product for corrupt stored shipping data regression',
      price: 1000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Test',
      brand: 'Test Brand',
      stock: 5,
      image: 'https://example.com/product.jpg',
      images: [{ url: 'https://example.com/product.jpg' }],
      seller: seller._id,
    });
    const shipping = await ShippingMethod.create({
      seller: seller._id,
      methods: [{
        type: 'standard',
        cost: 500,
        currency: 'PKR',
        costCurrency: 'PKR',
        costInputAmount: 500,
        deliveryDays: 5,
        isActive: true,
      }],
    });
    await ShippingMethod.collection.updateOne({ _id: shipping._id }, { $set: mutation });

    const cartResponse = await request(app)
      .post('/api/shipping/cart')
      .send({ cartItems: [{ productId: product._id.toString() }] });
    expect(cartResponse.status).toBe(409);
    expect(cartResponse.body.code).toBe(expectedCode);

    const sellerResponse = await request(app)
      .get(`/api/shipping/seller/${seller._id}`);
    expect(sellerResponse.status).toBe(409);
    expect(sellerResponse.body.code).toBe(expectedCode);
  });

  test('returns free shipping by default when seller has no saved methods', async () => {
    const seller = await createSeller();
    const product = await Product.create({
      name: 'Default Free Shipping Product',
      description: 'Product for checkout default shipping',
      price: 1000,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Test',
      brand: 'Test Brand',
      stock: 5,
      image: 'https://example.com/product.jpg',
      images: [{ url: 'https://example.com/product.jpg' }],
      seller: seller._id,
    });

    const res = await request(app)
      .post('/api/shipping/cart')
      .send({ cartItems: [{ productId: product._id.toString() }] });

    expect(res.status).toBe(200);
    expect(res.body.shippingMethods[seller._id.toString()].methods[0]).toMatchObject({
      type: 'free',
      cost: 0,
      currency: 'PKR',
      costCurrency: 'PKR',
      costInputAmount: 0,
      deliveryDays: 5,
      isActive: true,
    });
    expect(res.body.shippingMethods[seller._id.toString()]).toMatchObject({
      paymentPolicy: 'online_and_cod',
      allowsCashOnDelivery: true,
    });
  });
});
