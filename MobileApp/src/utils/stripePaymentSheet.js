import * as Linking from 'expo-linking';
import Constants from 'expo-constants';

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');

const unwrap = (payload = {}) => {
  const root = payload?.data || payload || {};
  return root?.paymentSheet || root?.payment || root?.stripe || root;
};

export const normalizeStripeConfig = (payload = {}) => {
  const root = payload?.data || payload || {};
  const source = root?.config || root?.stripe || root;
  const publishableKey = String(firstValue(
    source?.publishableKey,
    source?.publishable_key,
    root?.publishableKey,
    root?.publishable_key
  ) || '').trim();

  return {
    publishableKey,
    mode: String(firstValue(
      source?.mode,
      source?.stripeMode,
      source?.stripe_mode,
      root?.mode,
      root?.stripeMode,
      root?.stripe_mode,
      publishableKey.startsWith('pk_live_') ? 'live' : 'test'
    )).toLowerCase(),
    merchantCountryCode: String(firstValue(
      source?.merchantCountryCode,
      source?.merchant_country_code,
      root?.merchantCountryCode,
      root?.merchant_country_code
    ) || '').trim().toUpperCase(),
  };
};

export const assertUsableStripeConfig = (config) => {
  if (!config?.publishableKey?.startsWith('pk_')) {
    throw new Error('Secure card payments are temporarily unavailable. Please try again later.');
  }
  if (!/^[A-Z]{2}$/.test(config.merchantCountryCode || '')) {
    throw new Error('The payment merchant country is not configured correctly.');
  }
  return config;
};

export const normalizePaymentSheetPayload = (payload = {}) => {
  const root = payload?.data || payload || {};
  const source = unwrap(payload);
  const paymentIntentClientSecret = String(firstValue(
    source?.paymentIntentClientSecret,
    source?.paymentIntent,
    root?.paymentIntentClientSecret,
    root?.paymentIntent
  ) || '');
  const setupIntentClientSecret = String(firstValue(
    source?.setupIntentClientSecret,
    source?.setupIntent,
    root?.setupIntentClientSecret,
    root?.setupIntent
  ) || '');

  return {
    paymentIntentClientSecret,
    setupIntentClientSecret,
    customerId: String(firstValue(source?.customerId, source?.customer, root?.customerId, root?.customer) || ''),
    customerSessionClientSecret: String(firstValue(
      source?.customerSessionClientSecret,
      source?.customerSession,
      root?.customerSessionClientSecret,
      root?.customerSession
    ) || ''),
    orderId: String(firstValue(root?.orderId, root?.order?._id, root?.order?.orderId, source?.orderId) || ''),
    topUpId: String(firstValue(
      root?.topUpId,
      root?.transactionId,
      root?.topUp?._id,
      root?.topUp?.id,
      root?.transaction?._id,
      root?.transaction?.id,
      source?.topUpId,
      source?.transactionId,
      source?.transaction?._id,
      source?.transaction?.id
    ) || ''),
    paymentIntentId: String(firstValue(
      root?.paymentIntentId,
      source?.paymentIntentId,
      paymentIntentClientSecret.split('_secret_')[0]
    ) || ''),
    completed: root?.completed === true || root?.isPaid === true,
  };
};

export const assertPaymentSheetPayload = (payload, intentType = 'payment') => {
  const normalized = normalizePaymentSheetPayload(payload);
  const clientSecret = intentType === 'setup'
    ? normalized.setupIntentClientSecret
    : normalized.paymentIntentClientSecret;
  const expectedPrefix = intentType === 'setup' ? 'seti_' : 'pi_';

  if (!clientSecret || !clientSecret.startsWith(expectedPrefix) || !clientSecret.includes('_secret_')) {
    throw new Error(intentType === 'setup'
      ? 'Stripe did not return a valid card setup reference.'
      : 'Stripe did not return a valid payment reference.');
  }
  if (!normalized.customerId || !normalized.customerSessionClientSecret) {
    throw new Error('Stripe customer access could not be prepared securely.');
  }
  return normalized;
};

