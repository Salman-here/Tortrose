/**
 * SellerDashboardScreen — Professional Liquid Glass Design
 * Matched to the website's SellerHome: welcome hub, accurate stats
 * (recognized online/delivered-COD revenue, conversion), stock alerts, order summary bar,
 * quick-action tiles, and recent orders.
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity, Modal, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import api, { API_ENDPOINTS } from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import OrderCard from '../../components/common/OrderCard';
import { EmptyOrders } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import AIChatFab from '../../components/common/AIChatFab';
import { spacing, fontSize, borderRadius, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { inspectSellerProductCurrencyState } from '../../utils/productCurrencyState';
import {
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { fetchCompleteSellerCatalog } from '../../utils/sellerCatalog';
import {
  calculateSellerStats,
  readNonNegativePresentationCount,
  selectAuthoritativeSellerMetrics,
  selectAuthoritativeSellerRevenue,
  sellerInventorySnapshotIsValid,
  sellerOrdersSnapshotIsValid,
} from '../../utils/sellerDashboardStats';

export { fetchCompleteSellerCatalog } from '../../utils/sellerCatalog';
export { calculateSellerStats } from '../../utils/sellerDashboardStats';

export const SELLER_TOOL_GROUPS = [
  {
    id: 'sell',
    title: 'Sell & fulfil',
    subtitle: 'Products, orders, returns and delivery',
    tools: [
      { id: 'products', label: 'Products', detail: 'Catalog & inventory', icon: 'cube-outline', color: '#0EA5E9', screen: 'SellerProductManagement' },
      { id: 'orders', label: 'Orders', detail: 'Process customer orders', icon: 'receipt-outline', color: '#6366F1', screen: 'SellerOrderManagement' },
      { id: 'returns', label: 'Returns', detail: 'Review return requests', icon: 'return-down-back-outline', color: '#F97316', screen: 'SellerOrderManagement', params: { tab: 'returns' } },
      { id: 'shipping', label: 'Shipping', detail: 'Rates and delivery methods', icon: 'car-outline', color: '#F59E0B', screen: 'SellerShippingConfiguration' },
    ],
  },
  {
    id: 'grow',
    title: 'Grow your business',
    subtitle: 'Performance, promotions and campaigns',
    tools: [
      { id: 'analytics', label: 'Analytics', detail: 'Revenue and conversion', icon: 'bar-chart-outline', color: '#14B8A6', screen: 'SellerAnalytics' },
      { id: 'coupons', label: 'Coupons', detail: 'Offers and redemptions', icon: 'pricetag-outline', color: '#F97316', screen: 'SellerCouponManagement' },
      { id: 'ads', label: 'Rozare Ads', detail: 'TikTok and Meta campaigns', icon: 'megaphone-outline', color: '#A855F7', screen: 'SellerAds' },
      { id: 'storefront', label: 'Store Overview', detail: 'Preview store performance', icon: 'eye-outline', color: '#10B981', screen: 'SellerStoreOverview' },
    ],
  },
  {
    id: 'money',
    title: 'Money & plan',
    subtitle: 'Payouts, billing and your seller plan',
    tools: [
      { id: 'payments', label: 'Payments', detail: 'Balance and withdrawals', icon: 'wallet-outline', color: '#10B981', screen: 'SellerPayments' },
      { id: 'cards', label: 'Saved Cards', detail: 'Secure payment methods', icon: 'card-outline', color: '#2563EB', screen: 'PaymentMethods' },
      { id: 'plan', label: 'Subscription', detail: 'Plan and benefits', icon: 'diamond-outline', color: '#A855F7', screen: 'SellerSubscription' },
      { id: 'subdomain', label: 'Subdomain', detail: 'Your Rozare address', icon: 'globe-outline', color: '#0284C7', screen: 'SellerSubdomainManagement' },
    ],
  },
  {
    id: 'store',
    title: 'Store & account',
    subtitle: 'Identity, notifications and preferences',
    tools: [
      { id: 'settings', label: 'Store Settings', detail: 'Brand, policies and visibility', icon: 'storefront-outline', color: '#8B5CF6', screen: 'SellerStoreSettings' },
      { id: 'profile', label: 'Seller Profile', detail: 'Secure contact details', icon: 'person-circle-outline', color: '#06B6D4', screen: 'SellerProfile' },
      { id: 'notifications', label: 'Notifications', detail: 'Orders, stock and updates', icon: 'notifications-outline', color: '#EC4899', screen: 'SellerNotifications' },
      { id: 'notification-settings', label: 'Alert Preferences', detail: 'Choose what reaches you', icon: 'options-outline', color: '#64748B', screen: 'NotificationSettings' },
      { id: 'whatsapp', label: 'WhatsApp', detail: 'Seller alerts and verification', icon: 'logo-whatsapp', color: '#22C55E', screen: 'SellerWhatsAppSettings' },
    ],
  },
];

export const calculateStoreSetup = (store) => {
  if (!store) return { completed: 0, total: 6, percent: 0 };
  const checks = [
    store.storeName || store.name,
    store.description,
    store.logo,
    store.banner,
    store.paymentPolicy,
    store.returnPolicy && typeof store.returnPolicy === 'object',
  ];
  const completed = checks.filter(Boolean).length;
  return { completed, total: checks.length, percent: Math.round((completed / checks.length) * 100) };
};

export const getGreeting = (hour = new Date().getHours()) => {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

const founderPromotionIsPresentable = (promotion) => (
  promotion
  && typeof promotion === 'object'
  && typeof promotion.available === 'boolean'
  && typeof promotion.sellerEligible === 'boolean'
  && typeof promotion.entitlementActive === 'boolean'
  && typeof promotion.sellerHasReservation === 'boolean'
  && typeof promotion.code === 'string'
  && promotion.code.trim().length > 0
  && typeof promotion.discountPercent === 'number'
  && Number.isFinite(promotion.discountPercent)
  && promotion.discountPercent > 0
  && promotion.discountPercent <= 100
  && readNonNegativePresentationCount(promotion.remaining) !== null
  && readNonNegativePresentationCount(promotion.maxRedemptions) !== null
  && promotion.remaining <= promotion.maxRedemptions
);

export default function SellerDashboardScreen({ navigation }) {
  const { palette } = useTheme();
  const { formatAmount } = useCurrency();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState(null);
  const [orders, setOrders] = useState(null);
  const [moneyMetrics, setMoneyMetrics] = useState(null);
  const [sellerCurrency, setSellerCurrency] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [showFounderOffer, setShowFounderOffer] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [unreadCount, setUnreadCount] = useState(null);
  const dashboardRequestRef = useRef(0);

  const sellerKey = currentUser?._id || currentUser?.id || currentUser?.email || 'seller';

  const fetchDashboardData = useCallback(async () => {
    const requestId = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = requestId;
    const refreshKey = `${Date.now()}-${requestId}`;
    const freshParams = { _mobileRefresh: refreshKey };
    setMoneyMetrics(null);
    setSellerCurrency(null);
    setLoadError('');
    setShowFounderOffer(false);
    let requestedSellerCurrency = null;
    try {
      const response = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY, { params: freshParams });
      const inspected = inspectSellerProductCurrencyState(response.data?.productCurrency);
      if (!inspected.valid || inspected.hasStore !== true) {
        throw new Error('Store product currency is invalid.');
      }
      requestedSellerCurrency = inspected.activeCurrency;
    } catch (_error) {
      requestedSellerCurrency = null;
    }
    if (dashboardRequestRef.current !== requestId) return;
    const requests = await Promise.allSettled([
      api.get('/api/stores/my-store', { params: freshParams }),
      fetchCompleteSellerCatalog(api, { refreshKey }),
      api.get('/api/order/get', { params: freshParams }),
      api.get('/api/subscription/status', { params: freshParams }),
      api.get('/api/notifications/me', { params: freshParams }),
      requestedSellerCurrency
        ? api.get('/api/stores/analytics', {
          params: { currency: requestedSellerCurrency, ...freshParams },
        })
        : Promise.reject(new Error('Store product currency is unavailable.')),
    ]);
    if (dashboardRequestRef.current !== requestId) return;
    const [storeResult, productsResult, ordersResult, subscriptionResult, notificationsResult, metricsResult] = requests;
    const coreFailures = [];
    if (!requestedSellerCurrency) coreFailures.push('store currency');
    else setSellerCurrency(requestedSellerCurrency);

    if (storeResult.status === 'fulfilled') {
      const nextStore = storeResult.value.data?.store || storeResult.value.data || null;
      if (nextStore && typeof nextStore === 'object' && !Array.isArray(nextStore)) setStore(nextStore);
      else {
        setStore(null);
        coreFailures.push('store');
      }
    } else if (storeResult.reason?.response?.status === 404) {
      setStore(null);
    } else {
      setStore(null);
      coreFailures.push('store');
    }

    if (
      productsResult.status === 'fulfilled'
      && sellerInventorySnapshotIsValid(productsResult.value)
    ) {
      const nextProducts = productsResult.value;
      setProducts(nextProducts);
    } else {
      setProducts(null);
      coreFailures.push('products');
    }

    if (ordersResult.status === 'fulfilled') {
      const nextOrders = ordersResult.value.data?.orders || ordersResult.value.data || [];
      if (sellerOrdersSnapshotIsValid(nextOrders)) setOrders(nextOrders);
      else {
        setOrders(null);
        coreFailures.push('orders');
      }
    } else {
      setOrders(null);
      coreFailures.push('orders');
    }

    let nextSubscription = null;
    if (subscriptionResult.status === 'fulfilled') {
      nextSubscription = subscriptionResult.value.data?.subscription || null;
      setSubscription(nextSubscription);
    } else {
      setSubscription(null);
      coreFailures.push('subscription');
    }

    if (notificationsResult.status === 'fulfilled') {
      const nextUnreadCount = readNonNegativePresentationCount(notificationsResult.value.data?.unread);
      setUnreadCount(nextUnreadCount);
      if (nextUnreadCount === null) coreFailures.push('notification count');
    } else {
      setUnreadCount(null);
      coreFailures.push('notification count');
    }

    if (metricsResult.status === 'fulfilled') {
      const nextMetrics = metricsResult.value.data?.analytics || null;
      if (
        requestedSellerCurrency
        && selectAuthoritativeSellerMetrics(nextMetrics, requestedSellerCurrency) !== null
      ) {
        setMoneyMetrics(nextMetrics);
      } else {
        setMoneyMetrics(null);
        coreFailures.push('revenue');
      }
    } else {
      setMoneyMetrics(null);
      coreFailures.push('revenue');
    }

    if (coreFailures.length) {
      setLoadError(`Live ${coreFailures.join(', ')} data could not be verified. Unavailable values stay hidden until a successful refresh.`);
    } else {
      setLoadError('');
    }

    const promotion = nextSubscription?.founderPromotion;
    if (
      founderPromotionIsPresentable(promotion)
      && promotion.available === true
      && promotion.sellerEligible === true
      && promotion.entitlementActive === false
    ) {
      try {
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

    setIsLoading(false);
    setRefreshing(false);
  }, [sellerKey]);

  useFocusEffect(useCallback(() => {
    fetchDashboardData();
    return () => { dashboardRequestRef.current += 1; };
  }, [fetchDashboardData]));

  const stats = useMemo(
    () => (products && orders ? calculateSellerStats(products, orders) : null),
    [products, orders]
  );
  const authoritativeRevenue = sellerCurrency
    ? selectAuthoritativeSellerRevenue(moneyMetrics, sellerCurrency)
    : null;
  const onRefresh = useCallback(() => { setRefreshing(true); fetchDashboardData(); }, [fetchDashboardData]);
  // Newest first — sort explicitly so we don't depend on API ordering
  const recentOrders = orders ? [...orders]
    .sort((a, b) => {
      const left = new Date(a.createdAt).getTime();
      const right = new Date(b.createdAt).getTime();
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return right - left;
    })
    .slice(0, 5) : [];

  const formatDashboardRevenue = (amount) => formatAmount(amount, { targetCurrency: sellerCurrency });

  if (isLoading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Seller Dashboard"
        subtitle="Preparing your live store overview"
        icon="storefront-outline"
        variant="dashboard"
        fallbackScreen="Account"
      />
    );
  }

  const isTrialExpiring = subscription?.isTrialExpiringSoon === true
    && readNonNegativePresentationCount(subscription?.trialDaysRemaining) !== null;
  const isBlocked = subscription?.status === 'blocked';
  const isPastDue = subscription?.status === 'past_due';
  const storeName = store?.storeName || store?.name;
  const storeSetup = calculateStoreSetup(store);
  const isStoreLive = Boolean(store?._id)
    && store?.isActive === true
    && store?.blockedAt === null
    && !isBlocked;

  const heroStats = [
    { label: 'Total Revenue', value: authoritativeRevenue === null ? 'Unavailable' : formatDashboardRevenue(authoritativeRevenue), icon: 'cash-outline', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    { label: 'Total Orders', value: stats?.totalOrders ?? 'Unavailable', icon: 'bag-handle-outline', color: '#6366f1', bg: 'rgba(99,102,241,0.12)', onPress: () => navigation.navigate('SellerOrderManagement') },
    { label: 'Total Products', value: stats?.totalProducts ?? 'Unavailable', icon: 'cube-outline', color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)', onPress: () => navigation.navigate('SellerProductManagement') },
    { label: 'Conversion', value: stats === null ? 'Unavailable' : `${stats.conversion}%`, icon: 'trending-up-outline', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  ];

  const orderSummary = [
    { label: 'Pending', count: stats?.pendingOrders ?? '—', color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
    { label: 'Processing', count: stats?.processingOrders ?? '—', color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
    { label: 'Delivered', count: stats?.deliveredOrders ?? '—', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    { label: 'Low Stock', count: stats === null ? '—' : stats.lowStock + stats.outOfStock, color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  ];

  const navigateBack = () => {
    if (navigation.canGoBack?.()) navigation.goBack();
    else navigation.navigate('MainTabs', { screen: 'Account' });
  };

  const navigateToTool = (tool) => {
    const dynamicParams = tool.id === 'storefront' && store?._id ? { storeId: store._id } : {};
    navigation.navigate(tool.screen, { ...(tool.params || {}), ...dynamicParams });
  };

  return (
    <GlassBackground>
      <SafeAreaView
        style={{ flex: 1 }}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
      <SellerScreenHeader
        navigation={navigation}
        title="Seller Dashboard"
        subtitle={storeName || 'Your Rozare business command center'}
        icon="storefront-outline"
        onBack={navigateBack}
        rightIcon="notifications-outline"
        rightBadge={unreadCount ?? undefined}
        onRightPress={() => navigation.navigate('SellerNotifications')}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        {/* ── Top Bar: back + title ── */}
        {!!loadError && (
          <SellerInlineError
            title="Some live data is unavailable"
            message={loadError}
            onRetry={fetchDashboardData}
          />
        )}

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
        {isPastDue && !isBlocked && (
          <TouchableOpacity onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.8} style={[styles.alertBanner, { backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }]}>
            <Ionicons name="card-outline" size={16} color={palette.colors.error} />
            <Text style={[styles.alertBannerText, { color: palette.colors.error }]}>Payment needs attention — update subscription billing</Text>
            <Ionicons name="chevron-forward" size={14} color={palette.colors.error} />
          </TouchableOpacity>
        )}

        {/* ── Welcome Hub (matches website) ── */}
        <GlassPanel variant="strong" style={styles.header}>
          <View style={styles.tagPill}>
            <Ionicons name="sparkles" size={11} color={palette.colors.primary} />
            <Text style={styles.tagPillText}>Seller Hub</Text>
          </View>
          <Text style={styles.headerName}>{getGreeting()}, {currentUser?.name?.split(' ')[0] || currentUser?.username || 'Seller'}</Text>
          <Text style={styles.headerSub}>Your live performance, priorities and seller tools in one place.</Text>
          {storeName && (
            <View style={styles.storeSummary}>
              <View style={styles.storeNameRow}>
                <View style={styles.storeIdentityIcon}>
                  <Ionicons name="business-outline" size={15} color={palette.colors.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.storeName} numberOfLines={1}>{storeName}</Text>
                  <View style={styles.storePills}>
                    <View style={[styles.storePill, { backgroundColor: store?.verification?.isVerified === true ? palette.colors.successSubtle : palette.colors.warningSubtle }]}>
                      <Ionicons name={store?.verification?.isVerified === true ? 'checkmark-circle' : 'shield-outline'} size={11} color={store?.verification?.isVerified === true ? palette.colors.success : palette.colors.warning} />
                      <Text style={[styles.storePillText, { color: store?.verification?.isVerified === true ? palette.colors.success : palette.colors.warning }]}>
                        {store?.verification?.isVerified === true ? 'Verified' : 'Not verified'}
                      </Text>
                    </View>
                    <View style={[styles.storePill, { backgroundColor: isStoreLive ? palette.colors.successSubtle : palette.colors.errorSubtle }]}>
                      <View style={[styles.liveDot, { backgroundColor: isStoreLive ? palette.colors.success : palette.colors.error }]} />
                      <Text style={[styles.storePillText, { color: isStoreLive ? palette.colors.success : palette.colors.error }]}>
                        {isStoreLive ? 'Live' : 'Not live'}
                      </Text>
                    </View>
                  </View>
                </View>
                {store?.storeSlug && (
                  <TouchableOpacity style={styles.viewStoreBtn} onPress={() => navigation.navigate('Store', { storeSlug: store.storeSlug })} activeOpacity={0.8}>
                    <Text style={styles.viewStoreBtnText}>View</Text>
                    <Ionicons name="open-outline" size={12} color={palette.colors.primary} />
                  </TouchableOpacity>
                )}
              </View>
              {storeSetup.percent < 100 && (
                <TouchableOpacity style={styles.setupRow} onPress={() => navigation.navigate('SellerStoreSettings')} activeOpacity={0.78}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.setupCopy}>
                      <Text style={styles.setupLabel}>Store setup</Text>
                      <Text style={styles.setupPercent}>{storeSetup.percent}%</Text>
                    </View>
                    <View style={styles.progressTrack}>
                      <LinearGradient colors={palette.gradients.cta} style={[styles.progressFill, { width: `${storeSetup.percent}%` }]} />
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
          )}
          {!storeName && (
            <TouchableOpacity style={styles.missingStore} onPress={() => navigation.navigate('SellerStoreSettings')} activeOpacity={0.78}>
              <Ionicons name="alert-circle-outline" size={18} color={palette.colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={styles.missingStoreTitle}>Finish setting up your store</Text>
                <Text style={styles.missingStoreText}>Add your identity, policies and storefront details before selling.</Text>
              </View>
              <Ionicons name="arrow-forward" size={16} color={palette.colors.warning} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.addProductBtn}
            onPress={() => store?._id
              ? navigation.navigate('ProductForm', { isAdmin: false })
              : navigation.navigate('SellerStoreSettings')}
            activeOpacity={0.85}
          >
            <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            <Ionicons name={store?._id ? 'flash' : 'storefront-outline'} size={15} color="#fff" />
            <Text style={styles.addProductBtnText}>{store?._id ? 'Add Product' : 'Create Store'}</Text>
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
        {stats !== null && (stats.outOfStock > 0 || stats.lowStock > 0) && (
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
          <SellerSectionHeader
            title="Seller tools"
            subtitle="Everything available on your website dashboard, organized for mobile"
            icon="grid-outline"
          />
          {SELLER_TOOL_GROUPS.map((group) => (
            <GlassPanel key={group.id} variant="card" style={styles.toolGroup}>
              <View style={styles.toolGroupHeader}>
                <Text style={styles.toolGroupTitle}>{group.title}</Text>
                <Text style={styles.toolGroupSubtitle}>{group.subtitle}</Text>
              </View>
              <View style={styles.toolsGrid}>
                {group.tools.map((tool) => {
                  const badge = tool.id === 'products'
                    ? (stats === null ? null : stats.lowStock + stats.outOfStock)
                    : tool.id === 'orders'
                      ? (stats === null ? null : stats.pendingOrders)
                      : tool.id === 'notifications'
                        ? unreadCount
                        : null;
                  return (
                    <TouchableOpacity
                      key={tool.id}
                      onPress={() => navigateToTool(tool)}
                      activeOpacity={0.72}
                      style={styles.toolCard}
                      accessibilityRole="button"
                      accessibilityLabel={`${tool.label}. ${tool.detail}`}
                    >
                      <View style={[styles.toolIcon, { backgroundColor: `${tool.color}16`, borderColor: `${tool.color}30` }]}>
                        <Ionicons name={tool.icon} size={20} color={tool.color} />
                        {badge > 0 && (
                          <View style={[styles.tileBadge, { backgroundColor: tool.color }]}>
                            <Text style={styles.tileBadgeText}>{badge > 99 ? '99+' : badge}</Text>
                          </View>
                        )}
                      </View>
                      <View style={styles.toolCopy}>
                        <Text style={styles.toolLabel} numberOfLines={1}>{tool.label}</Text>
                        <Text style={styles.toolDetail} numberOfLines={2}>{tool.detail}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={15} color={palette.colors.textLight} />
                    </TouchableOpacity>
                  );
                })}
              </View>
            </GlassPanel>
          ))}
        </View>

        {/* ── Recent Orders ── */}
        <GlassPanel variant="card" style={styles.ordersPanel}>
          <SellerSectionHeader
            title="Recent orders"
            subtitle="Your five newest customer orders"
            icon="time-outline"
            actionLabel={orders?.length > 0 ? 'View all' : undefined}
            onAction={orders?.length > 0 ? () => navigation.navigate('SellerOrderManagement') : undefined}
          />
          {recentOrders.length > 0 ? (
            <View style={styles.ordersContainer}>
              {recentOrders.map((order) => (
                <OrderCard key={order._id} order={order}
                  onPress={() => navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin: false })}
                  showCustomer={true}
                  sellerView />
              ))}
            </View>
          ) : orders === null ? (
            <Text style={styles.unavailableText}>Recent orders are unavailable until a verified refresh succeeds.</Text>
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
            <Text style={styles.founderModalTitle}>Lock in an extra {subscription?.founderPromotion?.discountPercent}% off</Text>
            <Text style={styles.founderModalText}>Apply the verified founder offer to an eligible plan from the subscription screen.</Text>
            <View style={styles.founderRemaining}>
              <Text style={styles.founderRemainingText}>
                {subscription?.founderPromotion?.sellerHasReservation === true
                  ? 'A founder spot is currently reserved for your account'
                  : `${subscription?.founderPromotion?.remaining} of ${subscription?.founderPromotion?.maxRedemptions} founder spots remaining`}
              </Text>
            </View>
            <Text style={styles.founderFinePrint}>The rate stays through plan changes while your subscription remains uninterrupted. It ends permanently if you unsubscribe.</Text>
            <TouchableOpacity
              style={styles.founderCta}
              onPress={() => {
                setShowFounderOffer(false);
                navigation.navigate('SellerSubscription', { couponCode: subscription.founderPromotion.code });
              }}
            >
              <Text style={styles.founderCtaText}>View Plans</Text>
              <Ionicons name="arrow-forward" size={17} color="#fff" />
            </TouchableOpacity>
          </GlassPanel>
        </View>
      </Modal>

      {/* Sellers and buyers share the same full-screen AI chat experience. */}
      <AIChatFab
        onPress={() => navigation.navigate('AIChat', { role: 'seller' })}
        style={{ bottom: 24, right: 20 }}
      />
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingBottom: 96 },
  unavailableText: { paddingVertical: spacing.lg, textAlign: 'center', fontSize: fontSize.sm, color: p.colors.textSecondary },

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

  /* Banners */
  alertBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, borderWidth: 1 },
  alertBannerText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, flex: 1 },

  /* Welcome hub */
  header: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.xl },
  tagPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: borderRadius.full, marginBottom: spacing.md },
  tagPillText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  headerName: { fontSize: fontSize.xxxl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.5 },
  headerSub: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 4 },
  storeSummary: { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.borderSubtle },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  storeIdentityIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  storeName: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  storePills: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 4 },
  storePill: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, borderRadius: borderRadius.full },
  storePillText: { fontSize: 9, fontWeight: fontWeight.bold },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  viewStoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: borderRadius.full },
  viewStoreBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },
  setupRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  setupCopy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  setupLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  setupPercent: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: p.colors.primarySubtle },
  progressFill: { height: '100%', borderRadius: 3 },
  missingStore: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.colors.warningSubtle, borderWidth: 1, borderColor: p.colors.warningLighter },
  missingStoreTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  missingStoreText: { marginTop: 2, fontSize: fontSize.xs, lineHeight: 16, color: p.colors.textSecondary },
  addProductBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.lg, paddingVertical: spacing.md, borderRadius: borderRadius.xl, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  addProductBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },

  /* Stats */
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  statCardWrap: { flexGrow: 1, flexBasis: '47%', minWidth: 140 },
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

  /* Seller tools */
  sectionContainer: { paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  toolGroup: { padding: spacing.md, marginBottom: spacing.md },
  toolGroupHeader: { paddingHorizontal: spacing.xs, marginBottom: spacing.md },
  toolGroupTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.text },
  toolGroupSubtitle: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  toolsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  toolCard: { flexGrow: 1, flexBasis: '47%', minWidth: 138, minHeight: 112, position: 'relative', alignItems: 'flex-start', padding: spacing.md, borderRadius: borderRadius.xl, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  toolIcon: { width: 40, height: 40, borderRadius: 13, justifyContent: 'center', alignItems: 'center', borderWidth: 1, marginBottom: spacing.sm },
  toolCopy: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  toolLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  toolDetail: { marginTop: 2, fontSize: 10, lineHeight: 14, color: p.colors.textSecondary },
  tileBadge: { position: 'absolute', top: -4, right: -6, minWidth: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  tileBadgeText: { fontSize: 9, fontWeight: fontWeight.bold, color: '#fff' },

  /* Orders */
  ordersPanel: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  ordersContainer: { gap: spacing.sm },
});
