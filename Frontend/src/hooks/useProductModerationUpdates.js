import { useEffect, useRef } from 'react';
import axios from 'axios';
import { getAuthToken } from '../utils/cookieHelper';

export default function useProductModerationUpdates(products, setProducts) {
  const setter = useRef(setProducts); setter.current = setProducts;
  const ids = (Array.isArray(products) ? products : []).filter(product => product.moderationStatus === 'pending').map(product => product._id).slice(0, 100).sort().join(',');
  useEffect(() => {
    if (!ids) return undefined;
    let active = true, busy = false;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const response = await axios.get(`${import.meta.env.VITE_API_URL}api/products/moderation-status`, { params: { ids }, signal: controller.signal, headers: { Authorization: `Bearer ${getAuthToken()}` } });
        if (!active) return;
        const byId = new Map((response.data.products || []).map(product => [product._id, product]));
        setter.current(current => current.map(product => {
          const status = byId.get(product._id);
          return status && (status.moderationRevision === product.moderationRevision || (!product.moderationRevision && !product.moderationPolicyVersion)) ? { ...product, ...status } : product;
        }));
      } catch (_) { /* Retain the last known state, never invent an approval. */ }
      finally { busy = false; }
    }, 8000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [ids]);
}
