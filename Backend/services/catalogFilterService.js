'use strict';
const { convertAmount, normalizeCurrency } = require('./currencyService');
const { requireStoredProductEffectivePrice, requireStoredProductCurrency } = require('./productPricingService');

const filterError = message => Object.assign(new Error(message), { statusCode: 400, status: 400, code: 'CATALOG_FILTER_INVALID' });
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stableId = (a, b) => String(a._id || '').localeCompare(String(b._id || ''));

function exactValues(values) {
  const list = Array.isArray(values) ? values : [values];
  if (list.some(value => typeof value !== 'string')) throw filterError('Choose valid category or brand filters.');
  return [...new Set(list.map(value => value.trim()).filter(Boolean))].map(value => new RegExp(`^${escapeRegex(value)}$`, 'i'));
}

function uniqueFilterLabels(items) {
  const labels = [...new Set((items || []).map(value => String(value || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const seen = new Set();
  return labels.filter(label => { const key = label.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

function parsePriceRange(value) {
  if (value === undefined || value === null || value === '') return null;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  if (parts.length !== 2) throw filterError('Price range must contain a minimum and maximum.');
  const parse = (raw, upper) => {
    if (raw === '' || raw === null || raw === undefined || (upper && raw === 'Infinity')) return null;
    const number = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(number) || number < 0) throw filterError('Prices must be non-negative numbers.');
    return number;
  };
  const range = { min: parse(parts[0], false), max: parse(parts[1], true) };
  if (range.min !== null && range.max !== null && range.min > range.max) throw filterError('Minimum price cannot exceed maximum price.');
  return range;
}

async function attachComparablePrices(products, targetCurrency = 'USD') {
  const currency = normalizeCurrency(targetCurrency);
  return Promise.all(products.map(async product => {
    const plain = product?.toObject ? product.toObject() : product;
    return { ...plain, _comparablePrice: await convertAmount(requireStoredProductEffectivePrice(plain), requireStoredProductCurrency(plain, 'USD'), currency) };
  }));
}

function productFieldComparator(field, direction = 'desc') {
  if (!['price', 'rating', 'newest', 'popular', 'sales'].includes(field)) return null;
  const sign = direction === 'asc' ? 1 : -1;
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  return (a, b) => {
    let difference;
    if (field === 'price') {
      const invalidA = a?.adminDataIssue?.scope === 'money', invalidB = b?.adminDataIssue?.scope === 'money';
      if (invalidA !== invalidB) return invalidA ? 1 : -1;
      difference = number(a._comparablePrice) - number(b._comparablePrice);
    } else if (field === 'rating') {
      difference = number(a.rating) - number(b.rating) || number(a.numReviews) - number(b.numReviews);
    } else if (field === 'newest') {
      difference = number(new Date(a.createdAt || 0).getTime()) - number(new Date(b.createdAt || 0).getTime());
    } else {
      const key = field === 'popular' ? 'views' : 'totalSales';
      difference = number(a[key]) - number(b[key]);
    }
    return difference * sign || (field === 'newest' ? stableId(b, a) : stableId(a, b));
  };
}

function storeRefinements(query = {}) {
  if (query.verifiedOnly !== undefined && !['true', 'false', '1', '0'].includes(String(query.verifiedOnly))) throw filterError('Choose a valid verification filter.');
  const minTrust = query.minTrust === undefined || query.minTrust === '' ? 0 : Number(query.minTrust);
  if (!Number.isSafeInteger(minTrust) || minTrust < 0) throw filterError('Minimum trust must be a non-negative whole number.');
  return {
    ...(['true', '1'].includes(String(query.verifiedOnly)) ? { 'verification.isVerified': true } : {}),
    ...(minTrust > 0 ? { trustCount: { $gte: minTrust } } : {}),
  };
}

module.exports = { filterError, escapeRegex, exactValues, uniqueFilterLabels, parsePriceRange, attachComparablePrices, productFieldComparator, stableId, storeRefinements };
