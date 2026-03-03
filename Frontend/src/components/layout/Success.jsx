import axios from "axios";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { CheckCircle, Mail, CreditCard, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";

export default function Success() {
  const [session, setSession] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (sessionId) fetchSession(sessionId);
  }, []);

  const fetchSession = async (sessionId) => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/session/${sessionId}`);
      const sessionData = res.data?.session;
      setSession(sessionData);
      if (sessionData && window.GSM) {
        try {
          window.GSM.trackPurchase({ orderId: sessionData.metadata?.orderId || sessionData.id, amount: sessionData.amount_total / 100, customerEmail: sessionData.customer_details?.email, currency: 'USD' });
        } catch (gsmError) { console.error('GSM tracking failed:', gsmError); }
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
        <p className="text-sm mb-8" style={{ color: 'hsl(var(--muted-foreground))' }}>Your payment was processed successfully. A confirmation has been sent to your email.</p>

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

        <Link to="/">
          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.95 }}
            className="mt-8 px-6 py-3 rounded-xl font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 20px -4px hsl(220, 70%, 55%, 0.3)' }}
          >
            Continue Shopping
          </motion.button>
        </Link>
      </motion.div>
    </div>
  );
}
