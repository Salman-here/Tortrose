// const { default: Fuse } = require("fuse.js")
const mongoose = require('mongoose')
const Product = require("../models/Product")
const Fuse = require('fuse.js')
const {
    buildModerationFields,
    isProductBlocked,
    notifyProductBlocked,
    publicProductFilter,
} = require('../services/productModerationService')
const {
    isSupportedCurrency,
    normalizeCurrency,
    convertAmount,
    convertAmountSync,
    convertAmountUsingTrustedRates,
    getExchangeRateSnapshot,
} = require('../services/currencyService')
const {
    roundMoney,
    applyProductPricePercentage,
    assertEffectiveProductDiscount,
    assertRepresentablePositiveProductAmount,
    assertRepresentableProductAdjustment,
    requireStoredProductCurrency,
    requireStoredProductDiscountCurrency,
    requireStoredProductBasePrice,
    requireStoredProductDiscountPrice,
    requireStoredProductEffectivePrice,
} = require('../services/productPricingService')
const { percentageOfMoney } = require('../services/moneyMath')
const {
    PRODUCT_CURRENCY_ACTIVE_STATUS,
    assertProductCreationAllowed,
    getSellerProductCurrencyState,
    withProductCurrencyWriteLock,
} = require('../services/storeProductCurrencyService')
const {
    getSellerFeaturedProductQuota,
    assertSellerCanCreateProducts,
    assertSellerCanFeatureProduct,
} = require('../services/sellerProductQuotaService')
const { sanitizeProductPayload } = require('../services/productTextService')
const {
    buyerLocationFromRequest,
    findVisibleStores,
    isStoreVisibleToBuyer,
} = require('../services/storeVisibilityService')
const {
    normalizeStorePaymentPolicy,
    PAYMENT_POLICY_LABELS,
    storeAllowsCashOnDelivery,
} = require('../services/storePaymentPolicyService')
const {
    normalizeReturnPolicy,
    normalizeProductReturnPolicy,
} = require('../services/returnPolicyService')
const { findProductReviewEligibility } = require('../services/reviewEligibilityService')
const { findActiveStore } = require('../services/publicCatalogService')
const { runInTransaction } = require('../services/walletService')
const {
    parseNonNegativeSafeInteger,
    parseStrictFiniteNumber,
} = require('../services/numericInputService')
const {
    blockedIdSet,
    getBlockedUserIds,
    isUserBlocked,
} = require('../services/userBlockService')

const OTHER_BRANDS_FILTER = '__other_brands__';
const POPULAR_BRAND_MIN_PRODUCTS = Math.max(2, parseInt(process.env.POPULAR_BRAND_MIN_PRODUCTS || '3', 10) || 3);
const MAX_BULK_PRODUCT_MUTATIONS = 250;
const CANONICAL_PRODUCT_ID_PATTERN = /^[0-9a-f]{24}$/;

const cleanList = (items) => [...new Set(
    (items || []).map(item => String(item || '').trim()).filter(Boolean)
)].sort((a, b) => a.localeCompare(b));

const PRODUCT_CURRENCY_INPUT_FIELDS = [
    'currency',
    'priceCurrency',
    'discountedCurrency',
    'discountedPriceCurrency',
];

const invalidProductCurrencyField = (product = {}) => PRODUCT_CURRENCY_INPUT_FIELDS.find(field => (
    Object.prototype.hasOwnProperty.call(product, field)
    && (
        typeof product[field] !== 'string'
        || !String(product[field]).trim()
        || !isSupportedCurrency(product[field])
    )
));

const invalidProductNumber = (product = {}) => {
    for (const field of ['price', 'discountedPrice']) {
        if (!Object.prototype.hasOwnProperty.call(product, field)) continue;
        const value = parseStrictFiniteNumber(product[field]);
        if (value === null || value < 0) return `${field} must be a non-negative number.`;
        try {
            roundMoney(value);
        } catch (_) {
            return `${field} is too large to store safely.`;
        }
    }
    if (Object.prototype.hasOwnProperty.call(product, 'stock')) {
        if (parseNonNegativeSafeInteger(product.stock) === null) {
            return 'stock must be a non-negative safe whole number.';
        }
    }
    return '';
};

const normalizeBulkMoneyInput = (value, { nonNegative = false } = {}) => {
    const parsed = parseStrictFiniteNumber(value);
    if (parsed === null || (nonNegative && parsed < 0)) return null;
    try {
        const rounded = roundMoney(parsed);
        return rounded !== parsed ? null : rounded;
    } catch (_) {
        return null;
    }
};

const bulkProductMutationError = (message, {
    status = 400,
    code = 'PRODUCT_BULK_SELECTION_INVALID',
} = {}) => {
    const error = new Error(message);
    error.status = status;
    error.statusCode = status;
    error.code = code;
    return error;
};

const bulkProductMutationStatus = (error) => (
    error?.statusCode
    || error?.status
    || (error?.code === 'MONEY_AMOUNT_OUT_OF_RANGE' ? 400 : 500)
);

const parseBulkMutationProductIds = (productIds, { action = 'change' } = {}) => {
    if (!Array.isArray(productIds) || productIds.length === 0) {
        throw bulkProductMutationError('Select at least one product.');
    }
    if (productIds.length > MAX_BULK_PRODUCT_MUTATIONS) {
        throw bulkProductMutationError(
            `You can ${action} up to ${MAX_BULK_PRODUCT_MUTATIONS} products at a time.`,
            { code: 'PRODUCT_BULK_SELECTION_LIMIT' }
        );
    }

    // Do not trim, stringify, cast, or silently drop mutation identifiers.
    // A canonical API identifier is the exact lowercase 24-hex string emitted
    // by MongoDB. Rejecting every other representation makes the requested set
    // unambiguous before an ownership-scoped query is issued.
    const ids = Array.from(productIds, (value) => {
        if (
            typeof value !== 'string'
            || !CANONICAL_PRODUCT_ID_PATTERN.test(value)
            || !mongoose.Types.ObjectId.isValid(value)
            || new mongoose.Types.ObjectId(value).toHexString() !== value
        ) {
            throw bulkProductMutationError(
                'Every selected product ID must be a canonical lowercase 24-character hexadecimal ID.'
            );
        }
        return value;
    });

    if (new Set(ids).size !== ids.length) {
        throw bulkProductMutationError('Each selected product may appear only once.');
    }
    return ids;
};

const assertCompleteBulkProductSelection = (products, productIds) => {
    const selectedProducts = Array.isArray(products) ? products : [];
    const selectedIds = new Set(selectedProducts.map(product => String(product?._id || '')));
    if (
        selectedProducts.length !== productIds.length
        || selectedIds.size !== productIds.length
        || productIds.some(productId => !selectedIds.has(productId))
    ) {
        throw bulkProductMutationError(
            'One or more selected products were not found or are not available to this account. No products were changed.',
            { status: 404, code: 'PRODUCT_BULK_SELECTION_INCOMPLETE' }
        );
    }
    return selectedProducts;
};

const normalizeBulkMutationCurrency = (value, { required = false } = {}) => {
    if (value === undefined && !required) return null;
    if (typeof value !== 'string' || !value.trim() || !isSupportedCurrency(value)) {
        throw bulkProductMutationError(
            required
                ? 'Currency is required for this money change and must be USD, PKR, EUR, or GBP.'
                : 'Currency must be USD, PKR, EUR, or GBP.',
            { code: 'PRODUCT_BULK_CURRENCY_INVALID' }
        );
    }
    return normalizeCurrency(value);
};

const assertSellerBulkPricingCurrency = (products, state) => {
    if (!state?.hasStore) {
        throw bulkProductMutationError(
            'Store not found. Please create a store before changing product prices.',
            { status: 404, code: 'PRODUCT_STORE_NOT_FOUND' }
        );
    }
    if (state.status !== PRODUCT_CURRENCY_ACTIVE_STATUS) {
        throw bulkProductMutationError(
            state.message || 'Finish or cancel the pending store product currency change before changing prices.',
            { status: 409, code: 'PRODUCT_CURRENCY_CHANGE_PENDING' }
        );
    }
    const mismatchedProduct = products.find(product => (
        requireStoredProductCurrency(product, 'USD') !== state.activeCurrency
    ));
    if (mismatchedProduct) {
        throw bulkProductMutationError(
            `${mismatchedProduct.name || `Product ${mismatchedProduct._id}`} is not stored in the active ${state.activeCurrency} store currency. Finish the product currency migration and refresh before changing prices.`,
            { status: 409, code: 'PRODUCT_STORE_CURRENCY_CONFLICT' }
        );
    }
};

