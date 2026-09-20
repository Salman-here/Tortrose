import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useAuth } from './AuthContext';
import {
  EMPTY_SHOPPING_LOCATION, SHOPPING_LOCATION_STORAGE_KEY,
  normalizeShoppingLocation, shoppingLocationIsValid, shoppingLocationFromDetection,
  shoppingLocationFromProfile, shoppingLocationParams,
} from '../utils/shoppingLocation';
import { readShoppingPreference, writeShoppingPreference } from '../utils/shoppingLocationPersistence';

const BuyerLocationContext = createContext(null);
const confirmedStored = () => readShoppingPreference();

export const BuyerLocationProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [buyerLocation, setBuyerLocation] = useState(() => confirmedStored() || { ...EMPTY_SHOPPING_LOCATION });
  const locationRef = useRef(buyerLocation);
  const revisionRef = useRef(0);
  const [recommendedLocation, setRecommendedLocation] = useState({ ...EMPTY_SHOPPING_LOCATION });
  const [detecting, setDetecting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState('');

  useEffect(() => {
    if (locationRef.current.confirmed) return;
    let active = true;
    const revision = revisionRef.current;
    const controller = new AbortController();
    setDetecting(true);
    axios.get(`${import.meta.env.VITE_API_URL}api/currency/detect`, { timeout: 8000, signal: controller.signal })
      .then(response => shoppingLocationFromDetection(response.data))
      .catch(() => null)
      .then(detected => {
        if (!active || revision !== revisionRef.current || locationRef.current.confirmed) return;
        const suggestion = detected || shoppingLocationFromProfile(currentUser)
          || { ...EMPTY_SHOPPING_LOCATION };
        const next = { ...suggestion, confirmed: false };
        setRecommendedLocation(next);
        locationRef.current = next;
        setBuyerLocation(next);
      })
      .finally(() => { if (active) setDetecting(false); });
    return () => { active = false; controller.abort(); };
  }, [currentUser]);

  useEffect(() => {
    const sync = event => {
      if (event.type === 'storage' && event.key !== SHOPPING_LOCATION_STORAGE_KEY && event.key !== null) return;
      const saved = confirmedStored();
      if (!saved && event.type !== 'storage') return;
      const next = saved || { ...EMPTY_SHOPPING_LOCATION };
      if (JSON.stringify(next) === JSON.stringify(locationRef.current)) return;
      revisionRef.current += 1;
      locationRef.current = next;
      setBuyerLocation(next);
    };
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('pageshow', sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('focus', sync); window.removeEventListener('pageshow', sync); };
  }, []);

  const updateBuyerLocation = useCallback(updates => {
    if (!shoppingLocationIsValid({ ...locationRef.current, ...updates })) return false;
    const next = normalizeShoppingLocation({ ...locationRef.current, ...updates, version: 2, confirmed: true, updatedAt: Date.now() });
    if (!shoppingLocationIsValid(next)) return false;
    revisionRef.current += 1;
    locationRef.current = next;
    setBuyerLocation(next);
    setDetecting(false);
    setEditorOpen(false);
    setPersistenceWarning(writeShoppingPreference(next));
    return true;
  }, []);

  const openLocationSelector = useCallback(() => setEditorOpen(true), []);
  const closeLocationSelector = useCallback(() => setEditorOpen(false), []);
  const locationQueryString = useMemo(() => new URLSearchParams(shoppingLocationParams(buyerLocation)).toString(), [buyerLocation]);
  const appendLocationParams = useCallback(params => {
    ['buyerMode', 'buyerCountry', 'buyerCountryCode', 'buyerRegion', 'buyerRegionCode', 'buyerCity',
      'buyerCityStateCode', 'buyerTown', 'buyerTownStateCode', 'buyerLat', 'buyerLng'].forEach(key => params.delete(key));
    new URLSearchParams(locationQueryString).forEach((value, key) => params.set(key, value));
    return params;
  }, [locationQueryString]);

  const value = useMemo(() => ({
    buyerLocation, recommendedLocation, detecting, selectionRequired: !buyerLocation.confirmed,
    editorOpen, openLocationSelector, closeLocationSelector, persistenceWarning,
    updateBuyerLocation, resetBuyerLocation: openLocationSelector, locationQueryString, appendLocationParams,
  }), [buyerLocation, recommendedLocation, detecting, editorOpen, openLocationSelector, closeLocationSelector,
    persistenceWarning, updateBuyerLocation, locationQueryString, appendLocationParams]);
  return <BuyerLocationContext.Provider value={value}>{children}</BuyerLocationContext.Provider>;
};

export const useBuyerLocation = () => {
  const context = useContext(BuyerLocationContext);
  if (!context) throw new Error('useBuyerLocation must be used within BuyerLocationProvider');
  return context;
};
