import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CreditCard,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { getAuthToken } from '../../utils/cookieHelper';

const API = `${import.meta.env.VITE_API_URL}api/payment-methods`;
const CONSENT_VERSION = '2026-08-01';

const authHeaders = () => ({ Authorization: `Bearer ${getAuthToken()}` });

const normalizeCard = (paymentMethod = {}) => {
  const card = paymentMethod.card || {};
  return {
    id: paymentMethod.id || paymentMethod.paymentMethodId,
    brand: String(card.brand || paymentMethod.brand || 'card').toLowerCase(),
    last4: card.last4 || paymentMethod.last4 || '••••',
    expMonth: Number(card.expMonth || card.exp_month || paymentMethod.expMonth || paymentMethod.exp_month || 0),
    expYear: Number(card.expYear || card.exp_year || paymentMethod.expYear || paymentMethod.exp_year || 0),
    funding: card.funding || paymentMethod.funding || '',
    country: card.country || paymentMethod.country || '',
    walletType: card.walletType || card.wallet?.type || paymentMethod.walletType || '',
    name: paymentMethod.billing_details?.name || paymentMethod.billingName || '',
    isDefault: Boolean(paymentMethod.isDefault),
  };
};

const brandLabel = (brand) => ({
  amex: 'American Express',
  diners: 'Diners Club',
  mastercard: 'Mastercard',
  unionpay: 'UnionPay',
  visa: 'Visa',
}[brand] || brand.replace(/_/g, ' ').replace(/\b\w/g, character => character.toUpperCase()));

const brandMark = (brand) => ({
  amex: 'AMEX',
  diners: 'DC',
  discover: 'DISCOVER',
  jcb: 'JCB',
  mastercard: 'MC',
  unionpay: 'UP',
  visa: 'VISA',
}[brand] || 'CARD');

const isExpiringSoon = ({ expMonth, expYear }) => {
  if (!expMonth || !expYear) return false;
  const now = new Date();
  const expiry = new Date(expYear, expMonth, 1);
  const threeMonthsFromNow = new Date(now.getFullYear(), now.getMonth() + 3, 1);
  return expiry <= threeMonthsFromNow;
};

function SavedCard({ card, isDefault, busy, onMakeDefault, onRemove }) {
  const expiryWarning = isExpiringSoon(card);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="glass-card relative overflow-hidden p-5 min-h-[190px]"
      style={{ borderColor: isDefault ? 'hsla(220, 78%, 61%, 0.42)' : undefined }}
    >
      <div
        className="absolute -right-12 -top-16 h-40 w-40 rounded-full blur-3xl pointer-events-none"
        style={{ background: isDefault ? 'hsla(220, 85%, 62%, 0.24)' : 'hsla(180, 75%, 50%, 0.12)' }}
      />
      <div className="relative flex h-full flex-col justify-between gap-8">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="h-11 w-14 rounded-xl flex items-center justify-center text-[11px] font-black tracking-tight"
              style={{
                color: 'white',
                background: 'linear-gradient(135deg, hsl(178, 78%, 42%), hsl(224, 82%, 62%) 58%, hsl(252, 76%, 63%))',
                boxShadow: '0 10px 24px hsla(220, 70%, 45%, 0.2)',
              }}
            >
              {brandMark(card.brand)}
            </div>
            <div>
              <p className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>{brandLabel(card.brand)}</p>
              <p className="text-xs capitalize" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {[card.funding, card.walletType ? `${card.walletType} wallet` : ''].filter(Boolean).join(' · ') || 'Saved payment card'}
              </p>
            </div>
          </div>
          {isDefault && (
            <span className="tag-pill shrink-0" style={{ color: 'hsl(220, 72%, 50%)' }}>
              <Check size={12} /> Default
            </span>
          )}
        </div>

        <div>
          <p className="text-xl font-extrabold tracking-[0.16em]" style={{ color: 'hsl(var(--foreground))' }}>
            •••• {card.last4}
          </p>
          <div className="mt-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'hsl(var(--muted-foreground))' }}>Expires</p>
              <p className="text-sm font-semibold" style={{ color: expiryWarning ? 'hsl(30, 85%, 48%)' : 'hsl(var(--foreground))' }}>
                {String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}
                {expiryWarning ? ' · Update soon' : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!isDefault && (
                <button
                  type="button"
                  onClick={() => onMakeDefault(card.id)}
                  disabled={busy}
                  className="glass-button rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-50"
                >
                  Make default
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove(card)}
                disabled={busy}
                aria-label={`Remove ${brandLabel(card.brand)} ending ${card.last4}`}
                className="glass-button rounded-xl p-2.5 disabled:opacity-50"
                style={{ color: 'hsl(0, 72%, 54%)' }}
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.article>
  );
}

