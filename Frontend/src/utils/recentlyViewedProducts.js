import { deleteCookie, getCookie, setCrossDomainCookie } from './cookieHelper';

const RECENTLY_VIEWED_KEY = 'viewedProducts';
const RECENTLY_VIEWED_COOKIE = 'rozare_recently_viewed_products';
const MAX_RECENTLY_VIEWED = 20;

const isBrowser = () => typeof window !== 'undefined';

const parseIds = (value) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeIds = (ids) => {
  const seen = new Set();
  const normalized = [];

  (Array.isArray(ids) ? ids : []).forEach((id) => {
    const cleanId = String(id || '').trim();
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    normalized.push(cleanId);
  });

  return normalized.slice(0, MAX_RECENTLY_VIEWED);
};

const readLocalIds = () => {
  if (!isBrowser()) return [];
  try {
    return parseIds(window.localStorage.getItem(RECENTLY_VIEWED_KEY));
  } catch {
    return [];
  }
};

const persistLocalIds = (ids) => {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable in private mode or strict browser settings.
  }
};

const notifyRecentlyViewedChanged = (ids) => {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent('rozare:recentlyViewedChanged', { detail: ids }));
};

export const readRecentlyViewedProductIds = () => {
  if (!isBrowser()) return [];

  const cookieIds = parseIds(getCookie(RECENTLY_VIEWED_COOKIE));
  const localIds = readLocalIds();
  const ids = normalizeIds([...cookieIds, ...localIds]);

  if (ids.length > 0) {
    persistLocalIds(ids);
    setCrossDomainCookie(RECENTLY_VIEWED_COOKIE, JSON.stringify(ids), 120);
  }

  return ids;
};

export const writeRecentlyViewedProductIds = (ids) => {
  const normalized = normalizeIds(ids);
  if (!isBrowser()) return normalized;

  persistLocalIds(normalized);
  setCrossDomainCookie(RECENTLY_VIEWED_COOKIE, JSON.stringify(normalized), 120);
  notifyRecentlyViewedChanged(normalized);

  return normalized;
};

export const addRecentlyViewedProduct = (productId) => {
  const cleanId = String(productId || '').trim();
  if (!cleanId) return readRecentlyViewedProductIds();

  const existing = readRecentlyViewedProductIds().filter(id => id !== cleanId);
  return writeRecentlyViewedProductIds([cleanId, ...existing]);
};

export const clearRecentlyViewedProducts = () => {
  if (!isBrowser()) return [];

  try {
    window.localStorage.removeItem(RECENTLY_VIEWED_KEY);
  } catch {
    // Storage can be unavailable in private mode or strict browser settings.
  }

  deleteCookie(RECENTLY_VIEWED_COOKIE);
  notifyRecentlyViewedChanged([]);

  return [];
};
