/**
 * ProductCard — Liquid Glass Design
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Dimensions, Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useNavigation } from '@react-navigation/native';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import GlassBlurFill from './common/GlassBlurFill';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - spacing.lg * 2 - spacing.sm) / 2;

// Website's --logo-gradient and --logo-glow (index.css)
const LOGO_GRADIENT = ['#14B8A6', '#0EA5E9', '#6366F1'];
const LOGO_GLOW = {
  shadowColor: '#0EA5E9',
  shadowOffset: { width: 0, height: 8 },
  shadowOpacity: 0.4,
  shadowRadius: 16,
  elevation: 6,
};

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
  const { wishlistItems, handleAddToWishlist, handleDeleteFromWishlist, cartItems, handleAddToCart, handleQtyInc, handleQtyDec, qtyUpdateId, isCartLoading, loadingProductId } = useGlobal();
  const { formatProductPrice } = useCurrency();
  const { palette } = useTheme();
  const c = palette.colors;
  const g = palette.glass;

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
  const cartItem = cartItems?.cart?.find((item) => item?.product?._id === _id);
  const isInCart = !!cartItem;
  const isOutOfStock = stock === 0;
  const displayPrice = discountedPrice || price;
  const originalDisplayPrice = discountedPrice ? price : null;
  const discountPercentage = originalDisplayPrice && displayPrice < originalDisplayPrice ? Math.round(((originalDisplayPrice - displayPrice) / originalDisplayPrice) * 100) : 0;

  const handleWishlistToggle = () => {
    if (!currentUser) { navigation.navigate('Login'); return; }
    Animated.sequence([Animated.timing(heartScale, { toValue: 1.3, duration: 100, useNativeDriver: true }), Animated.timing(heartScale, { toValue: 1, duration: 100, useNativeDriver: true })]).start();
    isInWishlist ? handleDeleteFromWishlist(_id) : handleAddToWishlist(_id, product);
  };

  const handleAddToCartClick = () => { if (!currentUser) { navigation.navigate('Login'); return; } handleAddToCart(_id, null, product); };
  // Some legacy products store a text label instead of a URL — treat those as missing
  const rawImageSource = (typeof images?.[0] === 'string' ? images[0] : images?.[0]?.url) || image;
  const imageSource = typeof rawImageSource === 'string' && /^(https?:|data:|file:)/.test(rawImageSource) ? rawImageSource : null;
  const isLoading = isCartLoading && loadingProductId === _id;

  const renderStars = () => {
    const stars = []; const full = Math.floor(rating || 0); const half = (rating || 0) % 1 >= 0.5;
    for (let i = 0; i < 5; i++) {
      if (i < full) stars.push(<Ionicons key={i} name="star" size={11} color={colors.star} />);
      else if (i === full && half) stars.push(<Ionicons key={i} name="star-half" size={11} color={colors.star} />);
      else stars.push(<Ionicons key={i} name="star-outline" size={11} color={c.textSecondary} />);
    }
    return stars;
  };

  return (
    <Animated.View style={[styles.animatedContainer, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }]}>
      <TouchableOpacity
        style={[styles.container, { backgroundColor: g.bg, borderColor: g.border }]}
        onPress={onPress}
        onLongPress={() => {
          if (isOutOfStock) return;
          if (!currentUser) { navigation.navigate('Login'); return; }
          import('expo-haptics').then((H) => H.impactAsync?.(H.ImpactFeedbackStyle.Heavy)).catch(() => {});
          handleAddToCart(_id, null, product);
        }}
        delayLongPress={350}
        accessibilityHint="Long-press to quick-add to cart"
        activeOpacity={0.9}
        disabled={isOutOfStock}
      >
        <GlassBlurFill intensity={38} />
        {/* Badges */}
        <View style={styles.badgesContainer}>
          {isFeatured && (
            <View style={styles.featuredBadge}>
              <Ionicons name="flash" size={10} color="#2563eb" />
              <Text style={styles.featuredBadgeText}>Featured</Text>
            </View>
          )}
          {discountPercentage > 0 && <View style={styles.discountBadge}><Text style={styles.badgeText}>-{discountPercentage}%</Text></View>}
          {isOutOfStock && <View style={styles.outOfStockBadge}><Text style={styles.badgeText}>Sold Out</Text></View>}
        </View>

        {/* Actions */}
        <View style={styles.actionsContainer}>
          <Animated.View style={{ transform: [{ scale: heartScale }] }}>
            <TouchableOpacity
              style={[styles.actionButton, isInWishlist && styles.actionButtonActive]}
              onPress={handleWishlistToggle}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel={isInWishlist ? 'Remove from wishlist' : 'Add to wishlist'}
              accessibilityRole="button"
            >
              <Ionicons name={isInWishlist ? 'heart' : 'heart-outline'} size={16} color={isInWishlist ? c.heart : c.text} />
            </TouchableOpacity>
          </Animated.View>
        </View>

        {/* Image */}
        <View style={styles.imageContainer}>
          {imageSource && imageLoading && !imageError && <ShimmerPlaceholder style={StyleSheet.absoluteFill} />}
          {imageError || !imageSource ? <View style={styles.imagePlaceholder}><Ionicons name="image-outline" size={36} color={c.textLight} /></View> :
            <Image source={{ uri: imageSource }} style={[styles.image, imageLoading && { opacity: 0 }]} contentFit="contain" cachePolicy="memory-disk" transition={200} onLoad={() => setImageLoading(false)} onError={() => { setImageLoading(false); setImageError(true); }} />}
          {isOutOfStock && <View style={styles.outOfStockOverlay}><Text style={styles.outOfStockText}>Out of Stock</Text></View>}
        </View>

        {/* Details */}
        <View style={styles.detailsContainer}>
          <Text style={[styles.category, { color: c.textSecondary }]} numberOfLines={1}>{category}</Text>
          <Text style={[styles.name, { color: c.text }]} numberOfLines={3}>{name}</Text>
          <View style={styles.ratingContainer}><View style={{ flexDirection: 'row', marginRight: 4 }}>{renderStars()}</View><Text style={[styles.ratingText, { color: c.textSecondary }]}>({rating?.toFixed(1) || '0.0'})</Text></View>
          <View style={styles.priceContainer}>
            <Text style={[styles.price, { color: c.text }]}>{formatProductPrice(product, { field: discountedPrice ? 'discountedPrice' : 'price' })}</Text>
            {originalDisplayPrice && <Text style={[styles.originalPrice, { color: c.textSecondary }]}>{formatProductPrice(product, { field: 'price' })}</Text>}
          </View>
          {isInCart && cartItem ? (
            /* In-cart quantity stepper — matches website card */
            <View style={[styles.qtyRow, { backgroundColor: g.bgSubtle, borderColor: g.borderSubtle }]}>
              <TouchableOpacity
                style={[styles.qtyBtn, { backgroundColor: g.bgStrong, borderColor: g.border }]}
                onPress={() => handleQtyDec(cartItem._id)}
                disabled={qtyUpdateId === cartItem._id}
                accessibilityLabel="Decrease quantity"
              >
                <Ionicons name={cartItem.qty <= 1 ? 'close' : 'remove'} size={14} color={c.text} />
              </TouchableOpacity>
              {qtyUpdateId === cartItem._id
                ? <ActivityIndicator size="small" color={c.primary} />
                : <Text style={[styles.qtyValue, { color: c.text }]}>{cartItem.qty}</Text>}
              <TouchableOpacity
                onPress={() => handleQtyInc(cartItem._id)}
                disabled={qtyUpdateId === cartItem._id || cartItem.qty >= stock}
                accessibilityLabel="Increase quantity"
              >
                <LinearGradient colors={LOGO_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.qtyBtnGradient}>
                  <Ionicons name="add" size={14} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : isOutOfStock ? (
            <View style={[styles.addToCartButton, styles.addToCartDisabled, { backgroundColor: g.bgSubtle }]}>
              <Text style={[styles.addToCartTextDisabled, { color: c.textSecondary }]}>Out of Stock</Text>
            </View>
          ) : (
            /* Gradient Add to Cart — website --logo-gradient + glow */
            <TouchableOpacity onPress={handleAddToCartClick} disabled={isLoading} activeOpacity={0.85} style={LOGO_GLOW}>
              <LinearGradient colors={LOGO_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.addToCartButton}>
                {isLoading ? <ActivityIndicator size="small" color="#fff" /> : (
                  <View style={styles.btnContent}>
                    <Ionicons name="cart-outline" size={14} color="#fff" />
                    <Text style={styles.addToCartText}>Add to Cart</Text>
                  </View>
                )}
              </LinearGradient>
            </TouchableOpacity>
          )}

          {/* View details link — matches website */}
          <TouchableOpacity style={styles.viewDetailsRow} onPress={onPress} accessibilityLabel={`View details of ${name}`}>
            <Text style={[styles.viewDetailsText, { color: c.primary }]}>View details</Text>
            <Ionicons name="chevron-forward" size={12} color={c.primary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export function CompactProductCard({ product, onPress }) {
  const { formatProductPrice } = useCurrency();
  const [imageLoading, setImageLoading] = useState(true);
  if (!product) return null;
  const { name, image, images, discountedPrice, rating } = product;
  const imageSource = (typeof images?.[0] === 'string' ? images[0] : images?.[0]?.url) || image;
  return (
    <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.9}>
      <GlassBlurFill intensity={38} />
      <View style={styles.compactImageContainer}>
        {imageLoading && <ShimmerPlaceholder style={StyleSheet.absoluteFill} />}
        <Image source={{ uri: imageSource }} style={[styles.compactImage, imageLoading && { opacity: 0 }]} contentFit="cover" cachePolicy="memory-disk" transition={200} onLoad={() => setImageLoading(false)} />
      </View>
      <Text style={styles.compactName} numberOfLines={2}>{name}</Text>
      <View style={styles.compactRating}><Ionicons name="star" size={10} color={colors.star} /><Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>{rating?.toFixed(1) || '0.0'}</Text></View>
      <Text style={styles.compactPrice}>{formatProductPrice(product, { field: discountedPrice ? 'discountedPrice' : 'price' })}</Text>
    </TouchableOpacity>
  );
}

export default React.memo(ProductCard);

const styles = StyleSheet.create({
  animatedContainer: { width: CARD_WIDTH },
  container: { width: '100%', backgroundColor: glass.bg, borderRadius: 20, marginBottom: spacing.sm, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  badgesContainer: { position: 'absolute', top: spacing.sm, left: spacing.sm, zIndex: 10, gap: 4 },
  // Website .tag-pill: translucent indigo bg, blue text, subtle indigo border
  featuredBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(99,102,241,0.12)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20, gap: 3, borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)' },
  featuredBadgeText: { color: '#2563eb', fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  discountBadge: { backgroundColor: colors.discount, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  outOfStockBadge: { backgroundColor: colors.gray, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  actionsContainer: { position: 'absolute', top: spacing.sm, right: spacing.sm, zIndex: 10 },
  actionButton: { backgroundColor: 'rgba(255,255,255,0.85)', width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center', ...shadows.sm },
  actionButtonActive: { backgroundColor: 'rgba(239,68,68,0.15)' },
  // Inset rounded image area like the website's glass-inner block
  imageContainer: { marginHorizontal: spacing.sm, marginTop: spacing.sm, aspectRatio: 1, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', borderRadius: 16, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  imagePlaceholder: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' },
  shimmer: { backgroundColor: glass.bgSubtle },
  outOfStockOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  outOfStockText: { color: '#fff', fontWeight: fontWeight.semibold, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  detailsContainer: { padding: spacing.md },
  category: { fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  name: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm, minHeight: 54, lineHeight: 18 },
  ratingContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  ratingText: { fontSize: fontSize.xs, color: colors.textSecondary },
  priceContainer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.md },
  price: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  originalPrice: { fontSize: fontSize.sm, color: colors.textSecondary, textDecorationLine: 'line-through' },
  addToCartButton: { paddingVertical: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 38 },
  addToCartDisabled: { opacity: 0.6 },
  btnContent: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  addToCartText: { color: '#fff', fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  addToCartTextDisabled: { fontSize: fontSize.sm },
  // In-cart qty stepper (website parity)
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 12, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 6, minHeight: 38 },
  qtyBtn: { width: 26, height: 26, borderRadius: 8, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  qtyBtnGradient: { width: 26, height: 26, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  qtyValue: { fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  // View details link
  viewDetailsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: spacing.sm },
  viewDetailsText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  compactContainer: { width: 140, backgroundColor: glass.bg, borderRadius: 16, marginRight: spacing.md, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  compactImageContainer: { width: '100%', height: 100, backgroundColor: 'rgba(255,255,255,0.04)' },
  compactImage: { width: '100%', height: '100%' },
  compactName: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: colors.text, padding: spacing.sm, paddingBottom: 4 },
  compactRating: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, gap: 2 },
  compactPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.text, padding: spacing.sm, paddingTop: 4 },
});
