import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CalendarClock, Check, Loader2, Package, RotateCcw, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../utils/cookieHelper';
import {
  BUYER_CANCELLABLE_RETURN_STATUSES,
  RETURN_STATUS_LABELS,
  returnResolutionLabel,
  returnStatusTone,
} from '../../utils/returns';

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

export default function BuyerReturnsPanel({ order, formatMoney }) {
  const [groups, setGroups] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [reasonCategory, setReasonCategory] = useState('damaged');
  const [reasonDetails, setReasonDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState(null);

  const load = useCallback(async () => {
    if (!order?._id) return;
    setLoading(true);
    try {
      const [eligibility, existing] = await Promise.all([
        axios.get(`${API}/order/${order._id}/eligibility`, { headers: authHeaders() }),
        axios.get(`${API}/mine?orderId=${encodeURIComponent(order._id)}`, { headers: authHeaders() }),
      ]);
      setGroups(eligibility.data?.groups || []);
      setRequests(existing.data?.returns || []);
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to load return options.');
    } finally {
      setLoading(false);
    }
  }, [order?._id]);

  useEffect(() => { load(); }, [load]);

  const openRequest = (group) => {
    const defaults = {};
    group.items.forEach((item) => {
      if (item.eligible && item.remainingReturnableQuantity > 0) defaults[String(item.orderItemId)] = 0;
    });
    setQuantities(defaults);
    setReasonCategory('damaged');
    setReasonDetails('');
    setSelectedGroup(group);
  };

  const selectedItems = useMemo(() => Object.entries(quantities)
    .filter(([, quantity]) => Number(quantity) > 0)
    .map(([orderItemId, quantity]) => ({ orderItemId, quantity: Number(quantity) })), [quantities]);

  const submitReturn = async () => {
    if (!selectedGroup || selectedItems.length === 0) {
      toast.error('Select at least one item and quantity.');
      return;
    }
    if (reasonDetails.trim().length < 10) {
      toast.error('Please explain the return reason in at least 10 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await axios.post(API, {
        orderId: order._id,
        sellerId: selectedGroup.seller._id,
        items: selectedItems,
        reasonCategory,
        reasonDetails: reasonDetails.trim(),
        requestKey: crypto.randomUUID(),
      }, { headers: authHeaders() });
      toast.success('Return request sent to the seller.');
      setSelectedGroup(null);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Failed to submit return request.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelReturn = async (requestId) => {
    setCancellingId(requestId);
    try {
      await axios.post(`${API}/${requestId}/cancel`, {}, { headers: authHeaders() });
      toast.success('Return request cancelled.');
      await load();
    } catch (error) {
      toast.error(error.response?.data?.msg || 'Return request could not be cancelled.');
    } finally {
      setCancellingId(null);
    }
  };

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

      {requests.map((request) => (
        <article key={request._id} className="glass-panel p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <p className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>Return #{request.returnNumber}</p>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{request.storeName || request.seller?.username || 'Seller'} - {request.items.length} item line(s)</p>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-semibold w-fit" style={returnStatusTone(request.status)}>
              {RETURN_STATUS_LABELS[request.status] || request.status}
            </span>
          </div>
          <div className="mt-4 grid gap-2">
            {request.items.map((item) => (
              <div key={String(item.orderItemId)} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate" style={{ color: 'hsl(var(--foreground))' }}>{item.name} x {item.quantity}</span>
                <span className="shrink-0 font-medium" style={{ color: 'hsl(var(--foreground))' }}>{formatMoney(item.lineSubtotal)}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 pt-3" style={{ borderTop: '1px solid var(--glass-border)' }}>
            <div>
              <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{returnResolutionLabel(request.policySnapshot?.refundType)}</p>
              {request.policySnapshot?.refundType !== 'replacement_only' && <p className="font-bold text-sm" style={{ color: 'hsl(var(--foreground))' }}>{formatMoney(request.refund?.totalAmount || 0)}</p>}
            </div>
            {BUYER_CANCELLABLE_RETURN_STATUSES.has(request.status) && (
              <button type="button" onClick={() => cancelReturn(request._id)} disabled={cancellingId === request._id}
                className="glass-button px-3 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50">
                {cancellingId === request._id ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} Cancel request
              </button>
            )}
          </div>
          {request.statusHistory?.length > 0 && (
            <div className="mt-4 space-y-2">
              {request.statusHistory.map((entry, index) => (
                <div key={`${entry.status}-${entry.changedAt}-${index}`} className="flex gap-3 text-xs">
                  <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: returnStatusTone(entry.status).color }} />
                  <div>
                    <p className="font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{RETURN_STATUS_LABELS[entry.status] || entry.status}</p>
                    <p style={{ color: 'hsl(var(--muted-foreground))' }}>{new Date(entry.changedAt).toLocaleString()}{entry.note ? ` - ${entry.note}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      ))}

      {groups.map((group) => (
        <article key={group.seller._id} className="glass-panel p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <p className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>{group.store?.storeName || group.seller?.username || 'Seller'}</p>
              <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {group.policy?.returnsEnabled ? `${group.policy.returnDuration}-day returns - ${returnResolutionLabel(group.policy.refundType)}` : 'Returns are not offered by this seller'}
              </p>
            </div>
            {group.eligible ? (
              <button type="button" onClick={() => openRequest(group)} className="px-4 py-2 rounded-xl text-sm font-semibold text-white inline-flex items-center justify-center gap-2"
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
      ))}

      <AnimatePresence>
        {selectedGroup && (
          <motion.div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !submitting && setSelectedGroup(null)}>
            <motion.div className="glass-panel-strong w-full max-w-xl max-h-[90vh] overflow-y-auto p-5 sm:p-6" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h3 className="text-lg font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Request a return</h3>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>{selectedGroup.store?.storeName || selectedGroup.seller?.username}</p>
                </div>
                <button type="button" className="glass-button p-2 rounded-lg" onClick={() => setSelectedGroup(null)} aria-label="Close"><X size={16} /></button>
              </div>

              <div className="space-y-3">
                {selectedGroup.items.filter(item => item.eligible && item.remainingReturnableQuantity > 0).map((item) => {
                  const key = String(item.orderItemId);
                  const quantity = quantities[key] || 0;
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
                        <p className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>Up to {item.remainingReturnableQuantity} - {returnResolutionLabel(item.returnPolicy?.refundType)}</p>
                        {item.eligibilityDeadline && <p className="text-[10px] mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>Request by {new Date(item.eligibilityDeadline).toLocaleString()}</p>}
                      </div>
                      {quantity > 0 && (
                        <select value={quantity} onChange={(event) => setQuantities(prev => ({ ...prev, [key]: Number(event.target.value) }))} className="glass-input w-16 py-1.5 text-sm">
                          {Array.from({ length: item.remainingReturnableQuantity }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
                        </select>
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
              <div className="flex justify-end gap-3 mt-5">
                <button type="button" className="glass-button px-4 py-2 rounded-xl text-sm font-semibold" onClick={() => setSelectedGroup(null)} disabled={submitting}>Cancel</button>
                <button type="button" onClick={submitReturn} disabled={submitting} className="px-4 py-2 rounded-xl text-sm font-semibold text-white inline-flex items-center gap-2 disabled:opacity-50" style={{ background: 'hsl(var(--primary))' }}>
                  {submitting && <Loader2 size={14} className="animate-spin" />} Submit request
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
