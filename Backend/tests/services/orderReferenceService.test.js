const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../../models/Order');
const { resolveOrderReference } = require('../../services/orderReferenceService');

describe('orderReferenceService', () => {
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

  test('an immutable Mongo id is authoritative and never falls back to a matching public id', async () => {
    const immutableId = new mongoose.Types.ObjectId();
    const publicOnlyId = new mongoose.Types.ObjectId();
    await Order.collection.insertMany([
      { _id: immutableId, orderId: 'REAL-PUBLIC-ID', marker: 'mongo-row' },
      { _id: new mongoose.Types.ObjectId(), orderId: publicOnlyId.toString(), marker: 'public-row' },
    ]);

    await expect(resolveOrderReference({
      reference: immutableId.toString(),
      lean: true,
    })).resolves.toMatchObject({ marker: 'mongo-row' });
    await expect(resolveOrderReference({
      reference: publicOnlyId.toString(),
      lean: true,
    })).resolves.toBeNull();
  });

  test('a duplicate legacy public id fails closed instead of selecting the first row', async () => {
    await Order.collection.insertMany([
      { orderId: 'LEGACY-DUP' },
      { orderId: 'LEGACY-DUP' },
    ]);
    await expect(resolveOrderReference({ reference: 'LEGACY-DUP' }))
      .rejects.toMatchObject({
        code: 'ORDER_REFERENCE_AMBIGUOUS',
        statusCode: 409,
      });
  });

  test('legacy uniqueness is evaluated inside an explicit ownership scope', async () => {
    const buyerA = new mongoose.Types.ObjectId();
    const buyerB = new mongoose.Types.ObjectId();
    await Order.collection.insertMany([
      { orderId: 'LEGACY-SCOPED', user: buyerA },
      { orderId: 'LEGACY-SCOPED', user: buyerB },
    ]);
    await expect(resolveOrderReference({
      reference: 'LEGACY-SCOPED',
      scope: { user: buyerA },
      lean: true,
    })).resolves.toMatchObject({ user: buyerA });
  });
});