export const getStripeUrlScheme = () => (
  Constants.appOwnership === 'expo'
    ? Linking.createURL('/--/')
    : Linking.createURL('')
);

export const getStripeReturnUrl = () => Linking.createURL('stripe-redirect');

export const buildPaymentSheetAppearance = (palette, isDark = false) => ({
  colors: {
    primary: palette?.colors?.primary || '#6366F1',
    background: palette?.colors?.surface || (isDark ? '#141A2E' : '#FFFFFF'),
    componentBackground: palette?.colors?.surfaceElevated || (isDark ? '#1E2540' : '#FFFFFF'),
    componentBorder: palette?.colors?.borderStrong || (isDark ? '#374151' : '#E5E7EB'),
    componentDivider: palette?.colors?.border || (isDark ? '#273047' : '#EEF2F7'),
    primaryText: palette?.colors?.text || (isDark ? '#F9FAFB' : '#1F2937'),
    secondaryText: palette?.colors?.textSecondary || (isDark ? '#CBD5E1' : '#6B7280'),
    componentText: palette?.colors?.text || (isDark ? '#F9FAFB' : '#1F2937'),
    placeholderText: palette?.colors?.textLight || '#9CA3AF',
    icon: palette?.colors?.primary || '#6366F1',
    error: palette?.colors?.error || '#EF4444',
  },
  shapes: {
    borderRadius: 16,
    borderWidth: 1,
  },
  primaryButton: {
    shapes: { borderRadius: 16 },
    colors: {
      background: palette?.colors?.primary || '#6366F1',
      text: '#FFFFFF',
      border: palette?.colors?.primary || '#6366F1',
    },
  },
});

export const buildPaymentSheetOptions = ({
  payment,
  config,
  currentUser,
  billingDetails,
  currency = 'USD',
  palette,
  isDark = false,
  intentType = 'payment',
}) => {
  const normalized = assertPaymentSheetPayload(payment, intentType);
  const options = {
    merchantDisplayName: 'Rozare',
    customerId: normalized.customerId,
    customerSessionClientSecret: normalized.customerSessionClientSecret,
    returnURL: getStripeReturnUrl(),
    allowsDelayedPaymentMethods: false,
    style: isDark ? 'alwaysDark' : 'alwaysLight',
    appearance: buildPaymentSheetAppearance(palette, isDark),
    defaultBillingDetails: {
      name: billingDetails?.name || currentUser?.name || currentUser?.username || '',
      email: billingDetails?.email || currentUser?.email || '',
      phone: billingDetails?.phone || currentUser?.phone || '',
      address: billingDetails?.address,
    },
    googlePay: {
      merchantCountryCode: assertUsableStripeConfig(config).merchantCountryCode,
      currencyCode: String(currency || 'USD').toUpperCase(),
      testEnv: config.mode !== 'live',
    },
    paymentMethodLayout: 'Automatic',
  };

  if (intentType === 'setup') {
    options.setupIntentClientSecret = normalized.setupIntentClientSecret;
    options.primaryButtonLabel = 'Save card';
    options.googlePay.amount = '0';
  } else {
    options.paymentIntentClientSecret = normalized.paymentIntentClientSecret;
    options.primaryButtonLabel = 'Pay securely';
  }
  return options;
};

export const isPaymentSheetCancellation = (error) => (
  String(error?.code || '').toLowerCase() === 'canceled'
  || String(error?.code || '').toLowerCase() === 'cancelled'
);

export const runPaymentSheet = async ({
  initPaymentSheet,
  presentPaymentSheet,
  options,
}) => {
  const initialized = await initPaymentSheet(options);
  if (initialized?.error) return { status: 'failed', error: initialized.error, stage: 'initialize' };

  const presented = await presentPaymentSheet();
  if (presented?.error) {
    return {
      status: isPaymentSheetCancellation(presented.error) ? 'cancelled' : 'failed',
      error: presented.error,
      stage: 'present',
    };
  }
  return { status: 'presented' };
};

const paymentMethodId = (value) => String(value?.id || value?._id || value?.paymentMethodId || '');

