import { createContext, useContext, useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { getAuthToken } from "../utils/cookieHelper";
import { useAuth } from './AuthContext';
import {
  assertSafeCurrencyConversion,
  canSafelyConvertCurrency,
  convertCurrencyAmount,
  convertCurrencyLineAmount,
  convertCurrencyLineAmounts,
  normalizeCompleteExchangeRates,
  roundCurrencyAmount,
  shouldRefreshExchangeRates,
} from '../utils/currencySafety';

const CurrencyContext = createContext();

export const useCurrency = () => {
  const context = useContext(CurrencyContext);
  if (!context) {
    throw new Error('useCurrency must be used within CurrencyProvider');
  }
  return context;
};

const CURRENCIES = {
  USD: { symbol: '$', name: 'US Dollar', code: 'USD', position: 'before' },
  PKR: { symbol: 'Rs', name: 'Pakistani Rupee', code: 'PKR', position: 'before' },
  EUR: { symbol: '€', name: 'Euro', code: 'EUR', position: 'before' },
  GBP: { symbol: '£', name: 'British Pound', code: 'GBP', position: 'before' },
};

const hasOwn = (value, field) => (
  Boolean(value)
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, field)
);

export const presentationIntegrityError = (
  label,
  code = 'CURRENCY_PRESENTATION_DATA_INVALID'
) => {
  const error = new Error(`The stored ${label} is invalid.`);
  error.code = code;
  error.statusCode = 409;
  return error;
};

export const requireExactPresentationMoney = (
  value,
  label = 'money amount',
  code = 'CURRENCY_PRESENTATION_DATA_INVALID'
) => {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || roundCurrencyAmount(value) !== value
  ) {
    throw presentationIntegrityError(label, code);
  }
  return value;
};

export const requireCanonicalPresentationCurrency = (
  value,
  label = 'currency',
  code = 'CURRENCY_PRESENTATION_DATA_INVALID'
) => {
  if (
    typeof value !== 'string'
    || value !== value.trim().toUpperCase()
    || !Object.prototype.hasOwnProperty.call(CURRENCIES, value)
  ) {
    throw presentationIntegrityError(label, code);
  }
  return value;
};

const presentationCurrencyOrFallback = (
  value,
  fallback,
  label,
  code = 'CURRENCY_PRESENTATION_DATA_INVALID'
) => requireCanonicalPresentationCurrency(
  value === null || value === undefined ? fallback : value,
  label,
  code
);

const resolveCurrencyFields = (
  record,
  fields,
  fallback,
  {
    label = 'currency metadata',
    code = 'CURRENCY_PRESENTATION_DATA_INVALID',
    nullIsLegacy = false,
  } = {}
) => {
  const values = fields
    .filter((field) => hasOwn(record, field))
    .map((field) => record[field])
    .filter((value) => value !== undefined && (!nullIsLegacy || value !== null))
    .map((value) => requireCanonicalPresentationCurrency(value, label, code));
  const unique = [...new Set(values)];
  if (unique.length > 1) throw presentationIntegrityError(label, code);
  return unique[0] || requireCanonicalPresentationCurrency(fallback, label, code);
};

const resolveOptionalMoneyFields = (record, fields, label, code) => {
  const values = fields
    .filter((field) => hasOwn(record, field))
    .map((field) => record[field])
    .filter((value) => value !== null && value !== undefined)
    .map((value) => requireExactPresentationMoney(value, label, code));
  const unique = [...new Set(values)];
  if (unique.length > 1) throw presentationIntegrityError(label, code);
  return unique.length ? unique[0] : null;
};

export const resolveProductPresentationCurrency = (product) => resolveCurrencyFields(
  product,
  ['currency', 'priceCurrency'],
  'USD',
  {
    label: 'product currency metadata',
    code: 'PRODUCT_CURRENCY_METADATA_INVALID',
  }
);

export const resolveProductPresentationMoney = (product, field = 'price') => {
  const code = 'PRODUCT_PRICE_INVALID';
  if (!product || typeof product !== 'object') {
    throw presentationIntegrityError('product price', code);
  }
  if (field !== 'price' && field !== 'discountedPrice') {
    throw presentationIntegrityError('product price field', code);
  }

  const currentValue = product[field];
  if (currentValue !== null && currentValue !== undefined) {
    return requireExactPresentationMoney(currentValue, `product ${field}`, code);
  }

  const legacyField = field === 'discountedPrice'
    ? 'discountedPriceOriginal'
    : 'priceOriginal';
  const legacyValue = product[legacyField];
  if (legacyValue !== null && legacyValue !== undefined) {
    return requireExactPresentationMoney(legacyValue, `legacy product ${field}`, code);
  }

  // A genuinely absent legacy discount means no discount. A base price must
  // be explicitly present (zero remains a valid stored price).
  if (field === 'discountedPrice') return 0;
  throw presentationIntegrityError('product price', code);
};

