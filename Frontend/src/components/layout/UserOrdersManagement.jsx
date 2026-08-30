import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Package, Clock, CheckCircle, Truck, XCircle, CreditCard, Calendar, Eye, Search, Filter } from 'lucide-react';
import axios from 'axios';
import Loader from '../common/Loader';
import { Link } from 'react-router-dom';
import { useCurrency } from '../../contexts/CurrencyContext';
import { getAuthToken } from "../../utils/cookieHelper";
import { formatOrderItemOptions, getOrderCurrency, getOrderTotal } from "../../utils/orderItems";
import { BuyerSellerStatusChips } from '../order/BuyerSellerFulfillmentGroups';

const containerVariants = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.08 } } };
const itemVariants = { hidden: { y: 20, opacity: 0 }, visible: { y: 0, opacity: 1, transition: { type: "spring", stiffness: 100 } } };
const cardVariants = { hidden: { scale: 0.95, opacity: 0 }, visible: { scale: 1, opacity: 1, transition: { type: "spring", stiffness: 100 } } };

const statusConfig = {
    pending: { color: 'hsl(30, 90%, 50%)', bg: 'rgba(249, 115, 22, 0.12)', icon: Clock },
    confirmed: { color: 'hsl(220, 70%, 55%)', bg: 'rgba(99, 102, 241, 0.12)', icon: CheckCircle },
    processing: { color: 'hsl(45, 93%, 47%)', bg: 'rgba(234, 179, 8, 0.12)', icon: Package },
    shipped: { color: 'hsl(200, 80%, 50%)', bg: 'rgba(14, 165, 233, 0.12)', icon: Truck },
    delivered: { color: 'hsl(150, 60%, 40%)', bg: 'rgba(16, 185, 129, 0.12)', icon: CheckCircle },
    cancelled: { color: 'hsl(0, 72%, 55%)', bg: 'rgba(239, 68, 68, 0.12)', icon: XCircle }
};

const UserOrdersManagement = () => {
    const { formatPrice } = useCurrency();
    const [orders, setOrders] = useState([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [paymentFilter, setPaymentFilter] = useState('all');
    const [loading, setLoading] = useState(true);

    const serializeFilters = useCallback(() => {
        let params = new URLSearchParams();
        if (searchTerm !== '' && searchTerm !== 'all') params.append('search', searchTerm);
        if (statusFilter !== 'all') params.append('status', statusFilter);
        if (paymentFilter !== 'all') params.append('paymentStatus', paymentFilter);
        return params.toString();
    }, [searchTerm, statusFilter, paymentFilter]);

    const fetchOrders = useCallback(async () => {
        const token = getAuthToken();
        setLoading(true);
        try {
            const query = serializeFilters();
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/user-orders?${query}`, { headers: { Authorization: `Bearer ${token}` } });
            setOrders(res.data?.orders.reverse());
        } catch (error) { console.error(error); }
        finally { setLoading(false); }
    }, [serializeFilters]);

    useEffect(() => { fetchOrders(); }, [fetchOrders]);

    const formatDate = (dateString) => new Date(dateString).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

    const StatusBadge = ({ status }) => {
        const config = statusConfig[status] || statusConfig.pending;
        const Icon = config.icon;
        return (
            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: config.bg, color: config.color, border: `1px solid ${config.color}22` }}>
                <Icon className="h-3 w-3 mr-1" />{status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
        );
    };

    return (
        <motion.div className="max-w-6xl p-4 sm:p-6 md:p-8" variants={containerVariants} initial="hidden" animate="visible">
            <motion.div className="flex flex-col md:flex-row md:items-center justify-between mb-8" variants={itemVariants}>
                <div>
                    <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Order History</h1>
                    <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>View and manage your orders</p>
                </div>
                <div className="flex flex-col gap-3 mt-4 md:mt-0">
                    <div className="search-input-wrapper">
                        <div className="search-input-icon"><Search size={16} /></div>
                        <input type="text" placeholder="Search orders..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="glass-input glass-input-search" />
                    </div>
                    <div className='flex flex-col sm:flex-row gap-2'>
                        <div className='flex items-center gap-2 flex-1'>
                            <Filter className="h-4 w-4 flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} />
                            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="glass-input cursor-pointer font-medium flex-1">
                                <option value="all">All Statuses</option>
                                {Object.keys(statusConfig).map(status => (<option key={status} value={status}>{status.charAt(0).toUpperCase() + status.slice(1)}</option>))}
                            </select>
                        </div>
                        <div className='flex items-center gap-2 flex-1'>
                            <Filter className="h-4 w-4 flex-shrink-0" style={{ color: 'hsl(var(--muted-foreground))' }} />
                            <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} className="glass-input cursor-pointer font-medium flex-1">
                                <option value="all">All Payments</option>
                                <option value="paid">Paid</option>
                                <option value="unpaid">Unpaid</option>
                            </select>
                        </div>
                    </div>
                </div>
            </motion.div>

            <motion.div variants={containerVariants}>
                {loading ? (
                    <div className='w-full h-[250px] flex justify-center items-center'><Loader /></div>
                ) : orders.length > 0 ? (
                    orders.map((order) => (
                        <motion.div key={order._id} variants={cardVariants} whileHover={{ y: -2 }} className="glass-card p-5 mb-4 cursor-pointer">
                            <div className="flex flex-col md:flex-row md:items-center justify-between">
                                <div className="flex items-center space-x-4">
                                    <img src={order.orderItems[0].image} alt={order.orderItems[0].name} className="w-16 h-16 object-cover rounded-xl" style={{ border: '1px solid var(--glass-border)' }} />
                                    <div>
                                        <h3 className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                                            {order.orderItems[0].name}{order.orderItems.length > 1 && ` + ${order.orderItems.length - 1} more`}
                                        </h3>
                                        {formatOrderItemOptions(order.orderItems[0]) && (
                                            <p className="text-xs leading-snug" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {formatOrderItemOptions(order.orderItems[0])}
                                            </p>
                                        )}
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Order ID: {order.orderId}</p>
                                        <p className="text-xs flex items-center gap-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            <Calendar className="h-3 w-3" />{formatDate(order.createdAt)}
                                        </p>
                                        <BuyerSellerStatusChips order={order} />
                                    </div>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-4 md:mt-0">
                                    <StatusBadge status={order.orderStatus} />
                                    <div className="text-left sm:text-right">
                                        <p className="text-base font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                            {(() => {
                                                const orderCurrency = getOrderCurrency(order);
                                                return formatPrice(getOrderTotal(order), {
                                                    sourceCurrency: orderCurrency,
                                                    targetCurrency: orderCurrency,
                                                    showCode: true,
                                                });
                                            })()}
                                        </p>
                                        <Link to={`/user-dashboard/order/detail/${order._id}`}>
                                            <button className="text-sm font-medium flex items-center mt-1" style={{ color: 'hsl(var(--primary))' }}>
                                                View Details <Eye className="h-4 w-4 ml-1" />
                                            </button>
                                        </Link>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    ))
                ) : (
                    <motion.div variants={itemVariants} className="glass-panel p-8 text-center">
                        <div className="glass-inner p-4 rounded-2xl inline-block mb-4"><Package className="h-10 w-10" style={{ color: 'hsl(var(--muted-foreground))' }} /></div>
                        <h3 className="text-base font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>No orders found</h3>
                        <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Try adjusting your search or filter criteria</p>
                    </motion.div>
                )}
            </motion.div>
        </motion.div>
    );
};

export default UserOrdersManagement;
