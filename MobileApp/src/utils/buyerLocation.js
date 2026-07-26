import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Buyer location for store/product visibility.
//
// The backend hides stores (and their products) that aren't visible in the
// buyer's area — see Backend/services/storeVisibilityService.js. Stores default
// to `country` visibility, so a request WITHOUT a buyer country only ever sees
// `global` stores. The website solves this with BuyerLocationContext, which
// auto-detects the country (IP geolocation) and appends `buyerCountry` params to
// every catalog request. This util is the mobile-app equivalent: resolve the
// location once, cache it, and expose the params for the axios interceptor.
//
// IMPORTANT: this module must NOT import the shared `api` instance — the request
// interceptor lives on that instance and calls back into here. Detection uses a
// bare axios call so it can't recurse through the interceptor.

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://rozare.up.railway.app').replace(/\/$/, '');
const STORAGE_KEY = 'rozare:buyer-location';

const COUNTRY_NAME_BY_CODE = {
  PK: 'Pakistan',
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  IT: 'Italy',
  ES: 'Spain',
  IN: 'India',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  CA: 'Canada',
  AU: 'Australia',
};

const EMPTY = {
  country: '',
  countryCode: '',
  region: '',
  regionCode: '',
  city: '',
};

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const hasCountry = (loc) => !!(loc && (clean(loc.country) || clean(loc.countryCode)));

let memoryCache = null; // last resolved (non-empty) location
let inflight = null; // in-flight detection promise (dedupes concurrent requests)

async function readStored() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch (_) {
    return null;
  }
}

async function writeStored(loc) {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
  } catch (_) {}
}

async function detect() {
  try {
    const res = await axios.get(`${API_BASE_URL}/api/currency/detect`, { timeout: 8000 });
    const code = clean(res.data?.country);
    const country = clean(res.data?.countryName) || COUNTRY_NAME_BY_CODE[code] || '';
    if (country || code) {
      return { ...EMPTY, country, countryCode: code };
    }
  } catch (_) {}
  return null;
}

/**
 * Resolve the buyer location once and cache it.
 * Priority: in-memory → stored (AsyncStorage) → IP auto-detect.
 * Returns null only when nothing could be resolved (offline first launch).
 */
export async function resolveBuyerLocation() {
  if (hasCountry(memoryCache)) return memoryCache;

  const stored = await readStored();
  if (hasCountry(stored)) {
    memoryCache = stored;
    return memoryCache;
  }

  if (!inflight) {
    inflight = detect()
      .then(async (detected) => {
        if (hasCountry(detected)) {
          memoryCache = detected;
          await writeStored(detected);
        }
        return memoryCache;
      })
      .catch(() => memoryCache)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Explicitly set the buyer location (e.g. from the signed-in user's saved
 * address, or a future location selector). Overrides any detected value.
 */
export async function setBuyerLocation(loc) {
  const next = { ...EMPTY, ...(loc || {}) };
  Object.keys(next).forEach((key) => {
    next[key] = clean(next[key]);
  });
  if (!hasCountry(next)) return memoryCache;
  memoryCache = next;
  await writeStored(next);
  return next;
}

/** Synchronously read the currently cached location (may be null). */
export function getCachedBuyerLocation() {
  return memoryCache;
}

/** Clear the cached/stored location (e.g. on logout). */
export async function clearBuyerLocation() {
  memoryCache = null;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
}

/**
 * Query params to attach to catalog requests. Uses the `buyer*` names the
 * backend's buyerLocationFromRequest() understands (Backend/services/
 * storeVisibilityService.js).
 */
export async function getBuyerLocationParams() {
  const loc = await resolveBuyerLocation();
  const params = {};
  if (!loc) return params;
  if (clean(loc.country)) params.buyerCountry = clean(loc.country);
  if (clean(loc.countryCode)) params.buyerCountryCode = clean(loc.countryCode);
  if (clean(loc.region)) params.buyerRegion = clean(loc.region);
  if (clean(loc.regionCode)) params.buyerRegionCode = clean(loc.regionCode);
  if (clean(loc.city)) params.buyerCity = clean(loc.city);
  return params;
}
