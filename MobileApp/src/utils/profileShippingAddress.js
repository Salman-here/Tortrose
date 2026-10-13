export const EMPTY_PROFILE_SHIPPING_ADDRESS = Object.freeze({
  fullName: '', email: '', phone: '', address: '', country: 'Pakistan', countryCode: 'PK',
  state: '', stateCode: '', city: '', postalCode: '',
});
const clean = value => typeof value === 'string' ? value.trim() : '';

export function normalizeProfileShippingAddress(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const next = Object.fromEntries(Object.keys(EMPTY_PROFILE_SHIPPING_ADDRESS).map(key => [key,
    Object.prototype.hasOwnProperty.call(source, key) ? clean(source[key]) : EMPTY_PROFILE_SHIPPING_ADDRESS[key]]));
  next.countryCode = /^[A-Z]{2}$/i.test(next.countryCode) ? next.countryCode.toUpperCase() : '';
  // Legacy addresses saved country names without their ISO code. Do not give
  // foreign addresses the Pakistan default when their country is present.
  if (!Object.prototype.hasOwnProperty.call(source, 'countryCode')) next.countryCode = '';
  if (!next.countryCode && next.country.toLowerCase() === 'pakistan') next.countryCode = 'PK';
  next.stateCode = next.stateCode.toUpperCase();
  return next;
}

export function updateProfileShippingLocation(previous, type, option = null) {
  const name = clean(option?.name);
  const optionCountry = clean(option?.countryCode).toUpperCase();
  if (type === 'country') return { ...previous, country: name, countryCode: clean(option?.isoCode).toUpperCase(),
    state: '', stateCode: '', city: '' };
  if (!['state', 'city'].includes(type)) return previous;
  if (option && (!previous.country && !previous.countryCode
    || optionCountry && previous.countryCode && optionCountry !== previous.countryCode)) return previous;
  if (type === 'state') return { ...previous, state: name, stateCode: clean(option?.isoCode).toUpperCase(), city: '' };
  const cityState = clean(option?.stateCode).toUpperCase();
  if (option && previous.stateCode && cityState && cityState !== previous.stateCode) return previous;
  return { ...previous, city: name,
    countryCode: previous.countryCode || optionCountry,
    state: previous.state || clean(option?.stateName), stateCode: previous.stateCode || cityState };
}

export function profileShippingLocationError(address) {
  if (!clean(address?.country) || !/^[A-Z]{2}$/.test(address?.countryCode || '')) return 'Select a country from the list.';
  if (!clean(address?.city)) return 'Select a city from the list.';
  return '';
}
