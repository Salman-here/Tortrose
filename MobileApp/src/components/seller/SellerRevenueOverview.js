import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import GlassPanel from '../common/GlassPanel';
import { inspectSellerProductCurrencyState } from '../../utils/productCurrencyState';
import { inspectSellerRevenueOverview } from '../../utils/sellerRevenueOverview';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

export default function SellerRevenueOverview() {
  const { currentUser } = useAuth();
  const { formatAmount } = useCurrency();
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const sellerId = currentUser?.role === 'seller' ? String(currentUser._id || currentUser.id || '') : '';
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requestRef = useRef({ id: 0, controller: null });

  const refresh = useCallback(async () => {
    const requestId = requestRef.current.id + 1;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };
    setOverview(null);
    setError('');
    setLoading(true);
    if (!sellerId) { setLoading(false); return; }
    const options = { signal: controller.signal };
    try {
      const response = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY, options);
      if (requestRef.current.id !== requestId) return;
      const state = inspectSellerProductCurrencyState(response.data?.productCurrency);
      if (!state.valid || !state.hasStore) throw new Error('Your store currency could not be verified.');
      const totals = await api.get(`${API_ENDPOINTS.PAYMENTS.SELLER_SUMMARY}?currency=${encodeURIComponent(state.activeCurrency)}`, options);
      if (requestRef.current.id !== requestId) return;
      const next = inspectSellerRevenueOverview(totals.data, sellerId, state.activeCurrency);
      if (!next) throw new Error('Revenue totals could not be verified. Please retry.');
      setOverview(next);
    } catch (failure) {
      if (failure.code === 'ERR_CANCELED' || failure.name === 'CanceledError' || requestRef.current.id !== requestId) return;
      setError(failure.response?.data?.msg || failure.message || 'Revenue totals are unavailable.');
    } finally {
      if (requestRef.current.id === requestId) setLoading(false);
    }
  }, [sellerId]);

  useEffect(() => {
    refresh();
    return () => { requestRef.current.id += 1; requestRef.current.controller?.abort(); };
  }, [refresh]);

  const active = overview?.sellerId === sellerId ? overview : null;
  const cards = active ? [
    { label: 'Delivered COD Revenue', value: active.codDeliveredRevenue, icon: 'cash-outline', description: 'Delivered COD sales collected directly by you.', color: palette.colors.warning },
    { label: 'Total Delivered Revenue', value: active.totalDeliveredRevenue, icon: 'trending-up-outline', description: 'Delivered Safepay, Wallet and COD sales.', color: palette.colors.primary },
    { label: 'Estimated Revenue', value: active.estimatedRevenue, icon: 'time-outline', description: 'Delivered sales plus pending online and COD orders.', color: palette.colors.info },
  ] : [];

  return (
    <View style={styles.section} accessibilityLabel="All-time revenue">
      <View style={styles.header}>
        <View style={styles.headerCopy}><Text style={styles.title}>All-time revenue</Text>
          <Text style={styles.subtitle}>Gross sales totals{active ? ` in ${active.currency}` : ''}. Independent of the chart period; not your withdrawable balance.</Text></View>
        <TouchableOpacity onPress={refresh} disabled={loading} accessibilityRole="button" accessibilityLabel="Refresh all-time revenue" style={styles.refresh}>
          {loading ? <ActivityIndicator color={palette.colors.primary} size="small" /> : <Ionicons name="refresh" size={18} color={palette.colors.primary} />}
        </TouchableOpacity>
      </View>
      {loading ? <Text style={styles.subtitle} accessibilityLiveRegion="polite">Loading revenue totals…</Text>
        : active ? <View style={styles.grid}>{cards.map(card => (
          <GlassPanel key={card.label} variant="card" style={styles.card}>
            <Ionicons name={card.icon} size={20} color={card.color} />
            <Text style={styles.label}>{card.label}</Text>
            <Text style={styles.value}>{formatAmount(card.value, { targetCurrency: active.currency, showCode: true })}</Text>
            <Text style={styles.subtitle}>{card.description}</Text>
          </GlassPanel>
        ))}</View> : <Text style={styles.error} accessibilityRole="alert">{error || 'Sign in as a seller to view revenue totals.'}</Text>}
    </View>
  );
}

const buildStyles = p => StyleSheet.create({
  section: { marginHorizontal: spacing.lg, marginVertical: spacing.md, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headerCopy: { flex: 1 },
  title: { color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  subtitle: { color: p.colors.textSecondary, fontSize: 12, lineHeight: 18, marginTop: 4 },
  refresh: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  card: { flexGrow: 1, flexBasis: '47%', minWidth: 140, padding: spacing.md },
  label: { color: p.colors.textSecondary, fontSize: 12, fontWeight: fontWeight.medium, marginTop: spacing.sm },
  value: { color: p.colors.text, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, marginTop: 4 },
  error: { color: p.colors.error, fontSize: 13, lineHeight: 19 },
});
