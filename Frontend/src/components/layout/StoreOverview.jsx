import React from "react";
import { motion } from "framer-motion";
import { Package, TriangleAlert, AlertCircle, Star, DollarSign, TrendingUp, ShoppingBag, Eye, ArrowRight, Sparkles } from "lucide-react";
import { useOutletContext, Link } from "react-router-dom";
import { useCurrency } from "../../contexts/CurrencyContext";

const StoreOverview = () => {
    const { formatPrice, currency, exchangeRates, getCurrencySymbol } = useCurrency();
    const { products, orders } = useOutletContext();

    const formatCompactPrice = (amount) => {
        const usdAmount = Number(amount) || 0;
        const rate = exchangeRates[currency] || 1;
        const convertedAmount = usdAmount * rate;
        const symbol = getCurrencySymbol();
        if (convertedAmount >= 1000000) return `${symbol}${(convertedAmount / 1000000).toFixed(1)}M`;
        if (convertedAmount >= 10000) return `${symbol}${(convertedAmount / 1000).toFixed(1)}K`;
        return formatPrice(usdAmount);
    };

    const totalProducts = products.length;
    const outOfStock = products.filter(p => p.stock === 0).length;
    const lowStock = products.filter(p => p.stock <= 10 && p.stock !== 0).length;
    const featuredProducts = products.filter(p => p.isFeatured).length;
    const totalRevenue = orders.reduce((sum, order) => order.isPaid ? sum + (order.orderSummary?.totalAmount || 0) : sum, 0);
    const deliveredOrders = orders.filter(o => o.orderStatus === 'delivered').length;
    const totalOrders = orders.length;

    const stats = [
        { label: 'Total Products', value: totalProducts, icon: <Package size={20} />, color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)' },
        { label: 'Out of Stock', value: outOfStock, icon: <TriangleAlert size={20} />, color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)' },
        { label: 'Low Stock', value: lowStock, icon: <AlertCircle size={20} />, color: 'hsl(30, 90%, 50%)', bg: 'rgba(249, 115, 22, 0.12)' },
        { label: 'Featured', value: featuredProducts, icon: <Star size={20} />, color: 'hsl(45, 93%, 47%)', bg: 'rgba(245, 158, 11, 0.12)' },
        { label: 'Revenue', value: formatCompactPrice(totalRevenue), icon: <DollarSign size={20} />, color: 'hsl(150, 60%, 45%)', bg: 'rgba(16, 185, 129, 0.12)' },
    ];

    const categoryBreakdown = products.reduce((acc, p) => {
        acc[p.category] = (acc[p.category] || 0) + 1;
        return acc;
    }, {});

    const topCategories = Object.entries(categoryBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    const maxCategoryCount = topCategories.length > 0 ? topCategories[0][1] : 1;

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-7xl mx-auto">
            {/* Header */}
            <div className="mb-6">
                <div className="tag-pill mb-3">
                    <Sparkles size={12} /> Store Analytics
                </div>
                <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                    Store Overview
                </h2>
                <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Monitor your store performance and inventory at a glance
                </p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
                {stats.map((stat, index) => (
                    <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: index * 0.05 }}
                        className="glass-card water-shimmer p-5">
                        <div className="inline-flex p-2.5 rounded-xl mb-3" style={{ background: stat.bg, color: stat.color }}>
                            {stat.icon}
                        </div>
                        <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{stat.label}</p>
                        <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>{stat.value}</p>
                    </motion.div>
                ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
                {/* Recent Products */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }} className="lg:col-span-2 glass-panel water-shimmer p-6">
                    <div className="flex items-center justify-between mb-5">
                        <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Recent Products</h3>
                        <Link to="/seller-dashboard/product-management">
                            <span className="text-xs font-medium flex items-center gap-1" style={{ color: 'hsl(var(--primary))' }}>
                                View all <ArrowRight size={12} />
                            </span>
                        </Link>
                    </div>
                    <div className="space-y-3">
                        {products.length === 0 ? (
                            <div className="text-center py-8">
                                <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><Package size={28} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No products yet. Start by adding your first product.</p>
                            </div>
                        ) : products.slice(0, 5).map((product, i) => (
                            <motion.div key={product._id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.35 + i * 0.05 }}
                                className="flex items-center gap-4 p-3 rounded-xl transition-all hover:bg-white/5">
                                <img src={product.image} alt={product.name}
                                    className="w-12 h-12 object-cover rounded-xl flex-shrink-0"
                                    style={{ border: '1px solid var(--glass-border)' }} />
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{product.brand}</span>
                                        <span className="w-1 h-1 rounded-full" style={{ background: 'hsl(var(--muted-foreground))' }} />
                                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatPrice(product.price)}</span>
                                    </div>
                                </div>
                                <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold shrink-0"
                                    style={product.stock > 0
                                        ? product.stock <= 10
                                            ? { background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(45, 80%, 40%)' }
                                            : { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }
                                        : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }
                                    }>
                                    {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
                                </span>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                {/* Category Breakdown */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 }} className="glass-panel water-shimmer p-6">
                    <h3 className="text-base font-semibold mb-5" style={{ color: 'hsl(var(--foreground))' }}>Categories</h3>
                    {topCategories.length === 0 ? (
                        <div className="text-center py-8">
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No categories yet</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {topCategories.map(([cat, count], i) => (
                                <div key={cat}>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-sm font-medium capitalize" style={{ color: 'hsl(var(--foreground))' }}>{cat}</span>
                                        <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>{count}</span>
                                    </div>
                                    <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                        <motion.div
                                            initial={{ width: 0 }}
                                            animate={{ width: `${(count / maxCategoryCount) * 100}%` }}
                                            transition={{ duration: 0.8, delay: 0.5 + i * 0.1 }}
                                            className="h-full rounded-full"
                                            style={{ background: `linear-gradient(135deg, hsl(220, 70%, 55%), hsl(${200 + i * 20}, 70%, 55%))` }}
                                        />
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </motion.div>
            </div>

            {/* Top Rated & Performance */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.5 }} className="glass-panel water-shimmer p-6">
                    <h3 className="text-base font-semibold mb-5" style={{ color: 'hsl(var(--foreground))' }}>Top Rated Products</h3>
                    <div className="space-y-3">
                        {products.filter(p => p.rating >= 4).length === 0 ? (
                            <div className="text-center py-8">
                                <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><Star size={24} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No products with 4+ rating yet.</p>
                            </div>
                        ) : products.filter(p => p.rating >= 4).sort((a, b) => b.rating - a.rating).slice(0, 4).map((product, i) => (
                            <motion.div key={product._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                                transition={{ delay: 0.55 + i * 0.05 }}
                                className="flex items-center gap-4 p-3 rounded-xl hover:bg-white/5 transition-all">
                                <img src={product.image} alt={product.name}
                                    className="w-11 h-11 object-cover rounded-xl flex-shrink-0"
                                    style={{ border: '1px solid var(--glass-border)' }} />
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-sm truncate" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</p>
                                    <div className="flex items-center gap-1 mt-0.5">
                                        {[1, 2, 3, 4, 5].map(star => (
                                            <Star key={star} size={11}
                                                style={{
                                                    color: star <= product.rating ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))',
                                                    fill: star <= product.rating ? 'hsl(45, 93%, 47%)' : 'none'
                                                }} />
                                        ))}
                                        <span className="text-[10px] ml-1" style={{ color: 'hsl(var(--muted-foreground))' }}>({product.numReviews})</span>
                                    </div>
                                </div>
                                <span className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {formatPrice(product.price)}
                                </span>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>

                {/* Performance Summary */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.55 }} className="glass-panel water-shimmer p-6">
                    <h3 className="text-base font-semibold mb-5" style={{ color: 'hsl(var(--foreground))' }}>Performance Summary</h3>
                    <div className="space-y-4">
                        {[
                            { label: 'Fulfillment Rate', value: totalOrders > 0 ? `${((deliveredOrders / totalOrders) * 100).toFixed(0)}%` : 'N/A', icon: <TrendingUp size={16} />, color: 'hsl(150, 60%, 45%)' },
                            { label: 'Avg. Order Value', value: totalOrders > 0 ? formatCompactPrice(totalRevenue / totalOrders) : 'N/A', icon: <DollarSign size={16} />, color: 'hsl(220, 70%, 55%)' },
                            { label: 'Total Orders', value: totalOrders, icon: <ShoppingBag size={16} />, color: 'hsl(200, 80%, 50%)' },
                            { label: 'Inventory Health', value: totalProducts > 0 ? `${(((totalProducts - outOfStock) / totalProducts) * 100).toFixed(0)}%` : 'N/A', icon: <Package size={16} />, color: 'hsl(280, 60%, 55%)' },
                        ].map((item, i) => (
                            <motion.div key={item.label} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
                                transition={{ delay: 0.6 + i * 0.05 }}
                                className="flex items-center gap-3 p-3 rounded-xl glass-inner">
                                <div className="p-2 rounded-xl" style={{ background: `${item.color}20`, color: item.color }}>
                                    {item.icon}
                                </div>
                                <div className="flex-1">
                                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.label}</p>
                                </div>
                                <p className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>{item.value}</p>
                            </motion.div>
                        ))}
                    </div>
                </motion.div>
            </div>
        </motion.div>
    );
};

export default StoreOverview;
