'use strict';

const mockRefundCreate = jest.fn();
const mockRefundRetrieve = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    refunds: {
      create: mockRefundCreate,
      retrieve: mockRefundRetrieve,
    },
  },
  STRIPE_MODE: 'test',
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const NotificationOutbox = require('../../models/NotificationOutbox');
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const StripePaymentRiskMarker = require('../../models/StripePaymentRiskMarker');
const { flagStripePaymentRisk } = require('../../services/stripePaymentRiskService');
const { fulfillStripeOrderPaymentIntent } = require('../../services/stripeOrderPaymentService');

let replSet;

const productData = {
  name: 'Captured stock race',
  description: 'Legacy captured-payment stock-race fixture.',
  price: 10,
  currency: 'USD',
  priceCurrency: 'USD',
  category: 'Test',
  brand: 'Rozare',
  stock: 0,
  image: 'https://example.com/captured-stock.jpg',
  images: [{ url: 'https://example.com/captured-stock.jpg' }],
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  await NotificationOutbox.syncIndexes();
}, 120000);

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replSet) await replSet.stop();
}, 120000);

beforeEach(async () => {
  jest.clearAllMocks();
  await Promise.all([
    Order.deleteMany({}),
    NotificationOutbox.deleteMany({}),
    Product.deleteMany({}),
    StripePaymentRiskMarker.deleteMany({}),
  ]);
  const completedRefund = {
    id: 're_stock_1',
    status: 'succeeded',
    amount: 1000,
    currency: 'usd',
    payment_intent: 'pi_capture_1',
  };
  mockRefundCreate.mockResolvedValue(completedRefund);
  mockRefundRetrieve.mockResolvedValue(completedRefund);
});

const createLegacyOrder = async ({
  currency = 'USD',
  totalAmount = 10,
  paymentIntentId = 'pi_capture_1',
} = {}) => {
  const product = await Product.create(productData);
  const user = new mongoose.Types.ObjectId();
  const order = await Order.create({
    user,
    orderId: `ORD-CAPTURE-${Date.now()}`,
    currency,
    orderItems: [{
      productId: product._id,
      name: product.name,
      image: product.image,
      price: totalAmount,
      lineSubtotal: totalAmount,
      quantity: 1,
    }],
    shippingInfo: {
      fullName: 'Capture Buyer',
      email: 'capture@example.com',
      phone: '+923001234567',
      address: '1 Test Street',
      city: 'Lahore',
      state: 'Punjab',
      postalCode: '54000',
      country: 'Pakistan',
    },
    shippingMethod: { name: 'standard', price: 0, estimatedDays: 5 },
    orderSummary: {
      subtotal: totalAmount,
      shippingCost: 0,
      tax: 0,
      couponDiscount: 0,
      totalAmount,
    },
    paymentMethod: 'stripe',
    paymentFlow: 'payment_sheet',
    paymentSetupState: 'ready',
    stripeMode: 'test',
    stripeCustomerId: 'cus_capture_1',
    stripePaymentIntentId: paymentIntentId,
    awaitingPayment: true,
    inventoryCommitted: false,
    isPaid: false,
  });
  const paymentIntent = {
    id: paymentIntentId,
    status: 'succeeded',
    amount: Math.round(totalAmount * 100),
    amount_received: Math.round(totalAmount * 100),
    currency: currency.toLowerCase(),
    customer: 'cus_capture_1',
    livemode: false,
    receipt_email: 'capture@example.com',
    metadata: {
      type: 'order_payment',
      paymentFlow: 'payment_sheet',
      orderId: order.orderId,
      mongoOrderId: String(order._id),
      userId: String(user),
      amountMinor: String(Math.round(totalAmount * 100)),
      stripeMode: 'test',
    },
  };
  return { order, paymentIntent, product };
};

