/**
 * ProductDetailScreen
 * Modern product detail screen with image carousel, pricing, and actions
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Dimensions,
  FlatList,
  Share,
  Animated,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader } from '../components/common';
import VerifiedBadge from '../components/VerifiedBadge';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';

const { width } = Dimensions.get('window');

export default function ProductDetailScreen({ route, navigation }) {
  const { productId } = route.params;
  const { currentUser } = useAuth();
  const {
    wishlistItems,
    handleAddToWishlist,
    handleDeleteFromWishlist,
    cartItems,
    handleAddToCart,
    isCartLoading,
    loadingProductId,
  } = useGlobal();
  const { formatPrice, convertPrice, getCurrencySymbol } = useCurrency();

  const [product, setProduct] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [storeData, setStoreData] = useState(null);
  const flatListRef = useRef(null);

  // Animation for bottom bar
  const bottomBarAnim = useRef(new Animated.Value(0)).current;

  // Review modal state
  const [reviewModalVisible, setReviewModalVisible] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  const isInWishlist = product && wishlistItems?.some((item) => item._id === product._id);
  const isInCart = product && cartItems?.cart?.some((item) => item.product?._id === product._id);

  useEffect(() => {
    fetchProduct();
    // Animate bottom bar in
    Animated.spring(bottomBarAnim, {
      toValue: 1,
      friction: 8,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [productId]);

  // Share product
  const handleShare = async () => {
    try {
      await Share.share({
        message: `Check out ${product.name} on Tortrose! ${formatPrice(displayPrice)}`,
        title: product.name,
      });
    } catch (error) {
      console.log('Error sharing:', error);
    }
  };

  const fetchProduct = async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/api/products/get-single-product/${productId}`);
      setProduct(res.data.product);

      // Fetch store data
      if (res.data.product.seller) {
        try {
          const storeRes = await api.get(`/api/stores/seller/${res.data.product.seller}`);
          setStoreData(storeRes.data.store);
        } catch (error) {
          console.log('No store configured for this seller');
        }
      }
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Product not found',
      });
      navigation.goBack();
    } finally {
      setIsLoading(false);
    }
  };

  // Calculate discounted price
  const getDiscountedPrice = () => {
    if (!product) return 0;
    return product.discountedPrice || product.price;
  };

  const displayPrice = getDiscountedPrice();
  const originalPrice = product?.price;
  const discountPercentage = product?.discountedPrice && product.discountedPrice < product.price
    ? Math.round(((product.price - product.discountedPrice) / product.price) * 100)
    : 0;

  const handleWishlistToggle = () => {
    if (!currentUser) {
      navigation.navigate('Login');
      return;
    }
    if (isInWishlist) {
      handleDeleteFromWishlist(product._id);
    } else {
      handleAddToWishlist(product._id);
    }
  };

  const handleAddToCartClick = () => {
    if (!currentUser) {
      navigation.navigate('Login');
      return;
    }
    handleAddToCart(product._id);
  };

  const handleSubmitReview = async () => {
    if (!currentUser) {
      navigation.navigate('Login');
      return;
    }
    if (!reviewComment.trim()) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Please write a comment for your review' });
      return;
    }
    setSubmittingReview(true);
    try {
      await api.post(`/api/products/add-review/${productId}`, {
        rating: reviewRating,
        comment: reviewComment.trim(),
      });
      Toast.show({ type: 'success', text1: 'Review Submitted!', text2: 'Thank you for your feedback.' });
      setReviewModalVisible(false);
      setReviewComment('');
      setReviewRating(5);
      fetchProduct(); // Refresh to show new review
    } catch (error) {
      Toast.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed to submit review' });
    } finally {
      setSubmittingReview(false);
    }
  };

  const scrollToImage = (index) => {
    setSelectedImageIndex(index);
    flatListRef.current?.scrollToIndex({ index, animated: true });
  };

  // Render star rating with half stars
  const renderStars = (rating) => {
    const stars = [];
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating % 1 >= 0.5;
    
    for (let i = 0; i < 5; i++) {
      if (i < fullStars) {
        stars.push(
          <Ionicons key={i} name="star" size={18} color={colors.star} />
        );
      } else if (i === fullStars && hasHalfStar) {
        stars.push(
          <Ionicons key={i} name="star-half" size={18} color={colors.star} />
        );
      } else {
        stars.push(
          <Ionicons key={i} name="star-outline" size={18} color={colors.star} />
        );
      }
    }
    return stars;
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen size="large" />
      </SafeAreaView>
    );
  }

  if (!product) return null;

  const images = product.images?.length > 0 ? product.images : [{ url: product.image }];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Image Gallery */}
        <View style={styles.imageSection}>
          <FlatList
            ref={flatListRef}
            data={images}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => {
              const index = Math.round(e.nativeEvent.contentOffset.x / width);
              setSelectedImageIndex(index);
            }}
            renderItem={({ item }) => (
              <View style={styles.imageContainer}>
                <Image
                  source={{ uri: item.url }}
                  style={styles.mainImage}
                  contentFit="contain"
                  cachePolicy="memory-disk"
                  transition={200}
                />
              </View>
            )}
            keyExtractor={(item, index) => index.toString()}
          />

          {/* Badges */}
          <View style={styles.badgesContainer}>
            {product.isFeatured && (
              <View style={styles.featuredBadge}>
                <Ionicons name="flash" size={12} color={colors.white} />
                <Text style={styles.badgeText}>Featured</Text>
              </View>
            )}
            {discountPercentage > 0 && (
              <View style={styles.discountBadge}>
                <Text style={styles.badgeText}>-{discountPercentage}% OFF</Text>
              </View>
            )}
          </View>

          {/* Image Indicators */}
          {images.length > 1 && (
            <View style={styles.indicatorContainer}>
              {images.map((_, index) => (
                <TouchableOpacity
                  key={index}
                  onPress={() => scrollToImage(index)}
                  style={[
                    styles.indicator,
                    index === selectedImageIndex && styles.indicatorActive,
                  ]}
                />
              ))}
            </View>
          )}
        </View>

        {/* Thumbnails */}
        {images.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.thumbnailContainer}
          >
            {images.map((img, index) => (
              <TouchableOpacity
                key={index}
                onPress={() => scrollToImage(index)}
                style={[
                  styles.thumbnail,
                  index === selectedImageIndex && styles.thumbnailActive,
                ]}
              >
                <Image
                  source={{ uri: img.url }}
                  style={styles.thumbnailImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Product Info */}
        <View style={styles.infoSection}>
          <Text style={styles.category}>{product.category}</Text>
          <Text style={styles.name}>{product.name}</Text>

          {/* Rating */}
          <View style={styles.ratingRow}>
            <View style={styles.stars}>
              {renderStars(product.rating || 0)}
            </View>
            <Text style={styles.ratingText}>({product.numReviews || 0} reviews)</Text>
            <View style={styles.dot} />
            <Text style={[styles.stockText, product.stock > 0 ? styles.inStock : styles.outOfStock]}>
              {product.stock > 0 ? `In Stock (${product.stock})` : 'Out of Stock'}
            </Text>
          </View>

          {/* Price */}
          <View style={styles.priceSection}>
            <View style={styles.priceRow}>
              <Text style={styles.price}>
                {formatPrice(displayPrice)}
              </Text>
              {discountPercentage > 0 && (
                <>
                  <Text style={styles.originalPrice}>{formatPrice(originalPrice)}</Text>
                  <View style={styles.saveBadge}>
                    <Text style={styles.saveText}>
                      Save {discountPercentage}%
                    </Text>
                  </View>
                </>
              )}
            </View>
          </View>

          {/* Description */}
          <Text style={styles.description}>{product.description}</Text>

          {/* Features */}
          <View style={styles.featuresRow}>
            <View style={styles.featureItem}>
              <Ionicons name="refresh-outline" size={18} color={colors.secondary} />
              <Text style={styles.featureText}>30-Day Returns</Text>
            </View>
          </View>

          {/* Tags */}
          {product.tags && product.tags.length > 0 && (
            <View style={styles.tagsContainer}>
              {product.tags.map((tag, index) => (
                <View key={index} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Store Info */}
          {storeData && (
            <TouchableOpacity
              style={styles.storeCard}
              onPress={() => navigation.navigate('Store', { slug: storeData.storeSlug })}
              accessibilityLabel={`Visit ${storeData.storeName} store`}
              accessibilityRole="button"
            >
              <View style={styles.storeInfo}>
                {storeData.storeLogo ? (
                  <Image source={{ uri: storeData.storeLogo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                ) : (
                  <View style={styles.storeLogoPlaceholder}>
                    <Ionicons name="storefront" size={24} color={colors.white} />
                  </View>
                )}
                <View style={styles.storeDetails}>
                  <View style={styles.storeNameRow}>
                    <Text style={styles.storeName}>{storeData.storeName}</Text>
                    {storeData.isVerified && (
                      <VerifiedBadge size="sm" />
                    )}
                  </View>
                  <Text style={styles.storeStats}>
                    {storeData.trustCount || 0} trusted • {storeData.productCount || 0} products
                  </Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.grayLight} />
            </TouchableOpacity>
          )}

          {/* Product Details */}
          <View style={styles.detailsSection}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Category</Text>
              <Text style={styles.detailValue}>{product.category}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Brand</Text>
              <Text style={styles.detailValue}>{product.brand}</Text>
            </View>
          </View>

          {/* Reviews Section */}
          <View style={styles.reviewsSection}>
            <View style={styles.reviewsHeader}>
              <View>
                <Text style={styles.reviewsTitle}>Customer Reviews</Text>
                <Text style={styles.reviewsSubtitle}>{product.numReviews || 0} review{product.numReviews !== 1 ? 's' : ''}</Text>
              </View>
              <TouchableOpacity
                style={styles.writeReviewBtn}
                onPress={() => {
                  if (!currentUser) { navigation.navigate('Login'); return; }
                  setReviewModalVisible(true);
                }}
                activeOpacity={0.8}
              >
                <Ionicons name="create-outline" size={16} color={colors.white} />
                <Text style={styles.writeReviewBtnText}>Write a Review</Text>
              </TouchableOpacity>
            </View>

            {/* Reviews List */}
            {product.reviews && product.reviews.length > 0 ? (
              product.reviews.slice(0, 5).map((review, index) => (
                <View key={index} style={styles.reviewCard}>
                  <View style={styles.reviewCardHeader}>
                    <View style={styles.reviewAvatar}>
                      <Text style={styles.reviewAvatarText}>
                        {(review.user?.name || review.name || 'U')[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.reviewCardInfo}>
                      <Text style={styles.reviewerName}>{review.user?.name || review.name || 'Anonymous'}</Text>
                      <View style={styles.reviewStars}>
                        {[1,2,3,4,5].map(star => (
                          <Ionicons key={star} name={star <= review.rating ? 'star' : 'star-outline'} size={13} color={colors.star} />
                        ))}
                      </View>
                    </View>
                  </View>
                  <Text style={styles.reviewComment}>{review.comment}</Text>
                </View>
              ))
            ) : (
              <View style={styles.noReviewsWrap}>
                <Ionicons name="chatbubble-ellipses-outline" size={36} color={colors.grayLight} />
                <Text style={styles.noReviewsText}>No reviews yet. Be the first!</Text>
              </View>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Review Modal */}
      <Modal
        visible={reviewModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setReviewModalVisible(false)}
      >
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalSheet}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Write a Review</Text>
              <TouchableOpacity onPress={() => setReviewModalVisible(false)} style={styles.modalCloseBtn}>
                <Ionicons name="close" size={22} color={colors.text} />
              </TouchableOpacity>
            </View>

            {/* Product name in modal */}
            <Text style={styles.modalProductName} numberOfLines={1}>{product.name}</Text>

            {/* Star Rating Picker */}
            <Text style={styles.modalLabel}>Your Rating</Text>
            <View style={styles.starPicker}>
              {[1, 2, 3, 4, 5].map(star => (
                <TouchableOpacity key={star} onPress={() => setReviewRating(star)} style={styles.starPickerBtn} activeOpacity={0.7}>
                  <Ionicons
                    name={star <= reviewRating ? 'star' : 'star-outline'}
                    size={36}
                    color={colors.star}
                  />
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.ratingLabel}>
              {reviewRating === 1 ? '😞 Poor' : reviewRating === 2 ? '😕 Fair' : reviewRating === 3 ? '😐 Good' : reviewRating === 4 ? '😊 Very Good' : '😍 Excellent'}
            </Text>

            {/* Comment Input */}
            <Text style={styles.modalLabel}>Your Review</Text>
            <TextInput
              style={styles.reviewInput}
              value={reviewComment}
              onChangeText={setReviewComment}
              placeholder="Share your experience with this product..."
              placeholderTextColor={colors.grayLight}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={500}
            />
            <Text style={styles.charCount}>{reviewComment.length}/500</Text>

            {/* Submit Button */}
            <TouchableOpacity
              style={[styles.submitReviewBtn, submittingReview && styles.submitReviewBtnDisabled]}
              onPress={handleSubmitReview}
              disabled={submittingReview}
              activeOpacity={0.85}
            >
              {submittingReview ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <>
                  <Ionicons name="send" size={18} color={colors.white} />
                  <Text style={styles.submitReviewBtnText}>Submit Review</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Bottom Action Bar */}
      <Animated.View 
        style={[
          styles.bottomBar,
          {
            transform: [{
              translateY: bottomBarAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [100, 0],
              }),
            }],
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.wishlistButton, isInWishlist && styles.wishlistButtonActive]}
          onPress={handleWishlistToggle}
          accessibilityLabel={isInWishlist ? 'Remove from wishlist' : 'Add to wishlist'}
          accessibilityRole="button"
        >
          <Ionicons
            name={isInWishlist ? 'heart' : 'heart-outline'}
            size={24}
            color={isInWishlist ? colors.heart : colors.gray}
          />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.shareButton}
          onPress={handleShare}
          accessibilityLabel="Share product"
          accessibilityRole="button"
        >
          <Ionicons name="share-outline" size={24} color={colors.gray} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.addToCartButton,
            product.stock === 0 && styles.addToCartButtonDisabled,
            isInCart && styles.inCartButton,
          ]}
          onPress={handleAddToCartClick}
          disabled={product.stock === 0 || (isCartLoading && loadingProductId === productId)}
          accessibilityLabel={product.stock === 0 ? 'Out of stock' : isInCart ? 'Added to cart' : 'Add to cart'}
          accessibilityRole="button"
        >
          {isCartLoading && loadingProductId === productId ? (
            <InlineLoader size="small" color={colors.white} />
          ) : product.stock === 0 ? (
            <Text style={styles.addToCartButtonTextDisabled}>Out of Stock</Text>
          ) : isInCart ? (
            <>
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <Text style={styles.inCartButtonText}>Added to Cart</Text>
            </>
          ) : (
            <>
              <Ionicons name="cart-outline" size={20} color={colors.white} />
              <Text style={styles.addToCartButtonText}>Add to Cart</Text>
            </>
          )}
        </TouchableOpacity>
      </Animated.View>
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
  imageSection: {
    backgroundColor: colors.white,
    position: 'relative',
  },
  imageContainer: {
    width: width,
    height: 350,
    backgroundColor: colors.lighter,
  },
  mainImage: {
    width: '100%',
    height: '100%',
  },
  badgesContainer: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    gap: spacing.xs,
  },
  featuredBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.secondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    gap: 4,
  },
  discountBadge: {
    backgroundColor: colors.error,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  badgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  indicatorContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    position: 'absolute',
    bottom: spacing.md,
    left: 0,
    right: 0,
    gap: spacing.sm,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
  },
  indicatorActive: {
    backgroundColor: colors.primary,
    width: 24,
  },
  thumbnailContainer: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.white,
    gap: spacing.sm,
  },
  thumbnail: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    borderWidth: 2,
    borderColor: colors.light,
    overflow: 'hidden',
    marginRight: spacing.sm,
  },
  thumbnailActive: {
    borderColor: colors.primary,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  infoSection: {
    backgroundColor: colors.white,
    padding: spacing.lg,
    marginTop: spacing.sm,
  },
  category: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  name: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
    marginBottom: spacing.md,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
    flexWrap: 'wrap',
  },
  stars: {
    flexDirection: 'row',
    marginRight: spacing.sm,
  },
  ratingText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.grayLight,
    marginHorizontal: spacing.sm,
  },
  stockText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  inStock: {
    color: colors.success,
  },
  outOfStock: {
    color: colors.error,
  },
  priceSection: {
    marginBottom: spacing.lg,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  price: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  originalPrice: {
    fontSize: fontSize.lg,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  saveBadge: {
    backgroundColor: colors.errorLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  saveText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.error,
  },
  description: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  featuresRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    marginBottom: spacing.lg,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  featureText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  tag: {
    backgroundColor: colors.infoLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  tagText: {
    fontSize: fontSize.sm,
    color: colors.info,
    fontWeight: fontWeight.medium,
  },
  storeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.lighter,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.lg,
  },
  storeInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  storeLogo: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.md,
    marginRight: spacing.md,
  },
  storeLogoPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.md,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  storeDetails: {
    flex: 1,
  },
  storeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  storeName: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  storeStats: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  detailsSection: {
    borderTopWidth: 1,
    borderTopColor: colors.light,
    paddingTop: spacing.lg,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  detailLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  detailValue: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text,
  },
  bottomBar: {
    flexDirection: 'row',
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    gap: spacing.md,
    ...shadows.lg,
  },
  wishlistButton: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
  },
  wishlistButtonActive: {
    backgroundColor: colors.errorLight,
  },
  shareButton: {
    width: 56,
    height: 56,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
  },
  addToCartButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  addToCartButtonDisabled: {
    backgroundColor: colors.light,
  },
  inCartButton: {
    backgroundColor: colors.successLight,
  },
  addToCartButtonText: {
    color: colors.white,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  addToCartButtonTextDisabled: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.medium,
  },
  inCartButtonText: {
    color: colors.success,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },

  // Reviews Section
  reviewsSection: {
    borderTopWidth: 1,
    borderTopColor: colors.light,
    paddingTop: spacing.lg,
    marginTop: spacing.lg,
  },
  reviewsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  reviewsTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  reviewsSubtitle: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 2,
  },
  writeReviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
  },
  writeReviewBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  reviewCard: {
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  reviewCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  reviewAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reviewAvatarText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  reviewCardInfo: { flex: 1 },
  reviewerName: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: 2,
  },
  reviewStars: { flexDirection: 'row', gap: 2 },
  reviewComment: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  noReviewsWrap: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  noReviewsText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },

  // Review Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: borderRadius.xxl,
    borderTopRightRadius: borderRadius.xxl,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
    ...shadows.xl,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  modalTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  modalCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.lighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalProductName: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  modalLabel: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  starPicker: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  starPickerBtn: { padding: spacing.xs },
  ratingLabel: {
    textAlign: 'center',
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  reviewInput: {
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: colors.light,
    padding: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
    minHeight: 100,
    marginBottom: spacing.xs,
  },
  charCount: {
    fontSize: fontSize.xs,
    color: colors.grayLight,
    textAlign: 'right',
    marginBottom: spacing.lg,
  },
  submitReviewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.lg,
    ...shadows.md,
  },
  submitReviewBtnDisabled: { opacity: 0.6 },
  submitReviewBtnText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
});
