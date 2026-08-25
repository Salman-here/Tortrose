const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../../models/Order');
const {
  findOrderForWalletDebit,
  historicalReturnIdentity,
} = require('../../services/walletService');

describe('Wallet legacy order-reference ambiguity', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Order.collection.deleteMany({});
  });

  test('a duplicate buyer-scoped public id quarantines funding instead of selecting one order', async () => {
    const buyer = new mongoose.Types.ObjectId();
    const wallet = new mongoose.Types.ObjectId();
    await Order.collection.insertMany([
      { orderId: 'LEGACY-WALLET-DUP', user: buyer },
      { orderId: 'LEGACY-WALLET-DUP', user: buyer },
    ]);

    await expect(findOrderForWalletDebit({
      _id: new mongoose.Types.ObjectId(),
      user: buyer,
      wallet,
      referenceId: 'LEGACY-WALLET-DUP',
      metadata: {},
    }, null)).rejects.toMatchObject({
      code: 'WALLET_FUNDING_PROVENANCE_QUARANTINED',
      statusCode: 503,
      walletId: wallet.toString(),
    });
  });

  test('conflicting public references quarantine the debit', async () => {
    const buyer = new mongoose.Types.ObjectId();
    await Order.collection.insertMany([
      { orderId: 'LEGACY-PRIMARY', user: buyer },
      { orderId: 'LEGACY-METADATA', user: buyer },
    ]);

    await expect(findOrderForWalletDebit({
      _id: new mongoose.Types.ObjectId(),
      user: buyer,
      referenceId: 'LEGACY-PRIMARY',
      metadata: { orderId: 'LEGACY-METADATA' },
    }, null)).rejects.toMatchObject({
      code: 'WALLET_FUNDING_PROVENANCE_QUARANTINED',
    });
  });

  test('an unknown immutable reference never falls back to public metadata', async () => {
    const buyer = new mongoose.Types.ObjectId();
    await Order.collection.insertOne({ orderId: 'LEGACY-METADATA', user: buyer });

    await expect(findOrderForWalletDebit({
      user: buyer,
      referenceId: new mongoose.Types.ObjectId().toString(),
      metadata: { orderId: 'LEGACY-METADATA' },
    }, null)).resolves.toBeNull();
  });

  test('an ambiguous historical return reference is quarantined before refund ownership inference', async () => {
    const buyer = new mongoose.Types.ObjectId();
    const seller = new mongoose.Types.ObjectId();
    const returnId = new mongoose.Types.ObjectId();
    await Order.collection.insertMany([
      { orderId: 'LEGACY-RETURN-DUP', user: buyer },
      { orderId: 'LEGACY-RETURN-DUP', user: buyer },
    ]);

    await expect(historicalReturnIdentity({
      _id: new mongoose.Types.ObjectId(),
      user: buyer,
      wallet: new mongoose.Types.ObjectId(),
      referenceType: 'return_request',
      referenceId: returnId,
      idempotencyKey: `return-refund:${returnId}`,
      metadata: {
        orderId: 'LEGACY-RETURN-DUP',
        sellerId: seller.toString(),
      },
    }, null)).rejects.toMatchObject({
      code: 'WALLET_FUNDING_PROVENANCE_QUARANTINED',
      quarantineSellerIds: [seller.toString()],
    });
  });
});
