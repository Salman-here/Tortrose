import { inspectSellerProductPresentation } from './productCardSafety.js';

const SIGNED_MONEY_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const SIGNED_PERCENT_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;

export const inspectProductBulkSelection = (products) => {
  if (!Array.isArray(products) || products.length === 0 || products.length > 250) {
    return { valid: false, productIds: [], presentations: [], currencies: [] };
  }
  const presentations = products.map(inspectSellerProductPresentation);
  const productIds = products.map(product => product?._id);
  const uniqueIds = new Set(productIds);
  const valid = uniqueIds.size === productIds.length
    && presentations.every(presentation => presentation.managementSafe && presentation.valid);
  return {
    valid,
    productIds: valid ? productIds : [],
    presentations,
    currencies: valid ? presentations.map(presentation => presentation.currency) : [],
  };
};

export const parseSignedBulkMoneyInput = (raw, {
  allowNegative = false,
  allowZero = false,
} = {}) => {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const text = String(raw).trim();
  if (!text || text.length > 64 || !SIGNED_MONEY_PATTERN.test(text)) return null;
  const negative = text.startsWith('-');
  if (negative && !allowNegative) return null;
  const unsigned = negative ? text.slice(1) : text;
  const [wholeText, fractionText = ''] = unsigned.split('.');
  try {
    const magnitude = (BigInt(wholeText) * 100n) + BigInt(fractionText.padEnd(2, '0'));
    if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    if (!allowZero && magnitude === 0n) return null;
    const minorUnits = negative ? -magnitude : magnitude;
    return Number(minorUnits) / 100;
  } catch {
    return null;
  }
};

export const parseBulkPercentageInput = (raw, {
  minimum = -100,
  maximum = Number.MAX_SAFE_INTEGER,
  maximumExclusive = false,
  allowZero = false,
} = {}) => {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const text = String(raw).trim();
  if (!text || text.length > 64 || !SIGNED_PERCENT_PATTERN.test(text)) return null;
  const value = Number(text);
  if (
    !Number.isFinite(value)
    || !Number.isSafeInteger(Math.trunc(value))
    || (!allowZero && value === 0)
    || value < minimum
    || (maximumExclusive ? value >= maximum : value > maximum)
  ) return null;
  return value;
};
