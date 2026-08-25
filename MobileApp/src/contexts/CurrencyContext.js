import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, NativeModules, Platform } from 'react-native';
import axios from 'axios';
import api, { API_BASE_URL } from '../config/api';
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

const DEFAULT_RATES = {
  USD: 1,
  PKR: 284.6,
  EUR: 0.92,
  GBP: 0.79,
};

const DEVICE_CURRENCY_KEY = 'userCurrency';
const accountCurrencyKey = (accountId) => `accountCurrency:${accountId}`;

const EURO_COUNTRY_CODES = new Set([
  'AD', 'AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR',
  'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MC', 'ME', 'MT', 'NL',
  'PT', 'SI', 'SK', 'SM', 'VA', 'XK',
]);

const GBP_COUNTRY_CODES = new Set(['GB', 'GG', 'IM', 'JE']);

const supportedCurrency = (code) => {
  const normalized = String(code || '').trim().toUpperCase();
  return CURRENCIES[normalized] ? normalized : null;
};

export const currencyForCountry = (countryCode) => {
  const code = String(countryCode || '').trim().toUpperCase();
  if (code === 'PK') return 'PKR';
  if (GBP_COUNTRY_CODES.has(code)) return 'GBP';
  if (EURO_COUNTRY_CODES.has(code)) return 'EUR';
  return code ? 'USD' : null;
};

const countryCodeFromLocale = (locale) => {
  const parts = String(locale || '').replace(/_/g, '-').split('-');
  for (let index = parts.length - 1; index > 0; index -= 1) {
    const part = parts[index].toUpperCase();
    if (/^[A-Z]{2}$/.test(part)) return part;
  }
  return '';
};

const getDeviceCountryCode = () => {
  try {
    const settings = NativeModules.SettingsManager?.settings || {};
    const appleLocale = settings.AppleLocale || settings.AppleLanguages?.[0];
    const nativeLocale = Platform.OS === 'ios'
      ? appleLocale
      : NativeModules.I18nManager?.localeIdentifier;
    const intlLocale = typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : '';
    return countryCodeFromLocale(nativeLocale || intlLocale);
  } catch (_) {
    return '';
  }
};

const normalizeCurrency = (code) => {
  const normalized = String(code || 'USD').trim().toUpperCase();
  return CURRENCIES[normalized] ? normalized : 'USD';
};

