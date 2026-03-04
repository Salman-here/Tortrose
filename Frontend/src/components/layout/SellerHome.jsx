import React from 'react';
import { motion } from 'framer-motion';
import {
    Package, ShoppingBag, DollarSign, TriangleAlert, TrendingUp,
    AlertCircle, Star, ArrowRight, Clock, CheckCircle, Truck, Eye
} from 'lucide-react';
import { useOutletContext, Link } from 'react-router-dom';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useAuth } from '../../contexts/AuthContext';

const SellerHome = () => {
    const { currentUser } = useAuth();
    const { formatPrice, currency, exchangeRates, getCurrencySymbol } = useCurrency();
    const { products, orders } = useOutletContext();

    const formatCompactPrice = (amount) => {
        const usdAmount = Number(amount) || 0;
        const rate = exchangeRates[currency] || 1;
        const converted = usdAmount * rate;
        const symbol = getCurrencySymbol();
        if (converted >= 1000000) return `${symbol}${(converted / 1000000).toFixed(1)}M`;
        if (converted >= 10000) return `${symbol}${(converted / 1000).toFixed(1)}K`;
        return formatPrice(usdAmount);
    };

    const totalProducts = products.length;
    const totalOrders = orders.length;
    const pendingOrders = orders.filter(o => o.orderStatus === 'pending').length;
    const processingOrders = orders.filter(o => o.orderStatus === 'processing').length;
    const deliveredOrders = orders.filter(o => o.orderStatus === 'delivered').length;
    const outOfStock = products.filter(p => p.stock === 0).length;
    const lowStock = products.filter(p => p.stock <= 10 && p.stock > 0).length;
    const totalRevenue = orders.reduce((sum, order) => order.isPaid ? sum + (order.orderSummary?.totalAmount || 0) : sum, 0);

    const stats = [
        { label: 'Total Revenue', value: formatCompactPrice(totalRevenue), icon: <DollarSign size={22} />, color: 'hsl(150, 60%, 45%)', bg: 'rgba(16, 185, 129, 0.12)' },
        { label: 'Total Orders', value: totalOrders, icon: <ShoppingBag size={22} />, color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)' },
        { label: 'Total Products', value: totalProducts, icon: <Package size={22} />, color: 'hsl(200, 80%, 50%)', bg: 'rgba(14, 165, 233, 0.12)' },
        { label: 'Conversion', value: totalOrders > 0 ? `${((deliveredOrders / totalOrders) * 100).toFixed(0)}%` : '0%', icon: <TrendingUp size={22} />, color: 'hsl(280, 60%, 55%)', bg: 'rgba(139, 92, 246, 0.12)' },
    ];

    const quickActions = [
        { label: 'View Products', desc: `${totalProducts} products`, icon: <Package size={18} />, link: '/seller-dashboard/product-management', color: 'hsl(200, 80%, 50%)' },
        { label: 'Manage Orders', desc: `${pendingOrders} pending`, icon: <ShoppingBag size={18} />, link: '/seller-dashboard/order-management', color: 'hsl(30, 90%, 50%)' },
        { label: 'Store Overview', desc: 'Stats & analytics', icon: <Eye size={18} />, link: '/seller-dashboard/store-overview', color: 'hsl(150, 60%, 45%)' },
        { label: 'Store Settings', desc: 'Update your store', icon: <Star size={18} />, link: '/seller-dashboard/store-settings', color: 'hsl(280, 60%, 55%)' },
    ];

    const getStatusIcon = (status) => {
        const icons = { pending: <Clock className="w-3.5 h-3.5" />, processing: <Truck className="w-3.5 h-3.5" />, shipped: <Truck className="w-3.5 h-3.5" />, delivered: <CheckCircle className="w-3.5 h-3.5" /> };
        return icons[status] || <Package className="w-3.5 h-3.5" />;
    };

    const getStatusStyle = (status) => {
        const styles = {
            pending: { bg: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 50%)' },
            processing: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' },
            shipped: { bg: 'rgba(14, 165, 233, 0.12)', color: 'hsl(200, 80%, 50%)' },
            delivered: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' },
            cancelled: { bg: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' },
        };
        return styles[status] || { bg: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))' };
    };

    const greeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
    };

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-7xl mx-auto">

            {/* Welcome */}
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                    {greeting()}, {currentUser?.username || 'Seller'} 👋
                </h1>
                <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Here's what's happening with your store today
                </p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                {stats.map((stat, i) => (
                    <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }} whileHover={{ y: -3 }} className="glass-card p-5">
                        <div className="flex items-center justify-between mb-3">
                            <div className="inline-flex p-2.5 rounded-xl" style={{ background: stat.bg, color: stat.color }}>
                                {stat.icon}
                            </div>
                        </div>
                        <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{stat.label}</p>
                        <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{stat.value}</p>
                    </motion.div>
                ))}
            </div>

            {/* Alerts */}
            {(outOfStock > 0 || lowStock > 0) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                    {outOfStock > 0 && (
                        <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                            className="glass-card p-4 flex items-center gap-3" style={{ borderLeft: '3px solid hsl(0, 72%, 55%)' }}>
                            <div className="p-2 rounded-xl" style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                <TriangleAlert size={18} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{outOfStock} product{outOfStock > 1 ? 's' : ''} out of stock</p>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Update inventory to avoid lost sales</p>
                            </div>
                            <Link to="/seller-dashboard/product-management">
                                <ArrowRight size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
                            </Link>
                        </motion.div>
                    )}
                    {lowStock > 0 && (
                        <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
                            className="glass-card p-4 flex items-center gap-3" style={{ borderLeft: '3px solid hsl(45, 93%, 47%)' }}>
                            <div className="p-2 rounded-xl" style={{ background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(45, 80%, 40%)' }}>
                                <AlertCircle size={18} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{lowStock} product{lowStock > 1 ? 's' : ''} running low</p>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Stock ≤ 10 units remaining</p>
                            </div>
                            <Link to="/seller-dashboard/product-management">
                                <ArrowRight size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
                            </Link>
                        </motion.div>
                    )}
                </div>
            )}

            {/* Quick Actions + Recent Orders */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Quick Actions */}
                <div className="lg:col-span-1">
                    <div className="glass-panel p-5">
                        <h3 className="text-base font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Quick Actions</h3>
                        <div className="space-y-2">
                            {quickActions.map((action, i) => (
                                <Link key={i} to={action.link}>
                                    <motion.div whileHover={{ x: 3 }}
                                        className="flex items-center gap-3 p-3 rounded-xl transition-all cursor-pointer hover:bg-white/5">
                                        <div className="p-2 rounded-xl" style={{ background: `${action.color}20`, color: action.color }}>
                                            {action.icon}
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{action.label}</p>
                                            <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{action.desc}</p>
                                        </div>
                                        <ArrowRight size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                                    </motion.div>
                                </Link>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Recent Orders */}
                <div className="lg:col-span-2">
                    <div className="glass-panel p-5">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Recent Orders</h3>
                            <Link to="/seller-dashboard/order-management">
                                <span className="text-xs font-medium flex items-center gap-1" style={{ color: 'hsl(var(--primary))' }}>
                                    View all <ArrowRight size={12} />
                                </span>
                            </Link>
                        </div>

                        {orders.length === 0 ? (
                            <div className="text-center py-8">
                                <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><ShoppingBag size={28} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No orders yet</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {[...orders].reverse().slice(0, 5).map((order, i) => {
                                    const ss = getStatusStyle(order.orderStatus);
                                    return (
                                        <motion.div key={order._id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                                            transition={{ delay: i * 0.05 }}>
                                            <Link to={`/seller-dashboard/order/${order._id}`}>
                                                <div className="flex items-center gap-3 p-3 rounded-xl transition-all hover:bg-white/5 cursor-pointer">
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <p className="text-sm font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>
                                                                {order.orderId}
                                                            </p>
                                                            <span className="px-2 py-0.5 text-[10px] rounded-full flex items-center gap-1 font-medium shrink-0"
                                                                style={{ background: ss.bg, color: ss.color }}>
                                                                {getStatusIcon(order.orderStatus)}
                                                                {order.orderStatus}
                                                            </span>
                                                        </div>
                                                        <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                            {order.shippingInfo?.fullName} · {new Date(order.createdAt).toLocaleDateString()}
                                                        </p>
                                                    </div>
                                                    <div className="text-right shrink-0">
                                                        <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                                            {formatPrice(order.orderSummary?.totalAmount || order.orderSummary?.subtotal || 0)}
                                                        </p>
                                                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                                                            style={order.isPaid
                                                                ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }
                                                                : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                                            {order.isPaid ? 'Paid' : 'Unpaid'}
                                                        </span>
                                                    </div>
                                                </div>
                                            </Link>
                                        </motion.div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Order Summary Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
                {[
                    { label: 'Pending', count: pendingOrders, color: 'hsl(30, 90%, 50%)', bg: 'rgba(249, 115, 22, 0.12)' },
                    { label: 'Processing', count: processingOrders, color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)' },
                    { label: 'Delivered', count: deliveredOrders, color: 'hsl(150, 60%, 45%)', bg: 'rgba(16, 185, 129, 0.12)' },
                    { label: 'Low Stock', count: lowStock + outOfStock, color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)' },
                ].map((item, i) => (
                    <motion.div key={item.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.3 + i * 0.05 }}
                        className="glass-inner rounded-xl p-4 text-center">
                        <p className="text-2xl font-extrabold" style={{ color: item.color }}>{item.count}</p>
                        <p className="text-[11px] font-medium mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.label}</p>
                    </motion.div>
                ))}
            </div>
        </motion.div>
    );
};

export default SellerHome;
