import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useAuth } from './AuthContext';

const BuyerLocationContext = createContext(null);

const STORAGE_KEY = 'rozare:buyer-location';
const GPS_RADIUS_LOCATION_ENABLED = false;

const emptyLocation = {
  country: '',
  countryCode: '',
  region: '',
  regionCode: '',
  city: '',
  cityStateCode: '',
  town: '',
  townStateCode: '',
  lat: '',
  lng: '',
};

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const readStoredLocation = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...emptyLocation, ...parsed };
  } catch (_) {
    return null;
  }
};

const writeStoredLocation = (location) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch (_) {}
};

const defaultFromUser = (user) => {
  const defaultAddress = Array.isArray(user?.savedAddresses)
    ? user.savedAddresses.find(address => address.isDefault) || user.savedAddresses[0]
    : null;
  return {
    ...emptyLocation,
    country: clean(defaultAddress?.country || user?.savedShippingInfo?.country || user?.sellerInfo?.country),
    countryCode: clean(defaultAddress?.countryCode || user?.savedShippingInfo?.countryCode || user?.sellerInfo?.countryCode),
    region: clean(defaultAddress?.state || user?.savedShippingInfo?.state),
    regionCode: clean(defaultAddress?.stateCode || user?.savedShippingInfo?.stateCode),
    city: clean(defaultAddress?.city || user?.savedShippingInfo?.city || user?.sellerInfo?.city),
  };
};

export const BuyerLocationProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [buyerLocation, setBuyerLocation] = useState(() => readStoredLocation() || emptyLocation);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    const stored = readStoredLocation();
    if (stored?.country) return;

    const fromUser = defaultFromUser(currentUser);
    if (fromUser.country) {
      setBuyerLocation(fromUser);
      writeStoredLocation(fromUser);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setDetecting(true);
        const res = await axios.get(`${import.meta.env.VITE_API_URL}api/currency/detect`);
        if (cancelled) return;
        const detected = {
          ...emptyLocation,
          country: clean(res.data?.countryName) || (res.data?.country === 'PK' ? 'Pakistan' : res.data?.country === 'US' ? 'United States' : ''),
          countryCode: clean(res.data?.country),
        };
        if (detected.country || detected.countryCode) {
          setBuyerLocation(detected);
          writeStoredLocation(detected);
        }
      } catch (_) {
      } finally {
        if (!cancelled) setDetecting(false);
      }
    })();

    return () => { cancelled = true; };
  }, [currentUser]);

  const updateBuyerLocation = useCallback((updates) => {
    setBuyerLocation(prev => {
      const next = { ...prev, ...updates };
      Object.keys(next).forEach(key => {
        next[key] = key === 'lat' || key === 'lng' ? String(next[key] || '') : clean(next[key]);
      });
      writeStoredLocation(next);
      return next;
    });
  }, []);

  const resetBuyerLocation = useCallback(() => {
    const next = defaultFromUser(currentUser);
    setBuyerLocation(next);
    writeStoredLocation(next);
  }, [currentUser]);

  const useCurrentPosition = useCallback(() => new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available in this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = {
          lat: String(position.coords.latitude),
          lng: String(position.coords.longitude),
        };
        updateBuyerLocation(next);
        resolve(next);
      },
      (error) => reject(error),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 }
    );
  }), [updateBuyerLocation]);

  const locationQueryString = useMemo(() => {
    const params = new URLSearchParams();
    if (buyerLocation.country) params.set('buyerCountry', buyerLocation.country);
    if (buyerLocation.countryCode) params.set('buyerCountryCode', buyerLocation.countryCode);
    if (buyerLocation.region) params.set('buyerRegion', buyerLocation.region);
    if (buyerLocation.regionCode) params.set('buyerRegionCode', buyerLocation.regionCode);
    if (buyerLocation.city) params.set('buyerCity', buyerLocation.city);
    if (buyerLocation.cityStateCode) params.set('buyerCityStateCode', buyerLocation.cityStateCode);
    if (buyerLocation.town) params.set('buyerTown', buyerLocation.town);
    if (buyerLocation.townStateCode) params.set('buyerTownStateCode', buyerLocation.townStateCode);
    if (GPS_RADIUS_LOCATION_ENABLED && buyerLocation.lat && buyerLocation.lng) {
      params.set('buyerLat', buyerLocation.lat);
      params.set('buyerLng', buyerLocation.lng);
    }
    return params.toString();
  }, [buyerLocation]);

  const appendLocationParams = useCallback((params) => {
    const locationParams = new URLSearchParams(locationQueryString);
    locationParams.forEach((value, key) => params.set(key, value));
    return params;
  }, [locationQueryString]);

  const value = useMemo(() => ({
    buyerLocation,
    detecting,
    updateBuyerLocation,
    resetBuyerLocation,
    useCurrentPosition,
    locationQueryString,
    appendLocationParams,
  }), [buyerLocation, detecting, updateBuyerLocation, resetBuyerLocation, useCurrentPosition, locationQueryString, appendLocationParams]);

  return (
    <BuyerLocationContext.Provider value={value}>
      {children}
    </BuyerLocationContext.Provider>
  );
};

export const useBuyerLocation = () => {
  const context = useContext(BuyerLocationContext);
  if (!context) {
    throw new Error('useBuyerLocation must be used within BuyerLocationProvider');
  }
  return context;
};
