import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle, Clock3, Loader2, RefreshCw, ShoppingBag } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getAuthToken } from '../../utils/cookieHelper';
import { useGlobal } from '../../contexts/GlobalContext';

const STRIPE_RETURN_KEY = 'rozare_stripe_return_v1';
const CHECKOUT_ATTEMPT_KEY = 'rozare_checkout_attempt_v1';
const ORDER_SUCCESS_KEY = 'rozare_order_success_v1';

const readCheckoutReturn = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STRIPE_RETURN_KEY) || '{}');
    const checkout = saved?.checkoutSession;
    const fresh = Number(checkout?.receivedAt) > Date.now() - (60 * 60 * 1000);
    return checkout?.path === window.location.pathname && fresh ? checkout : null;
  } catch (_) {
    return null;
  }
};

const forgetCheckoutReturn = (sessionId) => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STRIPE_RETURN_KEY) || '{}');
    if (!sessionId || saved?.checkoutSession?.id === sessionId) delete saved.checkoutSession;
    sessionStorage.setItem(STRIPE_RETURN_KEY, JSON.stringify(saved));
  } catch (_) {}
};

const readConfirmedOrder = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ORDER_SUCCESS_KEY) || 'null');
    const fresh = Number(saved?.receivedAt) > Date.now() - (60 * 60 * 1000);
    return fresh && ['cash_on_delivery', 'wallet'].includes(saved?.paymentMethod) ? saved : null;
  } catch (_) {
    return null;
  }
};

