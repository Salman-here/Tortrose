import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { getAuthToken } from '../../utils/cookieHelper';
import AfterSalesPhotos from './AfterSalesPhotos';

export default function ReturnPhotoPicker({ orderId, photos, onChange, onBusyChange, disabled = false }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), generation = useRef(0), abort = useRef(null);
  useEffect(() => () => { generation.current += 1; abort.current?.abort(); onBusyChange(false); }, [orderId, onBusyChange]);
  const upload = async event => {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (working.current || disabled || !files.length) return;
    if (files.length + photos.length > 6 || files.some(file => !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size < 1 || file.size > 5242880)) {
      setError('Choose up to 6 JPEG, PNG or WebP photos, each up to 5 MB.'); return;
    }
    const current = generation.current; abort.current = new AbortController();
    working.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      for (const file of files) {
        const form = new FormData(); form.append('photo', file); form.append('orderId', orderId);
        const response = await axios.post(`${import.meta.env.VITE_API_URL}api/returns/evidence`, form, {
          headers: { Authorization: `Bearer ${getAuthToken()}` }, timeout: 60000, signal: abort.current.signal,
        });
        if (generation.current !== current) return;
        const photo = response.data?.evidence;
        if (!/^[a-f\d]{24}$/iu.test(photo?._id || '') || typeof photo.url !== 'string' || !photo.url.startsWith('https://')) throw new Error('The uploaded photo could not be verified.');
        onChange(previous => [...previous, photo]);
      }
    } catch (failure) { if (generation.current === current) setError(failure.response?.data?.msg || failure.message || 'Photo upload failed. Try again.'); }
    finally { working.current = false; if (generation.current === current) { setBusy(false); onBusyChange(false); } }
  };
  return <div className="mt-4">
    <p className="text-sm font-semibold">Photos (required)</p>
    <p className="text-xs text-muted-foreground mt-1">Attach 1–6 JPEG, PNG or WebP photos, up to 5 MB each. Show the item and issue; avoid personal or payment information.</p>
    <label className="glass-button inline-flex rounded-xl px-4 py-3 text-sm mt-3 cursor-pointer">{busy ? 'Uploading photos…' : `Add photos (${photos.length}/6)`}
      <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="Upload return photos" disabled={disabled || busy || photos.length >= 6} onChange={upload} />
    </label>
    <AfterSalesPhotos photos={photos} busy={disabled || busy} onRemove={id => { onChange(previous => previous.filter(photo => photo._id !== id)); setError(''); }} />
    {error && <p className="text-sm text-destructive mt-3" role="alert">{error}</p>}
  </div>;
}