function SaveCardForm({ returnUrl, onSaved, onCancel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError('');

    const result = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: returnUrl,
        // The checked consent immediately above authorizes redisplay during
        // future customer-initiated Rozare checkouts.
        payment_method_data: { allow_redisplay: 'always' },
      },
      redirect: 'if_required',
    });

    if (result.error) {
      setError(result.error.message || 'Stripe could not save this card. Please review the details and try again.');
      setSubmitting(false);
      return;
    }
    if (result.setupIntent?.status === 'succeeded') {
      await onSaved();
      return;
    }

    setError('Card verification is still processing. Please wait a moment and refresh your saved cards.');
    setSubmitting(false);
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="glass-inner rounded-2xl p-3 sm:p-4">
        <PaymentElement options={{ layout: 'tabs' }} />
      </div>

      <div className="glass-inner rounded-2xl p-4 flex items-start gap-3">
        <ShieldCheck size={17} className="mt-0.5 shrink-0" style={{ color: 'hsl(var(--primary))' }} />
        <span className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
          Your consent was recorded before this secure Stripe form opened. This card will be available only for payments you choose to make.
        </span>
      </div>
      <p className="text-[11px] leading-relaxed px-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
        Card details are handled by Stripe. Saving a card is subject to Rozare's{' '}
        <Link to="/terms" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">Terms</Link>{' '}
        and <Link to="/privacy" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">Privacy Policy</Link>.
      </p>

      {error && (
        <div className="rounded-xl p-3 flex items-start gap-2 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,48%)' }}>
          <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
        <button type="button" onClick={onCancel} disabled={submitting} className="glass-button rounded-xl px-5 py-2.5 text-sm font-semibold disabled:opacity-50">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || !elements || submitting}
          className="rounded-xl px-5 py-2.5 text-sm font-bold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: 'linear-gradient(135deg, hsl(178, 78%, 42%), hsl(224, 82%, 61%), hsl(252, 76%, 63%))', boxShadow: '0 12px 28px hsla(220, 70%, 48%, 0.22)' }}
        >
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <LockKeyhole size={16} />}
          {submitting ? 'Verifying securely…' : 'Save card securely'}
        </button>
      </div>
    </form>
  );
}

