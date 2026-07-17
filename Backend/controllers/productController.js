// const { default: Fuse } = require("fuse.js")
const mongoose = require('mongoose')
const Product = require("../models/Product")
const Order = require("../models/Order")
const Fuse = require('fuse.js')
const {
    buildModerationFields,
    isProductBlocked,
    notifyProductBlocked,
    publicProductFilter,
} = require('../services/productModerationService')
const { normalizeCurrency, convertAmount, convertAmountSync } = require('../services/currencyService')
const {
    roundMoney,
    getProductCurrency,
    getProductEffectivePrice,
} = require('../services/productPricingService')
const { assertProductCreationAllowed } = require('../services/storeProductCurrencyService')
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

const OTHER_BRANDS_FILTER = '__other_brands__';
const POPULAR_BRAND_MIN_PRODUCTS = Math.max(2, parseInt(process.env.POPULAR_BRAND_MIN_PRODUCTS || '3', 10) || 3);

const cleanList = (items) => [...new Set(
    (items || []).map(item => String(item || '').trim()).filter(Boolean)
)].sort((a, b) => a.localeCompare(b));

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

async function applyProductCurrencyMetadata(product, fallbackCurrency = 'USD') {
    if (!product || typeof product !== 'object') return product;
    const productCurrency = normalizeCurrency(product.currency || fallbackCurrency);
    const priceSourceCurrency = normalizeCurrency(product.priceCurrency || product.currency || productCurrency);
    const next = { ...product };

    if (next.price !== undefined && next.price !== '') {
        const rawPrice = roundMoney(next.price);
        next.price = priceSourceCurrency === productCurrency
            ? rawPrice
            : await convertAmount(rawPrice, priceSourceCurrency, productCurrency);
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
        const discountCurrency = normalizeCurrency(product.discountedPriceCurrency || product.discountedCurrency || productCurrency);
        const rawDiscount = roundMoney(next.discountedPrice);
        const convertedDiscount = rawDiscount > 0
            ? await convertAmount(rawDiscount, discountCurrency, productCurrency)
            : 0;
        next.discountedPrice = next.price !== undefined && convertedDiscount >= Number(next.price)
            ? 0
            : convertedDiscount;
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
            _comparablePrice: await convertAmount(getProductEffectivePrice(plainProduct), getProductCurrency(plainProduct), currency),
        };
    }));
}

