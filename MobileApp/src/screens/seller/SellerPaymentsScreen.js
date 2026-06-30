import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import Loader from '../../components/common/Loader';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing, typography } from '../../styles/theme';

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
const MIN_WITHDRAWAL_USD = 5;

const statusColor = (status, palette) => {
  switch (status) {
    case 'paid': return palette.colors.success;
    case 'processing': return palette.colors.info;
    case 'approved': return palette.colors.primary;
    case 'rejected':
    case 'cancelled': return palette.colors.error;
    default: return palette.colors.warning;
  }
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
  const { currency, currencies, convertPrice, convertToUSD, formatPrice } = useCurrency();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [summary, setSummary] = useState(null);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [accountForm, setAccountForm] = useState(defaultAccountForm);
  const [withdrawAmount, setWithdrawAmount] = useState('');

  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get(API_ENDPOINTS.PAYMENTS.SELLER_SUMMARY);
      const next = res.data || {};
      const account = next.paymentAccount;
      setSummary(next);
      setAccountForm({
        ...defaultAccountForm,
        accountHolderName: account?.accountHolderName || '',
        bankName: account?.bankName || '',
        swiftCode: account?.swiftCode || '',
        country: account?.country || '',
        currency: account?.currency || currency || 'USD',
        payoutInstructions: account?.payoutInstructions || '',
        accountNumber: '',
        iban: '',
      });
    } catch (error) {
      Alert.alert('Payments', error.response?.data?.msg || 'Failed to load payments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currency]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchSummary();
  }, [fetchSummary]);

  const revenue = summary?.revenue || {};
  const paymentAccount = summary?.paymentAccount;
  const withdrawals = summary?.withdrawals || [];
  const availableInCurrentCurrency = useMemo(
    () => convertPrice(revenue.withdrawableBalance || 0),
    [convertPrice, revenue.withdrawableBalance]
  );

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
    if (!paymentAccount && !accountForm.accountNumber.trim() && !accountForm.iban.trim()) {
      Alert.alert('Missing info', 'Enter a bank account number or IBAN');
      return;
    }

    setSavingAccount(true);
    try {
      const res = await api.put(API_ENDPOINTS.PAYMENTS.SELLER_ACCOUNT, accountForm);
      Toast.show({ type: 'success', text1: res.data?.msg || 'Payment account saved' });
      setShowAccountForm(false);
      await fetchSummary();
    } catch (error) {
      Alert.alert('Payment account', error.response?.data?.msg || 'Failed to save payment account');
    } finally {
      setSavingAccount(false);
    }
  };

  const requestWithdrawal = async () => {
    if (!paymentAccount) {
      Alert.alert('Payment account required', 'Link your payment account before requesting a withdrawal');
      return;
    }
    if ((revenue.withdrawableBalance || 0) <= 0) {
      Alert.alert('No balance', 'You have zero withdrawable balance right now');
      return;
    }
    if ((revenue.withdrawableBalance || 0) < MIN_WITHDRAWAL_USD) {
      Alert.alert('Minimum withdrawal', `Minimum withdrawal amount is ${formatPrice(MIN_WITHDRAWAL_USD)}`);
      return;
    }
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Invalid amount', 'Enter a withdrawal amount greater than zero');
      return;
    }

    const amountUSD = convertToUSD(amount);
    if (amountUSD < MIN_WITHDRAWAL_USD) {
      Alert.alert('Minimum withdrawal', `Minimum withdrawal amount is ${formatPrice(MIN_WITHDRAWAL_USD)}`);
      return;
    }
    if (amountUSD > (revenue.withdrawableBalance || 0) + 0.01) {
      Alert.alert('Too high', `You can withdraw up to ${formatPrice(revenue.withdrawableBalance || 0)}`);
      return;
    }

    setRequesting(true);
    try {
      await api.post(API_ENDPOINTS.PAYMENTS.SELLER_WITHDRAWALS, {
        amountUSD,
        requestedAmount: amount,
        requestedCurrency: currency,
      });
      Toast.show({ type: 'success', text1: 'Withdrawal request submitted' });
      setWithdrawAmount('');
      await fetchSummary();
    } catch (error) {
      Alert.alert('Withdrawal', error.response?.data?.msg || 'Failed to request withdrawal');
    } finally {
      setRequesting(false);
    }
  };

  if (loading) {
    return (
      <GlassBackground>
        <Loader fullScreen message="Loading payments..." />
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={styles.headerIcon}>
            <Ionicons name="wallet-outline" size={22} color="white" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Payments & Revenue</Text>
            <Text style={styles.subtitle}>Stripe balance, COD revenue, and withdrawals</Text>
          </View>
          <TouchableOpacity style={styles.iconButton} onPress={fetchSummary} activeOpacity={0.8}>
            <Ionicons name="refresh-outline" size={18} color={palette.colors.primary} />
          </TouchableOpacity>
        </GlassPanel>

        <View style={styles.statsGrid}>
          <StatCard styles={styles} icon="wallet-outline" label="Withdrawable" value={formatPrice(revenue.withdrawableBalance || 0)} description="Delivered Stripe orders minus withdrawals" color={palette.colors.success} />
          <StatCard styles={styles} icon="cash-outline" label="Delivered COD" value={formatPrice(revenue.codDeliveredRevenue || 0)} description="Collected directly from buyers" color={palette.colors.warning} />
          <StatCard styles={styles} icon="trending-up-outline" label="Delivered Total" value={formatPrice(revenue.totalDeliveredRevenue || 0)} description="Stripe plus COD delivered revenue" color={palette.colors.primary} />
          <StatCard styles={styles} icon="time-outline" label="Estimated" value={formatPrice(revenue.estimatedRevenue || 0)} description="Delivered plus pending revenue" color={palette.colors.info} />
        </View>

        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Bank Account</Text>
              <Text style={styles.sectionSubtitle}>Used for manual payouts</Text>
            </View>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowAccountForm((value) => !value)} activeOpacity={0.8}>
              <Ionicons name="business-outline" size={14} color={palette.colors.primary} />
              <Text style={styles.secondaryButtonText}>{paymentAccount ? 'Update' : 'Add'}</Text>
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
              <Field styles={styles} label="Account holder name" value={accountForm.accountHolderName} onChangeText={(value) => updateAccountField('accountHolderName', value)} />
              <Field styles={styles} label="Bank name" value={accountForm.bankName} onChangeText={(value) => updateAccountField('bankName', value)} />
              <Field styles={styles} label="Account number" value={accountForm.accountNumber} onChangeText={(value) => updateAccountField('accountNumber', value)} placeholder={paymentAccount?.maskedAccountNumber || 'Enter account number'} keyboardType="number-pad" />
              <Field styles={styles} label="IBAN" value={accountForm.iban} onChangeText={(value) => updateAccountField('iban', value)} placeholder={paymentAccount?.maskedIban || 'Optional IBAN'} autoCapitalize="characters" />
              <Field styles={styles} label="Country" value={accountForm.country} onChangeText={(value) => updateAccountField('country', value)} />
              <Text style={styles.inputLabel}>Payout currency</Text>
              <View style={styles.currencyGrid}>
                {Object.keys(currencies).map((code) => (
                  <TouchableOpacity
                    key={code}
                    style={[styles.currencyChip, accountForm.currency === code && styles.currencyChipActive]}
                    onPress={() => updateAccountField('currency', code)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.currencyChipText, accountForm.currency === code && styles.currencyChipTextActive]}>{code}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Field styles={styles} label="Payout instructions" value={accountForm.payoutInstructions} onChangeText={(value) => updateAccountField('payoutInstructions', value)} placeholder="Optional transfer details" multiline />
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
              <Text style={styles.sectionSubtitle}>Available: {formatPrice(revenue.withdrawableBalance || 0)} - Minimum: {formatPrice(MIN_WITHDRAWAL_USD)}</Text>
            </View>
            <View style={[styles.statIcon, { backgroundColor: `${palette.colors.success}18` }]}>
              <Ionicons name="card-outline" size={20} color={palette.colors.success} />
            </View>
          </View>
          <View style={styles.amountRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputLabel}>Amount in {currency}</Text>
              <TextInput
                style={styles.input}
                value={withdrawAmount}
                onChangeText={setWithdrawAmount}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={palette.colors.textSecondary}
              />
            </View>
            <TouchableOpacity style={styles.fullButton} onPress={() => setWithdrawAmount(availableInCurrentCurrency.toFixed(2))} activeOpacity={0.8}>
              <Text style={styles.fullButtonText}>Full</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[styles.primaryButton, requesting && styles.disabledButton]} onPress={requestWithdrawal} disabled={requesting} activeOpacity={0.85}>
            {requesting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send-outline" size={18} color="#fff" />}
            <Text style={styles.primaryButtonText}>Send withdrawal request</Text>
          </TouchableOpacity>
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Withdrawal History</Text>
          {withdrawals.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="wallet-outline" size={34} color={palette.colors.textSecondary} />
              <Text style={styles.emptyText}>No withdrawal requests yet.</Text>
            </View>
          ) : (
            withdrawals.map((request) => (
              <View key={request._id} style={styles.withdrawalRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.withdrawalAmount}>{formatPrice(request.amount || 0)}</Text>
                  <Text style={styles.withdrawalMeta}>
                    {new Date(request.createdAt).toLocaleDateString()} - {request.paymentAccountSnapshot?.bankName || 'Bank account'}
                  </Text>
                  {!!request.adminNote && <Text style={styles.adminNote}>Admin note: {request.adminNote}</Text>}
                </View>
                <View style={[styles.statusPill, { backgroundColor: `${statusColor(request.status, palette)}18` }]}>
                  <Text style={[styles.statusText, { color: statusColor(request.status, palette) }]}>{request.status || 'pending'}</Text>
                </View>
              </View>
            ))
          )}
        </GlassPanel>
      </ScrollView>
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
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 2 },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  backButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  iconButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  title: { ...typography.h4, color: p.colors.text },
  subtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { width: '48%', padding: spacing.md, minHeight: 142 },
  statIcon: { width: 40, height: 40, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  statValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.sm },
  statLabel: { ...typography.caption, color: p.colors.textSecondary, textTransform: 'uppercase', marginTop: 2 },
  statDescription: { fontSize: 10, color: p.colors.textSecondary, marginTop: spacing.xs, lineHeight: 14 },
  section: { padding: spacing.lg, marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
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
  withdrawalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  withdrawalAmount: { ...typography.bodySemibold, color: p.colors.text },
  withdrawalMeta: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  adminNote: { ...typography.caption, color: p.colors.text, marginTop: spacing.xs },
  statusPill: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { ...typography.caption, fontWeight: fontWeight.bold, textTransform: 'capitalize' },
});
