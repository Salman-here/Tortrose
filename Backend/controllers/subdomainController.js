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
    convertOrderTotal,
    roundMoney,
} = require('../services/orderMoneyService');
const {
    buyerLocationFromRequest,
    isStoreVisibleToBuyer,
} = require('../services/storeVisibilityService');
const { attachStoreReviewSummaries } = require('../services/storeReviewService');

const comparablePriceUSD = (product) =>
    convertAmountSync(getProductEffectivePrice(product), getProductCurrency(product), 'USD');

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
            'orderItems.productId': { $in: productIds },
            isPaid: true
        });

        const targetCurrency = await resolveRequestedCurrency(req, User);
        let totalRevenue = 0;
        for (const order of orders) {
            totalRevenue += await convertOrderTotal(order, targetCurrency);
        }
        totalRevenue = roundMoney(totalRevenue);
        const totalOrders = orders.length;

        // Simulate subdomain traffic data (views is the closest proxy)
        const totalViews = store.views || 0;

        // Monthly traffic simulation from views
        const now = new Date();
        const monthlyTraffic = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthLabel = d.toLocaleDateString('en', { month: 'short', year: '2-digit' });
            // Distribute views proportionally with some variance
            const baseViews = Math.floor(totalViews / 6);
            const variance = Math.floor(Math.random() * Math.max(baseViews * 0.3, 5));
            monthlyTraffic.push({
                month: monthLabel,
                views: Math.max(0, baseViews + (i === 0 ? variance : -variance + Math.floor(Math.random() * variance * 2))),
            });
        }

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
                monthlyTraffic,
                conversionRate: totalViews > 0 ? Math.round((totalOrders / totalViews) * 10000) / 100 : 0,
            }
        });
    } catch (error) {
        console.error('Seller subdomain analytics error:', error);
        res.status(500).json({ msg: 'Server error fetching subdomain analytics' });
    }
};

// ============================
// ADMIN: GET ALL SUBDOMAINS
// ============================
exports.getAllSubdomains = async (req, res) => {
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
            const products = await Product.find({ seller: store.seller?._id }).select('_id');
            const productIds = products.map(p => p._id);

            const orders = await Order.find({
                'orderItems.productId': { $in: productIds },
                isPaid: true
            });

            let totalRevenue = 0;
            for (const order of orders) {
                totalRevenue += await convertOrderTotal(order, targetCurrency);
            }
            totalRevenue = roundMoney(totalRevenue);

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
                totalOrders: orders.length,
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
        res.status(500).json({ msg: 'Server error fetching subdomains' });
    }
};

// ============================
// ADMIN: UPDATE SUBDOMAIN SLUG
// ============================
exports.adminUpdateSubdomain = async (req, res) => {
    try {
        const { storeId } = req.params;
        const { newSlug } = req.body;

        if (!newSlug || newSlug.trim().length < 3) {
            return res.status(400).json({ msg: 'Subdomain must be at least 3 characters' });
        }

        const sanitized = newSlug.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

        const reserved = ['www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog', 'docs', 'help', 'cdn', 'static', 'support'];
        if (reserved.includes(sanitized)) {
            return res.status(400).json({ msg: 'This subdomain is reserved' });
        }

        const existing = await Store.findOne({ storeSlug: sanitized, _id: { $ne: storeId } });
        if (existing) {
            return res.status(409).json({ msg: 'This subdomain is already taken' });
        }

        const store = await Store.findById(storeId);
        if (!store) {
            return res.status(404).json({ msg: 'Store not found' });
        }

        store.storeSlug = sanitized;
        await store.save();

        res.status(200).json({ msg: 'Subdomain updated successfully', store });
    } catch (error) {
        console.error('Admin update subdomain error:', error);
        res.status(500).json({ msg: 'Server error updating subdomain' });
    }
};
