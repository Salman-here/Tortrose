const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const {
  getSellerAnalytics,
  getSellerNotifications,
} = require('../../controllers/analyticsController');

let mongoServer;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

const createProduct = (seller, suffix) => Product.create({
  name: `Analytics ${suffix}`,
  description: `Analytics product ${suffix}`,
  price: 5,
  currency: 'USD',
  category: 'Analytics',
  brand: 'Rozare',
  stock: 20,
  image: `https://example.com/${suffix}.jpg`,
  images: [{ url: `https://example.com/${suffix}.jpg` }],
  seller,
});

const createOrder = ({
  orderId,
  items,
  sellerFulfillment = [],
  orderStatus = 'pending',
  awaitingPayment = false,
  sellerSettlementVersion = 0,
  sellerSettlement = [],
}) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Order.create({
    user: new mongoose.Types.ObjectId(),
    orderId,
    orderItems: items,
    shippingInfo: {
      fullName: 'Analytics Buyer',
      email: 'analytics-buyer@example.com',
      phone: '+923001234567',
      address: '1 Analytics Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
    sellerFulfillment,
    sellerSettlementVersion,
    sellerSettlement,
    orderSummary: { subtotal, shippingCost: 0, tax: 0, totalAmount: subtotal },
    orderStatus,
    paymentMethod: 'stripe',
    currency: 'USD',
    isPaid: true,
    paidAt: new Date(),
    awaitingPayment,
  });
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all([Order.deleteMany({}), Product.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('seller analytics order isolation', () => {
  test('uses seller snapshots first, supports legacy items, and reports seller fulfillment status', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const otherSellerId = new mongoose.Types.ObjectId();
    const liveProduct = await createProduct(sellerId, 'live');

    await createOrder({
      orderId: 'AN-SNAPSHOT',
      items: [{
        productId: new mongoose.Types.ObjectId(),
        seller: sellerId,
        name: 'Deleted snapshot product',
        image: 'https://example.com/deleted.jpg',
        price: 10,
        quantity: 2,
      }],
      sellerFulfillment: [{ seller: sellerId, status: 'shipped' }],
      orderStatus: 'processing',
    });
    await createOrder({
      orderId: 'AN-LEGACY',
      items: [{
        productId: liveProduct._id,
        name: liveProduct.name,
        image: liveProduct.image,
        price: 5,
        quantity: 1,
      }],
      orderStatus: 'pending',
    });
    await createOrder({
      orderId: 'AN-OTHER-SNAPSHOT',
      items: [{
        productId: liveProduct._id,
        seller: otherSellerId,
        name: 'Explicitly owned by another seller',
        image: liveProduct.image,
        price: 1000,
        quantity: 1,
      }],
      sellerFulfillment: [{ seller: otherSellerId, status: 'confirmed' }],
      orderStatus: 'confirmed',
    });
    await createOrder({
      orderId: 'AN-AWAITING-PAYMENT',
      items: [{
        productId: liveProduct._id,
        seller: sellerId,
        name: 'Hidden pre-payment line',
        image: liveProduct.image,
        price: 500,
        quantity: 1,
      }],
      orderStatus: 'pending',
      awaitingPayment: true,
    });

    const response = responseMock();
    await getSellerAnalytics({
      user: { id: sellerId.toString(), role: 'seller' },
      query: { days: '30', currency: 'USD' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const analytics = response.json.mock.calls[0][0].analytics;
    expect(analytics.summary).toMatchObject({
      totalRevenue: 25,
      paidOrders: 2,
      avgOrderValue: 12.5,
      totalUnitsSold: 3,
    });
    expect(analytics.statusBreakdown).toEqual(expect.arrayContaining([
      { name: 'shipped', value: 1 },
      { name: 'pending', value: 1 },
    ]));
    expect(analytics.statusBreakdown).not.toContainEqual({ name: 'confirmed', value: 1 });
    expect(analytics.notifications.some((item) => item.title.includes('AN-SNAPSHOT'))).toBe(false);
    expect(analytics.notifications.some((item) => item.title.includes('AN-LEGACY'))).toBe(true);
    expect(analytics.notifications.some((item) => item.title.includes('AN-AWAITING-PAYMENT'))).toBe(false);
  });

  test('keeps generated seller notifications scoped to the same seller rules', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const otherSellerId = new mongoose.Types.ObjectId();
    const liveProduct = await createProduct(sellerId, 'notifications');
    liveProduct.stock = 5;
    await liveProduct.save();
    await createOrder({
      orderId: 'NOTICE-MINE',
      items: [{
        productId: liveProduct._id,
        name: liveProduct.name,
        image: liveProduct.image,
        price: 5,
        quantity: 1,
      }],
      orderStatus: 'pending',
    });
    await createOrder({
      orderId: 'NOTICE-OTHER',
      items: [{
        productId: liveProduct._id,
        seller: otherSellerId,
        name: liveProduct.name,
        image: liveProduct.image,
        price: 100,
        quantity: 1,
      }],
      orderStatus: 'pending',
    });
    await createOrder({
      orderId: 'NOTICE-AWAITING',
      items: [{
        productId: liveProduct._id,
        seller: sellerId,
        name: liveProduct.name,
        image: liveProduct.image,
        price: 100,
        quantity: 1,
      }],
      orderStatus: 'pending',
      awaitingPayment: true,
    });

    const response = responseMock();
    await getSellerNotifications({
      user: { id: sellerId.toString(), role: 'seller' },
      query: {},
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json.mock.calls[0][0]).toMatchObject({
      sellerId: sellerId.toString(),
      audienceRole: 'seller',
    });
    const titles = response.json.mock.calls[0][0].notifications.map((item) => item.title);
    expect(titles).toContain('New order NOTICE-MINE');
    expect(titles).not.toContain('New order NOTICE-OTHER');
    expect(titles).not.toContain('New order NOTICE-AWAITING');
    const notifications = response.json.mock.calls[0][0].notifications;
    expect(notifications.some(item => String(item.description || '').includes('Analytics Buyer'))).toBe(false);
    const stockAlert = notifications.find(item => item.id === `low-${liveProduct._id}`);
    expect(new Date(stockAlert.time).getTime()).toBe(liveProduct.updatedAt.getTime());

    const repeatedResponse = responseMock();
    await getSellerNotifications({
      user: { id: sellerId.toString(), role: 'seller' },
      query: {},
    }, repeatedResponse);
    const repeatedStockAlert = repeatedResponse.json.mock.calls[0][0].notifications
      .find(item => item.id === `low-${liveProduct._id}`);
    expect(new Date(repeatedStockAlert.time).getTime()).toBe(new Date(stockAlert.time).getTime());
  });

  test('omits a paid receipt when a legacy order has no frozen seller settlement', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const product = await createProduct(sellerId, 'legacy-paid-notice');
    const order = await createOrder({
      orderId: 'NOTICE-LEGACY-NO-SETTLEMENT',
      items: [{
        productId: product._id,
        seller: sellerId,
        name: product.name,
        image: product.image,
        price: 5,
        quantity: 1,
      }],
      sellerFulfillment: [{ seller: sellerId, status: 'confirmed' }],
      orderStatus: 'confirmed',
    });

    const response = responseMock();
    await getSellerNotifications({
      user: { id: sellerId.toString(), role: 'seller' },
      query: {},
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json.mock.calls[0][0].notifications)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `paid-${order._id}` }),
      ]));
  });

  test('paid notification fallback uses the frozen seller settlement instead of mutable line reconstruction', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const product = await createProduct(sellerId, 'frozen-notice');
    const order = await createOrder({
      orderId: 'NOTICE-FROZEN',
      items: [{
        productId: product._id,
        seller: sellerId,
        name: product.name,
        image: product.image,
        price: 5,
        quantity: 1,
      }],
      sellerFulfillment: [{ seller: sellerId, status: 'confirmed' }],
      orderStatus: 'confirmed',
      sellerSettlementVersion: 1,
      sellerSettlement: [{
        seller: sellerId,
        sourceCurrency: 'USD',
        sourceAmountMinor: 500,
        amountUSDMinor: 500,
      }],
    });
    // Bypass model safeguards to simulate historical storage corruption. The
    // immutable settlement and persisted order total remain authoritative.
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { 'orderItems.0.price': 999 } },
    );

    const response = responseMock();
    await getSellerNotifications({
      user: { id: sellerId.toString(), role: 'seller' },
      query: {},
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const paid = response.json.mock.calls[0][0].notifications
      .find(item => item.id === `paid-${order._id}`);
    expect(paid).toEqual(expect.objectContaining({ description: '$5.00' }));
    expect(paid.description).not.toContain('999');
  });
});