const resolveOrderItemCurrency = (item, orderCurrency) => resolveCurrencyFields(
  item,
  ['currency', 'orderCurrency'],
  orderCurrency,
  {
    label: 'order item currency metadata',
    code: 'ORDER_PRESENTATION_DATA_INVALID',
    nullIsLegacy: true,
  }
);

export const resolveOrderItemPresentationMoney = (item, orderCurrency = 'USD') => {
  const code = 'ORDER_PRESENTATION_DATA_INVALID';
  if (!item || typeof item !== 'object') {
    throw presentationIntegrityError('order item price', code);
  }
  const fallbackCurrency = presentationCurrencyOrFallback(
    orderCurrency,
    'USD',
    'order currency',
    code
  );

  if (item.price !== null && item.price !== undefined) {
    return {
      amount: requireExactPresentationMoney(item.price, 'order item price', code),
      sourceCurrency: resolveOrderItemCurrency(item, fallbackCurrency),
    };
  }

  const sourceAmount = resolveOptionalMoneyFields(
    item,
    ['sourcePrice', 'priceOriginal'],
    'legacy order item source price',
    code
  );
  if (sourceAmount === null) throw presentationIntegrityError('order item price', code);

  return {
    amount: sourceAmount,
    sourceCurrency: resolveCurrencyFields(
      item,
      ['sourceCurrency', 'priceCurrency'],
      fallbackCurrency,
      {
        label: 'order item source currency metadata',
        code,
        nullIsLegacy: true,
      }
    ),
  };
};

const DEFAULT_RATES = { USD: 1, PKR: 284.6, EUR: 0.92, GBP: 0.79 };
const DEVICE_CURRENCY_KEY = 'userCurrency';
const accountCurrencyKey = (accountId) => `accountCurrency:${accountId}`;

const normalizeCurrency = (code) => {
  const normalized = String(code || 'USD').trim().toUpperCase();
  return CURRENCIES[normalized] ? normalized : 'USD';
};

