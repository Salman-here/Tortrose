const {
  toStripeMinorUnits,
  getExpectedStripeTotalMinor,
  getStripeOrderChargeAmountMinor,
  validateStripeOrderSession,
  validateStripeOrderPaymentIntent,
} = require('../../services/stripeOrderPaymentService');

const order = {
  paymentMethod: 'stripe',
  paymentFlow: 'checkout_session',
  stripeSessionId: 'cs_test_123',
  orderId: 'ORD-TEST-123',
  currency: 'PKR',
  orderItems: [
    { price: 1000.25, quantity: 2 },
    { price: 499.5, quantity: 1 },
  ],
  orderSummary: {
    subtotal: 2500,
    shippingCost: 150,
    tax: 35.75,
    couponDiscount: 100,
    totalAmount: 2585.75,
  },
};

const session = (overrides = {}) => ({
  id: 'cs_test_123',
  mode: 'payment',
  payment_status: 'paid',
  payment_intent: 'pi_checkout_123',
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

  test.each(['USD', 'PKR', 'EUR', 'GBP'])(
    'uses exactly two decimals and accepts the Stripe ceiling for %s',
    currency => {
      const maximumOrder = {
        currency,
        orderItems: [{ price: 999_999.99, lineSubtotal: 999_999.99, quantity: 1 }],
        orderSummary: {
          subtotal: 999_999.99,
          shippingCost: 0,
          tax: 0,
          couponDiscount: 0,
          totalAmount: 999_999.99,
        },
      };
      expect(toStripeMinorUnits(12.34, currency)).toBe(1234);
      expect(getStripeOrderChargeAmountMinor(maximumOrder)).toBe(99_999_999);
    },
  );

  test('rejects one minor unit above Stripe maximum while allowing zero only for local no-charge routing', () => {
    const oversizedOrder = {
      currency: 'USD',
      orderItems: [{ price: 1_000_000, lineSubtotal: 1_000_000, quantity: 1 }],
      orderSummary: {
        subtotal: 1_000_000,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 1_000_000,
      },
    };
    expect(() => getStripeOrderChargeAmountMinor(oversizedOrder)).toThrow(expect.objectContaining({
      code: 'PAYMENT_AMOUNT_TOO_LARGE',
      statusCode: 400,
    }));

    const zeroOrder = {
      currency: 'USD',
      orderItems: [{ price: 0, lineSubtotal: 0, quantity: 1 }],
      orderSummary: { subtotal: 0, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 0 },
    };
    expect(getStripeOrderChargeAmountMinor(zeroOrder, { allowZero: true })).toBe(0);
    expect(() => getStripeOrderChargeAmountMinor(zeroOrder)).toThrow(expect.objectContaining({
      code: 'PAYMENT_SETUP_INVALID',
    }));
  });

  test.each([true, '', Number.POSITIVE_INFINITY, -0.01, {}])(
    'never converts malformed Stripe money %p into a zero amount',
    value => {
      expect(() => toStripeMinorUnits(value, 'USD'))
        .toThrow(expect.objectContaining({ code: 'STRIPE_MONEY_INVALID' }));
    },
  );

  test('charges the authoritative converted line snapshot for sub-cent FX units', () => {
    const bulkOrder = {
      currency: 'USD',
      orderItems: [{ price: 0, quantity: 1000, lineSubtotal: 3.57 }],
      orderSummary: {
        subtotal: 3.57,
        shippingCost: 0,
        tax: 0,
        couponDiscount: 0,
        totalAmount: 3.57,
      },
    };
    expect(getExpectedStripeTotalMinor(bulkOrder)).toBe(357);
  });

  test('fails closed if stored totals do not reconcile with item snapshots', () => {
    expect(() => getExpectedStripeTotalMinor({
      currency: 'USD',
      orderItems: [{ price: 0, quantity: 1000, lineSubtotal: 3.57 }],
      orderSummary: { subtotal: 0, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 0 },
    })).toThrow(expect.objectContaining({ code: 'ORDER_TOTAL_MISMATCH' }));
  });

  test.each(['CAD', 'pkr', ' PKR ', ''])(
    'never reconciles corrupt stored order currency %p as an application currency',
    currency => {
      expect(() => getExpectedStripeTotalMinor({
        ...order,
        currency,
      })).toThrow(expect.objectContaining({ code: 'ORDER_CURRENCY_INVALID' }));
    },
  );

  test.each([
    ['non-finite line total', {
      orderItems: [{ price: 1, lineSubtotal: Number.POSITIVE_INFINITY, quantity: 1 }],
      orderSummary: { subtotal: 0, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 0 },
    }],
    ['blank summary total', {
      orderItems: [{ price: 1, lineSubtotal: 1, quantity: 1 }],
      orderSummary: { subtotal: 1, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: '' },
    }],
    ['sub-cent persisted component', {
      orderItems: [{ price: 1, lineSubtotal: 1, quantity: 1 }],
      orderSummary: { subtotal: 1, shippingCost: 0.001, tax: 0, couponDiscount: 0, totalAmount: 1 },
    }],
    ['discount beyond gross components', {
      orderItems: [{ price: 1, lineSubtotal: 1, quantity: 1 }],
      orderSummary: { subtotal: 1, shippingCost: 0, tax: 0, couponDiscount: 2, totalAmount: 0 },
    }],
    ['discount consuming shipping instead of products', {
      orderItems: [{ price: 10, lineSubtotal: 10, quantity: 1 }],
      orderSummary: { subtotal: 10, shippingCost: 5, tax: 2, couponDiscount: 11, totalAmount: 6 },
    }],
    ['string order quantity', {
      orderItems: [{ price: 1, lineSubtotal: 1, quantity: '1' }],
      orderSummary: { subtotal: 1, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 1 },
    }],
    ['empty payable order', {
      orderItems: [],
      orderSummary: { subtotal: 0, shippingCost: 1, tax: 0, couponDiscount: 0, totalAmount: 1 },
    }],
  ])('fails closed for %s instead of reconciling a zero or rounded charge', (_label, corrupt) => {
    expect(() => getExpectedStripeTotalMinor({ currency: 'USD', ...corrupt }))
      .toThrow(expect.objectContaining({
        code: expect.stringMatching(/^ORDER_(?:MONEY_INVALID|TOTAL_MISMATCH)$/),
      }));
  });

  test('reconciles every reserved coupon amount and product scope before payment', () => {
    const reservedOrder = {
      currency: 'USD',
      couponUsageVersion: 1,
      orderItems: [
        { productId: 'product-a', seller: 'seller-a', price: 10, lineSubtotal: 10, quantity: 1 },
        { productId: 'product-b', seller: 'seller-b', price: 20, lineSubtotal: 20, quantity: 1 },
      ],
      appliedCoupons: [
        {
          couponId: 'coupon-a',
          seller: 'seller-a',
          discountType: 'fixed',
          currency: 'USD',
          appliedDiscountAmount: 4,
          applicableProductIds: ['product-a'],
        },
        {
          couponId: 'coupon-b',
          seller: 'seller-b',
          discountType: 'percentage',
          currency: 'USD',
          appliedDiscountAmount: 6,
          applicableProductIds: ['product-b'],
        },
      ],
      orderSummary: {
        subtotal: 30,
        shippingCost: 5,
        tax: 2,
        couponDiscount: 10,
        totalAmount: 27,
      },
    };
    expect(getExpectedStripeTotalMinor(reservedOrder)).toBe(2700);
  });

  test.each([
    ['amount sum', order => { order.appliedCoupons[0].appliedDiscountAmount = 3; }],
    ['coupon currency', order => { order.appliedCoupons[0].currency = 'PKR'; }],
    ['overlapping product scope', order => { order.appliedCoupons[1].applicableProductIds = ['product-a']; }],
    ['seller ownership', order => { order.appliedCoupons[0].seller = 'seller-b'; }],
    ['unknown product scope', order => { order.appliedCoupons[1].applicableProductIds = ['product-c']; }],
    ['missing coupon rows', order => { order.appliedCoupons = []; }],
  ])('fails closed when reserved coupon %s is corrupt', (_label, mutate) => {
    const corrupt = {
      currency: 'USD',
      couponUsageVersion: 1,
      orderItems: [
        { productId: 'product-a', seller: 'seller-a', price: 10, lineSubtotal: 10, quantity: 1 },
        { productId: 'product-b', seller: 'seller-b', price: 20, lineSubtotal: 20, quantity: 1 },
      ],
      appliedCoupons: [
        {
          couponId: 'coupon-a',
          seller: 'seller-a',
          discountType: 'fixed',
          currency: 'USD',
          appliedDiscountAmount: 4,
          applicableProductIds: ['product-a'],
        },
        {
          couponId: 'coupon-b',
          seller: 'seller-b',
          discountType: 'percentage',
          currency: 'USD',
          appliedDiscountAmount: 6,
          applicableProductIds: ['product-b'],
        },
      ],
      orderSummary: {
        subtotal: 30,
        shippingCost: 5,
        tax: 2,
        couponDiscount: 10,
        totalAmount: 27,
      },
    };
    mutate(corrupt);
    expect(() => getExpectedStripeTotalMinor(corrupt)).toThrow(expect.objectContaining({
      code: expect.stringMatching(/^ORDER_(?:COUPON_ALLOCATION_INVALID|TOTAL_MISMATCH)$/),
    }));
  });

  test('accepts an exact paid session for its order', () => {
    expect(validateStripeOrderSession(order, session(), { requirePaid: true })).toBe(true);
  });

  test.each([
    [{ id: 'cs_other' }, 'PAYMENT_SESSION_MISMATCH'],
    [{ metadata: { orderId: 'ORD-OTHER' } }, 'PAYMENT_ORDER_MISMATCH'],
    [{ currency: 'usd' }, 'PAYMENT_CURRENCY_MISMATCH'],
    [{ amount_total: 1 }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ amount_total: String(getExpectedStripeTotalMinor(order)) }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ payment_intent: null }, 'PAYMENT_INTENT_MISMATCH'],
    [{ payment_status: 'unpaid' }, 'PAYMENT_NOT_CONFIRMED'],
    [{ mode: undefined }, 'PAYMENT_SESSION_MODE_MISMATCH'],
    [{ metadata: { orderId: 123 } }, 'PAYMENT_ORDER_MISMATCH'],
  ])('rejects mismatched or unconfirmed session data', (override, code) => {
    expect(() => validateStripeOrderSession(order, session(override), { requirePaid: true }))
      .toThrow(expect.objectContaining({ code }));
  });

  test('requires exact mode metadata and livemode on a durable hosted session', () => {
    const durableOrder = {
      ...order,
      _id: '507f1f77bcf86cd799439099',
      user: '507f1f77bcf86cd799439098',
      stripeMode: 'test',
    };
    const durableSession = {
      ...session(),
      livemode: false,
      metadata: {
        type: 'order_payment',
        paymentFlow: 'checkout_session',
        orderId: durableOrder.orderId,
        mongoOrderId: durableOrder._id,
        userId: durableOrder.user,
        amountMinor: String(getExpectedStripeTotalMinor(durableOrder)),
        currency: durableOrder.currency,
        stripeMode: 'test',
      },
    };

    expect(validateStripeOrderSession(durableOrder, durableSession, { requirePaid: true })).toBe(true);
    expect(() => validateStripeOrderSession(durableOrder, {
      ...durableSession,
      livemode: undefined,
    }, { requirePaid: true })).toThrow(expect.objectContaining({ code: 'PAYMENT_MODE_MISMATCH' }));
    expect(() => validateStripeOrderSession(durableOrder, {
      ...durableSession,
      metadata: { ...durableSession.metadata, mongoOrderId: 507 },
    }, { requirePaid: true })).toThrow(expect.objectContaining({ code: 'PAYMENT_MODE_MISMATCH' }));
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
    [{ amount: String(getExpectedStripeTotalMinor(nativeOrder)) }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ metadata: { ...paymentIntent().metadata, amountMinor: '0258575' } }, 'PAYMENT_AMOUNT_MISMATCH'],
    [{ amount_received: String(getExpectedStripeTotalMinor(nativeOrder)) }, 'PAYMENT_NOT_CONFIRMED'],
    [{ currency: 'usd' }, 'PAYMENT_CURRENCY_MISMATCH'],
    [{ livemode: true }, 'PAYMENT_MODE_MISMATCH'],
    [{ livemode: undefined }, 'PAYMENT_MODE_MISMATCH'],
    [{ metadata: { ...paymentIntent().metadata, userId: 123 } }, 'PAYMENT_USER_MISMATCH'],
    [{ status: 'requires_payment_method' }, 'PAYMENT_NOT_CONFIRMED'],
  ])('rejects invalid native PaymentIntent ownership or capture data', (override, code) => {
    expect(() => validateStripeOrderPaymentIntent(nativeOrder, paymentIntent(override), {
      requireSucceeded: true,
    })).toThrow(expect.objectContaining({ code }));
  });
});
