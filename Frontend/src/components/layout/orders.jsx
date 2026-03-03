import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Search, Filter, Edit, MoreHorizontal,
    Truck, CheckCircle, XCircle, Clock,
    Package, ArrowLeft, RefreshCw, X,
    SeparatorVertical,

} from 'lucide-react';
import axios from 'axios';
import { toast } from 'react-toastify'
import { Link } from 'react-router-dom';
import Loader from '../common/Loader';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const OrderManagement = () => {
    const { currentUser } = useAuth();
    const { formatPrice } = useCurrency();

    const fetchOrders = async () => {

        const token = localStorage.getItem('jwtToken')
        setLoading(true)
        try {
            const query = serializeFilters()
            console.log(query);

            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/get?${query}`,
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            )
            console.log(res.data);
            setOrders(res.data?.orders)
        } catch (error) {
            console.error(error);
        }
        finally {
            setLoading(false)
        }
    }


    const serializeFilters = () => {
        let params = new URLSearchParams()
        if (searchTerm) params.append('search', searchTerm)
        if (paymentFilter !== 'all') params.append('paymentStatus', paymentFilter)
        if (statusFilter !== 'all') params.append('status', statusFilter)
        if (dateRange.start !== '' && dateRange.end !== '') {
            params.append('startDate', dateRange.start)
            params.append('endDate', dateRange.end)
        }

        return params.toString()
    }



    const [orders, setOrders] = useState([]);
    const [selectedOrder, setSelectedOrder] = useState(null);
    // const [filteredOrders, setFilteredOrders] = useState(orders);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [paymentFilter, setPaymentFilter] = useState('all');
    const [dateRange, setDateRange] = useState({ start: '', end: '' });
    const [loading, setLoading] = useState(true)

    // useEffect(()=>{
    //     const {}
    // },[selectedOrder])

    useEffect(() => {
        fetchOrders()
    }, [searchTerm, statusFilter, paymentFilter, dateRange]);

    const getStatusIcon = (status) => {
        switch (status) {
            case 'pending': return <Clock className="w-4 h-4" />;
            case 'processing': return <RefreshCw className="w-4 h-4" />;
            case 'shipped': return <Truck className="w-4 h-4" />;
            case 'delivered': return <CheckCircle className="w-4 h-4" />;
            case 'cancelled': return <XCircle className="w-4 h-4" />;
            default: return <Package className="w-4 h-4" />;
        }
    };

    const getStatusColor = (status) => {
        switch (status) {
            case 'pending': return 'bg-yellow-100 text-yellow-800';
            case 'processing': return 'bg-blue-100 text-blue-800';
            case 'shipped': return 'bg-indigo-100 text-indigo-800';
            case 'delivered': return 'bg-green-100 text-green-800';
            case 'cancelled': return 'bg-red-100 text-red-800';
            default: return 'bg-gray-100 text-gray-800';
        }
    };


    return (
        <div className="min-h-screen bg-gray-50 p-3 sm:p-4 lg:p-6">
            <OrderList
                orders={orders}
                onSelectOrder={setSelectedOrder}
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                paymentFilter={paymentFilter}
                onPaymentFilterChange={setPaymentFilter}
                dateRange={dateRange}
                onDateRangeChange={setDateRange}
                getStatusIcon={getStatusIcon}
                getStatusColor={getStatusColor}
                loading={loading}
                currentUser={currentUser}
                formatPrice={formatPrice}
            />
            {/* {selectedOrder ? (
                <OrderDetail
                    order={selectedOrder}
                    onBack={() => setSelectedOrder(null)}
                    onCancelOrder={cancelOrder}
                    getStatusIcon={getStatusIcon}
                    getStatusColor={getStatusColor}
                />
            ) : (
            )} */}
        </div>
    );
};

const OrderList = ({
    orders,
    onSelectOrder,
    searchTerm,
    onSearchChange,
    statusFilter,
    onStatusFilterChange,
    paymentFilter,
    onPaymentFilterChange,
    dateRange,
    onDateRangeChange,
    getStatusIcon,
    getStatusColor,
    loading,
    currentUser,
    formatPrice
}) => {
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full bg-white rounded-lg shadow"
        >
            {/* Header */}
            <div className="p-4 sm:p-6 border-b border-gray-200">
                <h1 className="text-xl sm:text-2xl font-bold text-gray-800">Order Management</h1>
                <p className="text-sm sm:text-base text-gray-600 mt-1">View and manage all customer orders</p>
            </div>

            {/* Filters */}
            <div className="p-4 sm:p-6 border-b border-gray-200 bg-gray-50">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                    {/* Search */}
                    <div className="relative sm:col-span-2 lg:col-span-1">
                        <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                        <input
                            type="text"
                            placeholder="Search by ID or name"
                            value={searchTerm}
                            onChange={(e) => onSearchChange(e.target.value)}
                            className="pr-9 py-2 px-3 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        />
                    </div>

                    {/* Status Filter */}
                    <div>
                        <select
                            value={statusFilter}
                            onChange={(e) => onStatusFilterChange(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        >
                            <option value="all">All Statuses</option>
                            <option value="pending">Pending</option>
                            <option value="processing">Processing</option>
                            <option value="shipped">Shipped</option>
                            <option value="delivered">Delivered</option>
                            <option value="cancelled">Cancelled</option>
                        </select>
                    </div>

                    {/* Payment Filter */}
                    <div>
                        <select
                            value={paymentFilter}
                            onChange={(e) => onPaymentFilterChange(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                        >
                            <option value="all">All Payments</option>
                            <option value="paid">Paid</option>
                            <option value="unpaid">Unpaid</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Orders Table */}
            <div className={`${loading && 'h-[280px] flex justify-center items-center'} overflow-x-auto`}>
                {
                    loading ? <Loader /> :
                        orders.length === 0 ? (
                            <div className="text-center py-12 text-gray-500">
                                <Package className="mx-auto h-12 w-12" />
                                <p className="mt-4">No orders found matching your criteria</p>
                            </div>
                        )
                    :
                (
                <table className="w-full divide-y divide-gray-200 hidden md:table">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Order ID
                            </th>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Customer
                            </th>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Date
                            </th>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Payment
                            </th>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Status
                            </th>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Total
                            </th>
                            <th className="px-2 lg:px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Actions
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        <AnimatePresence>
                            {orders.reverse().map((order) => (
                                <motion.tr
                                    key={order._id}
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -10 }}
                                    transition={{ duration: 0.2 }}
                                    className="hover:bg-gray-50"
                                >
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                                        <div className="flex flex-col gap-1">
                                            <span className="text-xs lg:text-sm">{order.orderId}</span>
                                            {order.spinDiscount?.applied && (
                                                <span className="inline-flex items-center gap-1 px-1 py-0.5 bg-linear-to-r from-indigo-100 to-sky-100 text-indigo-700 text-[8px] font-semibold rounded-full border border-indigo-200 w-fit">
                                                    🎉
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap text-xs lg:text-sm text-gray-500">
                                        <span className="max-w-[100px] lg:max-w-[150px] truncate block">{order.shippingInfo.fullName}</span>
                                    </td>
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap text-xs lg:text-sm text-gray-500">
                                        <span className="hidden lg:inline">{new Date(order.createdAt).toLocaleDateString()}</span>
                                        <span className="lg:hidden">{new Date(order.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                                    </td>
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap">
                                        <span
                                            className={`px-1.5 lg:px-2 py-0.5 lg:py-1 text-[9px] lg:text-xs rounded-full ${order.isPaid
                                                ? "bg-green-100 text-green-800"
                                                : "bg-red-100 text-red-800"
                                                }`}
                                        >
                                            {order.isPaid ? "Paid" : "Unpaid"}
                                        </span>
                                    </td>
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap">
                                        <span
                                            className={`px-1.5 lg:px-2 py-0.5 lg:py-1 text-[9px] lg:text-xs rounded-full flex items-center space-x-1 w-fit ${getStatusColor(
                                                order.orderStatus
                                            )}`}
                                        >
                                            {getStatusIcon(order.orderStatus)}
                                            <span className="hidden xl:inline">
                                                {order.orderStatus.charAt(0).toUpperCase() +
                                                    order.orderStatus.slice(1)}
                                            </span>
                                        </span>
                                    </td>
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap text-xs lg:text-sm text-gray-500">
                                        {(() => {
                                            // For sellers, backend already filtered the order summary
                                            // For admin, recalculate using actual shipping cost
                                            if (currentUser?.role === 'seller') {
                                                // Use the already-filtered values from backend
                                                return formatPrice(order.orderSummary.totalAmount || order.orderSummary.subtotal || 0);
                                            }
                                            
                                            // Admin: recalculate total using actual shipping cost
                                            const subtotal = order.orderSummary.subtotal || 0;
                                            const tax = order.orderSummary.tax || 0;
                                            let actualShipping = order.orderSummary.shippingCost || 0;
                                            if (order.sellerShipping && order.sellerShipping.length > 0) {
                                                actualShipping = order.sellerShipping.reduce((sum, sellerShip) => 
                                                    sum + (sellerShip.shippingMethod.price || 0), 0
                                                );
                                            }
                                            return formatPrice(subtotal + tax + actualShipping);
                                        })()}
                                    </td>
                                    <td className="px-2 lg:px-4 py-3 whitespace-nowrap text-xs lg:text-sm font-medium">
                                        <Link to={`/${currentUser?.role === 'seller' ? 'seller' : 'admin'}-dashboard/order/${order._id}`}>
                                            <button
                                                className="text-blue-600 hover:text-blue-900 text-xs lg:text-sm"
                                            >
                                                <span className="hidden xl:inline">View Details</span>
                                                <span className="xl:hidden">View</span>
                                            </button>
                                        </Link>
                                    </td>
                                </motion.tr>
                            ))}
                        </AnimatePresence>
                    </tbody>
                </table>
                )
                }

                {/* Mobile Card View */}
                <div className="md:hidden space-y-3 p-3 sm:p-4">
                    {orders.map((order) => (
                        <motion.div
                            key={order._id}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            transition={{ duration: 0.2 }}
                            className="border rounded-lg p-3 sm:p-4 bg-white shadow-sm"
                        >
                            <div className="flex justify-between items-start gap-2">
                                <div className="min-w-0 flex-1">
                                    <h2 className="font-semibold text-sm sm:text-base text-gray-800 truncate">{order.orderId}</h2>
                                    {order.spinDiscount?.applied && (
                                        <span className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 bg-linear-to-r from-indigo-100 to-sky-100 text-indigo-700 text-[9px] sm:text-[10px] font-semibold rounded-full border border-indigo-200">
                                            🎉 Spin Discount
                                        </span>
                                    )}
                                </div>
                                <span
                                    className={`px-2 py-1 text-[10px] sm:text-xs rounded-full whitespace-nowrap flex-shrink-0 ${order.isPaid
                                        ? "bg-green-100 text-green-800"
                                        : "bg-red-100 text-red-800"
                                        }`}
                                >
                                    {order.isPaid ? "Paid" : "Unpaid"}
                                </span>
                            </div>
                            <p className="text-sm sm:text-base text-gray-600 mt-2 truncate">{order.shippingInfo.fullName}</p>
                            <p className="text-xs sm:text-sm text-gray-500 mt-1">
                                {new Date(order.createdAt).toLocaleDateString()}
                            </p>
                            <div className="flex justify-between items-center mt-3 gap-2">
                                <span
                                    className={`px-2 py-1 text-[10px] sm:text-xs rounded-full flex items-center gap-1 ${getStatusColor(
                                        order.orderStatus
                                    )}`}
                                >
                                    {getStatusIcon(order.orderStatus)}
                                    <span>
                                        {order.orderStatus.charAt(0).toUpperCase() +
                                            order.orderStatus.slice(1)}
                                    </span>
                                </span>
                                <span className="text-sm sm:text-base font-semibold text-gray-800">
                                    {(() => {
                                        // For sellers, backend already filtered the order summary
                                        // For admin, recalculate using actual shipping cost
                                        if (currentUser?.role === 'seller') {
                                            // Use the already-filtered values from backend
                                            return formatPrice(order.orderSummary.totalAmount || order.orderSummary.subtotal || 0);
                                        }
                                        
                                        // Admin: recalculate total using actual shipping cost
                                        const subtotal = order.orderSummary.subtotal || 0;
                                        const tax = order.orderSummary.tax || 0;
                                        let actualShipping = order.orderSummary.shippingCost || 0;
                                        if (order.sellerShipping && order.sellerShipping.length > 0) {
                                            actualShipping = order.sellerShipping.reduce((sum, sellerShip) => 
                                                sum + (sellerShip.shippingMethod.price || 0), 0
                                            );
                                        }
                                        return formatPrice(subtotal + tax + actualShipping);
                                    })()}
                                </span>
                            </div>
                            <Link to={`/${currentUser?.role === 'seller' ? 'seller' : 'admin'}-dashboard/order/${order._id}`}>
                                <button
                                    className="mt-3 w-full bg-linear-to-r from-indigo-600 to-sky-500 hover:from-indigo-700 hover:to-sky-600 text-white text-xs sm:text-sm font-medium py-2 rounded-md transition-colors"
                                >
                                    View Details
                                </button>
                            </Link>
                        </motion.div>
                    ))}
                </div>


            </div>
        </motion.div>


    );
};



export default OrderManagement;