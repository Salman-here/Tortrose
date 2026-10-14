import { useState } from 'react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { getAuthToken } from '../../utils/cookieHelper';
import { inspectReturnPresentationSnapshot } from '../../utils/returnPresentationSafety';
import AfterSalesConfirmDialog from '../common/AfterSalesConfirmDialog';

export default function ReplacementReceipt({ request, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!request.replacement?.shippedAt) return null;
  const receive = async () => {
    setBusy(true);
    try {
      const response = await axios.post(`${import.meta.env.VITE_API_URL}api/returns/${request._id}/replacement/receive`, {}, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
      if (!inspectReturnPresentationSnapshot(response.data?.returnRequest).valid || response.data.returnRequest.status !== 'replacement_delivered') throw new Error('Delivery confirmation could not be verified.');
      setConfirming(false); await onChanged(); toast.success('Replacement received.');
    } catch (error) { toast.error(error.response?.data?.msg || error.message || 'Unable to confirm receipt.'); }
    finally { setBusy(false); }
  };
  return <div className="glass-inner rounded-xl p-3 mt-4 text-sm space-y-2"><strong>Replacement shipment</strong><p>{request.replacement.shippingMethod === 'courier' ? `${request.replacement.carrier} · Tracking ${request.replacement.trackingNumber}` : 'Hand delivery'}</p>{request.status === 'replacement_shipped' && <button type="button" disabled={busy} className="glass-button rounded-xl p-3 text-sm font-semibold disabled:opacity-50" onClick={() => setConfirming(true)}>{busy ? 'Confirming…' : 'Confirm replacement received'}</button>}{request.status === 'replacement_delivered' && <p className="text-xs text-muted-foreground">Received {new Date(request.replacement.deliveredAt).toLocaleString()}</p>}
    <AfterSalesConfirmDialog open={confirming} title="Replacement received?" description="Confirm only after the replacement arrives. Your original warranty deadline stays unchanged." busy={busy} onCancel={() => setConfirming(false)} onConfirm={receive} confirmLabel="Confirm receipt" />
  </div>;
}
