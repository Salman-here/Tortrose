'use strict';

const SUPPORTED_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);

export const canonicalProductCurrency = value => (
  typeof value === 'string'
  && value === value.trim().toUpperCase()
  && SUPPORTED_CURRENCIES.has(value)
    ? value
    : null
);

const invalidState = () => ({
  valid: false,
  activeCurrency: null,
  pendingCurrency: null,
  previousCurrency: null,
  productCurrencies: [],
  productCurrencyCounts: {},
});

export const inspectSellerProductCurrencyState = (state) => {
  try {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return invalidState();
    if (typeof state.hasStore !== 'boolean' || typeof state.canAddProduct !== 'boolean') return invalidState();
    const activeCurrency = canonicalProductCurrency(state.activeCurrency);
    if (!activeCurrency || !['active', 'pending_conversion'].includes(state.status)) return invalidState();
    const pendingCurrency = state.pendingCurrency === null
      ? null
      : canonicalProductCurrency(state.pendingCurrency);
    const previousCurrency = state.previousCurrency === null
      ? null
      : canonicalProductCurrency(state.previousCurrency);
    if (
      (state.pendingCurrency !== null && !pendingCurrency)
      || (state.previousCurrency !== null && !previousCurrency)
      || !Number.isSafeInteger(state.productCount)
      || state.productCount < 0
      || !Array.isArray(state.productCurrencies)
    ) return invalidState();

    const productCurrencies = state.productCurrencies.map(canonicalProductCurrency);
    if (productCurrencies.some(currency => !currency) || new Set(productCurrencies).size !== productCurrencies.length) {
      return invalidState();
    }
    const counts = state.productCurrencyCounts;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return invalidState();
    const countEntries = Object.entries(counts).map(([currency, count]) => [
      canonicalProductCurrency(currency),
      count,
    ]);
    if (
      countEntries.some(([currency, count]) => !currency || !Number.isSafeInteger(count) || count <= 0)
      || new Set(countEntries.map(([currency]) => currency)).size !== countEntries.length
      || countEntries.reduce((total, [, count]) => total + BigInt(count), 0n) !== BigInt(state.productCount)
      || productCurrencies.length !== countEntries.length
      || productCurrencies.some(currency => !countEntries.some(([key]) => key === currency))
    ) return invalidState();

    if (state.status === 'pending_conversion') {
      if (
        !state.hasStore
        || !pendingCurrency
        || !previousCurrency
        || pendingCurrency === previousCurrency
        || activeCurrency !== previousCurrency
        || productCurrencies.some(currency => currency !== previousCurrency)
        || state.canAddProduct
      ) return invalidState();
    } else if (
      pendingCurrency !== null
      || previousCurrency !== null
      || state.canAddProduct !== state.hasStore
      || productCurrencies.some(currency => currency !== activeCurrency)
    ) return invalidState();

    if (!state.hasStore && (
      state.productCount !== 0
      || productCurrencies.length !== 0
      || countEntries.length !== 0
    )) return invalidState();

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
    return invalidState();
  }
};
