'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Product = require('../../models/Product');
const {
  __private,
  bulkDeleteProducts,
  bulkPriceUpdate,
} = require('../../controllers/productController');

let replicaSet;

const createProduct = ({ seller = null, suffix, price = 10, discountedPrice = 8 } = {}) => Product.create({
  name: `Bulk transaction ${suffix}`,
  description: 'Bulk transaction integrity fixture',
  price,
  discountedPrice,
  currency: 'USD',
  priceCurrency: 'USD',
  priceInputAmount: price,
  discountedPriceCurrency: 'USD',
  discountedPriceInputAmount: discountedPrice,
  priceVersion: 2,
  category: 'Other',
  brand: 'Test',
  stock: 1,
  image: 'https://example.com/product.jpg',
  seller,
});

const responseDouble = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(payload => payload);
  return res;
};

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replicaSet.getUri());
}, 60000);

afterEach(async () => {
  await Product.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
}, 60000);

describe('product bulk mutation transactions', () => {
  test('updates a currency-less legacy product through an exact absent-field CAS snapshot', async () => {
    const productId = new mongoose.Types.ObjectId();
    await Product.collection.insertOne({
      _id: productId,
      name: 'Legacy USD bulk product',
      description: 'Legacy product without native currency metadata',
      price: 10,
      discountedPrice: 0,
      category: 'Other',
      brand: 'Test',
      stock: 1,
      image: 'https://example.com/legacy.jpg',
      seller: null,
    });
    const res = responseDouble();

    await bulkPriceUpdate({
      user: { id: new mongoose.Types.ObjectId().toString(), role: 'admin' },
      body: {
        productIds: [productId.toString()],
        updateType: 'percentage',
        value: 10,
      },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const persisted = await Product.collection.findOne({ _id: productId });
    expect(persisted).toMatchObject({
      price: 11,
      discountedPrice: 0,
      currency: 'USD',
      priceCurrency: 'USD',
      priceInputAmount: 11,
      discountedPriceCurrency: 'USD',
      discountedPriceInputAmount: 0,
      priceVersion: 2,
    });
    expect(persisted.updatedAt).toBeInstanceOf(Date);
  });

  test('rolls back earlier pricing writes when any optimistic filter misses', async () => {
    const [first, second] = await Promise.all([
      createProduct({ suffix: 'first' }),
      createProduct({ suffix: 'second' }),
    ]);
    const updates = [
      {
        updateOne: {
          filter: { _id: first._id, updatedAt: first.updatedAt },
          update: { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } },
        },
      },
      {
        updateOne: {
          filter: { _id: second._id, updatedAt: new Date(0) },
          update: { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } },
        },
      },
    ];

    await expect(__private.writeProductsAtomically(updates)).rejects.toMatchObject({
      status: 409,
      code: 'PRODUCT_PRICE_UPDATE_CONFLICT',
    });

    const persisted = await Product.find({ _id: { $in: [first._id, second._id] } })
      .sort({ _id: 1 })
      .lean();
    expect(persisted).toHaveLength(2);
    expect(persisted.map(product => product.discountedPrice)).toEqual([8, 8]);
  });

  test('seller bulk delete rejects a mixed-ownership selection without deleting its owned subset', async () => {
    const seller = new mongoose.Types.ObjectId();
    const otherSeller = new mongoose.Types.ObjectId();
    const [owned, foreign] = await Promise.all([
      createProduct({ seller, suffix: 'owned' }),
      createProduct({ seller: otherSeller, suffix: 'foreign' }),
    ]);
    const res = responseDouble();

    await bulkDeleteProducts({
      user: { id: seller.toString(), role: 'seller' },
      body: { productIds: [owned._id.toString(), foreign._id.toString()] },
    }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PRODUCT_BULK_SELECTION_INCOMPLETE',
    }));
    expect(await Product.countDocuments({ _id: { $in: [owned._id, foreign._id] } })).toBe(2);
  });

  test('seller bulk delete commits the complete owned selection together', async () => {
    const seller = new mongoose.Types.ObjectId();
    const products = await Promise.all([
      createProduct({ seller, suffix: 'owned-one' }),
      createProduct({ seller, suffix: 'owned-two' }),
    ]);
    const res = responseDouble();

    await bulkDeleteProducts({
      user: { id: seller.toString(), role: 'seller' },
      body: { productIds: products.map(product => product._id.toString()) },
    }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      deletedCount: 2,
      skippedCount: 0,
    }));
    expect(await Product.countDocuments({ _id: { $in: products.map(product => product._id) } })).toBe(0);
  });
});
