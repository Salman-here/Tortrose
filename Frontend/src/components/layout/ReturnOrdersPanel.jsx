import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, CheckCircle, CreditCard, Loader2, RefreshCw, RotateCcw, Search, WalletCards, X, XCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../utils/cookieHelper';
import { RETURN_STATUS_LABELS, RETURN_STATUS_TRANSITIONS, returnResolutionLabel, returnStatusTone } from '../../utils/returns';

const API = `${import.meta.env.VITE_API_URL}api/returns`;
const actionLabels = {
  approved: 'Approve return',
  pickup_scheduled: 'Pickup scheduled',
  picked_up: 'Mark picked up',
  in_transit_to_seller: 'On the way to seller',
  received_by_seller: 'Mark received',
  under_review: 'Start review',
  rejected: 'Reject return',
};

const authHeaders = () => ({ Authorization: `Bearer ${getAuthToken()}` });

export default function ReturnOrdersPanel({ formatPrice }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (search.trim()) params.set('search', search.trim());
      const response = await axios.get(`${API}/seller?${params}`, { headers: authHeaders() });
      setRequests(response.data?.returns || []);
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to load return orders.');
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    const timeout = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(timeout);
  }, [load, search]);

  const updateStatus = async () => {
    if (!dialog?.request || !dialog?.status) return;
    if (dialog.status === 'rejected' && note.trim().length < 5) {
      toast.error('Add a clear rejection reason.');
      return;
    }
    setSubmitting(true);
    try {
      await axios.patch(`${API}/${dialog.request._id}/status`, { status: dialog.status, note: note.trim() }, { headers: authHeaders() });
      toast.success('Return status updated and the buyer was notified.');
      setDialog(null);
      setNote('');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to update return status.');
    } finally {
      setSubmitting(false);
    }
  };

  const acceptReturn = async (request, fundingSource) => {
    setSubmitting(true);
    try {
      const response = await axios.post(`${API}/${request._id}/accept`, fundingSource ? { fundingSource } : {}, { headers: authHeaders() });
      if (response.data?.requiresPayment && response.data.url) {
        window.location.assign(response.data.url);
        return;
      }
      toast.success(response.data?.msg || 'Return completed and buyer notified.');
      setDialog(null);
      await load();
    } catch (error) {
      const available = error.response?.data?.availableBalanceUSD;
      toast.error(`${error.response?.data?.msg || 'Failed to accept return.'}${Number.isFinite(available) ? ` Available balance: $${available.toFixed(2)}.` : ''}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="glass-panel p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="search-input-wrapper flex-1">
            <div className="search-input-icon"><Search size={16} /></div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="glass-input glass-input-search" placeholder="Search return, order, or reason" />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="glass-input lg:w-56 cursor-pointer">
            <option value="all">All return statuses</option>
            {Object.entries(RETURN_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button type="button" onClick={load} className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center"><Loader2 className="animate-spin" size={24} /></div>
      ) : requests.length === 0 ? (
        <div className="glass-panel py-16 text-center">
          <RotateCcw size={34} className="mx-auto mb-3" style={{ color: 'hsl(var(--muted-foreground))' }} />
          <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>No return orders found</p>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Buyer return requests for your products will appear here.</p>
        </div>
      ) : requests.map((request) => {
        const transitions = RETURN_STATUS_TRANSITIONS[request.status] || [];
        return (
          <article key={request._id} className="glass-panel p-4 sm:p-5">
            <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>#{request.returnNumber}</h3>
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold" style={returnStatusTone(request.status)}>{RETURN_STATUS_LABELS[request.status] || request.status}</span>
                </div>
                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Order #{request.orderId} - {request.buyer?.username || request.buyer?.email || 'Buyer'} - {new Date(request.createdAt).toLocaleString()}</p>
              </div>
              <div className="text-left xl:text-right shrink-0">
                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{returnResolutionLabel(request.policySnapshot?.refundType)}</p>
                {request.policySnapshot?.refundType !== 'replacement_only' && <p className="font-extrabold" style={{ color: 'hsl(var(--foreground))' }}>{formatPrice(request.refund?.totalAmount || 0, { sourceCurrency: request.currency })}</p>}
              </div>
            </div>

            <div className="mt-4 grid sm:grid-cols-2 gap-3">
              {request.items.map((item) => (
                <div key={String(item.orderItemId)} className="glass-inner p-3 rounded-xl flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                    {item.image ? <img src={item.image} alt="" className="w-full h-full object-cover" /> : <RotateCcw size={18} className="m-3" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{item.name}</p>
                    <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Quantity {item.quantity} - {formatPrice(item.lineSubtotal, { sourceCurrency: request.currency })}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl p-3" style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
              <p className="text-xs font-semibold" style={{ color: 'hsl(0, 65%, 48%)' }}>Buyer reason</p>
              <p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: 'hsl(var(--foreground))' }}>{request.reasonDetails}</p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {transitions.map((nextStatus) => (
                <button key={nextStatus} type="button" onClick={() => { setDialog({ type: 'status', request, status: nextStatus }); setNote(''); }}
                  className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2"
                  style={nextStatus === 'rejected' ? { color: 'hsl(0, 72%, 52%)' } : undefined}>
                  {nextStatus === 'rejected' ? <XCircle size={13} /> : <ArrowRight size={13} />} {actionLabels[nextStatus]}
                </button>
              ))}
              {request.status === 'under_review' && (
                <button type="button" onClick={() => setDialog({ type: 'accept', request })} className="px-3 py-2 rounded-lg text-xs font-semibold text-white inline-flex items-center gap-2" style={{ background: 'hsl(150, 60%, 40%)' }}>
                  <CheckCircle size={13} /> Accept return
                </button>
              )}
              {request.status === 'accepted_pending_payment' && (
                <>
                  <span className="text-xs px-3 py-2 rounded-lg" style={{ color: 'hsl(38, 85%, 42%)', background: 'rgba(245,158,11,0.1)' }}>Waiting for verified card payment</span>
                  <button type="button" onClick={() => acceptReturn(request, 'card')} disabled={submitting} className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50">
                    <CreditCard size={13} /> Resume card payment
                  </button>
                </>
              )}
            </div>

            {request.statusHistory?.length > 0 && (
              <details className="mt-4">
                <summary className="text-xs font-semibold cursor-pointer" style={{ color: 'hsl(var(--muted-foreground))' }}>Status history ({request.statusHistory.length})</summary>
                <div className="mt-3 space-y-2">
                  {[...request.statusHistory].reverse().map((entry, index) => (
                    <div key={`${entry.status}-${entry.changedAt}-${index}`} className="text-xs flex items-start gap-2">
                      <span className="w-2 h-2 mt-1.5 rounded-full shrink-0" style={{ background: returnStatusTone(entry.status).color }} />
                      <span style={{ color: 'hsl(var(--muted-foreground))' }}><strong style={{ color: 'hsl(var(--foreground))' }}>{RETURN_STATUS_LABELS[entry.status] || entry.status}</strong> - {new Date(entry.changedAt).toLocaleString()}{entry.note ? ` - ${entry.note}` : ''}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </article>
        );
      })}

      <AnimatePresence>
        {dialog && (
          <motion.div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !submitting && setDialog(null)}>
            <motion.div className="glass-panel-strong w-full max-w-md p-5 sm:p-6" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{dialog.type === 'accept' ? 'Accept return' : actionLabels[dialog.status]}</h3>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Return #{dialog.request.returnNumber}</p>
                </div>
                <button type="button" className="glass-button p-2 rounded-lg" onClick={() => setDialog(null)} aria-label="Close"><X size={16} /></button>
              </div>

              {dialog.type === 'status' ? (
                <>
                  <label className="block text-sm font-medium mt-5 mb-2" style={{ color: 'hsl(var(--foreground))' }}>{dialog.status === 'rejected' ? 'Rejection reason' : 'Note for buyer (optional)'}</label>
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} maxLength={1000} className="glass-input w-full resize-none" placeholder={dialog.status === 'rejected' ? 'Explain why this return cannot be accepted.' : 'Add pickup or review details.'} />
                  <button type="button" onClick={updateStatus} disabled={submitting} className="mt-4 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: dialog.status === 'rejected' ? 'hsl(0, 72%, 52%)' : 'hsl(var(--primary))' }}>
                    {submitting && <Loader2 size={14} className="animate-spin" />} Confirm update
                  </button>
                </>
              ) : dialog.request.policySnapshot?.refundType === 'replacement_only' ? (
                <>
                  <p className="text-sm mt-5" style={{ color: 'hsl(var(--muted-foreground))' }}>This policy provides a replacement instead of a wallet refund. Confirm only after reviewing the returned item.</p>
                  <button type="button" onClick={() => acceptReturn(dialog.request)} disabled={submitting} className="mt-4 w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50" style={{ background: 'hsl(150, 60%, 40%)' }}>
                    {submitting && <Loader2 size={14} className="animate-spin" />} Approve replacement
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm mt-5" style={{ color: 'hsl(var(--muted-foreground))' }}>The return becomes completed only after the full amount is funded and credited to the buyer's Rozare Wallet.</p>
                  <div className="grid gap-3 mt-4">
                    <button type="button" onClick={() => acceptReturn(dialog.request, 'seller_balance')} disabled={submitting} className="glass-button p-4 rounded-xl text-left inline-flex items-start gap-3 disabled:opacity-50">
                      <WalletCards size={19} className="mt-0.5 shrink-0" style={{ color: 'hsl(150, 60%, 40%)' }} />
                      <span><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Use seller balance</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Available delivered online revenue is debited atomically.</span></span>
                    </button>
                    <button type="button" onClick={() => acceptReturn(dialog.request, 'card')} disabled={submitting} className="glass-button p-4 rounded-xl text-left inline-flex items-start gap-3 disabled:opacity-50">
                      <CreditCard size={19} className="mt-0.5 shrink-0" style={{ color: 'hsl(220, 70%, 55%)' }} />
                      <span><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Pay by card</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Stripe verifies the exact amount before wallet credit.</span></span>
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
