const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Coupon = require('../../models/Coupon');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const { getCouponAnalytics } = require('../../controllers/couponController');
const { getStoreAnalytics } = require('../../controllers/storeController');

let mongoServer;

const responseMock = () => {
  const response = {};
  response.status = jest.fn().mockReturnValue(response);
  response.json = jest.fn().mockReturnValue(response);
  return response;
};

const createProduct = (seller, suffix) => Product.create({
  name: `Seller metric ${suffix}`,
  description: `Seller metric product ${suffix}`,
  price: 10,
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
  appliedCoupons = [],
  awaitingPayment = false,
  isPaid = true,
  paymentMethod = 'stripe',
  orderStatus = 'confirmed',
  user = new mongoose.Types.ObjectId(),
}) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const couponDiscount = appliedCoupons.reduce(
    (sum, entry) => sum + (Number(entry.appliedDiscountAmount) || 0),
    0
  );

  return Order.create({
    user,
    orderId,
    orderItems: items,
    shippingInfo: {
      fullName: 'Metrics Buyer',
      email: 'metrics-buyer@example.com',
      phone: '+923001234567',
      address: '1 Metrics Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'Standard', price: 0, estimatedDays: 3 },
    orderSummary: {
      subtotal,
      shippingCost: 0,
      tax: 0,
      couponDiscount,
      totalAmount: Math.max(0, subtotal - couponDiscount),
    },
    appliedCoupons,
    orderStatus,
    paymentMethod,
    currency: 'USD',
    isPaid,
    paidAt: isPaid ? new Date() : null,
    awaitingPayment,
  });
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all([
    Coupon.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    Store.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('seller coupon analytics tenant scoping', () => {
  test('attributes exact persisted seller coupon lines and counts only recognized revenue', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const otherSellerId = new mongoose.Types.ObjectId();
    const legacySellerProduct = await createProduct(sellerId, 'legacy-current-owner');
    const reassignedToSellerProduct = await createProduct(sellerId, 'reassigned-to-seller');
    const reassignedAwayProduct = await createProduct(otherSellerId, 'reassigned-away');
    const otherSellerProduct = await createProduct(otherSellerId, 'other-seller');
    const coupon = await Coupon.create({
      seller: sellerId,
      code: 'TENANT10',
      discountType: 'percentage',
      discountValue: 10,
      currency: 'USD',
      applicableTo: 'all',
      maxUses: 100,
      usedCount: 99,
      expiryDate: new Date(Date.now() + 86400000),
    });

    await createOrder({
      orderId: 'COUPON-HISTORICAL-SNAPSHOT',
      items: [
        { productId: reassignedAwayProduct._id, seller: sellerId, name: 'Mine historically', price: 100, quantity: 1 },
        { productId: otherSellerProduct._id, seller: otherSellerId, name: 'Other line', price: 200, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'percentage',
        discountValue: 10,
        appliedDiscountAmount: 10,
        currency: 'USD',
        applicableProductIds: [reassignedAwayProduct._id],
      }],
    });
    await createOrder({
      orderId: 'COUPON-LEGACY-LINE',
      items: [
        { productId: legacySellerProduct._id, name: 'Legacy mine', price: 50, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'fixed',
        discountValue: 5,
        appliedDiscountAmount: 5,
        currency: 'USD',
        applicableProductIds: [legacySellerProduct._id],
      }],
    });
    await createOrder({
      orderId: 'COUPON-MALFORMED-MIXED-SCOPE',
      items: [
        { productId: legacySellerProduct._id, seller: sellerId, name: 'Mine', price: 20, quantity: 1 },
        { productId: otherSellerProduct._id, seller: otherSellerId, name: 'Other', price: 80, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'percentage',
        discountValue: 10,
        appliedDiscountAmount: 10,
        currency: 'USD',
        applicableProductIds: [legacySellerProduct._id, otherSellerProduct._id],
      }],
    });
    await createOrder({
      orderId: 'COUPON-REASSIGNED-TO-SELLER',
      items: [
        { productId: reassignedToSellerProduct._id, seller: otherSellerId, name: 'Not mine historically', price: 700, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'percentage',
        discountValue: 10,
        appliedDiscountAmount: 70,
        currency: 'USD',
        applicableProductIds: [reassignedToSellerProduct._id],
      }],
    });
    await createOrder({
      orderId: 'COUPON-OTHER-SELLER-ONLY',
      items: [
        { productId: otherSellerProduct._id, seller: otherSellerId, name: 'Other only', price: 600, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'percentage',
        discountValue: 10,
        appliedDiscountAmount: 60,
        currency: 'USD',
        applicableProductIds: [otherSellerProduct._id],
      }],
    });
    await createOrder({
      orderId: 'COUPON-AWAITING-PAYMENT',
      items: [
        { productId: legacySellerProduct._id, seller: sellerId, name: 'Hidden pending line', price: 900, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'percentage',
        discountValue: 10,
        appliedDiscountAmount: 90,
        currency: 'USD',
        applicableProductIds: [legacySellerProduct._id],
      }],
      awaitingPayment: true,
    });
    await createOrder({
      orderId: 'COUPON-UNDELIVERED-COD',
      items: [
        { productId: legacySellerProduct._id, seller: sellerId, name: 'Unrecognized COD line', price: 800, quantity: 1 },
      ],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'percentage',
        discountValue: 10,
        appliedDiscountAmount: 80,
        currency: 'USD',
        applicableProductIds: [legacySellerProduct._id],
      }],
      isPaid: false,
      paymentMethod: 'cash_on_delivery',
    });

    const response = responseMock();
    await getCouponAnalytics({
      user: { id: sellerId.toString(), role: 'seller' },
      query: { currency: 'USD' },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.analytics).toHaveLength(1);
    expect(payload.analytics[0]).toMatchObject({
      code: 'TENANT10',
      ordersGenerated: 3,
      totalRevenue: 170,
      totalDiscount: 17,
      avgOrderValue: 56.67,
      uniqueUsers: 3,
      conversionRate: 3,
    });
    expect(payload.summary).toMatchObject({
      currency: 'USD',
      totalUses: 3,
      totalRevenueFromCoupons: 170,
      totalDiscountGiven: 17,
      topCouponCode: 'TENANT10',
    });
  });

  test('fails closed when a frozen coupon discount exceeds its eligible subtotal', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const product = await createProduct(sellerId, 'coupon-over-allocation');
    const coupon = await Coupon.create({
      seller: sellerId,
      code: 'OVERALLOC',
      discountType: 'fixed',
      discountValue: 20,
      currency: 'USD',
      applicableTo: 'all',
      expiryDate: new Date(Date.now() + 86400000),
    });
    await createOrder({
      orderId: 'COUPON-OVER-ALLOCATED-SNAPSHOT',
      items: [{
        productId: product._id,
        seller: sellerId,
        name: 'Over-allocated line',
        price: 10,
        quantity: 1,
      }],
      appliedCoupons: [{
        couponId: coupon._id,
        code: coupon.code,
        discountType: 'fixed',
        discountValue: 20,
        appliedDiscountAmount: 20,
        currency: 'USD',
        applicableProductIds: [product._id],
      }],
    });

    const response = responseMock();
    await getCouponAnalytics({
      user: { id: sellerId.toString(), role: 'seller' },
      query: { currency: 'USD' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'ORDER_COUPON_MONEY_INVALID',
    }));
  });
});

