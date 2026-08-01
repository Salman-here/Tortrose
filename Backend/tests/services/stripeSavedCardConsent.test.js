const mockCustomerRetrieve = jest.fn();
const mockPaymentMethodRetrieve = jest.fn();
const mockPaymentMethodUpdate = jest.fn();
const mockUserFindById = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    customers: {
      retrieve: mockCustomerRetrieve,
      update: jest.fn(),
    },
    paymentMethods: {
      retrieve: mockPaymentMethodRetrieve,
      update: mockPaymentMethodUpdate,
    },
  },
  STRIPE_MODE: 'test',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
  STRIPE_MERCHANT_COUNTRY_CODE: 'PK',
  STRIPE_MERCHANT_DISPLAY_NAME: 'Rozare',
}));

jest.mock('../../models/User', () => ({
  findById: mockUserFindById,
  updateOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../models/SellerSubscription', () => ({
  findOne: jest.fn(),
}));

const {
  finalizeSavedPaymentMethodSetup,
  SAVED_CARD_CONSENT_VERSION,
} = require('../../services/stripeCustomerService');

const setupIntent = (overrides = {}) => ({
  id: 'seti_123',
  status: 'succeeded',
  livemode: false,
  customer: 'cus_123',
  payment_method: 'pm_123',
  metadata: {
    type: 'saved_payment_method_setup',
    consent: 'customer_initiated_on_session',
    consentAccepted: 'true',
    consentVersion: SAVED_CARD_CONSENT_VERSION,
    stripeMode: 'test',
    userId: 'user_123',
  },
  ...overrides,
});

describe('saved-card SetupIntent consent finalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserFindById.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        _id: 'user_123',
        username: 'Buyer',
        email: 'buyer@example.com',
        status: 'active',
        stripeCustomers: { test: 'cus_123' },
      }),
    });
    mockCustomerRetrieve.mockResolvedValue({
      id: 'cus_123',
      email: 'buyer@example.com',
      name: 'Buyer',
      metadata: {
        rozareUserId: 'user_123',
        customerScope: 'rozare_buyer_commerce',
        stripeMode: 'test',
      },
    });
    mockPaymentMethodRetrieve.mockResolvedValue({
      id: 'pm_123',
      customer: 'cus_123',
      allow_redisplay: 'unspecified',
    });
    mockPaymentMethodUpdate.mockResolvedValue({
      id: 'pm_123',
      customer: 'cus_123',
      allow_redisplay: 'always',
    });
  });

  test('promotes only the explicitly consented SetupIntent card to always redisplay', async () => {
    const result = await finalizeSavedPaymentMethodSetup(setupIntent());

    expect(mockPaymentMethodUpdate).toHaveBeenCalledWith('pm_123', {
      allow_redisplay: 'always',
      metadata: {
        rozareSavedCardConsent: 'true',
        rozareSavedCardConsentVersion: SAVED_CARD_CONSENT_VERSION,
        rozareSavedCardSetupIntentId: 'seti_123',
      },
    });
    expect(result.allow_redisplay).toBe('always');
  });

  test('rejects a stale consent contract before touching the payment method', async () => {
    await expect(finalizeSavedPaymentMethodSetup(setupIntent({
      metadata: {
        ...setupIntent().metadata,
        consentVersion: 'legacy',
      },
    }))).rejects.toMatchObject({ code: 'SETUP_INTENT_METADATA_INVALID' });
    expect(mockPaymentMethodRetrieve).not.toHaveBeenCalled();
    expect(mockPaymentMethodUpdate).not.toHaveBeenCalled();
  });
});
