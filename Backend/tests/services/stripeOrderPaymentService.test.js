const {
  toStripeMinorUnits,
  getExpectedStripeTotalMinor,
  validateStripeOrderSession,
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
});
