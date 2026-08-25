const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const Product = require('../../models/Product');
const ProductCurrencyMigration = require('../../models/ProductCurrencyMigration');
const Store = require('../../models/Store');
const {
  commitWriteBatches,
  scanRemainingReadOnly,
} = require('../../scripts/migrateProductNativeCurrency');

const rateSnapshot = {
  base: 'USD',
  rates: { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.8 },
  capturedAt: new Date('2026-08-24T12:00:00.000Z'),
  source: 'checkpoint-test',
  fallback: false,
};

describe('bounded product-currency checkpoint runner', () => {
  let replicaSet;

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
    await ProductCurrencyMigration.syncIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replicaSet.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    await ProductCurrencyMigration.syncIndexes();
  });

  afterEach(() => jest.restoreAllMocks());

  test('streams a 205-product seller and resumes after one committed 100-row transaction', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const storeId = new mongoose.Types.ObjectId();
    const productRows = Array.from({ length: 205 }, (_, index) => ({
      _id: new mongoose.Types.ObjectId(),
      seller: sellerId,
      name: `Legacy ${String(index).padStart(3, '0')}`,
      price: 1,
      discountedPrice: 0,
      __v: 0,
    })).sort((left, right) => left._id.toString().localeCompare(right._id.toString()));
    await Store.collection.insertOne({
      _id: storeId,
      seller: sellerId,
      storeName: 'Checkpoint Store',
      storeSlug: 'checkpoint-store',
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      __v: 0,
    });
    await Product.collection.insertMany(productRows);

    const leaseOwner = 'checkpoint-test-owner';
    const checkpoint = await ProductCurrencyMigration.create({
      migrationId: 'checkpoint-test-20260824',
      status: 'running',
      force: false,
      batchSize: 100,
      upperBoundProductId: productRows[productRows.length - 1]._id,
      estimatedProducts: productRows.length,
      rateSnapshot,
      migratedAt: new Date('2026-08-24T12:05:00.000Z'),
      cursor: { phase: 'seller' },
      lease: {
        owner: leaseOwner,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const baseFilter = {
      $and: [
        {
          $or: [
            { currency: { $exists: false } },
            { priceVersion: { $ne: 2 } },
          ],
        },
        { _id: { $lte: productRows[productRows.length - 1]._id } },
      ],
    };
    const validation = await scanRemainingReadOnly({
      initialCursor: checkpoint.cursor,
      baseFilter,
      batchSize: 100,
      rateSnapshot,
      migratedAt: checkpoint.migratedAt,
    });
    expect(validation).toMatchObject({
      productsValidated: 205,
      batchesValidated: 3,
    });
    expect(await Product.countDocuments({ priceVersion: 2 })).toBe(0);

    const bulkSizes = [];
    const realBulkWrite = Product.bulkWrite.bind(Product);
    jest.spyOn(Product, 'bulkWrite').mockImplementation((operations, options) => {
      bulkSizes.push(operations.length);
      return realBulkWrite(operations, options);
    });

    const firstRun = await commitWriteBatches({
      checkpoint: checkpoint.toObject(),
      options: { maxBatches: 1, verbose: false },
      leaseOwner,
    });
    expect(firstRun.paused).toBe(true);
    expect(firstRun.checkpoint).toMatchObject({
      batchesCommitted: 1,
      productsCommitted: 100,
      status: 'running',
    });
    expect(await Product.countDocuments({ priceVersion: 2 })).toBe(100);

    const resumed = await commitWriteBatches({
      checkpoint: firstRun.checkpoint,
      options: { maxBatches: null, verbose: false },
      leaseOwner,
    });
    expect(resumed.paused).toBe(false);
    expect(resumed.checkpoint).toMatchObject({
      batchesCommitted: 3,
      productsCommitted: 205,
      cursor: { phase: 'done' },
    });
    expect(bulkSizes).toEqual([100, 100, 5]);
    expect(await Product.countDocuments({
      priceVersion: 2,
      currency: 'PKR',
      price: 280,
      priceInputAmount: 280,
    })).toBe(205);
  });

  test('losing the checkpoint lease aborts the product and Store writes in the same transaction', async () => {
    const sellerId = new mongoose.Types.ObjectId();
    const storeId = new mongoose.Types.ObjectId();
    const productId = new mongoose.Types.ObjectId();
    await Store.collection.insertOne({
      _id: storeId,
      seller: sellerId,
      storeName: 'Lease Store',
      storeSlug: 'lease-store',
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      __v: 0,
    });
    await Product.collection.insertOne({
      _id: productId,
      seller: sellerId,
      name: 'Lease Product',
      price: 1,
      discountedPrice: 0,
      __v: 0,
    });
    const checkpoint = await ProductCurrencyMigration.create({
      migrationId: 'checkpoint-lease-loss-20260824',
      status: 'running',
      force: false,
      batchSize: 100,
      upperBoundProductId: productId,
      estimatedProducts: 1,
      rateSnapshot,
      migratedAt: new Date('2026-08-24T12:05:00.000Z'),
      cursor: {
        phase: 'seller',
        activeSellerId: sellerId,
        lastProductId: null,
        authority: {
          kind: 'store',
          storeId,
          storeCurrency: 'PKR',
          targetCurrency: 'PKR',
          sellerCurrency: 'USD',
          sellerCurrencyExplicit: false,
          sellerExists: false,
        },
      },
      lease: {
        owner: 'original-owner',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    await ProductCurrencyMigration.updateOne(
      { _id: checkpoint._id },
      { $set: { 'lease.owner': 'takeover-owner' } }
    );

    await expect(commitWriteBatches({
      checkpoint: checkpoint.toObject(),
      options: { maxBatches: null, verbose: false },
      leaseOwner: 'original-owner',
    })).rejects.toMatchObject({ code: 'PRODUCT_CURRENCY_MIGRATION_CONFLICT' });

    expect(await Product.collection.findOne({ _id: productId })).toMatchObject({
      price: 1,
      __v: 0,
    });
    expect(await Store.collection.findOne({ _id: storeId })).toMatchObject({ __v: 0 });
    expect(await ProductCurrencyMigration.findById(checkpoint._id).lean()).toMatchObject({
      productsCommitted: 0,
      batchesCommitted: 0,
      lease: { owner: 'takeover-owner' },
    });
  });
});