describe('store analytics seller snapshot scoping', () => {
  test('does not reattribute historical orders after product ownership changes', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const otherSellerId = new mongoose.Types.ObjectId();
    await Store.create({
      seller: sellerId,
      storeName: 'Tenant Metrics Store',
      storeSlug: 'tenant-metrics-store',
      views: 12,
      trustCount: 4,
    });
    const legacySellerProduct = await createProduct(sellerId, 'store-legacy-current-owner');
    const reassignedToSellerProduct = await createProduct(sellerId, 'store-reassigned-to-seller');
    const reassignedAwayProduct = await createProduct(otherSellerId, 'store-reassigned-away');
    const otherSellerProduct = await createProduct(otherSellerId, 'store-other');

    await createOrder({
      orderId: 'STORE-HISTORICAL-SNAPSHOT',
      items: [
        { productId: reassignedAwayProduct._id, seller: sellerId, name: 'Mine historically', price: 100, quantity: 2 },
        { productId: otherSellerProduct._id, seller: otherSellerId, name: 'Other seller', price: 300, quantity: 1 },
      ],
    });
    await createOrder({
      orderId: 'STORE-LEGACY-LINE',
      items: [
        { productId: legacySellerProduct._id, name: 'Legacy mine', price: 50, quantity: 1 },
      ],
    });
    await createOrder({
      orderId: 'STORE-REASSIGNED-TO-SELLER',
      items: [
        { productId: reassignedToSellerProduct._id, seller: otherSellerId, name: 'Not mine historically', price: 1000, quantity: 1 },
      ],
    });
    await createOrder({
      orderId: 'STORE-AWAITING-PAYMENT',
      items: [
        { productId: legacySellerProduct._id, seller: sellerId, name: 'Hidden pending line', price: 900, quantity: 1 },
      ],
      awaitingPayment: true,
    });
    await createOrder({
      orderId: 'STORE-UNPAID',
      items: [
        { productId: legacySellerProduct._id, seller: sellerId, name: 'Unpaid line', price: 800, quantity: 1 },
      ],
      isPaid: false,
    });

    const response = responseMock();
    await getStoreAnalytics({
      user: { id: sellerId.toString(), role: 'seller' },
      query: { currency: 'USD' },
    }, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json.mock.calls[0][0].analytics).toMatchObject({
      currency: 'USD',
      views: 12,
      trustCount: 4,
      productCount: 2,
      totalOrders: 2,
      totalSales: 250,
      inventory: {
        totalProducts: 2,
        outOfStock: 0,
        lowStock: 0,
        featuredProducts: 0,
        categories: [{ category: 'Analytics', count: 2 }],
        topRatedProducts: [],
      },
    });
    expect(response.json.mock.calls[0][0].analytics.inventory.recentProducts).toHaveLength(2);
  });
});
