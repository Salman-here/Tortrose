/**
 * StoreScreen — Liquid Glass Design, matched to the website's StorePage:
 * banner + overlapping logo header, type pill + trust, address, social links,
 * available coupons (with copy), and server-side paginated products with
 * search + category chips.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Linking, Share, TextInput, ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/CurrencyContext';
import ProductCard from '../components/ProductCard';
import TrustButton from '../components/TrustButton';
import VerifiedBadge from '../components/VerifiedBadge';
import Loader from '../components/common/Loader';
import { EmptyProducts } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import GlassBlurFill from '../components/common/GlassBlurFill';
import TrustScoreSheet from '../components/common/TrustScoreSheet';
import StoreReviews from '../components/common/StoreReviews';
import { spacing, fontSize, borderRadius, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const PRODUCTS_PER_PAGE = 12; // matches website

const SOCIAL_LINKS = [
  { key: 'website', icon: 'globe-outline', label: 'Website', color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
  { key: 'facebook', icon: 'logo-facebook', label: 'Facebook', color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
  { key: 'instagram', icon: 'logo-instagram', label: 'Instagram', color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
  { key: 'twitter', icon: 'logo-twitter', label: 'X', color: '#0f172a', bg: 'rgba(15,23,42,0.08)' },
  { key: 'youtube', icon: 'logo-youtube', label: 'YouTube', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  { key: 'tiktok', icon: 'logo-tiktok', label: 'TikTok', color: '#0f172a', bg: 'rgba(15,23,42,0.08)' },
];

const getEntityId = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value._id || value.id || '';
};

// Stable anonymous visitor id so store views are deduped like the website
async function getStoreVisitorId() {
  const key = 'rozareStoreVisitorId';
  let id = await AsyncStorage.getItem(key);
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await AsyncStorage.setItem(key, id);
  }
  return id;
}

export default function StoreScreen({ route, navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { formatPrice } = useCurrency();

  const { currentUser } = useAuth();
  const slug = route.params?.slug || route.params?.storeSlug;
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [storeCategories, setStoreCategories] = useState([]);
  const [productPagination, setProductPagination] = useState({ total: 0, page: 1, pages: 1 });
  const [isLoading, setIsLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerError, setBannerError] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [trustSheetVisible, setTrustSheetVisible] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [productPage, setProductPage] = useState(1);
  const [storeCoupons, setStoreCoupons] = useState([]);
  const [copiedCoupon, setCopiedCoupon] = useState(null);
  const [storeRating, setStoreRating] = useState({ average: 0, count: 0 });

  // Debounced product search (server-side, like website)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setProductPage(1); }, [debouncedSearch, activeCategory]);

  const fetchStore = useCallback(async () => {
    if (!slug) { setIsLoading(false); return; }
    try {
      const res = await api.get(`/api/stores/${slug}`);
      setStore(res.data.store);
      setStoreRating({
        average: Number(res.data.store?.ratingAverage) || 0,
        count: Number(res.data.store?.ratingCount) || 0,
      });
    } catch (error) { console.error('Error fetching store:', error); }
    finally { setIsLoading(false); setRefreshing(false); }
  }, [slug]);

  const fetchProducts = useCallback(async () => {
    if (!slug) return;
    setProductsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(productPage), limit: String(PRODUCTS_PER_PAGE) });
      if (activeCategory !== 'all') params.set('categories', activeCategory);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await api.get(`/api/stores/${slug}/products?${params.toString()}`);
      setProducts(res.data.products || []);
      setProductPagination(res.data.pagination || { total: res.data.products?.length || 0, page: productPage, pages: 1 });
      setStoreCategories(res.data.categories || []);
    } catch (error) { console.error('Error fetching store products:', error); }
    finally { setProductsLoading(false); }
  }, [slug, productPage, activeCategory, debouncedSearch]);

  const fetchStoreCoupons = useCallback(async (sellerId) => {
    if (!sellerId || typeof sellerId !== 'string') { setStoreCoupons([]); return; }
    try {
      const res = await api.get(`/api/coupons/store/${sellerId}`);
      setStoreCoupons(res.data.coupons || []);
    } catch { /* no coupons for this store */ }
  }, []);

  const incrementViewCount = useCallback(async () => {
    if (!slug) return;
    try {
      const visitorId = await getStoreVisitorId();
      await api.post(`/api/stores/${slug}/view`, {}, { headers: { 'x-rozare-visitor-id': visitorId } });
    } catch { /* non-fatal */ }
  }, [slug]);

  useEffect(() => { fetchStore(); incrementViewCount(); }, [fetchStore, incrementViewCount]);
  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  useEffect(() => {
    const sellerId = getEntityId(store?.seller);
    if (sellerId) fetchStoreCoupons(sellerId);
  }, [store?.seller, fetchStoreCoupons]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchStore(); fetchProducts(); }, [fetchStore, fetchProducts]);

  const storeName = store?.storeName || store?.name;
  const isVerified = store?.verification?.isVerified;
  const isBrand = store?.sellerType === 'brand';
  const totalProducts = productPagination.total ?? products.length;
  const totalPages = Math.max(1, productPagination.pages || 1);
  const categories = useMemo(() => {
    if (storeCategories.length > 0) return storeCategories;
    return [...new Set(products.map(p => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }, [products, storeCategories]);
  const address = store?.address;
  const hasAddress = address && (address.street || address.city || address.country);
  const socialEntries = SOCIAL_LINKS.filter(s => store?.socialLinks?.[s.key]);

  const handleShare = useCallback(async () => {
    if (!store) return;
    try {
      await Share.share({ message: `Check out ${storeName} on Rozare! https://${slug}.rozare.com`, title: storeName });
    } catch {}
  }, [store, storeName, slug]);

  const copyCouponCode = useCallback(async (code) => {
    await Clipboard.setStringAsync(code);
    setCopiedCoupon(code);
    Toast.show({ type: 'success', text1: 'Copied!', text2: 'Coupon code copied' });
    setTimeout(() => setCopiedCoupon(null), 2000);
  }, []);

  const renderProduct = useCallback(({ item, index }) => (
    <View style={styles.productWrapper}>
      <ProductCard product={item} index={index} onPress={() => navigation.navigate('ProductDetail', { productId: item._id })} />
    </View>
  ), [navigation]);

  if (isLoading) return <GlassBackground><View style={styles.center}><Loader fullScreen message="Loading store..." /></View></GlassBackground>;

  if (!store) return (
    <GlassBackground>
      <View style={styles.center}>
        <Ionicons name="storefront-outline" size={64} color={palette.colors.textLight} />
        <Text style={styles.notFoundTitle}>Store Not Found</Text>
        <Text style={styles.notFoundSub}>The store you're looking for doesn't exist or has been removed.</Text>
        <TouchableOpacity style={styles.goBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.85}>
          <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
          <Text style={{ color: '#fff', fontWeight: fontWeight.semibold }}>Browse All Stores</Text>
        </TouchableOpacity>
      </View>
    </GlassBackground>
  );

  const renderHeader = () => (
    <View style={{ marginBottom: spacing.md }}>
      {/* Store Header Card — banner + overlapping logo like website */}
      <GlassPanel variant="strong" style={styles.headerCard}>
        {store.banner && !bannerError ? (
          <View style={styles.bannerContainer}>
            <Image source={{ uri: store.banner }} style={styles.banner} contentFit="cover" cachePolicy="memory-disk" transition={200} onError={() => setBannerError(true)} />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.4)']} style={StyleSheet.absoluteFill} />
          </View>
        ) : (
          <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.bannerFallback} />
        )}

        <View style={styles.headerBody}>
          {/* Overlapping logo */}
          <View style={styles.logoWrap}>
            {store.logo && !logoError ? (
              <Image source={{ uri: store.logo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} onError={() => setLogoError(true)} />
            ) : (
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.storeLogo, styles.logoPlaceholder]}>
                <Ionicons name="storefront" size={34} color="#fff" />
              </LinearGradient>
            )}
          </View>

          {/* Name + badges */}
          <View style={styles.nameRow}>
            <Text style={styles.storeName}>{storeName}</Text>
            {isVerified && <VerifiedBadge size="lg" />}
            <View style={[styles.typePill, { backgroundColor: isBrand ? 'rgba(168,85,247,0.15)' : 'rgba(59,130,246,0.15)', borderColor: isBrand ? 'rgba(168,85,247,0.35)' : 'rgba(59,130,246,0.35)' }]}>
              <Text style={[styles.typePillText, { color: isBrand ? '#a855f7' : '#3b82f6' }]}>{isBrand ? 'BRAND' : 'STORE'}</Text>
            </View>
          </View>

          {/* Trusters */}
          <TouchableOpacity onPress={() => setTrustSheetVisible(true)} activeOpacity={0.7} style={styles.trustersRow}>
            <Ionicons name="people" size={13} color={palette.colors.textSecondary} />
            <Text style={styles.trustersText}>{store.trustCount || 0} {store.trustCount === 1 ? 'truster' : 'trusters'}</Text>
            <Ionicons name="information-circle-outline" size={13} color={palette.colors.primary} />
          </TouchableOpacity>
          <View style={styles.ratingRow}>
            <Ionicons name={storeRating.count > 0 ? 'star' : 'star-outline'} size={13} color="#fbbf24" />
            <Text style={styles.trustersText}>
              {storeRating.count > 0 ? `${Number(storeRating.average).toFixed(1)} store rating (${storeRating.count})` : 'No store ratings yet'}
            </Text>
          </View>

          {store.description && <Text style={styles.storeDescription}>{store.description}</Text>}

          {/* Address */}
          {hasAddress && (
            <View style={styles.addressBox}>
              <Ionicons name="location-outline" size={16} color={palette.colors.textSecondary} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                {address.street ? <Text style={styles.addressText}>{address.street}</Text> : null}
                <Text style={styles.addressText}>{[address.city, address.state, address.postalCode].filter(Boolean).join(', ')}</Text>
                {address.country ? <Text style={styles.addressText}>{address.country}</Text> : null}
              </View>
            </View>
          )}

          {/* Stat pills */}
          <View style={styles.pillsRow}>
            <View style={styles.statPill}>
              <Ionicons name="cube-outline" size={13} color={palette.colors.primary} />
              <Text style={styles.statPillText}>{totalProducts} Products</Text>
            </View>
            <View style={[styles.statPill, { backgroundColor: 'rgba(56,189,248,0.1)', borderColor: 'rgba(56,189,248,0.18)' }]}>
              <Ionicons name="eye-outline" size={13} color="#0ea5e9" />
              <Text style={[styles.statPillText, { color: '#0ea5e9' }]}>{store.views || 0} Views</Text>
            </View>
          </View>

          {/* Social links */}
          {socialEntries.length > 0 && (
            <View style={styles.socialRow}>
              {socialEntries.map(s => (
                <TouchableOpacity key={s.key} style={[styles.socialBtn, { backgroundColor: s.bg }]}
                  onPress={() => Linking.openURL(store.socialLinks[s.key]).catch(() => {})} activeOpacity={0.8}>
                  <Ionicons name={s.icon} size={15} color={s.color} />
                  <Text style={[styles.socialBtnText, { color: s.color }]}>{s.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Actions: Trust + Share */}
          <View style={styles.actionsRow}>
            {currentUser && <View style={{ flex: 1 }}><TrustButton storeId={store._id} storeName={storeName} initialTrustCount={store.trustCount || 0} initialIsTrusted={store.isTrusted || false} /></View>}
            <TouchableOpacity style={styles.shareButton} onPress={handleShare} activeOpacity={0.8}>
              <Ionicons name="share-social-outline" size={16} color={palette.colors.text} />
              <Text style={styles.shareButtonText}>Share Store</Text>
            </TouchableOpacity>
          </View>
        </View>
      </GlassPanel>

      {/* Available Coupons */}
      {storeCoupons.length > 0 && (
        <GlassPanel variant="strong" style={styles.couponsCard}>
          <View style={styles.couponsHeader}>
            <View style={styles.couponsIcon}><Ionicons name="ticket-outline" size={16} color="#a855f7" /></View>
            <Text style={styles.couponsTitle}>Available Coupons</Text>
            <View style={styles.couponsCountPill}>
              <Text style={styles.couponsCountText}>{storeCoupons.length} coupon{storeCoupons.length !== 1 ? 's' : ''}</Text>
            </View>
          </View>
          {storeCoupons.map(coupon => (
            <View key={coupon._id} style={styles.couponCard}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.couponAccent} />
              <View style={styles.couponTopRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.couponCode}>{coupon.code}</Text>
                  <View style={styles.couponBadgesRow}>
                    <View style={styles.couponOffBadge}>
                      <Text style={styles.couponOffText}>
                        {coupon.discountType === 'percentage'
                          ? `${coupon.discountValue}% OFF`
                          : `${formatPrice(coupon.discountValue, { sourceCurrency: coupon.currency || 'USD' })} OFF`}
                      </Text>
                    </View>
                    <View style={styles.couponScopeBadge}>
                      <Text style={styles.couponScopeText}>{coupon.applicableTo === 'all' ? 'All Products' : `${coupon.applicableProducts?.length || 0} Products`}</Text>
                    </View>
                  </View>
                </View>
                <TouchableOpacity
                  style={[styles.couponCopyBtn, copiedCoupon === coupon.code && styles.couponCopiedBtn]}
                  onPress={() => copyCouponCode(coupon.code)} activeOpacity={0.8}>
                  <Ionicons name={copiedCoupon === coupon.code ? 'checkmark' : 'copy-outline'} size={12} color={copiedCoupon === coupon.code ? '#10b981' : '#a855f7'} />
                  <Text style={[styles.couponCopyText, copiedCoupon === coupon.code && { color: '#10b981' }]}>
                    {copiedCoupon === coupon.code ? 'Copied' : 'Copy'}
                  </Text>
                </TouchableOpacity>
              </View>
              {coupon.description ? <Text style={styles.couponDesc}>{coupon.description}</Text> : null}
              <View style={styles.couponMetaRow}>
                {coupon.minOrderAmount > 0 && <Text style={styles.couponMeta}>Min order: {formatPrice(coupon.minOrderAmount, { sourceCurrency: coupon.currency || 'USD' })}</Text>}
                {coupon.maxDiscountAmount ? <Text style={styles.couponMeta}>Max discount: {formatPrice(coupon.maxDiscountAmount, { sourceCurrency: coupon.currency || 'USD' })}</Text> : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                  <Ionicons name="calendar-outline" size={10} color={palette.colors.textSecondary} />
                  <Text style={styles.couponMeta}>Expires {new Date(coupon.expiryDate).toLocaleDateString()}</Text>
                </View>
              </View>
            </View>
          ))}
        </GlassPanel>
      )}

      {/* Reviews thread */}
      <StoreReviews storeId={store._id} storeOwnerId={getEntityId(store.seller)} onSummaryChange={setStoreRating} />

      {/* Products heading */}
      <View style={styles.productsHeader}>
        <Text style={styles.productsTitle}>Products</Text>
        <View style={styles.statPill}>
          <Text style={styles.statPillText}>{totalProducts} {totalProducts === 1 ? 'item' : 'items'}</Text>
        </View>
      </View>

      {/* Search + Category chips */}
      {(products.length > 0 || debouncedSearch || activeCategory !== 'all') && (
        <View style={{ paddingHorizontal: spacing.md, marginTop: spacing.sm }}>
          <GlassPanel variant="card" style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={palette.colors.textSecondary} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search products in this store..."
              placeholderTextColor={palette.colors.textLight}
              style={styles.searchInput}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={18} color={palette.colors.textSecondary} /></TouchableOpacity>
            )}
          </GlassPanel>

          {categories.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.xs, alignItems: 'center' }}>
              {['all', ...categories].map(cat => {
                const active = cat === activeCategory;
                return (
                  <TouchableOpacity key={cat} onPress={() => setActiveCategory(cat)} style={[styles.catChip, active && styles.catChipActive]} activeOpacity={0.85}>
                    {active && <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
                    {cat === 'all' && <Ionicons name="pricetag-outline" size={12} color={active ? '#fff' : palette.colors.textSecondary} />}
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]} numberOfLines={1}>
                      {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {productsLoading && (
        <View style={{ paddingVertical: spacing.lg, alignItems: 'center' }}>
          <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary }}>Loading products...</Text>
        </View>
      )}
    </View>
  );

  return (
    <GlassBackground>
      <FlatList
        data={productsLoading ? [] : products} keyExtractor={(item) => item._id} numColumns={2}
        columnWrapperStyle={styles.row} contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader()} renderItem={renderProduct}
        ListFooterComponent={!productsLoading && totalPages > 1 ? (
          <GlassPanel variant="card" style={styles.paginationCard}>
            <Text style={styles.paginationText}>Page {productPagination.page || productPage} of {totalPages}</Text>
            <View style={styles.paginationActions}>
              <TouchableOpacity
                style={[styles.pageButton, productPage <= 1 && styles.pageButtonDisabled]}
                onPress={() => setProductPage(page => Math.max(1, page - 1))}
                disabled={productPage <= 1}
              >
                <Ionicons name="chevron-back" size={18} color={productPage <= 1 ? palette.colors.textLight : palette.colors.primary} />
                <Text style={[styles.pageButtonText, productPage <= 1 && styles.pageButtonTextDisabled]}>Previous</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pageButton, productPage >= totalPages && styles.pageButtonDisabled]}
                onPress={() => setProductPage(page => Math.min(totalPages, page + 1))}
                disabled={productPage >= totalPages}
              >
                <Text style={[styles.pageButtonText, productPage >= totalPages && styles.pageButtonTextDisabled]}>Next</Text>
                <Ionicons name="chevron-forward" size={18} color={productPage >= totalPages ? palette.colors.textLight : palette.colors.primary} />
              </TouchableOpacity>
            </View>
          </GlassPanel>
        ) : null}
        ListEmptyComponent={productsLoading ? null : () => (
          <View style={styles.emptyBox}>
            <View style={styles.emptyIcon}><Ionicons name="cube-outline" size={40} color={palette.colors.textSecondary} /></View>
            <Text style={styles.emptyTitle}>{debouncedSearch || activeCategory !== 'all' ? 'No products match your filters' : 'No products yet'}</Text>
            <Text style={styles.emptySub}>{debouncedSearch || activeCategory !== 'all' ? 'Try a different search or category' : "This store hasn't added any products"}</Text>
          </View>
        )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
        showsVerticalScrollIndicator={false} initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5} removeClippedSubviews
      />
      {/* Floating back button over the banner */}
      <TouchableOpacity style={styles.floatBack} onPress={() => navigation.goBack()}>
        <GlassBlurFill />
        <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
      </TouchableOpacity>
      <TrustScoreSheet visible={trustSheetVisible} onClose={() => setTrustSheetVisible(false)} storeId={store?._id} storeName={storeName} />
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  notFoundTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.lg },
  notFoundSub: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },
  goBackBtn: { paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 16, marginTop: spacing.xl, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },

  // Header card
  headerCard: { margin: spacing.md, marginTop: spacing.sm, padding: 0, overflow: 'hidden' },
  bannerContainer: { height: 170 },
  banner: { width: '100%', height: '100%' },
  bannerFallback: { height: 96 },
  headerBody: { padding: spacing.lg, paddingTop: 0 },
  logoWrap: { marginTop: -44, marginBottom: spacing.sm, alignSelf: 'flex-start' },
  storeLogo: { width: 88, height: 88, borderRadius: 20, borderWidth: 3, borderColor: 'rgba(255,255,255,0.65)', backgroundColor: p.glass.bgSubtle },
  logoPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  storeName: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.4 },
  typePill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  typePillText: { fontSize: 10, fontWeight: fontWeight.bold, letterSpacing: 0.8 },
  trustersRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.sm },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -spacing.xs, marginBottom: spacing.sm },
  trustersText: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  storeDescription: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  addressBox: { flexDirection: 'row', gap: spacing.sm, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, borderRadius: 14, padding: spacing.md, marginBottom: spacing.md },
  addressText: { fontSize: fontSize.sm, color: p.colors.text, lineHeight: 19 },
  pillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  statPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)' },
  statPillText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },
  socialRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  socialBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 12 },
  socialBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  shareButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: 14, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border },
  shareButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },

  // Coupons
  couponsCard: { marginHorizontal: spacing.md, marginBottom: spacing.md, padding: spacing.lg },
  couponsHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  couponsIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: 'rgba(168,85,247,0.12)', justifyContent: 'center', alignItems: 'center' },
  couponsTitle: { flex: 1, fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  couponsCountPill: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)' },
  couponsCountText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: p.colors.primary },
  couponCard: { backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, borderRadius: 14, padding: spacing.md, paddingTop: spacing.md + 3, marginBottom: spacing.sm, overflow: 'hidden' },
  couponAccent: { position: 'absolute', top: 0, left: 0, right: 0, height: 3 },
  couponTopRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: 6 },
  couponCode: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: '#a855f7', letterSpacing: 1.5, fontVariant: ['tabular-nums'] },
  couponBadgesRow: { flexDirection: 'row', gap: 6, marginTop: 5, flexWrap: 'wrap' },
  couponOffBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(16,185,129,0.1)' },
  couponOffText: { fontSize: 10, fontWeight: fontWeight.semibold, color: '#10b981' },
  couponScopeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(59,130,246,0.08)' },
  couponScopeText: { fontSize: 10, color: '#3b82f6' },
  couponCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(168,85,247,0.12)' },
  couponCopiedBtn: { backgroundColor: 'rgba(16,185,129,0.15)' },
  couponCopyText: { fontSize: 11, fontWeight: fontWeight.semibold, color: '#a855f7' },
  couponDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginBottom: 6 },
  couponMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  couponMeta: { fontSize: 10, color: p.colors.textSecondary },

  // Products
  productsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginTop: spacing.md },
  productsTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.4 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.xl },
  searchInput: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, paddingVertical: 4 },
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: 999, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, overflow: 'hidden' },
  catChipActive: { borderColor: 'transparent' },
  catChipText: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  catChipTextActive: { color: '#fff' },
  listContent: { paddingBottom: 110, flexGrow: 1 },
  row: { paddingHorizontal: spacing.lg, justifyContent: 'space-between' },
  productWrapper: { flex: 1, maxWidth: '49%', marginBottom: spacing.sm },
  emptyBox: { alignItems: 'center', paddingVertical: spacing.xxxl, paddingHorizontal: spacing.xl },
  emptyIcon: { width: 84, height: 84, borderRadius: 22, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  emptyTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  emptySub: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 4 },

  // Pagination
  paginationCard: { marginHorizontal: spacing.md, marginTop: spacing.md, padding: spacing.md, alignItems: 'center' },
  paginationText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, marginBottom: spacing.sm },
  paginationActions: { flexDirection: 'row', gap: spacing.sm },
  pageButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: `${p.colors.primary}14`, borderWidth: 1, borderColor: `${p.colors.primary}25` },
  pageButtonDisabled: { opacity: 0.45, backgroundColor: p.glass.bgSubtle, borderColor: p.glass.borderSubtle },
  pageButtonText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.bold },
  pageButtonTextDisabled: { color: p.colors.textLight },

  // Floating back
  floatBack: { position: 'absolute', top: spacing.lg, left: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
});
