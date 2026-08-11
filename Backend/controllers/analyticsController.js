const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const {
    resolveRequestedCurrency,
    convertOrderAmount,
    convertOrderTotal,
    lineTotal,
    roundMoney,
    formatOrderMoney,
} = require('../services/orderMoneyService');

const sellerOrderScope = (sellerId, sellerProductIds = []) => ({
    $or: [
        { 'orderItems.seller': sellerId },
        ...(sellerProductIds.length ? [{
            orderItems: {
                $elemMatch: {
                    seller: null,
                    productId: { $in: sellerProductIds },
                },
            },
        }] : []),
    ],
});

const productAlertTime = (product) => (
    product?.updatedAt || product?._id?.getTimestamp?.() || new Date(0)
);

// ============================
// SELLER ANALYTICS
// ============================
exports.getSellerAnalytics = async (req, res) => {
    const { role, id: userId } = req.user;
    const { days = 30 } = req.query;

    try {
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Unauthorized' });
        }

        const targetCurrency = await resolveRequestedCurrency(req, User);
        const daysNum = Math.min(parseInt(days) || 30, 365);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysNum);
        startDate.setHours(0, 0, 0, 0);

        const sellerProducts = await Product.find({ seller: userId }).select('_id name image category stock updatedAt');
        const sellerProductIds = sellerProducts.map(p => String(p._id));

        const allOrders = await Order.find({
            createdAt: { $gte: startDate },
            awaitingPayment: { $ne: true },
            ...sellerOrderScope(userId, sellerProductIds),
        });

        const sellerOrders = [];
        allOrders.forEach(order => {
            const sellerItems = (order.orderItems || []).filter(item =>
                String(item?.seller || '') === String(userId)
                || (!item?.seller && item?.productId && sellerProductIds.includes(String(item.productId)))
            );
            if (sellerItems.length > 0) {
                const sellerFulfillment = (order.sellerFulfillment || []).find(
                    entry => String(entry?.seller || '') === String(userId)
                );
                sellerOrders.push({
                    ...order.toObject(),
                    sellerItems,
                    sellerStatus: sellerFulfillment?.status || order.orderStatus || 'pending',
                    sellerRevenue: sellerItems.reduce((sum, item) => sum + lineTotal(item), 0),
                    sellerUnits: sellerItems.reduce((sum, item) => sum + (Number(item?.quantity) || 0), 0),
                });
            }
        });

        const dayBuckets = {};
        for (let i = daysNum - 1; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            dayBuckets[key] = { date: key, revenue: 0, orders: 0 };
        }

        for (const o of sellerOrders) {
            const key = new Date(o.createdAt).toISOString().slice(0, 10);
            if (dayBuckets[key]) {
                dayBuckets[key].orders++;
                if (o.isPaid) {
                    dayBuckets[key].revenue += await convertOrderAmount(o, o.sellerRevenue, targetCurrency);
                    dayBuckets[key].revenue = roundMoney(dayBuckets[key].revenue);
                }
            }
        }

        const productMap = {};
        for (const o of sellerOrders) {
            if (!o.isPaid) continue;
            for (const item of o.sellerItems) {
                const id = String(item.productId);
                if (!productMap[id]) productMap[id] = { name: item.name, image: item.image, revenue: 0, sold: 0 };
                productMap[id].revenue += await convertOrderAmount(o, lineTotal(item), targetCurrency);
                productMap[id].revenue = roundMoney(productMap[id].revenue);
                productMap[id].sold += item.quantity;
            }
        }

        const catMap = {};
        sellerProducts.forEach(p => {
            if (!catMap[p.category]) catMap[p.category] = { name: p.category, count: 0 };
            catMap[p.category].count++;
        });

        const totalRevenue = Object.values(dayBuckets).reduce((s, b) => s + b.revenue, 0);
        const paidOrders = sellerOrders.filter(o => o.isPaid).length;
        const totalUnitsSold = sellerOrders.reduce((s, o) => o.isPaid ? s + o.sellerUnits : s, 0);
        const statusCounts = sellerOrders.reduce((counts, order) => {
            const status = order.sellerStatus || 'pending';
            counts[status] = (counts[status] || 0) + 1;
            return counts;
        }, {});

        const notifications = [];
        sellerProducts.filter(p => p.stock === 0).forEach(p => {
            notifications.push({ type: 'critical', category: 'stock', title: `${p.name} is out of stock`, time: productAlertTime(p), productId: p._id });
        });
        sellerProducts.filter(p => p.stock > 0 && p.stock <= 10).forEach(p => {
            notifications.push({ type: 'warning', category: 'stock', title: `${p.name} has only ${p.stock} units left`, time: productAlertTime(p), productId: p._id });
        });
        sellerOrders.filter(o => o.sellerStatus === 'pending').slice(0, 5).forEach(o => {
            notifications.push({ type: 'info', category: 'order', title: `New order ${o.orderId} needs attention`, time: o.createdAt, orderId: o._id });
        });

        res.status(200).json({
            msg: 'Analytics fetched',
            analytics: {
                currency: targetCurrency,
                revenueByDay: Object.values(dayBuckets),
                topProducts: Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
                categoryBreakdown: Object.values(catMap).sort((a, b) => b.count - a.count),
                statusBreakdown: Object.entries(statusCounts).map(([name, value]) => ({ name, value })),
                summary: {
                    totalRevenue: roundMoney(totalRevenue),
                    paidOrders,
                    avgOrderValue: paidOrders > 0 ? roundMoney(totalRevenue / paidOrders) : 0,
                    totalUnitsSold,
                    conversionRate: sellerOrders.length > 0 ? Math.round((paidOrders / sellerOrders.length) * 100) : 0,
                },
                notifications: notifications.sort((a, b) => {
                    const priority = { critical: 0, warning: 1, info: 2, success: 3 };
                    return (priority[a.type] || 4) - (priority[b.type] || 4);
                }),
            }
        });
    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ msg: 'Server error fetching analytics' });
    }
};

