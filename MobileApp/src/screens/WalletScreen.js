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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Crypto from 'expo-crypto';
import { useStripe } from '@stripe/stripe-react-native';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useCurrency } from '../contexts/CurrencyContext';
import { useAuth } from '../contexts/AuthContext';
import { useStripeConfig } from '../contexts/StripeContext';
import { useTheme } from '../contexts/ThemeContext';
import { fontSize, fontWeight, shadows, spacing, typography } from '../styles/theme';
import {
  assertPaymentSheetPayload,
  buildPaymentSheetOptions,
  normalizePaymentSheetPayload,
  runPaymentSheet,
  verifyWalletTopUp,
} from '../utils/stripePaymentSheet';
import { trackError, trackPaymentEvent } from '../utils/breadcrumbs';

const WALLET_CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];
const CURRENCY_META = {
  USD: { symbol: '$', color: '#2563EB', tint: 'rgba(37,99,235,0.12)' },
  PKR: { symbol: 'Rs', color: '#16A34A', tint: 'rgba(22,163,74,0.12)' },
  EUR: { symbol: '€', color: '#7C3AED', tint: 'rgba(124,58,237,0.12)' },
  GBP: { symbol: '£', color: '#D97706', tint: 'rgba(217,119,6,0.12)' },
};

const getTransactionMeta = (transaction) => {
  const isCredit = transaction.direction === 'credit';
  if (transaction.status === 'failed') {
    return { icon: 'close', color: '#DC2626', tint: 'rgba(239,68,68,0.12)', label: 'Failed' };
  }
  if (transaction.status === 'pending') {
    return { icon: 'time-outline', color: '#D97706', tint: 'rgba(245,158,11,0.12)', label: 'Pending' };
  }
  return isCredit
    ? { icon: 'arrow-down', color: '#16A34A', tint: 'rgba(34,197,94,0.12)', label: 'Received' }
    : { icon: 'arrow-up', color: '#4F46E5', tint: 'rgba(99,102,241,0.12)', label: 'Sent' };
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

export default function WalletScreen({ navigation, route }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);
  const { currentUser } = useAuth();
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
  const topUpAttemptKeyRef = useRef(null);

  const loadWallet = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api.get('/api/wallet/me?limit=100');
      setWallet(response.data?.wallet || null);
      setTransactions(response.data?.transactions || []);
      setLoadError('');
      return response.data;
    } catch (error) {
      setLoadError(error.response?.data?.msg || 'Your Rozare Wallet could not be loaded.');
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadWallet();
    const unsubscribe = navigation.addListener('focus', () => loadWallet({ quiet: true }));
    return unsubscribe;
  }, [loadWallet, navigation]);

  useEffect(() => {
    if (!route.params?.top_up) return undefined;
    if (route.params.top_up === 'success') {
      setNotice({
        type: 'success',
        title: 'Payment received',
        message: 'Your balance will update as soon as Stripe confirms the payment.',
      });
      let cancelled = false;
      const poll = async () => {
        for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
          await loadWallet({ quiet: true });
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (!cancelled) navigation.setParams({ top_up: undefined, session_id: undefined });
      };
      poll();
      return () => { cancelled = true; };
    }
    setNotice({
      type: 'info',
      title: 'Top-up cancelled',
      message: 'No balance was added to your wallet.',
    });
    navigation.setParams({ top_up: undefined });
    return undefined;
  }, [loadWallet, navigation, route.params?.top_up]);

  const selectedBalance = wallet?.balances?.[topUpCurrency] || 0;
  const selectedMeta = CURRENCY_META[topUpCurrency];
  const recentTransactions = useMemo(
    () => [...transactions].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [transactions]
  );

  const topUp = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setAmountError('Enter an amount greater than zero.');
      return;
    }
    if (wallet?.status === 'locked') {
      setAmountError(wallet.lockedReason || 'This wallet is currently locked.');
      return;
    }

    setAmountError('');
    setNotice(null);
    setSubmitting(true);
    try {
      const stripeConfig = await ensureStripeReady();
      trackPaymentEvent('wallet_top_up_started', {
        currency: topUpCurrency,
        googlePayEnabled: !!stripeConfig.googlePayEnabled,
      });
      if (!topUpAttemptKeyRef.current) topUpAttemptKeyRef.current = Crypto.randomUUID();
      const requestKey = topUpAttemptKeyRef.current;
      const response = await api.post('/api/wallet/top-ups', {
        amount: value,
        currency: topUpCurrency,
        platform: 'mobile',
        paymentFlow: 'payment_sheet',
        clientSurface: 'mobile',
        requestKey,
      }, {
        headers: { 'X-Idempotency-Key': requestKey },
      });
      if (response.data?.completed) {
        await loadWallet({ quiet: true });
        topUpAttemptKeyRef.current = null;
        setAmount('');
        setNotice({
          type: 'success',
          title: 'Balance added',
          message: `${formatAmount(value, { targetCurrency: topUpCurrency })} is ready to use.`,
        });
        return;
      }
      const reference = normalizePaymentSheetPayload(response);
      trackPaymentEvent('wallet_top_up_reference_created', {
        hasTopUpId: !!reference.topUpId,
        hasPaymentIntent: !!reference.paymentIntentId,
      });
      if (!reference.topUpId) {
        throw new Error('Rozare did not return a secure top-up reference. Your Wallet has not been credited.');
      }
      const payment = assertPaymentSheetPayload(response, 'payment');
      const sheetResult = await runPaymentSheet({
        initPaymentSheet,
        presentPaymentSheet,
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
      trackPaymentEvent(`wallet_top_up_sheet_${sheetResult.status}`, {
        stage: sheetResult.stage,
        code: sheetResult.error?.code,
      });
      let cancellationError = null;
      if (sheetResult.status !== 'presented') {
        try {
          await api.post(`/api/wallet/top-ups/${encodeURIComponent(reference.topUpId)}/cancel`, {
            paymentIntentId: reference.paymentIntentId,
          });
        } catch (error) {
          cancellationError = error;
        }
      }
      const verification = await verifyWalletTopUp({
        apiClient: api,
        topUpId: reference.topUpId,
        paymentIntentId: reference.paymentIntentId,
        currency: topUpCurrency,
        startingBalance: selectedBalance,
        amount: value,
        attempts: sheetResult.status === 'presented' || cancellationError?.response?.data?.code === 'PAYMENT_ALREADY_SUCCEEDED' ? 8 : 2,
        delayMs: 900,
      });
      if (verification.status === 'paid') {
        await loadWallet({ quiet: true });
        topUpAttemptKeyRef.current = null;
        setAmount('');
        setNotice({
          type: 'success',
          title: 'Balance added',
          message: `${formatAmount(value, { targetCurrency: topUpCurrency })} is ready to use.`,
        });
      } else if (verification.status === 'failed') {
        topUpAttemptKeyRef.current = null;
        setNotice({
          type: 'error',
          title: 'Top-up was not completed',
          message: 'Stripe did not complete this payment. Your wallet was not credited.',
        });
      } else if (verification.status === 'cancelled') {
        topUpAttemptKeyRef.current = null;
        setNotice({
          type: 'info',
          title: 'Top-up cancelled',
          message: 'Rozare confirmed that this payment attempt is closed. Your Wallet was not credited.',
        });
      } else if (sheetResult.status === 'failed') {
        setNotice({
          type: 'error',
          title: 'Top-up could not be completed',
          message: sheetResult.error?.localizedMessage || sheetResult.error?.message || 'The secure payment attempt could not be completed.',
        });
      } else if (sheetResult.status === 'cancelled') {
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
      setNotice({
        type: 'error',
        title: 'Top-up could not be completed',
        message: error.response?.data?.msg || error.message || 'Please try again in a moment.',
      });
    } finally {
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
        <KeyboardAvoidingView
          style={styles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          {header}
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
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

                {(!loadError || wallet) && (
                  <>
                {wallet?.status === 'locked' && (
                  <View style={styles.lockedBanner}>
                    <View style={styles.lockedIcon}>
                      <Ionicons name="lock-closed-outline" size={19} color={palette.colors.error} />
                    </View>
                    <View style={styles.lockedCopy}>
                      <Text style={styles.lockedTitle}>Wallet temporarily locked</Text>
                      <Text style={styles.lockedText}>{wallet.lockedReason || 'Contact support for help.'}</Text>
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
                            <Text style={styles.balanceCode}>{code}</Text>
                            <Text style={styles.balanceValue} numberOfLines={1} adjustsFontSizeToFit>
                              {formatAmount(wallet?.balances?.[code] || 0, { targetCurrency: code })}
                            </Text>
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
                      <Text style={styles.topUpTitle}>Add {topUpCurrency} balance</Text>
                      <Text style={styles.topUpSubtitle}>Complete a secure Stripe card payment.</Text>
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

                  <TouchableOpacity
                    style={[styles.topUpButton, (submitting || wallet?.status === 'locked') && styles.disabled]}
                    onPress={topUp}
                    disabled={submitting || wallet?.status === 'locked'}
                    accessibilityRole="button"
                  >
                    <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                    {submitting
                      ? <ActivityIndicator size="small" color="#fff" />
                      : (
                        <>
                          <Ionicons name="lock-closed-outline" size={17} color="#fff" />
                          <Text style={styles.topUpButtonText}>Continue securely</Text>
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
                    const meta = getTransactionMeta(transaction);
                    const description = transaction.type === 'top_up'
                      ? 'Wallet top-up'
                      : transaction.description || transaction.type?.replace(/_/g, ' ');
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
                        </View>
                        <Text style={[styles.transactionAmount, { color: isCredit ? palette.colors.success : palette.colors.text }]}>
                          {isCredit ? '+' : '-'}{formatAmount(transaction.amount || 0, { targetCurrency: transaction.currency })}
                        </Text>
                      </GlassPanel>
                    );
                  })}
                </View>
                  </>
                )}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
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
  balanceCard: { width: 142, minHeight: 112, padding: spacing.md, borderRadius: 18 },
  balanceCardActive: { borderColor: p.colors.primaryLighter, backgroundColor: p.colors.primarySubtle },
  smallCurrencyMark: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  smallCurrencyMarkText: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  balanceCode: { marginTop: spacing.sm, fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  balanceValue: { marginTop: 2, fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
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
  transactionAmount: { maxWidth: 112, textAlign: 'right', fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
});
