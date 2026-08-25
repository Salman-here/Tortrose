import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import {
    TrendingUp, DollarSign, ShoppingBag, Package, BarChart3,
    Calendar, ArrowUp, ArrowDown, Sparkles, Star, AlertTriangle
} from 'lucide-react';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import axios from 'axios';
import { getAuthToken } from "../../utils/cookieHelper";
import {
    AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts';
import {
    roundCurrencyAmount,
    sellerAnalyticsMoneyIsValid,
} from '../../utils/currencySafety';

const STATUS_ORDER = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
const STATUS_COLORS = {
    pending: 'hsl(30,90%,50%)',
    confirmed: 'hsl(280,60%,55%)',
    processing: 'hsl(200,80%,50%)',
    shipped: 'hsl(220,70%,55%)',
    delivered: 'hsl(150,60%,45%)',
    cancelled: 'hsl(0,72%,55%)',
};
const statusColor = (status) => STATUS_COLORS[status] || 'hsl(var(--muted-foreground))';

const SellerAnalytics = () => {
    const { formatPrice, currency } = useCurrency();
    const [timeRange, setTimeRange] = useState('30');
    const [loading, setLoading] = useState(true);
    const [analytics, setAnalytics] = useState(null);
    const [loadError, setLoadError] = useState('');
    const analyticsRequestRef = useRef({ id: 0, controller: null });

    const fetchAnalytics = useCallback(async () => {
        const requestId = analyticsRequestRef.current.id + 1;
        analyticsRequestRef.current.controller?.abort();
        const controller = new AbortController();
        analyticsRequestRef.current = { id: requestId, controller };
        setLoading(true);
        const token = getAuthToken();
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/analytics/seller?days=${timeRange}&currency=${currency}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: controller.signal,
            });
            if (analyticsRequestRef.current.id !== requestId) return;
            const nextAnalytics = res.data.analytics;
            if (!sellerAnalyticsMoneyIsValid(nextAnalytics, currency)) {
                throw new Error('Analytics returned incomplete or invalid money totals. Please retry.');
            }
            setAnalytics(nextAnalytics);
            setLoadError('');
        } catch (err) {
            if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
            if (analyticsRequestRef.current.id !== requestId) return;
            setAnalytics(null);
            setLoadError(err.response?.data?.msg || err.message || 'Live seller analytics are unavailable. Please retry.');
        } finally {
            if (analyticsRequestRef.current.id === requestId) setLoading(false);
        }
    }, [currency, timeRange]);

    useEffect(() => {
        fetchAnalytics();
        return () => {
            analyticsRequestRef.current.id += 1;
            analyticsRequestRef.current.controller?.abort();
        };
    }, [fetchAnalytics]);

    const CAT_COLORS = ['hsl(220,70%,55%)', 'hsl(150,60%,45%)', 'hsl(200,80%,50%)', 'hsl(280,60%,55%)', 'hsl(30,90%,50%)', 'hsl(340,65%,55%)'];

    const revenueData = useMemo(() => {
        if (!analytics?.revenueByDay) return [];
        return analytics.revenueByDay.map(b => ({
            ...b,
            label: new Date(b.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
            revenue: roundCurrencyAmount(b.revenue),
        }));
    }, [analytics]);

    const statusData = useMemo(() => {
        return [...(analytics?.statusBreakdown || [])].sort((left, right) => {
            const leftIndex = STATUS_ORDER.indexOf(left.name);
            const rightIndex = STATUS_ORDER.indexOf(right.name);
            return (leftIndex === -1 ? STATUS_ORDER.length : leftIndex) - (rightIndex === -1 ? STATUS_ORDER.length : rightIndex);
        });
    }, [analytics?.statusBreakdown]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="glass-floating p-3" style={{ minWidth: 140 }}>
                <p className="text-xs font-semibold mb-1" style={{ color: 'hsl(var(--foreground))' }}>{label}</p>
                {payload.map((p, i) => (
                    <p key={i} className="text-xs" style={{ color: p.color }}>
                        {p.name}: {p.name === 'revenue' ? formatPrice(p.value, { sourceCurrency: analytics?.currency || currency, targetCurrency: analytics?.currency || currency }) : p.value}
                    </p>
                ))}
            </div>
        );
    };

    const ranges = [
        { label: '7 Days', value: '7' },
        { label: '30 Days', value: '30' },
        { label: '90 Days', value: '90' },
    ];

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader size="default" text="Loading analytics..." />
            </div>
        );
    }

    if (!analytics) {
        return (
            <div className="p-6 max-w-xl mx-auto text-center glass-panel space-y-4">
                <AlertTriangle size={30} className="mx-auto" style={{ color: 'hsl(30,90%,50%)' }} />
                <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>{loadError}</p>
                <button type="button" onClick={fetchAnalytics} className="px-4 py-2 rounded-xl glass-inner text-sm font-semibold">Retry</button>
            </div>
        );
    }

    const s = analytics.summary;
    const analyticsCurrency = analytics.currency;
    const money = (amount) => formatPrice(amount, {
        sourceCurrency: analyticsCurrency,
        targetCurrency: analyticsCurrency,
    });

    const summaryStats = [
        { label: 'Total Revenue', value: money(s.totalRevenue), icon: <DollarSign size={20} />, color: 'hsl(150,60%,45%)', bg: 'rgba(16,185,129,0.12)' },
        { label: 'Recognized Orders', value: s.paidOrders, icon: <ShoppingBag size={20} />, color: 'hsl(220,70%,55%)', bg: 'rgba(99,102,241,0.12)' },
        { label: 'Avg Order Value', value: money(s.avgOrderValue), icon: <TrendingUp size={20} />, color: 'hsl(200,80%,50%)', bg: 'rgba(14,165,233,0.12)' },
        { label: 'Units Sold', value: s.totalUnitsSold, icon: <Package size={20} />, color: 'hsl(280,60%,55%)', bg: 'rgba(139,92,246,0.12)' },
    ];

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">

            {/* Header */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                    <div className="tag-pill mb-2"><Sparkles size={12} /> Analytics</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Store Analytics
                    </h1>
                    <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Track your store performance and revenue trends
                    </p>
                </div>
                <div className="flex gap-2">
                    {ranges.map(r => (
                        <motion.button key={r.value} whileTap={{ scale: 0.95 }}
                            onClick={() => setTimeRange(r.value)}
                            className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${timeRange === r.value ? 'border' : 'glass-inner'}`}
                            style={timeRange === r.value
                                ? { background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)', borderColor: 'rgba(16,185,129,0.3)' }
                                : { color: 'hsl(var(--muted-foreground))' }}>
                            <Calendar size={12} className="inline mr-1" />{r.label}
                        </motion.button>
                    ))}
                </div>
            </motion.div>

            {/* Summary Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {summaryStats.map((stat, i) => (
                    <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }} className="glass-card water-shimmer p-5">
                        <div className="flex items-center justify-between mb-3">
                            <div className="p-2.5 rounded-xl" style={{ background: stat.bg, color: stat.color }}>{stat.icon}</div>
                        </div>
                        <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{stat.label}</p>
                        <p className="text-2xl font-extrabold mt-1" style={{ color: 'hsl(var(--foreground))', letterSpacing: '-0.03em' }}>{stat.value}</p>
                    </motion.div>
                ))}
            </div>

            {/* Revenue Chart */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
                className="glass-panel water-shimmer p-5 sm:p-6">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Revenue Trend</h3>
                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Daily revenue over the last {timeRange} days</p>
                    </div>
                    <div className="p-2 rounded-xl" style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>
                        <TrendingUp size={18} />
                    </div>
                </div>
                <div style={{ height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={revenueData}>
                            <defs>
                                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="hsl(150,60%,45%)" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="hsl(150,60%,45%)" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(220,10%,50%)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                            <YAxis tick={{ fontSize: 11, fill: 'hsl(220,10%,50%)' }} axisLine={false} tickLine={false} tickFormatter={v => formatPrice(v, { sourceCurrency: analyticsCurrency, targetCurrency: analyticsCurrency, decimals: 0 })} />
                            <Tooltip content={<CustomTooltip />} />
                            <Area type="monotone" dataKey="revenue" stroke="hsl(150,60%,45%)" strokeWidth={2.5} fill="url(#revGrad)" />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </motion.div>

            {/* Order Volume + Order Status */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Order Volume</h3>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Daily orders received</p>
                        </div>
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)' }}>
                            <BarChart3 size={18} />
                        </div>
                    </div>
                    <div style={{ height: 240 }}>
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={revenueData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(220,10%,50%)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                                <YAxis tick={{ fontSize: 11, fill: 'hsl(220,10%,50%)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey="orders" fill="hsl(220,70%,55%)" radius={[6, 6, 0, 0]} barSize={revenueData.length > 30 ? 6 : 16} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Order Status</h3>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Breakdown by current status</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <div style={{ width: 180, height: 180 }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie data={statusData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value">
                                        {statusData.map((status) => <Cell key={status.name} fill={statusColor(status.name)} />)}
                                    </Pie>
                                    <Tooltip content={<CustomTooltip />} />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                        <div className="flex-1 space-y-2">
                            {statusData.map((s) => s.value > 0 && (
                                <div key={s.name} className="flex items-center gap-2">
                                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: statusColor(s.name) }} />
                                    <span className="text-xs capitalize flex-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{s.name}</span>
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{s.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </motion.div>
            </div>

            {/* Top Products + Category Breakdown */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Top Products</h3>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>By revenue generated</p>
                        </div>
                        <div className="p-2 rounded-xl" style={{ background: 'rgba(139,92,246,0.12)', color: 'hsl(280,60%,55%)' }}>
                            <Star size={18} />
                        </div>
                    </div>
                    {analytics.topProducts.length === 0 ? (
                        <div className="text-center py-10">
                            <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><Package size={28} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No sales data yet</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {analytics.topProducts.slice(0, 6).map((p, i) => (
                                <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                                    transition={{ delay: 0.4 + i * 0.05 }}
                                    className="flex items-center gap-3 p-3 rounded-xl glass-inner">
                                    <span className="text-xs font-bold w-5 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>#{i + 1}</span>
                                    {p.image && <img src={p.image} alt="" className="w-9 h-9 rounded-lg object-cover" style={{ border: '1px solid var(--glass-border)' }} />}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{p.name}</p>
                                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{p.sold} units sold</p>
                                    </div>
                                    <p className="text-sm font-bold shrink-0" style={{ color: 'hsl(150,60%,45%)' }}>{money(p.revenue)}</p>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </motion.div>

                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Category Breakdown</h3>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Products by category</p>
                        </div>
                    </div>
                    {analytics.categoryBreakdown.length === 0 ? (
                        <div className="text-center py-10">
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No products yet</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {analytics.categoryBreakdown.map((c, i) => {
                                const maxCount = Math.max(...analytics.categoryBreakdown.map(x => x.count));
                                const pct = maxCount > 0 ? (c.count / maxCount) * 100 : 0;
                                return (
                                    <div key={c.name}>
                                        <div className="flex items-center justify-between mb-1">
                                            <span className="text-sm font-medium capitalize" style={{ color: 'hsl(var(--foreground))' }}>{c.name}</span>
                                            <span className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>{c.count} products</span>
                                        </div>
                                        <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                            <motion.div initial={{ width: 0 }} animate={{ width: `${pct}%` }}
                                                transition={{ duration: 0.8, delay: 0.5 + i * 0.1 }}
                                                className="h-full rounded-full"
                                                style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </motion.div>
            </div>
        </motion.div>
    );
};

export default SellerAnalytics;
