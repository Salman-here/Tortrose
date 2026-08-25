const Product = require('../models/Product');
const Order = require('../models/Order');
const Store = require('../models/Store');
const User = require('../models/User');
const Complaint = require('../models/Complaint');
const TaxConfig = require('../models/TaxConfig');
const ShippingMethod = require('../models/ShippingMethod');
const {
    buildModerationFields,
    isProductBlocked,
    notifyProductBlocked,
    publicProductFilter,
} = require('../services/productModerationService');
const { convertAmountSync, convertAmount, isSupportedCurrency, normalizeCurrency, formatMoney } = require('../services/currencyService');
const { roundMoney: roundMoneyExact } = require('../services/moneyMath');
const { getProductCurrency, getProductEffectivePrice } = require('../services/productPricingService');
const {
    applyActiveSellerProductFilter,
    getActiveSellerIds,
    isProductSellerPubliclyActive,
} = require('../services/publicCatalogService');
const {
    resolveRequestedCurrency,
    convertOrderAmount,
    convertOrderTotal,
    lineTotal,
    roundMoney,
    sellerOrderSummaryForItems,
    getAccountingOrderCurrency,
    requireStoredOrderMoney,
} = require('../services/orderMoneyService');
const {
    ensureOrderSellerFulfillment,
    sellerFulfillmentFor,
    setAllSellerFulfillmentStatus,
    setSellerFulfillmentStatus,
    syncAggregateDeliveryState,
} = require('../services/orderFulfillmentService');
const { deleteAccountCascade } = require('../services/accountDeletionService');
const productController = require('./productController');
const couponController = require('./couponController');
const taxController = require('./taxController');

const productRouteRequest = (req, { id, product } = {}) => {
    const adapted = Object.create(req);
    adapted.params = { ...(req.params || {}), ...(id ? { id } : {}) };
    adapted.body = { ...(req.body || {}), ...(product !== undefined ? { product } : {}) };
    return adapted;
};

const toId = (value) => value?.toString?.() || String(value || '');
const comparablePriceUSD = (product) =>
    convertAmountSync(getProductEffectivePrice(product), getProductCurrency(product), 'USD');

const getSellerProductIds = async (sellerId) => {
    const ids = await Product.find({ seller: sellerId }).distinct('_id');
    return ids.map(toId);
};

const normalizedIdSet = (values = []) => new Set(
    [...(values instanceof Set ? values : values || [])].map(value => toId(value?._id || value)).filter(Boolean)
);

const getSellerOrderItems = (order, sellerProductIds, sellerId) => {
    const normalizedSellerId = toId(sellerId);
    const legacyProductIds = normalizedIdSet(sellerProductIds);

    return (order.orderItems || []).filter(item => {
        const snapshotSellerId = toId(item.seller?._id || item.seller);
        if (snapshotSellerId) return snapshotSellerId === normalizedSellerId;
        return legacyProductIds.has(toId(item.productId?._id || item.productId));
    });
};

