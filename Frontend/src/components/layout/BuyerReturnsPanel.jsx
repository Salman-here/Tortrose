import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CalendarClock, Check, Loader2, Package, RotateCcw, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../utils/cookieHelper';
import { startCancellationRefundRefresh } from '../../utils/orderCancellationPresentation';
import {
  BUYER_CANCELLABLE_RETURN_STATUSES,
  RETURN_STATUS_LABELS,
  returnResolutionLabel,
  returnGroupPolicyLabel,
  returnStatusTone,
} from '../../utils/returns';
import {
  fetchCompleteBuyerReturns,
  inspectBuyerReturnEligibilityResponse,
  inspectBuyerReturnMutationResponse,
  inspectBuyerReturnOrderContext,
  inspectBuyerReturnsResponse,
} from '../../utils/returnPresentationSafety';
import { getReturnItemVariantLabels } from '../../utils/returnItemVariants';
import { useReturnDialogAccessibility } from '../../utils/returnDialogAccessibility';

const API = `${import.meta.env.VITE_API_URL}api/returns`;
const reasonOptions = [
  ['damaged', 'Arrived damaged'],
  ['defective', 'Defective or not working'],
  ['wrong_item', 'Wrong item received'],
  ['not_as_described', 'Not as described'],
  ['size_or_fit', 'Size or fit issue'],
  ['changed_mind', 'Changed my mind'],
  ['other', 'Other'],
];

const authHeaders = () => ({ Authorization: `Bearer ${getAuthToken()}` });
const reasonValues = new Set(reasonOptions.map(([value]) => value));
const UNRESOLVED_RETURN_STATUSES = new Set([
  'requested', 'approved', 'pickup_scheduled', 'picked_up',
  'in_transit_to_seller', 'received_by_seller', 'under_review',
  'accepted_pending_payment',
]);
const activeReturnForSeller = (requests, orderId, sellerId) => requests.find(request => (
  request.order === orderId && request.seller._id === sellerId
  && UNRESOLVED_RETURN_STATUSES.has(request.status)
)) || null;
const activeReturnHint = request => `Return ${request.returnNumber} is in progress. You can request another return from this store after it is resolved.`;
const canonicalRequestKey = value => (
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value
    : null
);
const createRequestKey = () => canonicalRequestKey(globalThis.crypto?.randomUUID?.());
const isTransientReadError = error => error?.isAxiosError === true && (
  !error.response || error.response.status >= 500
  || error.response.status === 408 || error.response.status === 429
);
const responseMessage = (error, fallback) => {
  const value = error?.response?.data?.msg;
  return typeof value === 'string' && value.trim() && value.length <= 500
    ? value.trim()
    : fallback;
};

