const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const { getSellerSubdomainAnalytics } = require('../../controllers/subdomainController');

let mongoServer;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

const createOrder = ({ orderId, items, awaitingPayment = false }) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Order.create({
    user: new mongoose.Types.ObjectId(),
    orderId,
    orderItems: items,
    shippingInfo: {
      fullName: 'Subdomain Buyer',
      email: 'subdomain-buyer@example.com',
      phone: '+923001234567',
      address: '1 Store Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
    orderSummary: { subtotal, shippingCost: 0, tax: 0, totalAmount: subtotal },
    paymentMethod: 'cash_on_delivery',
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
  await Promise.all([Order.deleteMany({}), Product.deleteMany({}), Store.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('seller subdomain analytics contract', () => {
  test('counts only seller-scoped item revenue and never fabricates traffic history', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const otherSellerId = new mongoose.Types.ObjectId();
    const store = await Store.create({
      seller: sellerId,
      storeName: 'Seller Analytics Store',
      storeSlug: 'seller-analytics-store',
      views: 120,
      trustCount: 8,
    });
    const liveProduct = await Product.create({
      name: 'Live Product',
      description: 'Live product for analytics',
      price: 10,
      currency: 'USD',
      category: 'Analytics',
      brand: 'Rozare',
      stock: 20,
      image: 'https://example.com/live.jpg',
      images: [{ url: 'https://example.com/live.jpg' }],
      seller: sellerId,
    });

    await createOrder({
      orderId: 'SUB-MULTI',
      items: [
        {
          productId: liveProduct._id,
          seller: sellerId,
          name: liveProduct.name,
          image: liveProduct.image,
          price: 10,
          quantity: 2,
        },
        {
          productId: new mongoose.Types.ObjectId(),
          seller: otherSellerId,
          name: 'Other seller item',
          image: 'https://example.com/other.jpg',
          price: 100,
          quantity: 1,
        },
      ],
    });
    await createOrder({
      orderId: 'SUB-DELETED-SNAPSHOT',
      items: [{
        productId: new mongoose.Types.ObjectId(),
        seller: sellerId,
        name: 'Deleted seller product',
        image: 'https://example.com/deleted.jpg',
        price: 5,
        quantity: 1,
      }],
    });
    await createOrder({
      orderId: 'SUB-OTHER-SNAPSHOT',
      items: [{
        productId: liveProduct._id,
        seller: otherSellerId,
        name: 'Explicit other seller snapshot',
        image: liveProduct.image,
        price: 1000,
        quantity: 1,
      }],
    });
    await createOrder({
      orderId: 'SUB-AWAITING-PAYMENT',
      items: [{
        productId: liveProduct._id,
        seller: sellerId,
        name: 'Hidden awaiting payment',
        image: liveProduct.image,
        price: 500,
        quantity: 1,
      }],
      awaitingPayment: true,
    });

    const response = responseMock();
    await getSellerSubdomainAnalytics({
      user: { id: sellerId.toString(), role: 'seller' },
      query: { currency: 'USD' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    const payload = response.json.mock.calls[0][0];
    expect(payload.subdomain).toMatchObject({
      slug: store.storeSlug,
      url: `${store.storeSlug}.rozare.com`,
    });
    expect(payload.analytics).toMatchObject({
      currency: 'USD',
      totalViews: 120,
      totalOrders: 2,
      totalRevenue: 25,
      productCount: 1,
      trustCount: 8,
      monthlyTraffic: [],
      trafficHistoryAvailable: false,
    });
  });
});
