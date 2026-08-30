import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "react-toastify";
import { ArrowLeft, Edit, Package, XCircle, Clock, RefreshCw, Truck, CheckCircle, Mail, MessageCircle, AlertCircle } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import Loader from "../common/Loader";
import { useAuth } from "../../contexts/AuthContext";
import { useCurrency } from "../../contexts/CurrencyContext";
import { getAuthToken } from "../../utils/cookieHelper";
import {
    getExactOrderItemUnitAmount,
    getOrderCurrency,
    getSellerCurrencyMoney,
    getOrderItemLineSubtotal,
    getOrderItemOptionPairs,
    getOrderSellerShippingBreakdown,
    getOrderSummaryAmount,
    getOrderTotal,
} from "../../utils/orderItems";

const OrderItemMoney = ({ item, formatMoney, amountClassName, sellerItemMoney = null, buyerFormatMoney = null }) => {
    const lineSubtotal = getOrderItemLineSubtotal(item);
    const exactUnitAmount = getExactOrderItemUnitAmount(item);
    if (sellerItemMoney) {
        const nativeUnit = sellerItemMoney.originalCurrency === sellerItemMoney.currency
            ? sellerItemMoney.originalUnitPrice
            : null;
        return (
            <>
                <p className={amountClassName} style={{ color: 'hsl(var(--foreground))' }}>
                    {formatMoney(nativeUnit ?? sellerItemMoney.lineSubtotal)}
                </p>
                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Store subtotal: {formatMoney(sellerItemMoney.lineSubtotal)}
                </p>
                {sellerItemMoney.buyerCurrency !== sellerItemMoney.currency && (
                    <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        Buyer equivalent: {buyerFormatMoney(sellerItemMoney.buyerLineSubtotal)}
                    </p>
                )}
            </>
        );
    }
    return (
        <>
            <p className={amountClassName} style={{ color: 'hsl(var(--foreground))' }}>
                {formatMoney(exactUnitAmount ?? lineSubtotal)}
            </p>
            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {exactUnitAmount === null ? 'Complete frozen line price' : `Subtotal: ${formatMoney(lineSubtotal)}`}
            </p>
        </>
    );
};

const timeAgo = (dateStr) => {
    if (!dateStr) return '';
    const now = new Date();
    const then = new Date(dateStr);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
};

