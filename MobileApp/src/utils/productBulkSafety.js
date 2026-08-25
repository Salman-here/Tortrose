import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  parseExactMoneyInput,
} from './sellerMoneySafety';

const SIGNED_MONEY_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const SIGNED_PERCENT_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;
const canonicalProductId = value => typeof value === 'string' && /^[a-f\d]{24}$/iu.test(value);

const exactJsonMoney = value => (
  isExactNonNegativeJsonMoney(value) ? parseExactMoneyInput(value) : null
);

export const inspectManagedProduct = (product) => {
  const value = product && typeof product === 'object' && !Array.isArray(product) ? product : {};
  const currency = exactCurrencyCode(value.currency);
  const priceCurrency = exactCurrencyCode(value.priceCurrency);
  const discountedPriceCurrency = exactCurrencyCode(value.discountedPriceCurrency);
  const price = exactJsonMoney(value.price);
  const discountedPrice = exactJsonMoney(value.discountedPrice);
  const currenciesValid = Boolean(currency)
    && priceCurrency === currency
    && discountedPriceCurrency === currency;
  const discountValid = Boolean(discountedPrice)
    && (discountedPrice.minorUnits === 0 || (
      Boolean(price) && discountedPrice.minorUnits < price.minorUnits
    ));
  const moneyValid = Boolean(price) && currenciesValid && discountValid;
  const stockValid = Number.isSafeInteger(value.stock) && value.stock >= 0;
  return {
    valid: canonicalProductId(value._id) && moneyValid && stockValid,
    managementSafe: canonicalProductId(value._id),
    moneyValid,
    currency: moneyValid ? currency : null,
    price: moneyValid ? price.amount : null,
    discountedPrice: moneyValid && discountedPrice.minorUnits > 0
      ? discountedPrice.amount
      : null,
    hasDiscount: moneyValid && discountedPrice.minorUnits > 0,
    stockValid,
    stock: stockValid ? value.stock : null,
  };
};

export const inspectProductBulkSelection = (products) => {
  if (!Array.isArray(products) || products.length === 0 || products.length > 250) {
    return { valid: false, productIds: [], presentations: [], currencies: [] };
  }
  const presentations = products.map(inspectManagedProduct);
  const ids = products.map(product => product?._id);
  const valid = new Set(ids).size === ids.length && presentations.every(item => item.valid);
  return {
    valid,
    productIds: valid ? ids : [],
    presentations,
    currencies: valid ? presentations.map(item => item.currency) : [],
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
    if ((!allowZero && magnitude === 0n) || magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(negative ? -magnitude : magnitude) / 100;
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
    || (!allowZero && value === 0)
    || value < minimum
    || (maximumExclusive ? value >= maximum : value > maximum)
  ) return null;
  return value;
};
