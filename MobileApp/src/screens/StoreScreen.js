/**
 * StoreScreen
 * Individual store page with products
 * 
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  SafeAreaView,
  RefreshControl,
  TouchableOpacity,
  Linking,
  Share,
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
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
} from '../styles/theme';

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
    if (!slug) {
      setIsLoading(false);
      return;
    }
    try {
      const res = await api.get(`/api/stores/${slug}`);
      setStore(res.data.store);
      setProducts(res.data.products || []);
    } catch (error) {
      console.error('Error fetching store:', error);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [slug]);

  useEffect(() => {
    if (slug) {
      fetchStore();
    }
  }, [slug, fetchStore]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStore();
  }, [fetchStore]);

  const handleShare = useCallback(async () => {
    if (!store) return;
    try {
      await Share.share({
        message: `Check out ${store.name} on Tortrose!`,
        title: store.name,
      });
    } catch (error) {
      console.error('Error sharing:', error);
    }
  }, [store]);

  const handleContact = useCallback(() => {
    if (store?.email) {
      Linking.openURL(`mailto:${store.email}`);
    }
  }, [store]);

  // All useCallback hooks must be called before any conditional returns
  const renderProduct = useCallback(({ item, index }) => (
    <View style={styles.productWrapper}>
      <ProductCard
        product={item}
        index={index}
        onPress={() => navigation.navigate('ProductDetail', { productId: item._id })}
      />
    </View>
  ), [navigation]);

  const renderEmptyProducts = useCallback(() => (
    <EmptyProducts onAdd={null} />
  ), []);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading store..." />
      </SafeAreaView>
    );
  }

  if (!store) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <Ionicons name="storefront-outline" size={64} color={colors.grayLight} />
          <Text style={styles.errorTitle}>Store not found</Text>
          <Text style={styles.errorSubtitle}>This store may have been removed</Text>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isVerified = store?.verification?.isVerified;

  const renderHeader = () => (
    <View style={styles.headerContainer}>
      {/* Banner */}
      <View style={styles.bannerContainer}>
        {store.banner && !bannerError ? (
          <Image
            source={{ uri: store.banner }}
            style={styles.banner}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={200}
            onError={() => setBannerError(true)}
          />
        ) : (
          <View style={styles.bannerPlaceholder}>
            <View style={styles.bannerGradient} />
          </View>
        )}
        <View style={styles.bannerOverlay} />
        
        {/* Share Button */}
        <TouchableOpacity
          style={styles.shareButton}
          onPress={handleShare}
          activeOpacity={0.8}
        >
          <Ionicons name="share-outline" size={22} color={colors.white} />
        </TouchableOpacity>
      </View>

      {/* Store Info Card */}
      <View style={styles.storeInfoCard}>
        {/* Logo */}
        <View style={styles.logoContainer}>
          {store.logo && !logoError ? (
            <Image
              source={{ uri: store.logo }}
              style={styles.storeLogo}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
              onError={() => setLogoError(true)}
            />
          ) : (
            <View style={[styles.storeLogo, styles.logoPlaceholder]}>
              <Ionicons name="storefront" size={36} color={colors.white} />
            </View>
          )}
        </View>

        {/* Name & Verified Badge */}
        <View style={styles.nameRow}>
          <Text style={styles.storeName} numberOfLines={2}>{store.name}</Text>
          {isVerified && <VerifiedBadge size="md" style={styles.verifiedBadge} />}
        </View>

        {/* Trust Count */}
        <View style={styles.trustCountRow}>
          <Ionicons name="heart" size={16} color={colors.heart} />
          <Text style={styles.trustCountText}>
            {store.trustCount || 0} {(store.trustCount || 0) === 1 ? 'truster' : 'trusters'}
          </Text>
        </View>

        {/* Description */}
        {store.description && (
          <Text style={styles.storeDescription} numberOfLines={3}>
            {store.description}
          </Text>
        )}

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <View style={[styles.statIcon, { backgroundColor: colors.primaryLighter }]}>
              <Ionicons name="cube-outline" size={18} color={colors.primary} />
            </View>
            <View>
              <Text style={styles.statValue}>{products.length}</Text>
              <Text style={styles.statLabel}>Products</Text>
            </View>
          </View>
          <View style={styles.statItem}>
            <View style={[styles.statIcon, { backgroundColor: colors.infoLighter }]}>
              <Ionicons name="eye-outline" size={18} color={colors.info} />
            </View>
            <View>
              <Text style={styles.statValue}>{store.views || 0}</Text>
              <Text style={styles.statLabel}>Views</Text>
            </View>
          </View>
          {isVerified && (
            <View style={styles.statItem}>
              <View style={[styles.statIcon, { backgroundColor: colors.successLighter }]}>
                <Ionicons name="shield-checkmark" size={18} color={colors.success} />
              </View>
              <View>
                <Text style={styles.statValue}>Verified</Text>
                <Text style={styles.statLabel}>Store</Text>
              </View>
            </View>
          )}
        </View>

        {/* Action Buttons */}
        <View style={styles.actionsRow}>
          {currentUser && (
            <View style={styles.trustButtonContainer}>
              <TrustButton
                storeId={store._id}
                storeName={store.name}
                initialTrustCount={store.trustCount || 0}
                initialIsTrusted={store.isTrusted || false}
              />
            </View>
          )}
          {store.email && (
            <TouchableOpacity
              style={styles.contactButton}
              onPress={handleContact}
              activeOpacity={0.8}
            >
              <Ionicons name="mail-outline" size={20} color={colors.primary} />
              <Text style={styles.contactButtonText}>Contact</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Products Section Header */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Products</Text>
        <Text style={styles.sectionCount}>{products.length} items</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={products}
        keyExtractor={(item) => item._id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader}
        renderItem={renderProduct}
        ListEmptyComponent={renderEmptyProducts}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
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
  // Error state
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
  },
  errorTitle: {
    ...typography.h2,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  errorSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.xl,
  },
  backButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
  },
  backButtonText: {
    ...typography.bodySemibold,
    color: colors.white,
  },
  // Header
  headerContainer: {
    marginBottom: spacing.md,
  },
  // Banner
  bannerContainer: {
    height: 160,
    position: 'relative',
  },
  banner: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: colors.primary,
  },
  bannerGradient: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  bannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  shareButton: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Store Info Card
  storeInfoCard: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.md,
    marginTop: -50,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.lg,
  },
  logoContainer: {
    alignItems: 'center',
    marginTop: -60,
    marginBottom: spacing.md,
  },
  storeLogo: {
    width: 90,
    height: 90,
    borderRadius: borderRadius.full,
    borderWidth: 4,
    borderColor: colors.white,
    backgroundColor: colors.lighter,
  },
  logoPlaceholder: {
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  storeName: {
    ...typography.h2,
    textAlign: 'center',
  },
  verifiedBadge: {
    marginLeft: spacing.sm,
  },
  trustCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  trustCountText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginLeft: spacing.xs,
  },
  storeDescription: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
    lineHeight: 22,
  },
  // Stats
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xl,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    marginBottom: spacing.md,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statValue: {
    ...typography.bodySemibold,
    fontSize: fontSize.md,
  },
  statLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  // Actions
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.md,
  },
  trustButtonContainer: {
    flex: 1,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: colors.white,
  },
  contactButtonText: {
    ...typography.bodySemibold,
    color: colors.primary,
  },
  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginTop: spacing.md,
  },
  sectionTitle: {
    ...typography.h3,
  },
  sectionCount: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  // Products List
  listContent: {
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
  row: {
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  productWrapper: {
    flex: 1,
    marginBottom: spacing.sm,
  },
});
