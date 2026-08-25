'use strict';

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { normalizeNativeProductPricing } = require('./productPricingService');

const productProjection = {
  name: 1,
  brand: 1,
  category: 1,
  image: 1,
  images: 1,
  price: 1,
  discountedPrice: 1,
  currency: 1,
  priceCurrency: 1,
  discountedPriceCurrency: 1,
  discountedCurrency: 1,
  stock: 1,
  rating: 1,
  numReviews: 1,
  isFeatured: 1,
  createdAt: 1,
};

const inventoryDataError = label => {
  const error = new Error(`Stored seller inventory ${label} is invalid. Refresh or correct the affected products before using analytics.`);
  error.code = 'SELLER_INVENTORY_DATA_INVALID';
  error.statusCode = 409;
  return error;
};

const requireCount = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw inventoryDataError(label);
  return value;
};

const normalizePreviewProduct = (product) => {
  const pricing = normalizeNativeProductPricing(product, 'USD');
  if (!Number.isSafeInteger(product?.stock) || product.stock < 0) {
    throw inventoryDataError('product stock');
  }
  const rating = product.rating === undefined ? 0 : product.rating;
  const numReviews = product.numReviews === undefined ? 0 : product.numReviews;
  const isFeatured = product.isFeatured === undefined ? false : product.isFeatured;
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5) {
    throw inventoryDataError('product rating');
  }
  if (!Number.isSafeInteger(numReviews) || numReviews < 0) {
    throw inventoryDataError('product review count');
  }
  if (typeof isFeatured !== 'boolean') throw inventoryDataError('product featured state');
  return { ...pricing, stock: product.stock, rating, numReviews, isFeatured };
};

const normalizeCategoryRows = (rows, totalProducts) => {
  if (!Array.isArray(rows) || rows.length > 5) throw inventoryDataError('category summary');
  let total = 0n;
  const normalized = rows.map((row) => {
    if (typeof row?.category !== 'string' || !row.category.trim()) {
      throw inventoryDataError('category name');
    }
    const count = requireCount(row.count, 'category count');
    if (count === 0) throw inventoryDataError('category count');
    total += BigInt(count);
    return { category: row.category, count };
  });
  if (total > BigInt(totalProducts)) throw inventoryDataError('category totals');
  return normalized;
};

const sellerObjectId = sellerId => {
  if (!mongoose.isValidObjectId(sellerId)) {
    const error = new Error('Seller id is invalid.');
    error.code = 'SELLER_ID_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return new mongoose.Types.ObjectId(String(sellerId));
};

/** One bounded aggregation replaces downloading every catalog page merely to
 * calculate dashboard inventory cards. Full products remain paginated on the
 * product-management route. */
async function getSellerInventoryOverview(sellerId) {
  const [result] = await Product.aggregate([
    { $match: { seller: sellerObjectId(sellerId) } },
    {
      $facet: {
        summary: [{
          $group: {
            _id: null,
            totalProducts: { $sum: 1 },
            outOfStock: { $sum: { $cond: [{ $eq: ['$stock', 0] }, 1, 0] } },
            lowStock: {
              $sum: {
                $cond: [{ $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', 10] }] }, 1, 0],
              },
            },
            featuredProducts: { $sum: { $cond: ['$isFeatured', 1, 0] } },
          },
        }],
        categories: [
          { $match: { category: { $type: 'string', $ne: '' } } },
          { $group: { _id: '$category', count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 5 },
          { $project: { _id: 0, category: '$_id', count: 1 } },
        ],
        recentProducts: [
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 5 },
          { $project: productProjection },
        ],
        topRatedProducts: [
          { $match: { rating: { $gte: 4 } } },
          { $sort: { rating: -1, numReviews: -1, _id: 1 } },
          { $limit: 4 },
          { $project: productProjection },
        ],
        invalidInventory: [
          {
            $match: {
              $expr: {
                $or: [
                  { $not: [{ $isNumber: '$stock' }] },
                  {
                    $cond: [
                      { $isNumber: '$stock' },
                      {
                        $or: [
                          { $lt: ['$stock', 0] },
                          { $gt: ['$stock', Number.MAX_SAFE_INTEGER] },
                          { $ne: ['$stock', { $trunc: '$stock' }] },
                        ],
                      },
                      false,
                    ],
                  },
                  { $not: [{ $in: [{ $type: '$isFeatured' }, ['bool', 'missing']] }] },
                ],
              },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
      },
    },
  ]);
  if (
    !result
    || !Array.isArray(result.summary)
    || !Array.isArray(result.categories)
    || !Array.isArray(result.recentProducts)
    || !Array.isArray(result.topRatedProducts)
    || !Array.isArray(result.invalidInventory)
  ) throw inventoryDataError('aggregation result');
  if (result.invalidInventory.length) throw inventoryDataError('stock or featured metadata');
  const summary = result.summary[0];
  if (!summary) {
    if (
      result.categories.length
      || result.recentProducts.length
      || result.topRatedProducts.length
    ) throw inventoryDataError('empty aggregation result');
    return {
      totalProducts: 0,
      outOfStock: 0,
      lowStock: 0,
      featuredProducts: 0,
      categories: [],
      recentProducts: [],
      topRatedProducts: [],
    };
  }
  const totalProducts = requireCount(summary.totalProducts, 'total product count');
  const outOfStock = requireCount(summary.outOfStock, 'out-of-stock count');
  const lowStock = requireCount(summary.lowStock, 'low-stock count');
  const featuredProducts = requireCount(summary.featuredProducts, 'featured count');
  if (
    BigInt(outOfStock) + BigInt(lowStock) > BigInt(totalProducts)
    || featuredProducts > totalProducts
  ) {
    throw inventoryDataError('summary totals');
  }
  return {
    totalProducts,
    outOfStock,
    lowStock,
    featuredProducts,
    categories: normalizeCategoryRows(result.categories, totalProducts),
    recentProducts: result.recentProducts.map(normalizePreviewProduct),
    topRatedProducts: result.topRatedProducts.map(normalizePreviewProduct),
  };
}

module.exports = { getSellerInventoryOverview };
