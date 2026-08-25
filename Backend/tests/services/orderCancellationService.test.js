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
} = require('../../services/couponUsageService');
const {
  commitOrderInventory,
  commitOrderInventoryAndCoupons,
} = require('../../services/orderInventoryService');
const {
  cancelOrderSafely,
  cancelUnpaidOrderLocally,
  reconfirmCancelledCodOrder,
} = require('../../services/orderCancellationService');
const { fulfillStripeOrderPaymentIntent } = require('../../services/stripeOrderPaymentService');
const { confirmCodOrderByBuyer } = require('../../services/orderStatusTransitionService');
const { payOrderWithWallet } = require('../../services/walletService');

let replicaSet;

const identity = () => ({
  seller: new mongoose.Types.ObjectId(),
  buyer: new mongoose.Types.ObjectId(),
  product: new mongoose.Types.ObjectId(),
});

const createProduct = ids => Product.create({
  _id: ids.product,
  name: 'Cancellation race product',
  description: 'Inventory lifecycle race fixture',
  price: 100,
  currency: 'USD',
  priceCurrency: 'USD',
  category: 'Test',
  brand: 'Test',
  stock: 5,
  image: 'https://example.com/cancellation-race.jpg',
  images: [{ url: 'https://example.com/cancellation-race.jpg' }],
  seller: ids.seller,
});

const createCoupon = ids => Coupon.create({
  seller: ids.seller,
  code: `RACE${new mongoose.Types.ObjectId().toString().slice(-6)}`,
  discountType: 'percentage',
  discountValue: 10,
  currency: 'USD',
  applicableTo: 'all',
  maxUses: 10,
  maxUsesPerUser: 2,
  startDate: new Date(Date.now() - 60_000),
  expiryDate: new Date(Date.now() + 3_600_000),
  isActive: true,
});

