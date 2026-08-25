'use strict';

const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const mongoose = require('mongoose');
const {
  CURRENCIES,
  isSupportedCurrency,
  normalizeCurrency,
  getExchangeRateSnapshot,
  convertAmountUsingTrustedRates,
} = require('./currencyService');
const {
  normalizeRepresentableConvertedProductPricing,
  requireStoredProductCurrency,
  requireStoredProductDiscountCurrency,
  requireStoredProductBasePrice,
  requireStoredProductDiscountPrice,
} = require('./productPricingService');
const { runInTransaction } = require('./walletService');

const PRODUCT_CURRENCY_PENDING_STATUS = 'pending_conversion';
const PRODUCT_CURRENCY_ACTIVE_STATUS = 'active';
const SUPPORTED_PRODUCT_CURRENCIES = Object.keys(CURRENCIES);

const matchedCount = result => Number(result?.matchedCount ?? result?.n ?? result?.result?.n ?? 0);

const productCurrencyConflict = (message = 'Product currency settings changed while this write was being prepared. Nothing was saved; refresh and retry.') => {
  const error = new Error(message);
  error.status = 409;
  error.code = 'PRODUCT_CURRENCY_CONVERSION_CONFLICT';
  return error;
};

const storeCurrencyMutationFilter = (store, sellerId) => {
  const filter = { _id: store._id, seller: sellerId };
  const version = Number(store.__v);
  if (Number.isSafeInteger(version) && version >= 0) {
    filter.__v = version;
  } else if (store.updatedAt) {
    filter.updatedAt = store.updatedAt;
  }
  return filter;
};

async function updateStoreCurrencyState(
  store,
  sellerId,
  fields,
  message = 'Product currency settings changed while this request was being saved. Refresh and retry.'
) {
  const updatedStore = await Store.findOneAndUpdate(
    storeCurrencyMutationFilter(store, sellerId),
    {
      $set: fields,
      $inc: { __v: 1 },
    },
    { new: true, runValidators: true }
  );
  if (!updatedStore) throw productCurrencyConflict(message);
  return updatedStore;
}

const COUNTRY_CURRENCY = {
  pakistan: 'PKR',
  pk: 'PKR',
  'united states': 'USD',
  'united states of america': 'USD',
  usa: 'USD',
  us: 'USD',
  america: 'USD',
  'united kingdom': 'GBP',
  uk: 'GBP',
  gb: 'GBP',
  britain: 'GBP',
  england: 'GBP',
  germany: 'EUR',
  france: 'EUR',
  italy: 'EUR',
  spain: 'EUR',
  netherlands: 'EUR',
  belgium: 'EUR',
  ireland: 'EUR',
  portugal: 'EUR',
  austria: 'EUR',
  finland: 'EUR',
  greece: 'EUR',
};

function countryCurrency(country) {
  const key = String(country || '').trim().toLowerCase();
  return COUNTRY_CURRENCY[key] || null;
}

