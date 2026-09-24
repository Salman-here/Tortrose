import { useEffect, useRef } from 'react';
import { ShieldAlert, Clock } from 'lucide-react';
import axios from 'axios';
import { getAuthToken } from '../../utils/cookieHelper';

export default function StoreModerationNotice({ store, onChange }) {
  const latest = useRef({ store, onChange }); latest.current = { store, onChange };
  const pending = store?.moderationStatus === 'pending';
  useEffect(() => {
    if (!pending || !onChange) return undefined;
    let active = true, busy = false;
    const controller = new AbortController();
    const revision = store?.moderationRevision;
    const timer = setInterval(async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const response = await axios.get(`${import.meta.env.VITE_API_URL}api/stores/my-store`, { signal: controller.signal, headers: { Authorization: `Bearer ${getAuthToken()}` } });
        const updated = response.data.store;
        if (active && updated?._id === latest.current.store?._id && updated?.moderationRevision === revision
          && latest.current.store?.moderationRevision === revision) latest.current.onChange?.(updated);
      } catch (_) { /* Keep the pending state on a temporary request failure. */ }
      finally { busy = false; }
    }, 8000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [pending, store?.moderationRevision, onChange]);
  if (!pending && store?.moderationStatus !== 'blocked') return null;
  const Icon = pending ? Clock : ShieldAlert;
  return <section role='status' className='glass-panel p-4 mb-5 border' style={{ borderColor: pending ? '#f59e0b' : '#ef4444' }}>
    <h2 className='font-semibold flex items-center gap-2'><Icon size={18} />{pending ? 'Store under review' : 'Store content blocked'}</h2>
    <p className='text-sm mt-2'>{store.moderationReason || 'Automatic content checks are in progress.'}</p>
    <p className='text-sm mt-1'>{pending ? 'Your store and products remain hidden until the checks pass.' : 'Edit the flagged content below to submit it for automatic checks again.'}</p>
  </section>;
}
