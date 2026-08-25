const mongoose = require('mongoose');
const Product = require('../../models/Product');
const Store = require('../../models/Store');
const {
  buildMigrationPlan,
  describeProductMigration,
  executeMigrationPlan,
  groupMigrationPlan,
  parseArguments,
} = require('../../scripts/migrateProductNativeCurrency');

const liveSnapshot = {
  base: 'USD',
  rates: { USD: 1, PKR: 280, EUR: 0.92, GBP: 0.8 },
  capturedAt: new Date().toISOString(),
  source: 'test',
  fallback: false,
};

const makeLegacyProduct = overrides => new Product({
  _id: new mongoose.Types.ObjectId(),
  seller: new mongoose.Types.ObjectId(),
  name: 'Legacy price',
  description: 'migration regression',
  category: 'Test',
  brand: 'Test',
  stock: 1,
  image: 'https://example.com/product.jpg',
  images: [{ url: 'https://example.com/product.jpg' }],
  price: 1,
  ...overrides,
});

describe('migrateProductNativeCurrency', () => {
  afterEach(() => jest.restoreAllMocks());

  test('uses Store.productCurrency instead of the seller display currency for missing legacy metadata', async () => {
    const product = makeLegacyProduct();
    const sellerId = product.seller.toString();
    expect(product.$isDefault('currency')).toBe(true);
    const store = {
      _id: new mongoose.Types.ObjectId(),
      seller: product.seller,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      __v: 0,
    };

    const { plan } = await buildMigrationPlan([product], {
      storesBySeller: new Map([[sellerId, store]]),
      sellersById: new Map([[sellerId, { _id: product.seller, currency: 'GBP' }]]),
      rateSnapshot: liveSnapshot,
    });

    expect(plan[0]).toMatchObject({
      targetCurrency: 'PKR',
      update: {
        price: 280,
        currency: 'PKR',
        priceCurrency: 'PKR',
        priceInputAmount: 280,
      },
    });
  });

  test('keeps explicit product metadata ahead of account display currency when no store exists', () => {
    const product = makeLegacyProduct({
      currency: 'EUR',
      priceCurrency: 'EUR',
      priceInputAmount: 10,
    });

    expect(describeProductMigration(product, {
      seller: { _id: product.seller, currency: 'GBP' },
    })).toMatchObject({
      targetCurrency: 'EUR',
      priceAmount: 10,
      priceSourceCurrency: 'EUR',
    });
  });

  test('fails the complete plan before writes when required FX is an emergency fallback', async () => {
    const product = makeLegacyProduct();
    const sellerId = product.seller.toString();

    await expect(buildMigrationPlan([product], {
      storesBySeller: new Map([[sellerId, {
        _id: new mongoose.Types.ObjectId(),
        seller: product.seller,
        productCurrency: 'PKR',
        productCurrencyStatus: 'active',
      }]]),
      rateSnapshot: { ...liveSnapshot, fallback: true, source: 'fallback' },
    })).rejects.toMatchObject({ code: 'EXCHANGE_RATES_UNAVAILABLE' });
  });

  test('rejects a migration plan that would turn a positive PKR product into zero USD', async () => {
    const product = makeLegacyProduct({
      price: 1,
      priceInputAmount: 1,
      currency: 'PKR',
      priceCurrency: 'PKR',
    });
    const sellerId = product.seller.toString();

    await expect(buildMigrationPlan([product], {
      storesBySeller: new Map([[sellerId, {
        _id: new mongoose.Types.ObjectId(),
        seller: product.seller,
        productCurrency: 'USD',
        productCurrencyStatus: 'active',
      }]]),
      rateSnapshot: liveSnapshot,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_CURRENCY_PRICE_UNREPRESENTABLE',
    });
  });

  test('uses guarded product writes in one transaction and rejects a stale match count', async () => {
    const session = {
      withTransaction: jest.fn(async work => work()),
      endSession: jest.fn(async () => {}),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    jest.spyOn(Store, 'updateOne').mockResolvedValue({ matchedCount: 1 });
    const bulkWrite = jest.spyOn(Product, 'bulkWrite').mockResolvedValue({ matchedCount: 0 });
    const product = makeLegacyProduct();
    product.__v = 4;
    product.updatedAt = new Date('2026-01-01T00:00:00.000Z');

    await expect(executeMigrationPlan([{
      product,
      store: null,
      update: { price: 280, currency: 'PKR' },
    }])).rejects.toMatchObject({ code: 'PRODUCT_CURRENCY_MIGRATION_CONFLICT' });

    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(bulkWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        updateOne: expect.objectContaining({
          filter: expect.objectContaining({
            _id: product._id,
            __v: 4,
            updatedAt: product.updatedAt,
          }),
        }),
      }),
    ], expect.objectContaining({ session, ordered: true }));
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  test('groups writes by seller/store instead of one marketplace-wide transaction', async () => {
    const sellerA = new mongoose.Types.ObjectId();
    const sellerB = new mongoose.Types.ObjectId();
    const storeA = { _id: new mongoose.Types.ObjectId(), seller: sellerA, __v: 0, productCurrency: 'PKR', productCurrencyStatus: 'active' };
    const storeB = { _id: new mongoose.Types.ObjectId(), seller: sellerB, __v: 0, productCurrency: 'USD', productCurrencyStatus: 'active' };
    const plan = [
      { product: makeLegacyProduct({ seller: sellerA }), store: storeA, update: { priceVersion: 2 } },
      { product: makeLegacyProduct({ seller: sellerA }), store: storeA, update: { priceVersion: 2 } },
      { product: makeLegacyProduct({ seller: sellerB }), store: storeB, update: { priceVersion: 2 } },
    ];
    expect(groupMigrationPlan(plan).map(group => group.length)).toEqual([2, 1]);

    const sessions = Array.from({ length: 2 }, () => ({
      withTransaction: jest.fn(async work => work()),
      endSession: jest.fn(async () => {}),
    }));
    jest.spyOn(mongoose, 'startSession')
      .mockResolvedValueOnce(sessions[0])
      .mockResolvedValueOnce(sessions[1]);
    jest.spyOn(Store, 'updateOne').mockResolvedValue({ matchedCount: 1 });
    jest.spyOn(Product, 'bulkWrite').mockImplementation(async operations => ({ matchedCount: operations.length }));

    await expect(executeMigrationPlan(plan)).resolves.toMatchObject({
      batchesCommitted: 2,
      productsCommitted: 3,
    });
    expect(mongoose.startSession).toHaveBeenCalledTimes(2);
    expect(Product.bulkWrite).toHaveBeenNthCalledWith(1, expect.any(Array), expect.objectContaining({
      session: sessions[0],
    }));
    expect(Product.bulkWrite).toHaveBeenNthCalledWith(2, expect.any(Array), expect.objectContaining({
      session: sessions[1],
    }));
  });

  test('splits a single very large seller into deterministic bounded transactions', () => {
    const seller = new mongoose.Types.ObjectId();
    const store = {
      _id: new mongoose.Types.ObjectId(),
      seller,
      __v: 0,
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
    };
    const plan = Array.from({ length: 205 }, (_, index) => ({
      product: makeLegacyProduct({ seller, name: `Product ${index}` }),
      store,
      update: { priceVersion: 2 },
    }));

    const batches = groupMigrationPlan(plan, { batchSize: 100 });
    expect(batches.map(batch => batch.length)).toEqual([100, 100, 5]);
    expect(batches.flat().map(entry => entry.product._id.toString()))
      .toEqual(plan.map(entry => entry.product._id.toString()));
  });

  test('write mode requires a stable checkpoint id and explicit force acknowledgement', () => {
    expect(() => parseArguments(['--write'])).toThrow(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_MIGRATION_ID_REQUIRED',
    }));
    expect(() => parseArguments([
      '--write',
      '--force',
      '--migration-id=currency-v2-20260824',
    ])).toThrow(expect.objectContaining({
      code: 'PRODUCT_CURRENCY_FORCE_ACK_REQUIRED',
    }));
    expect(parseArguments([
      '--write',
      '--force',
      '--acknowledge-force',
      '--migration-id=currency-v2-20260824',
      '--batch-size=75',
      '--max-batches=2',
    ])).toMatchObject({
      write: true,
      force: true,
      migrationId: 'currency-v2-20260824',
      batchSize: 75,
      maxBatches: 2,
    });
  });

  test('dry-run mode cannot create or reuse a durable write checkpoint', () => {
    expect(() => parseArguments(['--migration-id=currency-v2-20260824']))
      .toThrow(expect.objectContaining({
        code: 'PRODUCT_CURRENCY_DRY_RUN_MUST_NOT_CHECKPOINT',
      }));
  });
});