function normalizeProductCurrency(value, fallback = 'USD') {
  const raw = value === undefined ? fallback : value;
  if (typeof raw !== 'string' || !raw.trim() || !isSupportedCurrency(raw)) {
    const error = new Error('Stored product currency metadata is invalid. Use USD, PKR, EUR, or GBP.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
    throw error;
  }
  return normalizeCurrency(raw);
}

function requireSellerProductCurrency(seller) {
  if (!seller || typeof seller.currency !== 'string' || !seller.currency.trim()) {
    const error = new Error(
      'Stored seller currency metadata is invalid. Choose USD, PKR, EUR, or GBP before creating a store.'
    );
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SELLER_CURRENCY_METADATA_INVALID';
    throw error;
  }
  try {
    return normalizeProductCurrency(seller.currency, null);
  } catch (_error) {
    const error = new Error(
      'Stored seller currency metadata is invalid. Choose USD, PKR, EUR, or GBP before creating a store.'
    );
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SELLER_CURRENCY_METADATA_INVALID';
    throw error;
  }
}

function sellerDefaultProductCurrency(store, seller) {
  const sellerCurrency = requireSellerProductCurrency(seller);
  if (store?.productCurrency !== undefined && store?.productCurrency !== null) {
    return normalizeProductCurrency(store.productCurrency);
  }
  // A bank/store address is not a pricing decision. If no explicit store
  // currency exists, retain the seller's authoritative selected currency so a
  // Pakistani seller cannot have PKR products silently relabelled as USD (or
  // vice versa) merely because the store address is in another country.
  return sellerCurrency;
}

async function getProductCurrencyBreakdown(sellerId) {
  const sellerObjectId = mongoose.Types.ObjectId.isValid(sellerId)
    ? new mongoose.Types.ObjectId(sellerId)
    : sellerId;
  const rows = await Product.aggregate([
    { $match: { seller: sellerObjectId } },
    {
      $group: {
        _id: {
          currencyType: { $type: '$currency' },
          currency: '$currency',
          priceCurrencyType: { $type: '$priceCurrency' },
          priceCurrency: '$priceCurrency',
          discountedPriceCurrencyType: { $type: '$discountedPriceCurrency' },
          discountedPriceCurrency: '$discountedPriceCurrency',
          discountedCurrencyType: { $type: '$discountedCurrency' },
          discountedCurrency: '$discountedCurrency',
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const counts = {};
  for (const row of rows) {
    // Keep compatibility with the old scalar aggregate shape in rolling
    // deployments/tests, while validating every persisted currency field in
    // the new shape. Mongo's $type lets us distinguish a missing legacy field
    // from an explicitly stored null/blank value.
    const aggregateMetadata = row?._id && typeof row._id === 'object' && !Array.isArray(row._id)
      ? row._id
      : null;
    let currency;
    if (aggregateMetadata) {
      const productMetadata = {};
      for (const field of [
        'currency',
        'priceCurrency',
        'discountedPriceCurrency',
        'discountedCurrency',
      ]) {
        const fieldType = aggregateMetadata[`${field}Type`];
        if (fieldType !== 'missing' && (
          fieldType !== undefined
          || Object.prototype.hasOwnProperty.call(aggregateMetadata, field)
        )) {
          productMetadata[field] = aggregateMetadata[field];
        }
      }
      currency = requireStoredProductCurrency(productMetadata, 'USD');
      requireStoredProductDiscountCurrency(productMetadata, currency);
    } else {
      currency = normalizeProductCurrency(row._id);
    }
    counts[currency] = (counts[currency] || 0) + row.count;
  }

  return {
    productCount: rows.reduce((sum, row) => sum + row.count, 0),
    productCurrencies: Object.keys(counts),
    productCurrencyCounts: counts,
  };
}

async function getSellerProductCurrencyState(sellerId, options = {}) {
  const [store, seller] = await Promise.all([
    options.store || Store.findOne({ seller: sellerId }),
    options.seller || User.findById(sellerId).select('currency').lean(),
  ]);
  // A corrupt account currency must not be hidden by a valid Store/country or
  // by a one-currency product aggregate. It remains a persisted money input.
  normalizeProductCurrency(seller?.currency, 'USD');

  if (!store) {
    const fallbackCurrency = normalizeProductCurrency(seller?.currency, 'USD');
    return {
      hasStore: false,
      activeCurrency: fallbackCurrency,
      status: PRODUCT_CURRENCY_ACTIVE_STATUS,
      pendingCurrency: null,
      previousCurrency: null,
      productCount: 0,
      productCurrencies: [],
      productCurrencyCounts: {},
      canAddProduct: false,
    };
  }

  const breakdown = await getProductCurrencyBreakdown(sellerId);
  const inferredCurrency = breakdown.productCurrencies.length === 1
    ? breakdown.productCurrencies[0]
    : sellerDefaultProductCurrency(store, seller);
  // Store.productCurrency=null is the schema's explicit uninitialized state;
  // infer it once. Blank or otherwise corrupt persisted values fail closed.
  const activeCurrency = store.productCurrency === null || store.productCurrency === undefined
    ? normalizeProductCurrency(inferredCurrency)
    : normalizeProductCurrency(store.productCurrency);
  const pendingCurrency = store.pendingProductCurrency !== null && store.pendingProductCurrency !== undefined
    ? normalizeProductCurrency(store.pendingProductCurrency)
    : null;
  const previousCurrency = store.previousProductCurrency !== null && store.previousProductCurrency !== undefined
    ? normalizeProductCurrency(store.previousProductCurrency)
    : null;
  const status = store.productCurrencyStatus === PRODUCT_CURRENCY_PENDING_STATUS && pendingCurrency
    ? PRODUCT_CURRENCY_PENDING_STATUS
    : PRODUCT_CURRENCY_ACTIVE_STATUS;

  return {
    hasStore: true,
    activeCurrency,
    status,
    pendingCurrency: status === PRODUCT_CURRENCY_PENDING_STATUS ? pendingCurrency : null,
    previousCurrency: status === PRODUCT_CURRENCY_PENDING_STATUS ? (previousCurrency || activeCurrency) : null,
    productCount: breakdown.productCount,
    productCurrencies: breakdown.productCurrencies,
    productCurrencyCounts: breakdown.productCurrencyCounts,
    canAddProduct: status !== PRODUCT_CURRENCY_PENDING_STATUS,
    message: status === PRODUCT_CURRENCY_PENDING_STATUS
      ? `Product currency change from ${previousCurrency || activeCurrency} to ${pendingCurrency} is pending. Convert existing product prices or cancel the change before adding new products.`
      : '',
  };
}

async function ensureStoreProductCurrencyInitialized(sellerId, options = {}) {
  let store = options.store || await Store.findOne({ seller: sellerId });
  if (!store) return getSellerProductCurrencyState(sellerId, options);

  const seller = options.seller || await User.findById(sellerId).select('currency').lean();
  const state = await getSellerProductCurrencyState(sellerId, { store, seller });
  if (!store.productCurrency || store.productCurrencyStatus !== state.status) {
    store = await updateStoreCurrencyState(store, sellerId, {
      productCurrency: state.activeCurrency,
      productCurrencyStatus: state.status,
      ...(state.status === PRODUCT_CURRENCY_ACTIVE_STATUS ? {
        pendingProductCurrency: null,
        previousProductCurrency: null,
      } : {}),
    });
  }
  return getSellerProductCurrencyState(sellerId, { store, seller });
}

async function requestProductCurrencyChange(sellerId, requestedCurrency, { confirm = false } = {}) {
  if (typeof requestedCurrency !== 'string' || !requestedCurrency.trim() || !isSupportedCurrency(requestedCurrency)) {
    const error = new Error('Choose a supported product currency: USD, PKR, EUR, or GBP.');
    error.status = 400;
    throw error;
  }
  const targetCurrency = normalizeProductCurrency(requestedCurrency);
  let store = await Store.findOne({ seller: sellerId });
  if (!store) {
    const error = new Error('Store not found. Please create a store first.');
    error.status = 404;
    throw error;
  }

  await ensureStoreProductCurrencyInitialized(sellerId, { store });
  // Initialization itself is an optimistic write. Re-read its exact version so
  // a following request mutation never relies on a stale __v/updatedAt token.
  store = await Store.findOne({ seller: sellerId });
  const state = await getSellerProductCurrencyState(sellerId, { store });
  if (state.status === PRODUCT_CURRENCY_PENDING_STATUS) {
    if (!confirm && targetCurrency !== state.pendingCurrency) {
      return {
        ...state,
        requiresConfirmation: true,
        requestedCurrency: targetCurrency,
        msg: `You already have a pending product currency change from ${state.previousCurrency} to ${state.pendingCurrency}. Confirm to replace it with ${targetCurrency}, or cancel the current change first.`,
      };
    }

    if (confirm && targetCurrency !== state.pendingCurrency) {
      store = await updateStoreCurrencyState(store, sellerId, {
        pendingProductCurrency: targetCurrency,
        previousProductCurrency: state.previousCurrency || state.activeCurrency,
        productCurrencyStatus: PRODUCT_CURRENCY_PENDING_STATUS,
        productCurrencyChangedAt: new Date(),
      });
    }
    return getSellerProductCurrencyState(sellerId, { store });
  }

  if (targetCurrency === state.activeCurrency) {
    if (
      store.productCurrency !== targetCurrency
      || store.productCurrencyStatus !== PRODUCT_CURRENCY_ACTIVE_STATUS
      || store.pendingProductCurrency
      || store.previousProductCurrency
    ) {
      store = await updateStoreCurrencyState(store, sellerId, {
        productCurrency: targetCurrency,
        productCurrencyStatus: PRODUCT_CURRENCY_ACTIVE_STATUS,
        pendingProductCurrency: null,
        previousProductCurrency: null,
      });
    }
    return getSellerProductCurrencyState(sellerId, { store });
  }

  if (state.productCount > 0 && !confirm) {
    return {
      ...state,
      requiresConfirmation: true,
      requestedCurrency: targetCurrency,
      msg: `You have added products in ${state.activeCurrency}. To switch product currency to ${targetCurrency}, you must convert existing product prices from the Products tab before adding more products.`,
    };
  }

  if (state.productCount === 0) {
    store = await updateStoreCurrencyState(
      store,
      sellerId,
      {
        productCurrency: targetCurrency,
        productCurrencyStatus: PRODUCT_CURRENCY_ACTIVE_STATUS,
        pendingProductCurrency: null,
        previousProductCurrency: null,
        productCurrencyChangedAt: new Date(),
      },
      'A product or product-currency setting changed at the same time. Nothing was saved; refresh and retry.'
    );
    return getSellerProductCurrencyState(sellerId, { store });
  }

  store = await updateStoreCurrencyState(store, sellerId, {
    productCurrency: state.activeCurrency,
    previousProductCurrency: state.activeCurrency,
    pendingProductCurrency: targetCurrency,
    productCurrencyStatus: PRODUCT_CURRENCY_PENDING_STATUS,
    productCurrencyChangedAt: new Date(),
  });
  return getSellerProductCurrencyState(sellerId, { store });
}

async function cancelPendingProductCurrencyChange(sellerId) {
  let store = await Store.findOne({ seller: sellerId });
  if (!store) {
    const error = new Error('Store not found. Please create a store first.');
    error.status = 404;
    throw error;
  }
  const state = await getSellerProductCurrencyState(sellerId, { store });
  if (state.status !== PRODUCT_CURRENCY_PENDING_STATUS) return state;
  const fallback = normalizeProductCurrency(state.previousCurrency ?? state.activeCurrency ?? 'USD');
  store = await updateStoreCurrencyState(
    store,
    sellerId,
    {
      productCurrency: fallback,
      productCurrencyStatus: PRODUCT_CURRENCY_ACTIVE_STATUS,
      pendingProductCurrency: null,
      previousProductCurrency: null,
      productCurrencyChangedAt: new Date(),
    },
    'Product currency conversion finished or changed while cancellation was being saved. Refresh to see the current currency.'
  );
  return getSellerProductCurrencyState(sellerId, { store });
}

async function convertPendingProductPrices(sellerId) {
  const store = await Store.findOne({ seller: sellerId });
  if (!store) {
    const error = new Error('Store not found. Please create a store first.');
    error.status = 404;
    throw error;
  }
  const state = await getSellerProductCurrencyState(sellerId, { store });
  if (state.status !== PRODUCT_CURRENCY_PENDING_STATUS || !state.pendingCurrency) {
    return { converted: 0, state };
  }

  const targetCurrency = state.pendingCurrency;
  const products = await Product.find({ seller: sellerId });
  // A legacy discount may be denominated differently from its base price, so
  // validate each raw amount independently and compare only after conversion.
  products.forEach((product) => {
    requireStoredProductBasePrice(product);
    requireStoredProductDiscountPrice(product);
  });
  const needsConversion = products.some(product => (
    requireStoredProductCurrency(product, 'USD') !== targetCurrency
    || (
      requireStoredProductDiscountPrice(product) > 0
      && requireStoredProductDiscountCurrency(
        product,
        requireStoredProductCurrency(product, 'USD')
      ) !== targetCurrency
    )
  ));
  const rateSnapshot = needsConversion ? await getExchangeRateSnapshot() : null;
  if (rateSnapshot?.fallback) {
    const error = new Error('Live exchange rates are temporarily unavailable. No product prices were changed. Please retry shortly.');
    error.status = 503;
    error.code = 'EXCHANGE_RATES_UNAVAILABLE';
    throw error;
  }
  const operations = [];
  for (const product of products) {
    const sourceCurrency = requireStoredProductCurrency(product, 'USD');
    const discountedSourceCurrency = requireStoredProductDiscountCurrency(product, sourceCurrency);
    const nextPrice = await convertAmountUsingTrustedRates(product.price, sourceCurrency, targetCurrency, rateSnapshot);
    const nextDiscountedPrice = requireStoredProductDiscountPrice(product) > 0
      ? await convertAmountUsingTrustedRates(
        product.discountedPrice,
        discountedSourceCurrency,
        targetCurrency,
        rateSnapshot
      )
      : 0;
    const { price, discountedPrice } = normalizeRepresentableConvertedProductPricing({
      sourcePrice: product.price,
      convertedPrice: nextPrice,
      sourceDiscountedPrice: product.discountedPrice,
      convertedDiscountedPrice: nextDiscountedPrice,
      sourceCurrency,
      targetCurrency,
      productLabel: product.name || `Product ${product._id}`,
    });
    operations.push({
      updateOne: {
        filter: {
          _id: product._id,
          seller: sellerId,
          ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}),
        },
        update: {
          $set: {
            price,
            discountedPrice,
            currency: targetCurrency,
            priceCurrency: targetCurrency,
            priceInputAmount: price,
            discountedPriceCurrency: targetCurrency,
            discountedPriceInputAmount: discountedPrice,
            priceVersion: 2,
          },
        },
      },
    });
  }

  await runInTransaction(async session => {
    const lockResult = await Store.updateOne(
      {
        _id: store._id,
        seller: sellerId,
        productCurrencyStatus: PRODUCT_CURRENCY_PENDING_STATUS,
        pendingProductCurrency: targetCurrency,
        ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
      },
      { $inc: { __v: 1 } },
      { session }
    );
    if (matchedCount(lockResult) !== 1) {
      throw productCurrencyConflict('Product currency settings changed during conversion. No prices were changed; refresh and retry.');
    }
    if (operations.length) {
      const result = await Product.bulkWrite(operations, { session });
      if (Number(result.matchedCount) !== operations.length) {
        throw productCurrencyConflict('A product changed while prices were being converted. No prices were changed; refresh and retry.');
      }
    }
    const result = await Store.updateOne(
      {
        _id: store._id,
        seller: sellerId,
        productCurrencyStatus: PRODUCT_CURRENCY_PENDING_STATUS,
        pendingProductCurrency: targetCurrency,
      },
      {
        $set: {
          productCurrency: targetCurrency,
          productCurrencyStatus: PRODUCT_CURRENCY_ACTIVE_STATUS,
          pendingProductCurrency: null,
          previousProductCurrency: null,
          productCurrencyChangedAt: new Date(),
        },
      },
      { session }
    );
    if (Number(result.matchedCount) !== 1) {
      throw productCurrencyConflict('Product currency settings changed during conversion. No prices were changed; refresh and retry.');
    }
  });

  const updatedStore = await Store.findOne({ seller: sellerId });

  return {
    converted: operations.length,
    state: await getSellerProductCurrencyState(sellerId, { store: updatedStore }),
  };
}

async function withProductCurrencyWriteLock(sellerId, expectedCurrency, work) {
  const currency = normalizeProductCurrency(expectedCurrency);
  return runInTransaction(async session => {
    const query = Store.findOne({ seller: sellerId })
      .select('_id seller productCurrency productCurrencyStatus pendingProductCurrency updatedAt')
      .lean();
    if (session) query.session(session);
    const store = await query;
    if (!store) {
      const error = new Error('Store not found. Please create a store first.');
      error.status = 404;
      throw error;
    }
    if (
      store.productCurrencyStatus === PRODUCT_CURRENCY_PENDING_STATUS
      || normalizeProductCurrency(store.productCurrency) !== currency
    ) {
      throw productCurrencyConflict();
    }
    const lockResult = await Store.updateOne(
      {
        _id: store._id,
        seller: sellerId,
        productCurrency: currency,
        productCurrencyStatus: PRODUCT_CURRENCY_ACTIVE_STATUS,
        ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
      },
      { $inc: { __v: 1 } },
      { session }
    );
    if (matchedCount(lockResult) !== 1) throw productCurrencyConflict();
    return work(session);
  });
}

async function assertProductCreationAllowed(sellerId) {
  const state = await ensureStoreProductCurrencyInitialized(sellerId);
  if (!state.hasStore) {
    const error = new Error('You must create a store before adding products. Go to Store Settings to set up your store.');
    error.status = 403;
    error.productCurrencyState = state;
    throw error;
  }
  if (!state.canAddProduct) {
    const error = new Error(state.message || 'Convert existing product prices or cancel the pending product currency change before adding new products.');
    error.status = 409;
    error.productCurrencyState = state;
    throw error;
  }
  return state;
}

module.exports = {
  PRODUCT_CURRENCY_ACTIVE_STATUS,
  PRODUCT_CURRENCY_PENDING_STATUS,
  SUPPORTED_PRODUCT_CURRENCIES,
  countryCurrency,
  normalizeProductCurrency,
  requireSellerProductCurrency,
  sellerDefaultProductCurrency,
  getSellerProductCurrencyState,
  ensureStoreProductCurrencyInitialized,
  requestProductCurrencyChange,
  cancelPendingProductCurrencyChange,
  convertPendingProductPrices,
  withProductCurrencyWriteLock,
  assertProductCreationAllowed,
};
