import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import api from '../config/api';

export default function useProductModerationUpdates(products, setProducts) {
  const setter = useRef(setProducts); setter.current = setProducts;
  const ids = (Array.isArray(products) ? products : []).filter(product => product.moderationStatus === 'pending').map(product => product._id).slice(0, 100).sort().join(',');
  useEffect(() => {
    if (!ids) return undefined;
    let active = true, busy = false;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (busy || AppState.currentState !== 'active') return;
      busy = true;
      try {
        const response = await api.get('/api/products/moderation-status', { params: { ids }, signal: controller.signal });
        if (!active) return;
        const byId = new Map((response.data.products || []).map(product => [product._id, product]));
        setter.current(current => current.map(product => {
          const status = byId.get(product._id);
          return status && (status.moderationRevision === product.moderationRevision || (!product.moderationRevision && !product.moderationPolicyVersion)) ? { ...product, ...status } : product;
        }));
      } catch (_) { /* A network failure is not an approval. */ }
      finally { busy = false; }
    }, 8000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [ids]);
}
