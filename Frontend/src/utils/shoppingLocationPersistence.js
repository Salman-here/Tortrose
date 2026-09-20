import { normalizeShoppingLocation, SHOPPING_LOCATION_STORAGE_KEY } from './shoppingLocation.js';

const COOKIE_NAME = 'rozare_shopping_location_v2';
const sharesStoreDomain = environment => {
  const host = environment.location?.hostname || '';
  return host === 'rozare.com' || host.endsWith('.rozare.com');
};
const parse = raw => {
  try { const value = normalizeShoppingLocation(JSON.parse(raw)); return value.confirmed ? value : null; }
  catch (_) { return null; }
};
const readCookie = environment => {
  if (!sharesStoreDomain(environment)) return null;
  try {
    const pair = environment.document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(COOKIE_NAME + '='));
    return pair ? parse(decodeURIComponent(pair.slice(COOKIE_NAME.length + 1))) : null;
  } catch (_) { return null; }
};
export function readShoppingPreference(environment = globalThis) {
  let local = null;
  try { local = parse(environment.localStorage.getItem(SHOPPING_LOCATION_STORAGE_KEY)); } catch (_) {}
  const shared = readCookie(environment);
  if (shared && (!local || shared.updatedAt >= local.updatedAt)) return shared;
  return local;
}
export function writeShoppingPreference(value, environment = globalThis) {
  const normalized = normalizeShoppingLocation(value);
  if (!normalized.confirmed) return 'Choose a valid shopping location.';
  const raw = JSON.stringify(normalized);
  let localSaved = false, sharedSaved = false;
  try { environment.localStorage.setItem(SHOPPING_LOCATION_STORAGE_KEY, raw); localSaved = true; } catch (_) {}
  if (sharesStoreDomain(environment)) {
    try {
      environment.document.cookie = COOKIE_NAME + '=' + encodeURIComponent(raw)
        + '; Domain=.rozare.com; Path=/; Max-Age=15552000; SameSite=Lax'
        + (environment.location.protocol === 'https:' ? '; Secure' : '');
      sharedSaved = JSON.stringify(readCookie(environment)) === raw;
    } catch (_) {}
  }
  if (!localSaved && !sharedSaved) return 'Your selection applies now, but could not be saved on this device.';
  if (sharesStoreDomain(environment) && !sharedSaved) return 'Saved here. Your browser may ask you to choose again when opening a store subdomain.';
  return '';
}
