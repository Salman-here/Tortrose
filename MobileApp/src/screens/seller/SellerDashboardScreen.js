/**
 * SellerDashboardScreen — Professional Liquid Glass Design
 * Matched to the website's SellerHome: welcome hub, accurate stats
 * (paid-only revenue, conversion), stock alerts, order summary bar,
 * quick-action tiles, and recent orders.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Dimensions, SafeAreaView, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import OrderCard from '../../components/common/OrderCard';
import Loader from '../../components/common/Loader';
import { EmptyOrders } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import AIChatFab from '../../components/common/AIChatFab';
import ChatBot from '../../components/ChatBot';
import { spacing, fontSize, borderRadius, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TILE_GAP = spacing.sm;

// Mirrors the website's SellerHome math exactly:
// revenue counts PAID orders only (converted per-order currency),
// pending/processing/delivered match orderStatus, conversion = delivered/total.
export const calculateSellerStats = (products, orders, convertAmount = (amount) => Number(amount || 0), targetCurrency = 'USD') => {
  const totalProducts = products?.length || 0;
  const totalOrders = orders?.length || 0;
  const statusOf = (o) => o.orderStatus || o.status;
  const pendingOrders = orders?.filter(o => statusOf(o) === 'pending').length || 0;
  const processingOrders = orders?.filter(o => statusOf(o) === 'processing').length || 0;
  const deliveredOrders = orders?.filter(o => statusOf(o) === 'delivered').length || 0;
  const outOfStock = products?.filter(p => p.stock === 0).length || 0;
  const lowStock = products?.filter(p => p.stock <= 10 && p.stock > 0).length || 0;
  const revenue = orders?.reduce((sum, order) => (
    order.isPaid
      ? sum + convertAmount(order.orderSummary?.totalAmount || 0, order.currency || 'USD', targetCurrency)
      : sum
  ), 0) || 0;
  const conversion = totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0;
  return { totalProducts, totalOrders, pendingOrders, processingOrders, deliveredOrders, outOfStock, lowStock, revenue, conversion };
};

export const getGreeting = (hour = new Date().getHours()) => {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

export default function SellerDashboardScreen({ navigation }) {
  const { palette } = useTheme();
  const { currency, convertAmount, formatAmount } = useCurrency();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(calculateSellerStats([], []));
  const [showAI, setShowAI] = useState(false);
  const [subscription, setSubscription] = useState(null);
  const [showFounderOffer, setShowFounderOffer] = useState(false);

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
      const nextSubscription = subRes.data?.subscription;
      setSubscription(nextSubscription);

      const promotion = nextSubscription?.founderPromotion;
      if (promotion?.available && promotion?.sellerEligible && !promotion?.entitlementActive) {
        try {
          const sellerKey = currentUser?._id || currentUser?.id || currentUser?.email || 'seller';
          const storageKey = `rozare-founder-promotion-last-shown:${sellerKey}`;
          const lastShown = Number(await AsyncStorage.getItem(storageKey) || 0);
          if (!lastShown || Date.now() - lastShown >= 4 * 60 * 60 * 1000) {
            await AsyncStorage.setItem(storageKey, String(Date.now()));
            setShowFounderOffer(true);
          }
        } catch (storageError) {
          console.warn('Founder promotion display storage unavailable:', storageError?.message);
          setShowFounderOffer(true);
        }
      }
    } catch (error) { console.error('Error fetching dashboard data:', error); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchDashboardData(); }, []);
  // Newest first — sort explicitly so we don't depend on API ordering
  const recentOrders = [...orders]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 5);

  const formatCompactPrice = (amount) => {
    const value = Number(amount) || 0;
    const symbol = String(formatAmount(0)).replace(/[0-9.,\s]/g, '');
    if (value >= 1000000) return `${symbol}${(value / 1000000).toFixed(1)}M`;
    if (value >= 10000) return `${symbol}${(value / 1000).toFixed(1)}K`;
    return formatAmount(value);
  };

  if (isLoading) return <GlassBackground><SafeAreaView style={{ flex: 1 }}><Loader fullScreen message="Loading dashboard..." /></SafeAreaView></GlassBackground>;

  const isTrialExpiring = subscription?.isTrialExpiringSoon;
  const isBlocked = subscription?.status === 'blocked';
  const storeName = store?.storeName || store?.name;

  const heroStats = [
    { label: 'Total Revenue', value: formatCompactPrice(stats.revenue), icon: 'cash-outline', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    { label: 'Total Orders', value: stats.totalOrders, icon: 'bag-handle-outline', color: '#6366f1', bg: 'rgba(99,102,241,0.12)', onPress: () => navigation.navigate('SellerOrderManagement') },
    { label: 'Total Products', value: stats.totalProducts, icon: 'cube-outline', color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)', onPress: () => navigation.navigate('SellerProductManagement') },
    { label: 'Conversion', value: `${stats.conversion}%`, icon: 'trending-up-outline', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  ];

  const orderSummary = [
    { label: 'Pending', count: stats.pendingOrders, color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
    { label: 'Processing', count: stats.processingOrders, color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
    { label: 'Delivered', count: stats.deliveredOrders, color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    { label: 'Low Stock', count: stats.lowStock + stats.outOfStock, color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  ];

  const quickActions = [
    { icon: 'cube-outline', color: '#0ea5e9', label: 'Products', onPress: () => navigation.navigate('SellerProductManagement'), badge: stats.totalProducts },
    { icon: 'receipt-outline', color: '#6366f1', label: 'Orders', onPress: () => navigation.navigate('SellerOrderManagement'), badge: stats.pendingOrders },
    { icon: 'wallet-outline', color: '#10b981', label: 'Payments', onPress: () => navigation.navigate('SellerPayments') },
    { icon: 'storefront-outline', color: '#8b5cf6', label: 'Store', onPress: () => navigation.navigate('SellerStoreSettings') },
    { icon: 'car-outline', color: '#f59e0b', label: 'Shipping', onPress: () => navigation.navigate('SellerShippingConfiguration') },
    { icon: 'pricetag-outline', color: '#f97316', label: 'Coupons', onPress: () => navigation.navigate('SellerCouponManagement') },
    { icon: 'bar-chart-outline', color: '#14b8a6', label: 'Analytics', onPress: () => navigation.navigate('SellerAnalytics') },
    { icon: 'globe-outline', color: '#0284c7', label: 'Subdomain', onPress: () => navigation.navigate('SellerSubdomainManagement') },
    { icon: 'diamond-outline', color: '#a855f7', label: 'Plan', onPress: () => navigation.navigate('SellerSubscription') },
    { icon: 'logo-whatsapp', color: '#22c55e', label: 'WhatsApp', onPress: () => navigation.navigate('SellerWhatsAppSettings') },
    { icon: 'chatbubbles-outline', color: '#ec4899', label: 'Complaints', onPress: () => navigation.navigate('SellerComplaints') },
    { icon: 'person-circle-outline', color: '#06b6d4', label: 'Profile', onPress: () => navigation.navigate('SellerProfile') },
  ];

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        {/* ── Top Bar: back + title ── */}
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} accessibilityLabel="Go back">
            <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
          </TouchableOpacity>
          <Text style={styles.topBarTitle}>Seller Dashboard</Text>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.navigate('SellerNotifications')} accessibilityLabel="Seller notifications">
            <Ionicons name="notifications-outline" size={19} color={palette.colors.text} />
          </TouchableOpacity>
        </View>

        {/* Subscription Warnings */}
        {isBlocked && (
          <TouchableOpacity onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.8} style={[styles.alertBanner, { backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }]}>
            <Ionicons name="lock-closed" size={16} color={palette.colors.error} />
            <Text style={[styles.alertBannerText, { color: palette.colors.error }]}>Store Blocked — Subscribe to reactivate</Text>
            <Ionicons name="chevron-forward" size={14} color={palette.colors.error} />
          </TouchableOpacity>
        )}
        {isTrialExpiring && !isBlocked && (
          <TouchableOpacity onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.8} style={[styles.alertBanner, { backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.25)' }]}>
            <Ionicons name="alert-circle" size={16} color={palette.colors.warning} />
            <Text style={[styles.alertBannerText, { color: palette.colors.warning }]}>Trial expiring in {subscription?.trialDaysRemaining} days — Subscribe now</Text>
            <Ionicons name="chevron-forward" size={14} color={palette.colors.warning} />
          </TouchableOpacity>
        )}

        {/* ── Welcome Hub (matches website) ── */}
        <GlassPanel variant="strong" style={styles.header}>
          <View style={styles.tagPill}>
            <Ionicons name="sparkles" size={11} color={palette.colors.primary} />
            <Text style={styles.tagPillText}>Seller Hub</Text>
          </View>
          <Text style={styles.headerName}>{getGreeting()}, {currentUser?.name?.split(' ')[0] || currentUser?.username || 'Seller'}</Text>
          <Text style={styles.headerSub}>Here's what's happening with your store today</Text>
          {storeName && (
            <View style={styles.storeNameRow}>
              <Ionicons name="business-outline" size={14} color={palette.colors.textSecondary} />
              <Text style={styles.storeName}>{storeName}</Text>
              {store?.storeSlug && (
                <TouchableOpacity style={styles.viewStoreBtn} onPress={() => navigation.navigate('Store', { storeSlug: store.storeSlug })} activeOpacity={0.8}>
                  <Text style={styles.viewStoreBtnText}>View Store</Text>
                  <Ionicons name="open-outline" size={12} color={palette.colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          )}
          <TouchableOpacity style={styles.addProductBtn} onPress={() => navigation.navigate('ProductForm', { isAdmin: false })} activeOpacity={0.85}>
            <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            <Ionicons name="flash" size={15} color="#fff" />
            <Text style={styles.addProductBtnText}>Add Product</Text>
          </TouchableOpacity>
        </GlassPanel>

        {/* ── Stats Grid (matches website: revenue/orders/products/conversion) ── */}
        <View style={styles.statsGrid}>
          {heroStats.map((stat) => {
            const Wrapper = stat.onPress ? TouchableOpacity : View;
            return (
              <Wrapper key={stat.label} onPress={stat.onPress} activeOpacity={0.75} style={styles.statCardWrap}>
                <GlassPanel variant="card" style={styles.statCard}>
                  <View style={[styles.statIcon, { backgroundColor: stat.bg }]}>
                    <Ionicons name={stat.icon} size={20} color={stat.color} />
                  </View>
                  <Text style={styles.statLabel}>{stat.label}</Text>
                  <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{stat.value}</Text>
                </GlassPanel>
              </Wrapper>
            );
          })}
        </View>

        {/* ── Stock Alerts (matches website) ── */}
        {(stats.outOfStock > 0 || stats.lowStock > 0) && (
          <View style={styles.alertsSection}>
            {stats.outOfStock > 0 && (
              <TouchableOpacity onPress={() => navigation.navigate('SellerProductManagement')} activeOpacity={0.8}>
                <GlassPanel variant="card" style={[styles.stockAlert, { borderLeftColor: '#ef4444' }]}>
                  <View style={[styles.stockAlertIcon, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
                    <Ionicons name="warning-outline" size={18} color="#ef4444" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.stockAlertTitle}>{stats.outOfStock} product{stats.outOfStock > 1 ? 's' : ''} out of stock</Text>
                    <Text style={styles.stockAlertSub}>Update inventory to avoid lost sales</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={16} color={palette.colors.textSecondary} />
                </GlassPanel>
              </TouchableOpacity>
            )}
            {stats.lowStock > 0 && (
              <TouchableOpacity onPress={() => navigation.navigate('SellerProductManagement')} activeOpacity={0.8}>
                <GlassPanel variant="card" style={[styles.stockAlert, { borderLeftColor: '#f59e0b' }]}>
                  <View style={[styles.stockAlertIcon, { backgroundColor: 'rgba(245,158,11,0.12)' }]}>
                    <Ionicons name="alert-circle-outline" size={18} color="#b45309" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.stockAlertTitle}>{stats.lowStock} product{stats.lowStock > 1 ? 's' : ''} running low</Text>
                    <Text style={styles.stockAlertSub}>Stock below 10 units</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={16} color={palette.colors.textSecondary} />
                </GlassPanel>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Order Summary Bar (matches website) ── */}
        <View style={styles.summaryBar}>
          {orderSummary.map((item) => (
            <View key={item.label} style={[styles.summaryTile, { backgroundColor: item.bg }]}>
              <Text style={[styles.summaryCount, { color: item.color }]}>{item.count}</Text>
              <Text style={styles.summaryLabel}>{item.label}</Text>
            </View>
          ))}
        </View>

        {/* ── Quick Actions ── */}
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            {quickActions.map((action, i) => (
              <TouchableOpacity key={i} onPress={action.onPress} activeOpacity={0.7} style={styles.quickTile}>
                <GlassPanel variant="inner" style={styles.quickTileInner}>
                  <View style={[styles.quickTileIcon, { backgroundColor: `${action.color}15` }]}>
                    <Ionicons name={action.icon} size={22} color={action.color} />
                    {action.badge > 0 && (
                      <View style={[styles.tileBadge, { backgroundColor: action.color }]}>
                        <Text style={styles.tileBadgeText}>{action.badge > 99 ? '99+' : action.badge}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.quickTileLabel} numberOfLines={1}>{action.label}</Text>
                </GlassPanel>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Recent Orders ── */}
        <GlassPanel variant="card" style={styles.ordersPanel}>
          <View style={styles.ordersHeader}>
            <Text style={styles.sectionTitle}>Recent Orders</Text>
            {orders.length > 0 && (
              <TouchableOpacity onPress={() => navigation.navigate('SellerOrderManagement')} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <Text style={styles.viewAllText}>View all</Text>
                <Ionicons name="arrow-forward" size={12} color={palette.colors.primary} />
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

      <Modal
        visible={showFounderOffer}
        transparent
        animationType="fade"
        onRequestClose={() => setShowFounderOffer(false)}
      >
        <View style={styles.founderBackdrop}>
          <GlassPanel variant="strong" style={styles.founderModal}>
            <TouchableOpacity
              onPress={() => setShowFounderOffer(false)}
              style={styles.founderClose}
              accessibilityLabel="Close founder offer"
            >
              <Ionicons name="close" size={20} color={palette.colors.textSecondary} />
            </TouchableOpacity>
            <View style={styles.founderIcon}>
              <Ionicons name="pricetag" size={23} color={palette.colors.primary} />
            </View>
            <Text style={styles.founderEyebrow}>FIRST 100 SELLERS</Text>
            <Text style={styles.founderModalTitle}>Lock in an extra 40% off</Text>
            <Text style={styles.founderModalText}>Use FIRST100 for Starter at $5.99/month or Elite at $12.99/month.</Text>
            <View style={styles.founderRemaining}>
              <Text style={styles.founderRemainingText}>
                {subscription?.founderPromotion?.sellerHasReservation
                  ? 'A founder spot is currently reserved for your account'
                  : `${subscription?.founderPromotion?.remaining} of ${subscription?.founderPromotion?.maxRedemptions} founder spots remaining`}
              </Text>
            </View>
            <Text style={styles.founderFinePrint}>The rate stays through plan changes while your subscription remains uninterrupted. It ends permanently if you unsubscribe.</Text>
            <TouchableOpacity
              style={styles.founderCta}
              onPress={() => {
                setShowFounderOffer(false);
                navigation.navigate('SellerSubscription', { couponCode: subscription?.founderPromotion?.code || 'FIRST100' });
              }}
            >
              <Text style={styles.founderCtaText}>View Plans</Text>
              <Ionicons name="arrow-forward" size={17} color="#fff" />
            </TouchableOpacity>
          </GlassPanel>
        </View>
      </Modal>

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

  founderBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  founderModal: { width: '100%', maxWidth: 440, padding: spacing.xl, position: 'relative' },
  founderClose: { position: 'absolute', top: spacing.md, right: spacing.md, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  founderIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: `${p.colors.primary}15`, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  founderEyebrow: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.primary },
  founderModalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: 3, paddingRight: spacing.xl },
  founderModalText: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: spacing.sm, lineHeight: 20 },
  founderRemaining: { alignSelf: 'flex-start', backgroundColor: `${p.colors.success}12`, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, marginTop: spacing.lg },
  founderRemainingText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.success },
  founderFinePrint: { fontSize: 10, color: p.colors.textSecondary, marginTop: spacing.md, lineHeight: 15 },
  founderCta: { minHeight: 46, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  founderCtaText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },

  /* Top bar */
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  backBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, justifyContent: 'center', alignItems: 'center' },
  topBarTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },

  /* Banners */
  alertBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, borderWidth: 1 },
  alertBannerText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, flex: 1 },

  /* Welcome hub */
  header: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.xl },
  tagPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: borderRadius.full, marginBottom: spacing.md },
  tagPillText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  headerName: { fontSize: fontSize.xxxl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.5 },
  headerSub: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 4 },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.borderSubtle },
  storeName: { flex: 1, fontSize: fontSize.sm, color: p.colors.textSecondary },
  viewStoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: borderRadius.full },
  viewStoreBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },
  addProductBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.lg, paddingVertical: spacing.md, borderRadius: borderRadius.xl, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  addProductBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },

  /* Stats */
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  statCardWrap: { width: (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP) / 2 },
  statCard: { padding: spacing.lg },
  statIcon: { width: 42, height: 42, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  statLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: p.colors.textSecondary, marginBottom: 2 },
  statValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.6 },

  /* Stock alerts */
  alertsSection: { paddingHorizontal: spacing.lg, marginTop: spacing.md, gap: spacing.sm },
  stockAlert: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderLeftWidth: 3 },
  stockAlertIcon: { width: 36, height: 36, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  stockAlertTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  stockAlertSub: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 1 },

  /* Order summary bar */
  summaryBar: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  summaryTile: { flex: 1, alignItems: 'center', paddingVertical: spacing.md, borderRadius: borderRadius.xl },
  summaryCount: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, letterSpacing: -0.6 },
  summaryLabel: { fontSize: 10, fontWeight: fontWeight.medium, color: p.colors.textSecondary, marginTop: 2 },

  /* Quick Actions */
  sectionContainer: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.sm },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickTile: { width: (SCREEN_WIDTH - spacing.lg * 2 - TILE_GAP * 2) / 3 },
  quickTileInner: { padding: spacing.md, alignItems: 'center', minHeight: 90 },
  quickTileIcon: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xs },
  quickTileLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: p.colors.text, textAlign: 'center', marginBottom: 2 },
  tileBadge: { position: 'absolute', top: -4, right: -6, minWidth: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  tileBadgeText: { fontSize: 9, fontWeight: fontWeight.bold, color: '#fff' },

  /* Orders */
  ordersPanel: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  ordersHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  viewAllText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  ordersContainer: { gap: spacing.sm },
});
