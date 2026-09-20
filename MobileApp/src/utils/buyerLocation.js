import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_SHOPPING_LOCATION, SHOPPING_LOCATION_STORAGE_KEY,
  normalizeShoppingLocation, shoppingLocationIsValid, shoppingLocationFromDetection, shoppingLocationParams,
} from './shoppingLocation';

// Use bare axios: the shared API interceptor calls this module.
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://rozare.up.railway.app').replace(/\/$/, '');
let memoryCache = null;
let inflight = null;
let revision = 0;
let profileSuggestion = null;
let detectedSuggestion = null;
let detectionInflight = null;
let detectionVersion = 0;
let storageWrite = Promise.resolve();
const listeners = new Set();
const publish = next => { memoryCache = next; listeners.forEach(listener => listener(next)); return next; };
const readStored = async key => {
  try { return normalizeShoppingLocation(JSON.parse(await AsyncStorage.getItem(key))); } catch (_) { return null; }
};

export async function resolveBuyerCountrySuggestion() {
  if (detectedSuggestion) return detectedSuggestion;
  if (!detectionInflight) {
    const generation = detectionVersion;
    const pending = axios.get(API_BASE_URL + '/api/currency/detect', { timeout: 8000 })
      .then(response => shoppingLocationFromDetection(response.data))
      .catch(() => null)
      .then(value => { if (value && generation === detectionVersion) detectedSuggestion = value; return value || profileSuggestion; })
      .finally(() => { if (detectionInflight === pending) detectionInflight = null; });
    detectionInflight = pending;
  }
  return detectionInflight;
}

export async function resolveBuyerLocation() {
  if (memoryCache) return memoryCache;
  if (inflight) return inflight;
  const startedAt = revision;
  const pending = (async () => {
    const stored = await readStored(SHOPPING_LOCATION_STORAGE_KEY);
    if (startedAt !== revision) return memoryCache;
    if (stored?.confirmed) return publish(stored);
    const suggestion = await resolveBuyerCountrySuggestion();
    if (startedAt !== revision) return memoryCache;
    return publish({ ...(suggestion || profileSuggestion || EMPTY_SHOPPING_LOCATION), confirmed: false });
  })().finally(() => { if (inflight === pending) inflight = null; });
  inflight = pending;
  return pending;
}

export async function setBuyerLocation(value) {
  if (!shoppingLocationIsValid(value)) throw new Error('Choose Global or select a country.');
  const next = normalizeShoppingLocation({ ...value, version: 2, confirmed: true, updatedAt: Date.now() });
  if (!shoppingLocationIsValid(next)) throw new Error('Choose Global or select a country.');
  revision += 1;
  publish(next);
  // Keep the explicit in-session selection even if device storage is unavailable.
  const write = storageWrite.catch(() => {}).then(() => AsyncStorage.setItem(SHOPPING_LOCATION_STORAGE_KEY, JSON.stringify(next)));
  storageWrite = write;
  try { await write; }
  catch (_) { return { ...next, persistenceWarning: 'Your selection applies now, but could not be saved on this device.' }; }
  return next;
}

export async function suggestBuyerLocation(value) {
  const suggestion = normalizeShoppingLocation(value);
  if (!shoppingLocationIsValid(suggestion) || suggestion.mode !== 'country') return;
  profileSuggestion = { ...suggestion, confirmed: false };
  if (memoryCache?.confirmed) return memoryCache;
  if (memoryCache && !shoppingLocationIsValid(memoryCache)) publish(profileSuggestion);
  return memoryCache;
}

export function subscribeBuyerLocation(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getCachedBuyerLocation() { return memoryCache; }
export async function clearBuyerLocation() {
  revision += 1;
  inflight = null;
  detectionVersion += 1;
  detectionInflight = null;
  detectedSuggestion = null;
  profileSuggestion = null;
  publish(null);
  const write = storageWrite.catch(() => {}).then(() => AsyncStorage.removeItem(SHOPPING_LOCATION_STORAGE_KEY));
  storageWrite = write;
  try { await write; } catch (_) {}
}
export async function getBuyerLocationParams() {
  return shoppingLocationParams(await resolveBuyerLocation());
}
