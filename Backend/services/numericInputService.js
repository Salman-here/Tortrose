'use strict';

const STRICT_DECIMAL = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

const inputIsMissing = value => value === undefined;

const parseStrictFiniteNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !STRICT_DECIMAL.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
};

const parsePositiveSafeInteger = (value, { fallback } = {}) => {
  if (inputIsMissing(value) && fallback !== undefined) value = fallback;
  const number = parseStrictFiniteNumber(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const parseNonNegativeSafeInteger = (value) => {
  const number = parseStrictFiniteNumber(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

// AI money arguments may contain a currency marker ("PKR 500", "$10.25"),
// but their underlying value must still be a scalar string/number. Booleans,
// blanks, arrays, and objects must never coerce to 0/1 at a write boundary.
const parseMoneyLikeNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.replace(/,/g, '');
  const matches = normalized.match(/[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?/ig) || [];
  if (matches.length !== 1) return null;
  const number = Number(matches[0]);
  return Number.isFinite(number) ? number : null;
};

module.exports = {
  parseStrictFiniteNumber,
  parsePositiveSafeInteger,
  parseNonNegativeSafeInteger,
  parseMoneyLikeNumber,
};
