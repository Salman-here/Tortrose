import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Package,
    Clock,
    CheckCircle,
    Truck,
    XCircle,
    CreditCard,
    MapPin,
    Calendar,
    ArrowLeft,
    Eye,
    Search,
    Filter
} from 'lucide-react';
import axios from 'axios';
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

// Status configuration
const statusConfig = {
    pending: { color: 'bg-orange-100 text-orange-800', icon: Clock },
    confirmed: { color: 'bg-blue-100 text-blue-800', icon: CheckCircle },
    processing: { color: 'bg-yellow-100 text-yellow-800', icon: Package },
    shipped: { color: 'bg-purple-100 text-purple-800', icon: Truck },
    delivered: { color: 'bg-green-100 text-green-800', icon: CheckCircle },
    cancelled: { color: 'bg-red-100 text-red-800', icon: XCircle }
};


const UserOrdersManagement = () => {
    const [orders, setOrders] = useState([]);
    const [selectedOrder, setSelectedOrder] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [paymentFilter, setPaymentFilter] = useState('all');
    const [loading, setLoading] = useState(true)

    const serializeFilters = () => {
        let params = new URLSearchParams()
        if (searchTerm !== '' && searchTerm !== 'all') params.append('search', searchTerm)
        if (statusFilter !== 'all') params.append('status', statusFilter)
        if (paymentFilter !== 'all') params.append('paymentStatus', paymentFilter)
        return params.toString()
    }

    const fetchOrders = async () => {

        const token = localStorage.getItem('jwtToken')
        setLoading(true)
        try {
            const query = serializeFilters()
            console.log(query);

            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/user-orders?${query}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            console.log(res.data);
            setOrders(res.data?.orders.reverse())
        } catch (error) {
            console.error(error);
        }
        finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        fetchOrders()
    }, [searchTerm, statusFilter, paymentFilter])


    // Format date function
    const formatDate = (dateString) => {
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return new Date(dateString).toLocaleDateString(undefined, options);
    };

    // Format currency
    const formatCurrency = (amount) => {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD',
        }).format(amount);
    };

    // Get status badge
    const StatusBadge = ({ status }) => {
        const { color, icon: Icon } = statusConfig[status] || statusConfig.pending;
        return (
            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
                <Icon className="h-3 w-3 mr-1" />
                {status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
        );
    };

    // Order List View
    return (
        <motion.div
            className="max-w-6xl p-8"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
        >
            {/* Header */}
            <motion.div
                className="flex flex-col md:flex-row md:items-center justify-between mb-8"
                variants={itemVariants}
            >
                <div>
                    <h1 className="text-2xl md:text-3xl font-bold text-gray-800">
                        Order History
                    </h1>
                    <p className="text-gray-600">View and manage your orders</p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 mt-4 md:mt-0">
                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search orders..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                    </div>

                    <div className='flex items-center gap-2'>
                        {/* Filter */}
                        <Filter className="h-4 w-4 text-gray-400" />
                        <div className="relative">
                            <select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                className="pl-10 pr-8 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 "
                            >
                                <option value="all">All Statuses</option>
                                {Object.keys(statusConfig).map(status => (
                                    <option key={status} value={status}>
                                        {status.charAt(0).toUpperCase() + status.slice(1)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* PAYMENT STATUS FILTER */}
                    <div className='flex items-center gap-2'>
                        {/* Filter */}
                        <Filter className="h-4 w-4 text-gray-400" />
                        <div className="relative">
                            <select
                                value={paymentFilter}
                                onChange={(e) => setPaymentFilter(e.target.value)}
                                className="pl-10 pr-8 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 "
                            >
                                <option value="all">All</option>
                                <option value="paid">Paid</option>
                                <option value="unpaid">UnPaid</option>
                            </select>
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Orders List */}
            <motion.div variants={containerVariants}>
                {
                    loading ? (
                        <div className='w-full h-[250px] flex justify-center items-center'>
                            <Loader />
                        </div>
                    )
                        : (
                            <>
                                {orders.length > 0 ? (
                                    orders.map((order) => (
                                        <motion.div
                                            key={order._id}
                                            variants={cardVariants}
                                            whileHover={{ y: -2 }}
                                            className="bg-white rounded-xl p-5 shadow-md border border-gray-100 mb-4 cursor-pointer"
                                            onClick={() => setSelectedOrder(order)}
                                        >
                                            <div className="flex flex-col md:flex-row md:items-center justify-between">
                                                <div className="flex items-center space-x-4">
                                                    <div className="flex-shrink-0">
                                                        <img
                                                            src={order.orderItems[0].image}
                                                            alt={order.orderItems[0].name}
                                                            className="w-16 h-16 object-cover rounded-lg"
                                                        />
                                                    </div>
                                                    <div>
                                                        <h3 className="font-medium text-gray-900">{order.orderItems[0].name}
                                                            {order.orderItems.length > 1 && ` + ${order.orderItems.length - 1} more`}
                                                        </h3>
                                                        <p className="text-sm text-gray-500">Order ID: {order.orderId}</p>
                                                        <p className="text-sm text-gray-500">
                                                            <Calendar className="h-3 w-3 inline mr-1" />
                                                            {formatDate(order.createdAt)}
                                                        </p>
                                                    </div>
                                                </div>

                                                <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-4 md:mt-0">
                                                    <StatusBadge status={order.orderStatus} />
                                                    <div className="text-right">
                                                        <p className="text-lg font-semibold text-gray-900">
                                                            {formatCurrency(order.orderSummary.totalAmount || order.orderSummary.subtotal || 0)}
                                                        </p>
                                                        <Link to={`/user-dashboard/order/detail/${order._id}`}>
                                                        <button className="text-blue-600 hover:text-blue-800 text-sm font-medium flex items-center mt-1">
                                                            View Details <Eye className="h-4 w-4 ml-1" />
                                                        </button>
                                                        </Link>
                                                    </div>
                                                </div>
                                            </div>
                                        </motion.div>
                                    ))
                                ) : (
                                    <motion.div
                                        variants={itemVariants}
                                        className="bg-white rounded-xl p-8 text-center shadow-md border border-gray-100"
                                    >
                                        <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                                        <h3 className="text-lg font-medium text-gray-900 mb-2">No orders found</h3>
                                        <p className="text-gray-500">Try adjusting your search or filter criteria</p>
                                    </motion.div>
                                )}
                            </>
                        )
                }

            </motion.div>
            
        </motion.div>

    )


    

    // return (
    //     <div className="min-h-screen bg-gray-50 p-4 md:p-6">
    //         <AnimatePresence mode="wait">
    //             {selectedOrder ? <OrderDetailView key="detail" /> : <OrderListView key="list" />}
    //         </AnimatePresence>
    //     </div>
    // );
};

export default UserOrdersManagement;