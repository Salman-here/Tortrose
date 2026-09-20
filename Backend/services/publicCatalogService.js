'use strict';

const Store = require('../models/Store');
const User = require('../models/User');
const { AsyncLocalStorage } = require('node:async_hooks');
const { findVisibleStores, isStoreVisibleToBuyer, normalizeBuyerLocation } = require('./storeVisibilityService');
const buyerCatalogScope = new AsyncLocalStorage();
const withBuyerCatalogLocation = (location, work) => buyerCatalogScope.run(normalizeBuyerLocation(location), work);
const storeMatchesBuyerCatalogScope = store => !buyerCatalogScope.getStore() || isStoreVisibleToBuyer(store, buyerCatalogScope.getStore());
const {
  PROTECTED_STORE_SLUG_PATTERN,
  STORE_SLUG_PATTERN,
} = require('../utils/storeSlug');

const ACTIVE_STORE_QUERY = {
  isActive: true,
  blockedAt: null,
};

const PUBLIC_STORE_SLUG_CLAUSE = {
  storeSlug: {
    $regex: STORE_SLUG_PATTERN,
    $not: PROTECTED_STORE_SLUG_PATTERN,
  },
};

const normalizeId = (value) => {
  const id = value?._id || value;
  return id ? String(id) : '';
};

async function getActiveSellerIds(extraStoreFilter = {}) {
  if (buyerCatalogScope.getStore()) {
    const stores = await findVisibleStores(Store, activeStoreQuery(extraStoreFilter), buyerCatalogScope.getStore(), { select: 'seller' });
    return stores.map(store => store.seller).filter(Boolean);
  }
  const stores = await Store.find(activeStoreQuery(extraStoreFilter))
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
  const { $and: extraAnd = [], ...rest } = extra || {};
  return {
    ...rest,
    ...ACTIVE_STORE_QUERY,
    $and: [
      ...(Array.isArray(extraAnd) ? extraAnd : [extraAnd]).filter(Boolean),
      PUBLIC_STORE_SLUG_CLAUSE,
    ],
  };
}

function applyActiveSellerProductFilter(productFilter = {}, activeSellerIds = []) {
  const visibilityFilter = {
    $or: [
      ...(!buyerCatalogScope.getStore() || buyerCatalogScope.getStore().mode === 'global'
        ? [{ seller: null }, { seller: { $exists: false } }] : []),
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
  if (!id) return !buyerCatalogScope.getStore() || buyerCatalogScope.getStore().mode === 'global';
  const [store, seller] = await Promise.all([
    buyerCatalogScope.getStore()
      ? Store.findOne(activeStoreQuery({ seller: id })).select('visibility address').lean()
      : Store.exists(activeStoreQuery({ seller: id })),
    User.exists({ _id: id, role: 'seller', status: 'active' }),
  ]);
  return Boolean(store && seller && storeMatchesBuyerCatalogScope(store));
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
  withBuyerCatalogLocation,
  storeMatchesBuyerCatalogScope,
  ACTIVE_STORE_QUERY,
  PUBLIC_STORE_SLUG_CLAUSE,
  activeStoreQuery,
  applyActiveSellerProductFilter,
  findActiveStore,
  getActiveSellerIds,
  isProductSellerPubliclyActive,
  publicProductFilterWithActiveStores,
};
