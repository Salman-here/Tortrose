const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Order = require('../../models/Order');
const {
  analyzeOrderIds,
  parseArguments,
} = require('../../scripts/preflightOrderIdUniqueness');

describe('order public-id uniqueness cutover', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await Order.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Order.collection.deleteMany({});
  });

  test('the preflight refuses write flags', () => {
    expect(() => parseArguments(['--write'])).toThrow(expect.objectContaining({
      code: 'ORDER_ID_PREFLIGHT_READ_ONLY',
    }));
  });

  test('the partial index rejects duplicate modern ids but preserves duplicate legacy evidence', async () => {
    const indexes = await Order.collection.indexes();
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_order_public_id_lookup' }),
      expect.objectContaining({
        name: 'uniq_modern_order_public_id',
        unique: true,
        partialFilterExpression: { orderIdVersion: 2 },
      }),
      expect.objectContaining({
        name: 'uniq_short_order_public_id',
        unique: true,
        partialFilterExpression: { orderIdVersion: 3 },
      }),
    ]));

    const publicId = 'ORD-1770000000000-AABBCCDDEEFF';
    await Order.collection.insertOne({ orderId: publicId, orderIdVersion: 2 });
    await expect(Order.collection.insertOne({ orderId: publicId, orderIdVersion: 2 }))
      .rejects.toMatchObject({ code: 11000 });

    const shortPublicId = 'ORD-1788027012731';
    await Order.collection.insertOne({ orderId: shortPublicId, orderIdVersion: 3 });
    await expect(Order.collection.insertOne({ orderId: shortPublicId, orderIdVersion: 3 }))
      .rejects.toMatchObject({ code: 11000 });

    await Order.collection.insertMany([
      { orderId: 'LEGACY-DUPLICATE' },
      { orderId: 'LEGACY-DUPLICATE' },
    ]);
    await expect(Order.collection.countDocuments({ orderId: 'LEGACY-DUPLICATE' }))
      .resolves.toBe(2);
  });

  test('reports legacy duplicates without treating them as a blocker to the modern partial index', async () => {
    await Order.collection.insertMany([
      { orderId: 'LEGACY-DUPLICATE' },
      { orderId: 'LEGACY-DUPLICATE' },
      { orderId: 'ORD-1770000000000-AABBCCDDEEFF', orderIdVersion: 2 },
      { orderId: null },
    ]);

    const result = await analyzeOrderIds({ sampleLimit: 10 });
    expect(result).toMatchObject({
      readOnly: true,
      counts: {
        totalOrders: 4,
        legacyUnversionedOrders: 3,
        modernVersionedOrders: 1,
        longVersionedOrders: 1,
        shortVersionedOrders: 0,
        invalidOrderIds: 1,
        malformedModernOrders: 0,
      },
      duplicates: {
        all: { duplicateGroups: 1, affectedOrders: 2 },
        modernVersioned: { duplicateGroups: 0, affectedOrders: 0 },
      },
      readyForModernUniqueIndex: true,
    });
    expect(result.duplicates.all.samples[0]).toMatchObject({
      orderId: 'LEGACY-DUPLICATE',
      count: 2,
    });
  });

  test('malformed version-2 ids fail the index-readiness assessment', async () => {
    await Order.collection.insertOne({ orderId: 'BAD-MODERN-ID', orderIdVersion: 2 });
    const result = await analyzeOrderIds({ sampleLimit: 5 });
    expect(result.counts.malformedModernOrders).toBe(1);
    expect(result.readyForModernUniqueIndex).toBe(false);
    expect(result.samples.malformedModern[0]).toMatchObject({
      orderId: 'BAD-MODERN-ID',
      orderIdVersion: 2,
    });
  });

  test('reports compact version-3 ids separately and rejects malformed compact rows', async () => {
    await Order.collection.insertMany([
      { orderId: 'ORD-1788027012731', orderIdVersion: 3 },
      { orderId: 'ORD-1788027012731-TOO-LONG', orderIdVersion: 3 },
    ]);
    const result = await analyzeOrderIds({ sampleLimit: 5 });
    expect(result.counts).toMatchObject({
      shortVersionedOrders: 2,
      malformedShortOrders: 1,
      malformedModernOrders: 1,
    });
    expect(result.readyForModernUniqueIndex).toBe(false);
    expect(result.samples.malformedShort[0]).toMatchObject({
      orderId: 'ORD-1788027012731-TOO-LONG',
      orderIdVersion: 3,
    });
  });
});