describe('captured Stripe inventory safety', () => {
  test('an early card reversal marker cancels the order without inventory or revenue fulfillment', async () => {
    const { order, paymentIntent, product } = await createLegacyOrder();
    await Product.updateOne({ _id: product._id }, { $set: { stock: 5 } });
    const risk = await flagStripePaymentRisk({
      charge: {
        id: 'ch_capture_early_risk',
        amount: 1000,
        amount_refunded: 1000,
        currency: 'usd',
        payment_intent: paymentIntent.id,
        metadata: paymentIntent.metadata,
      },
      eventId: 'evt_capture_early_risk',
      eventType: 'charge.refunded',
    });
    expect(risk).toMatchObject({ handled: true, preCompletionBlocked: true });

    const completion = await fulfillStripeOrderPaymentIntent({
      order,
      paymentIntent,
      eventId: 'evt_capture_success_after_risk',
    });
    expect(completion).toMatchObject({ paymentReversed: true, newlyFulfilled: false });
    const stored = await Order.findById(order._id);
    expect(stored).toMatchObject({
      isPaid: false,
      inventoryCommitted: false,
      orderStatus: 'cancelled',
    });
    expect(stored.paymentResult).toMatchObject({
      failureCode: 'STRIPE_PAYMENT_REVERSED_BEFORE_COMPLETION',
    });
    expect(await Product.findById(product._id).lean()).toMatchObject({ stock: 5, totalSales: 0 });
  });

  test('automatically refunds a legacy capture when stock commit loses the race, then replays idempotently', async () => {
    const { order, paymentIntent, product } = await createLegacyOrder();

    const first = await fulfillStripeOrderPaymentIntent({
      order,
      paymentIntent,
      eventId: 'evt_capture_first',
    });

    expect(first).toMatchObject({ paymentRefunded: true, newlyFulfilled: false });
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockRefundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: paymentIntent.id }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining(String(order._id)) }),
    );
    let stored = await Order.findById(order._id);
    expect(stored).toMatchObject({
      isPaid: false,
      awaitingPayment: true,
      inventoryCommitted: false,
      orderStatus: 'cancelled',
      paymentSetupState: 'closed',
    });
    expect(stored.paymentProcessingStartedAt).toBeNull();
    expect(stored.paymentResult).toMatchObject({
      stockRefundId: 're_stock_1',
      stockRefundStatus: 'succeeded',
      stockRefundAmountMinor: 1000,
      stockRefundCurrency: 'USD',
      failureCode: 'ORDER_STOCK_CHANGED_AFTER_CAPTURE',
    });
    expect(stored.paymentResult.stockRefundAt).toBeInstanceOf(Date);
    expect(await Product.findById(product._id).lean()).toMatchObject({ stock: 0, totalSales: 0 });

    let refundReceipts = await NotificationOutbox.find({
      aggregateId: String(order._id),
      eventType: 'order.stock_refund_completed',
      'recipient.audienceRole': 'buyer',
    }).lean();
    expect(refundReceipts.map(record => record.channel).sort())
      .toEqual(['email', 'inapp', 'push', 'whatsapp']);
    for (const record of refundReceipts) {
      expect(record.money).toEqual([expect.objectContaining({
        amountMinor: 1000,
        currency: 'USD',
        sourcePath: 'paymentResult.stockRefundAmountMinor',
      })]);
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(rendered).toContain('$10.00');
    }
    expect(await NotificationOutbox.countDocuments({
      aggregateId: String(order._id),
      eventType: 'order.status_updated',
      'recipient.audienceRole': 'buyer',
    })).toBe(0);

    const replay = await fulfillStripeOrderPaymentIntent({
      order: stored,
      paymentIntent,
      eventId: 'evt_capture_retry',
    });
    expect(replay).toMatchObject({ paymentRefunded: true, newlyFulfilled: false });
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockRefundRetrieve).toHaveBeenCalledTimes(1);
    stored = await Order.findById(order._id);
    expect(stored.orderStatus).toBe('cancelled');
    expect(stored.isPaid).toBe(false);
    expect((await Product.findById(product._id)).stock).toBe(0);
    refundReceipts = await NotificationOutbox.find({
      aggregateId: String(order._id),
      eventType: 'order.stock_refund_completed',
    }).lean();
    expect(refundReceipts).toHaveLength(4);
  });

  test('PKR stock-loss refund renders the provider-confirmed minor units without live FX', async () => {
    const paymentIntentId = 'pi_capture_pkr_1';
    const { order, paymentIntent } = await createLegacyOrder({
      currency: 'PKR',
      totalAmount: 1880,
      paymentIntentId,
    });
    const completedRefund = {
      id: 're_stock_pkr_1',
      status: 'succeeded',
      amount: 188000,
      currency: 'pkr',
      payment_intent: paymentIntentId,
    };
    mockRefundCreate.mockResolvedValue(completedRefund);
    mockRefundRetrieve.mockResolvedValue(completedRefund);

    await fulfillStripeOrderPaymentIntent({
      order,
      paymentIntent,
      eventId: 'evt_capture_pkr',
    });

    const stored = await Order.findById(order._id).lean();
    expect(stored.paymentResult).toMatchObject({
      stockRefundId: 're_stock_pkr_1',
      stockRefundStatus: 'succeeded',
      stockRefundAmountMinor: 188000,
      stockRefundCurrency: 'PKR',
    });
    const receipts = await NotificationOutbox.find({
      aggregateId: String(order._id),
      eventType: 'order.stock_refund_completed',
    }).lean();
    expect(receipts).toHaveLength(4);
    for (const record of receipts) {
      const rendered = record.payload.body
        || record.payload.text
        || record.payload.html
        || record.payload.message;
      expect(record.money[0]).toEqual(expect.objectContaining({
        amountMinor: 188000,
        currency: 'PKR',
      }));
      expect(rendered).toContain('Rs1,880.00 PKR');
      expect(rendered).not.toContain('$');
    }
  });

  test.each([
    [999, 'usd', 'CAPTURED_PAYMENT_REFUND_AMOUNT_MISMATCH'],
    [1000, 'pkr', 'CAPTURED_PAYMENT_REFUND_CURRENCY_MISMATCH'],
  ])('fails closed and emits no receipt for mismatched Stripe refund %s %s', async (
    amount,
    currency,
    expectedCode,
  ) => {
    const { order, paymentIntent } = await createLegacyOrder();
    mockRefundCreate.mockResolvedValue({
      id: `re_stock_wrong_${currency}_${amount}`,
      status: 'succeeded',
      amount,
      currency,
      payment_intent: paymentIntent.id,
    });

    await expect(fulfillStripeOrderPaymentIntent({
      order,
      paymentIntent,
      eventId: `evt_capture_wrong_refund_${currency}_${amount}`,
    })).rejects.toMatchObject({
      code: expectedCode,
      statusCode: 503,
    });

    const stored = await Order.findById(order._id).lean();
    expect(stored).toMatchObject({
      isPaid: false,
      orderStatus: 'pending',
    });
    expect(stored.paymentResult.stockRefundId).toBeNull();
    expect(await NotificationOutbox.countDocuments({ aggregateId: String(order._id) })).toBe(0);
  });
});