const createOrder = ({ ids, coupon, paymentMethod, paymentSetupState, stripePaymentIntentId = null }) => (
  Order.create({
    user: ids.buyer,
    currency: 'USD',
    orderId: `ORD-RACE-${new mongoose.Types.ObjectId()}`,
    orderItems: [{
      productId: ids.product,
      seller: ids.seller,
      name: 'Cancellation race product',
      price: 100,
      sourcePrice: 100,
      sourceCurrency: 'USD',
      quantity: 1,
    }],
    shippingInfo: {
      fullName: 'Race Buyer',
      email: 'race@example.com',
      phone: '+923001234567',
      address: '1 Test Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'standard', price: 0, estimatedDays: 3, seller: ids.seller },
    sellerShipping: [{ seller: ids.seller, shippingMethod: { name: 'standard', price: 0, estimatedDays: 3 } }],
    sellerFulfillment: [{ seller: ids.seller, status: 'pending', updatedAt: new Date() }],
    orderSummary: { subtotal: 100, shippingCost: 0, tax: 0, couponDiscount: 10, totalAmount: 90 },
    appliedCoupons: [{
      couponId: coupon._id,
      seller: ids.seller,
      code: coupon.code,
      discountType: coupon.discountType,
      discountValue: 10,
      appliedDiscountAmount: 10,
      currency: 'USD',
      sourceDiscountValue: 10,
      sourceCurrency: 'USD',
      applicableProductIds: [ids.product],
      couponTermsFingerprint: couponTermsFingerprint(coupon),
    }],
    paymentMethod,
    paymentFlow: paymentMethod === 'stripe' ? 'payment_sheet' : 'checkout_session',
    paymentSetupState,
    stripeMode: paymentMethod === 'stripe' ? 'test' : null,
    stripeCustomerId: paymentMethod === 'stripe' ? 'cus_race' : null,
    stripePaymentIntentId,
    awaitingPayment: paymentMethod !== 'cash_on_delivery',
  })
);

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

describe('central unpaid-order cancellation lifecycle', () => {
  test('buyer COD confirmation consumes a legacy reserved coupon in the same inventory transaction', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventory(order._id);

    const confirmed = await confirmCodOrderByBuyer({
      orderId: order._id,
      channel: 'email',
    });

    expect(confirmed).toMatchObject({ status: 'confirmed', newlyConfirmed: true });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'confirmed',
      inventoryCommitted: true,
      isPaid: false,
    });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');
  });

  test('concurrent COD cancellation restores inventory once, keeps the consumed coupon, and reconfirm reserves once', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventoryAndCoupons(order._id);

    const firstDecisionAt = new Date('2026-01-01T00:00:00.000Z');
    const secondDecisionAt = new Date('2026-01-02T00:00:00.000Z');
    const cancelled = await Promise.all([
      cancelUnpaidOrderLocally({
        orderId: order._id,
        reason: 'first COD cancellation',
        confirmationFields: {
          declinedAt: firstDecisionAt,
          decidedAt: firstDecisionAt,
          decidedVia: 'dashboard',
        },
        at: firstDecisionAt,
      }),
      cancelUnpaidOrderLocally({
        orderId: order._id,
        reason: 'concurrent COD cancellation',
        confirmationFields: {
          declinedAt: secondDecisionAt,
          decidedAt: secondDecisionAt,
          decidedVia: 'dashboard',
        },
        at: secondDecisionAt,
      }),
    ]);

    expect(cancelled.some(result => result.alreadyCancelled)).toBe(true);
    const transitionWinner = cancelled.find(result => !result.alreadyCancelled);
    const replay = cancelled.find(result => result.alreadyCancelled);
    expect(replay.order.confirmation.decidedAt.getTime())
      .toBe(transitionWinner.order.confirmation.decidedAt.getTime());
    expect(replay.order.confirmation.declinedAt.getTime())
      .toBe(transitionWinner.order.confirmation.declinedAt.getTime());
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
    });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');

    await expect(commitOrderInventory(order._id))
      .rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });

    const reconfirmed = await Promise.all([
      reconfirmCancelledCodOrder({ orderId: order._id }),
      reconfirmCancelledCodOrder({ orderId: order._id }),
    ]);
    expect(reconfirmed.some(result => result.alreadyConfirmed)).toBe(true);
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 4, totalSales: 1 });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'confirmed',
      inventoryCommitted: true,
    });
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');
  });

  test('reconfirm fails closed when cancellation released a still-reserved coupon', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventory(order._id);
    await cancelUnpaidOrderLocally({
      orderId: order._id,
      reason: 'cancel before reserved coupon consumption',
    });

    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('released');
    await expect(reconfirmCancelledCodOrder({ orderId: order._id }))
      .rejects.toMatchObject({ code: 'COUPON_RESERVATION_RELEASED' });

    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
    });
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('released');
  });

  test('email reconfirm validates the token expiry inside the inventory transaction', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventoryAndCoupons(order._id);
    await cancelUnpaidOrderLocally({ orderId: order._id, reason: 'buyer cancelled' });
    const token = `expired-reconfirm-${new mongoose.Types.ObjectId()}`;
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'confirmation.token': token,
        'confirmation.tokenExpiresAt': new Date(Date.now() - 1000),
      },
    });

    await expect(reconfirmCancelledCodOrder({ orderId: order._id, token }))
      .rejects.toMatchObject({
        code: 'ORDER_CONFIRMATION_EXPIRED',
        statusCode: 410,
      });

    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
    });
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
  });

  test('cannot reopen a corrupted COD row that is still awaiting payment', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await Order.updateOne({ _id: order._id }, {
      $set: {
        orderStatus: 'cancelled',
        inventoryCommitted: false,
        awaitingPayment: true,
      },
    });

    await expect(reconfirmCancelledCodOrder({ orderId: order._id }))
      .rejects.toMatchObject({ code: 'ORDER_PAYMENT_NOT_CONFIRMED' });

    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      awaitingPayment: true,
    });
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 5 });
  });

  test('email cancellation is bound to the current unexpired confirmation token', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventoryAndCoupons(order._id);
    const expiredToken = `expired-decline-${new mongoose.Types.ObjectId()}`;
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'confirmation.token': expiredToken,
        'confirmation.tokenExpiresAt': new Date(Date.now() - 1000),
      },
    });

    await expect(cancelOrderSafely({
      orderId: order._id,
      token: expiredToken,
      reason: 'expired email decline',
    })).rejects.toMatchObject({
      code: 'ORDER_CONFIRMATION_EXPIRED',
      statusCode: 410,
    });

    const currentToken = `current-decline-${new mongoose.Types.ObjectId()}`;
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'confirmation.token': currentToken,
        'confirmation.tokenExpiresAt': new Date(Date.now() + 60_000),
      },
    });
    await expect(cancelOrderSafely({
      orderId: order._id,
      token: expiredToken,
      reason: 'rotated email decline',
    })).rejects.toMatchObject({
      code: 'ORDER_CONFIRMATION_TOKEN_INVALID',
      statusCode: 404,
    });

    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'pending',
      inventoryCommitted: true,
    });
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 4, totalSales: 1 });
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');
  });

  test('legacy confirmedVia still prevents a different confirmation channel from cancelling', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventoryAndCoupons(order._id);
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'confirmation.confirmedAt': new Date(),
        'confirmation.confirmedVia': 'email',
        'confirmation.decidedAt': null,
        'confirmation.decidedVia': null,
      },
    });

    await expect(cancelUnpaidOrderLocally({
      orderId: order._id,
      reason: 'attempted cross-channel override',
      allowedExistingDecisionChannels: ['manual', 'admin'],
    })).rejects.toMatchObject({ code: 'ORDER_DECISION_ALREADY_MADE' });

    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'pending',
      inventoryCommitted: true,
    });
    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 4, totalSales: 1 });
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('consumed');
  });

  test('reconfirm rolls back completely when stock changed after COD cancellation', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'cash_on_delivery',
      paymentSetupState: 'closed',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await commitOrderInventoryAndCoupons(order._id);
    await cancelUnpaidOrderLocally({ orderId: order._id, reason: 'buyer cancelled' });
    await Product.updateOne({ _id: ids.product }, { $set: { stock: 0 } });

    await expect(reconfirmCancelledCodOrder({ orderId: order._id }))
      .rejects.toMatchObject({ code: 'ORDER_STOCK_CHANGED' });

    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 0, totalSales: 0 });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
    });
  });

  test('fails closed when Stripe may have created an object whose ID was not saved', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'stripe',
      paymentSetupState: 'creating',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await Product.updateOne({ _id: ids.product }, { $inc: { stock: -1, totalSales: 1 } });
    await Order.updateOne({ _id: order._id }, { $set: { inventoryCommitted: true } });

    await expect(cancelOrderSafely({ orderId: order._id, reason: 'unsafe cancellation attempt' }))
      .rejects.toMatchObject({ code: 'PAYMENT_SETUP_RECOVERY_REQUIRED', statusCode: 503 });

    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 4, totalSales: 1 });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'pending',
      inventoryCommitted: true,
      paymentSetupState: 'creating',
    });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(1);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('reserved');
  });

  test('concurrent Stripe-local cancellation restores and releases exactly once after authoritative closure', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'stripe',
      paymentSetupState: 'ready',
      stripePaymentIntentId: 'pi_race',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await Product.updateOne({ _id: ids.product }, { $inc: { stock: -1, totalSales: 1 } });
    await Order.updateOne({ _id: order._id }, { $set: { inventoryCommitted: true } });

    await Promise.all([
      cancelUnpaidOrderLocally({ orderId: order._id, externalPaymentClosed: true }),
      cancelUnpaidOrderLocally({ orderId: order._id, externalPaymentClosed: true }),
    ]);

    expect(await Product.findById(ids.product).lean()).toMatchObject({ stock: 5, totalSales: 0 });
    expect(await Order.findById(order._id).lean()).toMatchObject({
      orderStatus: 'cancelled',
      inventoryCommitted: false,
      paymentSetupState: 'closed',
    });
    expect((await Coupon.findById(coupon._id)).usedCount).toBe(0);
    expect((await CouponRedemption.findOne({ order: order._id })).status).toBe('released');
  });

  test('concurrent Stripe success webhook and cancellation have one lifecycle winner with no mixed state', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'stripe',
      paymentSetupState: 'ready',
      stripePaymentIntentId: 'pi_webhook_race',
    });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });
    await Product.updateOne({ _id: ids.product }, { $inc: { stock: -1, totalSales: 1 } });
    await Order.updateOne({ _id: order._id }, { $set: { inventoryCommitted: true } });
    const paymentIntent = {
      id: 'pi_webhook_race',
      status: 'succeeded',
      amount: 9000,
      amount_received: 9000,
      currency: 'usd',
      customer: 'cus_race',
      livemode: false,
      receipt_email: 'race@example.com',
      metadata: {
        type: 'order_payment',
        paymentFlow: 'payment_sheet',
        orderId: order.orderId,
        mongoOrderId: String(order._id),
        userId: String(ids.buyer),
        amountMinor: '9000',
        stripeMode: 'test',
      },
    };

    const results = await Promise.allSettled([
      fulfillStripeOrderPaymentIntent({
        order,
        paymentIntent,
        eventId: 'evt_webhook_cancel_race',
      }),
      cancelUnpaidOrderLocally({
        orderId: order._id,
        reason: 'concurrent buyer cancellation',
        externalPaymentClosed: true,
      }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);

    const [savedOrder, product, refreshedCoupon, redemption] = await Promise.all([
      Order.findById(order._id).lean(),
      Product.findById(ids.product).lean(),
      Coupon.findById(coupon._id).lean(),
      CouponRedemption.findOne({ order: order._id }).lean(),
    ]);
    if (savedOrder.isPaid) {
      expect(savedOrder).toMatchObject({
        orderStatus: 'confirmed',
        awaitingPayment: false,
        inventoryCommitted: true,
        paymentSetupState: 'complete',
      });
      expect(product).toMatchObject({ stock: 4, totalSales: 1 });
      expect(refreshedCoupon.usedCount).toBe(1);
      expect(redemption.status).toBe('consumed');
    } else {
      expect(savedOrder).toMatchObject({
        orderStatus: 'cancelled',
        awaitingPayment: true,
        inventoryCommitted: false,
        paymentSetupState: 'closed',
      });
      expect(product).toMatchObject({ stock: 5, totalSales: 0 });
      expect(refreshedCoupon.usedCount).toBe(0);
      expect(redemption.status).toBe('released');
    }
  });

  test('Wallet payment racing cancellation has one atomic winner and no mixed money/inventory/coupon state', async () => {
    const ids = identity();
    await createProduct(ids);
    const coupon = await createCoupon(ids);
    const order = await createOrder({
      ids,
      coupon,
      paymentMethod: 'wallet',
      paymentSetupState: 'closed',
    });
    await Wallet.create({ user: ids.buyer, balances: { USD: 100 } });
    await reserveOrderCoupons({ orderId: order._id, userId: ids.buyer });

    const results = await Promise.allSettled([
      payOrderWithWallet({ orderId: order._id, userId: ids.buyer }),
      cancelUnpaidOrderLocally({ orderId: order._id, reason: 'buyer cancelled during wallet debit' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);

    const [savedOrder, product, wallet, redemption] = await Promise.all([
      Order.findById(order._id).lean(),
      Product.findById(ids.product).lean(),
      Wallet.findOne({ user: ids.buyer }).lean(),
      CouponRedemption.findOne({ order: order._id }).lean(),
    ]);
    if (savedOrder.isPaid) {
      expect(savedOrder).toMatchObject({ orderStatus: 'confirmed', awaitingPayment: false, inventoryCommitted: true });
      expect(product).toMatchObject({ stock: 4, totalSales: 1 });
      expect(wallet.balances.USD).toBe(10);
      expect(redemption.status).toBe('consumed');
      expect(await WalletTransaction.countDocuments({ referenceId: String(order._id) })).toBe(1);
    } else {
      expect(savedOrder).toMatchObject({ orderStatus: 'cancelled', awaitingPayment: true, inventoryCommitted: false });
      expect(product).toMatchObject({ stock: 5, totalSales: 0 });
      expect(wallet.balances.USD).toBe(100);
      expect(redemption.status).toBe('released');
      expect(await WalletTransaction.countDocuments({ referenceId: String(order._id) })).toBe(0);
    }
  });
});
