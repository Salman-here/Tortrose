/**
 * Enhanced ProductCard Component
 * Modern product card with animations, badges, and quick actions
 * 
 * Requirements: 6.4, 6.5, 7.7
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useNavigation } from '@react-navigation/native';
import { 
  colors, 
  spacing, 
  fontSize, 
  borderRadius, 
  shadows, 
  fontWeight,
  typography,
} from '../styles/theme';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - spacing.lg * 2 - spacing.sm) / 2;

// Shimmer placeholder component
const ShimmerPlaceholder = ({ style }) => {
  const shimmerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmerAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(shimmerAnim, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  const opacity = shimmerAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  return (
    <Animated.View style={[styles.shimmer, style, { opacity }]}>
      <View style={styles.shimmerInner} />
    </Animated.View>
  );
};

function ProductCard({
  product,
  index = 0,
  onPress,
  compact = false,
}) {
  const navigation = useNavigation();
  const { currentUser } = useAuth();
  const { 
    wishlistItems, 
    handleAddToWishlist, 
    handleDeleteFromWishlist, 
    cartItems, 
    handleAddToCart, 
    isCartLoading, 
    loadingProductId 
  } = useGlobal();
  const { formatPrice } = useCurrency();
  
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  
  // Animation values
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const heartScale = useRef(new Animated.Value(1)).current;

  // Staggered entrance animation
  useEffect(() => {
    const delay = index * 50; // 50ms stagger between cards
    const timeout = setTimeout(() => {
      Animated.parallel([
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    }, delay);

    return () => clearTimeout(timeout);
  }, [index]);

  if (!product) return null;

  const { 
    _id, 
    name, 
    image, 
    images, 
    category, 
    price, 
    discountedPrice, 
    stock, 
    rating, 
    numReviews,
    isFeatured, 
    brand,
  } = product;

  const isInWishlist = wishlistItems?.some((item) => item?._id === _id);
  const isInCart = cartItems?.cart?.some((item) => item?.product?._id === _id);
  const isOutOfStock = stock === 0;

  const displayPrice = discountedPrice || price;
  const originalDisplayPrice = discountedPrice ? price : null;
  const discountPercentage = originalDisplayPrice && displayPrice < originalDisplayPrice 
    ? Math.round(((originalDisplayPrice - displayPrice) / originalDisplayPrice) * 100) 
    : 0;

  // Handlers
  const handleWishlistToggle = () => {
    if (!currentUser) {
      navigation.navigate('Login');
      return;
    }
    
    // Heart animation
    Animated.sequence([
      Animated.timing(heartScale, {
        toValue: 1.3,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(heartScale, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
    ]).start();

    isInWishlist ? handleDeleteFromWishlist(_id) : handleAddToWishlist(_id);
  };

  const handleAddToCartClick = () => {
    if (!currentUser) {
      navigation.navigate('Login');
      return;
    }
    handleAddToCart(_id);
  };

  const imageSource = images?.[0]?.url || image;
  const isLoading = isCartLoading && loadingProductId === _id;

  // Render rating stars
  const renderStars = () => {
    const stars = [];
    const fullStars = Math.floor(rating || 0);
    const hasHalfStar = (rating || 0) % 1 >= 0.5;

    for (let i = 0; i < 5; i++) {
      if (i < fullStars) {
        stars.push(
          <Ionicons key={i} name="star" size={12} color={colors.star} />
        );
      } else if (i === fullStars && hasHalfStar) {
        stars.push(
          <Ionicons key={i} name="star-half" size={12} color={colors.star} />
        );
      } else {
        stars.push(
          <Ionicons key={i} name="star-outline" size={12} color={colors.star} />
        );
      }
    }
    return stars;
  };

  return (
    <Animated.View
      style={[
        styles.animatedContainer,
        {
          transform: [{ scale: scaleAnim }],
          opacity: opacityAnim,
        },
      ]}
    >
      <TouchableOpacity 
        style={[styles.container, compact && styles.containerCompact]} 
        onPress={onPress} 
        activeOpacity={0.9}
        disabled={isOutOfStock}
      >
        {/* Badges */}
        <View style={styles.badgesContainer}>
          {isFeatured && (
            <View style={styles.featuredBadge}>
              <Ionicons name="flash" size={10} color={colors.white} />
              <Text style={styles.badgeText}>Featured</Text>
            </View>
          )}
          {discountPercentage > 0 && (
            <View style={styles.discountBadge}>
              <Text style={styles.badgeText}>-{discountPercentage}%</Text>
            </View>
          )}
          {isOutOfStock && (
            <View style={styles.outOfStockBadge}>
              <Text style={styles.badgeText}>Sold Out</Text>
            </View>
          )}
        </View>

        {/* Quick Actions */}
        <View style={styles.actionsContainer}>
          <Animated.View style={{ transform: [{ scale: heartScale }] }}>
            <TouchableOpacity 
              style={[
                styles.actionButton, 
                isInWishlist && styles.actionButtonActive
              ]} 
              onPress={handleWishlistToggle}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons 
                name={isInWishlist ? 'heart' : 'heart-outline'} 
                size={18} 
                color={isInWishlist ? colors.heart : colors.gray} 
              />
            </TouchableOpacity>
          </Animated.View>
          <TouchableOpacity 
            style={[
              styles.actionButton, 
              isInCart && styles.actionButtonActiveCart
            ]} 
            onPress={handleAddToCartClick} 
            disabled={isOutOfStock}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons 
              name={isInCart ? 'cart' : 'cart-outline'} 
              size={18} 
              color={isInCart ? colors.primary : colors.gray} 
            />
          </TouchableOpacity>
        </View>

        {/* Image */}
        <View style={styles.imageContainer}>
          {imageLoading && !imageError && (
            <ShimmerPlaceholder style={StyleSheet.absoluteFill} />
          )}
          {imageError ? (
            <View style={styles.imagePlaceholder}>
              <Ionicons name="image-outline" size={40} color={colors.grayLight} />
            </View>
          ) : (
            <Image
              source={{ uri: imageSource }}
              style={[styles.image, imageLoading && styles.imageHidden]}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={200}
              onLoad={() => setImageLoading(false)}
              onError={() => {
                setImageLoading(false);
                setImageError(true);
              }}
            />
          )}
          {isOutOfStock && (
            <View style={styles.outOfStockOverlay}>
              <Text style={styles.outOfStockText}>Out of Stock</Text>
            </View>
          )}
        </View>

        {/* Details */}
        <View style={styles.detailsContainer}>
          {/* Category */}
          <Text style={styles.category} numberOfLines={1}>
            {category}
          </Text>

          {/* Name */}
          <Text style={styles.name} numberOfLines={2}>
            {name}
          </Text>

          {/* Rating */}
          <View style={styles.ratingContainer}>
            <View style={styles.stars}>
              {renderStars()}
            </View>
            <Text style={styles.ratingText}>
              ({rating?.toFixed(1) || '0.0'})
            </Text>
            {numReviews > 0 && (
              <Text style={styles.reviewCount}>
                {numReviews} {numReviews === 1 ? 'review' : 'reviews'}
              </Text>
            )}
          </View>

          {/* Price */}
          <View style={styles.priceContainer}>
            {originalDisplayPrice ? (
              <>
                <Text style={styles.price}>{formatPrice(displayPrice)}</Text>
                <Text style={styles.originalPrice}>{formatPrice(originalDisplayPrice)}</Text>
              </>
            ) : (
              <Text style={styles.price}>{formatPrice(displayPrice)}</Text>
            )}
          </View>

          {/* Add to Cart Button */}
          <TouchableOpacity 
            style={[
              styles.addToCartButton, 
              isOutOfStock && styles.addToCartButtonDisabled, 
              isInCart && styles.removeFromCartButton
            ]} 
            onPress={handleAddToCartClick} 
            disabled={isOutOfStock || isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator 
                size="small" 
                color={isInCart ? colors.error : colors.white} 
              />
            ) : isOutOfStock ? (
              <Text style={styles.addToCartButtonTextDisabled}>Out of Stock</Text>
            ) : isInCart ? (
              <View style={styles.buttonContent}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={styles.inCartButtonText}>In Cart</Text>
              </View>
            ) : (
              <View style={styles.buttonContent}>
                <Ionicons name="cart-outline" size={16} color={colors.white} />
                <Text style={styles.addToCartButtonText}>Add to Cart</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// Compact product card for horizontal lists
export function CompactProductCard({ product, onPress }) {
  const { formatPrice } = useCurrency();
  const [imageLoading, setImageLoading] = useState(true);

  if (!product) return null;

  const { name, image, images, price, discountedPrice, rating } = product;
  const imageSource = images?.[0]?.url || image;
  const displayPrice = discountedPrice || price;

  return (
    <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.9}>
      <View style={styles.compactImageContainer}>
        {imageLoading && <ShimmerPlaceholder style={StyleSheet.absoluteFill} />}
        <Image
          source={{ uri: imageSource }}
          style={[styles.compactImage, imageLoading && styles.imageHidden]}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={200}
          onLoad={() => setImageLoading(false)}
        />
      </View>
      <Text style={styles.compactName} numberOfLines={2}>{name}</Text>
      <View style={styles.compactRating}>
        <Ionicons name="star" size={10} color={colors.star} />
        <Text style={styles.compactRatingText}>{rating?.toFixed(1) || '0.0'}</Text>
      </View>
      <Text style={styles.compactPrice}>{formatPrice(displayPrice)}</Text>
    </TouchableOpacity>
  );
}

