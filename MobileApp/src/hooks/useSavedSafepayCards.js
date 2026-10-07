import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../config/api';

export default function useSavedSafepayCards() {
  const { currentUser } = useAuth();
  const owner = String(currentUser?._id || currentUser?.id || '');
  const [state, setState] = useState({ owner: '', cards: [], selectedCardId: '', loading: false });
  const touched = useRef(false);
  useEffect(() => {
    let active = true;
    touched.current = false;
    setState({ owner, cards: [], selectedCardId: '', loading: !!owner });
    if (owner) api.get('/api/safepay/cards').then(({ data }) => {
      if (!active) return;
      const cards = Array.isArray(data.cards) ? data.cards.filter(card => card.usable === true
        && /^pm_[a-zA-Z0-9-]{8,100}$/.test(card.id) && /^\d{4}$/.test(card.last4)) : [];
      setState(previous => ({ owner, cards, loading: false, selectedCardId: touched.current
        ? previous.selectedCardId : cards.some(card => card.id === data.defaultPaymentMethodId) ? data.defaultPaymentMethodId : '' }));
    }).catch(() => { if (active) setState({ owner, cards: [], selectedCardId: '', loading: false }); });
    return () => { active = false; };
  }, [owner]);
  const current = state.owner === owner ? state : { cards: [], selectedCardId: '', loading: !!owner };
  return { ...current, setSelectedCardId: id => { touched.current = true; setState(previous => ({ ...previous, owner, selectedCardId: id })); } };
}
