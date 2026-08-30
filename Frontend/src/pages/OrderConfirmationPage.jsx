import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, XCircle, Clock, ShieldCheck, Loader2, Package, MapPin, MessageCircle, Mail, ShoppingCart } from 'lucide-react';
import axios from 'axios';
import SEOHead from '../components/common/SEOHead';
import { useCurrency } from '../contexts/CurrencyContext';
import {
  formatOrderItemOptions,
  getOrderCurrency,
  getOrderItemLineSubtotal,
  getOrderSummaryAmount,
  getOrderTotal,
  hasExactOrderItemUnitEquation,
} from '../utils/orderItems';
import { shouldShowGenericConfirmedBanner } from '../utils/orderConfirmationPresentation';

const API = import.meta.env.VITE_API_URL;

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

export default function OrderConfirmationPage() {
  const { token } = useParams();
  const { formatPrice } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState(null);
  const orderMoney = (amount) => {
    const orderCurrency = getOrderCurrency(order);
    return formatPrice(amount, {
      sourceCurrency: orderCurrency,
      targetCurrency: orderCurrency,
      showCode: true,
    });
  };
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionDone, setActionDone] = useState(null); // 'confirmed' | 'declined'
  const [showReorderDialog, setShowReorderDialog] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${API}api/order-confirm/${token}`);
        if (cancelled) return;
        setOrder(res.data.order);
        if (res.data.order?.confirmation?.confirmedAt && !res.data.order?.confirmation?.declinedAt) setActionDone('confirmed');
        else if (res.data.order?.confirmation?.declinedAt) setActionDone('declined');
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.msg || 'Confirmation link is invalid or expired');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const res = await axios.post(`${API}api/order-confirm/${token}/confirm`);
      setOrder(res.data.order);
      if (res.data.order?.confirmation?.confirmedAt) setActionDone('confirmed');
      else if (res.data.order?.confirmation?.declinedAt) setActionDone('declined');
    } catch (err) {
      if (err.response?.data?.order) {
        setOrder(err.response.data.order);
        if (err.response.data.order?.confirmation?.confirmedAt) setActionDone('confirmed');
        else if (err.response.data.order?.confirmation?.declinedAt) setActionDone('declined');
      } else {
        setError(err.response?.data?.msg || 'Could not confirm order');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecline = async () => {
    setSubmitting(true);
    try {
      const res = await axios.post(`${API}api/order-confirm/${token}/decline`);
      setOrder(res.data.order);
      if (res.data.order?.confirmation?.declinedAt || res.data.order?.orderStatus === 'cancelled') setActionDone('declined');
      else if (res.data.order?.confirmation?.confirmedAt) setActionDone('confirmed');
    } catch (err) {
      if (err.response?.data?.order) {
        setOrder(err.response.data.order);
        if (err.response.data.order?.confirmation?.confirmedAt) setActionDone('confirmed');
        else if (err.response.data.order?.confirmation?.declinedAt) setActionDone('declined');
      } else {
        setError(err.response?.data?.msg || 'Could not cancel order');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleReconfirm = async () => {
    setSubmitting(true);
    try {
      const res = await axios.post(`${API}api/order-confirm/${token}/reconfirm`);
      setOrder(res.data.order);
      setActionDone('confirmed');
      setShowReorderDialog(false);
    } catch (err) {
      setError(err.response?.data?.msg || 'Could not re-confirm order');
    } finally {
      setSubmitting(false);
    }
  };

  const expired = order?.confirmation?.expired;
  const conf = order?.confirmation;
  const confirmedVia = conf?.decidedVia || conf?.confirmedVia;
  const maskedPhone = order?.shippingInfo?.maskedPhone;
  const orderCancelled = order?.orderStatus === 'cancelled';
  const cancellationActor = conf?.cancelledByRole;
  const cancelledByAnotherActor = orderCancelled
    && ['admin', 'seller', 'system'].includes(cancellationActor);

  // Simple states
  // cancelledViaWhatsApp = buyer pressed cancel button on WA (declinedAt set, decidedVia=whatsapp, NOT cancelledFromDashboard)
  const confirmedViaWhatsApp = confirmedVia === 'whatsapp' && conf?.confirmedAt && !orderCancelled;
  const cancelledViaWhatsApp = !cancelledByAnotherActor && conf?.declinedAt && (conf?.decidedVia === 'whatsapp' || conf?.confirmedVia === 'whatsapp') && !conf?.cancelledFromDashboardAt && !conf?.confirmedAt;
  const confirmedViaEmail = confirmedVia === 'email' && conf?.confirmedAt && !orderCancelled;
  const cancelledViaEmail = !cancelledByAnotherActor && confirmedVia === 'email' && conf?.declinedAt && !conf?.cancelledFromDashboardAt;
  // Cancelled from account (user dashboard) — with or without prior confirmation
  const cancelledFromAccount = !cancelledByAnotherActor && (conf?.cancelledVia === 'dashboard' || conf?.decidedVia === 'dashboard' || (conf?.cancelledFromDashboardAt && conf?.cancelledFromDashboardNote?.includes('account'))) && orderCancelled;
  // Cancelled from email page after WA/email confirm
  const cancelledFromEmailPage = !cancelledByAnotherActor
    && conf?.cancelledFromDashboardAt
    && (conf?.cancelledVia
      ? conf.cancelledVia === 'email'
      : !conf?.cancelledFromDashboardNote?.includes('account'))
    && orderCancelled;
  const notYetDecided = !actionDone && !expired;
  const showGenericConfirmedBanner = shouldShowGenericConfirmedBanner({
    actionDone,
    orderStatus: order?.orderStatus,
    hasSpecificConfirmationState: Boolean(confirmedViaWhatsApp || confirmedViaEmail),
    hasCancellationState: Boolean(
      cancelledByAnotherActor
      || cancelledFromAccount
      || cancelledFromEmailPage
      || cancelledViaWhatsApp
      || cancelledViaEmail
    ),
  });
  const summarySubtotal = getOrderSummaryAmount(order, ['subtotal'], 'order subtotal');
  const summaryShipping = getOrderSummaryAmount(order, ['shippingCost', 'shippingFee'], 'order shipping');
  const summaryTax = getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'order tax');
  const couponDiscount = getOrderSummaryAmount(
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

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12" style={{ background: 'hsl(var(--background))' }}>
      <SEOHead title="Confirm Your Order · Rozare" description="Confirm your Cash on Delivery order with Rozare." />
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-2xl glass-panel p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="glass-inner p-2.5 rounded-xl"><ShieldCheck size={22} style={{ color: 'hsl(var(--primary))' }} /></div>
          <div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Order Confirmation</h1>
            <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Cash on Delivery · Rozare</p>
          </div>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="animate-spin" size={28} style={{ color: 'hsl(var(--primary))' }} />
            <p className="text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Loading order...</p>
          </div>
        )}

        {!loading && error && !order && (
          <div className="text-center py-12">
            <div className="glass-inner p-3 rounded-2xl inline-block mb-4"><XCircle size={28} style={{ color: 'hsl(0, 72%, 55%)' }} /></div>
            <h2 className="text-lg font-bold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Link Invalid</h2>
            <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>{error}</p>
            <Link to="/" className="text-sm font-semibold" style={{ color: 'hsl(var(--primary))' }}>Back to home</Link>
          </div>
        )}

        {!loading && order && (
          <>
            {cancelledByAnotherActor && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                <XCircle size={20} style={{ color: 'hsl(0, 72%, 55%)', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1">
                  <p className="font-semibold text-sm" style={{ color: 'hsl(0, 72%, 50%)' }}>
                    {cancellationActor === 'admin'
                      ? 'A Rozare administrator cancelled this order'
                      : cancellationActor === 'seller'
                        ? 'The seller cancelled this order'
                        : 'Rozare automatically cancelled this order'}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    No charges applied.
                  </p>
                </div>
              </div>
            )}

            {/* Already confirmed via WhatsApp — no cancel button, just text */}
            {confirmedViaWhatsApp && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(16, 185, 129, 0.10)', border: '1px solid rgba(16,185,129,0.25)' }}>
                <MessageCircle size={20} style={{ color: 'hsl(150, 60%, 40%)', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1">
                  <p className="font-semibold text-sm" style={{ color: 'hsl(150, 60%, 35%)' }}>
                    You have already confirmed this order via your WhatsApp {maskedPhone ? `(+${maskedPhone})` : ''}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Confirmed {timeAgo(conf.confirmedAt)} · Status: <span className="font-medium capitalize">{order.orderStatus}</span>
                  </p>
                  <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    If you want to cancel, visit your Rozare account.
                  </p>
                </div>
              </div>
            )}

            {/* Already cancelled via WhatsApp — show re-order button */}
            {cancelledViaWhatsApp && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                <MessageCircle size={20} style={{ color: 'hsl(0, 72%, 55%)', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1">
                  <p className="font-semibold text-sm" style={{ color: 'hsl(0, 72%, 50%)' }}>
                    You have cancelled this order via your WhatsApp {maskedPhone ? `(+${maskedPhone})` : ''}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Cancelled {timeAgo(conf.declinedAt || conf.cancelledFromDashboardAt)}
                  </p>
                  <p className="text-sm mt-2" style={{ color: 'hsl(var(--foreground))' }}>
                    Want to place this order again?
                  </p>
                  <button
                    onClick={() => setShowReorderDialog(true)}
                    className="mt-2 px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-1.5"
                    style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(263, 70%, 60%))', color: '#fff' }}
                  >
                    <ShoppingCart size={14} /> Yes, place order again
                  </button>
                </div>
              </div>
            )}

            {/* Already confirmed via email (returning visitor) */}
            {confirmedViaEmail && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(16, 185, 129, 0.10)', border: '1px solid rgba(16,185,129,0.25)' }}>
                <Mail size={20} style={{ color: 'hsl(150, 60%, 40%)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p className="font-semibold text-sm" style={{ color: 'hsl(150, 60%, 35%)' }}>You confirmed this order via email</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Confirmed {timeAgo(conf.confirmedAt)} · The seller has been notified.
                  </p>
                </div>
              </div>
            )}

            {/* Already cancelled via email (returning visitor) */}
            {cancelledViaEmail && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                <Mail size={20} style={{ color: 'hsl(0, 72%, 55%)', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1">
                  <p className="font-semibold text-sm" style={{ color: 'hsl(0, 72%, 50%)' }}>You cancelled this order via email</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Cancelled {timeAgo(conf.declinedAt)} · No charges applied.
                  </p>
                  <p className="text-sm mt-2" style={{ color: 'hsl(var(--foreground))' }}>Want to place this order again?</p>
                  <button
                    onClick={() => setShowReorderDialog(true)}
                    className="mt-2 px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-1.5"
                    style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(263, 70%, 60%))', color: '#fff' }}
                  >
                    <ShoppingCart size={14} /> Yes, place order again
                  </button>
                </div>
              </div>
            )}

            {/* Cancelled from user account */}
            {cancelledFromAccount && !cancelledViaWhatsApp && !cancelledViaEmail && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                <XCircle size={20} style={{ color: 'hsl(0, 72%, 55%)', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1">
                  <p className="font-semibold text-sm" style={{ color: 'hsl(0, 72%, 50%)' }}>You cancelled this order from your Rozare account</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    No charges applied.
                  </p>
                  <p className="text-sm mt-2" style={{ color: 'hsl(var(--foreground))' }}>Want to place this order again?</p>
                  <button
                    onClick={() => setShowReorderDialog(true)}
                    className="mt-2 px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-1.5"
                    style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(263, 70%, 60%))', color: '#fff' }}
                  >
                    <ShoppingCart size={14} /> Yes, place order again
                  </button>
                </div>
              </div>
            )}

            {/* Cancelled from email page (after prior WA/email confirm) */}
            {cancelledFromEmailPage && !cancelledFromAccount && !cancelledViaWhatsApp && !cancelledViaEmail && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                <Mail size={20} style={{ color: 'hsl(0, 72%, 55%)', flexShrink: 0, marginTop: 2 }} />
                <div className="flex-1">
                  <p className="font-semibold text-sm" style={{ color: 'hsl(0, 72%, 50%)' }}>You cancelled this order from email</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    No charges applied.
                  </p>
                  <p className="text-sm mt-2" style={{ color: 'hsl(var(--foreground))' }}>Want to place this order again?</p>
                  <button
                    onClick={() => setShowReorderDialog(true)}
                    className="mt-2 px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-1.5"
                    style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(263, 70%, 60%))', color: '#fff' }}
                  >
                    <ShoppingCart size={14} /> Yes, place order again
                  </button>
                </div>
              </div>
            )}

            {/* Generic confirmed (just confirmed fresh) */}
            {showGenericConfirmedBanner && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(16, 185, 129, 0.10)', border: '1px solid rgba(16,185,129,0.25)' }}>
                <CheckCircle2 size={20} style={{ color: 'hsl(150, 60%, 40%)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p className="font-semibold text-sm" style={{ color: 'hsl(150, 60%, 35%)' }}>Order confirmed!</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>The seller has been notified and will begin processing your order.</p>
                </div>
              </div>
            )}
            {actionDone === 'declined' && !cancelledViaWhatsApp && !cancelledViaEmail && !cancelledFromAccount && !cancelledFromEmailPage && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239,68,68,0.20)' }}>
                <XCircle size={20} style={{ color: 'hsl(0, 72%, 55%)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p className="font-semibold text-sm" style={{ color: 'hsl(0, 72%, 50%)' }}>Order cancelled</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>No charges applied.</p>
                </div>
              </div>
            )}
            {!actionDone && expired && (
              <div className="rounded-xl p-4 mb-5 flex items-start gap-3" style={{ background: 'rgba(249, 115, 22, 0.10)', border: '1px solid rgba(249,115,22,0.25)' }}>
                <Clock size={20} style={{ color: 'hsl(30, 90%, 50%)', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <p className="font-semibold text-sm" style={{ color: 'hsl(30, 90%, 45%)' }}>Link expired</p>
                  <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Please contact the seller to verify your order.</p>
                </div>
              </div>
            )}

            {/* Order summary */}
            <div className="glass-inner rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Order ID</span>
                <span className="text-sm font-bold" style={{ color: 'hsl(var(--primary))' }}>{order.orderId}</span>
              </div>
              <div className="space-y-2.5 mb-3">
                {order.orderItems.map((it, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }}>
                      {it.image ? <img src={it.image} alt={it.name} className="w-full h-full object-cover" /> : <Package size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'hsl(var(--foreground))' }}>{it.name}</p>
                      {formatOrderItemOptions(it) && (
                        <p className="text-xs leading-snug" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatOrderItemOptions(it)}</p>
                      )}
                      <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                        {hasExactOrderItemUnitEquation(it)
                          ? <>Qty: {it.quantity} × {orderMoney(it.price)}</>
                          : <>Qty: {it.quantity} · Complete line price</>}
                      </p>
                    </div>
                    <p className="text-sm font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(getOrderItemLineSubtotal(it))}</p>
                  </div>
                ))}
              </div>
              <div className="pt-3 mt-1 space-y-1.5" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
                <div className="flex justify-between text-xs"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Subtotal</span><span style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(summarySubtotal)}</span></div>
                <div className="flex justify-between text-xs"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping</span><span style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(summaryShipping)}</span></div>
                {summaryTax > 0 && (
                  <div className="flex justify-between text-xs"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Tax</span><span style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(summaryTax)}</span></div>
                )}
                {couponDiscount > 0 && (
                  <div className="flex justify-between text-xs" style={{ color: 'hsl(150, 60%, 40%)' }}><span>Coupon discount</span><span>-{orderMoney(couponDiscount)}</span></div>
                )}
                {reconciliationAdjustment !== 0 && (
                  <div className="flex justify-between text-xs"><span style={{ color: 'hsl(var(--muted-foreground))' }}>Rounding adjustment</span><span style={{ color: 'hsl(var(--foreground))' }}>{reconciliationAdjustment > 0 ? '+' : '-'}{orderMoney(Math.abs(reconciliationAdjustment))}</span></div>
                )}
                <div className="flex justify-between text-sm font-bold pt-1.5" style={{ borderTop: '1px solid var(--glass-border-subtle)', color: 'hsl(var(--foreground))' }}>
                  <span>Total</span><span style={{ color: 'hsl(var(--primary))' }}>{orderMoney(getOrderTotal(order))}</span>
                </div>
              </div>
            </div>

            <div className="glass-inner rounded-xl p-4 mb-5">
              <div className="flex items-center gap-2 mb-2">
                <MapPin size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />
                <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>Shipping to</span>
              </div>
              <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>{order.shippingInfo.fullName}</p>
              <p className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {order.shippingInfo.address}, {order.shippingInfo.city}, {order.shippingInfo.state} {order.shippingInfo.postalCode}, {order.shippingInfo.country}
              </p>
            </div>

            {/* Action buttons — only for undecided, non-expired */}
            {notYetDecided && !cancelledByAnotherActor && !confirmedViaWhatsApp && !cancelledViaWhatsApp && !confirmedViaEmail && !cancelledViaEmail && !cancelledFromAccount && !cancelledFromEmailPage && (
              <div className="flex flex-col sm:flex-row gap-3">
                <button onClick={handleConfirm} disabled={submitting}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all"
                  style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(263, 70%, 60%))', color: '#fff', opacity: submitting ? 0.6 : 1 }}>
                  {submitting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  Confirm Order
                </button>
                <button onClick={handleDecline} disabled={submitting}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all"
                  style={{ background: 'rgba(239, 68, 68, 0.10)', color: 'hsl(0, 72%, 55%)', border: '1px solid rgba(239,68,68,0.25)', opacity: submitting ? 0.6 : 1 }}>
                  <XCircle size={16} /> Cancel Order
                </button>
              </div>
            )}

            {actionDone && (
              <div className="text-center mt-4">
                <Link to="/" className="text-sm font-semibold" style={{ color: 'hsl(var(--primary))' }}>Back to Rozare</Link>
              </div>
            )}

            {/* Re-order confirmation dialog */}
            {showReorderDialog && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setShowReorderDialog(false)}>
                <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="glass-panel p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-lg font-semibold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Confirm this order again?</h3>
                  <div className="glass-inner rounded-xl p-3 mb-4 space-y-2">
                    {order.orderItems.map((it, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-md overflow-hidden flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          {it.image ? <img src={it.image} alt={it.name} className="w-full h-full object-cover" /> : <Package size={12} style={{ color: 'hsl(var(--muted-foreground))' }} />}
                        </div>
                        <span className="text-xs flex-1 min-w-0" style={{ color: 'hsl(var(--foreground))' }}>
                          <span className="block truncate">{it.name} x{it.quantity}</span>
                          {formatOrderItemOptions(it) && (
                            <span className="block truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatOrderItemOptions(it)}</span>
                          )}
                        </span>
                        <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{orderMoney(getOrderItemLineSubtotal(it))}</span>
                      </div>
                    ))}
                    <div className="pt-2 flex justify-between text-sm font-bold" style={{ borderTop: '1px solid var(--glass-border-subtle)' }}>
                      <span style={{ color: 'hsl(var(--foreground))' }}>Total</span>
                      <span style={{ color: 'hsl(var(--primary))' }}>{orderMoney(getOrderTotal(order))}</span>
                    </div>
                  </div>
                  <p className="text-sm mb-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    Are you sure you want to confirm this order? The seller will be notified.
                  </p>
                  <div className="flex justify-end gap-3">
                    <button onClick={() => setShowReorderDialog(false)} className="px-4 py-2 rounded-xl glass-inner font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>Cancel</button>
                    <button onClick={handleReconfirm} disabled={submitting} className="px-4 py-2 rounded-xl text-white font-medium text-sm inline-flex items-center gap-1.5" style={{ background: 'linear-gradient(135deg, hsl(var(--primary)), hsl(263, 70%, 60%))', opacity: submitting ? 0.6 : 1 }}>
                      {submitting ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                      Yes, confirm order
                    </button>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}
