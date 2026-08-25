import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useStripe } from '@stripe/stripe-react-native';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../components/common/KeyboardAwareFormScrollView';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useCurrency } from '../contexts/CurrencyContext';
import { useAuth } from '../contexts/AuthContext';
import { useStripeConfig } from '../contexts/StripeContext';
import { useTheme } from '../contexts/ThemeContext';
import { fontSize, fontWeight, shadows, spacing, typography } from '../styles/theme';
import {
  assertPaymentSheetPayload,
  buildPaymentSheetOptions,
  cancelWalletTopUpPaymentAttempt,
  normalizePaymentSheetPayload,
  runWalletPaymentSheetAttempt,
  verifyWalletTopUp,
} from '../utils/stripePaymentSheet';
import { trackError, trackPaymentEvent } from '../utils/breadcrumbs';
import {
  canTopUpWalletCurrency,
  findWalletTransaction,
  getTopUpCompletionBreakdown,
  getWalletCurrencyRisk,
  isWalletRiskSettlementTopUp,
  shouldRetainWalletTopUpAttempt,
} from '../utils/walletPaymentRisk';
import { roundCurrencyAmount } from '../utils/currencySafety';
import {
  clearPersistedMutationAttemptFromLedger,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttemptInLedger,
} from '../utils/persistedMutationAttempt';
import { inspectWalletSummaryPresentation } from '../utils/walletPresentationSafety';

const WALLET_CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];
const TOP_UP_ATTEMPT_STORAGE_KEY = 'rozare_wallet_topup_attempt_v1';
const CURRENCY_META = {
  USD: { symbol: '$', color: '#2563EB', tint: 'rgba(37,99,235,0.12)' },
  PKR: { symbol: 'Rs', color: '#16A34A', tint: 'rgba(22,163,74,0.12)' },
  EUR: { symbol: '€', color: '#7C3AED', tint: 'rgba(124,58,237,0.12)' },
  GBP: { symbol: '£', color: '#D97706', tint: 'rgba(217,119,6,0.12)' },
};

const getTransactionMeta = (transaction) => {
  const isCredit = transaction.direction === 'credit';
  const status = String(transaction.status || '').toLowerCase();
  if (status === 'completed') {
    return isCredit
      ? { icon: 'arrow-down', color: '#16A34A', tint: 'rgba(34,197,94,0.12)', label: 'Received' }
      : { icon: 'arrow-up', color: '#4F46E5', tint: 'rgba(99,102,241,0.12)', label: 'Sent' };
  }
  if (status === 'pending') {
    return { icon: 'time-outline', color: '#D97706', tint: 'rgba(245,158,11,0.12)', label: 'Pending' };
  }
  if (status === 'cancelled' || status === 'canceled') {
    return { icon: 'remove-circle-outline', color: '#64748B', tint: 'rgba(100,116,139,0.12)', label: 'Cancelled' };
  }
  if (status === 'expired') {
    return { icon: 'timer-outline', color: '#EA580C', tint: 'rgba(249,115,22,0.12)', label: 'Expired' };
  }
  if (status === 'reversed') {
    return { icon: 'swap-horizontal-outline', color: '#7C3AED', tint: 'rgba(124,58,237,0.12)', label: 'Reversed' };
  }
  if (status === 'failed') {
    return { icon: 'close', color: '#DC2626', tint: 'rgba(239,68,68,0.12)', label: 'Failed' };
  }
  return { icon: 'ellipse-outline', color: '#64748B', tint: 'rgba(100,116,139,0.12)', label: status ? status.replace(/_/g, ' ') : 'Recorded' };
};

const formatActivityDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const paymentSheetFailureMessage = (error) => (
  error?.localizedMessage
  || error?.message
  || 'Stripe could not open the secure card sheet. Please try again.'
);

const getTopUpCompletionNotice = (transaction, formatAmount) => {
  const breakdown = getTopUpCompletionBreakdown(transaction);
  if (!breakdown) {
    return {
      title: 'Top-up verified',
      message: 'Your current available balance and payment-risk liability have been refreshed.',
    };
  }
  const format = value => formatAmount(value, { targetCurrency: breakdown.currency });
  return {
    title: breakdown.appliedToLiability > 0 ? 'Top-up applied safely' : 'Balance added',
    message: [
      `Available balance credited: ${format(breakdown.creditedAmount)}.`,
      `Applied to payment-risk liability: ${format(breakdown.appliedToLiability)}.`,
      `Remaining liability: ${format(breakdown.remainingLiability)}.`,
    ].join(' '),
  };
};

