import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { motion as Motion } from 'framer-motion';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock3, CreditCard, Loader2, RefreshCw, WalletCards } from 'lucide-react';
import { toast } from 'react-toastify';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getAuthToken } from '../../utils/cookieHelper';
import {
  canTopUpWalletCurrency,
  getTopUpCompletionBreakdown,
  getWalletCreditCompletionBreakdown,
  getWalletCurrencyRisk,
  inspectWalletTopUpCreateResponse,
  inspectWalletTopUpStatusResponse,
  isWalletRiskSettlementTopUp,
  requireWalletSummaryResponse,
  shouldRetainWalletTopUpAttempt,
} from '../../utils/walletPaymentRisk';
import {
  SUPPORTED_CURRENCY_CODES,
  roundCurrencyAmount,
} from '../../utils/currencySafety';
import {
  clearPersistedMutationAttemptFromLedger,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttemptInLedger,
} from '../../utils/persistedMutationAttempt';

const API = `${import.meta.env.VITE_API_URL}api/wallet`;
const currencies = SUPPORTED_CURRENCY_CODES;
const TOP_UP_ATTEMPT_KEY = 'rozare_wallet_topup_attempt_v1';
const STRIPE_RETURN_KEY = 'rozare_stripe_return_v1';
const TOP_UP_RETURN_KEY = 'rozare_wallet_topup_return_v1';

const parseTopUpAmount = (raw) => {
  if (typeof raw !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(raw.trim())) return null;
  const value = Number(raw);
  if (
    !Number.isFinite(value)
    || value <= 0
    || roundCurrencyAmount(value) !== value
  ) return null;
  return value;
};

const clearWalletStripeReturn = () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STRIPE_RETURN_KEY) || '{}');
    if (saved?.checkoutSession?.path === window.location.pathname) delete saved.checkoutSession;
    sessionStorage.setItem(STRIPE_RETURN_KEY, JSON.stringify(saved));
  } catch {
    // Best-effort cleanup only.
  }
};

const rememberWalletTopUpReturn = ({
  transactionId,
  attemptStorageKey,
  attemptFingerprint,
  attemptKey,
}) => {
  if (!transactionId || !attemptStorageKey || !attemptFingerprint || !attemptKey) return false;
  try {
    const record = {
      transactionId: String(transactionId),
      attemptStorageKey,
      attemptFingerprint,
      attemptKey,
      createdAt: Date.now(),
    };
    sessionStorage.setItem(TOP_UP_RETURN_KEY, JSON.stringify(record));
    const confirmed = JSON.parse(sessionStorage.getItem(TOP_UP_RETURN_KEY) || 'null');
    return confirmed?.transactionId === record.transactionId
      && confirmed?.attemptStorageKey === record.attemptStorageKey
      && confirmed?.attemptFingerprint === record.attemptFingerprint
      && confirmed?.attemptKey === record.attemptKey
      && confirmed?.createdAt === record.createdAt;
  } catch {
    return false;
  }
};

const readWalletTopUpReturn = (transactionId) => {
  try {
    const record = JSON.parse(sessionStorage.getItem(TOP_UP_RETURN_KEY) || 'null');
    const fresh = Number(record?.createdAt) > Date.now() - (60 * 60 * 1000);
    return fresh && String(record?.transactionId || '') === String(transactionId || '')
      ? record
      : null;
  } catch {
    return null;
  }
};

const forgetWalletTopUpReturn = (transactionId) => {
  try {
    const record = JSON.parse(sessionStorage.getItem(TOP_UP_RETURN_KEY) || 'null');
    if (!transactionId || String(record?.transactionId || '') === String(transactionId)) {
      sessionStorage.removeItem(TOP_UP_RETURN_KEY);
    }
  } catch {
    // Best-effort cleanup only.
  }
};

