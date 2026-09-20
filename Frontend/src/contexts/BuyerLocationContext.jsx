import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useAuth } from './AuthContext';
import {
  EMPTY_SHOPPING_LOCATION, SHOPPING_LOCATION_STORAGE_KEY,
  normalizeShoppingLocation, shoppingLocationIsValid, shoppingLocationFromDetection,
  shoppingLocationFromProfile, shoppingLocationParams, withGlobalShoppingCountry,
} from '../utils/shoppingLocation';
import { readShoppingPreference, writeShoppingPreference } from '../utils/shoppingLocationPersistence';

const BuyerLocationContext = createContext(null);
const confirmedStored = () => readShoppingPreference();

export const BuyerLocationProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [buyerLocation, setBuyerLocation] = useState(() => confirmedStored() || { ...EMPTY_SHOPPING_LOCATION });
  const locationRef = useRef(buyerLocation);
  const revisionRef = useRef(0);
  const countrySuggestionRef = useRef(null);
  const detectedCountryRef = useRef(null);
  const [recommendedLocation, setRecommendedLocation] = useState({ ...EMPTY_SHOPPING_LOCATION });
  const [detecting, setDetecting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [persistenceWarning, setPersistenceWarning] = useState('');

  useEffect(() => {
    let active = true;
    const revision = revisionRef.current;
    const controller = new AbortController();
    setDetecting(!detectedCountryRef.current);
    const countryLookup = detectedCountryRef.current ? Promise.resolve(detectedCountryRef.current)
      : (async () => {
        for (let attempt = 0; attempt < 2 && active; attempt += 1) {
          try {
            const response = await axios.get(`${import.meta.env.VITE_API_URL}api/currency/detect`, { timeout: 12000, signal: controller.signal });
            const suggestion = shoppingLocationFromDetection(response.data);
            if (suggestion) return suggestion;
          } catch (_) {}
        }
        return null;
      })();
    countryLookup
      .then(detected => {
        if (!active) return;
        if (detected) detectedCountryRef.current = detected;
        const suggestion = detected || shoppingLocationFromProfile(currentUser)
          || { ...EMPTY_SHOPPING_LOCATION };
        countrySuggestionRef.current = suggestion;
        setRecommendedLocation(suggestion);
        if (locationRef.current.confirmed) {
          if (locationRef.current.mode === 'global') {
            const next = withGlobalShoppingCountry(locationRef.current, suggestion);
            if (next.country !== locationRef.current.country || next.countryCode !== locationRef.current.countryCode) {
              next.updatedAt = Date.now();
              locationRef.current = next;
              setBuyerLocation(next);
              setPersistenceWarning(writeShoppingPreference(next));
            }
          }
          return;
        }
        if (revision !== revisionRef.current) return;
        const next = { ...suggestion, confirmed: false };
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
      const next = saved?.mode === 'global' && countrySuggestionRef.current
        ? withGlobalShoppingCountry(saved, countrySuggestionRef.current)
        : saved || { ...EMPTY_SHOPPING_LOCATION };
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
    const requested = { ...locationRef.current, ...updates, version: 2, confirmed: true, updatedAt: Date.now() };
    const next = requested.mode === 'global'
      ? withGlobalShoppingCountry(requested, countrySuggestionRef.current)
      : normalizeShoppingLocation(requested);
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
