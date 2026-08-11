'use strict';

const User = require('../models/User');

const EARTH_RADIUS_KM = 6371;
const MAX_RADIUS_KM = 500;
const {
  countryCodeFromName,
  countryNameFromCode,
} = require('./locationCatalogService');

const VISIBILITY_MODES = new Set(['global', 'country', 'region', 'city', 'town', 'radius']);

const COUNTRY_NAMES_BY_CODE = {
  PK: 'Pakistan',
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  IT: 'Italy',
  ES: 'Spain',
};

const COUNTRY_CODES_BY_KEY = Object.entries(COUNTRY_NAMES_BY_CODE).reduce((acc, [code, name]) => {
  acc[normalizeAreaKey(name)] = code;
  return acc;
}, {});

const CURRENCY_COUNTRY = {
  PKR: { country: 'Pakistan', countryCode: 'PK' },
  USD: { country: 'United States', countryCode: 'US' },
  GBP: { country: 'United Kingdom', countryCode: 'GB' },
  EUR: { country: 'Germany', countryCode: 'DE' },
};

function cleanText(value, max = 80) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function normalizeAreaKey(value) {
  return cleanText(value, 120)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function normalizeCountry(value, countryCode = '') {
  const code = normalizeCountryCode(countryCode || value);
  const catalogName = code ? countryNameFromCode(code) : '';
  const country = cleanText(catalogName || (code && COUNTRY_NAMES_BY_CODE[code] ? COUNTRY_NAMES_BY_CODE[code] : value), 80);
  const countryKey = normalizeAreaKey(country);
  const derivedCode = code || countryCodeFromName(country) || COUNTRY_CODES_BY_KEY[countryKey] || '';
  return {
    country,
    countryCode: derivedCode,
    countryKey,
  };
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampRadiusKm(value) {
  const n = numberOrNull(value);
  if (n === null) return null;
  return Math.min(MAX_RADIUS_KM, Math.max(0.1, Math.round(n * 10) / 10));
}

function coordinatesFrom(input = {}) {
  const lat = numberOrNull(input.lat ?? input.latitude ?? input.buyerLat);
  const lng = numberOrNull(input.lng ?? input.longitude ?? input.buyerLng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function fallbackSellerCountry({ store = null, seller = null } = {}) {
  const storeCountry = store?.address?.country;
  if (storeCountry || store?.address?.countryCode) return normalizeCountry(storeCountry, store?.address?.countryCode);

  const sellerCountry = seller?.sellerInfo?.country || seller?.savedShippingInfo?.country;
  const sellerCountryCode = seller?.sellerInfo?.countryCode || seller?.savedShippingInfo?.countryCode;
  if (sellerCountry || sellerCountryCode) return normalizeCountry(sellerCountry, sellerCountryCode);

  const mapped = CURRENCY_COUNTRY[String(seller?.currency || '').toUpperCase()];
  if (mapped) return normalizeCountry(mapped.country, mapped.countryCode);

  return normalizeCountry('United States', 'US');
}

function normalizeStoreVisibility(input = {}, options = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackCountry = fallbackSellerCountry(options);
  const mode = VISIBILITY_MODES.has(String(source.mode || '').toLowerCase())
    ? String(source.mode).toLowerCase()
    : 'country';

  const explicitCountry = cleanText(source.country, 80);
  const countryInfo = normalizeCountry(
    explicitCountry || fallbackCountry.country,
    source.countryCode || (explicitCountry ? '' : fallbackCountry.countryCode)
  );
  const region = cleanText(source.region ?? source.state ?? source.province, 80);
  const regionCode = cleanText(source.regionCode ?? source.stateCode, 12).toUpperCase();
  const city = cleanText(source.city, 80);
  const cityStateCode = cleanText(source.cityStateCode ?? source.cityState ?? regionCode, 12).toUpperCase();
  const town = cleanText(source.town ?? source.area ?? source.neighborhood, 80);
  const townStateCode = cleanText(source.townStateCode ?? source.townState ?? cityStateCode, 12).toUpperCase();
  const coords = coordinatesFrom(source);
  const radiusKm = clampRadiusKm(source.radiusKm ?? source.radius);

  const visibility = {
    mode,
    country: mode === 'global' ? '' : countryInfo.country,
    countryCode: mode === 'global' ? '' : countryInfo.countryCode,
    countryKey: mode === 'global' ? '' : countryInfo.countryKey,
    region: '',
    regionCode: '',
    regionKey: '',
    city: '',
    cityStateCode: '',
    cityKey: '',
    town: '',
    townStateCode: '',
    townKey: '',
    radiusKm: null,
    location: undefined,
    label: cleanText(source.label, 120),
    updatedAt: new Date(),
  };

  if (mode === 'region' || mode === 'city' || mode === 'town') {
    if (!region && mode === 'region') {
      const err = new Error('State or province is required for regional visibility.');
      err.status = 400;
      throw err;
    }
    visibility.region = region;
    visibility.regionCode = regionCode;
    visibility.regionKey = normalizeAreaKey(region);
  }

  if (mode === 'city' || mode === 'town') {
    if (!city && mode === 'city') {
      const err = new Error('City is required for city visibility.');
      err.status = 400;
      throw err;
    }
    visibility.city = city;
    visibility.cityStateCode = cityStateCode;
    visibility.cityKey = normalizeAreaKey(city);
  }

  if (mode === 'town') {
    if (!town) {
      const err = new Error('Town or area is required for town visibility.');
      err.status = 400;
      throw err;
    }
    visibility.town = town;
    visibility.townStateCode = townStateCode;
    visibility.townKey = normalizeAreaKey(town);
  }

  if (mode === 'radius') {
    if (!coords || radiusKm === null) {
      const err = new Error('Latitude, longitude, and radius are required for radius visibility.');
      err.status = 400;
      throw err;
    }
    visibility.radiusKm = radiusKm;
    visibility.location = {
      type: 'Point',
      coordinates: [coords.lng, coords.lat],
    };
    visibility.city = city;
    visibility.cityStateCode = cityStateCode;
    visibility.cityKey = normalizeAreaKey(city);
    visibility.region = region;
    visibility.regionCode = regionCode;
    visibility.regionKey = normalizeAreaKey(region);
    visibility.town = town;
    visibility.townStateCode = townStateCode;
    visibility.townKey = normalizeAreaKey(town);
  }

  if (!visibility.label) {
    visibility.label = describeVisibility(visibility);
  }

  return visibility;
}

async function ensureStoreVisibilityInitialized(store, seller = null) {
  if (!store) return null;
  if (store.visibility?.mode) return store.visibility;

  store.visibility = normalizeStoreVisibility({}, { store, seller });
  store.markModified?.('visibility');
  await store.save?.();
  return store.visibility;
}

function buyerLocationFromRequest(req = {}) {
  const source = { ...(req.query || {}), ...(req.body?.buyerLocation || {}) };
  const user = req.user || {};
  const savedAddress = Array.isArray(user.savedAddresses)
    ? user.savedAddresses.find(a => a.isDefault) || user.savedAddresses[0]
    : null;
  const defaultCountry = source.country
    || source.buyerCountry
    || savedAddress?.country
    || user.savedShippingInfo?.country
    || user.sellerInfo?.country
    || '';

  return normalizeBuyerLocation({
    country: defaultCountry,
    countryCode: source.countryCode || source.buyerCountryCode,
    region: source.region || source.state || source.province || source.buyerRegion,
    city: source.city || source.buyerCity,
    town: source.town || source.area || source.buyerTown,
    lat: source.lat || source.latitude || source.buyerLat,
    lng: source.lng || source.longitude || source.buyerLng,
  });
}

function normalizeBuyerLocation(input = {}) {
  const explicitCountry = cleanText(input.country, 80);
  const countryInfo = normalizeCountry(explicitCountry, explicitCountry ? '' : input.countryCode);
  const coords = coordinatesFrom(input);
  return {
    country: countryInfo.country,
    countryCode: countryInfo.countryCode,
    countryKey: countryInfo.countryKey,
    region: cleanText(input.region ?? input.state ?? input.province, 80),
    regionKey: normalizeAreaKey(input.region ?? input.state ?? input.province),
    city: cleanText(input.city, 80),
    cityKey: normalizeAreaKey(input.city),
    town: cleanText(input.town ?? input.area ?? input.neighborhood, 80),
    townKey: normalizeAreaKey(input.town ?? input.area ?? input.neighborhood),
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    hasCountry: !!countryInfo.countryKey,
    hasGeo: !!coords,
  };
}

function legacyVisibilityClauses() {
  return [
    { visibility: { $exists: false } },
    { 'visibility.mode': { $exists: false } },
    { 'visibility.mode': null },
  ];
}

function nonRadiusVisibilityFilter(buyerLocation = {}, { includeLegacy = true } = {}) {
  const location = normalizeBuyerLocation(buyerLocation);
  const or = [{ 'visibility.mode': 'global' }];
  if (includeLegacy) or.push(...legacyVisibilityClauses());

  if (location.countryKey) {
    or.push({
      'visibility.mode': 'country',
      'visibility.countryKey': location.countryKey,
    });
  }

  if (location.countryKey && location.regionKey) {
    or.push({
      'visibility.mode': 'region',
      'visibility.countryKey': location.countryKey,
      'visibility.regionKey': location.regionKey,
    });
  }

  if (location.countryKey && location.cityKey) {
    or.push({
      'visibility.mode': 'city',
      'visibility.countryKey': location.countryKey,
      'visibility.cityKey': location.cityKey,
    });
  }

  if (location.countryKey && location.townKey) {
    or.push({
      'visibility.mode': 'town',
      'visibility.countryKey': location.countryKey,
      'visibility.townKey': location.townKey,
      ...(location.cityKey ? { 'visibility.cityKey': location.cityKey } : {}),
    });
  }

  return { $or: or };
}

function mergeAndFilter(baseFilter, visibilityFilter) {
  const filter = { ...(baseFilter || {}) };
  if (filter.$and) {
    filter.$and = [...filter.$and, visibilityFilter];
  } else {
    filter.$and = [visibilityFilter];
  }
  return filter;
}

function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function storeRadiusLocation(store = {}) {
  const coords = store.visibility?.location?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function isStoreVisibleToBuyer(store = {}, buyerLocation = {}) {
  const visibility = store.visibility || {};
  if (!visibility.mode) return true;
  if (visibility.mode === 'global') return true;

  const location = normalizeBuyerLocation(buyerLocation);
  if (!location.hasCountry && visibility.mode !== 'radius') return false;

  if (visibility.mode === 'country') {
    return visibility.countryKey === location.countryKey;
  }
  if (visibility.mode === 'region') {
    return visibility.countryKey === location.countryKey && visibility.regionKey === location.regionKey;
  }
  if (visibility.mode === 'city') {
    return visibility.countryKey === location.countryKey && visibility.cityKey === location.cityKey;
  }
  if (visibility.mode === 'town') {
    return visibility.countryKey === location.countryKey
      && visibility.townKey === location.townKey
      && (!visibility.cityKey || !location.cityKey || visibility.cityKey === location.cityKey);
  }
  if (visibility.mode === 'radius') {
    if (!location.hasGeo) return false;
    const center = storeRadiusLocation(store);
    const radiusKm = Number(visibility.radiusKm);
    if (!center || !Number.isFinite(radiusKm)) return false;
    return haversineKm(center, location) <= radiusKm;
  }

  return false;
}

function applyQueryOptions(query, options = {}) {
  if (options.select) query.select(options.select);
  if (options.populate) {
    const populates = Array.isArray(options.populate) ? options.populate : [options.populate];
    populates.forEach(populate => query.populate(populate));
  }
  if (options.projection) query.select(options.projection);
  return query;
}

async function findVisibleStores(StoreModel, baseFilter = {}, buyerLocation = {}, options = {}) {
  const location = normalizeBuyerLocation(buyerLocation);
  const includeLegacy = options.includeLegacy !== false;
  const nonRadiusFilter = mergeAndFilter(baseFilter, nonRadiusVisibilityFilter(location, { includeLegacy }));

  let nonRadiusQuery = StoreModel.find(nonRadiusFilter);
  applyQueryOptions(nonRadiusQuery, options);
  let stores = await nonRadiusQuery.lean(options.lean !== false);

  if (location.hasGeo) {
    const radiusBase = {
      ...(baseFilter || {}),
      'visibility.mode': 'radius',
      'visibility.location': {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [location.lng, location.lat] },
          $maxDistance: MAX_RADIUS_KM * 1000,
        },
      },
    };
    let radiusQuery = StoreModel.find(radiusBase);
    applyQueryOptions(radiusQuery, options);
    const radiusStores = await radiusQuery.lean(options.lean !== false);
    stores = [...stores, ...radiusStores.filter(store => isStoreVisibleToBuyer(store, location))];
  }

  // Store.isActive alone is insufficient for legacy rows whose seller was
  // deleted without a cascade. Require a currently active seller account so
  // orphaned or blocked storefronts disappear immediately from marketplace
  // lists even before a maintenance cleanup runs.
  const sellerIds = [...new Set(stores
    .map(store => store?.seller?._id || store?.seller)
    .filter(Boolean)
    .map(String))];
  const activeSellers = sellerIds.length
    ? await User.find({
      _id: { $in: sellerIds },
      role: 'seller',
      status: 'active',
    }).select('_id').lean()
    : [];
  const activeSellerIds = new Set(activeSellers.map(seller => String(seller._id)));

  const seen = new Set();
  return stores.filter(store => {
    const id = String(store._id || '');
    const sellerId = String(store?.seller?._id || store?.seller || '');
    if (!id || seen.has(id) || !activeSellerIds.has(sellerId)) return false;
    seen.add(id);
    return true;
  });
}

function describeVisibility(visibility = {}) {
  const mode = visibility.mode || 'country';
  if (mode === 'global') return 'Visible globally';
  if (mode === 'country') return `Visible in ${visibility.country || 'selected country'}`;
  if (mode === 'region') return `Visible in ${visibility.region || 'selected region'}, ${visibility.country || ''}`.trim();
  if (mode === 'city') return `Visible in ${visibility.city || 'selected city'}, ${visibility.country || ''}`.trim();
  if (mode === 'town') return `Visible in ${visibility.town || 'selected town'}, ${visibility.city || visibility.country || ''}`.trim();
  if (mode === 'radius') return `Visible within ${visibility.radiusKm || 1} km`;
  return 'Visible in selected area';
}

module.exports = {
  MAX_RADIUS_KM,
  VISIBILITY_MODES,
  buyerLocationFromRequest,
  describeVisibility,
  ensureStoreVisibilityInitialized,
  findVisibleStores,
  fallbackSellerCountry,
  haversineKm,
  isStoreVisibleToBuyer,
  nonRadiusVisibilityFilter,
  normalizeAreaKey,
  normalizeBuyerLocation,
  normalizeStoreVisibility,
};
