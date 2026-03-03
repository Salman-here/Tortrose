import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { API_BASE_URL } from '../config/api';

const CurrencyContext = createContext();

export const useCurrency = () => {
  const context = useContext(CurrencyContext);
  if (!context) {
    throw new Error('useCurrency must be used within CurrencyProvider');
  }
  return context;
};

const CURRENCIES = {
  USD: { symbol: '$', name: 'US Dollar', code: 'USD' },
  PKR: { symbol: '₨', name: 'Pakistani Rupee', code: 'PKR' },
  EUR: { symbol: '€', name: 'Euro', code: 'EUR' },
  GBP: { symbol: '£', name: 'British Pound', code: 'GBP' },
  INR: { symbol: '₹', name: 'Indian Rupee', code: 'INR' },
  AED: { symbol: 'د.إ', name: 'UAE Dirham', code: 'AED' },
  SAR: { symbol: '﷼', name: 'Saudi Riyal', code: 'SAR' },
  CAD: { symbol: 'C$', name: 'Canadian Dollar', code: 'CAD' },
  AUD: { symbol: 'A$', name: 'Australian Dollar', code: 'AUD' },
  JPY: { symbol: '¥', name: 'Japanese Yen', code: 'JPY' },
};

const DEFAULT_RATES = {
  USD: 1,
  PKR: 284.6,
  EUR: 0.92,
  GBP: 0.79,
  INR: 83.5,
  AED: 3.67,
  SAR: 3.75,
  CAD: 1.36,
  AUD: 1.53,
  JPY: 149.5,
};

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
    } catch (error) {
      // Use default rates if API fails
    }
  };

  const setCurrency = async (newCurrency) => {
    if (!CURRENCIES[newCurrency]) return;

    setCurrencyState(newCurrency);
    await AsyncStorage.setItem('userCurrency', newCurrency);

    // Try to save to backend if user is logged in
    try {
      const savedToken = await AsyncStorage.getItem('jwtToken');
      if (savedToken) {
        await api.patch('/api/currency/update', { currency: newCurrency });
      }
    } catch (error) {
      // Silently fail - local storage is the primary source
    }
  };

  const convertPrice = (priceInUSD) => {
    if (!priceInUSD || isNaN(priceInUSD)) return 0;
    const rate = exchangeRates[currency] || 1;
    return priceInUSD * rate;
  };

  const formatPrice = (priceInUSD, options = {}) => {
    const { 
      showSymbol = true, 
      decimals = 2,
      showCode = false 
    } = options;

    const convertedPrice = convertPrice(priceInUSD);
    const currencyInfo = CURRENCIES[currency] || CURRENCIES.USD;
    
    const formattedNumber = convertedPrice.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });

    if (!showSymbol) return formattedNumber;

    const symbol = currencyInfo.symbol;
    const code = showCode ? ` ${currency}` : '';
    
    return `${symbol}${formattedNumber}${code}`;
  };

  const convertToUSD = (priceInCurrentCurrency) => {
    if (!priceInCurrentCurrency || isNaN(priceInCurrentCurrency)) return 0;
    const rate = exchangeRates[currency] || 1;
    return priceInCurrentCurrency / rate;
  };

  const getCurrencySymbol = () => {
    return CURRENCIES[currency]?.symbol || '$';
  };

  const getCurrencyName = () => {
    return CURRENCIES[currency]?.name || 'US Dollar';
  };

  const value = {
    currency,
    currencies: CURRENCIES,
    exchangeRates,
    isLoading,
    setCurrency,
    convertPrice,
    formatPrice,
    convertToUSD,
    getCurrencySymbol,
    getCurrencyName,
  };

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
};

export default CurrencyContext;
