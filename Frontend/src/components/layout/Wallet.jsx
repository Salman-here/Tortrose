import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, CreditCard, Loader2, RefreshCw, WalletCards } from 'lucide-react';
import { toast } from 'react-toastify';
import { useSearchParams } from 'react-router-dom';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/wallet`;
const currencies = ['USD', 'PKR', 'EUR', 'GBP'];

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
    if (result === 'success') toast.success('Payment received. Your wallet will update after Stripe verification.');
    if (result === 'cancelled') toast.info('Wallet top-up was cancelled.');
    if (result !== 'success') {
      const next = new URLSearchParams(searchParams);
      next.delete('top_up');
      next.delete('session_id');
      setSearchParams(next, { replace: true });
      return undefined;
    }
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      load({ quiet: true });
      if (attempts >= 6) {
        clearInterval(interval);
        const next = new URLSearchParams(searchParams);
        next.delete('top_up');
        next.delete('session_id');
        setSearchParams(next, { replace: true });
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [load, searchParams, setSearchParams]);

  const startTopUp = async () => {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      toast.error('Enter a valid top-up amount.');
      return;
    }
    setSubmitting(true);
    try {
      const response = await axios.post(`${API}/top-ups`, {
        amount: numericAmount,
        currency,
        requestKey: crypto.randomUUID(),
      }, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
      if (response.data?.url) window.location.assign(response.data.url);
      else if (response.data?.completed) await load();
      else throw new Error('Stripe checkout URL was not returned.');
    } catch (error) {
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
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Stripe verifies payment before any balance is credited.</p>
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
