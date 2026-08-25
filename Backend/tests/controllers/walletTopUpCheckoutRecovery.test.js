'use strict';

const mockPaymentIntentCreate = jest.fn();
const mockPaymentIntentRetrieve = jest.fn();
const mockCheckoutSessionCreate = jest.fn();
const mockCheckoutSessionRetrieve = jest.fn();
const mockEnsureStripeCustomer = jest.fn();
const mockCreateMobileCustomerAccess = jest.fn();

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

jest.mock('../../services/stripeCustomerService', () => ({
  ensureStripeCustomerForUser: mockEnsureStripeCustomer,
  createMobileCustomerAccess: mockCreateMobileCustomerAccess,
  getStripeMobileConfig: () => ({ stripePublishableKey: 'pk_test_wallet' }),
}));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const Notification = require('../../models/Notification');
const NotificationOutbox = require('../../models/NotificationOutbox');
const {
  createTopUpCheckout,
  __private: { configuredWalletTopUpLimits },
} = require('../../controllers/walletController');

jest.setTimeout(60000);

const response = () => {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((body) => {
      res.body = body;
      return res;
    }),
    set: jest.fn((name, value) => {
      res.headers[name] = value;
      return res;
    }),
  };
  return res;
};

const request = ({ userId, requestKey, paymentFlow = 'payment_sheet', amount = 12.34 } = {}) => ({
  user: { id: String(userId), currency: 'USD' },
  body: {
    amount,
    currency: 'USD',
    paymentFlow,
    clientSurface: paymentFlow === 'payment_sheet' ? 'mobile' : 'web',
    requestKey,
  },
});

const buildIntent = (params) => ({
  id: `pi_${params.metadata.walletTransactionId}`,
  status: 'requires_payment_method',
  client_secret: 'pi_wallet_secret',
  customer: params.customer,
  amount: params.amount,
  amount_received: 0,
  currency: params.currency,
  livemode: false,
  metadata: params.metadata,
});

const buildSession = (params) => ({
  id: `cs_${params.metadata.walletTransactionId}`,
  mode: 'payment',
  status: 'open',
  payment_status: 'unpaid',
  url: 'https://checkout.stripe.test/wallet',
  customer: params.customer,
  amount_total: params.line_items[0].price_data.unit_amount,
  currency: params.line_items[0].price_data.currency,
  livemode: false,
  metadata: params.metadata,
});

describe('Wallet top-up configuration boundary', () => {
  test('uses safe defaults and cent-normalizes configured USD limits', () => {
    expect(configuredWalletTopUpLimits({})).toEqual({
      minimumUSD: 1,
      maximumUSD: 10000,
    });
    expect(configuredWalletTopUpLimits({
      WALLET_MIN_TOP_UP_USD: ' 2.345 ',
      WALLET_MAX_TOP_UP_USD: '999.999',
    })).toEqual({
      minimumUSD: 2.35,
      maximumUSD: 1000,
    });
  });

  test.each(['nope', 'NaN', 'Infinity', '0', '-1', ' '])(
    'rejects an unsafe minimum configuration value %p',
    value => {
      if (value === ' ') {
        expect(configuredWalletTopUpLimits({ WALLET_MIN_TOP_UP_USD: value })).toEqual({
          minimumUSD: 1,
          maximumUSD: 10000,
        });
        return;
      }
      expect(() => configuredWalletTopUpLimits({ WALLET_MIN_TOP_UP_USD: value }))
        .toThrow('WALLET_MIN_TOP_UP_USD must be a positive finite USD amount.');
    }
  );

  test('rejects a positive configured limit that rounds down to zero cents', () => {
    expect(() => configuredWalletTopUpLimits({ WALLET_MIN_TOP_UP_USD: '0.001' }))
      .toThrow('WALLET_MIN_TOP_UP_USD must be at least 0.01 USD after cent rounding.');
  });

  test('rejects a maximum below the configured minimum', () => {
    expect(() => configuredWalletTopUpLimits({
      WALLET_MIN_TOP_UP_USD: '10',
      WALLET_MAX_TOP_UP_USD: '9.99',
    })).toThrow(
      'WALLET_MAX_TOP_UP_USD must be greater than or equal to WALLET_MIN_TOP_UP_USD.'
    );
  });
});