const requireBulkStoredProductPricing = (product) => {
    const productCurrency = requireStoredProductCurrency(product, 'USD');
    const price = requireStoredProductBasePrice(product);
    const discountedPrice = requireStoredProductDiscountPrice(product);
    requireStoredProductEffectivePrice(product);
    const discountedPriceCurrency = requireStoredProductDiscountCurrency(product, productCurrency);
    if (discountedPrice > 0 && discountedPriceCurrency !== productCurrency) {
        throw bulkProductMutationError(
            `${product?.name || `Product ${product?._id || ''}`} has conflicting stored price currencies. Refresh after repairing its product currency metadata.`,
            { status: 409, code: 'PRODUCT_CURRENCY_METADATA_INVALID' }
        );
    }
    return { productCurrency, price, discountedPrice };
};

const persistedProductFieldSnapshot = (product, fields = []) => {
    const plainProduct = product?.toObject
        ? product.toObject({ getters: false, virtuals: false, depopulate: true })
        : product;
    return fields.reduce((filter, field) => {
        const defaulted = typeof product?.$isDefault === 'function' && product.$isDefault(field);
        const present = !defaulted
            && plainProduct
            && Object.prototype.hasOwnProperty.call(plainProduct, field)
            && plainProduct[field] !== undefined;
        filter[field] = present ? plainProduct[field] : { $exists: false };
        return filter;
    }, {});
};

const productPricingMutationFilter = (product, { role, userId, discountOnly = false } = {}) => ({
    _id: product._id,
    ...(role === 'seller'
        ? { seller: userId }
        : persistedProductFieldSnapshot(product, ['seller'])),
    ...persistedProductFieldSnapshot(product, discountOnly
        ? ['discountedPrice', 'discountedPriceInputAmount', 'updatedAt']
        : [
            'price',
            'discountedPrice',
            'currency',
            'priceCurrency',
            'priceInputAmount',
            'discountedPriceCurrency',
            'discountedPriceInputAmount',
            'priceVersion',
            'updatedAt',
        ]),
});

const matchedBulkCount = (result) => {
    const count = result?.matchedCount ?? result?.nMatched ?? result?.result?.nMatched;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
        ? count
        : null;
};

const deletedBulkCount = (result) => {
    const count = result?.deletedCount ?? result?.n;
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
        ? count
        : null;
};

const writeProductsAtomically = async (updates = [], { sellerId = null, expectedCurrency = null } = {}) => {
    const write = async session => {
        const result = await Product.bulkWrite(updates, { session });
        const matchedCount = matchedBulkCount(result);
        if (matchedCount === null) {
            throw bulkProductMutationError(
                'The database did not return a trustworthy product update count.',
                { status: 500, code: 'PRODUCT_BULK_WRITE_RESULT_INVALID' }
            );
        }
        if (matchedCount !== updates.length) {
            const error = new Error('One or more products changed while this update was being prepared. No product pricing was changed; refresh and retry.');
            error.status = 409;
            error.statusCode = 409;
            error.code = 'PRODUCT_PRICE_UPDATE_CONFLICT';
            throw error;
        }
        return result;
    };
    return sellerId
        ? withProductCurrencyWriteLock(sellerId, expectedCurrency, write)
        : runInTransaction(write);
};

const toArray = (value) => Array.isArray(value) ? value : [value];

const parseProductIdsFilter = (...values) => {
    const ids = values
        .flatMap(value => toArray(value))
        .flatMap(value => String(value || '').split(','))
        .map(value => value.trim())
        .filter(Boolean);

    const uniqueIds = [...new Set(ids)]
        .filter(id => mongoose.Types.ObjectId.isValid(id));

    return {
        requested: ids.length > 0,
        ids: uniqueIds,
    };
};

async function applyProductCurrencyMetadata(product, fallbackCurrency = 'USD', forcedProductCurrency = null) {
    if (!product || typeof product !== 'object') return product;
    const fallbackSourceCurrency = normalizeCurrency(fallbackCurrency || 'USD');
    const productCurrency = normalizeCurrency(forcedProductCurrency || product.currency || fallbackSourceCurrency);
    // A forced store target describes where the value must be saved, not what
    // an unlabelled historical value was stored in. Currency-less legacy
    // Product.price values are canonical USD (the supplied fallback here), so
    // using the forced target as their source would silently relabel USD 10 as
    // PKR 10 instead of converting it.
    const priceSourceCurrency = normalizeCurrency(
        product.priceCurrency || product.currency || fallbackSourceCurrency
    );
    const next = { ...product };
    const productLabel = String(product.name || 'A product').trim() || 'A product';
    let conversionSnapshot;
    const convertForWrite = async (amount, sourceCurrency, targetCurrency) => {
        if (normalizeCurrency(sourceCurrency) === normalizeCurrency(targetCurrency)) return roundMoney(amount);
        if (!conversionSnapshot) conversionSnapshot = await getExchangeRateSnapshot();
        return convertAmountUsingTrustedRates(amount, sourceCurrency, targetCurrency, conversionSnapshot);
    };

    if (next.price !== undefined && next.price !== '') {
        const rawPrice = Number(next.price);
        const convertedPrice = priceSourceCurrency === productCurrency
            ? rawPrice
            : await convertForWrite(rawPrice, priceSourceCurrency, productCurrency);
        next.price = assertRepresentablePositiveProductAmount({
            sourceAmount: rawPrice,
            convertedAmount: convertedPrice,
            sourceCurrency: priceSourceCurrency,
            targetCurrency: productCurrency,
            productLabel,
            field: 'price',
        });
        next.currency = productCurrency;
        next.priceCurrency = productCurrency;
        next.priceInputAmount = next.price;
        if (next.discountedPrice === undefined) {
            next.discountedPriceCurrency = productCurrency;
            next.discountedPriceInputAmount = 0;
        }
        next.priceVersion = 2;
    } else if (next.currency !== undefined || next.priceCurrency !== undefined) {
        next.currency = productCurrency;
        next.priceCurrency = productCurrency;
    }

    if (next.discountedPrice !== undefined && next.discountedPrice !== '') {
        const discountCurrency = normalizeCurrency(
            product.discountedPriceCurrency
            || product.discountedCurrency
            || product.currency
            || product.priceCurrency
            || fallbackSourceCurrency
        );
        const rawDiscount = Number(next.discountedPrice);
        const convertedDiscount = rawDiscount > 0
            ? await convertForWrite(rawDiscount, discountCurrency, productCurrency)
            : 0;
        next.discountedPrice = assertRepresentablePositiveProductAmount({
            sourceAmount: rawDiscount,
            convertedAmount: convertedDiscount,
            sourceCurrency: discountCurrency,
            targetCurrency: productCurrency,
            productLabel,
            field: 'discountedPrice',
        });
        next.discountedPriceCurrency = productCurrency;
        next.discountedPriceInputAmount = next.discountedPrice;
        next.priceVersion = 2;
    } else if (next.discountedPrice !== undefined) {
        next.discountedPrice = 0;
        next.discountedPriceCurrency = productCurrency;
        next.discountedPriceInputAmount = 0;
    }

    delete next.discountedCurrency;
    return next;
}

function serializeProductCurrencyMetadata(product, fallbackCurrency = 'USD') {
    if (!product || typeof product !== 'object') return product;
    const plainProduct = product?.toObject ? product.toObject() : { ...product };
    // Raw documents created before native product currencies have no currency
    // fields at all. Their numeric prices were stored canonically in USD.
    const productCurrency = requireStoredProductCurrency(product, fallbackCurrency || 'USD');
    requireStoredProductEffectivePrice(product);
    const storedDiscountedPrice = requireStoredProductDiscountPrice(product);
    const discountCurrency = requireStoredProductDiscountCurrency(product, productCurrency);
    if (storedDiscountedPrice > 0 && discountCurrency !== productCurrency) {
        const error = new Error(`${plainProduct.name || 'A product'} has conflicting stored price currencies.`);
        error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
        error.status = 409;
        error.statusCode = 409;
        throw error;
    }

    return {
        ...plainProduct,
        currency: productCurrency,
        priceCurrency: productCurrency,
        discountedPriceCurrency: discountCurrency,
    };
}