export default function Success() {
  const { fetchCart } = useGlobal();
  const query = new URLSearchParams(window.location.search);
  const [checkoutReturn] = useState(readCheckoutReturn);
  const [confirmedOrder] = useState(readConfirmedOrder);
  const requestedOrderId = query.get('orderId') || '';
  const confirmedStripe = checkoutReturn && (!requestedOrderId || checkoutReturn.orderId === requestedOrderId)
    ? checkoutReturn
    : null;
  const confirmedNonStripe = confirmedOrder && (!requestedOrderId || confirmedOrder.orderId === requestedOrderId)
    ? confirmedOrder
    : null;
  const paymentMethod = confirmedStripe?.id ? 'stripe' : confirmedNonStripe?.paymentMethod || 'unknown';
  const orderId = confirmedStripe?.orderId || confirmedNonStripe?.orderId || requestedOrderId;
  const sessionId = confirmedStripe?.id || '';
  const isStripe = paymentMethod === 'stripe';
  const isConfirmedNonStripe = ['cash_on_delivery', 'wallet'].includes(paymentMethod);
  const finalizedRef = useRef(false);
  const [verification, setVerification] = useState({
    status: isStripe ? 'checking' : isConfirmedNonStripe ? 'paid' : 'failed',
    message: isStripe
      ? 'Confirming your payment securely…'
      : isConfirmedNonStripe
        ? ''
        : 'No verified order completion was found. Open My Orders before attempting payment again.',
  });

  useEffect(() => {
    if (checkoutReturn && !confirmedStripe) forgetCheckoutReturn(checkoutReturn.id);
  }, [checkoutReturn, confirmedStripe]);

  const clearConfirmedCart = useCallback(async () => {
    if (finalizedRef.current) return;
    try {
      sessionStorage.removeItem('checkoutProgress_v1');
      sessionStorage.removeItem(CHECKOUT_ATTEMPT_KEY);
    } catch (_) {}
    forgetCheckoutReturn(sessionId);
    // The signed Stripe webhook removes only the purchased item quantities.
    // Never clear the whole cart here: the buyer may have added unrelated
    // products in another tab while Stripe was open.
    try {
      await fetchCart?.();
    } catch (error) {
      console.error('Confirmed order cart refresh failed:', error);
    }
    finalizedRef.current = true;
  }, [fetchCart, sessionId]);

  const verifyStripePayment = useCallback(async () => {
    const token = getAuthToken();
    if (!token || !orderId || !sessionId) {
      setVerification({
        status: 'failed',
        message: 'The secure payment reference is incomplete. Open My Orders before attempting another payment.',
      });
      return;
    }

    setVerification({ status: 'checking', message: 'Confirming your payment securely…' });
    let lastMessage = 'Stripe has received your return, but Rozare is still waiting for final confirmation.';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await axios.get(
          `${import.meta.env.VITE_API_URL}api/order/payment-status/${encodeURIComponent(orderId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: { sessionId },
          },
        );
        const result = response.data || {};
        if (result.status === 'paid' && result.webhookProcessed === true) {
          setVerification({ status: 'paid', message: 'Payment verified by Rozare.' });
          await clearConfirmedCart();
          return;
        }
        if (['cancelled', 'canceled', 'expired', 'failed'].includes(String(result.status).toLowerCase())) {
          setVerification({
            status: 'failed',
            message: result.failureMessage || 'This payment was not completed. Your cart has been kept.',
          });
          try { sessionStorage.removeItem(CHECKOUT_ATTEMPT_KEY); } catch (_) {}
          forgetCheckoutReturn(sessionId);
          return;
        }
        lastMessage = result.msg || lastMessage;
      } catch (error) {
        const status = error.response?.status;
        if (status >= 400 && status < 500 && status !== 408 && status !== 409) {
          setVerification({
            status: 'failed',
            message: error.response?.data?.msg || 'Rozare could not verify this payment reference.',
          });
          forgetCheckoutReturn(sessionId);
          return;
        }
        lastMessage = error.response?.data?.msg || lastMessage;
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1200));
    }
    setVerification({ status: 'pending', message: lastMessage });
  }, [clearConfirmedCart, orderId, sessionId]);

  useEffect(() => {
    if (isStripe) {
      verifyStripePayment();
    } else if (isConfirmedNonStripe) {
      try { sessionStorage.removeItem(ORDER_SUCCESS_KEY); } catch (_) {}
      clearConfirmedCart();
    }
  }, [clearConfirmedCart, isConfirmedNonStripe, isStripe, verifyStripePayment]);

  const paid = verification.status === 'paid';
  const checking = verification.status === 'checking';
  const pending = verification.status === 'pending';
  const failed = verification.status === 'failed';
  const title = paid
    ? 'Thank you for your order!'
    : checking
      ? 'Confirming your payment'
      : pending
        ? 'Payment confirmation is taking longer'
        : 'Payment not confirmed';
  const confirmationCopy = paid
    ? paymentMethod === 'wallet'
      ? 'Your Rozare Wallet payment is complete and your order is confirmed.'
      : paymentMethod === 'cash_on_delivery'
        ? 'Your order was placed. Confirm it using the button sent by WhatsApp or email.'
        : 'Your card payment was verified and your order is now confirmed.'
    : verification.message;
  const accent = paid ? 'hsl(150, 60%, 42%)' : failed ? 'hsl(0, 72%, 52%)' : 'hsl(38, 92%, 48%)';

  return (
    <div className="flex justify-center items-center min-h-screen px-4 py-10">
      <motion.div
        className="glass-panel p-7 sm:p-8 max-w-lg w-full text-center"
        initial={{ opacity: 0, scale: 0.96, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <motion.div initial={{ scale: 0.85 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 120 }} className="flex justify-center mb-6">
          <div className="glass-inner p-4 rounded-full" style={{ color: accent }}>
            {checking
              ? <Loader2 className="w-14 h-14 animate-spin" />
              : paid
                ? <CheckCircle className="w-14 h-14" />
                : pending
                  ? <Clock3 className="w-14 h-14" />
                  : <AlertCircle className="w-14 h-14" />}
          </div>
        </motion.div>

        <p className="text-[11px] font-bold tracking-[0.16em] uppercase mb-2" style={{ color: accent }}>
          {paid ? 'Order secured' : 'Secure payment check'}
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight mb-3" style={{ color: 'hsl(var(--foreground))' }}>{title}</h1>
        <p className="text-sm leading-relaxed mb-7" style={{ color: 'hsl(var(--muted-foreground))' }}>{confirmationCopy}</p>

        {!!orderId && (
          <div className="glass-inner p-4 rounded-xl text-left flex items-center gap-3">
            <ShoppingBag className="w-5 h-5 shrink-0" style={{ color: accent }} />
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>Order reference</p>
              <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{orderId}</p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3 justify-center mt-8">
          {(pending || failed) && isStripe && (
            <button
              type="button"
              onClick={verifyStripePayment}
              className="px-6 py-3 rounded-xl font-semibold text-white inline-flex items-center gap-2"
              style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}
            >
              <RefreshCw className="w-4 h-4" /> Check again
            </button>
          )}
          {paid && (
            <Link to="/">
              <button type="button" className="px-6 py-3 rounded-xl font-semibold text-white" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}>
                Continue Shopping
              </button>
            </Link>
          )}
          {failed && <Link to="/checkout"><button type="button" className="px-6 py-3 rounded-xl font-semibold glass-button">Return to checkout</button></Link>}
          <Link to="/user-dashboard/orders"><button type="button" className="px-6 py-3 rounded-xl font-semibold glass-button">My Orders</button></Link>
        </div>
      </motion.div>
    </div>
  );
}
