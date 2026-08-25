'use strict';

const mockCommitOrderInventory = jest.fn();
const mockConsumeOrderCoupons = jest.fn();
const mockOrderFindOneAndUpdate = jest.fn();
const mockOrderFindById = jest.fn();
const mockOrderUpdateOne = jest.fn();
const mockClaimStripePaymentCompletion = jest.fn();
const mockMarkStripePaymentCompletionDone = jest.fn();

jest.mock('../../services/orderInventoryService', () => ({
  commitOrderInventory: mockCommitOrderInventory,
}));

jest.mock('../../services/couponUsageService', () => ({
  consumeOrderCoupons: mockConsumeOrderCoupons,
}));

jest.mock('../../models/Order', () => ({
  findOneAndUpdate: mockOrderFindOneAndUpdate,
  findById: mockOrderFindById,
  updateOne: mockOrderUpdateOne,
}));

jest.mock('../../services/stripePaymentRiskMarkerService', () => ({
  claimStripePaymentCompletion: mockClaimStripePaymentCompletion,
  markStripePaymentCompletionDone: mockMarkStripePaymentCompletionDone,
}));

const {
  fulfillStripeOrder,
  getExpectedStripeTotalMinor,
  attachStripeOrderReference,
} = require('../../services/stripeOrderPaymentService');

const makeOrder = () => ({
  _id: '507f1f77bcf86cd799439011',
  user: '507f1f77bcf86cd799439012',
  paymentMethod: 'stripe',
  paymentFlow: 'checkout_session',
  stripeSessionId: 'cs_coupon_123',
  orderId: 'ORD-COUPON-123',
  currency: 'USD',
  orderItems: [{
    price: 10,
    lineSubtotal: 10,
    sourcePrice: 10,
    sourceLineSubtotal: 10,
    sourceCurrency: 'USD',
    quantity: 1,
  }],
  orderSummary: {
    subtotal: 10,
    shippingCost: 0,
    tax: 0,
    couponDiscount: 1,
    totalAmount: 9,
  },
  appliedCoupons: [{ couponId: '507f1f77bcf86cd799439013' }],
  awaitingPayment: true,
  isPaid: false,
  inventoryCommitted: false,
  paymentFulfilledAt: null,
  paymentProcessingStartedAt: null,
  orderStatus: 'pending',
  paymentResult: {},
  confirmation: {},
  sellerFulfillment: [],
  shippingInfo: { email: 'buyer@example.com' },
  save: jest.fn().mockResolvedValue(undefined),
});

const makeSession = order => ({
  id: order.stripeSessionId,
  mode: 'payment',
  payment_status: 'paid',
  currency: order.currency.toLowerCase(),
  amount_total: getExpectedStripeTotalMinor(order),
  payment_intent: 'pi_coupon_123',
  customer_details: { email: 'buyer@example.com' },
  metadata: { orderId: order.orderId },
});

describe('Stripe coupon consumption lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCommitOrderInventory.mockResolvedValue({ alreadyCommitted: false });
    mockOrderUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    mockConsumeOrderCoupons.mockResolvedValue({ consumed: 1 });
    mockClaimStripePaymentCompletion.mockResolvedValue({ claimed: true });
    mockMarkStripePaymentCompletionDone.mockResolvedValue({ completed: true });
  });

  test('consumes a reserved coupon when Stripe fulfillment becomes durable', async () => {
    const order = makeOrder();
    mockOrderFindOneAndUpdate.mockResolvedValue(order);

    const result = await fulfillStripeOrder({
      order,
      stripeSession: makeSession(order),
      eventId: 'evt_coupon_123',
    });

    expect(mockCommitOrderInventory).toHaveBeenCalledWith(order._id);
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(mockConsumeOrderCoupons).toHaveBeenCalledWith({ orderId: order._id });
    expect(mockClaimStripePaymentCompletion).toHaveBeenCalledWith({
      paymentIntentId: 'pi_coupon_123',
      sourceType: 'order_payment',
      sourceReferenceId: order._id,
      eventId: 'evt_coupon_123',
    });
    expect(mockMarkStripePaymentCompletionDone).toHaveBeenCalledWith({
      paymentIntentId: 'pi_coupon_123',
      sourceType: 'order_payment',
      sourceReferenceId: order._id,
    });
    expect(result).toMatchObject({ order, newlyFulfilled: true });
    expect(order).toMatchObject({
      isPaid: true,
      awaitingPayment: false,
      inventoryCommitted: true,
      orderStatus: 'confirmed',
    });
  });

  test('returns a retryable error after capture and finishes consumption on webhook retry', async () => {
    const order = makeOrder();
    mockOrderFindOneAndUpdate.mockResolvedValue(order);
    mockConsumeOrderCoupons
      .mockRejectedValueOnce(Object.assign(new Error('temporary coupon write failure'), { code: 'COUPON_WRITE_FAILED' }))
      .mockResolvedValueOnce({ consumed: 1 });

    await expect(fulfillStripeOrder({
      order,
      stripeSession: makeSession(order),
      eventId: 'evt_coupon_first',
    })).rejects.toMatchObject({ statusCode: 500, code: 'COUPON_WRITE_FAILED' });
    expect(mockMarkStripePaymentCompletionDone).not.toHaveBeenCalled();

    const retry = await fulfillStripeOrder({
      order,
      stripeSession: makeSession(order),
      eventId: 'evt_coupon_retry',
    });
    expect(mockConsumeOrderCoupons).toHaveBeenCalledTimes(2);
    expect(mockClaimStripePaymentCompletion).toHaveBeenCalledTimes(2);
    expect(mockMarkStripePaymentCompletionDone).toHaveBeenCalledTimes(1);
    expect(mockOrderFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ order, newlyFulfilled: false });
  });
});

