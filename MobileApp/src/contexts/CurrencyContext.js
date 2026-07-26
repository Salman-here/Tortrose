import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';
import axios from 'axios';
import api, { API_BASE_URL } from '../config/api';
import { useAuth } from './AuthContext';

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
  EUR: { symbol: 'EUR', name: 'Euro', code: 'EUR', position: 'before' },
  GBP: { symbol: 'GBP', name: 'British Pound', code: 'GBP', position: 'before' },
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

const roundMoney = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

export const CurrencyProvider = ({ children }) => {
  const { currentUser, token, isLoading: isAuthLoading } = useAuth();
  const [currency, setCurrencyState] = useState('USD');
  const [exchangeRates, setExchangeRates] = useState(DEFAULT_RATES);
  const [isLoading, setIsLoading] = useState(true);
  const loadSequenceRef = useRef(0);
  const accountId = currentUser?._id || currentUser?.id || null;

  useEffect(() => {
    fetchExchangeRates();
  }, []);

  useEffect(() => {
    if (isAuthLoading) return undefined;

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

        // A bare server-side USD value is the account schema default. Only a
        // non-default value, or an account-specific cached USD selection, is
        // proof of an intentional account preference.
        const intentionalAccountCurrency = serverAccountCurrency
          && serverAccountCurrency !== 'USD'
          ? serverAccountCurrency
          : cachedAccountCurrency;

        if (intentionalAccountCurrency) {
          if (loadSequenceRef.current !== sequence) return;
          setCurrencyState(intentionalAccountCurrency);
          await AsyncStorage.setItem(
            accountCurrencyKey(activeAccountId),
            intentionalAccountCurrency
          );
          return;
        }

        if (deviceCurrency) {
          if (loadSequenceRef.current !== sequence) return;
          setCurrencyState(deviceCurrency);
          await AsyncStorage.setItem(
            accountCurrencyKey(activeAccountId),
            deviceCurrency
          );
          api.patch('/api/currency/update', { currency: deviceCurrency }).catch(() => {});
          return;
        }
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

        if (hasToken && activeAccountId) {
          await AsyncStorage.setItem(
            accountCurrencyKey(activeAccountId),
            detectedCurrency
          );
          api.patch('/api/currency/update', { currency: detectedCurrency }).catch(() => {});
        }
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
    try {
      const res = await api.get('/api/currency/rates');
      if (res.data.success && res.data.rates) {
        setExchangeRates({ ...DEFAULT_RATES, ...res.data.rates });
      }
    } catch (_) {
      setExchangeRates(DEFAULT_RATES);
    }
  };

  const setCurrency = async (newCurrency) => {
    const targetCurrency = normalizeCurrency(newCurrency);
    loadSequenceRef.current += 1;
    setIsLoading(false);
    setCurrencyState(targetCurrency);

    if (token && accountId) {
      await AsyncStorage.setItem(accountCurrencyKey(accountId), targetCurrency);
      try {
        await api.patch('/api/currency/update', { currency: targetCurrency });
      } catch (_) {}
      return;
    }

    await AsyncStorage.setItem(DEVICE_CURRENCY_KEY, targetCurrency);
  };

  const convertAmount = (amount, sourceCurrency = 'USD', targetCurrency = currency) => {
    const value = Number(amount || 0);
    if (!Number.isFinite(value)) return 0;

    const from = normalizeCurrency(sourceCurrency);
    const to = normalizeCurrency(targetCurrency);
    if (from === to) return roundMoney(value);

    const fromRate = Number(exchangeRates[from]) || 1;
    const toRate = Number(exchangeRates[to]) || 1;
    return roundMoney((value / fromRate) * toRate);
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

    const target = normalizeCurrency(targetCurrency);
    const value = Number(amount || 0);
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

    const target = normalizeCurrency(targetCurrency);
    const convertedPrice = convertAmount(price, sourceCurrency, target);
    return formatAmount(convertedPrice, { ...formatOptions, targetCurrency: target });
  };

  const convertToUSD = (priceInCurrentCurrency) => {
    return convertAmount(priceInCurrentCurrency, currency, 'USD');
  };

  const convertFromCurrency = (amount, fromCurrency = 'USD') => {
    return convertAmount(amount, fromCurrency, currency);
  };

  const getProductCurrency = (product) => normalizeCurrency(product?.currency || product?.priceCurrency || 'USD');

  const getProductPriceNumber = (product, field = 'price') => {
    if (!product) return 0;
    const productCurrency = getProductCurrency(product);
    const rawValue = Number(product[field]);
    if (Number.isFinite(rawValue)) return convertAmount(rawValue, productCurrency, currency);

    const legacyField = field === 'discountedPrice' ? 'discountedPriceOriginal' : 'priceOriginal';
    const legacyValue = Number(product[legacyField]);
    return Number.isFinite(legacyValue)
      ? convertAmount(legacyValue, productCurrency, currency)
      : 0;
  };

  const formatProductPrice = (product, amountOrOptions = undefined, maybeOptions = {}) => {
    const hasExplicitAmount = typeof amountOrOptions === 'number' || typeof amountOrOptions === 'string';
    const options = hasExplicitAmount ? maybeOptions : (amountOrOptions || {});
    const field = options.field || 'price';
    const value = hasExplicitAmount
      ? convertAmount(amountOrOptions, getProductCurrency(product), currency)
      : getProductPriceNumber(product, field);
    return formatAmount(value, options);
  };

  const getOrderItemCurrency = (item, orderCurrency = 'USD') =>
    normalizeCurrency(item?.currency || item?.orderCurrency || orderCurrency);

  const getOrderItemPriceNumber = (item, orderCurrency = 'USD') => {
    if (!item) return 0;
    const amount = Number(item.price);
    if (Number.isFinite(amount)) {
      return convertAmount(amount, getOrderItemCurrency(item, orderCurrency), currency);
    }

    const sourceAmount = Number(item.sourcePrice ?? item.priceOriginal);
    const sourceCurrency = item.sourceCurrency || item.priceCurrency || orderCurrency;
    return Number.isFinite(sourceAmount) ? convertAmount(sourceAmount, sourceCurrency, currency) : 0;
  };

  const formatOrderItemPrice = (item, options = {}) =>
    formatAmount(getOrderItemPriceNumber(item, options.orderCurrency), options);

  const value = useMemo(() => ({
    currency,
    currencies: CURRENCIES,
    exchangeRates,
    isLoading,
    setCurrency,
    changeCurrency: setCurrency,
    normalizeCurrency,
    convertAmount,
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
  }), [currency, exchangeRates, isLoading]);

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
};

export default CurrencyContext;
