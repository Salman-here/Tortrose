/**
 * StoresListingScreen
 * Browse and search all stores
 * 
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import StoreCard from '../components/common/StoreCard';
import Loader from '../components/common/Loader';
import { EmptyStores, EmptySearch } from '../components/common/EmptyState';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
} from '../styles/theme';

/**
 * Filter stores by search query
 * Exported for property testing
 */
export const filterStoresByQuery = (stores, query) => {
  if (!query || !query.trim()) return stores;
  const normalizedQuery = query.toLowerCase().trim();
  return stores.filter(store =>
    store.storeName?.toLowerCase().includes(normalizedQuery) ||
    store.description?.toLowerCase().includes(normalizedQuery)
  );
};

export default function StoresListingScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [stores, setStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');

  useEffect(() => {
    fetchStores();
  }, [sortBy]);

  const fetchStores = async () => {
    try {
      const res = await api.get(`/api/stores/all?sort=${sortBy}`);
      setStores(res.data.stores || []);
    } catch (error) {
      console.error('Error fetching stores:', error);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStores();
  }, [sortBy]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const handleBrowseProducts = useCallback(() => {
    navigation.navigate('Home');
  }, [navigation]);

  const filteredStores = filterStoresByQuery(stores, searchQuery);

  const renderStoreCard = useCallback(({ item, index }) => (
    <View style={styles.cardWrapper}>
      <StoreCard
        store={{
          _id: item._id,
          storeName: item.storeName,
          storeSlug: item.storeSlug,
          description: item.storeDescription || item.description,
          logo: item.storeLogo || item.logo,
          banner: item.storeBanner || item.banner,
          trustCount: item.trustCount || 0,
          verification: { isVerified: item.isVerified },
          productCount: item.productCount || 0,
          views: item.views || 0,
        }}
        index={index}
        showTrustButton={!!currentUser}
        showDescription={true}
        showStats={true}
      />
    </View>
  ), [currentUser]);

  const renderHeader = useCallback(() => (
    <View>
      {/* Hero Header */}
      <View style={styles.heroHeader}>
        <View style={styles.heroTitleRow}>
          <View>
            <Text style={styles.heroTitle}>Discover Stores</Text>
            <Text style={styles.heroSubtitle}>Explore amazing sellers & products</Text>
          </View>
          {currentUser && (
            <TouchableOpacity
              style={styles.trustedButton}
              onPress={() => navigation.navigate('TrustedStores')}
              activeOpacity={0.8}
            >
              <Ionicons name="heart" size={15} color={colors.white} />
              <Text style={styles.trustedButtonText}>Trusted</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Search inside hero */}
        <View style={styles.searchBox}>
          <Ionicons name="search" size={18} color={colors.gray} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search stores..."
            placeholderTextColor={colors.grayLight}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={handleClearSearch} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close-circle" size={18} color={colors.gray} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Results Count */}
      <View style={styles.resultsRow}>
        <Text style={styles.resultsText}>
          {searchQuery ? `Found ` : ``}
          <Text style={styles.resultsCount}>{filteredStores.length}</Text>
          {` ${filteredStores.length === 1 ? 'store' : 'stores'}${searchQuery ? '' : ' available'}`}
        </Text>
      </View>
    </View>
  ), [currentUser, searchQuery, filteredStores.length, navigation, handleClearSearch]);

  const renderEmptyComponent = useCallback(() => {
    if (searchQuery) {
      return (
        <EmptySearch 
          query={searchQuery} 
          onClear={handleClearSearch} 
        />
      );
    }
    return (
      <EmptyStores onRefresh={onRefresh} />
    );
  }, [searchQuery, handleClearSearch, onRefresh]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading stores..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={filteredStores}
        keyExtractor={(item) => item._id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader}
        renderItem={renderStoreCard}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={renderEmptyComponent}
        showsVerticalScrollIndicator={false}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews={true}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Hero Header
  heroHeader: {
    backgroundColor: colors.primaryDark,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  heroTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
    marginBottom: 2,
  },
  heroSubtitle: {
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.75)',
  },
  trustedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
    gap: spacing.xs,
  },
  trustedButtonText: {
    color: colors.white,
    fontWeight: fontWeight.semibold,
    fontSize: fontSize.sm,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.md,
    height: 46,
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.text,
  },
  resultsRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  resultsText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  resultsCount: {
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  listContent: {
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  row: {
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  cardWrapper: {
    flex: 1,
    marginBottom: spacing.sm,
  },
});
