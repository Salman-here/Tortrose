const mockRetrieveSetupIntent = jest.fn();
const mockCancelSetupIntent = jest.fn();
const mockCreateSetupIntent = jest.fn();
const mockEnsureStripeCustomerForUser = jest.fn();
const mockCreateMobileCustomerAccess = jest.fn();

jest.mock('../../config/stripe', () => ({
  stripe: {
    setupIntents: {
      create: mockCreateSetupIntent,
      retrieve: mockRetrieveSetupIntent,
      cancel: mockCancelSetupIntent,
    },
  },
  STRIPE_MODE: 'test',
}));

jest.mock('../../models/SellerSubscription', () => ({
  findOne: jest.fn(),
}));

jest.mock('../../services/stripeCustomerService', () => ({
  ensureStripeCustomerForUser: mockEnsureStripeCustomerForUser,
  createMobileCustomerAccess: mockCreateMobileCustomerAccess,
  getStripeMobileConfig: jest.fn(),
  sanitizePaymentMethod: jest.fn(),
  verifyPaymentMethodOwnership: jest.fn(),
  PAYMENT_METHOD_FILTERS: ['always'],
  SAVED_CARD_CONSENT_VERSION: '2026-08-01',
  selectRedisplayableReplacement: jest.fn(),
  stripeError: (message, code, statusCode = 400) => Object.assign(new Error(message), {
    code,
    statusCode,
  }),
}));

const { cancelSetup, createSetup } = require('../../controllers/paymentMethodController');

const ownedSetupIntent = (overrides = {}) => {
  const { metadata = {}, ...intentOverrides } = overrides;
  return {
    id: 'seti_123ABC',
    status: 'requires_payment_method',
    customer: 'cus_123',
    cancellation_reason: null,
    metadata: {
      type: 'saved_payment_method_setup',
      userId: 'user_123',
      stripeMode: 'test',
      ...metadata,
    },
    ...intentOverrides,
  };
};

const makeRequest = (overrides = {}) => ({
  params: { setupIntentId: 'seti_123ABC' },
  body: {},
  user: { id: 'user_123' },
  ...overrides,
});

