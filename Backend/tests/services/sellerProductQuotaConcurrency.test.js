'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Product = require('../../models/Product');
const SellerSubscription = require('../../models/SellerSubscription');
const Store = require('../../models/Store');
const User = require('../../models/User');
const { withProductCurrencyWriteLock } = require('../../services/storeProductCurrencyService');
const {
  assertSellerCanCreateProducts,
  assertSellerCanFeatureProduct,
} = require('../../services/sellerProductQuotaService');

let replicaSet;

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri());
}, 60000);

afterEach(async () => {
  await Promise.all([
    Product.deleteMany({}),
    SellerSubscription.deleteMany({}),
    Store.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 60000);

async function fixture({ status = 'trial', plan = 'starter' } = {}) {
  const seller = await User.create({
    username: `quota-${new mongoose.Types.ObjectId()}`,
    email: `quota-${new mongoose.Types.ObjectId()}@example.com`,
    role: 'seller',
    currency: 'PKR',
  });
  await Store.create({
    seller: seller._id,
    storeName: 'Quota Store',
    storeSlug: `quota-${seller._id}`,
    productCurrency: 'PKR',
    productCurrencyStatus: 'active',
  });
  await SellerSubscription.create({ seller: seller._id, status, plan });
  return seller;
}

const productData = (sellerId, index, isFeatured = false) => ({
  seller: sellerId,
  name: `Quota Product ${index}`,
  description: `Concurrency quota fixture ${index}.`,
  price: 100 + index,
  currency: 'PKR',
  priceCurrency: 'PKR',
  priceInputAmount: 100 + index,
  category: 'Test',
  brand: 'Rozare',
  stock: 1,
  image: 'https://example.com/quota.jpg',
  isFeatured,
});

describe('seller product quota serialization', () => {
  test('two concurrent trial inserts cannot create a sixteenth product', async () => {
    const seller = await fixture();
    await Product.insertMany(Array.from({ length: 14 }, (_, index) => productData(seller._id, index)));

    const createOne = index => withProductCurrencyWriteLock(seller._id, 'PKR', async session => {
      await assertSellerCanCreateProducts(seller._id, { session });
      return Product.create([productData(seller._id, index)], { session });
    });
    const results = await Promise.allSettled([createOne(100), createOne(101)]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')[0].reason).toMatchObject({
      code: 'TRIAL_PRODUCT_LIMIT_REACHED',
      status: 403,
    });
    await expect(Product.countDocuments({ seller: seller._id })).resolves.toBe(15);
  });

  test('two concurrent feature writes cannot take the seventh Starter slot', async () => {
    const seller = await fixture({ status: 'active', plan: 'starter' });
    const products = await Product.insertMany([
      ...Array.from({ length: 5 }, (_, index) => productData(seller._id, index, true)),
      productData(seller._id, 100, false),
      productData(seller._id, 101, false),
    ]);
    const candidates = products.slice(-2);

    const featureOne = product => withProductCurrencyWriteLock(seller._id, 'PKR', async session => {
      await assertSellerCanFeatureProduct(seller._id, {
        excludeProductId: product._id,
        session,
      });
      return Product.updateOne({ _id: product._id, seller: seller._id }, {
        $set: { isFeatured: true },
      }, { session });
    });
    const results = await Promise.allSettled(candidates.map(featureOne));

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')[0].reason).toMatchObject({
      code: 'FEATURED_PRODUCT_LIMIT_REACHED',
      status: 403,
    });
    await expect(Product.countDocuments({ seller: seller._id, isFeatured: true })).resolves.toBe(6);
  });
});
