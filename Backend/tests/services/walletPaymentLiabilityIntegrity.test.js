'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Wallet = require('../../models/Wallet');
const WalletTransaction = require('../../models/WalletTransaction');
const { getWalletPaymentRiskSummary } = require('../../services/walletPaymentLiabilityService');

jest.setTimeout(60000);

describe('Wallet payment-risk liability ledger integrity', () => {
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

  const insertLiability = async (metadataOverrides = {}) => {
    const user = new mongoose.Types.ObjectId();
    const wallet = await Wallet.create({
      user,
      balances: { USD: 25 },
      status: 'locked',
      lockedReason: 'Stripe payment-risk liability is outstanding.',
      lockSource: 'payment_risk',
    });
    const id = new mongoose.Types.ObjectId();
    await WalletTransaction.collection.insertOne({
      _id: id,
      user,
      wallet: wallet._id,
      type: 'reversal',
      direction: 'debit',
      status: 'completed',
      amount: 10,
      currency: 'USD',
      balanceAfter: 25,
      description: 'Raw liability integrity fixture',
      referenceType: 'stripe_refund',
      referenceId: `evt-${id}`,
      idempotencyKey: `wallet-risk:${id}`,
      metadata: {
        sourceType: 'wallet_top_up',
        liabilityState: 'terminal',
        liabilityMinor: 1000,
        heldMinor: 0,
        collectedMinor: 0,
        writtenOffMinor: 0,
        outstandingMinor: 1000,
        ...metadataOverrides,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    });
    return wallet;
  };

  test.each([
    ['liabilityMinor', true],
    ['heldMinor', '0'],
    ['collectedMinor', -1],
    ['writtenOffMinor', 0.5],
    ['outstandingMinor', false],
    ['outstandingMinor', 7_036_874_417_766_401],
    ['outstandingMinor', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects raw malformed %s metadata %p and leaves the Wallet locked', async (field, value) => {
    const wallet = await insertLiability({ [field]: value });
    await expect(getWalletPaymentRiskSummary(wallet._id)).rejects.toMatchObject({
      code: 'WALLET_PAYMENT_RISK_LEDGER_INVALID',
      statusCode: 409,
    });
    await expect(Wallet.findById(wallet._id).lean()).resolves.toMatchObject({
      status: 'locked',
      lockSource: 'payment_risk',
    });
  });

  test('rejects a ledger whose components do not conserve the original liability', async () => {
    const wallet = await insertLiability({ collectedMinor: 1, outstandingMinor: 1000 });
    await expect(getWalletPaymentRiskSummary(wallet._id)).rejects.toMatchObject({
      code: 'WALLET_PAYMENT_RISK_LEDGER_INVALID',
    });
  });

  test('rejects a non-canonical persisted liability currency before selecting a Wallet balance path', async () => {
    const wallet = await insertLiability();
    await WalletTransaction.collection.updateOne(
      { wallet: wallet._id },
      { $set: { currency: 'usd' } },
    );
    await expect(getWalletPaymentRiskSummary(wallet._id)).rejects.toMatchObject({
      code: 'WALLET_STORED_MONEY_INVALID',
      statusCode: 503,
    });
    await expect(Wallet.findById(wallet._id).lean()).resolves.toMatchObject({
      balances: { USD: 25 },
      status: 'locked',
    });
  });

  test('reports a valid exact liability without changing its locked state', async () => {
    const wallet = await insertLiability({ collectedMinor: 400, outstandingMinor: 600 });
    await expect(getWalletPaymentRiskSummary(wallet._id)).resolves.toMatchObject({
      restricted: true,
      outstandingMinor: 600,
    });
    await expect(Wallet.findById(wallet._id).lean()).resolves.toMatchObject({ status: 'locked' });
  });
});
