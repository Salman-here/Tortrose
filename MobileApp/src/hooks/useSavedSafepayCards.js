import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../config/api';

export default function useSavedSafepayCards() {
  const { currentUser } = useAuth();
  const owner = String(currentUser?._id || currentUser?.id || '');
  const [state, setState] = useState({ owner: '', cards: [], selectedCardId: '', loading: false, billingProfileReady: null });
  const [refreshRevision, setRefreshRevision] = useState(0);
  const refreshCards = useCallback(() => setRefreshRevision(value => value + 1), []);
  const touched = useRef(false);
  const selectionOwner = useRef(owner);
  useEffect(() => {
    let active = true;
    if (selectionOwner.current !== owner) { touched.current = false; selectionOwner.current = owner; }
    setState(previous => previous.owner === owner
      ? { ...previous, loading: !!owner } : { owner, cards: [], selectedCardId: '', loading: !!owner, billingProfileReady: null });
    if (owner) api.get('/api/safepay/cards').then(({ data }) => {
      if (!active) return;
      const cards = Array.isArray(data.cards) ? data.cards.filter(card => card.usable === true
        && /^pm_[a-zA-Z0-9-]{8,100}$/.test(card.id) && /^\d{4}$/.test(card.last4)) : [];
      setState(previous => ({ owner, cards, loading: false,
        billingProfileReady: typeof data.billingProfileReady === 'boolean' ? data.billingProfileReady : null,
        selectedCardId: touched.current
        ? previous.owner === owner && cards.some(card => card.id === previous.selectedCardId) ? previous.selectedCardId : ''
        : cards.some(card => card.id === data.defaultPaymentMethodId) ? data.defaultPaymentMethodId : '' }));
    }).catch(() => { if (active) setState(previous => previous.owner === owner
      ? { ...previous, loading: false, billingProfileReady: null } : { owner, cards: [], selectedCardId: '', loading: false, billingProfileReady: null }); });
    return () => { active = false; };
  }, [owner, refreshRevision]);
  const current = state.owner === owner ? state : { cards: [], selectedCardId: '', loading: !!owner, billingProfileReady: null };
  const setSelectedCardId = useCallback(id => {
    if (selectionOwner.current !== owner) return;
    touched.current = true;
    setState(previous => previous.owner === owner ? { ...previous, selectedCardId: id } : previous);
  }, [owner]);
  return { ...current, refreshCards, setSelectedCardId };
}
