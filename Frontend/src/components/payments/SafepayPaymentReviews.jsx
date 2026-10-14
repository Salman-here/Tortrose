import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { AlertTriangle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { getAuthToken } from '../../utils/cookieHelper';
import { buildPaymentReviewResolution, paymentReviewIsValid, paymentReviewAuditIsValid } from '../../utils/safepayPaymentReview';

const API = `${import.meta.env.VITE_API_URL}api/payments/admin/payment-reviews`;
const money = (minor, currency) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 100);
const empty = { outcome: 'won', reference: '', evidence: '', amount: '', confirmed: false };

export default function SafepayPaymentReviews({ onResolved }) {
  const [reviews, setReviews] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null), [form, setForm] = useState(empty), [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false), [receipt, setReceipt] = useState('');
  const [audit, setAudit] = useState(null);
  const [filter, setFilter] = useState('pending'), [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false);
  const request = useRef(0), operation = useRef(null), submitting = useRef(false), panel = useRef(null);
  const auth = () => ({ Authorization: `Bearer ${getAuthToken()}` });
  const load = useCallback(async () => {
    const version = ++request.current;
    setLoading(true); setError('');
    try {
      const { data } = await axios.get(API, { headers: auth(), params: { status: filter, page } });
      if (version !== request.current) return;
      if (data?.version !== 1 || !Array.isArray(data.reviews) || !data.reviews.every(paymentReviewIsValid)) throw new Error('Payment reviews returned incomplete financial data.');
      setReviews(data.reviews);
      setHasMore(data.hasMore === true);
    } catch (failure) { if (version === request.current) setError(failure.response?.data?.msg || failure.message || 'Payment reviews are unavailable.'); }
    finally { if (version === request.current) setLoading(false); }
  }, [filter, page]);
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [load]);
  useEffect(() => {
    if (!selected) return undefined;
    const previous = document.activeElement;
    const focus = () => {
      const elements = [...(panel.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]') || [])];
      return elements.filter(element => element.offsetParent !== null);
    };
    focus()[0]?.focus();
    const key = event => {
      if (event.key === 'Escape' && !submitting.current) { event.preventDefault(); setSelected(null); }
      if (event.key !== 'Tab') return;
      const elements = focus(), first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, [selected, confirming]);
  const open = review => {
    operation.current = null; setConfirming(false); setError(''); setReceipt('');
    setForm({ ...empty, amount: (review.originalAmountMinor / 100).toFixed(2) }); setSelected(review);
  };
  const edit = (field, value) => { if (submitting.current) return; operation.current = null; setConfirming(false); setForm(current => ({ ...current, [field]: value })); };
  const recheck = async review => {
    if (submitting.current) return;
    setBusy(true); setError('');
    try { await axios.post(`${API}/${review._id}/recheck`, {}, { headers: auth() }); await load(); }
    catch (failure) { setError(failure.response?.data?.msg || 'Safepay could not be rechecked. The hold remains.'); }
    finally { setBusy(false); }
  };
  const readAudit = async review => {
    if (submitting.current) return;
    setBusy(true); setError(''); setAudit(null);
    try {
      const { data } = await axios.get(`${API}/${review._id}/audit`, { headers: auth() });
      if (!paymentReviewAuditIsValid(data, review)) throw new Error('The saved review evidence could not be verified.');
      setAudit({ ...data.audit, reviewId: review._id });
    } catch (failure) { setError(failure.response?.data?.msg || failure.message || 'The saved evidence is unavailable.'); }
    finally { setBusy(false); }
  };
  const resolve = async () => {
    if (!selected || submitting.current) return;
    const key = operation.current?.key || `bank-review-${crypto.randomUUID()}`;
    const payload = buildPaymentReviewResolution(selected, form, key);
    if (!payload) { setError('Review the final decision, original-currency principal, case reference and supporting evidence first.'); return; }
    if (!confirming) { setConfirming(true); return; }
    const fingerprint = JSON.stringify({ id: selected._id, payload });
    if (operation.current && operation.current.fingerprint !== fingerprint) { setError('The decision changed. Review it again before submitting.'); setConfirming(false); return; }
    operation.current = { key, fingerprint }; submitting.current = true; setBusy(true); setError('');
    try {
      const { data } = await axios.post(`${API}/${selected._id}/resolve`, payload, { headers: { ...auth(), 'Idempotency-Key': key } });
      if (data?.version !== 1 || !paymentReviewIsValid(data.review) || data.review._id !== selected._id || data.review.status !== form.outcome) throw new Error('The decision response could not be verified. Recheck this same review before another action.');
      setSelected(null); setReceipt('Provider decision recorded. Related balances and holds were updated.');
      await load(); onResolved?.();
    } catch (failure) { setError(failure.response?.data?.msg || failure.message || 'The response was interrupted. Retry this same decision; do not create a different adjustment.'); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <section className="glass-panel p-4 sm:p-6 space-y-4" aria-label="Safepay payment reviews">
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-lg font-bold flex items-center gap-2"><ShieldCheck size={20} /> Payment reviews</h2><p className="text-sm text-muted-foreground">Record a verified final bank decision. This does not issue a refund or bank transfer.</p></div><button type="button" className="glass-button p-2" aria-label="Refresh payment reviews" disabled={busy} onClick={load}><RefreshCw size={18} /></button></div>
    {error && !selected && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
    {receipt && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{receipt}</p>}
    <div className="flex flex-wrap gap-2">{[['pending', 'Needs review'], ['all', 'All decisions']].map(([value, label]) => <button key={value} type="button" className="glass-button px-3 py-2 text-sm" aria-pressed={filter === value} disabled={busy} onClick={() => { setFilter(value); setPage(1); setAudit(null); }}>{label}</button>)}</div>
    {loading ? <p>Loading payment reviews…</p> : !reviews.length ? <p className="text-sm text-muted-foreground">No payment reviews.</p> : <div className="space-y-3">{reviews.map(review => <article key={review._id} className="glass-inner rounded-2xl p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong className="min-w-0 break-all">{review.originalPaymentReference || review.tracker}</strong><span className="tag-pill">{review.environment} · {review.status}</span></div>
      <p className="text-sm">Original card payment: {money(review.originalAmountMinor, review.currency)}</p>
      {review.status === 'lost' && <p className="text-sm">Recorded bank principal: {money(review.principalMinor, review.currency)}</p>}
      <div className="flex flex-wrap gap-2"><a className="glass-button px-3 py-2 text-sm" href={review.providerUrl} target="_blank" rel="noopener noreferrer">Open Safepay payment</a>
        {review.status === 'pending' ? <><button type="button" className="glass-button px-3 py-2 text-sm" disabled={busy} onClick={() => recheck(review)}>Recheck Safepay</button><button type="button" className="glass-button px-3 py-2 text-sm" disabled={busy} onClick={() => open(review)}>Review final decision</button></> : <button type="button" className="glass-button px-3 py-2 text-sm" disabled={busy} onClick={() => readAudit(review)}>View saved evidence</button>}</div>
      {audit?.reviewId === review._id && <div className="glass-inner rounded-xl p-3 space-y-2 text-sm"><p><strong>Case reference:</strong> {audit.caseReference}</p><p><strong>Decision:</strong> Admin-reviewed provider evidence · {audit.status}</p><p className="whitespace-pre-wrap break-words">{audit.evidence}</p><p>Seller adjustments: {money(audit.sellerAllocations.reduce((sum, row) => sum + row.amountMinor, 0), audit.currency)} · Wallet adjustments: {money(audit.buyerAllocations.reduce((sum, row) => sum + row.amountMinor, 0), audit.currency)} · Rozare portion: {money(audit.platformPrincipalMinor, audit.currency)}</p><button type="button" className="glass-button px-3 py-2" onClick={() => setAudit(null)}>Close evidence</button></div>}
    </article>)}</div>}
    {(page > 1 || hasMore) && <div className="flex justify-end gap-2"><button type="button" className="glass-button px-3 py-2" disabled={busy || page === 1} onClick={() => setPage(current => current - 1)}>Previous reviews</button><span className="px-2 py-2 text-sm">Page {page}</span><button type="button" className="glass-button px-3 py-2" disabled={busy || !hasMore} onClick={() => setPage(current => current + 1)}>Next reviews</button></div>}
    {selected && createPortal(<div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setSelected(null); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="bank-review-title" aria-busy={busy} className="modal-surface w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-3xl p-5 sm:p-7 space-y-4">
        <div className="flex items-center justify-between gap-3"><h3 id="bank-review-title" className="text-lg font-bold">Record final bank decision</h3><button type="button" disabled={busy} aria-label="Close bank review" className="glass-button p-2" onClick={() => setSelected(null)}><X size={18} /></button></div>
        <p className="text-sm text-muted-foreground">Original payment: {money(selected.originalAmountMinor, selected.currency)}. Seller allocations are calculated by Rozare, not entered manually.</p>
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}
        <div className="flex gap-2">{['won', 'lost'].map(outcome => <button key={outcome} type="button" className="glass-button flex-1 px-4 py-3" style={form.outcome === outcome ? { borderColor: 'hsl(var(--primary))', color: 'hsl(var(--primary))', background: 'hsl(var(--primary) / 0.12)' } : undefined} aria-pressed={form.outcome === outcome} disabled={busy} onClick={() => edit('outcome', outcome)}>{outcome === 'won' ? 'Merchant won' : 'Merchant lost'}</button>)}</div>
        {form.outcome === 'lost' && <label className="block text-sm space-y-1">Bank-reported reversed principal ({selected.currency})<input className="glass-input w-full px-3 py-2.5 rounded-xl" inputMode="decimal" disabled={busy} value={form.amount} onChange={event => edit('amount', event.target.value)} /><span className="block text-xs text-muted-foreground">Copy the principal from the final provider evidence. Do not include bank fees, tax or penalties.</span></label>}
        <label className="block text-sm space-y-1">Safepay / bank case reference<input className="glass-input w-full px-3 py-2.5 rounded-xl" disabled={busy} value={form.reference} maxLength={160} onChange={event => edit('reference', event.target.value)} /></label>
        <label className="block text-sm space-y-1">Final decision evidence<textarea className="glass-input w-full px-3 py-2.5 rounded-xl min-h-32" disabled={busy} value={form.evidence} maxLength={12000} onChange={event => edit('evidence', event.target.value)} placeholder="Record the final provider decision, its date and supporting confirmation. Include only this payment’s evidence; no full card details." /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={form.confirmed} onChange={event => edit('confirmed', event.target.checked)} /><span>I checked the final provider decision and principal against this original payment.</span></label>
        {confirming && <div className="glass-inner rounded-2xl p-4 text-sm"><p className="font-semibold flex gap-2 items-center"><AlertTriangle size={18} /> Confirm this audited decision</p><p>{form.outcome === 'won' ? 'Release only this review’s verified hold, without a loss deduction.' : `Record the bank-reported principal in ${selected.currency}; Rozare calculates the seller impact and any deficit.`} The saved decision and evidence cannot be overwritten.</p></div>}
        <div className="flex justify-end gap-2"><button type="button" className="glass-button px-4 py-2.5" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button type="button" className="glass-button px-4 py-2.5 font-semibold" disabled={busy || !form.confirmed} onClick={resolve}>{busy ? 'Recording…' : confirming ? 'Confirm and record decision' : 'Review decision'}</button></div>
      </div>
    </div>, document.body)}
  </section>;
}