const activityTimestamp = (value) => {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseTopUpAmount = (raw) => {
  if (typeof raw !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(raw.trim())) return null;
  const value = Number(raw);
  if (
    !Number.isFinite(value)
    || value <= 0
    || roundCurrencyAmount(value) !== value
  ) return null;
  return value;
};

export default function WalletScreen({ navigation, route }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);
  const { currentUser } = useAuth();
  const topUpAttemptStorageKey = createScopedMutationStorageKey(
    TOP_UP_ATTEMPT_STORAGE_KEY,
    currentUser?._id || currentUser?.id || 'guest'
  );
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { ensureReady: ensureStripeReady } = useStripeConfig();
  const { currency, formatAmount } = useCurrency();
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);
  const [amountError, setAmountError] = useState('');
  const [topUpCurrency, setTopUpCurrency] = useState(
    WALLET_CURRENCIES.includes(currency) ? currency : 'USD'
  );
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const topUpSubmissionRef = useRef(false);
  const activeTopUpAttemptRef = useRef(null);
  const walletRequestRef = useRef(0);

  const clearTopUpAttempt = useCallback(async (correlation) => {
    if (!correlation?.storageKey || !correlation?.fingerprint || !correlation?.attemptKey) {
      return false;
    }
    const cleared = await clearPersistedMutationAttemptFromLedger(
      AsyncStorage,
      correlation.storageKey,
      correlation.fingerprint,
      correlation.attemptKey,
    );
    if (
      cleared
      && activeTopUpAttemptRef.current?.attemptKey === correlation.attemptKey
    ) {
      activeTopUpAttemptRef.current = null;
    }
    return cleared;
  }, []);

  const loadWallet = useCallback(async ({ quiet = false } = {}) => {
    const requestId = walletRequestRef.current + 1;
    walletRequestRef.current = requestId;
    if (!quiet) setLoading(true);
    try {
      const response = await api.get('/api/wallet/me?limit=100');
      const snapshot = inspectWalletSummaryPresentation(response.data);
      if (!snapshot) {
        const integrityError = new Error('The Wallet response could not be verified. Refresh before using Wallet funds or starting a top-up.');
        integrityError.code = 'WALLET_PRESENTATION_DATA_INVALID';
        throw integrityError;
      }
      if (walletRequestRef.current === requestId) {
        setWallet(snapshot.wallet);
        setTransactions(snapshot.transactions);
        setLoadError('');
      }
      return snapshot;
    } catch (error) {
      if (walletRequestRef.current === requestId) {
        setWallet(null);
        setTransactions([]);
        setLoadError(
          error.code === 'WALLET_PRESENTATION_DATA_INVALID'
            ? error.message
            : (error.response?.data?.msg || 'Your Rozare Wallet could not be loaded.'),
        );
      }
      return null;
    } finally {
      if (walletRequestRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    loadWallet();
    const unsubscribe = navigation.addListener('focus', () => loadWallet({ quiet: true }));
    return () => {
      walletRequestRef.current += 1;
      unsubscribe?.();
    };
  }, [loadWallet, navigation]);

  useEffect(() => {
    if (!route.params?.top_up) return undefined;
    setNotice({
      type: 'pending',
      title: 'Checking top-up status',
      message: route.params.top_up === 'success'
        ? 'Stripe returned successfully. Rozare is verifying the exact Wallet transaction.'
        : 'Stripe checkout was closed. Rozare is checking the exact Wallet transaction before showing a final result.',
    });
    let cancelled = false;
    const transactionId = String(route.params?.transactionId || '');
    const returnCorrelation = {
      storageKey: route.params?.topUpAttemptStorageKey || '',
      fingerprint: route.params?.topUpAttemptFingerprint || '',
      attemptKey: route.params?.topUpAttemptKey || '',
    };
    const clearReturnParams = () => navigation.setParams({
      top_up: undefined,
      session_id: undefined,
      transactionId: undefined,
      topUpAttemptStorageKey: undefined,
      topUpAttemptFingerprint: undefined,
      topUpAttemptKey: undefined,
    });
    const poll = async () => {
      if (!transactionId) {
        if (!cancelled) {
          setNotice({
            type: 'error',
            title: 'Top-up reference missing',
            message: 'No Wallet credit or retry key was changed. Refresh activity before starting another top-up.',
          });
          clearReturnParams();
        }
        return;
      }
      for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
        const payload = await loadWallet({ quiet: true });
        const transaction = findWalletTransaction(payload, transactionId);
        const status = String(transaction?.status || '').toLowerCase();
        if (status === 'completed') {
          await clearTopUpAttempt(returnCorrelation);
          if (!cancelled) {
            setNotice({
              type: 'success',
              ...getTopUpCompletionNotice(transaction, formatAmount),
            });
            clearReturnParams();
          }
          return;
        }
        if (['failed', 'cancelled', 'canceled', 'expired', 'reversed'].includes(status)) {
          await clearTopUpAttempt(returnCorrelation);
          if (!cancelled) {
            const explicitlyCancelled = ['cancelled', 'canceled'].includes(status);
            setNotice({
              type: explicitlyCancelled ? 'info' : 'error',
              title: explicitlyCancelled ? 'Top-up cancelled' : status === 'expired' ? 'Top-up expired' : 'Top-up failed',
              message: `Rozare verified that this Wallet top-up is ${status}. No success has been assumed.`,
            });
            clearReturnParams();
          }
          return;
        }
        if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!cancelled) {
        setNotice({
          type: 'pending',
          title: 'Top-up confirmation timed out',
          message: 'The exact transaction is still not terminal. No Wallet credit was assumed and its retry key is preserved.',
        });
        clearReturnParams();
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [clearTopUpAttempt, formatAmount, loadWallet, navigation, route.params?.top_up, route.params?.transactionId, route.params?.topUpAttemptFingerprint, route.params?.topUpAttemptKey, route.params?.topUpAttemptStorageKey]);

  const selectedBalance = wallet?.balances?.[topUpCurrency] ?? null;
  const selectedMeta = CURRENCY_META[topUpCurrency];
  const selectedRisk = getWalletCurrencyRisk(wallet, topUpCurrency);
  const canTopUpSelectedCurrency = !loading
    && !refreshing
    && wallet !== null
    && selectedBalance !== null
    && canTopUpWalletCurrency(wallet, topUpCurrency);
  const isRiskSettlement = isWalletRiskSettlementTopUp(wallet, topUpCurrency);
  const recentTransactions = useMemo(
    () => [...transactions].sort((a, b) => {
      const left = activityTimestamp(a.createdAt);
      const right = activityTimestamp(b.createdAt);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    }),
    [transactions]
  );

  const topUp = async () => {
    if (topUpSubmissionRef.current || submitting) return;
    const normalizedAmount = parseTopUpAmount(amount);
    if (normalizedAmount === null) {
      setAmountError('Enter a positive amount with no more than two decimal places.');
      return;
    }
    if (!canTopUpSelectedCurrency) {
      setAmountError(wallet?.lockedReason || 'This wallet cannot accept a top-up right now.');
      return;
    }
    setAmountError('');
    setNotice(null);
    topUpSubmissionRef.current = true;
    setSubmitting(true);
    let topUpReference = null;
    let paymentCleanupAttempted = false;
    let attemptCorrelation = null;
    try {
      const stripeConfig = await ensureStripeReady();
      trackPaymentEvent('wallet_top_up_started', {
        currency: topUpCurrency,
        googlePayEnabled: !!stripeConfig.googlePayEnabled,
      });
      const fingerprint = `${currentUser?._id || currentUser?.id || 'guest'}:${String(topUpCurrency).toUpperCase()}:${normalizedAmount.toFixed(2)}`;
      const attempt = await getOrCreatePersistedMutationAttemptInLedger({
        storage: AsyncStorage,
        storageKey: topUpAttemptStorageKey,
        fingerprint,
        keyPrefix: 'mobile-wallet',
      });
      attemptCorrelation = {
        storageKey: topUpAttemptStorageKey,
        fingerprint,
        attemptKey: attempt.key,
      };
      activeTopUpAttemptRef.current = attemptCorrelation;
      const requestKey = attempt.key;
      const response = await api.post('/api/wallet/top-ups', {
        amount: normalizedAmount,
        currency: topUpCurrency,
        platform: 'mobile',
        paymentFlow: 'payment_sheet',
        clientSurface: 'mobile',
        requestKey,
      }, {
        headers: { 'X-Idempotency-Key': requestKey },
      });
      if (response.data?.completed) {
        const refreshedWallet = await loadWallet({ quiet: true });
        if (!refreshedWallet) {
          const integrityError = new Error('The completed top-up could not be reconciled with a verified Wallet balance. Refresh before retrying.');
          integrityError.code = 'WALLET_PRESENTATION_DATA_INVALID';
          throw integrityError;
        }
        await clearTopUpAttempt(attemptCorrelation);
        setAmount('');
        setNotice({
          type: 'success',
          ...getTopUpCompletionNotice(response.data?.transaction, formatAmount),
        });
        return;
      }
      const reference = normalizePaymentSheetPayload(response);
      topUpReference = reference;
      trackPaymentEvent('wallet_top_up_reference_created', {
        hasTopUpId: !!reference.topUpId,
        hasPaymentIntent: !!reference.paymentIntentId,
      });
      if (!reference.topUpId) {
        throw new Error('Rozare did not return a secure top-up reference. Your Wallet has not been credited.');
      }
      const payment = assertPaymentSheetPayload(response, 'payment');
      const sheetResult = await runWalletPaymentSheetAttempt({
        initPaymentSheet,
        presentPaymentSheet,
        apiClient: api,
        topUpId: reference.topUpId,
        paymentIntentId: reference.paymentIntentId,
        options: buildPaymentSheetOptions({
          payment,
          config: stripeConfig,
          currentUser,
          currency: topUpCurrency,
          palette,
          isDark,
          intentType: 'payment',
        }),
      });
      paymentCleanupAttempted = sheetResult.status !== 'presented';
      trackPaymentEvent(`wallet_top_up_sheet_${sheetResult.status}`, {
        stage: sheetResult.stage,
        code: sheetResult.error?.code,
      });
      const cancellationError = sheetResult.cleanupError;
      const verification = await verifyWalletTopUp({
        apiClient: api,
        topUpId: reference.topUpId,
        paymentIntentId: reference.paymentIntentId,
        currency: topUpCurrency,
        startingBalance: selectedBalance,
        amount: normalizedAmount,
        attempts: sheetResult.status === 'presented' || cancellationError?.response?.data?.code === 'PAYMENT_ALREADY_SUCCEEDED' ? 8 : 2,
        delayMs: 900,
      });
      if (verification.status === 'paid') {
        const refreshedWallet = await loadWallet({ quiet: true });
        if (!refreshedWallet) {
          const integrityError = new Error('Stripe confirmed the payment, but the verified Wallet balance is not available yet. Refresh before retrying.');
          integrityError.code = 'WALLET_PRESENTATION_DATA_INVALID';
          throw integrityError;
        }
        await clearTopUpAttempt(attemptCorrelation);
        setAmount('');
        const completedTransaction = findWalletTransaction(verification.payload, reference.topUpId);
        setNotice({
          type: 'success',
          ...getTopUpCompletionNotice(completedTransaction, formatAmount),
        });
      } else if (verification.status === 'failed') {
        await loadWallet({ quiet: true });
        await clearTopUpAttempt(attemptCorrelation);
        setNotice({
          type: 'error',
          title: 'Top-up was not completed',
          message: 'Stripe did not complete this payment. Your wallet was not credited.',
        });
      } else if (verification.status === 'cancelled') {
        await loadWallet({ quiet: true });
        await clearTopUpAttempt(attemptCorrelation);
        setNotice({
          type: sheetResult.status === 'failed' ? 'error' : 'info',
          title: sheetResult.status === 'failed' ? 'Secure payment could not open' : 'Top-up cancelled',
          message: sheetResult.status === 'failed'
            ? `${paymentSheetFailureMessage(sheetResult.error)} Rozare closed the failed attempt and your Wallet was not credited.`
            : 'Rozare confirmed that this payment attempt is closed. Your Wallet was not credited.',
        });
      } else if (sheetResult.status === 'failed') {
        await loadWallet({ quiet: true });
        setNotice({
          type: 'error',
          title: sheetResult.stage === 'initialize' ? 'Secure payment could not open' : 'Top-up could not be completed',
          message: cancellationError
            ? 'The payment could not open and Rozare is still confirming cleanup. No Wallet balance has been added.'
            : paymentSheetFailureMessage(sheetResult.error),
        });
      } else if (sheetResult.status === 'cancelled') {
        await loadWallet({ quiet: true });
        setNotice({
          type: 'info',
          title: cancellationError ? 'Closing your top-up' : 'Top-up closing',
          message: 'No balance has been added. Rozare is confirming the final status with the payment server.',
        });
      } else {
        setNotice({
          type: 'info',
          title: 'Confirming your top-up',
          message: 'Stripe accepted the payment. Rozare will show the balance only after backend confirmation.',
        });
      }
    } catch (error) {
      trackError('wallet_top_up', error, { currency: topUpCurrency });
      if (topUpReference?.topUpId && !paymentCleanupAttempted) {
        let cleanupError = null;
        try {
          await cancelWalletTopUpPaymentAttempt({
            apiClient: api,
            topUpId: topUpReference.topUpId,
            paymentIntentId: topUpReference.paymentIntentId,
            closeReason: 'payment_sheet_preparation_failed',
          });
          await clearTopUpAttempt(attemptCorrelation);
        } catch (nextError) {
          cleanupError = nextError;
        }
        await loadWallet({ quiet: true });
        setNotice({
          type: 'error',
          title: 'Secure payment could not open',
          message: cleanupError
            ? 'Rozare is still confirming cleanup. No Wallet balance has been added.'
            : 'Rozare closed the failed payment attempt. Your Wallet was not credited.',
        });
        return;
      }
      if (!topUpReference?.topUpId && !shouldRetainWalletTopUpAttempt(error)) {
        await clearTopUpAttempt(attemptCorrelation);
      }
      setNotice({
        type: 'error',
        title: 'Top-up could not be completed',
        message: error.response?.data?.msg || error.message || 'Please try again in a moment.',
      });
    } finally {
      topUpSubmissionRef.current = false;
      setSubmitting(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadWallet({ quiet: true });
  };

  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('MainTabs', { screen: 'Account' });
  };

  const header = (
    <PremiumBackHeader
      title="Rozare Wallet"
      subtitle="Balance, refunds, and secure top-ups"
      icon="wallet-outline"
      onBack={goBack}
      rightElement={(
        <TouchableOpacity
          style={styles.headerAction}
          onPress={() => loadWallet()}
          disabled={loading || refreshing}
          accessibilityRole="button"
          accessibilityLabel="Refresh wallet"
        >
          {loading || refreshing
            ? <ActivityIndicator size="small" color={palette.colors.primary} />
            : <Ionicons name="refresh-outline" size={19} color={palette.colors.primary} />}
        </TouchableOpacity>
      )}
      style={styles.premiumHeader}
    />
  );

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <View style={styles.container}>
          {header}
          <KeyboardAwareFormScrollView
            contentContainerStyle={styles.scroll}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
          >
            {loading ? (
              <GlassPanel variant="strong" style={styles.loadingCard}>
                <View style={styles.loadingIcon}>
                  <ActivityIndicator size="small" color={palette.colors.primary} />
                </View>
                <Text style={styles.loadingTitle}>Preparing your wallet</Text>
                <Text style={styles.loadingText}>Loading balances and recent activity securely.</Text>
              </GlassPanel>
            ) : (
              <>
                {!!loadError && (
                  <View style={styles.loadError}>
                    <View style={styles.loadErrorIcon}>
                      <Ionicons name="cloud-offline-outline" size={20} color={palette.colors.error} />
                    </View>
                    <View style={styles.loadErrorCopy}>
                      <Text style={styles.loadErrorTitle}>Wallet unavailable</Text>
                      <Text style={styles.loadErrorText}>{loadError}</Text>
                    </View>
                    <TouchableOpacity onPress={() => loadWallet()} style={styles.retryButton}>
                      <Text style={styles.retryText}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {!!notice && (
                  <View style={[
                    styles.notice,
                    notice.type === 'error' && styles.noticeError,
                    notice.type === 'success' && styles.noticeSuccess,
                  ]}>
                    <Ionicons
                      name={notice.type === 'error' ? 'alert-circle-outline' : notice.type === 'success' ? 'checkmark-circle-outline' : 'information-circle-outline'}
                      size={19}
                      color={notice.type === 'error' ? palette.colors.error : notice.type === 'success' ? palette.colors.success : palette.colors.primary}
                    />
                    <View style={styles.noticeCopy}>
                      <Text style={styles.noticeTitle}>{notice.title}</Text>
                      <Text style={styles.noticeText}>{notice.message}</Text>
                    </View>
                    <TouchableOpacity onPress={() => setNotice(null)} hitSlop={8}>
                      <Ionicons name="close" size={16} color={palette.colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                )}

                {wallet && !loadError && (
                  <>
                {wallet && wallet.status !== 'active' && (
                  <View style={styles.lockedBanner}>
                    <View style={styles.lockedIcon}>
                      <Ionicons name="lock-closed-outline" size={19} color={palette.colors.error} />
                    </View>
                    <View style={styles.lockedCopy}>
                      <Text style={styles.lockedTitle}>Wallet access locked</Text>
                      <Text style={styles.lockedText}>{wallet.lockedReason || 'Contact support for help.'}</Text>
                      {wallet.paymentRisk?.canTopUpForSettlement === true && (
                        <Text style={styles.lockedText}>Checkout remains blocked. Each verified payment reduces the selected-currency liability first. The Wallet stays locked while debt remains, and only surplus after full clearance becomes available.</Text>
                      )}
                    </View>
                  </View>
                )}

                <GlassPanel variant="strong" style={styles.balanceHero}>
                  <LinearGradient
                    colors={['rgba(20,184,166,0.16)', 'rgba(14,165,233,0.07)', 'rgba(99,102,241,0.16)']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                  />
                  <View style={styles.balanceTopline}>
                    <View style={styles.balanceLabelRow}>
                      <View style={[styles.currencyMark, { backgroundColor: selectedMeta.tint }]}>
                        <Text style={[styles.currencyMarkText, { color: selectedMeta.color }]}>{selectedMeta.symbol}</Text>
                      </View>
                      <View>
                        <Text style={styles.balanceEyebrow}>AVAILABLE BALANCE</Text>
                        <Text style={styles.balanceCurrency}>{topUpCurrency} wallet</Text>
                      </View>
                    </View>
                    <View style={styles.securePill}>
                      <Ionicons name="shield-checkmark-outline" size={13} color={palette.colors.success} />
                      <Text style={styles.secureText}>Protected</Text>
                    </View>
                  </View>
                  <Text style={styles.heroBalance} numberOfLines={1} adjustsFontSizeToFit>
                    {formatAmount(selectedBalance, { targetCurrency: topUpCurrency })}
                  </Text>
                  <Text style={styles.balanceHint}>Use this balance for orders in {topUpCurrency}. Currencies stay separate.</Text>

                  <View style={styles.heroCurrencyRow}>
                    {WALLET_CURRENCIES.map((code) => {
                      const active = topUpCurrency === code;
                      return (
                        <TouchableOpacity
                          key={code}
                          style={[styles.heroCurrencyChip, active && styles.heroCurrencyChipActive]}
                          onPress={() => {
                            setTopUpCurrency(code);
                            setAmountError('');
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: active }}
                        >
                          <Text style={[styles.heroCurrencyText, active && styles.heroCurrencyTextActive]}>{code}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </GlassPanel>

                <View style={styles.balanceOverview}>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.sectionEyebrow}>YOUR BALANCES</Text>
                      <Text style={styles.sectionTitle}>Every currency, at a glance</Text>
                    </View>
                    <Text style={styles.sectionMeta}>{WALLET_CURRENCIES.length} wallets</Text>
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.balanceStrip}
                  >
                    {WALLET_CURRENCIES.map((code) => {
                      const meta = CURRENCY_META[code];
                      const risk = getWalletCurrencyRisk(wallet, code);
                      return (
                        <TouchableOpacity
                          key={code}
                          onPress={() => setTopUpCurrency(code)}
                          activeOpacity={0.78}
                        >
                          <GlassPanel
                            variant="card"
                            style={[styles.balanceCard, topUpCurrency === code && styles.balanceCardActive]}
                          >
                            <View style={[styles.smallCurrencyMark, { backgroundColor: meta.tint }]}>
                              <Text style={[styles.smallCurrencyMarkText, { color: meta.color }]}>{meta.symbol}</Text>
                            </View>
                            <Text style={styles.balanceCode}>{code} AVAILABLE</Text>
                            <Text style={styles.balanceValue} numberOfLines={1} adjustsFontSizeToFit>
                              {formatAmount(wallet.balances[code], { targetCurrency: code })}
                            </Text>
                            {(risk.held !== null || risk.outstanding !== null) && (
                              <View style={styles.riskAmounts}>
                                {risk.held !== null && (
                                  <Text style={styles.riskAmountText}>Held {formatAmount(risk.held, { targetCurrency: code })}</Text>
                                )}
                                {risk.outstanding !== null && (
                                  <Text style={styles.riskAmountText}>Liability {formatAmount(risk.outstanding, { targetCurrency: code })}</Text>
                                )}
                              </View>
                            )}
                          </GlassPanel>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>

                <GlassPanel variant="card" style={styles.topUpSection}>
                  <View style={styles.topUpHeading}>
                    <View style={styles.topUpIcon}>
                      <Ionicons name="add" size={20} color={palette.colors.primary} />
                    </View>
                    <View style={styles.topUpCopy}>
                      <Text style={styles.topUpTitle}>{isRiskSettlement ? `Settle ${topUpCurrency} liability` : `Add ${topUpCurrency} balance`}</Text>
                      <Text style={styles.topUpSubtitle}>{isRiskSettlement
                        ? `${formatAmount(selectedRisk.outstanding, { targetCurrency: topUpCurrency })} is outstanding. Any valid top-up reduces it first; a partial payment leaves the Wallet locked, while surplus after full clearance becomes available.`
                        : 'Complete a secure Stripe card payment.'}</Text>
                    </View>
                    <Ionicons name="card-outline" size={20} color={palette.colors.textSecondary} />
                  </View>

                  <Text style={styles.inputLabel}>Amount</Text>
                  <View style={[styles.amountInputWrap, !!amountError && styles.amountInputError]}>
                    <Text style={styles.amountCurrency}>{selectedMeta.symbol}</Text>
                    <TextInput
                      value={amount}
                      onChangeText={(value) => {
                        setAmount(value.replace(/[^0-9.]/g, ''));
                        if (amountError) setAmountError('');
                      }}
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      placeholderTextColor={palette.colors.textLight}
                      style={styles.amountInput}
                      returnKeyType="done"
                    />
                    <Text style={styles.amountCode}>{topUpCurrency}</Text>
                  </View>
                  {!!amountError && (
                    <View style={styles.amountErrorRow}>
                      <Ionicons name="information-circle-outline" size={15} color={palette.colors.error} />
                      <Text style={styles.amountErrorText}>{amountError}</Text>
                    </View>
                  )}
                  {!canTopUpSelectedCurrency && wallet?.status !== 'active' && !amountError && (
                    <View style={styles.amountErrorRow}>
                      <Ionicons name="information-circle-outline" size={15} color={palette.colors.error} />
                      <Text style={styles.amountErrorText}>Top-up is unavailable for {topUpCurrency}. Select a currency with an outstanding liability, or contact support if this is not a payment-risk lock.</Text>
                    </View>
                  )}

                  <TouchableOpacity
                    style={[styles.topUpButton, (submitting || !canTopUpSelectedCurrency) && styles.disabled]}
                    onPress={topUp}
                    disabled={submitting || !canTopUpSelectedCurrency}
                    accessibilityRole="button"
                  >
                    <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                    {submitting
                      ? <ActivityIndicator size="small" color="#fff" />
                      : (
                        <>
                          <Ionicons name="lock-closed-outline" size={17} color="#fff" />
                          <Text style={styles.topUpButtonText}>{isRiskSettlement ? 'Pay liability securely' : 'Continue securely'}</Text>
                          <Ionicons name="arrow-forward" size={17} color="#fff" />
                        </>
                      )}
                  </TouchableOpacity>
                  <View style={styles.stripeRow}>
                    <Ionicons name="shield-checkmark-outline" size={13} color={palette.colors.success} />
                    <Text style={styles.stripeText}>Rozare never stores your card details.</Text>
                  </View>
                </GlassPanel>

                <View style={styles.activitySection}>
                  <View style={styles.sectionHeader}>
                    <View>
                      <Text style={styles.sectionEyebrow}>WALLET HISTORY</Text>
                      <Text style={styles.sectionTitle}>Recent activity</Text>
                    </View>
                    <View style={styles.activityCount}>
                      <Text style={styles.activityCountText}>{recentTransactions.length}</Text>
                    </View>
                  </View>

                  {recentTransactions.length === 0 ? (
                    <GlassPanel variant="card" style={styles.emptyState}>
                      <View style={styles.emptyIcon}>
                        <Ionicons name="receipt-outline" size={23} color={palette.colors.primary} />
                      </View>
                      <Text style={styles.emptyTitle}>Nothing here yet</Text>
                      <Text style={styles.emptyText}>Top-ups, order payments, and refunds will appear here.</Text>
                    </GlassPanel>
                  ) : recentTransactions.map((transaction) => {
                    const isCredit = transaction.direction === 'credit';
                    const isCompleted = String(transaction.status || '').toLowerCase() === 'completed';
                    const meta = getTransactionMeta(transaction);
                    const description = transaction.type === 'top_up'
                      ? 'Wallet top-up'
                      : transaction.description || transaction.type?.replace(/_/g, ' ');
                    const amountPrefix = isCompleted ? (isCredit ? '+' : '-') : '';
                    const amountColor = isCompleted
                      ? (isCredit ? palette.colors.success : palette.colors.text)
                      : meta.color;
                    const topUpBreakdown = transaction.type === 'top_up'
                      ? getTopUpCompletionBreakdown(transaction)
                      : null;
                    const displayedAmount = topUpBreakdown?.creditedAmount ?? transaction.amount;
                    return (
                      <GlassPanel key={transaction._id} variant="card" style={styles.transactionCard}>
                        <View style={[styles.transactionIcon, { backgroundColor: meta.tint }]}>
                          <Ionicons name={meta.icon} size={18} color={meta.color} />
                        </View>
                        <View style={styles.transactionCopy}>
                          <Text style={styles.transactionTitle} numberOfLines={1}>{description}</Text>
                          <View style={styles.transactionMetaRow}>
                            <Text style={styles.transactionDate}>{formatActivityDate(transaction.createdAt)}</Text>
                            <View style={styles.metaDot} />
                            <Text style={[styles.transactionStatus, { color: meta.color }]}>{meta.label}</Text>
                          </View>
                          {topUpBreakdown && (
                            <Text style={styles.transactionRiskDetail}>
                              Available +{formatAmount(topUpBreakdown.creditedAmount, { targetCurrency: topUpBreakdown.currency })} · Liability {formatAmount(topUpBreakdown.appliedToLiability, { targetCurrency: topUpBreakdown.currency })} · Remaining {formatAmount(topUpBreakdown.remainingLiability, { targetCurrency: topUpBreakdown.currency })}
                            </Text>
                          )}
                        </View>
                        <Text style={[styles.transactionAmount, { color: amountColor }]}>
                          {amountPrefix}{formatAmount(displayedAmount, { targetCurrency: transaction.currency })}
                        </Text>
                      </GlassPanel>
                    );
                  })}
                </View>
                  </>
                )}
              </>
            )}
          </KeyboardAwareFormScrollView>
        </View>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  headerAction: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxxl },
  loadingCard: { minHeight: 250, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  loadingIcon: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  loadingTitle: { marginTop: spacing.md, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  loadingText: { marginTop: 5, textAlign: 'center', fontSize: fontSize.sm, color: p.colors.textSecondary },
  loadError: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 18,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: p.colors.errorLighter,
  },
  loadErrorIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239,68,68,0.10)' },
  loadErrorCopy: { flex: 1 },
  loadErrorTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  loadErrorText: { marginTop: 2, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  retryButton: { minHeight: 32, justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 10, backgroundColor: 'rgba(239,68,68,0.10)' },
  retryText: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.error },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 17,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  noticeError: { backgroundColor: p.colors.errorSubtle, borderColor: p.colors.errorLighter },
  noticeSuccess: { backgroundColor: p.colors.successSubtle, borderColor: p.colors.successLighter },
  noticeCopy: { flex: 1 },
  noticeTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  noticeText: { marginTop: 2, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  lockedBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 18,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: p.colors.errorLighter,
  },
  lockedIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239,68,68,0.10)' },
  lockedCopy: { flex: 1 },
  lockedTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  lockedText: { marginTop: 3, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  balanceHero: { padding: spacing.lg, marginBottom: spacing.xl },
  balanceTopline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  balanceLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  currencyMark: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  currencyMarkText: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  balanceEyebrow: { fontSize: 9, fontWeight: fontWeight.extrabold, letterSpacing: 1, color: p.colors.textSecondary },
  balanceCurrency: { marginTop: 2, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  securePill: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, borderRadius: 10, backgroundColor: p.colors.successSubtle },
  secureText: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.success },
  heroBalance: { marginTop: spacing.lg, fontSize: 36, lineHeight: 43, fontWeight: fontWeight.extrabold, letterSpacing: -1, color: p.colors.text },
  balanceHint: { marginTop: 3, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  heroCurrencyRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  heroCurrencyChip: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  heroCurrencyChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  heroCurrencyText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  heroCurrencyTextActive: { color: '#fff' },
  balanceOverview: { marginBottom: spacing.xl },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: spacing.xs, marginBottom: spacing.sm },
  sectionEyebrow: { fontSize: 9, fontWeight: fontWeight.extrabold, letterSpacing: 1, color: p.colors.primary },
  sectionTitle: { marginTop: 3, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  sectionMeta: { fontSize: 10, color: p.colors.textSecondary },
  balanceStrip: { gap: spacing.sm, paddingRight: spacing.md },
  balanceCard: { width: 158, minHeight: 112, padding: spacing.md, borderRadius: 18 },
  balanceCardActive: { borderColor: p.colors.primaryLighter, backgroundColor: p.colors.primarySubtle },
  smallCurrencyMark: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  smallCurrencyMarkText: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  balanceCode: { marginTop: spacing.sm, fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  balanceValue: { marginTop: 2, fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  riskAmounts: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle, gap: 3 },
  riskAmountText: { fontSize: 9, lineHeight: 13, color: p.colors.textSecondary },
  topUpSection: { padding: spacing.lg, marginBottom: spacing.xl },
  topUpHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  topUpIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  topUpCopy: { flex: 1 },
  topUpTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  topUpSubtitle: { marginTop: 2, fontSize: 10, color: p.colors.textSecondary },
  inputLabel: { marginBottom: 6, fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  amountInputWrap: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, borderRadius: 16, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  amountInputError: { borderColor: p.colors.errorLighter, backgroundColor: p.colors.errorSubtle },
  amountCurrency: { minWidth: 32, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.primary },
  amountInput: { flex: 1, minWidth: 0, paddingVertical: spacing.sm, fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  amountCode: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  amountErrorRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 7 },
  amountErrorText: { flex: 1, fontSize: 10, color: p.colors.error },
  topUpButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.md, borderRadius: 16, overflow: 'hidden', ...shadows.md },
  topUpButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  disabled: { opacity: 0.55 },
  stripeRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5, marginTop: spacing.sm },
  stripeText: { fontSize: 9, color: p.colors.textSecondary },
  activitySection: { marginBottom: spacing.xl },
  activityCount: { minWidth: 28, height: 26, paddingHorizontal: 7, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  activityCountText: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.primary },
  emptyState: { alignItems: 'center', padding: spacing.xl },
  emptyIcon: { width: 50, height: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  emptyTitle: { marginTop: spacing.md, fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  emptyText: { marginTop: 5, textAlign: 'center', fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  transactionCard: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, marginBottom: spacing.sm, borderRadius: 18 },
  transactionIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  transactionCopy: { flex: 1, minWidth: 0 },
  transactionTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text, textTransform: 'capitalize' },
  transactionMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  transactionDate: { fontSize: 9, color: p.colors.textSecondary },
  metaDot: { width: 3, height: 3, borderRadius: 2, backgroundColor: p.colors.textLight },
  transactionStatus: { fontSize: 9, fontWeight: fontWeight.bold },
  transactionRiskDetail: { marginTop: 5, fontSize: 9, lineHeight: 13, color: p.colors.textSecondary },
  transactionAmount: { maxWidth: 112, textAlign: 'right', fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
});
