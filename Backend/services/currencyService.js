const axios = require('axios');
const { convertMoneyByRates, roundMoney } = require('./moneyMath');

const CURRENCIES = {
  USD: { symbol: '$', name: 'US Dollar', code: 'USD' },
  PKR: { symbol: 'Rs', name: 'Pakistani Rupee', code: 'PKR' },
  EUR: { symbol: '€', name: 'Euro', code: 'EUR' },
  GBP: { symbol: '£', name: 'British Pound', code: 'GBP' },
};

const FALLBACK_RATES = Object.freeze({ USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 });
const CACHE_DURATION = 60 * 60 * 1000;
const FALLBACK_RETRY_DURATION = 60 * 1000;

let exchangeRatesCache = null;
let lastAttemptTime = 0;
let lastSuccessfulFetchTime = 0;
let exchangeRatesSource = 'fallback';
let exchangeRatesAreFallback = true;
let exchangeRatesFetchPromise = null;

function isSupportedCurrency(currency) {
  const code = String(currency || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

function normalizeCurrency(currency) {
  const code = String(currency || 'USD').trim().toUpperCase();
  return CURRENCIES[code] ? code : 'USD';
}

function normalizeRates(rates) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) return null;
  const normalized = {};
  for (const currency of Object.keys(CURRENCIES)) {
    const raw = rates[currency];
    if (
      raw === null
      || raw === undefined
      || typeof raw === 'boolean'
      || (typeof raw === 'string' && !raw.trim())
      || typeof raw === 'object'
    ) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    normalized[currency] = value;
  }
  if (normalized.USD !== 1) return null;
  return normalized;
}

async function getExchangeRates() {
  const now = Date.now();
  const retryDelay = exchangeRatesAreFallback ? FALLBACK_RETRY_DURATION : CACHE_DURATION;
  if (exchangeRatesCache && now - lastAttemptTime < retryDelay) {
    return exchangeRatesCache;
  }

  // Charts and dashboards can request many currency aggregations at once. All
  // callers must observe one rate table instead of racing separate provider
  // requests that may return slightly different snapshots.
  if (exchangeRatesFetchPromise) return exchangeRatesFetchPromise;

  exchangeRatesFetchPromise = (async () => {
    const attemptTime = Date.now();

    let rates = null;
    let source = null;
    try {
      const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 8000 });
      rates = normalizeRates({
        USD: 1,
        PKR: response.data?.rates?.PKR,
        EUR: response.data?.rates?.EUR,
        GBP: response.data?.rates?.GBP,
      });
      if (rates) source = 'exchangerate-api.com';
    } catch (_) {}

    if (!rates) {
      try {
        const response = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
        rates = normalizeRates({
          USD: 1,
          PKR: response.data?.rates?.PKR,
          EUR: response.data?.rates?.EUR,
          GBP: response.data?.rates?.GBP,
        });
        if (response.data?.result === 'success' && rates) source = 'open.er-api.com';
        else rates = null;
      } catch (_) {}
    }

    // A previously fetched live table is safer than silently replacing it with
    // unrelated hard-coded rates during a temporary provider outage.
    if (rates) {
      exchangeRatesCache = rates;
      exchangeRatesSource = source;
      exchangeRatesAreFallback = false;
      lastSuccessfulFetchTime = attemptTime;
    } else if (!exchangeRatesCache) {
      exchangeRatesCache = { ...FALLBACK_RATES };
      exchangeRatesSource = 'fallback';
      exchangeRatesAreFallback = true;
    } else {
      // Keep the last table available for read-only display, but fail closed for
      // every monetary write as soon as both providers miss a scheduled refresh.
      // The UI can label it stale; checkout/settlement must not call it live.
      exchangeRatesSource = 'stale';
      exchangeRatesAreFallback = true;
    }
    lastAttemptTime = attemptTime;
    return exchangeRatesCache;
  })();

  try {
    return await exchangeRatesFetchPromise;
  } finally {
    exchangeRatesFetchPromise = null;
  }
}

async function getExchangeRateSnapshot() {
  const rates = await getExchangeRates();
  return {
    base: 'USD',
    rates: { ...rates },
    capturedAt: new Date(lastSuccessfulFetchTime || lastAttemptTime || Date.now()).toISOString(),
    source: exchangeRatesSource,
    fallback: exchangeRatesAreFallback,
  };
}

function warmRatesCache() {
  getExchangeRates().catch(() => {});
}

const requireConvertibleAmount = (amount) => {
  if (
    amount === null
    || amount === undefined
    || typeof amount === 'boolean'
    || (typeof amount === 'string' && !amount.trim())
    || typeof amount === 'object'
  ) throw invalidTrustedMoneyAmountError();
  const value = Number(amount);
  if (!Number.isFinite(value)) throw invalidTrustedMoneyAmountError();
  return value;
};

const requireConversionCurrency = (currency) => {
  if (!isSupportedCurrency(currency)) throw unsupportedTrustedCurrencyError();
  return normalizeCurrency(currency);
};