const makeResponse = () => {
  const res = {};
  res.set = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('saved-card SetupIntent cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureStripeCustomerForUser.mockResolvedValue({ customer: { id: 'cus_123' } });
    mockCreateMobileCustomerAccess.mockResolvedValue({
      customerAccessMode: 'customer_session',
      customerSessionClientSecret: 'cuss_secret_123',
    });
  });

  test('rejects an invalid SetupIntent reference before contacting Stripe', async () => {
    const req = makeRequest({ params: { setupIntentId: 'pi_not_a_setup_intent' } });
    const res = makeResponse();

    await cancelSetup(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SETUP_INTENT_INVALID' }));
    expect(mockEnsureStripeCustomerForUser).not.toHaveBeenCalled();
    expect(mockRetrieveSetupIntent).not.toHaveBeenCalled();
  });

  test('returns a non-probing 404 when Stripe cannot find the SetupIntent', async () => {
    mockRetrieveSetupIntent.mockRejectedValue(Object.assign(new Error('No such setup_intent'), {
      code: 'resource_missing',
      statusCode: 404,
    }));
    const res = makeResponse();

    await cancelSetup(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SETUP_INTENT_NOT_FOUND' }));
    expect(mockCancelSetupIntent).not.toHaveBeenCalled();
  });

  test.each([
    ['another Stripe customer', { customer: 'cus_other' }],
    ['another Rozare user', { metadata: { userId: 'user_other' } }],
    ['another Stripe mode', { metadata: { stripeMode: 'live' } }],
    ['an unrelated SetupIntent type', { metadata: { type: 'subscription_setup' } }],
  ])('does not expose or cancel an intent belonging to %s', async (_label, overrides) => {
    mockRetrieveSetupIntent.mockResolvedValue(ownedSetupIntent(overrides));
    const res = makeResponse();

    await cancelSetup(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SETUP_INTENT_NOT_FOUND' }));
    expect(mockCancelSetupIntent).not.toHaveBeenCalled();
  });

  test('returns success without another Stripe mutation when already cancelled', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(ownedSetupIntent({
      status: 'canceled',
      cancellation_reason: 'abandoned',
    }));
    const res = makeResponse();

    await cancelSetup(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      cancelled: true,
      alreadyCancelled: true,
      setupIntentId: 'seti_123ABC',
      status: 'canceled',
    }));
    expect(mockCancelSetupIntent).not.toHaveBeenCalled();
  });

  test('rejects a SetupIntent that already succeeded', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(ownedSetupIntent({ status: 'succeeded' }));
    const res = makeResponse();

    await cancelSetup(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SETUP_INTENT_ALREADY_SUCCEEDED' }));
    expect(mockCancelSetupIntent).not.toHaveBeenCalled();
  });

  test('rejects a non-cancellable incomplete Stripe status', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(ownedSetupIntent({ status: 'processing' }));
    const res = makeResponse();

    await cancelSetup(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SETUP_INTENT_NOT_CANCELLABLE',
      status: 'processing',
    }));
    expect(mockCancelSetupIntent).not.toHaveBeenCalled();
  });

  test('uses requested_by_customer for an explicit PaymentSheet close', async () => {
    const setupIntent = ownedSetupIntent({ customer: { id: 'cus_123' } });
    mockRetrieveSetupIntent.mockResolvedValue(setupIntent);
    mockCancelSetupIntent.mockResolvedValue({
      ...setupIntent,
      status: 'canceled',
      cancellation_reason: 'requested_by_customer',
    });
    const req = makeRequest({ body: { closeReason: 'buyer_cancelled_payment_sheet' } });
    const res = makeResponse();

    await cancelSetup(req, res);

    expect(mockCancelSetupIntent).toHaveBeenCalledWith(
      'seti_123ABC',
      { cancellation_reason: 'requested_by_customer' },
      { idempotencyKey: 'rozare-setup-cancel:test:seti_123ABC' },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyCancelled: false,
      cancellationReason: 'requested_by_customer',
    }));
  });

  test.each(['requires_payment_method', 'requires_confirmation', 'requires_action'])(
    'cancels %s as abandoned after a PaymentSheet failure',
    async (status) => {
      const setupIntent = ownedSetupIntent({ status });
      mockRetrieveSetupIntent.mockResolvedValue(setupIntent);
      mockCancelSetupIntent.mockResolvedValue({
        ...setupIntent,
        status: 'canceled',
        cancellation_reason: 'abandoned',
      });
      const req = makeRequest({ body: { closeReason: 'payment_sheet_initialize' } });
      const res = makeResponse();

      await cancelSetup(req, res);

      expect(mockCancelSetupIntent).toHaveBeenCalledWith(
        'seti_123ABC',
        { cancellation_reason: 'abandoned' },
        { idempotencyKey: 'rozare-setup-cancel:test:seti_123ABC' },
      );
      expect(res.status).toHaveBeenCalledWith(200);
    },
  );

  test('treats an overlapping successful cancellation request as idempotent', async () => {
    const pending = ownedSetupIntent();
    const cancelled = ownedSetupIntent({
      status: 'canceled',
      cancellation_reason: 'abandoned',
    });
    mockRetrieveSetupIntent
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(cancelled);
    mockCancelSetupIntent.mockRejectedValue(new Error('SetupIntent cannot be cancelled'));
    const res = makeResponse();

    await cancelSetup(makeRequest(), res);

    expect(mockRetrieveSetupIntent).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      cancelled: true,
      alreadyCancelled: true,
    }));
  });

  test('cancels a newly created SetupIntent when CustomerSession preparation fails', async () => {
    const setupIntent = ownedSetupIntent({ client_secret: 'seti_123ABC_secret_value' });
    mockCreateSetupIntent.mockResolvedValue(setupIntent);
    mockCreateMobileCustomerAccess.mockRejectedValue(new Error('CustomerSession failed'));
    mockCancelSetupIntent.mockResolvedValue({
      ...setupIntent,
      status: 'canceled',
      cancellation_reason: 'abandoned',
    });
    const req = makeRequest({
      headers: { 'x-idempotency-key': 'setup-request-1' },
      body: {
        clientSurface: 'mobile',
        consentAccepted: true,
        consentVersion: '2026-08-01',
        requestKey: 'setup-request-1',
      },
    });
    const res = makeResponse();

    await createSetup(req, res);

    expect(mockCancelSetupIntent).toHaveBeenCalledWith(
      'seti_123ABC',
      { cancellation_reason: 'abandoned' },
      { idempotencyKey: 'rozare-setup-access-failure:test:seti_123ABC' },
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PAYMENT_SHEET_PREPARATION_FAILED',
    }));
  });
});
