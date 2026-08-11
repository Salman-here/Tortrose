import {
  countryCodeFromName,
  countryDisplayName,
  normalizeCountryCode,
} from './phoneNumber';

/**
 * Address forms prefer a saved address, then the detected buyer location.
 * Pakistan is used only after both sources are unavailable offline.
 */
export const addressCountrySeed = (
  savedAddress,
  detectedLocation,
  allowOfflineFallback = true,
) => {
  const savedCode = normalizeCountryCode(savedAddress?.countryCode)
    || countryCodeFromName(savedAddress?.country);
  const detectedCode = normalizeCountryCode(detectedLocation?.countryCode)
    || countryCodeFromName(detectedLocation?.country);
  const countryCode = savedCode || detectedCode || (allowOfflineFallback ? 'PK' : '');
  const country = String(savedAddress?.country || detectedLocation?.country || '').trim()
    || (countryCode ? countryDisplayName(countryCode) : '');
  return { country, countryCode };
};

export default addressCountrySeed;
