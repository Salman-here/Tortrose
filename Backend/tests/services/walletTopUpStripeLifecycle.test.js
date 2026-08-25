'use strict';

const mockPaymentIntentCreate = jest.fn();
const mockPaymentIntentRetrieve = jest.fn();
const mockCheckoutSessionCreate = jest.fn();
const mockCheckoutSessionRetrieve = jest.fn();

jest.mock('../../config/stripe', () => ({
  STRIPE_MODE: 'test',
  stripe: {
    paymentIntents: {
      create: mockPaymentIntentCreate,
      retrieve: mockPaymentIntentRetrieve,
    },
    checkout: {
      sessions: {
        create: mockCheckoutSessionCreate,
        retrieve: mockCheckoutSessionRetrieve,
      },
    },
  },
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const {
  attachStripeWalletTopUpReference,
  cancelWalletTopUpFromPaymentIntent,
  claimWalletTopUpSetup,
  closeWalletTopUpWithoutStripeReference,
  completeWalletTopUp,
  completeWalletTopUpFromPaymentIntent,
  failWalletTopUp,
  recordWalletTopUpPaymentFailure,
  recoverWalletTopUpStripeSetup,
} = require('../../services/walletService');

jest.setTimeout(60000);

const unique = (() => {
  let value = 0;
  return (prefix) => `${prefix}_${++value}`;
})();

const createTopUp = async (paymentFlow, overrides = {}) => {
  const user = overrides.user || new mongoose.Types.ObjectId();
  const referenceId = unique('request');
  return WalletTransaction.create({
    user,
    type: 'top_up',
    direction: 'credit',
    status: 'pending',
    amount: 10.25,
    currency: 'USD',
    description: 'Rozare Wallet top-up of $10.25 USD',
    referenceType: paymentFlow === 'payment_sheet' ? 'stripe_payment_intent' : 'stripe_checkout',
    referenceId,
    idempotencyKey: unique('wallet-topup'),
    stripeCustomerId: 'cus_wallet_lifecycle',
    stripeMode: 'test',
    paymentFlow,
    paymentSetupState: 'creating',
    paymentSetupStartedAt: new Date(),
    clientSurface: paymentFlow === 'payment_sheet' ? 'mobile' : 'web',
    paymentExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    metadata: { receiptEmail: 'buyer@example.com' },
    ...overrides,
    user,
  });
};

const paymentIntentFor = (transaction, overrides = {}) => ({
  id: unique('pi_wallet'),
  status: 'requires_payment_method',
  client_secret: 'pi_secret',
  customer: transaction.stripeCustomerId,
  amount: Math.round(Number(transaction.amount) * 100),
  amount_received: 0,
  currency: transaction.currency.toLowerCase(),
  livemode: false,
  metadata: {
    type: 'wallet_top_up',
    paymentFlow: 'payment_sheet',
    walletTransactionId: String(transaction._id),
    userId: String(transaction.user),
    amountMinor: String(Math.round(Number(transaction.amount) * 100)),
    currency: transaction.currency,
    stripeMode: 'test',
  },
  ...overrides,
});

const checkoutSessionFor = (transaction, overrides = {}) => ({
  id: unique('cs_wallet'),
  mode: 'payment',
  status: 'open',
  payment_status: 'unpaid',
  url: 'https://checkout.stripe.test/session',
  customer: transaction.stripeCustomerId,
  amount_total: Math.round(Number(transaction.amount) * 100),
  currency: transaction.currency.toLowerCase(),
  livemode: false,
  metadata: {
    type: 'wallet_top_up',
    paymentFlow: 'checkout_session',
    walletTransactionId: String(transaction._id),
    userId: String(transaction.user),
    stripeMode: 'test',
  },
  ...overrides,
});

describe('Wallet top-up durable Stripe setup lifecycle', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    await Promise.all([Wallet.init(), WalletTransaction.init()]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all([Wallet.deleteMany({}), WalletTransaction.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  test.each([
    ['PaymentSheet', 'payment_sheet', 'stripePaymentIntentId'],
    ['hosted Checkout', 'checkout_session', 'stripeSessionId'],
  ])('recovers %s when Stripe creation returned but DB reference attachment failed', async (
    _label,
    paymentFlow,
    referenceField,
  ) => {
    const transaction = await createTopUp(paymentFlow);
    const stripeObject = paymentFlow === 'payment_sheet'
      ? paymentIntentFor(transaction)
      : checkoutSessionFor(transaction);
    const createMock = paymentFlow === 'payment_sheet'
      ? mockPaymentIntentCreate
      : mockCheckoutSessionCreate;
    createMock.mockResolvedValue(stripeObject);

    const originalFindOneAndUpdate = WalletTransaction.findOneAndUpdate.bind(WalletTransaction);
    let rejectAttachmentOnce = true;
    jest.spyOn(WalletTransaction, 'findOneAndUpdate').mockImplementation((filter, update, options) => {
      if (rejectAttachmentOnce && update?.$set?.[referenceField]) {
        rejectAttachmentOnce = false;
        throw new Error('simulated DB attachment outage');
      }
      return originalFindOneAndUpdate(filter, update, options);
    });

    await expect(recoverWalletTopUpStripeSetup(transaction)).rejects.toThrow('simulated DB attachment outage');
    let stored = await WalletTransaction.findById(transaction._id);
    expect(stored.paymentSetupState).toBe('creating');
    expect(stored[referenceField]).toBeNull();

    const recovered = await recoverWalletTopUpStripeSetup(stored);
    stored = await WalletTransaction.findById(transaction._id);
    expect(recovered.stripeObject.id).toBe(stripeObject.id);
    expect(stored[referenceField]).toBe(stripeObject.id);
    expect(stored.paymentSetupState).toBe('ready');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][1]).toEqual(createMock.mock.calls[1][1]);
    expect(createMock.mock.calls[0][1].idempotencyKey).toContain(String(transaction._id));
    if (paymentFlow === 'checkout_session') {
      const params = createMock.mock.calls[0][0];
      expect(params.payment_intent_data?.metadata).toEqual(params.metadata);
      expect(params.metadata).toMatchObject({
        type: 'wallet_top_up',
        walletTransactionId: String(transaction._id),
        amountMinor: '1025',
        currency: 'USD',
      });
    }
  });

  test('schema rejects ready setup state without its flow-specific Stripe reference', async () => {
    await expect(createTopUp('payment_sheet', {
      paymentSetupState: 'ready',
      stripePaymentIntentId: null,
    })).rejects.toThrow('A ready Wallet top-up requires its Stripe reference.');
  });

  test('schema rejects mixed external references before hosted settlement', async () => {
    await expect(createTopUp('checkout_session', {
      paymentSetupState: 'ready',
      stripeSessionId: 'cs_mixed_reference',
      stripePaymentIntentId: 'pi_mixed_reference',
    })).rejects.toThrow('cannot reference both');
  });

  test('hosted recovery stays explicitly card-only and immutable in amount/currency/customer', async () => {
    const transaction = await createTopUp('checkout_session');
    const session = checkoutSessionFor(transaction);
    mockCheckoutSessionCreate.mockResolvedValue(session);

    await recoverWalletTopUpStripeSetup(transaction);

    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        payment_method_types: ['card'],
        customer: transaction.stripeCustomerId,
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({ currency: 'usd', unit_amount: 1025 }),
        })],
        metadata: expect.objectContaining({
          walletTransactionId: String(transaction._id),
          userId: String(transaction.user),
        }),
      }),
      { idempotencyKey: `wallet-topup-checkout:test:${transaction._id}` },
    );
  });

  test.each(['USD', 'PKR', 'EUR', 'GBP'])(
    'creates an exact two-decimal %s PaymentIntent without cross-currency conversion',
    async (currency) => {
      const transaction = await createTopUp('payment_sheet', { amount: 123.45, currency });
      const paymentIntent = paymentIntentFor(transaction);
      mockPaymentIntentCreate.mockResolvedValue(paymentIntent);

      await recoverWalletTopUpStripeSetup(transaction);

      expect(mockPaymentIntentCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 12345,
          currency: currency.toLowerCase(),
          metadata: expect.objectContaining({
            amountMinor: '12345',
            currency,
          }),
        }),
        { idempotencyKey: `wallet-topup-pi:test:${transaction._id}` },
      );
    },
  );

  test('keeps authentication and connection failures in creating state for deterministic replay', async () => {
    for (const type of ['StripeAuthenticationError', 'StripePermissionError', 'StripeConnectionError']) {
      const transaction = await createTopUp('payment_sheet');
      mockPaymentIntentCreate.mockRejectedValueOnce(Object.assign(new Error(type), { type }));

      await expect(recoverWalletTopUpStripeSetup(transaction)).rejects.toMatchObject({
        code: 'PAYMENT_ATTEMPT_RECOVERY_PENDING',
      });
      const stored = await WalletTransaction.findById(transaction._id);
      expect(stored.status).toBe('pending');
      expect(stored.paymentSetupState).toBe('creating');
      expect(stored.stripePaymentIntentId).toBeNull();
    }
  });

  test('closes only a same-request invalid response inside the conservative idempotency window', async () => {
    const transaction = await createTopUp('payment_sheet');
    const invalid = Object.assign(new Error('invalid amount'), { type: 'StripeInvalidRequestError' });
    mockPaymentIntentCreate.mockRejectedValue(invalid);

    await expect(recoverWalletTopUpStripeSetup(transaction)).rejects.toMatchObject({
      walletSetupDefinitivelyRejected: true,
    });
    const stored = await WalletTransaction.findById(transaction._id);
    expect(stored.status).toBe('failed');
    expect(stored.paymentSetupState).toBe('closed');
    expect(stored.stripePaymentIntentId).toBeNull();
  });

  test('never reuses a deterministic Stripe key after the conservative replay window', async () => {
    const transaction = await createTopUp('payment_sheet', {
      paymentSetupStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    await expect(recoverWalletTopUpStripeSetup(transaction)).rejects.toMatchObject({
      code: 'PAYMENT_SETUP_RECOVERY_REQUIRED',
    });
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    const stored = await WalletTransaction.findById(transaction._id);
    expect(stored.status).toBe('pending');
    expect(stored.paymentSetupState).toBe('creating');
  });

  test('attaches and settles a signed PaymentIntent success webhook that beats reference persistence exactly once', async () => {
    const transaction = await createTopUp('payment_sheet');
    const paymentIntent = paymentIntentFor(transaction, {
      status: 'succeeded',
      amount_received: 1025,
      latest_charge: 'ch_wallet_success',
    });

    const first = await completeWalletTopUpFromPaymentIntent(paymentIntent, 'evt_wallet_success_1');
    const second = await completeWalletTopUpFromPaymentIntent(paymentIntent, 'evt_wallet_success_2');
    const wallet = await Wallet.findOne({ user: transaction.user }).lean();
    const stored = await WalletTransaction.findById(transaction._id).lean();

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(wallet.balances.USD).toBe(10.25);
    expect(stored.stripePaymentIntentId).toBe(paymentIntent.id);
    expect(stored.paymentSetupState).toBe('complete');
  });

  test('attaches and settles a signed hosted Checkout success webhook before reference persistence exactly once', async () => {
    const transaction = await createTopUp('checkout_session');
    const session = checkoutSessionFor(transaction, {
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_hosted_underlying',
    });

    await completeWalletTopUp(session, 'evt_checkout_paid_1');
    await completeWalletTopUp(session, 'evt_checkout_paid_2');
    const wallet = await Wallet.findOne({ user: transaction.user }).lean();
    const stored = await WalletTransaction.findById(transaction._id).lean();

    expect(wallet.balances.USD).toBe(10.25);
    expect(stored.stripeSessionId).toBe(session.id);
    expect(stored.stripePaymentIntentId).toBe('pi_hosted_underlying');
    expect(stored.paymentSetupState).toBe('complete');
  });

  test('attaches failed and cancelled PaymentIntent webhooks without crediting Wallet balance', async () => {
    const failedTransaction = await createTopUp('payment_sheet');
    const failedIntent = paymentIntentFor(failedTransaction, {
      status: 'requires_payment_method',
      last_payment_error: { message: 'Card declined' },
    });
    const failed = await recordWalletTopUpPaymentFailure(failedIntent, 'evt_wallet_failed');
    expect(failed.status).toBe('pending');
    expect(failed.paymentSetupState).toBe('ready');
    expect(failed.failureReason).toBe('Card declined');

    const cancelledTransaction = await createTopUp('payment_sheet');
    const cancelledIntent = paymentIntentFor(cancelledTransaction, { status: 'canceled' });
    const cancelled = await cancelWalletTopUpFromPaymentIntent(cancelledIntent, {
      eventId: 'evt_wallet_cancelled',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.paymentSetupState).toBe('closed');
    expect(await Wallet.countDocuments({ user: { $in: [failedTransaction.user, cancelledTransaction.user] } })).toBe(0);
  });

  test('attaches an expired hosted webhook before closing and never credits the Wallet', async () => {
    const transaction = await createTopUp('checkout_session');
    const session = checkoutSessionFor(transaction, { status: 'expired' });

    const closed = await failWalletTopUp(session, 'Hosted checkout expired.', 'evt_checkout_expired');
    expect(closed.status).toBe('expired');
    expect(closed.paymentSetupState).toBe('closed');
    expect(closed.stripeSessionId).toBe(session.id);
    expect(closed.stripeWebhookEventId).toBe('evt_checkout_expired');
    expect(await Wallet.countDocuments({ user: transaction.user })).toBe(0);
  });

  test('creator and no-reference cancellation use one atomic state winner', async () => {
    for (let index = 0; index < 8; index += 1) {
      const transaction = await createTopUp('payment_sheet', {
        paymentSetupState: 'not_started',
        paymentSetupStartedAt: null,
      });
      await Promise.allSettled([
        claimWalletTopUpSetup(transaction),
        closeWalletTopUpWithoutStripeReference(transaction, {
          status: 'cancelled',
          reason: 'Buyer cancelled before PaymentSheet opened.',
        }),
      ]);
      const stored = await WalletTransaction.findById(transaction._id).lean();
      expect([
        'pending:creating',
        'cancelled:closed',
      ]).toContain(`${stored.status}:${stored.paymentSetupState}`);
      expect(stored.stripePaymentIntentId).toBeNull();
    }
  });

  test('a signed cancellation webhook can attach and close while the creator response is still in flight', async () => {
    const transaction = await createTopUp('payment_sheet');
    const paymentIntent = paymentIntentFor(transaction, { status: 'canceled' });
    let releaseCreate;
    mockPaymentIntentCreate.mockReturnValue(new Promise(resolve => { releaseCreate = resolve; }));

    const creator = recoverWalletTopUpStripeSetup(transaction);
    while (mockPaymentIntentCreate.mock.calls.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const webhook = await cancelWalletTopUpFromPaymentIntent(paymentIntent, {
      eventId: 'evt_cancel_won_race',
    });
    releaseCreate(paymentIntent);
    const recovered = await creator;
    const stored = await WalletTransaction.findById(transaction._id).lean();

    expect(webhook.status).toBe('cancelled');
    expect(recovered.transaction.status).toBe('cancelled');
    expect(stored.stripePaymentIntentId).toBe(paymentIntent.id);
    expect(stored.paymentSetupState).toBe('closed');
  });

  test('a signed hosted-expiry webhook can attach and close while the creator response is still in flight', async () => {
    const transaction = await createTopUp('checkout_session');
    const session = checkoutSessionFor(transaction, { status: 'expired' });
    let releaseCreate;
    mockCheckoutSessionCreate.mockReturnValue(new Promise(resolve => { releaseCreate = resolve; }));

    const creator = recoverWalletTopUpStripeSetup(transaction);
    while (mockCheckoutSessionCreate.mock.calls.length === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const expiry = await failWalletTopUp(
      session,
      'Stripe confirmed hosted expiry.',
      'evt_expiry_won_race',
    );
    releaseCreate(session);
    const recovered = await creator;
    const stored = await WalletTransaction.findById(transaction._id).lean();

    expect(expiry.status).toBe('expired');
    expect(recovered.transaction.status).toBe('expired');
    expect(stored.stripeSessionId).toBe(session.id);
    expect(stored.paymentSetupState).toBe('closed');
    expect(await Wallet.countDocuments({ user: transaction.user })).toBe(0);
  });

  test('rejects a conflicting Stripe object after one validated reference wins attachment', async () => {
    const transaction = await createTopUp('payment_sheet');
    const firstIntent = paymentIntentFor(transaction);
    const secondIntent = paymentIntentFor(transaction);
    await attachStripeWalletTopUpReference({
      transaction,
      stripeObject: firstIntent,
      paymentFlow: 'payment_sheet',
    });

    await expect(attachStripeWalletTopUpReference({
      transaction,
      stripeObject: secondIntent,
      paymentFlow: 'payment_sheet',
    })).rejects.toMatchObject({ code: 'PAYMENT_SETUP_RECOVERY_REQUIRED' });
    const stored = await WalletTransaction.findById(transaction._id).lean();
    expect(stored.stripePaymentIntentId).toBe(firstIntent.id);
  });
});
