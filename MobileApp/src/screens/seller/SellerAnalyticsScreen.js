import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import Skeleton from '../../components/common/Skeleton';
import { SellerInlineError, SellerScreenHeader } from '../../components/seller/SellerUI';
import SellerRevenueOverview from '../../components/seller/SellerRevenueOverview';
import SellerAnalyticsCharts from '../../components/seller/SellerAnalyticsCharts';
import { useTheme } from '../../contexts/ThemeContext';
import useResponsiveLayout from '../../hooks/useResponsiveLayout';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useAuth } from '../../contexts/AuthContext';
import { inspectSellerProductCurrencyState } from '../../utils/productCurrencyState';
import { sellerAnalyticsPeriodIsValid } from '../../utils/sellerAnalyticsPresentation';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

const RANGES = [{ label: '7 Days', value: '7' }, { label: '30 Days', value: '30' }, { label: '90 Days', value: '90' }];

function SellerAnalyticsScreen({ navigation }) {
  const { palette } = useTheme();
  const { formatAmount } = useCurrency();
  const { width, fontScale } = useWindowDimensions();
  const { isTablet } = useResponsiveLayout();
  const styles = useMemo(() => buildStyles(palette, isTablet), [palette, isTablet]);
  const [timeRange, setTimeRange] = useState('30');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [revenueRefreshKey, setRevenueRefreshKey] = useState(0);
  const analyticsRequestRef = useRef({ id: 0, controller: null });
  const analytics = response?.days === timeRange ? response.data : null;

  const fetchAnalytics = useCallback(async () => {
    const requestId = analyticsRequestRef.current.id + 1;
    analyticsRequestRef.current.controller?.abort();
    const controller = new AbortController();
    analyticsRequestRef.current = { id: requestId, controller };
    setLoading(true); setError(null); setResponse(null);
    try {
      const options = { signal: controller.signal };
      const currencyResponse = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY, options);
      if (analyticsRequestRef.current.id !== requestId) return;
      const state = inspectSellerProductCurrencyState(currencyResponse.data?.productCurrency);
      if (!state.valid || !state.hasStore) throw new Error('Your store currency could not be verified. Please retry.');
      const result = await api.get(`/api/analytics/seller?days=${timeRange}&currency=${encodeURIComponent(state.activeCurrency)}`, options);
      if (analyticsRequestRef.current.id !== requestId) return;
      if (!sellerAnalyticsPeriodIsValid(result.data?.analytics, state.activeCurrency, timeRange)) {
        throw new Error('Analytics returned an incomplete or invalid reporting period. Please retry.');
      }
      setResponse({ data: result.data.analytics, days: timeRange });
    } catch (failure) {
      if (failure.code === 'ERR_CANCELED' || failure.name === 'CanceledError' || analyticsRequestRef.current.id !== requestId) return;
      setResponse(null);
      setError(failure.response?.status === 403
        ? { entitlement: true, message: 'Advanced Analytics is not included in your current seller entitlement. Open Subscription to compare plans and unlock live performance reporting.' }
        : { entitlement: false, message: failure.response?.data?.msg || failure.message || 'Performance charts are unavailable. Check your connection and try again.' });
    } finally {
      if (analyticsRequestRef.current.id === requestId) { setLoading(false); setRefreshing(false); }
    }
  }, [timeRange]);

  useEffect(() => {
    fetchAnalytics();
    return () => { analyticsRequestRef.current.id += 1; analyticsRequestRef.current.controller?.abort(); };
  }, [fetchAnalytics]);
  const onRefresh = useCallback(() => {
    setRefreshing(true); setRevenueRefreshKey(key => key + 1); fetchAnalytics();
  }, [fetchAnalytics]);
  const summary = analytics?.summary;
  const stats = analytics ? [
    { label: 'Total Revenue', value: formatAmount(summary.totalRevenue, { targetCurrency: analytics.currency, showCode: true }), icon: 'cash-outline', color: palette.colors.success },
    { label: 'Recognized Orders', value: summary.paidOrders, icon: 'receipt-outline', color: palette.colors.primary },
    { label: 'Avg Order Value', value: formatAmount(summary.avgOrderValue, { targetCurrency: analytics.currency, showCode: true }), icon: 'trending-up-outline', color: palette.colors.info },
    { label: 'Units Sold', value: summary.totalUnitsSold, icon: 'cube-outline', color: palette.colors.secondary },
  ] : [];
  const wideStats = width >= 340 && fontScale < 1.4;

  return <GlassBackground>
    <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top']}>
      <SellerScreenHeader navigation={navigation} title="Store Analytics" subtitle="Track performance and revenue trends"
        icon="bar-chart-outline" rightIcon="refresh" rightLabel="Refresh" onRightPress={onRefresh} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        <SellerRevenueOverview refreshKey={revenueRefreshKey} />

        <View style={styles.periodHeader}><Text style={styles.periodTitle} accessibilityRole="header">Reporting period</Text><Text style={styles.periodNote}>Calendar days · UTC</Text></View>
        <GlassPanel variant="inner" style={styles.rangeRow} accessibilityLabel="Analytics date filter">
          {RANGES.map(range => <TouchableOpacity key={range.value} activeOpacity={0.8}
            style={[styles.rangeButton, timeRange === range.value && styles.rangeButtonActive]}
            accessibilityRole="button" accessibilityLabel={range.label} accessibilityState={{ selected: timeRange === range.value }}
            onPress={() => setTimeRange(range.value)}>
            <Ionicons name="calendar-outline" size={14} color={timeRange === range.value ? palette.colors.success : palette.colors.textSecondary} />
            <Text style={[styles.rangeLabel, timeRange === range.value && styles.rangeLabelActive]}>{range.label}</Text>
          </TouchableOpacity>)}
        </GlassPanel>

        <SellerRevenueOverview days={timeRange} refreshKey={revenueRefreshKey} />

        <View style={styles.performanceHeader}><Text style={styles.performanceTitle} accessibilityRole="header">Period performance</Text>
          <Text style={styles.performanceNote}>Charts and sales metrics · Last {timeRange} days</Text></View>
        {loading && <View accessibilityLabel="Loading period performance" accessibilityState={{ busy: true }}>
          <View style={styles.statsGrid}>{Array.from({ length: 4 }, (_, index) => <GlassPanel key={index} variant="card" style={[styles.statCard, wideStats ? styles.halfCard : styles.fullCard]}>
            <Skeleton width={36} height={36} radius={12} /><Skeleton width="80%" height={12} style={styles.skeletonGap} /><Skeleton width="65%" height={24} style={styles.skeletonGap} />
          </GlassPanel>)}</View>
          <GlassPanel variant="card" style={styles.loadingChart}><Skeleton width="48%" height={18} /><Skeleton width="100%" height={160} radius={12} style={styles.skeletonGap} /></GlassPanel>
        </View>}
        {!loading && error && <>
          <SellerInlineError title="Performance charts unavailable" message={error.message} onRetry={fetchAnalytics} />
          {error.entitlement && <TouchableOpacity style={styles.planButton} onPress={() => navigation.navigate('SellerSubscription')} accessibilityRole="button">
            <Ionicons name="diamond-outline" size={17} color="#fff" /><Text style={styles.planButtonText}>View seller plans</Text>
          </TouchableOpacity>}
        </>}
        {!loading && analytics && <>
          <View style={styles.statsGrid}>{stats.map(stat => <GlassPanel key={stat.label} variant="card" style={[styles.statCard, wideStats ? styles.halfCard : styles.fullCard]}>
            <View style={[styles.statIcon, { backgroundColor: `${stat.color}18` }]}><Ionicons name={stat.icon} size={19} color={stat.color} /></View>
            <Text style={styles.statLabel}>{stat.label}</Text><Text style={styles.statValue}>{stat.value}</Text>
          </GlassPanel>)}</View>
          <SellerAnalyticsCharts analytics={analytics} days={timeRange} />
        </>}
      </ScrollView>
    </SafeAreaView>
  </GlassBackground>;
}

