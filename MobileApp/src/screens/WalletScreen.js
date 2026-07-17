import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import Loader from '../components/common/Loader';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTheme } from '../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing, typography } from '../styles/theme';

const WALLET_CURRENCIES = ['USD', 'PKR', 'EUR', 'GBP'];

export default function WalletScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currency, formatAmount } = useCurrency();
  const [wallet, setWallet] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [topUpCurrency, setTopUpCurrency] = useState(
    WALLET_CURRENCIES.includes(currency) ? currency : 'USD'
  );
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadWallet = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api.get('/api/wallet/me?limit=100');
      setWallet(response.data?.wallet || null);
      setTransactions(response.data?.transactions || []);
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Wallet unavailable',
        text2: error.response?.data?.msg || 'Failed to load your Rozare Wallet.',
      });
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
    if (!route.params?.top_up) return;
    if (route.params.top_up === 'success') {
      Toast.show({ type: 'success', text1: 'Payment received', text2: 'Your wallet balance will refresh after Stripe confirms it.' });
      let cancelled = false;
      const poll = async () => {
        for (let attempt = 0; attempt < 10 && !cancelled; attempt += 1) {
          await loadWallet({ quiet: true });
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
        if (!cancelled) navigation.setParams({ top_up: undefined, session_id: undefined });
      };
      poll();
      return () => { cancelled = true; };
    }
    Toast.show({ type: 'info', text1: 'Top-up cancelled', text2: 'No wallet balance was added.' });
    navigation.setParams({ top_up: undefined });
  }, [loadWallet, navigation, route.params?.top_up]);

  const topUp = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      Toast.show({ type: 'error', text1: 'Enter a valid amount' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await api.post('/api/wallet/top-ups', {
        amount: value,
        currency: topUpCurrency,
        platform: 'mobile',
        requestKey: Crypto.randomUUID(),
      });
      if (response.data?.completed) {
        await loadWallet({ quiet: true });
        setAmount('');
        return;
      }
      if (!response.data?.url) throw new Error('Stripe checkout URL was not returned.');
      await WebBrowser.openBrowserAsync(response.data.url, {
        dismissButtonStyle: 'cancel',
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      });
      await loadWallet({ quiet: true });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Top-up failed',
        text2: error.response?.data?.msg || error.message || 'Could not start card payment.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadWallet({ quiet: true });
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading wallet..." /></GlassBackground>;

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.iconButton} onPress={() => navigation.goBack()} accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Rozare Wallet</Text>
            <Text style={styles.subtitle}>Balance, refunds, and card top-ups</Text>
          </View>
          <TouchableOpacity style={styles.iconButton} onPress={() => loadWallet()} accessibilityLabel="Refresh wallet">
            <Ionicons name="refresh-outline" size={21} color={palette.colors.primary} />
          </TouchableOpacity>
        </GlassPanel>

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        >
          {wallet?.status === 'locked' && (
            <View style={styles.lockedBanner}>
              <Ionicons name="lock-closed-outline" size={19} color={palette.colors.error} />
              <Text style={styles.lockedText}>{wallet.lockedReason || 'This wallet is locked. Contact support for help.'}</Text>
            </View>
          )}

          <View style={styles.balanceGrid}>
            {WALLET_CURRENCIES.map(code => (
              <GlassPanel key={code} variant="card" style={styles.balanceCard}>
                <View style={styles.balanceIcon}>
                  <Ionicons name="wallet-outline" size={18} color={palette.colors.primary} />
                </View>
                <Text style={styles.balanceCode}>{code}</Text>
                <Text style={styles.balanceValue} numberOfLines={1} adjustsFontSizeToFit>
                  {formatAmount(wallet?.balances?.[code] || 0, { targetCurrency: code })}
                </Text>
              </GlassPanel>
            ))}
          </View>

          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="add-circle-outline" size={20} color={palette.colors.success} />
              <Text style={styles.sectionTitle}>Add balance</Text>
            </View>
            <View style={styles.currencyRow}>
              {WALLET_CURRENCIES.map(code => (
                <TouchableOpacity
                  key={code}
                  style={[styles.currencyChip, topUpCurrency === code && styles.currencyChipActive]}
                  onPress={() => setTopUpCurrency(code)}
                >
                  <Text style={[styles.currencyChipText, topUpCurrency === code && styles.currencyChipTextActive]}>{code}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.amountInputWrap}>
              <Text style={styles.amountCurrency}>{topUpCurrency}</Text>
              <TextInput
                value={amount}
                onChangeText={value => setAmount(value.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor={palette.colors.textSecondary}
                style={styles.amountInput}
              />
            </View>
            <TouchableOpacity style={[styles.topUpButton, (submitting || wallet?.status === 'locked') && styles.disabled]} onPress={topUp} disabled={submitting || wallet?.status === 'locked'}>
              <LinearGradient colors={['#14B8A6', '#0EA5E9', '#6366F1']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="card-outline" size={19} color="#fff" />}
              <Text style={styles.topUpButtonText}>{submitting ? 'Opening Stripe...' : 'Add with Card'}</Text>
            </TouchableOpacity>
          </GlassPanel>

          <View style={styles.transactionsHeader}>
            <Text style={styles.sectionTitle}>Activity</Text>
            <Text style={styles.transactionCount}>{transactions.length} transaction{transactions.length === 1 ? '' : 's'}</Text>
          </View>
          {transactions.length === 0 ? (
            <GlassPanel variant="card" style={styles.emptyState}>
              <Ionicons name="receipt-outline" size={32} color={palette.colors.textSecondary} />
              <Text style={styles.emptyTitle}>No wallet activity yet</Text>
              <Text style={styles.emptyText}>Top-ups, order payments, and return refunds will appear here.</Text>
            </GlassPanel>
          ) : transactions.map(transaction => {
            const isCredit = transaction.direction === 'credit';
            return (
              <GlassPanel key={transaction._id} variant="card" style={styles.transactionCard}>
                <View style={[styles.transactionIcon, { backgroundColor: isCredit ? 'rgba(16,185,129,0.12)' : 'rgba(99,102,241,0.12)' }]}>
                  <Ionicons name={isCredit ? 'arrow-down-outline' : 'arrow-up-outline'} size={19} color={isCredit ? palette.colors.success : palette.colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.transactionTitle} numberOfLines={1}>{transaction.description || transaction.type?.replace(/_/g, ' ')}</Text>
                  <Text style={styles.transactionDate}>{new Date(transaction.createdAt).toLocaleString()} - {transaction.status}</Text>
                </View>
                <Text style={[styles.transactionAmount, { color: isCredit ? palette.colors.success : palette.colors.text }]}>
                  {isCredit ? '+' : '-'}{formatAmount(transaction.amount || 0, { targetCurrency: transaction.currency })}
                </Text>
              </GlassPanel>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginHorizontal: spacing.md, marginTop: spacing.sm, padding: spacing.md },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  title: { ...typography.h3, color: p.colors.text },
  subtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  scroll: { padding: spacing.md, paddingBottom: 80 },
  lockedBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderRadius: borderRadius.lg, padding: spacing.md, marginBottom: spacing.md, backgroundColor: 'rgba(239,68,68,0.09)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)' },
  lockedText: { flex: 1, fontSize: fontSize.sm, color: p.colors.error, lineHeight: 19 },
  balanceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  balanceCard: { width: '47.8%', minHeight: 132, padding: spacing.md, justifyContent: 'space-between' },
  balanceIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.12)' },
  balanceCode: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary, marginTop: spacing.sm },
  balanceValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  section: { padding: spacing.lg, marginTop: spacing.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  currencyRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  currencyChip: { flex: 1, minHeight: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  currencyChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  currencyChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  currencyChipTextActive: { color: '#fff' },
  amountInputWrap: { flexDirection: 'row', alignItems: 'center', minHeight: 54, borderRadius: 14, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md, paddingHorizontal: spacing.md },
  amountCurrency: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.primary, marginRight: spacing.sm },
  amountInput: { flex: 1, fontSize: fontSize.xl, fontWeight: fontWeight.semibold, color: p.colors.text, paddingVertical: spacing.sm },
  topUpButton: { minHeight: 50, borderRadius: 15, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  topUpButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  disabled: { opacity: 0.55 },
  transactionsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl, marginBottom: spacing.md, paddingHorizontal: spacing.xs },
  transactionCount: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  transactionCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, marginBottom: spacing.sm },
  transactionIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  transactionTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, textTransform: 'capitalize' },
  transactionDate: { fontSize: 11, color: p.colors.textSecondary, marginTop: 3, textTransform: 'capitalize' },
  transactionAmount: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, maxWidth: 118 },
  emptyState: { alignItems: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text, marginTop: spacing.md },
  emptyText: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', marginTop: spacing.xs, lineHeight: 19 },
});
