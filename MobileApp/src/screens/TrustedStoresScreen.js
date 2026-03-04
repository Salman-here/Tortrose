/**
 * TrustedStoresScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import TrustButton from '../components/TrustButton';
import VerifiedBadge from '../components/VerifiedBadge';
import Loader from '../components/common/Loader';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

export default function TrustedStoresScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [trustedStores, setTrustedStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTrustedStores = useCallback(async () => {
    if (!currentUser) { setIsLoading(false); return; }
    try {
      const response = await api.get('/api/stores/trusted');
      if (response.data.success) setTrustedStores(response.data.data.trustedStores);
    } catch { Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to load trusted stores' }); }
    finally { setIsLoading(false); }
  }, [currentUser]);

  useEffect(() => { fetchTrustedStores(); }, [fetchTrustedStores]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchTrustedStores(); setRefreshing(false); }, [fetchTrustedStores]);

  const handleTrustChange = (storeId, isTrusted) => { if (!isTrusted) setTrustedStores(prev => prev.filter(s => s._id !== storeId)); };

  if (!currentUser) {
    return (
      <GlassBackground><View style={styles.center}>
        <GlassPanel variant="panel" style={{ alignItems: 'center', padding: spacing.xxl }}>
          <Ionicons name="lock-closed" size={56} color="rgba(255,255,255,0.4)" />
          <Text style={styles.authTitle}>Login Required</Text>
          <Text style={styles.authSub}>Please login to view your trusted stores</Text>
          <TouchableOpacity style={styles.loginBtn} onPress={() => navigation.navigate('Login')}><Text style={{ color: '#fff', fontWeight: fontWeight.semibold }}>Login</Text></TouchableOpacity>
        </GlassPanel>
      </View></GlassBackground>
    );
  }

  if (isLoading) return <GlassBackground><View style={styles.center}><Loader size="large" /></View></GlassBackground>;

  const renderStoreCard = ({ item }) => {
    const isVerified = item.verification?.isVerified;
    return (
      <GlassPanel variant="card" style={styles.storeCard}>
        <TouchableOpacity style={styles.storeHeader} onPress={() => navigation.navigate('Store', { storeSlug: item.storeSlug })}>
          {item.logo ? <Image source={{ uri: item.logo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} /> :
            <View style={[styles.storeLogo, styles.logoPlaceholder]}><Ionicons name="storefront" size={22} color="#fff" /></View>}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={styles.storeName} numberOfLines={1}>{item.storeName}</Text>
              {isVerified && <VerifiedBadge size="sm" />}
            </View>
            <Text style={styles.storeDesc} numberOfLines={2}>{item.description || 'No description available'}</Text>
          </View>
        </TouchableOpacity>
        <View style={styles.storeFooter}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name="people" size={14} color={colors.textSecondary} />
            <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>{item.trustCount} trusters</Text>
          </View>
          <TrustButton storeId={item._id} storeName={item.storeName} initialTrustCount={item.trustCount} initialIsTrusted={true} compact onTrustChange={(isTrusted, count) => handleTrustChange(item._id, isTrusted, count)} />
        </View>
      </GlassPanel>
    );
  };

  return (
    <GlassBackground>
      {/* Header */}
      <GlassPanel variant="floating" style={styles.header}>
        <View style={styles.headerIcon}><Ionicons name="heart" size={20} color={colors.heart} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Trusted Stores</Text>
          <Text style={styles.headerSub}>{trustedStores.length} stores you trust</Text>
        </View>
      </GlassPanel>

      <FlatList
        data={trustedStores} renderItem={renderStoreCard} keyExtractor={(item) => item._id}
        contentContainerStyle={{ padding: spacing.md, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}
        ListEmptyComponent={() => (
          <View style={styles.center}>
            <Ionicons name="heart-outline" size={56} color="rgba(255,255,255,0.3)" />
            <Text style={styles.authTitle}>No Trusted Stores Yet</Text>
            <Text style={styles.authSub}>Start exploring stores and tap Trust to add them!</Text>
            <TouchableOpacity style={styles.loginBtn} onPress={() => navigation.navigate('Stores')}>
              <Ionicons name="storefront" size={18} color="#fff" /><Text style={{ color: '#fff', fontWeight: fontWeight.semibold }}>Explore Stores</Text>
            </TouchableOpacity>
          </View>
        )}
      />
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  authTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text, marginTop: spacing.lg },
  authSub: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.xl },
  loginBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: 14, borderRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.md, marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.md },
  headerIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: 'rgba(239,68,68,0.12)', justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  headerSub: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  storeCard: { padding: spacing.md, marginBottom: spacing.md },
  storeHeader: { flexDirection: 'row', marginBottom: spacing.md },
  storeLogo: { width: 52, height: 52, borderRadius: 16, marginRight: spacing.md, backgroundColor: glass.bgSubtle },
  logoPlaceholder: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  storeName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, flex: 1 },
  storeDesc: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  storeFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: glass.borderSubtle },
});