const parsePriceRange = (priceRange) => {
    if (!priceRange) return null;
    const [min, max] = String(priceRange).split(',');
    const minValue = Number(min);
    const maxValue = Number(max);
    return {
        min: Number.isFinite(minValue) ? minValue : null,
        max: Number.isFinite(maxValue) ? maxValue : null,
    };
};

async function attachComparablePrices(products, targetCurrency = 'USD') {
    const currency = normalizeCurrency(targetCurrency);
    return Promise.all(products.map(async (product) => {
        const plainProduct = product?.toObject ? product.toObject() : product;
        return {
            ...plainProduct,
            _comparablePrice: await convertAmount(
                requireStoredProductEffectivePrice(plainProduct),
                requireStoredProductCurrency(plainProduct, 'USD'),
                currency
            ),
        };
    }));
}

function filterByComparablePriceRange(products, range) {
    if (!range || (range.min === null && range.max === null)) return products;
    return products.filter(product => {
        const price = Number(product._comparablePrice ?? convertAmountSync(
            requireStoredProductEffectivePrice(product),
            requireStoredProductCurrency(product, 'USD'),
            'USD'
        ));
        if (range.min !== null && price < range.min) return false;
        if (range.max !== null && price > range.max) return false;
        return true;
    });
}

async function getBrandStats(productScope) {
    const rows = await Product.aggregate([
        { $match: productScope },
        { $group: { _id: '$brand', count: { $sum: 1 } } },
    ]);

    const byName = new Map();
    for (const row of rows) {
        const name = String(row._id || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        const existing = byName.get(key);
        if (existing) {
            existing.count += row.count;
        } else {
            byName.set(key, { name, count: row.count });
        }
    }

    return [...byName.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function getPopularBrandNames(productScope) {
    const stats = await getBrandStats(productScope);
    return stats
        .filter(brand => brand.count >= POPULAR_BRAND_MIN_PRODUCTS)
        .map(brand => brand.name);
}

/**
 * Calculate relevance score for product ranking
 * Balances quality, freshness, diversity, and seller fairness
 */
const calculateRelevanceScore = (product, sellerProductCounts, totalSellers) => {
    const now = Date.now();
    const createdAt = new Date(product.createdAt).getTime();
    const daysSinceCreated = (now - createdAt) / (1000 * 60 * 60 * 24);

    // Base scores
    let score = 0;

    // 1. FEATURED BOOST (200-400 points)
    // Featured products get moderate boost, not overwhelming
    // Quality products with sales can still outrank featured products
    if (product.isFeatured) {
        score += 300;
    }

    // 2. QUALITY SCORE (0-500 points)
    // Rating × reviews = quality indicator
    const rating = product.rating || 0;
    const numReviews = product.numReviews || 0;
    const qualityScore = (rating * 50) + (Math.min(numReviews, 50) * 5);
    score += qualityScore;

    // 3. SALES PERFORMANCE (0-300 points)
    // Products that sell well rank higher
    const totalSales = product.totalSales || 0;
    const salesScore = Math.min(totalSales * 10, 300);
    score += salesScore;

    // 4. POPULARITY (0-200 points)
    // Views indicate interest
    const views = product.views || 0;
    const popularityScore = Math.min(views * 0.5, 200);
    score += popularityScore;

    // 5. FRESHNESS BOOST (0-600 points, decays over time)
    // New products get temporary boost to ensure visibility
    // Boost is stronger when there are more sellers (more competition)
    let freshnessBoost = 0;
    if (daysSinceCreated <= 30) {
        // New product (< 30 days)
        const freshnessMultiplier = Math.max(1, totalSellers / 10); // More sellers = stronger boost
        const decayFactor = 1 - (daysSinceCreated / 30); // Linear decay over 30 days
        freshnessBoost = 600 * decayFactor * freshnessMultiplier;
        score += freshnessBoost;
    }

    // 6. DIVERSITY PENALTY (prevents seller domination)
    // If a seller has many products, reduce their individual product scores slightly
    const sellerId = product.seller?._id?.toString() || product.seller?.toString();
    const sellerProductCount = sellerProductCounts[sellerId] || 1;

    if (sellerProductCount > 5) {
        // Sellers with 6+ products get diminishing returns
        // This ensures smaller sellers get fair visibility
        const diversityPenalty = Math.min((sellerProductCount - 5) * 20, 200);
        score -= diversityPenalty;
    }

    // 7. STOCK AVAILABILITY (0 or -500 points)
    // Out of stock products rank much lower
    if (product.stock === 0) {
        score -= 500;
    }

    // 8. DISCOUNT BOOST (0-150 points)
    // Products on sale get slight boost
    if (product.discountedPrice && product.discountedPrice < product.price) {
        const discountPercent = ((product.price - product.discountedPrice) / product.price) * 100;
        score += Math.min(discountPercent * 3, 150);
    }

    // 9. VERIFIED STORE BOOST (0-300 points)
    // Products from verified stores get trust boost
    if (product.seller?.store?.verification?.isVerified) {
        score += 300;
    }

    return Math.max(0, score); // Ensure non-negative
};

/**
 * Apply intelligent sorting based on sort parameter
 */
const applySorting = (products, sortBy, sortOrder, sellerProductCounts, totalSellers) => {
    const order = sortOrder === 'asc' ? 1 : -1;

    switch(sortBy) {
        case 'price':
            return products.sort((a, b) => {
                const priceA = a._comparablePrice ?? convertAmountSync(requireStoredProductEffectivePrice(a), requireStoredProductCurrency(a, 'USD'), 'USD');
                const priceB = b._comparablePrice ?? convertAmountSync(requireStoredProductEffectivePrice(b), requireStoredProductCurrency(b, 'USD'), 'USD');
                return (priceA - priceB) * order;
            });

        case 'rating':
            return products.sort((a, b) => {
                const scoreA = (a.rating || 0) * 100 + (a.numReviews || 0);
                const scoreB = (b.rating || 0) * 100 + (b.numReviews || 0);
                return (scoreB - scoreA) * order;
            });

        case 'newest':
            return products.sort((a, b) => {
                const dateA = new Date(a.createdAt).getTime();
                const dateB = new Date(b.createdAt).getTime();
                return (dateB - dateA) * order;
            });

        case 'popular':
            return products.sort((a, b) => {
                return ((b.views || 0) - (a.views || 0)) * order;
            });

        case 'sales':
            return products.sort((a, b) => {
                return ((b.totalSales || 0) - (a.totalSales || 0)) * order;
            });

        case 'relevance':
        default:
            // Calculate relevance scores for all products
            const productsWithScores = products.map(product => ({
                ...product,
                _relevanceScore: calculateRelevanceScore(product, sellerProductCounts, totalSellers)
            }));

            // Sort by relevance score
            return productsWithScores.sort((a, b) => b._relevanceScore - a._relevanceScore);
    }
};

const compactProductSearchText = (value) =>
    String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const getProductSearchText = (product) => [
    product.name,
    product.brand,
    product.category,
    product.description,
    ...(Array.isArray(product.tags) ? product.tags : []),
].filter(Boolean).join(' ');

const fuzzyRankProducts = (products, search) => {
    const normalizedSearch = String(search || '').trim();
    if (!normalizedSearch || !products.length) return products;

    const compactSearch = compactProductSearchText(normalizedSearch);
    const searchParts = normalizedSearch
        .toLowerCase()
        .split(/\s+/)
        .map(compactProductSearchText)
        .filter(part => part.length >= 2);

    const directMatches = products.filter(product => {
        const text = compactProductSearchText(getProductSearchText(product));
        return compactSearch && (
            text.includes(compactSearch) ||
            searchParts.every(part => text.includes(part))
        );
    });

    const fuse = new Fuse(products, {
        includeScore: true,
        threshold: 0.52,
        ignoreLocation: true,
        minMatchCharLength: 2,
        keys: [
            { name: 'name', weight: 0.55 },
            { name: 'brand', weight: 0.18 },
            { name: 'category', weight: 0.12 },
            { name: 'tags', weight: 0.1 },
            { name: 'description', weight: 0.05 },
        ],
    });

    const fuzzyMatches = fuse.search(normalizedSearch)
        .filter(result => result.score == null || result.score <= 0.55)
        .map(result => result.item);

    const seen = new Set();
    return [...directMatches, ...fuzzyMatches].filter(product => {
        const key = String(product._id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const parsePagination = (page = 1, limit = 24, maxLimit = 100) => {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(maxLimit, Math.max(1, parseInt(limit, 10) || 24));
    const skip = (pageNum - 1) * limitNum;
    return { pageNum, limitNum, skip };
};

const paginateProductArray = (products, pageNum, limitNum, skip) => {
    const totalProducts = products.length;
    const totalPages = Math.max(1, Math.ceil(totalProducts / limitNum));
    return {
        products: products.slice(skip, skip + limitNum),
        pagination: {
            page: pageNum,
            limit: limitNum,
            totalProducts,
            totalPages,
            hasMore: pageNum < totalPages,
        },
    };
};

exports.getProducts = async (req, res) => {
    const {
        categories,
        brands,
        priceRange,
        search,
        page = 1,
        limit = 24,
        sortBy = 'relevance',
        sortOrder = 'desc',
        currency,
        ids,
        productIds,
    } = { ...req.query }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 24));
    const skip = (pageNum - 1) * limitNum;

    try {
        let query = publicProductFilter()
        if (categories) query.category = Array.isArray(categories) ? { $in: categories } : categories
        const productIdFilter = parseProductIdsFilter(ids, productIds);
        if (productIdFilter.requested) {
            query._id = { $in: productIdFilter.ids };
        }
        const requestedCurrency = normalizeCurrency(currency || req.user?.currency || 'USD');
        const parsedPriceRange = parsePriceRange(priceRange);
        const buyerLocation = buyerLocationFromRequest(req);

        // Only show products from active stores (hides blocked/expired seller products)
        const Store = require('../models/Store');
        const activeStores = await findVisibleStores(Store, { isActive: true }, buyerLocation, {
            select: 'seller verification visibility',
            populate: { path: 'seller', select: '_id' },
        });
        const blockedSellers = blockedIdSet(await getBlockedUserIds(req));
        const activeSellerIds = activeStores
            .map(s => s.seller?._id || s.seller)
            .filter(sellerId => sellerId && !blockedSellers.has(String(sellerId)));

        // Count total active sellers for diversity calculation
        const totalSellers = activeSellerIds.length;

        // Include products with no seller (admin products) + products from active sellers
        const visibilityFilter = {
            $or: [
            { seller: null },
            { seller: { $in: activeSellerIds } },
            ],
        };
        query.$and = [...(query.$and || []), visibilityFilter];

        if (brands) {
            const brandValues = toArray(brands).map(brand => String(brand || '').trim()).filter(Boolean);
            const includeOtherBrands = brandValues.includes(OTHER_BRANDS_FILTER);
            const selectedBrands = brandValues.filter(brand => brand !== OTHER_BRANDS_FILTER);

            if (includeOtherBrands) {
                const popularBrandNames = await getPopularBrandNames(publicProductFilter(visibilityFilter));
                const brandFilters = [];
                if (selectedBrands.length) brandFilters.push({ brand: { $in: selectedBrands } });
                brandFilters.push({ brand: { $nin: popularBrandNames } });
                query.$and.push({ $or: brandFilters });
            } else if (selectedBrands.length) {
                query.brand = selectedBrands.length === 1 ? selectedBrands[0] : { $in: selectedBrands };
            }
        }

        let products = await Product.find(query).lean()
            .populate({
                path: 'seller',
                select: 'username email',
                populate: {
                    path: 'store',
                    select: 'storeName storeSlug verification'
                }
            })
            .lean()

        // Apply tolerant fuzzy search so buyers can find products with partial names and typos.
        if (search) {
            products = fuzzyRankProducts(products, search)
        }

        products = await attachComparablePrices(products, requestedCurrency);
        products = filterByComparablePriceRange(products, parsedPriceRange);

        // Count products per seller for diversity calculation
        const sellerProductCounts = {};
        products.forEach(product => {
            const sellerId = product.seller?._id?.toString() || product.seller?.toString() || 'admin';
            sellerProductCounts[sellerId] = (sellerProductCounts[sellerId] || 0) + 1;
        });

        // Apply intelligent sorting
        products = applySorting(products, sortBy, sortOrder, sellerProductCounts, totalSellers);

        const totalProducts = products.length;
        const totalPages = Math.ceil(totalProducts / limitNum);
        const paginatedProducts = products
            .slice(skip, skip + limitNum)
            .map(product => serializeProductCurrencyMetadata(product, 'USD'));

        res.status(200).json({
            msg: 'fetched products successfully.',
            products: paginatedProducts,
            pagination: {
                page: pageNum,
                limit: limitNum,
                totalProducts,
                totalPages,
                hasMore: pageNum < totalPages,
            },
            sorting: {
                sortBy,
                sortOrder,
                availableSorts: ['relevance', 'price', 'rating', 'newest', 'popular', 'sales']
            }
        })
    } catch (error) {
        console.error('Server error while fetching products:::', error.message);
        res.status(500).json({ msg: 'Server error while fetching products.' })
    }
}

exports.getSingleProduct = async (req, res) => {
    const { id } = req.params
    try {
        const singleProduct = await Product.findById(id)
        if (!singleProduct) {
            return res.status(404).json({ msg: 'Product not found' });
        }
        if (isProductBlocked(singleProduct)) {
            return res.status(404).json({ msg: 'Product not available' });
        }

        // Check if seller's store is active (hide products from blocked sellers)
        let storePolicy = null;
        if (singleProduct.seller) {
            if (await isUserBlocked(req, singleProduct.seller)) {
                return res.status(404).json({ msg: 'Product not available' });
            }
            const store = await findActiveStore({ seller: singleProduct.seller });
            if (!store) {
                return res.status(404).json({ msg: 'Product not available' });
            }
            if (!isStoreVisibleToBuyer(store, buyerLocationFromRequest(req))) {
                return res.status(404).json({ msg: 'Product is not available in your selected area.' });
            }
            const paymentPolicy = normalizeStorePaymentPolicy(store.paymentPolicy);
            storePolicy = {
                storeId: store._id,
                storeName: store.storeName,
                paymentPolicy,
                paymentPolicyLabel: PAYMENT_POLICY_LABELS[paymentPolicy],
                allowsCashOnDelivery: storeAllowsCashOnDelivery(store),
                returnPolicy: normalizeReturnPolicy(store.returnPolicy || {}),
            };
        }

        await singleProduct.populate({
            path: 'reviews.user',
            select: 'avatar username email'
        })
        const blockedReviewers = blockedIdSet(await getBlockedUserIds(req));
        if (blockedReviewers.size && Array.isArray(singleProduct.reviews)) {
            singleProduct.reviews = singleProduct.reviews.filter(review => {
                const reviewerId = review?.user?._id || review?.user;
                return !reviewerId || !blockedReviewers.has(String(reviewerId));
            });
        }
        res.status(200).json({
            msg: 'fetched single product',
            product: serializeProductCurrencyMetadata(singleProduct, 'USD'),
            storePolicy,
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({ msg: 'Server error' })
    }
}


exports.getFilters = async (req, res) => {
    try {
        const Store = require('../models/Store');
        const buyerLocation = buyerLocationFromRequest(req);
        const activeStores = await findVisibleStores(Store, { isActive: true }, buyerLocation, {
            select: 'seller visibility',
            populate: { path: 'seller', select: '_id' },
        });
        const blockedSellers = blockedIdSet(await getBlockedUserIds(req));
        const activeSellerIds = activeStores
            .map(s => s.seller?._id || s.seller)
            .filter(sellerId => sellerId && !blockedSellers.has(String(sellerId)));
        const productScope = publicProductFilter({
            $or: [
                { seller: null },
                { seller: { $in: activeSellerIds } },
            ],
        });

        const [categories, brandStats] = await Promise.all([
            Product.distinct('category', productScope),
            getBrandStats(productScope),
        ]);

        const popularBrands = brandStats
            .filter(brand => brand.count >= POPULAR_BRAND_MIN_PRODUCTS)
            .map(brand => brand.name)
            .sort((a, b) => a.localeCompare(b));
        const otherBrandsCount = brandStats
            .filter(brand => brand.count < POPULAR_BRAND_MIN_PRODUCTS)
            .reduce((sum, brand) => sum + brand.count, 0);

        res.status(200).json({
            categories: cleanList(categories),
            brands: popularBrands,
            otherBrandsCount,
            brandFilter: {
                otherValue: OTHER_BRANDS_FILTER,
                minProducts: POPULAR_BRAND_MIN_PRODUCTS,
            },
        })
    } catch (err) {
        console.error(err)
        res.status(500).json({ error: err })
    }
}

// Add Review to Product (Authenticated Users)
exports.addReview = async (req, res) => {
    const { rating, comment } = req.body
    const { id: prodId } = req.params


    const userId = req.user.id

    try {
        const numericRating = Number(rating);
        const cleanComment = String(comment || '').trim();
        if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
            return res.status(400).json({ msg: 'Rating must be a whole number between 1 and 5.' });
        }
        if (!cleanComment) {
            return res.status(400).json({ msg: 'Please write a review comment.' });
        }
        if (cleanComment.length > 1000) {
            return res.status(400).json({ msg: 'Review comments cannot exceed 1000 characters.' });
        }

        const product = await Product.findById(prodId)
        if (!product || isProductBlocked(product)) {
            return res.status(404).json({ msg: 'Product not available' })
        }

        const eligibility = await findProductReviewEligibility({ userId, product });
        if (!eligibility.eligible) {
            if (eligibility.reason === 'order_not_delivered') {
                return res.status(403).json({
                    msg: 'You will be able to add a review for this product once the order is delivered and you have checked it.',
                    reason: 'order_not_delivered',
                });
            }

            return res.status(403).json({
                msg: "You haven't ordered this product yet, so you can't rate or review it.",
                reason: 'not_ordered',
            });
        }

        const existingReview = product.reviews.find(review => review.user?.toString() === userId);
        if (existingReview) {
            existingReview.rating = numericRating;
            existingReview.comment = cleanComment;
            existingReview.order = eligibility.order._id;
            existingReview.isVerifiedPurchase = true;
        } else {
            product.reviews.push({
                user: userId,
                rating: numericRating,
                comment: cleanComment,
                order: eligibility.order._id,
                isVerifiedPurchase: true,
            })
        }

        await product.populate({
            path: 'reviews.user',
            select: 'username email'
        })


        product.calculateRating()
        await product.save()
        res.status(200).json({ msg: existingReview ? 'Review updated' : 'Review added', product: product })
    } catch (error) {
        console.error('Error while adding review:::', error.message);
        res.status(500).json({ msg: 'Server error while adding review.' })
    }
};


exports.deleteProduct = async (req, res) => {
    const { role, id: userId } = req.user
    const { id } = req.params

    if (role !== 'admin' && role !== 'seller') {
        return res.status(403).json({ msg: 'Unauthorized to delete product' })
    }

    try {
        const product = await Product.findById(id)

        if (!product) {
            return res.status(404).json({ msg: 'Product not found' })
        }

        // Sellers can only delete their own products
        if (role === 'seller' && product.seller?.toString() !== userId) {
            return res.status(403).json({ msg: 'You can only delete your own products' })
        }

        await Product.findByIdAndDelete({ _id: id })
        res.status(200).json({ msg: 'Product deleted successfully' })
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ msg: 'Server error while deleting product' })
    }

}

exports.bulkDeleteProducts = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds } = req.body || {}

    if (role !== 'admin' && role !== 'seller') {
        return res.status(403).json({ msg: 'Unauthorized to delete products' })
    }

    try {
        const selectedProductIds = parseBulkMutationProductIds(productIds, { action: 'delete' })
        const query = { _id: { $in: selectedProductIds } }
        if (role === 'seller') query.seller = userId

        const deletedCount = await runInTransaction(async session => {
            let productQuery = Product.find(query).select('_id')
            if (session) productQuery = productQuery.session(session)
            const products = await productQuery
            assertCompleteBulkProductSelection(products, selectedProductIds)

            // Use the same ownership-scoped selection inside the transaction.
            // A concurrent removal/ownership change must produce a count
            // mismatch and roll back the whole delete rather than partially
            // succeeding against whatever subset remains.
            const result = await Product.deleteMany(query, { session })
            const count = deletedBulkCount(result)
            if (count === null) {
                throw bulkProductMutationError(
                    'The database did not return a trustworthy product deletion count.',
                    { status: 500, code: 'PRODUCT_BULK_DELETE_RESULT_INVALID' }
                )
            }
            if (count !== selectedProductIds.length) {
                throw bulkProductMutationError(
                    'One or more products changed while this deletion was being prepared. No products were deleted; refresh and retry.',
                    { status: 409, code: 'PRODUCT_BULK_DELETE_CONFLICT' }
                )
            }
            return count
        })

        res.status(200).json({
            msg: `Deleted ${deletedCount} product${deletedCount === 1 ? '' : 's'} successfully.`,
            deletedCount,
            skippedCount: 0,
        })
    } catch (error) {
        const status = bulkProductMutationStatus(error)
        if (status >= 500) console.error('Error while bulk deleting products:::', error.message)
        res.status(status).json({
            msg: status < 500 ? error.message : 'Server error while deleting selected products.',
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

/**
 * Check if a seller can feature a product. Returns:
 * { allowed: boolean, current: number, max: number, plan: string, reason?: string }
 */
async function sellerCanFeatureProduct(userId, excludeProductId = null) {
    try {
        return getSellerFeaturedProductQuota(userId, { excludeProductId });
    } catch (e) {
        console.error('sellerCanFeatureProduct error:', e);
        return { allowed: false, current: 0, max: 0, plan: 'free_trial', reason: 'error' };
    }
}

/**
 * GET /api/products/featured-stats — returns the seller's featured product count and limit.
 */
exports.getFeaturedStats = async (req, res) => {
    try {
        const { role, id: userId } = req.user;
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Unauthorized' });
        }
        const stats = await sellerCanFeatureProduct(userId);
        res.json({ current: stats.current, max: stats.max, plan: stats.plan, allowed: stats.allowed });
    } catch (err) {
        console.error('getFeaturedStats:', err);
        res.status(500).json({ msg: 'Failed to fetch featured stats' });
    }
};

exports.editProduct = async (req, res) => {
    try {
        const { id } = req.params
        const { product } = req.body
        const { role, id: userId } = req.user

        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to edit product' })
        }

        const existingProduct = await Product.findById(id)

        if (!existingProduct) {
            return res.status(404).json({ msg: 'Product not found' })
        }

        // Sellers can only edit their own products
        if (role === 'seller' && existingProduct.seller?.toString() !== userId) {
            return res.status(403).json({ msg: 'You can only edit your own products' })
        }

        const sanitizedProduct = sanitizeProductPayload({ ...product });
        const invalidCurrencyField = invalidProductCurrencyField(sanitizedProduct);
        if (invalidCurrencyField) {
            return res.status(400).json({ msg: `${invalidCurrencyField} must be USD, PKR, EUR, or GBP.` });
        }
        const invalidNumber = invalidProductNumber(sanitizedProduct);
        if (invalidNumber) return res.status(400).json({ msg: invalidNumber });
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'name') && !sanitizedProduct.name) {
            return res.status(400).json({ msg: 'Product name is required.' });
        }
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'description') && !sanitizedProduct.description) {
            return res.status(400).json({ msg: 'Product description is required.' });
        }
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'returnPolicy')) {
            sanitizedProduct.returnPolicy = normalizeProductReturnPolicy(sanitizedProduct.returnPolicy, { strict: true });
        }

        const ownerCurrencyState = existingProduct.seller
            ? await getSellerProductCurrencyState(existingProduct.seller)
            : null;
        // Products persisted before native-currency metadata was introduced
        // stored canonical USD. A buyer/seller display preference must never
        // reinterpret that historical number as a different native currency.
        const storedCurrency = requireStoredProductCurrency(existingProduct, 'USD');
        requireStoredProductEffectivePrice(existingProduct);
        const storedBasePrice = requireStoredProductBasePrice(existingProduct);
        const storedDiscountedPrice = requireStoredProductDiscountPrice(existingProduct);
        const targetProductCurrency = ownerCurrencyState?.hasStore
            ? ownerCurrencyState.activeCurrency
            : storedCurrency;
        const requestedCurrency = sanitizedProduct.priceCurrency || sanitizedProduct.currency;
        if (
            sanitizedProduct.price === undefined
            && (
                storedCurrency !== targetProductCurrency
                || (requestedCurrency && normalizeCurrency(requestedCurrency) !== targetProductCurrency)
            )
        ) {
            return res.status(400).json({
                msg: `This store saves products in ${targetProductCurrency}. Include the price to convert it, or change the store product currency from Product Currency settings.`,
            });
        }
        const explicitDiscountUpdate = Object.prototype.hasOwnProperty.call(sanitizedProduct, 'discountedPrice');
        const currencyPayload = { ...sanitizedProduct };
        if (
            currencyPayload.price !== undefined
            && storedDiscountedPrice > 0
            && !explicitDiscountUpdate
        ) {
            currencyPayload.discountedPrice = existingProduct.discountedPrice;
            currencyPayload.discountedPriceCurrency = storedCurrency;
        }
        let safeProduct = await applyProductCurrencyMetadata(
            currencyPayload,
            storedCurrency,
            targetProductCurrency
        );
        const effectiveRegularPrice = safeProduct.price !== undefined
            ? Number(safeProduct.price)
            : storedBasePrice;
        if (safeProduct.discountedPrice > 0 && safeProduct.discountedPrice >= effectiveRegularPrice) {
            if (explicitDiscountUpdate) {
                return res.status(400).json({ msg: 'Discounted price must be lower than the regular price.' });
            }
            safeProduct.discountedPrice = 0;
            safeProduct.discountedPriceCurrency = targetProductCurrency;
            safeProduct.discountedPriceInputAmount = 0;
        }
        if (
            Object.prototype.hasOwnProperty.call(safeProduct, 'discountedPrice')
            && !Object.prototype.hasOwnProperty.call(safeProduct, 'price')
        ) {
            // Positive discount update validators run in Query context. Carry
            // the already validated final price in the same CAS update so the
            // schema can prove discount < price without a second/stale read.
            safeProduct.price = effectiveRegularPrice;
        }

        // Gate: enforce featured product limits based on subscription tier.
        if (role === 'seller' && safeProduct && safeProduct.isFeatured === true) {
            // Exclude this product from the count (since we're editing it)
            const featCheck = await sellerCanFeatureProduct(userId, id);
            if (!featCheck.allowed) {
                if (featCheck.reason === 'limit_reached') {
                    return res.status(403).json({ msg: `You've reached your featured product limit (${featCheck.max}). Upgrade your plan to feature more products.`, featuredStats: featCheck });
                }
                safeProduct.isFeatured = false;
            }
        }

        const wasBlocked = isProductBlocked(existingProduct);
        const mergedProduct = {
            ...existingProduct.toObject(),
            ...safeProduct,
        };
        const { fields: moderationFields } = buildModerationFields(mergedProduct, {
            previouslyBlocked: wasBlocked,
        });
        Object.assign(safeProduct, moderationFields);

        const editFilter = {
            _id: id,
            ...(role === 'seller' ? { seller: userId } : {}),
            ...(existingProduct.updatedAt ? { updatedAt: existingProduct.updatedAt } : {}),
        };
        const updateProduct = async session => {
            if (
                role === 'seller'
                && safeProduct.isFeatured === true
                && existingProduct.isFeatured !== true
            ) {
                await assertSellerCanFeatureProduct(userId, {
                    excludeProductId: existingProduct._id,
                    session,
                });
            }
            return Product.findOneAndUpdate(editFilter,
                { $set: safeProduct },
                { new: true, runValidators: true, ...(session ? { session } : {}) }
            );
        };
        const updatedProduct = existingProduct.seller && ownerCurrencyState?.hasStore
            ? await withProductCurrencyWriteLock(existingProduct.seller, targetProductCurrency, updateProduct)
            : await updateProduct(null);

        if (!updatedProduct) {
            return res.status(409).json({
                msg: 'This product changed while your edit was being prepared. Refresh it and try again.',
                code: 'PRODUCT_UPDATE_CONFLICT',
            });
        }

        if (isProductBlocked(updatedProduct) && !wasBlocked) {
            notifyProductBlocked({ sellerId: updatedProduct.seller, product: updatedProduct }).catch(err =>
                console.error('[productController] product blocked notification failed:', err.message)
            );
        }

        const msg = isProductBlocked(updatedProduct)
            ? `Product updated, but it is blocked because ${updatedProduct.blockedReason || updatedProduct.moderationReason}. Customers cannot see it until it has real product details.`
            : wasBlocked
                ? 'Product updated successfully. It is available to customers again.'
                : 'Product updated successfully.';

        res.status(200).json({
            msg,
            product: serializeProductCurrencyMetadata(updatedProduct, 'USD'),
            blocked: isProductBlocked(updatedProduct),
            moderationReason: updatedProduct.moderationReason || updatedProduct.blockedReason || '',
        })

    } catch (error) {
        console.error(error.message);
        const status = error.status || error.statusCode || 500;
        const trustedRateFailure = error.code === 'EXCHANGE_RATES_UNAVAILABLE';
        res.status(status).json({
            msg: status < 500 || trustedRateFailure ? error.message : 'Server error while editing product.',
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

exports.addProduct = async (req, res) => {
    const { product } = req.body
    const { role, id: userId } = req.user

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to add product' })
        }

        // Sellers must have a store before adding products
        if (role === 'seller') {
            await assertProductCreationAllowed(userId);
        }

        const sanitizedProduct = sanitizeProductPayload({ ...product });
        const invalidCurrencyField = invalidProductCurrencyField(sanitizedProduct);
        if (invalidCurrencyField) {
            return res.status(400).json({ msg: `${invalidCurrencyField} must be USD, PKR, EUR, or GBP.` });
        }
        const invalidNumber = invalidProductNumber(sanitizedProduct);
        if (invalidNumber) return res.status(400).json({ msg: invalidNumber });
        if (!sanitizedProduct.name) {
            return res.status(400).json({ msg: 'Product name is required.' });
        }
        if (!sanitizedProduct.description) {
            return res.status(400).json({ msg: 'Product description is required.' });
        }
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'returnPolicy')) {
            sanitizedProduct.returnPolicy = normalizeProductReturnPolicy(sanitizedProduct.returnPolicy, { strict: true });
        }

        // Gate: enforce featured product limits based on subscription tier.
        const productCurrencyState = role === 'seller'
            ? await assertProductCreationAllowed(userId)
            : null;
        const productEntryCurrency = productCurrencyState?.activeCurrency || req.user?.currency || 'USD';
        let safeProduct = await applyProductCurrencyMetadata({
            ...sanitizedProduct,
            currency: productEntryCurrency,
            priceCurrency: sanitizedProduct?.priceCurrency || sanitizedProduct?.currency || productEntryCurrency,
            discountedPriceCurrency: sanitizedProduct?.discountedPriceCurrency || sanitizedProduct?.discountedCurrency || sanitizedProduct?.currency || productEntryCurrency,
        }, productEntryCurrency, productEntryCurrency);
        if (safeProduct.discountedPrice > 0 && safeProduct.discountedPrice >= safeProduct.price) {
            return res.status(400).json({ msg: 'Discounted price must be lower than the regular price.' });
        }
        if (safeProduct.price === undefined) {
            return res.status(400).json({ msg: 'Product price is required.' });
        }
        if (role === 'seller' && product?.isFeatured === true) {
            const featCheck = await sellerCanFeatureProduct(userId);
            if (!featCheck.allowed) {
                if (featCheck.reason === 'limit_reached') {
                    return res.status(403).json({ msg: `You've reached your featured product limit (${featCheck.max}). Upgrade your plan to feature more products.`, featuredStats: featCheck });
                }
                safeProduct = { ...safeProduct, isFeatured: false };
            }
        }

        const { fields: moderationFields } = buildModerationFields(safeProduct);
        const newProduct = new Product({
            ...safeProduct,
            ...moderationFields,
            seller: role === 'seller' ? userId : null // Only set seller for seller role
        })
        if (role === 'seller') {
            await withProductCurrencyWriteLock(
                userId,
                productEntryCurrency,
                async session => {
                    // This count and the insert share the seller's Store write
                    // lock. If two transactions race, Mongo retries the loser
                    // and this quota check observes the winner's committed row.
                    await assertSellerCanCreateProducts(userId, { session });
                    if (newProduct.isFeatured) {
                        await assertSellerCanFeatureProduct(userId, { session });
                    }
                    return newProduct.save({ session });
                }
            );
        } else {
            await newProduct.save()
        }
        if (isProductBlocked(newProduct)) {
            await notifyProductBlocked({ sellerId: newProduct.seller, product: newProduct });
        }

        res.status(200).json({
            msg: isProductBlocked(newProduct)
                ? `Product added, but it was blocked because ${newProduct.blockedReason || newProduct.moderationReason}. Customers cannot see it until you edit it with real product details.`
                : 'Product added successfully.',
            product: serializeProductCurrencyMetadata(newProduct, 'USD'),
            blocked: isProductBlocked(newProduct),
            moderationReason: newProduct.moderationReason || newProduct.blockedReason || '',
        })

    } catch (error) {
        console.error(error.message);
        const status = error.status || error.statusCode || 500;
        res.status(status).json({
            msg: status < 500 || error.code === 'EXCHANGE_RATES_UNAVAILABLE'
                ? error.message
                : 'Server error while adding new product.',
            productCurrency: error.productCurrencyState,
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

exports.bulkDiscount = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds, discountType, discountValue, currency } = req.body || {}

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to apply bulk discount' })
        }

        const selectedProductIds = parseBulkMutationProductIds(productIds)

        if (!discountType || !['percentage', 'fixed'].includes(discountType)) {
            return res.status(400).json({ msg: 'Discount type must be "percentage" or "fixed"' })
        }

        const parsedDiscountValue = parseStrictFiniteNumber(discountValue)
        const numericDiscountValue = discountType === 'fixed'
            ? normalizeBulkMoneyInput(discountValue, { nonNegative: true })
            : parsedDiscountValue
        if (numericDiscountValue === null || numericDiscountValue <= 0) {
            return res.status(400).json({ msg: 'A positive discount value is required' })
        }
        if (discountType === 'percentage' && numericDiscountValue >= 100) {
            return res.status(400).json({ msg: 'Percentage product discount must be below 100' })
        }
        const inputCurrency = normalizeBulkMutationCurrency(currency, {
            required: discountType === 'fixed',
        })

        // Build query - sellers can only update their own products
        const query = { _id: { $in: selectedProductIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Fetch all products to update
        const products = await Product.find(query)
        assertCompleteBulkProductSelection(products, selectedProductIds)
        const sellerCurrencyState = role === 'seller'
            ? await getSellerProductCurrencyState(userId)
            : null
        if (sellerCurrencyState) assertSellerBulkPricingCurrency(products, sellerCurrencyState)
        const conversionSnapshot = discountType === 'fixed' && products.some(product => (
            inputCurrency && requireStoredProductCurrency(product, 'USD') !== inputCurrency
        )) ? await getExchangeRateSnapshot() : null

        // Compute every value before writing so a failed FX lookup cannot leave
        // a partially updated product selection.
        const updates = await Promise.all(products.map(async (product) => {
            let newDiscountedPrice
            const { productCurrency, price } = requireBulkStoredProductPricing(product)

            if (discountType === 'percentage') {
                // Apply percentage discount
                const discountAmount = percentageOfMoney(price, numericDiscountValue)
                newDiscountedPrice = Math.max(0, price - discountAmount)
            } else {
                // Apply fixed amount discount
                const convertedFixedDiscount = await convertAmountUsingTrustedRates(
                    numericDiscountValue,
                    inputCurrency || productCurrency,
                    productCurrency,
                    conversionSnapshot
                )
                const fixedDiscount = assertRepresentableProductAdjustment({
                    sourceAmount: numericDiscountValue,
                    convertedAmount: convertedFixedDiscount,
                    sourceCurrency: inputCurrency || productCurrency,
                    targetCurrency: productCurrency,
                    productLabel: product.name || `Product ${product._id}`,
                })
                newDiscountedPrice = Math.max(0, price - fixedDiscount)
            }
            const discountedPrice = assertEffectiveProductDiscount({
                regularPrice: price,
                discountedPrice: newDiscountedPrice,
                productLabel: product.name || `Product ${product._id}`,
            })
            return {
                updateOne: {
                    filter: productPricingMutationFilter(product, { role, userId }),
                    update: { $set: {
                        price,
                        discountedPrice,
                        currency: productCurrency,
                        priceCurrency: productCurrency,
                        priceInputAmount: price,
                        discountedPriceCurrency: productCurrency,
                        discountedPriceInputAmount: discountedPrice,
                        priceVersion: 2,
                    } },
                },
            }
        }))

        await writeProductsAtomically(updates, {
            sellerId: role === 'seller' ? userId : null,
            expectedCurrency: sellerCurrencyState?.activeCurrency,
        })

        res.status(200).json({
            msg: `Bulk discount applied successfully to ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        const status = bulkProductMutationStatus(error)
        if (status >= 500) console.error('Error while applying bulk discount:::', error.message)
        res.status(status).json({
            msg: status < 500 || error.code === 'EXCHANGE_RATES_UNAVAILABLE'
                ? error.message
                : 'Server error while applying bulk discount.',
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

exports.bulkPriceUpdate = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds, updateType, value, currency } = req.body || {}

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to update bulk prices' })
        }

        const selectedProductIds = parseBulkMutationProductIds(productIds)

        if (!updateType || !['percentage', 'fixed', 'set'].includes(updateType)) {
            return res.status(400).json({ msg: 'Update type must be "percentage", "fixed", or "set"' })
        }

        const parsedValue = parseStrictFiniteNumber(value)
        const numericValue = updateType === 'percentage'
            ? parsedValue
            : normalizeBulkMoneyInput(value, { nonNegative: updateType === 'set' })
        if (numericValue === null) {
            return res.status(400).json({ msg: 'Value is required' })
        }
        if (updateType !== 'set' && numericValue === 0) {
            return res.status(400).json({ msg: 'A non-zero price change is required' })
        }
        const inputCurrency = normalizeBulkMutationCurrency(currency, {
            required: updateType !== 'percentage',
        })
        if (updateType === 'percentage') {
            // Reject unsafe percentages before loading products or preparing a
            // bulk write. The per-product helper also guards the computed
            // money result against exceeding safe minor-unit bounds.
            applyProductPricePercentage(0, numericValue)
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: selectedProductIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Fetch all products to update
        const products = await Product.find(query)
        assertCompleteBulkProductSelection(products, selectedProductIds)
        const sellerCurrencyState = role === 'seller'
            ? await getSellerProductCurrencyState(userId)
            : null
        if (sellerCurrencyState) assertSellerBulkPricingCurrency(products, sellerCurrencyState)
        const conversionSnapshot = updateType !== 'percentage' && numericValue !== 0 && products.some(product => (
            inputCurrency && requireStoredProductCurrency(product, 'USD') !== inputCurrency
        )) ? await getExchangeRateSnapshot() : null

        const updates = await Promise.all(products.map(async (product) => {
            let newPrice
            const {
                productCurrency,
                price: storedPrice,
                discountedPrice: storedDiscountedPrice,
            } = requireBulkStoredProductPricing(product)

            if (updateType === 'percentage') {
                // Increase/decrease by percentage
                newPrice = applyProductPricePercentage(storedPrice, numericValue)
                // A percentage of an intentionally free product is exactly
                // zero, so retaining zero is valid. For positive products a
                // non-zero request that rounds to no cent-level change must
                // fail instead of reporting a misleading successful update.
                if (storedPrice > 0 && newPrice === storedPrice) {
                    throw bulkProductMutationError(
                        `${product.name || `Product ${product._id}`}'s percentage change is too small to affect its price at the current currency precision.`,
                        { status: 409, code: 'PRODUCT_PRICE_ADJUSTMENT_UNREPRESENTABLE' }
                    )
                }
            } else if (updateType === 'fixed') {
                // Increase/decrease by fixed amount
                const convertedFixedChange = await convertAmountUsingTrustedRates(
                    numericValue,
                    inputCurrency || productCurrency,
                    productCurrency,
                    conversionSnapshot
                )
                const fixedChange = assertRepresentableProductAdjustment({
                    sourceAmount: numericValue,
                    convertedAmount: convertedFixedChange,
                    sourceCurrency: inputCurrency || productCurrency,
                    targetCurrency: productCurrency,
                    productLabel: product.name || `Product ${product._id}`,
                })
                newPrice = Math.max(0, storedPrice + fixedChange)
            } else {
                // Set to specific price
                if (numericValue === 0) {
                    // Zero has no denomination-dependent magnitude. Saving an
                    // explicitly free product must not depend on a live FX
                    // service, and it must clear any now-invalid discount.
                    newPrice = 0
                } else {
                    const convertedSetPrice = await convertAmountUsingTrustedRates(
                        numericValue,
                        inputCurrency || productCurrency,
                        productCurrency,
                        conversionSnapshot
                    )
                    newPrice = assertRepresentablePositiveProductAmount({
                        sourceAmount: numericValue,
                        convertedAmount: convertedSetPrice,
                        sourceCurrency: inputCurrency || productCurrency,
                        targetCurrency: productCurrency,
                        productLabel: product.name || `Product ${product._id}`,
                        field: 'price',
                    })
                }
            }

            const price = roundMoney(newPrice)
            const update = {
                price,
                currency: productCurrency,
                priceCurrency: productCurrency,
                priceInputAmount: price,
                priceVersion: 2,
            }

            // Bulk writes do not run Mongoose update validators, so persist a
            // complete, prevalidated pricing pair rather than an isolated base
            // price that could strand an old discount above the new price.
            const retainedDiscount = storedDiscountedPrice > 0 && storedDiscountedPrice < price
                ? storedDiscountedPrice
                : 0
            update.discountedPrice = retainedDiscount
            update.discountedPriceInputAmount = retainedDiscount
            update.discountedPriceCurrency = productCurrency

            return {
                updateOne: {
                    filter: productPricingMutationFilter(product, { role, userId }),
                    update: { $set: update },
                },
            }
        }))

        await writeProductsAtomically(updates, {
            sellerId: role === 'seller' ? userId : null,
            expectedCurrency: sellerCurrencyState?.activeCurrency,
        })

        res.status(200).json({
            msg: `Bulk price update applied successfully to ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        const status = bulkProductMutationStatus(error)
        if (status >= 500) console.error('Error while updating bulk prices:::', error.message)
        res.status(status).json({
            msg: status < 500 || error.code === 'EXCHANGE_RATES_UNAVAILABLE'
                ? error.message
                : 'Server error while updating bulk prices.',
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

exports.removeDiscount = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds } = req.body || {}

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to remove discounts' })
        }

        const selectedProductIds = parseBulkMutationProductIds(productIds)

        // Build query - sellers can only update their own products
        const query = { _id: { $in: selectedProductIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        const products = await Product.find(query)
        assertCompleteBulkProductSelection(products, selectedProductIds)
        const updates = products.map(product => {
            requireBulkStoredProductPricing(product)
            return {
                updateOne: {
                    filter: productPricingMutationFilter(product, {
                        role,
                        userId,
                        discountOnly: true,
                    }),
                    update: { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } },
                },
            }
        })
        await writeProductsAtomically(updates)

        res.status(200).json({
            msg: `Discounts removed successfully from ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        const status = bulkProductMutationStatus(error)
        if (status >= 500) console.error('Error while removing discounts:::', error.message)
        res.status(status).json({
            msg: status < 500 ? error.message : 'Server error while removing discounts.',
            ...(error.code ? { code: error.code } : {}),
        })
    }
}