// ============================
// SELLER NOTIFICATIONS
// ============================
exports.getSellerNotifications = async (req, res) => {
    const { role, id: userId } = req.user;

    try {
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Unauthorized' });
        }

        const sellerProducts = await Product.find({ seller: userId }).select('_id name stock updatedAt');
        const sellerProductIds = sellerProducts.map(p => String(p._id));

        const recentOrders = await Order.find({
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
            awaitingPayment: { $ne: true },
            ...sellerOrderScope(userId, sellerProductIds),
        }).sort({ createdAt: -1 });

        const notifications = [];

        sellerProducts.filter(p => p.stock === 0).forEach(p => {
            notifications.push({ id: `stock-${p._id}`, type: 'critical', category: 'stock', title: `${p.name} is out of stock`, description: 'Update inventory to avoid lost sales', time: productAlertTime(p), read: false });
        });
        sellerProducts.filter(p => p.stock > 0 && p.stock <= 10).forEach(p => {
            notifications.push({ id: `low-${p._id}`, type: 'warning', category: 'stock', title: `${p.name} is running low`, description: `Only ${p.stock} units remaining`, time: productAlertTime(p), read: false });
        });

        recentOrders.forEach(order => {
            const sellerItems = (order.orderItems || []).filter(item =>
                String(item?.seller || '') === String(userId)
                || (!item?.seller && item?.productId && sellerProductIds.includes(String(item.productId)))
            );
            if (sellerItems.length === 0) return;
            const sellerTotal = sellerItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
            const sellerStatus = (order.sellerFulfillment || []).find(
                entry => String(entry?.seller || '') === String(userId)
            )?.status || order.orderStatus;

            if (sellerStatus === 'pending') {
                notifications.push({ id: `order-${order._id}`, type: 'info', category: 'order', title: `New order ${order.orderId}`, description: `${sellerItems.length} item(s) awaiting your review`, time: order.createdAt, read: false, orderId: order._id });
            }
            if (order.isPaid && sellerStatus === 'confirmed') {
                notifications.push({ id: `paid-${order._id}`, type: 'success', category: 'payment', title: `Payment received for ${order.orderId}`, description: formatOrderMoney(sellerTotal, order.currency), time: order.paidAt || order.createdAt, read: false, orderId: order._id });
            }
            if (order.confirmation?.confirmedAt && order.confirmation?.confirmedVia === 'email') {
                notifications.push({
                    id: `confirmed-${order._id}`,
                    type: 'success',
                    category: 'order',
                    title: `Buyer confirmed order ${order.orderId} via email`,
                    description: 'Buyer verified the order — ready to process',
                    time: order.confirmation.confirmedAt,
                    read: false,
                    orderId: order._id,
                });
            }
        });

        notifications.sort((a, b) => new Date(b.time) - new Date(a.time));
        res.status(200).json({ msg: 'Notifications fetched', notifications: notifications.slice(0, 20) });
    } catch (error) {
        console.error('Notifications error:', error);
        res.status(500).json({ msg: 'Server error fetching notifications' });
    }
};