export default React.memo(ProductCard);

const styles = StyleSheet.create({
  animatedContainer: {
    width: CARD_WIDTH,
  },
  container: { 
    width: '100%',
    backgroundColor: colors.white, 
    borderRadius: borderRadius.xl, 
    marginBottom: spacing.sm, 
    ...shadows.md, 
    borderWidth: 1, 
    borderColor: colors.light, 
    overflow: 'hidden',
  },
  containerCompact: {
    width: 140,
  },
  // Badges
  badgesContainer: { 
    position: 'absolute', 
    top: spacing.sm, 
    left: spacing.sm, 
    zIndex: 10, 
    gap: 4,
  },
  featuredBadge: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: colors.featured, 
    paddingHorizontal: spacing.sm, 
    paddingVertical: 3, 
    borderRadius: borderRadius.full, 
    gap: 3,
  },
  discountBadge: {
    backgroundColor: colors.discount, 
    paddingHorizontal: spacing.sm, 
    paddingVertical: 3, 
    borderRadius: borderRadius.full,
  },
  outOfStockBadge: { 
    backgroundColor: colors.gray, 
    paddingHorizontal: spacing.sm, 
    paddingVertical: 3, 
    borderRadius: borderRadius.full,
  },
  badgeText: { 
    color: colors.white, 
    fontSize: fontSize.xs, 
    fontWeight: fontWeight.semibold,
  },
  // Actions
  actionsContainer: { 
    position: 'absolute', 
    top: spacing.sm, 
    right: spacing.sm, 
    zIndex: 10, 
    gap: spacing.xs,
  },
  actionButton: { 
    backgroundColor: 'rgba(255, 255, 255, 0.95)', 
    width: 34, 
    height: 34, 
    borderRadius: borderRadius.full, 
    justifyContent: 'center', 
    alignItems: 'center', 
    ...shadows.sm,
  },
  actionButtonActive: { 
    backgroundColor: colors.errorLighter,
  },
  actionButtonActiveCart: { 
    backgroundColor: colors.primaryLighter,
  },
  // Image
  imageContainer: { 
    width: '100%', 
    aspectRatio: 1, 
    backgroundColor: colors.lighter, 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  image: { 
    width: '100%', 
    height: '100%',
  },
  imageHidden: { 
    opacity: 0,
  },
  imagePlaceholder: { 
    ...StyleSheet.absoluteFillObject, 
    justifyContent: 'center', 
    alignItems: 'center', 
    backgroundColor: colors.lighter,
  },
  shimmer: {
    backgroundColor: colors.light,
    overflow: 'hidden',
  },
  shimmerInner: {
    flex: 1,
    backgroundColor: colors.grayLighter,
  },
  outOfStockOverlay: { 
    ...StyleSheet.absoluteFillObject, 
    backgroundColor: 'rgba(0, 0, 0, 0.5)', 
    justifyContent: 'center', 
    alignItems: 'center',
  },
  outOfStockText: { 
    color: colors.white, 
    fontWeight: fontWeight.semibold, 
    backgroundColor: 'rgba(0, 0, 0, 0.7)', 
    paddingHorizontal: spacing.md, 
    paddingVertical: spacing.sm, 
    borderRadius: borderRadius.md,
  },
  // Details
  detailsContainer: { 
    padding: spacing.md,
  },
  category: { 
    fontSize: fontSize.xs, 
    color: colors.textSecondary, 
    textTransform: 'uppercase', 
    letterSpacing: 0.5, 
    marginBottom: 2,
  },
  name: { 
    fontSize: fontSize.sm, 
    fontWeight: fontWeight.semibold, 
    color: colors.text, 
    marginBottom: spacing.sm, 
    minHeight: 36,
    lineHeight: 18,
  },
  ratingContainer: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    marginBottom: spacing.sm,
    flexWrap: 'wrap',
  },
  stars: { 
    flexDirection: 'row', 
    marginRight: spacing.xs,
  },
  ratingText: { 
    fontSize: fontSize.xs, 
    color: colors.textSecondary,
  },
  reviewCount: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    marginLeft: spacing.xs,
  },
  priceContainer: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: spacing.sm, 
    marginBottom: spacing.md,
  },
  price: { 
    ...typography.price,
  },
  originalPrice: {
    fontSize: fontSize.sm, 
    color: colors.textSecondary, 
    textDecorationLine: 'line-through',
  },
  // Button
  addToCartButton: { 
    backgroundColor: colors.primary, 
    paddingVertical: spacing.sm, 
    borderRadius: borderRadius.lg, 
    alignItems: 'center', 
    justifyContent: 'center',
    minHeight: 40,
  },
  addToCartButtonDisabled: { 
    backgroundColor: colors.light,
  },
  removeFromCartButton: { 
    backgroundColor: colors.successLighter,
  },
  buttonContent: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: spacing.xs,
  },
  addToCartButtonText: { 
    color: colors.white, 
    fontWeight: fontWeight.semibold, 
    fontSize: fontSize.sm,
  },
  addToCartButtonTextDisabled: { 
    color: colors.textSecondary, 
    fontWeight: fontWeight.medium, 
    fontSize: fontSize.sm,
  },
  inCartButtonText: { 
    color: colors.success, 
    fontWeight: fontWeight.semibold, 
    fontSize: fontSize.sm,
  },
  // Compact styles
  compactContainer: {
    width: 140,
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    marginRight: spacing.md,
    ...shadows.sm,
    overflow: 'hidden',
  },
  compactImageContainer: {
    width: '100%',
    height: 100,
    backgroundColor: colors.lighter,
  },
  compactImage: {
    width: '100%',
    height: '100%',
  },
  compactName: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
    padding: spacing.sm,
    paddingBottom: spacing.xs,
  },
  compactRating: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    gap: 2,
  },
  compactRatingText: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
  },
  compactPrice: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.text,
    padding: spacing.sm,
    paddingTop: spacing.xs,
  },
});