// Get seller's products
exports.getSellerProducts = async (req, res) => {
    const { role, id: userId } = req.user
    const {
        categories,
        brands,
        priceRange,
        search,
        currency,
        page = 1,
        limit = 24,
        sortBy = 'newest',
        sortOrder = 'desc',
    } = { ...req.query }

    try {
        if (role !== 'seller') {
            return res.status(403).json({ msg: 'Only sellers can access this endpoint' })
        }

        let query = { seller: userId }

        if (categories) query.category = Array.isArray(categories) ? { $in: categories } : categories
        if (brands) query.brand = Array.isArray(brands) ? { $in: brands } : brands
        const parsedPriceRange = parsePriceRange(priceRange);
        const requestedCurrency = normalizeCurrency(currency || req.user?.currency || 'USD');
        const { pageNum, limitNum, skip } = parsePagination(page, limit, 100);

        let products = await Product.find(query)
            .sort({ createdAt: -1 })
            .populate({
                path: 'seller',
                select: 'username email',
                populate: {
                    path: 'store',
                    select: 'storeName storeSlug isActive blockedAt verification',
                },
            })
            .lean()

        if (search) {
            products = fuzzyRankProducts(products, search)
        }

        products = await attachComparablePrices(products, requestedCurrency);
        products = filterByComparablePriceRange(products, parsedPriceRange);
        products = applySorting(products, sortBy, sortOrder, { [String(userId)]: products.length }, 1);
        const paginated = paginateProductArray(products, pageNum, limitNum, skip);

        res.status(200).json({
            msg: 'Fetched seller products successfully.',
            products: paginated.products.map(product => serializeProductCurrencyMetadata(product, 'USD')),
            pagination: paginated.pagination,
        })
    } catch (error) {
        console.error('Server error while fetching seller products:::', error.message);
        res.status(500).json({ msg: 'Server error while fetching seller products.' })
    }
}

