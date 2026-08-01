import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { StripeProvider, initStripe } from '@stripe/stripe-react-native';
import api from '../config/api';
import {
  assertUsableStripeConfig,
  getStripeUrlScheme,
  normalizeStripeConfig,
} from '../utils/stripePaymentSheet';

const StripeContext = createContext(null);

export function StripeBootstrapProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/payment-methods/config');
      const next = assertUsableStripeConfig(normalizeStripeConfig(response));
      await initStripe({
        publishableKey: next.publishableKey,
        urlScheme: getStripeUrlScheme(),
        setReturnUrlSchemeOnAndroid: true,
      });
      setConfig(next);
      setError(null);
      return next;
    } catch (nextError) {
      setError(nextError);
      throw nextError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig().catch(() => {});
  }, [loadConfig]);

  const ensureReady = useCallback(async () => {
    if (config) return assertUsableStripeConfig(config);
    return loadConfig();
  }, [config, loadConfig]);

  const value = useMemo(() => ({
    config,
    loading,
    error,
    refresh: loadConfig,
    ensureReady,
  }), [config, ensureReady, error, loadConfig, loading]);

  return (
    <StripeContext.Provider value={value}>
      <StripeProvider
        publishableKey={config?.publishableKey || ''}
        urlScheme={getStripeUrlScheme()}
        setReturnUrlSchemeOnAndroid
      >
        {children}
      </StripeProvider>
    </StripeContext.Provider>
  );
}

export function useStripeConfig() {
  const context = useContext(StripeContext);
  if (!context) throw new Error('useStripeConfig must be used within StripeBootstrapProvider');
  return context;
}

export default StripeContext;
