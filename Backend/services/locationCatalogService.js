'use strict';

const { Country, State, City } = require('country-state-city');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

function cleanText(value, max = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeKey(value) {
  return cleanText(value, 160)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCoordinatePair(item = {}) {
  return {
    latitude: numberOrNull(item.latitude),
    longitude: numberOrNull(item.longitude),
  };
}

function rankByQuery(item, queryKey) {
  if (!queryKey) return 0;
  const nameKey = normalizeKey(item.name);
  const codeKey = normalizeKey(item.isoCode || item.stateCode || item.countryCode || '');
  if (nameKey === queryKey || codeKey === queryKey) return 0;
  if (nameKey.startsWith(queryKey) || codeKey.startsWith(queryKey)) return 1;
  if (nameKey.includes(queryKey)) return 2;
  return 3;
}

function filterSortLimit(items, query, limit) {
  const queryKey = normalizeKey(query);
  const max = clampLimit(limit);
  const filtered = queryKey
    ? items.filter(item => {
      const nameKey = normalizeKey(item.name);
      const codeKey = normalizeKey(item.isoCode || item.stateCode || item.countryCode || '');
      return nameKey.includes(queryKey) || codeKey.includes(queryKey);
    })
    : items;

  return filtered
    .sort((a, b) => {
      const rankDiff = rankByQuery(a, queryKey) - rankByQuery(b, queryKey);
      if (rankDiff !== 0) return rankDiff;
      return cleanText(a.name).localeCompare(cleanText(b.name));
    })
    .slice(0, max);
}

function normalizeCountryCode(value) {
  const code = cleanText(value, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(code) && Country.getCountryByCode(code) ? code : '';
}

function resolveCountryCode({ countryCode, country } = {}) {
  const directCode = normalizeCountryCode(countryCode || country);
  if (directCode) return directCode;

  const countryKey = normalizeKey(country);
  if (!countryKey) return '';

  const match = Country.getAllCountries().find(item => normalizeKey(item.name) === countryKey);
  return match?.isoCode || '';
}

function resolveStateCode({ countryCode, stateCode, state, region } = {}) {
  const code = cleanText(stateCode, 12).toUpperCase();
  const states = Country.getCountryByCode(countryCode) ? State.getStatesOfCountry(countryCode) : [];
  if (code && states.some(item => item.isoCode === code)) return code;

  const stateKey = normalizeKey(state || region);
  if (!stateKey) return '';
  const match = states.find(item => normalizeKey(item.name) === stateKey);
  return match?.isoCode || '';
}

function serializeCountry(country) {
  const coords = toCoordinatePair(country);
  return {
    name: country.name,
    isoCode: country.isoCode,
    currency: country.currency || '',
    phonecode: country.phonecode || '',
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
}

function serializeState(state) {
  const coords = toCoordinatePair(state);
  return {
    name: state.name,
    isoCode: state.isoCode,
    countryCode: state.countryCode,
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
}

function serializeCity(city) {
  const coords = toCoordinatePair(city);
  return {
    name: city.name,
    countryCode: city.countryCode,
    stateCode: city.stateCode,
    stateName: State.getStatesOfCountry(city.countryCode).find(state => state.isoCode === city.stateCode)?.name || '',
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
}

function listCountries({ q = '', limit } = {}) {
  return filterSortLimit(Country.getAllCountries(), q, limit).map(serializeCountry);
}

function listStates({ countryCode = '', country = '', q = '', limit } = {}) {
  const resolvedCountryCode = resolveCountryCode({ countryCode, country });
  if (!resolvedCountryCode) return [];
  return filterSortLimit(State.getStatesOfCountry(resolvedCountryCode), q, limit).map(serializeState);
}

function listCities({ countryCode = '', country = '', stateCode = '', state = '', region = '', q = '', limit } = {}) {
  const resolvedCountryCode = resolveCountryCode({ countryCode, country });
  if (!resolvedCountryCode) return [];

  const resolvedStateCode = resolveStateCode({
    countryCode: resolvedCountryCode,
    stateCode,
    state,
    region,
  });
  const cities = resolvedStateCode
    ? City.getCitiesOfState(resolvedCountryCode, resolvedStateCode)
    : City.getCitiesOfCountry(resolvedCountryCode);

  return filterSortLimit(cities || [], q, limit).map(serializeCity);
}

function countryNameFromCode(countryCode) {
  const code = normalizeCountryCode(countryCode);
  return code ? Country.getCountryByCode(code)?.name || '' : '';
}

function countryCodeFromName(country) {
  return resolveCountryCode({ country });
}

function stateInfoFromLocation(countryCode, stateCode = '', stateName = '') {
  if (!Country.getCountryByCode(countryCode)) return null;
  const code = cleanText(stateCode, 12).toUpperCase();
  const name = normalizeKey(stateName);
  const states = State.getStatesOfCountry(countryCode);
  const match = code ? states.find(state => state.isoCode === code)
    : states.find(state => normalizeKey(state.name) === name || state.isoCode.toUpperCase() === String(stateName).trim().toUpperCase());
  return match ? { name: match.name, code: match.isoCode } : null;
}

module.exports = {
  cleanText,
  countryCodeFromName,
  countryNameFromCode,
  listCities,
  listCountries,
  listStates,
  normalizeKey,
  resolveCountryCode,
  resolveStateCode,
  stateInfoFromLocation,
};
