/**
 * ProductCard — Liquid Glass Design
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Dimensions, Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useNavigation } from '@react-navigation/native';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - spacing.lg * 2 - spacing.sm) / 2;

const ShimmerPlaceholder = ({ style }) => {
  const shimmerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(shimmerAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      Animated.timing(shimmerAnim, { toValue: 0, duration: 1000, useNativeDriver: true }),
    ]));
    anim.start(); return () => anim.stop();
  }, []);
  return <Animated.View style={[styles.shimmer, style, { opacity: shimmerAnim.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.7] }) }]} />;
};

function ProductCard({ product, index = 0, onPress, compact = false }) {
  const navigation = useNavigation();
  const { currentUser } = useAuth();
  const { wishlistItems, handleAddToWishlist, handleDeleteFromWishlist, cartItems, handleAddToCart, isCartLoading, loadingProductId } = useGlobal();
  const { formatPrice } = useCurrency();

  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0.9)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const heartScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, friction: 8, tension: 40, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
    }, index * 50);
    return () => clearTimeout(t);
  }, [index]);

  if (!product) return null;

  const { _id, name, image, images, category, price, discountedPrice, stock, rating, numReviews, isFeatured } = product;
  const isInWishlist = wishlistItems?.some((item) => item?._id === _id);
  const isInCart = cartItems?.cart?.some((item) => item?.product?._id === _id);
  const isOutOfStock = stock === 0;
  const displayPrice = discountedPrice || price;
  const originalDisplayPrice = discountedPrice ? price : null;
  const discountPercentage = originalDisplayPrice && displayPrice < originalDisplayPrice ? Math.round(((originalDisplayPrice - displayPrice) / originalDisplayPrice) * 100) : 0;

  const handleWishlistToggle = () => {
    if (!currentUser) { navigation.navigate('Login'); return; }
    Animated.sequence([Animated.timing(heartScale, { toValue: 1.3, duration: 100, useNativeDriver: true }), Animated.timing(heartScale, { toValue: 1, duration: 100, useNativeDriver: true })]).start();
    isInWishlist ? handleDeleteFromWishlist(_id) : handleAddToWishlist(_id);
  };

  const handleAddToCartClick = () => { if (!currentUser) { navigation.navigate('Login'); return; } handleAddToCart(_id); };
  const imageSource = images?.[0]?.url || image;
  const isLoading = isCartLoading && loadingProductId === _id;

  const renderStars = () => {
    const stars = []; const full = Math.floor(rating || 0); const half = (rating || 0) % 1 >= 0.5;
    for (let i = 0; i < 5; i++) {
      if (i < full) stars.push(<Ionicons key={i} name="star" size={11} color={colors.star} />);
      else if (i === full && half) stars.push(<Ionicons key={i} name="star-half" size={11} color={colors.star} />);
      else stars.push(<Ionicons key={i} name="star-outline" size={11} color={colors.star} />);
    }
    return stars;
  };

  return (
    <Animated.View style={[styles.animatedContainer, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }]}>
      <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={0.9} disabled={isOutOfStock}>
        {/* Badges */}
        <View style={styles.badgesContainer}>
          {isFeatured && <View style={styles.featuredBadge}><Ionicons name="flash" size={10} color="#fff" /><Text style={styles.badgeText}>Featured</Text></View>}
          {discountPercentage > 0 && <View style={styles.discountBadge}><Text style={styles.badgeText}>-{discountPercentage}%</Text></View>}
          {isOutOfStock && <View style={styles.outOfStockBadge}><Text style={styles.badgeText}>Sold Out</Text></View>}
        </View>

        {/* Actions */}
        <View style={styles.actionsContainer}>
          <Animated.View style={{ transform: [{ scale: heartScale }] }}>
            <TouchableOpacity style={[styles.actionButton, isInWishlist && styles.actionButtonActive]} onPress={handleWishlistToggle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name={isInWishlist ? 'heart' : 'heart-outline'} size={16} color={isInWishlist ? colors.heart : colors.text} />
            </TouchableOpacity>
          </Animated.View>
        </View>

        {/* Image */}
        <View style={styles.imageContainer}>
          {imageLoading && !imageError && <ShimmerPlaceholder style={StyleSheet.absoluteFill} />}
          {imageError ? <View style={styles.imagePlaceholder}><Ionicons name="image-outline" size={36} color="rgba(255,255,255,0.3)" /></View> :
            <Image source={{ uri: imageSource }} style={[styles.image, imageLoading && { opacity: 0 }]} contentFit="contain" cachePolicy="memory-disk" transition={200} onLoad={() => setImageLoading(false)} onError={() => { setImageLoading(false); setImageError(true); }} />}
          {isOutOfStock && <View style={styles.outOfStockOverlay}><Text style={styles.outOfStockText}>Out of Stock</Text></View>}
        </View>

        {/* Details */}
        <View style={styles.detailsContainer}>
          <Text style={styles.category} numberOfLines={1}>{category}</Text>
          <Text style={styles.name} numberOfLines={2}>{name}</Text>
          <View style={styles.ratingContainer}><View style={{ flexDirection: 'row', marginRight: 4 }}>{renderStars()}</View><Text style={styles.ratingText}>({rating?.toFixed(1) || '0.0'})</Text></View>
          <View style={styles.priceContainer}>
            <Text style={styles.price}>{formatPrice(displayPrice)}</Text>
            {originalDisplayPrice && <Text style={styles.originalPrice}>{formatPrice(originalDisplayPrice)}</Text>}
          </View>
          <TouchableOpacity style={[styles.addToCartButton, isOutOfStock && styles.addToCartDisabled, isInCart && styles.inCartButton]} onPress={handleAddToCartClick} disabled={isOutOfStock || isLoading} activeOpacity={0.8}>
            {isLoading ? <ActivityIndicator size="small" color={isInCart ? colors.success : '#fff'} /> :
              isOutOfStock ? <Text style={styles.addToCartTextDisabled}>Out of Stock</Text> :
              isInCart ? <View style={styles.btnContent}><Ionicons name="checkmark-circle" size={14} color={colors.success} /><Text style={styles.inCartText}>In Cart</Text></View> :
              <View style={styles.btnContent}><Ionicons name="cart-outline" size={14} color="#fff" /><Text style={styles.addToCartText}>Add to Cart</Text></View>}
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export function CompactProductCard({ product, onPress }) {
  const { formatPrice } = useCurrency();
  const [imageLoading, setImageLoading] = useState(true);
  if (!product) return null;
  const { name, image, images, price, discountedPrice, rating } = product;
  const imageSource = images?.[0]?.url || image;
  return (
    <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.9}>
      <View style={styles.compactImageContainer}>
        {imageLoading && <ShimmerPlaceholder style={StyleSheet.absoluteFill} />}
        <Image source={{ uri: imageSource }} style={[styles.compactImage, imageLoading && { opacity: 0 }]} contentFit="cover" cachePolicy="memory-disk" transition={200} onLoad={() => setImageLoading(false)} />
      </View>
      <Text style={styles.compactName} numberOfLines={2}>{name}</Text>
      <View style={styles.compactRating}><Ionicons name="star" size={10} color={colors.star} /><Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{rating?.toFixed(1) || '0.0'}</Text></View>
      <Text style={styles.compactPrice}>{formatPrice(discountedPrice || price)}</Text>
    </TouchableOpacity>
  );
}

