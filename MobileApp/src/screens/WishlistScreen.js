/**
 * Favorites hub — saved products and trusted stores in one premium tab.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import ProductCard from '../components/ProductCard';
import TrustButton from '../components/TrustButton';
import { ProductCardSkeleton } from '../components/common/Skeleton';
import { EmptyWishlist } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { useTheme } from '../contexts/ThemeContext';
import { shareWishlistAsLink, shareWishlistAsPdf } from '../utils/shareWishlist';
import { borderRadius, fontSize, fontWeight, shadows, spacing } from '../styles/theme';

const FAVORITES_SHEEN = [
  'rgba(236,72,153,0.11)',
  'rgba(99,102,241,0.08)',
  'rgba(14,165,233,0.10)',
];

export default function WishlistScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currentUser } = useAuth();
  const { wishlistItems, fetchWishlist } = useGlobal();

  const [activeTab, setActiveTab] = useState('products');
  const [trustedStores, setTrustedStores] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errors, setErrors] = useState({ products: false, stores: false });

  useFocusEffect(
    useCallback(() => {
      const requestedTab = route?.params?.tab;
      if (requestedTab === 'products' || requestedTab === 'stores') {
        setActiveTab(requestedTab);
        navigation.setParams({ tab: undefined });
      }
    }, [navigation, route?.params?.tab]),
  );

  const loadFavorites = useCallback(async ({ silent = false } = {}) => {
    if (!currentUser) {
      setTrustedStores([]);
      setErrors({ products: false, stores: false });
      setIsLoading(false);
      setRefreshing(false);
      return;
    }

    if (!silent) setIsLoading(true);

    const [productsResult, storesResult] = await Promise.allSettled([
      fetchWishlist(),
      api.get('/api/stores/trusted'),
    ]);

    const productsOk = productsResult.status === 'fulfilled'
      && Array.isArray(productsResult.value);
    const storesPayload = storesResult.status === 'fulfilled'
      ? storesResult.value?.data?.data?.trustedStores
      : null;
    const storesOk = Array.isArray(storesPayload);

    if (storesOk) setTrustedStores(storesPayload);
    setErrors({ products: !productsOk, stores: !storesOk });
    setIsLoading(false);
    setRefreshing(false);
  }, [currentUser, fetchWishlist]);

  useEffect(() => {
    loadFavorites();
  // fetchWishlist is intentionally omitted because the context facade recreates
  // its function identity whenever wishlist state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFavorites({ silent: true });
  }, [loadFavorites]);

  const openStore = useCallback((store) => {
    navigation.navigate('Store', {
      storeSlug: store.storeSlug || store._id,
      storeName: store.storeName,
    });
  }, [navigation]);

  const onShareWishlist = useCallback(() => {
    if (!wishlistItems?.length) return;
    const userName = `${(currentUser?.name || 'My').split(' ')[0]}'s`;
    Alert.alert('Share favorites', 'How would you like to share your saved products?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Share as link', onPress: () => shareWishlistAsLink(wishlistItems, userName) },
      { text: 'Share as PDF', onPress: () => shareWishlistAsPdf(wishlistItems, userName) },
    ]);
  }, [currentUser?.name, wishlistItems]);

  const heroHeader = (
    <View>
      <GlassPanel variant="floating" style={styles.hero}>
        <LinearGradient
          colors={FAVORITES_SHEEN}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={styles.heroTop}>
          <LinearGradient colors={palette.gradients.cta} style={styles.heroIcon}>
            <Ionicons name="heart" size={23} color="#fff" />
          </LinearGradient>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>YOUR COLLECTION</Text>
            <Text style={styles.heroTitle}>Favorites</Text>
            <Text style={styles.heroSubtitle}>Saved products and the stores you trust, together.</Text>
          </View>
          {activeTab === 'products' && wishlistItems?.length > 0 && (
            <TouchableOpacity
              style={styles.shareButton}
              onPress={onShareWishlist}
              accessibilityRole="button"
              accessibilityLabel="Share saved products"
              activeOpacity={0.78}
            >
              <Ionicons name="share-outline" size={19} color={palette.colors.primary} />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryChip}>
            <Ionicons name="bag-handle-outline" size={14} color={palette.colors.heart} />
            <Text style={styles.summaryValue}>{wishlistItems?.length || 0}</Text>
            <Text style={styles.summaryLabel}>saved</Text>
          </View>
          <View style={styles.summaryChip}>
            <Ionicons name="shield-checkmark-outline" size={14} color={palette.colors.success} />
            <Text style={styles.summaryValue}>{trustedStores.length}</Text>
            <Text style={styles.summaryLabel}>trusted</Text>
          </View>
        </View>
      </GlassPanel>

      <View style={styles.segment}>
        {[
          {
            key: 'products',
            label: 'Products',
            icon: 'heart-outline',
            count: wishlistItems?.length || 0,
          },
          {
            key: 'stores',
            label: 'Trusted stores',
            icon: 'shield-checkmark-outline',
            count: trustedStores.length,
          },
        ].map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.segmentButton, selected && styles.segmentButtonActive]}
              onPress={() => setActiveTab(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              activeOpacity={0.82}
            >
              {selected && (
                <LinearGradient
                  colors={palette.gradients.cta}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
              )}
              <Ionicons name={tab.icon} size={16} color={selected ? '#fff' : palette.colors.primary} />
              <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>{tab.label}</Text>
              <View style={[styles.segmentCount, selected && styles.segmentCountActive]}>
                <Text style={[styles.segmentCountText, selected && styles.segmentCountTextActive]}>
                  {tab.count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  const renderProduct = useCallback(({ item, index }) => (
    <View style={styles.productCell}>
      <ProductCard
        product={item}
        index={index}
        onPress={() => navigation.navigate('ProductDetail', { productId: item._id })}
      />
    </View>
  ), [navigation, styles.productCell]);

  const renderStore = useCallback(({ item }) => {
    const logoUri = item.storeLogo || item.logo;
    const isVerified = item.isVerified || item.verification?.isVerified;
    return (
      <GlassPanel androidBlur={false} variant="card" style={styles.storeCard}>
        <LinearGradient
          colors={FAVORITES_SHEEN}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <TouchableOpacity
          style={styles.storeMain}
          onPress={() => openStore(item)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.storeName}`}
          activeOpacity={0.78}
        >
          {logoUri ? (
            <Image source={{ uri: logoUri }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" />
          ) : (
            <LinearGradient colors={palette.gradients.cta} style={[styles.storeLogo, styles.storeLogoFallback]}>
              <Ionicons name="storefront" size={23} color="#fff" />
            </LinearGradient>
          )}
          <View style={styles.storeCopy}>
            <View style={styles.storeNameRow}>
              <Text style={styles.storeName} numberOfLines={1}>{item.storeName}</Text>
              {isVerified && <Ionicons name="checkmark-circle" size={15} color={palette.colors.info} />}
            </View>
            <Text style={styles.storeDescription} numberOfLines={2}>
              {item.description || 'A store you chose to trust on Rozare.'}
            </Text>
            <View style={styles.storeMeta}>
              <Ionicons name="heart" size={12} color={palette.colors.heart} />
              <Text style={styles.storeMetaText}>{item.trustCount || 0} trusters</Text>
              {Number(item.ratingCount) > 0 && (
                <>
                  <View style={styles.metaDot} />
                  <Ionicons name="star" size={12} color={palette.colors.star} />
                  <Text style={styles.storeMetaText}>{Number(item.ratingAverage || 0).toFixed(1)}</Text>
                </>
              )}
            </View>
          </View>
          <View style={styles.storeArrow}>
            <Ionicons name="chevron-forward" size={17} color={palette.colors.primary} />
          </View>
        </TouchableOpacity>
        <View style={styles.storeFooter}>
          <View style={styles.trustedSince}>
            <Ionicons name="time-outline" size={13} color={palette.colors.textSecondary} />
            <Text style={styles.trustedSinceText}>
              {item.trustedAt
                ? `Trusted ${new Date(item.trustedAt).toLocaleDateString()}`
                : 'In your trusted stores'}
            </Text>
          </View>
          <TrustButton
            storeId={item._id}
            storeName={item.storeName}
            initialTrustCount={item.trustCount || 0}
            initialIsTrusted
            compact
            onTrustChange={(isTrusted) => {
              if (!isTrusted) {
                setTrustedStores((previous) => previous.filter((store) => store._id !== item._id));
              }
            }}
          />
        </View>
      </GlassPanel>
    );
  }, [openStore, palette, styles]);

  const renderLoading = () => (
    <View style={styles.skeletonWrap}>
      {[0, 1, 2, 3].map((index) => (
        <View
          key={index}
          style={activeTab === 'products' ? styles.productCell : styles.storeSkeleton}
        >
          <ProductCardSkeleton />
        </View>
      ))}
    </View>
  );

  const renderEmpty = () => {
    const failed = activeTab === 'products' ? errors.products : errors.stores;
    if (failed) {
      return (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Ionicons name="cloud-offline-outline" size={30} color={palette.colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>Couldn’t load your favorites</Text>
          <Text style={styles.emptyText}>Check your connection and try this collection again.</Text>
          <TouchableOpacity style={styles.emptyAction} onPress={() => loadFavorites()} activeOpacity={0.84}>
            <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
            <Ionicons name="refresh" size={16} color="#fff" />
            <Text style={styles.emptyActionText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (activeTab === 'products') {
      return <EmptyWishlist onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />;
    }

    return (
      <View style={styles.emptyState}>
        <View style={styles.emptyIcon}>
          <Ionicons name="shield-checkmark-outline" size={31} color={palette.colors.primary} />
        </View>
        <Text style={styles.emptyTitle}>No trusted stores yet</Text>
        <Text style={styles.emptyText}>
          Trust stores you love for quicker access, stronger signals and easier repeat shopping.
        </Text>
        <TouchableOpacity
          style={styles.emptyAction}
          onPress={() => navigation.navigate('MainTabs', { screen: 'Marketplace' })}
          activeOpacity={0.84}
        >
          <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
          <Ionicons name="storefront-outline" size={16} color="#fff" />
          <Text style={styles.emptyActionText}>Explore stores</Text>
        </TouchableOpacity>
      </View>
    );
  };

  if (!currentUser) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {heroHeader}
          <GlassPanel variant="card" style={styles.guestCard}>
            <LinearGradient colors={palette.gradients.cta} style={styles.guestIcon}>
              <Ionicons name="heart-outline" size={30} color="#fff" />
            </LinearGradient>
            <Text style={styles.guestEyebrow}>SYNC YOUR COLLECTION</Text>
            <Text style={styles.guestTitle}>Sign in to keep every favorite</Text>
            <Text style={styles.guestText}>
              Save products, trust stores and find your collection on every device.
            </Text>
            <TouchableOpacity
              style={styles.guestPrimary}
              onPress={() => navigation.navigate('Login')}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              activeOpacity={0.84}
            >
              <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
              <Ionicons name="person-outline" size={17} color="#fff" />
              <Text style={styles.guestPrimaryText}>Sign in</Text>
              <Ionicons name="arrow-forward" size={17} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.guestSecondary}
              onPress={() => navigation.navigate('MainTabs', { screen: 'Home' })}
              accessibilityRole="button"
              accessibilityLabel="Continue browsing"
              activeOpacity={0.78}
            >
              <Ionicons name="storefront-outline" size={16} color={palette.colors.primary} />
              <Text style={styles.guestSecondaryText}>Continue browsing</Text>
            </TouchableOpacity>
          </GlassPanel>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const data = activeTab === 'products' ? (wishlistItems || []) : trustedStores;
  const numColumns = activeTab === 'products' ? 2 : 1;

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <FlatList
          key={`${activeTab}-${numColumns}`}
          data={isLoading ? [] : data}
          numColumns={numColumns}
          keyExtractor={(item) => item._id}
          renderItem={activeTab === 'products' ? renderProduct : renderStore}
          columnWrapperStyle={numColumns === 2 ? styles.productRow : undefined}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={heroHeader}
          ListEmptyComponent={isLoading ? renderLoading : renderEmpty}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[palette.colors.primary]}
              tintColor={palette.colors.primary}
            />
          )}
          showsVerticalScrollIndicator={false}
          initialNumToRender={6}
          maxToRenderPerBatch={8}
          windowSize={5}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingBottom: 112 },
  hero: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    padding: spacing.lg,
    borderRadius: 28,
    ...shadows.lg,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center' },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  heroCopy: { flex: 1, minWidth: 0 },
  eyebrow: {
    color: p.colors.primary,
    fontSize: 9,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
  },
  heroTitle: {
    marginTop: 2,
    color: p.colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    marginTop: 3,
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 17,
  },
  shareButton: {
    width: 40,
    height: 40,
    marginLeft: spacing.sm,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  summaryRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  summaryChip: {
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  summaryValue: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  summaryLabel: { color: p.colors.textSecondary, fontSize: fontSize.xs },
  segment: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: 5,
    borderRadius: 22,
    backgroundColor: p.glass.bg,
    borderWidth: 1,
    borderColor: p.glass.border,
    overflow: 'hidden',
  },
  segmentButton: {
    minHeight: 46,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: 17,
    overflow: 'hidden',
  },
  segmentButtonActive: { ...shadows.sm },
  segmentText: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  segmentTextActive: { color: '#fff' },
  segmentCount: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
    backgroundColor: p.colors.primarySubtle,
  },
  segmentCountActive: { backgroundColor: 'rgba(255,255,255,0.22)' },
  segmentCountText: { color: p.colors.primary, fontSize: 10, fontWeight: fontWeight.bold },
  segmentCountTextActive: { color: '#fff' },
  guestCard: {
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxl,
    borderRadius: 28,
    alignItems: 'center',
  },
  guestIcon: {
    width: 66,
    height: 66,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    ...shadows.md,
  },
  guestEyebrow: {
    color: p.colors.primary,
    fontSize: 9,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.9,
  },
  guestTitle: {
    marginTop: spacing.sm,
    color: p.colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.extrabold,
    textAlign: 'center',
  },
  guestText: {
    maxWidth: 300,
    marginTop: spacing.sm,
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  guestPrimary: {
    width: '100%',
    minHeight: 50,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  guestPrimaryText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  guestSecondary: {
    minHeight: 44,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  guestSecondaryText: {
    color: p.colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  productRow: { paddingHorizontal: spacing.md },
  productCell: { width: '50%', paddingHorizontal: 2, paddingBottom: 4 },
  storeCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: 24,
  },
  storeMain: { flexDirection: 'row', alignItems: 'center' },
  storeLogo: {
    width: 58,
    height: 58,
    borderRadius: 18,
    marginRight: spacing.md,
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  storeLogoFallback: { alignItems: 'center', justifyContent: 'center' },
  storeCopy: { flex: 1, minWidth: 0 },
  storeNameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  storeName: {
    flexShrink: 1,
    color: p.colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  storeDescription: {
    marginTop: 3,
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 17,
  },
  storeMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7 },
  storeMetaText: { color: p.colors.textSecondary, fontSize: 10, fontWeight: fontWeight.medium },
  metaDot: { width: 3, height: 3, borderRadius: 2, marginHorizontal: 2, backgroundColor: p.colors.textLight },
  storeArrow: {
    width: 34,
    height: 34,
    marginLeft: spacing.sm,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  storeFooter: {
    minHeight: 48,
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: p.glass.borderSubtle,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  trustedSince: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  trustedSinceText: { flexShrink: 1, color: p.colors.textSecondary, fontSize: fontSize.xs },
  skeletonWrap: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.md },
  storeSkeleton: { width: '100%', marginBottom: spacing.md },
  emptyState: {
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xxxl,
    alignItems: 'center',
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    color: p.colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.extrabold,
    textAlign: 'center',
  },
  emptyText: {
    maxWidth: 300,
    marginTop: spacing.sm,
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  emptyAction: {
    minHeight: 46,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  emptyActionText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
});
