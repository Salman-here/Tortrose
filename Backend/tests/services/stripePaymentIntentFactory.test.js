const {
  buildCustomerInitiatedPaymentIntentParams,
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
});
