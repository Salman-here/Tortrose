/**
 * SellerDashboardScreen — Professional Liquid Glass Design
 * Clean grid layout with compact navigation tiles and recent orders
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Dimensions, SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import OrderCard from '../../components/common/OrderCard';
import Loader from '../../components/common/Loader';
import { EmptyOrders } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import AIChatFab from '../../components/common/AIChatFab';
import ChatBot from '../../components/ChatBot';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TILE_GAP = spacing.sm;

export const calculateSellerStats = (products, orders, convertAmount = (amount) => Number(amount || 0), targetCurrency = 'USD') => {
  const totalProducts = products?.length || 0;
  const totalOrders = orders?.length || 0;
  const pendingOrders = orders?.filter(o => {
    const status = o.orderStatus || o.status;
    return status === 'pending' || status === 'confirmed' || status === 'processing';
  }).length || 0;
  const revenue = orders?.reduce((sum, order) => {
    const status = order.orderStatus || order.status;
    if (status !== 'cancelled') {
      const total = order.orderSummary?.totalAmount ?? order.totalAmount ?? order.total ?? 0;
      return sum + convertAmount(total, order.currency || targetCurrency, targetCurrency);
    }
    return sum;
  }, 0) || 0;
  return { totalProducts, totalOrders, pendingOrders, revenue };
};

export default function SellerDashboardScreen({ navigation }) {
  const { palette } = useTheme();
  const { currency, convertAmount, formatAmount } = useCurrency();
  const styles = buildStyles(palette);

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
      </GlassPanel>
    </TouchableOpacity>
  );

  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState({ totalProducts: 0, totalOrders: 0, pendingOrders: 0, revenue: 0 });
  const [showAI, setShowAI] = useState(false);
  const [subscription, setSubscription] = useState(null);

  useEffect(() => { fetchDashboardData(); }, []);

  const fetchDashboardData = async () => {
    try {
      const [storeRes, productsRes, ordersRes, subRes] = await Promise.all([
        api.get('/api/stores/my-store').catch(() => ({ data: { store: null } })),
        api.get('/api/products/get-seller-products').catch(() => ({ data: [] })),
        api.get('/api/order/get').catch(() => ({ data: { orders: [] } })),
        api.get('/api/subscription/status').catch(() => ({ data: { subscription: null } })),
      ]);
      setStore(storeRes.data?.store);
      const fetchedProducts = productsRes.data?.products || productsRes.data || [];
      setProducts(fetchedProducts);
      const fetchedOrders = ordersRes.data?.orders || [];
      setOrders(fetchedOrders);
      setStats(calculateSellerStats(fetchedProducts, fetchedOrders, convertAmount, currency));
      setSubscription(subRes.data?.subscription);
    } catch (error) { console.error('Error fetching dashboard data:', error); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchDashboardData(); }, []);
  const recentOrders = orders.slice(0, 5);

  if (isLoading) return <GlassBackground><SafeAreaView style={{flex:1}}><Loader fullScreen message="Loading dashboard..." /></SafeAreaView></GlassBackground>;

  const isTrialExpiring = subscription?.isTrialExpiringSoon;
  const isBlocked = subscription?.status === 'blocked';

  const quickActions = [
    { icon: 'cube-outline', color: palette.colors.secondary, label: 'Products', onPress: () => navigation.navigate('SellerProductManagement'), badge: stats.totalProducts },
    { icon: 'receipt-outline', color: palette.colors.info, label: 'Orders', onPress: () => navigation.navigate('SellerOrderManagement'), badge: stats.pendingOrders },
    { icon: 'wallet-outline', color: '#10b981', label: 'Payments', onPress: () => navigation.navigate('SellerPayments') },
    { icon: 'storefront-outline', color: palette.colors.primary, label: 'Store', onPress: () => navigation.navigate('SellerStoreSettings') },
    { icon: 'car-outline', color: palette.colors.warning, label: 'Shipping', onPress: () => navigation.navigate('SellerShippingConfiguration') },
    { icon: 'pricetag-outline', color: '#f97316', label: 'Coupons', onPress: () => navigation.navigate('SellerCouponManagement') },
    { icon: 'bar-chart-outline', color: palette.colors.success, label: 'Analytics', onPress: () => navigation.navigate('SellerAnalytics') },
    { icon: 'globe-outline', color: '#0ea5e9', label: 'Subdomain', onPress: () => navigation.navigate('SellerSubdomainManagement') },
    { icon: 'diamond-outline', color: '#8b5cf6', label: 'Plan', onPress: () => navigation.navigate('SellerSubscription') },
    { icon: 'logo-whatsapp', color: '#22C55E', label: 'WhatsApp', onPress: () => navigation.navigate('SellerWhatsAppSettings') },
    { icon: 'chatbubbles-outline', color: '#f97316', label: 'Complaints', onPress: () => navigation.navigate('SellerComplaints') },
    { icon: 'person-circle-outline', color: '#06b6d4', label: 'Profile', onPress: () => navigation.navigate('SellerProfile') },
  ];

  return (
    <GlassBackground>
      <SafeAreaView style={{flex:1}}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        {/* Subscription Warnings */}
        {isBlocked && (
          <TouchableOpacity onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.8}
            style={{ marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${palette.colors.error}10`, borderWidth: 1, borderColor: `${palette.colors.error}25` }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="lock-closed" size={16} color={palette.colors.error} />
              <Text style={{ fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: palette.colors.error, flex: 1 }}>Store Blocked — Subscribe to reactivate</Text>
              <Ionicons name="chevron-forward" size={14} color={palette.colors.error} />
            </View>
          </TouchableOpacity>
        )}
        {isTrialExpiring && !isBlocked && (
          <TouchableOpacity onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.8}
            style={{ marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${palette.colors.warning}10`, borderWidth: 1, borderColor: `${palette.colors.warning}25` }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={16} color={palette.colors.warning} />
              <Text style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: palette.colors.warning, flex: 1 }}>Trial expiring in {subscription?.trialDaysRemaining} days — Subscribe now</Text>
              <Ionicons name="chevron-forward" size={14} color={palette.colors.warning} />
            </View>
          </TouchableOpacity>
        )}

        {/* ── Header ── */}
        <GlassPanel variant="strong" style={styles.header}>
          <View style={styles.headerRow}>
            <View style={styles.headerAvatar}>
              <Ionicons name="storefront" size={22} color={palette.colors.white} />
            </View>
            <View style={styles.headerInfo}>
              <Text style={styles.headerGreeting}>Welcome back</Text>
              <Text style={styles.headerName}>{currentUser?.name?.split(' ')[0] || 'Seller'}</Text>
            </View>
            {store && (
              <TouchableOpacity
                style={styles.viewStoreBtn}
                onPress={() => navigation.navigate('Store', { storeSlug: store.storeSlug || store.slug })}
                activeOpacity={0.8}
              >
                <Text style={styles.viewStoreBtnText}>View Store</Text>
                <Ionicons name="open-outline" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          {store?.name && (
            <View style={styles.storeNameRow}>
              <Ionicons name="business-outline" size={14} color={palette.colors.textSecondary} />
              <Text style={styles.storeName}>{store.name}</Text>
            </View>
          )}
        </GlassPanel>

        {/* ── Stats Grid ── */}
        <View style={styles.statsGrid}>
          <MiniStat icon="cube-outline" iconColor={palette.colors.secondary} label="Products" value={stats.totalProducts} onPress={() => navigation.navigate('SellerProductManagement')} />
          <MiniStat icon="receipt-outline" iconColor={palette.colors.info} label="Orders" value={stats.totalOrders} onPress={() => navigation.navigate('SellerOrderManagement')} />
          <MiniStat icon="cash-outline" iconColor={palette.colors.success} label="Revenue" value={formatAmount(stats.revenue)} />
          <MiniStat icon="time-outline" iconColor={palette.colors.warning} label="Pending" value={stats.pendingOrders} onPress={() => navigation.navigate('SellerOrderManagement')} />
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

      {/* AI FAB — matches website chat launcher */}
      <AIChatFab onPress={() => setShowAI(true)} style={{ bottom: 24, right: 20 }} />

      {/* AI ChatBot */}
      <ChatBot embedded={false} dashboardRole="seller" visible={showAI} onClose={() => setShowAI(false)} navigation={navigation} />
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },

  /* Header */
  header: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  headerAvatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center',
  },
  headerInfo: { flex: 1, marginLeft: spacing.md },
  headerGreeting: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  headerName: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  viewStoreBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: `${p.colors.primary}12`, paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  viewStoreBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.borderSubtle },
  storeName: { fontSize: fontSize.sm, color: p.colors.textSecondary },

  /* Stats */
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  miniStat: { width: (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP) / 2 },
  miniStatInner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  miniStatIcon: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm },
  miniStatContent: { flex: 1 },
  miniStatValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  miniStatLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 1 },

  /* Quick Actions */
  sectionContainer: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.sm },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickTile: { width: (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP * 2) / 3 },
  quickTileInner: { padding: spacing.md, alignItems: 'center', minHeight: 90 },
  quickTileIcon: {
    width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xs,
  },
  quickTileLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: p.colors.text, textAlign: 'center', marginBottom: 2 },
  tileBadge: {
    position: 'absolute', top: -4, right: -6,
    minWidth: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  tileBadgeText: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.white },

  /* Orders */
  ordersPanel: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  ordersHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  viewAllText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  ordersContainer: { gap: spacing.sm },
});
