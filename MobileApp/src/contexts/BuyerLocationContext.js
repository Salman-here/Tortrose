import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getCachedBuyerLocation, resolveBuyerLocation, setBuyerLocation, subscribeBuyerLocation } from '../utils/buyerLocation';
import { EMPTY_SHOPPING_LOCATION, shoppingLocationParams } from '../utils/shoppingLocation';

const BuyerLocationContext = createContext(null);
export function BuyerLocationProvider({ children }) {
  const [buyerLocation, setLocation] = useState(() => getCachedBuyerLocation() || { ...EMPTY_SHOPPING_LOCATION });
  const [detecting, setDetecting] = useState(!getCachedBuyerLocation());
  const [editorOpen, setEditorOpen] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState('');
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeBuyerLocation(next => {
      if (active) { setLocation(next || { ...EMPTY_SHOPPING_LOCATION }); setDetecting(false); }
    });
    resolveBuyerLocation().then(next => { if (active && next) setLocation(next); })
      .finally(() => { if (active) setDetecting(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const updateBuyerLocation = useCallback(async value => {
    const next = await setBuyerLocation(value);
    setPersistenceWarning(next.persistenceWarning || '');
    setEditorOpen(false);
    return next;
  }, []);
  const openLocationSelector = useCallback(() => setEditorOpen(true), []);
  const closeLocationSelector = useCallback(() => setEditorOpen(false), []);
  const locationKey = useMemo(() => JSON.stringify(shoppingLocationParams(buyerLocation)), [buyerLocation]);
  const value = useMemo(() => ({ buyerLocation, detecting, locationKey,
    selectionRequired: !buyerLocation.confirmed, editorOpen, persistenceWarning,
    updateBuyerLocation, openLocationSelector, closeLocationSelector,
  }), [buyerLocation, detecting, locationKey, editorOpen, persistenceWarning, updateBuyerLocation, openLocationSelector, closeLocationSelector]);
  return <BuyerLocationContext.Provider value={value}>{children}</BuyerLocationContext.Provider>;
}
export function useBuyerLocation() {
  const value = useContext(BuyerLocationContext);
  if (!value) throw new Error('useBuyerLocation must be used within BuyerLocationProvider');
  return value;
}