exports.getAdminProducts = async (req, res) => {
    const { role } = req.user
    const {
        categories,
        brands,
        priceRange,
        search,
        currency,
        page = 1,
        limit = 24,
        sortBy = 'newest',
        sortOrder = 'desc',
    } = { ...req.query }

    try {
        if (role !== 'admin') {
            return res.status(403).json({ msg: 'Only admins can access this endpoint' })
        }

        const query = {}
        if (categories) query.category = Array.isArray(categories) ? { $in: categories } : categories
        if (brands) query.brand = Array.isArray(brands) ? { $in: brands } : brands

        const parsedPriceRange = parsePriceRange(priceRange)
        const requestedCurrency = normalizeCurrency(currency || req.user?.currency || 'USD')
        const { pageNum, limitNum, skip } = parsePagination(page, limit, 100)

        let products = await Product.find(query)
            .sort({ createdAt: -1 })
            .populate({
                path: 'seller',
                select: 'username email',
                populate: {
                    path: 'store',
                    select: 'storeName storeSlug isActive blockedAt verification',
                },
            })
            .lean()

        if (search) {
            products = fuzzyRankProducts(products, search)
        }

        products = await attachComparablePrices(products, requestedCurrency)
        products = filterByComparablePriceRange(products, parsedPriceRange)

        const sellerProductCounts = {}
        products.forEach(product => {
            const sellerId = product.seller?._id?.toString() || product.seller?.toString() || 'admin'
            sellerProductCounts[sellerId] = (sellerProductCounts[sellerId] || 0) + 1
        })
        products = applySorting(products, sortBy, sortOrder, sellerProductCounts, Object.keys(sellerProductCounts).length || 1)
        const paginated = paginateProductArray(products, pageNum, limitNum, skip)

        res.status(200).json({
            msg: 'Fetched admin products successfully.',
            products: paginated.products.map(product => serializeProductCurrencyMetadata(product, 'USD')),
            pagination: paginated.pagination,
        })
    } catch (error) {
        console.error('Server error while fetching admin products:::', error.message)
        res.status(500).json({ msg: 'Server error while fetching admin products.' })
    }
}

exports.__private = {
    MAX_BULK_PRODUCT_MUTATIONS,
    applyProductCurrencyMetadata,
    serializeProductCurrencyMetadata,
    invalidProductCurrencyField,
    invalidProductNumber,
    normalizeBulkMoneyInput,
    parseBulkMutationProductIds,
    assertCompleteBulkProductSelection,
    normalizeBulkMutationCurrency,
    assertSellerBulkPricingCurrency,
    productPricingMutationFilter,
    writeProductsAtomically,
};