export const CurrencyProvider = ({ children }) => {
  const { currentUser, token, isLoading: isAuthLoading } = useAuth();
  const [currency, setCurrencyState] = useState('USD');
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
  const loadSequenceRef = useRef(0);
  const currencyPreferenceRequestRef = useRef(0);
  const currencyPreferenceInFlightRef = useRef(false);
  const ratesRequestRef = useRef({ id: 0, controller: null });
  const ratesClockRef = useRef({ lastAttemptAt: 0, lastLiveAt: 0 });
  const accountId = currentUser?._id || currentUser?.id || null;
  const currencyActorRef = useRef('guest');
  currencyActorRef.current = token && accountId ? `account:${accountId}` : 'guest';

  useEffect(() => {
    fetchExchangeRates();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (
        nextState === 'active'
        && shouldRefreshExchangeRates(ratesClockRef.current)
      ) fetchExchangeRates();
    });
    const refreshTimer = setInterval(() => {
      if (
        AppState.currentState === 'active'
        && shouldRefreshExchangeRates(ratesClockRef.current)
      ) fetchExchangeRates();
    }, 60 * 1000);
    return () => {
      ratesRequestRef.current.id += 1;
      ratesRequestRef.current.controller?.abort();
      subscription.remove();
      clearInterval(refreshTimer);
    };
  }, []);

  useEffect(() => {
    if (isAuthLoading) return undefined;

    currencyPreferenceRequestRef.current += 1;
    currencyPreferenceInFlightRef.current = false;
    setCurrencyPreferenceState({ isSaving: false, error: '' });
    const sequence = ++loadSequenceRef.current;
    setIsLoading(true);
    loadSavedCurrency({
      accountId,
      accountCurrency: currentUser?.currency,
      hasToken: Boolean(token),
      sequence,
    });

    return () => {
      if (loadSequenceRef.current === sequence) {
        loadSequenceRef.current += 1;
      }
    };
  }, [accountId, currentUser?.currency, isAuthLoading, token]);

  const loadSavedCurrency = async ({
    accountId: activeAccountId,
    accountCurrency: currentAccountCurrency,
    hasToken,
    sequence,
  }) => {
    try {
      const deviceCurrency = supportedCurrency(
        await AsyncStorage.getItem(DEVICE_CURRENCY_KEY)
      );
      const cachedAccountCurrency = activeAccountId
        ? supportedCurrency(
          await AsyncStorage.getItem(accountCurrencyKey(activeAccountId))
        )
        : null;

      if (hasToken && activeAccountId) {
        let serverAccountCurrency = supportedCurrency(currentAccountCurrency);
        try {
          const res = await api.get('/api/user/single');
          serverAccountCurrency = supportedCurrency(res.data?.user?.currency)
            || serverAccountCurrency;
        } catch (_) {}

        // A signed-in account's server preference is authoritative, including
        // USD. Otherwise a seller who explicitly selected USD could sign in on
        // a Pakistan-locale device and have the account (and future product
        // price currency) silently changed to PKR.
        const intentionalAccountCurrency = serverAccountCurrency || cachedAccountCurrency;

        if (intentionalAccountCurrency) {
          if (loadSequenceRef.current !== sequence) return;
          setCurrencyState(intentionalAccountCurrency);
          await AsyncStorage.setItem(
            accountCurrencyKey(activeAccountId),
            intentionalAccountCurrency
          );
          return;
        }

        // Never promote the guest/device preference into an authenticated
        // account. User.currency is server-defaulted to USD; when both the
        // server lookup and account cache are unavailable, USD is the only
        // fail-closed display choice until account state refreshes.
        if (loadSequenceRef.current !== sequence) return;
        setCurrencyState('USD');
        return;
      }

      // Device currency belongs to the guest/device session. Account choices
      // are cached separately so signing out cannot leak another user's choice.
      if (deviceCurrency) {
        if (loadSequenceRef.current !== sequence) return;
        setCurrencyState(deviceCurrency);
        return;
      }

      let detectedCurrency = null;
      try {
        const detection = await axios.get(`${API_BASE_URL}/api/currency/detect`, {
          timeout: 8000,
        });
        if (detection.data?.success && detection.data?.detected) {
          detectedCurrency = supportedCurrency(detection.data.currency)
            || currencyForCountry(detection.data.country);
        }
      } catch (_) {}

      // IP detection can be unavailable in development or offline. Locale is
      // only a fallback; it never replaces an account or saved preference.
      detectedCurrency = detectedCurrency || currencyForCountry(getDeviceCountryCode());

      if (detectedCurrency) {
        if (loadSequenceRef.current !== sequence) return;
        setCurrencyState(detectedCurrency);
        await AsyncStorage.setItem(DEVICE_CURRENCY_KEY, detectedCurrency);

        // Detection is only a display default. Never overwrite an authenticated
        // account preference after a failed/ambiguous account lookup; only an
        // explicit selector action is allowed to persist a new account value.
      }
    } catch (error) {
      console.error('Error loading saved currency:', error);
    } finally {
      if (loadSequenceRef.current === sequence) {
        setIsLoading(false);
      }
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
      const res = await api.get('/api/currency/rates', { signal: controller.signal });
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
      setExchangeRateState((previous) => ({
        ...previous,
        isLoading: false,
        fallback: true,
        source: 'unavailable',
        error: error.response?.data?.msg || error.message || 'Live exchange rates are temporarily unavailable.',
      }));
    }
  };

  const setCurrency = async (newCurrency) => {
    const targetCurrency = supportedCurrency(newCurrency);
    if (!targetCurrency) return false;
    if (targetCurrency === currency) return true;
    if (currencyPreferenceInFlightRef.current) return false;

    currencyPreferenceInFlightRef.current = true;
    const requestId = currencyPreferenceRequestRef.current + 1;
    currencyPreferenceRequestRef.current = requestId;
    const actorKey = currencyActorRef.current;
    const activeAccountId = accountId;
    loadSequenceRef.current += 1;
    setIsLoading(false);
    setCurrencyPreferenceState({ isSaving: true, error: '' });
    try {
      // Keep the signed-in account authoritative across web and mobile. A
      // failed write must not create an optimistic device-only preference.
      if (token && activeAccountId) {
        await api.patch('/api/currency/update', { currency: targetCurrency });
        if (
          currencyPreferenceRequestRef.current !== requestId
          || currencyActorRef.current !== actorKey
        ) return false;
        try {
          await AsyncStorage.setItem(accountCurrencyKey(activeAccountId), targetCurrency);
        } catch (_) {}
      } else {
        await AsyncStorage.setItem(DEVICE_CURRENCY_KEY, targetCurrency);
      }
      if (
        currencyPreferenceRequestRef.current !== requestId
        || currencyActorRef.current !== actorKey
      ) return false;
      setCurrencyState(targetCurrency);
      currencyPreferenceInFlightRef.current = false;
      setCurrencyPreferenceState({ isSaving: false, error: '' });
      return true;
    } catch (error) {
      const message = error.response?.data?.msg || 'Currency preference could not be saved.';
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

  const convertAmountForMoneyAction = (amount, sourceCurrency = 'USD', targetCurrency = currency) => {
    const source = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
    const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
    assertSafeCurrencyConversion(source, target, {
      ratesFallback: exchangeRateState.fallback,
      ratesLoading: exchangeRateState.isLoading,
    });
    return convertAmount(amount, source, target);
  };

  const convertPrice = (price, sourceCurrency = 'USD') => {
    return convertAmount(price, sourceCurrency, currency);
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

  const formatPrice = (price, options = {}) => {
    const {
      sourceCurrency = 'USD',
      targetCurrency = currency,
      ...formatOptions
    } = options;

    const source = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
    const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
    const convertedPrice = convertAmount(price, source, target);
    const formatted = formatAmount(convertedPrice, { ...formatOptions, targetCurrency: target });
    const isApproximate = source !== target
      && (exchangeRateState.isLoading || exchangeRateState.fallback);
    return `${isApproximate ? '≈' : ''}${formatted}`;
  };

  const convertToUSD = (priceInCurrentCurrency) => {
    return convertAmount(priceInCurrentCurrency, currency, 'USD');
  };

  const convertFromCurrency = (amount, fromCurrency = 'USD') => {
    return convertAmount(amount, fromCurrency, currency);
  };

  const canConvertCurrency = (sourceCurrency, targetCurrency = currency) => {
    try {
      const source = presentationCurrencyOrFallback(sourceCurrency, 'USD', 'source currency');
      const target = presentationCurrencyOrFallback(targetCurrency, currency, 'target currency');
      return canSafelyConvertCurrency(source, target, {
        ratesFallback: exchangeRateState.fallback,
        ratesLoading: exchangeRateState.isLoading,
      });
    } catch (_) {
      return false;
    }
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

  const value = useMemo(() => ({
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
    setCurrency,
    changeCurrency: setCurrency,
    normalizeCurrency,
    convertAmount,
    convertLineAmount,
    convertLineAmounts,
    convertAmountForMoneyAction,
    convertPrice,
    formatPrice,
    formatAmount,
    formatProductPrice,
    getProductPriceNumber,
    getProductCurrency,
    getOrderItemPriceNumber,
    formatOrderItemPrice,
    convertToUSD,
    convertFromCurrency,
    getCurrencySymbol: () => CURRENCIES[currency]?.symbol || '$',
    getCurrencyName: () => CURRENCIES[currency]?.name || 'US Dollar',
  }), [currency, currencyPreferenceState, exchangeRates, exchangeRateState, isLoading]);

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
};

export default CurrencyContext;
