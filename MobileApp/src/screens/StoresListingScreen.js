/**
 * StoresListingScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, SafeAreaView, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import StoreCard from '../components/common/StoreCard';
import Loader from '../components/common/Loader';
import { EmptyStores, EmptySearch } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, fontWeight } from '../styles/theme';

export const filterStoresByQuery = (stores, query) => {
  if (!query || !query.trim()) return stores;
  const q = query.toLowerCase().trim();
  return stores.filter(s => s.storeName?.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q));
};

export default function StoresListingScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');

  useEffect(() => { fetchStores(); }, [sortBy]);

  const fetchStores = async () => {
    try { const res = await api.get(`/api/stores/all?sort=${sortBy}`); setStores(res.data.stores || []); }
    catch (e) { console.error('Error fetching stores:', e); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchStores(); }, [sortBy]);
  const filteredStores = filterStoresByQuery(stores, searchQuery);

  if (isLoading) return <GlassBackground><SafeAreaView style={styles.container}><Loader fullScreen message="Loading stores..." /></SafeAreaView></GlassBackground>;

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <FlatList
          data={filteredStores}
          keyExtractor={(item) => item._id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View>
              <GlassPanel variant="floating" style={styles.heroHeader}>
                <View style={styles.heroTitleRow}>
                  <View>
                    <Text style={styles.heroTitle}>Discover Stores</Text>
                    <Text style={styles.heroSubtitle}>Explore amazing sellers & products</Text>
                  </View>
                  {currentUser && (
                    <TouchableOpacity style={styles.trustedButton} onPress={() => navigation.navigate('TrustedStores')} activeOpacity={0.8}>
                      <Ionicons name="heart" size={15} color={colors.heart} />
                      <Text style={styles.trustedButtonText}>Trusted</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <GlassPanel variant="inner" style={styles.searchBox}>
                  <Ionicons name="search" size={18} color={colors.textSecondary} />
                  <TextInput style={styles.searchInput} placeholder="Search stores..." placeholderTextColor={colors.textLight} value={searchQuery} onChangeText={setSearchQuery} returnKeyType="search" />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                      <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
                    </TouchableOpacity>
                  )}
                </GlassPanel>
              </GlassPanel>
              <View style={styles.resultsRow}>
                <Text style={styles.resultsText}>{searchQuery ? 'Found ' : ''}<Text style={styles.resultsCount}>{filteredStores.length}</Text> {filteredStores.length === 1 ? 'store' : 'stores'}{searchQuery ? '' : ' available'}</Text>
              </View>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={styles.cardWrapper}>
              <StoreCard store={{ _id: item._id, storeName: item.storeName, storeSlug: item.storeSlug, description: item.storeDescription || item.description, logo: item.storeLogo || item.logo, banner: item.storeBanner || item.banner, trustCount: item.trustCount || 0, verification: { isVerified: item.isVerified }, productCount: item.productCount || 0, views: item.views || 0 }} index={index} showTrustButton={!!currentUser} showDescription={true} showStats={true} />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}
          ListEmptyComponent={searchQuery ? <EmptySearch query={searchQuery} onClear={() => setSearchQuery('')} /> : <EmptyStores onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, marginBottom: 2 },
  heroSubtitle: { fontSize: fontSize.sm, color: colors.textSecondary },
  trustedButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(239,68,68,0.1)', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, gap: spacing.xs },
  trustedButtonText: { color: colors.heart, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  searchBox: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 46, gap: spacing.sm },
  searchInput: { flex: 1, fontSize: fontSize.md, color: colors.text },
  resultsRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  resultsText: { fontSize: fontSize.sm, color: colors.textSecondary },
  resultsCount: { fontWeight: fontWeight.bold, color: colors.text },
  listContent: { paddingBottom: spacing.xxl, flexGrow: 1 },
  row: { paddingHorizontal: spacing.sm, gap: spacing.sm },
  cardWrapper: { flex: 1, marginBottom: spacing.sm },
});
