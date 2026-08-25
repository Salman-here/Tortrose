'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../services/currencyService', () => {
  const actual = jest.requireActual('../../services/currencyService');
  return {
    ...actual,
    getExchangeRateSnapshot: jest.fn().mockResolvedValue({
      base: 'USD',
      rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 },
      capturedAt: '2026-08-20T00:00:00.000Z',
      source: 'test-live',
      fallback: false,
    }),
  };
});

const Product = require('../../models/Product');
const Store = require('../../models/Store');
const User = require('../../models/User');
const {
  cancelPendingProductCurrencyChange,
  convertPendingProductPrices,
  requestProductCurrencyChange,
  withProductCurrencyWriteLock,
} = require('../../services/storeProductCurrencyService');

let replicaSet;

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
}, 60000);

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([Product.deleteMany({}), Store.deleteMany({}), User.deleteMany({})]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 60000);

async function createSellerAndStore() {
  const seller = await User.create({
    username: `currency-race-${Date.now()}`,
    email: `currency-race-${Date.now()}@example.com`,
    role: 'seller',
    currency: 'PKR',
  });
  const store = await Store.create({
    seller: seller._id,
    storeName: 'Currency Race Store',
    storeSlug: `currency-race-${seller._id}`,
    productCurrency: 'PKR',
    productCurrencyStatus: 'active',
    isActive: true,
  });
  return { seller, store };
}

const productData = sellerId => ({
  seller: sellerId,
  name: `Race Product ${Date.now()}`,
  description: 'Product currency concurrency regression fixture.',
  price: 2800,
  currency: 'PKR',
  priceCurrency: 'PKR',
  priceInputAmount: 2800,
  category: 'Test',
  brand: 'Rozare',
  stock: 5,
  image: 'https://example.com/currency-race.jpg',
  images: [{ url: 'https://example.com/currency-race.jpg' }],
});

function pauseNextStoreCurrencyMutation() {
  const original = Store.findOneAndUpdate.bind(Store);
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const spy = jest.spyOn(Store, 'findOneAndUpdate').mockImplementation(async (...args) => {
    enteredResolve();
    await release;
    return original(...args);
  });
  return { entered, release: releaseResolve, spy };
}

describe('store product-currency transition serialization', () => {
  test('a product insert lock makes a stale zero-product currency switch fail closed', async () => {
    const { seller } = await createSellerAndStore();
    const gate = pauseNextStoreCurrencyMutation();
    const currencyChange = requestProductCurrencyChange(seller._id, 'USD', { confirm: true });
    await gate.entered;

    await withProductCurrencyWriteLock(seller._id, 'PKR', session => (
      Product.create([productData(seller._id)], { session })
    ));
    gate.release();

    await expect(currencyChange).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT',
    });
    const [store, products] = await Promise.all([
      Store.findOne({ seller: seller._id }).lean(),
      Product.find({ seller: seller._id }).lean(),
    ]);
    expect(store).toMatchObject({
      productCurrency: 'PKR',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
    });
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ price: 2800, currency: 'PKR', priceCurrency: 'PKR' });
  });

  test('a completed conversion makes a stale cancellation fail without reverting the store', async () => {
    const { seller } = await createSellerAndStore();
    const product = await Product.create(productData(seller._id));
    await requestProductCurrencyChange(seller._id, 'USD', { confirm: true });

    const gate = pauseNextStoreCurrencyMutation();
    const cancellation = cancelPendingProductCurrencyChange(seller._id);
    await gate.entered;
    const conversion = await convertPendingProductPrices(seller._id);
    gate.release();

    expect(conversion.converted).toBe(1);
    await expect(cancellation).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_CURRENCY_CONVERSION_CONFLICT',
    });
    const [store, convertedProduct] = await Promise.all([
      Store.findOne({ seller: seller._id }).lean(),
      Product.findById(product._id).lean(),
    ]);
    expect(store).toMatchObject({
      productCurrency: 'USD',
      productCurrencyStatus: 'active',
      pendingProductCurrency: null,
      previousProductCurrency: null,
    });
    expect(convertedProduct).toMatchObject({
      price: 10,
      currency: 'USD',
      priceCurrency: 'USD',
    });
  });
});
