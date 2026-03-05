/**
 * AdminDashboardScreen — Professional Liquid Glass Design
 * Clean grid layout with compact navigation tiles and activity feed
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography, shadows,
} from '../../styles/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TILE_GAP = spacing.sm;
const TILE_SIZE = (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP) / 2;

export const calculateAdminStats = (users, stores, products, orders) => {
  const totalUsers = users?.length || 0;
  const totalStores = stores?.length || 0;
  const totalProducts = products?.length || 0;
  const totalOrders = orders?.length || 0;
  const pendingVerifications = stores?.filter(s => !s.verification?.isVerified).length || 0;
  const revenue = orders?.reduce((sum, order) => {
    if (order.status !== 'cancelled') return sum + (order.totalAmount || order.total || 0);
    return sum;
  }, 0) || 0;
  return { totalUsers, totalStores, totalProducts, totalOrders, pendingVerifications, revenue };
};

const getStatusColor = (status) => {
  switch (status) {
    case 'pending': return colors.warning;
    case 'processing': return colors.info;
    case 'shipped': return colors.primary;
    case 'delivered': return colors.success;
    case 'cancelled': return colors.error;
    default: return colors.gray;
  }
};

const getStatusLabel = (status) => {
  return (status || 'unknown').charAt(0).toUpperCase() + (status || 'unknown').slice(1);
};

/* ── Compact Stat Pill ── */
const StatPill = ({ icon, iconColor, label, value, onPress }) => {
  const Wrapper = onPress ? TouchableOpacity : View;
  const wrapperProps = onPress ? { onPress, activeOpacity: 0.7 } : {};
  const formatValue = (v) => {
    if (typeof v === 'number') {
      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
      if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
      return v.toLocaleString();
    }
    return v;
  };
  return (
    <Wrapper {...wrapperProps} style={styles.statPill}>
      <GlassPanel variant="card" style={styles.statPillInner}>
        <View style={[styles.statIcon, { backgroundColor: `${iconColor}18` }]}>
          <Ionicons name={icon} size={20} color={iconColor} />
        </View>
        <Text style={styles.statValue}>{formatValue(value)}</Text>
        <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
      </GlassPanel>
    </Wrapper>
  );
};

/* ── Quick Action Tile ── */
const QuickTile = ({ icon, color, label, onPress, badge }) => (
  <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={styles.quickTile}>
    <GlassPanel variant="inner" style={styles.quickTileInner}>
      <View style={[styles.quickTileIcon, { backgroundColor: `${color}15` }]}>
        <Ionicons name={icon} size={22} color={color} />
        {badge > 0 && (
          <View style={[styles.tileBadge, { backgroundColor: color }]}>
            <Text style={styles.tileBadgeText}>{badge > 99 ? '99+' : badge}</Text>
          </View>
        )}
      </View>
      <Text style={styles.quickTileLabel} numberOfLines={1}>{label}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.grayLight} />
    </GlassPanel>
  </TouchableOpacity>
);

