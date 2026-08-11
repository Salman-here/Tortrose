import { NativeModules, Platform } from 'react-native';
import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/max';

const FALLBACK_COUNTRY = 'PK';
const supportedCountries = new Set(getCountries());

export const normalizeCountryCode = (value) => {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && supportedCountries.has(code) ? code : '';
};

export const countryCodeFromLocale = (locale) => {
  const parts = String(locale || '').replace(/_/g, '-').split('-');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const code = normalizeCountryCode(parts[index]);
    if (code) return code;
  }
  return '';
};

export const getDeviceCountryCode = () => {
  try {
    const settings = NativeModules.SettingsManager?.settings || {};
    const appleLocale = settings.AppleLocale || settings.AppleLanguages?.[0];
    const nativeLocale = Platform.OS === 'ios'
      ? appleLocale
      : NativeModules.I18nManager?.localeIdentifier;
    const intlLocale = typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : '';
    return countryCodeFromLocale(nativeLocale || intlLocale);
  } catch (_) {
    return '';
  }
};

export const countryCallingCode = (countryCode) => {
  const code = normalizeCountryCode(countryCode) || FALLBACK_COUNTRY;
  try {
    return getCountryCallingCode(code);
  } catch (_) {
    return getCountryCallingCode(FALLBACK_COUNTRY);
  }
};

export const countryFlag = (countryCode) => {
  const code = normalizeCountryCode(countryCode);
  if (!code) return '\uD83C\uDF10';
  return String.fromCodePoint(...code.split('').map(char => 127397 + char.charCodeAt(0)));
};

export const countryDisplayName = (countryCode) => {
  const code = normalizeCountryCode(countryCode);
  if (!code) return 'Country';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code;
  } catch (_) {
    return code;
  }
};

export const countryCodeFromName = (value) => {
  const name = String(value || '').trim();
  if (!name) return '';
  const directCode = normalizeCountryCode(name);
  if (directCode) return directCode;
  const normalizedName = name.toLocaleLowerCase('en');
  return getCountries().find(code => countryDisplayName(code).toLocaleLowerCase('en') === normalizedName) || '';
};

export const countryFromPhoneNumber = (value) => {
  try {
    return normalizeCountryCode(parsePhoneNumberFromString(String(value || ''))?.country);
  } catch (_) {
    return '';
  }
};

export const nationalDigitsFromPhone = (value, countryCode) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = parsePhoneNumberFromString(raw, normalizeCountryCode(countryCode) || undefined);
    if (parsed?.nationalNumber) return String(parsed.nationalNumber).slice(0, 15);
  } catch (_) {}
  return raw.replace(/\D/g, '').replace(/^0+/, '').slice(0, 15);
};

/**
 * Convert a user's national-number input to the canonical E.164-shaped value
 * sent to Rozare APIs. The exact validity check remains separate so incomplete
 * input can stay controlled while the user is still typing.
 */
export const toE164PhoneNumber = (value, countryCode = FALLBACK_COUNTRY) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits.slice(0, 15)}`;

  const code = normalizeCountryCode(countryCode) || FALLBACK_COUNTRY;
  const national = digits.replace(/^0+/, '');
  if (!national) return '';
  return `+${countryCallingCode(code)}${national}`.slice(0, 16);
};

export const isValidPhoneNumber = (value) => {
  try {
    const parsed = parsePhoneNumberFromString(String(value || ''));
    return Boolean(parsed?.isValid());
  } catch (_) {
    return false;
  }
};

export const formatPhoneNumber = (value) => {
  try {
    const parsed = parsePhoneNumberFromString(String(value || ''));
    return parsed?.formatInternational() || String(value || '');
  } catch (_) {
    return String(value || '');
  }
};

export const fallbackCountryOption = (countryCode = FALLBACK_COUNTRY) => {
  const code = normalizeCountryCode(countryCode) || FALLBACK_COUNTRY;
  return {
    name: countryDisplayName(code),
    isoCode: code,
    phonecode: countryCallingCode(code),
  };
};

export const allFallbackCountryOptions = () => getCountries().map(fallbackCountryOption);

export const isPhoneCountrySupported = (countryCode) => {
  const code = normalizeCountryCode(countryCode);
  return Boolean(code && isSupportedCountry(code));
};

export { FALLBACK_COUNTRY };