export default React.memo(ProductCard);

const styles = StyleSheet.create({
  animatedContainer: { width: CARD_WIDTH },
  container: { width: '100%', backgroundColor: glass.bg, borderRadius: 20, marginBottom: spacing.sm, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  badgesContainer: { position: 'absolute', top: spacing.sm, left: spacing.sm, zIndex: 10, gap: 4 },
  featuredBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.featured, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, gap: 3 },
  discountBadge: { backgroundColor: colors.discount, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  outOfStockBadge: { backgroundColor: colors.gray, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  actionsContainer: { position: 'absolute', top: spacing.sm, right: spacing.sm, zIndex: 10 },
  actionButton: { backgroundColor: 'rgba(255,255,255,0.85)', width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center', ...shadows.sm },
  actionButtonActive: { backgroundColor: 'rgba(239,68,68,0.15)' },
  imageContainer: { width: '100%', aspectRatio: 1, backgroundColor: 'rgba(255,255,255,0.04)', justifyContent: 'center', alignItems: 'center' },
  image: { width: '100%', height: '100%' },
  imagePlaceholder: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  shimmer: { backgroundColor: glass.bgSubtle },
  outOfStockOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  outOfStockText: { color: '#fff', fontWeight: fontWeight.semibold, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  detailsContainer: { padding: spacing.md },
  category: { fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  name: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm, minHeight: 36, lineHeight: 18 },
  ratingContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  ratingText: { fontSize: fontSize.xs, color: colors.textSecondary },
  priceContainer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.md },
  price: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  originalPrice: { fontSize: fontSize.sm, color: colors.textSecondary, textDecorationLine: 'line-through' },
  addToCartButton: { backgroundColor: colors.primary, paddingVertical: 10, borderRadius: 14, alignItems: 'center', justifyContent: 'center', minHeight: 38 },
  addToCartDisabled: { backgroundColor: glass.bgSubtle },
  inCartButton: { backgroundColor: 'rgba(34,197,94,0.12)' },
  btnContent: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addToCartText: { color: '#fff', fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  addToCartTextDisabled: { color: colors.textSecondary, fontSize: fontSize.sm },
  inCartText: { color: colors.success, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  compactContainer: { width: 140, backgroundColor: glass.bg, borderRadius: 16, marginRight: spacing.md, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  compactImageContainer: { width: '100%', height: 100, backgroundColor: 'rgba(255,255,255,0.04)' },
  compactImage: { width: '100%', height: '100%' },
  compactName: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: colors.text, padding: spacing.sm, paddingBottom: 4 },
  compactRating: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, gap: 2 },
  compactPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.text, padding: spacing.sm, paddingTop: 4 },
});
