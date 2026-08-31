import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
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
import Feedback from '../../utils/feedback';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import {
  SellerEmptyState,
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, shadows, spacing, typography } from '../../styles/theme';
import {
  toCurrencyMinorUnits,
} from '../../utils/currencySafety';
import {
  clearPersistedMutationAttemptFromLedger,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttemptInLedger,
} from '../../utils/persistedMutationAttempt';
import {
  exactCurrencyCode,
  isExactNonNegativeJsonMoney,
  parseExactMoneyInput,
  selectWithdrawalHistoryMoney,
  shouldRetainWithdrawalAttempt,
  withdrawalNeedsLiveFx,
} from '../../utils/sellerMoneySafety';
import { inspectSellerProductCurrencyState } from '../../utils/productCurrencyState';

const WITHDRAWAL_ATTEMPT_STORAGE_KEY = 'rozare_seller_withdrawal_attempt_v1';

const defaultAccountForm = {
  accountHolderName: '',
  bankName: '',
  accountNumber: '',
  iban: '',
  swiftCode: '',
  country: '',
  currency: 'USD',
  payoutInstructions: '',
};
const REQUIRED_DISPLAY_REVENUE_FIELDS = [
  'withdrawableBalance',
  'onlineDeliveredRevenue',
  'codDeliveredRevenue',
  'totalDeliveredRevenue',
  'estimatedRevenue',
  'stripeDeliveredRevenue',
  'walletDeliveredRevenue',
  'onlinePendingRevenue',
  'pendingWithdrawalAmount',
  'processingWithdrawalAmount',
  'totalWithdrawn',
  'returnRefundDebits',
  'codPendingRevenue',
];

const statusColor = (status, palette) => {
  switch (status) {
    case 'paid': return palette.colors.success;
    case 'processing': return palette.colors.info;
    case 'approved': return palette.colors.primary;
    case 'manual_review': return palette.colors.warning;
    case 'failed':
    case 'rejected':
    case 'cancelled': return palette.colors.error;
    default: return palette.colors.warning;
  }
};

const statusLabels = {
  manual_review: 'Manual review',
  failed: 'Failed',
};

const statusDescriptions = {
  manual_review: 'Funds remain reserved while the payout outcome is reviewed.',
  failed: 'The payout was not sent and the reserved funds were released.',
};

