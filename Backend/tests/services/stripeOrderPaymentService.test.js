const {
  toStripeMinorUnits,
  getExpectedStripeTotalMinor,
  validateStripeOrderSession,
  validateStripeOrderPaymentIntent,
} = require('../../services/stripeOrderPaymentService');

const order = {
  paymentMethod: 'stripe',
  stripeSessionId: 'cs_test_123',
  orderId: 'ORD-TEST-123',
  currency: 'PKR',
  orderItems: [
    { price: 1000.25, quantity: 2 },
    { price: 499.5, quantity: 1 },
  ],
  orderSummary: {
    shippingCost: 150,
    tax: 35.75,
    couponDiscount: 100,
  },
};

const session = (overrides = {}) => ({
  id: 'cs_test_123',
  mode: 'payment',
  payment_status: 'paid',
  currency: 'pkr',
  amount_total: getExpectedStripeTotalMinor(order),
  metadata: { orderId: 'ORD-TEST-123' },
  ...overrides,
});

const nativeOrder = {
  ...order,
  _id: '507f1f77bcf86cd799439011',
  user: '507f1f77bcf86cd799439012',
  paymentFlow: 'payment_sheet',
  stripeMode: 'test',
  stripeCustomerId: 'cus_test_123',
  stripePaymentIntentId: 'pi_test_123',
};

const paymentIntent = (overrides = {}) => ({
  id: 'pi_test_123',
  status: 'succeeded',
  amount: getExpectedStripeTotalMinor(nativeOrder),
  amount_received: getExpectedStripeTotalMinor(nativeOrder),
  currency: 'pkr',
  customer: 'cus_test_123',
  livemode: false,
  metadata: {
    type: 'order_payment',
    paymentFlow: 'payment_sheet',
    orderId: nativeOrder.orderId,
    mongoOrderId: nativeOrder._id,
    userId: nativeOrder.user,
    amountMinor: String(getExpectedStripeTotalMinor(nativeOrder)),
    stripeMode: 'test',
  },
  ...overrides,
});

describe('Stripe order payment validation', () => {
  test('uses Stripe minor-unit rules and the exact checkout line total', () => {
    expect(toStripeMinorUnits(10.235, 'USD')).toBe(1024);
    expect(toStripeMinorUnits(10.6, 'JPY')).toBe(11);
    expect(getExpectedStripeTotalMinor(order)).toBe(258575);
  });

  test('accepts an exact paid session for its order', () => {
    expect(validateStripeOrderSession(order, session(), { requirePaid: true })).toBe(true);
  });

  test.each([
    [{ id: 'cs_other' }, 'PAYMENT_SESSION_MISMATCH'],
    [{ metadata: { orderId: 'ORD-OTHER' } }, 'PAYMENT_ORDER_MISMATCH'],
    [{ currency: 'usd' }, 'PAYMENT_CURRENCY_MISMATCH'],
    [{ amount_total: 1 }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ payment_status: 'unpaid' }, 'PAYMENT_NOT_CONFIRMED'],
  ])('rejects mismatched or unconfirmed session data', (override, code) => {
    expect(() => validateStripeOrderSession(order, session(override), { requirePaid: true }))
      .toThrow(expect.objectContaining({ code }));
  });

  test('accepts a fully owned and fully captured native PaymentIntent', () => {
    expect(validateStripeOrderPaymentIntent(nativeOrder, paymentIntent(), {
      requireSucceeded: true,
    })).toBe(true);
  });

  test.each([
    [{ id: 'pi_other' }, 'PAYMENT_INTENT_MISMATCH'],
    [{ customer: 'cus_other' }, 'PAYMENT_CUSTOMER_MISMATCH'],
    [{ amount: 1 }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ currency: 'usd' }, 'PAYMENT_CURRENCY_MISMATCH'],
    [{ livemode: true }, 'PAYMENT_MODE_MISMATCH'],
    [{ status: 'requires_payment_method' }, 'PAYMENT_NOT_CONFIRMED'],
  ])('rejects invalid native PaymentIntent ownership or capture data', (override, code) => {
    expect(() => validateStripeOrderPaymentIntent(nativeOrder, paymentIntent(override), {
      requireSucceeded: true,
    })).toThrow(expect.objectContaining({ code }));
  });
});
