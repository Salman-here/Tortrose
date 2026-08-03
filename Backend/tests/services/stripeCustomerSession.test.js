const mockCreateCustomerSession = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    customerSessions: { create: mockCreateCustomerSession },
  },
  STRIPE_MODE: 'test',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
  STRIPE_MERCHANT_COUNTRY_CODE: 'PK',
  STRIPE_MERCHANT_DISPLAY_NAME: 'Rozare',
}));

const {
  createMobileCustomerSession,
  PAYMENT_METHOD_FILTERS,
  selectRedisplayableReplacement,
} = require('../../services/stripeCustomerService');

describe('Stripe mobile CustomerSession', () => {
  beforeEach(() => {
    mockCreateCustomerSession.mockReset();
    mockCreateCustomerSession.mockResolvedValue({ id: 'css_123', client_secret: 'cuss_secret_123' });
  });

  test('uses a single PaymentSheet component with explicit opt-in and protected removal', async () => {
    await createMobileCustomerSession('cus_123');

    expect(PAYMENT_METHOD_FILTERS).toEqual(['always']);
    expect(mockCreateCustomerSession).toHaveBeenCalledWith({
      customer: 'cus_123',
      components: {
        mobile_payment_element: {
          enabled: true,
          features: {
            payment_method_save: 'enabled',
            payment_method_redisplay: 'enabled',
            payment_method_remove: 'disabled',
            payment_method_allow_redisplay_filters: ['always'],
          },
        },
      },
    });
  });

  test('never falls back to legacy unspecified cards when replacing a deleted default', () => {
    const methods = [
      { id: 'pm_removed', allow_redisplay: 'always' },
      { id: 'pm_legacy', allow_redisplay: 'unspecified' },
      { id: 'pm_saved', allow_redisplay: 'always' },
    ];
    expect(selectRedisplayableReplacement(methods, 'pm_removed')).toEqual(methods[2]);
    expect(selectRedisplayableReplacement(methods.slice(0, 2), 'pm_removed')).toBeNull();
  });
});
