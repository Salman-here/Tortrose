import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import GlassPanel from '../common/GlassPanel';
import Skeleton from '../common/Skeleton';
import { SellerInlineError } from './SellerUI';
import { inspectSellerProductCurrencyState } from '../../utils/productCurrencyState';
import { inspectSellerRevenueOverview } from '../../utils/sellerRevenueOverview';
import { revenueCardColumns } from '../../utils/sellerAnalyticsPresentation';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

export default function SellerRevenueOverview({ days = 'all', refreshKey = 0 }) {
  const { currentUser } = useAuth();
  const { formatAmount } = useCurrency();
  const { palette } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const styles = buildStyles(palette);
  const cardWidth = revenueCardColumns(width, fontScale) === 2 ? styles.halfCard : styles.fullCard;
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
      const totals = await api.get(`/api/payments/seller/revenue-overview?currency=${encodeURIComponent(state.activeCurrency)}&days=${days}`, options);
      if (requestRef.current.id !== requestId) return;
      const next = inspectSellerRevenueOverview(totals.data?.overview, sellerId, state.activeCurrency, days);
      if (!next) throw new Error('Revenue totals could not be verified. Please retry.');
      setOverview(next);
    } catch (failure) {
      if (failure.code === 'ERR_CANCELED' || failure.name === 'CanceledError' || requestRef.current.id !== requestId) return;
      setError(failure.response?.data?.msg || failure.message || 'Revenue totals are unavailable.');
    } finally {
      if (requestRef.current.id === requestId) setLoading(false);
    }
  }, [sellerId, days]);

  useEffect(() => {
    refresh();
    return () => { requestRef.current.id += 1; requestRef.current.controller?.abort(); };
  }, [refresh, refreshKey]);

  const allTime = days === 'all';
  const sectionName = allTime ? 'All-time revenue' : 'Revenue for selected period';
  const active = overview?.sellerId === sellerId && overview.days === (allTime ? null : Number(days)) ? overview : null;
  const cards = active ? [
    { label: `Total Online Earnings (${active.currency})`, value: active.onlineGrossEarnings, icon: 'wallet-outline', description: 'Safepay and Wallet earnings before fees and withdrawals, excluding refunds and reversals.', color: palette.colors.success },
    { label: 'Delivered COD Revenue', value: active.codDeliveredRevenue, icon: 'cash-outline', description: 'Delivered COD sales collected directly by you.', color: palette.colors.warning },
    { label: 'Total Delivered Revenue', value: active.totalDeliveredRevenue, icon: 'trending-up-outline', description: 'Delivered Safepay, Wallet and COD sales.', color: palette.colors.primary },
    { label: 'Estimated Revenue', value: active.estimatedRevenue, icon: 'time-outline', description: 'Delivered sales plus pending online and COD orders.', color: palette.colors.info },
  ] : [];

  return (
    <View style={styles.section} accessibilityLabel={sectionName} accessibilityState={{ busy: loading }}>
      <View style={styles.header}>
        <View style={styles.headerCopy}><Text style={styles.title}>{allTime ? 'All-time revenue' : `Revenue · Last ${days} days`}</Text>
          <Text style={styles.subtitle}>{allTime ? 'Lifetime totals, independent of the date filter.' : 'Orders placed in the selected calendar-day period (UTC), using saved order amounts.'} Not your withdrawable balance.</Text>
          {!allTime && active && <Text style={styles.subtitle}>{active.period.startDate.slice(0, 10)} to {new Date(Date.parse(active.period.endDateExclusive) - 86400000).toISOString().slice(0, 10)} · UTC</Text>}</View>
        <TouchableOpacity onPress={refresh} disabled={loading} accessibilityRole="button" accessibilityLabel={allTime ? 'Refresh all-time revenue' : 'Refresh period revenue'} style={styles.refresh}>
          {loading ? <ActivityIndicator color={palette.colors.primary} size="small" /> : <Ionicons name="refresh" size={18} color={palette.colors.primary} />}
        </TouchableOpacity>
      </View>
      {loading ? <View style={styles.grid} accessibilityLabel="Loading revenue totals">{Array.from({ length: 4 }, (_, index) => <GlassPanel key={index} variant="card" style={[styles.card, cardWidth]}>
          <Skeleton width="62%" height={12} /><Skeleton width="76%" height={28} style={styles.skeletonGap} /><Skeleton width="95%" height={12} style={styles.skeletonGap} />
        </GlassPanel>)}</View>
        : active ? <View style={styles.grid}>{cards.map(card => (
          <GlassPanel key={card.label} variant="card" style={[styles.card, cardWidth]}>
            <View style={styles.cardHeader}><Text style={styles.label}>{card.label}</Text>
              <View style={[styles.cardIcon, { backgroundColor: `${card.color}18` }]}><Ionicons name={card.icon} size={20} color={card.color} /></View></View>
            <Text style={styles.value}>{formatAmount(card.value, { targetCurrency: active.currency, showCode: true })}</Text>
            <Text style={styles.subtitle}>{card.description}</Text>
          </GlassPanel>
        ))}</View> : <SellerInlineError compact title="Revenue totals unavailable" message={error || 'Sign in as a seller to view revenue totals.'} onRetry={refresh} />}
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
  card: { minWidth: 0, padding: spacing.lg, borderRadius: borderRadius.xxl },
  halfCard: { flexGrow: 1, flexBasis: '46%' },
  fullCard: { width: '100%' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  cardIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1, color: p.colors.textSecondary, fontSize: 11, lineHeight: 17, fontWeight: fontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.4 },
  value: { color: p.colors.text, fontSize: fontSize.xxxl, lineHeight: 33, fontWeight: fontWeight.extrabold, marginTop: spacing.md, marginBottom: spacing.xs, fontVariant: ['tabular-nums'] },
  skeletonGap: { marginTop: spacing.md },
});