export const CurrencyProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [currency, setCurrency] = useState('USD');
  const [exchangeRates, setExchangeRates] = useState(DEFAULT_RATES);
  const [exchangeRateState, setExchangeRateState] = useState({
    isLoading: true,
    fallback: true,
    source: 'initial',
    lastUpdate: null,
    error: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [currencyPreferenceState, setCurrencyPreferenceState] = useState({
    isSaving: false,
    error: '',
  });
  const currencyLoadRef = useRef(0);
  const currencyPreferenceRequestRef = useRef(0);
  const currencyPreferenceInFlightRef = useRef(false);
  const ratesRequestRef = useRef({ id: 0, controller: null });
  const ratesClockRef = useRef({ lastAttemptAt: 0, lastLiveAt: 0 });
  const accountId = currentUser?._id || currentUser?.id || null;
  const currencyActorRef = useRef('guest');
  currencyActorRef.current = accountId ? `account:${accountId}` : 'guest';

  useEffect(() => {
    fetchExchangeRates();
    const refreshIfStale = () => {
      if (shouldRefreshExchangeRates(ratesClockRef.current)) fetchExchangeRates();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfStale();
    };
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', handleVisibility);
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshIfStale();
    }, 60 * 1000);
    return () => {
      ratesRequestRef.current.id += 1;
      ratesRequestRef.current.controller?.abort();
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    currencyPreferenceRequestRef.current += 1;
    currencyPreferenceInFlightRef.current = false;
    setCurrencyPreferenceState({ isSaving: false, error: '' });
    const sequence = currencyLoadRef.current + 1;
    currencyLoadRef.current = sequence;
    setIsLoading(true);
    detectAndSetCurrency(sequence, {
      accountId,
      accountCurrency: currentUser?.currency,
      hasToken: Boolean(getAuthToken()),
    });
    return () => {
      if (currencyLoadRef.current === sequence) currencyLoadRef.current += 1;
    };
  }, [accountId, currentUser?.currency]);

  const detectAndSetCurrency = async (sequence, {
    accountId: activeAccountId,
    accountCurrency,
    hasToken,
  }) => {
    try {
      const savedCurrency = localStorage.getItem(DEVICE_CURRENCY_KEY);
      const cachedAccountCurrency = activeAccountId
        ? localStorage.getItem(accountCurrencyKey(activeAccountId))
        : null;
      if (hasToken && activeAccountId) {
        let serverCurrency = null;
        try {
          const userRes = await axios.get(`${import.meta.env.VITE_API_URL}api/user/single`, {
            headers: { Authorization: `Bearer ${getAuthToken()}` },
          });
          serverCurrency = userRes.data?.user?.currency;
        } catch {
          console.warn('Could not refresh account currency; using the account-scoped cached preference.');
        }

        const intentionalAccountCurrency = [serverCurrency, accountCurrency, cachedAccountCurrency]
          .map((value) => String(value || '').trim().toUpperCase())
          .find((value) => CURRENCIES[value]);
        // For an authenticated account, the server/account value is
        // authoritative, including USD. Keep it separate from the guest device
        // choice so account switches cannot leak currencies into seller prices.
        if (intentionalAccountCurrency) {
          if (currencyLoadRef.current !== sequence) return;
          setCurrency(intentionalAccountCurrency);
          try {
            localStorage.setItem(accountCurrencyKey(activeAccountId), intentionalAccountCurrency);
          } catch {
            // The account-scoped cache is best-effort; the server value remains authoritative.
          }
          return;
        }

        // Never borrow the guest/device preference for an authenticated
        // account. User.currency is server-defaulted to USD, so if both the
        // authoritative lookup and account-scoped cache are unavailable, USD
        // is the only fail-closed display choice until account state refreshes.
        if (currencyLoadRef.current !== sequence) return;
        setCurrency('USD');
        return;
      }

      if (savedCurrency && CURRENCIES[savedCurrency]) {
        if (currencyLoadRef.current !== sequence) return;
        setCurrency(savedCurrency);
        setIsLoading(false);
        return;
      }

      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/currency/detect`);
      if (res.data.success && res.data.detected) {
        const detectedCurrency = normalizeCurrency(res.data.currency);
        if (currencyLoadRef.current !== sequence) return;
        setCurrency(detectedCurrency);
        localStorage.setItem(DEVICE_CURRENCY_KEY, detectedCurrency);
      }
    } catch (error) {
      console.error('Currency detection error:', error);
    } finally {
      if (currencyLoadRef.current === sequence) setIsLoading(false);
    }
  };

  const fetchExchangeRates = async () => {
    ratesClockRef.current.lastAttemptAt = Date.now();
    const requestId = ratesRequestRef.current.id + 1;
    ratesRequestRef.current.controller?.abort();
    const controller = new AbortController();
    ratesRequestRef.current = { id: requestId, controller };
    setExchangeRateState((previous) => ({ ...previous, isLoading: true, error: '' }));

    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/currency/rates`, {
        signal: controller.signal,
      });
      if (ratesRequestRef.current.id !== requestId) return;
      const nextRates = res.data?.success === true
        ? normalizeCompleteExchangeRates(res.data?.rates)
        : null;
      if (!nextRates) {
        throw new Error('Exchange-rate response was incomplete.');
      }

      setExchangeRates({ ...DEFAULT_RATES, ...nextRates });
      ratesClockRef.current.lastLiveAt = res.data.fallback === false ? Date.now() : 0;
      setExchangeRateState({
        isLoading: false,
        fallback: res.data.fallback !== false,
        source: res.data.source || (res.data.fallback === false ? 'live' : 'fallback'),
        lastUpdate: res.data.lastUpdate || null,
        error: res.data.fallback === false ? '' : 'Live exchange rates are temporarily unavailable.',
      });
    } catch (error) {
      if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') return;
      if (ratesRequestRef.current.id !== requestId) return;
      ratesClockRef.current.lastLiveAt = 0;
      console.error('Exchange rates fetch error:', error);
      setExchangeRateState((previous) => ({
        ...previous,
        isLoading: false,
        fallback: true,
        source: 'unavailable',
        error: error.response?.data?.msg || error.message || 'Live exchange rates are temporarily unavailable.',
      }));
    }
  };

  const changeCurrency = async (newCurrency) => {
    const targetCurrency = String(newCurrency || '').trim().toUpperCase();
    if (!CURRENCIES[targetCurrency]) return false;
    if (targetCurrency === currency) return true;
    if (currencyPreferenceInFlightRef.current) return false;

    currencyPreferenceInFlightRef.current = true;
    const requestId = currencyPreferenceRequestRef.current + 1;
    currencyPreferenceRequestRef.current = requestId;
    const actorKey = currencyActorRef.current;
    const activeAccountId = accountId;
    currencyLoadRef.current += 1;
    setIsLoading(false);
    const token = getAuthToken();
    setCurrencyPreferenceState({ isSaving: true, error: '' });
    try {
      // Authenticated preferences are server-authoritative. Commit there first
      // so an offline/failed PATCH cannot leave this device displaying a value
      // that the next web or mobile session immediately contradicts.
      if (token) {
        await axios.patch(
          `${import.meta.env.VITE_API_URL}api/currency/update`,
          { currency: targetCurrency },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      }
      if (
        currencyPreferenceRequestRef.current !== requestId
        || currencyActorRef.current !== actorKey
      ) return false;
      setCurrency(targetCurrency);
      try {
        localStorage.setItem(
          token && activeAccountId ? accountCurrencyKey(activeAccountId) : DEVICE_CURRENCY_KEY,
          targetCurrency
        );
      } catch (storageError) {
        // The authenticated server preference has already committed and is
        // authoritative. A cache failure must not roll the UI back to a stale
        // currency; guests still need durable storage before accepting a new
        // device preference.
        if (!(token && activeAccountId)) throw storageError;
      }
      if (
        currencyPreferenceRequestRef.current !== requestId
        || currencyActorRef.current !== actorKey
      ) return false;
      currencyPreferenceInFlightRef.current = false;
      setCurrencyPreferenceState({ isSaving: false, error: '' });
      return true;
    } catch (error) {
      const message = error.response?.data?.msg || 'Currency preference could not be saved.';
      console.error('Failed to save currency preference:', error);
      if (
        currencyPreferenceRequestRef.current === requestId
        && currencyActorRef.current === actorKey
      ) {
        currencyPreferenceInFlightRef.current = false;
        setCurrencyPreferenceState({ isSaving: false, error: message });
      }
      return false;
    }
  };

  const convertAmount = (amount, sourceCurrency = 'USD', targetCurrency = currency) => {
    const value = requireExactPresentationMoney(amount);
    const from = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
    const to = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
    return convertCurrencyAmount(value, from, to, exchangeRates);
  };

  const convertLineAmount = (
    unitAmount,
    quantity,
    sourceCurrency = 'USD',
    targetCurrency = currency
  ) => {
    const value = requireExactPresentationMoney(unitAmount, 'line unit amount');
    if (!Number.isSafeInteger(quantity) || quantity < 0) {
      throw presentationIntegrityError('line quantity');
    }
    return convertCurrencyLineAmount(
      value,
      quantity,
      presentationCurrencyOrFallback(sourceCurrency, 'USD', 'line source currency'),
      presentationCurrencyOrFallback(targetCurrency, currency, 'line target currency'),
      exchangeRates
    );
  };

  const convertLineAmounts = (lines, targetCurrency = currency) => {
    if (!Array.isArray(lines)) throw presentationIntegrityError('currency lines');
    const target = presentationCurrencyOrFallback(
      targetCurrency,
      currency,
      'line target currency'
    );
    const strictLines = lines.map((line) => {
      if (!line || typeof line !== 'object') throw presentationIntegrityError('currency line');
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) {
        throw presentationIntegrityError('line quantity');
      }
      return {
        ...line,
        unitAmount: requireExactPresentationMoney(line.unitAmount, 'line unit amount'),
        sourceCurrency: presentationCurrencyOrFallback(
          line.sourceCurrency,
          'USD',
          'line source currency'
        ),
      };
    });
    return convertCurrencyLineAmounts(strictLines, target, exchangeRates);
  };

  const convertPrice = (price, sourceCurrency = 'USD') => {
    return convertAmount(price, sourceCurrency, currency);
  };

  const formatPrice = (price, options = {}) => {
    const {
      showSymbol = true,
      decimals = 2,
      showCode = false,
      sourceCurrency = 'USD',
      targetCurrency = currency,
    } = options;

    const source = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
    const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
    const convertedPrice = convertAmount(price, source, target);
    const currencyInfo = CURRENCIES[target];
    const isApproximate = source !== target
      && (exchangeRateState.isLoading || exchangeRateState.fallback);

    const formattedNumber = convertedPrice.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });

    if (!showSymbol) return `${isApproximate ? '≈' : ''}${formattedNumber}`;

    const code = showCode ? ` ${target}` : '';
    return `${isApproximate ? '≈' : ''}${currencyInfo.symbol}${formattedNumber}${code}`;
  };

  const convertToUSD = (priceInCurrentCurrency) => {
    return convertAmount(priceInCurrentCurrency, currency, 'USD');
  };

  const convertFromCurrency = (amount, fromCurrency = 'USD') => {
    return convertAmount(amount, fromCurrency, currency);
  };

  const convertAmountForMoneyAction = (amount, sourceCurrency = 'USD', targetCurrency = currency) => {
    const source = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
    const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
    assertSafeCurrencyConversion(source, target, {
      ratesFallback: exchangeRateState.fallback,
      ratesLoading: exchangeRateState.isLoading,
    });
    return convertAmount(amount, source, target);
  };

  const canConvertCurrency = (sourceCurrency, targetCurrency = currency) => {
    try {
      const source = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
      const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
      return canSafelyConvertCurrency(source, target, {
        ratesFallback: exchangeRateState.fallback,
        ratesLoading: exchangeRateState.isLoading,
      });
    } catch {
      return false;
    }
  };

  const formatAmount = (amount, options = {}) => {
    const {
      showSymbol = true,
      decimals = 2,
      showCode = false,
      targetCurrency = currency,
    } = options;
    const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
    const value = requireExactPresentationMoney(amount);
    const formattedNumber = value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    if (!showSymbol) return formattedNumber;
    const code = showCode ? ` ${target}` : '';
    return `${CURRENCIES[target].symbol}${formattedNumber}${code}`;
  };

  const getProductCurrency = (product) => resolveProductPresentationCurrency(product);

  const getProductPriceNumber = (product, field = 'price') => {
    return convertAmount(
      resolveProductPresentationMoney(product, field),
      getProductCurrency(product),
      currency
    );
  };

  const formatProductPrice = (product, amountOrOptions = undefined, maybeOptions = {}) => {
    const hasExplicitAmount = amountOrOptions !== undefined
      && amountOrOptions !== null
      && typeof amountOrOptions !== 'object';
    const options = hasExplicitAmount ? maybeOptions : (amountOrOptions || {});
    const field = options.field || 'price';
    const sourceAmount = hasExplicitAmount
      ? amountOrOptions
      : resolveProductPresentationMoney(product, field);
    return formatPrice(sourceAmount, {
      ...options,
      sourceCurrency: getProductCurrency(product),
    });
  };

  const getOrderItemPriceNumber = (item, orderCurrency = 'USD') => {
    const { amount, sourceCurrency } = resolveOrderItemPresentationMoney(item, orderCurrency);
    return convertAmount(amount, sourceCurrency, currency);
  };

  const formatOrderItemPrice = (item, options = {}) => {
    const { amount, sourceCurrency } = resolveOrderItemPresentationMoney(
      item,
      options.orderCurrency
    );
    return formatPrice(amount, {
      ...options,
      sourceCurrency,
    });
  };

  // These helpers intentionally close over the latest currency, rates, and
  // account. Building the value directly prevents stale money helpers when an
  // auth/currency input changes without changing the previous memo deps.
  const value = {
    currency,
    currencies: CURRENCIES,
    exchangeRates,
    exchangeRatesLoading: exchangeRateState.isLoading,
    exchangeRatesFallback: exchangeRateState.fallback,
    exchangeRatesSource: exchangeRateState.source,
    exchangeRatesLastUpdate: exchangeRateState.lastUpdate,
    exchangeRatesError: exchangeRateState.error,
    currencyPreferenceSaving: currencyPreferenceState.isSaving,
    currencyPreferenceError: currencyPreferenceState.error,
    hasTrustedExchangeRates: !exchangeRateState.fallback && !exchangeRateState.isLoading,
    canConvertCurrency,
    refreshExchangeRates: fetchExchangeRates,
    isLoading,
    changeCurrency,
    normalizeCurrency,
    convertAmount,
    convertLineAmount,
    convertLineAmounts,
    convertAmountForMoneyAction,
    convertPrice,
    formatPrice,
    formatProductPrice,
    getProductPriceNumber,
    formatAmount,
    convertFromCurrency,
    getOrderItemPriceNumber,
    formatOrderItemPrice,
    getProductCurrency,
    convertToUSD,
    getCurrencySymbol: () => CURRENCIES[currency].symbol,
    getCurrencyName: () => CURRENCIES[currency].name,
  };

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
};
