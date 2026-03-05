/**
 * SellerDashboardScreen — Professional Liquid Glass Design
 * Clean grid layout with compact navigation tiles and recent orders
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import OrderCard from '../../components/common/OrderCard';
import Loader from '../../components/common/Loader';
import { EmptyOrders } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography,
} from '../../styles/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TILE_GAP = spacing.sm;

export const calculateSellerStats = (products, orders) => {
  const totalProducts = products?.length || 0;
  const totalOrders = orders?.length || 0;
  const pendingOrders = orders?.filter(o => o.status === 'pending' || o.status === 'processing').length || 0;
  const revenue = orders?.reduce((sum, order) => {
    if (order.status !== 'cancelled') return sum + (order.total || 0);
    return sum;
  }, 0) || 0;
  return { totalProducts, totalOrders, pendingOrders, revenue };
};

/* ── Mini Stat Card ── */
const MiniStat = ({ icon, iconColor, label, value, onPress }) => {
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
    <Wrapper {...wrapperProps} style={styles.miniStat}>
      <GlassPanel variant="card" style={styles.miniStatInner}>
        <View style={[styles.miniStatIcon, { backgroundColor: `${iconColor}15` }]}>
          <Ionicons name={icon} size={18} color={iconColor} />
        </View>
        <View style={styles.miniStatContent}>
          <Text style={styles.miniStatValue}>{formatValue(value)}</Text>
          <Text style={styles.miniStatLabel} numberOfLines={1}>{label}</Text>
        </View>
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

export default function SellerDashboardScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState({ totalProducts: 0, totalOrders: 0, pendingOrders: 0, revenue: 0 });

  useEffect(() => { fetchDashboardData(); }, []);

  const fetchDashboardData = async () => {
    try {
      const storeRes = await api.get('/api/stores/my-store').catch(() => ({ data: { store: null } }));
      setStore(storeRes.data?.store);
      const productsRes = await api.get('/api/products/get-seller-products').catch(() => ({ data: [] }));
      const fetchedProducts = productsRes.data?.products || productsRes.data || [];
      setProducts(fetchedProducts);
      const ordersRes = await api.get('/api/order/get').catch(() => ({ data: { orders: [] } }));
      const fetchedOrders = ordersRes.data?.orders || [];
      setOrders(fetchedOrders);
      setStats(calculateSellerStats(fetchedProducts, fetchedOrders));
    } catch (error) { console.error('Error fetching dashboard data:', error); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchDashboardData(); }, []);
  const recentOrders = orders.slice(0, 5);

  if (isLoading) return <GlassBackground><Loader fullScreen message="Loading dashboard..." /></GlassBackground>;

  const quickActions = [
    { icon: 'cube-outline', color: colors.secondary, label: 'Products', onPress: () => navigation.navigate('SellerProductManagement'), badge: stats.totalProducts },
    { icon: 'receipt-outline', color: colors.info, label: 'Orders', onPress: () => navigation.navigate('SellerOrderManagement'), badge: stats.pendingOrders },
    { icon: 'storefront-outline', color: colors.primary, label: 'Store', onPress: () => navigation.navigate('SellerStoreSettings') },
    { icon: 'car-outline', color: colors.warning, label: 'Shipping', onPress: () => navigation.navigate('SellerShippingConfiguration') },
    { icon: 'bar-chart-outline', color: colors.success, label: 'Analytics', onPress: () => navigation.navigate('SellerAnalytics') },
    { icon: 'notifications-outline', color: colors.error, label: 'Alerts', onPress: () => navigation.navigate('SellerNotifications') },
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
              <Ionicons name="storefront" size={22} color={colors.white} />
            </View>
            <View style={styles.headerInfo}>
              <Text style={styles.headerGreeting}>Welcome back</Text>
              <Text style={styles.headerName}>{currentUser?.name?.split(' ')[0] || 'Seller'}</Text>
            </View>
            {store && (
              <TouchableOpacity
                style={styles.viewStoreBtn}
                onPress={() => navigation.navigate('Store', { storeSlug: store.slug })}
                activeOpacity={0.8}
              >
                <Text style={styles.viewStoreBtnText}>View Store</Text>
                <Ionicons name="open-outline" size={14} color={colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {store?.name && (
            <View style={styles.storeNameRow}>
              <Ionicons name="business-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.storeName}>{store.name}</Text>
            </View>
          )}
        </GlassPanel>

        {/* ── Stats Grid ── */}
        <View style={styles.statsGrid}>
          <MiniStat icon="cube-outline" iconColor={colors.secondary} label="Products" value={stats.totalProducts} onPress={() => navigation.navigate('SellerProductManagement')} />
          <MiniStat icon="receipt-outline" iconColor={colors.info} label="Orders" value={stats.totalOrders} onPress={() => navigation.navigate('SellerOrderManagement')} />
          <MiniStat icon="cash-outline" iconColor={colors.success} label="Revenue" value={`$${stats.revenue.toLocaleString()}`} />
          <MiniStat icon="time-outline" iconColor={colors.warning} label="Pending" value={stats.pendingOrders} onPress={() => navigation.navigate('SellerOrderManagement')} />
        </View>

        {/* ── Quick Actions ── */}
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            {quickActions.map((action, i) => (
              <QuickTile key={i} {...action} />
            ))}
          </View>
        </View>

        {/* ── Recent Orders ── */}
        <GlassPanel variant="card" style={styles.ordersPanel}>
          <View style={styles.ordersHeader}>
            <Text style={styles.sectionTitle}>Recent Orders</Text>
            {orders.length > 0 && (
              <TouchableOpacity onPress={() => navigation.navigate('SellerOrderManagement')} activeOpacity={0.7}>
                <Text style={styles.viewAllText}>View All</Text>
              </TouchableOpacity>
            )}
          </View>
          {recentOrders.length > 0 ? (
            <View style={styles.ordersContainer}>
              {recentOrders.map((order) => (
                <OrderCard key={order._id} order={order}
                  onPress={() => navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin: false })}
                  showCustomer={true} />
              ))}
            </View>
          ) : (
            <EmptyOrders onBrowse={null} />
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
  viewStoreBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: `${colors.primary}12`, paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  viewStoreBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.primary },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(0,0,0,0.06)' },
  storeName: { fontSize: fontSize.sm, color: colors.textSecondary },

  /* Stats */
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  miniStat: { width: (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP) / 2 },
  miniStatInner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  miniStatIcon: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm },
  miniStatContent: { flex: 1 },
  miniStatValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  miniStatLabel: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },

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

  /* Orders */
  ordersPanel: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  ordersHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  viewAllText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  ordersContainer: { gap: spacing.sm },
});
