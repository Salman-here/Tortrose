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
    CreditCard
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
            case 'delivered':
                return 'bg-green-100 text-green-800';
            case 'shipped':
                return 'bg-blue-100 text-blue-800';
            case 'processing':
                return 'bg-yellow-100 text-yellow-800';
            case 'pending':
                return 'bg-orange-100 text-orange-800';
            default:
                return 'bg-gray-100 text-gray-800';
        }
    };

    // Format currency - now using currency context
    const formatCurrency = (amount) => {
        return formatPrice(amount);
    };



    return (
        <div className="min-h-screen bg-gray-50 p-4 md:p-6">
            <motion.div
                className="max-w-6xl mx-auto"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
            >
                {/* Welcome Header */}
                <motion.div
                    className="flex items-center justify-between mb-8"
                    variants={itemVariants}
                >
                    <div>
                        <h1 className="text-2xl md:text-3xl font-bold text-gray-800">
                            Welcome, {userData.username} 👋
                        </h1>
                        <p className="text-gray-600">Here's your account overview</p>
                    </div>
                    {
                        userData.avatar !== '' && (

                            <motion.div
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                className="relative"
                            >
                                <img
                                    src={userData.avatar}
                                    alt="Profile"
                                    className="w-12 h-12 md:w-14 md:h-14 rounded-full object-cover border-2 border-white shadow-md"
                                />
                                <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
                            </motion.div>
                        )
                    }
                </motion.div>

                {
                    loading ? (
                        <div className='w-full h-[300px] flex justify-center items-center'>

                            <Loader />
                        </div>
                    )
                        :
                        <>
                            {/* Stats Cards */}
                            <motion.div
                                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
                                variants={containerVariants}
                            >
                                {/* Total Orders Card */}
                                <motion.div
                                    variants={cardVariants}
                                    className="bg-white rounded-xl p-5 shadow-md border border-gray-100"
                                >
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-gray-500 text-sm font-medium">Total Orders</p>
                                            <h3 className="text-2xl font-bold text-gray-800 mt-1">
                                                {orders.length}
                                            </h3>
                                        </div>
                                        <div className="p-3 bg-blue-100 rounded-lg">
                                            <ShoppingBag className="h-6 w-6 text-blue-600" />
                                        </div>
                                    </div>
                                </motion.div>

                                {/* Pending Orders Card */}
                                <motion.div
                                    variants={cardVariants}
                                    className="bg-white rounded-xl p-5 shadow-md border border-gray-100"
                                >
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-gray-500 text-sm font-medium">Pending Orders</p>
                                            <h3 className="text-2xl font-bold text-gray-800 mt-1">
                                                {pendingOrders}
                                            </h3>
                                        </div>
                                        <div className="p-3 bg-orange-100 rounded-lg">
                                            <Clock className="h-6 w-6 text-orange-600" />
                                        </div>
                                    </div>
                                </motion.div>

                                {/* Delivered Orders Card */}
                                <motion.div
                                    variants={cardVariants}
                                    className="bg-white rounded-xl p-5 shadow-md border border-gray-100"
                                >
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-gray-500 text-sm font-medium">Delivered Orders</p>
                                            <h3 className="text-2xl font-bold text-gray-800 mt-1">
                                                {deliveredOrders}
                                            </h3>
                                        </div>
                                        <div className="p-3 bg-green-100 rounded-lg">
                                            <CheckCircle className="h-6 w-6 text-green-600" />
                                        </div>
                                    </div>
                                </motion.div>

                                {/* Total Spent Card */}
                                <motion.div
                                    variants={cardVariants}
                                    className="bg-white rounded-xl p-5 shadow-md border border-gray-100"
                                >
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-gray-500 text-sm font-medium">Total Amount Spent</p>
                                            <h3 className="text-2xl font-bold text-gray-800 mt-1">
                                                {formatCurrency(totalAmoutSpent)}
                                            </h3>
                                        </div>
                                        <div className="p-3 bg-purple-100 rounded-lg">
                                            <CreditCard className="h-6 w-6 text-purple-600" />
                                        </div>
                                    </div>
                                </motion.div>
                            </motion.div>

                            {/* Recent Orders Section */}
                            <motion.div
                                className="bg-white rounded-xl shadow-md border border-gray-100 overflow-hidden"
                                variants={itemVariants}
                            >
                                <div className="p-5 border-b border-gray-200 flex justify-between items-center">
                                    <h2 className="text-xl font-semibold text-gray-800">Recent Orders</h2>
                                    <Link to={'/user-dashboard/orders'}>
                                        <button className="text-blue-600 hover:text-blue-800 font-medium flex items-center">
                                            View All Orders <ArrowRight className="ml-1 h-4 w-4" />
                                        </button>
                                    </Link>
                                </div>

                                <div className="divide-y divide-gray-100">
                                    {recentOrders.length === 0 ? (<p className='p-4'>No orders to show yet.</p>) : recentOrders.map((order) => (
                                        <motion.div
                                            key={order._id}
                                            className="p-5 hover:bg-gray-50 transition-colors duration-200"
                                            whileHover={{ x: 5 }}
                                            transition={{ type: "spring", stiffness: 300 }}
                                        >
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center space-x-4">
                                                    <img
                                                        src={order.orderItems[0].image}
                                                        alt={order.orderItems[0].name}
                                                        className="w-16 h-16 object-cover rounded-lg"
                                                    />
                                                    <div>
                                                        <h3 className="font-medium text-gray-900">{order.orderItems[0].name}</h3>
                                                        <p className="text-sm text-gray-500">Order ID: {order.orderId}</p>
                                                        <p className="text-sm text-gray-500">{formatDate(order.createdAt)}</p>
                                                    </div>
                                                </div>

                                                <div className="text-right">
                                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.orderStatus)}`}>
                                                        {order.orderStatus.charAt(0).toUpperCase() + order.orderStatus.slice(1)}
                                                    </span>
                                                    <p className="text-lg font-semibold text-gray-900 mt-1">
                                                        {(() => {
                                                            // Recalculate total using actual shipping cost
                                                            const subtotal = order.orderSummary.subtotal || 0;
                                                            const tax = order.orderSummary.tax || 0;
                                                            let actualShipping = order.orderSummary.shippingCost || 0;
                                                            if (order.sellerShipping && order.sellerShipping.length > 0) {
                                                                actualShipping = order.sellerShipping.reduce((sum, sellerShip) => 
                                                                    sum + (sellerShip.shippingMethod.price || 0), 0
                                                                );
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
                }


            </motion.div>
        </div>
    );
};

export default AccountOverview;