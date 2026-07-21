const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

const orderRoutes = require('../../routes/orderRoutes');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const TaxConfig = require('../../models/TaxConfig');
const User = require('../../models/User');

let mongoServer;
let app;

const createSeller = (suffix) =>
  User.create({
    username: `seller-${suffix}`,
    email: `seller-${suffix}@test.com`,
    password: 'password123',
    role: 'seller',
    currency: 'PKR',
  });

const tokenFor = (user) =>
  `Bearer ${jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET)}`;

const shippingInfo = {
  fullName: 'Buyer One',
  email: 'buyer@test.com',
  phone: '+923001234567',
  address: '123 Test Street',
  city: 'Lahore',
  state: 'Punjab',
  postalCode: '54000',
  country: 'Pakistan',
};

const orderPayloadFor = (product, paymentMethod) => ({
  order: {
    currency: 'PKR',
    orderItems: [{ id: product._id.toString(), quantity: 1 }],
    shippingInfo,
    paymentMethod,
    shippingMethod: {
      name: 'standard',
      price: 0,
      estimatedDays: 5,
      seller: product.seller.toString(),
    },
    sellerShipping: [{
      seller: product.seller.toString(),
      shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 },
    }],
    orderSummary: {
      subtotal: product.price,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount: product.price,
    },
  },
});

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'order-payment-policy-test-secret';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  app = express();
  app.use(express.json());
  app.use('/api/orders', orderRoutes);
}, 60000);

afterEach(async () => {
  await Promise.all([
    Order.deleteMany({}),
    Product.deleteMany({}),
    Store.deleteMany({}),
    TaxConfig.deleteMany({}),
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

describe('order payment policy', () => {
  test('rejects cash on delivery when the seller requires advance payment', async () => {
    const seller = await createSeller('advance');
    const buyer = await User.create({
      username: 'buyer-advance',
      email: 'buyer-advance@test.com',
      password: 'password123',
      role: 'user',
      currency: 'PKR',
    });
    await Store.create({
      seller: seller._id,
      storeName: 'Advance Store',
      storeSlug: `advance-store-${Date.now()}`,
      paymentPolicy: 'advance_only',
      visibility: { mode: 'global' },
    });
    const product = await Product.create({
      name: 'Leather Office Bag',
      description: 'Durable leather office bag for daily work use.',
      price: 2500,
      currency: 'PKR',
      priceCurrency: 'PKR',
      category: 'Bags',
      brand: 'Rozare',
      stock: 5,
      image: 'https://example.com/bag.jpg',
      images: [{ url: 'https://example.com/bag.jpg' }],
      seller: seller._id,
    });

    const res = await request(app)
      .post('/api/orders/place')
      .set('Authorization', tokenFor(buyer))
      .send(orderPayloadFor(product, 'cash_on_delivery'));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'COD_NOT_AVAILABLE_FOR_CART',
      advanceOnlySellers: ['Advance Store'],
    });
    expect(await Order.countDocuments()).toBe(0);
  });
});
