import axios from "axios";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle, Mail, CreditCard, DollarSign, WalletCards } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { getAuthToken } from "../../utils/cookieHelper";
import { trackPurchase } from "../../utils/tiktokPixel";

export default function Success() {
  const [session, setSession] = useState(null);
  const query = new URLSearchParams(window.location.search);
  const paymentMethod = query.get('payment') || (query.get('session_id') ? 'stripe' : 'cash_on_delivery');
  const orderId = query.get('orderId') || '';
  const confirmationCopy = paymentMethod === 'wallet'
    ? 'Your Rozare Wallet payment was completed and your order is confirmed.'
    : paymentMethod === 'cash_on_delivery'
      ? 'Your order was placed. Confirm it using the button sent by WhatsApp or email.'
      : 'Your card payment was processed successfully. A confirmation has been sent to your email.';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (sessionId) fetchSession(sessionId);

    // Clear cart after successful order
    clearCart();

    // Clear any saved in-progress checkout state
    try { sessionStorage.removeItem('checkoutProgress_v1'); } catch (_) {}
  }, []);

  const clearCart = async () => {
    try {
      const token = getAuthToken();
      if (token) {
        await axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`, {
          headers: { Authorization: `Bearer ${token}` }
        });
      }
      // Always clear guest cart
      localStorage.removeItem('guestCart');
    } catch (error) {
      console.error('Error clearing cart:', error);
    }
  };

  const fetchSession = async (sessionId) => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/session/${sessionId}`);
      const sessionData = res.data?.session;
      setSession(sessionData);
      const purchaseTrackKey = `tiktok_purchase_${sessionData?.id}`;
      if (sessionData?.payment_status === 'paid' && !sessionStorage.getItem(purchaseTrackKey)) {
        const lineItems = (sessionData.line_items?.data || []).map((item) => ({
          id: item.price?.product || item.id,
          name: item.description,
          price: item.quantity ? (item.amount_subtotal || item.amount_total || 0) / 100 / item.quantity : undefined,
          quantity: item.quantity || 1,
        }));
        trackPurchase({
          orderId: sessionData.metadata?.orderId || sessionData.id,
          cartItems: lineItems,
          totalAmount: (sessionData.amount_total || 0) / 100,
          currency: sessionData.currency?.toUpperCase() || 'USD',
          eventId: sessionData.metadata?.tiktokPurchaseEventId,
        });
        sessionStorage.setItem(purchaseTrackKey, '1');
      }
    } catch (error) { console.error(error); toast.error(error.response?.data?.msg); }
  };

  return (
    <div className="flex justify-center items-center min-h-screen px-4">
      <motion.div
        className="glass-panel p-8 max-w-lg w-full text-center"
        initial={{ opacity: 0, scale: 0.9, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 100, delay: 0.3 }} className="flex justify-center mb-6">
          <div className="glass-inner p-4 rounded-full" style={{ color: 'hsl(150, 60%, 45%)' }}>
            <CheckCircle className="w-16 h-16" />
          </div>
        </motion.div>

        <h1 className="text-2xl font-extrabold tracking-tight mb-3" style={{ color: 'hsl(var(--foreground))' }}>Thank you for your order!</h1>
        <p className="text-sm mb-8" style={{ color: 'hsl(var(--muted-foreground))' }}>{confirmationCopy}</p>

        {!session && orderId && (
          <div className="glass-inner p-3 rounded-xl text-left flex items-center gap-3">
            {paymentMethod === 'wallet' ? <WalletCards className="w-5 h-5" /> : <CheckCircle className="w-5 h-5" />}
            <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}><span className="font-semibold">Order:</span> {orderId}</p>
          </div>
        )}

        {session && (
          <motion.div className="space-y-3 text-left" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}>
            {[
              { icon: <CreditCard className="w-5 h-5" />, label: 'Payment Status', value: session.payment_status },
              { icon: <Mail className="w-5 h-5" />, label: 'Customer', value: session.customer_details.email },
              { icon: <DollarSign className="w-5 h-5" />, label: 'Total', value: `${session.amount_total / 100} ${session.currency.toUpperCase()}` },
            ].map((item, i) => (
              <div key={i} className="flex items-center glass-inner p-3 rounded-xl">
                <span className="mr-3" style={{ color: 'hsl(var(--primary))' }}>{item.icon}</span>
                <p className="text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                  <span className="font-semibold">{item.label}:</span> {item.value}
                </p>
              </div>
            ))}
          </motion.div>
        )}

        <div className="flex gap-3 justify-center mt-8">
          <Link to="/">
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.95 }}
              className="px-6 py-3 rounded-xl font-semibold text-white"
              style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
            >
              Continue Shopping
            </motion.button>
          </Link>
          <Link to="/track-order">
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.95 }}
              className="px-6 py-3 rounded-xl font-semibold glass-button"
              style={{ color: 'hsl(var(--foreground))' }}
            >
              Track Order
            </motion.button>
          </Link>
          {getAuthToken() && (
            <Link to="/user-dashboard/orders">
              <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.95 }} className="px-6 py-3 rounded-xl font-semibold glass-button" style={{ color: 'hsl(var(--foreground))' }}>
                Your Orders
              </motion.button>
            </Link>
          )}
        </div>
      </motion.div>
    </div>
  );
}
