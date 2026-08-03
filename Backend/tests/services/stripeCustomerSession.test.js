const mockCreateCustomerSession = jest.fn();
const mockCreateEphemeralKey = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    customerSessions: { create: mockCreateCustomerSession },
    ephemeralKeys: { create: mockCreateEphemeralKey },
  },
  STRIPE_MODE: 'test',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
  STRIPE_MERCHANT_COUNTRY_CODE: 'PK',
  STRIPE_MERCHANT_DISPLAY_NAME: 'Rozare',
  STRIPE_GOOGLE_PAY_ENABLED: false,
  STRIPE_CUSTOMER_SESSION_ENABLED: false,
  STRIPE_API_VERSION: '2025-08-27.basil',
}));

const {
  createMobileCustomerAccess,
  createMobileCustomerSession,
  PAYMENT_METHOD_FILTERS,
  selectRedisplayableReplacement,
} = require('../../services/stripeCustomerService');

describe('Stripe mobile CustomerSession', () => {
  beforeEach(() => {
    mockCreateCustomerSession.mockReset();
    mockCreateEphemeralKey.mockReset();
    mockCreateCustomerSession.mockResolvedValue({ id: 'css_123', client_secret: 'cuss_secret_123' });
    mockCreateEphemeralKey.mockResolvedValue({ id: 'ephkey_123', secret: 'ek_test_secret_123' });
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

  test('uses ephemeral keys as the default mobile PaymentSheet customer access path', async () => {
    await expect(createMobileCustomerAccess('cus_123')).resolves.toEqual({
      customerAccessMode: 'ephemeral_key',
      customerEphemeralKeySecret: 'ek_test_secret_123',
    });
    expect(mockCreateEphemeralKey).toHaveBeenCalledWith(
      { customer: 'cus_123' },
      { apiVersion: '2025-08-27.basil' },
    );
    expect(mockCreateCustomerSession).not.toHaveBeenCalled();
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
