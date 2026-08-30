import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "react-toastify";
import { ArrowLeft, Package, XCircle, Clock, RefreshCw, Truck, CheckCircle, CreditCard } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { useCurrency } from "../../contexts/CurrencyContext";
import Loader from "../common/Loader";
import { getAuthToken } from "../../utils/cookieHelper";
import {
    getExactOrderItemUnitAmount,
    getOrderCurrency,
    getOrderItemLineSubtotal,
    getOrderItemOptionPairs,
    getOrderSellerShippingBreakdown,
    getOrderSellerGroups,
    getOrderSummaryAmount,
    getOrderTotal,
} from "../../utils/orderItems";
import BuyerReturnsPanel from "./BuyerReturnsPanel";
import BuyerSellerFulfillmentGroups from "../order/BuyerSellerFulfillmentGroups";

const OrderItemMoney = ({ item, formatMoney, amountClassName }) => {
    const lineSubtotal = getOrderItemLineSubtotal(item);
    const exactUnitAmount = getExactOrderItemUnitAmount(item);
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

const OrderDetail = () => {
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
    const { id } = useParams();
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

    const fetchOrderDetail = useCallback(async () => {
        const token = getAuthToken();
        try {
            const res = await axios.get(`${import.meta.env.VITE_API_URL}api/order/detail/${id}`, { headers: { Authorization: `Bearer ${token}` } });
            setOrder(res.data.order);
        } catch (error) { toast.error(error.response?.data?.msg || "Server error while fetching order detail"); }
    }, [id]);

    useEffect(() => { fetchOrderDetail(); }, [fetchOrderDetail]);

    const handleCancelOrder = async () => {
        try {
            const token = getAuthToken();
            const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/order/cancel/${id}`, {}, { headers: { Authorization: `Bearer ${token}` } });
            // Use the response order directly for immediate UI update
            if (res.data?.order) {
                setOrder(res.data.order);
            } else {
                fetchOrderDetail();
            }
        } catch (error) { toast.error(error.response?.data?.msg || "Server error while cancelling order"); }
        finally { setShowCancelConfirm(false); }
    };

    if (!order) return <div className="min-h-screen flex justify-center items-center"><Loader /></div>;

    const ss = getStatusStyle(order?.orderStatus);
    const summarySubtotal = getOrderSummaryAmount(order, ['subtotal'], 'order subtotal');
    const summaryTax = getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'order tax');
    const summaryCouponDiscount = getOrderSummaryAmount(
        order,
        ['couponDiscount', 'discountAmount'],
        'order coupon discount',
    );
    const reconciliationAdjustment = getOrderSummaryAmount(
        order,
        ['reconciliationAdjustment'],
        'order reconciliation adjustment',
        { signed: true },
    );
    const sellerGrouping = (() => {
        try {
            return { groups: getOrderSellerGroups(order), invalid: false };
        } catch (_) {
            return { groups: [], invalid: true };
        }
    })();
    const fulfillmentStartedGroup = sellerGrouping.groups.find(group => ['shipped', 'delivered'].includes(group.status));
    const canCancelWholeOrder = !sellerGrouping.invalid
        && order.orderStatus !== 'cancelled'
        && order.orderStatus !== 'delivered'
        && order.orderStatus !== 'shipped'
        && !order.isPaid
        && !fulfillmentStartedGroup;
    const unpaidStatusLabel = order.orderStatus === 'cancelled'
        ? 'Unpaid'
        : order.paymentMethod === 'cash_on_delivery'
            ? 'Due on delivery'
            : 'Pending';

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

                {/* Buyer-side confirmation / cancellation status */}
                {(order?.confirmation?.confirmedAt || order?.confirmation?.declinedAt || order?.confirmation?.cancelledAt) && (() => {
                    const cancelledFromDash = !!order.confirmation.cancelledFromDashboardAt;
                    const confirmed = !!order.confirmation.confirmedAt;
                    const via = order.confirmation.decidedVia || order.confirmation.confirmedVia;
                    const cancellationActor = order.confirmation.cancelledByRole;
                    const cancelledByAnotherActor = order.orderStatus === 'cancelled'
                        && ['admin', 'seller', 'system'].includes(cancellationActor);

                    if (cancelledByAnotherActor) {
                        const actorLabel = cancellationActor === 'admin'
                            ? 'a Rozare administrator'
                            : cancellationActor === 'seller'
                                ? 'the seller'
                                : 'Rozare automatically';
                        const confirmedChannel = order.confirmation.confirmedVia === 'whatsapp'
                            ? 'WhatsApp'
                            : order.confirmation.confirmedVia === 'email'
                                ? 'email'
                                : 'Rozare';
                        return (
                            <div className="mt-4 p-3 rounded-xl flex items-start gap-3"
                                style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                                <XCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'hsl(0, 70%, 45%)' }} />
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold" style={{ color: 'hsl(0, 70%, 45%)' }}>
                                        Order cancelled by {actorLabel}
                                    </p>
                                    <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        {confirmed
                                            ? `This happened after you confirmed via ${confirmedChannel}. Nothing has been charged.`
                                            : 'Nothing has been charged.'}
                                    </p>
                                </div>
                            </div>
                        );
                    }

                    // Cancelled after previously confirming (from account or email page)
                    if (cancelledFromDash && confirmed) {
                        const confirmedChannel = order.confirmation.confirmedVia === 'whatsapp' ? 'WhatsApp' : 'email';
                        // Determine WHERE they cancelled from using the note
                        const note = order.confirmation.cancelledFromDashboardNote || '';
                        const cancelledFrom = note.includes('account') || note.includes('dashboard')
                            ? 'your Rozare account'
                            : 'email';
                        return (
                            <div className="mt-4 p-3 rounded-xl flex items-start gap-3"
                                style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)' }}>
                                <XCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'hsl(0, 70%, 45%)' }} />
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold" style={{ color: 'hsl(0, 70%, 45%)' }}>
                                        Order cancelled
                                    </p>
                                    <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                        You confirmed via {confirmedChannel}, then cancelled from {cancelledFrom} — nothing has been charged.
                                    </p>
                                </div>
                            </div>
                        );
                    }

                    // Re-confirmed after cancel (status is now confirmed, but declinedAt was set then cleared)
                    const orderConfirmed = order.orderStatus === 'confirmed' || order.orderStatus === 'processing' || order.orderStatus === 'shipped';

                    const verbPast = orderConfirmed ? 'confirmed' : (order.orderStatus === 'cancelled' ? 'cancelled' : (confirmed ? 'confirmed' : 'cancelled'));
                    const viaLabel = via === 'whatsapp'
                        ? 'WhatsApp'
                        : via === 'email'
                            ? 'email'
                            : via === 'admin'
                                ? 'the seller/admin'
                                : via === 'manual'
                                    ? 'the seller'
                                    : via === 'dashboard'
                                        ? 'your Rozare account'
                                        : 'the order confirmation flow';
                    const isGood = verbPast === 'confirmed';
                    const palette = isGood
                        ? { bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.25)', title: 'hsl(150, 60%, 35%)' }
                        : { bg: 'rgba(239, 68, 68, 0.08)',  border: 'rgba(239, 68, 68, 0.25)',  title: 'hsl(0, 70%, 45%)' };
                    const Icon = isGood ? CheckCircle : XCircle;
                    return (
                        <div className="mt-4 p-3 rounded-xl flex items-start gap-3"
                            style={{ background: palette.bg, border: `1px solid ${palette.border}` }}>
                            <Icon className="w-5 h-5 mt-0.5 shrink-0" style={{ color: palette.title }} />
                            <div className="min-w-0">
                                <p className="text-sm font-semibold" style={{ color: palette.title }}>
                                    You {verbPast} this order via {viaLabel}
                                </p>
                                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                    {isGood
                                        ? 'The seller has been notified and will process your order shortly.'
                                        : 'Nothing has been charged.'}
                                </p>
                            </div>
                        </div>
                    );
                })()}
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
                                <span style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(summarySubtotal)}</span>
                            </div>
                            {(() => {
                                const shipping = getOrderSellerShippingBreakdown(order);
                                return shipping.total >= 0 ? (
                                    <div className="space-y-1">
                                        <div className="flex justify-between">
                                            <span className="font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping</span>
                                            <span style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(shipping.total)}</span>
                                        </div>
                                        {shipping.hasBreakdown && (
                                            <div className="pl-4 space-y-1">
                                                {shipping.entries.map((s, i) => (
                                                    <div key={i} className="flex justify-between text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                        <span className="capitalize">{s.shippingMethod.name} ({s.shippingMethod.estimatedDays} days)</span>
                                                        <span>{orderMoney(s.shippingMethod.price)}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ) : null;
                            })()}
                            {summaryTax > 0 && (
                                <div className="flex justify-between">
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Tax</span>
                                    <span style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(summaryTax)}</span>
                                </div>
                            )}
                            {summaryCouponDiscount > 0 && (
                                <div className="flex justify-between">
                                    <span style={{ color: 'hsl(150, 60%, 45%)' }}>Coupon Discount</span>
                                    <span style={{ color: 'hsl(150, 60%, 45%)' }}>-{orderMoney(summaryCouponDiscount)}</span>
                                </div>
                            )}
                            {reconciliationAdjustment !== 0 && (
                                <div className="flex justify-between">
                                    <span style={{ color: 'hsl(var(--muted-foreground))' }}>Rounding adjustment</span>
                                    <span style={{ color: 'hsl(var(--foreground))' }}>{reconciliationAdjustment > 0 ? '+' : '-'}{orderMoney(Math.abs(reconciliationAdjustment))}</span>
                                </div>
                            )}
                            {order?.appliedCoupons?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                    {order.appliedCoupons.map((c, i) => (
                                        <span key={i} className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold" style={{ background: 'rgba(168,85,247,0.12)', color: 'hsl(280, 60%, 55%)' }}>{c.code}</span>
                                    ))}
                                </div>
                            )}
                            <div className="flex justify-between pt-2" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                <span className="text-base font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Total</span>
                                <span className="text-base font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>
                                    {orderMoney(getOrderTotal(order))}
                                </span>
                            </div>
                        </div>

                        {canCancelWholeOrder && (
                            <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--glass-border)' }}>
                                <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.97 }}
                                    onClick={() => setShowCancelConfirm(true)}
                                    className="w-full px-4 py-2.5 rounded-xl font-semibold flex items-center justify-center gap-2 text-sm"
                                    style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'hsl(0, 72%, 55%)', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                                    <XCircle className="w-4 h-4" /> Cancel Order
                                </motion.button>
                            </div>
                        )}
                        {!canCancelWholeOrder && fulfillmentStartedGroup && !order.isPaid && (
                            <div className="mt-4 pt-4 text-xs flex items-start gap-2" style={{ borderTop: '1px solid var(--glass-border)', color: 'hsl(var(--muted-foreground))' }}>
                                <Truck className="w-4 h-4 shrink-0" /> The whole order can no longer be cancelled because {fulfillmentStartedGroup.storeName} already {fulfillmentStartedGroup.status === 'delivered' ? 'delivered' : 'shipped'} its portion.
                            </div>
                        )}
                    </div>

                    {/* Payment */}
                    <div className="glass-panel p-4 sm:p-5">
                        <h2 className="text-base sm:text-lg font-semibold mb-4 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                            <CreditCard className="w-4 h-4" style={{ color: 'hsl(var(--primary))' }} /> Payment Details
                        </h2>
                        <div className="space-y-3 text-sm">
                            <div className="flex justify-between"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Method:</span><span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{order.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : order.paymentMethod === 'wallet' ? 'Rozare Wallet' : 'Card (Stripe)'}</span></div>
                            <div className="flex justify-between items-center">
                                <span style={{ color: 'hsl(var(--muted-foreground))' }}>Status:</span>
                                {order.isPaid
                                    ? <span className="flex items-center gap-1 font-semibold" style={{ color: 'hsl(150, 60%, 40%)' }}><CheckCircle className="w-4 h-4" /> Paid</span>
                                    : <span className="flex items-center gap-1 font-semibold" style={{ color: order.orderStatus === 'cancelled' ? 'hsl(0, 72%, 55%)' : 'hsl(30, 90%, 50%)' }}><Clock className="w-4 h-4" /> {unpaidStatusLabel}</span>
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

                {/* Seller-owned shipment groups */}
                <div className="lg:col-span-2 space-y-4">
                    <BuyerSellerFulfillmentGroups order={order} formatMoney={orderMoney} />
                    {sellerGrouping.groups.length === 0 && !sellerGrouping.invalid && (
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
                                            <OrderItemMoney item={item} formatMoney={orderMoney} amountClassName="text-sm font-semibold" />
                                        </div>
                                    </div>
                                    <div className="text-right hidden sm:block shrink-0">
                                        <OrderItemMoney item={item} formatMoney={orderMoney} amountClassName="text-sm font-semibold" />
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </div>
                    )}
                </div>
            </div>

            <BuyerReturnsPanel order={order} formatMoney={orderMoney} />

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
