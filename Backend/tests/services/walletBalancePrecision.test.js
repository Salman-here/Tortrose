const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const {
  creditWalletInSession,
  debitWalletInSession,
  roundMoney,
  runInTransaction,
} = require('../../services/walletService');
const {
  consumeWalletBalanceForLiability,
} = require('../../services/walletPaymentLiabilityService');

jest.setTimeout(60000);

describe('wallet balance minor-unit precision', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    await Promise.all([Wallet.init(), WalletTransaction.init()]);
  });

  afterEach(async () => {
    await Promise.all([Wallet.deleteMany({}), WalletTransaction.deleteMany({})]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  test('normalizes legacy floating residue and stores exact cents after credit and debit', async () => {
    const userId = new mongoose.Types.ObjectId();
    // Insert below Mongoose validation to represent an already-deployed legacy
    // row. New writes reject this residue at the model boundary; the service
    // still has to normalize historical values on first mutation.
    await Wallet.collection.insertOne({
      user: userId,
      balances: { USD: 0.30000000000000004, PKR: 0, EUR: 0, GBP: 0 },
      status: 'active',
      lockedReason: '',
      lockSource: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });

    const credit = await runInTransaction((session) => creditWalletInSession({
      userId,
      amount: 0.01,
      currency: 'USD',
      type: 'admin_adjustment',
      referenceType: 'admin',
      referenceId: 'credit-one-cent',
      idempotencyKey: 'precision-credit-one-cent',
      description: 'Precision credit',
    }, session));

    const debit = await runInTransaction((session) => debitWalletInSession({
      userId,
      amount: 0.11,
      currency: 'USD',
      type: 'admin_adjustment',
      referenceType: 'admin',
      referenceId: 'debit-eleven-cents',
      idempotencyKey: 'precision-debit-eleven-cents',
      description: 'Precision debit',
    }, session));

    const wallet = await Wallet.findOne({ user: userId }).lean();
    expect(credit.balanceAfter).toBe(0.31);
    expect(debit.balanceAfter).toBe(0.2);
    expect(wallet.balances.USD).toBe(0.2);
  });

  test('serializes concurrent one-cent credits without losing or drifting a cent', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Wallet.create({ user: userId });

    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      runInTransaction((session) => creditWalletInSession({
        userId,
        amount: 0.01,
        currency: 'USD',
        type: 'admin_adjustment',
        referenceType: 'admin',
        referenceId: `concurrent-credit-${index}`,
        idempotencyKey: `precision-concurrent-credit-${index}`,
        description: 'Concurrent precision credit',
      }, session))
    )));

    const wallet = await Wallet.findOne({ user: userId }).lean();
    const transactions = await WalletTransaction.find({ user: userId }).lean();
    expect(wallet.balances.USD).toBe(0.2);
    expect(transactions).toHaveLength(20);
    expect(transactions.every((transaction) => (
      roundMoney(transaction.balanceAfter) === transaction.balanceAfter
    ))).toBe(true);
  });

  test('rejects an atomic debit that exceeds the normalized cent balance', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Wallet.collection.insertOne({
      user: userId,
      balances: { USD: 0.29999999999999993, PKR: 0, EUR: 0, GBP: 0 },
      status: 'active',
      lockedReason: '',
      lockSource: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });

    await expect(runInTransaction((session) => debitWalletInSession({
      userId,
      amount: 0.31,
      currency: 'USD',
      type: 'admin_adjustment',
      referenceType: 'admin',
      referenceId: 'overdraft',
      idempotencyKey: 'precision-overdraft',
      description: 'Must not overdraw',
    }, session))).rejects.toMatchObject({
      code: 'INSUFFICIENT_WALLET_BALANCE',
      availableBalance: 0.3,
    });

    const wallet = await Wallet.findOne({ user: userId }).lean();
    expect(wallet.balances.USD).toBeCloseTo(0.3, 12);
    expect(await WalletTransaction.countDocuments({ user: userId })).toBe(0);
  });

  test.each([null, -1, Number.POSITIVE_INFINITY])(
    'fails closed before mutating a corrupt persisted Wallet balance %p',
    async (corruptBalance) => {
      const userId = new mongoose.Types.ObjectId();
      await Wallet.collection.insertOne({
        user: userId,
        balances: { USD: corruptBalance, PKR: 0, EUR: 0, GBP: 0 },
        status: 'active',
        lockedReason: '',
        lockSource: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
      });

      await expect(runInTransaction((session) => creditWalletInSession({
        userId,
        amount: 1,
        currency: 'USD',
        type: 'admin_adjustment',
        referenceType: 'admin',
        referenceId: `corrupt-balance-${String(corruptBalance)}`,
        idempotencyKey: `corrupt-balance-${String(corruptBalance)}`,
        description: 'Must not repair corrupt stored money silently',
      }, session))).rejects.toMatchObject({
        code: 'WALLET_STORED_MONEY_INVALID',
        statusCode: 503,
      });

      const persisted = await Wallet.collection.findOne({ user: userId });
      expect(persisted.balances.USD).toBe(corruptBalance);
      expect(await WalletTransaction.countDocuments({ user: userId })).toBe(0);
    },
  );

  test('the liability collector also rejects corrupt stored balance before applying a reversal', async () => {
    const userId = new mongoose.Types.ObjectId();
    const inserted = await Wallet.collection.insertOne({
      user: userId,
      balances: { USD: null, PKR: 0, EUR: 0, GBP: 0 },
      status: 'active',
      lockedReason: '',
      lockSource: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });

    await expect(runInTransaction(session => consumeWalletBalanceForLiability({
      walletId: inserted.insertedId,
      currency: 'USD',
      liabilityMinor: 100,
      session,
    }))).rejects.toMatchObject({
      code: 'WALLET_STORED_MONEY_INVALID',
      statusCode: 503,
    });

    const persisted = await Wallet.collection.findOne({ _id: inserted.insertedId });
    expect(persisted.balances.USD).toBeNull();
  });

  test('a Wallet credit rolls back before exceeding reversible cent storage', async () => {
    const userId = new mongoose.Types.ObjectId();
    const maximumReversibleBalance = 70_368_744_177_664;
    await Wallet.create({ user: userId, balances: { USD: maximumReversibleBalance } });

    await expect(runInTransaction(session => creditWalletInSession({
      userId,
      amount: 0.01,
      currency: 'USD',
      type: 'admin_adjustment',
      referenceType: 'admin',
      referenceId: 'wallet-credit-overflow',
      idempotencyKey: 'wallet-credit-overflow',
      description: 'Must preserve every stored cent',
    }, session))).rejects.toMatchObject({
      code: 'WALLET_STORED_MONEY_INVALID',
      statusCode: 503,
    });

    expect((await Wallet.findOne({ user: userId }).lean()).balances.USD)
      .toBe(maximumReversibleBalance);
    expect(await WalletTransaction.countDocuments({ user: userId })).toBe(0);
  });

  test('a Wallet debit quarantines coercible top-up funding counters instead of spending them as cents', async () => {
    const userId = new mongoose.Types.ObjectId();
    const wallet = await Wallet.create({ user: userId, balances: { USD: 10 } });
    await WalletTransaction.create({
      user: userId,
      wallet: wallet._id,
      type: 'top_up',
      direction: 'credit',
      status: 'completed',
      amount: 10,
      currency: 'USD',
      balanceAfter: 10,
      description: 'Corrupt funding counter fixture',
      referenceType: 'stripe_payment_intent',
      referenceId: 'pi_corrupt_funding_counter',
      idempotencyKey: 'topup:corrupt-funding-counter',
      stripePaymentIntentId: 'pi_corrupt_funding_counter',
      paymentFlow: 'payment_sheet',
      paymentSetupState: 'complete',
      metadata: {
        availableCreditedMinor: 1000,
        liabilityAppliedMinor: 0,
        fundingOriginalAvailableMinor: 1000,
        fundingRemainingMinor: '1000',
      },
      completedAt: new Date(),
    });

    await expect(runInTransaction(session => debitWalletInSession({
      userId,
      amount: 1,
      currency: 'USD',
      type: 'admin_adjustment',
      referenceType: 'admin',
      referenceId: 'corrupt-funding-debit',
      idempotencyKey: 'corrupt-funding-debit',
      description: 'Must not consume coercible provenance',
    }, session))).rejects.toMatchObject({
      code: 'WALLET_FUNDING_PROVENANCE_QUARANTINED',
      statusCode: 503,
    });

    expect((await Wallet.findById(wallet._id).lean()).balances.USD).toBe(10);
    expect(await WalletTransaction.countDocuments({ idempotencyKey: 'corrupt-funding-debit' })).toBe(0);
  });
});
