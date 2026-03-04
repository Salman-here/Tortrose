/**
 * WishlistScreen — Liquid Glass Design
 */

import React, { useEffect, useCallback, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, SafeAreaView, RefreshControl, Alert } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { colors, spacing, fontSize, borderRadius, fontWeight } from '../styles/theme';
import Loader, { InlineLoader } from '../components/common/Loader';
import { EmptyWishlist, LoginRequired } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';

export default function WishlistScreen({ navigation }) {
  const { currentUser } = useAuth();
  const { wishlistItems, fetchWishlist, handleDeleteFromWishlist, handleAddToCart, cartItems, isCartLoading, loadingProductId } = useGlobal();
  const { formatPrice } = useCurrency();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const loadWishlist = useCallback(async () => {
    try { await fetchWishlist(); } finally { setIsLoading(false); setRefreshing(false); }
  }, [fetchWishlist]);

  useEffect(() => { if (currentUser) loadWishlist(); else setIsLoading(false); }, [currentUser, loadWishlist]);

  const heroHeader = (
    <GlassPanel variant="floating" style={styles.heroHeader}>
      <Text style={styles.heroTitle}>Wishlist</Text>
      {wishlistItems?.length > 0 && (
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>{wishlistItems.length} {wishlistItems.length === 1 ? 'item' : 'items'}</Text>
        </View>
      )}
    </GlassPanel>
  );

  if (!currentUser) return <GlassBackground><SafeAreaView style={styles.container}>{heroHeader}<LoginRequired onLogin={() => navigation.navigate('Login')} onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} /></SafeAreaView></GlassBackground>;
  if (isLoading) return <GlassBackground><SafeAreaView style={styles.container}>{heroHeader}<View style={styles.loadingContainer}><Loader size="large" /></View></SafeAreaView></GlassBackground>;
  if (!wishlistItems || wishlistItems.length === 0) return <GlassBackground><SafeAreaView style={styles.container}>{heroHeader}<EmptyWishlist onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} /></SafeAreaView></GlassBackground>;

  const renderWishlistItem = ({ item }) => {
    const isInCart = cartItems?.cart?.some((c) => c?.product?._id === item._id);
    const isAddingToCart = isCartLoading && loadingProductId === item._id;
    const isRemoving = removingId === item._id;
    const isOutOfStock = item.stock === 0;

    return (
      <GlassPanel variant="card" style={styles.wishlistItem}>
        <TouchableOpacity style={styles.itemContent} onPress={() => navigation.navigate('ProductDetail', { productId: item._id })} activeOpacity={0.7}>
          <Image source={{ uri: item.image || item.images?.[0]?.url }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={200} />
          <View style={styles.itemDetails}>
            {item.category && <Text style={styles.itemCategory}>{item.category}</Text>}
            <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
            <View style={styles.priceRow}>
              <Text style={styles.itemPrice}>{formatPrice(item.discountedPrice || item.price)}</Text>
              {item.discountedPrice && item.discountedPrice < item.price && (
                <Text style={styles.originalPrice}>{formatPrice(item.price)}</Text>
              )}
            </View>
          </View>
        </TouchableOpacity>
        <View style={styles.actionsContainer}>
          <TouchableOpacity style={styles.removeButton} onPress={async () => { setRemovingId(item._id); try { await handleDeleteFromWishlist(item._id); } finally { setRemovingId(null); } }} disabled={isRemoving}>
            {isRemoving ? <InlineLoader size={22} color={colors.heart} /> : <Ionicons name="heart" size={22} color={colors.heart} />}
            <Text style={styles.removeButtonText}>Remove</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.addToCartButton, isInCart && styles.inCartButton, isOutOfStock && styles.disabledButton]}
            onPress={() => handleAddToCart(item._id)}
            disabled={isOutOfStock || isAddingToCart}
          >
            {isAddingToCart ? <InlineLoader size={16} color={colors.white} /> : isOutOfStock ? <Text style={styles.disabledButtonText}>Out of Stock</Text> : isInCart ? <><Ionicons name="checkmark-circle" size={16} color={colors.success} /><Text style={styles.inCartButtonText}>In Cart</Text></> : <><Ionicons name="cart-outline" size={16} color={colors.white} /><Text style={styles.addToCartButtonText}>Add to Cart</Text></>}
          </TouchableOpacity>
        </View>
      </GlassPanel>
    );
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <FlatList
          data={wishlistItems}
          keyExtractor={(item) => item._id}
          renderItem={renderWishlistItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={heroHeader}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadWishlist(); }} colors={[colors.primary]} tintColor={colors.primary} />}
          ListFooterComponent={<View style={{ height: spacing.xxl }} />}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  heroHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  heroBadge: { backgroundColor: 'rgba(99,102,241,0.15)', borderRadius: borderRadius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  heroBadgeText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  listContent: { padding: spacing.md },
  wishlistItem: { marginBottom: spacing.md, overflow: 'hidden' },
  itemContent: { flexDirection: 'row', padding: spacing.md },
  itemImage: { width: 100, height: 100, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.1)' },
  itemDetails: { flex: 1, marginLeft: spacing.md },
  itemCategory: { fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.xs },
  itemName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  itemPrice: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.primary },
  originalPrice: { fontSize: fontSize.sm, color: colors.textSecondary, textDecorationLine: 'line-through' },
  actionsContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)' },
  removeButton: { flexDirection: 'row', alignItems: 'center', padding: spacing.sm, gap: spacing.xs },
  removeButtonText: { fontSize: fontSize.sm, color: colors.heart, fontWeight: fontWeight.medium },
  addToCartButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: borderRadius.lg, gap: spacing.xs, minWidth: 120, justifyContent: 'center' },
  inCartButton: { backgroundColor: 'rgba(16,185,129,0.15)' },
  disabledButton: { backgroundColor: 'rgba(255,255,255,0.08)' },
  addToCartButtonText: { color: colors.white, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  inCartButtonText: { color: colors.success, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  disabledButtonText: { color: colors.textSecondary, fontWeight: fontWeight.medium, fontSize: fontSize.sm },
});
