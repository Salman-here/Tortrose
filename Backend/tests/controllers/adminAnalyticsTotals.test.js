const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const { getAdminAnalytics } = require('../../controllers/analyticsController');

const SELLER_A = new mongoose.Types.ObjectId();
const SELLER_B = new mongoose.Types.ObjectId();
const PRODUCT_A = new mongoose.Types.ObjectId();
const PRODUCT_B = new mongoose.Types.ObjectId();

const line = (productId, seller, price) => ({
  productId,
  seller,
  name: `Item ${productId}`,
  image: 'https://example.com/item.jpg',
  price,
  quantity: 1,
});

const createOrder = (orderId, overrides = {}) => Order.create({
  orderId,
  orderItems: [line(PRODUCT_A, SELLER_A, 1)],
  shippingInfo: {
    fullName: 'Analytics Buyer',
    email: 'analytics-buyer@example.com',
    phone: '+14155552671',
    address: '1 Test Street',
    city: 'Test City',
    state: 'Test State',
    postalCode: '10000',
    country: 'United States',
  },
  shippingMethod: { name: 'Standard', price: 0, estimatedDays: 5 },
  orderSummary: { subtotal: 1, shippingCost: 0, tax: 0, totalAmount: 1 },
  paymentMethod: 'stripe',
  currency: 'USD',
  isPaid: false,
  orderStatus: 'processing',
  ...overrides,
});

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

describe('admin analytics recognized revenue totals', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await Promise.all([
      Order.deleteMany({}),
      Product.deleteMany({}),
      Store.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('uses exact item allocations and excludes unpaid, hidden, and cancelled revenue', async () => {
    await createOrder('ADMIN-WEB-PAID-CENTS', {
      orderItems: [line(PRODUCT_A, SELLER_A, 0.01), line(PRODUCT_B, SELLER_B, 0.01)],
      orderSummary: { subtotal: 0.02, shippingCost: 0, tax: 0.01, totalAmount: 0.03 },
      isPaid: true,
    });
    await createOrder('ADMIN-WEB-PARTIAL-COD', {
      orderItems: [line(PRODUCT_A, SELLER_A, 0.05), line(PRODUCT_B, SELLER_B, 0.07)],
      orderSummary: { subtotal: 0.12, shippingCost: 0, tax: 0, totalAmount: 0.12 },
      paymentMethod: 'cash_on_delivery',
      sellerFulfillment: [
        { seller: SELLER_A, status: 'delivered' },
        { seller: SELLER_B, status: 'processing' },
      ],
    });
    await createOrder('ADMIN-WEB-UNPAID');
    await createOrder('ADMIN-WEB-HIDDEN', { isPaid: true, awaitingPayment: true });
    await createOrder('ADMIN-WEB-CANCELLED', { isPaid: true, orderStatus: 'cancelled' });

    const res = response();
    await getAdminAnalytics({ user: { role: 'admin' }, query: { days: '30', currency: 'USD' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.analytics.summary).toMatchObject({
      totalRevenue: 0.08,
      totalOrders: 4,
      avgOrderValue: 0.04,
      totalUnitsSold: 3,
    });
    expect(res.body.analytics.revenueByDay.reduce((sum, day) => sum + day.revenue, 0)).toBe(0.08);
    expect(res.body.analytics.topProducts.reduce((sum, product) => sum + product.revenue, 0)).toBe(0.08);
  });

  it('keeps the requested one-day summary on the same calendar date as its chart', async () => {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    await createOrder('ADMIN-TODAY', {
      isPaid: true,
      createdAt: new Date(todayStart.getTime() + 60 * 60 * 1000),
    });
    await createOrder('ADMIN-BEFORE-WINDOW', {
      isPaid: true,
      createdAt: new Date(todayStart.getTime() - 1),
    });

    const res = response();
    await getAdminAnalytics({ user: { role: 'admin' }, query: { days: '1', currency: 'USD' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.analytics.revenueByDay).toHaveLength(1);
    expect(res.body.analytics.revenueByDay[0].revenue).toBe(1);
    expect(res.body.analytics.summary).toMatchObject({
      totalRevenue: 1,
      totalOrders: 1,
      avgOrderValue: 1,
    });
  });

  it('fails closed instead of presenting a zero unit when stored order quantity is corrupt', async () => {
    const order = await createOrder('ADMIN-CORRUPT-QUANTITY', { isPaid: true });
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { 'orderItems.0.quantity': 1.5 } },
    );

    const res = response();
    await getAdminAnalytics({ user: { role: 'admin' }, query: { days: '30', currency: 'USD' } }, res);

    expect(res.statusCode).toBe(409);
    expect(['ORDER_MONEY_INVALID', 'ORDER_LINE_MONEY_INVALID']).toContain(res.body.code);
    expect(res.body.msg).toMatch(/quantity|order/i);
  });
});