export default function PaymentMethods() {
  const location = useLocation();
  const [config, setConfig] = useState(null);
  const [cards, setCards] = useState([]);
  const [defaultPaymentMethodId, setDefaultPaymentMethodId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [setupConsent, setSetupConsent] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const setupRequestKeyRef = useRef('');

  const stripePromise = useMemo(
    () => config?.publishableKey ? loadStripe(config.publishableKey) : null,
    [config?.publishableKey]
  );

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setLoadError('');
    try {
      const [configResponse, methodsResponse] = await Promise.all([
        axios.get(`${API}/config`, { headers: authHeaders() }),
        axios.get(API, { headers: authHeaders() }),
      ]);
      const configData = configResponse.data?.config || configResponse.data || {};
      const methodsData = methodsResponse.data || {};
      setConfig(configData);
      const normalizedCards = (methodsData.paymentMethods || methodsData.cards || []).map(normalizeCard).filter(card => card.id);
      setCards(normalizedCards);
      setDefaultPaymentMethodId(
        methodsData.defaultPaymentMethodId
        || methodsData.default_payment_method
        || normalizedCards.find(card => card.isDefault)?.id
        || null
      );
    } catch (error) {
      setLoadError(error.response?.data?.msg || 'Your saved cards could not be loaded securely.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('rozare_stripe_return_v1') || '{}');
      const setupReturn = saved?.paymentMethodSetup;
      const isFresh = Number(setupReturn?.receivedAt) > Date.now() - (60 * 60 * 1000);
      if (!setupReturn || setupReturn.path !== location.pathname || !isFresh) return;

      delete saved.paymentMethodSetup;
      sessionStorage.setItem('rozare_stripe_return_v1', JSON.stringify(saved));
      const succeeded = setupReturn.redirectStatus === 'succeeded';
      setStatus(succeeded
        ? { type: 'info', message: 'Secure Stripe return received. Only cards confirmed in the verified list below are available for reuse.' }
        : { type: 'error', message: 'Card verification was not confirmed. No saved card has been assumed.' });
      load({ quiet: true });
    } catch (_) {}
  }, [load, location.pathname, location.search]);

  const beginAddCard = async () => {
    setStatus(null);
    setSetupConsent(false);
    setupRequestKeyRef.current = '';
    setConsentOpen(true);
  };

  const createSetup = async () => {
    if (!setupConsent) return;
    if (setupLoading) return;
    setSetupLoading(true);
    setStatus(null);
    try {
      const requestKey = setupRequestKeyRef.current || `web-card-setup:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      setupRequestKeyRef.current = requestKey;
      const response = await axios.post(`${API}/setup`, {
        clientSurface: 'web',
        consentAccepted: true,
        consentVersion: CONSENT_VERSION,
        requestKey,
      }, { headers: { ...authHeaders(), 'Idempotency-Key': requestKey } });
      const secret = response.data?.setupIntentClientSecret || response.data?.clientSecret;
      if (!secret) throw new Error('Stripe did not return a secure setup session.');
      setConsentOpen(false);
      setSetupConsent(false);
      setSetupSecret(secret);
    } catch (error) {
      setStatus({ type: 'error', message: error.response?.data?.msg || error.message || 'Could not start secure card setup.' });
    } finally {
      setSetupLoading(false);
    }
  };

  const handleSaved = async () => {
    setSetupSecret('');
    setupRequestKeyRef.current = '';
    setStatus({ type: 'success', message: 'Your card was saved securely and is ready for future checkouts.' });
    await load({ quiet: true });
  };

  const makeDefault = async (paymentMethodId) => {
    setBusyId(paymentMethodId);
    setStatus(null);
    try {
      await axios.patch(`${API}/${encodeURIComponent(paymentMethodId)}/default`, {}, { headers: authHeaders() });
      setDefaultPaymentMethodId(paymentMethodId);
      setStatus({ type: 'success', message: 'Default payment card updated.' });
    } catch (error) {
      setStatus({ type: 'error', message: error.response?.data?.msg || 'Could not update your default card.' });
    } finally {
      setBusyId('');
    }
  };

  const removeCard = async () => {
    if (!removeTarget?.id) return;
    setBusyId(removeTarget.id);
    setStatus(null);
    try {
      await axios.delete(`${API}/${encodeURIComponent(removeTarget.id)}`, { headers: authHeaders() });
      setRemoveTarget(null);
      await load({ quiet: true });
      setStatus({ type: 'success', message: `Card ending ${removeTarget.last4} was removed from your Rozare account.` });
    } catch (error) {
      setStatus({ type: 'error', message: error.response?.data?.msg || 'Could not remove this card.' });
    } finally {
      setBusyId('');
    }
  };

  const returnUrl = `${window.location.origin}${location.pathname}?card_setup=complete`;
  const elementsAppearance = {
    theme: 'stripe',
    variables: {
      colorPrimary: '#5965f2',
      colorBackground: '#f7f9ff',
      colorText: '#182033',
      colorDanger: '#dc3545',
      borderRadius: '14px',
      fontFamily: 'Inter, system-ui, sans-serif',
      spacingUnit: '4px',
    },
    rules: {
      '.Input': { border: '1px solid rgba(99, 102, 241, 0.16)', boxShadow: 'none' },
      '.Input:focus': { border: '1px solid rgba(89, 101, 242, 0.7)', boxShadow: '0 0 0 3px rgba(89, 101, 242, 0.1)' },
      '.Tab': { border: '1px solid rgba(99, 102, 241, 0.14)' },
      '.Tab--selected': { borderColor: '#5965f2', boxShadow: '0 0 0 2px rgba(89, 101, 242, 0.08)' },
    },
  };

  if (loading) {
    return (
      <div className="min-h-[70vh] p-4 sm:p-8 flex items-center justify-center">
        <div className="glass-panel px-6 py-5 flex items-center gap-3 text-sm font-semibold" style={{ color: 'hsl(var(--muted-foreground))' }}>
          <Loader2 size={20} className="animate-spin" /> Opening your secure card wallet…
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto">
        <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-panel-strong water-shimmer relative overflow-hidden p-6 sm:p-8 mb-6">
          <div className="absolute -right-16 -top-20 h-56 w-56 rounded-full blur-3xl pointer-events-none" style={{ background: 'hsla(190, 80%, 52%, 0.18)' }} />
          <div className="absolute -left-20 -bottom-28 h-60 w-60 rounded-full blur-3xl pointer-events-none" style={{ background: 'hsla(252, 75%, 62%, 0.18)' }} />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5">
            <div>
              <div className="tag-pill mb-3"><Sparkles size={12} /> Secure wallet</div>
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Saved payment cards</h1>
              <p className="text-sm mt-2 max-w-2xl" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Pay faster for products and wallet top-ups. Rozare never receives or stores your full card number.
              </p>
            </div>
            <button
              type="button"
              onClick={beginAddCard}
              disabled={setupLoading || !config?.publishableKey}
              className="shrink-0 rounded-2xl px-5 py-3 text-sm font-bold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, hsl(178, 78%, 42%), hsl(224, 82%, 61%), hsl(252, 76%, 63%))', boxShadow: '0 14px 30px hsla(220, 70%, 45%, 0.23)' }}
            >
              {setupLoading ? <Loader2 size={17} className="animate-spin" /> : <Plus size={17} />}
              {setupLoading ? 'Preparing Stripe…' : 'Add a card'}
            </button>
          </div>
        </motion.header>

        {status && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl p-4 mb-5 flex items-start gap-3 text-sm" style={status.type === 'success'
            ? { background: 'rgba(16,185,129,0.09)', border: '1px solid rgba(16,185,129,0.22)', color: 'hsl(150,60%,34%)' }
            : status.type === 'info'
              ? { background: 'rgba(59,130,246,0.09)', border: '1px solid rgba(59,130,246,0.22)', color: 'hsl(215,70%,45%)' }
              : { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'hsl(0,72%,48%)' }}>
            {status.type === 'success'
              ? <CheckCircle2 size={18} className="shrink-0" />
              : status.type === 'info'
                ? <ShieldCheck size={18} className="shrink-0" />
                : <AlertCircle size={18} className="shrink-0" />}
            <span className="flex-1">{status.message}</span>
            <button type="button" onClick={() => setStatus(null)} aria-label="Dismiss"><X size={16} /></button>
          </motion.div>
        )}

        {loadError ? (
          <section className="glass-panel p-8 sm:p-12 text-center">
            <div className="mx-auto h-14 w-14 rounded-2xl glass-inner flex items-center justify-center" style={{ color: 'hsl(0,72%,54%)' }}><AlertCircle size={25} /></div>
            <h2 className="font-bold text-lg mt-4" style={{ color: 'hsl(var(--foreground))' }}>Cards are temporarily unavailable</h2>
            <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError}</p>
            <button type="button" onClick={() => load()} className="glass-button rounded-xl px-4 py-2.5 mt-5 inline-flex items-center gap-2 text-sm font-semibold"><RefreshCw size={15} /> Try again</button>
          </section>
        ) : cards.length === 0 ? (
          <section className="glass-panel p-8 sm:p-12 text-center">
            <div className="mx-auto h-20 w-20 rounded-[26px] flex items-center justify-center" style={{ color: 'hsl(224,82%,58%)', background: 'linear-gradient(145deg, rgba(255,255,255,0.72), rgba(224,232,255,0.52))', border: '1px solid rgba(255,255,255,0.75)', boxShadow: '0 18px 36px rgba(77,91,190,0.13)' }}>
              <CreditCard size={32} />
            </div>
            <h2 className="font-extrabold text-xl mt-5" style={{ color: 'hsl(var(--foreground))' }}>Your secure wallet is ready</h2>
            <p className="text-sm mt-2 max-w-lg mx-auto" style={{ color: 'hsl(var(--muted-foreground))' }}>
              Link a card once, then select it during future purchases and Rozare Wallet top-ups.
            </p>
            <button type="button" onClick={beginAddCard} disabled={setupLoading} className="mt-6 rounded-xl px-5 py-2.5 text-sm font-bold text-white inline-flex items-center gap-2 disabled:opacity-50" style={{ background: 'linear-gradient(135deg, hsl(178,78%,42%), hsl(224,82%,61%))' }}>
              {setupLoading ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add your first card
            </button>
          </section>
        ) : (
          <section>
            <div className="flex items-center justify-between gap-3 mb-4 px-1">
              <div>
                <h2 className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>Your cards</h2>
                <p className="text-xs mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{cards.length} secure {cards.length === 1 ? 'payment method' : 'payment methods'}</p>
              </div>
              <button type="button" onClick={() => load({ quiet: true })} className="glass-button p-2.5 rounded-xl" aria-label="Refresh saved cards"><RefreshCw size={15} /></button>
            </div>
            <AnimatePresence mode="popLayout">
              <div className="grid md:grid-cols-2 gap-4">
                {cards.map(card => (
                  <SavedCard
                    key={card.id}
                    card={card}
                    isDefault={card.id === defaultPaymentMethodId}
                    busy={busyId === card.id}
                    onMakeDefault={makeDefault}
                    onRemove={setRemoveTarget}
                  />
                ))}
              </div>
            </AnimatePresence>
          </section>
        )}

        <section className="glass-panel mt-6 p-5 grid sm:grid-cols-3 gap-4">
          {[
            { icon: <ShieldCheck size={18} />, title: 'Stripe protected', copy: 'Card details go directly to Stripe over an encrypted connection.' },
            { icon: <LockKeyhole size={18} />, title: 'No card numbers stored', copy: 'Rozare only receives a card token, brand, expiry, and last four digits.' },
            { icon: <CreditCard size={18} />, title: 'You stay in control', copy: 'Choose a saved card during payment or remove it here at any time.' },
          ].map(item => (
            <div key={item.title} className="glass-inner rounded-2xl p-4 flex items-start gap-3">
              <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'hsla(220,70%,55%,0.1)', color: 'hsl(220,70%,52%)' }}>{item.icon}</div>
              <div><p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{item.title}</p><p className="text-xs mt-1 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>{item.copy}</p></div>
            </div>
          ))}
        </section>
      </div>

      <AnimatePresence>
        {consentOpen && (
          <motion.div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button type="button" aria-label="Close card consent" onClick={() => setConsentOpen(false)} className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" />
            <motion.div initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} className="glass-panel-strong relative w-full sm:max-w-md rounded-t-[28px] sm:rounded-[28px] p-6 sm:p-7">
              <div className="mx-auto h-12 w-12 rounded-2xl flex items-center justify-center" style={{ background: 'hsla(220,70%,55%,0.12)', color: 'hsl(220,70%,52%)' }}>
                <ShieldCheck size={23} />
              </div>
              <h2 className="text-xl font-extrabold text-center mt-4" style={{ color: 'hsl(var(--foreground))' }}>Save a card securely</h2>
              <p className="text-sm text-center mt-2 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Stripe will securely store the card so you can select it for future Rozare purchases and Wallet top-ups. Rozare never stores the full card number, and no future charge happens without your action.
              </p>
              <label className="glass-inner rounded-2xl p-4 mt-5 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={setupConsent}
                  onChange={event => setSetupConsent(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded accent-[hsl(220,70%,55%)]"
                />
                <span className="text-xs leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  I agree to save this payment method to my Rozare account for payments I choose to make. I can remove it later.
                </span>
              </label>
              <p className="text-[11px] leading-relaxed text-center mt-3" style={{ color: 'hsl(var(--muted-foreground))' }}>
                By continuing, you agree to Rozare's <Link to="/terms" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">Terms</Link> and <Link to="/privacy" target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">Privacy Policy</Link>.
              </p>
              <div className="grid grid-cols-2 gap-3 mt-6">
                <button type="button" onClick={() => setConsentOpen(false)} disabled={setupLoading} className="glass-button rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Not now</button>
                <button
                  type="button"
                  onClick={createSetup}
                  disabled={!setupConsent || setupLoading}
                  className="rounded-xl px-4 py-2.5 text-sm font-bold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, hsl(178, 78%, 42%), hsl(224, 82%, 61%), hsl(252, 76%, 63%))' }}
                >
                  {setupLoading ? <Loader2 size={15} className="animate-spin" /> : <LockKeyhole size={15} />}
                  Continue
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {setupSecret && stripePromise && (
          <motion.div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button type="button" aria-label="Close add card" onClick={() => setSetupSecret('')} className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" />
            <motion.div initial={{ y: 36, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }} className="glass-panel-strong relative w-full sm:max-w-xl rounded-t-[28px] sm:rounded-[28px] p-5 sm:p-7 max-h-[94vh] overflow-y-auto">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div><div className="tag-pill mb-2"><ShieldCheck size={12} /> Stripe secure</div><h2 className="text-xl font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>Add a payment card</h2><p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Verify once, then choose it during future payments.</p></div>
                <button type="button" onClick={() => setSetupSecret('')} className="glass-button rounded-xl p-2.5" aria-label="Close"><X size={17} /></button>
              </div>
              <Elements key={setupSecret} stripe={stripePromise} options={{ clientSecret: setupSecret, appearance: elementsAppearance, loader: 'auto' }}>
                <SaveCardForm returnUrl={returnUrl} onSaved={handleSaved} onCancel={() => setSetupSecret('')} />
              </Elements>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {removeTarget && (
          <motion.div className="fixed inset-0 z-[110] flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button type="button" aria-label="Cancel removal" onClick={() => setRemoveTarget(null)} className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm" />
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} className="glass-panel-strong relative w-full max-w-sm p-6 text-center">
              <div className="mx-auto h-12 w-12 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.1)', color: 'hsl(0,72%,54%)' }}><Trash2 size={21} /></div>
              <h3 className="font-extrabold text-lg mt-4" style={{ color: 'hsl(var(--foreground))' }}>Remove this card?</h3>
              <p className="text-sm mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{brandLabel(removeTarget.brand)} ending {removeTarget.last4} will no longer appear at checkout.</p>
              <div className="grid grid-cols-2 gap-3 mt-6">
                <button type="button" onClick={() => setRemoveTarget(null)} disabled={Boolean(busyId)} className="glass-button rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Keep card</button>
                <button type="button" onClick={removeCard} disabled={Boolean(busyId)} className="rounded-xl px-4 py-2.5 text-sm font-bold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: 'hsl(0,72%,54%)' }}>
                  {busyId ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Remove
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