describe('Wallet top-up controller deterministic recovery', () => {
  let replSet;
  let userId;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    await Promise.all([
      Wallet.init(),
      WalletTransaction.init(),
      Notification.init(),
      NotificationOutbox.init(),
    ]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    userId = new mongoose.Types.ObjectId();
    mockEnsureStripeCustomer.mockResolvedValue({
      customer: { id: 'cus_wallet_controller' },
      user: { email: 'buyer@example.com' },
    });
    mockCreateMobileCustomerAccess.mockResolvedValue({
      customerEphemeralKeySecret: 'eph_secret',
      customerSessionClientSecret: 'cuss_secret',
    });
    mockPaymentIntentCreate.mockImplementation(async params => buildIntent(params));
    mockCheckoutSessionCreate.mockImplementation(async params => buildSession(params));
  });

  afterEach(async () => {
    await Promise.all([
      Wallet.deleteMany({}),
      WalletTransaction.deleteMany({}),
      Notification.deleteMany({}),
      NotificationOutbox.deleteMany({}),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  test('requires a durable client request key for both PaymentSheet and hosted Checkout', async () => {
    for (const paymentFlow of ['payment_sheet', 'checkout_session']) {
      const res = response();
      await createTopUpCheckout(request({ userId, requestKey: '', paymentFlow }), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test.each([
    null,
    '',
    '   ',
    true,
    false,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    'NaN',
    'Infinity',
    {},
    [],
    'not-money',
    0,
    -1,
    '0.004',
    '-0.004',
  ])('rejects malformed raw top-up amount %# before coercion or Stripe setup', async (amount) => {
    const req = request({ userId, requestKey: 'invalid-raw-amount', amount });
    const res = response();

    await createTopUpCheckout(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('WALLET_TOP_UP_AMOUNT_INVALID');
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(mockEnsureStripeCustomer).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled();
  });

  test('maps unsafe money magnitude to a clear 400 instead of surfacing an internal error', async () => {
    const res = response();

    await createTopUpCheckout(request({
      userId,
      requestKey: 'unsafe-money-range',
      amount: Number.MAX_SAFE_INTEGER,
    }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('WALLET_TOP_UP_AMOUNT_OUT_OF_RANGE');
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(mockEnsureStripeCustomer).not.toHaveBeenCalled();
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
  });

  test('rounds a valid decimal string once at the cent boundary before fingerprinting and Stripe creation', async () => {
    const res = response();

    await createTopUpCheckout(request({
      userId,
      requestKey: 'cent-rounding-boundary',
      amount: '1.005',
    }), res);

    expect(res.statusCode).toBe(201);
    expect(mockPaymentIntentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 101 }),
      expect.any(Object),
    );
    const transaction = await WalletTransaction.findById(res.body.transactionId);
    expect(transaction.amount).toBe(1.01);
  });

  test('creates and replays one native top-up with the same Stripe object and response references', async () => {
    const first = response();
    await createTopUpCheckout(request({ userId, requestKey: 'native-replay-1' }), first);
    expect(first.statusCode).toBe(201);
    expect(first.body.paymentIntentId).toMatch(/^pi_/);
    const transaction = await WalletTransaction.findById(first.body.transactionId).lean();
    expect(transaction.paymentSetupState).toBe('ready');
    expect(transaction.stripePaymentIntentId).toBe(first.body.paymentIntentId);

    mockPaymentIntentRetrieve.mockResolvedValue(buildIntent(mockPaymentIntentCreate.mock.calls[0][0]));
    const replay = response();
    await createTopUpCheckout(request({ userId, requestKey: 'native-replay-1' }), replay);

    expect(replay.statusCode).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toEqual(first.body.transactionId);
    expect(replay.body.paymentIntentId).toBe(first.body.paymentIntentId);
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await WalletTransaction.countDocuments()).toBe(1);
  });

  test('creates and replays one card-only hosted top-up', async () => {
    const first = response();
    await createTopUpCheckout(request({
      userId,
      requestKey: 'hosted-replay-1',
      paymentFlow: 'checkout_session',
    }), first);
    expect(first.statusCode).toBe(201);
    const createdParams = mockCheckoutSessionCreate.mock.calls[0][0];
    expect(createdParams.payment_method_types).toEqual(['card']);

    mockCheckoutSessionRetrieve.mockResolvedValue(buildSession(createdParams));
    const replay = response();
    await createTopUpCheckout(request({
      userId,
      requestKey: 'hosted-replay-1',
      paymentFlow: 'checkout_session',
    }), replay);

    expect(replay.statusCode).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.transactionId).toEqual(first.body.transactionId);
    expect(mockCheckoutSessionCreate).toHaveBeenCalledTimes(1);
    expect(await WalletTransaction.countDocuments()).toBe(1);
  });

  test('serializes concurrent same-key creators into one local transaction and one external identity', async () => {
    const first = response();
    const second = response();
    await Promise.all([
      createTopUpCheckout(request({ userId, requestKey: 'native-concurrent-1' }), first),
      createTopUpCheckout(request({ userId, requestKey: 'native-concurrent-1' }), second),
    ]);

    expect([first.statusCode, second.statusCode].every(code => [200, 201].includes(code))).toBe(true);
    const transactions = await WalletTransaction.find({ user: userId }).lean();
    expect(transactions).toHaveLength(1);
    expect(transactions[0].paymentSetupState).toBe('ready');
    expect(new Set(mockPaymentIntentCreate.mock.calls.map(call => call[1].idempotencyKey)).size).toBe(1);
    expect(transactions[0].stripePaymentIntentId).toBe(`pi_${transactions[0]._id}`);
  });

  test('rejects reuse of a request key with a different monetary fingerprint', async () => {
    const first = response();
    await createTopUpCheckout(request({ userId, requestKey: 'money-conflict-1', amount: 12.34 }), first);
    const conflict = response();
    await createTopUpCheckout(request({ userId, requestKey: 'money-conflict-1', amount: 12.35 }), conflict);

    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await WalletTransaction.countDocuments()).toBe(1);
  });

  test('settles a captured PaymentIntent during same-key replay exactly once when its webhook is delayed', async () => {
    const first = response();
    await createTopUpCheckout(request({ userId, requestKey: 'native-paid-recovery-1' }), first);
    const createdParams = mockPaymentIntentCreate.mock.calls[0][0];
    mockPaymentIntentRetrieve.mockImplementation(async () => ({
      ...buildIntent(createdParams),
      status: 'succeeded',
      amount_received: createdParams.amount,
      latest_charge: 'ch_controller_recovery',
    }));

    const recovered = response();
    await createTopUpCheckout(request({ userId, requestKey: 'native-paid-recovery-1' }), recovered);
    const duplicateReplay = response();
    await createTopUpCheckout(request({ userId, requestKey: 'native-paid-recovery-1' }), duplicateReplay);

    const wallet = await Wallet.findOne({ user: userId }).lean();
    const transaction = await WalletTransaction.findById(first.body.transactionId).lean();
    expect(recovered.statusCode).toBe(200);
    expect(recovered.body.completed).toBe(true);
    expect(duplicateReplay.body.completed).toBe(true);
    expect(wallet.balances.USD).toBe(12.34);
    expect(transaction.status).toBe('completed');
    expect(transaction.paymentSetupState).toBe('complete');
    expect(await Notification.countDocuments({ dedupeKey: `wallet-top-up-completed:${transaction._id}` })).toBe(0);
    const receipts = await NotificationOutbox.find({
      eventKey: `wallet-transaction:${transaction._id}:completed:buyer:v1`,
    }).lean();
    expect(receipts).toHaveLength(3);
    expect(receipts.map(row => row.channel).sort()).toEqual(['email', 'inapp', 'push']);
    expect(receipts.every(row => (
      row.money?.[0]?.amountMinor === 1234
      && row.money?.[0]?.currency === 'USD'
      && row.money?.[0]?.sourceDocumentId === String(transaction._id)
    ))).toBe(true);
  });

  test('allows a normal top-up to settle sub-minimum payment-risk debt and retain surplus', async () => {
    const wallet = await Wallet.create({
      user: userId,
      balances: { USD: 0 },
      status: 'locked',
      lockedReason: 'Stripe payment-risk liability is outstanding. New credits will settle it before becoming available.',
      lockSource: 'payment_risk',
    });
    await WalletTransaction.create({
      user: userId,
      wallet: wallet._id,
      type: 'reversal',
      direction: 'debit',
      status: 'completed',
      amount: 0.5,
      currency: 'USD',
      description: 'Terminal card reversal liability',
      referenceType: 'stripe_refund',
      referenceId: 'evt_subminimum_debt',
      idempotencyKey: 'wallet-risk-subminimum-debt',
      metadata: {
        sourceType: 'wallet_top_up',
        liabilityState: 'terminal',
        liabilityMinor: 50,
        heldMinor: 0,
        collectedMinor: 0,
        writtenOffMinor: 0,
        outstandingMinor: 50,
      },
      completedAt: new Date(),
    });

    const res = response();
    await createTopUpCheckout(request({
      userId,
      requestKey: 'risk-subminimum-settlement',
      amount: 1,
    }), res);

    expect(res.statusCode).toBe(201);
    expect(res.body.transaction).toMatchObject({ amount: 1, currency: 'USD', status: 'pending' });
    expect(mockPaymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  test('does not bypass an independent Wallet lock just because payment-risk debt exists', async () => {
    const wallet = await Wallet.create({
      user: userId,
      balances: { USD: 0 },
      status: 'locked',
      lockedReason: 'Suspected fraud - manual review required.',
      lockSource: 'manual',
    });
    await WalletTransaction.create({
      user: userId,
      wallet: wallet._id,
      type: 'reversal',
      direction: 'debit',
      status: 'completed',
      amount: 5,
      currency: 'USD',
      description: 'Terminal card reversal liability',
      referenceType: 'stripe_refund',
      referenceId: 'evt_manual_lock_debt',
      idempotencyKey: 'wallet-risk-manual-lock-debt',
      metadata: {
        sourceType: 'wallet_top_up',
        liabilityState: 'terminal',
        liabilityMinor: 500,
        heldMinor: 0,
        collectedMinor: 0,
        writtenOffMinor: 0,
        outstandingMinor: 500,
      },
      completedAt: new Date(),
    });

    const res = response();
    await createTopUpCheckout(request({
      userId,
      requestKey: 'manual-lock-settlement-attempt',
      amount: 5,
    }), res);

    expect(res.statusCode).toBe(423);
    expect(res.body.code).toBe('WALLET_LOCKED');
    expect(mockPaymentIntentCreate).not.toHaveBeenCalled();
  });
});
