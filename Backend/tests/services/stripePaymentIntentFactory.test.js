const {
  STRIPE_MAX_CHARGE_AMOUNT_MINOR,
  buildCustomerInitiatedPaymentIntentParams,
  isDefinitiveStripeCreationError,
  isAuthoritativeStripeIdempotentReplayRejection,
} = require('../../services/stripePaymentIntentFactory');

describe('native Stripe PaymentIntent creation', () => {
  test('does not auto-save a card without the PaymentSheet opt-in', () => {
    const params = buildCustomerInitiatedPaymentIntentParams({
      amountMinor: 2599,
      currency: 'PKR',
      customerId: 'cus_test_123',
      receiptEmail: 'buyer@example.com',
      metadata: { type: 'order_payment' },
    });

    expect(params).toMatchObject({
      amount: 2599,
      currency: 'pkr',
      customer: 'cus_test_123',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });
    expect(params).not.toHaveProperty('setup_future_usage');
    expect(params).not.toHaveProperty('payment_method');
  });

  test.each(['USD', 'PKR', 'EUR', 'GBP'])(
    'accepts the exact documented eight-digit %s ceiling in minor units',
    currency => {
      expect(buildCustomerInitiatedPaymentIntentParams({
        amountMinor: STRIPE_MAX_CHARGE_AMOUNT_MINOR,
        currency,
        customerId: 'cus_test_123',
        metadata: { type: 'order_payment' },
      })).toMatchObject({
        amount: 99_999_999,
        currency: currency.toLowerCase(),
      });
    },
  );

  test('allows a one-minor-unit positive request so the account-specific minimum remains provider-authoritative', () => {
    expect(buildCustomerInitiatedPaymentIntentParams({
      amountMinor: 1,
      currency: 'PKR',
      customerId: 'cus_test_123',
      metadata: { type: 'order_payment' },
    }).amount).toBe(1);
  });

  test.each([
    ['amount', { amountMinor: '2599' }],
    ['amount', { amountMinor: 0 }],
    ['amount', { amountMinor: STRIPE_MAX_CHARGE_AMOUNT_MINOR + 1 }],
    ['amount', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ['currency', { currency: 'pkr' }],
    ['currency', { currency: 'CAD' }],
    ['customer', { customerId: '' }],
    ['metadata', { metadata: null }],
  ])('rejects malformed authoritative %s input before calling Stripe', (_label, override) => {
    expect(() => buildCustomerInitiatedPaymentIntentParams({
      amountMinor: 2599,
      currency: 'PKR',
      customerId: 'cus_test_123',
      metadata: { type: 'order_payment' },
      ...override,
    })).toThrow(expect.objectContaining({ code: 'STRIPE_PAYMENT_INTENT_PARAMS_INVALID' }));
  });
});

describe('Stripe deterministic replay rejection authority', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  test('accepts only a recent InvalidRequest response inside the guaranteed key-retention window', () => {
    expect(isAuthoritativeStripeIdempotentReplayRejection(
      { type: 'StripeInvalidRequestError' },
      { createdAt: new Date(now.getTime() - (60 * 60 * 1000)), now },
    )).toBe(true);
  });

  test.each([
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeAPIError',
    'StripeConnectionError',
    'StripeIdempotencyError',
  ])('keeps recovery fail-closed for %s', type => {
    expect(isAuthoritativeStripeIdempotentReplayRejection(
      { type },
      { createdAt: new Date(now.getTime() - (60 * 60 * 1000)), now },
    )).toBe(false);
  });

  test('does not trust an InvalidRequest response after the safe retention window', () => {
    expect(isAuthoritativeStripeIdempotentReplayRejection(
      { type: 'StripeInvalidRequestError' },
      { createdAt: new Date(now.getTime() - (24 * 60 * 60 * 1000)), now },
    )).toBe(false);
  });
});

describe('fresh Stripe creation error authority', () => {
  test.each([
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
  ])('treats explicit pre-mutation %s as definitive for the sole fresh creator', type => {
    expect(isDefinitiveStripeCreationError({ type })).toBe(true);
  });

  test.each([
    ['StripeRateLimitError', 429],
    ['StripeIdempotencyError', 409],
    ['StripeAPIError', 500],
    ['StripeConnectionError', undefined],
    ['StripeError', 424],
  ])('keeps %s unresolved instead of trusting its HTTP status', (type, statusCode) => {
    expect(isDefinitiveStripeCreationError({ type, statusCode })).toBe(false);
  });
});
