const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

const shippingRoutes = require('../../routes/shippingRoutes');
const Product = require('../../models/Product');
const ShippingMethod = require('../../models/ShippingMethod');
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
  });
});
