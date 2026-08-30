// Controller to handle subdomain store requests
const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { publicProductFilter } = require('../services/productModerationService');
const { convertAmountSync } = require('../services/currencyService');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const {
    resolveRequestedCurrency,
    sellerCurrencyMoneyPresentation,
    sellerOrderSummaryForItems,
    isSellerRevenueRecognized,
    sumCurrencyAmountsInCurrency,
} = require('../services/orderMoneyService');
const {
    buyerLocationFromRequest,
    isStoreVisibleToBuyer,
} = require('../services/storeVisibilityService');
const { attachStoreReviewSummaries } = require('../services/storeReviewService');
const { changeStoreSlug } = require('../services/subdomainSlugMutationService');

const comparablePriceUSD = (product) =>
    convertAmountSync(getProductEffectivePrice(product), getProductCurrency(product), 'USD');

const idString = (value) => String(value?._id || value || '');

const sellerItemsForOrder = (order, sellerId, productIds = []) => {
    const sellerKey = idString(sellerId);
    const productKeys = new Set(productIds.map(idString));
    return (order?.orderItems || []).filter((item) => {
        // Newer orders carry an immutable seller snapshot. It is authoritative;
        // live product ownership is only a legacy fallback for unsnapshotted rows.
        if (item?.seller) return idString(item.seller) === sellerKey;
        return productKeys.has(idString(item?.productId));
    });
};

const sellerOrderScope = (sellerId, productIds = []) => ({
    $or: [
        { 'orderItems.seller': sellerId },
        ...(productIds.length ? [{
            orderItems: {
                $elemMatch: {
                    seller: null,
                    productId: { $in: productIds },
                },
            },
        }] : []),
    ],
});

// Get store data for subdomain
exports.getSubdomainStore = async (req, res) => {
    try {
        // Check if store is blocked
        if (req.subdomainStoreBlocked) {
            return res.status(403).json({
                msg: 'Store temporarily unavailable',
                blocked: true,
                storeName: req.subdomainStoreName || 'This store',
            });
        }

        if (!req.subdomainStore) {
            return res.status(404).json({ msg: 'Store not found' });
        }
        const store = req.subdomainStore;
        if (!isStoreVisibleToBuyer(store, buyerLocationFromRequest(req))) {
            return res.status(404).json({ msg: 'Store is not available in your selected area.' });
        }
        const [storeWithRating] = await attachStoreReviewSummaries([store]);
        res.status(200).json({
            msg: 'Store fetched successfully',
            store: storeWithRating,
            isSubdomain: true
        });
    } catch (error) {
        console.error('Get subdomain store error:', error);
        res.status(500).json({ msg: 'Server error while fetching store' });
    }
};

