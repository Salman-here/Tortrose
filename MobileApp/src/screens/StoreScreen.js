/**
 * StoreScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Linking, Share, TextInput, ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import ProductCard from '../components/ProductCard';
import TrustButton from '../components/TrustButton';
import VerifiedBadge from '../components/VerifiedBadge';
import Loader from '../components/common/Loader';
import { EmptyProducts } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import TrustScoreSheet from '../components/common/TrustScoreSheet';
import StoreReviews from '../components/common/StoreReviews';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function StoreScreen({ route, navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const slug = route.params?.slug || route.params?.storeSlug;
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerError, setBannerError] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [trustSheetVisible, setTrustSheetVisible] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 12;

  const categories = React.useMemo(() => {
    const set = new Set();
    products.forEach(p => { if (p.category) set.add(p.category); });
    return ['All', ...Array.from(set)];
  }, [products]);

  const filteredProducts = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (activeCategory !== 'All' && p.category !== activeCategory) return false;
      if (!q) return true;
      return (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
    });
  }, [products, search, activeCategory]);

  useEffect(() => { setCurrentPage(1); }, [search, activeCategory]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const visibleProducts = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredProducts.slice(start, start + pageSize);
  }, [filteredProducts, currentPage]);

  const fetchStore = useCallback(async () => {
    if (!slug) { setIsLoading(false); return; }
    try { const res = await api.get(`/api/stores/${slug}`); setStore(res.data.store); setProducts(res.data.products || []); }
    catch (error) { console.error('Error fetching store:', error); }
    finally { setIsLoading(false); setRefreshing(false); }
  }, [slug]);

  useEffect(() => { if (slug) fetchStore(); }, [slug, fetchStore]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchStore(); }, [fetchStore]);

  const handleShare = useCallback(async () => {
    if (!store) return;
    try { await Share.share({ message: `Check out ${store.name} on Rozare!`, title: store.name }); } catch {}
  }, [store]);

  const handleContact = useCallback(() => { if (store?.email) Linking.openURL(`mailto:${store.email}`); }, [store]);

  const renderProduct = useCallback(({ item, index }) => (
    <View style={styles.productWrapper}>
      <ProductCard product={item} index={index} onPress={() => navigation.navigate('ProductDetail', { productId: item._id })} />
    </View>
  ), [navigation]);

  if (isLoading) return <GlassBackground><View style={styles.center}><Loader fullScreen message="Loading store..." /></View></GlassBackground>;

  if (!store) return (
    <GlassBackground>
      <View style={styles.center}>
        <Ionicons name="storefront-outline" size={64} color="rgba(255,255,255,0.3)" />
        <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text, marginTop: spacing.lg }}>Store not found</Text>
        <TouchableOpacity style={styles.goBackBtn} onPress={() => navigation.goBack()}><Text style={{ color: '#fff', fontWeight: fontWeight.semibold }}>Go Back</Text></TouchableOpacity>
      </View>
    </GlassBackground>
  );

  const isVerified = store?.verification?.isVerified;

  const renderHeader = () => (
    <View style={{ marginBottom: spacing.md }}>
      {/* Banner */}
      <View style={styles.bannerContainer}>
        {store.banner && !bannerError ? (
          <Image source={{ uri: store.banner }} style={styles.banner} contentFit="cover" cachePolicy="memory-disk" transition={200} onError={() => setBannerError(true)} />
        ) : <View style={[styles.banner, { backgroundColor: palette.colors.primary }]} />}
        <View style={styles.bannerOverlay} />
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare}><Ionicons name="share-outline" size={20} color="#fff" /></TouchableOpacity>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}><Ionicons name="arrow-back" size={20} color="#fff" /></TouchableOpacity>
      </View>

      {/* Store Info */}
      <View style={{ paddingHorizontal: spacing.md }}>
        <GlassPanel variant="strong" style={styles.storeInfoCard}>
          <View style={styles.logoContainer}>
            {store.logo && !logoError ? (
              <Image source={{ uri: store.logo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} onError={() => setLogoError(true)} />
            ) : (
              <View style={[styles.storeLogo, styles.logoPlaceholder]}><Ionicons name="storefront" size={32} color="#fff" /></View>
            )}
          </View>
          <View style={styles.nameRow}>
            <Text style={styles.storeName} numberOfLines={2}>{store.name}</Text>
            {isVerified && <VerifiedBadge size="md" style={{ marginLeft: 6 }} />}
          </View>
          <View style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, marginBottom: spacing.sm, backgroundColor: store?.sellerType === 'brand' ? 'rgba(16,185,129,0.15)' : 'rgba(59,130,246,0.15)', borderWidth: 1, borderColor: store?.sellerType === 'brand' ? 'rgba(16,185,129,0.35)' : 'rgba(59,130,246,0.35)' }}>
            <Ionicons name={store?.sellerType === 'brand' ? 'pricetag' : 'storefront'} size={11} color={store?.sellerType === 'brand' ? '#10b981' : '#3b82f6'} />
            <Text style={{ fontSize: 11, fontWeight: '700', color: store?.sellerType === 'brand' ? '#10b981' : '#3b82f6' }}>
              {store?.sellerType === 'brand' ? 'Brand' : 'Store'}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setTrustSheetVisible(true)} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(99,102,241,0.08)' }}>
            <Ionicons name="heart" size={14} color={palette.colors.heart} />
            <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, marginLeft: 4 }}>{store.trustCount || 0} trusters</Text>
            <Ionicons name="information-circle-outline" size={14} color={palette.colors.primary} style={{ marginLeft: 6 }} />
          </TouchableOpacity>
          {store.description && <Text style={styles.storeDescription} numberOfLines={3}>{store.description}</Text>}

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <View style={[styles.statIcon, { backgroundColor: 'rgba(99,102,241,0.12)' }]}><Ionicons name="cube-outline" size={16} color={palette.colors.primary} /></View>
              <View><Text style={styles.statValue}>{products.length}</Text><Text style={styles.statLabel}>Products</Text></View>
            </View>
            <View style={styles.statItem}>
              <View style={[styles.statIcon, { backgroundColor: 'rgba(59,130,246,0.12)' }]}><Ionicons name="eye-outline" size={16} color={palette.colors.info} /></View>
              <View><Text style={styles.statValue}>{store.views || 0}</Text><Text style={styles.statLabel}>Views</Text></View>
            </View>
            {isVerified && (
              <View style={styles.statItem}>
                <View style={[styles.statIcon, { backgroundColor: 'rgba(34,197,94,0.12)' }]}><Ionicons name="shield-checkmark" size={16} color={palette.colors.success} /></View>
                <View><Text style={styles.statValue}>Verified</Text><Text style={styles.statLabel}>Store</Text></View>
              </View>
            )}
          </View>

          <View style={styles.actionsRow}>
            {currentUser && <View style={{ flex: 1 }}><TrustButton storeId={store._id} storeName={store.name} initialTrustCount={store.trustCount || 0} initialIsTrusted={store.isTrusted || false} /></View>}
            {store.email && (
              <TouchableOpacity style={styles.contactButton} onPress={handleContact}>
                <Ionicons name="mail-outline" size={18} color={palette.colors.primary} /><Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: palette.colors.primary }}>Contact</Text>
              </TouchableOpacity>
            )}
          </View>
        </GlassPanel>
      </View>

      {/* Reviews thread */}
      <StoreReviews storeId={store._id} storeOwnerId={store.seller?._id || store.seller} />

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginTop: spacing.xl }}>
        <Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.colors.text }}>Products</Text>
        <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary }}>{filteredProducts.length} of {products.length}</Text>
      </View>

      {products.length > 0 && (
        <View style={{ paddingHorizontal: spacing.md, marginTop: spacing.md }}>
          <GlassPanel variant="card" style={styles.searchWrap}>
            <Ionicons name="search" size={16} color={palette.colors.textSecondary} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search in this store..."
              placeholderTextColor={palette.colors.textSecondary}
              style={styles.searchInput}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')}><Ionicons name="close-circle" size={18} color={palette.colors.textSecondary} /></TouchableOpacity>
            )}
          </GlassPanel>

          {categories.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.xs }}>
              {categories.map(cat => {
                const active = cat === activeCategory;
                return (
                  <TouchableOpacity key={cat} onPress={() => setActiveCategory(cat)} style={[styles.catChip, active && styles.catChipActive]}>
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]} numberOfLines={1}>{cat}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );

  return (
    <GlassBackground>
      <FlatList
        data={visibleProducts} keyExtractor={(item) => item._id} numColumns={2}
        columnWrapperStyle={styles.row} contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader()} renderItem={renderProduct}
        ListFooterComponent={filteredProducts.length > pageSize ? (
          <GlassPanel variant="card" style={styles.paginationCard}>
            <Text style={styles.paginationText}>
              Page {currentPage} of {totalPages}
            </Text>
            <View style={styles.paginationActions}>
              <TouchableOpacity
                style={[styles.pageButton, currentPage <= 1 && styles.pageButtonDisabled]}
                onPress={() => setCurrentPage(page => Math.max(1, page - 1))}
                disabled={currentPage <= 1}
              >
                <Ionicons name="chevron-back" size={18} color={currentPage <= 1 ? palette.colors.textLight : palette.colors.primary} />
                <Text style={[styles.pageButtonText, currentPage <= 1 && styles.pageButtonTextDisabled]}>Previous</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pageButton, currentPage >= totalPages && styles.pageButtonDisabled]}
                onPress={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                disabled={currentPage >= totalPages}
              >
                <Text style={[styles.pageButtonText, currentPage >= totalPages && styles.pageButtonTextDisabled]}>Next</Text>
                <Ionicons name="chevron-forward" size={18} color={currentPage >= totalPages ? palette.colors.textLight : palette.colors.primary} />
              </TouchableOpacity>
            </View>
          </GlassPanel>
        ) : null}
        ListEmptyComponent={() => <EmptyProducts onAdd={null} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
        showsVerticalScrollIndicator={false} initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5} removeClippedSubviews
      />
      <TrustScoreSheet visible={trustSheetVisible} onClose={() => setTrustSheetVisible(false)} storeId={store?._id} storeName={store?.name} />
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  goBackBtn: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 16, marginTop: spacing.xl },
  bannerContainer: { height: 160, position: 'relative' },
  banner: { width: '100%', height: '100%' },
  bannerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.2)' },
  shareBtn: { position: 'absolute', top: spacing.lg, right: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  backBtn: { position: 'absolute', top: spacing.lg, left: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  storeInfoCard: { marginTop: -50, padding: spacing.lg, alignItems: 'center' },
  logoContainer: { marginTop: -50, marginBottom: spacing.sm },
  storeLogo: { width: 84, height: 84, borderRadius: 42, borderWidth: 4, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: p.glass.bgSubtle },
  logoPlaceholder: { backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  storeName: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center' },
  storeDescription: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg, lineHeight: 20 },
  statsRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xl, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle, marginBottom: spacing.md, width: '100%' },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statIcon: { width: 34, height: 34, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  statValue: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  statLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  actionsRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.md, width: '100%' },
  contactButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: 16, borderWidth: 2, borderColor: p.colors.primary },
  listContent: { paddingBottom: spacing.xxl, flexGrow: 1 },
  row: { paddingHorizontal: spacing.sm, gap: spacing.sm },
  productWrapper: { flex: 1, marginBottom: spacing.sm },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.xl },
  searchInput: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, paddingVertical: 4 },
  catChip: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  catChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  catChipText: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  catChipTextActive: { color: '#fff' },
  paginationCard: { marginHorizontal: spacing.md, marginTop: spacing.md, padding: spacing.md, alignItems: 'center' },
  paginationText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, marginBottom: spacing.sm },
  paginationActions: { flexDirection: 'row', gap: spacing.sm },
  pageButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: `${p.colors.primary}14`, borderWidth: 1, borderColor: `${p.colors.primary}25` },
  pageButtonDisabled: { opacity: 0.45, backgroundColor: p.glass.bgSubtle, borderColor: p.glass.borderSubtle },
  pageButtonText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.bold },
  pageButtonTextDisabled: { color: p.colors.textLight },
});