const OrderDetail = () => {
    const { currentUser } = useAuth();
    const { formatPrice } = useCurrency();
    const [order, setOrder] = useState(null);
    const orderMoney = (amount) => {
        const orderCurrency = getOrderCurrency(order);
        return formatPrice(amount, {
            sourceCurrency: orderCurrency,
            targetCurrency: orderCurrency,
            showCode: true,
        });
    };
    const [isUpdating, setIsUpdating] = useState(false);
    const [newStatus, setNewStatus] = useState(null);
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const { id } = useParams();

    const getStatusIcon = (status) => {
        const icons = { pending: <Clock className="w-4 h-4" />, confirmed: <CheckCircle className="w-4 h-4" />, processing: <RefreshCw className="w-4 h-4" />, shipped: <Truck className="w-4 h-4" />, delivered: <CheckCircle className="w-4 h-4" />, cancelled: <XCircle className="w-4 h-4" /> };
        return icons[status] || <Package className="w-4 h-4" />;
    };

    const getStatusStyle = (status) => {
        const styles = { pending: { bg: 'rgba(249, 115, 22, 0.12)', color: 'hsl(30, 90%, 50%)' }, confirmed: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }, processing: { bg: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }, shipped: { bg: 'rgba(14, 165, 233, 0.12)', color: 'hsl(200, 80%, 50%)' }, delivered: { bg: 'rgba(16, 185, 129, 0.12)', color: 'hsl(150, 60%, 40%)' }, cancelled: { bg: 'rgba(239, 68, 68, 0.12)', color: 'hsl(0, 72%, 55%)' } };
        return styles[status] || { bg: 'rgba(255,255,255,0.08)', color: 'hsl(var(--muted-foreground))' };
    };

    const fetchOrderDetail = useCallback(async () => {
        const token = getAuthToken();
        try { const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/detail/${id}`, { headers: { Authorization: `Bearer ${token}` } }); setOrder(res.data.order); setNewStatus(res.data.order?.orderStatus || 'pending'); }
        catch (error) { toast.error(error.response?.data?.msg || 'Server error'); }
    }, [id]);
    useEffect(() => { fetchOrderDetail(); }, [fetchOrderDetail]);

    const handleStatusUpdate = async () => {
        try { const token = getAuthToken(); const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/order/update-status/${order?._id}`, { newStatus }, { headers: { Authorization: `Bearer ${token}` } }); toast.success(res.data.msg || 'Updated'); fetchOrderDetail(); }
        catch (error) { toast.error(error.response?.msg || 'Error updating status'); }
        setIsUpdating(false);
    };

    const handleCancelOrder = async () => {
        try { const token = getAuthToken(); await axios.patch(`${import.meta.env.VITE_API_URL}api/order/cancel/${id}`, {}, { headers: { Authorization: `Bearer ${token}` } }); fetchOrderDetail(); }
        catch (error) { toast.error(error.response?.msg || 'Error cancelling order'); }
        finally { setShowCancelConfirm(false); }
    };

    if (!order) return <div className="flex justify-center items-center min-h-[400px]"><Loader /></div>;

    const ss = getStatusStyle(order?.orderStatus);
    const sellerCurrencyMoney = currentUser?.role === 'seller'
        ? getSellerCurrencyMoney(order)
        : null;
    const sellerMoney = (amount) => formatPrice(amount, {
        sourceCurrency: sellerCurrencyMoney?.currency || getOrderCurrency(order),
        targetCurrency: sellerCurrencyMoney?.currency || getOrderCurrency(order),
        showCode: true,
    });
    const summarySubtotal = sellerCurrencyMoney?.summary.subtotal
        ?? getOrderSummaryAmount(order, ['subtotal'], 'order subtotal');
    const summaryTax = sellerCurrencyMoney?.summary.tax
        ?? getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'order tax');
    const summaryCouponDiscount = sellerCurrencyMoney?.summary.couponDiscount
        ?? getOrderSummaryAmount(order, ['couponDiscount', 'discountAmount'], 'order coupon discount');
    const reconciliationAdjustment = sellerCurrencyMoney?.summary.reconciliationAdjustment
        ?? getOrderSummaryAmount(
            order,
            ['reconciliationAdjustment'],
            'order reconciliation adjustment',
            { signed: true },
        );
    const primaryMoney = sellerCurrencyMoney ? sellerMoney : orderMoney;
    const primaryTotal = sellerCurrencyMoney?.summary.totalAmount ?? getOrderTotal(order);

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

            {/* Buyer decision banner — shows how the order was confirmed or cancelled */}
            {(order?.confirmation?.confirmedAt || order?.confirmation?.declinedAt) && (() => {
                const cancelledFromDash = !!order.confirmation.cancelledFromDashboardAt;
                const confirmed = !!order.confirmation.confirmedAt;
                const via = order.confirmation.confirmedVia;

                // If confirmed then cancelled — show the cancellation as primary
                if (cancelledFromDash && confirmed) {
                    const note = order.confirmation.cancelledFromDashboardNote || '';
                    const cancelledFrom = note.includes('account') || note.includes('dashboard')
                        ? 'account' : 'email';
                    const confirmedChannel = via === 'whatsapp' ? 'WhatsApp' : (via === 'email' ? 'email' : via);
                    return (
                        <div className="mx-4 sm:mx-6 p-3 rounded-xl flex items-start gap-3"
                            style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                            <span className="text-base" style={{ color: 'hsl(0, 70%, 45%)' }}>❌</span>
                            <div className="min-w-0">
                                <p className="text-sm font-semibold" style={{ color: 'hsl(0, 70%, 45%)' }}>
                                    Cancelled by buyer from {cancelledFrom} (was confirmed via {confirmedChannel})
                                </p>
                                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    Cancelled {timeAgo(order.confirmation.cancelledFromDashboardAt)} · {new Date(order.confirmation.cancelledFromDashboardAt).toLocaleString()}
                                </p>
                            </div>
                        </div>
                    );
                }

                const whenIso = confirmed ? order.confirmation.confirmedAt : order.confirmation.declinedAt;
                const verbPast = confirmed ? 'Confirmed' : 'Cancelled';
                const viaLabel = via === 'whatsapp'
                    ? 'Rozare WhatsApp automation'
                    : via === 'email'
                        ? 'email confirmation link'
                        : (via || 'the order confirmation flow');
                const palette = confirmed
                    ? { bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.25)', title: 'hsl(150, 60%, 35%)' }
                    : { bg: 'rgba(239, 68, 68, 0.08)',  border: 'rgba(239, 68, 68, 0.25)',  title: 'hsl(0, 70%, 45%)' };
                return (
                    <div className="mx-4 sm:mx-6 p-3 rounded-xl flex items-start gap-3"
                        style={{ background: palette.bg, border: `1px solid ${palette.border}` }}>
                        <span className="text-base" style={{ color: palette.title }}>
                            {confirmed ? '✅' : '❌'}
                        </span>
                        <div className="min-w-0">
                            <p className="text-sm font-semibold" style={{ color: palette.title }}>
                                {verbPast} by buyer via {viaLabel}
                            </p>
                            <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                {timeAgo(whenIso)} · {new Date(whenIso).toLocaleString()}
                            </p>
                        </div>
                    </div>
                );
            })()}

            {/* Confirmation Status — channel tracking for seller/admin */}
            {order?.confirmation && (
                <div className="mx-4 sm:mx-6 mt-3 glass-inner rounded-xl p-3 sm:p-4">
                    <h3 className="text-sm font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Confirmation Status</h3>

                    {/* Summary line when both channels sent */}
                    {order.confirmation.emailSentSuccess === true && order.confirmation.whatsappSentSuccess === true && (
                        <p className="text-xs font-medium mb-2 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(16, 185, 129, 0.08)', color: 'hsl(150, 60%, 38%)' }}>
                            The confirmation message was sent via email and Rozare WhatsApp automation
                        </p>
                    )}
                    {order.confirmation.emailSentSuccess === true && order.confirmation.whatsappSentSuccess === false && (
                        <p className="text-xs font-medium mb-2 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(249, 115, 22, 0.08)', color: 'hsl(30, 90%, 45%)' }}>
                            The confirmation message was sent via email. WhatsApp sending failed.
                        </p>
                    )}
                    {order.confirmation.emailSentSuccess === false && order.confirmation.whatsappSentSuccess === true && (
                        <p className="text-xs font-medium mb-2 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(249, 115, 22, 0.08)', color: 'hsl(30, 90%, 45%)' }}>
                            The confirmation message was sent via Rozare WhatsApp automation. Email sending failed.
                        </p>
                    )}

                    <div className="space-y-2">
                        {/* Email status */}
                        <div className="flex items-start gap-2">
                            <Mail className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: order.confirmation.emailSentSuccess === true ? 'hsl(150, 60%, 40%)' : order.confirmation.emailSentSuccess === false ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }} />
                            <div className="min-w-0 flex-1">
                                {order.confirmation.emailSentSuccess === true ? (
                                    <p className="text-xs font-medium" style={{ color: 'hsl(150, 60%, 40%)' }}>
                                        Email confirmation sent · {timeAgo(order.confirmation.emailSentAt)}
                                    </p>
                                ) : order.confirmation.emailSentSuccess === false ? (
                                    <>
                                        <p className="text-xs font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                            Email failed — {order.confirmation.emailError || 'Unknown error'}
                                        </p>
                                        <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            The buyer can still confirm via WhatsApp if that channel is active.
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Email confirmation: Not sent
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* WhatsApp status */}
                        <div className="flex items-start gap-2">
                            <MessageCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: order.confirmation.whatsappSentSuccess === true ? 'hsl(150, 60%, 40%)' : order.confirmation.whatsappSentSuccess === false ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))' }} />
                            <div className="min-w-0 flex-1">
                                {order.confirmation.whatsappSentSuccess === true ? (
                                    <p className="text-xs font-medium" style={{ color: 'hsl(150, 60%, 40%)' }}>
                                        WhatsApp confirmation sent · {timeAgo(order.confirmation.whatsappSentAt)}
                                    </p>
                                ) : order.confirmation.whatsappSentSuccess === false ? (
                                    <>
                                        <p className="text-xs font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                            WhatsApp failed — {order.confirmation.whatsappError || 'Unknown error'}
                                        </p>
                                        <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                            You can try sending the confirmation manually via the WhatsApp button on the order list.
                                        </p>
                                    </>
                                ) : (
                                    <p className="text-xs font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        WhatsApp confirmation: Not sent yet (queued or not applicable)
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Buyer response status */}
                        <div className="flex items-start gap-2 pt-1" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
                            {order.confirmation.confirmedAt ? (
                                <>
                                    <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'hsl(150, 60%, 40%)' }} />
                                    <p className="text-xs font-medium" style={{ color: 'hsl(150, 60%, 40%)' }}>
                                        Buyer confirmed via {order.confirmation.decidedVia || order.confirmation.confirmedVia || 'unknown'} · {timeAgo(order.confirmation.confirmedAt)}
                                    </p>
                                </>
                            ) : order.confirmation.declinedAt ? (
                                <>
                                    <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'hsl(0, 72%, 55%)' }} />
                                    <p className="text-xs font-medium" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                        Buyer cancelled via {order.confirmation.decidedVia || order.confirmation.confirmedVia || 'unknown'} · {timeAgo(order.confirmation.declinedAt)}
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Clock className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'hsl(30, 90%, 50%)' }} />
                                    <p className="text-xs font-medium" style={{ color: 'hsl(30, 90%, 50%)' }}>
                                        Waiting for buyer response · Confirmation sent {timeAgo(order.confirmation.emailSentAt || order.confirmation.whatsappSentAt || order.createdAt)}
                                    </p>
                                </>
                            )}
                        </div>

                        {/* Cancelled from dashboard note */}
                        {order.confirmation.cancelledFromDashboardAt && (
                            <div className="flex items-start gap-2 pt-1" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
                                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'hsl(30, 90%, 50%)' }} />
                                <div>
                                    <p className="text-xs font-medium" style={{ color: 'hsl(30, 90%, 50%)' }}>
                                        {order.confirmation.cancelledFromDashboardNote || 'Buyer cancelled from dashboard after confirming via WhatsApp'}
                                    </p>
                                    <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Cancelled {timeAgo(order.confirmation.cancelledFromDashboardAt)}
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

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
                                        {getOrderItemOptionPairs(item).length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 mt-2">
                                                {getOrderItemOptionPairs(item).map((option) => (
                                                    <span key={`${option.name}:${option.value}`} className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: 'rgba(99, 102, 241, 0.12)', color: 'hsl(220, 70%, 55%)' }}>
                                                        {option.name}: {option.value}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        <div className="mt-2 sm:hidden">
                                            <OrderItemMoney
                                                item={item}
                                                formatMoney={primaryMoney}
                                                buyerFormatMoney={orderMoney}
                                                sellerItemMoney={sellerCurrencyMoney?.itemMoney?.[index] || null}
                                                amountClassName="text-sm font-semibold"
                                            />
                                        </div>
                                    </div>
                                    <div className="text-right hidden sm:block flex-shrink-0">
                                        <OrderItemMoney
                                            item={item}
                                            formatMoney={primaryMoney}
                                            buyerFormatMoney={orderMoney}
                                            sellerItemMoney={sellerCurrencyMoney?.itemMoney?.[index] || null}
                                            amountClassName="text-sm sm:text-base font-medium"
                                        />
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>

                    {/* Order Summary */}
                    <div className="mt-6 glass-inner rounded-xl p-4">
                        <h2 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                            {sellerCurrencyMoney ? `Your Store-Currency Summary (${sellerCurrencyMoney.currency})` : 'Order Summary'}
                        </h2>
                        {sellerCurrencyMoney && (
                            <p className="text-xs mt-1 mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                Frozen at checkout. This is your order value in the store currency; it is not a live-FX estimate.
                            </p>
                        )}
                        <div className="space-y-2">
                            <div className="flex justify-between"><span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{primaryMoney(summarySubtotal)}</span></div>
                            {(() => {
                                const sellerId = currentUser?.role === 'seller'
                                    ? String(currentUser.id || currentUser._id)
                                    : null;
                                const shipping = sellerCurrencyMoney
                                    ? {
                                        total: sellerCurrencyMoney.summary.shippingCost,
                                        entries: (order.sellerShipping || []).map((entry) => ({
                                            ...entry,
                                            shippingMethod: {
                                                ...entry.shippingMethod,
                                                price: sellerCurrencyMoney.summary.shippingCost,
                                            },
                                        })),
                                    }
                                    : getOrderSellerShippingBreakdown(order, sellerId);
                                return shipping.total > 0 || shipping.entries.length > 0 ? (
                                    <div className="space-y-1">
                                        <div className="flex justify-between"><span className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{primaryMoney(shipping.total)}</span></div>
                                        {shipping.entries.length > 0 && <div className="pl-4 space-y-1">{shipping.entries.map((ss, i) => (<div key={i} className="flex justify-between text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}><span>{ss.shippingMethod.name} ({ss.shippingMethod.estimatedDays} days)</span><span>{primaryMoney(ss.shippingMethod.price)}</span></div>))}</div>}
                                    </div>
                                ) : null;
                            })()}
                            {summaryTax > 0 && <div className="flex justify-between"><span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Tax</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{primaryMoney(summaryTax)}</span></div>}
                            {summaryCouponDiscount > 0 && <div className="flex justify-between"><span className="text-sm" style={{ color: 'hsl(150, 60%, 45%)' }}>Coupon Discount</span><span className="text-sm font-medium" style={{ color: 'hsl(150, 60%, 45%)' }}>-{primaryMoney(summaryCouponDiscount)}</span></div>}
                            {reconciliationAdjustment !== 0 && <div className="flex justify-between"><span className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Frozen FX/cent adjustment</span><span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{reconciliationAdjustment > 0 ? '+' : '-'}{primaryMoney(Math.abs(reconciliationAdjustment))}</span></div>}
                            {order?.appliedCoupons?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {order.appliedCoupons.map((c, i) => (
                                        <span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold" style={{ background: 'rgba(168,85,247,0.12)', color: 'hsl(280, 60%, 55%)' }}>{c.code}</span>
                                    ))}
                                </div>
                            )}
                            <div className="flex justify-between pt-2" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                <span className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Total Amount</span>
                                <span className="text-lg font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {primaryMoney(primaryTotal)}
                                </span>
                            </div>
                            {sellerCurrencyMoney && sellerCurrencyMoney.buyerCurrency !== sellerCurrencyMoney.currency && (
                                <div className="mt-4 p-3 rounded-xl" style={{ background: 'rgba(99, 102, 241, 0.08)', border: '1px solid rgba(99, 102, 241, 0.18)' }}>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Buyer checkout equivalent</span>
                                        <span className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(sellerCurrencyMoney.buyerSummary.totalAmount)}</span>
                                    </div>
                                    <p className="text-[10px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        Frozen rate: 1 {sellerCurrencyMoney.currency} = {sellerCurrencyMoney.exchangeRate.rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} {sellerCurrencyMoney.buyerCurrency}. Buyer and seller values will not change with live FX.
                                    </p>
                                </div>
                            )}
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
                                            <option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="processing">Processing</option><option value="shipped">Shipped</option><option value="delivered">Delivered</option><option value="cancelled">Cancelled</option>
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
