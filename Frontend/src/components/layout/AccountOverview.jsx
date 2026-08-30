import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Package, Clock, CheckCircle, User, ShoppingBag, ArrowRight, CreditCard, Sparkles, TrendingUp, Box, Calendar, Eye, MessageCircle } from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import CurrencySelector from '../common/CurrencySelector';
import { Link } from 'react-router-dom';
import { getAuthToken } from "../../utils/cookieHelper";
import { addCurrencyAmounts } from '../../utils/currencySafety';
import { inspectOrderListMoney } from '../../utils/orderItems';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } };
const itemVariants = { hidden: { y: 20, opacity: 0 }, visible: { y: 0, opacity: 1, transition: { type: "spring", stiffness: 100 } } };
const cardVariants = { hidden: { scale: 0.95, opacity: 0 }, visible: { scale: 1, opacity: 1, transition: { type: "spring", stiffness: 100 } } };

const AccountOverview = () => {
    const { currentUser } = useAuth();
    const {
        currency,
        convertLineAmounts,
        exchangeRatesFallback,
        exchangeRatesLoading,
        formatAmount,
        formatPrice,
    } = useCurrency();
    const [orders, setOrders] = useState([]);
    const [userData, setUserData] = useState(currentUser);
    const [recentOrders, setRecentOrders] = useState([]);
    const [loading, setLoading] = useState(true);

    const fetchUser = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/single`, { headers: { Authorization: `Bearer ${token}` } });
            setUserData(res.data?.user);
        } catch (error) { console.error(error); }
    };

    useEffect(() => { fetchUser(); }, []);

    const pendingOrders = orders.filter(order => order.orderStatus === 'pending').length;
    const deliveredOrders = orders.filter(order => order.orderStatus === 'delivered').length;
    const paidOrderMoney = orders.filter(order => order.isPaid).map(inspectOrderListMoney);
    const paidOrderTotalsValid = paidOrderMoney.every(row => row.valid);
    const paidOrderTotals = paidOrderTotalsValid
        ? paidOrderMoney.map(row => ({ unitAmount: row.total, quantity: 1, sourceCurrency: row.currency }))
        : [];
    const totalSpentNeedsLiveRates = paidOrderTotals.some(line => line.sourceCurrency !== currency)
        && (exchangeRatesLoading || exchangeRatesFallback);
    let totalAmountSpent = null;
    if (paidOrderTotalsValid && !totalSpentNeedsLiveRates) {
        try {
            totalAmountSpent = addCurrencyAmounts(...convertLineAmounts(paidOrderTotals, currency));
        } catch (_) {
            totalAmountSpent = null;
        }
    }

    const fetchOrders = async () => {
        const token = getAuthToken();
        setLoading(true);
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/user-orders`, { headers: { Authorization: `Bearer ${token}` } });
            if (!Array.isArray(res.data?.orders)) throw new Error('Order history is unavailable.');
            setOrders(res.data.orders);
            setRecentOrders(res.data.orders.slice().reverse().slice(0, 3));
        } catch (error) { console.error(error); setOrders([]); setRecentOrders([]); }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchOrders(); }, []);

    const formatDate = (dateString) => new Date(dateString).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const formatCurrency = (amount) => formatAmount(amount, { targetCurrency: currency });

    const getStatusDot = (status) => {
        const colors = { delivered: 'hsl(150, 60%, 45%)', shipped: 'hsl(200, 80%, 50%)', processing: 'hsl(45, 93%, 47%)', pending: 'hsl(30, 90%, 50%)' };
        return colors[status] || 'hsl(var(--muted-foreground))';
    };

    const statsCards = [
        { label: 'Total Orders', value: orders.length, icon: <ShoppingBag size={18} />, color: 'hsl(220, 70%, 55%)' },
        { label: 'Pending', value: pendingOrders, icon: <Clock size={18} />, color: 'hsl(30, 90%, 50%)' },
        { label: 'Delivered', value: deliveredOrders, icon: <CheckCircle size={18} />, color: 'hsl(150, 60%, 45%)' },
        { label: 'Total Spent', value: totalAmountSpent === null ? 'Unavailable' : formatCurrency(totalAmountSpent), icon: <CreditCard size={18} />, color: 'hsl(200, 80%, 50%)' },
    ];

    const quickActions = [
        { label: 'Browse Products', icon: <Sparkles size={14} />, link: '/products' },
        { label: 'Your Orders', icon: <Box size={14} />, link: '/user-dashboard/orders' },
        { label: 'WhatsApp AI', icon: <MessageCircle size={14} />, link: '/user-dashboard/whatsapp' },
        { label: 'Saved Cards', icon: <CreditCard size={14} />, link: '/user-dashboard/payment-methods' },
        { label: 'Edit Profile', icon: <User size={14} />, link: '/user-dashboard/profile' },
    ];

    return (
        <div className="min-h-screen p-4 md:p-8">
            <motion.div className="max-w-5xl mx-auto" variants={containerVariants} initial="hidden" animate="visible">
                {/* Hero Header */}
                <motion.div variants={itemVariants} className="glass-panel-strong water-shimmer relative overflow-hidden mb-8 p-6 md:p-8">
                    <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full opacity-25 blur-3xl pointer-events-none" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }} />
                    <div className="relative flex items-center justify-between">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Welcome back</p>
                            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>{userData.username}</h1>
                            <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Here's what's happening with your account</p>
                        </div>
                        <motion.div whileHover={{ scale: 1.05 }} className="relative shrink-0">
                            <div className="flex flex-col items-end gap-2">
                                {userData.avatar ? (
                                    <img src={userData.avatar} alt="Profile" className="w-14 h-14 md:w-16 md:h-16 rounded-2xl object-cover" style={{ border: '2px solid var(--glass-border-strong)' }} />
                                ) : (
                                    <div className="w-14 h-14 md:w-16 md:h-16 rounded-2xl glass-inner flex items-center justify-center font-bold text-2xl" style={{ color: 'hsl(var(--foreground))' }}>
                                        {userData.username?.[0]?.toUpperCase() || 'U'}
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] hidden sm:inline" style={{ color: 'hsl(var(--muted-foreground))' }}>Currency: {currency}</span>
                                    <CurrencySelector />
                                </div>
                            </div>
                            <div className="absolute top-11 right-0 w-4 h-4 rounded-full border-2" style={{ background: 'hsl(150, 60%, 45%)', borderColor: 'var(--glass-border-strong)' }} />
                        </motion.div>
                    </div>
                    <div className="relative flex flex-wrap gap-2 mt-6">
                        {quickActions.map(action => (
                            <Link key={action.label} to={action.link}>
                                <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                                    className="glass-button flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold">
                                    {action.icon}{action.label}
                                </motion.button>
                            </Link>
                        ))}
                    </div>
                </motion.div>

                {loading ? (
                    <div className="w-full h-64 flex justify-center items-center"><Loader /></div>
                ) : (
                    <>
                        {/* Stats */}
                        <motion.div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8" variants={containerVariants}>
                            {statsCards.map((card, i) => (
                                <motion.div key={i} variants={cardVariants} whileHover={{ y: -3 }}
                                    className="glass-card p-5">
                                    <div className="glass-inner inline-flex p-2.5 rounded-xl mb-3" style={{ color: card.color }}>{card.icon}</div>
                                    <p className="text-xs font-medium mb-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{card.label}</p>
                                    <p className="text-2xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{card.value}</p>
                                </motion.div>
                            ))}
                        </motion.div>

                        {/* Recent Orders */}
                        <motion.div variants={itemVariants} className="glass-panel overflow-hidden">
                            <div className="px-6 py-5 flex justify-between items-center" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                                <div className="flex items-center gap-2">
                                    <TrendingUp size={18} style={{ color: 'hsl(var(--primary))' }} />
                                    <h2 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Recent Orders</h2>
                                </div>
                                <Link to="/user-dashboard/orders">
                                    <motion.button whileHover={{ x: 2 }} className="flex items-center gap-1 text-sm font-medium" style={{ color: 'hsl(var(--primary))' }}>
                                        View All <ArrowRight size={14} />
                                    </motion.button>
                                </Link>
                            </div>

                            <div>
                                {recentOrders.length === 0 ? (
                                    <div className="flex flex-col items-center py-14">
                                        <div className="glass-inner p-4 rounded-2xl mb-3"><ShoppingBag size={32} style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                                        <p className="font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>No orders yet</p>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Start shopping to see your orders here</p>
                                        <Link to="/products">
                                            <motion.button whileHover={{ y: -1 }} className="mt-4 px-5 py-2 rounded-xl text-sm font-semibold" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}>
                                                Browse Products
                                            </motion.button>
                                        </Link>
                                    </div>
                                ) : recentOrders.map((order, idx) => {
                                    const money = inspectOrderListMoney(order);
                                    return (
                                    <motion.div key={order._id} className="px-6 py-4 transition-colors hover:bg-white/5" style={{ borderBottom: idx < recentOrders.length - 1 ? '1px solid var(--glass-border-subtle)' : 'none' }}>
                                        <div className="flex items-center gap-4">
                                            <img src={order.orderItems[0].image} alt={order.orderItems[0].name} className="w-14 h-14 object-cover rounded-xl shrink-0" style={{ border: '1px solid var(--glass-border)' }} />
                                            <div className="flex-1 min-w-0">
                                                <h3 className="font-semibold text-sm truncate" style={{ color: 'hsl(var(--foreground))' }}>{order.orderItems[0].name}</h3>
                                                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>#{order.orderId} · {formatDate(order.createdAt)}</p>
                                                <div className="flex items-center gap-1.5 mt-1.5">
                                                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: getStatusDot(order.orderStatus) }} />
                                                    <span className="tag-pill text-[10px] font-medium">{order.orderStatus.charAt(0).toUpperCase() + order.orderStatus.slice(1)}</span>
                                                </div>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className="text-base font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                                    {money.valid
                                                        ? formatPrice(money.total, {
                                                            sourceCurrency: money.currency,
                                                            targetCurrency: money.currency,
                                                            showCode: true,
                                                        })
                                                        : 'Money unavailable'}
                                                </p>
                                            </div>
                                        </div>
                                    </motion.div>
                                    );
                                })}
                            </div>
                        </motion.div>
                    </>
                )}
            </motion.div>
        </div>
    );
};

export default AccountOverview;
