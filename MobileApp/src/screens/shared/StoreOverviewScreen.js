import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api, { API_ENDPOINTS } from '../../config/api';
import VerifiedBadge from '../../components/VerifiedBadge';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  SellerEmptyState,
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { fetchCompleteSellerCatalog, getProductImage } from '../../utils/sellerCatalog';
import { useCurrency } from '../../contexts/CurrencyContext';
import { inspectSellerProductCurrencyState } from '../../utils/productCurrencyState';
import { useTheme } from '../../contexts/ThemeContext';
import { getStorefrontHost } from '../../utils/storefrontUrl';
import {
  isRecognizedSellerOrder,
  readNonNegativePresentationCount,
  readSellerProductRating,
  selectAuthoritativeSellerMetrics,
  sellerOrdersSnapshotIsValid,
  sellerStoreInventorySnapshotIsValid,
} from '../../utils/sellerDashboardStats';
import { roundCurrencyAmount } from '../../utils/currencySafety';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

const orderStatus = (order) => order?.orderStatus ?? order?.status;

export const calculateStoreOverview = (
  products,
  orders
) => {
  if (!sellerStoreInventorySnapshotIsValid(products) || !sellerOrdersSnapshotIsValid(orders)) return null;
  const recognizedOrders = orders.filter(isRecognizedSellerOrder);
  const delivered = orders.filter((order) => orderStatus(order) === 'delivered').length;
  const outOfStock = products.filter((product) => product.stock === 0).length;
  const lowStock = products.filter((product) => product.stock > 0 && product.stock <= 10).length;
  const featured = products.filter((product) => product.isFeatured === true).length;
  const categoryMap = products.reduce((map, product) => {
    const category = product.category.trim();
    map[category] = (map[category] ?? 0) + 1;
    return map;
  }, {});
  const categories = Object.entries(categoryMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const topRated = [...products]
    .filter((product) => readSellerProductRating(product) > 0)
    .sort((a, b) => readSellerProductRating(b) - readSellerProductRating(a))
    .slice(0, 4);

  return {
    totalProducts: products.length,
    outOfStock,
    lowStock,
    featured,
    totalOrders: orders.length,
    recognizedOrders: recognizedOrders.length,
    delivered,
    fulfillmentRate: orders.length ? Math.round((delivered / orders.length) * 100) : 0,
    categories,
    topRated,
  };
};

export default function StoreOverviewScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { formatAmount } = useCurrency();
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState(null);
  const [orders, setOrders] = useState(null);
  const [moneyMetrics, setMoneyMetrics] = useState(null);
  const [sellerCurrency, setSellerCurrency] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const overviewRequestRef = useRef(0);

  const loadOverview = useCallback(async () => {
    const requestId = overviewRequestRef.current + 1;
    overviewRequestRef.current = requestId;
    setMoneyMetrics(null);
    setSellerCurrency(null);
    setLoadError('');
    let requestedSellerCurrency = null;
    try {
      const response = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY);
      const inspected = inspectSellerProductCurrencyState(response.data?.productCurrency);
      if (!inspected.valid || inspected.hasStore !== true) {
        throw new Error('Store product currency is invalid.');
      }
      requestedSellerCurrency = inspected.activeCurrency;
    } catch (_error) {
      requestedSellerCurrency = null;
    }
    if (overviewRequestRef.current !== requestId) return;
    const results = await Promise.allSettled([
      api.get('/api/stores/my-store'),
      fetchCompleteSellerCatalog(),
      api.get('/api/order/get'),
      requestedSellerCurrency
        ? api.get(`/api/stores/analytics?currency=${encodeURIComponent(requestedSellerCurrency)}`)
        : Promise.reject(new Error('Store product currency is unavailable.')),
    ]);
    if (overviewRequestRef.current !== requestId) return;
    const [storeResult, productResult, orderResult, metricsResult] = results;
    const failed = [];
    if (!requestedSellerCurrency) failed.push('store currency');
    else setSellerCurrency(requestedSellerCurrency);
    const storeMissing = storeResult.status === 'rejected'
      && storeResult.reason?.response?.status === 404;

    if (storeResult.status === 'fulfilled') {
      const nextStore = storeResult.value.data?.store || storeResult.value.data || null;
      if (nextStore && typeof nextStore === 'object' && !Array.isArray(nextStore)) setStore(nextStore);
      else {
        setStore(null);
        failed.push('store profile');
      }
    } else if (storeMissing) {
      setStore(null);
    } else {
      setStore(null);
      failed.push('store profile');
    }

    if (
      productResult.status === 'fulfilled'
      && sellerStoreInventorySnapshotIsValid(productResult.value)
    ) setProducts(productResult.value);
    else {
      setProducts(null);
      failed.push('inventory');
    }

    if (orderResult.status === 'fulfilled') {
      const nextOrders = orderResult.value.data?.orders || orderResult.value.data || [];
      if (sellerOrdersSnapshotIsValid(nextOrders)) setOrders(nextOrders);
      else {
        setOrders(null);
        failed.push('orders');
      }
    } else {
      setOrders(null);
      failed.push('orders');
    }

    if (!storeMissing && metricsResult.status === 'fulfilled') {
      const nextMetrics = metricsResult.value.data?.analytics || null;
      if (
        requestedSellerCurrency
        && selectAuthoritativeSellerMetrics(nextMetrics, requestedSellerCurrency) !== null
      ) {
        setMoneyMetrics(nextMetrics);
      } else {
        setMoneyMetrics(null);
        failed.push('revenue');
      }
    } else {
      setMoneyMetrics(null);
      if (!storeMissing) failed.push('revenue');
    }

    setLoadError(failed.length ? `Could not refresh ${failed.join(', ')}. Unavailable values are hidden until a successful retry.` : '');
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    loadOverview();
    return () => { overviewRequestRef.current += 1; };
  }, [loadOverview]);

  const overview = useMemo(
    () => (products && orders ? calculateStoreOverview(products, orders) : null),
    [products, orders]
  );
  const authoritativeMetrics = sellerCurrency
    ? selectAuthoritativeSellerMetrics(moneyMetrics, sellerCurrency)
    : null;
  const authoritativeRevenue = authoritativeMetrics?.totalSales ?? null;
  const authoritativeAverage = authoritativeMetrics === null
    ? null
    : authoritativeMetrics.totalOrders === 0
      ? 0
      : roundCurrencyAmount(authoritativeMetrics.totalSales / authoritativeMetrics.totalOrders);
  const recentProducts = useMemo(
    () => (products ? [...products].sort((a, b) => {
      const left = new Date(a.updatedAt || a.createdAt).getTime();
      const right = new Date(b.updatedAt || b.createdAt).getTime();
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return right - left;
    }).slice(0, 6) : []),
    [products]
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    loadOverview();
  }, [loadOverview]);

  if (loading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Store Overview"
        subtitle="Preparing your business performance"
        icon="analytics-outline"
        variant="dashboard"
      />
    );
  }

  if (!store && loadError) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
          <SellerScreenHeader navigation={navigation} title="Store Overview" subtitle="Live seller performance" icon="analytics-outline" />
          <SellerInlineError title="Store overview unavailable" message={loadError} onRetry={loadOverview} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (!store) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
          <SellerScreenHeader navigation={navigation} title="Store Overview" subtitle="Live seller performance" icon="analytics-outline" />
          <View style={styles.emptyStoreWrap}>
            <SellerEmptyState
              icon="storefront-outline"
              title="Create your storefront first"
              message="Your inventory and sales overview will become available as soon as your Rozare store is created."
              actionLabel="Create store"
              onAction={() => navigation.navigate('SellerStoreSettings')}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const storeName = store?.storeName || store?.name || 'Your store';
  const isVerified = store?.verification?.isVerified === true;
  const storeIsLive = store?.isActive === true && store?.blockedAt === null;
  const inventoryHealthy = overview === null
    ? null
    : overview.outOfStock === 0 && overview.lowStock === 0;
  const maxCategoryCount = overview?.categories.length
    ? Math.max(...overview.categories.map((item) => item.count))
    : null;
  const trustCount = readNonNegativePresentationCount(store?.trustCount);

  const metrics = [
    { label: 'Recognized revenue', value: authoritativeRevenue === null ? 'Unavailable' : formatAmount(authoritativeRevenue, { targetCurrency: moneyMetrics.currency }), icon: 'cash-outline', color: '#10B981', tint: 'rgba(16,185,129,0.12)' },
    { label: 'Recognized orders', value: authoritativeMetrics?.totalOrders ?? 'Unavailable', icon: 'receipt-outline', color: '#6366F1', tint: 'rgba(99,102,241,0.12)' },
    { label: 'Products', value: overview?.totalProducts ?? 'Unavailable', icon: 'cube-outline', color: '#0EA5E9', tint: 'rgba(14,165,233,0.12)' },
    { label: 'Fulfilment', value: overview === null ? 'Unavailable' : `${overview.fulfillmentRate}%`, icon: 'checkmark-done-outline', color: '#8B5CF6', tint: 'rgba(139,92,246,0.12)' },
  ];

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
        <SellerScreenHeader
          navigation={navigation}
          title="Store Overview"
          subtitle="Live inventory and sales performance"
          icon="analytics-outline"
          rightIcon="refresh"
          rightLabel="Refresh"
          onRightPress={refresh}
        />
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={palette.colors.primary} />}
        >
          {!!loadError && <SellerInlineError compact title="Some data is unavailable" message={loadError} onRetry={loadOverview} />}

          <GlassPanel variant="strong" style={styles.hero}>
            {store?.banner ? (
              <Image source={{ uri: store.banner }} style={styles.banner} contentFit="cover" transition={180} />
            ) : (
              <LinearGradient colors={palette.gradients.cta} style={styles.bannerFallback}>
                <Ionicons name="storefront-outline" size={34} color="rgba(255,255,255,0.92)" />
              </LinearGradient>
            )}
            <View style={styles.identityRow}>
              {store?.logo ? (
                <Image source={{ uri: store.logo }} style={styles.logo} contentFit="cover" transition={180} />
              ) : (
                <View style={styles.logoFallback}><Ionicons name="storefront" size={27} color={palette.colors.primary} /></View>
              )}
              <View style={styles.identityCopy}>
                <View style={styles.nameRow}>
                  <Text style={styles.storeName} numberOfLines={1}>{storeName}</Text>
                  {isVerified && <VerifiedBadge size="sm" />}
                </View>
                <Text style={styles.storeMeta} numberOfLines={1}>
                  {store?.storeSlug ? getStorefrontHost(store.storeSlug) : 'Complete your subdomain in Store Settings'}
                </Text>
                <View style={styles.trustRow}>
                  <Ionicons name="people-outline" size={13} color={palette.colors.primary} />
                  <Text style={styles.trustText}>{trustCount === null ? 'Trust count unavailable' : `${trustCount.toLocaleString()} people trust this store`}</Text>
                </View>
              </View>
            </View>
            <View style={styles.heroActions}>
              <TouchableOpacity style={styles.primaryAction} onPress={() => navigation.navigate('Store', { storeSlug: store.storeSlug })} disabled={!store?.storeSlug || !storeIsLive} activeOpacity={0.78}>
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text style={styles.primaryActionText}>View live store</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryAction} onPress={() => navigation.navigate('SellerStoreSettings')} activeOpacity={0.78}>
                <Ionicons name="settings-outline" size={16} color={palette.colors.primary} />
                <Text style={styles.secondaryActionText}>Settings</Text>
              </TouchableOpacity>
            </View>
          </GlassPanel>

          <View style={styles.metricsGrid}>
            {metrics.map((metric) => (
              <GlassPanel key={metric.label} variant="card" style={styles.metricCard}>
                <View style={[styles.metricIcon, { backgroundColor: metric.tint }]}>
                  <Ionicons name={metric.icon} size={19} color={metric.color} />
                </View>
                <Text style={styles.metricLabel}>{metric.label}</Text>
                <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>{metric.value}</Text>
              </GlassPanel>
            ))}
          </View>

          <GlassPanel variant="card" style={styles.sectionCard}>
            <SellerSectionHeader title="Inventory health" subtitle="Stock readiness across your full catalog" icon="pulse-outline" actionLabel="Manage" onAction={() => navigation.navigate('SellerProductManagement')} />
            {overview === null ? (
              <Text style={styles.mutedText}>Inventory counts are unavailable until a verified refresh succeeds.</Text>
            ) : (
              <View style={[styles.healthBanner, { backgroundColor: inventoryHealthy ? palette.colors.successSubtle : palette.colors.warningSubtle }]}>
                <Ionicons name={inventoryHealthy ? 'checkmark-circle' : 'warning'} size={21} color={inventoryHealthy ? palette.colors.success : palette.colors.warning} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.healthTitle}>{inventoryHealthy ? 'Inventory looks healthy' : 'Inventory needs attention'}</Text>
                  <Text style={styles.healthText}>{overview.outOfStock} out of stock · {overview.lowStock} low stock · {overview.featured} featured</Text>
                </View>
              </View>
            )}
            {overview !== null && (recentProducts.length ? recentProducts.map((product) => {
              const stock = product.stock;
              const stockColor = stock <= 0 ? palette.colors.error : stock <= 10 ? palette.colors.warning : palette.colors.success;
              return (
                <TouchableOpacity key={product._id} style={styles.productRow} onPress={() => navigation.navigate('ProductForm', { product, isAdmin: false })} activeOpacity={0.75}>
                  {getProductImage(product) ? <Image source={{ uri: getProductImage(product) }} style={styles.productImage} contentFit="cover" /> : <View style={styles.productImageFallback}><Ionicons name="image-outline" size={18} color={palette.colors.textLight} /></View>}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.productName} numberOfLines={1}>{product.name}</Text>
                    <Text style={styles.productMeta} numberOfLines={1}>{product.category || 'Uncategorized'} · {product.isFeatured ? 'Featured' : 'Standard'}</Text>
                  </View>
                  <View style={[styles.stockPill, { backgroundColor: `${stockColor}16` }]}>
                    <Text style={[styles.stockText, { color: stockColor }]}>{stock} in stock</Text>
                  </View>
                </TouchableOpacity>
              );
            }) : (
              <SellerEmptyState icon="cube-outline" title="No products yet" message="Add your first product to start measuring inventory health." actionLabel="Add product" onAction={() => navigation.navigate('ProductForm', { isAdmin: false })} />
            ))}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.sectionCard}>
            <SellerSectionHeader title="Sales performance" subtitle="Recognized revenue and fulfilment" icon="trending-up-outline" actionLabel="Orders" onAction={() => navigation.navigate('SellerOrderManagement')} />
            <View style={styles.performanceGrid}>
              <View style={styles.performanceItem}><Text style={styles.performanceValue}>{authoritativeAverage === null ? 'Unavailable' : formatAmount(authoritativeAverage, { targetCurrency: moneyMetrics.currency })}</Text><Text style={styles.performanceLabel}>Avg. recognized order</Text></View>
              <View style={styles.performanceDivider} />
              <View style={styles.performanceItem}><Text style={styles.performanceValue}>{authoritativeMetrics?.totalOrders ?? 'Unavailable'}</Text><Text style={styles.performanceLabel}>Recognized orders</Text></View>
              <View style={styles.performanceDivider} />
              <View style={styles.performanceItem}><Text style={styles.performanceValue}>{overview?.delivered ?? 'Unavailable'}</Text><Text style={styles.performanceLabel}>Delivered</Text></View>
            </View>
          </GlassPanel>

          <GlassPanel variant="card" style={styles.sectionCard}>
            <SellerSectionHeader title="Catalog mix" subtitle="Products by category" icon="pie-chart-outline" />
            {overview === null ? <Text style={styles.mutedText}>Catalog counts are unavailable until a verified refresh succeeds.</Text> : overview.categories.length ? overview.categories.slice(0, 8).map((item) => (
              <View key={item.name} style={styles.categoryRow}>
                <View style={styles.categoryCopy}><Text style={styles.categoryName} numberOfLines={1}>{item.name}</Text><Text style={styles.categoryCount}>{item.count}</Text></View>
                <View style={styles.categoryTrack}><LinearGradient colors={palette.gradients.cta} style={[styles.categoryFill, { width: `${Math.max(8, (item.count / maxCategoryCount) * 100)}%` }]} /></View>
              </View>
            )) : <Text style={styles.mutedText}>Categories appear after products are added.</Text>}
          </GlassPanel>

          {overview?.topRated.length > 0 && (
            <GlassPanel variant="card" style={styles.sectionCard}>
              <SellerSectionHeader title="Top rated" subtitle="Products customers love" icon="star-outline" />
              {overview.topRated.map((product) => (
                <View key={product._id} style={styles.ratingRow}>
                  <Text style={styles.productName} numberOfLines={1}>{product.name}</Text>
                  <View style={styles.ratingPill}><Ionicons name="star" size={12} color="#F59E0B" /><Text style={styles.ratingText}>{readSellerProductRating(product).toFixed(1)}</Text></View>
                </View>
              ))}
            </GlassPanel>
          )}
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safe: { flex: 1 },
  emptyStoreWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  scroll: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 100 },
  hero: { overflow: 'hidden', padding: 0 },
  banner: { width: '100%', height: 128 },
  bannerFallback: { height: 128, alignItems: 'center', justifyContent: 'center' },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, marginTop: -28 },
  logo: { width: 70, height: 70, borderRadius: 22, borderWidth: 3, borderColor: p.colors.surface },
  logoFallback: { width: 70, height: 70, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.surface, borderWidth: 3, borderColor: p.colors.surfaceElevated },
  identityCopy: { flex: 1, minWidth: 0, paddingTop: 30 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  storeName: { flexShrink: 1, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  storeMeta: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  trustText: { fontSize: 10, color: p.colors.textSecondary },
  heroActions: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg },
  primaryAction: { flex: 1, minHeight: 44, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary },
  primaryActionText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  secondaryAction: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  secondaryActionText: { color: p.colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  metricsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  metricCard: { flexGrow: 1, flexBasis: '47%', minWidth: 140, padding: spacing.lg },
  metricIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  metricLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  metricValue: { marginTop: 2, fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  sectionCard: { marginTop: spacing.md, padding: spacing.lg },
  healthBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, marginBottom: spacing.sm },
  healthTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  healthText: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  productRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  productImage: { width: 48, height: 48, borderRadius: 14 },
  productImageFallback: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  productName: { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  productMeta: { marginTop: 2, fontSize: 10, color: p.colors.textSecondary },
  stockPill: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full },
  stockText: { fontSize: 9, fontWeight: fontWeight.bold },
  performanceGrid: { flexDirection: 'row', alignItems: 'stretch', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle },
  performanceItem: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  performanceDivider: { width: StyleSheet.hairlineWidth, backgroundColor: p.glass.border, marginHorizontal: spacing.sm },
  performanceValue: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text, textAlign: 'center' },
  performanceLabel: { marginTop: 3, fontSize: 9, color: p.colors.textSecondary, textAlign: 'center' },
  categoryRow: { marginBottom: spacing.md },
  categoryCopy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 },
  categoryName: { flex: 1, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  categoryCount: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  categoryTrack: { height: 7, borderRadius: 4, overflow: 'hidden', backgroundColor: p.colors.primarySubtle },
  categoryFill: { height: '100%', borderRadius: 4 },
  mutedText: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', paddingVertical: spacing.lg },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  ratingPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, backgroundColor: 'rgba(245,158,11,0.12)' },
  ratingText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: '#D97706' },
});
