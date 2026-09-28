import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { safepayApi } from '../../utils/safepay';
import { formatUsdCents } from '../../utils/subscriptionPricing';
import { createScopedMutationStorageKey, getOrCreatePersistedMutationAttemptForFingerprint, clearPersistedMutationAttemptForFingerprint } from '../../utils/persistedMutationAttempt';

export const isValidBillingQuote = quote => Boolean(quote && /^[a-f\d]{24}$/i.test(quote.quoteId)
  && Number.isSafeInteger(quote.monthlyAmountMinor) && quote.monthlyAmountMinor > 0
  && Number.isSafeInteger(quote.dueNowMinor) && quote.dueNowMinor >= 0
  && quote.currency === 'USD' && quote.consentVersion === 'rozare-safepay-recurring-v1'
  && typeof quote.terms === 'string' && quote.terms.length > 0);

export function useSafepaySubscriptionBilling(subscription, refresh) {
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const busyRef = useRef(false);
  const attemptRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState(null);
  const [cards, setCards] = useState([]);
  const [cardId, setCardId] = useState('');
  const [consent, setConsent] = useState(false);
  const check = async operationId => {
    const { data } = await safepayApi.get(`/subscription/operations/${operationId}`);
    if (data.completed === true) {
      const attempt = attemptRef.current;
      if (attempt) await clearPersistedMutationAttemptForFingerprint(localStorage, attempt.storageKey, attempt.fingerprint, attempt.key);
      setQuote(null); toast.success(data.msg || 'Your subscription is updated.');
    } else {
      toast.info(data.status === 'failed' ? 'Payment was not completed. Review your card and use Retry payment.'
        : 'This payment is still being verified. Checking its status does not create another charge.');
    }
    await refresh();
    return data;
  };
  const getCards = async () => {
    const { data } = await safepayApi.get('/cards');
    const available = Array.isArray(data.cards) ? data.cards.filter(card => card.usable !== false) : [];
    if (!available.length) {
      toast.info('Add a card with Safepay first, then return here to review and approve your subscription. No Safepay account is needed.');
      navigate('/seller-dashboard/payment-methods'); return null;
    }
    setCards(available); setCardId(available.some(card => card.id === data.defaultPaymentMethodId) ? data.defaultPaymentMethodId : available[0].id);
    setConsent(false);
    return available;
  };
  const open = async ({ plan, kind = 'enrollment', includeMetaAds = false, couponCode = '' }) => {
    if (busyRef.current) return;
    if (subscription?.billingProvider === 'stripe' && ['active', 'free_period', 'past_due'].includes(subscription.status)) {
      toast.info('Your existing card subscription must finish before switching to Safepay, to prevent duplicate billing. You can cancel its renewal on this page.'); return;
    }
    busyRef.current = true; setBusy(true);
    try {
      if (subscription?.pendingBillingOperation) { await check(subscription.pendingBillingOperation); return; }
      if (!await getCards()) return;
      const storageKey = createScopedMutationStorageKey('rozare_safepay_billing_web_v1', currentUser?._id || currentUser?.id);
      const fingerprint = JSON.stringify({ kind, plan, includeMetaAds, couponCode, version: subscription?.billingVersion || 0 });
      const attempt = await getOrCreatePersistedMutationAttemptForFingerprint({ storage: localStorage, storageKey, fingerprint, keyPrefix: 'web-billing' });
      attemptRef.current = { ...attempt, storageKey, fingerprint };
      const { data } = await safepayApi.post(kind === 'retry' ? '/subscription/retry-quote' : '/subscription/quote', {
        clientSurface: 'web', kind, plan, includeMetaAds, couponCode, requestKey: attempt.key,
        ...(kind === 'retry' ? { failedOperation: subscription?.failedBillingOperation } : {}),
      });
      if (!isValidBillingQuote(data)) throw new Error('The subscription quote could not be verified. Retry the same attempt.');
      if (['accepted', 'awaiting_payment', 'applied'].includes(data.status)) { await check(data.quoteId); return; }
      if (data.status !== 'quoted' || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()) {
        await clearPersistedMutationAttemptForFingerprint(localStorage, storageKey, fingerprint, attempt.key);
        throw new Error('This quote is no longer available. Choose your plan again to review a fresh quote.');
      }
      setQuote(data);
    } catch (err) { toast.error(err.response?.data?.msg || err.message || 'Billing is unavailable. Retry the same attempt.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const changeCard = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      if (!await getCards()) return;
      if (!Number.isSafeInteger(subscription?.currentMonthlyAmountCents) || subscription.currentMonthlyAmountCents <= 0) throw new Error('Refresh your subscription to verify its price.');
      setQuote({ kind: 'card_change', planName: subscription.planName, dueNowMinor: 0,
        monthlyAmountMinor: subscription.currentMonthlyAmountCents, billingVersion: subscription.billingVersion,
        consentVersion: 'rozare-safepay-recurring-v1',
        terms: `Authorize this card for your existing ${formatUsdCents(subscription.currentMonthlyAmountCents)} USD/month agreement. This changes neither the renewal date nor the price and does not collect a payment.` });
    } catch (err) { toast.error(err.response?.data?.msg || err.message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const confirm = async () => {
    if (busyRef.current || !quote || !consent || !cardId) return;
    busyRef.current = true; setBusy(true);
    try {
      if (quote.kind === 'card_change') {
        await safepayApi.patch('/subscription/card', { clientSurface: 'web', cardId, billingVersion: quote.billingVersion, consentAccepted: true, consentVersion: quote.consentVersion });
        setQuote(null); toast.success('Subscription billing card updated.'); await refresh();
      } else {
        await safepayApi.post('/subscription/accept', { clientSurface: 'web', quoteId: quote.quoteId, cardId, consentAccepted: true, consentVersion: quote.consentVersion });
        await check(quote.quoteId);
      }
    } catch (err) { toast.error(err.response?.data?.msg || 'Billing is not confirmed. Your exact attempt is retained.'); await refresh(); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const checkPending = async () => {
    if (busyRef.current || !subscription?.pendingBillingOperation) return;
    busyRef.current = true; setBusy(true);
    try { await check(subscription.pendingBillingOperation); }
    catch (err) { toast.error(err.response?.data?.msg || 'Payment is still being verified. Please retry.'); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return { busy, open, changeCard, checkPending, review: <SafepayBillingReview quote={quote} cards={cards} cardId={cardId} onCardChange={setCardId}
    consent={consent} onConsentChange={setConsent} busy={busy} onConfirm={confirm} onClose={() => { if (!busyRef.current) setQuote(null); }} /> };
}

function SafepayBillingReview({ quote, cards, cardId, onCardChange, consent, onConsentChange, busy, onConfirm, onClose }) {
  const panel = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (!quote) return undefined;
    const previous = document.activeElement; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; panel.current?.focus();
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      const items = panel.current?.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href]');
      if (event.key !== 'Tab' || !items?.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, [quote]);
  if (!quote) return null;
  return createPortal(<div className="fixed inset-0 z-[9995] bg-black/60 flex items-center justify-center p-4">
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="safepay-billing-title" className="safepay-surface w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl p-6 shadow-xl space-y-5">
      <header className="flex items-center justify-between gap-3"><h2 id="safepay-billing-title" className="font-bold text-lg">Review your subscription</h2><button type="button" aria-label="Close subscription review" disabled={busy} onClick={onClose}><X /></button></header>
      <h3 className="font-semibold">{quote.planName}</h3>
      <div className="glass-card p-4 space-y-2"><p>Due now: <strong>{formatUsdCents(quote.dueNowMinor)} USD</strong></p><p>Recurring price: <strong>{formatUsdCents(quote.monthlyAmountMinor)} USD/month</strong></p>{quote.freePeriodDays > 0 && <p>First {quote.freePeriodDays} days free.</p>}{quote.creditMinor > 0 && <p>Credit toward future billing: {formatUsdCents(quote.creditMinor)} USD</p>}</div>
      <label className="block text-sm">Safepay payment card<select value={cardId} onChange={event => onCardChange(event.target.value)} disabled={busy} className="glass-input block w-full mt-2">{cards.map(card => <option key={card.id} value={card.id}>{String(card.brand || 'Card').toUpperCase()} •••• {card.last4}</option>)}</select></label>
      <p className="text-sm text-muted-foreground">{quote.terms}</p>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={consent} disabled={busy} onChange={event => onConsentChange(event.target.checked)} /><span>I agree to this price and the displayed automatic renewal terms.</span></label>
      <div className="flex flex-wrap justify-end gap-3"><button className="glass-button px-4 py-3" disabled={busy} onClick={onClose}>Not now</button><button className="glass-button-primary px-4 py-3 disabled:opacity-50" disabled={busy || !consent || !cardId} onClick={onConfirm}>{busy ? 'Verifying…' : quote.kind === 'card_change' ? 'Confirm card change' : 'Confirm subscription'}</button></div>
    </section>
  </div>, document.body);
}
