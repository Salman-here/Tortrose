import axios from 'axios';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle, CheckCircle, Clock3, Loader2, RefreshCw, ShoppingBag } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { getAuthToken } from '../../utils/cookieHelper';
import { useAuth } from '../../contexts/AuthContext';
import { createOrderCompletionCheck, formatOrderReceiptTotal, orderCompletionPresentation } from '../../utils/orderCompletion';

export default function Success() {
  const { currentUser } = useAuth();
  const [params] = useSearchParams();
  const references = params.getAll('orderId');
  const reference = references.length === 1 ? references[0] : '';
  const buyerId = String(currentUser?._id || currentUser?.id || '');
  const [retry, setRetry] = useState(0);
  const scope = `${buyerId}:${reference}:${retry}`;
  const [verification, setVerification] = useState({ scope: '', status: 'checking', receipt: null, message: '' });

  useEffect(() => {
    const abort = new AbortController();
    const requestScope = `${buyerId}:${reference}:${retry}`;
    const check = createOrderCompletionCheck({ reference, buyerId, publish: value => setVerification({ ...value, scope: requestScope }),
      read: async requested => {
        const token = getAuthToken();
        if (!token) throw { response: { status: 401 } };
        const response = await axios.get(`${(import.meta.env.VITE_API_URL || 'https://rozare.up.railway.app').replace(/\/$/, '')}/api/order/receipt/${encodeURIComponent(requested)}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal, timeout: 30000 });
        return response.data;
      } });
    check.run();
    return () => { check.stop(); abort.abort(); };
  }, [reference, buyerId, retry]);

  useEffect(() => {
    const refresh = event => {
      if (event.persisted) {
        setVerification({ scope: '', status: 'checking', receipt: null, message: '' });
        setRetry(value => value + 1);
      }
    };
    window.addEventListener('pageshow', refresh);
    return () => window.removeEventListener('pageshow', refresh);
  }, []);

  // Hide a superseded owner's/order's receipt immediately, before effects run.
  // This page never clears cart, checkout draft, attempt or confirmation state.
  const view = verification.scope === scope ? verification
    : { status: buyerId ? 'checking' : 'signin', receipt: null, message: buyerId ? 'Loading your order confirmation securely…' : 'Sign in to view your order confirmation securely.' };
  const receipt = view.receipt;
  const presentation = receipt ? orderCompletionPresentation(receipt) : {
    tone: view.status === 'checking' ? 'warning' : 'neutral', eyebrow: 'Order confirmation',
    title: view.status === 'checking' ? 'Checking your order' : view.status === 'signin' ? 'Sign in to view your order' : 'Order confirmation unavailable',
    message: view.message,
  };
  const checking = view.status === 'checking';
  const positive = presentation.tone === 'success';
  const accent = positive ? 'hsl(150, 60%, 42%)' : presentation.tone === 'warning' ? 'hsl(38, 92%, 48%)' : 'hsl(220, 70%, 55%)';
  const loginHref = `/login?redirect=${encodeURIComponent(`/success?orderId=${encodeURIComponent(reference)}`)}`;

  return <div className="flex justify-center items-center min-h-screen px-4 py-10">
    <motion.div className="glass-panel p-7 sm:p-8 max-w-lg w-full text-center" initial={{ opacity: 0, scale: 0.96, y: 24 }}
      animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <motion.div initial={{ scale: 0.85 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 120 }} className="flex justify-center mb-6">
        <div className="glass-inner p-4 rounded-full" style={{ color: accent }}>
          {checking ? <Loader2 className="w-14 h-14 animate-spin" /> : positive ? <CheckCircle className="w-14 h-14" />
            : presentation.tone === 'warning' ? <Clock3 className="w-14 h-14" /> : <AlertCircle className="w-14 h-14" />}
        </div>
      </motion.div>
      <p className="text-[11px] font-bold tracking-[0.16em] uppercase mb-2" style={{ color: accent }}>{presentation.eyebrow}</p>
      <h1 className="text-2xl font-extrabold tracking-tight mb-3" style={{ color: 'hsl(var(--foreground))' }}>{presentation.title}</h1>
      <p role={checking || receipt ? 'status' : 'alert'} className="text-sm leading-relaxed mb-7" style={{ color: 'hsl(var(--muted-foreground))' }}>{presentation.message}</p>
      {receipt && <div className="glass-inner p-4 rounded-xl text-left space-y-3">
        <div className="flex items-center gap-3"><ShoppingBag className="w-5 h-5 shrink-0" style={{ color: accent }} />
          <div className="min-w-0"><p className="text-[11px] uppercase tracking-wide" style={{ color: 'hsl(var(--muted-foreground))' }}>Order reference</p>
            <p className="text-sm font-semibold break-all" style={{ color: 'hsl(var(--foreground))' }}>{receipt.orderId}</p></div></div>
        <div className="flex justify-between gap-3 text-sm"><span className="text-muted-foreground">Payment method</span><span className="font-semibold">{presentation.methodLabel}</span></div>
        <div className="flex justify-between gap-3 text-sm"><span className="text-muted-foreground">{presentation.originalTotal ? 'Original order total' : 'Order total'}</span>
          <span className="font-semibold">{formatOrderReceiptTotal(receipt)}</span></div>
      </div>}
      <div className="flex flex-wrap gap-3 justify-center mt-8">
        {view.status === 'signin' ? <Link className="glass-button-primary px-6 py-3 rounded-xl font-semibold" to={loginHref}>Sign in</Link> : <>
          {(view.status === 'unavailable' || receipt && !positive) && <button type="button" disabled={checking} onClick={() => setRetry(value => value + 1)}
            className="glass-button px-6 py-3 rounded-xl font-semibold inline-flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Check again</button>}
          {receipt && <Link className="glass-button-primary px-6 py-3 rounded-xl font-semibold" to="/">Continue Shopping</Link>}
          {receipt && <Link className="glass-button px-6 py-3 rounded-xl font-semibold" to={presentation.detailsHref}>View Order</Link>}
          <Link className="glass-button px-6 py-3 rounded-xl font-semibold" to="/user-dashboard/orders">My Orders</Link>
        </>}
      </div>
    </motion.div>
  </div>;
}
