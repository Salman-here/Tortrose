'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Coupon = require('../../models/Coupon');
const CouponRedemption = require('../../models/CouponRedemption');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { couponTermsFingerprint } = require('../../services/couponTermsService');
const {
  reserveOrderCoupons,
  consumeOrderCoupons,
  releaseOrderCoupons,
  deleteUnpaidOrderAndReleaseCoupons,
  deleteCouponIfUnreserved,
} = require('../../services/couponUsageService');
const { payOrderWithWallet } = require('../../services/walletService');
const { commitOrderInventoryAndCoupons } = require('../../services/orderInventoryService');

let replicaSet;

const ids = () => ({
  seller: new mongoose.Types.ObjectId(),
  buyer: new mongoose.Types.ObjectId(),
  product: new mongoose.Types.ObjectId(),
});

const makeCoupon = ({ seller, maxUses = 10, maxUsesPerUser = 2, discountValue = 10 }) => Coupon.create({
  seller,
  code: `SAVE${discountValue}${new mongoose.Types.ObjectId().toString().slice(-4)}`,
  discountType: 'percentage',
  discountValue,
  currency: 'USD',
  applicableTo: 'all',
  maxUses,
  maxUsesPerUser,
  startDate: new Date(Date.now() - 60_000),
  expiryDate: new Date(Date.now() + 3_600_000),
  isActive: true,
});

const makeOrder = async ({
  coupon,
  seller,
  buyer,
  product,
  paymentMethod = 'stripe',
  awaitingPayment = true,
  persist = true,
}) => {
  const fingerprint = couponTermsFingerprint(coupon);
  const order = new Order({
    user: buyer || null,
    guestEmail: buyer ? null : 'guest@example.com',
    currency: 'USD',
    orderId: `ORD-${new mongoose.Types.ObjectId()}`,
    orderItems: [{
      productId: product,
      seller,
      name: 'Atomic coupon product',
      price: 100,
      sourcePrice: 100,
      sourceCurrency: 'USD',
      quantity: 1,
    }],
    shippingInfo: {
      fullName: 'Coupon Buyer',
      email: 'buyer@example.com',
      phone: '+923001234567',
      address: '1 Test Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'standard', price: 0, estimatedDays: 3, seller },
    sellerShipping: [{ seller, shippingMethod: { name: 'standard', price: 0, estimatedDays: 3 } }],
    orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 10, totalAmount: 90 },
    sellerSettlementVersion: 1,
    sellerSettlement: [{
      seller,
      sourceCurrency: 'USD',
      sourceAmountMinor: 9000,
      amountUSDMinor: 9000,
    }],
    appliedCoupons: [{
      couponId: coupon._id,
      seller,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: 10,
      appliedDiscountAmount: 10,
      currency: 'USD',
      sourceDiscountValue: 10,
      sourceCurrency: 'USD',
      applicableProductIds: [product],
      couponTermsFingerprint: fingerprint,
    }],
    paymentMethod,
    awaitingPayment,
  });
  return persist ? order.save() : order;
};

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
  await Promise.all([Coupon.syncIndexes(), CouponRedemption.syncIndexes(), Order.syncIndexes()]);
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 120000);

beforeEach(async () => {
  await Promise.all([
    Coupon.deleteMany({}),
    CouponRedemption.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    Wallet.deleteMany({}),
    WalletTransaction.deleteMany({}),
  ]);
});

