/**
 * StoreOverviewScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import VerifiedBadge from '../../components/VerifiedBadge';
import Loader from '../../components/common/Loader';
import EmptyState from '../../components/common/EmptyState';
import StatCard from '../../components/common/StatCard';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

export const formatCurrency = (amount, currency = 'USD') => {
  if (typeof amount !== 'number' || isNaN(amount)) return '$0.00';
  return `$${amount.toFixed(2)}`;
};

export default function StoreOverviewScreen({ route, navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { storeId } = route.params || {};
  const { currentUser } = useAuth();
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStoreData = useCallback(async () => {
    if (!storeId) { setIsLoading(false); return; }
    try {
      const storeRes = await api.get(`/api/stores/${storeId}`);
      const storeData = storeRes.data.store || storeRes.data;
      setStore(storeData);

      try { const prodRes = await api.get(`/api/products/get-products?store=${storeId}`); setProducts(prodRes.data.products || prodRes.data || []); } catch { setProducts([]); }
    } catch (e) { Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to load store' }); }
    finally { setIsLoading(false); }
  }, [storeId]);

  useEffect(() => { fetchStoreData(); }, [fetchStoreData]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchStoreData(); setRefreshing(false); }, [fetchStoreData]);

  if (isLoading) return <GlassBackground><Loader fullScreen /></GlassBackground>;
  if (!store) return <GlassBackground><EmptyState icon="storefront-outline" title="Store Not Found" actionLabel="Go Back" onAction={() => navigation.goBack()} /></GlassBackground>;

  const isVerified = store.verification?.isVerified;

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        
        {/* Store Header */}
        <GlassPanel variant="strong" style={styles.header}>
          {store.banner ? <Image source={{ uri: store.banner }} style={styles.banner} contentFit="cover" /> : (
            <View style={styles.bannerPlaceholder}><Ionicons name="image-outline" size={48} color={palette.colors.textSecondary} /></View>
          )}
          <View style={styles.storeInfoContainer}>
            {store.logo ? <Image source={{ uri: store.logo }} style={styles.logo} contentFit="cover" /> : (
              <View style={styles.logoPlaceholder}><Ionicons name="storefront" size={32} color={palette.colors.primary} /></View>
            )}
            <View style={{ flex: 1 }}>
              <View style={styles.storeNameRow}>
                <Text style={styles.storeName}>{store.storeName || store.name}</Text>
                {isVerified && <VerifiedBadge size="md" />}
              </View>
              {store.description && <Text style={styles.storeDescription} numberOfLines={2}>{store.description}</Text>}
              <View style={styles.trustRow}>
                <Ionicons name="people" size={16} color={palette.colors.primary} />
                <Text style={styles.trustCount}>{store.trustCount || 0} trusters</Text>
              </View>
            </View>
          </View>
        </GlassPanel>

        {/* Stats */}
        <View style={styles.statsGrid}>
          <StatCard title="Products" value={products.length} icon="cube-outline" iconColor={palette.colors.primary} iconBgColor="rgba(99,102,241,0.12)" />
          <StatCard title="Trusters" value={store.trustCount || 0} icon="people-outline" iconColor={palette.colors.info} iconBgColor="rgba(14,165,233,0.12)" />
        </View>

        {/* Quick Actions */}
        <View style={styles.actionsSection}>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: palette.colors.primary }]}
            onPress={() => navigation.navigate('SellerProductManagement', { storeId, isAdmin: false })}>
            <Ionicons name="cube" size={20} color="white" /><Text style={styles.actionButtonText}>Products</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.actionButton, { backgroundColor: palette.colors.info }]}
            onPress={() => navigation.navigate('SellerOrderManagement', { storeId, isAdmin: false })}>
            <Ionicons name="receipt" size={20} color="white" /><Text style={styles.actionButtonText}>Orders</Text>
          </TouchableOpacity>
        </View>

        {/* Products List */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Products ({products.length})</Text>
          {products.length === 0 ? (
            <EmptyState icon="cube-outline" title="No products" subtitle="This store has no products yet" compact />
          ) : (
            products.slice(0, 6).map(item => (
              <TouchableOpacity key={item._id} style={styles.productCard} onPress={() => navigation.navigate('ProductDetail', { productId: item._id })}>
                {item.images?.[0] ? <Image source={{ uri: item.images[0] }} style={styles.productImage} contentFit="cover" /> : (
                  <View style={[styles.productImage, { justifyContent: 'center', alignItems: 'center' }]}>
                    <Ionicons name="cube-outline" size={24} color={palette.colors.textSecondary} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.productPrice}>{formatCurrency(item.price)}</Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </GlassPanel>

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  header: { margin: spacing.lg, overflow: 'hidden' },
  banner: { width: '100%', height: 160 },
  bannerPlaceholder: { width: '100%', height: 160, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center' },
  storeInfoContainer: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md },
  logo: { width: 60, height: 60, borderRadius: 30 },
  logoPlaceholder: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center' },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  storeName: { ...typography.h3, color: p.colors.text, flex: 1 },
  storeDescription: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: 2 },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  trustCount: { ...typography.bodySmall, color: p.colors.primary, fontWeight: fontWeight.semibold },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg },
  actionsSection: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  actionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.md, borderRadius: borderRadius.xl },
  actionButtonText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.bold },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: p.colors.text, marginBottom: spacing.md },
  productCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  productImage: { width: 50, height: 50, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.06)' },
  productName: { ...typography.bodySemibold, color: p.colors.text },
  productPrice: { ...typography.bodySmall, color: p.colors.primary, fontWeight: fontWeight.semibold },
});
