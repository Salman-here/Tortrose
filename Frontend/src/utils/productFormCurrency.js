import { parseExactMoneyInput } from './sellerMoneySafety.js';

const SUPPORTED_PRODUCT_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);

const invalidProductCurrencyMetadata = () => {
  const error = new Error('Product currency metadata is invalid. Refresh the product before editing it.');
  error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
  return error;
};

const requireProductCurrency = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw invalidProductCurrencyMetadata();
  const normalized = value.trim().toUpperCase();
  if (!SUPPORTED_PRODUCT_CURRENCIES.has(normalized)) throw invalidProductCurrencyMetadata();
  return normalized;
};

const explicitCurrencyValues = (product, fields) => fields
  .filter(field => Object.prototype.hasOwnProperty.call(product || {}, field))
  .map(field => product[field])
  // Only a genuinely absent field is legacy metadata. Explicit null,
  // undefined, blank, non-string, and unsupported values are corruption.
  .map(requireProductCurrency);

const resolveCurrencyFields = (product, fields, fallback) => {
  const explicit = [...new Set(explicitCurrencyValues(product, fields))];
  if (explicit.length > 1) throw invalidProductCurrencyMetadata();
  return explicit[0] || requireProductCurrency(fallback);
};

export const resolveProductFormCurrency = (product, accountCurrency = 'USD') => {
  // Currency-less persisted products predate native pricing and are canonical
  // USD. Only new products may inherit the user's currently selected currency.
  const fallback = product?._id ? 'USD' : accountCurrency;
  return resolveCurrencyFields(product, ['currency', 'priceCurrency'], fallback);
};

export const normalizeProductForEdit = (product) => {
  if (!product || typeof product !== 'object') return product;
  const currency = resolveProductFormCurrency(product, 'USD');
  const discountedPriceCurrency = resolveCurrencyFields(
    product,
    ['discountedPriceCurrency', 'discountedCurrency'],
    currency,
  );
  if (Number(product.discountedPrice) > 0 && discountedPriceCurrency !== currency) {
    throw invalidProductCurrencyMetadata();
  }
  return {
    ...product,
    currency,
    priceCurrency: currency,
    discountedPriceCurrency: Number(product.discountedPrice) > 0
      ? discountedPriceCurrency
      : currency,
  };
};

export const inspectProductFormSubmission = (product, accountCurrency = 'USD') => {
  try {
    if (!product || typeof product !== 'object' || Array.isArray(product)) return { valid: false };
    const currency = resolveProductFormCurrency(product, accountCurrency);
    const discountedCurrency = resolveCurrencyFields(
      product,
      ['discountedPriceCurrency', 'discountedCurrency'],
      currency,
    );
    if (discountedCurrency !== currency) return { valid: false };

    const price = parseExactMoneyInput(product.price);
    const discountText = String(product.discountedPrice ?? '').trim();
    const discountedPrice = discountText
      ? parseExactMoneyInput(discountText)
      : { amount: 0, minorUnits: 0 };
    const stockText = String(product.stock ?? '').trim();
    const stock = /^\d+$/.test(stockText) ? Number(stockText) : Number.NaN;
    if (
      !price
      || !discountedPrice
      || !Number.isSafeInteger(stock)
      || stock < 0
      || (discountedPrice.minorUnits > 0 && (
        price.minorUnits === 0
        || discountedPrice.minorUnits >= price.minorUnits
      ))
    ) return { valid: false };

    return {
      valid: true,
      currency,
      price: price.amount,
      discountedPrice: discountedPrice.amount,
      stock,
    };
  } catch (_) {
    return { valid: false };
  }
};

export const inspectSellerProductCurrencyState = (state) => {
  try {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { valid: false };
    if (typeof state.hasStore !== 'boolean' || typeof state.canAddProduct !== 'boolean') {
      return { valid: false };
    }
    const requireCanonicalStateCurrency = (value) => {
      const normalized = requireProductCurrency(value);
      if (value !== normalized) throw invalidProductCurrencyMetadata();
      return normalized;
    };
    const activeCurrency = requireCanonicalStateCurrency(state.activeCurrency);
    if (!['active', 'pending_conversion'].includes(state.status)) return { valid: false };
    const pendingCurrency = state.pendingCurrency === null
      ? null
      : requireCanonicalStateCurrency(state.pendingCurrency);
    const previousCurrency = state.previousCurrency === null
      ? null
      : requireCanonicalStateCurrency(state.previousCurrency);
    if (!Number.isSafeInteger(state.productCount) || state.productCount < 0) return { valid: false };
    if (!Array.isArray(state.productCurrencies)) return { valid: false };
    const productCurrencies = state.productCurrencies.map(requireCanonicalStateCurrency);
    if (new Set(productCurrencies).size !== productCurrencies.length) return { valid: false };
    const counts = state.productCurrencyCounts;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return { valid: false };
    const countEntries = Object.entries(counts).map(([currency, count]) => [
      requireCanonicalStateCurrency(currency),
      count,
    ]);
    if (
      countEntries.some(([, count]) => !Number.isSafeInteger(count) || count <= 0)
      || new Set(countEntries.map(([currency]) => currency)).size !== countEntries.length
      || countEntries.reduce((total, [, count]) => total + BigInt(count), 0n) !== BigInt(state.productCount)
      || productCurrencies.length !== countEntries.length
      || productCurrencies.some(currency => !countEntries.some(([key]) => key === currency))
    ) return { valid: false };

    if (state.status === 'pending_conversion') {
      if (
        !state.hasStore
        || !pendingCurrency
        || !previousCurrency
        || pendingCurrency === previousCurrency
        || activeCurrency !== previousCurrency
        || productCurrencies.some(currency => currency !== previousCurrency)
        || state.canAddProduct
      ) return { valid: false };
    } else if (
      pendingCurrency !== null
      || previousCurrency !== null
      || state.canAddProduct !== state.hasStore
      || productCurrencies.some(currency => currency !== activeCurrency)
    ) return { valid: false };

    if (!state.hasStore && (
      state.productCount !== 0
      || productCurrencies.length !== 0
      || countEntries.length !== 0
    )) return { valid: false };

    return {
      valid: true,
      ...state,
      activeCurrency,
      pendingCurrency,
      previousCurrency,
      productCurrencies,
      productCurrencyCounts: Object.fromEntries(countEntries),
    };
  } catch (_) {
    return { valid: false };
  }
};

export { invalidProductCurrencyMetadata, requireProductCurrency };
