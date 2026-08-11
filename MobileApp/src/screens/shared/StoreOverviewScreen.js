import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import api from '../../config/api';
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
import { useTheme } from '../../contexts/ThemeContext';
import { getStorefrontHost } from '../../utils/storefrontUrl';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

const orderStatus = (order) => order?.orderStatus || order?.status || 'pending';

export const calculateStoreOverview = (
  products = [],
  orders = [],
  convertAmount = (amount) => Number(amount || 0),
  targetCurrency = 'USD'
) => {
  const paidOrders = orders.filter((order) => order?.isPaid);
  const revenue = paidOrders.reduce((sum, order) => (
    sum + convertAmount(order?.orderSummary?.totalAmount || 0, order?.currency || 'USD', targetCurrency)
  ), 0);
  const delivered = orders.filter((order) => orderStatus(order) === 'delivered').length;
  const outOfStock = products.filter((product) => Number(product?.stock || 0) <= 0).length;
  const lowStock = products.filter((product) => Number(product?.stock || 0) > 0 && Number(product.stock) <= 10).length;
  const featured = products.filter((product) => product?.isFeatured).length;
  const categoryMap = products.reduce((map, product) => {
    const category = String(product?.category || 'Uncategorized').trim() || 'Uncategorized';
    map[category] = (map[category] || 0) + 1;
    return map;
  }, {});
  const categories = Object.entries(categoryMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const topRated = [...products]
    .filter((product) => Number(product?.rating || product?.averageRating || 0) > 0)
    .sort((a, b) => Number(b?.rating || b?.averageRating || 0) - Number(a?.rating || a?.averageRating || 0))
    .slice(0, 4);

  return {
    totalProducts: products.length,
    outOfStock,
    lowStock,
    featured,
    totalOrders: orders.length,
    paidOrders: paidOrders.length,
    delivered,
    revenue,
    averageOrderValue: paidOrders.length ? revenue / paidOrders.length : 0,
    fulfillmentRate: orders.length ? Math.round((delivered / orders.length) * 100) : 0,
    categories,
    topRated,
  };
};

export const formatCurrency = (amount, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount || 0));
  } catch (_) {
    return `${currency} ${Number(amount || 0).toFixed(2)}`;
  }
};