// ============================
// ADMIN ANALYTICS (Platform-wide)
// ============================
exports.getAdminAnalytics = async (req, res) => {
    const { role } = req.user;
    const { days = 30 } = req.query;

    try {
        if (role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }

        const targetCurrency = await resolveRequestedCurrency(req, User);
        const daysNum = Math.min(parseInt(days) || 30, 365);
        const now = new Date();
        const startDate = new Date(now);
        startDate.setDate(startDate.getDate() - daysNum);
        startDate.setHours(0, 0, 0, 0);

        // Previous period for comparison
        const prevStart = new Date(startDate);
        prevStart.setDate(prevStart.getDate() - daysNum);

        // Parallel DB queries
        const [allOrders, prevOrders, allProducts, allStores, allUsers] = await Promise.all([
            Order.find({ createdAt: { $gte: startDate } }),
            Order.find({ createdAt: { $gte: prevStart, $lt: startDate } }),
            Product.find({}).select('_id name category stock price seller image'),
            Store.find({}).select('storeName logo seller trustCount verification isActive createdAt'),
            User.find({}).select('_id username role createdAt'),
        ]);

        // Revenue by day
        const dayBuckets = {};
        for (let i = daysNum - 1; i >= 0; i--) {
            const d = new Date(now); d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            dayBuckets[key] = { date: key, revenue: 0, orders: 0, newUsers: 0 };
        }

        for (const o of allOrders) {
            const key = new Date(o.createdAt).toISOString().slice(0, 10);
            if (dayBuckets[key]) {
                dayBuckets[key].orders++;
                if (o.isPaid) {
                    dayBuckets[key].revenue += await convertOrderTotal(o, targetCurrency);
                    dayBuckets[key].revenue = roundMoney(dayBuckets[key].revenue);
                }
            }
        }

        // User growth by day
        allUsers.forEach(u => {
            if (!u.createdAt) return;
            const key = new Date(u.createdAt).toISOString().slice(0, 10);
            if (dayBuckets[key]) dayBuckets[key].newUsers++;
        });

        // Summary stats
        let totalRevenue = 0;
        for (const order of allOrders) {
            if (order.isPaid) totalRevenue += await convertOrderTotal(order, targetCurrency);
        }
        totalRevenue = roundMoney(totalRevenue);

        let prevRevenue = 0;
        for (const order of prevOrders) {
            if (order.isPaid) prevRevenue += await convertOrderTotal(order, targetCurrency);
        }
        prevRevenue = roundMoney(prevRevenue);
        const paidOrders = allOrders.filter(o => o.isPaid).length;
        const prevPaidOrders = prevOrders.filter(o => o.isPaid).length;
        const avgOrderValue = paidOrders > 0 ? totalRevenue / paidOrders : 0;
        const prevAvg = prevPaidOrders > 0 ? prevRevenue / prevPaidOrders : 0;
        const totalUnitsSold = allOrders.reduce((s, o) => o.isPaid ? s + o.orderItems.reduce((a, i) => a + i.quantity, 0) : s, 0);

        const calcChange = (curr, prev) => {
            if (prev === 0 && curr === 0) return 0;
            if (prev === 0) return 100;
            return Math.round(((curr - prev) / prev) * 100);
        };

        // Store stats
        const totalStores = allStores.length;
        const verifiedStores = allStores.filter(s => s.verification?.isVerified).length;
        const pendingVerification = allStores.filter(s => s.verification?.status === 'pending').length;
        const newStoresInPeriod = allStores.filter(s => new Date(s.createdAt) >= startDate).length;
        const prevNewStores = allStores.filter(s => {
            const d = new Date(s.createdAt);
            return d >= prevStart && d < startDate;
        }).length;

        // Brand vs Store split (current totals + new in period)
        const brandCount = allStores.filter(s => s.sellerType === 'brand').length;
        const storeCount = totalStores - brandCount;
        const newBrandsInPeriod = allStores.filter(s => s.sellerType === 'brand' && new Date(s.createdAt) >= startDate).length;
        const newStoresOnlyInPeriod = newStoresInPeriod - newBrandsInPeriod;

        // Top stores by order revenue
        const storeRevenueMap = {};
        for (const o of allOrders) {
            if (!o.isPaid) continue;
            for (const item of o.orderItems) {
                const product = allProducts.find(p => p._id.toString() === item.productId?.toString());
                if (!product) continue;
                const sellerId = product.seller?.toString();
                const store = allStores.find(s => s.seller?.toString() === sellerId);
                if (!store) continue;
                const sid = store._id.toString();
                if (!storeRevenueMap[sid]) {
                    storeRevenueMap[sid] = {
                        name: store.storeName,
                        logo: store.logo,
                        verified: store.verification?.isVerified || false,
                        trustCount: store.trustCount || 0,
                        revenue: 0,
                        orders: 0,
                        productCount: 0,
                    };
                }
                storeRevenueMap[sid].revenue += await convertOrderAmount(o, lineTotal(item), targetCurrency);
                storeRevenueMap[sid].revenue = roundMoney(storeRevenueMap[sid].revenue);
                storeRevenueMap[sid].orders++;
            }
        }
        // Add product counts
        Object.keys(storeRevenueMap).forEach(sid => {
            const store = allStores.find(s => s._id.toString() === sid);
            if (store) {
                storeRevenueMap[sid].productCount = allProducts.filter(p => p.seller?.toString() === store.seller?.toString()).length;
            }
        });
        const topStores = Object.values(storeRevenueMap).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

        // If no revenue-based stores, fall back to trust-based
        const topStoresFinal = topStores.length > 0 ? topStores : allStores
            .map(s => ({
                name: s.storeName,
                logo: s.logo,
                verified: s.verification?.isVerified || false,
                trustCount: s.trustCount || 0,
                productCount: allProducts.filter(p => p.seller?.toString() === s.seller?.toString()).length,
                revenue: 0,
                orders: 0,
            }))
            .sort((a, b) => b.trustCount - a.trustCount)
            .slice(0, 8);

        // User role breakdown
        const roleCounts = { user: 0, seller: 0, admin: 0 };
        allUsers.forEach(u => { if (roleCounts[u.role] !== undefined) roleCounts[u.role]++; });

        // Order status breakdown
        const statusCounts = { pending: 0, processing: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0 };
        allOrders.forEach(o => {
            const s = o.orderStatus || 'pending';
            if (statusCounts[s] !== undefined) statusCounts[s]++;
        });

        // Category breakdown
        const catMap = {};
        allProducts.forEach(p => {
            if (!catMap[p.category]) catMap[p.category] = { name: p.category, count: 0 };
            catMap[p.category].count++;
        });

        // Top products by revenue
        const productRevenueMap = {};
        for (const o of allOrders) {
            if (!o.isPaid) continue;
            for (const item of o.orderItems) {
                const id = item.productId?.toString();
                if (!id) continue;
                if (!productRevenueMap[id]) {
                    const prod = allProducts.find(p => p._id.toString() === id);
                    productRevenueMap[id] = { name: item.name || prod?.name || 'Unknown', image: item.image || prod?.image, revenue: 0, sold: 0 };
                }
                productRevenueMap[id].revenue += await convertOrderAmount(o, lineTotal(item), targetCurrency);
                productRevenueMap[id].revenue = roundMoney(productRevenueMap[id].revenue);
                productRevenueMap[id].sold += item.quantity;
            }
        }
        const topProducts = Object.values(productRevenueMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

        res.status(200).json({
            msg: 'Admin analytics fetched',
            analytics: {
                currency: targetCurrency,
                revenueByDay: Object.values(dayBuckets),
                summary: {
                    totalRevenue: roundMoney(totalRevenue),
                    revenueChange: calcChange(totalRevenue, prevRevenue),
                    totalOrders: allOrders.length,
                    ordersChange: calcChange(allOrders.length, prevOrders.length),
                    avgOrderValue: roundMoney(avgOrderValue),
                    avgChange: calcChange(avgOrderValue, prevAvg),
                    totalUnitsSold,
                    totalStores,
                    verifiedStores,
                    pendingVerification,
                    newStoresInPeriod,
                    storesChange: calcChange(newStoresInPeriod, prevNewStores),
                    brandCount,
                    storeCount,
                    newBrandsInPeriod,
                    newStoresOnlyInPeriod,
                    totalUsers: allUsers.length,
                    totalSellers: roleCounts.seller,
                    totalProducts: allProducts.length,
                    outOfStock: allProducts.filter(p => p.stock === 0).length,
                },
                topStores: topStoresFinal,
                topProducts,
                roleBreakdown: Object.entries(roleCounts).map(([name, value]) => ({ name, value })),
                statusBreakdown: Object.entries(statusCounts).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value })),
                categoryBreakdown: Object.values(catMap).sort((a, b) => b.count - a.count).slice(0, 10),
            }
        });
    } catch (error) {
        console.error('Admin analytics error:', error);
        res.status(500).json({ msg: 'Server error fetching admin analytics' });
    }
};

