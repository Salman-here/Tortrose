const Order = require('../models/Order');
const Product = require('../models/Product');

exports.getSellerAnalytics = async (req, res) => {
    const { role, id: userId } = req.user;
    const { days = 30 } = req.query;

    try {
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Unauthorized' });
        }

        const daysNum = Math.min(parseInt(days) || 30, 365);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysNum);
        startDate.setHours(0, 0, 0, 0);

        // Get seller's products
        const sellerProducts = await Product.find({ seller: userId }).select('_id name image category stock');
        const sellerProductIds = sellerProducts.map(p => p._id.toString());

        if (sellerProductIds.length === 0) {
            return res.status(200).json({
                msg: 'Analytics fetched',
                analytics: {
                    revenueByDay: [],
                    ordersByDay: [],
                    topProducts: [],
                    categoryBreakdown: [],
                    summary: { totalRevenue: 0, paidOrders: 0, avgOrderValue: 0, totalUnitsSold: 0, conversionRate: 0 },
                    notifications: []
                }
            });
        }

        // Get all orders containing seller's products
        const allOrders = await Order.find({ createdAt: { $gte: startDate } });

        // Filter to orders with seller products and extract seller's portion
        const sellerOrders = [];
        allOrders.forEach(order => {
            const sellerItems = order.orderItems.filter(item =>
                sellerProductIds.includes(item.productId.toString())
            );
            if (sellerItems.length > 0) {
                sellerOrders.push({
                    ...order.toObject(),
                    sellerItems,
                    sellerRevenue: sellerItems.reduce((s, i) => s + i.price * i.quantity, 0),
                    sellerUnits: sellerItems.reduce((s, i) => s + i.quantity, 0),
                });
            }
        });

        // Revenue & orders by day
        const dayBuckets = {};
        for (let i = daysNum - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            dayBuckets[key] = { date: key, revenue: 0, orders: 0 };
        }

        sellerOrders.forEach(o => {
            const key = new Date(o.createdAt).toISOString().slice(0, 10);
            if (dayBuckets[key]) {
                dayBuckets[key].orders++;
                if (o.isPaid) dayBuckets[key].revenue += o.sellerRevenue;
            }
        });

        // Top products by revenue
        const productMap = {};
        sellerOrders.forEach(o => {
            if (!o.isPaid) return;
            o.sellerItems.forEach(item => {
                const id = item.productId.toString();
                if (!productMap[id]) productMap[id] = { name: item.name, image: item.image, revenue: 0, sold: 0 };
                productMap[id].revenue += item.price * item.quantity;
                productMap[id].sold += item.quantity;
            });
        });
        const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

        // Category breakdown
        const catMap = {};
        sellerProducts.forEach(p => {
            if (!catMap[p.category]) catMap[p.category] = { name: p.category, count: 0 };
            catMap[p.category].count++;
        });

        // Summary
        const totalRevenue = sellerOrders.reduce((s, o) => o.isPaid ? s + o.sellerRevenue : s, 0);
        const paidOrders = sellerOrders.filter(o => o.isPaid).length;
        const totalUnitsSold = sellerOrders.reduce((s, o) => o.isPaid ? s + o.sellerUnits : s, 0);

        // Notifications
        const notifications = [];
        const lowStockProducts = sellerProducts.filter(p => p.stock > 0 && p.stock <= 10);
        const outOfStockProducts = sellerProducts.filter(p => p.stock === 0);
        const pendingOrders = sellerOrders.filter(o => o.orderStatus === 'pending');
        const recentOrders = sellerOrders
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 10);

        outOfStockProducts.forEach(p => {
            notifications.push({ type: 'critical', category: 'stock', title: `${p.name} is out of stock`, time: new Date().toISOString(), productId: p._id });
        });
        lowStockProducts.forEach(p => {
            notifications.push({ type: 'warning', category: 'stock', title: `${p.name} has only ${p.stock} units left`, time: new Date().toISOString(), productId: p._id });
        });
        pendingOrders.slice(0, 5).forEach(o => {
            notifications.push({ type: 'info', category: 'order', title: `New order ${o.orderId} needs attention`, time: o.createdAt, orderId: o._id });
        });
        recentOrders.filter(o => o.isPaid && o.orderStatus !== 'pending').slice(0, 3).forEach(o => {
            notifications.push({ type: 'success', category: 'order', title: `Order ${o.orderId} payment received`, time: o.paidAt || o.createdAt, orderId: o._id });
        });

        res.status(200).json({
            msg: 'Analytics fetched',
            analytics: {
                revenueByDay: Object.values(dayBuckets),
                topProducts,
                categoryBreakdown: Object.values(catMap).sort((a, b) => b.count - a.count),
                summary: {
                    totalRevenue: Math.round(totalRevenue * 100) / 100,
                    paidOrders,
                    avgOrderValue: paidOrders > 0 ? Math.round((totalRevenue / paidOrders) * 100) / 100 : 0,
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

exports.getSellerNotifications = async (req, res) => {
    const { role, id: userId } = req.user;

    try {
        if (role !== 'seller' && role !== 'admin') {
            return res.status(403).json({ msg: 'Unauthorized' });
        }

        const sellerProducts = await Product.find({ seller: userId }).select('_id name stock');
        const sellerProductIds = sellerProducts.map(p => p._id.toString());

        const recentOrders = await Order.find({
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }).sort({ createdAt: -1 });

        const notifications = [];

        // Stock alerts
        sellerProducts.filter(p => p.stock === 0).forEach(p => {
            notifications.push({ id: `stock-${p._id}`, type: 'critical', category: 'stock', title: `${p.name} is out of stock`, description: 'Update inventory to avoid lost sales', time: new Date().toISOString(), read: false });
        });
        sellerProducts.filter(p => p.stock > 0 && p.stock <= 10).forEach(p => {
            notifications.push({ id: `low-${p._id}`, type: 'warning', category: 'stock', title: `${p.name} is running low`, description: `Only ${p.stock} units remaining`, time: new Date().toISOString(), read: false });
        });

        // Order notifications
        recentOrders.forEach(order => {
            const hasSellerProduct = order.orderItems.some(item => sellerProductIds.includes(item.productId.toString()));
            if (!hasSellerProduct) return;

            if (order.orderStatus === 'pending') {
                notifications.push({ id: `order-${order._id}`, type: 'info', category: 'order', title: `New order ${order.orderId}`, description: `${order.shippingInfo?.fullName} · ${order.orderItems.length} item(s)`, time: order.createdAt, read: false, orderId: order._id });
            }
            if (order.isPaid && order.orderStatus === 'confirmed') {
                notifications.push({ id: `paid-${order._id}`, type: 'success', category: 'payment', title: `Payment received for ${order.orderId}`, description: `$${order.orderSummary?.totalAmount?.toFixed(2)}`, time: order.paidAt || order.createdAt, read: false, orderId: order._id });
            }
        });

        notifications.sort((a, b) => new Date(b.time) - new Date(a.time));

        res.status(200).json({ msg: 'Notifications fetched', notifications: notifications.slice(0, 20) });
    } catch (error) {
        console.error('Notifications error:', error);
        res.status(500).json({ msg: 'Server error fetching notifications' });
    }
};
