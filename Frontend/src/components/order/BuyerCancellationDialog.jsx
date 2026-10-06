import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { CreditCard, LoaderCircle, Wallet, X } from 'lucide-react';
import { getAuthToken } from '../../utils/cookieHelper';
import { getOrderSellerGroups, getOrderCurrency } from '../../utils/orderItems';
import { assertCancellationQuote } from '../../utils/cancellationQuote';

export default function BuyerCancellationDialog({ order, sellerIds, formatMoney, onClose, onCancelled, onBusyChange }) {
  const [quote, setQuote] = useState(null);
  const [destination, setDestination] = useState('wallet');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const submitting = useRef(false);
  const scopeKey = sellerIds?.join(',') || 'all';
  useEffect(() => {
    let active = true;
    setQuote(null); setError(''); setLoading(true); setAccepted(false);
    const fetch = async () => {
      try {
        const groups = getOrderSellerGroups(order);
        const selected = sellerIds || groups.filter(row => row.canCancel === true).map(row => row.sellerId);
        const grossMinor = groups.filter(row => selected.includes(row.sellerId) && row.canCancel === true)
          .reduce((n, row) => n + Math.round(row.summary.totalAmount * 100), 0);
        const res = await axios.post(`${import.meta.env.VITE_API_URL}api/order/cancel/${order._id}/preview`, { sellerIds: selected },
          { headers: { Authorization: `Bearer ${getAuthToken()}` } });
        const value = assertCancellationQuote(res.data?.quote, { orderId: order._id, currency: getOrderCurrency(order),
          paymentMethod: order.paymentMethod, sellerIds: selected, grossMinor });
        if (active) { setQuote(value); setDestination(value.defaultDestination); }
      } catch (err) { if (active) setError(err.response?.data?.msg || err.message); }
      finally { if (active) setLoading(false); }
    };
    fetch();
    return () => { active = false; };
  }, [order, scopeKey, reload]);
  const chosen = quote?.options.find(row => row.destination === destination);
  const consentNeeded = (chosen?.deductionMinor || 0) > 0;
  const cancel = async () => {
    if (submitting.current || busy || !quote || !chosen?.available || consentNeeded && !accepted) return;
    submitting.current = true;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      const res = await axios.patch(`${import.meta.env.VITE_API_URL}api/order/cancel/${order._id}`,
        { sellerIds: quote.activeSellerIds, refundDestination: destination, quoteId: quote.quoteId, acceptDeduction: accepted },
        { headers: { Authorization: `Bearer ${getAuthToken()}` } });
      if (res.data?.order?._id !== order._id) throw new Error('The cancellation response could not be verified. Refresh the order.');
      getOrderSellerGroups(res.data.order);
      await onCancelled(res.data.order); onClose();
    } catch (err) {
      setError(err.response?.data?.msg || err.message);
      if (err.response?.status === 409) setQuote(null);
    } finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  };
  return <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => !busy && onClose()}>
    <section role="dialog" aria-modal="true" aria-labelledby="cancel-dialog-title" className="glass-panel p-5 sm:p-6 max-w-md w-full max-h-[85dvh] overflow-y-auto"
      style={{ background: 'hsl(var(--background) / 0.96)', color: 'hsl(var(--foreground))' }} onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-3"><h3 id="cancel-dialog-title" className="text-lg font-bold">Cancel {sellerIds ? 'this store’s items' : 'order'}?</h3>
        <button type="button" disabled={busy} className="glass-button p-2 rounded-xl" aria-label="Close cancellation" onClick={onClose}><X size={17} /></button></div>
      <p className="text-sm text-muted-foreground mt-2 mb-4">{sellerIds ? 'Only this store’s unshipped items will be cancelled. Other stores stay unchanged.' : 'The selected unshipped items will be cancelled and the sellers notified.'}</p>
      {loading && <p role="status" className="flex gap-2 items-center text-sm py-5"><LoaderCircle className="animate-spin" size={18} /> Checking refund amounts…</p>}
      {!!error && <div role="alert" className="rounded-xl p-3 mb-3 bg-red-500/10 text-red-600 text-sm">{error}
        {!busy && <button type="button" className="block underline mt-2" onClick={() => setReload(n => n + 1)}>Refresh refund amounts</button>}</div>}
      {quote && <div className="space-y-3">
        {quote.paymentMethod === 'safepay' && quote.grossMinor > 0 && <p className="text-sm font-semibold">Where would you like your refund?</p>}
        {quote.options.map(option => {
          const Icon = option.destination === 'original_card' ? CreditCard : Wallet;
          return <button key={option.destination} type="button" role={quote.options.length > 1 ? 'radio' : undefined}
            aria-checked={quote.options.length > 1 ? destination === option.destination : undefined}
            disabled={busy || !option.available} onClick={() => { setDestination(option.destination); setAccepted(false); }}
            className={`w-full text-left rounded-2xl p-4 border transition-colors ${destination === option.destination ? 'border-indigo-400 bg-indigo-500/10' : 'border-[var(--glass-border)] bg-white/5'} disabled:opacity-50`}>
            <div className="flex items-center gap-2 font-semibold text-sm"><Icon size={18} /> {option.label}
              {option.destination === 'wallet' && quote.options.length > 1 && <span className="ml-auto text-[10px] rounded-full bg-emerald-500/10 text-emerald-600 px-2 py-1">Full refund</span>}</div>
            {option.destination !== 'none' && <>
              <div className="flex justify-between gap-3 text-xs text-muted-foreground mt-3"><span>Cancelled amount</span><span>{formatMoney(quote.grossMinor / 100)}</span></div>
              {option.destination === 'original_card' && <div className="flex justify-between gap-3 text-xs text-muted-foreground mt-2"><span>Processing fee</span><span>{formatMoney(option.deductionMinor / 100)}</span></div>}
              <div className="flex justify-between gap-3 font-bold text-sm mt-3"><span>You receive</span><span>{formatMoney(option.amountMinor / 100)}</span></div>
              {option.destination === 'original_card' && <p className="text-xs text-muted-foreground mt-2">Returned to the card used for this order after verification. Your bank may take additional time to display it.</p>}
            </>}
          </button>;
        })}
        {consentNeeded && <label className="flex gap-3 items-start text-xs text-muted-foreground p-2"><input type="checkbox" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} className="mt-0.5" />I agree to the processing fee shown above.</label>}
      </div>}
      <div className="flex justify-end gap-3 mt-5"><button type="button" disabled={busy} onClick={onClose} className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold">Keep order</button>
        <button type="button" onClick={cancel} disabled={loading || busy || !quote || !chosen?.available || consentNeeded && !accepted}
          className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-red-500 text-white disabled:opacity-40">{busy ? 'Cancelling…' : sellerIds ? 'Cancel store items' : 'Cancel order'}</button></div>
    </section>
  </div>;
}