const formatAmount = (amount, currency) => {
  if (
    typeof amount !== 'number'
    || !Number.isFinite(amount)
    || amount < 0
    || Object.is(amount, -0)
    || roundCurrencyAmount(amount) !== amount
    || !currencies.includes(currency)
  ) {
    const error = new Error('The stored Wallet money snapshot is invalid.');
    error.code = 'WALLET_PRESENTATION_DATA_INVALID';
    throw error;
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
};

const getTransactionDescription = (transaction) => {
  if (transaction.type === 'top_up') {
    return `Rozare Wallet top-up of ${formatAmount(transaction.amount, transaction.currency)}`;
  }
  return transaction.description || transaction.type.replaceAll('_', ' ');
};

const getTopUpCompletionMessage = (transaction) => {
  const breakdown = getTopUpCompletionBreakdown(transaction);
  if (!breakdown) {
    return 'Wallet top-up verified. Your current available balance and payment-risk liability have been refreshed.';
  }
  const currency = breakdown.currency;
  return [
    `Available balance credited: ${formatAmount(breakdown.creditedAmount, currency)}.`,
    `Applied to payment-risk liability: ${formatAmount(breakdown.appliedToLiability, currency)}.`,
    `Remaining liability: ${formatAmount(breakdown.remainingLiability, currency)}.`,
  ].join(' ');
};

export default function Wallet() {
  const { currentUser } = useAuth();
  const topUpAttemptStorageKey = createScopedMutationStorageKey(
    TOP_UP_ATTEMPT_KEY,
    currentUser?._id || currentUser?.id || 'guest'
  );
  const clearTopUpAttempt = useCallback(async (
    fingerprint = '',
    attemptKey = '',
    storageKey = topUpAttemptStorageKey,
  ) => {
    if (fingerprint && attemptKey) {
      return clearPersistedMutationAttemptFromLedger(
        localStorage,
        storageKey,
        fingerprint,
        attemptKey,
      );
    }
    return false;
  }, [topUpAttemptStorageKey]);
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('PKR');
  const [topUpStatus, setTopUpStatus] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const loadRequestRef = useRef(0);
  const selectedRisk = getWalletCurrencyRisk(wallet, currency);
  const canTopUpSelectedCurrency = canTopUpWalletCurrency(wallet, currency);
  const isRiskSettlement = isWalletRiskSettlementTopUp(wallet, currency);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    try {
      const response = await axios.get(`${API}/me?limit=100`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      });
      const inspected = requireWalletSummaryResponse(response.data);
      if (requestId !== loadRequestRef.current) return null;
      setWallet(inspected.wallet);
      setTransactions(inspected.transactions);
      setLoadError('');
      return inspected;
    } catch (error) {
      if (requestId !== loadRequestRef.current) return null;
      setWallet(null);
      setTransactions([]);
      const message = error.code === 'WALLET_PRESENTATION_DATA_INVALID'
        ? 'Rozare Wallet data could not be verified, so balances and transactions are hidden. Refresh or contact support.'
        : (error.response?.data?.msg || 'Failed to load Rozare Wallet.');
      setLoadError(message);
      toast.error(message);
      return null;
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const result = searchParams.get('top_up');
    if (!result) return undefined;
    const transactionId = searchParams.get('transactionId') || '';
    const topUpReturn = readWalletTopUpReturn(transactionId);
    let active = true;
    const clearReturnQuery = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('top_up');
      next.delete('session_id');
      next.delete('transactionId');
      setSearchParams(next, { replace: true });
    };
    const verify = async () => {
      if (!transactionId || !topUpReturn?.attemptStorageKey || !topUpReturn?.attemptFingerprint || !topUpReturn?.attemptKey) {
        if (active) setTopUpStatus({ type: 'error', message: 'This return is missing secure top-up correlation. No retry key or Wallet credit was changed.' });
        clearWalletStripeReturn();
        clearReturnQuery();
        return;
      }
      setTopUpStatus({
        type: 'pending',
        message: result === 'success'
          ? 'Stripe returned successfully. Rozare is verifying the signed payment event…'
          : 'Stripe checkout was closed. Rozare is verifying the exact top-up before deciding its final status…',
      });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const response = await axios.get(`${API}/top-ups/${encodeURIComponent(transactionId)}/status`, {
            headers: { Authorization: `Bearer ${getAuthToken()}` },
          });
          const inspected = inspectWalletTopUpStatusResponse(response.data, transactionId);
          if (!inspected.valid) {
            const presentationError = new Error(`Wallet top-up status could not be verified: ${inspected.errors[0]}`);
            presentationError.code = 'WALLET_PRESENTATION_DATA_INVALID';
            throw presentationError;
          }
          if (!active) return;
          // This owner-scoped status response contains a newer complete Wallet
          // summary. Retire any slower /me request before committing it.
          loadRequestRef.current += 1;
          setWallet(inspected.wallet);
          setTransactions(inspected.transactions);
          setLoadError('');
          setLoading(false);
          const status = inspected.status;
          if (status === 'completed') {
            if (!active) return;
            setTopUpStatus({ type: 'success', message: getTopUpCompletionMessage(inspected.transaction) });
            await clearTopUpAttempt(
              topUpReturn.attemptFingerprint,
              topUpReturn.attemptKey,
              topUpReturn.attemptStorageKey,
            );
            forgetWalletTopUpReturn(transactionId);
            clearWalletStripeReturn();
            clearReturnQuery();
            return;
          }
          if (['failed', 'cancelled', 'expired', 'reversed'].includes(status)) {
            if (!active) return;
            setTopUpStatus({ type: 'error', message: inspected.failureReason || 'This Wallet top-up was not completed. No balance was credited.' });
            await clearTopUpAttempt(
              topUpReturn.attemptFingerprint,
              topUpReturn.attemptKey,
              topUpReturn.attemptStorageKey,
            );
            forgetWalletTopUpReturn(transactionId);
            clearWalletStripeReturn();
            clearReturnQuery();
            return;
          }
        } catch (error) {
          if (error.code === 'WALLET_PRESENTATION_DATA_INVALID') {
            if (active) {
              loadRequestRef.current += 1;
              setWallet(null);
              setTransactions([]);
              setLoadError('Wallet top-up status data could not be verified, so financial values are hidden. Refresh to retry safely.');
              setTopUpStatus({ type: 'error', message: 'Rozare could not verify the returned Wallet money snapshot. The same top-up key is preserved and no local success was assumed.' });
              setLoading(false);
            }
            return;
          }
          if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 408) {
            if (active) setTopUpStatus({ type: 'error', message: error.response?.data?.msg || 'Rozare could not verify this Wallet top-up.' });
            // A redirect or an HTTP classification is not a terminal Wallet
            // state. Preserve the exact key until this owner-scoped endpoint
            // returns the transaction's completed/failed/cancelled status.
            clearReturnQuery();
            return;
          }
        }
        if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1200));
      }
      if (active) setTopUpStatus({ type: 'pending', message: 'Confirmation is taking longer than usual. The same top-up key is preserved; your balance will update only after Stripe is verified.' });
      clearReturnQuery();
    };
    verify();
    return () => { active = false; };
  }, [clearTopUpAttempt, searchParams, setSearchParams]);

  const startTopUp = async () => {
    const normalizedAmount = parseTopUpAmount(amount);
    if (normalizedAmount === null) {
      toast.error('Enter a positive amount with no more than two decimal places.');
      return;
    }
    if (!canTopUpSelectedCurrency) {
      toast.error(wallet?.lockedReason || 'This Wallet cannot accept a top-up right now.');
      return;
    }
    setSubmitting(true);
    const fingerprint = `${currentUser?._id || currentUser?.id || 'guest'}:${String(currency).toUpperCase()}:${normalizedAmount.toFixed(2)}`;
    let attemptKey = '';
    try {
      const attempt = await getOrCreatePersistedMutationAttemptInLedger({
        storage: localStorage,
        storageKey: topUpAttemptStorageKey,
        fingerprint,
        keyPrefix: 'web-wallet',
      });
      attemptKey = attempt.key;
      const response = await axios.post(`${API}/top-ups`, {
        amount: normalizedAmount,
        currency,
        requestKey: attempt.key,
        paymentFlow: 'checkout_session',
        clientSurface: 'web',
      }, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
      const inspected = inspectWalletTopUpCreateResponse(response.data, {
        amount: normalizedAmount,
        currency,
      });
      if (!inspected.valid) {
        const presentationError = new Error(`Wallet top-up response could not be verified: ${inspected.errors[0]}`);
        presentationError.code = 'WALLET_PRESENTATION_DATA_INVALID';
        throw presentationError;
      }
      if (inspected.kind === 'redirect') {
        // Do not leave for hosted checkout unless this exact ledger generation
        // can be correlated again on the return page.
        const returnSaved = rememberWalletTopUpReturn({
          transactionId: inspected.transactionId,
          attemptStorageKey: topUpAttemptStorageKey,
          attemptFingerprint: fingerprint,
          attemptKey: attempt.key,
        });
        if (!returnSaved) {
          const correlationError = new Error('Secure top-up return correlation could not be saved. Enable site storage and retry.');
          correlationError.retainMutationAttempt = true;
          throw correlationError;
        }
        window.location.assign(inspected.redirectUrl);
      }
      else if (inspected.kind === 'completed') {
        await clearTopUpAttempt(fingerprint, attempt.key);
        forgetWalletTopUpReturn(inspected.transactionId);
        setTopUpStatus({ type: 'success', message: getTopUpCompletionMessage(inspected.transaction) });
        await load();
        setSubmitting(false);
      }
      else if (inspected.kind === 'payment_received') {
        if (!rememberWalletTopUpReturn({
          transactionId: inspected.transactionId,
          attemptStorageKey: topUpAttemptStorageKey,
          attemptFingerprint: fingerprint,
          attemptKey: attempt.key,
        })) {
          const correlationError = new Error('Secure top-up return correlation could not be saved.');
          correlationError.retainMutationAttempt = true;
          throw correlationError;
        }
        setTopUpStatus({ type: 'pending', message: 'Stripe received your payment. Rozare is waiting for the signed confirmation before updating your balance.' });
        setSubmitting(false);
        setSearchParams({
          top_up: 'success',
          transactionId: inspected.transactionId,
        }, { replace: true });
      }
      else {
        const responseError = new Error('Stripe checkout URL was not returned.');
        responseError.retainMutationAttempt = true;
        throw responseError;
      }
    } catch (error) {
      if (!error.retainMutationAttempt && !shouldRetainWalletTopUpAttempt(error)) {
        await clearTopUpAttempt(fingerprint, attemptKey);
      }
      if (error.code === 'WALLET_PRESENTATION_DATA_INVALID') {
        loadRequestRef.current += 1;
        setWallet(null);
        setTransactions([]);
        setLoadError('The Wallet top-up response could not be verified. Existing financial values are hidden until an authoritative refresh succeeds.');
        setLoading(false);
      }
      toast.error(error.response?.data?.msg || error.message || 'Failed to start wallet top-up.');
      setSubmitting(false);
    }
  };

  if (loading) return <div className="min-h-[60vh] flex items-center justify-center"><Loader2 size={26} className="animate-spin" /></div>;

  if (!wallet) {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="tag-pill mb-3"><WalletCards size={12} /> Rozare Wallet</div>
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Wallet</h1>
        <div className="glass-panel p-5 mt-6" style={{ border: '1px solid rgba(239,68,68,0.25)' }}>
          <div className="flex items-start gap-3" style={{ color: 'hsl(0,72%,48%)' }}>
            <AlertCircle size={20} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Wallet financial data is unavailable</p>
              <p className="text-sm mt-1">{loadError || 'Rozare could not load an authoritative Wallet snapshot.'}</p>
              {topUpStatus?.message && <p className="text-xs mt-2">{topUpStatus.message}</p>}
            </div>
          </div>
          <button type="button" onClick={() => load()} className="glass-button px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 mt-4">
            <RefreshCw size={14} /> Retry Wallet refresh
          </button>
        </div>
      </div>
    );
  }

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

      {wallet && wallet.status !== 'active' && (
        <div className="rounded-xl p-4 mb-5" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,52%)' }}>
          Wallet access is locked. {wallet?.lockedReason || 'Contact Rozare support for help.'}
          {wallet?.paymentRisk?.canTopUpForSettlement === true && (
            <p className="text-xs mt-1">Checkout remains blocked. Stripe top-ups are allowed only for a currency with outstanding payment-risk liability. Each verified payment reduces that liability first; the Wallet stays locked while debt remains, and only surplus after full clearance becomes available.</p>
          )}
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
        {currencies.map((code, index) => {
          const risk = getWalletCurrencyRisk(wallet, code);
          return (
            <Motion.div key={code} className="glass-card p-4 sm:p-5" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}>
              <p className="text-xs font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>{code} available balance</p>
              <p className="text-lg sm:text-xl font-extrabold mt-2 break-words" style={{ color: 'hsl(var(--foreground))' }}>{formatAmount(wallet.balances[code], code)}</p>
              {(risk.held !== null || risk.outstanding !== null) && (
                <div className="mt-3 pt-3 text-[11px] space-y-1" style={{ borderTop: '1px solid var(--glass-border-subtle)', color: 'hsl(var(--muted-foreground))' }}>
                  {risk.held !== null && <p>Held: <span className="font-semibold">{formatAmount(risk.held, code)}</span></p>}
                  {risk.outstanding !== null && <p>Outstanding liability: <span className="font-semibold">{formatAmount(risk.outstanding, code)}</span></p>}
                </div>
              )}
            </Motion.div>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-[360px_minmax(0,1fr)] gap-5">
        <section className="glass-panel p-5 h-fit">
          <h2 className="font-semibold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}><CreditCard size={17} style={{ color: 'hsl(var(--primary))' }} /> {isRiskSettlement ? 'Settle liability' : 'Add balance'}</h2>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{isRiskSettlement
            ? `${formatAmount(selectedRisk.outstanding, currency)} is outstanding. Any valid top-up reduces it first; a partial payment leaves the Wallet locked, while surplus after full clearance becomes available.`
            : 'Stripe verifies payment before any balance is credited. You can select a saved card at secure checkout.'}</p>
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
          {!canTopUpSelectedCurrency && wallet && wallet.status !== 'active' && (
            <p className="text-xs mt-2" style={{ color: 'hsl(0,72%,52%)' }}>Top-up is unavailable for {currency}. Select a currency with an outstanding liability, or contact support if this is not a payment-risk lock.</p>
          )}
          <button type="button" onClick={startTopUp} disabled={submitting || !canTopUpSelectedCurrency} className="mt-4 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: 'hsl(var(--primary))' }}>
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />} {isRiskSettlement ? 'Pay liability with Stripe' : 'Continue to Stripe'}
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
                const creditBreakdown = getWalletCreditCompletionBreakdown(transaction);
                const displayedAmount = creditBreakdown?.creditedAmount ?? transaction.amount;
                return (
                  <div key={transaction._id} className="p-4 sm:p-5 flex items-start gap-3" style={{ borderBottom: index < transactions.length - 1 ? '1px solid var(--glass-border-subtle)' : 'none' }}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: credit ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.1)', color: credit ? 'hsl(150,60%,38%)' : 'hsl(215,75%,50%)' }}>
                      {credit ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{getTransactionDescription(transaction)}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(transaction.createdAt).toLocaleString()} - {transaction.status}</p>
                      {creditBreakdown && (
                        <p className="text-[11px] mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          Available +{formatAmount(creditBreakdown.creditedAmount, creditBreakdown.currency)} · Applied to liability {formatAmount(creditBreakdown.appliedToLiability, creditBreakdown.currency)} · Remaining {formatAmount(creditBreakdown.remainingLiability, creditBreakdown.currency)}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold" style={{ color: completed ? (credit ? 'hsl(150,60%,38%)' : 'hsl(var(--foreground))') : 'hsl(var(--muted-foreground))' }}>{credit ? '+' : '-'}{formatAmount(displayedAmount, transaction.currency)}</p>
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
