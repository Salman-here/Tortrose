/**
 * SellerAnalyticsScreen
 * Store analytics overview for sellers
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import StatCard from '../../components/common/StatCard';
import Loader from '../../components/common/Loader';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
} from '../../styles/theme';

export default function SellerAnalyticsScreen({ navigation }) {
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      setError(null);
      const response = await api.get('/api/stores/analytics');
      setAnalytics(response.data);
    } catch (err) {
      console.error('Error fetching analytics:', err);
      setError('Failed to load analytics. Pull to refresh.');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAnalytics();
  }, []);

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading analytics..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="bar-chart" size={28} color={colors.white} />
          </View>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>
              {analytics?.storeName || 'Store Analytics'}
            </Text>
            <Text style={styles.headerSubtitle}>
              Member since {formatDate(analytics?.createdAt)}
            </Text>
          </View>
        </View>

        {error ? (
          <View style={styles.errorContainer}>
            <Ionicons name="alert-circle-outline" size={48} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
          <>
            {/* Stats Grid */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Performance Overview</Text>
              <View style={styles.statsGrid}>
                <View style={styles.statWrapper}>
                  <StatCard
                    title="Store Views"
                    value={analytics?.views ?? 0}
                    icon="eye-outline"
                    iconColor={colors.info}
                    iconBgColor={colors.infoLighter}
                  />
                </View>
                <View style={styles.statWrapper}>
                  <StatCard
                    title="Total Products"
                    value={analytics?.productCount ?? 0}
                    icon="cube-outline"
                    iconColor={colors.secondary}
                    iconBgColor={colors.secondaryLighter}
                  />
                </View>
              </View>
              <View style={styles.statsGrid}>
                <View style={styles.statWrapper}>
                  <StatCard
                    title="Total Sales"
                    value={`$${(analytics?.totalSales ?? 0).toLocaleString()}`}
                    icon="cash-outline"
                    iconColor={colors.success}
                    iconBgColor={colors.successLighter}
                  />
                </View>
                <View style={styles.statWrapper}>
                  <StatCard
                    title="Trust Count"
                    value={analytics?.trustCount ?? 0}
                    icon="heart-outline"
                    iconColor={colors.error}
                    iconBgColor={colors.errorLighter}
                  />
                </View>
              </View>
            </View>
          </>
        )}

        <View style={styles.bottomSpacing} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    backgroundColor: colors.primaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.xl,
  },
  headerIcon: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  headerSubtitle: {
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.75)',
    marginTop: 2,
  },
  section: { padding: spacing.lg },
  sectionTitle: {
    ...typography.h4,
    marginBottom: spacing.md,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  statWrapper: { flex: 1 },
  errorContainer: {
    alignItems: 'center',
    padding: spacing.xxxl,
    marginTop: spacing.xl,
  },
  errorText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  bottomSpacing: { height: spacing.xxl },
});

