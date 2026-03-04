/**
 * StoreScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Linking, Share,
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
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

export default function StoreScreen({ route, navigation }) {
  const { currentUser } = useAuth();
  const slug = route.params?.slug || route.params?.storeSlug;
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bannerError, setBannerError] = useState(false);
  const [logoError, setLogoError] = useState(false);

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
    try { await Share.share({ message: `Check out ${store.name} on Tortrose!`, title: store.name }); } catch {}
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
        <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text, marginTop: spacing.lg }}>Store not found</Text>
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
        ) : <View style={[styles.banner, { backgroundColor: colors.primary }]} />}
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
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md }}>
            <Ionicons name="heart" size={14} color={colors.heart} />
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary, marginLeft: 4 }}>{store.trustCount || 0} trusters</Text>
          </View>
          {store.description && <Text style={styles.storeDescription} numberOfLines={3}>{store.description}</Text>}

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <View style={[styles.statIcon, { backgroundColor: 'rgba(99,102,241,0.12)' }]}><Ionicons name="cube-outline" size={16} color={colors.primary} /></View>
              <View><Text style={styles.statValue}>{products.length}</Text><Text style={styles.statLabel}>Products</Text></View>
            </View>
            <View style={styles.statItem}>
              <View style={[styles.statIcon, { backgroundColor: 'rgba(59,130,246,0.12)' }]}><Ionicons name="eye-outline" size={16} color={colors.info} /></View>
              <View><Text style={styles.statValue}>{store.views || 0}</Text><Text style={styles.statLabel}>Views</Text></View>
            </View>
            {isVerified && (
              <View style={styles.statItem}>
                <View style={[styles.statIcon, { backgroundColor: 'rgba(34,197,94,0.12)' }]}><Ionicons name="shield-checkmark" size={16} color={colors.success} /></View>
                <View><Text style={styles.statValue}>Verified</Text><Text style={styles.statLabel}>Store</Text></View>
              </View>
            )}
          </View>

          <View style={styles.actionsRow}>
            {currentUser && <View style={{ flex: 1 }}><TrustButton storeId={store._id} storeName={store.name} initialTrustCount={store.trustCount || 0} initialIsTrusted={store.isTrusted || false} /></View>}
            {store.email && (
              <TouchableOpacity style={styles.contactButton} onPress={handleContact}>
                <Ionicons name="mail-outline" size={18} color={colors.primary} /><Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primary }}>Contact</Text>
              </TouchableOpacity>
            )}
          </View>
        </GlassPanel>
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginTop: spacing.md }}>
        <Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text }}>Products</Text>
        <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>{products.length} items</Text>
      </View>
    </View>
  );

  return (
    <GlassBackground>
      <FlatList
        data={products} keyExtractor={(item) => item._id} numColumns={2}
        columnWrapperStyle={styles.row} contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader} renderItem={renderProduct}
        ListEmptyComponent={() => <EmptyProducts onAdd={null} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false} initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5} removeClippedSubviews
      />
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  goBackBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 16, marginTop: spacing.xl },
  bannerContainer: { height: 160, position: 'relative' },
  banner: { width: '100%', height: '100%' },
  bannerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.2)' },
  shareBtn: { position: 'absolute', top: spacing.lg, right: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  backBtn: { position: 'absolute', top: spacing.lg, left: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  storeInfoCard: { marginTop: -50, padding: spacing.lg, alignItems: 'center' },
  logoContainer: { marginTop: -50, marginBottom: spacing.sm },
  storeLogo: { width: 84, height: 84, borderRadius: 42, borderWidth: 4, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: glass.bgSubtle },
  logoPlaceholder: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  storeName: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  storeDescription: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg, lineHeight: 20 },
  statsRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xl, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: glass.borderSubtle, marginBottom: spacing.md, width: '100%' },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statIcon: { width: 34, height: 34, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  statValue: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  statLabel: { fontSize: fontSize.xs, color: colors.textSecondary },
  actionsRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.md, width: '100%' },
  contactButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: 16, borderWidth: 2, borderColor: colors.primary },
  listContent: { paddingBottom: spacing.xxl, flexGrow: 1 },
  row: { paddingHorizontal: spacing.sm, gap: spacing.sm },
  productWrapper: { flex: 1, marginBottom: spacing.sm },
});
