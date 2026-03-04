/**
 * StoreOverviewScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
  FlatList, Alert, ActivityIndicator,
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
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../../styles/theme';

export const formatCurrency = (amount, currency = 'USD') => {
  if (typeof amount !== 'number' || isNaN(amount)) return '$0.00';
  return `$${amount.toFixed(2)}`;
};

export const getOrderStatusInfo = (status) => {
  const map = {
    pending: { color: colors.warning, label: 'Pending' },
    processing: { color: colors.info, label: 'Processing' },
    shipped: { color: colors.primary, label: 'Shipped' },
    delivered: { color: colors.success, label: 'Delivered' },
    cancelled: { color: colors.error, label: 'Cancelled' },
  };
  return map[status?.toLowerCase()] || map.pending;
};

export default function StoreOverviewScreen({ route, navigation }) {
  const { storeId, isAdmin } = route.params || {};
  const { currentUser } = useAuth();
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState({ totalProducts: 0, totalOrders: 0, totalRevenue: 0, pendingOrders: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const fetchStoreData = useCallback(async () => {
    if (!storeId) { setIsLoading(false); return; }
    try {
      const storeRes = await api.get(`/api/stores/${storeId}`);
      const storeData = storeRes.data.store || storeRes.data;
      setStore(storeData);

      try { const prodRes = await api.get(`/api/products/get-products?store=${storeId}`); setProducts(prodRes.data.products || prodRes.data || []); } catch { setProducts([]); }

      if (isAdmin && currentUser?.role === 'admin') {
        try {
          const orderRes = await api.get(`/api/order/store/${storeId}`);
          const ordersData = orderRes.data.orders || orderRes.data || [];
          setOrders(ordersData);
          const totalRevenue = ordersData.reduce((sum, o) => o.status !== 'cancelled' ? sum + (o.totalPrice || o.orderSummary?.totalAmount || 0) : sum, 0);
          setStats(p => ({ ...p, totalOrders: ordersData.length, totalRevenue, pendingOrders: ordersData.filter(o => o.status === 'pending').length }));
        } catch { setOrders([]); }
      }
    } catch (e) { Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to load store' }); }
    finally { setIsLoading(false); }
  }, [storeId, isAdmin, currentUser]);

  useEffect(() => { fetchStoreData(); }, [fetchStoreData]);
  useEffect(() => { setStats(p => ({ ...p, totalProducts: products.length })); }, [products]);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchStoreData(); setRefreshing(false); }, [fetchStoreData]);

  const handleVerifyStore = async () => {
    if (!store) return;
    const isVerified = store.verification?.isVerified;
    const action = isVerified ? 'unverify' : 'verify';
    Alert.alert(`${action.charAt(0).toUpperCase() + action.slice(1)} Store`, `${action} "${store.storeName || store.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: action.charAt(0).toUpperCase() + action.slice(1), style: isVerified ? 'destructive' : 'default',
        onPress: async () => {
          setVerifying(true);
          try {
            await api.patch(`/api/stores/${storeId}/${action}`, {});
            setStore(p => ({ ...p, verification: { ...p.verification, isVerified: !isVerified } }));
            Toast.show({ type: 'success', text1: 'Success', text2: `Store ${action}ed` });
          } catch (e) { Toast.show({ type: 'error', text1: 'Error', text2: `Failed to ${action}` }); }
          finally { setVerifying(false); }
        }
      },
    ]);
  };

  if (isLoading) return <GlassBackground><Loader fullScreen /></GlassBackground>;
  if (!store) return <GlassBackground><EmptyState icon="storefront-outline" title="Store Not Found" actionLabel="Go Back" onAction={() => navigation.goBack()} /></GlassBackground>;

  const isVerified = store.verification?.isVerified;

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        {/* Store Header */}
        <GlassPanel variant="strong" style={styles.header}>
          {store.banner ? <Image source={{ uri: store.banner }} style={styles.banner} contentFit="cover" /> : (
            <View style={styles.bannerPlaceholder}><Ionicons name="image-outline" size={48} color={colors.textSecondary} /></View>
          )}
          <View style={styles.storeInfoContainer}>
            {store.logo ? <Image source={{ uri: store.logo }} style={styles.logo} contentFit="cover" /> : (
              <View style={styles.logoPlaceholder}><Ionicons name="storefront" size={32} color={colors.primary} /></View>
            )}
            <View style={{ flex: 1 }}>
              <View style={styles.storeNameRow}>
                <Text style={styles.storeName}>{store.storeName || store.name}</Text>
                {isVerified && <VerifiedBadge size="md" />}
              </View>
              {store.description && <Text style={styles.storeDescription} numberOfLines={2}>{store.description}</Text>}
              <View style={styles.trustRow}>
                <Ionicons name="people" size={16} color={colors.primary} />
                <Text style={styles.trustCount}>{store.trustCount || 0} trusters</Text>
              </View>
            </View>
          </View>
        </GlassPanel>

        {/* Stats */}
        {isAdmin && (
          <View style={styles.statsGrid}>
            <StatCard title="Products" value={stats.totalProducts} icon="cube-outline" iconColor={colors.primary} iconBgColor="rgba(99,102,241,0.12)" />
            <StatCard title="Orders" value={stats.totalOrders} icon="receipt-outline" iconColor={colors.info} iconBgColor="rgba(14,165,233,0.12)" />
            <StatCard title="Revenue" value={formatCurrency(stats.totalRevenue)} icon="cash-outline" iconColor={colors.success} iconBgColor="rgba(16,185,129,0.12)" />
            <StatCard title="Pending" value={stats.pendingOrders} icon="time-outline" iconColor={colors.warning} iconBgColor="rgba(245,158,11,0.12)" />
          </View>
        )}

        {/* Quick Actions */}
        {isAdmin && (
          <View style={styles.actionsSection}>
            <TouchableOpacity style={[styles.actionButton, isVerified ? styles.unverifyAction : styles.verifyAction, verifying && { opacity: 0.5 }]}
              onPress={handleVerifyStore} disabled={verifying}>
              {verifying ? <ActivityIndicator size="small" color="white" /> : (
                <><Ionicons name={isVerified ? 'close-circle' : 'checkmark-circle'} size={20} color="white" />
                <Text style={styles.actionButtonText}>{isVerified ? 'Unverify' : 'Verify'}</Text></>
              )}
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, { backgroundColor: colors.primary }]}
              onPress={() => navigation.navigate('ProductManagement', { storeId, isAdmin: true })}>
              <Ionicons name="cube" size={20} color="white" /><Text style={styles.actionButtonText}>Products</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.actionButton, { backgroundColor: colors.info }]}
              onPress={() => navigation.navigate('OrderManagement', { storeId, isAdmin: true })}>
              <Ionicons name="receipt" size={20} color="white" /><Text style={styles.actionButtonText}>Orders</Text>
            </TouchableOpacity>
          </View>
        )}

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
                    <Ionicons name="cube-outline" size={24} color={colors.textSecondary} />
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

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  header: { margin: spacing.lg, overflow: 'hidden' },
  banner: { width: '100%', height: 160 },
  bannerPlaceholder: { width: '100%', height: 160, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center' },
  storeInfoContainer: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md },
  logo: { width: 60, height: 60, borderRadius: 30 },
  logoPlaceholder: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center' },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  storeName: { ...typography.h3, color: colors.text, flex: 1 },
  storeDescription: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2 },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  trustCount: { ...typography.bodySmall, color: colors.primary, fontWeight: fontWeight.semibold },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg },
  actionsSection: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  actionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.md, borderRadius: borderRadius.xl },
  verifyAction: { backgroundColor: colors.success },
  unverifyAction: { backgroundColor: colors.error },
  actionButtonText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.bold },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: colors.text, marginBottom: spacing.md },
  productCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  productImage: { width: 50, height: 50, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.06)' },
  productName: { ...typography.bodySemibold, color: colors.text },
  productPrice: { ...typography.bodySmall, color: colors.primary, fontWeight: fontWeight.semibold },
});
