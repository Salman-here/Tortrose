// Shared web/mobile shopping preference contract. No currency or delivery-address mutation.
export const SHOPPING_LOCATION_STORAGE_KEY = 'rozare:shopping-location:v2';
export const LEGACY_BUYER_LOCATION_STORAGE_KEY = 'rozare:buyer-location';
export const EMPTY_SHOPPING_LOCATION = Object.freeze({
  version: 2, confirmed: false, updatedAt: 0, mode: 'country', country: '', countryCode: '',
  region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '',
});
const fields = ['country', 'countryCode', 'region', 'regionCode', 'city', 'cityStateCode', 'town', 'townStateCode'];
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
const countryCode = value => /^[A-Z]{2}$/.test(clean(value).toUpperCase()) ? clean(value).toUpperCase() : '';

export function normalizeShoppingLocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_SHOPPING_LOCATION };
  const mode = value.mode === 'global' ? 'global' : 'country';
  const next = { ...EMPTY_SHOPPING_LOCATION, mode };
  if (Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 && value.updatedAt <= Date.now() + 86400000) next.updatedAt = value.updatedAt;
  {
    (mode === 'global' ? ['country', 'countryCode'] : fields).forEach(field => { next[field] = clean(value[field]); });
    next.countryCode = countryCode(value.countryCode);
    if (!next.country && next.countryCode) next.country = next.countryCode;
    if (!next.country || !next.countryCode) {
      fields.filter(field => !['country', 'countryCode'].includes(field)).forEach(field => { next[field] = ''; });
    }
  }
  next.confirmed = value.version === 2 && value.confirmed === true && ['country', 'global'].includes(value.mode)
    && (mode === 'global' || Boolean(next.country && next.countryCode));
  return next;
}

export function shoppingLocationIsValid(value) {
  return value?.mode === 'global'
    || (value?.mode === 'country' && Boolean(clean(value.country) && countryCode(value.countryCode)));
}

export function shoppingLocationFromDetection(data) {
  if (data?.detected !== true || !countryCode(data.country)) return null;
  return normalizeShoppingLocation({
    mode: 'country', country: clean(data.countryName) || countryCode(data.country),
    countryCode: countryCode(data.country),
  });
}

export function shoppingLocationFromProfile(user) {
  const addresses = Array.isArray(user?.savedAddresses) ? user.savedAddresses : [];
  const candidates = [addresses.find(address => address?.isDefault), ...addresses, user?.savedShippingInfo, user?.sellerInfo];
  // Ignore the old empty address placeholder whose schema default was Pakistan.
  const address = candidates.find(candidate => candidate && (candidate.address || candidate.street || candidate.city)
    && (candidate.country || candidate.countryCode));
  if (!address) return null;
  const code = countryCode(address.countryCode)
    || ({ pakistan: 'PK', 'united states': 'US', 'united kingdom': 'GB' })[clean(address.country).toLowerCase()];
  if (!code) return null;
  return normalizeShoppingLocation({
    mode: 'country', country: address.country || code, countryCode: code,
    region: address.state, regionCode: address.stateCode, city: address.city,
  });
}

export function shoppingLocationParams(value) {
  const location = normalizeShoppingLocation(value);
  const params = { buyerMode: location.mode };
  const mappings = {
    country: 'buyerCountry', countryCode: 'buyerCountryCode', region: 'buyerRegion',
    regionCode: 'buyerRegionCode', city: 'buyerCity', cityStateCode: 'buyerCityStateCode',
    town: 'buyerTown', townStateCode: 'buyerTownStateCode',
  };
  Object.entries(mappings).forEach(([field, key]) => { if (location[field]) params[key] = location[field]; });
  return params;
}

export function shoppingLocationLabel(value) {
  if (value?.mode === 'global') return value.country ? `Global + ${value.country}` : 'Global';
  return value?.town || value?.city || value?.region || value?.country || 'Choose a country';
}

// Global's local catalog follows the detected/profile country, not a country
// the shopper previously chose to browse. Never infer geography from currency.
export function withGlobalShoppingCountry(value, suggestion) {
  return normalizeShoppingLocation({ ...value, mode: 'global',
    country: suggestion?.country || '', countryCode: suggestion?.countryCode || '' });
}

export function shoppingCountryPatch(option) {
  return {
    mode: 'country', country: option?.name || '', countryCode: option?.isoCode || '',
    region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '',
  };
}