export default function StoreOverviewScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currency, convertAmount, formatAmount } = useCurrency();
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadOverview = useCallback(async () => {
    const results = await Promise.allSettled([
      api.get('/api/stores/my-store'),
      fetchCompleteSellerCatalog(),
      api.get('/api/order/get'),
    ]);
    const [storeResult, productResult, orderResult] = results;
    const failed = [];

    if (storeResult.status === 'fulfilled') {
      setStore(storeResult.value.data?.store || storeResult.value.data || null);
    } else if (storeResult.reason?.response?.status === 404) {
      setStore(null);
    } else failed.push('store profile');

    if (productResult.status === 'fulfilled') setProducts(productResult.value);
    else failed.push('inventory');

    if (orderResult.status === 'fulfilled') {
      const nextOrders = orderResult.value.data?.orders || orderResult.value.data || [];
      setOrders(Array.isArray(nextOrders) ? nextOrders : []);
    } else failed.push('orders');

    setLoadError(failed.length ? `Could not refresh ${failed.join(', ')}. Existing information is shown where available.` : '');
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const overview = useMemo(
    () => calculateStoreOverview(products, orders, convertAmount, currency),
    [products, orders, convertAmount, currency]
  );
  const recentProducts = useMemo(
    () => [...products].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)).slice(0, 6),
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
  const isVerified = Boolean(store?.verification?.isVerified);
  const inventoryHealthy = overview.outOfStock === 0 && overview.lowStock === 0;
  const maxCategoryCount = Math.max(1, ...overview.categories.map((item) => item.count));

  const metrics = [
    { label: 'Revenue', value: formatAmount(overview.revenue), icon: 'cash-outline', color: '#10B981', tint: 'rgba(16,185,129,0.12)' },
    { label: 'Orders', value: overview.totalOrders, icon: 'receipt-outline', color: '#6366F1', tint: 'rgba(99,102,241,0.12)' },
    { label: 'Products', value: overview.totalProducts, icon: 'cube-outline', color: '#0EA5E9', tint: 'rgba(14,165,233,0.12)' },
    { label: 'Fulfilment', value: `${overview.fulfillmentRate}%`, icon: 'checkmark-done-outline', color: '#8B5CF6', tint: 'rgba(139,92,246,0.12)' },
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
                  <Text style={styles.trustText}>{Number(store?.trustCount || 0).toLocaleString()} people trust this store</Text>
                </View>
              </View>
            </View>
            <View style={styles.heroActions}>
              <TouchableOpacity style={styles.primaryAction} onPress={() => navigation.navigate('Store', { storeSlug: store?.storeSlug })} disabled={!store?.storeSlug} activeOpacity={0.78}>
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
            <View style={[styles.healthBanner, { backgroundColor: inventoryHealthy ? palette.colors.successSubtle : palette.colors.warningSubtle }]}>
              <Ionicons name={inventoryHealthy ? 'checkmark-circle' : 'warning'} size={21} color={inventoryHealthy ? palette.colors.success : palette.colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={styles.healthTitle}>{inventoryHealthy ? 'Inventory looks healthy' : 'Inventory needs attention'}</Text>
                <Text style={styles.healthText}>{overview.outOfStock} out of stock · {overview.lowStock} low stock · {overview.featured} featured</Text>
              </View>
            </View>
            {recentProducts.length ? recentProducts.map((product) => {
              const stock = Number(product?.stock || 0);
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
            )}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.sectionCard}>
            <SellerSectionHeader title="Sales performance" subtitle="Paid-order value and fulfilment" icon="trending-up-outline" actionLabel="Orders" onAction={() => navigation.navigate('SellerOrderManagement')} />
            <View style={styles.performanceGrid}>
              <View style={styles.performanceItem}><Text style={styles.performanceValue}>{formatAmount(overview.averageOrderValue)}</Text><Text style={styles.performanceLabel}>Avg. paid order</Text></View>
              <View style={styles.performanceDivider} />
              <View style={styles.performanceItem}><Text style={styles.performanceValue}>{overview.paidOrders}</Text><Text style={styles.performanceLabel}>Paid orders</Text></View>
              <View style={styles.performanceDivider} />
              <View style={styles.performanceItem}><Text style={styles.performanceValue}>{overview.delivered}</Text><Text style={styles.performanceLabel}>Delivered</Text></View>
            </View>
          </GlassPanel>

          <GlassPanel variant="card" style={styles.sectionCard}>
            <SellerSectionHeader title="Catalog mix" subtitle="Products by category" icon="pie-chart-outline" />
            {overview.categories.length ? overview.categories.slice(0, 8).map((item) => (
              <View key={item.name} style={styles.categoryRow}>
                <View style={styles.categoryCopy}><Text style={styles.categoryName} numberOfLines={1}>{item.name}</Text><Text style={styles.categoryCount}>{item.count}</Text></View>
                <View style={styles.categoryTrack}><LinearGradient colors={palette.gradients.cta} style={[styles.categoryFill, { width: `${Math.max(8, (item.count / maxCategoryCount) * 100)}%` }]} /></View>
              </View>
            )) : <Text style={styles.mutedText}>Categories appear after products are added.</Text>}
          </GlassPanel>

          {overview.topRated.length > 0 && (
            <GlassPanel variant="card" style={styles.sectionCard}>
              <SellerSectionHeader title="Top rated" subtitle="Products customers love" icon="star-outline" />
              {overview.topRated.map((product) => (
                <View key={product._id} style={styles.ratingRow}>
                  <Text style={styles.productName} numberOfLines={1}>{product.name}</Text>
                  <View style={styles.ratingPill}><Ionicons name="star" size={12} color="#F59E0B" /><Text style={styles.ratingText}>{Number(product.rating || product.averageRating || 0).toFixed(1)}</Text></View>
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
