'use strict';

const mockCheckoutSessionCreate = jest.fn();
const mockPaymentIntentCreate = jest.fn();

jest.mock('../../config/stripe', () => ({
  STRIPE_MODE: 'test',
  stripe: {
    checkout: {
      sessions: { create: mockCheckoutSessionCreate },
    },
    paymentIntents: { create: mockPaymentIntentCreate },
    coupons: { create: jest.fn() },
  },
}));

const {
  createHostedOrderCheckoutSession,
  createNativeOrderPaymentIntent,
  hostedOrderLineItems,
} = require('../../services/stripeOrderSetupService');

const makeOrder = overrides => ({
  _id: '507f1f77bcf86cd799439011',
  orderId: 'ORD-CHECKOUT-1',
  user: '507f1f77bcf86cd799439012',
  currency: 'PKR',
  stripeMode: 'test',
  stripeCustomerId: 'cus_order_1',
  clientSurface: 'web',
  paymentExpiresAt: new Date(Date.now() + 35 * 60 * 1000),
  orderItems: [{ name: 'Native PKR item', quantity: 1, lineSubtotal: 1000 }],
  sellerShipping: [],
  shippingMethod: { name: 'Standard' },
  orderSummary: {
    subtotal: 1000,
    shippingCost: 0,
    tax: 0,
    couponDiscount: 0,
    totalAmount: 1000,
  },
  tracking: { tiktokPurchaseEventId: 'event-order-1' },
  ...overrides,
});

describe('hosted order Checkout metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckoutSessionCreate.mockResolvedValue({ id: 'cs_order_1' });
    mockPaymentIntentCreate.mockResolvedValue({ id: 'pi_order_1' });
  });

  test('copies immutable source metadata onto the PaymentIntent for reversal webhooks', async () => {
    const order = makeOrder();

    await createHostedOrderCheckoutSession(order);

    const [params] = mockCheckoutSessionCreate.mock.calls[0];
    expect(params.payment_intent_data?.metadata).toEqual(params.metadata);
    expect(params.metadata).toEqual({
      type: 'order_payment',
      paymentFlow: 'checkout_session',
      orderId: 'ORD-CHECKOUT-1',
      mongoOrderId: '507f1f77bcf86cd799439011',
      userId: '507f1f77bcf86cd799439012',
      amountMinor: '100000',
      currency: 'PKR',
      stripeMode: 'test',
      tiktokPurchaseEventId: 'event-order-1',
    });
  });

  test('replays hosted setup with frozen return URLs even if FRONTEND_URL changes', async () => {
    const originalFrontendUrl = process.env.FRONTEND_URL;
    const order = makeOrder({
      paymentSetupState: 'creating',
      paymentSetupStartedAt: new Date(),
      stripeCheckoutSuccessUrl: 'https://checkout-snapshot.example/success?session_id={CHECKOUT_SESSION_ID}&orderId=ORD-CHECKOUT-1',
      stripeCheckoutCancelUrl: 'https://checkout-snapshot.example/checkout',
    });
    try {
      process.env.FRONTEND_URL = 'https://first-runtime.example';
      await createHostedOrderCheckoutSession(order);
      process.env.FRONTEND_URL = 'https://second-runtime.example';
      await createHostedOrderCheckoutSession(order);
    } finally {
      if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = originalFrontendUrl;
    }

    expect(mockCheckoutSessionCreate).toHaveBeenCalledTimes(2);
    const firstParams = mockCheckoutSessionCreate.mock.calls[0][0];
    const secondParams = mockCheckoutSessionCreate.mock.calls[1][0];
    expect(firstParams.success_url).toBe(order.stripeCheckoutSuccessUrl);
    expect(firstParams.cancel_url).toBe(order.stripeCheckoutCancelUrl);
    expect(secondParams).toEqual(firstParams);
  });

  test('never rebuilds mutable return URLs for a legacy creating order without snapshots', async () => {
    await expect(createHostedOrderCheckoutSession(makeOrder({
      paymentSetupState: 'creating',
      paymentSetupStartedAt: new Date(),
    }))).rejects.toMatchObject({
      code: 'PAYMENT_SETUP_RECOVERY_REQUIRED',
      statusCode: 503,
    });
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test('consolidates receipt presentation before Stripe payment-mode line item limits', () => {
    const orderItems = Array.from({ length: 101 }, (_, index) => ({
      name: `Item ${index + 1}`,
      quantity: 1,
      lineSubtotal: 1,
    }));
    const order = makeOrder({
      orderItems,
      orderSummary: {
        subtotal: 101,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 101,
      },
    });

    const lines = hostedOrderLineItems(order);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      price_data: {
        product_data: { name: 'Order items (101 lines)' },
        unit_amount: 10100,
      },
      quantity: 1,
    });
  });

  test.each([
    ['Stripe mode', { stripeMode: '' }],
    ['client surface', { clientSurface: 'unknown' }],
    ['customer', { stripeCustomerId: '' }],
    ['expiry', { paymentExpiresAt: '2026-08-24T00:00:00.000Z' }],
  ])('fails closed for an invalid %s snapshot before creating Checkout', async (_label, override) => {
    await expect(createHostedOrderCheckoutSession(makeOrder(override)))
      .rejects.toMatchObject({ code: expect.stringMatching(/^PAYMENT_/) });
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test('rejects zero-total hosted setup so no-charge orders cannot create Stripe objects', async () => {
    await expect(createHostedOrderCheckoutSession(makeOrder({
      orderItems: [{ name: 'Free item', quantity: 1, lineSubtotal: 0 }],
      orderSummary: {
        subtotal: 0,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 0,
      },
    }))).rejects.toMatchObject({ code: 'PAYMENT_SETUP_INVALID' });
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['hosted Checkout', 'web', createHostedOrderCheckoutSession, mockCheckoutSessionCreate],
    ['native PaymentIntent', 'mobile', createNativeOrderPaymentIntent, mockPaymentIntentCreate],
  ])('rejects an over-limit %s before any Stripe mutation', async (
    _label,
    clientSurface,
    create,
    expectedCreate,
  ) => {
    const oversized = makeOrder({
      currency: 'GBP',
      clientSurface,
      orderItems: [{ name: 'Oversized item', quantity: 1, lineSubtotal: 1_000_000 }],
      orderSummary: {
        subtotal: 1_000_000,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1_000_000,
      },
    });

    await expect(Promise.resolve().then(() => create(oversized))).rejects.toMatchObject({
      code: 'PAYMENT_AMOUNT_TOO_LARGE',
      statusCode: 400,
    });
    expect(expectedCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
  });
});