const buildStyles = (palette, isTablet = false) => StyleSheet.create({
  safeArea: { flex: 1 },
  scroll: { width: '100%', maxWidth: isTablet ? 1024 : 680, alignSelf: 'center', paddingTop: spacing.sm, paddingBottom: 100 },
  periodHeader: { marginHorizontal: spacing.lg, marginTop: spacing.xl, marginBottom: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  periodTitle: { flex: 1, fontSize: fontSize.sm, color: palette.colors.text, fontWeight: fontWeight.bold },
  periodNote: { fontSize: 10, color: palette.colors.textSecondary },
  rangeRow: { flexDirection: 'row', gap: spacing.xs, marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: 5, borderRadius: 17 },
  rangeButton: { flex: 1, minHeight: 44, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs, paddingVertical: spacing.sm, borderRadius: 12, borderWidth: 1, borderColor: 'transparent' },
  rangeButtonActive: { backgroundColor: `${palette.colors.success}18`, borderColor: `${palette.colors.success}45` },
  rangeLabel: { flexShrink: 1, color: palette.colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  rangeLabelActive: { color: palette.colors.success, fontWeight: fontWeight.bold },
  performanceHeader: { marginHorizontal: spacing.lg, marginTop: spacing.xl, marginBottom: spacing.md },
  performanceTitle: { fontSize: fontSize.lg, color: palette.colors.text, fontWeight: fontWeight.bold },
  performanceNote: { fontSize: fontSize.sm, color: palette.colors.textSecondary, lineHeight: 18, marginTop: 4 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginHorizontal: spacing.lg },
  statCard: { padding: spacing.md, borderRadius: borderRadius.xxl, minWidth: 0 },
  halfCard: { flexGrow: 1, flexBasis: '46%' },
  fullCard: { width: '100%' },
  statIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  statLabel: { fontSize: 11, color: palette.colors.textSecondary, fontWeight: fontWeight.medium, lineHeight: 17 },
  statValue: { color: palette.colors.text, fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, lineHeight: 29, marginTop: 5, fontVariant: ['tabular-nums'] },
  skeletonGap: { marginTop: spacing.md },
  loadingChart: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  planButton: { minHeight: 48, marginHorizontal: spacing.lg, marginTop: spacing.sm, borderRadius: borderRadius.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: palette.colors.primary },
  planButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
});

export default function AccountScopedSellerAnalyticsScreen(props) {
  const { currentUser } = useAuth();
  return <SellerAnalyticsScreen key={`${currentUser?.role || 'guest'}:${currentUser?._id || currentUser?.id || ''}`} {...props} />;
}