// ============================
// ADMIN NOTIFICATIONS
// ============================
exports.getAdminNotifications = async (req, res) => {
    const { role } = req.user;

    try {
        if (role !== 'admin') {
            return res.status(403).json({ msg: 'Admin access only' });
        }

        const notifications = [];

        // Recent stores created (last 30 days)
        const recentStores = await Store.find({
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        }).sort({ createdAt: -1 }).populate('seller', 'username').limit(10);

        recentStores.forEach(s => {
            notifications.push({
                id: `store-new-${s._id}`, type: 'info', category: 'store',
                title: `New store "${s.storeName}" created`,
                description: `By ${s.seller?.username || 'Unknown seller'}`,
                time: s.createdAt, read: false
            });
        });

        // Pending verifications
        const pendingStores = await Store.find({
            'verification.status': 'pending'
        }).populate('seller', 'username').limit(10);

        pendingStores.forEach(s => {
            notifications.push({
                id: `store-verify-${s._id}`, type: 'warning', category: 'store',
                title: `"${s.storeName}" awaiting verification`,
                description: `Applied ${s.verification?.appliedAt ? new Date(s.verification.appliedAt).toLocaleDateString() : 'recently'}`,
                time: s.verification?.appliedAt || s.createdAt, read: false
            });
        });

        // Out of stock products (platform-wide)
        const outOfStock = await Product.find({ stock: 0 }).select('name').limit(10);
        outOfStock.forEach(p => {
            notifications.push({
                id: `stock-${p._id}`, type: 'critical', category: 'stock',
                title: `${p.name} is out of stock`,
                description: 'Product unavailable for customers',
                time: new Date().toISOString(), read: false
            });
        });

        // Low stock products
        const lowStock = await Product.find({ stock: { $gt: 0, $lte: 10 } }).select('name stock').limit(10);
        lowStock.forEach(p => {
            notifications.push({
                id: `low-${p._id}`, type: 'warning', category: 'stock',
                title: `${p.name} running low`,
                description: `Only ${p.stock} units remaining`,
                time: new Date().toISOString(), read: false
            });
        });

        // Recent pending orders
        const pendingOrders = await Order.find({ orderStatus: 'pending' }).sort({ createdAt: -1 }).limit(5);
        pendingOrders.forEach(o => {
            notifications.push({
                id: `order-${o._id}`, type: 'info', category: 'order',
                title: `Pending order ${o.orderId}`,
                description: `${o.shippingInfo?.fullName || 'Customer'} · ${o.orderItems?.length || 0} item(s)`,
                time: o.createdAt, read: false, orderId: o._id
            });
        });

        // Recent paid orders
        const paidOrders = await Order.find({ isPaid: true }).sort({ paidAt: -1 }).limit(5);
        paidOrders.forEach(o => {
            notifications.push({
                id: `paid-${o._id}`, type: 'success', category: 'payment',
                title: `Payment received for ${o.orderId}`,
                description: formatOrderMoney(o.orderSummary?.totalAmount || 0, o.currency),
                time: o.paidAt || o.createdAt, read: false, orderId: o._id
            });
        });

        // Sort: critical first, then by time
        const priority = { critical: 0, warning: 1, info: 2, success: 3 };
        notifications.sort((a, b) => {
            const pDiff = (priority[a.type] || 4) - (priority[b.type] || 4);
            if (pDiff !== 0) return pDiff;
            return new Date(b.time) - new Date(a.time);
        });

        res.status(200).json({ msg: 'Notifications fetched', notifications: notifications.slice(0, 30) });
    } catch (error) {
        console.error('Admin notifications error:', error);
        res.status(500).json({ msg: 'Server error fetching admin notifications' });
    }
};

