import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, CheckCircle, CreditCard, Loader2, RefreshCw, RotateCcw, Search, WalletCards, X, XCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../utils/cookieHelper';
import { useAuth } from '../../contexts/AuthContext';
import { openSafepayCheckout } from '../../utils/safepay';
import { createScopedMutationStorageKey, getOrCreatePersistedMutationAttemptInLedger, clearPersistedMutationAttemptFromLedger } from '../../utils/persistedMutationAttempt';
import { RETURN_STATUS_LABELS, RETURN_STATUS_TRANSITIONS, returnResolutionLabel, returnStatusTone, warrantyStatusLabel } from '../../utils/returns';
import { inspectReturnPresentationSnapshot } from '../../utils/returnPresentationSafety';
import { isExactNonNegativeJsonMoney } from '../../utils/sellerMoneySafety';
import { getReturnItemVariantLabels } from '../../utils/returnItemVariants';
import { useReturnDialogAccessibility } from '../../utils/returnDialogAccessibility';
import { useSearchParams } from 'react-router-dom';

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
const displayText = (value, fallback) => (
  typeof value === 'string' && value.trim() ? value.trim() : fallback
);
const formatDateTime = (value) => {
  try {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
  } catch {
    return 'Date unavailable';
  }
};

export default function ReturnOrdersPanel({ formatPrice, kind = 'return' }) {
  const warranty = kind === 'warranty';
  const API = `${import.meta.env.VITE_API_URL}api/${warranty ? 'warranties' : 'returns'}`;
  const labelForStatus = status => warranty ? warrantyStatusLabel(status) : RETURN_STATUS_LABELS[status];
  const { currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedClaim = warranty ? searchParams.get('warrantyId') : null;
  const loadSequence = useRef(0);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [shipment, setShipment] = useState({ shippingMethod: 'courier', carrier: '', trackingNumber: '' });
  const dispatchKey = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const closeDialog = useCallback(() => { if (!submitting) setDialog(null); }, [submitting]);
  const dialogPanel = useReturnDialogAccessibility({ open: Boolean(dialog), busy: submitting, onClose: closeDialog });

  const load = useCallback(async () => {
    const requestId = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    setDialog(null);
    setNote('');
    try {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (search.trim()) params.set('search', search.trim());
      const targeted = linkedClaim && !search.trim() && status === 'all';
      const response = await axios.get(targeted ? `${API}/${linkedClaim}` : `${API}/seller?${params}`, { headers: authHeaders() });
      if (requestId !== loadSequence.current) return;
      const rows = targeted ? (response.data?.returnRequest?.kind === 'warranty' ? [response.data.returnRequest] : null) : response.data?.returns;
      if (!Array.isArray(rows)) {
        throw new Error('The returns service sent an invalid response. Please try again.');
      }
      setRequests(rows);
    } catch (error) {
      if (requestId !== loadSequence.current) return;
      const message = displayText(
        error.response?.data?.msg,
        displayText(error.message, 'Failed to load return orders.'),
      );
      setRequests([]);
      setLoadError(message);
      toast.error(message);
    } finally {
      if (requestId === loadSequence.current) setLoading(false);
    }
  }, [search, status, API, linkedClaim]);

  useEffect(() => {
    const timeout = setTimeout(load, search ? 250 : 0);
    return () => {
      clearTimeout(timeout);
      loadSequence.current += 1;
    };
  }, [load, search]);

  const updateStatus = async () => {
    if (!dialog?.request || !dialog?.status) return;
    if (!inspectReturnPresentationSnapshot(dialog.request).valid) {
      toast.error('This return has an invalid financial snapshot. Refresh before updating its status.');
      setDialog(null);
      return;
    }
    if (!(RETURN_STATUS_TRANSITIONS[dialog.request.status] || []).includes(dialog.status)) {
      toast.error('This status change is no longer available. Refresh the return and try again.');
      setDialog(null);
      return;
    }
    if (dialog.status === 'rejected' && note.trim().length < (warranty ? 10 : 5)) {
      toast.error('Add a clear rejection reason.');
      return;
    }
    setSubmitting(true);
    try {
      await axios.patch(`${API}/${dialog.request._id}/status`, { status: dialog.status, note: note.trim(), expectedUpdatedAt: dialog.request.updatedAt }, { headers: authHeaders() });
      toast.success(`${warranty ? 'Warranty claim' : 'Return status'} updated and the buyer was notified.`);
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
    const snapshot = inspectReturnPresentationSnapshot(request);
    if (!snapshot.valid) {
      toast.error('This return has an invalid financial snapshot. Refresh before accepting it.');
      setDialog(null);
      return;
    }
    const replacementOnly = request.policySnapshot.refundType === 'replacement_only';
    const actionValid = request.status === 'accepted_pending_payment'
      ? !replacementOnly && fundingSource === 'card'
      : request.status === 'under_review' && (
        (replacementOnly && fundingSource === undefined)
        || (!replacementOnly && ['held_order', 'seller_balance', 'card'].includes(fundingSource))
      );
    if (!actionValid) {
      toast.error('This refund action is no longer available. Refresh the return and try again.');
      setDialog(null);
      return;
    }
    setSubmitting(true);
    try {
      let attempt, storageKey, fingerprint;
      if (fundingSource === 'card') {
        storageKey = createScopedMutationStorageKey('rozare_safepay_return_v1', currentUser?._id || currentUser?.id);
        fingerprint = `return:${request._id}`;
        attempt = await getOrCreatePersistedMutationAttemptInLedger({ storage: localStorage, storageKey, fingerprint, keyPrefix: 'web-return' });
      }
      const response = await axios.post(`${API}/${request._id}/accept`, fundingSource ? { fundingSource,
        expectedRefundAmount: snapshot.refund.totalAmount, expectedRefundCurrency: snapshot.currency, expectedReturnUpdatedAt: request.updatedAt,
        ...(attempt ? { paymentProvider: 'safepay', platform: 'web', requestKey: attempt.key } : {}) } : {}, { headers: authHeaders() });
      if (response.data?.requiresPayment) {
        const result = await openSafepayCheckout(response);
        if (['paid', 'cancelled', 'failed', 'refunded'].includes(result.status)) {
          await clearPersistedMutationAttemptFromLedger(localStorage, storageKey, fingerprint, attempt.key);
        }
        if (result.status !== 'paid') {
          toast.info(['cancelled', 'failed', 'refunded'].includes(result.status)
            ? 'This payment is closed. Refresh the return before trying again.'
            : result.status === 'manual_review' ? 'This payment needs support review. Do not pay again.'
              : 'Funding is not confirmed. Resume this same return payment later.');
          await load(); return;
        }
      }
      toast.success(response.data?.msg || 'Return completed and buyer notified.');
      setDialog(null);
      await load();
    } catch (error) {
      const data = error.response?.data;
      const nativeCurrency = ['USD', 'PKR', 'EUR', 'GBP'].includes(data?.availableBalanceCurrency) ? data.availableBalanceCurrency : null;
      const available = nativeCurrency ? data.availableBalance : data?.availableBalanceUSD;
      const availableCurrency = nativeCurrency || 'USD';
      const availableText = isExactNonNegativeJsonMoney(available)
        ? ` Available balance: ${formatPrice(available, { sourceCurrency: availableCurrency, targetCurrency: availableCurrency, showCode: true })}.`
        : '';
      toast.error(`${error.response?.data?.msg || 'Failed to accept return.'}${availableText}`);
    } finally {
      setSubmitting(false);
    }
  };

  const submitDecision = async () => {
    if (note.trim().length < 10 || dialog.status === 'approved' && !['refund', 'replacement'].includes(resolution)) {
      toast.error('Give a clear reason and declare the resolution before approving.'); return;
    }
    setSubmitting(true);
    try {
      await axios.post(`${API}/${dialog.request._id}/decision`, { outcome: dialog.status === 'approved' ? 'approve' : 'reject',
        resolution, reason: note.trim(), expectedUpdatedAt: dialog.request.updatedAt }, { headers: authHeaders() });
      toast.success('Warranty decision sent to the buyer.'); await load();
    } catch (error) { toast.error(error.response?.data?.msg || 'Unable to save the decision.'); }
    finally { setSubmitting(false); }
  };
  const dispatch = async () => {
    if (!dispatchKey.current || !inspectReturnPresentationSnapshot(dialog.request).valid) return;
    setSubmitting(true);
    try {
      const response = await axios.post(`${API}/${dialog.request._id}/replacement/dispatch`, { ...shipment,
        operationKey: dispatchKey.current, expectedUpdatedAt: dialog.request.updatedAt }, { headers: authHeaders() });
      if (!inspectReturnPresentationSnapshot(response.data?.returnRequest).valid || response.data.returnRequest.status !== 'replacement_shipped') throw new Error('Shipment confirmation could not be verified. Refresh the claim before dispatching again.');
      toast.success('Replacement shipped and buyer notified.'); await load();
    } catch (error) { toast.error(error.response?.data?.msg || error.message || 'Unable to dispatch replacement.'); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="space-y-5">
      <div className="glass-panel p-4 sm:p-5">
        {linkedClaim && <div className="flex items-center justify-between gap-3 mb-3"><p className="text-xs text-muted-foreground">Warranty claim opened from your notification</p><button type="button" className="glass-button rounded-lg p-2 text-xs" onClick={() => { const next = new URLSearchParams(searchParams); next.delete('warrantyId'); setSearchParams(next, { replace: true }); }}>View all claims</button></div>}
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="search-input-wrapper flex-1">
            <div className="search-input-icon"><Search size={16} /></div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} className="glass-input glass-input-search" placeholder={warranty ? 'Search claim, order, or reason' : 'Search return, order, or reason'} />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="glass-input lg:w-56 cursor-pointer">
            <option value="all">All {warranty ? 'warranty' : 'return'} statuses</option>
            {Object.keys(RETURN_STATUS_LABELS).map(value => <option key={value} value={value}>{labelForStatus(value)}</option>)}
          </select>
          <button type="button" onClick={load} className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center"><Loader2 className="animate-spin" size={24} /></div>
      ) : loadError ? (
        <div className="glass-panel py-12 px-5 text-center" role="alert">
          <XCircle size={30} className="mx-auto mb-3" style={{ color: 'hsl(0, 72%, 55%)' }} />
          <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Returns unavailable</p>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{loadError}</p>
          <button type="button" onClick={load} className="glass-button px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center gap-2 mt-4">
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : requests.length === 0 ? (
        <div className="glass-panel py-16 text-center">
          <RotateCcw size={34} className="mx-auto mb-3" style={{ color: 'hsl(var(--muted-foreground))' }} />
          <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>No {warranty ? 'warranty claims' : 'return orders'} found</p>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Buyer {warranty ? 'warranty claims and appeals' : 'return requests'} for your products will appear here.</p>
        </div>
      ) : requests.map((rawRequest, requestIndex) => {
        const request = rawRequest && typeof rawRequest === 'object' && !Array.isArray(rawRequest) ? rawRequest : {};
        const snapshot = inspectReturnPresentationSnapshot(request);
        const transitions = snapshot.valid ? (RETURN_STATUS_TRANSITIONS[request.status] || []) : [];
        const requestItems = Array.isArray(request.items) ? request.items : [];
        const statusHistory = Array.isArray(request.statusHistory) ? request.statusHistory : [];
        const returnNumber = displayText(request.returnNumber, 'Unavailable');
        const orderId = displayText(request.orderId, 'Unavailable');
        const buyerName = displayText(request.buyer?.username, displayText(request.buyer?.email, 'Buyer'));
        const statusLabel = labelForStatus(request.status) || displayText(request.status, 'Unknown status');
        return (
          <article key={typeof request._id === 'string' && request._id ? request._id : `invalid-return-${requestIndex}`} className="glass-panel p-4 sm:p-5">
            {!snapshot.valid && (
              <div className="rounded-xl p-3 mb-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert" style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.22)' }}>
                <XCircle size={18} className="shrink-0" style={{ color: 'hsl(0, 72%, 55%)' }} />
                <p className="text-xs flex-1" style={{ color: 'hsl(var(--foreground))' }}>Financial snapshot unavailable. Amounts and seller actions are disabled until a fresh, internally consistent return is loaded.</p>
                <button type="button" onClick={load} className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2"><RefreshCw size={13} /> Retry</button>
              </div>
            )}
            <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold" style={{ color: 'hsl(var(--foreground))' }}>#{returnNumber}</h3>
                  <span className="px-2.5 py-1 rounded-full text-xs font-semibold" style={returnStatusTone(request.status)}>{statusLabel}</span>
                </div>
                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Order #{orderId} - {buyerName} - {formatDateTime(request.createdAt)}</p>
              </div>
              <div className="text-left xl:text-right shrink-0">
                <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{warranty && !request.resolution ? (request.status === 'rejected' ? 'Claim declined — no refund issued' : 'Resolution awaiting your decision') : returnResolutionLabel(request.policySnapshot?.refundType)}</p>
                {request.policySnapshot?.refundType !== 'replacement_only' && (
                  <p className="font-extrabold" style={{ color: snapshot.valid ? 'hsl(var(--foreground))' : 'hsl(0, 72%, 55%)' }}>
                    {snapshot.valid
                      ? formatPrice(snapshot.refund.totalAmount, { sourceCurrency: snapshot.currency, targetCurrency: snapshot.currency, showCode: true })
                      : 'Amount unavailable'}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 grid sm:grid-cols-2 gap-3">
              {requestItems.map((item, itemIndex) => (
                <div key={typeof item?.orderItemId === 'string' && item.orderItemId ? item.orderItemId : `invalid-item-${itemIndex}`} className="glass-inner p-3 rounded-xl flex items-center gap-3">
                  <div className="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                    {typeof item?.image === 'string' && item.image.trim() ? <img src={item.image} alt="" className="w-full h-full object-cover" /> : <RotateCcw size={18} className="m-3" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{displayText(item?.name, 'Item unavailable')}</p>
                    {getReturnItemVariantLabels(item).map(label => <p key={label} className="text-xs break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</p>)}
                    <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      Quantity {snapshot.items[itemIndex]?.quantity ?? 'unavailable'} - {snapshot.valid
                        ? formatPrice(snapshot.items[itemIndex].lineSubtotal, { sourceCurrency: snapshot.currency, targetCurrency: snapshot.currency, showCode: true })
                        : 'Amount unavailable'}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl p-3" style={{ background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
              <p className="text-xs font-semibold" style={{ color: 'hsl(0, 65%, 48%)' }}>Buyer reason</p>
              <p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: 'hsl(var(--foreground))' }}>{displayText(request.reasonDetails, 'Reason unavailable')}</p>
            </div>
            {warranty && snapshot.valid && <div className="mt-4 space-y-3">
              <p className="text-xs text-muted-foreground">Purchased warranty: {request.warrantySnapshot.months} month(s) · Original deadline {formatDateTime(request.warrantySnapshot.deadline)}{request.appealVersion > 0 ? ` · Appeal ${request.appealVersion}` : ''}</p>
              <div className="flex flex-wrap gap-2" aria-label="Buyer claim photos">{request.evidenceUrls.map((url, index) => <a href={url} key={`${url}-${index}`} target="_blank" rel="noopener noreferrer"><img src={url} alt={`Warranty evidence ${index + 1}`} className="w-24 h-24 rounded-xl border border-border object-cover" /></a>)}</div>
              {request.evidenceHistory?.length > 1 && <details><summary className="text-xs font-semibold cursor-pointer text-muted-foreground">Original claim and appeal evidence</summary><div className="mt-3 space-y-3">{request.evidenceHistory.map(entry => <div key={entry.version} className="glass-inner rounded-xl p-3"><p className="text-xs font-bold">{entry.version ? `Appeal ${entry.version}` : 'Original on-time claim'} · {formatDateTime(entry.submittedAt)}</p><p className="text-sm mt-2 whitespace-pre-wrap">{entry.reason}</p><div className="flex flex-wrap gap-2 mt-2">{entry.urls.map((url, index) => <a key={`${entry.version}-${index}`} href={url} target="_blank" rel="noopener noreferrer"><img className="w-20 h-20 object-cover rounded-lg" alt={`${entry.version ? 'Appeal' : 'Original claim'} photo ${index + 1}`} src={url} /></a>)}</div></div>)}</div></details>}
              {request.decisionReason && <p className="glass-inner rounded-xl p-3 text-sm">Your decision: {request.decisionReason}</p>}
            </div>}
            {snapshot.valid && request.replacement?.shippedAt && <div className="glass-inner rounded-xl p-3 mt-4 text-sm"><strong>Replacement shipment</strong><p>{request.replacement.shippingMethod === 'courier' ? `${request.replacement.carrier} · ${request.replacement.trackingNumber}` : 'Hand delivery'} · {formatDateTime(request.replacement.shippedAt)}</p>{request.replacement.deliveredAt && <p>Buyer confirmed receipt: {formatDateTime(request.replacement.deliveredAt)}</p>}</div>}

            <div className="mt-4 flex flex-wrap gap-2">
              {transitions.map((nextStatus) => (
                <button key={nextStatus} type="button" onClick={() => { setDialog({ type: warranty && request.status === 'requested' ? 'decision' : 'status', request, status: nextStatus }); setNote(''); setResolution(''); }}
                  className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2"
                  style={nextStatus === 'rejected' ? { color: 'hsl(0, 72%, 52%)' } : undefined}>
                  {nextStatus === 'rejected' ? <XCircle size={13} /> : <ArrowRight size={13} />} {warranty && nextStatus === 'rejected' ? 'Decline claim' : warranty && request.status === 'requested' ? 'Approve claim' : actionLabels[nextStatus]}
                </button>
              ))}
              {snapshot.valid && request.status === 'under_review' && (
                <button type="button" onClick={() => setDialog({ type: 'accept', request })} className="px-3 py-2 rounded-lg text-xs font-semibold text-white inline-flex items-center gap-2" style={{ background: 'hsl(150, 60%, 40%)' }}>
                  <CheckCircle size={13} /> {warranty ? 'Complete warranty resolution' : 'Accept return'}
                </button>
              )}
              {snapshot.valid && request.status === 'replacement_approved' && <button type="button" className="glass-button px-3 py-2 rounded-lg text-xs font-semibold" onClick={() => { dispatchKey.current = globalThis.crypto?.randomUUID?.(); if (!dispatchKey.current) { toast.error('Secure dispatch is unavailable. Please refresh.'); return; } setShipment({ shippingMethod: 'courier', carrier: '', trackingNumber: '' }); setDialog({ type: 'dispatch', request }); }}>Dispatch replacement</button>}
              {snapshot.valid && request.status === 'accepted_pending_payment' && (
                <>
                  <span className="text-xs px-3 py-2 rounded-lg" style={{ color: 'hsl(38, 85%, 42%)', background: 'rgba(245,158,11,0.1)' }}>Waiting for verified Safepay payment</span>
                  <button type="button" onClick={() => acceptReturn(request, 'card')} disabled={submitting} className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50">
                    <CreditCard size={13} /> Resume Safepay payment
                  </button>
                </>
              )}
            </div>

            {statusHistory.length > 0 && (
              <details className="mt-4">
                <summary className="text-xs font-semibold cursor-pointer" style={{ color: 'hsl(var(--muted-foreground))' }}>Status history ({statusHistory.length})</summary>
                <div className="mt-3 space-y-2">
                  {[...statusHistory].reverse().map((rawEntry, index) => {
                    const entry = rawEntry && typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? rawEntry : {};
                    const entryStatus = labelForStatus(entry.status) || displayText(entry.status, 'Unknown status');
                    const entryNote = displayText(entry.note, '');
                    return (
                      <div key={`${displayText(entry.status, 'unknown')}-${displayText(entry.changedAt, 'unknown')}-${index}`} className="text-xs flex items-start gap-2">
                        <span className="w-2 h-2 mt-1.5 rounded-full shrink-0" style={{ background: returnStatusTone(entry.status).color }} />
                        <span style={{ color: 'hsl(var(--muted-foreground))' }}><strong style={{ color: 'hsl(var(--foreground))' }}>{entryStatus}</strong> - {formatDateTime(entry.changedAt)}{entryNote ? ` - ${entryNote}` : ''}</span>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </article>
        );
      })}

      {typeof document !== 'undefined' && createPortal(<AnimatePresence>
        {dialog && (
          <motion.div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDialog}>
            <motion.div ref={dialogPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-busy={submitting} aria-labelledby="seller-return-dialog-title" className="modal-surface glass-panel-strong w-full max-w-md max-h-[90dvh] overflow-y-auto p-5 sm:p-6" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 id="seller-return-dialog-title" className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{dialog.type === 'dispatch' ? 'Dispatch replacement' : dialog.type === 'decision' ? (dialog.status === 'approved' ? 'Approve warranty claim' : 'Decline warranty claim') : dialog.type === 'accept' ? (warranty ? 'Complete warranty resolution' : 'Accept return') : actionLabels[dialog.status]}</h3>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{warranty ? 'Claim' : 'Return'} #{displayText(dialog.request.returnNumber, 'Unavailable')}</p>
                </div>
                <button type="button" className="glass-button p-2 rounded-lg disabled:opacity-50" disabled={submitting} onClick={closeDialog} aria-label="Close return update"><X size={16} /></button>
              </div>

              {dialog.type === 'decision' ? <div className="space-y-4 mt-5">
                {dialog.status === 'approved' && <label className="block text-sm font-semibold">Planned resolution<select aria-label="Planned resolution" className="glass-input mt-2" value={resolution} onChange={event => setResolution(event.target.value)}><option value="" disabled>Choose a resolution</option><option value="refund">Refund to Rozare Wallet</option><option value="replacement">Replacement product</option></select></label>}
                <label className="block text-sm font-semibold">Decision reason<textarea className="glass-input mt-2" value={note} onChange={event => setNote(event.target.value)} minLength={10} maxLength={1000} rows={4} placeholder="Explain your decision and next steps to the buyer." /></label>
                <p className="text-xs text-muted-foreground">The buyer sees this decision. Approval does not hold earnings or charge a card.</p>
                <button type="button" className="glass-button w-full p-3 rounded-xl font-semibold disabled:opacity-50" disabled={submitting} onClick={submitDecision}>{submitting ? 'Saving…' : 'Confirm decision'}</button>
              </div> : dialog.type === 'dispatch' ? <div className="space-y-4 mt-5">
                <p className="text-sm text-muted-foreground">Dispatch the original product and purchased options. Stock is deducted once. The buyer does not pay again.</p>
                <label className="block text-sm font-semibold">Shipping method<select aria-label="Shipping method" className="glass-input mt-2" value={shipment.shippingMethod} onChange={event => setShipment({ ...shipment, shippingMethod: event.target.value })}><option value="courier">Courier</option><option value="hand_delivery">Hand delivery</option></select></label>
                {shipment.shippingMethod === 'courier' && <><label className="block text-sm font-semibold">Carrier<input className="glass-input mt-2" maxLength={100} value={shipment.carrier} onChange={event => setShipment({ ...shipment, carrier: event.target.value })} /></label><label className="block text-sm font-semibold">Tracking number<input className="glass-input mt-2" maxLength={160} value={shipment.trackingNumber} onChange={event => setShipment({ ...shipment, trackingNumber: event.target.value })} /></label></>}
                <button type="button" className="glass-button w-full p-3 rounded-xl font-semibold disabled:opacity-50" disabled={submitting} onClick={dispatch}>{submitting ? 'Dispatching…' : 'Confirm dispatch'}</button>
              </div> : dialog.type === 'status' ? (
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
              ) : dialog.request.refundFundingPolicy === 'held_order' ? (
                <>
                  <div className="glass-inner rounded-2xl p-4 mt-5 flex items-start gap-3">
                    <WalletCards size={22} className="shrink-0 text-emerald-600" />
                    <p className="text-sm text-muted-foreground">This refund uses the money held from the original order. The buyer receives the approved amount in their Rozare Wallet; no additional card payment or withdrawable earnings are needed.</p>
                  </div>
                  <button type="button" onClick={() => acceptReturn(dialog.request, 'held_order')} disabled={submitting}
                    className="glass-button mt-4 w-full rounded-xl px-4 py-3 font-semibold text-sm inline-flex justify-center items-center gap-2 disabled:opacity-50">
                    {submitting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />} Refund held order funds
                  </button>
                </>
              ) : (
                <>
                  <p className="text-sm mt-5" style={{ color: 'hsl(var(--muted-foreground))' }}>The return becomes completed only after the full amount is funded and credited to the buyer's Rozare Wallet.</p>
                  <div className="grid gap-3 mt-4">
                    <button type="button" onClick={() => acceptReturn(dialog.request, 'seller_balance')} disabled={submitting} className="glass-button p-4 rounded-xl text-left inline-flex items-start gap-3 disabled:opacity-50">
                      <WalletCards size={19} className="mt-0.5 shrink-0" style={{ color: "var(--modal-success)" }} />
                      <span><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Use seller balance</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Available delivered online revenue is debited atomically.</span></span>
                    </button>
                    <button type="button" onClick={() => acceptReturn(dialog.request, 'card')} disabled={submitting} className="glass-button p-4 rounded-xl text-left inline-flex items-start gap-3 disabled:opacity-50">
                      <CreditCard size={19} className="mt-0.5 shrink-0" style={{ color: "var(--modal-info)" }} />
                      <span><strong className="block text-sm" style={{ color: 'hsl(var(--foreground))' }}>Pay through Safepay</strong><span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Safepay verifies the exact amount before wallet credit.</span></span>
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>, document.body)}
    </div>
  );
}
