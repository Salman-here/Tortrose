/**
 * StoreVerificationScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl,
  ActivityIndicator, Alert, TextInput,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import VerifiedBadge from '../../components/VerifiedBadge';
import Loader from '../../components/common/Loader';
import EmptyState from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../../styles/theme';

export const filterStoresBySearch = (stores, searchQuery) => {
  if (!searchQuery?.trim()) return stores;
  const query = searchQuery.toLowerCase().trim();
  return stores.filter(store => (store.storeName || store.name || '').toLowerCase().includes(query));
};

export const getVerificationDisplayInfo = (store) => {
  const isVerified = store?.verification?.isVerified || false;
  return {
    isVerified,
    statusText: isVerified ? 'Verified' : 'Unverified',
    statusColor: isVerified ? colors.success : colors.error,
    verificationDate: store?.verification?.verifiedAt ? new Date(store.verification.verifiedAt).toLocaleDateString() : null,
  };
};

export default function StoreVerificationScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [processingStoreId, setProcessingStoreId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (currentUser?.role !== 'admin') { navigation.goBack(); return; }
    fetchStores();
  }, [currentUser]);

  const fetchStores = useCallback(async () => {
    try {
      const res = await api.get('/api/stores/admin/all');
      setStores(res.data.stores || res.data.data?.stores || []);
    } catch (e) {
      try { const res = await api.get('/api/stores'); setStores(res.data.stores || []); } catch { }
    } finally { setIsLoading(false); }
  }, []);

  const onRefresh = useCallback(async () => { setRefreshing(true); await fetchStores(); setRefreshing(false); }, [fetchStores]);

  const handleVerifyStore = async (storeId, storeName, currentStatus) => {
    const action = currentStatus ? 'unverify' : 'verify';
    Alert.alert(`${action.charAt(0).toUpperCase() + action.slice(1)} Store`, `${action} "${storeName}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: action.charAt(0).toUpperCase() + action.slice(1), style: currentStatus ? 'destructive' : 'default',
        onPress: async () => {
          setProcessingStoreId(storeId);
          try {
            await api.patch(`/api/stores/${storeId}/${action}`, {});
            setStores(prev => prev.map(s => s._id === storeId ? { ...s, verification: { ...s.verification, isVerified: action === 'verify', verifiedAt: action === 'verify' ? new Date().toISOString() : null } } : s));
            Toast.show({ type: 'success', text1: 'Success', text2: `Store ${action}ed` });
          } catch (e) { Toast.show({ type: 'error', text1: 'Error', text2: `Failed to ${action}` }); }
          finally { setProcessingStoreId(null); }
        }
      },
    ]);
  };

  const filteredStores = useMemo(() => {
    let result = stores;
    if (filter === 'verified') result = result.filter(s => s.verification?.isVerified);
    else if (filter === 'unverified') result = result.filter(s => !s.verification?.isVerified);
    return filterStoresBySearch(result, searchQuery);
  }, [stores, filter, searchQuery]);

  const verifiedCount = stores.filter(s => s.verification?.isVerified).length;

  const renderStoreCard = ({ item }) => {
    const info = getVerificationDisplayInfo(item);
    const isProcessing = processingStoreId === item._id;
    return (
      <GlassPanel variant="card" style={styles.storeCard}>
        <View style={styles.storeHeader}>
          {item.logo ? <Image source={{ uri: item.logo }} style={styles.storeLogo} contentFit="cover" /> : (
            <View style={styles.storeLogoPlaceholder}><Ionicons name="storefront" size={24} color={colors.textSecondary} /></View>
          )}
          <View style={styles.storeInfo}>
            <View style={styles.storeNameRow}>
              <Text style={styles.storeName} numberOfLines={1}>{item.storeName || item.name}</Text>
              {info.isVerified && <VerifiedBadge size="sm" />}
            </View>
            {item.owner && <Text style={styles.ownerText}>{item.owner.name || item.owner.email}</Text>}
          </View>
        </View>
        <View style={styles.storeFooter}>
          <View style={[styles.statusBadge, { backgroundColor: info.statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: info.statusColor }]}>{info.statusText}</Text>
          </View>
          <TouchableOpacity style={[styles.actionButton, info.isVerified ? styles.unverifyBtn : styles.verifyBtn, isProcessing && { opacity: 0.5 }]}
            onPress={() => handleVerifyStore(item._id, item.storeName || item.name, info.isVerified)} disabled={isProcessing}>
            {isProcessing ? <ActivityIndicator size="small" color="white" /> : (
              <><Ionicons name={info.isVerified ? 'close' : 'checkmark'} size={16} color="white" />
              <Text style={styles.actionButtonText}>{info.isVerified ? 'Unverify' : 'Verify'}</Text></>
            )}
          </TouchableOpacity>
        </View>
      </GlassPanel>
    );
  };

  if (isLoading) return <GlassBackground><Loader fullScreen /></GlassBackground>;

  return (
    <GlassBackground>
      <FlatList data={filteredStores} renderItem={renderStoreCard} keyExtractor={i => i._id}
        contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        ListHeaderComponent={
          <View>
            <GlassPanel variant="floating" style={styles.headerPanel}>
              <View style={styles.headerIcon}><Ionicons name="shield-checkmark-outline" size={24} color="white" /></View>
              <View>
                <Text style={styles.headerTitle}>Store Verification</Text>
                <Text style={styles.headerSubtitle}>{stores.length} stores · {verifiedCount} verified</Text>
              </View>
            </GlassPanel>
            <View style={styles.searchContainer}>
              <Ionicons name="search-outline" size={20} color={colors.textSecondary} />
              <TextInput style={styles.searchInput} placeholder="Search stores..." placeholderTextColor={colors.textSecondary} value={searchQuery} onChangeText={setSearchQuery} />
              {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><Ionicons name="close-circle" size={20} color={colors.textSecondary} /></TouchableOpacity>}
            </View>
            <View style={styles.filterTabs}>
              {[{ key: 'all', label: 'All' }, { key: 'verified', label: 'Verified' }, { key: 'unverified', label: 'Unverified' }].map(tab => (
                <TouchableOpacity key={tab.key} style={[styles.filterTab, filter === tab.key && styles.activeFilterTab]} onPress={() => setFilter(tab.key)}>
                  <Text style={[styles.filterTabText, filter === tab.key && styles.activeFilterTabText]}>{tab.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="storefront-outline" title="No stores found" subtitle="Try adjusting filters" />}
      />
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.md, paddingBottom: 100, flexGrow: 1 },
  headerPanel: { flexDirection: 'row', alignItems: 'center', margin: spacing.md, padding: spacing.lg },
  headerIcon: { width: 44, height: 44, borderRadius: borderRadius.lg, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  headerTitle: { ...typography.h3, color: colors.text },
  headerSubtitle: { ...typography.bodySmall, color: colors.textSecondary },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, marginHorizontal: spacing.md, marginBottom: spacing.md, height: 44, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, color: colors.text },
  filterTabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.md },
  filterTab: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: 'rgba(255,255,255,0.08)' },
  activeFilterTab: { backgroundColor: colors.primary },
  filterTabText: { ...typography.bodySmall, color: colors.textSecondary, fontWeight: fontWeight.medium },
  activeFilterTabText: { color: 'white' },
  storeCard: { padding: spacing.md, marginBottom: spacing.sm },
  storeHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  storeLogo: { width: 48, height: 48, borderRadius: 24, marginRight: spacing.md },
  storeLogoPlaceholder: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  storeInfo: { flex: 1 },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  storeName: { ...typography.bodySemibold, color: colors.text, flex: 1 },
  ownerText: { ...typography.bodySmall, color: colors.textSecondary },
  storeFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusBadge: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { ...typography.caption, fontWeight: fontWeight.semibold },
  actionButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg },
  verifyBtn: { backgroundColor: colors.success },
  unverifyBtn: { backgroundColor: colors.error },
  actionButtonText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.semibold },
});