export const normalizeSavedCards = (payload = {}) => {
  const root = payload?.data || payload || {};
  const cards = root?.cards || root?.paymentMethods || [];
  const defaultPaymentMethodId = String(root?.defaultPaymentMethodId || root?.default || '');

  return {
    defaultPaymentMethodId,
    cards: (Array.isArray(cards) ? cards : []).map((entry) => {
      const card = entry?.card || entry;
      const id = paymentMethodId(entry);
      return {
        id,
        brand: String(card?.brand || entry?.brand || 'card').toLowerCase(),
        last4: String(card?.last4 || entry?.last4 || '').slice(-4),
        expMonth: Number(card?.expMonth || card?.exp_month || entry?.expMonth || 0),
        expYear: Number(card?.expYear || card?.exp_year || entry?.expYear || 0),
        funding: String(card?.funding || entry?.funding || ''),
        country: String(card?.country || entry?.country || ''),
        isDefault: entry?.isDefault === true || id === defaultPaymentMethodId,
      };
    }).filter((card) => card.id && card.last4),
  };
};

const topUpReferenceMatches = (transaction, references) => {
  const candidates = [
    transaction?._id,
    transaction?.id,
    transaction?.topUpId,
    transaction?.paymentIntentId,
    transaction?.stripePaymentIntentId,
    transaction?.reference,
    transaction?.metadata?.paymentIntentId,
  ].map(String);
  return references.some((reference) => reference && candidates.includes(String(reference)));
};

export const normalizeWalletTopUpStatus = ({
  payload,
  topUpId,
  paymentIntentId,
  currency,
  startingBalance,
  amount,
}) => {
  const root = payload?.data || payload || {};
  const directStatus = String(root?.status || root?.topUp?.status || root?.transaction?.status || '').toLowerCase();
  if (
    root?.webhookProcessed === true
    || ['completed', 'complete', 'succeeded', 'success', 'paid'].includes(directStatus)
  ) {
    return { status: 'paid', payload: root };
  }
  if (['cancelled', 'canceled'].includes(directStatus)) {
    return { status: 'cancelled', payload: root };
  }
  if (['failed', 'expired'].includes(directStatus)) {
    return { status: 'failed', payload: root };
  }
  const wallet = root?.wallet || {};
  const transactions = root?.transactions || wallet?.transactions || [];
  const references = [topUpId, paymentIntentId].filter(Boolean);
  const matching = references.length
    ? (Array.isArray(transactions) ? transactions : []).find((item) => topUpReferenceMatches(item, references))
    : null;
  const rawStatus = String(matching?.status || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'paid'].includes(rawStatus)) {
    return { status: 'paid', payload: root };
  }
  if (['cancelled', 'canceled'].includes(rawStatus)) {
    return { status: 'cancelled', payload: root };
  }
  if (['failed', 'expired'].includes(rawStatus)) {
    return { status: 'failed', payload: root };
  }
  const balance = Number(wallet?.balances?.[String(currency || '').toUpperCase()] || 0);
  if (Number(amount) > 0 && balance + 0.0001 >= Number(startingBalance || 0) + Number(amount)) {
    return { status: 'paid', payload: root };
  }
  return { status: 'pending', payload: root };
};

export const verifyWalletTopUp = async ({
  apiClient,
  topUpId,
  paymentIntentId,
  currency,
  startingBalance,
  amount,
  attempts = 8,
  delayMs = 1000,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) => {
  let lastResult = { status: 'pending', payload: null };
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      const response = topUpId
        ? await apiClient.get(
          `/api/wallet/top-ups/${encodeURIComponent(topUpId)}/status`,
          { params: paymentIntentId ? { paymentIntentId } : {} }
        )
        : await apiClient.get('/api/wallet/me?limit=100');
      lastResult = normalizeWalletTopUpStatus({
        payload: response,
        topUpId,
        paymentIntentId,
        currency,
        startingBalance,
        amount,
      });
      if (lastResult.status !== 'pending') return lastResult;
    } catch (error) {
      lastResult = { status: 'pending', error, payload: lastResult.payload };
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return lastResult;
};
