/**
 * StoresListingScreen — Liquid Glass Design
 * With filter sheet (sort + verified-only) for full feature parity with web.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, SafeAreaView, RefreshControl, Modal, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import StoreCard from '../components/common/StoreCard';
import { ProductCardSkeleton } from '../components/common/Skeleton';
import { EmptyStores, EmptySearch } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest', icon: 'time-outline' },
  { key: 'rating', label: 'Highest Rated', icon: 'star-outline' },
  { key: 'trusted', label: 'Most Trusted', icon: 'heart-outline' },
  { key: 'popular', label: 'Most Popular', icon: 'flame-outline' },
  { key: 'name', label: 'A → Z', icon: 'text-outline' },
];

export const filterStoresByQuery = (stores, query) => {
  if (!query || !query.trim()) return stores;
  const q = query.toLowerCase().trim();
  return stores.filter(s => s.storeName?.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q) || s.storeDescription?.toLowerCase().includes(q));
};

export const filterStores = (stores, { query, verifiedOnly, minTrust }) => {
  let out = filterStoresByQuery(stores, query);
  if (verifiedOnly) out = out.filter(s => s.isVerified || s.verification?.isVerified);
  if (minTrust > 0) out = out.filter(s => (s.trustCount || 0) >= minTrust);
  return out;
};

export default function StoresListingScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalStores, setTotalStores] = useState(0);
  const [storeCounts, setStoreCounts] = useState({ all: 0, brand: 0, store: 0 });
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [showFilters, setShowFilters] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [minTrust, setMinTrust] = useState(0);
  const [typeFilter, setTypeFilter] = useState('all'); // all | brand | store

  const STORES_PER_PAGE = 12; // matches website

  // Debounce search so we query the server like the website does
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchStores = useCallback(async (pageNum = 1, append = false) => {
    if (append) setLoadingMore(true);
    try {
      const params = new URLSearchParams({ sort: sortBy, page: String(pageNum), limit: String(STORES_PER_PAGE) });
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await api.get(`/api/stores/all?${params.toString()}`);
      const newStores = res.data.stores || [];
      if (append) {
        setStores(prev => {
          const seen = new Set(prev.map(s => s._id));
          return [...prev, ...newStores.filter(s => s?._id && !seen.has(s._id))];
        });
      } else {
        setStores(newStores);
      }
      setStoreCounts(res.data.counts || { all: 0, brand: 0, store: 0 });
      setTotalStores(res.data.pagination?.total || newStores.length);
      setTotalPages(Math.max(1, res.data.pagination?.pages || 1));
      setPage(pageNum);
    } catch (e) { console.error('Error fetching stores:', e); }
    finally { setIsLoading(false); setRefreshing(false); setLoadingMore(false); }
  }, [sortBy, typeFilter, debouncedSearch]);

  // Refetch from page 1 whenever server-side filters change
  useEffect(() => { fetchStores(1, false); }, [fetchStores]);

  const hasMore = page < totalPages;
  const loadMore = useCallback(() => {
    if (!loadingMore && !isLoading && hasMore) fetchStores(page + 1, true);
  }, [loadingMore, isLoading, hasMore, page, fetchStores]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchStores(1, false); }, [fetchStores]);
  const filteredStores = useMemo(() => {
    // Search + type are server-side now; keep the extra client-side filters
    return filterStores(stores, { query: '', verifiedOnly, minTrust });
  }, [stores, verifiedOnly, minTrust]);

  const counts = storeCounts;

  const activeFilterCount = (verifiedOnly ? 1 : 0) + (minTrust > 0 ? 1 : 0) + (sortBy !== 'newest' ? 1 : 0);

  const resetFilters = () => { setVerifiedOnly(false); setMinTrust(0); setSortBy('newest'); };

  if (isLoading) return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: spacing.sm, paddingTop: spacing.xl }}>
          {[0,1,2,3,4,5].map((i) => (
            <View key={i} style={{ width: '50%', padding: spacing.xs }}><ProductCardSkeleton /></View>
          ))}
        </View>
      </SafeAreaView>
    </GlassBackground>
  );

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
                <View style={{ flex: 1 }}>
                    <Text style={styles.heroTitle}>Marketplace</Text>
                    <Text style={styles.heroSubtitle}>Discover stores & brands worldwide</Text>
                  </View>
                  {currentUser && (
                    <TouchableOpacity style={styles.trustedButton} onPress={() => navigation.navigate('TrustedStores')} activeOpacity={0.8} accessibilityLabel="View trusted stores">
                      <Ionicons name="heart" size={15} color={palette.colors.heart} />
                      <Text style={styles.trustedButtonText}>Trusted</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {/* Type tabs */}
                <View style={styles.typeTabsRow}>
                  {[
                    { k: 'all', label: 'All', icon: 'grid-outline' },
                    { k: 'brand', label: 'Brands', icon: 'sparkles-outline' },
                    { k: 'store', label: 'Stores', icon: 'storefront-outline' },
                  ].map(t => {
                    const active = typeFilter === t.k;
                    return (
                      <TouchableOpacity key={t.k} style={[styles.typeTab, active && styles.typeTabActive]} onPress={() => setTypeFilter(t.k)} activeOpacity={0.85}>
                        <Ionicons name={t.icon} size={13} color={active ? '#fff' : palette.colors.primary} />
                        <Text style={[styles.typeTabText, active && styles.typeTabTextActive]}>{t.label}</Text>
                        <View style={[styles.typeTabCount, active && styles.typeTabCountActive]}>
                          <Text style={[styles.typeTabCountText, active && { color: '#fff' }]}>{counts[t.k]}</Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <View style={styles.searchRow}>
                  <View style={styles.searchBox}>
                    <Ionicons name="search" size={18} color={palette.colors.textSecondary} />
                    <TextInput style={styles.searchInput} placeholder="Search stores & brands..." placeholderTextColor={palette.colors.textLight} value={searchQuery} onChangeText={setSearchQuery} returnKeyType="search" />
                    {searchQuery.length > 0 && (
                      <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                        <Ionicons name="close-circle" size={18} color={palette.colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                  </View>
                  <TouchableOpacity
                    style={[styles.filterIconBtn, activeFilterCount > 0 && styles.filterIconBtnActive]}
                    onPress={() => setShowFilters(true)}
                    accessibilityLabel="Open filters"
                    activeOpacity={0.85}
                  >
                    <Ionicons name="options-outline" size={20} color={activeFilterCount > 0 ? '#fff' : palette.colors.primary} />
                    {activeFilterCount > 0 && (
                      <View style={styles.filterBadge}><Text style={styles.filterBadgeText}>{activeFilterCount}</Text></View>
                    )}
                  </TouchableOpacity>
                </View>
              </GlassPanel>

              {/* Active filter chips */}
              {(verifiedOnly || minTrust > 0 || sortBy !== 'newest') && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.activeChipsRow}>
                  {sortBy !== 'newest' && (
                    <TouchableOpacity style={styles.activeChip} onPress={() => setSortBy('newest')} activeOpacity={0.7}>
                      <Ionicons name={SORT_OPTIONS.find(o => o.key === sortBy)?.icon || 'swap-vertical'} size={12} color={palette.colors.primary} />
                      <Text style={styles.activeChipText}>{SORT_OPTIONS.find(o => o.key === sortBy)?.label}</Text>
                      <Ionicons name="close" size={12} color={palette.colors.primary} />
                    </TouchableOpacity>
                  )}
                  {verifiedOnly && (
                    <TouchableOpacity style={styles.activeChip} onPress={() => setVerifiedOnly(false)} activeOpacity={0.7}>
                      <Ionicons name="shield-checkmark" size={12} color={palette.colors.primary} />
                      <Text style={styles.activeChipText}>Verified Only</Text>
                      <Ionicons name="close" size={12} color={palette.colors.primary} />
                    </TouchableOpacity>
                  )}
                  {minTrust > 0 && (
                    <TouchableOpacity style={styles.activeChip} onPress={() => setMinTrust(0)} activeOpacity={0.7}>
                      <Ionicons name="heart" size={12} color={palette.colors.primary} />
                      <Text style={styles.activeChipText}>{minTrust}+ trusters</Text>
                      <Ionicons name="close" size={12} color={palette.colors.primary} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.clearAllChip} onPress={resetFilters} activeOpacity={0.7}>
                    <Text style={styles.clearAllText}>Clear all</Text>
                  </TouchableOpacity>
                </ScrollView>
              )}

              <View style={styles.resultsRow}>
                <Text style={styles.resultsText}>{searchQuery ? 'Found ' : ''}<Text style={styles.resultsCount}>{totalStores}</Text> {totalStores === 1 ? 'store' : 'stores'}{searchQuery ? '' : ' available'}</Text>
              </View>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={styles.cardWrapper}>
              <StoreCard store={{ _id: item._id, storeName: item.storeName, storeSlug: item.storeSlug, sellerType: item.sellerType || 'store', description: item.storeDescription || item.description, logo: item.storeLogo || item.logo, banner: item.storeBanner || item.banner, trustCount: item.trustCount || 0, verification: { isVerified: item.isVerified || item.verification?.isVerified }, productCount: item.productCount || 0, views: item.views || 0, ratingAverage: item.ratingAverage || 0, ratingCount: item.ratingCount || 0 }} index={index} showTrustButton={!!currentUser} showDescription={true} showStats={true} />
            </View>
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
          ListEmptyComponent={searchQuery ? <EmptySearch query={searchQuery} onClear={() => setSearchQuery('')} /> : <EmptyStores onRefresh={onRefresh} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footerLoading}>
                <Text style={styles.footerLoadingText}>Loading more stores...</Text>
              </View>
            ) : hasMore ? (
              <TouchableOpacity style={styles.loadMoreBtn} onPress={loadMore} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                <Text style={styles.loadMoreText}>Load More Stores</Text>
                <Ionicons name="chevron-down" size={16} color="#fff" />
              </TouchableOpacity>
            ) : null
          }
          showsVerticalScrollIndicator={false}
        />

        {/* Filter Sheet */}
        <Modal visible={showFilters} animationType="slide" transparent onRequestClose={() => setShowFilters(false)}>
          <View style={styles.sheetOverlay}>
            <TouchableOpacity style={{ flex: 1 }} onPress={() => setShowFilters(false)} activeOpacity={1} />
            <GlassPanel variant="strong" style={styles.sheet}>
              <View style={styles.sheetHandle} />
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>Filter & Sort</Text>
                <TouchableOpacity onPress={() => setShowFilters(false)} style={styles.sheetClose} accessibilityLabel="Close">
                  <Ionicons name="close" size={20} color={palette.colors.text} />
                </TouchableOpacity>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing.lg }}>
                {/* Sort */}
                <Text style={styles.sectionLabel}>Sort by</Text>
                <View style={styles.optionGrid}>
                  {SORT_OPTIONS.map((opt) => {
                    const active = sortBy === opt.key;
                    return (
                      <TouchableOpacity key={opt.key} style={[styles.optionTile, active && styles.optionTileActive]} onPress={() => setSortBy(opt.key)} activeOpacity={0.85}>
                        <Ionicons name={opt.icon} size={18} color={active ? '#fff' : palette.colors.primary} />
                        <Text style={[styles.optionTileText, active && styles.optionTileTextActive]}>{opt.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Trust threshold */}
                <Text style={styles.sectionLabel}>Trust threshold</Text>
                <View style={styles.presetRow}>
                  {[0, 5, 10, 50, 100].map((n) => {
                    const active = minTrust === n;
                    return (
                      <TouchableOpacity key={n} style={[styles.preset, active && styles.presetActive]} onPress={() => setMinTrust(n)} activeOpacity={0.85}>
                        <Text style={[styles.presetText, active && styles.presetTextActive]}>{n === 0 ? 'Any' : `${n}+`}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Verified toggle */}
                <TouchableOpacity style={styles.toggleRow} onPress={() => setVerifiedOnly(!verifiedOnly)} activeOpacity={0.85}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
                    <Ionicons name="shield-checkmark" size={18} color={palette.colors.info} />
                    <View>
                      <Text style={styles.toggleLabel}>Verified Stores Only</Text>
                      <Text style={styles.toggleSubLabel}>Show only verified merchants</Text>
                    </View>
                  </View>
                  <View style={[styles.switch, verifiedOnly && styles.switchActive]}>
                    <View style={[styles.switchKnob, verifiedOnly && styles.switchKnobActive]} />
                  </View>
                </TouchableOpacity>
              </ScrollView>

              {/* Footer */}
              <View style={styles.sheetFooter}>
                <TouchableOpacity style={styles.resetBtn} onPress={resetFilters} activeOpacity={0.85}>
                  <Text style={styles.resetBtnText}>Reset</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.applyBtn} onPress={() => setShowFilters(false)} activeOpacity={0.85}>
                  <Text style={styles.applyBtnText}>Show {filteredStores.length} stores</Text>
                </TouchableOpacity>
              </View>
            </GlassPanel>
          </View>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm },
  heroTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: 2 },
  heroSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  trustedButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(239,68,68,0.1)', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, gap: spacing.xs },
  trustedButtonText: { color: p.colors.heart, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchBox: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, height: 46, gap: spacing.sm, borderRadius: borderRadius.xl, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, fontSize: fontSize.md, color: p.colors.text },
  filterIconBtn: { width: 46, height: 46, borderRadius: borderRadius.xl, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, justifyContent: 'center', alignItems: 'center', position: 'relative' },
  filterIconBtnActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  filterBadge: { position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: p.colors.error, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  filterBadgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: '#fff' },
  activeChipsRow: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.xs, flexDirection: 'row' },
  activeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: borderRadius.full, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter, marginRight: spacing.xs },
  activeChipText: { fontSize: fontSize.xs, color: p.colors.primary, fontWeight: fontWeight.semibold },
  clearAllChip: { paddingHorizontal: spacing.md, paddingVertical: 6, justifyContent: 'center' },
  clearAllText: { fontSize: fontSize.xs, color: p.colors.error, fontWeight: fontWeight.semibold },
  resultsRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  resultsText: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  resultsCount: { fontWeight: fontWeight.bold, color: p.colors.text },
  listContent: { paddingBottom: 110, flexGrow: 1 },
  footerLoading: { paddingVertical: spacing.xl, alignItems: 'center' },
  footerLoadingText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  loadMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, marginHorizontal: spacing.lg, marginTop: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  loadMoreText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  row: { paddingHorizontal: spacing.sm, gap: spacing.sm },
  cardWrapper: { flex: 1, marginBottom: spacing.sm },
  typeTabsRow: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  typeTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  typeTabActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  typeTabText: { fontSize: fontSize.xs, color: p.colors.text, fontWeight: fontWeight.semibold },
  typeTabTextActive: { color: '#fff' },
  typeTabCount: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8, backgroundColor: p.colors.primarySubtle },
  typeTabCountActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  typeTabCountText: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.primary },

  // Filter sheet
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingTop: spacing.sm, paddingBottom: spacing.lg, maxHeight: '80%' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: p.glass.borderStrong, alignSelf: 'center', marginBottom: spacing.md },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  sheetTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  sheetClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  sectionLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary, letterSpacing: 1, textTransform: 'uppercase', marginTop: spacing.md, marginBottom: spacing.sm },
  optionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  optionTile: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, minWidth: '47%', flex: 1 },
  optionTileActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  optionTileText: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.semibold },
  optionTileTextActive: { color: '#fff' },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  preset: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  presetActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  presetText: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.semibold },
  presetTextActive: { color: '#fff' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md, marginTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  toggleLabel: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  toggleSubLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  switch: { width: 46, height: 26, borderRadius: 13, backgroundColor: p.glass.bgSubtle, padding: 2, justifyContent: 'center', borderWidth: 1, borderColor: p.glass.borderSubtle },
  switchActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  switchKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  switchKnobActive: { transform: [{ translateX: 20 }] },
  sheetFooter: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.md, marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  resetBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, justifyContent: 'center' },
  resetBtnText: { fontSize: fontSize.md, color: p.colors.text, fontWeight: fontWeight.semibold },
  applyBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  applyBtnText: { fontSize: fontSize.md, color: '#fff', fontWeight: fontWeight.bold },
});
