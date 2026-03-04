import { useEffect, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "react-toastify";
import { ArrowLeft, Edit, Package, XCircle, Clock, RefreshCw, Truck, CheckCircle } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import Loader from "../common/Loader";
import { useAuth } from "../../contexts/AuthContext";
import { useCurrency } from "../../contexts/CurrencyContext";

const OrderDetail = () => {
    const { currentUser } = useAuth();
    const { formatPrice } = useCurrency();
    const [order, setOrder] = useState(null);
    const [isUpdating, setIsUpdating] = useState(false);
    const [newStatus, setNewStatus] = useState(null);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const { id } = useParams();

    const getStatusIcon = (status) => {
        const icons = { pending: <Clock className="w-4 h-4" />, processing: <RefreshCw className="w-4 h-4" />, shipped: <Truck className="w-4 h-4" />, delivered: <CheckCircle className="w-4 h-4" />, cancelled: <XCircle className="w-4 h-4" /> };
        return icons[status] || <Package className="w-4 h-4" />;
    };

    const getStatusStyle = (status) => {
        const styles = { pending: { bg: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 50%)' }, processing: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }, shipped: { bg: 'rgba(14, 165, 233, 0.12)', color: 'hsl(200, 80%, 50%)' }, delivered: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }, cancelled: { bg: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' } };
        return styles[status] || { bg: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))' };
    };

    const fetchOrderDetail = async () => {
        const token = localStorage.getItem('jwtToken');
        try { const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/detail/${id}`, { headers: { Authorization: `Bearer ${token}` } }); setOrder(res.data.order); }
        catch (error) { toast.error(error.response?.data?.msg || 'Server error'); }
    };
    useEffect(() => { fetchOrderDetail(); }, []);

    const handleStatusUpdate = async () => {
        try { const token = localStorage.getItem('jwtToken'); const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/order/update-status/${order?._id}`, { newStatus }, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data.msg || 'Updated'); fetchOrderDetail(); }
        catch (error) { toast.error(error.response?.msg || 'Error updating status'); }
        setIsUpdating(false);
    };

    const handleCancelOrder = async () => {
        try { const token = localStorage.getItem('jwtToken'); await axios.patch(`${import.meta.env.VITE_API_URL}api/order/cancel/${id}`, {}, { headers: { Authorization: `Bearer ${token}` } }); fetchOrderDetail(); }
        catch (error) { toast.error(error.response?.msg || 'Error cancelling order'); }
        finally { setShowCancelConfirm(false); }
    };

    if (!order) return <div className="flex justify-center items-center min-h-[400px]"><Loader /></div>;

    const ss = getStatusStyle(order?.orderStatus);

    return (
        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="p-4 sm:p-6">
            <div className="glass-panel overflow-hidden">
            {/* Header */}
            <div className="p-4 sm:p-6 mt-2" style={{ borderBottom: '1px solid var(--glass-border)' }}>
                <div className="flex items-start gap-3 sm:gap-4 mb-4">
                    <Link to={`/${currentUser?.role === 'seller' ? 'seller' : 'admin'}-dashboard/order-management`}>
                        <button className="p-2 rounded-xl glass-inner relative z-10"><ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5" style={{ color: 'hsl(var(--foreground))' }} /></button>
                    </Link>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight truncate" style={{ color: 'hsl(var(--foreground))' }}>Order {order?.orderId}</h1>
                        <p className="text-xs sm:text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Placed on {new Date(order?.createdAt).toLocaleDateString()}</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 sm:px-3 py-1 text-xs sm:text-sm rounded-full flex items-center gap-1 font-medium" style={{ background: ss.bg, color: ss.color }}>
                        {getStatusIcon(order?.orderStatus)}
                        <span className="hidden xs:inline">{order?.orderStatus?.charAt(0).toUpperCase() + order?.orderStatus.slice(1)}</span>
                    </span>
                    <span className="px-2 sm:px-3 py-1 text-xs sm:text-sm rounded-full font-medium"
                        style={order?.isPaid ? { background: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' } : { background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                        {order?.isPaid ? 'Paid' : 'Unpaid'}
                    </span>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 p-4 sm:p-6">
                {/* Customer Information */}
                <div className="lg:col-span-1">
                    <div className="glass-inner rounded-xl p-3 sm:p-4">
                        <h2 className="text-base sm:text-lg font-semibold mb-3 sm:mb-4" style={{ color: 'hsl(var(--foreground))' }}>Customer Information</h2>
                        <div className="space-y-2 sm:space-y-3">
                            {[{ label: 'Name', value: order?.shippingInfo.fullName }, { label: 'Email', value: order?.shippingInfo.email }, { label: 'Phone', value: order?.shippingInfo.phone }].map(item => (
                                <div key={item.label}>
                                    <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.label}</p>
                                    <p className="text-sm font-medium break-words" style={{ color: 'hsl(var(--foreground))' }}>{item.value}</p>
                                </div>
                            ))}
                            <div>
                                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Address</p>
                                <p className="text-sm font-medium break-words" style={{ color: 'hsl(var(--foreground))' }}>{order?.shippingInfo.address}</p>
                                <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{order?.shippingInfo.city}, {order?.shippingInfo.state} {order?.shippingInfo.postalCode}</p>
                                <p className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{order?.shippingInfo.country}</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Order Items and Summary */}
                <div className="lg:col-span-2">
                    <div className="glass-inner rounded-xl overflow-hidden">
                        <h2 className="text-base sm:text-lg font-semibold p-3 sm:p-4" style={{ color: 'hsl(var(--foreground))', borderBottom: '1px solid var(--glass-border)' }}>Order Items</h2>
                        <div>
                            {order?.orderItems.map((item, index) => (
                                <motion.div key={index} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: index * 0.1 }}
                                    className="p-3 sm:p-4 flex items-start gap-3 sm:gap-4" style={{ borderBottom: index < order.orderItems.length - 1 ? '1px solid var(--glass-border-subtle)' : 'none' }}>
                                    <div className="flex-shrink-0 h-14 w-14 sm:h-16 sm:w-16 rounded-xl overflow-hidden glass-inner">
                                        {item.image ? <img src={item.image} alt={item.name} className="h-full w-full object-cover" /> :
                                            <div className="h-full w-full flex items-center justify-center"><Package className="h-6 w-6 sm:h-8 sm:w-8" style={{ color: 'hsl(var(--muted-foreground))' }} /></div>}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-sm sm:text-base font-medium break-words" style={{ color: 'hsl(var(--foreground))' }}>{item.name}</h3>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Quantity: {item.quantity}</p>
                                        <div className="mt-2 sm:hidden">
                                            <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(item.price)}</p>
                                        </div>
                                    </div>
                                    <div className="text-right hidden sm:block flex-shrink-0">
                                        <p className="text-sm sm:text-base font-medium" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(item.price)}</p>
                                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal: {formatPrice(item.price * item.quantity)}</p>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>

                    {/* Order Summary */}
                    <div className="mt-6 glass-inner rounded-xl p-4">
                        <h2 className="text-lg font-semibold mb-4" style={{ color: 'hsl(var(--foreground))' }}>Order Summary</h2>
                        <div className="space-y-2">
                            <div className="flex justify-between"><span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(order?.orderSummary.subtotal)}</span></div>
                            {(() => {
                                let displayShippingCost = order?.orderSummary.shippingCost || 0;
                                let filteredShipping = order?.sellerShipping || [];
                                if (order?.sellerShipping && order.sellerShipping.length > 0) {
                                    if (currentUser?.role === 'seller') {
                                        filteredShipping = order.sellerShipping.filter(ss => ss.seller === currentUser.id || ss.seller === currentUser._id);
                                        displayShippingCost = filteredShipping.reduce((sum, ss) => sum + (ss.shippingMethod.price || 0), 0);
                                    } else { filteredShipping = order.sellerShipping; displayShippingCost = order.sellerShipping.reduce((sum, ss) => sum + (ss.shippingMethod.price || 0), 0); }
                                }
                                return displayShippingCost > 0 || filteredShipping.length > 0 ? (
                                    <div className="space-y-1">
                                        <div className="flex justify-between"><span className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(displayShippingCost)}</span></div>
                                        {filteredShipping.length > 0 && <div className="pl-4 space-y-1">{filteredShipping.map((ss, i) => (<div key={i} className="flex justify-between text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}><span>{ss.shippingMethod.name} ({ss.shippingMethod.estimatedDays} days)</span><span>{formatPrice(ss.shippingMethod.price)}</span></div>))}</div>}
                                    </div>
                                ) : null;
                            })()}
                            {order?.orderSummary.tax > 0 && <div className="flex justify-between"><span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Tax</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(order?.orderSummary.tax)}</span></div>}
                            <div className="flex justify-between pt-2" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                <span className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Total Amount</span>
                                <span className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {(() => {
                                        const subtotal = order?.orderSummary.subtotal || 0;
                                        const tax = order?.orderSummary.tax || 0;
                                        let actualShipping = order?.orderSummary.shippingCost || 0;
                                        if (order?.sellerShipping && order.sellerShipping.length > 0) {
                                            if (currentUser?.role === 'seller') { const ss = order.sellerShipping.find(s => s.seller === currentUser.id || s.seller === currentUser._id); actualShipping = ss ? ss.shippingMethod.price : 0; }
                                            else { actualShipping = order.sellerShipping.reduce((sum, s) => sum + (s.shippingMethod.price || 0), 0); }
                                        }
                                        return formatPrice(subtotal + tax + actualShipping);
                                    })()}
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Order Actions */}
                    <div className="mt-6 glass-inner rounded-xl overflow-hidden">
                        <h2 className="text-lg font-semibold p-4" style={{ color: 'hsl(var(--foreground))', borderBottom: '1px solid var(--glass-border)' }}>Order Management</h2>
                        <div className="p-4 space-y-4">
                            {!isUpdating ? (
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Current Status</p>
                                        <span className="px-3 py-1 text-sm rounded-full flex items-center gap-1 w-fit mt-1 font-medium" style={{ background: ss.bg, color: ss.color }}>
                                            {getStatusIcon(order?.orderStatus)} {order?.orderStatus.charAt(0).toUpperCase() + order?.orderStatus.slice(1)}
                                        </span>
                                    </div>
                                    {order?.orderStatus !== 'cancelled' && order?.orderStatus !== 'delivered' && (
                                        <motion.button whileHover={{ scale: 1.02 }} onClick={() => setIsUpdating(true)}
                                            className="px-4 py-2 rounded-xl text-white text-sm font-semibold flex items-center gap-2"
                                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>
                                            <Edit className="w-4 h-4" /> Update Status
                                        </motion.button>
                                    )}
                                </div>
                            ) : (
                                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-4">
                                    <div>
                                        <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Update Order Status</label>
                                        <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className="glass-input cursor-pointer font-medium">
                                            <option value="pending">Pending</option><option value="processing">Processing</option><option value="shipped">Shipped</option><option value="delivered">Delivered</option>
                                        </select>
                                    </div>
                                    <div className="flex space-x-2">
                                        <motion.button whileHover={{ scale: 1.02 }} onClick={handleStatusUpdate}
                                            className="px-4 py-2 rounded-xl text-white text-sm font-semibold"
                                            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(200, 80%, 50%))' }}>Save Changes</motion.button>
                                        <button onClick={() => setIsUpdating(false)} className="px-4 py-2 rounded-xl glass-inner text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                                    </div>
                                </motion.div>
                            )}

                            {order?.orderStatus === 'cancelled' ? (
                                <p className="text-sm font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>Order has been cancelled</p>
                            ) : order?.orderStatus === 'delivered' ? (
                                <p className="text-sm font-medium" style={{ color: 'hsl(150, 60%, 45%)' }}>Order has been delivered</p>
                            ) : (
                                currentUser?.role !== 'seller' && (
                                    <div className="pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                        <button onClick={() => setShowCancelConfirm(true)} className="px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2"
                                            style={{ background: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' }}>
                                            <XCircle className="w-4 h-4" /> Cancel Order
                                        </button>
                                    </div>
                                )
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Cancel Confirmation Modal */}
            <AnimatePresence>
                {showCancelConfirm && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setShowCancelConfirm(false)}>
                        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }} className="glass-panel p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-lg font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Cancel Order</h3>
                            <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>Are you sure? This action cannot be undone.</p>
                            <div className="flex justify-end space-x-3">
                                <button onClick={() => setShowCancelConfirm(false)} className="px-4 py-2 rounded-xl glass-inner font-medium" style={{ color: 'hsl(var(--foreground))' }}>Keep Order</button>
                                <button onClick={handleCancelOrder} className="px-4 py-2 rounded-xl text-white font-medium" style={{ background: 'hsl(0, 72%, 55%)' }}>Cancel Order</button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
            </div>
        </motion.div>
    );
};
export default OrderDetail
