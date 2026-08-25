'use strict';

require('dotenv').config();

const crypto = require('crypto');
const os = require('os');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductCurrencyMigration = require('../models/ProductCurrencyMigration');
const Store = require('../models/Store');
const User = require('../models/User');
const {
  normalizeCurrency,
  isSupportedCurrency,
  getExchangeRateSnapshot,
  convertAmountUsingTrustedRates,
  exchangeRatesUnavailableError,
  normalizeRates,
} = require('../services/currencyService');
const {
  normalizeRepresentableConvertedProductPricing,
} = require('../services/productPricingService');

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
const LEASE_DURATION_MS = 10 * 60 * 1000;
const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;

const argumentValue = (argv, name) => {
  const prefix = `${name}=`;
  const inline = argv.find(argument => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const parsePositiveInteger = (value, { name, maximum = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a whole number between 1 and ${maximum}.`);
  }
  return parsed;
};

function parseArguments(argv = []) {
  const write = argv.includes('--write');
  const force = argv.includes('--force');
  const migrationId = String(argumentValue(argv, '--migration-id') || '').trim();
  const batchSizeValue = argumentValue(argv, '--batch-size');
  const maxBatchesValue = argumentValue(argv, '--max-batches');

  if (write && !MIGRATION_ID_PATTERN.test(migrationId)) {
    const error = new Error('Write mode requires --migration-id=<8-100 character stable id>.');
    error.code = 'PRODUCT_CURRENCY_MIGRATION_ID_REQUIRED';
    throw error;
  }
  if (!write && migrationId) {
    const error = new Error('--migration-id is reserved for durable write/resume runs; omit it for a read-only dry run.');
    error.code = 'PRODUCT_CURRENCY_DRY_RUN_MUST_NOT_CHECKPOINT';
    throw error;
  }
  if (write && force && !argv.includes('--acknowledge-force')) {
    const error = new Error('Force write mode requires --acknowledge-force because it rewrites already-versioned products.');
    error.code = 'PRODUCT_CURRENCY_FORCE_ACK_REQUIRED';
    throw error;
  }

  return {
    write,
    force,
    migrationId: migrationId || null,
    batchSize: batchSizeValue === undefined
      ? DEFAULT_BATCH_SIZE
      : parsePositiveInteger(batchSizeValue, { name: '--batch-size', maximum: MAX_BATCH_SIZE }),
    maxBatches: maxBatchesValue === undefined
      ? null
      : parsePositiveInteger(maxBatchesValue, { name: '--max-batches' }),
    verbose: argv.includes('--verbose'),
  };
}

const toId = value => value?._id?.toString?.() || value?.toString?.() || '';
const hasFiniteMoney = value => value !== null
  && value !== undefined
  && Number.isFinite(Number(value));
const supportedCurrency = value => (
  isSupportedCurrency(value) ? normalizeCurrency(value) : null
);
const matchedCount = result => Number(result?.matchedCount ?? result?.nMatched ?? result?.n ?? 0);

// Mongoose hydrates absent currency fields with the schema's USD default.
// `$isDefault` lets the migration distinguish that legacy absence from an
// explicitly stored USD value.
const explicitProductField = (product, field) => {
  if (typeof product?.$isDefault === 'function' && product.$isDefault(field)) return undefined;
  return product?.[field];
};

const migrationConflict = (message) => {
  const error = new Error(message || 'A product or store changed while the migration was being prepared.');
  error.code = 'PRODUCT_CURRENCY_MIGRATION_CONFLICT';
  return error;
};

function describeProductMigration(product, { store = null, seller = null } = {}) {
  if (store && store.productCurrencyStatus === 'pending_conversion') {
    throw migrationConflict(`Store ${store._id} has a pending product-currency change; finish or cancel it before migration.`);
  }

  const explicitPriceCurrency = supportedCurrency(explicitProductField(product, 'priceCurrency'));
  const explicitProductCurrency = supportedCurrency(explicitProductField(product, 'currency'));
  const metadataCurrency = explicitPriceCurrency || explicitProductCurrency;
  const storeCurrency = supportedCurrency(store?.productCurrency);
  const sellerFallbackCurrency = supportedCurrency(seller?.currency);

  // Store.productCurrency is the current authority. Product metadata comes
  // next for orphaned products. User.currency is only a final compatibility
  // fallback when no store and no explicit product currency exist; it is an
  // account display preference and must never override store state.
  const targetCurrency = storeCurrency
    || metadataCurrency
    || sellerFallbackCurrency
    || 'USD';
  const hasNativeMetadata = hasFiniteMoney(product.priceInputAmount);
  const hasLegacyOriginal = hasFiniteMoney(product.priceOriginal);

  if (hasNativeMetadata) {
    return {
      product,
      store,
      seller,
      targetCurrency,
      priceAmount: Number(product.priceInputAmount),
      priceSourceCurrency: metadataCurrency || targetCurrency,
      discountedAmount: hasFiniteMoney(product.discountedPriceInputAmount)
        ? Number(product.discountedPriceInputAmount)
        : 0,
      discountedSourceCurrency: supportedCurrency(explicitProductField(product, 'discountedPriceCurrency'))
        || metadataCurrency
        || targetCurrency,
    };
  }

  if (hasLegacyOriginal) {
    return {
      product,
      store,
      seller,
      targetCurrency,
      priceAmount: Number(product.priceOriginal),
      priceSourceCurrency: metadataCurrency || targetCurrency,
      discountedAmount: hasFiniteMoney(product.discountedPriceOriginal)
        ? Number(product.discountedPriceOriginal)
        : 0,
      discountedSourceCurrency: supportedCurrency(explicitProductField(product, 'discountedPriceCurrency'))
        || metadataCurrency
        || targetCurrency,
    };
  }

  // Records without either native-input field came from the former
  // USD-normalized representation. Their stored numeric price is USD even
  // when a schema default now makes a missing currency look explicit.
  return {
    product,
    store,
    seller,
    targetCurrency,
    priceAmount: Number(product.price),
    priceSourceCurrency: 'USD',
    discountedAmount: Number(product.discountedPrice || 0),
    discountedSourceCurrency: 'USD',
  };
}

async function buildMigrationPlan(products, {
  storesBySeller = new Map(),
  sellersById = new Map(),
  rateSnapshot = null,
  migratedAt = new Date(),
} = {}) {
  const descriptions = products.map(product => {
    const sellerId = toId(product.seller);
    return describeProductMigration(product, {
      store: storesBySeller.get(sellerId) || null,
      seller: sellersById.get(sellerId) || null,
    });
  });
  const needsFX = descriptions.some(description => (
    description.priceSourceCurrency !== description.targetCurrency
    || (
      description.discountedAmount > 0
      && description.discountedSourceCurrency !== description.targetCurrency
    )
  ));
  const snapshot = needsFX
    ? (rateSnapshot || await getExchangeRateSnapshot())
    : rateSnapshot;

  if (needsFX && (snapshot?.fallback || !normalizeRates(snapshot?.rates))) {
    const error = exchangeRatesUnavailableError();
    error.message = 'Live exchange rates are unavailable. No product prices were migrated.';
    throw error;
  }

  const plan = [];
  for (const description of descriptions) {
    const {
      product,
      targetCurrency,
      priceAmount,
      priceSourceCurrency,
      discountedAmount,
      discountedSourceCurrency,
    } = description;
    const convertedPrice = await convertAmountUsingTrustedRates(
      priceAmount,
      priceSourceCurrency,
      targetCurrency,
      snapshot
    );
    const convertedDiscount = discountedAmount > 0
      ? await convertAmountUsingTrustedRates(
        discountedAmount,
        discountedSourceCurrency,
        targetCurrency,
        snapshot
      )
      : 0;
    const { price: nextPrice, discountedPrice: nextDiscountedPrice } = (
      normalizeRepresentableConvertedProductPricing({
        sourcePrice: priceAmount,
        convertedPrice,
        sourceDiscountedPrice: discountedAmount,
        convertedDiscountedPrice: convertedDiscount,
        sourceCurrency: priceSourceCurrency,
        targetCurrency,
        productLabel: product.name || `Product ${product._id}`,
      })
    );

    plan.push({
      product,
      store: description.store,
      seller: description.seller,
      sourcePrice: product.price,
      targetCurrency,
      update: {
        price: nextPrice,
        discountedPrice: nextDiscountedPrice,
        currency: targetCurrency,
        priceCurrency: targetCurrency,
        priceInputAmount: nextPrice,
        discountedPriceCurrency: targetCurrency,
        discountedPriceInputAmount: nextDiscountedPrice,
        priceVersion: 2,
        priceMigratedAt: migratedAt,
      },
    });
  }

  return { plan, rateSnapshot: snapshot, needsFX };
}

function groupMigrationPlan(plan, { batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const boundedBatchSize = parsePositiveInteger(batchSize, {
    name: 'batchSize',
    maximum: MAX_BATCH_SIZE,
  });
  const groups = new Map();
  for (const entry of plan) {
    const storeId = toId(entry.store?._id);
    const sellerId = toId(entry.product?.seller);
    // One seller/store per transaction keeps its currency authority locked for
    // every product it owns without putting the whole marketplace in one
    // long-running Mongo transaction.
    const key = storeId ? `store:${storeId}` : sellerId ? `seller:${sellerId}` : `product:${toId(entry.product?._id)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()].flatMap(group => {
    const batches = [];
    for (let index = 0; index < group.length; index += boundedBatchSize) {
      batches.push(group.slice(index, index + boundedBatchSize));
    }
    return batches;
  });
}

async function executeMigrationBatch(plan, {
  checkpoint = null,
  checkpointUpdate = null,
  authority = null,
} = {}) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_BATCH_SIZE) {
    throw new Error(`A migration transaction must contain between 1 and ${MAX_BATCH_SIZE} products.`);
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const stores = [...new Map(
        plan.filter(entry => entry.store).map(entry => [toId(entry.store._id), entry.store])
      ).values()];

      for (const store of stores) {
        const pinnedStoreCurrency = authority?.kind === 'store'
          ? authority.storeCurrency
          : store.productCurrency;
        const result = await Store.updateOne(
          {
            _id: store._id,
            seller: authority?.sellerId || store.seller,
            productCurrency: pinnedStoreCurrency,
            productCurrencyStatus: 'active',
            pendingProductCurrency: null,
          },
          { $inc: { __v: 1 } },
          { session }
        );
        if (matchedCount(result) !== 1) {
          throw migrationConflict('A store product-currency setting changed during migration. No prices in this seller batch were changed.');
        }
      }

      if (authority?.kind === 'store' && stores.length !== 1) {
        throw migrationConflict('The seller store authority was not present in this bounded migration batch.');
      }
      if (authority?.kind === 'seller') {
        const storeCreated = await Store.exists({ seller: authority.sellerId }).session(session);
        if (storeCreated) {
          throw migrationConflict('A store was created for this seller during migration. Resume only after starting a new dry run with the store as currency authority.');
        }
        if (authority.sellerExists) {
          const sellerResult = await User.updateOne(
            authority.sellerCurrencyExplicit ? {
              _id: authority.sellerId,
              currency: authority.sellerCurrency,
            } : {
              _id: authority.sellerId,
              $or: [
                { currency: { $exists: false } },
                { currency: null },
              ],
            },
            { $inc: { __v: 1 } },
            { session }
          );
          if (matchedCount(sellerResult) !== 1) {
            throw migrationConflict('The seller fallback currency changed during migration. No prices in this batch were changed.');
          }
        }
      }

      const operations = plan.map(({ product, update }) => ({
        updateOne: {
          filter: {
            _id: product._id,
            __v: product.__v,
            ...(product.updatedAt ? { updatedAt: product.updatedAt } : {}),
          },
          update: {
            $set: update,
            $inc: { __v: 1 },
          },
        },
      }));
      const result = await Product.bulkWrite(operations, { session, ordered: true });
      if (matchedCount(result) !== operations.length) {
        throw migrationConflict('A product changed during migration. No prices in this seller batch were changed.');
      }

      if (checkpoint) {
        const checkpointResult = await ProductCurrencyMigration.updateOne(
          checkpoint.filter,
          checkpointUpdate,
          { session }
        );
        if (matchedCount(checkpointResult) !== 1) {
          throw migrationConflict('The durable migration checkpoint or its lease changed. No prices in this batch were changed.');
        }
      }
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
}

async function executeMigrationPlan(plan, {
  onBatchCommitted = null,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  const batches = groupMigrationPlan(plan, { batchSize });
  let productsCommitted = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    try {
      await executeMigrationBatch(batch);
      productsCommitted += batch.length;
      if (onBatchCommitted) {
        await onBatchCommitted({
          batch: index + 1,
          totalBatches: batches.length,
          productsCommitted,
          batchSize: batch.length,
        });
      }
    } catch (error) {
      error.migrationProgress = {
        batchesCommitted: index,
        totalBatches: batches.length,
        productsCommitted,
      };
      throw error;
    }
  }
  return {
    batchesCommitted: batches.length,
    totalBatches: batches.length,
    productsCommitted,
  };
}

const PRODUCT_SELECTION = [
  '_id',
  'seller',
  'name',
  'price',
  'discountedPrice',
  'currency',
  'priceCurrency',
  'priceInputAmount',
  'discountedPriceCurrency',
  'discountedPriceInputAmount',
  'priceOriginal',
  'discountedPriceOriginal',
  'priceVersion',
  'updatedAt',
  '__v',
].join(' ');

const migrationSelection = force => force ? {} : {
  $or: [
    { currency: { $exists: false } },
    { priceVersion: { $ne: 2 } },
  ],
};

const andFilters = (...filters) => {
  const applicable = filters.filter(filter => filter && Object.keys(filter).length);
  if (applicable.length === 0) return {};
  if (applicable.length === 1) return applicable[0];
  return { $and: applicable };
};

const boundedSelection = ({ force, upperBoundProductId }) => {
  if (!upperBoundProductId) return { _id: null };
  return andFilters(
    migrationSelection(force),
    { _id: { $lte: upperBoundProductId } }
  );
};

const validatedRateSnapshot = snapshot => {
  const rates = normalizeRates(snapshot?.rates);
  if (snapshot?.fallback || !rates) {
    const error = exchangeRatesUnavailableError();
    error.message = 'A trusted live FX snapshot is required before this migration can checkpoint or change any product.';
    throw error;
  }
  const capturedAt = new Date(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new Error('The FX snapshot has an invalid capturedAt timestamp.');
  }
  return {
    base: 'USD',
    rates,
    capturedAt,
    source: String(snapshot.source || 'unknown').slice(0, 120),
    fallback: false,
  };
};

const sellerQueryValue = value => value ? new mongoose.Types.ObjectId(String(value)) : null;

const checkpointCursor = cursor => ({
  phase: cursor?.phase || 'seller',
  lastSellerId: sellerQueryValue(cursor?.lastSellerId),
  activeSellerId: sellerQueryValue(cursor?.activeSellerId),
  lastProductId: sellerQueryValue(cursor?.lastProductId),
  authority: {
    kind: cursor?.authority?.kind || 'none',
    storeId: sellerQueryValue(cursor?.authority?.storeId),
    storeCurrency: supportedCurrency(cursor?.authority?.storeCurrency),
    targetCurrency: supportedCurrency(cursor?.authority?.targetCurrency),
    sellerCurrency: supportedCurrency(cursor?.authority?.sellerCurrency) || 'USD',
    sellerCurrencyExplicit: !!cursor?.authority?.sellerCurrencyExplicit,
    sellerExists: !!cursor?.authority?.sellerExists,
  },
});

async function loadSellerAuthority(sellerId) {
  const [store, seller] = await Promise.all([
    Store.findOne({ seller: sellerId })
      .select('_id seller productCurrency productCurrencyStatus pendingProductCurrency')
      .lean(),
    User.findById(sellerId).select('_id currency').lean(),
  ]);
  if (store?.productCurrencyStatus === 'pending_conversion') {
    throw migrationConflict(`Store ${store._id} has a pending product-currency change; finish or cancel it before migration.`);
  }
  if (!store && seller) {
    const error = migrationConflict(`Seller ${sellerId} owns legacy products but has no Store currency authority. Create or repair that seller's Store, then start a fresh dry run.`);
    error.code = 'PRODUCT_CURRENCY_STORE_AUTHORITY_REQUIRED';
    throw error;
  }

  const storeCurrency = supportedCurrency(store?.productCurrency);
  const sellerCurrencyExplicit = seller?.currency !== null && seller?.currency !== undefined;
  const sellerCurrency = supportedCurrency(seller?.currency) || 'USD';
  return {
    kind: store ? 'store' : 'none',
    sellerId: sellerQueryValue(sellerId),
    storeId: sellerQueryValue(store?._id),
    storeCurrency,
    targetCurrency: storeCurrency,
    sellerCurrency,
    sellerCurrencyExplicit,
    sellerExists: !!seller,
  };
}

const authorityDocuments = authority => {
  const sellerId = toId(authority?.sellerId);
  const store = authority?.kind === 'store' ? {
    _id: authority.storeId,
    seller: authority.sellerId,
    productCurrency: authority.storeCurrency,
    productCurrencyStatus: 'active',
    pendingProductCurrency: null,
  } : null;
  const seller = authority?.sellerExists ? {
    _id: authority.sellerId,
    currency: authority.sellerCurrency,
  } : null;
  return {
    storesBySeller: store ? new Map([[sellerId, store]]) : new Map(),
    sellersById: seller ? new Map([[sellerId, seller]]) : new Map(),
    store,
  };
};

async function findNextSeller({ baseFilter, afterSellerId }) {
  const sellerConstraint = afterSellerId
    ? { seller: { $type: 'objectId', $gt: sellerQueryValue(afterSellerId) } }
    : { seller: { $type: 'objectId' } };
  const product = await Product.findOne(andFilters(baseFilter, sellerConstraint))
    .sort({ seller: 1, _id: 1 })
    .select('seller')
    .lean();
  return product?.seller || null;
}

async function loadSellerProductBatch({ baseFilter, sellerId, afterProductId, batchSize }) {
  const cursorFilter = afterProductId ? { _id: { $gt: afterProductId } } : {};
  return Product.find(andFilters(baseFilter, { seller: sellerId }, cursorFilter))
    .sort({ _id: 1 })
    .limit(batchSize)
    .select(PRODUCT_SELECTION);
}

async function loadOrphanProductBatch({ baseFilter, afterProductId, batchSize }) {
  const cursorFilter = afterProductId ? { _id: { $gt: afterProductId } } : {};
  return Product.find(andFilters(
    baseFilter,
    { $or: [{ seller: null }, { seller: { $exists: false } }] },
    cursorFilter
  ))
    .sort({ _id: 1 })
    .limit(batchSize)
    .select(PRODUCT_SELECTION);
}

async function buildBoundedPlan(products, { authority, rateSnapshot, migratedAt }) {
  const authorityState = authorityDocuments(authority);
  const result = await buildMigrationPlan(products, {
    storesBySeller: authorityState.storesBySeller,
    sellersById: authorityState.sellersById,
    rateSnapshot,
    migratedAt,
  });
  if (authorityState.store) {
    result.plan.forEach(entry => { entry.store = authorityState.store; });
  }
  return result.plan;
}

const logPlan = (plan, { prefix, verbose }) => {
  if (!verbose) return;
  plan.forEach(entry => {
    console.log(`${prefix} ${entry.product._id}: ${entry.sourcePrice} -> ${entry.update.price} ${entry.targetCurrency}`);
  });
};

async function scanRemainingReadOnly({
  initialCursor,
  baseFilter,
  batchSize,
  rateSnapshot,
  migratedAt,
  verbose = false,
  prefix = 'VALIDATE',
  onBatchValidated = null,
}) {
  const cursor = checkpointCursor(initialCursor);
  let productsValidated = 0;
  let batchesValidated = 0;

  while (cursor.phase !== 'done') {
    if (cursor.phase === 'seller') {
      if (!cursor.activeSellerId) {
        const sellerId = await findNextSeller({
          baseFilter,
          afterSellerId: cursor.lastSellerId,
        });
        if (!sellerId) {
          cursor.phase = 'orphan';
          cursor.lastProductId = null;
          cursor.authority = checkpointCursor({}).authority;
          continue;
        }
        cursor.activeSellerId = sellerQueryValue(sellerId);
        cursor.lastProductId = null;
        cursor.authority = await loadSellerAuthority(sellerId);
      }

      const products = await loadSellerProductBatch({
        baseFilter,
        sellerId: cursor.activeSellerId,
        afterProductId: cursor.lastProductId,
        batchSize,
      });
      if (!products.length) {
        cursor.lastSellerId = cursor.activeSellerId;
        cursor.activeSellerId = null;
        cursor.lastProductId = null;
        cursor.authority = checkpointCursor({}).authority;
        continue;
      }
      const plan = await buildBoundedPlan(products, {
        authority: { ...cursor.authority, sellerId: cursor.activeSellerId },
        rateSnapshot,
        migratedAt,
      });
      logPlan(plan, { prefix, verbose });
      cursor.lastProductId = products[products.length - 1]._id;
      productsValidated += products.length;
      batchesValidated += 1;
      if (onBatchValidated) {
        await onBatchValidated({ productsValidated, batchesValidated });
      }
      continue;
    }

    const products = await loadOrphanProductBatch({
      baseFilter,
      afterProductId: cursor.lastProductId,
      batchSize,
    });
    if (!products.length) {
      cursor.phase = 'done';
      continue;
    }
    const plan = await buildBoundedPlan(products, {
      authority: { kind: 'none' },
      rateSnapshot,
      migratedAt,
    });
    logPlan(plan, { prefix, verbose });
    cursor.lastProductId = products[products.length - 1]._id;
    productsValidated += products.length;
    batchesValidated += 1;
    if (onBatchValidated) {
      await onBatchValidated({ productsValidated, batchesValidated });
    }
  }

  return { productsValidated, batchesValidated, finalCursor: cursor };
}

async function prepareUniverse({ force }) {
  const selection = migrationSelection(force);
  const [lastProduct, estimatedProducts, invalidSellerProducts, rawSnapshot] = await Promise.all([
    Product.findOne(selection).sort({ _id: -1 }).select('_id').lean(),
    Product.countDocuments(selection),
    Product.countDocuments(andFilters(selection, {
      $nor: [
        { seller: { $type: 'objectId' } },
        { seller: null },
      ],
    })),
    getExchangeRateSnapshot(),
  ]);
  if (invalidSellerProducts > 0) {
    const error = migrationConflict(`${invalidSellerProducts} candidate product(s) have an invalid seller identifier. Repair those records explicitly before migration.`);
    error.code = 'PRODUCT_CURRENCY_INVALID_SELLER_REFERENCE';
    throw error;
  }
  return {
    upperBoundProductId: lastProduct?._id || null,
    estimatedProducts,
    rateSnapshot: validatedRateSnapshot(rawSnapshot),
  };
}

const checkpointConfigurationConflict = message => {
  const error = new Error(message);
  error.code = 'PRODUCT_CURRENCY_CHECKPOINT_CONFIGURATION_CONFLICT';
  return error;
};

async function openCheckpoint({ options, universe, leaseOwner, now = new Date() }) {
  await ProductCurrencyMigration.collection.createIndex(
    { migrationId: 1 },
    { unique: true, name: 'uniq_product_currency_migration_id' }
  );
  await ProductCurrencyMigration.collection.createIndex(
    { 'lease.expiresAt': 1 },
    { name: 'idx_product_currency_migration_lease' }
  );
  const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);
  let checkpoint;
  try {
    checkpoint = await ProductCurrencyMigration.create({
      migrationId: options.migrationId,
      status: 'running',
      force: options.force,
      batchSize: options.batchSize,
      upperBoundProductId: universe.upperBoundProductId,
      estimatedProducts: universe.estimatedProducts,
      rateSnapshot: universe.rateSnapshot,
      migratedAt: now,
      cursor: { phase: 'seller' },
      lease: { owner: leaseOwner, expiresAt: leaseExpiresAt },
    });
    return checkpoint.toObject();
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  const existing = await ProductCurrencyMigration.findOne({ migrationId: options.migrationId }).lean();
  if (!existing) throw checkpointConfigurationConflict('The checkpoint was created concurrently but could not be reloaded.');
  if (existing.force !== options.force) {
    throw checkpointConfigurationConflict('The existing checkpoint uses a different --force setting.');
  }
  if (Number(existing.batchSize) !== Number(options.batchSize)) {
    throw checkpointConfigurationConflict(`Resume with the original --batch-size=${existing.batchSize}.`);
  }
  if (existing.status === 'completed') return existing;

  checkpoint = await ProductCurrencyMigration.findOneAndUpdate({
    _id: existing._id,
    status: 'running',
    $or: [
      { 'lease.owner': leaseOwner },
      { 'lease.expiresAt': { $lte: now } },
      { 'lease.expiresAt': null },
      { 'lease.expiresAt': { $exists: false } },
    ],
  }, {
    $set: {
      'lease.owner': leaseOwner,
      'lease.expiresAt': leaseExpiresAt,
      'lastError.code': '',
      'lastError.message': '',
      'lastError.at': null,
    },
  }, { new: true }).lean();
  if (!checkpoint) {
    const error = new Error(`Migration ${options.migrationId} is leased by another live process.`);
    error.code = 'PRODUCT_CURRENCY_MIGRATION_LEASED';
    throw error;
  }
  return checkpoint;
}

const leaseExpiry = () => new Date(Date.now() + LEASE_DURATION_MS);

async function renewCheckpointLease(checkpointId, leaseOwner) {
  const result = await ProductCurrencyMigration.updateOne({
    _id: checkpointId,
    status: 'running',
    'lease.owner': leaseOwner,
  }, {
    $set: { 'lease.expiresAt': leaseExpiry() },
  });
  if (matchedCount(result) !== 1) {
    throw migrationConflict('The migration lease was lost during the read-only validation pass. No new product batch was committed by this process.');
  }
}

const checkpointIdentity = (checkpoint, leaseOwner, extra = {}) => ({
  _id: checkpoint._id,
  status: 'running',
  'lease.owner': leaseOwner,
  ...extra,
});

async function guardedCheckpointUpdate(checkpoint, leaseOwner, filter, update) {
  const next = await ProductCurrencyMigration.findOneAndUpdate(
    checkpointIdentity(checkpoint, leaseOwner, filter),
    update,
    { new: true }
  ).lean();
  if (!next) throw migrationConflict('The durable migration checkpoint or lease changed. Stop this process and inspect the checkpoint before resuming.');
  return next;
}

async function activateSeller(checkpoint, leaseOwner, sellerId) {
  const authority = await loadSellerAuthority(sellerId);
  return guardedCheckpointUpdate(checkpoint, leaseOwner, {
    'cursor.phase': 'seller',
    'cursor.activeSellerId': null,
    'cursor.lastSellerId': checkpoint.cursor?.lastSellerId || null,
  }, {
    $set: {
      'cursor.activeSellerId': sellerId,
      'cursor.lastProductId': null,
      'cursor.authority': authority,
      'lease.expiresAt': leaseExpiry(),
    },
  });
}

async function commitWriteBatches({ checkpoint: initialCheckpoint, options, leaseOwner }) {
  let checkpoint = initialCheckpoint;
  let batchesThisRun = 0;
  const baseFilter = boundedSelection({
    force: checkpoint.force,
    upperBoundProductId: checkpoint.upperBoundProductId,
  });
  const rateSnapshot = validatedRateSnapshot(checkpoint.rateSnapshot);

  while (checkpoint.status === 'running' && checkpoint.cursor?.phase !== 'done') {
    const cursor = checkpointCursor(checkpoint.cursor);
    if (cursor.phase === 'seller') {
      if (!cursor.activeSellerId) {
        const sellerId = await findNextSeller({ baseFilter, afterSellerId: cursor.lastSellerId });
        if (!sellerId) {
          checkpoint = await guardedCheckpointUpdate(checkpoint, leaseOwner, {
            'cursor.phase': 'seller',
            'cursor.activeSellerId': null,
          }, {
            $set: {
              'cursor.phase': 'orphan',
              'cursor.lastProductId': null,
              'cursor.authority': checkpointCursor({}).authority,
              'lease.expiresAt': leaseExpiry(),
            },
          });
          continue;
        }
        checkpoint = await activateSeller(checkpoint, leaseOwner, sellerId);
        continue;
      }

      const products = await loadSellerProductBatch({
        baseFilter,
        sellerId: cursor.activeSellerId,
        afterProductId: cursor.lastProductId,
        batchSize: checkpoint.batchSize,
      });
      if (!products.length) {
        checkpoint = await guardedCheckpointUpdate(checkpoint, leaseOwner, {
          'cursor.phase': 'seller',
          'cursor.activeSellerId': cursor.activeSellerId,
          'cursor.lastProductId': cursor.lastProductId || null,
        }, {
          $set: {
            'cursor.lastSellerId': cursor.activeSellerId,
            'cursor.activeSellerId': null,
            'cursor.lastProductId': null,
            'cursor.authority': checkpointCursor({}).authority,
            'lease.expiresAt': leaseExpiry(),
          },
        });
        continue;
      }

      const authority = { ...cursor.authority, sellerId: cursor.activeSellerId };
      const plan = await buildBoundedPlan(products, {
        authority,
        rateSnapshot,
        migratedAt: checkpoint.migratedAt,
      });
      logPlan(plan, { prefix: 'MIGRATE', verbose: options.verbose });
      const lastProductId = products[products.length - 1]._id;
      await executeMigrationBatch(plan, {
        authority,
        checkpoint: {
          filter: checkpointIdentity(checkpoint, leaseOwner, {
            'cursor.phase': 'seller',
            'cursor.activeSellerId': cursor.activeSellerId,
            'cursor.lastProductId': cursor.lastProductId || null,
          }),
        },
        checkpointUpdate: {
          $set: {
            'cursor.lastProductId': lastProductId,
            'lease.expiresAt': leaseExpiry(),
            'lastError.code': '',
            'lastError.message': '',
            'lastError.at': null,
          },
          $inc: { batchesCommitted: 1, productsCommitted: products.length },
        },
      });
      checkpoint = await ProductCurrencyMigration.findById(checkpoint._id).lean();
      batchesThisRun += 1;
    } else {
      const products = await loadOrphanProductBatch({
        baseFilter,
        afterProductId: cursor.lastProductId,
        batchSize: checkpoint.batchSize,
      });
      if (!products.length) {
        checkpoint = await guardedCheckpointUpdate(checkpoint, leaseOwner, {
          'cursor.phase': 'orphan',
          'cursor.lastProductId': cursor.lastProductId || null,
        }, {
          $set: {
            'cursor.phase': 'done',
            'cursor.lastProductId': null,
            'lease.expiresAt': leaseExpiry(),
          },
        });
        continue;
      }
      const plan = await buildBoundedPlan(products, {
        authority: { kind: 'none' },
        rateSnapshot,
        migratedAt: checkpoint.migratedAt,
      });
      logPlan(plan, { prefix: 'MIGRATE', verbose: options.verbose });
      const lastProductId = products[products.length - 1]._id;
      await executeMigrationBatch(plan, {
        checkpoint: {
          filter: checkpointIdentity(checkpoint, leaseOwner, {
            'cursor.phase': 'orphan',
            'cursor.lastProductId': cursor.lastProductId || null,
          }),
        },
        checkpointUpdate: {
          $set: {
            'cursor.lastProductId': lastProductId,
            'lease.expiresAt': leaseExpiry(),
            'lastError.code': '',
            'lastError.message': '',
            'lastError.at': null,
          },
          $inc: { batchesCommitted: 1, productsCommitted: products.length },
        },
      });
      checkpoint = await ProductCurrencyMigration.findById(checkpoint._id).lean();
      batchesThisRun += 1;
    }

    console.log(`Committed bounded batch ${checkpoint.batchesCommitted}; ${checkpoint.productsCommitted}/${checkpoint.estimatedProducts} checkpointed product(s).`);
    if (options.maxBatches && batchesThisRun >= options.maxBatches) {
      return { checkpoint, paused: true, batchesThisRun };
    }
  }

  return { checkpoint, paused: false, batchesThisRun };
}

async function completeCheckpoint(checkpoint, leaseOwner) {
  if (Number(checkpoint.productsCommitted) !== Number(checkpoint.estimatedProducts)) {
    const error = migrationConflict(
      `The checkpoint committed ${checkpoint.productsCommitted} product(s), but its immutable starting universe contained ${checkpoint.estimatedProducts}. A product was inserted, deleted, or changed outside the cursor; review the data and start a new migration id.`
    );
    error.code = 'PRODUCT_CURRENCY_MIGRATION_COUNT_MISMATCH';
    throw error;
  }
  if (!checkpoint.force && checkpoint.upperBoundProductId) {
    const remaining = await Product.countDocuments(boundedSelection({
      force: false,
      upperBoundProductId: checkpoint.upperBoundProductId,
    }));
    if (remaining > 0) {
      const error = migrationConflict(`${remaining} bounded candidate product(s) remain behind the completed cursor. Start a new dry run and migration id; do not mark this checkpoint complete.`);
      error.code = 'PRODUCT_CURRENCY_MIGRATION_UNIVERSE_CHANGED';
      throw error;
    }
  }
  return guardedCheckpointUpdate(checkpoint, leaseOwner, {
    'cursor.phase': 'done',
  }, {
    $set: {
      status: 'completed',
      completedAt: new Date(),
      'lease.owner': null,
      'lease.expiresAt': null,
      'lastError.code': '',
      'lastError.message': '',
      'lastError.at': null,
    },
  });
}

async function recordCheckpointError(checkpointId, leaseOwner, error) {
  if (!checkpointId || !leaseOwner) return;
  await ProductCurrencyMigration.updateOne({
    _id: checkpointId,
    status: 'running',
    'lease.owner': leaseOwner,
  }, {
    $set: {
      'lastError.code': String(error?.code || 'PRODUCT_CURRENCY_MIGRATION_ERROR').slice(0, 120),
      'lastError.message': String(error?.message || 'Unknown migration error').slice(0, 1000),
      'lastError.at': new Date(),
    },
  }).catch(() => {});
}

async function releaseCheckpointLease(checkpointId, leaseOwner) {
  if (!checkpointId || !leaseOwner) return;
  await ProductCurrencyMigration.updateOne({
    _id: checkpointId,
    status: 'running',
    'lease.owner': leaseOwner,
  }, {
    $set: { 'lease.owner': null, 'lease.expiresAt': null },
  }).catch(() => {});
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGO_URI is required');
  // A dry run must not implicitly build application indexes. Write mode
  // creates only its two checkpoint indexes explicitly in openCheckpoint.
  await mongoose.connect(mongoUri, { autoIndex: false, autoCreate: false });

  const existingCheckpoint = options.write
    ? await ProductCurrencyMigration.findOne({ migrationId: options.migrationId }).lean()
    : null;
  const universe = existingCheckpoint ? {
    upperBoundProductId: existingCheckpoint.upperBoundProductId,
    estimatedProducts: existingCheckpoint.estimatedProducts,
    rateSnapshot: validatedRateSnapshot(existingCheckpoint.rateSnapshot),
  } : await prepareUniverse({ force: options.force });
  const baseFilter = boundedSelection({
    force: options.force,
    upperBoundProductId: universe.upperBoundProductId,
  });

  if (!options.write) {
    const result = await scanRemainingReadOnly({
      initialCursor: { phase: 'seller' },
      baseFilter,
      batchSize: options.batchSize,
      rateSnapshot: universe.rateSnapshot,
      migratedAt: new Date(),
      verbose: options.verbose,
      prefix: 'DRY RUN',
    });
    console.log(`Dry run complete: ${result.productsValidated} product(s) validated in ${result.batchesValidated} bounded batch(es); no database writes were made.`);
    return { ...result, dryRun: true, universe };
  }

  const leaseOwner = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  let checkpoint = null;
  try {
    checkpoint = await openCheckpoint({ options, universe, leaseOwner });
    if (checkpoint.status === 'completed') {
      console.log(`Migration ${options.migrationId} is already complete: ${checkpoint.productsCommitted} product(s).`);
      return { checkpoint, alreadyCompleted: true };
    }

    // Validate every remaining bounded conversion with the checkpoint's one
    // trusted FX snapshot before this invocation changes a product. This is a
    // streaming pass, so validation does not retain the catalog in memory.
    const validation = await scanRemainingReadOnly({
      initialCursor: checkpoint.cursor,
      baseFilter: boundedSelection({
        force: checkpoint.force,
        upperBoundProductId: checkpoint.upperBoundProductId,
      }),
      batchSize: checkpoint.batchSize,
      rateSnapshot: validatedRateSnapshot(checkpoint.rateSnapshot),
      migratedAt: checkpoint.migratedAt,
      verbose: false,
      prefix: 'VALIDATE',
      onBatchValidated: () => renewCheckpointLease(checkpoint._id, leaseOwner),
    });
    console.log(`Validated ${validation.productsValidated} remaining product(s) in ${validation.batchesValidated} bounded batch(es) before writes.`);

    const result = await commitWriteBatches({ checkpoint, options, leaseOwner });
    checkpoint = result.checkpoint;
    if (result.paused) {
      console.log(`Paused safely after ${result.batchesThisRun} batch(es). Resume with the same migration id and batch size.`);
      return { ...result, checkpoint };
    }
    checkpoint = await completeCheckpoint(checkpoint, leaseOwner);
    console.log(`Done: migration ${options.migrationId} committed ${checkpoint.productsCommitted} product(s) in ${checkpoint.batchesCommitted} bounded transaction(s).`);
    return { checkpoint, completed: true };
  } catch (error) {
    await recordCheckpointError(checkpoint?._id, leaseOwner, error);
    throw error;
  } finally {
    await releaseCheckpointLease(checkpoint?._id, leaseOwner);
  }
}

if (require.main === module) {
  run()
    .catch(error => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  explicitProductField,
  describeProductMigration,
  buildMigrationPlan,
  buildBoundedPlan,
  boundedSelection,
  commitWriteBatches,
  executeMigrationBatch,
  groupMigrationPlan,
  executeMigrationPlan,
  openCheckpoint,
  parseArguments,
  prepareUniverse,
  scanRemainingReadOnly,
  validatedRateSnapshot,
  run,
};