async function convertAmount(amount, fromCurrency = 'USD', toCurrency = 'USD') {
  const value = requireConvertibleAmount(amount);
  const from = requireConversionCurrency(fromCurrency);
  const to = requireConversionCurrency(toCurrency);
  if (from === to) return roundMoney(value);
  const rates = await getExchangeRates();
  return convertAmountWithRates(value, from, to, rates);
}

function exchangeRatesUnavailableError() {
  const error = new Error('Live exchange rates are temporarily unavailable. Please retry shortly.');
  error.statusCode = 503;
  error.code = 'EXCHANGE_RATES_UNAVAILABLE';
  return error;
}

function invalidTrustedMoneyAmountError() {
  const error = new Error('Money amount must be a finite decimal number.');
  error.statusCode = 400;
  error.code = 'MONEY_AMOUNT_INVALID';
  return error;
}

function unsupportedTrustedCurrencyError() {
  const error = new Error('Currency must be one of USD, PKR, EUR, or GBP.');
  error.statusCode = 400;
  error.code = 'UNSUPPORTED_CURRENCY';
  return error;
}

// Use this for writes that permanently change a monetary value. Read-only
// presentation may tolerate a recent cached table, but a product price,
// shipping charge, checkout, refund, or withdrawal must never be saved from
// the hard-coded emergency fallback.
async function convertAmountUsingTrustedRates(
  amount,
  fromCurrency = 'USD',
  toCurrency = 'USD',
  suppliedSnapshot = null,
) {
  const value = requireConvertibleAmount(amount);
  const from = requireConversionCurrency(fromCurrency);
  const to = requireConversionCurrency(toCurrency);
  if (from === to) return roundMoney(value);
  const snapshot = suppliedSnapshot || await getExchangeRateSnapshot();
  if (snapshot?.fallback || !normalizeRates(snapshot?.rates)) {
    throw exchangeRatesUnavailableError();
  }
  return convertAmountWithRates(value, from, to, snapshot.rates);
}

function convertAmountWithRates(amount, fromCurrency = 'USD', toCurrency = 'USD', rates = FALLBACK_RATES) {
  const value = requireConvertibleAmount(amount);
  const from = requireConversionCurrency(fromCurrency);
  const to = requireConversionCurrency(toCurrency);
  if (from === to) return roundMoney(value);
  const normalizedRates = normalizeRates(rates);
  if (!normalizedRates) throw exchangeRatesUnavailableError();
  return convertMoneyByRates(value, normalizedRates[from], normalizedRates[to]);
}

function convertAmountSync(amount, fromCurrency = 'USD', toCurrency = 'USD') {
  const value = requireConvertibleAmount(amount);
  const from = requireConversionCurrency(fromCurrency);
  const to = requireConversionCurrency(toCurrency);
  if (from === to) return roundMoney(value);
  return convertAmountWithRates(value, from, to, exchangeRatesCache || FALLBACK_RATES);
}

async function convertToUSD(amount, fromCurrency = 'USD') {
  return convertAmount(amount, fromCurrency, 'USD');
}

async function convertFromUSD(amount, toCurrency = 'USD') {
  return convertAmount(amount, 'USD', toCurrency);
}

function convertToUSDSync(amount, fromCurrency = 'USD') {
  return convertAmountSync(amount, fromCurrency, 'USD');
}

function convertFromUSDSync(amount, toCurrency = 'USD') {
  return convertAmountSync(amount, 'USD', toCurrency);
}

async function formatMoney(amount, currency = 'USD', { decimals = 2, sourceCurrency = 'USD' } = {}) {
  const code = requireConversionCurrency(currency);
  requireConversionCurrency(sourceCurrency);
  const convertedAmount = await convertAmount(amount, sourceCurrency, code);
  const symbol = CURRENCIES[code].symbol;
  return `${symbol}${convertedAmount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${code === 'USD' ? '' : ` ${code}`}`;
}

function formatMoneySync(amount, currency = 'USD', { decimals = 2, sourceCurrency = 'USD' } = {}) {
  const code = requireConversionCurrency(currency);
  requireConversionCurrency(sourceCurrency);
  const convertedAmount = convertAmountSync(amount, sourceCurrency, code);
  const symbol = CURRENCIES[code].symbol;
  return `${symbol}${convertedAmount.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${code === 'USD' ? '' : ` ${code}`}`;
}

module.exports = {
  CURRENCIES,
  FALLBACK_RATES,
  isSupportedCurrency,
  normalizeCurrency,
  normalizeRates,
  getExchangeRates,
  getExchangeRateSnapshot,
  exchangeRatesUnavailableError,
  invalidTrustedMoneyAmountError,
  unsupportedTrustedCurrencyError,
  warmRatesCache,
  convertAmount,
  convertAmountUsingTrustedRates,
  convertAmountWithRates,
  convertAmountSync,
  convertToUSD,
  convertFromUSD,
  convertToUSDSync,
  convertFromUSDSync,
  formatMoney,
  formatMoneySync,
};
