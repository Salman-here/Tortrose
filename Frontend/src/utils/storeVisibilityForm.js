export const STORE_VISIBILITY_OPTIONS = [
  { mode: 'global', label: 'Global', description: 'Appear in Global shopping' },
  { mode: 'country', label: 'Country', description: 'Visible in one country' },
  { mode: 'region', label: 'State', description: 'Visible in one province or state' },
  { mode: 'city', label: 'City', description: 'Visible in one city' },
  { mode: 'town', label: 'Town', description: 'Visible in one town or area' },
];
export const GLOBAL_SHIPPING_NOTICE = 'Only choose Global if you can ship your products globally. Your store and products will appear in Global shopping.';
export function defaultStoreVisibility(address = {}) {
  return { mode: 'country', country: address.country || '', countryCode: address.countryCode || '',
    region: address.state || '', regionCode: address.stateCode || '', city: address.city || '',
    cityStateCode: address.stateCode || '', town: '', townStateCode: '' };
}
export function storeVisibilityError(value = {}) {
  if (!STORE_VISIBILITY_OPTIONS.some(option => option.mode === value.mode)) return 'Choose a store visibility option.';
  if (value.mode === 'global') return '';
  if (!String(value.country || '').trim() || !/^[A-Z]{2}$/.test(value.countryCode || '')) return 'Select a country for your store visibility.';
  if (value.mode === 'region' && !String(value.region || '').trim()) return 'Select a state or province for your store visibility.';
  if (['city', 'town'].includes(value.mode) && !String(value.city || '').trim()) return 'Select a city for your store visibility.';
  if (value.mode === 'town' && !String(value.town || '').trim()) return 'Select a town or area for your store visibility.';
  return '';
}
export function storeVisibilityPayload(value) {
  if (storeVisibilityError(value)) throw new Error(storeVisibilityError(value));
  if (value.mode === 'global') return { mode: 'global' };
  const result = { mode: value.mode, country: value.country, countryCode: value.countryCode };
  if (['region', 'city', 'town'].includes(value.mode)) Object.assign(result, { region: value.region || '', regionCode: value.regionCode || '' });
  if (['city', 'town'].includes(value.mode)) Object.assign(result, { city: value.city || '', cityStateCode: value.cityStateCode || '' });
  if (value.mode === 'town') Object.assign(result, { town: value.town || '', townStateCode: value.townStateCode || '' });
  return result;
}
