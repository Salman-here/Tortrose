import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock3, CreditCard, Loader2, RefreshCw, WalletCards } from 'lucide-react';
import { toast } from 'react-toastify';
import { Link, useSearchParams } from 'react-router-dom';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/wallet`;
const currencies = ['USD', 'PKR', 'EUR', 'GBP'];
const TOP_UP_ATTEMPT_KEY = 'rozare_wallet_topup_attempt_v1';
const STRIPE_RETURN_KEY = 'rozare_stripe_return_v1';
const TOP_UP_ATTEMPT_MAX_AGE_MS = 60 * 60 * 1000;

const getTopUpAttempt = (amount, currency) => {
  const fingerprint = `${String(currency).toUpperCase()}:${Number(amount).toFixed(2)}`;
  try {
    const stored = JSON.parse(sessionStorage.getItem(TOP_UP_ATTEMPT_KEY) || 'null');
    const isFresh = Number(stored?.createdAt) > Date.now() - TOP_UP_ATTEMPT_MAX_AGE_MS;
    if (stored?.requestKey && stored.fingerprint === fingerprint && isFresh) return stored;
    if (stored) sessionStorage.removeItem(TOP_UP_ATTEMPT_KEY);
  } catch (_) {}
  const entropy = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const attempt = { requestKey: `web-wallet:${entropy}`, fingerprint, createdAt: Date.now() };
  try { sessionStorage.setItem(TOP_UP_ATTEMPT_KEY, JSON.stringify(attempt)); } catch (_) {}
  return attempt;
};

const clearTopUpAttempt = () => {
  try { sessionStorage.removeItem(TOP_UP_ATTEMPT_KEY); } catch (_) {}
};

const clearWalletStripeReturn = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STRIPE_RETURN_KEY) || '{}');
    if (saved?.checkoutSession?.path === window.location.pathname) delete saved.checkoutSession;
    sessionStorage.setItem(STRIPE_RETURN_KEY, JSON.stringify(saved));
  } catch (_) {}
};

const formatAmount = (amount, currency) => new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency,
  maximumFractionDigits: currency === 'PKR' ? 2 : 2,
}).format(Number(amount) || 0);

const getTransactionDescription = (transaction) => {
  if (transaction.type === 'top_up') {
    return `Rozare Wallet top-up of ${formatAmount(transaction.amount, transaction.currency)}`;
  }
  return transaction.description || transaction.type.replaceAll('_', ' ');
};

export default function Wallet() {
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('PKR');
  const [topUpStatus, setTopUpStatus] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await axios.get(`${API}/me?limit=100`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      setWallet(response.data?.wallet || null);
      setTransactions(response.data?.transactions || []);
    } catch (error) {
      if (!quiet) toast.error(error.response?.data?.msg || 'Failed to load Rozare Wallet.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const result = searchParams.get('top_up');
    if (!result) return undefined;
    const transactionId = searchParams.get('transactionId') || '';
    if (result !== 'success') {
      setTopUpStatus({ type: 'info', message: 'Stripe checkout was closed. No Wallet credit has been assumed.' });
      clearWalletStripeReturn();
      const next = new URLSearchParams(searchParams);
      next.delete('top_up');
      next.delete('session_id');
      next.delete('transactionId');
      setSearchParams(next, { replace: true });
      return undefined;
    }

    let active = true;
    const verify = async () => {
      if (!transactionId) {
        if (active) setTopUpStatus({ type: 'error', message: 'The Wallet top-up reference is missing. Refresh your transaction history before trying again.' });
        return;
      }
      setTopUpStatus({ type: 'pending', message: 'Stripe returned successfully. Rozare is verifying the signed payment event…' });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const response = await axios.get(`${API}/top-ups/${encodeURIComponent(transactionId)}/status`, {
            headers: { Authorization: `Bearer ${getAuthToken()}` },
          });
          const status = String(response.data?.status || '').toLowerCase();
          if (status === 'completed' && response.data?.webhookProcessed === true) {
            if (!active) return;
            setTopUpStatus({ type: 'success', message: 'Wallet top-up verified. Your available balance has been updated.' });
            clearTopUpAttempt();
            clearWalletStripeReturn();
            await load({ quiet: true });
            const next = new URLSearchParams(searchParams);
            next.delete('top_up');
            next.delete('session_id');
            next.delete('transactionId');
            setSearchParams(next, { replace: true });
            return;
          }
          if (['failed', 'cancelled', 'canceled', 'expired', 'reversed'].includes(status)) {
            if (!active) return;
            setTopUpStatus({ type: 'error', message: response.data?.failureReason || 'This Wallet top-up was not completed. No balance was credited.' });
            clearTopUpAttempt();
            return;
          }
        } catch (error) {
          if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 408) {
            if (active) setTopUpStatus({ type: 'error', message: error.response?.data?.msg || 'Rozare could not verify this Wallet top-up.' });
            return;
          }
        }
        if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (active) setTopUpStatus({ type: 'pending', message: 'Confirmation is taking longer than usual. Your balance will update only after Stripe is verified.' });
    };
    verify();
    return () => { active = false; };
  }, [load, searchParams, setSearchParams]);

  const startTopUp = async () => {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      toast.error('Enter a valid top-up amount.');
      return;
    }
    setSubmitting(true);
    try {
      const attempt = getTopUpAttempt(numericAmount, currency);
      const response = await axios.post(`${API}/top-ups`, {
        amount: numericAmount,
        currency,
        requestKey: attempt.requestKey,
        paymentFlow: 'checkout_session',
        clientSurface: 'web',
      }, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
      if (response.data?.url) window.location.assign(response.data.url);
      else if (response.data?.completed) {
        clearTopUpAttempt();
        await load();
        setSubmitting(false);
      }
      else if (response.data?.stripePaymentReceived && response.data?.transactionId) {
        setTopUpStatus({ type: 'pending', message: 'Stripe received your payment. Rozare is waiting for the signed confirmation before updating your balance.' });
        setSubmitting(false);
        setSearchParams({
          top_up: 'success',
          transactionId: String(response.data.transactionId),
        }, { replace: true });
      }
      else throw new Error('Stripe checkout URL was not returned.');
    } catch (error) {
      if (['IDEMPOTENCY_CONFLICT', 'WALLET_TOP_UP_RETRY_REQUIRED'].includes(error.response?.data?.code)) clearTopUpAttempt();
      toast.error(error.response?.data?.msg || error.message || 'Failed to start wallet top-up.');
      setSubmitting(false);
    }
  };

  if (loading) return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 size={26} className="animate-spin" /></div>;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <div className="tag-pill mb-3"><WalletCards size={12} /> Rozare Wallet</div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Wallet</h1>
          <p className="text-sm mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Top up, pay for orders, and receive verified return refunds.</p>
        </div>
        <button type="button" onClick={() => load()} className="glass-button px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2"><RefreshCw size={14} /> Refresh</button>
      </div>

      {wallet?.status !== 'active' && (
        <div className="rounded-xl p-4 mb-5" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,52%)' }}>
          Wallet access is locked. {wallet?.lockedReason || 'Contact Rozare support for help.'}
        </div>
      )}

      {topUpStatus && (
        <div
          className="rounded-2xl p-4 mb-5 flex items-start gap-3 text-sm"
          style={topUpStatus.type === 'success'
            ? { background: 'rgba(16,185,129,0.09)', border: '1px solid rgba(16,185,129,0.22)', color: 'hsl(150,60%,34%)' }
            : topUpStatus.type === 'error'
              ? { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,48%)' }
              : { background: 'rgba(245,158,11,0.09)', border: '1px solid rgba(245,158,11,0.22)', color: 'hsl(35,82%,38%)' }}
        >
          {topUpStatus.type === 'success'
            ? <CheckCircle2 size={18} className="shrink-0" />
            : topUpStatus.type === 'error'
              ? <AlertCircle size={18} className="shrink-0" />
              : <Clock3 size={18} className="shrink-0" />}
          <span>{topUpStatus.message}</span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {currencies.map((code, index) => (
          <motion.div key={code} className="glass-card p-4 sm:p-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}>
            <p className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>{code} balance</p>
            <p className="text-lg sm:text-xl font-extrabold mt-2 break-words" style={{ color: 'hsl(var(--foreground))' }}>{formatAmount(wallet?.balances?.[code] || 0, code)}</p>
          </motion.div>
        ))}
      </div>

      <div className="grid lg:grid-cols-[360px_minmax(0,1fr)] gap-5">
        <section className="glass-panel p-5 h-fit">
          <h2 className="font-semibold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}><CreditCard size={17} style={{ color: 'hsl(var(--primary))' }} /> Add balance</h2>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Stripe verifies payment before any balance is credited. You can select a saved card at secure checkout.</p>
          <Link to="/user-dashboard/payment-methods" className="mt-3 inline-flex items-center gap-2 text-xs font-semibold" style={{ color: 'hsl(var(--primary))' }}>
            <CreditCard size={13} /> Manage saved cards
          </Link>
          <label className="block text-xs font-semibold mt-5 mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Currency</label>
          <div className="grid grid-cols-4 gap-2">
            {currencies.map(code => (
              <button type="button" key={code} onClick={() => setCurrency(code)} className="py-2 rounded-lg text-xs font-bold transition-all"
                style={currency === code ? { background: 'hsl(var(--primary))', color: 'white' } : { background: 'rgba(255,255,255,0.06)', color: 'hsl(var(--muted-foreground))' }}>{code}</button>
            ))}
          </div>
          <label className="block text-xs font-semibold mt-4 mb-2" style={{ color: 'hsl(var(--muted-foreground))' }}>Amount</label>
          <input type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className="glass-input w-full" placeholder={`Amount in ${currency}`} />
          <button type="button" onClick={startTopUp} disabled={submitting || wallet?.status !== 'active'} className="mt-4 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: 'hsl(var(--primary))' }}>
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />} Continue to Stripe
          </button>
        </section>

        <section className="glass-panel overflow-hidden">
          <div className="p-4 sm:p-5" style={{ borderBottom: '1px solid var(--glass-border)' }}>
            <h2 className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Transaction history</h2>
          </div>
          {transactions.length === 0 ? (
            <div className="py-16 text-center text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>No wallet transactions yet.</div>
          ) : (
            <div>
              {transactions.map((transaction, index) => {
                const credit = transaction.direction === 'credit';
                const completed = transaction.status === 'completed';
                return (
                  <div key={transaction._id} className="p-4 sm:p-5 flex items-start gap-3" style={{ borderBottom: index < transactions.length - 1 ? '1px solid var(--glass-border-subtle)' : 'none' }}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: credit ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.1)', color: credit ? 'hsl(150,60%,38%)' : 'hsl(215,75%,50%)' }}>
                      {credit ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{getTransactionDescription(transaction)}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(transaction.createdAt).toLocaleString()} - {transaction.status}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold" style={{ color: completed ? (credit ? 'hsl(150,60%,38%)' : 'hsl(var(--foreground))') : 'hsl(var(--muted-foreground))' }}>{credit ? '+' : '-'}{formatAmount(transaction.amount, transaction.currency)}</p>
                      {transaction.balanceAfter !== null && transaction.balanceAfter !== undefined && <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Balance {formatAmount(transaction.balanceAfter, transaction.currency)}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
