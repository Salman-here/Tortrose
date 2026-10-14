import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import { ShieldCheck, Camera, Loader2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../utils/cookieHelper';
import { inspectWarrantyCoverage, inspectWarrantyList } from '../../utils/warrantySafety';
import { BUYER_CANCELLABLE_RETURN_STATUSES, warrantyStatusLabel, returnStatusTone } from '../../utils/returns';
import { useReturnDialogAccessibility } from '../../utils/returnDialogAccessibility';
import AfterSalesConfirmDialog from '../common/AfterSalesConfirmDialog';
import { publishAfterSalesChange, subscribeAfterSalesChange } from '../../utils/afterSalesRefresh';

const API = `${import.meta.env.VITE_API_URL}api/warranties`;
const options = () => ({ headers: { Authorization: `Bearer ${getAuthToken()}` }, timeout: 20000 });
const date = value => new Date(value).toLocaleString();

export default function BuyerWarrantyPanel({ order, formatMoney }) {
  const [groups, setGroups] = useState([]), [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [dialog, setDialog] = useState(null), [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [reason, setReason] = useState(''), [quantity, setQuantity] = useState(1), [photos, setPhotos] = useState([]);
  const key = useRef(null), generation = useRef(0), mutation = useRef(false);
  const close = useCallback(() => { if (!mutation.current) setDialog(null); }, []);
  const panel = useReturnDialogAccessibility({ open: Boolean(dialog), busy, onClose: close });
  const load = useCallback(async ({ quiet = false } = {}) => {
    const sequence = ++generation.current;
    if (!quiet) setLoading(true); setError('');
    try {
      const coverage = await axios.get(`${API}/order/${order._id}/eligibility`, options());
      const rows = [];
      for (let page = 1; ; page += 1) {
        const response = await axios.get(`${API}/mine?orderId=${order._id}&page=${page}&limit=100`, options());
        if (!Array.isArray(response.data?.returns) || response.data.pagination?.page !== page || !Number.isSafeInteger(response.data.pagination.totalPages) || response.data.pagination.totalPages < page) throw new Error('Warranty history could not be verified.');
        rows.push(...response.data.returns);
        if (page >= response.data.pagination.totalPages) break;
        if (page >= 1000) throw new Error('Warranty history needs support review.');
      }
      const checked = inspectWarrantyCoverage(coverage.data, order);
      if (!checked.valid || !inspectWarrantyList(rows, order)) throw new Error('Warranty details could not be verified. Reload before submitting a claim.');
      if (generation.current !== sequence) return;
      setGroups(checked.groups); setClaims(rows);
    } catch (failure) {
      if (generation.current !== sequence) return;
      setGroups([]); setClaims([]); setError(failure.response?.data?.msg || failure.message || 'Warranty details are unavailable.');
    } finally { if (generation.current === sequence) setLoading(false); }
  }, [order]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load]);
  useEffect(() => subscribeAfterSalesChange(orderId => {
    if (orderId === order._id && !mutation.current && !dialog && !confirmation) void load({ quiet: true });
  }), [load, order._id, dialog, confirmation]);
  const activeClaim = claims.some(claim => !['returned', 'replacement_delivered', 'rejected', 'cancelled_by_buyer'].includes(claim.status));
  useEffect(() => {
    const refresh = () => { if (!mutation.current && !dialog && !confirmation && document.visibilityState === 'visible') load({ quiet: true }); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    const interval = activeClaim ? setInterval(refresh, 30000) : null;
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); if (interval) clearInterval(interval); };
  }, [load, activeClaim, dialog, confirmation]);

  const open = selection => {
    key.current = globalThis.crypto?.randomUUID?.();
    if (!key.current) { toast.error('Secure claim submission is unavailable. Please refresh.'); return; }
    setDialog(selection); setReason(''); setQuantity(1);
    setPhotos(selection.claim ? selection.claim.evidence.map((id, index) => ({ _id: id, url: selection.claim.evidenceUrls[index] })) : []);
  };
  const upload = async event => {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (files.length + photos.length > 6 || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5242880)) { toast.error('Attach up to 6 JPEG, PNG or WebP photos, each up to 5 MB.'); return; }
    mutation.current = true; setBusy(true);
    try {
      for (const file of files) {
        const form = new FormData(); form.append('photo', file); form.append('orderId', order._id);
        if (dialog.claim) form.append('claimId', dialog.claim._id);
        const response = await axios.post(`${API}/evidence`, form, { ...options(), timeout: 60000 });
        const photo = response.data?.evidence;
        if (!/^[a-f\d]{24}$/iu.test(photo?._id || '') || !/^https:\/\//u.test(photo?.url || '')) throw new Error('Uploaded photo could not be verified.');
        setPhotos(previous => [...previous, photo]);
      }
    } catch (failure) { toast.error(failure.response?.data?.msg || 'A photo could not be uploaded. Please retry.'); }
    finally { mutation.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (mutation.current) return;
    const current = dialog.claim ? claims.find(claim => claim._id === dialog.claim._id) : groups.flatMap(group => group.items).find(item => item.orderItemId === dialog.item.orderItemId);
    if (error || reason.trim().length < 10 || !photos.length || !Number.isSafeInteger(quantity) || quantity < 1
      || dialog.claim && current?.status !== 'rejected'
      || !dialog.claim && (!current?.eligible || quantity > current.availableQuantity)) { toast.error('Refresh the claim details, explain the issue, add a photo and select an eligible quantity.'); return; }
    mutation.current = true; setBusy(true);
    try {
      const body = { reasonDetails: reason.trim(), evidenceIds: photos.map(photo => photo._id), requestKey: key.current };
      const response = dialog.claim ? await axios.post(`${API}/${dialog.claim._id}/appeal`, body, options())
        : await axios.post(API, { ...body, orderId: order._id, sellerId: dialog.sellerId,
          items: [{ orderItemId: dialog.item.orderItemId, quantity }] }, options());
      if (!inspectWarrantyList([response.data?.returnRequest], order)
        || dialog.claim && response.data.returnRequest._id !== dialog.claim._id
        || !dialog.claim && (response.data.returnRequest.items[0].orderItemId !== dialog.item.orderItemId || response.data.returnRequest.items[0].quantity !== quantity)) throw new Error('Claim confirmation could not be verified. Refresh before submitting again.');
      setDialog(null); await load(); publishAfterSalesChange(order._id); toast.success(dialog.claim ? 'Appeal sent under your original warranty.' : 'Warranty claim sent to the seller.');
    } catch (failure) { toast.error(failure.response?.data?.msg || failure.message || 'Unable to submit this claim.'); }
    finally { mutation.current = false; setBusy(false); }
  };
  const act = async (claim, action) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(true);
    try {
      const response = await axios.post(`${API}/${claim._id}/${action === 'cancel' ? 'cancel' : 'replacement/receive'}`, {}, options());
      if (!inspectWarrantyList([response.data?.returnRequest], order) || response.data.returnRequest._id !== claim._id) throw new Error('Claim update could not be verified.');
      setConfirmation(null); await load(); publishAfterSalesChange(order._id); toast.success(action === 'cancel' ? 'Claim cancelled.' : 'Replacement received. Your original warranty deadline is unchanged.');
    } catch (failure) { toast.error(failure.response?.data?.msg || failure.message); }
    finally { mutation.current = false; setBusy(false); }
  };

  return <section id="warranty" className="mt-6 space-y-4" aria-label="Product warranties">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold flex items-center gap-2"><ShieldCheck size={19} className="text-primary" /> Warranty</h2><p className="text-xs text-muted-foreground mt-1">Coverage and prices are saved from your purchase. The warranty period starts at delivery.</p></div><button type="button" className="glass-button rounded-xl p-2 text-xs font-semibold" onClick={() => load()} disabled={busy || loading}>Refresh warranty</button></div>
    {loading ? <div className="glass-panel p-5 flex items-center gap-2"><Loader2 size={18} className="animate-spin" /> Checking coverage…</div> : error ? <div className="glass-panel p-4" role="alert"><p>{error}</p><button className="glass-button rounded-xl p-2 mt-2" onClick={load}>Retry</button></div> : <>
      {groups.flatMap(group => group.items.filter(item => item.months > 0).map(item => <article key={item.orderItemId} className="glass-panel p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div><p className="font-semibold">{item.name}</p><p className="text-xs text-muted-foreground mt-1">{group.store?.storeName || group.seller.username} · {item.months}-month warranty{item.deadline ? ` · Until ${date(item.deadline)}` : ''}</p>{item.description && <p className="text-sm mt-2">{item.description}</p>}{!item.eligible && <p className="text-xs text-muted-foreground mt-2">{item.reason}</p>}</div>
        {item.eligible && <button className="glass-button rounded-xl px-4 py-3 font-semibold shrink-0" disabled={busy} onClick={() => open({ item, sellerId: group.seller._id })}>Claim warranty</button>}
      </article>))}
      {!groups.some(group => group.items.some(item => item.months > 0)) && <p className="text-sm text-muted-foreground">No warranty was included with these purchased items.</p>}
      {claims.map(claim => <article key={claim._id} id={`warranty-${claim._id}`} className="glass-panel p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap gap-2 justify-between"><h3 className="font-bold">Claim #{claim.returnNumber}</h3><span className="rounded-full px-3 py-1 text-xs font-semibold" style={returnStatusTone(claim.status)}>{warrantyStatusLabel(claim.status)}</span></div>
        <p className="text-sm">{claim.items[0].name} × {claim.items[0].quantity}</p><p className="text-xs text-muted-foreground">Original warranty deadline: {date(claim.warrantySnapshot.deadline)}{claim.appealVersion ? ` · Appeal ${claim.appealVersion}` : ''}</p>
        <p className="text-sm whitespace-pre-wrap">{claim.reasonDetails}</p>
        <div className="flex flex-wrap gap-2">{claim.evidenceUrls.map((url, index) => <a key={`${url}-${index}`} href={url} target="_blank" rel="noopener noreferrer"><img alt={`Claim photo ${index + 1}`} src={url} className="w-20 h-20 rounded-xl object-cover border border-border" /></a>)}</div>
        {claim.resolution && <p className="glass-inner rounded-xl p-3 text-sm font-semibold">Planned resolution: {claim.resolution === 'replacement' ? 'Replacement product — no additional payment' : `Refund to Rozare Wallet: ${formatMoney(claim.refund.totalAmount)}`}</p>}
        {claim.decisionReason && <p className="text-sm"><strong>Seller’s reason:</strong> {claim.decisionReason}</p>}
        {claim.replacement?.shippedAt && <p className="text-sm">Shipment: {claim.replacement.shippingMethod === 'courier' ? `${claim.replacement.carrier} · Tracking ${claim.replacement.trackingNumber}` : 'Hand delivery'}</p>}
        <div className="flex flex-wrap gap-2">{claim.status === 'rejected' && <button className="glass-button rounded-xl p-3 text-sm font-semibold" disabled={busy} onClick={() => open({ claim })}>Appeal original claim</button>}{BUYER_CANCELLABLE_RETURN_STATUSES.has(claim.status) && <button className="glass-button rounded-xl p-3 text-sm" disabled={busy} onClick={() => setConfirmation({ claim, action: 'cancel' })}>Cancel request</button>}{claim.status === 'replacement_shipped' && <button className="glass-button rounded-xl p-3 text-sm font-semibold" disabled={busy} onClick={() => setConfirmation({ claim, action: 'receive' })}>Confirm replacement received</button>}</div>
        <details><summary className="text-xs font-semibold cursor-pointer text-muted-foreground">Claim history</summary><div className="mt-2 space-y-2">{[...claim.statusHistory].reverse().map((entry, index) => <p key={`${entry.changedAt}-${index}`} className="text-xs"><strong>{warrantyStatusLabel(entry.status)}</strong> · {date(entry.changedAt)}<br />{entry.note}</p>)}</div>{claim.evidenceHistory?.length > 1 && <div className="mt-3 space-y-3">{claim.evidenceHistory.map(entry => <div key={entry.version} className="glass-inner rounded-xl p-3"><p className="text-xs font-bold">{entry.version ? `Appeal ${entry.version}` : 'Original on-time claim'} · {date(entry.submittedAt)}</p><p className="text-sm mt-2">{entry.reason}</p><div className="flex flex-wrap gap-2 mt-2">{entry.urls.map((url, index) => <a key={`${entry.version}-${index}`} href={url} target="_blank" rel="noopener noreferrer"><img src={url} className="w-20 h-20 rounded-lg object-cover" alt={`Evidence submission ${entry.version}, photo ${index + 1}`} /></a>)}</div></div>)}</div>}</details>
      </article>)}
    </>}
    <AfterSalesConfirmDialog open={Boolean(confirmation)} busy={busy} title={confirmation?.action === 'cancel' ? 'Cancel warranty request?' : 'Replacement received?'} description={confirmation?.action === 'cancel' ? 'This cancels the claim, not your original purchase. No refund is issued by cancelling a claim.' : 'Confirm only after your replacement arrives. The original warranty deadline stays unchanged.'} confirmLabel={confirmation?.action === 'cancel' ? 'Cancel request' : 'Confirm receipt'} onCancel={() => { if (!mutation.current) setConfirmation(null); }} onConfirm={() => act(confirmation.claim, confirmation.action)} />
    {dialog && createPortal(<div className="fixed inset-0 z-50 bg-black/60 p-4 flex items-center justify-center" onClick={close}><div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="warranty-dialog-title" aria-busy={busy} onClick={event => event.stopPropagation()} className="modal-surface glass-panel-strong w-full max-w-lg max-h-[90dvh] overflow-y-auto p-5 space-y-4">
      <div className="flex justify-between gap-3"><h3 id="warranty-dialog-title" className="text-lg font-bold">{dialog.claim ? 'Appeal original warranty claim' : 'Claim warranty'}</h3><button onClick={close} disabled={busy} className="glass-button p-2 rounded-lg" aria-label="Close warranty claim"><X size={18} /></button></div>
      <p className="text-sm text-muted-foreground">{dialog.claim ? 'This appeal keeps the original claim, purchase terms and warranty deadline.' : dialog.item.name}</p>
      {!dialog.claim && <label className="block text-sm font-semibold">Quantity<input className="glass-input mt-2" type="number" min={1} max={dialog.item.availableQuantity} value={quantity} onChange={event => setQuantity(Number(event.target.value))} disabled={busy} /></label>}
      <label className="block text-sm font-semibold">Describe the issue<textarea className="glass-input mt-2" value={reason} onChange={event => setReason(event.target.value)} rows={4} maxLength={1500} minLength={10} disabled={busy} placeholder="Explain the fault and any troubleshooting you have tried." /></label>
      <label className="block text-sm font-semibold"><span className="flex items-center gap-2"><Camera size={16} /> Photos (1–6 required)</span><input className="glass-input mt-2" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={upload} disabled={busy || photos.length >= 6} /></label>
      <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 5 MB each. Include the product and visible fault; avoid personal or payment information.</p>
      <div className="flex flex-wrap gap-2">{photos.map(photo => <div key={photo._id} className="relative"><img alt="Attached warranty evidence" src={photo.url} className="w-20 h-20 rounded-xl object-cover" /><button className="glass-button absolute right-0 top-0 p-1 rounded-lg" aria-label="Remove photo" disabled={busy} onClick={() => setPhotos(photos.filter(row => row._id !== photo._id))}><X size={14} /></button></div>)}</div>
      <button className="glass-button w-full rounded-xl p-3 font-bold disabled:opacity-50" disabled={busy} onClick={submit}>{busy ? 'Please wait…' : dialog.claim ? 'Submit appeal' : 'Submit warranty claim'}</button>
    </div></div>, document.body)}
  </section>;
}
