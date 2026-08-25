'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Coupon = require('../../models/Coupon');
const CouponRedemption = require('../../models/CouponRedemption');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const WalletTransaction = require('../../models/WalletTransaction');
const { couponTermsFingerprint } = require('../../services/couponTermsService');
const { reserveOrderCoupons } = require('../../services/couponUsageService');
const {
  buildOrderSellerSettlement,
  SELLER_SETTLEMENT_VERSION,
} = require('../../services/orderMoneyService');
const {
  completeNoChargeOrder,
  isNoChargeOnlineOrder,
} = require('../../services/orderNoChargeService');

let replicaSet;

const createFixture = async (paymentMethod = 'stripe') => {
  const seller = new mongoose.Types.ObjectId();
  const buyer = new mongoose.Types.ObjectId();
  const product = await Product.create({
    name: `Free checkout ${paymentMethod}`,
    description: 'No-charge lifecycle test product',
    price: 100,
    currency: 'USD',
    priceCurrency: 'USD',
    category: 'Test',
    brand: 'Test',
    stock: 5,
    image: 'https://example.com/free-checkout.jpg',
    images: [{ url: 'https://example.com/free-checkout.jpg' }],
    seller,
  });
  const coupon = await Coupon.create({
    seller,
    code: `FREE${paymentMethod.toUpperCase()}${new mongoose.Types.ObjectId().toString().slice(-4)}`,
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
  const termsFingerprint = couponTermsFingerprint(coupon);
  const order = new Order({
    user: buyer,
    checkoutIdempotencyKey: `free:${paymentMethod}:${new mongoose.Types.ObjectId()}`,
    checkoutRequestFingerprint: 'f'.repeat(64),
    currency: 'USD',
    orderId: `ORD-FREE-${new mongoose.Types.ObjectId()}`,
    orderItems: [{
      productId: product._id,
      seller,
      name: product.name,
      image: product.image,
      price: 100,
      sourcePrice: 100,
      sourceCurrency: 'USD',
      quantity: 1,
    }],
    shippingInfo: {
      fullName: 'Free Buyer',
      email: 'free-buyer@example.com',
      phone: '+923001234567',
      address: '1 Test Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'free', price: 0, estimatedDays: 5, seller },
    sellerShipping: [{
      seller,
      shippingMethod: { name: 'free', price: 0, estimatedDays: 5 },
    }],
    sellerFulfillment: [{ seller, status: 'pending' }],
    orderSummary: {
      subtotal: 100,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 100,
      totalAmount: 0,
    },
    appliedCoupons: [{
      couponId: coupon._id,
      seller,
      code: coupon.code,
      discountType: 'percentage',
      discountValue: 100,
      appliedDiscountAmount: 100,
      currency: 'USD',
      sourceDiscountValue: 100,
      sourceCurrency: 'USD',
      applicableProductIds: [product._id],
      couponTermsFingerprint: termsFingerprint,
    }],
    paymentMethod,
    paymentFlow: paymentMethod === 'stripe' ? 'payment_sheet' : 'checkout_session',
    clientSurface: paymentMethod === 'stripe' ? 'mobile' : 'web',
    paymentSetupState: paymentMethod === 'stripe' ? 'not_started' : 'closed',
    awaitingPayment: true,
    confirmation: {
      token: `confirm-${new mongoose.Types.ObjectId()}`,
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  order.sellerSettlementVersion = SELLER_SETTLEMENT_VERSION;
  order.sellerSettlement = buildOrderSellerSettlement(order, { requireOrderTotal: true });
  return { buyer, coupon, order, product, seller };
};

const insertReserveAndComplete = async fixture => {
  let completion;
  await mongoose.connection.transaction(async session => {
    await fixture.order.save({ session });
    await reserveOrderCoupons({
      orderId: fixture.order._id,
      userId: fixture.buyer,
      session,
    });
    completion = await completeNoChargeOrder({
      orderId: fixture.order._id,
      session,
    });
  }, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  return completion;
};

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
  await Promise.all([
    Coupon.syncIndexes(),
    CouponRedemption.syncIndexes(),
    NotificationOutbox.syncIndexes(),
    Order.syncIndexes(),
  ]);
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 120000);

beforeEach(async () => {
  await Promise.all([
    Coupon.deleteMany({}),
    CouponRedemption.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

describe('atomic no-charge online checkout', () => {
  test.each([
    ['stripe', 'stripe_payment'],
    ['wallet', 'wallet_payment'],
  ])('completes a 100%% coupon %s order with exact-once inventory/coupon state and no payment rail', async (paymentMethod, confirmationVia) => {
    const fixture = await createFixture(paymentMethod);
    expect(isNoChargeOnlineOrder(fixture.order)).toBe(true);

    const first = await insertReserveAndComplete(fixture);
    expect(first.alreadyCompleted).toBe(false);

    let stored = await Order.findById(fixture.order._id);
    expect(stored).toMatchObject({
      isPaid: true,
      awaitingPayment: false,
      inventoryCommitted: true,
      orderStatus: 'confirmed',
      paymentSetupState: 'complete',
    });
    expect(stored.paidAt).toBeTruthy();
    expect(stored.paymentFulfilledAt).toBeTruthy();
    expect(stored.paymentExpiresAt).toBeNull();
    expect(stored.stripePaymentIntentId).toBeNull();
    expect(stored.stripeSessionId).toBeNull();
    expect(stored.sellerFulfillment).toHaveLength(1);
    expect(stored.sellerFulfillment[0].status).toBe('confirmed');
    expect(stored.confirmation.confirmedAt).toBeTruthy();
    expect(stored.confirmation.confirmedVia).toBe(confirmationVia);

    const [productAfterFirst, couponAfterFirst, redemptionAfterFirst] = await Promise.all([
      Product.findById(fixture.product._id),
      Coupon.findById(fixture.coupon._id),
      CouponRedemption.findOne({ order: stored._id }),
    ]);
    expect(productAfterFirst.stock).toBe(4);
    expect(productAfterFirst.totalSales).toBe(1);
    expect(couponAfterFirst.usedCount).toBe(1);
    expect(redemptionAfterFirst.status).toBe('consumed');
    expect(await WalletTransaction.countDocuments({ referenceId: stored._id })).toBe(0);
    const notifications = await NotificationOutbox.find({ aggregateId: String(stored._id) }).lean();
    expect(notifications).toHaveLength(8);
    expect(notifications.filter(row => row.recipient.audienceRole === 'buyer')).toHaveLength(4);
    expect(notifications.filter(row => row.recipient.audienceRole === 'seller')).toHaveLength(4);
    expect(notifications.every(row => (
      row.money.length === 1
      && row.money[0].currency === 'USD'
      && row.money[0].amountMinor === 0
    ))).toBe(true);

    let replay;
    await mongoose.connection.transaction(async session => {
      replay = await completeNoChargeOrder({ orderId: stored._id, session });
    });
    expect(replay.alreadyCompleted).toBe(true);

    stored = await Order.findById(stored._id);
    const [productAfterReplay, couponAfterReplay, redemptionsAfterReplay] = await Promise.all([
      Product.findById(fixture.product._id),
      Coupon.findById(fixture.coupon._id),
      CouponRedemption.find({ order: stored._id }),
    ]);
    expect(productAfterReplay.stock).toBe(4);
    expect(productAfterReplay.totalSales).toBe(1);
    expect(couponAfterReplay.usedCount).toBe(1);
    expect(redemptionsAfterReplay).toHaveLength(1);
    expect(redemptionsAfterReplay[0].status).toBe('consumed');
    expect(await WalletTransaction.countDocuments({ referenceId: stored._id })).toBe(0);
    expect(await NotificationOutbox.countDocuments({ aggregateId: String(stored._id) })).toBe(8);
  });

  test('rolls back order insert, inventory, coupon reservation, and coupon consumption when final completion fails', async () => {
    const fixture = await createFixture('stripe');
    const originalSave = Order.prototype.save;
    const saveSpy = jest.spyOn(Order.prototype, 'save').mockImplementation(function (...args) {
      if (this.paymentSetupState === 'complete') {
        throw new Error('injected final no-charge save failure');
      }
      return originalSave.apply(this, args);
    });

    try {
      await expect(insertReserveAndComplete(fixture))
        .rejects.toThrow('injected final no-charge save failure');
    } finally {
      saveSpy.mockRestore();
    }

    const [storedOrder, product, coupon, redemptions] = await Promise.all([
      Order.findById(fixture.order._id),
      Product.findById(fixture.product._id),
      Coupon.findById(fixture.coupon._id),
      CouponRedemption.find({ order: fixture.order._id }),
    ]);
    expect(storedOrder).toBeNull();
    expect(product.stock).toBe(5);
    expect(product.totalSales).toBe(0);
    expect(coupon.usedCount).toBe(0);
    expect(coupon.usedBy).toHaveLength(0);
    expect(redemptions).toHaveLength(0);
    expect(await WalletTransaction.countDocuments({ referenceId: fixture.order._id })).toBe(0);
  });

  test('never treats a zero-total COD order as an online paid order', async () => {
    const fixture = await createFixture('stripe');
    fixture.order.paymentMethod = 'cash_on_delivery';
    fixture.order.paymentFlow = 'checkout_session';
    fixture.order.paymentSetupState = 'closed';

    expect(isNoChargeOnlineOrder(fixture.order)).toBe(false);
  });
});