function filterByComparablePriceRange(products, range) {
    if (!range || (range.min === null && range.max === null)) return products;
    return products.filter(product => {
        const price = Number(product._comparablePrice ?? convertAmountSync(
            getProductEffectivePrice(product),
            getProductCurrency(product),
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
                const priceA = a._comparablePrice ?? convertAmountSync(getProductEffectivePrice(a), getProductCurrency(a), 'USD');
                const priceB = b._comparablePrice ?? convertAmountSync(getProductEffectivePrice(b), getProductCurrency(b), 'USD');
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
        const activeSellerIds = activeStores.map(s => s.seller?._id || s.seller).filter(Boolean);

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
        const paginatedProducts = products.slice(skip, skip + limitNum);

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
            const Store = require('../models/Store');
            const store = await Store.findOne({ seller: singleProduct.seller, isActive: true });
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
        res.status(200).json({ msg: 'fetched single product', product: singleProduct, storePolicy })
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
        const activeSellerIds = activeStores.map(s => s.seller?._id || s.seller).filter(Boolean);
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
        if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
            return res.status(400).json({ msg: 'Rating must be between 1 and 5.' });
        }
        if (!cleanComment) {
            return res.status(400).json({ msg: 'Please write a review comment.' });
        }

        const product = await Product.findById(prodId)
        if (!product || isProductBlocked(product)) {
            return res.status(404).json({ msg: 'Product not available' })
        }

        const baseOrderQuery = {
            user: userId,
            awaitingPayment: { $ne: true },
            'orderItems.productId': prodId,
            orderStatus: { $ne: 'cancelled' },
        };
        const deliveredOrder = await Order.exists({
            ...baseOrderQuery,
            orderStatus: 'delivered',
        });

        if (!deliveredOrder) {
            const anyOrder = await Order.exists(baseOrderQuery);
            if (anyOrder) {
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
        } else {
            product.reviews.push({
                user: userId,
                rating: numericRating,
                comment: cleanComment
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

// ── Featured product limits by plan tier ──
const FEATURED_LIMITS = {
    free_trial: 6,
    starter: 6,
    elite: 12,
};

exports.bulkDeleteProducts = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds } = req.body

    if (role !== 'admin' && role !== 'seller') {
        return res.status(403).json({ msg: 'Unauthorized to delete products' })
    }

    try {
        if (!Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Select at least one product to delete.' })
        }

        const uniqueIds = [...new Set(productIds.map(id => String(id || '').trim()))]
        const validIds = uniqueIds.filter(id => mongoose.Types.ObjectId.isValid(id))

        if (validIds.length === 0) {
            return res.status(400).json({ msg: 'No valid product IDs were provided.' })
        }
        if (validIds.length > 250) {
            return res.status(400).json({ msg: 'You can delete up to 250 products at a time.' })
        }

        const query = { _id: { $in: validIds } }
        if (role === 'seller') query.seller = userId

        const products = await Product.find(query).select('_id name')
        if (products.length === 0) {
            return res.status(404).json({ msg: 'No products found or you do not have permission to delete them.' })
        }

        const idsToDelete = products.map(product => product._id)
        const result = await Product.deleteMany({ _id: { $in: idsToDelete } })
        const deletedCount = result.deletedCount || products.length

        res.status(200).json({
            msg: `Deleted ${deletedCount} product${deletedCount === 1 ? '' : 's'} successfully.`,
            deletedCount,
            skippedCount: uniqueIds.length - products.length,
        })
    } catch (error) {
        console.error('Error while bulk deleting products:::', error.message);
        res.status(500).json({ msg: 'Server error while deleting selected products.' })
    }
}

/**
 * Check if a seller can feature a product. Returns:
 * { allowed: boolean, current: number, max: number, plan: string, reason?: string }
 */
async function sellerCanFeatureProduct(userId, excludeProductId = null) {
    try {
        const SellerSubscription = require('../models/SellerSubscription');
        const sub = await SellerSubscription.findOne({ seller: userId });

        // Determine plan tier and entitlement
        let plan = 'free_trial';
        let entitled = false;

        if (!sub) {
            // No subscription record — trial-grace
            plan = 'free_trial';
            entitled = true;
        } else if (sub.status === 'trial') {
            plan = 'free_trial';
            entitled = true;
        } else if (sub.plan === 'elite' && ['active', 'free_period'].includes(sub.status)) {
            plan = 'elite';
            entitled = true;
        } else if (['active', 'free_period'].includes(sub.status)) {
            plan = sub.plan || 'starter';
            // Starter: needs bonus features active OR just allow (featured is a core feature per tier now)
            entitled = true;
        } else if (sub.bonusFeaturesActive && (!sub.bonusExpiryDate || new Date() < sub.bonusExpiryDate)) {
            plan = sub.plan || 'starter';
            entitled = true;
        } else {
            plan = sub.plan || 'free_trial';
            entitled = false;
        }

        if (!entitled) {
            return { allowed: false, current: 0, max: 0, plan, reason: 'not_entitled' };
        }

        const max = FEATURED_LIMITS[plan] || FEATURED_LIMITS.free_trial;

        // Count current featured products for this seller
        const query = publicProductFilter({ seller: userId, isFeatured: true });
        if (excludeProductId) {
            query._id = { $ne: excludeProductId };
        }
        const current = await Product.countDocuments(query);

        if (current >= max) {
            return { allowed: false, current, max, plan, reason: 'limit_reached' };
        }

        return { allowed: true, current, max, plan };
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
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'name') && !sanitizedProduct.name) {
            return res.status(400).json({ msg: 'Product name is required.' });
        }
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'description') && !sanitizedProduct.description) {
            return res.status(400).json({ msg: 'Product description is required.' });
        }
        if (Object.prototype.hasOwnProperty.call(sanitizedProduct, 'returnPolicy')) {
            sanitizedProduct.returnPolicy = normalizeProductReturnPolicy(sanitizedProduct.returnPolicy, { strict: true });
        }

        let safeProduct = await applyProductCurrencyMetadata(sanitizedProduct, req.user?.currency || 'USD');
        if (
            safeProduct.price !== undefined &&
            existingProduct.discountedPrice > 0 &&
            getProductCurrency(existingProduct, req.user?.currency || 'USD') !== normalizeCurrency(safeProduct.currency || safeProduct.priceCurrency)
        ) {
            safeProduct.discountedPrice = 0;
            safeProduct.discountedPriceCurrency = safeProduct.currency || safeProduct.priceCurrency;
            safeProduct.discountedPriceInputAmount = 0;
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
        const { fields: moderationFields } = buildModerationFields(mergedProduct);
        Object.assign(safeProduct, moderationFields);

        const updatedProduct = await Product.findByIdAndUpdate(id,
            { $set: safeProduct },
            { new: true, runValidators: true }
        )

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
            blocked: isProductBlocked(updatedProduct),
            moderationReason: updatedProduct.moderationReason || updatedProduct.blockedReason || '',
        })

    } catch (error) {
        console.error(error.message);
        const status = error.status || error.statusCode || 500;
        res.status(status).json({ msg: status < 500 ? error.message : 'Server error while editing product.' })
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

            // Enforce product limit for trial sellers (15 products max)
            const SellerSubscription = require('../models/SellerSubscription');
            const sub = await SellerSubscription.findOne({ seller: userId });
            if (sub && sub.status === 'trial') {
                const productCount = await Product.countDocuments({ seller: userId });
                if (productCount >= 15) {
                    return res.status(403).json({ msg: 'You have reached the maximum of 15 product listings during your free trial. Subscribe to add unlimited products.' });
                }
            }
        }

        const sanitizedProduct = sanitizeProductPayload({ ...product });
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
        }, productEntryCurrency);
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
        await newProduct.save()
        if (isProductBlocked(newProduct)) {
            await notifyProductBlocked({ sellerId: newProduct.seller, product: newProduct });
        }

        res.status(200).json({
            msg: isProductBlocked(newProduct)
                ? `Product added, but it was blocked because ${newProduct.blockedReason || newProduct.moderationReason}. Customers cannot see it until you edit it with real product details.`
                : 'Product added successfully.',
            product: newProduct,
            blocked: isProductBlocked(newProduct),
            moderationReason: newProduct.moderationReason || newProduct.blockedReason || '',
        })

    } catch (error) {
        console.error(error.message);
        const status = error.status || error.statusCode || 500;
        res.status(status).json({
            msg: status < 500 ? error.message : 'Server error while adding new product.',
            productCurrency: error.productCurrencyState,
        })
    }
}