describe('atomic order coupon lifecycle', () => {
  test('allows only one concurrent reservation for the final global use', async () => {
    const first = ids();
    const secondBuyer = new mongoose.Types.ObjectId();
    const coupon = await makeCoupon({ seller: first.seller, maxUses: 1, maxUsesPerUser: 1 });
    const orderA = await makeOrder({ coupon, ...first });
    const orderB = await makeOrder({ coupon, ...first, buyer: secondBuyer });

    const results = await Promise.allSettled([
      reserveOrderCoupons({ orderId: orderA._id, userId: first.buyer }),
      reserveOrderCoupons({ orderId: orderB._id, userId: secondBuyer }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('COUPON_USAGE_LIMIT');
    const refreshed = await Coupon.findById(coupon._id).lean();
    expect(refreshed.usedCount).toBe(1);
    expect(refreshed.usedBy).toHaveLength(1);
    expect(await CouponRedemption.countDocuments({ coupon: coupon._id, status: 'reserved' })).toBe(1);
  });

  test('reserve, consume, and release retries are exact and idempotent', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });

    expect((await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer })).reused).toBe(false);
    expect((await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer })).reused).toBe(true);
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);

    expect((await consumeOrderCoupons({ orderId: order._id })).consumed).toBe(1);
    expect((await consumeOrderCoupons({ orderId: order._id })).reused).toBe(true);
    expect((await releaseOrderCoupons({ orderId: order._id })).released).toBe(0);
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');
  });

  test('releases a pending reservation once and removes the user counter at zero', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });

    expect((await releaseOrderCoupons({ orderId: order._id, reason: 'Stripe expired' })).released).toBe(1);
    expect((await releaseOrderCoupons({ orderId: order._id, reason: 'retry' })).released).toBe(0);
    const refreshed = await Coupon.findById(coupon._id).lean();
    expect(refreshed.usedCount).toBe(0);
    expect(refreshed.usedBy).toHaveLength(0);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('released');
  });

  test('rejects a seller terms edit between pricing and reservation without consuming capacity', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    coupon.discountValue = 20;
    await coupon.save();

    await expect(reserveOrderCoupons({ orderId: order._id, userId: identity.buyer }))
      .rejects.toMatchObject({ code: 'COUPON_TERMS_CHANGED' });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ order: order._id })).toBe(0);
  });

  test('keeps coupons authenticated-only and never writes a null user usage row', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller, maxUses: 1 });
    const guestOrder = await makeOrder({ coupon, ...identity, buyer: null });

    await expect(reserveOrderCoupons({ orderId: guestOrder._id }))
      .rejects.toMatchObject({ code: 'COUPON_LOGIN_REQUIRED' });
    const refreshed = await Coupon.findById(coupon._id).lean();
    expect(refreshed.usedCount).toBe(0);
    expect(refreshed.usedBy).toHaveLength(0);
  });

  test('COD consumes at placement and later cancellation cannot return coupon capacity', async () => {
    const identity = ids();
    await Product.create({
      _id: identity.product,
      name: 'COD coupon product',
      description: 'COD inventory and coupon transaction product',
      price: 100,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 5,
      image: 'https://example.com/cod-coupon.jpg',
      images: [{ url: 'https://example.com/cod-coupon.jpg' }],
      seller: identity.seller,
    });
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({
      coupon,
      ...identity,
      paymentMethod: 'cash_on_delivery',
      awaitingPayment: false,
    });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });
    await commitOrderInventoryAndCoupons(order._id);

    await expect(releaseOrderCoupons({ orderId: order._id, reason: 'Buyer cancelled COD' }))
      .rejects.toMatchObject({ code: 'COUPON_RELEASE_NOT_ALLOWED' });
    expect(await Product.findById(identity.product).lean()).toMatchObject({ stock: 4, totalSales: 1 });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');
  });

  test('atomically releases reservation while deleting an unpaid order', async () => {
    const identity = ids();
    await Product.create({
      _id: identity.product,
      name: 'Expired checkout product',
      description: 'Inventory restored with coupon release',
      price: 100,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 4,
      totalSales: 1,
      image: 'https://example.com/expired.jpg',
      images: [{ url: 'https://example.com/expired.jpg' }],
      seller: identity.seller,
    });
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });
    await Order.updateOne({ _id: order._id }, { $set: { inventoryCommitted: true } });

    const result = await deleteUnpaidOrderAndReleaseCoupons({
      orderId: order._id,
      reason: 'Payment setup failed',
      requireAwaitingPayment: true,
      // Restoration changes this field inside the transaction. The final
      // delete must not reuse the now-stale caller match.
      match: { inventoryCommitted: true },
    });
    expect(result).toEqual({ deleted: true, released: 1 });
    expect(await Order.findById(order._id)).toBeNull();
    expect(await Product.findById(identity.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('released');
    expect((await deleteUnpaidOrderAndReleaseCoupons({ orderId: order._id })).deleted).toBe(false);
  });

  test('rolls back COD order insert, coupon reservation, consumption, and inventory as one placement unit', async () => {
    const identity = ids();
    await Product.create({
      _id: identity.product,
      name: 'COD placement rollback product',
      description: 'Atomic initial placement rollback fixture',
      price: 100,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 5,
      image: 'https://example.com/cod-placement-rollback.jpg',
      images: [{ url: 'https://example.com/cod-placement-rollback.jpg' }],
      seller: identity.seller,
    });
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({
      coupon,
      ...identity,
      paymentMethod: 'cash_on_delivery',
      awaitingPayment: false,
      persist: false,
    });

    await expect(mongoose.connection.transaction(async session => {
      await order.save({ session });
      await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer, session });
      await commitOrderInventoryAndCoupons(order._id, { session });
      throw new Error('simulate process failure before placement commit');
    })).rejects.toThrow('simulate process failure');

    expect(await Order.findById(order._id)).toBeNull();
    expect(await Product.findById(identity.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ order: order._id })).toBe(0);
  });

  test('never releases or deletes an order claimed by Stripe fulfillment', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });
    await Order.updateOne(
      { _id: order._id },
      { $set: { paymentProcessingStartedAt: new Date() } },
    );

    const result = await deleteUnpaidOrderAndReleaseCoupons({
      orderId: order._id,
      reason: 'Late expiry webhook',
      requireAwaitingPayment: true,
    });
    expect(result).toEqual({ deleted: false, released: 0 });
    expect(await Order.findById(order._id)).not.toBeNull();
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('reserved');
  });

  test('prevents coupon deletion while a pending checkout owns a reservation', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });

    await expect(deleteCouponIfUnreserved({ couponId: coupon._id, sellerId: identity.seller }))
      .rejects.toMatchObject({ code: 'COUPON_HAS_ACTIVE_RESERVATIONS' });
    expect(await Coupon.findById(coupon._id)).not.toBeNull();

    await releaseOrderCoupons({ orderId: order._id, reason: 'Buyer closed checkout' });
    expect((await deleteCouponIfUnreserved({ couponId: coupon._id, sellerId: identity.seller })).deleted).toBe(true);
    expect(await Coupon.findById(coupon._id)).toBeNull();
  });

  test('consumes the reservation in the same transaction as Wallet debit, inventory, and payment', async () => {
    const identity = ids();
    const product = await Product.create({
      _id: identity.product,
      name: 'Wallet coupon product',
      description: 'Wallet coupon transaction product',
      price: 100,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 5,
      image: 'https://example.com/wallet-coupon.jpg',
      images: [{ url: 'https://example.com/wallet-coupon.jpg' }],
      seller: identity.seller,
    });
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({
      coupon,
      ...identity,
      product: product._id,
      paymentMethod: 'wallet',
      awaitingPayment: true,
    });
    await Wallet.create({ user: identity.buyer, balances: { USD: 100 } });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });

    await payOrderWithWallet({ orderId: order._id, userId: identity.buyer });

    const [paidOrder, refreshedProduct, wallet, redemption] = await Promise.all([
      Order.findById(order._id).lean(),
      Product.findById(product._id).lean(),
      Wallet.findOne({ user: identity.buyer }).lean(),
      CouponRedemption.findOne({ order: order._id }).lean(),
    ]);
    expect(paidOrder).toMatchObject({ isPaid: true, awaitingPayment: false, inventoryCommitted: true });
    expect(refreshedProduct).toMatchObject({ stock: 4, totalSales: 1 });
    expect(wallet.balances.USD).toBe(10);
    expect(redemption.status).toBe('consumed');
    expect(await WalletTransaction.countDocuments({ referenceId: String(order._id) })).toBe(1);
  });

  test('coupon consume failure rolls back Wallet debit, inventory, transaction, and paid order state', async () => {
    const identity = ids();
    const product = await Product.create({
      _id: identity.product,
      name: 'Wallet rollback product',
      description: 'Wallet rollback transaction product',
      price: 100,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 5,
      image: 'https://example.com/wallet-rollback.jpg',
      images: [{ url: 'https://example.com/wallet-rollback.jpg' }],
      seller: identity.seller,
    });
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({
      coupon,
      ...identity,
      product: product._id,
      paymentMethod: 'wallet',
      awaitingPayment: true,
    });
    await Wallet.create({ user: identity.buyer, balances: { USD: 100 } });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });
    // Simulate a lifecycle integrity failure after reservation. The Wallet
    // transaction must roll back every preceding write when consumption fails.
    await CouponRedemption.updateOne({ order: order._id }, { $set: { status: 'released' } });

    await expect(payOrderWithWallet({ orderId: order._id, userId: identity.buyer }))
      .rejects.toMatchObject({ code: 'COUPON_RESERVATION_RELEASED' });

    const [pendingOrder, refreshedProduct, wallet, redemption] = await Promise.all([
      Order.findById(order._id).lean(),
      Product.findById(product._id).lean(),
      Wallet.findOne({ user: identity.buyer }).lean(),
      CouponRedemption.findOne({ order: order._id }).lean(),
    ]);
    expect(pendingOrder).toMatchObject({ isPaid: false, awaitingPayment: true, inventoryCommitted: false });
    expect(refreshedProduct).toMatchObject({ stock: 5, totalSales: 0 });
    expect(wallet.balances.USD).toBe(100);
    expect(redemption.status).toBe('released');
    expect(await WalletTransaction.countDocuments({ referenceId: String(order._id) })).toBe(0);
  });

  test('rolls back initial Wallet order insert together with debit, inventory, and coupon writes', async () => {
    const identity = ids();
    await Product.create({
      _id: identity.product,
      name: 'Wallet placement rollback product',
      description: 'Atomic initial wallet placement rollback fixture',
      price: 100,
      currency: 'USD',
      priceCurrency: 'USD',
      category: 'Test',
      brand: 'Test',
      stock: 5,
      image: 'https://example.com/wallet-placement-rollback.jpg',
      images: [{ url: 'https://example.com/wallet-placement-rollback.jpg' }],
      seller: identity.seller,
    });
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({
      coupon,
      ...identity,
      paymentMethod: 'wallet',
      awaitingPayment: true,
      persist: false,
    });
    await Wallet.create({ user: identity.buyer, balances: { USD: 100 } });

    await expect(mongoose.connection.transaction(async session => {
      await order.save({ session });
      await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer, session });
      await payOrderWithWallet({ orderId: order._id, userId: identity.buyer, session });
      throw new Error('simulate process failure before wallet placement commit');
    })).rejects.toThrow('simulate process failure');

    expect(await Order.findById(order._id)).toBeNull();
    expect(await Product.findById(identity.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect((await Wallet.findOne({ user: identity.buyer }).lean()).balances.USD).toBe(100);
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ order: order._id })).toBe(0);
    expect(await WalletTransaction.countDocuments({ referenceId: String(order._id) })).toBe(0);
  });

  test('never rounds a corrupt persisted coupon snapshot during reservation comparison', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { 'appliedCoupons.0.appliedDiscountAmount': 10.001 } },
    );

    await expect(reserveOrderCoupons({ orderId: order._id, userId: identity.buyer }))
      .rejects.toMatchObject({ code: 'COUPON_RESERVATION_INVALID' });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments({ order: order._id })).toBe(0);
  });

  test('never truncates corrupt coupon counters while releasing capacity', async () => {
    const identity = ids();
    const coupon = await makeCoupon({ seller: identity.seller });
    const order = await makeOrder({ coupon, ...identity });
    await reserveOrderCoupons({ orderId: order._id, userId: identity.buyer });
    await Coupon.collection.updateOne(
      { _id: coupon._id },
      { $set: { usedCount: 1.5 } },
    );

    await expect(releaseOrderCoupons({ orderId: order._id, reason: 'corrupt counter test' }))
      .rejects.toMatchObject({ code: 'COUPON_RESERVATION_INVALID' });
    expect((await Coupon.collection.findOne({ _id: coupon._id })).usedCount).toBe(1.5);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('reserved');
  });
});
