/**
 * AdminAnalyticsScreen — Liquid Glass
 * Platform-wide analytics with simple chart bars
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import StatCard from '../../components/common/StatCard';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../../styles/theme';

const RANGES = [
  { label: '7 Days', value: '7' },
  { label: '30 Days', value: '30' },
  { label: '90 Days', value: '90' },
];

export default function AdminAnalyticsScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [timeRange, setTimeRange] = useState('30');
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState(null);

  const fetchAnalytics = async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get(`/api/analytics/admin?days=${timeRange}`);
      setAnalytics(res.data.analytics);
    } catch (e) {
      setError(e.response?.status === 404
        ? 'Analytics API not available. Please redeploy your backend.'
        : 'Failed to load analytics.');
    } finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { fetchAnalytics(); }, [timeRange]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchAnalytics(); }, [timeRange]);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading analytics..." /></GlassBackground>;

  if (error) return (
    <GlassBackground>
      <View style={styles.errorContainer}>
        <GlassPanel variant="card" style={styles.errorCard}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.warning} />
          <Text style={styles.errorTitle}>Analytics Unavailable</Text>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={fetchAnalytics}><Text style={styles.retryBtnText}>Retry</Text></TouchableOpacity>
        </GlassPanel>
      </View>
    </GlassBackground>
  );

  if (!analytics) return null;
  const s = analytics.summary;

  const summaryStats = [
    { label: 'Total Revenue', value: `$${s.totalRevenue?.toFixed(2)}`, icon: 'cash-outline', color: colors.success, bg: 'rgba(16,185,129,0.12)', change: `${s.revenueChange >= 0 ? '+' : ''}${s.revenueChange}%`, up: s.revenueChange >= 0 },
    { label: 'Total Orders', value: s.totalOrders, icon: 'receipt-outline', color: colors.info, bg: 'rgba(99,102,241,0.12)', change: `${s.ordersChange >= 0 ? '+' : ''}${s.ordersChange}%`, up: s.ordersChange >= 0 },
    { label: 'Total Stores', value: s.totalStores, icon: 'storefront-outline', color: colors.primary, bg: 'rgba(14,165,233,0.12)', change: `${s.verifiedStores} verified`, up: true },
    { label: 'Total Users', value: s.totalUsers, icon: 'people-outline', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)', change: `${s.totalSellers} sellers`, up: true },
    { label: 'Products', value: s.totalProducts, icon: 'cube-outline', color: '#f97316', bg: 'rgba(249,115,22,0.12)', change: `${s.outOfStock} out of stock`, up: s.outOfStock === 0 },
    { label: 'Avg Order Value', value: `$${s.avgOrderValue?.toFixed(2)}`, icon: 'trending-up-outline', color: '#f43f5e', bg: 'rgba(244,63,94,0.12)', change: `${s.avgChange >= 0 ? '+' : ''}${s.avgChange}%`, up: s.avgChange >= 0 },
  ];

  const maxRevenue = Math.max(...(analytics.revenueByDay || []).map(d => d.revenue), 1);

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <View style={styles.tagPill}><Ionicons name="sparkles" size={12} color={colors.primary} /><Text style={styles.tagText}>Platform Analytics</Text></View>
            <Text style={styles.headerTitle}>Admin Analytics</Text>
            <Text style={styles.headerSubtitle}>Last {timeRange} days vs previous {timeRange} days</Text>
          </View>
        </View>

        {/* Period Selector */}
        <View style={styles.rangeRow}>
          {RANGES.map(r => (
            <TouchableOpacity key={r.value} style={[styles.rangeBtn, timeRange === r.value && styles.rangeBtnActive]}
              onPress={() => setTimeRange(r.value)}>
              <Ionicons name="calendar-outline" size={12} color={timeRange === r.value ? colors.primary : colors.textSecondary} />
              <Text style={[styles.rangeBtnText, timeRange === r.value && { color: colors.primary }]}>{r.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Summary Stats */}
        <View style={styles.statsGrid}>
          {summaryStats.map((stat, i) => (
            <GlassPanel key={stat.label} variant="card" style={styles.statCard}>
              <View style={styles.statHeader}>
                <View style={[styles.statIcon, { backgroundColor: stat.bg }]}>
                  <Ionicons name={stat.icon} size={20} color={stat.color} />
                </View>
                <View style={[styles.changeBadge, { backgroundColor: stat.up ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)' }]}>
                  <Ionicons name={stat.up ? 'arrow-up' : 'arrow-down'} size={10} color={stat.up ? colors.success : colors.error} />
                  <Text style={[styles.changeText, { color: stat.up ? colors.success : colors.error }]}>{stat.change}</Text>
                </View>
              </View>
              <Text style={styles.statLabel}>{stat.label}</Text>
              <Text style={styles.statValue}>{stat.value}</Text>
            </GlassPanel>
          ))}
        </View>

        {/* Revenue Chart (simple bars) */}
        <GlassPanel variant="card" style={styles.chartSection}>
          <View style={styles.chartHeader}>
            <View>
              <Text style={styles.chartTitle}>Revenue Trend</Text>
              <Text style={styles.chartSubtitle}>Daily revenue over {timeRange} days</Text>
            </View>
            <View style={[styles.statIcon, { backgroundColor: 'rgba(16,185,129,0.12)' }]}>
              <Ionicons name="trending-up" size={18} color={colors.success} />
            </View>
          </View>
          <View style={styles.barChart}>
            {(analytics.revenueByDay || []).slice(-14).map((day, i) => (
              <View key={i} style={styles.barContainer}>
                <View style={[styles.bar, { height: Math.max((day.revenue / maxRevenue) * 120, 4), backgroundColor: colors.success }]} />
                {i % 3 === 0 && (
                  <Text style={styles.barLabel}>{new Date(day.date).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</Text>
                )}
              </View>
            ))}
          </View>
        </GlassPanel>

        {/* Order Status Distribution */}
        {analytics.statusBreakdown?.length > 0 && (
          <GlassPanel variant="card" style={styles.chartSection}>
            <Text style={styles.chartTitle}>Order Status</Text>
            <View style={styles.statusList}>
              {analytics.statusBreakdown.map((st, i) => {
                const statusColors = [colors.warning, colors.info, colors.primary, colors.success, colors.error, '#f43f5e'];
                const c = statusColors[i % statusColors.length];
                const total = analytics.statusBreakdown.reduce((sum, s) => sum + s.value, 0);
                const pct = total > 0 ? ((st.value / total) * 100).toFixed(0) : 0;
                return (
                  <View key={st.name} style={styles.statusRow}>
                    <View style={styles.statusRowLeft}>
                      <View style={[styles.statusDot, { backgroundColor: c }]} />
                      <Text style={styles.statusName}>{st.name}</Text>
                    </View>
                    <View style={styles.statusBarContainer}>
                      <View style={[styles.statusBar, { width: `${pct}%`, backgroundColor: c }]} />
                    </View>
                    <Text style={styles.statusValue}>{st.value}</Text>
                  </View>
                );
              })}
            </View>
          </GlassPanel>
        )}

        {/* Top Products */}
        {analytics.topProducts?.length > 0 && (
          <GlassPanel variant="card" style={styles.chartSection}>
            <Text style={styles.chartTitle}>Top Products by Revenue</Text>
            {analytics.topProducts.slice(0, 5).map((p, i) => (
              <View key={i} style={styles.topProductRow}>
                <Text style={styles.topProductRank}>#{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.topProductName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.topProductMeta}>${p.revenue?.toFixed(2)} · {p.sold} sold</Text>
                </View>
              </View>
            ))}
          </GlassPanel>
        )}

        {/* Top Stores */}
        {analytics.topStores?.length > 0 && (
          <GlassPanel variant="card" style={styles.chartSection}>
            <Text style={styles.chartTitle}>Top Stores by Revenue</Text>
            {analytics.topStores.slice(0, 5).map((st, i) => (
              <View key={i} style={styles.topProductRow}>
                <Text style={styles.topProductRank}>#{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.topProductName} numberOfLines={1}>{st.name}</Text>
                  <Text style={styles.topProductMeta}>${st.revenue?.toFixed(2)} · {st.orders} orders</Text>
                </View>
              </View>
            ))}
          </GlassPanel>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  headerRow: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  tagPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.12)', alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: borderRadius.full, marginBottom: spacing.sm },
  tagText: { ...typography.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  headerTitle: { fontSize: fontSize.xxl + 4, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: -0.5 },
  headerSubtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2 },
  rangeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.lg },
  rangeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.xl, backgroundColor: 'rgba(255,255,255,0.08)' },
  rangeBtnActive: { backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)' },
  rangeBtnText: { ...typography.caption, color: colors.textSecondary, fontWeight: fontWeight.medium },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg },
  statCard: { width: '47%', padding: spacing.md },
  statHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  statIcon: { width: 40, height: 40, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  changeBadge: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.full },
  changeText: { fontSize: 10, fontWeight: fontWeight.semibold },
  statLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: fontWeight.medium },
  statValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: -0.5, marginTop: 2 },
  chartSection: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  chartTitle: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.xs },
  chartSubtitle: { ...typography.caption, color: colors.textSecondary },
  barChart: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 140 },
  barContainer: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 3, minWidth: 4 },
  barLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 4, fontSize: 8 },
  statusList: { gap: spacing.sm },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusRowLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, width: 100 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusName: { ...typography.caption, color: colors.textSecondary, textTransform: 'capitalize' },
  statusBarContainer: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.06)' },
  statusBar: { height: 8, borderRadius: 4 },
  statusValue: { ...typography.caption, fontWeight: fontWeight.bold, color: colors.text, width: 30, textAlign: 'right' },
  topProductRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  topProductRank: { ...typography.caption, fontWeight: fontWeight.bold, color: colors.textSecondary, width: 24 },
  topProductName: { ...typography.bodySemibold, color: colors.text },
  topProductMeta: { ...typography.caption, color: colors.textSecondary },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl },
  errorCard: { alignItems: 'center', padding: spacing.xxl },
  errorTitle: { ...typography.h3, color: colors.text, marginTop: spacing.md },
  errorText: { ...typography.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, marginTop: spacing.lg },
  retryBtnText: { ...typography.bodySemibold, color: 'white' },
});