const buildSellerOrderScope = (sellerId, sellerProductIds = []) => {
    const normalizedSellerId = toId(sellerId);
    if (!normalizedSellerId) return { _id: null };

    const clauses = [
        { orderItems: { $elemMatch: { seller: normalizedSellerId } } },
    ];
    const legacyProductIds = [...normalizedIdSet(sellerProductIds)];
    if (legacyProductIds.length) {
        clauses.push({
            orderItems: {
                $elemMatch: {
                    seller: null,
                    productId: { $in: legacyProductIds },
                },
            },
        });
    }

    return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

const buildSellerStatusScope = (sellerId, status) => {
    const normalizedSellerId = toId(sellerId);
    if (!normalizedSellerId) return { _id: null };
    return {
        $or: [
            { sellerFulfillment: { $elemMatch: { seller: normalizedSellerId, status } } },
            {
                $and: [
                    { sellerFulfillment: { $not: { $elemMatch: { seller: normalizedSellerId } } } },
                    { orderStatus: status },
                ],
            },
        ],
    };
};

const sellerOrderStatus = (order, sellerId) =>
    sellerFulfillmentFor(order, sellerId)?.status || order.orderStatus;

const buildSellerOrderSummary = (order, sellerItems, sellerId) => {
    const summary = sellerOrderSummaryForItems(order, sellerId, sellerItems);
    return {
        subtotal: summary.subtotal,
        shippingCost: summary.shippingCost,
        tax: summary.tax,
        couponDiscount: summary.couponDiscount,
        reconciliationAdjustment: summary.adjustment,
        totalAmount: summary.totalAmount,
    };
};

const summarizeOrderForRole = (order, role, sellerProductIds = [], sellerId = null) => {
    const items = role === 'seller' ? getSellerOrderItems(order, sellerProductIds, sellerId) : (order.orderItems || []);
    const total = role === 'seller'
        ? buildSellerOrderSummary(order, items, sellerId).totalAmount
        : requireStoredOrderMoney(order.orderSummary?.totalAmount, 'order total');

    return {
        orderId: order.orderId,
        _id: order._id,
        status: role === 'seller' ? sellerOrderStatus(order, sellerId) : order.orderStatus,
        isPaid: order.isPaid,
        total: roundMoneyExact(total),
        currency: getAccountingOrderCurrency(order),
        date: order.createdAt,
        customer: role === 'admin' ? order.shippingInfo?.fullName : undefined,
        itemCount: items.length,
    };
};

// ─── SELLER ACTIONS ───

// AI product writes use the same persistence boundary as the website/mobile
// product APIs: exact money parsing, native store currency, FX fail-closed,
// product-currency write locks, validation, and subscription limits.
exports.addProduct = (req, res) => {
    const product = req.body?.product || {};
    return productController.addProduct(productRouteRequest(req, {
        product: {
            ...product,
            description: product.description || product.name || '',
        },
    }), res);
};

exports.editProduct = (req, res) => productController.editProduct(productRouteRequest(req, {
    id: req.body?.productId,
    product: req.body?.updates,
}), res);

exports.deleteProduct = (req, res) => productController.deleteProduct(productRouteRequest(req, {
    id: req.body?.productId,
}), res);

exports.listMyProducts = async (req, res) => {
    const { role, id: userId } = req.user;
    const { search, category, page = 1, limit = 10 } = req.query;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });

        let query = role === 'seller' ? { seller: userId } : {};
        if (category) query.category = category;
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const products = await Product.find(query).skip(skip).limit(parseInt(limit)).select('name price stock category brand discountedPrice image isBlocked blockedReason moderationStatus moderationReason');
        const total = await Product.countDocuments(query);

        res.json({ products, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
    } catch (error) {
        console.error('AI list products error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.bulkDiscount = (req, res) => productController.bulkDiscount(req, res);

exports.bulkPriceUpdate = (req, res) => productController.bulkPriceUpdate(req, res);

exports.removeDiscount = (req, res) => productController.removeDiscount(req, res);

exports.getSellerAnalytics = async (req, res) => {
    const { role, id: userId } = req.user;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });
        const targetCurrency = await resolveRequestedCurrency(req, User);

        const products = await Product.find(role === 'seller' ? { seller: userId } : {});
        const productIds = products.map(p => p._id.toString());

        const orderScope = role === 'seller'
            ? buildSellerOrderScope(userId, productIds)
            : {};
        const allOrders = await Order.find({
            $and: [orderScope, { awaitingPayment: { $ne: true } }],
        });
        let revenue = 0, unitsSold = 0, orderCount = 0;

        for (const order of allOrders) {
            const items = role === 'seller'
                ? getSellerOrderItems(order, productIds, userId)
                : (order.orderItems || []);
            if (items.length > 0) {
                orderCount++;
                for (const i of items) {
                    if (order.isPaid) {
                        revenue += await convertOrderAmount(order, lineTotal(i), targetCurrency);
                        unitsSold += i.quantity;
                    }
                }
            }
        }

        const lowStock = products.filter(p => p.stock > 0 && p.stock <= 10);
        const outOfStock = products.filter(p => p.stock === 0);

        res.json({
            totalProducts: products.length,
            totalRevenue: roundMoney(revenue),
            currency: targetCurrency,
            totalOrders: orderCount,
            totalUnitsSold: unitsSold,
            avgOrderValue: orderCount > 0 ? roundMoney(revenue / orderCount) : 0,
            lowStockProducts: lowStock.map(p => ({ name: p.name, stock: p.stock })),
            outOfStockProducts: outOfStock.map(p => ({ name: p.name })),
            topProducts: products.sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 5).map(p => ({
                name: p.name,
                price: p.price,
                currency: getProductCurrency(p),
                rating: p.rating,
                stock: p.stock,
            })),
        });
    } catch (error) {
        console.error('AI seller analytics error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getSellerOrders = async (req, res) => {
    const { role, id: userId } = req.user;
    const { status, limit = 20 } = req.query;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });

        const query = { awaitingPayment: { $ne: true } };

        if (role === 'seller') {
            const spIds = await getSellerProductIds(userId);
            const conditions = [query, buildSellerOrderScope(userId, spIds)];
            if (status && status !== 'all') conditions.push(buildSellerStatusScope(userId, status));
            const sellerOrders = await Order.find({
                $and: conditions,
            }).sort({ createdAt: -1 }).limit(parseInt(limit));
            return res.json({ orders: sellerOrders.map(o => summarizeOrderForRole(o, role, spIds, userId)) });
        }

        const adminQuery = status && status !== 'all' ? { ...query, orderStatus: status } : query;
        const allOrders = await Order.find(adminQuery).sort({ createdAt: -1 }).limit(parseInt(limit));
        res.json({ orders: allOrders.map(o => summarizeOrderForRole(o, role)) });
    } catch (error) {
        console.error('AI seller orders error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateOrderStatus = async (req, res) => {
    const { orderId, newStatus } = req.body;
    const { role, id: userId } = req.user;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });
        const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
        if (!validStatuses.includes(newStatus)) {
            return res.status(400).json({ msg: 'Choose a valid order status.' });
        }

        const spIds = role === 'seller' ? await getSellerProductIds(userId) : [];
        const order = role === 'seller'
            ? await Order.findOne({
                $and: [
                    { _id: orderId },
                    { awaitingPayment: { $ne: true } },
                    buildSellerOrderScope(userId, spIds),
                ],
            })
            : await Order.findById(orderId);
        if (!order) {
            return role === 'seller'
                ? res.status(403).json({ msg: 'This order does not contain your products' })
                : res.status(404).json({ msg: 'Order not found' });
        }

        const sellerIds = await ensureOrderSellerFulfillment(order);
        if (newStatus === 'cancelled' && order.isPaid) {
            return res.status(409).json({
                msg: role === 'seller'
                    ? 'Paid seller portions require a verified refund before cancellation.'
                    : 'Paid orders require a verified refund before cancellation.',
                code: 'PAID_ORDER_REQUIRES_REFUND',
            });
        }

        if (role === 'seller') {
            if (getSellerOrderItems(order, spIds, userId).length === 0) {
                return res.status(403).json({ msg: 'This order does not contain your products' });
            }
            const fulfillment = sellerFulfillmentFor(order, userId);
            if (!fulfillment) {
                return res.status(403).json({ msg: 'Seller fulfillment record was not found for this order.' });
            }
            if (newStatus === 'cancelled' && ['shipped', 'delivered'].includes(fulfillment.status)) {
                return res.status(403).json({ msg: 'Cannot cancel an order that is already shipped or delivered.' });
            }
            setSellerFulfillmentStatus(order, userId, newStatus);
        } else if (order.sellerFulfillment.length) {
            setAllSellerFulfillmentStatus(order, newStatus);
        }

        const buyerAlreadyDecided = !!(order.confirmation?.confirmedAt || order.confirmation?.declinedAt);
        const updatesWholeOrderDecision = role === 'admin' || sellerIds.length <= 1;
        if (updatesWholeOrderDecision && newStatus === 'confirmed' && !buyerAlreadyDecided) {
            order.confirmation = order.confirmation || {};
            order.confirmation.confirmedAt = new Date();
            order.confirmation.confirmedVia = role === 'admin' ? 'admin' : 'manual';
            order.confirmation.decidedAt = new Date();
            order.confirmation.decidedVia = role === 'admin' ? 'admin' : 'manual';
        } else if (updatesWholeOrderDecision && newStatus === 'cancelled' && !buyerAlreadyDecided) {
            order.confirmation = order.confirmation || {};
            order.confirmation.declinedAt = new Date();
            order.confirmation.confirmedVia = role === 'admin' ? 'admin' : 'manual';
            order.confirmation.decidedAt = new Date();
            order.confirmation.decidedVia = role === 'admin' ? 'admin' : 'manual';
        }

        if (role === 'admin' && !order.sellerFulfillment.length) {
            order.orderStatus = newStatus;
            order.isDelivered = newStatus === 'delivered';
            if (newStatus === 'delivered' && !order.deliveredAt) order.deliveredAt = new Date();
        } else {
            syncAggregateDeliveryState(order);
        }
        if (order.orderStatus === 'delivered') order.isPaid = true;
        await order.save();

        res.json({
            msg: `Order ${order.orderId} status updated to ${newStatus}`,
            orderStatus: role === 'seller' ? sellerOrderStatus(order, userId) : order.orderStatus,
            aggregateOrderStatus: order.orderStatus,
        });
    } catch (error) {
        console.error('AI update order status error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getMyStore = async (req, res) => {
    const { id: userId } = req.user;
    try {
        const store = await Store.findOne({ seller: userId });
        if (!store) return res.status(404).json({ msg: 'No store found' });
        res.json({
            storeName: store.storeName, storeSlug: store.storeSlug, description: store.description,
            logo: store.logo, banner: store.banner, trustCount: store.trustCount,
            verification: store.verification, isActive: store.isActive,
            socialLinks: store.socialLinks, address: store.address, returnPolicy: store.returnPolicy,
        });
    } catch (error) {
        console.error('AI get store error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateStore = async (req, res) => {
    const { updates } = req.body;
    const { id: userId } = req.user;
    try {
        const store = await Store.findOne({ seller: userId });
        if (!store) return res.status(404).json({ msg: 'No store found' });

        const allowed = ['storeName', 'description', 'logo', 'banner', 'socialLinks', 'address', 'returnPolicy'];
        allowed.forEach(key => { if (updates[key] !== undefined) { store[key] = updates[key]; store.markModified(key); } });
        await store.save();

        res.json({ msg: `Store "${store.storeName}" updated successfully` });
    } catch (error) {
        console.error('AI update store error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getStoreAnalytics = async (req, res) => {
    const { id: userId } = req.user;
    try {
        const store = await Store.findOne({ seller: userId });
        if (!store) return res.status(404).json({ msg: 'No store found' });

        const productCount = await Product.countDocuments({ seller: userId });
        res.json({
            storeName: store.storeName, trustCount: store.trustCount, productCount,
            isVerified: store.verification?.isVerified || false, isActive: store.isActive,
        });
    } catch (error) {
        console.error('AI store analytics error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.applyForVerification = async (req, res) => {
    const { id: userId } = req.user;
    try {
        const store = await Store.findOne({ seller: userId });
        if (!store) return res.status(404).json({ msg: 'No store found' });
        if (store.verification?.isVerified) return res.json({ msg: 'Store is already verified' });
        if (store.verification?.status === 'pending') return res.json({ msg: 'Verification already pending' });

        store.verification = { ...(store.verification || {}), status: 'pending', appliedAt: new Date() };
        store.markModified('verification');
        await store.save();

        res.json({ msg: 'Verification application submitted successfully' });
    } catch (error) {
        console.error('AI apply verification error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getShippingMethods = async (req, res) => {
    const { id: userId } = req.user;
    try {
        const methods = await ShippingMethod.find({ seller: userId });
        res.json({ shippingMethods: methods });
    } catch (error) {
        console.error('AI get shipping error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateShipping = async (req, res) => {
    const { methodId, updates } = req.body;
    const { id: userId } = req.user;
    try {
        const method = await ShippingMethod.findOne({ _id: methodId, seller: userId });
        if (!method) return res.status(404).json({ msg: 'Shipping method not found' });

        Object.assign(method, updates);
        await method.save();
        res.json({ msg: `Shipping method "${method.name}" updated` });
    } catch (error) {
        console.error('AI update shipping error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// ─── ADMIN ACTIONS ───

exports.getAllUsers = async (req, res) => {
    const { role: userRole } = req.user;
    const { search, role, status, limit = 20 } = req.query;
    try {
        if (userRole !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        let query = publicProductFilter();
        if (role) query.role = role;
        if (status) query.status = status;
        if (search) {
            query.$or = [
                { username: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
            ];
        }

        const users = await User.find(query).limit(parseInt(limit)).select('username email role status avatar createdAt');
        const total = await User.countDocuments(query);

        res.json({ users, total });
    } catch (error) {
        console.error('AI get all users error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.deleteUser = async (req, res) => {
    const { userId } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        if (user.role === 'admin') return res.status(409).json({ msg: 'Cannot delete an admin user' });

        const username = user.username;
        await deleteAccountCascade(userId);
        res.json({ msg: `User "${username}" deleted successfully` });
    } catch (error) {
        console.error('AI delete user error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.blockUser = async (req, res) => {
    const { userId } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.status = user.status === 'blocked' ? 'active' : 'blocked';
        await user.save();
        res.json({ msg: `User "${user.username}" is now ${user.status}` });
    } catch (error) {
        console.error('AI block user error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.changeUserRole = async (req, res) => {
    const { userId, newRole } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });
        if (!['user', 'seller', 'admin'].includes(newRole)) return res.status(400).json({ msg: 'Invalid role' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        user.role = newRole;
        await user.save();
        res.json({ msg: `${user.username}'s role changed to ${newRole}` });
    } catch (error) {
        console.error('AI change role error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAdminAnalytics = async (req, res) => {
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const totalUsers = await User.countDocuments();
        const usersByRole = await User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]);
        const totalProducts = await Product.countDocuments();
        const totalOrders = await Order.countDocuments({ awaitingPayment: { $ne: true } });
        const totalStores = await Store.countDocuments();
        const verifiedStores = await Store.countDocuments({ 'verification.isVerified': true });
        const pendingVerifications = await Store.countDocuments({ 'verification.status': 'pending' });

        const targetCurrency = await resolveRequestedCurrency(req, User);
        const orders = await Order.find({ isPaid: true, awaitingPayment: { $ne: true } });
        let totalRevenue = 0;
        for (const order of orders) {
            totalRevenue += await convertOrderTotal(order, targetCurrency);
        }

        res.json({
            totalUsers, usersByRole: usersByRole.reduce((a, r) => ({ ...a, [r._id]: r.count }), {}),
            totalProducts, totalOrders, totalStores, verifiedStores, pendingVerifications,
            totalRevenue: roundMoney(totalRevenue),
            currency: targetCurrency,
        });
    } catch (error) {
        console.error('AI admin analytics error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAllOrders = async (req, res) => {
    const { role } = req.user;
    const { status, limit = 20 } = req.query;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        let query = { awaitingPayment: { $ne: true } };
        if (status) query.orderStatus = status;

        const orders = await Order.find(query).sort({ createdAt: -1 }).limit(parseInt(limit));
        res.json({
            orders: orders.map(o => ({
                orderId: o.orderId, _id: o._id, status: o.orderStatus, isPaid: o.isPaid,
                total: o.orderSummary?.totalAmount, date: o.createdAt,
                customer: o.shippingInfo?.fullName, itemCount: o.orderItems.length,
            })),
        });
    } catch (error) {
        console.error('AI get all orders error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getOrderDetail = async (req, res) => {
    const { orderId } = req.query;
    const { role, id: userId } = req.user;
    try {
        const sellerProductIds = role === 'seller' ? await getSellerProductIds(userId) : [];
        const order = role === 'seller'
            ? await Order.findOne({
                $and: [
                    { _id: orderId },
                    { awaitingPayment: { $ne: true } },
                    buildSellerOrderScope(userId, sellerProductIds),
                ],
            })
            : await Order.findById(orderId);
        if (!order) {
            return role === 'seller'
                ? res.status(403).json({ msg: 'You can only view orders containing your products' })
                : res.status(404).json({ msg: 'Order not found' });
        }

        if (role === 'seller') {
            const sellerItems = getSellerOrderItems(order, sellerProductIds, userId);
            if (sellerItems.length === 0) return res.status(403).json({ msg: 'You can only view orders containing your products' });

            return res.json({
                orderId: order.orderId, status: sellerOrderStatus(order, userId), isPaid: order.isPaid,
                orderItems: sellerItems, shippingInfo: order.shippingInfo,
                orderSummary: buildSellerOrderSummary(order, sellerItems, userId),
                paymentMethod: order.paymentMethod,
                createdAt: order.createdAt,
            });
        }

        if (role !== 'admin' && toId(order.user) !== toId(userId)) {
            return res.status(403).json({ msg: 'You can only view your own orders' });
        }

        res.json({
            orderId: order.orderId, status: order.orderStatus, isPaid: order.isPaid,
            orderItems: order.orderItems, shippingInfo: order.shippingInfo,
            orderSummary: order.orderSummary, paymentMethod: order.paymentMethod,
            createdAt: order.createdAt,
        });
    } catch (error) {
        console.error('AI order detail error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.cancelOrder = async (req, res) => {
    const { orderId } = req.body;
    const { role, id: userId } = req.user;
    try {
        if (role === 'seller') return res.status(403).json({ msg: 'Sellers cannot cancel orders' });

        const order = await Order.findById(orderId);
        if (!order) return res.status(404).json({ msg: 'Order not found' });

        if (role !== 'admin' && toId(order.user) !== toId(userId)) {
            return res.status(403).json({ msg: 'You can only cancel your own orders' });
        }

        order.orderStatus = 'cancelled';
        await order.save();
        res.json({ msg: `Order ${order.orderId} cancelled` });
    } catch (error) {
        console.error('AI cancel order error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAllComplaints = async (req, res) => {
    const { role } = req.user;
    const { category, status, limit = 20 } = req.query;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        let query = {};
        if (category) query.category = category;
        if (status) query.status = status;

        const complaints = await Complaint.find(query).sort({ createdAt: -1 }).limit(parseInt(limit))
            .populate('user', 'username email');

        res.json({ complaints: complaints.map(c => ({ _id: c._id, category: c.category, subject: c.subject, message: c.message, status: c.status, priority: c.priority, user: c.user?.username || 'Unknown', adminResponse: c.adminResponse, createdAt: c.createdAt })) });
    } catch (error) {
        console.error('AI get complaints error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateComplaint = async (req, res) => {
    const { complaintId, status, adminResponse, priority } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const complaint = await Complaint.findById(complaintId);
        if (!complaint) return res.status(404).json({ msg: 'Complaint not found' });

        if (status) complaint.status = status;
        if (adminResponse) complaint.adminResponse = adminResponse;
        if (priority) complaint.priority = priority;
        await complaint.save();

        res.json({ msg: `Complaint updated — status: ${complaint.status}` });
    } catch (error) {
        console.error('AI update complaint error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getPendingVerifications = async (req, res) => {
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const stores = await Store.find({ 'verification.status': 'pending' }).populate('seller', 'username email');
        res.json({
            stores: stores.map(s => ({
                _id: s._id, storeName: s.storeName, storeSlug: s.storeSlug,
                seller: s.seller?.username, sellerEmail: s.seller?.email,
                appliedAt: s.verification?.appliedAt,
            })),
        });
    } catch (error) {
        console.error('AI pending verifications error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.approveVerification = async (req, res) => {
    const { storeId } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ msg: 'Store not found' });

        store.verification = { isVerified: true, status: 'approved', verifiedAt: new Date() };
        store.markModified('verification');
        await store.save();

        res.json({ msg: `Store "${store.storeName}" verified successfully` });
    } catch (error) {
        console.error('AI approve verification error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.rejectVerification = async (req, res) => {
    const { storeId, reason } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ msg: 'Store not found' });

        store.verification = { isVerified: false, status: 'rejected', rejectedAt: new Date(), rejectionReason: reason || '' };
        store.markModified('verification');
        await store.save();

        res.json({ msg: `Store "${store.storeName}" verification rejected` });
    } catch (error) {
        console.error('AI reject verification error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.removeVerification = async (req, res) => {
    const { storeId } = req.body;
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const store = await Store.findById(storeId);
        if (!store) return res.status(404).json({ msg: 'Store not found' });

        store.verification = { isVerified: false, status: 'none' };
        store.markModified('verification');
        await store.save();

        res.json({ msg: `Verification removed from "${store.storeName}"` });
    } catch (error) {
        console.error('AI remove verification error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAllStores = async (req, res) => {
    const { role } = req.user;
    const { limit = 20 } = req.query;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const stores = await Store.find().limit(parseInt(limit)).populate('seller', 'username email');
        res.json({
            stores: stores.map(s => ({
                _id: s._id, storeName: s.storeName, storeSlug: s.storeSlug,
                seller: s.seller?.username, isVerified: s.verification?.isVerified,
                trustCount: s.trustCount, isActive: s.isActive,
            })),
        });
    } catch (error) {
        console.error('AI get all stores error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateTaxConfig = async (req, res) => {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ msg: 'Admin access only' });
    }
    return taxController.updateTaxConfig(req, res);
};

exports.getTaxConfig = async (req, res) => {
    try {
        const config = await TaxConfig.findOne();
        res.json({ config: config || { type: 'none', value: 0, currency: 'USD', isActive: true } });
    } catch (error) {
        console.error('AI get tax error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.searchProducts = async (req, res) => {
    const { query: searchQuery, category, maxPrice, minPrice, limit = 10 } = req.query;
    try {
        const activeSellerIds = await getActiveSellerIds();
        let query = applyActiveSellerProductFilter(publicProductFilter(), activeSellerIds);
        if (category) query.category = category;
        // maxPrice/minPrice are interpreted as USD for this legacy endpoint.
        const maxPriceUSD = maxPrice ? parseFloat(maxPrice) : null;
        const minPriceUSD = minPrice ? parseFloat(minPrice) : null;

        let products = await Product.find(query).lean();
        if (maxPriceUSD !== null || minPriceUSD !== null) {
            products = products.filter((p) => {
                const v = comparablePriceUSD(p);
                if (minPriceUSD !== null && v < minPriceUSD) return false;
                if (maxPriceUSD !== null && v > maxPriceUSD) return false;
                return true;
            });
        }

        if (searchQuery) {
            const Fuse = require('fuse.js');
            const fuse = new Fuse(products, { threshold: 0.4, keys: ['name', 'description', 'brand', 'tags', 'category'] });
            products = fuse.search(searchQuery).map(r => r.item);
        }

        res.json({
            products: products.slice(0, parseInt(limit)).map(p => ({
                _id: p._id, name: p.name, price: p.price, discountedPrice: p.discountedPrice,
                currency: getProductCurrency(p), priceCurrency: getProductCurrency(p),
                image: p.image || p.images?.[0]?.url, rating: p.rating, category: p.category, brand: p.brand, stock: p.stock,
            })),
        });
    } catch (error) {
        console.error('AI search products error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// ─── USER ACTIONS ───

exports.getWishlist = async (req, res) => {
    try {
        const activeSellerIds = await getActiveSellerIds();
        const user = await User.findById(req.user.id).populate({
            path: 'wishlist',
            match: applyActiveSellerProductFilter(publicProductFilter(), activeSellerIds),
            select: 'name price discountedPrice currency priceCurrency image category brand stock',
        });
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const items = (user.wishlist || []).filter(Boolean);
        res.json({
            wishlist: items.map(p => ({
                _id: p._id, name: p.name, price: p.price,
                currency: getProductCurrency(p), priceCurrency: getProductCurrency(p),
                discountedPrice: p.discountedPrice, image: p.image,
                category: p.category, brand: p.brand, inStock: p.stock > 0
            })),
            count: items.length
        });
    } catch (error) {
        console.error('AI get wishlist error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.addToWishlist = async (req, res) => {
    const { productId } = req.body;
    try {
        const product = await Product.findOne(publicProductFilter({ _id: productId })).select('name seller');
        if (!product) return res.status(404).json({ msg: 'Product not found' });
        if (!(await isProductSellerPubliclyActive(product.seller))) {
            return res.status(404).json({ msg: 'Product not found' });
        }

        const user = await User.findById(req.user.id);
        if (user.wishlist.includes(productId)) {
            return res.json({ msg: `"${product.name}" is already in your wishlist` });
        }

        user.wishlist.push(productId);
        await user.save();
        res.json({ msg: `"${product.name}" added to your wishlist`, wishlistCount: user.wishlist.length });
    } catch (error) {
        console.error('AI add to wishlist error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.removeFromWishlist = async (req, res) => {
    const { productId } = req.body;
    try {
        const user = await User.findById(req.user.id);
        const product = await Product.findById(productId);
        const productName = product?.name || 'Product';

        user.wishlist = user.wishlist.filter(id => id.toString() !== productId);
        await user.save();
        res.json({ msg: `"${productName}" removed from your wishlist`, wishlistCount: user.wishlist.length });
    } catch (error) {
        console.error('AI remove from wishlist error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAddresses = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const addresses = user.savedAddresses || [];
        const defaultAddress = user.savedShippingInfo || null;

        res.json({ addresses, defaultAddress, count: addresses.length });
    } catch (error) {
        console.error('AI get addresses error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.addAddress = async (req, res) => {
    const { address } = req.body;
    try {
        if (!address || !address.fullName || !address.address || !address.city || !address.phone) {
            return res.status(400).json({ msg: 'Missing required fields: fullName, address, city, phone' });
        }

        const user = await User.findById(req.user.id);
        if (!user.savedAddresses) user.savedAddresses = [];

        user.savedAddresses.push(address);
        await user.save();
        res.json({ msg: `Address for "${address.fullName}" added successfully`, addressCount: user.savedAddresses.length });
    } catch (error) {
        console.error('AI add address error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateProfile = async (req, res) => {
    const { updates } = req.body;
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        const allowed = ['username'];
        const applied = [];
        allowed.forEach(key => {
            if (updates[key] !== undefined) { user[key] = updates[key]; applied.push(key); }
        });

        if (applied.length === 0) return res.status(400).json({ msg: 'No valid fields to update' });

        await user.save();
        res.json({ msg: `Profile updated: ${applied.join(', ')}`, updatedFields: applied });
    } catch (error) {
        console.error('AI update profile error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getNotifications = async (req, res) => {
    try {
        const Notification = require('../models/Notification');
        const notifications = await Notification.find({ userId: req.user.id })
            .sort({ createdAt: -1 }).limit(20);

        const unreadCount = await Notification.countDocuments({ userId: req.user.id, read: false });

        res.json({
            notifications: notifications.map(n => ({
                _id: n._id, title: n.title, message: n.message,
                type: n.type, read: n.read, createdAt: n.createdAt
            })),
            unreadCount,
            totalCount: notifications.length
        });
    } catch (error) {
        console.error('AI get notifications error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.markNotificationsRead = async (req, res) => {
    try {
        const Notification = require('../models/Notification');
        const result = await Notification.updateMany(
            { userId: req.user.id, read: false },
            { $set: { read: true } }
        );
        res.json({ msg: `Marked ${result.modifiedCount} notification(s) as read` });
    } catch (error) {
        console.error('AI mark notifications read error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAvailableCoupons = async (req, res) => {
    const { productId, storeId } = req.query;
    try {
        const Coupon = require('../models/Coupon');
        let query = { isActive: true, expiryDate: { $gte: new Date() } };

        if (storeId) query.seller = storeId;

        const coupons = await Coupon.find(query).limit(10);
        res.json({
            coupons: coupons.map(c => ({
                code: c.code, discountType: c.discountType, discountValue: c.discountValue,
                currency: c.currency || 'USD',
                minOrderAmount: c.minOrderAmount, maxUses: c.maxUses, usedCount: c.usedCount,
                expiryDate: c.expiryDate
            })),
            count: coupons.length
        });
    } catch (error) {
        console.error('AI get coupons error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.validateCoupon = async (req, res) => {
    const { code, cartTotal } = req.body;
    try {
        const Coupon = require('../models/Coupon');
        const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });

        if (!coupon) return res.json({ valid: false, msg: 'Coupon not found or inactive' });
        if (coupon.expiryDate < new Date()) return res.json({ valid: false, msg: 'Coupon has expired' });
        if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) return res.json({ valid: false, msg: 'Coupon usage limit reached' });
        const couponCurrency = normalizeCurrency(coupon.currency || 'USD');
        const cartCurrency = normalizeCurrency(req.body.currency || req.query.currency || couponCurrency);
        const cartTotalInCouponCurrency = cartTotal
            ? await convertAmount(Number(cartTotal), cartCurrency, couponCurrency)
            : 0;
        if (coupon.minOrderAmount && cartTotalInCouponCurrency < coupon.minOrderAmount) {
            return res.json({
                valid: false,
                msg: `Minimum order amount is ${await formatMoney(coupon.minOrderAmount, couponCurrency, { sourceCurrency: couponCurrency })}`,
            });
        }

        let discount = 0;
        if (coupon.discountType === 'percentage') {
            discount = (cartTotalInCouponCurrency * coupon.discountValue) / 100;
            if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
        } else {
            discount = coupon.discountValue;
        }

        res.json({
            valid: true,
            discount: roundMoneyExact(discount),
            currency: couponCurrency,
            code: coupon.code,
            msg: `Coupon "${coupon.code}" saves you ${await formatMoney(discount, couponCurrency, { sourceCurrency: couponCurrency })}!`,
        });
    } catch (error) {
        console.error('AI validate coupon error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// ─── SELLER COUPON MANAGEMENT ───

exports.createCoupon = async (req, res) => {
    const { role, id: userId } = req.user;
    const { coupon } = req.body;
    if (role !== 'seller' && role !== 'admin') {
        return res.status(403).json({ msg: 'Unauthorized' });
    }
    if (!coupon || typeof coupon !== 'object' || Array.isArray(coupon)) {
        return res.status(400).json({ msg: 'Coupon details are required.' });
    }
    const adapted = Object.create(req);
    adapted.body = {
        ...coupon,
        ...(coupon.currency === undefined && req.body.currency !== undefined
            ? { currency: req.body.currency }
            : {}),
    };
    adapted.user = { ...req.user, id: userId };
    return couponController.createCoupon(adapted, res);
};

exports.getMyCoupons = async (req, res) => {
    const { role, id: userId } = req.user;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });

        const Coupon = require('../models/Coupon');
        const coupons = await Coupon.find({ seller: userId }).sort({ createdAt: -1 });

        res.json({
            coupons: coupons.map(c => ({
                _id: c._id, code: c.code, discountType: c.discountType,
                discountValue: c.discountValue, isActive: c.isActive,
                currency: c.currency || 'USD',
                minOrderAmount: c.minOrderAmount, maxUses: c.maxUses,
                maxDiscountAmount: c.maxDiscountAmount,
                usedCount: c.usedCount, expiryDate: c.expiryDate
            })),
            totalCoupons: coupons.length,
            activeCoupons: coupons.filter(c => c.isActive).length
        });
    } catch (error) {
        console.error('AI get my coupons error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.updateCoupon = async (req, res) => {
    const { role, id: userId } = req.user;
    const { couponId, updates } = req.body;
    if (role !== 'seller' && role !== 'admin') {
        return res.status(403).json({ msg: 'Unauthorized' });
    }
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ msg: 'Coupon updates are required.' });
    }
    const adaptedUpdates = { ...updates };
    if (
        adaptedUpdates.maxDiscountAmount === undefined
        && adaptedUpdates.maxDiscount !== undefined
    ) {
        adaptedUpdates.maxDiscountAmount = adaptedUpdates.maxDiscount;
    }
    delete adaptedUpdates.maxDiscount;
    const adapted = Object.create(req);
    adapted.params = { ...(req.params || {}), id: couponId };
    adapted.body = adaptedUpdates;
    adapted.user = { ...req.user, id: userId };
    return couponController.updateCoupon(adapted, res);
};

exports.deleteCoupon = async (req, res) => {
    const { role, id: userId } = req.user;
    const { couponId } = req.body;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });

        const { deleteCouponIfUnreserved } = require('../services/couponUsageService');
        const result = await deleteCouponIfUnreserved({ couponId, sellerId: userId });
        const coupon = result.coupon;
        if (!result.deleted) return res.status(404).json({ msg: 'Coupon not found' });

        res.json({ msg: `Coupon "${coupon.code}" deleted` });
    } catch (error) {
        console.error('AI delete coupon error:', error);
        res.status(error.statusCode || 500).json({
            msg: error.statusCode ? error.message : 'Server error',
            ...(error.code ? { code: error.code } : {}),
        });
    }
};

exports.toggleCoupon = async (req, res) => {
    const { role, id: userId } = req.user;
    const { couponId } = req.body;
    if (role !== 'seller' && role !== 'admin') {
        return res.status(403).json({ msg: 'Unauthorized' });
    }
    const adapted = Object.create(req);
    adapted.params = { ...(req.params || {}), id: couponId };
    adapted.user = { ...req.user, id: userId };
    return couponController.toggleCoupon(adapted, res);
};

exports.getSubscriptionStatus = async (req, res) => {
    const { role, id: userId } = req.user;
    try {
        if (role !== 'seller' && role !== 'admin') return res.status(403).json({ msg: 'Unauthorized' });

        const SellerSubscription = require('../models/SellerSubscription');
        const sub = await SellerSubscription.findOne({ seller: userId });

        if (!sub) return res.json({ msg: 'No subscription found', hasSubscription: false });

        res.json({
            hasSubscription: true,
            plan: sub.plan,
            status: sub.status,
            trialEndsAt: sub.trialEndsAt,
            currentPeriodEnd: sub.currentPeriodEnd,
            features: sub.features || [],
            aiMessageLimit: -1,
            aiMessagesUnlimited: true,
            bonusExpiresAt: sub.bonusExpiresAt
        });
    } catch (error) {
        console.error('AI subscription status error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// ─── ADMIN BROADCAST & SUBSCRIPTION ───

exports.sendBroadcast = async (req, res) => {
    const { role } = req.user;
    const { title, message, audience, scheduledAt } = req.body;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        if (!title || !message) return res.status(400).json({ msg: 'Title and message are required' });

        const BroadcastJob = require('../models/BroadcastJob');
        const broadcast = new BroadcastJob({
            title, message,
            audience: audience || { target: 'all' },
            scheduledAt: scheduledAt || new Date(),
            status: 'pending',
            createdBy: req.user.id
        });
        await broadcast.save();

        res.json({ msg: `Broadcast "${title}" scheduled for ${audience?.target || 'all users'}`, broadcastId: broadcast._id });
    } catch (error) {
        console.error('AI send broadcast error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getBroadcasts = async (req, res) => {
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const BroadcastJob = require('../models/BroadcastJob');
        const broadcasts = await BroadcastJob.find().sort({ createdAt: -1 }).limit(20);

        res.json({
            broadcasts: broadcasts.map(b => ({
                _id: b._id, title: b.title, message: b.message,
                audience: b.audience, status: b.status,
                scheduledAt: b.scheduledAt, sentAt: b.sentAt,
                recipientCount: b.recipientCount
            })),
            count: broadcasts.length
        });
    } catch (error) {
        console.error('AI get broadcasts error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.cancelBroadcast = async (req, res) => {
    const { role } = req.user;
    const { broadcastId } = req.body;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const BroadcastJob = require('../models/BroadcastJob');
        const broadcast = await BroadcastJob.findById(broadcastId);
        if (!broadcast) return res.status(404).json({ msg: 'Broadcast not found' });
        if (broadcast.status === 'sent') return res.status(400).json({ msg: 'Cannot cancel an already sent broadcast' });

        broadcast.status = 'cancelled';
        await broadcast.save();

        res.json({ msg: `Broadcast "${broadcast.title}" cancelled` });
    } catch (error) {
        console.error('AI cancel broadcast error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getAllSubscriptions = async (req, res) => {
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const SellerSubscription = require('../models/SellerSubscription');
        const subs = await SellerSubscription.find().populate('seller', 'username email').sort({ createdAt: -1 }).limit(30);

        const stats = await SellerSubscription.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        res.json({
            subscriptions: subs.map(s => ({
                _id: s._id, seller: s.seller?.username, email: s.seller?.email,
                plan: s.plan, status: s.status,
                trialEndsAt: s.trialEndsAt, currentPeriodEnd: s.currentPeriodEnd
            })),
            stats: stats.reduce((a, s) => ({ ...a, [s._id]: s.count }), {}),
            total: subs.length
        });
    } catch (error) {
        console.error('AI get all subscriptions error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getVerifiedStores = async (req, res) => {
    const { role } = req.user;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const stores = await Store.find({ 'verification.isVerified': true }).populate('seller', 'username email');
        res.json({
            stores: stores.map(s => ({
                _id: s._id, storeName: s.storeName, storeSlug: s.storeSlug,
                seller: s.seller?.username, sellerEmail: s.seller?.email,
                verifiedAt: s.verification?.verifiedAt, trustCount: s.trustCount
            })),
            count: stores.length
        });
    } catch (error) {
        console.error('AI get verified stores error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.getStoreDetails = async (req, res) => {
    const { role } = req.user;
    const { storeId, slug } = req.query;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        let store;
        if (storeId) store = await Store.findById(storeId).populate('seller', 'username email role status');
        else if (slug) store = await Store.findOne({ storeSlug: slug }).populate('seller', 'username email role status');

        if (!store) return res.status(404).json({ msg: 'Store not found' });

        const productCount = await Product.countDocuments({ seller: store.seller?._id });

        res.json({
            storeName: store.storeName, storeSlug: store.storeSlug,
            seller: store.seller?.username, sellerEmail: store.seller?.email,
            sellerStatus: store.seller?.status,
            verification: store.verification, trustCount: store.trustCount,
            isActive: store.isActive, productCount,
            socialLinks: store.socialLinks, description: store.description,
            createdAt: store.createdAt
        });
    } catch (error) {
        console.error('AI get store details error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

exports.searchStores = async (req, res) => {
    const { role } = req.user;
    const { query, limit = 10 } = req.query;
    try {
        if (role !== 'admin') return res.status(403).json({ msg: 'Admin access only' });

        const stores = await Store.find({
            $or: [
                { storeName: { $regex: query || '', $options: 'i' } },
                { storeSlug: { $regex: query || '', $options: 'i' } }
            ]
        }).populate('seller', 'username email').limit(parseInt(limit));

        res.json({
            stores: stores.map(s => ({
                _id: s._id, storeName: s.storeName, storeSlug: s.storeSlug,
                seller: s.seller?.username, isVerified: s.verification?.isVerified,
                trustCount: s.trustCount, isActive: s.isActive
            })),
            count: stores.length
        });
    } catch (error) {
        console.error('AI search stores error:', error);
        res.status(500).json({ msg: 'Server error' });
    }
};

// Production AI action adapter:
// Keep legacy /api/ai-actions routes, but execute through the same hardened,
// role-aware tool executor used by /api/ai-chat and WhatsApp.
const { executeToolCall: executeUnifiedToolCall } = require('../services/aiActionExecutor');

const AI_ACTION_ROUTE_ROLES = {
    guest: new Set(['search_products', 'get_available_coupons', 'validate_coupon']),
    user: new Set([
        'search_products', 'get_order_detail', 'cancel_order', 'get_wishlist',
        'add_to_wishlist', 'remove_from_wishlist', 'get_addresses', 'add_address',
        'update_profile', 'get_notifications', 'mark_notifications_read',
        'get_available_coupons', 'validate_coupon', 'get_verified_stores',
        'get_store_details', 'search_stores',
    ]),
    seller: new Set([
        'search_products', 'get_order_detail', 'cancel_order', 'get_wishlist',
        'add_to_wishlist', 'remove_from_wishlist', 'get_addresses', 'add_address',
        'update_profile', 'get_notifications', 'mark_notifications_read',
        'get_available_coupons', 'validate_coupon', 'get_verified_stores',
        'get_store_details', 'search_stores', 'add_product', 'edit_product',
        'delete_product', 'feature_product', 'list_my_products', 'bulk_discount', 'bulk_price_update',
        'remove_discount', 'get_seller_analytics', 'get_seller_orders',
        'update_order_status', 'get_my_store', 'update_store',
        'get_store_analytics', 'apply_for_verification', 'get_shipping_methods',
        'update_shipping', 'create_coupon', 'get_my_coupons', 'update_coupon',
        'delete_coupon', 'toggle_coupon', 'get_subscription_status',
    ]),
    admin: new Set([
        'search_products', 'get_order_detail', 'cancel_order', 'get_wishlist',
        'add_to_wishlist', 'remove_from_wishlist', 'get_addresses', 'add_address',
        'update_profile', 'get_notifications', 'mark_notifications_read',
        'get_available_coupons', 'validate_coupon', 'get_verified_stores',
        'get_store_details', 'search_stores', 'add_product', 'edit_product',
        'delete_product', 'feature_product', 'list_my_products', 'bulk_discount', 'bulk_price_update',
        'remove_discount', 'get_seller_analytics', 'get_seller_orders',
        'update_order_status', 'get_my_store', 'update_store',
        'get_store_analytics', 'apply_for_verification', 'get_shipping_methods',
        'update_shipping', 'create_coupon', 'get_my_coupons', 'update_coupon',
        'delete_coupon', 'toggle_coupon', 'get_subscription_status',
        'get_all_users', 'delete_user', 'block_user', 'change_user_role',
        'get_admin_analytics', 'get_all_orders', 'get_all_complaints',
        'update_complaint', 'get_pending_verifications', 'approve_verification',
        'reject_verification', 'remove_verification', 'get_all_stores',
        'update_tax_config', 'get_tax_config', 'send_broadcast', 'get_broadcasts',
        'cancel_broadcast', 'get_all_subscriptions',
    ]),
};

function canUseAIActionTool(role, toolName) {
    const normalizedRole = role || 'guest';
    return AI_ACTION_ROUTE_ROLES[normalizedRole]?.has(toolName) || false;
}

function normalizeToolHttpResult(result) {
    const ok = result?.success !== false;
    const data = result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data
        : {};
    return {
        success: ok,
        ok,
        msg: result?.message || result?.error || (ok ? 'Done.' : 'Action failed.'),
        message: result?.message,
        error: result?.error,
        data: result?.data,
        ...data,
        ...(result?.code ? { code: result.code } : {}),
        ...(result?.missingFields ? { missingFields: result.missingFields } : {}),
        ...(result?.cooldown ? { cooldown: result.cooldown } : {}),
        ...(result?.requiresConfirmation ? { requiresConfirmation: true } : {}),
    };
}

function aiActionToolRoute(toolName, source = 'body', transform) {
    return async (req, res) => {
        const role = req.user?.role || 'guest';
        if (!canUseAIActionTool(role, toolName)) {
            return res.status(403).json({
                success: false,
                ok: false,
                msg: 'This AI tool is not available for your role.',
                error: 'This AI tool is not available for your role.',
            });
        }

        const args = transform
            ? transform(req)
            : source === 'query'
                ? req.query
                : req.body;
        const rawIdempotencyKey = String(
            req.get?.('Idempotency-Key')
            || req.get?.('X-Idempotency-Key')
            || ''
        ).trim();
        const executorArgs = {
            ...(args || {}),
            _chatRequestKey: rawIdempotencyKey ? `http-action:${rawIdempotencyKey}` : '',
            _chatToolOrdinal: 0,
        };
        const result = await executeUnifiedToolCall(toolName, executorArgs, req.user || { role: 'guest' });
        const failureStatuses = {
            PAID_ORDER_REQUIRES_REFUND: 409,
            EXCHANGE_RATES_UNAVAILABLE: 503,
            AI_ACTION_IDEMPOTENCY_CONFLICT: 409,
            AI_ACTION_PENDING: 409,
        };
        const status = result?.success === false
            ? (failureStatuses[result?.code] || 400)
            : 200;
        return res.status(status).json(normalizeToolHttpResult(result));
    };
}

exports.addProduct = aiActionToolRoute('add_product');
exports.editProduct = aiActionToolRoute('edit_product');
exports.deleteProduct = aiActionToolRoute('delete_product');
exports.featureProduct = aiActionToolRoute('feature_product');
exports.listMyProducts = aiActionToolRoute('list_my_products', 'query');
exports.bulkDiscount = aiActionToolRoute('bulk_discount');
exports.bulkPriceUpdate = aiActionToolRoute('bulk_price_update');
exports.removeDiscount = aiActionToolRoute('remove_discount');
exports.getSellerAnalytics = aiActionToolRoute('get_seller_analytics', 'query');
exports.getSellerOrders = aiActionToolRoute('get_seller_orders', 'query');
exports.updateOrderStatus = aiActionToolRoute('update_order_status');
exports.getMyStore = aiActionToolRoute('get_my_store', 'query');
exports.updateStore = aiActionToolRoute('update_store');
exports.getStoreAnalytics = aiActionToolRoute('get_store_analytics', 'query');
exports.applyForVerification = aiActionToolRoute('apply_for_verification');
exports.getShippingMethods = aiActionToolRoute('get_shipping_methods', 'query');
exports.updateShipping = aiActionToolRoute('update_shipping');
exports.getAllUsers = aiActionToolRoute('get_all_users', 'query');
exports.deleteUser = aiActionToolRoute('delete_user');
exports.blockUser = aiActionToolRoute('block_user');
exports.changeUserRole = aiActionToolRoute('change_user_role');
exports.getAdminAnalytics = aiActionToolRoute('get_admin_analytics', 'query');
exports.getAllOrders = aiActionToolRoute('get_all_orders', 'query');
exports.getOrderDetail = aiActionToolRoute('get_order_detail', 'query');
exports.cancelOrder = aiActionToolRoute('cancel_order');
exports.getAllComplaints = aiActionToolRoute('get_all_complaints', 'query');
exports.updateComplaint = aiActionToolRoute('update_complaint');
exports.getPendingVerifications = aiActionToolRoute('get_pending_verifications', 'query');
exports.approveVerification = aiActionToolRoute('approve_verification');
exports.rejectVerification = aiActionToolRoute('reject_verification');
exports.removeVerification = aiActionToolRoute('remove_verification');
exports.getAllStores = aiActionToolRoute('get_all_stores', 'query');
exports.updateTaxConfig = aiActionToolRoute('update_tax_config');
exports.getTaxConfig = aiActionToolRoute('get_tax_config', 'query');
exports.getWishlist = aiActionToolRoute('get_wishlist', 'query');
exports.addToWishlist = aiActionToolRoute('add_to_wishlist');
exports.removeFromWishlist = aiActionToolRoute('remove_from_wishlist');
exports.getAddresses = aiActionToolRoute('get_addresses', 'query');
exports.addAddress = aiActionToolRoute('add_address');
exports.updateProfile = aiActionToolRoute('update_profile');
exports.getNotifications = aiActionToolRoute('get_notifications', 'query');
exports.markNotificationsRead = aiActionToolRoute('mark_notifications_read');
exports.getAvailableCoupons = aiActionToolRoute('get_available_coupons', 'query');
exports.validateCoupon = aiActionToolRoute('validate_coupon');
exports.createCoupon = aiActionToolRoute('create_coupon');
exports.getMyCoupons = aiActionToolRoute('get_my_coupons', 'query');
exports.updateCoupon = aiActionToolRoute('update_coupon');
exports.deleteCoupon = aiActionToolRoute('delete_coupon');
exports.toggleCoupon = aiActionToolRoute('toggle_coupon');
exports.getSubscriptionStatus = aiActionToolRoute('get_subscription_status', 'query');
exports.sendBroadcast = aiActionToolRoute('send_broadcast');
exports.getBroadcasts = aiActionToolRoute('get_broadcasts', 'query');
exports.cancelBroadcast = aiActionToolRoute('cancel_broadcast');
exports.getAllSubscriptions = aiActionToolRoute('get_all_subscriptions', 'query');
exports.getVerifiedStores = aiActionToolRoute('get_verified_stores', 'query');
exports.getStoreDetails = aiActionToolRoute('get_store_details', 'query');
exports.searchStores = aiActionToolRoute('search_stores', 'query');
exports.searchProducts = aiActionToolRoute('search_products', 'query');