exports.bulkDiscount = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds, discountType, discountValue, currency } = req.body

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to apply bulk discount' })
        }

        // Validate input
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Product IDs array is required' })
        }

        if (!discountType || !['percentage', 'fixed'].includes(discountType)) {
            return res.status(400).json({ msg: 'Discount type must be "percentage" or "fixed"' })
        }

        if (discountValue === undefined || discountValue < 0) {
            return res.status(400).json({ msg: 'Valid discount value is required' })
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: productIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Fetch all products to update
        const products = await Product.find(query)

        if (products.length === 0) {
            return res.status(404).json({ msg: 'No products found or you do not have permission to update these products' })
        }

        // Apply discount to each product
        const updatePromises = products.map(async (product) => {
            let newDiscountedPrice
            const productCurrency = getProductCurrency(product, req.user?.currency || 'USD')

            if (discountType === 'percentage') {
                // Apply percentage discount
                const discountAmount = (product.price * discountValue) / 100
                newDiscountedPrice = Math.max(0, product.price - discountAmount)
            } else {
                // Apply fixed amount discount
                const fixedDiscount = await convertAmount(discountValue, normalizeCurrency(currency || productCurrency), productCurrency)
                newDiscountedPrice = Math.max(0, product.price - fixedDiscount)
            }

            product.discountedPrice = Math.round(newDiscountedPrice * 100) / 100
            product.discountedPriceCurrency = productCurrency
            product.discountedPriceInputAmount = product.discountedPrice
            return product.save()
        })

        await Promise.all(updatePromises)

        res.status(200).json({
            msg: `Bulk discount applied successfully to ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        console.error('Error while applying bulk discount:::', error.message);
        res.status(500).json({ msg: 'Server error while applying bulk discount.' })
    }
}

exports.bulkPriceUpdate = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds, updateType, value, currency } = req.body

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to update bulk prices' })
        }

        // Validate input
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Product IDs array is required' })
        }

        if (!updateType || !['percentage', 'fixed', 'set'].includes(updateType)) {
            return res.status(400).json({ msg: 'Update type must be "percentage", "fixed", or "set"' })
        }

        if (value === undefined) {
            return res.status(400).json({ msg: 'Value is required' })
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: productIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Fetch all products to update
        const products = await Product.find(query)

        if (products.length === 0) {
            return res.status(404).json({ msg: 'No products found or you do not have permission to update these products' })
        }

        // Update price for each product
        const updatePromises = products.map(async (product) => {
            let newPrice
            const productCurrency = getProductCurrency(product, req.user?.currency || 'USD')

            if (updateType === 'percentage') {
                // Increase/decrease by percentage
                const changeAmount = (product.price * value) / 100
                newPrice = Math.max(0, product.price + changeAmount)
            } else if (updateType === 'fixed') {
                // Increase/decrease by fixed amount
                const fixedChange = await convertAmount(value, normalizeCurrency(currency || productCurrency), productCurrency)
                newPrice = Math.max(0, product.price + fixedChange)
            } else {
                // Set to specific price
                newPrice = Math.max(0, await convertAmount(value, normalizeCurrency(currency || productCurrency), productCurrency))
            }

            product.price = Math.round(newPrice * 100) / 100
            product.currency = productCurrency
            product.priceCurrency = productCurrency
            product.priceInputAmount = product.price
            product.priceVersion = 2

            // Reset discounted price if it's higher than new price
            if (product.discountedPrice > 0 && product.discountedPrice >= product.price) {
                product.discountedPrice = 0
                product.discountedPriceInputAmount = 0
            }

            return product.save()
        })

        await Promise.all(updatePromises)

        res.status(200).json({
            msg: `Bulk price update applied successfully to ${products.length} product(s)`,
            updatedCount: products.length
        })

    } catch (error) {
        console.error('Error while updating bulk prices:::', error.message);
        res.status(500).json({ msg: 'Server error while updating bulk prices.' })
    }
}

exports.removeDiscount = async (req, res) => {
    const { role, id: userId } = req.user
    const { productIds } = req.body

    try {
        if (role !== 'admin' && role !== 'seller') {
            return res.status(403).json({ msg: 'Unauthorized to remove discounts' })
        }

        // Validate input
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
            return res.status(400).json({ msg: 'Product IDs array is required' })
        }

        // Build query - sellers can only update their own products
        const query = { _id: { $in: productIds } }
        if (role === 'seller') {
            query.seller = userId
        }

        // Update all products to remove discount
        const result = await Product.updateMany(
            query,
            { $set: { discountedPrice: 0 } }
        )

        res.status(200).json({
            msg: `Discounts removed successfully from ${result.modifiedCount} product(s)`,
            updatedCount: result.modifiedCount
        })

    } catch (error) {
        console.error('Error while removing discounts:::', error.message);
        res.status(500).json({ msg: 'Server error while removing discounts.' })
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
            products: paginated.products,
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
            products: paginated.products,
            pagination: paginated.pagination,
        })
    } catch (error) {
        console.error('Server error while fetching admin products:::', error.message)
        res.status(500).json({ msg: 'Server error while fetching admin products.' })
    }
}
