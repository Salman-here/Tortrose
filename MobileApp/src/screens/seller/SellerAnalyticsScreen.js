/**
 * SellerAnalyticsScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl,
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

export default function SellerAnalyticsScreen({ navigation }) {
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { fetchAnalytics(); }, []);

  const fetchAnalytics = async () => {
    try {
      setError(null);
      const response = await api.get('/api/stores/analytics');
      setAnalytics(response.data);
    } catch (err) {
      setError('Failed to load analytics. Pull to refresh.');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchAnalytics(); }, []);

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  };

  if (isLoading) {
    return <GlassBackground><Loader fullScreen message="Loading analytics..." /></GlassBackground>;
  }

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        <GlassPanel variant="floating" style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="bar-chart" size={28} color={colors.primary} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>{analytics?.storeName || 'Store Analytics'}</Text>
            <Text style={styles.headerSubtitle}>Member since {formatDate(analytics?.createdAt)}</Text>
          </View>
        </GlassPanel>

        {error ? (
          <GlassPanel variant="card" style={styles.errorContainer}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </GlassPanel>
        ) : (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Performance Overview</Text>
            <View style={styles.statsGrid}>
              <View style={styles.statWrapper}>
                <StatCard title="Store Views" value={analytics?.views ?? 0} icon="eye-outline" iconColor={colors.info} iconBgColor="rgba(14,165,233,0.12)" />
              </View>
              <View style={styles.statWrapper}>
                <StatCard title="Total Products" value={analytics?.productCount ?? 0} icon="cube-outline" iconColor={colors.secondary} iconBgColor="rgba(139,92,246,0.12)" />
              </View>
            </View>
            <View style={styles.statsGrid}>
              <View style={styles.statWrapper}>
                <StatCard title="Total Sales" value={`$${(analytics?.totalSales ?? 0).toLocaleString()}`} icon="cash-outline" iconColor={colors.success} iconBgColor="rgba(16,185,129,0.12)" />
              </View>
              <View style={styles.statWrapper}>
                <StatCard title="Trust Count" value={analytics?.trustCount ?? 0} icon="heart-outline" iconColor={colors.error} iconBgColor="rgba(239,68,68,0.12)" />
              </View>
            </View>
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'center', margin: spacing.lg, padding: spacing.lg },
  headerIcon: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(99,102,241,0.12)',
    justifyContent: 'center', alignItems: 'center', marginRight: spacing.md,
  },
  headerText: { flex: 1 },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  headerSubtitle: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  section: { padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: colors.text, marginBottom: spacing.md },
  statsGrid: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  statWrapper: { flex: 1 },
  errorContainer: { alignItems: 'center', padding: spacing.xxxl, margin: spacing.lg },
  errorText: { ...typography.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.md },
});