// Get products for subdomain store
exports.getSubdomainProducts = async (req, res) => {
    try {
        if (!req.subdomainStore) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const { categories, brands, priceRange, search, page = 1, limit = 20 } = req.query;
        const store = req.subdomainStore;
        if (!isStoreVisibleToBuyer(store, buyerLocationFromRequest(req))) {
            return res.status(404).json({ msg: 'Store products are not available in your selected area.' });
        }

        // Build query for products
        let query = publicProductFilter({ seller: store.seller });

        // Apply filters
        if (categories) {
            const categoryArray = Array.isArray(categories) ? categories : [categories];
            query.category = { $in: categoryArray };
        }

        if (brands) {
            const brandArray = Array.isArray(brands) ? brands : [brands];
            query.brand = { $in: brandArray };
        }

        let priceMinUSD = null;
        let priceMaxUSD = null;
        if (priceRange) {
            const [min, max] = priceRange.split(',').map(Number);
            priceMinUSD = Number.isFinite(min) ? min : null;
            priceMaxUSD = Number.isFinite(max) ? max : null;
        }

        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        // Pagination
        const skip = (page - 1) * limit;

        let products = await Product.find(query).sort({ createdAt: -1 });

        if (priceMinUSD !== null || priceMaxUSD !== null) {
            products = products.filter((p) => {
                const v = comparablePriceUSD(p);
                if (priceMinUSD !== null && v < priceMinUSD) return false;
                if (priceMaxUSD !== null && v > priceMaxUSD) return false;
                return true;
            });
        }

        const total = products.length;
        products = products.slice(skip, skip + parseInt(limit));

        res.status(200).json({
            msg: 'Products fetched successfully',
            products,
            pagination: {
                total,
                page: parseInt(page),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get subdomain products error:', error);
        res.status(500).json({ msg: 'Server error while fetching products' });
    }
};

// ============================
// SELLER SUBDOMAIN ANALYTICS
// ============================
exports.getSellerSubdomainAnalytics = async (req, res) => {
    if (req.user?.role !== 'seller') {
        return res.status(403).json({ msg: 'Seller access required' });
    }

    try {
        const sellerId = req.user.id;
        const store = await Store.findOne({ seller: sellerId });

        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        // Get product count and order data
        const products = await Product.find({ seller: sellerId }).select('_id');
        const productIds = products.map(p => p._id);

        const orders = await Order.find({
            ...sellerOrderScope(sellerId, productIds),
            awaitingPayment: { $ne: true },
        });

        const targetCurrency = await resolveRequestedCurrency(req, User);
        const recognizedOrders = orders.filter(order => isSellerRevenueRecognized(order, sellerId));
        const revenueEntries = recognizedOrders.map(order => {
            const sellerItems = sellerItemsForOrder(order, sellerId, productIds);
            const sellerMoney = sellerOrderSummaryForItems(order, sellerId, sellerItems);
            const native = sellerCurrencyMoneyPresentation(order, sellerId, sellerItems);
            return {
                amount: native?.summary?.totalAmount ?? sellerMoney.totalAmount,
                currency: native?.currency || order.currency,
            };
        });
        const totalRevenue = await sumCurrencyAmountsInCurrency(revenueEntries, targetCurrency);
        const totalOrders = recognizedOrders.length;

        // Store views are currently retained only as a lifetime counter. Do not
        // fabricate a monthly series: consumers can render the real total and an
        // honest unavailable-history state until dated traffic events are stored.
        const totalViews = store.views || 0;
        const now = new Date();

        const removalAt = store.subdomainPurchase?.removalScheduledAt;
        const isPurchased = !!(store.subdomainPurchase?.isPurchased &&
            store.subdomainPurchase?.expiresAt &&
            new Date(store.subdomainPurchase.expiresAt) > now);
        const blocked = store.isActive === false;
        const daysUntilRemoval = (blocked && !isPurchased && removalAt)
            ? Math.max(0, Math.ceil((new Date(removalAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
            : null;

        res.status(200).json({
            msg: 'Subdomain analytics fetched',
            subdomain: {
                slug: store.storeSlug,
                url: `${store.storeSlug}.rozare.com`,
                isActive: !blocked,
                blocked,
                blockedAt: store.blockedAt || null,
                daysUntilRemoval,
                isPurchased,
                verificationStatus: store.verification?.status || 'none',
                createdAt: store.createdAt,
                storeName: store.storeName,
                logo: store.logo,
                lastSlugChangeAt: store.lastSlugChangeAt || null,
                lastNameChangeAt: store.lastNameChangeAt || null,
                lastTypeChangeAt: store.lastTypeChangeAt || null,
            },
            analytics: {
                currency: targetCurrency,
                totalViews,
                totalOrders,
                totalRevenue,
                productCount: products.length,
                trustCount: store.trustCount || 0,
                monthlyTraffic: [],
                trafficHistoryAvailable: false,
                conversionRate: totalViews > 0 ? Math.round((totalOrders / totalViews) * 10000) / 100 : 0,
            }
        });
    } catch (error) {
        console.error('Seller subdomain analytics error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error fetching subdomain analytics',
            code: error.code,
        });
    }
};

// ============================
// ADMIN: GET ALL SUBDOMAINS
// ============================
exports.getAllSubdomains = async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ msg: 'Access denied. Admin privileges required.' });
    }

    try {
        const { status, search, page = 1, limit = 20 } = req.query;

        let query = {};

        // Filter by subdomain/store availability. Verification is separate from routing.
        if (status === 'active') {
            query.isActive = { $ne: false };
        } else if (status === 'inactive') {
            query.isActive = false;
        } else if (status === 'pending') {
            query['verification.status'] = 'pending';
        }

        // Search by store name or slug
        if (search) {
            query.$or = [
                { storeName: { $regex: search, $options: 'i' } },
                { storeSlug: { $regex: search, $options: 'i' } },
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const stores = await Store.find(query)
            .populate('seller', 'username email')
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(skip);

        const total = await Store.countDocuments(query);
        const targetCurrency = await resolveRequestedCurrency(req, User);

        // Enrich with product count and revenue
        const enrichedStores = await Promise.all(stores.map(async (store) => {
            const sellerId = store.seller?._id || store.seller;
            const products = await Product.find({ seller: sellerId }).select('_id');
            const productIds = products.map(p => p._id);

            const orders = await Order.find({
                ...sellerOrderScope(sellerId, productIds),
                awaitingPayment: { $ne: true },
            });

            const recognizedOrders = orders.filter(order => isSellerRevenueRecognized(order, sellerId));
            const revenueEntries = recognizedOrders.map(order => {
                const sellerItems = sellerItemsForOrder(order, sellerId, productIds);
                const sellerMoney = sellerOrderSummaryForItems(order, sellerId, sellerItems);
                const native = sellerCurrencyMoneyPresentation(order, sellerId, sellerItems);
                return {
                    amount: native?.summary?.totalAmount ?? sellerMoney.totalAmount,
                    currency: native?.currency || order.currency,
                };
            });
            const totalRevenue = await sumCurrencyAmountsInCurrency(revenueEntries, targetCurrency);

            return {
                _id: store._id,
                storeName: store.storeName,
                storeSlug: store.storeSlug,
                logo: store.logo,
                seller: store.seller,
                views: store.views || 0,
                trustCount: store.trustCount || 0,
                isActive: store.isActive,
                verification: store.verification,
                createdAt: store.createdAt,
                subdomainUrl: `${store.storeSlug}.rozare.com`,
                isSubdomainActive: store.isActive !== false,
                productCount: products.length,
                totalOrders: recognizedOrders.length,
                totalRevenue,
            };
        }));

        // Summary stats
        const allStores = await Store.find({});
        const totalStores = allStores.length;
        const activeSubdomains = allStores.filter(s => s.isActive !== false).length;
        const inactiveSubdomains = totalStores - activeSubdomains;
        const pendingVerifications = allStores.filter(s => s.verification?.status === 'pending').length;
        const totalViewsAll = allStores.reduce((sum, s) => sum + (s.views || 0), 0);

        res.status(200).json({
            msg: 'All subdomains fetched',
            currency: targetCurrency,
            stores: enrichedStores,
            summary: {
                totalStores,
                activeSubdomains,
                inactiveSubdomains,
                pendingVerifications,
                totalViews: totalViewsAll,
            },
            pagination: {
                total,
                page: parseInt(page),
                pages: Math.ceil(total / parseInt(limit)),
            }
        });
    } catch (error) {
        console.error('Admin get all subdomains error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error fetching subdomains',
            code: error.code,
        });
    }
};

// ============================
// ADMIN: UPDATE SUBDOMAIN SLUG
// ============================
exports.adminUpdateSubdomain = async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ msg: 'Access denied. Admin privileges required.' });
    }

    try {
        const { storeId } = req.params;
        const { newSlug, confirmPurchasedForfeit } = req.body;

        const store = await Store.findById(storeId);
        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        const result = await changeStoreSlug({
            storeId: store._id,
            sellerId: store.seller,
            expectedSlug: store.storeSlug,
            newSlug,
            confirmPurchasedForfeit: confirmPurchasedForfeit === true,
            actor: {
                type: 'admin',
                id: req.user.id || req.user._id,
                reason: req.body.reason || 'Administrative subdomain reassignment',
            },
        });

        res.status(200).json({
            msg: result.changed ? 'Subdomain updated successfully' : 'Subdomain was already up to date',
            store: result.store,
            purchasedOwnershipForfeited: result.forfeitedPurchasedOwnership,
        });
    } catch (error) {
        console.error('Admin update subdomain error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error updating subdomain',
            ...(error.code ? { code: error.code } : {}),
            ...(error.requiresConfirmation ? {
                requiresConfirmation: true,
                currentSubdomain: error.currentSubdomain,
                newSubdomain: error.newSubdomain,
            } : {}),
        });
    }
};
