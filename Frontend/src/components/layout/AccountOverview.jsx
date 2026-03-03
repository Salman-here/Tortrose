import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
    Package,
    Clock,
    CheckCircle,
    ChevronRight,
    User,
    ShoppingBag,
    ArrowRight,
    CreditCard,
    Sparkles,
    TrendingUp,
    Box,
} from 'lucide-react';
import axios from 'axios';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import Loader from '../common/Loader';
import { Link } from 'react-router-dom';





// Animation variants
const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
        opacity: 1,
        transition: {
            staggerChildren: 0.1
        }
    }
};

const itemVariants = {
    hidden: { y: 20, opacity: 0 },
    visible: {
        y: 0,
        opacity: 1,
        transition: {
            type: "spring",
            stiffness: 100
        }
    }
};

const cardVariants = {
    hidden: { scale: 0.9, opacity: 0 },
    visible: {
        scale: 1,
        opacity: 1,
        transition: {
            type: "spring",
            stiffness: 100
        }
    }
};

const AccountOverview = () => {
    const {
        currentUser
    } = useAuth()
    const { formatPrice } = useCurrency()
    const [orders, setOrders] = useState([]);
    const [userData, setUserData] = useState(currentUser);
    const [recentOrders, setRecentOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    // console.log(currentUser);

    const fetchUser = async () => {
        try {
            const token = localStorage.getItem('jwtToken')
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/single`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            console.log(res.data);
            setUserData(res.data?.user)

        } catch (error) {
            console.error(error);
        }
        finally {
            // setIsWaiting(false)
        }

    }

    useEffect(() => {
        fetchUser()
    }, [])



    const pendingOrders = orders.filter(order => order.orderStatus === 'pending').length
    const deliveredOrders = orders.filter(order => order.orderStatus === 'delivered').length
    const totalAmoutSpent = orders.reduce((acc, order) => {
        if (order.isPaid == true) {
            // Recalculate total using actual shipping cost
            const subtotal = order.orderSummary.subtotal || 0;
            const tax = order.orderSummary.tax || 0;
            let actualShipping = order.orderSummary.shippingCost || 0;
            if (order.sellerShipping && order.sellerShipping.length > 0) {
                actualShipping = order.sellerShipping.reduce((sum, sellerShip) => 
                    sum + (sellerShip.shippingMethod.price || 0), 0
                );
            }
            return acc + (subtotal + tax + actualShipping);
        }
        return acc + 0
    }, 0)

    const fetchOrders = async () => {

        const token = localStorage.getItem('jwtToken')
        setLoading(true)
        try {
            const query = ''
            // const query = serializeFilters()
            // console.log(query);

            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/user-orders`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            console.log(res.data);
            setOrders(res.data?.orders)
            // Get the 3 most recent orders (reverse first, then take 3)
            setRecentOrders(res.data?.orders.slice().reverse().slice(0, 3))

        } catch (error) {
            console.error(error);
        }
        finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchOrders()
    }, [])

    // Format date function
    const formatDate = (dateString) => {
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return new Date(dateString).toLocaleDateString(undefined, options);
    };

    // Get status color
    const getStatusColor = (status) => {
        switch (status) {
            case 'delivered': return 'bg-emerald-100 text-emerald-700 border border-emerald-200';
            case 'shipped': return 'bg-sky-100 text-sky-700 border border-sky-200';
            case 'processing': return 'bg-amber-100 text-amber-700 border border-amber-200';
            case 'pending': return 'bg-orange-100 text-orange-700 border border-orange-200';
            default: return 'bg-slate-100 text-slate-600 border border-slate-200';
        }
    };

    const getStatusDot = (status) => {
        switch (status) {
            case 'delivered': return 'bg-emerald-500';
            case 'shipped': return 'bg-sky-500';
            case 'processing': return 'bg-amber-500';
            case 'pending': return 'bg-orange-500';
            default: return 'bg-slate-400';
        }
    };

    const formatCurrency = (amount) => formatPrice(amount);

    const statsCards = [
        { label: 'Total Orders', value: orders.length, icon: <ShoppingBag size={20} />, gradient: 'from-indigo-500 to-indigo-600', bg: 'bg-indigo-50', text: 'text-indigo-600' },
        { label: 'Pending', value: pendingOrders, icon: <Clock size={20} />, gradient: 'from-amber-500 to-orange-500', bg: 'bg-amber-50', text: 'text-amber-600' },
        { label: 'Delivered', value: deliveredOrders, icon: <CheckCircle size={20} />, gradient: 'from-emerald-500 to-emerald-600', bg: 'bg-emerald-50', text: 'text-emerald-600' },
        { label: 'Total Spent', value: formatCurrency(totalAmoutSpent), icon: <CreditCard size={20} />, gradient: 'from-sky-400 to-sky-500', bg: 'bg-sky-50', text: 'text-sky-600' },
    ];

    const quickActions = [
        { label: 'Browse Products', icon: <Sparkles size={16} />, link: '/products', color: 'bg-indigo-600 hover:bg-indigo-700' },
        { label: 'Your Orders', icon: <Box size={16} />, link: '/user-dashboard/orders', color: 'bg-slate-700 hover:bg-slate-800' },
        { label: 'Edit Profile', icon: <User size={16} />, link: '/user-dashboard/profile', color: 'bg-sky-500 hover:bg-sky-600' },
    ];

    return (
        <div className="min-h-screen p-4 md:p-8">
            <motion.div className="max-w-5xl mx-auto" variants={containerVariants} initial="hidden" animate="visible">

                {/* Hero Header */}
                <motion.div variants={itemVariants}
                    className="relative rounded-2xl overflow-hidden mb-8 bg-linear-to-r from-indigo-600 via-indigo-500 to-sky-500 p-6 md:p-8 shadow-xl shadow-indigo-300/40">
                    <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.15),transparent_60%)]" />
                    <div className="relative flex items-center justify-between">
                        <div>
                            <p className="text-indigo-200 text-sm font-medium mb-1">Welcome back</p>
                            <h1 className="text-2xl md:text-3xl font-bold text-white">
                                {userData.username} 👋
                            </h1>
                            <p className="text-indigo-200 text-sm mt-1">Here's what's happening with your account</p>
                        </div>
                        <motion.div whileHover={{ scale: 1.05 }} className="relative shrink-0">
                            {userData.avatar ? (
                                <img src={userData.avatar} alt="Profile"
                                    className="w-14 h-14 md:w-16 md:h-16 rounded-2xl object-cover border-2 border-white/30 shadow-lg" />
                            ) : (
                                <div className="w-14 h-14 md:w-16 md:h-16 rounded-2xl bg-white/20 border-2 border-white/30 flex items-center justify-center text-white font-bold text-2xl">
                                    {userData.username?.[0]?.toUpperCase() || 'U'}
                                </div>
                            )}
                            <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-emerald-400 rounded-full border-2 border-white shadow-sm" />
                        </motion.div>
                    </div>
                    {/* Quick Actions */}
                    <div className="relative flex flex-wrap gap-2 mt-6">
                        {quickActions.map(action => (
                            <Link key={action.label} to={action.link}>
                                <motion.button whileHover={{ y: -1 }} whileTap={{ scale: 0.97 }}
                                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-white text-xs font-semibold ${action.color} transition-colors shadow-sm`}>
                                    {action.icon}{action.label}
                                </motion.button>
                            </Link>
                        ))}
                    </div>
                </motion.div>

                {loading ? (
                    <div className="w-full h-64 flex justify-center items-center">
                        <Loader />
                    </div>
                ) : (
                    <>
                        {/* Stats Cards */}
                        <motion.div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8" variants={containerVariants}>
                            {statsCards.map((card, i) => (
                                <motion.div key={i} variants={cardVariants} whileHover={{ y: -3, transition: { duration: 0.2 } }}
                                    className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
                                    <div className={`inline-flex p-2.5 rounded-xl ${card.bg} ${card.text} mb-3`}>
                                        {card.icon}
                                    </div>
                                    <p className="text-slate-500 text-xs font-medium mb-1">{card.label}</p>
                                    <p className="text-2xl font-bold text-slate-800">{card.value}</p>
                                </motion.div>
                            ))}
                        </motion.div>

                        {/* Recent Orders */}
                        <motion.div variants={itemVariants}
                            className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                            <div className="px-6 py-5 border-b border-slate-100 flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <TrendingUp size={18} className="text-indigo-500" />
                                    <h2 className="text-lg font-semibold text-slate-800">Recent Orders</h2>
                                </div>
                                <Link to="/user-dashboard/orders">
                                    <motion.button whileHover={{ x: 2 }}
                                        className="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 text-sm font-medium transition-colors">
                                        View All <ArrowRight size={14} />
                                    </motion.button>
                                </Link>
                            </div>

                            <div className="divide-y divide-slate-50">
                                {recentOrders.length === 0 ? (
                                    <div className="flex flex-col items-center py-14 text-slate-400">
                                        <ShoppingBag size={40} className="mb-3 opacity-40" />
                                        <p className="font-medium text-slate-500">No orders yet</p>
                                        <p className="text-sm mt-1">Start shopping to see your orders here</p>
                                        <Link to="/products">
                                            <motion.button whileHover={{ y: -1 }}
                                                className="mt-4 px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors">
                                                Browse Products
                                            </motion.button>
                                        </Link>
                                    </div>
                                ) : recentOrders.map((order) => (
                                    <motion.div key={order._id} whileHover={{ backgroundColor: '#F8FAFC' }}
                                        className="px-6 py-4 transition-colors">
                                        <div className="flex items-center gap-4">
                                            <img src={order.orderItems[0].image} alt={order.orderItems[0].name}
                                                className="w-14 h-14 object-cover rounded-xl border border-slate-100 shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <h3 className="font-semibold text-slate-800 text-sm truncate">{order.orderItems[0].name}</h3>
                                                <p className="text-xs text-slate-400 mt-0.5">#{order.orderId} · {formatDate(order.createdAt)}</p>
                                                <div className="flex items-center gap-1.5 mt-1.5">
                                                    <div className={`w-1.5 h-1.5 rounded-full ${getStatusDot(order.orderStatus)}`} />
                                                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${getStatusColor(order.orderStatus)}`}>
                                                        {order.orderStatus.charAt(0).toUpperCase() + order.orderStatus.slice(1)}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="text-right shrink-0">
                                                <p className="text-base font-bold text-slate-800">
                                                    {(() => {
                                                        const subtotal = order.orderSummary.subtotal || 0;
                                                        const tax = order.orderSummary.tax || 0;
                                                        let actualShipping = order.orderSummary.shippingCost || 0;
                                                        if (order.sellerShipping && order.sellerShipping.length > 0) {
                                                            actualShipping = order.sellerShipping.reduce((sum, s) => sum + (s.shippingMethod.price || 0), 0);
                                                        }
                                                        return formatCurrency(subtotal + tax + actualShipping);
                                                    })()}
                                                </p>
                                            </div>
                                        </div>
                                    </motion.div>
                                ))}
                            </div>
                        </motion.div>
                    </>
                )}
            </motion.div>
        </div>
    );
};

export default AccountOverview;