describe('signed Stripe event reference recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('atomically attaches a hosted Session created before its ID save failed', async () => {
    const order = makeOrder();
    order.stripeSessionId = null;
    order.paymentSetupState = 'creating';
    const session = makeSession({ ...order, stripeSessionId: 'cs_recovered_event' });
    const recovered = {
      ...order,
      stripeSessionId: session.id,
      paymentSetupState: 'ready',
    };
    mockOrderFindOneAndUpdate.mockResolvedValue(recovered);

    const result = await attachStripeOrderReference({
      order,
      stripeObject: session,
      paymentFlow: 'checkout_session',
    });

    expect(mockOrderFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: order._id,
        paymentSetupState: 'creating',
        paymentFlow: 'checkout_session',
      }),
      {
        $set: {
          stripeSessionId: session.id,
          paymentSetupState: 'ready',
          paymentSetupCompletedAt: expect.any(Date),
        },
      },
      { new: true },
    );
    expect(result).toBe(recovered);
  });

  test('atomically attaches a PaymentIntent created before its ID save failed', async () => {
    const order = makeOrder();
    order.paymentFlow = 'payment_sheet';
    order.stripeSessionId = null;
    order.stripePaymentIntentId = null;
    order.paymentSetupState = 'creating';
    order.stripeMode = 'test';
    order.stripeCustomerId = 'cus_recovered_event';
    const amount = getExpectedStripeTotalMinor(order);
    const paymentIntent = {
      id: 'pi_recovered_event',
      status: 'succeeded',
      amount,
      amount_received: amount,
      currency: 'usd',
      customer: order.stripeCustomerId,
      livemode: false,
      metadata: {
        type: 'order_payment',
        paymentFlow: 'payment_sheet',
        orderId: order.orderId,
        mongoOrderId: String(order._id),
        userId: String(order.user),
        amountMinor: String(amount),
        stripeMode: 'test',
      },
    };
    const recovered = {
      ...order,
      stripePaymentIntentId: paymentIntent.id,
      paymentSetupState: 'ready',
    };
    mockOrderFindOneAndUpdate.mockResolvedValue(recovered);

    const result = await attachStripeOrderReference({
      order,
      stripeObject: paymentIntent,
      paymentFlow: 'payment_sheet',
    });

    expect(mockOrderFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: order._id,
        paymentSetupState: 'creating',
        paymentFlow: 'payment_sheet',
      }),
      {
        $set: {
          stripePaymentIntentId: paymentIntent.id,
          paymentSetupState: 'ready',
          paymentSetupCompletedAt: expect.any(Date),
        },
      },
      { new: true },
    );
    expect(result).toBe(recovered);
  });

  test('fails closed instead of attaching an event to a setup that was never marked creating', async () => {
    const order = makeOrder();
    order.stripeSessionId = null;
    order.paymentSetupState = 'not_started';
    const session = makeSession({ ...order, stripeSessionId: 'cs_unexpected_event' });

    await expect(attachStripeOrderReference({
      order,
      stripeObject: session,
      paymentFlow: 'checkout_session',
    })).rejects.toMatchObject({
      code: 'PAYMENT_SETUP_RECOVERY_REQUIRED',
      statusCode: 503,
    });
    expect(mockOrderFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