export default function AdminDashboardScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState({ totalUsers: 0, totalStores: 0, totalProducts: 0, totalOrders: 0, pendingVerifications: 0, revenue: 0 });
  const [recentActivity, setRecentActivity] = useState([]);

  useEffect(() => { fetchDashboardData(); }, []);

  const fetchDashboardData = async () => {
    try {
      const [usersRes, storesRes, productsRes, ordersRes] = await Promise.all([
        api.get('/api/user/get').catch(() => ({ data: [] })),
        api.get('/api/stores/all').catch(() => ({ data: { stores: [] } })),
        api.get('/api/products/get-products?limit=50&page=1').catch(() => ({ data: [] })),
        api.get('/api/order/get').catch(() => ({ data: [] })),
      ]);
      const users = usersRes.data?.users || usersRes.data || [];
      const stores = storesRes.data?.stores || [];
      const products = productsRes.data?.products || productsRes.data || [];
      const totalProductsFromPagination = productsRes.data?.pagination?.totalProducts;
      const orders = ordersRes.data?.orders || ordersRes.data || [];
      const computedStats = calculateAdminStats(users, stores, products, orders);
      if (totalProductsFromPagination !== undefined) computedStats.totalProducts = totalProductsFromPagination;
      setStats(computedStats);
      const sortedOrders = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      setRecentActivity(sortedOrders.slice(0, 5));
    } catch (error) { console.error('Error fetching dashboard data:', error); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchDashboardData(); }, []);

  if (isLoading) return <GlassBackground><Loader fullScreen message="Loading dashboard..." /></GlassBackground>;

  const quickActions = [
    { icon: 'people-outline', color: colors.primary, label: 'Users', onPress: () => navigation.navigate('AdminUserManagement'), badge: stats.totalUsers },
    { icon: 'shield-checkmark-outline', color: colors.info, label: 'Verifications', onPress: () => navigation.navigate('StoreVerification'), badge: stats.pendingVerifications },
    { icon: 'business-outline', color: colors.secondary, label: 'All Stores', onPress: () => navigation.navigate('StoreOverview') },
    { icon: 'bar-chart-outline', color: colors.info, label: 'Analytics', onPress: () => navigation.navigate('AdminAnalytics') },
    { icon: 'grid-outline', color: colors.warning, label: 'Products', onPress: () => navigation.navigate('AdminProductManagement') },
    { icon: 'list-outline', color: colors.success, label: 'Orders', onPress: () => navigation.navigate('AdminOrderManagement'), badge: stats.totalOrders },
    { icon: 'calculator-outline', color: colors.error, label: 'Tax Config', onPress: () => navigation.navigate('AdminTaxConfiguration') },
    { icon: 'notifications-outline', color: colors.warning, label: 'Notifications', onPress: () => navigation.navigate('AdminNotifications') },
    { icon: 'options-outline', color: colors.gray, label: 'Settings', onPress: () => navigation.navigate('NotificationSettings') },
  ];

  return (
    <GlassBackground>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* ── Header ── */}
        <GlassPanel variant="strong" style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.headerAvatar}>
              <Ionicons name="shield-checkmark" size={24} color={colors.white} />
            </View>
            <View style={styles.headerInfo}>
              <Text style={styles.headerGreeting}>Welcome back</Text>
              <Text style={styles.headerName}>{currentUser?.name?.split(' ')[0] || 'Admin'}</Text>
            </View>
            <View style={styles.headerBadge}>
              <Ionicons name="sparkles" size={10} color={colors.white} />
              <Text style={styles.headerBadgeText}>Admin</Text>
            </View>
          </View>
        </GlassPanel>

        {/* ── Stats Row ── */}
        <View style={styles.statsSection}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statsScroll}>
            <StatPill icon="people-outline" iconColor={colors.primary} label="Users" value={stats.totalUsers} onPress={() => navigation.navigate('AdminUserManagement')} />
            <StatPill icon="storefront-outline" iconColor={colors.warning} label="Stores" value={stats.totalStores} onPress={() => navigation.navigate('StoreVerification')} />
            <StatPill icon="cube-outline" iconColor={colors.secondary} label="Products" value={stats.totalProducts} onPress={() => navigation.navigate('AdminProductManagement')} />
            <StatPill icon="receipt-outline" iconColor={colors.info} label="Orders" value={stats.totalOrders} onPress={() => navigation.navigate('AdminOrderManagement')} />
            <StatPill icon="cash-outline" iconColor={colors.success} label="Revenue" value={`$${typeof stats.revenue === 'number' ? stats.revenue.toLocaleString() : stats.revenue}`} />
            <StatPill icon="hourglass-outline" iconColor={colors.error} label="Pending" value={stats.pendingVerifications} onPress={() => navigation.navigate('StoreVerification')} />
          </ScrollView>
        </View>

        {/* ── Quick Actions Grid ── */}
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            {quickActions.map((action, i) => (
              <QuickTile key={i} {...action} />
            ))}
          </View>
        </View>

        {/* ── Recent Activity ── */}
        <GlassPanel variant="card" style={styles.activityPanel}>
          <View style={styles.activityHeader}>
            <Text style={styles.sectionTitle}>Recent Orders</Text>
            {recentActivity.length > 0 && (
              <TouchableOpacity onPress={() => navigation.navigate('AdminOrderManagement')} activeOpacity={0.7}>
                <Text style={styles.viewAllText}>View All</Text>
              </TouchableOpacity>
            )}
          </View>
          {recentActivity.length > 0 ? (
            recentActivity.map((order, index) => (
              <TouchableOpacity
                key={order._id || index} style={[styles.activityRow, index < recentActivity.length - 1 && styles.activityRowBorder]}
                activeOpacity={0.7}
                onPress={() => navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin: true })}
              >
                <View style={[styles.activityDot, { backgroundColor: getStatusColor(order.status) }]} />
                <View style={styles.activityInfo}>
                  <Text style={styles.activityOrderId}>#{order._id?.slice(-6).toUpperCase()}</Text>
                  <Text style={styles.activityDate}>{new Date(order.createdAt).toLocaleDateString()}</Text>
                </View>
                <View style={styles.activityRight}>
                  <Text style={styles.activityAmount}>${(order.totalAmount || order.total || 0).toFixed(2)}</Text>
                  <View style={[styles.statusChip, { backgroundColor: `${getStatusColor(order.status)}18` }]}>
                    <Text style={[styles.statusChipText, { color: getStatusColor(order.status) }]}>{getStatusLabel(order.status)}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))
          ) : (
            <View style={styles.emptyActivity}>
              <Ionicons name="time-outline" size={36} color={colors.grayLight} />
              <Text style={styles.emptyText}>No recent activity</Text>
            </View>
          )}
        </GlassPanel>

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },

  /* Header */
  header: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  headerAvatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center',
  },
  headerInfo: { flex: 1, marginLeft: spacing.md },
  headerGreeting: { fontSize: fontSize.sm, color: colors.textSecondary },
  headerName: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  headerBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.error, paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: borderRadius.full,
  },
  headerBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.white },

  /* Stats */
  statsSection: { marginTop: spacing.md },
  statsScroll: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  statPill: { width: 100 },
  statPillInner: { padding: spacing.md, alignItems: 'center' },
  statIcon: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xs },
  statValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text, marginBottom: 2 },
  statLabel: { fontSize: fontSize.xs, color: colors.textSecondary },

  /* Quick Actions */
  sectionContainer: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickTile: { width: (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP * 2) / 3 },
  quickTileInner: { padding: spacing.md, alignItems: 'center', minHeight: 90 },
  quickTileIcon: {
    width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xs,
  },
  quickTileLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: colors.text, textAlign: 'center', marginBottom: 2 },
  tileBadge: {
    position: 'absolute', top: -4, right: -6,
    minWidth: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  tileBadgeText: { fontSize: 9, fontWeight: fontWeight.bold, color: colors.white },

  /* Activity */
  activityPanel: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  activityHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  viewAllText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  activityRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  activityRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(0,0,0,0.06)' },
  activityDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.md },
  activityInfo: { flex: 1 },
  activityOrderId: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text },
  activityDate: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  activityRight: { alignItems: 'flex-end' },
  activityAmount: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.text, marginBottom: 3 },
  statusChip: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.full },
  statusChipText: { fontSize: 9, fontWeight: fontWeight.semibold },
  emptyActivity: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyText: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: spacing.sm },
});
