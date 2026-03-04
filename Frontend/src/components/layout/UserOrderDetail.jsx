import { useEffect, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "react-toastify";
import { ArrowLeft, Package, XCircle, Clock, RefreshCw, Truck, CheckCircle, CreditCard } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useCurrency } from "../../contexts/CurrencyContext";
import Loader from "../common/Loader";

const OrderDetail = () => {
    const { formatPrice } = useCurrency();
    const [order, setOrder] = useState(null);
    const { id } = useParams();
    const [isUpdating, setIsUpdating] = useState(false);
    const [newStatus, setNewStatus] = useState(null);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);

    const getStatusIcon = (status) => {
        const icons = { pending: <Clock className="w-4 h-4" />, confirmed: <CheckCircle className="w-4 h-4" />, processing: <RefreshCw className="w-4 h-4" />, shipped: <Truck className="w-4 h-4" />, delivered: <CheckCircle className="w-4 h-4" />, cancelled: <XCircle className="w-4 h-4" /> };
        return icons[status] || <Package className="w-4 h-4" />;
    };

    const getStatusStyle = (status) => {
        const styles = {
            pending: { bg: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 50%)' },
            confirmed: { bg: 'rgba(14, 165, 233, 0.12)', color: 'hsl(200, 80%, 50%)' },
            processing: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' },
            shipped: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(260, 60%, 55%)' },
            delivered: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' },
            cancelled: { bg: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }
        };
        return styles[status] || { bg: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))' };
    };

    const fetchOrderDetail = async () => {
        const token = localStorage.getItem("jwtToken");
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/detail/${id}`, { headers: { Authorization: `Bearer ${token}` } });
            setOrder(res.data.order);
        } catch (error) { toast.error(error.response?.data?.msg || "Server error while fetching order detail"); }
    };

    useEffect(() => { fetchOrderDetail(); }, []);

    const handleStatusUpdate = async () => {
        try {
            const token = localStorage.getItem("jwtToken");
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/order/update-status/${order?._id}`, { newStatus }, { headers: { Authorization: `Bearer ${token}` } });
            toast.success(res.data.msg || "Updated status successfully.");
            fetchOrderDetail();
        } catch (error) { toast.error(error.response?.msg || "Server error while updating status"); }
        setIsUpdating(false);
    };

    const handleCancelOrder = async () => {
        try {
            const token = localStorage.getItem("jwtToken");
            await axios.patch(`${import.meta.env.VITE_API_URL}api/order/cancel/${id}`, {}, { headers: { Authorization: `Bearer ${token}` } });
            fetchOrderDetail();
        } catch (error) { toast.error(error.response?.msg || "Server error while cancelling order"); }
        finally { setShowCancelConfirm(false); }
    };

    if (!order) return <div className="min-h-screen flex justify-center items-center"><Loader /></div>;

    const ss = getStatusStyle(order?.orderStatus);

    return (
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="max-w-full p-4 sm:p-6">
            {/* Header */}
            <div className="glass-panel p-4 sm:p-6 mb-4">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
                        <Link to="/user-dashboard/orders">
                            <button className="glass-button p-2 rounded-xl shrink-0"><ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" /></button>
                        </Link>
                        <div className="min-w-0 flex-1">
                            <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight truncate" style={{ color: 'hsl(var(--foreground))' }}>Order {order?.orderId}</h1>
                            <p className="text-xs sm:text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Placed on {new Date(order?.createdAt).toLocaleDateString()}</p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <span className="px-2.5 py-1 text-xs rounded-full flex items-center gap-1 font-medium" style={{ background: ss.bg, color: ss.color }}>
                            {getStatusIcon(order?.orderStatus)}
                            <span className="hidden sm:inline">{order?.orderStatus?.charAt(0).toUpperCase() + order?.orderStatus.slice(1)}</span>
                        </span>
                        <span className="px-2.5 py-1 text-xs rounded-full font-medium" style={order?.isPaid ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' } : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                            {order?.isPaid ? "Paid" : "Unpaid"}
                        </span>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Customer Information */}
                <div className="lg:col-span-1 space-y-4">
                    <div className="glass-panel p-4 sm:p-5">
                        <h2 className="text-base sm:text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Customer Information</h2>
                        <div className="space-y-3">
                            {[
                                { label: 'Name', value: order?.shippingInfo.fullName },
                                { label: 'Email', value: order?.shippingInfo.email },
                                { label: 'Phone', value: order?.shippingInfo.phone },
                            ].map((item, i) => (
                                <div key={i}>
                                    <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.label}</p>
                                    <p className="text-sm font-medium break-words" style={{ color: 'hsl(var(--foreground))' }}>{item.value}</p>
                                </div>
                            ))}
                            <div>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Address</p>
                                <p className="text-sm font-medium break-words" style={{ color: 'hsl(var(--foreground))' }}>
                                    {order?.shippingInfo.address}<br />
                                    {order?.shippingInfo.city}, {order?.shippingInfo.state} {order?.shippingInfo.postalCode}<br />
                                    {order?.shippingInfo.country}
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Order Summary */}
                    <div className="glass-panel p-4 sm:p-5">
                        <h2 className="text-base sm:text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Order Summary</h2>
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal</span>
                                <span style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(order?.orderSummary.subtotal)}</span>
                            </div>
                            {(() => {
                                let actualShippingCost = order?.orderSummary.shippingCost || 0;
                                if (order?.sellerShipping && order.sellerShipping.length > 0) {
                                    actualShippingCost = order.sellerShipping.reduce((sum, s) => sum + (s.shippingMethod.price || 0), 0);
                                }
                                return actualShippingCost >= 0 || order?.sellerShipping?.length > 0 ? (
                                    <div className="space-y-1">
                                        <div className="flex justify-between">
                                            <span className="font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping</span>
                                            <span style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(actualShippingCost)}</span>
                                        </div>
                                        {order?.sellerShipping && order.sellerShipping.length > 0 && (
                                            <div className="pl-4 space-y-1">
                                                {order.sellerShipping.map((s, i) => (
                                                    <div key={i} className="flex justify-between text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        <span className="capitalize">{s.shippingMethod.name} ({s.shippingMethod.estimatedDays} days)</span>
                                                        <span>{formatPrice(s.shippingMethod.price)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ) : null;
                            })()}
                            {order?.orderSummary.tax > 0 && (
                                <div className="flex justify-between">
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Tax</span>
                                    <span style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(order?.orderSummary.tax)}</span>
                                </div>
                            )}
                            <div className="flex justify-between pt-2" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                <span className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Total</span>
                                <span className="text-base font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {(() => {
                                        const subtotal = order?.orderSummary.subtotal || 0;
                                        const tax = order?.orderSummary.tax || 0;
                                        let actualShipping = order?.orderSummary.shippingCost || 0;
                                        if (order?.sellerShipping && order.sellerShipping.length > 0) {
                                            actualShipping = order.sellerShipping.reduce((sum, s) => sum + (s.shippingMethod.price || 0), 0);
                                        }
                                        return formatPrice(subtotal + tax + actualShipping);
                                    })()}
                                </span>
                            </div>
                        </div>

                        {order?.orderStatus !== 'cancelled' && order?.orderStatus !== 'delivered' && (
                            <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.97 }}
                                    onClick={() => setShowCancelConfirm(true)}
                                    className="w-full px-4 py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2 text-sm"
                                    style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'hsl(0, 72%, 55%)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                    <XCircle className="w-4 h-4" /> Cancel Order
                                </motion.button>
                            </div>
                        )}
                    </div>

                    {/* Payment */}
                    <div className="glass-panel p-4 sm:p-5">
                        <h2 className="text-base sm:text-lg font-semibold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <CreditCard className="w-4 h-4" style={{ color: 'hsl(var(--primary))' }} /> Payment Details
                        </h2>
                        <div className="space-y-3 text-sm">
                            <div className="flex justify-between"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Method:</span><span className="capitalize font-medium" style={{ color: 'hsl(var(--foreground))' }}>{order.paymentMethod}</span></div>
                            <div className="flex justify-between items-center">
                                <span style={{ color: 'hsl(var(--muted-foreground))' }}>Status:</span>
                                {order.isPaid
                                    ? <span className="flex items-center gap-1 font-semibold" style={{ color: 'hsl(150, 60%, 40%)' }}><CheckCircle className="w-4 h-4" /> Paid</span>
                                    : <span className="flex items-center gap-1 font-semibold" style={{ color: 'hsl(30, 90%, 50%)' }}><Clock className="w-4 h-4" /> Pending</span>
                                }
                            </div>
                            {order.paymentResult?.paymentIntentId && (
                                <div className="flex flex-col gap-1">
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Payment Intent ID:</span>
                                    <span className="text-xs break-all" style={{ color: 'hsl(var(--foreground))' }}>{order.paymentResult.paymentIntentId}</span>
                                </div>
                            )}
                            {order.paymentResult?.emailAddress && (
                                <div className="flex justify-between"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Paid By:</span><span style={{ color: 'hsl(var(--foreground))' }}>{order.paymentResult.emailAddress}</span></div>
                            )}
                            <div className="flex justify-between"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Created:</span><span style={{ color: 'hsl(var(--foreground))' }}>{new Date(order.createdAt).toLocaleDateString()}</span></div>
                        </div>
                    </div>
                </div>

                {/* Order Items */}
                <div className="lg:col-span-2">
                    <div className="glass-panel overflow-hidden">
                        <div className="p-4 sm:p-5" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                            <h2 className="text-base sm:text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Order Items</h2>
                        </div>
                        <div>
                            {order?.orderItems.map((item, index) => (
                                <motion.div key={index} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: index * 0.1 }}
                                    className="p-4 sm:p-5 flex items-start gap-3 sm:gap-4" style={{ borderBottom: index < order.orderItems.length - 1 ? '1px solid var(--glass-border-subtle)' : 'none' }}>
                                    <div className="shrink-0 h-14 w-14 sm:h-16 sm:w-16 glass-inner rounded-xl overflow-hidden flex items-center justify-center">
                                        {item.image ? <img src={item.image} alt={item.name} className="h-full w-full object-cover" /> : <Package className="h-6 w-6" style={{ color: 'hsl(var(--muted-foreground))' }} />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-sm sm:text-base font-semibold break-words" style={{ color: 'hsl(var(--foreground))' }}>{item.name}</h3>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Quantity: {item.quantity}</p>
                                        <div className="mt-2 sm:hidden">
                                            <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(item.price)}</p>
                                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal: {formatPrice(item.price * item.quantity)}</p>
                                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal: {formatPrice(item.price * item.quantity)}</p>
                                        </div>
                                    </div>
                                    <div className="text-right hidden sm:block shrink-0">
                                        <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(item.price)}</p>
                                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal: {formatPrice(item.price * item.quantity)}</p>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal: {formatPrice(item.price * item.quantity)}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Cancel Confirmation Modal */}
            <AnimatePresence>
                {showCancelConfirm && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={() => setShowCancelConfirm(false)}>
                        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                            className="glass-panel p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-lg font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Cancel Order</h3>
                            <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>Are you sure you want to cancel this order? This action cannot be undone.</p>
                            <div className="flex justify-end gap-3">
                                <motion.button whileTap={{ scale: 0.97 }} onClick={() => setShowCancelConfirm(false)}
                                    className="px-4 py-2 rounded-xl font-semibold text-sm glass-button">Keep Order</motion.button>
                                <motion.button whileTap={{ scale: 0.97 }} onClick={handleCancelOrder}
                                    className="px-4 py-2 rounded-xl font-semibold text-sm text-white"
                                    style={{ background: 'linear-gradient(135deg, hsl(0, 72%, 55%), hsl(0, 60%, 45%))', boxShadow: '0 0 15px -4px hsl(0, 72%, 55%, 0.3)' }}>
                                    Cancel Order
                                </motion.button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};
export default OrderDetail;
