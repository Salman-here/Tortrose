/**
 * WishlistScreen
 * Displays user's saved wishlist items with modern design
 * 
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import React, { useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  RefreshControl,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
  cardStyles,
  buttonStyles,
} from '../styles/theme';
import Loader, { InlineLoader } from '../components/common/Loader';
import { EmptyWishlist, LoginRequired } from '../components/common/EmptyState';

export default function WishlistScreen({ navigation }) {
  const { currentUser } = useAuth();
  const {
    wishlistItems,
    fetchWishlist,
    handleDeleteFromWishlist,
    handleAddToCart,
    cartItems,
    isCartLoading,
    loadingProductId,
  } = useGlobal();
  const { formatPrice } = useCurrency();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const loadWishlist = useCallback(async () => {
    try {
      await fetchWishlist();
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [fetchWishlist]);

  useEffect(() => {
    if (currentUser) {
      loadWishlist();
    } else {
      setIsLoading(false);
    }
  }, [currentUser, loadWishlist]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadWishlist();
  }, [loadWishlist]);

  const handleRemoveFromWishlist = useCallback(async (productId) => {
    setRemovingId(productId);
    try {
      await handleDeleteFromWishlist(productId);
    } finally {
      setRemovingId(null);
    }
  }, [handleDeleteFromWishlist]);

  const handleAddToCartWithFeedback = useCallback(async (productId) => {
    try {
      await handleAddToCart(productId);
    } catch (error) {
      Alert.alert('Error', 'Failed to add item to cart');
    }
  }, [handleAddToCart]);

  const handleBrowseProducts = useCallback(() => {
    navigation.navigate('MainTabs', { screen: 'Home' });
  }, [navigation]);

  const handleLogin = useCallback(() => {
    navigation.navigate('Login');
  }, [navigation]);

  const handleProductPress = useCallback((productId) => {
    navigation.navigate('ProductDetail', { productId });
  }, [navigation]);

  const keyExtractor = useCallback((item) => item._id, []);

  // Guest View
  if (!currentUser) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.heroHeader}>
          <Text style={styles.heroTitle}>Wishlist</Text>
        </View>
        <LoginRequired
          onLogin={handleLogin}
          onBrowse={handleBrowseProducts}
        />
      </SafeAreaView>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.heroHeader}>
          <Text style={styles.heroTitle}>Wishlist</Text>
        </View>
        <View style={styles.loadingContainer}>
          <Loader size="large" />
        </View>
      </SafeAreaView>
    );
  }

  // Empty Wishlist
  if (!wishlistItems || wishlistItems.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.heroHeader}>
          <Text style={styles.heroTitle}>Wishlist</Text>
        </View>
        <EmptyWishlist onBrowse={handleBrowseProducts} />
      </SafeAreaView>
    );
  }

  const renderWishlistItem = ({ item, index }) => {
    const isInCart = cartItems?.cart?.some((cartItem) => cartItem?.product?._id === item._id);
    const isAddingToCart = isCartLoading && loadingProductId === item._id;
    const isRemoving = removingId === item._id;
    const isOutOfStock = item.stock === 0;

    return (
      <View style={[styles.wishlistItem, index === 0 && styles.firstItem]}>
        <TouchableOpacity
          style={styles.itemContent}
          onPress={() => handleProductPress(item._id)}
          activeOpacity={0.7}
        >
          {/* Product Image */}
          <View style={styles.imageContainer}>
            <Image
              source={{ uri: item.image || item.images?.[0]?.url }}
              style={styles.itemImage}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={200}
            />
            {isOutOfStock && (
              <View style={styles.outOfStockOverlay}>
                <Text style={styles.outOfStockText}>Out of Stock</Text>
              </View>
            )}
          </View>
          
          {/* Product Details */}
          <View style={styles.itemDetails}>
            {item.category && (
              <Text style={styles.itemCategory}>{item.category}</Text>
            )}
            <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
            
            {/* Price */}
            <View style={styles.priceRow}>
              <Text style={styles.itemPrice}>
                {formatPrice(item.discountedPrice || item.price)}
              </Text>
              {item.discountedPrice && item.discountedPrice < item.price && (
                <>
                  <Text style={styles.originalPrice}>{formatPrice(item.price)}</Text>
                  <View style={styles.discountBadge}>
                    <Text style={styles.discountText}>
                      -{Math.round((1 - item.discountedPrice / item.price) * 100)}%
                    </Text>
                  </View>
                </>
              )}
            </View>

            {/* Rating */}
            <View style={styles.ratingContainer}>
              {[...Array(5)].map((_, i) => {
                const rating = item.rating || 0;
                const filled = i < Math.floor(rating);
                const halfFilled = !filled && i < rating;
                return (
                  <Ionicons
                    key={i}
                    name={filled ? 'star' : halfFilled ? 'star-half' : 'star-outline'}
                    size={14}
                    color={colors.star}
                  />
                );
              })}
              <Text style={styles.ratingText}>
                ({item.rating?.toFixed(1) || '0.0'})
              </Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* Actions */}
        <View style={styles.actionsContainer}>
          {/* Remove from Wishlist */}
          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => handleRemoveFromWishlist(item._id)}
            disabled={isRemoving}
            activeOpacity={0.7}
          >
            {isRemoving ? (
              <InlineLoader size={22} color={colors.heart} />
            ) : (
              <Ionicons name="heart" size={22} color={colors.heart} />
            )}
            <Text style={styles.removeButtonText}>Remove</Text>
          </TouchableOpacity>

          {/* Add to Cart */}
          <TouchableOpacity
            style={[
              styles.addToCartButton,
              isInCart && styles.inCartButton,
              isOutOfStock && styles.disabledButton,
            ]}
            onPress={() => handleAddToCartWithFeedback(item._id)}
            disabled={isOutOfStock || isAddingToCart}
            activeOpacity={0.7}
          >
            {isAddingToCart ? (
              <InlineLoader size={16} color={isInCart ? colors.error : colors.white} />
            ) : isOutOfStock ? (
              <Text style={styles.disabledButtonText}>Out of Stock</Text>
            ) : isInCart ? (
              <>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={styles.inCartButtonText}>In Cart</Text>
              </>
            ) : (
              <>
                <Ionicons name="cart-outline" size={16} color={colors.white} />
                <Text style={styles.addToCartButtonText}>Add to Cart</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Hero Header */}
      <View style={styles.heroHeader}>
        <Text style={styles.heroTitle}>Wishlist</Text>
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>{wishlistItems.length} {wishlistItems.length === 1 ? 'item' : 'items'}</Text>
        </View>
      </View>

      {/* Wishlist Items */}
      <FlatList
        data={wishlistItems}
        keyExtractor={keyExtractor}
        renderItem={renderWishlistItem}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={true}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListFooterComponent={<View style={styles.listFooter} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroHeader: {
    backgroundColor: colors.primaryDark,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  heroBadge: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  heroBadgeText: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  listContent: {
    padding: spacing.md,
  },
  listFooter: {
    height: spacing.xxl,
  },
  wishlistItem: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    marginBottom: spacing.md,
    ...shadows.md,
    overflow: 'hidden',
  },
  firstItem: {
    marginTop: 0,
  },
  itemContent: {
    flexDirection: 'row',
    padding: spacing.md,
  },
  imageContainer: {
    position: 'relative',
  },
  itemImage: {
    width: 100,
    height: 100,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.light,
  },
  outOfStockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  outOfStockText: {
    ...typography.caption,
    color: colors.white,
    fontWeight: fontWeight.semibold,
  },
  itemDetails: {
    flex: 1,
    marginLeft: spacing.md,
  },
  itemCategory: {
    ...typography.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  itemName: {
    ...typography.bodySemibold,
    marginBottom: spacing.sm,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  itemPrice: {
    ...typography.price,
  },
  originalPrice: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  discountBadge: {
    backgroundColor: colors.errorLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  discountText: {
    ...typography.caption,
    color: colors.error,
    fontWeight: fontWeight.semibold,
  },
  ratingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ratingText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginLeft: spacing.xs,
  },
  actionsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    backgroundColor: colors.lighter,
  },
  removeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.sm,
    gap: spacing.xs,
  },
  removeButtonText: {
    ...typography.bodySmall,
    color: colors.heart,
    fontWeight: fontWeight.medium,
  },
  addToCartButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.lg,
    gap: spacing.xs,
    minWidth: 120,
    justifyContent: 'center',
  },
  inCartButton: {
    backgroundColor: colors.successLight,
  },
  disabledButton: {
    backgroundColor: colors.light,
  },
  addToCartButtonText: {
    color: colors.white,
    fontWeight: fontWeight.semibold,
    fontSize: fontSize.sm,
  },
  inCartButtonText: {
    color: colors.success,
    fontWeight: fontWeight.semibold,
    fontSize: fontSize.sm,
  },
  disabledButtonText: {
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
    fontSize: fontSize.sm,
  },
});
