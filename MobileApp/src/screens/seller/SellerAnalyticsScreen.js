/**
 * SellerAnalyticsScreen — Full analytics matching website
 * Revenue trend, order volume, order status, top products, category breakdown
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, SafeAreaView, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const RANGES = [
  { label: '7 Days', value: '7' },
  { label: '30 Days', value: '30' },
  { label: '90 Days', value: '90' },
];

const getStatusColors = (palette) => [palette.colors.warning, palette.colors.info, palette.colors.primary, palette.colors.success, palette.colors.error, '#f43f5e'];
const CAT_COLORS = ['#6366f1', '#10b981', '#0ea5e9', '#8b5cf6', '#f97316', '#ec4899'];

export default function SellerAnalyticsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const STATUS_COLORS = getStatusColors(palette);
  const { currency, convertAmount, formatAmount } = useCurrency();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [timeRange, setTimeRange] = useState('30');
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState(null);

  const fetchAnalytics = async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get(`/api/analytics/seller?days=${timeRange}&currency=${currency}`);
      setAnalytics(res.data.analytics);
    } catch (e) {
      // Fallback: try to build from local data
      try {
        const [productsRes, ordersRes] = await Promise.all([
          api.get('/api/products/get-seller-products').catch(() => ({ data: { products: [] } })),
          api.get('/api/order/get').catch(() => ({ data: { orders: [] } })),
        ]);
        const products = productsRes.data?.products || productsRes.data || [];
        const orders = ordersRes.data?.orders || [];
        buildLocalAnalytics(products, orders);
      } catch {
        setError('Failed to load analytics.');
      }
    } finally { setLoading(false); setRefreshing(false); }
  };

  const buildLocalAnalytics = (products, orders) => {
    const days = parseInt(timeRange);
    const now = new Date();
    const startDate = new Date(now); startDate.setDate(startDate.getDate() - days);
    const filtered = orders.filter(o => new Date(o.createdAt) >= startDate);

    const dayBuckets = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      dayBuckets[key] = { date: key, revenue: 0, orders: 0 };
    }
    filtered.forEach(o => {
      const key = new Date(o.createdAt).toISOString().slice(0, 10);
      if (dayBuckets[key]) {
        dayBuckets[key].orders++;
        if (o.isPaid || o.status !== 'cancelled') {
          const total = o.orderSummary?.totalAmount || o.totalAmount || o.total || 0;
          dayBuckets[key].revenue += convertAmount(total, o.currency || currency, currency);
        }
      }
    });

    const productMap = {};
    filtered.forEach(o => {
      if (o.status === 'cancelled') return;
      o.orderItems?.forEach(item => {
        const id = item.productId || item._id;
        if (!productMap[id]) productMap[id] = { name: item.name, revenue: 0, sold: 0 };
        const qty = item.quantity || item.qty || 1;
        productMap[id].revenue += convertAmount((item.price || 0) * qty, item.currency || o.currency || currency, currency);
        productMap[id].sold += qty;
      });
    });

    const catMap = {};
    products.forEach(p => {
      const cat = p.category || 'Uncategorized';
      if (!catMap[cat]) catMap[cat] = { name: cat, count: 0 };
      catMap[cat].count++;
    });

    const statusCounts = { pending: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 };
    filtered.forEach(o => {
      const s = o.orderStatus || o.status || 'pending';
      if (statusCounts[s] !== undefined) statusCounts[s]++;
    });

    const totalRevenue = filtered.reduce((sum, o) => {
      if (o.status === 'cancelled') return sum;
      const total = o.orderSummary?.totalAmount || o.totalAmount || o.total || 0;
      return sum + convertAmount(total, o.currency || currency, currency);
    }, 0);
    const paidOrders = filtered.filter(o => o.status !== 'cancelled').length;
    const totalUnitsSold = filtered.reduce((s, o) => o.status !== 'cancelled' ? s + (o.orderItems?.reduce((a, i) => a + (i.quantity || i.qty || 1), 0) || 0) : s, 0);

    setAnalytics({
      revenueByDay: Object.values(dayBuckets),
      topProducts: Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
      categoryBreakdown: Object.values(catMap).sort((a, b) => b.count - a.count),
      statusBreakdown: Object.entries(statusCounts).map(([name, value]) => ({ name, value })),
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        paidOrders,
        avgOrderValue: paidOrders > 0 ? Math.round((totalRevenue / paidOrders) * 100) / 100 : 0,
        totalUnitsSold,
        conversionRate: filtered.length > 0 ? Math.round((paidOrders / filtered.length) * 100) : 0,
      }
    });
  };

  useEffect(() => { fetchAnalytics(); }, [timeRange, currency]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchAnalytics(); }, [timeRange, currency]);

  if (loading) return <GlassBackground><SafeAreaView style={{flex:1}}><Loader fullScreen message="Loading analytics..." /></SafeAreaView></GlassBackground>;

  if (error) return (
    <GlassBackground>
      <SafeAreaView style={{flex:1}}>
        <View style={styles.errorContainer}>
          <GlassPanel variant="card" style={styles.errorCard}>
            <Ionicons name="alert-circle-outline" size={48} color={palette.colors.warning} />
            <Text style={styles.errorTitle}>Analytics Unavailable</Text>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={fetchAnalytics}><Text style={styles.retryBtnText}>Retry</Text></TouchableOpacity>
          </GlassPanel>
        </View>
      </SafeAreaView>
    </GlassBackground>
  );

  if (!analytics) return null;
  const s = analytics.summary;

  const summaryStats = [
    { label: 'Total Revenue', value: formatAmount(s.totalRevenue || 0), icon: 'cash-outline', color: palette.colors.success, bg: 'rgba(16,185,129,0.12)' },
    { label: 'Paid Orders', value: s.paidOrders || 0, icon: 'receipt-outline', color: palette.colors.info, bg: 'rgba(99,102,241,0.12)' },
    { label: 'Avg Order Value', value: formatAmount(s.avgOrderValue || 0), icon: 'trending-up-outline', color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
    { label: 'Units Sold', value: s.totalUnitsSold || 0, icon: 'cube-outline', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  ];

  const maxRevenue = Math.max(...(analytics.revenueByDay || []).map(d => d.revenue), 1);
  const maxOrders = Math.max(...(analytics.revenueByDay || []).map(d => d.orders), 1);

  const statusBreakdown = analytics.statusBreakdown || [];
  const totalStatusCount = statusBreakdown.reduce((sum, s) => sum + s.value, 0);

  return (
    <GlassBackground>
      <SafeAreaView style={{flex:1}}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        
        {/* Header */}
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={{flex:1}}>
            <View style={styles.tagPill}><Ionicons name="sparkles" size={12} color={palette.colors.primary} /><Text style={styles.tagText}>Analytics</Text></View>
            <Text style={styles.headerTitle}>Store Analytics</Text>
            <Text style={styles.headerSubtitle}>Track your store performance</Text>
          </View>
        </View>

        {/* Period Selector */}
        <View style={styles.rangeRow}>
          {RANGES.map(r => (
            <TouchableOpacity key={r.value} style={[styles.rangeBtn, timeRange === r.value && styles.rangeBtnActive]}
              onPress={() => setTimeRange(r.value)}>
              <Ionicons name="calendar-outline" size={12} color={timeRange === r.value ? palette.colors.primary : palette.colors.textSecondary} />
              <Text style={[styles.rangeBtnText, timeRange === r.value && { color: palette.colors.primary }]}>{r.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Summary Stats */}
        <View style={styles.statsGrid}>
          {summaryStats.map((stat) => (
            <GlassPanel key={stat.label} variant="card" style={styles.statCard}>
              <View style={[styles.statIcon, { backgroundColor: stat.bg }]}>
                <Ionicons name={stat.icon} size={20} color={stat.color} />
              </View>
              <Text style={styles.statLabel}>{stat.label}</Text>
              <Text style={styles.statValue}>{stat.value}</Text>
            </GlassPanel>
          ))}
        </View>

        {/* Revenue Chart */}
        <GlassPanel variant="card" style={styles.chartSection}>
          <View style={styles.chartHeader}>
            <View>
              <Text style={styles.chartTitle}>Revenue Trend</Text>
              <Text style={styles.chartSubtitle}>Daily revenue over {timeRange} days</Text>
            </View>
            <View style={[styles.chartIcon, { backgroundColor: 'rgba(16,185,129,0.12)' }]}>
              <Ionicons name="trending-up" size={18} color={palette.colors.success} />
            </View>
          </View>
          <View style={styles.barChart}>
            {(analytics.revenueByDay || []).slice(-14).map((day, i) => (
              <View key={i} style={styles.barContainer}>
                <View style={[styles.bar, { height: Math.max((day.revenue / maxRevenue) * 120, 4), backgroundColor: palette.colors.success }]} />
                {i % 3 === 0 && (
                  <Text style={styles.barLabel}>{new Date(day.date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</Text>
                )}
              </View>
            ))}
          </View>
        </GlassPanel>

        {/* Order Volume Chart */}
        <GlassPanel variant="card" style={styles.chartSection}>
          <View style={styles.chartHeader}>
            <View>
              <Text style={styles.chartTitle}>Order Volume</Text>
              <Text style={styles.chartSubtitle}>Daily orders received</Text>
            </View>
            <View style={[styles.chartIcon, { backgroundColor: 'rgba(99,102,241,0.12)' }]}>
              <Ionicons name="bar-chart" size={18} color={palette.colors.primary} />
            </View>
          </View>
          <View style={styles.barChart}>
            {(analytics.revenueByDay || []).slice(-14).map((day, i) => (
              <View key={i} style={styles.barContainer}>
                <View style={[styles.bar, { height: Math.max((day.orders / maxOrders) * 120, 4), backgroundColor: palette.colors.primary }]} />
                {i % 3 === 0 && (
                  <Text style={styles.barLabel}>{new Date(day.date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</Text>
                )}
              </View>
            ))}
          </View>
        </GlassPanel>

        {/* Order Status Distribution */}
        {statusBreakdown.length > 0 && totalStatusCount > 0 && (
          <GlassPanel variant="card" style={styles.chartSection}>
            <Text style={styles.chartTitle}>Order Status</Text>
            <Text style={[styles.chartSubtitle, {marginBottom: spacing.md}]}>Breakdown by current status</Text>
            {/* Visual pie approximation */}
            <View style={styles.statusPieRow}>
              <View style={styles.pieContainer}>
                {statusBreakdown.map((st, i) => {
                  if (st.value === 0) return null;
                  const pct = (st.value / totalStatusCount) * 100;
                  return (
                    <View key={st.name} style={[styles.pieSegment, { 
                      width: `${pct}%`, 
                      backgroundColor: STATUS_COLORS[i % STATUS_COLORS.length],
                      borderTopLeftRadius: i === 0 ? 6 : 0,
                      borderBottomLeftRadius: i === 0 ? 6 : 0,
                      borderTopRightRadius: i === statusBreakdown.filter(s=>s.value>0).length - 1 ? 6 : 0,
                      borderBottomRightRadius: i === statusBreakdown.filter(s=>s.value>0).length - 1 ? 6 : 0,
                    }]} />
                  );
                })}
              </View>
            </View>
            <View style={styles.statusLegend}>
              {statusBreakdown.map((st, i) => st.value > 0 && (
                <View key={st.name} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: STATUS_COLORS[i % STATUS_COLORS.length] }]} />
                  <Text style={styles.legendName}>{st.name}</Text>
                  <Text style={styles.legendValue}>{st.value}</Text>
                </View>
              ))}
            </View>
          </GlassPanel>
        )}

        {/* Top Products */}
        {analytics.topProducts?.length > 0 && (
          <GlassPanel variant="card" style={styles.chartSection}>
            <View style={styles.chartHeader}>
              <View>
                <Text style={styles.chartTitle}>Top Products</Text>
                <Text style={styles.chartSubtitle}>By revenue generated</Text>
              </View>
              <View style={[styles.chartIcon, { backgroundColor: 'rgba(139,92,246,0.12)' }]}>
                <Ionicons name="star" size={18} color="#8b5cf6" />
              </View>
            </View>
            {analytics.topProducts.slice(0, 6).map((p, i) => (
              <View key={i} style={styles.topRow}>
                <Text style={styles.topRank}>#{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.topName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.topMeta}>{formatAmount(p.revenue || 0)} - {p.sold} sold</Text>
                </View>
              </View>
            ))}
          </GlassPanel>
        )}

        {/* Category Breakdown */}
        {analytics.categoryBreakdown?.length > 0 && (
          <GlassPanel variant="card" style={styles.chartSection}>
            <Text style={styles.chartTitle}>Category Breakdown</Text>
            <Text style={[styles.chartSubtitle, {marginBottom: spacing.md}]}>Products by category</Text>
            {analytics.categoryBreakdown.slice(0, 6).map((cat, i) => {
              const total = analytics.categoryBreakdown.reduce((s, c) => s + c.count, 0);
              const pct = total > 0 ? ((cat.count / total) * 100).toFixed(0) : 0;
              return (
                <View key={cat.name} style={styles.catRow}>
                  <View style={styles.catLeft}>
                    <View style={[styles.legendDot, { backgroundColor: CAT_COLORS[i % CAT_COLORS.length] }]} />
                    <Text style={styles.catName}>{cat.name}</Text>
                  </View>
                  <View style={styles.catBarContainer}>
                    <View style={[styles.catBar, { width: `${pct}%`, backgroundColor: CAT_COLORS[i % CAT_COLORS.length] }]} />
                  </View>
                  <Text style={styles.catCount}>{cat.count}</Text>
                </View>
              );
            })}
          </GlassPanel>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  tagPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.12)', alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: borderRadius.full, marginBottom: spacing.xs },
  tagText: { fontSize: 11, color: p.colors.primary, fontWeight: fontWeight.semibold },
  headerTitle: { fontSize: fontSize.xxl + 2, fontWeight: fontWeight.bold, color: p.colors.text, letterSpacing: -0.5 },
  headerSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  rangeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.lg },
  rangeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.xl, backgroundColor: 'rgba(255,255,255,0.08)' },
  rangeBtnActive: { backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)' },
  rangeBtnText: { fontSize: 12, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg },
  statCard: { width: (SCREEN_WIDTH - spacing.lg * 2 - spacing.md) / 2, padding: spacing.md },
  statIcon: { width: 40, height: 40, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  statLabel: { fontSize: 12, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  statValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, letterSpacing: -0.5, marginTop: 2 },
  chartSection: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  chartTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  chartSubtitle: { fontSize: 12, color: p.colors.textSecondary, marginTop: 2 },
  chartIcon: { width: 36, height: 36, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  barChart: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 140 },
  barContainer: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 3, minWidth: 4 },
  barLabel: { fontSize: 8, color: p.colors.textSecondary, marginTop: 4 },
  statusPieRow: { marginBottom: spacing.md },
  pieContainer: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)' },
  pieSegment: { height: 12 },
  statusLegend: { gap: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendName: { flex: 1, fontSize: 12, color: p.colors.textSecondary, textTransform: 'capitalize' },
  legendValue: { fontSize: 12, fontWeight: fontWeight.bold, color: p.colors.text },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  topRank: { fontSize: 12, fontWeight: fontWeight.bold, color: p.colors.textSecondary, width: 24 },
  topName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  topMeta: { fontSize: 11, color: p.colors.textSecondary, marginTop: 2 },
  catRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  catLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, width: 100 },
  catName: { fontSize: 12, color: p.colors.textSecondary },
  catBarContainer: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.06)' },
  catBar: { height: 8, borderRadius: 4 },
  catCount: { fontSize: 12, fontWeight: fontWeight.bold, color: p.colors.text, width: 30, textAlign: 'right' },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl },
  errorCard: { alignItems: 'center', padding: spacing.xxl },
  errorTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.md },
  errorText: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
  retryBtn: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, marginTop: spacing.lg },
  retryBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: 'white' },
});
