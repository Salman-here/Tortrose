import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import api from '../config/api';

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

const normalizeCurrency = (code) => {
  const normalized = String(code || 'USD').trim().toUpperCase();
  return CURRENCIES[normalized] ? normalized : 'USD';
};

const roundMoney = (amount) => Math.round((Number(amount) || 0) * 100) / 100;

export const CurrencyProvider = ({ children }) => {
  const [currency, setCurrencyState] = useState('USD');
  const [exchangeRates, setExchangeRates] = useState(DEFAULT_RATES);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadSavedCurrency();
    fetchExchangeRates();
  }, []);

  const loadSavedCurrency = async () => {
    try {
      const savedCurrency = await AsyncStorage.getItem('userCurrency');
      const token = await SecureStore.getItemAsync('jwtToken');

      if (token) {
        try {
          const res = await api.get('/api/user/single');
          const accountCurrency = normalizeCurrency(res.data?.user?.currency || savedCurrency);
          setCurrencyState(accountCurrency);
          await AsyncStorage.setItem('userCurrency', accountCurrency);
          return;
        } catch (_) {}
      }

      if (savedCurrency && CURRENCIES[savedCurrency]) {
        setCurrencyState(savedCurrency);
      }
    } catch (error) {
      console.error('Error loading saved currency:', error);
    } finally {
      setIsLoading(false);
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
    setCurrencyState(targetCurrency);
    await AsyncStorage.setItem('userCurrency', targetCurrency);

    try {
      const token = await SecureStore.getItemAsync('jwtToken');
      if (token) {
        await api.patch('/api/currency/update', { currency: targetCurrency });
      }
    } catch (_) {}
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
