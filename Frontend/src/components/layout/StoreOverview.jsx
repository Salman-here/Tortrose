import React from "react";
import { motion } from "framer-motion";
import { Package, TriangleAlert, AlertCircle, Star, DollarSign, TrendingUp, ShoppingBag, Eye, ArrowRight, Sparkles } from "lucide-react";
import { useOutletContext, Link } from "react-router-dom";
import { useCurrency } from "../../contexts/CurrencyContext";
import Loader from "../common/Loader";
import {
    roundCurrencyAmount,
    selectAuthoritativeSellerMetrics,
} from '../../utils/currencySafety';
import {
    inspectSellerProductPresentation,
    sellerInventoryOverviewIsValid,
} from '../../utils/productCardSafety';

const StoreOverview = () => {
    const { formatPrice, currency } = useCurrency();
    const context = useOutletContext() || {};
    const {
        products = [],
        orders = [],
        overviewProducts = null,
        overviewOrders = null,
        overviewMetrics = null,
        overviewLoaded = false,
        overviewError = '',
        refreshOverview,
        dashboardRole,
    } = context;
    const usesCanonicalOverview = dashboardRole === 'seller';
    const businessProducts = usesCanonicalOverview
        ? (Array.isArray(overviewProducts) ? overviewProducts : [])
        : products;
    const businessOrders = usesCanonicalOverview
        ? (Array.isArray(overviewOrders) ? overviewOrders : [])
        : orders;

    if (usesCanonicalOverview && !overviewLoaded) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading verified store totals..." />
            </div>
        );
    }

    const formatCompactPrice = (amount) => {
        const value = amount;
        const symbol = formatPrice(0, { sourceCurrency: currency, decimals: 0 }).replace(/[0-9,.]/g, '');
        if (value >= 1000000) return `${symbol}${(value / 1000000).toFixed(1)}M`;
        if (value >= 10000) return `${symbol}${(value / 1000).toFixed(1)}K`;
        return formatPrice(value, { sourceCurrency: currency });
    };

    const inventoryOverview = overviewMetrics?.inventory || null;
    const inventoryValid = sellerInventoryOverviewIsValid(inventoryOverview)
        && Number.isSafeInteger(overviewMetrics?.productCount)
        && overviewMetrics.productCount === inventoryOverview.totalProducts;
    const productPresentations = businessProducts.map(inspectSellerProductPresentation);
    const fallbackInventoryValid = !usesCanonicalOverview
        && productPresentations.every(presentation => presentation.stockValid)
        && businessProducts.every(product => typeof product?.isFeatured === 'boolean');
    const totalProducts = usesCanonicalOverview
        ? (inventoryValid ? overviewMetrics.productCount : null)
        : businessProducts.length;
    const outOfStock = inventoryValid
        ? inventoryOverview.outOfStock
        : (fallbackInventoryValid
            ? productPresentations.filter(presentation => presentation.stock === 0).length
            : null);
    const lowStock = inventoryValid
        ? inventoryOverview.lowStock
        : (fallbackInventoryValid
            ? productPresentations.filter(presentation => presentation.stock > 0 && presentation.stock <= 10).length
            : null);
    const featuredProducts = inventoryValid
        ? inventoryOverview.featuredProducts
        : (fallbackInventoryValid ? businessProducts.filter(product => product.isFeatured).length : null);
    const authoritativeMetrics = selectAuthoritativeSellerMetrics(overviewMetrics, currency);
    const totalRevenue = authoritativeMetrics?.totalSales ?? null;
    const averageRecognizedOrder = authoritativeMetrics === null
        ? null
        : authoritativeMetrics.totalOrders === 0
            ? 0
            : roundCurrencyAmount(authoritativeMetrics.totalSales / authoritativeMetrics.totalOrders);
    const deliveredOrders = businessOrders.filter(o => o.orderStatus === 'delivered').length;
    const totalOrders = businessOrders.length;

    const stats = [
        { label: 'Total Products', value: totalProducts === null ? 'Unavailable' : totalProducts, icon: <Package size={20} />, color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)' },
        { label: 'Out of Stock', value: outOfStock === null ? 'Unavailable' : outOfStock, icon: <TriangleAlert size={20} />, color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)' },
        { label: 'Low Stock', value: lowStock === null ? 'Unavailable' : lowStock, icon: <AlertCircle size={20} />, color: 'hsl(30, 90%, 50%)', bg: 'rgba(249, 115, 22, 0.12)' },
        { label: 'Featured', value: featuredProducts === null ? 'Unavailable' : featuredProducts, icon: <Star size={20} />, color: 'hsl(45, 93%, 47%)', bg: 'rgba(245, 158, 11, 0.12)' },
        { label: 'Recognized Revenue', value: totalRevenue === null ? 'Unavailable' : formatCompactPrice(totalRevenue), icon: <DollarSign size={20} />, color: 'hsl(150, 60%, 45%)', bg: 'rgba(16, 185, 129, 0.12)' },
    ];

    const topCategories = inventoryValid
        ? inventoryOverview.categories.map(row => [row.category, row.count])
        : (usesCanonicalOverview ? [] : Object.entries(businessProducts.reduce((acc, product) => {
            acc[product.category] = (acc[product.category] || 0) + 1;
            return acc;
        }, {})).sort(([, left], [, right]) => right - left).slice(0, 5));
    const recentProducts = usesCanonicalOverview && inventoryValid
        ? inventoryOverview.recentProducts
        : businessProducts.slice(0, 5);
    const topRatedProducts = usesCanonicalOverview && inventoryValid
        ? inventoryOverview.topRatedProducts
        : businessProducts.filter(product => {
            const presentation = inspectSellerProductPresentation(product);
            return presentation.ratingValid && presentation.rating >= 4;
        })
            .sort((left, right) => (
                inspectSellerProductPresentation(right).rating
                - inspectSellerProductPresentation(left).rating
            ))
            .slice(0, 4);

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

            {usesCanonicalOverview && !!overviewError && (
                <div className="glass-panel p-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3" role="status" aria-live="polite">
                    <AlertCircle size={18} className="shrink-0" style={{ color: 'hsl(30,90%,50%)' }} />
                    <p className="text-sm flex-1" style={{ color: 'hsl(var(--foreground))' }}>{overviewError}</p>
                    <button type="button" onClick={refreshOverview} className="px-3 py-2 rounded-xl glass-inner text-xs font-semibold">Retry</button>
                </div>
            )}

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
                        {recentProducts.length === 0 ? (
                            <div className="text-center py-8">
                                <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><Package size={28} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No products yet. Start by adding your first product.</p>
                            </div>
                        ) : recentProducts.map((product, i) => {
                            const presentation = inspectSellerProductPresentation(product);
                            return (
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
                                        <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {presentation.moneyValid
                                                ? formatPrice(presentation.price, { sourceCurrency: presentation.currency })
                                                : 'Price unavailable'}
                                        </span>
                                    </div>
                                </div>
                                <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold shrink-0"
                                    style={presentation.stockValid && presentation.stock > 0
                                        ? presentation.stock <= 10
                                            ? { background: 'rgba(245, 158, 11, 0.12)', color: 'hsl(45, 80%, 40%)' }
                                            : { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }
                                        : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }
                                    }>
                                    {!presentation.stockValid
                                        ? 'Stock unavailable'
                                        : presentation.stock > 0
                                            ? `${presentation.stock} in stock`
                                            : 'Out of stock'}
                                </span>
                            </motion.div>
                            );
                        })}
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
                        {topRatedProducts.length === 0 ? (
                            <div className="text-center py-8">
                                <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><Star size={24} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                                <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No products with 4+ rating yet.</p>
                            </div>
                        ) : topRatedProducts.map((product, i) => {
                            const presentation = inspectSellerProductPresentation(product);
                            return (
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
                                                    color: presentation.ratingValid && star <= presentation.rating ? 'hsl(45, 93%, 47%)' : 'hsl(var(--muted-foreground))',
                                                    fill: presentation.ratingValid && star <= presentation.rating ? 'hsl(45, 93%, 47%)' : 'none'
                                                }} />
                                        ))}
                                        <span className="text-[10px] ml-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {presentation.reviewCountValid ? `(${presentation.reviewCount})` : '(unavailable)'}
                                        </span>
                                    </div>
                                </div>
                                <span className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {presentation.moneyValid
                                        ? formatPrice(presentation.price, { sourceCurrency: presentation.currency })
                                        : 'Price unavailable'}
                                </span>
                            </motion.div>
                            );
                        })}
                    </div>
                </motion.div>

                {/* Performance Summary */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.55 }} className="glass-panel water-shimmer p-6">
                    <h3 className="text-base font-semibold mb-5" style={{ color: 'hsl(var(--foreground))' }}>Performance Summary</h3>
                    <div className="space-y-4">
                        {[
                            { label: 'Fulfillment Rate', value: totalOrders > 0 ? `${((deliveredOrders / totalOrders) * 100).toFixed(0)}%` : 'N/A', icon: <TrendingUp size={16} />, color: 'hsl(150, 60%, 45%)' },
                            { label: 'Avg. Recognized Order', value: averageRecognizedOrder === null ? 'Unavailable' : formatCompactPrice(averageRecognizedOrder), icon: <DollarSign size={16} />, color: 'hsl(220, 70%, 55%)' },
                            { label: 'Total Orders', value: totalOrders, icon: <ShoppingBag size={16} />, color: 'hsl(200, 80%, 50%)' },
                            { label: 'Inventory Health', value: totalProducts === null || outOfStock === null ? 'Unavailable' : totalProducts > 0 ? `${(((totalProducts - outOfStock) / totalProducts) * 100).toFixed(0)}%` : 'N/A', icon: <Package size={16} />, color: 'hsl(280, 60%, 55%)' },
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
