import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, LockKeyhole, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { isValidPhoneNumber } from 'react-phone-number-input';
import { useAuth } from '../../contexts/AuthContext';
import PhoneField from '../common/PhoneField';
import LocationAutocomplete from '../common/LocationAutocomplete';
import { safepayApi, openSafepayCheckout } from '../../utils/safepay';
import { safepayCardSetupNotice } from '../../utils/safepayCardNotice';
import { createScopedMutationStorageKey, getOrCreatePersistedMutationAttemptForFingerprint, clearPersistedMutationAttemptForFingerprint } from '../../utils/persistedMutationAttempt';

export default function PaymentMethods() {
  const { currentUser } = useAuth();
  const [cards, setCards] = useState([]);
  const [defaultId, setDefaultId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cardsUnavailable, setCardsUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [consent, setConsent] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [contact, setContact] = useState({ fullName: '', phone: '', country: '', countryCode: '' });
  const editedContact = useRef(false);
  const [removeCard, setRemoveCard] = useState(null);
  const [retryAt, setRetryAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const remaining = Math.max(0, Math.ceil((retryAt - clock) / 1000));
  const storageKey = createScopedMutationStorageKey('rozare_safepay_card_setup_web_v1', currentUser?._id || currentUser?.id);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await safepayApi.get('/cards');
      if (!Array.isArray(data.cards)) throw new Error('Saved cards could not be verified.');
      setCards(data.cards); setDefaultId(data.defaultPaymentMethodId); setCardsUnavailable(false);
      setProfileReady(data.billingProfileReady === true);
      if (data.billingContact && !editedContact.current) setContact(data.billingContact);
      return data.cards;
    } catch (err) { setCardsUnavailable(true); setError(err.response?.data?.msg || err.message || 'Saved cards are unavailable. Please retry.'); return null; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!retryAt) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const edit = fields => { editedContact.current = true; setContact(value => ({ ...value, ...fields })); };
  const report = err => {
    setError(err.response?.data?.msg || err.message || 'This request could not be completed. Please retry.');
    const seconds = Number(err.response?.data?.retryAfterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) { setClock(Date.now()); setRetryAt(Date.now() + Math.min(seconds, 90) * 1000); }
    if (err.response?.data?.code === 'SAFEPAY_BILLING_PROFILE_REQUIRED') setProfileReady(false);
  };
  const addCard = async event => {
    event.preventDefault();
    if (busyRef.current || remaining || !consent || cardsUnavailable) return;
    setError(''); setNotice('');
    if (!profileReady && (contact.fullName.trim().split(/\s+/).length < 2 || !isValidPhoneNumber(contact.phone || '') || !contact.countryCode)) {
      setError('Enter your billing first and last name, a valid phone number, and select your country.'); return;
    }
    busyRef.current = true; setBusy(true);
    try {
      const fingerprint = 'safepay-card-storage-v1';
      const attempt = await getOrCreatePersistedMutationAttemptForFingerprint({ storage: localStorage, storageKey, fingerprint, keyPrefix: 'web-card' });
      const { data } = await safepayApi.post('/cards/setup', { clientSurface: 'web', consentToSave: true,
        requestKey: attempt.key, ...(!profileReady ? { billingContact: contact } : {}) });
      const result = await openSafepayCheckout(data);
      if (['authorized', 'cancelled', 'failed', 'refunded'].includes(result.status)) {
        await clearPersistedMutationAttemptForFingerprint(localStorage, storageKey, fingerprint, attempt.key);
      }
      if (result.status === 'authorized') setConsent(false);
      const refreshedCards = await load();
      setNotice(safepayCardSetupNotice(result.status, refreshedCards));
    } catch (err) { report(err); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const mutateCard = async (cardId, remove = false) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (remove) await safepayApi.delete(`/cards/${encodeURIComponent(cardId)}`, { data: { clientSurface: 'web' } });
      else await safepayApi.patch(`/cards/${encodeURIComponent(cardId)}/default`, { clientSurface: 'web' });
      setRemoveCard(null); await load();
      setNotice(remove ? 'Card removed.' : 'Default card updated. Your subscription billing card is managed separately in Subscription.');
    } catch (err) { report(err); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="max-w-5xl mx-auto w-full min-w-0 space-y-6 p-4 sm:p-6">
    <header className="glass-card p-5 flex items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold flex items-center gap-2"><CreditCard /> Payment Methods</h1><p className="text-sm text-muted-foreground">Secure cards for faster checkout</p></div>
      <button type="button" className="glass-button p-3" disabled={busy || loading} onClick={() => { setError(''); load(); }} aria-label="Refresh saved cards"><RefreshCw size={20} className={loading ? 'animate-spin' : ''} /></button>
    </header>
    <section className="glass-card p-6 space-y-3"><ShieldCheck className="text-primary" size={32} /><h2 className="text-lg font-bold">Your cards, protected by Safepay</h2><p className="text-sm text-muted-foreground">Safepay handles your card details securely. Rozare uses a saved-card reference and masked card details. No separate Safepay account is needed.</p></section>
    {error && <div role="alert" className="glass-card p-4 border border-red-400 text-red-700">{error}{remaining > 0 && <p>Retry in {remaining} seconds.</p>}</div>}
    {notice && <p role="status" className="glass-card p-4">{notice}</p>}
    <section aria-label="Saved payment cards" aria-busy={loading}>
      <h2 className="font-semibold mb-3">Saved payment methods</h2>
      {loading ? <div className="glass-card h-40 animate-pulse" aria-label="Loading saved cards" /> : cardsUnavailable ? <p role="status" className="glass-card p-5">Cards could not be loaded. Use Refresh saved cards to retry.</p> : cards.length ? <div className="grid sm:grid-cols-2 gap-4">{cards.map(card => <article key={card.id} className="glass-card p-5 space-y-4">
        <div className="flex justify-between gap-2"><span className="font-bold uppercase">{card.brand || 'Card'}</span>{card.id === defaultId && <span className="text-sm text-primary">Default</span>}</div>
        <p className="text-xl font-semibold tracking-widest">•••• {card.last4}</p>
        <p className="text-sm text-muted-foreground">Expires {String(card.expMonth).padStart(2, '0')}/{card.expYear}{card.usable === false ? ' · Not available for payment' : ''}</p>
        <div className="flex gap-3 flex-wrap">{card.id !== defaultId && <button className="glass-button px-3 py-2" disabled={busy || card.usable === false} onClick={() => mutateCard(card.id)}>Make default</button>}<button className="glass-button px-3 py-2 flex gap-2 items-center" disabled={busy} onClick={() => setRemoveCard(card)}><Trash2 size={16} /> Remove</button></div>
      </article>)}</div> : <div className="glass-card p-8 text-center"><CreditCard size={36} className="mx-auto mb-3" /><h3 className="font-semibold">No card saved yet</h3><p className="text-sm text-muted-foreground mt-2">Add a card securely with Safepay.</p></div>}
    </section>
    <form onSubmit={addCard} className="glass-card p-6 space-y-5">
      {!profileReady && <fieldset disabled={busy || loading} className="space-y-4"><legend className="font-semibold mb-3">Billing details</legend>
        <label className="block text-sm">Billing first and last name<input className="glass-input block w-full mt-2" autoComplete="cc-name" maxLength={160} value={contact.fullName || ''} onChange={event => edit({ fullName: event.target.value })} required /></label>
        <label className="block text-sm">Billing phone number<PhoneField value={contact.phone || ''} onChange={phone => edit({ phone: phone || '' })} profileCountry={contact.country} /></label>
        <LocationAutocomplete type="country" label="Billing country" value={contact.country} code={contact.countryCode} required disabled={busy || loading} onSelect={country => edit({ country: country.name, countryCode: country.isoCode })} onClear={() => edit({ country: '', countryCode: '' })} />
      </fieldset>}
      <label className="flex gap-3 items-start text-sm"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} className="mt-1" /><span>I authorize Safepay to save this card for purchases I approve. Automatic subscription renewals require a separate agreement. Adding a card does not start a subscription.</span></label>
      <p className="text-xs text-muted-foreground">By continuing, you agree to Rozare’s <Link className="underline" to="/terms">Terms</Link> and <Link className="underline" to="/privacy">Privacy Policy</Link>.</p>
      <button type="submit" className="glass-button-primary px-5 py-3 flex items-center gap-2 disabled:opacity-50" disabled={!consent || busy || loading || cardsUnavailable || remaining > 0}><Plus size={18} />{busy ? 'Verifying…' : remaining ? `Retry in ${remaining}s` : 'Add a new card'}</button>
      <p className="text-xs text-muted-foreground flex items-center gap-2"><LockKeyhole size={14} /> Card details are entered only in Safepay's secure form.</p>
    </form>
    {removeCard && <div className="fixed inset-0 z-[9990] bg-black/50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="remove-card-title"><div className="glass-card safepay-surface p-6 max-w-md space-y-4"><h2 id="remove-card-title" className="font-bold">Remove card ending {removeCard.last4}?</h2><p className="text-sm">A card used for automatic renewals must be replaced in Subscription, or renewal cancelled, before removal.</p><div className="flex gap-3"><button className="glass-button px-4 py-2" disabled={busy} onClick={() => setRemoveCard(null)}>Keep card</button><button className="glass-button-primary px-4 py-2" disabled={busy} onClick={() => mutateCard(removeCard.id, true)}>{busy ? 'Verifying…' : 'Remove card'}</button></div></div></div>}
  </div>;
}
