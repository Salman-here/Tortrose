'use strict';

const Store = require('../models/Store');
const User = require('../models/User');

const ACTIVE_STORE_QUERY = {
  isActive: true,
  blockedAt: null,
};

const normalizeId = (value) => {
  const id = value?._id || value;
  return id ? String(id) : '';
};

async function getActiveSellerIds(extraStoreFilter = {}) {
  const stores = await Store.find({ ...ACTIVE_STORE_QUERY, ...extraStoreFilter })
    .select('seller')
    .lean();
  const sellerIds = stores.map(store => store.seller).filter(Boolean);
  if (!sellerIds.length) return [];
  const activeSellers = await User.find({
    _id: { $in: sellerIds },
    role: 'seller',
    status: 'active',
  }).select('_id').lean();
  return activeSellers.map(seller => seller._id);
}

function activeStoreQuery(extra = {}) {
  return { ...ACTIVE_STORE_QUERY, ...extra };
}

function applyActiveSellerProductFilter(productFilter = {}, activeSellerIds = []) {
  const visibilityFilter = {
    $or: [
      { seller: null },
      { seller: { $exists: false } },
      { seller: { $in: activeSellerIds } },
    ],
  };
  return {
    ...productFilter,
    $and: [
      ...(Array.isArray(productFilter.$and) ? productFilter.$and : []),
      visibilityFilter,
    ],
  };
}

async function publicProductFilterWithActiveStores(productFilter = {}, extraStoreFilter = {}) {
  const activeSellerIds = await getActiveSellerIds(extraStoreFilter);
  return applyActiveSellerProductFilter(productFilter, activeSellerIds);
}

async function isProductSellerPubliclyActive(sellerId) {
  const id = normalizeId(sellerId);
  if (!id) return true;
  const [store, seller] = await Promise.all([
    Store.exists(activeStoreQuery({ seller: id })),
    User.exists({ _id: id, role: 'seller', status: 'active' }),
  ]);
  return Boolean(store && seller);
}

async function findActiveStore(filter = {}, options = {}) {
  const query = activeStoreQuery(filter);
  let cursor = Store.findOne(query);
  if (options.select) cursor = cursor.select(options.select);
  if (options.populate) cursor = cursor.populate(options.populate);
  if (options.lean !== false) cursor = cursor.lean();
  const store = await cursor;
  if (!store) return null;
  const sellerId = normalizeId(store.seller);
  if (!sellerId) return null;
  const activeSeller = await User.exists({ _id: sellerId, role: 'seller', status: 'active' });
  return activeSeller ? store : null;
}

module.exports = {
  ACTIVE_STORE_QUERY,
  activeStoreQuery,
  applyActiveSellerProductFilter,
  findActiveStore,
  getActiveSellerIds,
  isProductSellerPubliclyActive,
  publicProductFilterWithActiveStores,
};