// ============================
// NOTIFICATION PREFERENCES (stored in DB)
// ============================
exports.getNotificationPrefs = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('notificationPrefs');
        res.status(200).json({
            msg: 'Preferences fetched',
            prefs: user?.notificationPrefs || {
                stockAlerts: true, lowStockAlerts: true, orderAlerts: true,
                paymentAlerts: true, deliveryAlerts: true, storeCreation: true, storeVerification: true
            }
        });
    } catch (error) {
        console.error('Get prefs error:', error);
        res.status(500).json({ msg: 'Server error fetching preferences' });
    }
};

exports.updateNotificationPrefs = async (req, res) => {
    try {
        const { prefs } = req.body;
        if (!prefs || typeof prefs !== 'object') {
            return res.status(400).json({ msg: 'Invalid preferences' });
        }

        const allowed = ['stockAlerts', 'lowStockAlerts', 'orderAlerts', 'paymentAlerts', 'deliveryAlerts', 'storeCreation', 'storeVerification'];
        const sanitized = {};
        allowed.forEach(key => {
            sanitized[key] = prefs[key] !== false;
        });

        await User.findByIdAndUpdate(req.user.id, { notificationPrefs: sanitized });
        res.status(200).json({ msg: 'Preferences saved', prefs: sanitized });
    } catch (error) {
        console.error('Update prefs error:', error);
        res.status(500).json({ msg: 'Server error saving preferences' });
    }
};