const StatCard = ({ icon, label, value, description, color, styles }) => (
  <GlassPanel variant="card" style={styles.statCard}>
    <View style={[styles.statIcon, { backgroundColor: `${color}18` }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
    {!!description && <Text style={styles.statDescription}>{description}</Text>}
  </GlassPanel>
);

export default function SellerPaymentsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const { currencies, formatAmount } = useCurrency();
  const { currentUser } = useAuth();
  const withdrawalAttemptStorageKey = createScopedMutationStorageKey(
    WITHDRAWAL_ATTEMPT_STORAGE_KEY,
    currentUser?._id || currentUser?.id || 'guest'
  );

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [summary, setSummary] = useState(null);
  const [sellerCurrency, setSellerCurrency] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [accountForm, setAccountForm] = useState(defaultAccountForm);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const summaryRef = useRef(null);
  const summaryRequestRef = useRef({ id: 0, controller: null });
  const withdrawalSubmissionRef = useRef(false);
  const activeWithdrawalAttemptRef = useRef(null);
  const withdrawalAttemptResetRef = useRef(Promise.resolve());

  const retireActiveWithdrawalAttempt = useCallback(() => {
    const attempt = activeWithdrawalAttemptRef.current;
    if (!attempt) return withdrawalAttemptResetRef.current;
    activeWithdrawalAttemptRef.current = null;
    const reset = withdrawalAttemptResetRef.current
      .catch(() => undefined)
      .then(() => clearPersistedMutationAttemptFromLedger(
        AsyncStorage,
        attempt.storageKey,
        attempt.fingerprint,
        attempt.key,
      ));
    withdrawalAttemptResetRef.current = reset;
    return reset;
  }, []);

  const updateWithdrawAmount = (value) => {
    if (value !== withdrawAmount) void retireActiveWithdrawalAttempt();
    setWithdrawAmount(value);
  };

  useEffect(() => {
    void retireActiveWithdrawalAttempt();
    setWithdrawAmount('');
  }, [sellerCurrency, retireActiveWithdrawalAttempt]);

  const fetchSummary = useCallback(async () => {
    const requestId = summaryRequestRef.current.id + 1;
    summaryRequestRef.current.controller?.abort();
    const controller = new AbortController();
    summaryRequestRef.current = { id: requestId, controller };
    summaryRef.current = null;
    setSummary(null);
    setSellerCurrency(null);
    setLoadError('');
    setLoading(true);
    setRefreshing(true);
    try {
      const productCurrencyResponse = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY, {
        signal: controller.signal,
      });
      if (summaryRequestRef.current.id !== requestId) return;
      const productCurrencyState = inspectSellerProductCurrencyState(
        productCurrencyResponse.data?.productCurrency
      );
      if (!productCurrencyState.valid || productCurrencyState.hasStore !== true) {
        throw new Error('Your store product currency could not be verified. Please retry.');
      }
      const requestCurrency = productCurrencyState.activeCurrency;
      const res = await api.get(
        `${API_ENDPOINTS.PAYMENTS.SELLER_SUMMARY}?currency=${encodeURIComponent(requestCurrency)}`,
        { signal: controller.signal }
      );
      if (summaryRequestRef.current.id !== requestId) return;
      const next = res.data || {};
      const responseCurrency = exactCurrencyCode(next.displayCurrency);
      if (responseCurrency !== requestCurrency) {
        throw new Error('Payment summary returned in an unexpected currency. Please retry.');
      }
      const displayRevenue = next.displayRevenue || {};
      const limits = next.withdrawalLimits || {};
      const account = next.paymentAccount;
      const completeMoneySummary = REQUIRED_DISPLAY_REVENUE_FIELDS.every((field) => (
        isExactNonNegativeJsonMoney(displayRevenue[field])
      )) && isExactNonNegativeJsonMoney(limits.availableDisplayAmount)
        && isExactNonNegativeJsonMoney(limits.minimumDisplayAmount)
        && isExactNonNegativeJsonMoney(limits.availableUSD)
        && isExactNonNegativeJsonMoney(limits.minimumUSD)
        && exactCurrencyCode(limits.displayCurrency) === requestCurrency
        && exactCurrencyCode(limits.baseCurrency) === 'USD'
        && typeof next.exchangeRateStatus?.fallback === 'boolean'
        && Array.isArray(next.withdrawals)
        && (!account || exactCurrencyCode(account.currency) !== null);
      if (!completeMoneySummary) {
        throw new Error('Payment summary did not include complete authoritative money totals.');
      }
      const normalizedNext = { ...next, displayCurrency: responseCurrency };
      summaryRef.current = normalizedNext;
      setSellerCurrency(requestCurrency);
      setSummary(normalizedNext);
      setLoadError('');
      setAccountForm({
        ...defaultAccountForm,
        accountHolderName: account?.accountHolderName || '',
        bankName: account?.bankName || '',
        swiftCode: account?.swiftCode || '',
        country: account?.country || '',
        currency: account?.currency || requestCurrency,
        payoutInstructions: account?.payoutInstructions || '',
        accountNumber: '',
        iban: '',
      });
    } catch (error) {
      if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') return;
      if (summaryRequestRef.current.id !== requestId) return;
      setLoadError(error.response?.data?.msg || error.message || 'We could not load your live payment summary.');
    } finally {
      if (summaryRequestRef.current.id === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchSummary();
    return () => {
      summaryRequestRef.current.id += 1;
      summaryRequestRef.current.controller?.abort();
    };
  }, [fetchSummary]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchSummary();
  }, [fetchSummary]);

  const summaryMatchesCurrency = Boolean(summary)
    && Boolean(sellerCurrency)
    && String(summary.displayCurrency).toUpperCase() === sellerCurrency;
  const activeSummary = summaryMatchesCurrency ? summary : null;
  const displayRevenue = activeSummary?.displayRevenue || {};
  const displayValue = (field) => displayRevenue[field];
  const withdrawalLimits = activeSummary?.withdrawalLimits || {};
  const paymentAccount = activeSummary?.paymentAccount;
  const exchangeRatesAreFallback = activeSummary?.exchangeRateStatus?.fallback !== false;
  const withdrawalRequiresLiveFx = withdrawalNeedsLiveFx(sellerCurrency, paymentAccount?.currency);
  const withdrawalBlockedByFallback = exchangeRatesAreFallback && withdrawalRequiresLiveFx;
  const displayMoneyIsApproximate = exchangeRatesAreFallback && sellerCurrency !== 'USD';
  const formatDisplayMoney = (amount) => `${displayMoneyIsApproximate ? '≈' : ''}${formatAmount(amount, { targetCurrency: sellerCurrency })}`;
  const withdrawals = activeSummary?.withdrawals || [];
  const availableInCurrentCurrency = withdrawalLimits.availableDisplayAmount;
  const minimumWithdrawalInCurrentCurrency = withdrawalLimits.minimumDisplayAmount;
  const withdrawalInput = parseExactMoneyInput(withdrawAmount, { allowZero: false });
  const withdrawalInputError = withdrawAmount && !withdrawalInput
    ? 'Enter a positive amount with no more than 2 decimal places.'
    : '';

  const updateAccountField = (field, value) => {
    setAccountForm((previous) => ({ ...previous, [field]: value }));
  };

  const saveAccount = async () => {
    if (!accountForm.accountHolderName.trim()) {
      Alert.alert('Missing info', 'Account holder name is required');
      return;
    }
    if (!accountForm.bankName.trim()) {
      Alert.alert('Missing info', 'Bank name is required');
      return;
    }
    if (!accountForm.country.trim()) {
      Alert.alert('Missing info', 'Payout bank country is required');
      return;
    }
    if (!paymentAccount && !accountForm.accountNumber.trim() && !accountForm.iban.trim()) {
      Alert.alert('Missing info', 'Enter a bank account number or IBAN');
      return;
    }

    setSavingAccount(true);
    try {
      const res = await api.put(API_ENDPOINTS.PAYMENTS.SELLER_ACCOUNT, accountForm);
      Feedback.show({ type: 'success', text1: res.data?.msg || 'Payment account saved' });
      setShowAccountForm(false);
      await fetchSummary();
    } catch (error) {
      Alert.alert('Payment account', error.response?.data?.msg || 'Failed to save payment account');
    } finally {
      setSavingAccount(false);
    }
  };

  const requestWithdrawal = async () => {
    if (withdrawalSubmissionRef.current || requesting) return;
    if (!activeSummary || refreshing) {
      Alert.alert('Refresh required', 'Refresh the live payment summary before requesting a withdrawal.');
      return;
    }
    if (withdrawalBlockedByFallback) {
      Alert.alert('Live rates unavailable', 'Refresh and retry before requesting a withdrawal.');
      return;
    }
    if (!paymentAccount) {
      Alert.alert('Payment account required', 'Link your payment account before requesting a withdrawal');
      return;
    }
    if (toCurrencyMinorUnits(availableInCurrentCurrency) <= 0) {
      Alert.alert('No balance', 'You have zero withdrawable balance right now');
      return;
    }
    if (toCurrencyMinorUnits(availableInCurrentCurrency) < toCurrencyMinorUnits(minimumWithdrawalInCurrentCurrency)) {
      Alert.alert('Minimum withdrawal', `Minimum withdrawal amount is ${formatDisplayMoney(minimumWithdrawalInCurrentCurrency)}`);
      return;
    }
    if (!withdrawalInput) {
      Alert.alert('Invalid amount', 'Enter a positive withdrawal amount with no more than 2 decimal places.');
      return;
    }
    const amount = withdrawalInput.amount;

    if (toCurrencyMinorUnits(amount) < toCurrencyMinorUnits(minimumWithdrawalInCurrentCurrency)) {
      Alert.alert('Minimum withdrawal', `Minimum withdrawal amount is ${formatDisplayMoney(minimumWithdrawalInCurrentCurrency)}`);
      return;
    }
    if (toCurrencyMinorUnits(amount) > toCurrencyMinorUnits(availableInCurrentCurrency)) {
      Alert.alert('Too high', `You can withdraw up to ${formatDisplayMoney(availableInCurrentCurrency)}`);
      return;
    }

    withdrawalSubmissionRef.current = true;
    setRequesting(true);
    const fingerprint = `${currentUser?._id || currentUser?.id || 'guest'}:${sellerCurrency}:${amount.toFixed(2)}`;
    let attemptKey = '';
    try {
      await withdrawalAttemptResetRef.current;
      const attempt = await getOrCreatePersistedMutationAttemptInLedger({
        storage: AsyncStorage,
        storageKey: withdrawalAttemptStorageKey,
        fingerprint,
        keyPrefix: 'seller-withdrawal',
      });
      attemptKey = attempt.key;
      activeWithdrawalAttemptRef.current = {
        fingerprint,
        key: attempt.key,
        storageKey: withdrawalAttemptStorageKey,
      };
      await api.post(API_ENDPOINTS.PAYMENTS.SELLER_WITHDRAWALS, {
        amount,
        currency: sellerCurrency,
      }, {
        headers: { 'Idempotency-Key': attempt.key },
      });
      await retireActiveWithdrawalAttempt();
      Feedback.show({ type: 'success', text1: 'Withdrawal request submitted' });
      setWithdrawAmount('');
      await fetchSummary();
    } catch (error) {
      if (!shouldRetainWithdrawalAttempt(error) && attemptKey) {
        await retireActiveWithdrawalAttempt();
      }
      Alert.alert('Withdrawal', error.response?.data?.msg || 'Failed to request withdrawal');
    } finally {
      withdrawalSubmissionRef.current = false;
      setRequesting(false);
    }
  };

  if (loading || (!loadError && summary && !summaryMatchesCurrency)) {
    return <SellerScreenSkeleton navigation={navigation} title="Payments & Revenue" subtitle="Loading balances and payouts" icon="wallet-outline" variant="dashboard" />;
  }

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Payments & Revenue"
          subtitle="Balances, payout account, and withdrawals"
          icon="wallet-outline"
          rightIcon="refresh-outline"
          rightLabel="Refresh"
          onRightPress={fetchSummary}
        />
        <KeyboardAwareFormScrollView
          contentContainerStyle={styles.scroll}
          bottomOffset={32}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
          keyboardShouldPersistTaps="handled"
        >
        {!!loadError && (
          <SellerInlineError
            compact
            title="Payment summary unavailable"
            message={loadError}
            onRetry={fetchSummary}
          />
        )}

        {!!activeSummary && (
        <>
        {exchangeRatesAreFallback && (
          <View style={styles.warningBox}>
            <Ionicons name="alert-circle-outline" size={18} color={palette.colors.warning} />
            <Text style={styles.warningText}>
              {withdrawalBlockedByFallback
                ? 'Live FX is temporarily unavailable. Cross-currency totals are estimates and this withdrawal needs a conversion, so it is paused until rates refresh.'
                : 'Live FX is temporarily unavailable. This USD-to-USD withdrawal does not require conversion and remains available.'}
            </Text>
          </View>
        )}
        <GlassPanel variant="strong" style={styles.hero}>
          <LinearGradient
            colors={['rgba(99,102,241,0.22)', 'rgba(14,165,233,0.10)', 'rgba(16,185,129,0.12)']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={styles.heroIcon}><Ionicons name="wallet" size={24} color="#fff" /></View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroEyebrow}>AVAILABLE TO WITHDRAW</Text>
            <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>{formatDisplayMoney(displayValue('withdrawableBalance'))}</Text>
            <Text style={styles.heroText}>Delivered card and Rozare Wallet revenue after payout reservations and return-refund debits.</Text>
          </View>
        </GlassPanel>

        <View style={styles.statsGrid}>
          <StatCard styles={styles} icon="card-outline" label="Online delivered" value={formatDisplayMoney(displayValue('onlineDeliveredRevenue'))} description="Delivered card and Wallet revenue" color={palette.colors.success} />
          <StatCard styles={styles} icon="cash-outline" label="Delivered COD" value={formatDisplayMoney(displayValue('codDeliveredRevenue'))} description="Collected directly from buyers" color={palette.colors.warning} />
          <StatCard styles={styles} icon="trending-up-outline" label="Delivered Total" value={formatDisplayMoney(displayValue('totalDeliveredRevenue'))} description="Delivered card, Wallet, and COD revenue" color={palette.colors.primary} />
          <StatCard styles={styles} icon="time-outline" label="Estimated" value={formatDisplayMoney(displayValue('estimatedRevenue'))} description="Delivered plus pending revenue" color={palette.colors.info} />
        </View>

        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionHeading}>
              <SellerSectionHeader title="Payout account" subtitle="Where approved withdrawals are sent" icon="business-outline" />
            </View>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowAccountForm((value) => !value)} activeOpacity={0.8}>
              <Ionicons name="business-outline" size={14} color={palette.colors.primary} />
              <Text style={styles.secondaryButtonText}>{showAccountForm ? 'Hide' : paymentAccount ? 'Update' : 'Add'}</Text>
            </TouchableOpacity>
          </View>

          {paymentAccount ? (
            <View style={styles.linkedAccount}>
              <View style={styles.successIcon}><Ionicons name="checkmark" size={16} color="white" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.accountTitle}>{paymentAccount.bankName || 'Bank account'}</Text>
                <Text style={styles.accountText}>
                  {paymentAccount.accountHolderName || 'Account holder'}
                  {paymentAccount.maskedAccountNumber ? ` - ${paymentAccount.maskedAccountNumber}` : ''}
                  {paymentAccount.maskedIban ? ` - IBAN ${paymentAccount.maskedIban}` : ''}
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.warningBox}>
              <Ionicons name="alert-circle-outline" size={18} color={palette.colors.warning} />
              <Text style={styles.warningText}>Add a bank account before requesting withdrawals.</Text>
            </View>
          )}

          {showAccountForm && (
            <View style={styles.form}>
              <Field styles={styles} label="Account holder name" value={accountForm.accountHolderName} onChangeText={(value) => updateAccountField('accountHolderName', value)} maxLength={120} accessibilityLabel="Account holder name" />
              <Field styles={styles} label="Bank name" value={accountForm.bankName} onChangeText={(value) => updateAccountField('bankName', value)} maxLength={120} accessibilityLabel="Bank name" />
              <Field styles={styles} label="Account number" value={accountForm.accountNumber} onChangeText={(value) => updateAccountField('accountNumber', value)} placeholder={paymentAccount?.maskedAccountNumber || 'Enter account number'} maxLength={80} accessibilityLabel="Bank account number" />
              <Field styles={styles} label="IBAN" value={accountForm.iban} onChangeText={(value) => updateAccountField('iban', value.toUpperCase())} placeholder={paymentAccount?.maskedIban || 'Optional IBAN'} maxLength={80} autoCapitalize="characters" accessibilityLabel="IBAN" />
              <Field styles={styles} label="SWIFT / BIC" value={accountForm.swiftCode} onChangeText={(value) => updateAccountField('swiftCode', value.toUpperCase())} placeholder="Optional 8 or 11 character code" maxLength={20} autoCapitalize="characters" accessibilityLabel="SWIFT or BIC code" />
              <Field styles={styles} label="Payout bank country" value={accountForm.country} onChangeText={(value) => updateAccountField('country', value)} placeholder="Pakistan" maxLength={80} accessibilityLabel="Payout bank country" />
              <Text style={styles.inputLabel}>Payout currency</Text>
              <View style={styles.currencyGrid}>
                {Object.keys(currencies).map((code) => (
                  <TouchableOpacity
                    key={code}
                    style={[styles.currencyChip, accountForm.currency === code && styles.currencyChipActive]}
                    onPress={() => updateAccountField('currency', code)}
                    activeOpacity={0.8}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: accountForm.currency === code }}
                    accessibilityLabel={`Payout currency ${code}`}
                  >
                    <Text style={[styles.currencyChipText, accountForm.currency === code && styles.currencyChipTextActive]}>{code}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Field styles={styles} label="Payout instructions" value={accountForm.payoutInstructions} onChangeText={(value) => updateAccountField('payoutInstructions', value)} placeholder="Optional transfer details" maxLength={500} multiline accessibilityLabel="Payout instructions" />
              <TouchableOpacity style={[styles.primaryButton, savingAccount && styles.disabledButton]} onPress={saveAccount} disabled={savingAccount} activeOpacity={0.85}>
                {savingAccount ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
                <Text style={styles.primaryButtonText}>Save payment account</Text>
              </TouchableOpacity>
            </View>
          )}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Request Withdrawal</Text>
              <Text style={styles.sectionSubtitle}>Available: {formatDisplayMoney(availableInCurrentCurrency)} - Minimum: {formatDisplayMoney(minimumWithdrawalInCurrentCurrency)}</Text>
            </View>
            <View style={[styles.statIcon, { backgroundColor: `${palette.colors.success}18` }]}>
              <Ionicons name="card-outline" size={20} color={palette.colors.success} />
            </View>
          </View>
          <View style={styles.amountRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Amount in {sellerCurrency}</Text>
              <TextInput
                style={[styles.input, !!withdrawalInputError && styles.inputInvalid]}
                value={withdrawAmount}
                onChangeText={updateWithdrawAmount}
                editable={!requesting && !withdrawalBlockedByFallback && !refreshing}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={palette.colors.textSecondary}
                accessibilityLabel={`Withdrawal amount in ${sellerCurrency}`}
              />
              {!!withdrawalInputError && <Text style={styles.fieldError}>{withdrawalInputError}</Text>}
            </View>
            <TouchableOpacity style={[styles.fullButton, (requesting || withdrawalBlockedByFallback || refreshing) && styles.disabledButton]} disabled={requesting || withdrawalBlockedByFallback || refreshing} onPress={() => updateWithdrawAmount(availableInCurrentCurrency.toFixed(2))} activeOpacity={0.8}>
              <Text style={styles.fullButtonText}>Full</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[styles.primaryButton, (requesting || !paymentAccount || withdrawalBlockedByFallback || refreshing || !withdrawalInput) && styles.disabledButton]} onPress={requestWithdrawal} disabled={requesting || !paymentAccount || withdrawalBlockedByFallback || refreshing || !withdrawalInput} activeOpacity={0.85} accessibilityRole="button">
            {requesting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send-outline" size={18} color="#fff" />}
            <Text style={styles.primaryButtonText}>Send withdrawal request</Text>
          </TouchableOpacity>
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <SellerSectionHeader title="Balance details" subtitle="How your available amount is calculated" icon="calculator-outline" />
          {[
            ['Card delivered revenue', displayValue('stripeDeliveredRevenue'), 'card-outline'],
            ['Wallet delivered revenue', displayValue('walletDeliveredRevenue'), 'wallet-outline'],
            ['Pending online estimate', displayValue('onlinePendingRevenue'), 'hourglass-outline'],
            ['Pending withdrawals', displayValue('pendingWithdrawalAmount'), 'paper-plane-outline'],
            ['Processing withdrawals', displayValue('processingWithdrawalAmount'), 'sync-outline'],
            ['Paid out', displayValue('totalWithdrawn'), 'checkmark-done-outline'],
            ['Return-refund reserve', displayValue('returnRefundDebits'), 'return-down-back-outline'],
            ['Pending COD estimate', displayValue('codPendingRevenue'), 'cash-outline'],
          ].map(([label, amount, icon], index, rows) => (
            <View key={label} style={[styles.balanceRow, index === rows.length - 1 && styles.lastRow]}>
              <View style={styles.balanceLabelRow}>
                <Ionicons name={icon} size={16} color={palette.colors.textSecondary} />
                <Text style={styles.balanceLabel}>{label}</Text>
              </View>
              <Text style={styles.balanceValue}>{formatDisplayMoney(amount)}</Text>
            </View>
          ))}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <SellerSectionHeader title="Withdrawal history" subtitle="Every request and its current review status" icon="receipt-outline" />
          {withdrawals.length === 0 ? (
            <SellerEmptyState icon="wallet-outline" title="No withdrawals yet" message="Your first request will appear here with live status updates." />
          ) : (
            withdrawals.map((request) => {
              const money = selectWithdrawalHistoryMoney(request);
              return (
                <View key={request._id} style={styles.withdrawalRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.withdrawalAmount}>
                      {money.requested
                        ? `Requested: ${formatAmount(money.requested.amount, { targetCurrency: money.requested.currency, showCode: true })}`
                        : 'Requested amount: Unavailable'}
                    </Text>
                    <Text style={styles.withdrawalMeta}>
                      {new Date(request.createdAt).toLocaleDateString()} · {request.paymentAccountSnapshot?.bankName || 'Bank account'}
                      {request.paymentAccountSnapshot?.accountNumberLast4 ? ` · •••• ${request.paymentAccountSnapshot.accountNumberLast4}` : ''}
                    </Text>
                    {money.status === 'unavailable' && (
                      <Text style={[styles.requestedAmount, styles.unavailableAmount]}>Expected bank payout: Unavailable</Text>
                    )}
                    {money.showPayout && money.payout && (
                      <Text style={styles.requestedAmount}>
                        Expected bank payout: {formatAmount(money.payout.amount, { targetCurrency: money.payout.currency, showCode: true })}
                      </Text>
                    )}
                    {money.status === 'legacy' && (
                      <Text style={styles.requestedAmount}>Legacy request: expected bank payout was not frozen.</Text>
                    )}
                    {!!statusDescriptions[request.status] && (
                      <Text style={styles.withdrawalStatusDescription}>{statusDescriptions[request.status]}</Text>
                    )}
                    {!!request.adminNote && <Text style={styles.adminNote}>Admin note: {request.adminNote}</Text>}
                  </View>
                  <View style={[styles.statusPill, { backgroundColor: `${statusColor(request.status, palette)}18` }]}>
                    <Text style={[styles.statusText, { color: statusColor(request.status, palette) }]}>{statusLabels[request.status] || request.status || 'pending'}</Text>
                  </View>
                </View>
              );
            })
          )}
        </GlassPanel>
        </>
        )}
      </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const Field = ({ styles, label, multiline = false, ...props }) => (
  <View style={styles.field}>
    <Text style={styles.inputLabel}>{label}</Text>
    <TextInput
      style={[styles.input, multiline && styles.textArea]}
      placeholderTextColor="rgba(148,163,184,0.85)"
      multiline={multiline}
      {...props}
    />
  </View>
);

const makeStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxl * 2 },
  hero: { minHeight: 142, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, overflow: 'hidden', padding: spacing.xl, marginBottom: spacing.md },
  heroIcon: { width: 56, height: 56, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, borderWidth: 1, borderColor: 'rgba(255,255,255,0.55)', ...shadows.md },
  heroCopy: { flex: 1, minWidth: 0 },
  heroEyebrow: { fontSize: 9, letterSpacing: 0.9, fontWeight: fontWeight.extrabold, color: p.colors.primary },
  heroValue: { marginTop: 3, fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  heroText: { marginTop: 4, ...typography.caption, color: p.colors.textSecondary, lineHeight: 17 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { minWidth: 142, flexBasis: '47%', flexGrow: 1, padding: spacing.md, minHeight: 142 },
  statIcon: { width: 40, height: 40, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  statValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.sm },
  statLabel: { ...typography.caption, color: p.colors.textSecondary, textTransform: 'uppercase', marginTop: 2 },
  statDescription: { fontSize: 10, color: p.colors.textSecondary, marginTop: spacing.xs, lineHeight: 14 },
  section: { padding: spacing.lg, marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.md },
  sectionHeading: { flex: 1, minWidth: 0 },
  sectionTitle: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.lg },
  sectionSubtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  linkedAccount: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.lg, padding: spacing.md },
  successIcon: { width: 30, height: 30, borderRadius: 15, backgroundColor: p.colors.success, justifyContent: 'center', alignItems: 'center' },
  accountTitle: { ...typography.bodySemibold, color: p.colors.text },
  accountText: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  warningBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: `${p.colors.warning}12`, borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: `${p.colors.warning}25` },
  warningText: { ...typography.bodySmall, color: p.colors.text, flex: 1 },
  form: { marginTop: spacing.md, gap: spacing.sm },
  field: { gap: spacing.xs },
  inputLabel: { ...typography.caption, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, textTransform: 'uppercase' },
  input: { minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, paddingHorizontal: spacing.md, color: p.colors.text, fontSize: fontSize.md },
  inputInvalid: { borderColor: p.colors.error },
  fieldError: { ...typography.caption, color: p.colors.error, marginTop: spacing.xs },
  textArea: { minHeight: 92, paddingTop: spacing.md, textAlignVertical: 'top' },
  currencyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  currencyChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, borderWidth: 1, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle },
  currencyChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  currencyChipText: { ...typography.bodySmall, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  currencyChipTextActive: { color: 'white' },
  secondaryButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  secondaryButtonText: { ...typography.bodySmall, color: p.colors.primary, fontWeight: fontWeight.semibold },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, marginTop: spacing.md },
  primaryButtonText: { ...typography.bodySemibold, color: 'white' },
  disabledButton: { opacity: 0.65 },
  amountRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  fullButton: { height: 48, paddingHorizontal: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, justifyContent: 'center' },
  fullButtonText: { ...typography.bodySemibold, color: p.colors.primary },
  emptyState: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyText: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: spacing.sm },
  balanceRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  lastRow: { borderBottomWidth: 0 },
  balanceLabelRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  balanceLabel: { ...typography.bodySmall, color: p.colors.textSecondary },
  balanceValue: { ...typography.bodySemibold, color: p.colors.text },
  withdrawalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  withdrawalAmount: { ...typography.bodySemibold, color: p.colors.text },
  withdrawalMeta: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  requestedAmount: { ...typography.caption, color: p.colors.primary, marginTop: 3 },
  unavailableAmount: { color: p.colors.error },
  withdrawalStatusDescription: { ...typography.caption, color: p.colors.textSecondary, marginTop: spacing.xs, lineHeight: 17 },
  adminNote: { ...typography.caption, color: p.colors.text, marginTop: spacing.xs },
  statusPill: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { ...typography.caption, fontWeight: fontWeight.bold, textTransform: 'capitalize' },
});