export default function BuyerReturnsPanel({ order, formatMoney }) {
  const [groups, setGroups] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [reasonCategory, setReasonCategory] = useState('damaged');
  const [reasonDetails, setReasonDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const closeDialog = useCallback(() => { if (!submitting) setSelectedGroup(null); }, [submitting]);
  const dialogPanel = useReturnDialogAccessibility({ open: Boolean(selectedGroup), busy: submitting, onClose: closeDialog });
  const requestKeyRef = useRef(null);
  const [cancellingId, setCancellingId] = useState(null);
  const loadGenerationRef = useRef(0);
  const loadInFlightRef = useRef(null);
  const mutationInProgressRef = useRef(false);
  const mutationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const orderContext = useMemo(() => inspectBuyerReturnOrderContext(order), [order]);
  const currentOrderIdRef = useRef(null);
  currentOrderIdRef.current = orderContext.valid ? orderContext.orderId : null;

  const clearPresentedState = useCallback(({ closeForm = true } = {}) => {
    setGroups([]);
    setRequests([]);
    setCancellingId(null);
    if (closeForm) {
      setSelectedGroup(null);
      setQuantities({});
    }
  }, []);

  const load = useCallback(async ({ notify = true, silent = false } = {}) => {
    if (silent && (loadInFlightRef.current || mutationInProgressRef.current)) {
      return { valid: false, skipped: true, requests: [], groups: [] };
    }
    const previousLoad = loadInFlightRef.current;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    if (!silent) {
      clearPresentedState();
      setLoadError('');
      setLoading(true);
    }
    if (!orderContext.valid) {
      const message = 'Return information is unavailable because this order could not be verified.';
      setLoadError(message);
      setLoading(false);
      return { valid: false, requests: [], groups: [] };
    }
    // Explicit and mutation reloads supersede a poll, then wait until its
    // complete eligibility/list snapshot has finished before reading again.
    if (previousLoad) await previousLoad.done;
    const isCurrent = () => mountedRef.current
      && generation === loadGenerationRef.current
      && currentOrderIdRef.current === orderContext.orderId;
    if (!isCurrent()) return { valid: false, stale: true, requests: [], groups: [] };
    let finishLoad;
    const currentLoad = { done: new Promise(resolve => { finishLoad = resolve; }) };
    loadInFlightRef.current = currentLoad;
    const reads = [];
    const read = (...args) => {
      const result = axios.get(...args);
      reads.push(result);
      return result;
    };
    try {
      const results = await Promise.allSettled([
        read(`${API}/order/${orderContext.orderId}/eligibility`, { headers: authHeaders(), timeout: 20000 }),
        fetchCompleteBuyerReturns(async (page, limit) => {
          const response = await read(`${API}/mine`, {
            headers: authHeaders(),
            params: { orderId: orderContext.orderId, page, limit },
            timeout: 20000,
          });
          return response.data;
        }),
      ]);
      const eligibilityInspection = results[0].status === 'fulfilled'
        ? inspectBuyerReturnEligibilityResponse(results[0].value.data, orderContext)
        : null;
      const returnsInspection = results[1].status === 'fulfilled'
        ? inspectBuyerReturnsResponse(results[1].value, orderContext, eligibilityInspection)
        : null;
      // A malformed sibling response must still fail closed when the other
      // endpoint has a temporary connection failure.
      if (
        (eligibilityInspection && !eligibilityInspection.valid)
        || (returnsInspection && returnsInspection.errors.some(error => error !== 'eligibility'))
      ) {
        const error = new Error('Unverified return response');
        error.code = 'RETURN_RESPONSE_UNVERIFIED';
        throw error;
      }
      const failed = results.find(result => result.status === 'rejected' && !isTransientReadError(result.reason))
        || results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (!isCurrent()) {
        return { valid: false, stale: true, requests: [], groups: [] };
      }
      setGroups(eligibilityInspection.groups);
      setRequests(returnsInspection.requests);
      setLoadError('');
      return {
        valid: true,
        groups: eligibilityInspection.groups,
        requests: returnsInspection.requests,
      };
    } catch (error) {
      if (!isCurrent()) {
        return { valid: false, stale: true, requests: [], groups: [] };
      }
      if (silent && isTransientReadError(error)) return { valid: false, requests: [], groups: [] };
      clearPresentedState({ closeForm: !silent });
      const message = error?.code === 'RETURN_RESPONSE_UNVERIFIED' || !error?.isAxiosError
        ? 'Return information is temporarily unavailable because the server response could not be verified.'
        : responseMessage(error, 'Could not load verified return information.');
      setLoadError(message);
      if (notify) toast.error(message);
      return { valid: false, requests: [], groups: [] };
    } finally {
      await Promise.allSettled(reads);
      if (loadInFlightRef.current === currentLoad) loadInFlightRef.current = null;
      finishLoad();
      if (!silent && isCurrent()) setLoading(false);
    }
  }, [clearPresentedState, orderContext]);

  useEffect(() => {
    mountedRef.current = true;
    mutationInProgressRef.current = false;
    setSubmitting(false);
    void load();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
    };
  }, [load]);

  const returnPending = requests.some(request => UNRESOLVED_RETURN_STATUSES.has(request.status));
  useEffect(() => {
    if (!returnPending || submitting || cancellingId) return;
    const isActive = () => mountedRef.current
      && document.visibilityState !== 'hidden'
      && document.hasFocus()
      && !mutationInProgressRef.current;
    const refresh = () => {
      if (isActive()) void load({ notify: false, silent: true });
    };
    const stop = startCancellationRefundRefresh(
      () => load({ notify: false, silent: true }),
      isActive,
    );
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      stop();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [returnPending, submitting, cancellingId, load]);

  const openRequest = (group) => {
    const current = groups.find(entry => entry.seller._id === group?.seller?._id);
    const activeReturn = current && activeReturnForSeller(requests, orderContext.orderId, current.seller._id);
    if (activeReturn) {
      toast.error(activeReturnHint(activeReturn));
      return;
    }
    if (!current?.eligible) {
      toast.error('This return option is no longer available.');
      return;
    }
    const requestKey = createRequestKey();
    if (!requestKey) {
      toast.error('A secure return request could not be started. Please reload and try again.');
      return;
    }
    const defaults = {};
    current.items.forEach((item) => {
      if (item.eligible && item.remainingReturnableQuantity > 0) defaults[item.orderItemId] = 0;
    });
    setQuantities(defaults);
    setReasonCategory('damaged');
    setReasonDetails('');
    requestKeyRef.current = requestKey;
    setSelectedGroup(current);
  };

  const selectedActiveReturn = selectedGroup
    ? activeReturnForSeller(requests, orderContext.orderId, selectedGroup.seller._id)
    : null;
  const selection = useMemo(() => {
    if (!selectedGroup) return { valid: false, items: [] };
    const current = groups.find(group => group.seller._id === selectedGroup.seller._id);
    if (!current?.eligible || selectedActiveReturn) return { valid: false, items: [] };
    const selectable = current.items.filter(
      item => item.eligible && item.remainingReturnableQuantity > 0,
    );
    const selectableIds = new Set(selectable.map(item => item.orderItemId));
    if (Object.keys(quantities).some(key => !selectableIds.has(key))) {
      return { valid: false, items: [] };
    }
    const items = [];
    for (const item of selectable) {
      const quantity = Object.prototype.hasOwnProperty.call(quantities, item.orderItemId)
        ? quantities[item.orderItemId]
        : null;
      if (
        !Number.isSafeInteger(quantity)
        || quantity < 0
        || quantity > item.remainingReturnableQuantity
      ) return { valid: false, items: [] };
      if (quantity > 0) {
        const draftItem = selectedGroup.items.find(entry => entry.orderItemId === item.orderItemId);
        if (draftItem?.returnPolicy?.refundType !== item.returnPolicy?.refundType) {
          return { valid: false, items: [] };
        }
        items.push({ orderItemId: item.orderItemId, quantity });
      }
    }
    return { valid: true, items };
  }, [quantities, selectedGroup, groups, selectedActiveReturn]);

  const selectedItems = selection.items;

  const submitReturn = async () => {
    if (mutationInProgressRef.current || !mountedRef.current || loadError || currentOrderIdRef.current !== orderContext.orderId) return;
    if (selectedActiveReturn) {
      toast.error(activeReturnHint(selectedActiveReturn));
      return;
    }
    if (!selectedGroup || !selection.valid || selectedItems.length === 0) {
      toast.error('Select at least one item and quantity.');
      return;
    }
    const cleanReason = reasonDetails.trim();
    if (!reasonValues.has(reasonCategory) || cleanReason.length < 10 || cleanReason.length > 1500) {
      toast.error('Please explain the return reason in at least 10 characters.');
      return;
    }
    const requestKey = canonicalRequestKey(requestKeyRef.current);
    if (!requestKey) {
      toast.error('This return form is no longer valid. Please close it and start again.');
      return;
    }
    const expectedSellerId = selectedGroup.seller._id;
    const expectedItems = selectedItems.map(item => ({ ...item }));
    const mutationGeneration = ++mutationGenerationRef.current;
    const isMutationCurrent = () => mountedRef.current
      && mutationGeneration === mutationGenerationRef.current
      && currentOrderIdRef.current === orderContext.orderId;
    mutationInProgressRef.current = true;
    loadGenerationRef.current += 1;
    setSubmitting(true);
    setGroups([]);
    setRequests([]);
    setLoadError('');
    try {
      const response = await axios.post(API, {
        orderId: orderContext.orderId,
        sellerId: expectedSellerId,
        items: expectedItems,
        reasonCategory,
        reasonDetails: cleanReason,
        requestKey,
      }, {
        headers: {
          ...authHeaders(),
          'Idempotency-Key': requestKey,
        },
      });
      if (!isMutationCurrent()) return;
      const mutation = inspectBuyerReturnMutationResponse(response.data, orderContext, {
        mode: 'create',
        expectedSellerId,
        expectedItems,
        expectedReasonCategory: reasonCategory,
        expectedReasonDetails: cleanReason,
      });
      const refreshed = await load({ notify: false });
      if (refreshed.stale || !isMutationCurrent()) return;
      const refetched = mutation.valid
        ? refreshed.requests.find(request => request._id === mutation.request._id)
        : null;
      if (!mutation.valid || !refreshed.valid || !refetched) {
        clearPresentedState();
        setLoadError('The request may have been received, but its saved state could not be verified. Reload before taking another action.');
        toast.error('Return confirmation is unavailable. Reload before trying again.');
        return;
      }
      requestKeyRef.current = null;
      toast.success(response.data.replayed
        ? 'This return request was already received.'
        : 'Return request sent to the seller.');
    } catch (error) {
      if (!isMutationCurrent()) return;
      if (error?.response?.status === 409 && error?.response?.data?.code === 'RETURN_REQUEST_ALREADY_OPEN') {
        requestKeyRef.current = null;
        setSelectedGroup(null);
        setQuantities({});
        const refreshed = await load({ notify: false });
        if (refreshed.stale || !isMutationCurrent()) return;
        toast.error(`${responseMessage(error, 'Another return is already in progress for this store.')} ${refreshed.valid ? 'Return information has been refreshed.' : 'Reload return information before starting another request.'}`);
        return;
      }
      setGroups([]);
      setRequests([]);
      setLoadError('Return information must be verified again before retrying this saved request.');
      toast.error(responseMessage(error, 'Failed to submit return request. You can retry this form safely.'));
    } finally {
      if (mutationGeneration === mutationGenerationRef.current) {
        mutationInProgressRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    }
  };

  const cancelReturn = async (requestId) => {
    if (mutationInProgressRef.current || !mountedRef.current || currentOrderIdRef.current !== orderContext.orderId) return;
    const current = requests.find(request => request._id === requestId);
    if (!current || !BUYER_CANCELLABLE_RETURN_STATUSES.has(current.status)) {
      toast.error('This return can no longer be cancelled.');
      return;
    }
    const mutationGeneration = ++mutationGenerationRef.current;
    const isMutationCurrent = () => mountedRef.current
      && mutationGeneration === mutationGenerationRef.current
      && currentOrderIdRef.current === orderContext.orderId;
    mutationInProgressRef.current = true;
    loadGenerationRef.current += 1;
    setCancellingId(requestId);
    setGroups([]);
    setRequests([]);
    setLoadError('');
    try {
      const response = await axios.post(`${API}/${requestId}/cancel`, {}, { headers: authHeaders() });
      if (!isMutationCurrent()) return;
      const mutation = inspectBuyerReturnMutationResponse(response.data, orderContext, {
        mode: 'cancel',
        expectedRequestId: requestId,
        expectedStatus: 'cancelled_by_buyer',
      });
      const refreshed = await load({ notify: false });
      if (refreshed.stale || !isMutationCurrent()) return;
      const refetched = refreshed.requests.find(request => request._id === requestId);
      if (!mutation.valid || !refreshed.valid || refetched?.status !== 'cancelled_by_buyer') {
        clearPresentedState();
        setLoadError('The cancellation response could not be verified. Reload before taking another action.');
        toast.error('Cancellation confirmation is unavailable.');
        return;
      }
      toast.success('Return request cancelled.');
    } catch (error) {
      if (!isMutationCurrent()) return;
      const refreshed = await load({ notify: false });
      if (refreshed.stale || !isMutationCurrent()) return;
      const refetched = refreshed.requests.find(request => request._id === requestId);
      if (refreshed.valid && refetched?.status === 'cancelled_by_buyer') {
        toast.success('Return request cancelled.');
        return;
      }
      toast.error(responseMessage(error, 'Return request could not be cancelled.'));
    } finally {
      if (mutationGeneration === mutationGenerationRef.current) {
        mutationInProgressRef.current = false;
        if (mountedRef.current) setCancellingId(null);
      }
    }
  };

  const moneyLabel = useCallback((amount) => {
    try {
      const label = formatMoney(amount);
      return typeof label === 'string' && label.trim() ? label : 'Money unavailable';
    } catch (_) {
      return 'Money unavailable';
    }
  }, [formatMoney]);

  if (loading) {
    return <div className="glass-panel p-6 flex items-center justify-center"><Loader2 className="animate-spin" size={20} /></div>;
  }

  return (
    <section className="mt-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-semibold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
            <RotateCcw size={18} style={{ color: 'hsl(var(--primary))' }} /> Returns
          </h2>
          <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>Return eligibility is calculated separately for each seller.</p>
        </div>
      </div>

      {loadError && (
        <div className="glass-panel p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" role="alert">
          <p className="text-sm inline-flex items-start gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
            <AlertCircle size={16} className="shrink-0 mt-0.5" /> {loadError}
          </p>
          <button type="button" className="glass-button px-3 py-2 rounded-lg text-xs font-semibold" onClick={() => load()} disabled={loading}>
            Retry
          </button>
        </div>
      )}

      {requests.map((request) => (
        <article key={request._id} className="glass-panel p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <p className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>Return #{request.returnNumber}</p>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{request.storeName || request.seller?.username || 'Seller'} - {request.items.length} item line(s)</p>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-semibold w-fit" style={returnStatusTone(request.status)}>
              {RETURN_STATUS_LABELS[request.status]}
            </span>
          </div>
          <div className="mt-4 grid gap-2">
            {request.items.map((item) => (
              <div key={item.orderItemId} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate" style={{ color: 'hsl(var(--foreground))' }}>{item.name} x {item.quantity}</p>
                  {getReturnItemVariantLabels(item).map(label => <p key={label} className="text-xs break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</p>)}
                </div>
                <span className="shrink-0 font-medium" style={{ color: 'hsl(var(--foreground))' }}>{moneyLabel(item.lineSubtotal)}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3" style={{ borderTop: '1px solid var(--glass-border)' }}>
            <div>
              <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{returnResolutionLabel(request.policySnapshot?.refundType)}</p>
              {request.policySnapshot.refundType !== 'replacement_only' && <p className="font-bold text-sm" style={{ color: 'hsl(var(--foreground))' }}>{moneyLabel(request.refund.totalAmount)}</p>}
            </div>
            {BUYER_CANCELLABLE_RETURN_STATUSES.has(request.status) && (
              <button type="button" onClick={() => cancelReturn(request._id)} disabled={cancellingId === request._id}
                className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50">
                {cancellingId === request._id ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Cancel request
              </button>
            )}
          </div>
          {request.statusHistory.length > 0 && (
            <div className="mt-4 space-y-2">
              {request.statusHistory.map((entry, index) => (
                <div key={`${entry.status}-${entry.changedAt}-${index}`} className="flex gap-3 text-xs">
                  <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: returnStatusTone(entry.status).color }} />
                  <div>
                    <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{RETURN_STATUS_LABELS[entry.status]}</p>
                    <p style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(entry.changedAt).toLocaleString()}{entry.note ? ` - ${entry.note}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      ))}

      {groups.map((group) => {
        const activeReturn = activeReturnForSeller(requests, orderContext.orderId, group.seller._id);
        return (
        <article key={group.seller._id} className="glass-panel p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>{group.store?.storeName || group.seller?.username || 'Seller'}</p>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {returnGroupPolicyLabel(group)}
              </p>
              {activeReturn && <p className="text-xs mt-2" style={{ color: 'hsl(var(--muted-foreground))' }}>{activeReturnHint(activeReturn)}</p>}
            </div>
            {group.eligible ? (
              <button type="button" onClick={() => openRequest(group)} disabled={Boolean(activeReturn)} aria-label={`Request return from ${group.store?.storeName || group.seller.username || 'Seller'}`} className="px-4 py-2 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(180, 65%, 42%))' }}>
                <RotateCcw size={15} /> Request return
              </button>
            ) : (
              <span className="text-xs inline-flex items-start gap-2 max-w-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                <AlertCircle size={14} className="shrink-0 mt-0.5" /> {group.reason}
              </span>
            )}
          </div>
          {group.eligibilityDeadline && (
            <p className="text-xs mt-3 inline-flex items-center gap-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
              <CalendarClock size={13} /> Request by {new Date(group.eligibilityDeadline).toLocaleString()}
            </p>
          )}
        </article>
        );
      })}

      {typeof document !== 'undefined' && createPortal(<AnimatePresence>
        {selectedGroup && (
          <motion.div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeDialog}>
            <motion.div ref={dialogPanel} tabIndex={-1} role="dialog" aria-modal="true" aria-busy={submitting} aria-labelledby="buyer-return-dialog-title" className="glass-panel-strong w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 sm:p-6" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h3 id="buyer-return-dialog-title" className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Request a return</h3>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{selectedGroup.store?.storeName || selectedGroup.seller?.username}</p>
                </div>
                <button type="button" className="glass-button p-2 rounded-lg disabled:opacity-50" disabled={submitting} onClick={closeDialog} aria-label="Close return request"><X size={16} /></button>
              </div>

              <div className="space-y-3">
                {selectedGroup.items.filter(item => item.eligible && item.remainingReturnableQuantity > 0).map((item) => {
                  const key = item.orderItemId;
                  const quantity = quantities[key];
                  return (
                    <div key={key} className="glass-inner p-3 rounded-xl flex items-center gap-3">
                      <button type="button" onClick={() => setQuantities(prev => ({ ...prev, [key]: quantity ? 0 : 1 }))}
                        className="w-5 h-5 rounded flex items-center justify-center shrink-0" aria-label={`Select ${item.name}`}
                        style={{ border: '1px solid var(--glass-border)', background: quantity ? 'hsl(var(--primary))' : 'transparent', color: 'white' }}>
                        {quantity > 0 && <Check size={13} />}
                      </button>
                      <div className="w-11 h-11 rounded-lg overflow-hidden glass-inner shrink-0">
                        {item.image ? <img src={item.image} alt="" className="w-full h-full object-cover" /> : <Package className="m-3" size={18} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{item.name}</p>
                        {getReturnItemVariantLabels(item).map(label => <p key={label} className="text-xs break-words" style={{ color: 'hsl(var(--muted-foreground))' }}>{label}</p>)}
                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Up to {item.remainingReturnableQuantity} - {returnResolutionLabel(item.returnPolicy?.refundType)}</p>
                        {item.eligibilityDeadline && <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Request by {new Date(item.eligibilityDeadline).toLocaleString()}</p>}
                      </div>
                      {quantity > 0 && (
                        <input type="number" min="1" max={item.remainingReturnableQuantity} step="1" value={quantity} onChange={(event) => {
                          const raw = event.target.value;
                          const parsed = /^[1-9]\d*$/u.test(raw) ? Number(raw) : null;
                          if (Number.isSafeInteger(parsed) && parsed <= item.remainingReturnableQuantity) {
                            setQuantities(prev => ({ ...prev, [key]: parsed }));
                          }
                        }} className="glass-input w-20 py-1.5 text-sm" aria-label={`Return quantity for ${item.name}`} />
                      )}
                    </div>
                  );
                })}
              </div>

              {selectedGroup.policyVariants?.length > 1 && (
                <p className="text-xs mt-3" style={{ color: 'hsl(38, 85%, 42%)' }}>Items with different refund or replacement resolutions must be submitted in separate requests.</p>
              )}

              <label className="block text-sm font-medium mt-5 mb-2" style={{ color: 'hsl(var(--foreground))' }}>Reason</label>
              <select value={reasonCategory} onChange={(event) => setReasonCategory(event.target.value)} className="glass-input w-full">
                {reasonOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <label className="block text-sm font-medium mt-4 mb-2" style={{ color: 'hsl(var(--foreground))' }}>What happened?</label>
              <textarea value={reasonDetails} onChange={(event) => setReasonDetails(event.target.value)} maxLength={1500} rows={4} className="glass-input w-full resize-none" placeholder="Describe the issue clearly for the seller." />
              {loadError && (
                <div className="mt-4 text-xs" role="alert" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <p>Return information must be verified again before submitting. Your draft is saved here.</p>
                  <button type="button" className="glass-button px-3 py-2 rounded-lg mt-2" onClick={() => load({ notify: false, silent: true })} disabled={submitting}>
                    Retry return information
                  </button>
                </div>
              )}
              {!loadError && !submitting && selectedActiveReturn && <p className="mt-4 text-xs" role="alert" style={{ color: 'hsl(var(--muted-foreground))' }}>{activeReturnHint(selectedActiveReturn)}</p>}
              <div className="flex justify-end gap-3 mt-5">
                <button type="button" className="glass-button px-4 py-2 rounded-xl text-sm font-semibold" onClick={closeDialog} disabled={submitting}>Cancel</button>
                <button type="button" onClick={submitReturn} disabled={submitting || !selection.valid || Boolean(loadError)} className="px-4 py-2 rounded-xl text-sm font-semibold text-white inline-flex items-center gap-2 disabled:opacity-50" style={{ background: 'hsl(var(--primary))' }}>
                  {submitting && <Loader2 size={14} className="animate-spin" />} Submit request
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>, document.body)}
    </section>
  );
}
