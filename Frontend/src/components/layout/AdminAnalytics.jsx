import React, { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import {
    TrendingUp, DollarSign, ShoppingBag, Package, BarChart3,
    Calendar, ArrowUp, ArrowDown, Sparkles, Star, Store, Users,
    CheckCircle, Clock, Loader2
} from 'lucide-react';
import { useCurrency } from '../../contexts/CurrencyContext';
import axios from 'axios';
import {
    AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, ResponsiveContainer, PieChart, Pie, Cell
} from 'recharts';

const AdminAnalytics = () => {
    const { formatPrice, currency, exchangeRates, getCurrencySymbol } = useCurrency();
    const [timeRange, setTimeRange] = useState('30');
    const [loading, setLoading] = useState(true);
    const [analytics, setAnalytics] = useState(null);

    const rate = exchangeRates[currency] || 1;
    const symbol = getCurrencySymbol();

    const fetchAnalytics = async () => {
        setLoading(true);
        const token = localStorage.getItem('jwtToken');
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/analytics/admin?days=${timeRange}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setAnalytics(res.data.analytics);
        } catch (err) {
            console.error('Failed to fetch admin analytics:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchAnalytics(); }, [timeRange]);

    const ROLE_COLORS = ['hsl(220,70%,55%)', 'hsl(150,60%,45%)', 'hsl(280,60%,55%)'];
    const STATUS_COLORS = ['hsl(30,90%,50%)', 'hsl(220,70%,55%)', 'hsl(200,80%,50%)', 'hsl(150,60%,45%)', 'hsl(0,72%,55%)', 'hsl(340,65%,55%)'];
    const CAT_COLORS = ['hsl(220,70%,55%)', 'hsl(150,60%,45%)', 'hsl(200,80%,50%)', 'hsl(280,60%,55%)', 'hsl(30,90%,50%)', 'hsl(340,65%,55%)', 'hsl(170,60%,45%)', 'hsl(260,55%,55%)'];

    const revenueData = useMemo(() => {
        if (!analytics?.revenueByDay) return [];
        return analytics.revenueByDay.map(b => ({
            ...b,
            label: new Date(b.date).toLocaleDateString('en', { month: 'short', day: 'numeric' }),
            revenue: Math.round(b.revenue * rate * 100) / 100,
        }));
    }, [analytics, rate]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="glass-panel p-3" style={{ minWidth: 140 }}>
                <p className="text-xs font-semibold mb-1" style={{ color: 'hsl(var(--foreground))' }}>{label}</p>
                {payload.map((p, i) => (
                    <p key={i} className="text-xs" style={{ color: p.color }}>
                        {p.name}: {p.name === 'revenue' ? `${symbol}${p.value}` : p.value}
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

    if (loading || !analytics) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <Loader2 size={32} className="animate-spin" style={{ color: 'hsl(var(--muted-foreground))' }} />
            </div>
        );
    }

    const s = analytics.summary;

    const summaryStats = [
        { label: 'Total Revenue', value: `${symbol}${(s.totalRevenue * rate).toFixed(2)}`, icon: <DollarSign size={20} />, color: 'hsl(150,60%,45%)', bg: 'rgba(16,185,129,0.12)', change: `${s.revenueChange >= 0 ? '+' : ''}${s.revenueChange}%`, up: s.revenueChange >= 0 },
        { label: 'Total Orders', value: s.totalOrders, icon: <ShoppingBag size={20} />, color: 'hsl(220,70%,55%)', bg: 'rgba(99,102,241,0.12)', change: `${s.ordersChange >= 0 ? '+' : ''}${s.ordersChange}%`, up: s.ordersChange >= 0 },
        { label: 'Total Stores', value: s.totalStores, icon: <Store size={20} />, color: 'hsl(200,80%,50%)', bg: 'rgba(14,165,233,0.12)', change: `${s.verifiedStores} verified`, up: true },
        { label: 'Total Users', value: s.totalUsers, icon: <Users size={20} />, color: 'hsl(280,60%,55%)', bg: 'rgba(139,92,246,0.12)', change: `${s.totalSellers} sellers`, up: true },
        { label: 'Products', value: s.totalProducts, icon: <Package size={20} />, color: 'hsl(30,90%,50%)', bg: 'rgba(249,115,22,0.12)', change: `${s.outOfStock} out of stock`, up: s.outOfStock === 0 },
        { label: 'Avg Order Value', value: `${symbol}${(s.avgOrderValue * rate).toFixed(2)}`, icon: <TrendingUp size={20} />, color: 'hsl(340,65%,55%)', bg: 'rgba(244,63,94,0.12)', change: `${s.avgChange >= 0 ? '+' : ''}${s.avgChange}%`, up: s.avgChange >= 0 },
    ];

    return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
            {/* Header */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                    <div className="tag-pill mb-2"><Sparkles size={12} /> Platform Analytics</div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>
                        Admin Analytics
                    </h1>
                    <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Platform-wide performance · Last {timeRange} days vs previous {timeRange} days
                    </p>
                </div>
                <div className="flex gap-2">
                    {ranges.map(r => (
                        <motion.button key={r.value} whileTap={{ scale: 0.95 }}
                            onClick={() => setTimeRange(r.value)}
                            className={`px-3 py-2 rounded-xl text-xs font-medium transition-all ${timeRange === r.value ? 'border' : 'glass-inner'}`}
                            style={timeRange === r.value
                                ? { background: 'rgba(99,102,241,0.12)', color: 'hsl(220,70%,55%)', borderColor: 'rgba(99,102,241,0.3)' }
                                : { color: 'hsl(var(--muted-foreground))' }}>
                            <Calendar size={12} className="inline mr-1" />{r.label}
                        </motion.button>
                    ))}
                </div>
            </motion.div>

            {/* Summary Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                {summaryStats.map((stat, i) => (
                    <motion.div key={stat.label} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.05 }} className="glass-card water-shimmer p-5">
                        <div className="flex items-center justify-between mb-3">
                            <div className="p-2.5 rounded-xl" style={{ background: stat.bg, color: stat.color }}>{stat.icon}</div>
                            <span className="flex items-center gap-0.5 text-[11px] font-semibold"
                                style={{ color: stat.up ? 'hsl(150,60%,45%)' : 'hsl(0,72%,55%)' }}>
                                {stat.up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}{stat.change}
                            </span>
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
                        <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Platform Revenue</h3>
                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Total revenue over the last {timeRange} days</p>
                    </div>
                    <div className="p-2 rounded-xl" style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>
                        <TrendingUp size={18} />
                    </div>
                </div>
                <div style={{ height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={revenueData}>
                            <defs>
                                <linearGradient id="adminRevGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="hsl(150,60%,45%)" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="hsl(150,60%,45%)" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(220,10%,50%)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                            <YAxis tick={{ fontSize: 11, fill: 'hsl(220,10%,50%)' }} axisLine={false} tickLine={false} tickFormatter={v => `${symbol}${v}`} />
                            <Tooltip content={<CustomTooltip />} />
                            <Area type="monotone" dataKey="revenue" stroke="hsl(150,60%,45%)" strokeWidth={2.5} fill="url(#adminRevGrad)" />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </motion.div>

            {/* Order Volume + Status */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-6">
                        <div>
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Order Volume</h3>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Daily orders across the platform</p>
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
                                    <Pie data={analytics.statusBreakdown} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value">
                                        {analytics.statusBreakdown.map((_, i) => <Cell key={i} fill={STATUS_COLORS[i % STATUS_COLORS.length]} />)}
                                    </Pie>
                                    <Tooltip content={<CustomTooltip />} />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                        <div className="flex-1 space-y-2">
                            {analytics.statusBreakdown.map((st, i) => (
                                <div key={st.name} className="flex items-center gap-2">
                                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: STATUS_COLORS[i % STATUS_COLORS.length] }} />
                                    <span className="text-xs capitalize flex-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{st.name}</span>
                                    <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{st.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </motion.div>
            </div>

            {/* Top Products */}
            {analytics.topProducts.length > 0 && (
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <h3 className="text-base font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Top Products by Revenue</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {analytics.topProducts.slice(0, 6).map((p, i) => (
                            <div key={i} className="flex items-center gap-3 p-3 rounded-xl glass-inner">
                                <span className="text-xs font-bold w-5 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>#{i + 1}</span>
                                {p.image ? (
                                    <img src={p.image} alt="" className="w-10 h-10 rounded-lg object-cover" style={{ border: '1px solid var(--glass-border)' }} />
                                ) : (
                                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.12)' }}>
                                        <Package size={16} style={{ color: 'hsl(220,70%,55%)' }} />
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{p.name}</p>
                                    <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {symbol}{(p.revenue * rate).toFixed(2)} · {p.sold} sold
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </motion.div>
            )}

            {/* Stores + User Roles */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Top Stores */}
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
                    className="glass-panel water-shimmer p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Top Stores</h3>
                            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>By revenue performance</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                                style={{ background: 'rgba(16,185,129,0.12)', color: 'hsl(150,60%,45%)' }}>
                                {s.verifiedStores} verified
                            </span>
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full"
                                style={{ background: 'rgba(249,115,22,0.12)', color: 'hsl(30,90%,50%)' }}>
                                {s.pendingVerification} pending
                            </span>
                        </div>
                    </div>
                    {analytics.topStores.length === 0 ? (
                        <div className="text-center py-10">
                            <div className="glass-inner inline-flex p-3 rounded-xl mb-2"><Store size={28} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No stores yet</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {analytics.topStores.map((store, i) => (
                                <motion.div key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                                    transition={{ delay: 0.4 + i * 0.04 }}
                                    className="flex items-center gap-3 p-3 rounded-xl glass-inner">
                                    <span className="text-xs font-bold w-5 text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>#{i + 1}</span>
                                    {store.logo ? (
                                        <img src={store.logo} alt="" className="w-9 h-9 rounded-lg object-cover" style={{ border: '1px solid var(--glass-border)' }} />
                                    ) : (
                                        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.12)' }}>
                                            <Store size={16} style={{ color: 'hsl(220,70%,55%)' }} />
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1.5">
                                            <p className="text-sm font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{store.name}</p>
                                            {store.verified && <CheckCircle size={12} style={{ color: 'hsl(150,60%,45%)' }} />}
                                        </div>
                                        <p className="text-[11px]" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            {store.revenue > 0 ? `${symbol}${(store.revenue * rate).toFixed(2)} revenue · ` : ''}{store.trustCount} trusts · {store.productCount} products
                                        </p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </motion.div>

                {/* User Roles + Category Breakdown */}
                <div className="space-y-6">
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}
                        className="glass-panel water-shimmer p-5 sm:p-6">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h3 className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>User Roles</h3>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Distribution of user types</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-6">
                            <div style={{ width: 140, height: 140 }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie data={analytics.roleBreakdown} cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={3} dataKey="value">
                                            {analytics.roleBreakdown.map((_, i) => <Cell key={i} fill={ROLE_COLORS[i]} />)}
                                        </Pie>
                                        <Tooltip content={<CustomTooltip />} />
                                    </PieChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="flex-1 space-y-2">
                                {analytics.roleBreakdown.map((r, i) => r.value > 0 && (
                                    <div key={r.name} className="flex items-center gap-2">
                                        <div className="w-2.5 h-2.5 rounded-full" style={{ background: ROLE_COLORS[i] }} />
                                        <span className="text-xs capitalize flex-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{r.name}s</span>
                                        <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{r.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </motion.div>

                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
                        className="glass-panel water-shimmer p-5 sm:p-6">
                        <h3 className="text-base font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Category Breakdown</h3>
                        <div className="space-y-2">
                            {analytics.categoryBreakdown.map((c, i) => {
                                const max = analytics.categoryBreakdown[0]?.count || 1;
                                return (
                                    <div key={c.name} className="flex items-center gap-3">
                                        <span className="text-xs w-24 truncate font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>{c.name}</span>
                                        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                            <motion.div initial={{ width: 0 }} animate={{ width: `${(c.count / max) * 100}%` }}
                                                transition={{ delay: 0.5 + i * 0.05 }}
                                                className="h-full rounded-full" style={{ background: CAT_COLORS[i % CAT_COLORS.length] }} />
                                        </div>
                                        <span className="text-xs font-semibold w-8 text-right" style={{ color: 'hsl(var(--foreground))' }}>{c.count}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </motion.div>
                </div>
            </div>
        </motion.div>
    );
};

export default AdminAnalytics;
