/**
 * ProductDetailScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Dimensions, FlatList, Share, Animated, Modal, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, RefreshControl,
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
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { trackProductView } from '../utils/recentlyViewed';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const { width } = Dimensions.get('window');

export default function ProductDetailScreen({ route, navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { productId } = route.params;
  const { currentUser } = useAuth();
  const { wishlistItems, handleAddToWishlist, handleDeleteFromWishlist, cartItems, handleAddToCart, isCartLoading, loadingProductId } = useGlobal();
  const { formatProductPrice } = useCurrency();

  const [product, setProduct] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedColor, setSelectedColor] = useState(null);
  const [selectedOptions, setSelectedOptions] = useState({});
  const [storeData, setStoreData] = useState(null);
  const flatListRef = useRef(null);
  const bottomBarAnim = useRef(new Animated.Value(0)).current;

  const [reviewModalVisible, setReviewModalVisible] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  const optionsKeyOf = (opts) => opts ? Object.keys(opts).filter(k => opts[k]).sort().map(k => `${k}:${opts[k]}`).join('|') : '';
  const myOptKey = optionsKeyOf(selectedOptions);
  const allOptionsSelected = !product?.optionGroups?.length || product.optionGroups.every(g => selectedOptions[g.name]);
  const isInWishlist = product && wishlistItems?.some((item) => item._id === product._id);
  const isInCart = product && cartItems?.cart?.some((item) =>
    item.product?._id === product._id &&
    (item.selectedColor || null) === (selectedColor || null) &&
    optionsKeyOf(item.selectedOptions) === myOptKey
  );

  useEffect(() => {
    fetchProduct();
    if (productId) trackProductView(productId);
    Animated.spring(bottomBarAnim, { toValue: 1, friction: 8, tension: 40, useNativeDriver: true }).start();
  }, [productId]);

  const handleShare = async () => {
    try { await Share.share({ message: `Check out ${product.name} on Rozare! ${formatProductPrice(product, { field: product.discountedPrice ? 'discountedPrice' : 'price' })}`, title: product.name }); } catch {}
  };

  const fetchProduct = async () => {
    setIsLoading(true);
    try {
      const res = await api.get(`/api/products/get-single-product/${productId}`);
      setProduct(res.data.product);
      if (res.data.product.seller) {
        try { const storeRes = await api.get(`/api/stores/seller/${res.data.product.seller}`); setStoreData(storeRes.data.store); } catch {}
      }
    } catch { Toast.show({ type: 'error', text1: 'Error', text2: 'Product not found' }); navigation.goBack(); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchProduct();
  }, [productId]);

  const displayPrice = product?.discountedPrice || product?.price || 0;
  const originalPrice = product?.price;
  const discountPercentage = product?.discountedPrice && product.discountedPrice < product.price ? Math.round(((product.price - product.discountedPrice) / product.price) * 100) : 0;

  const handleWishlistToggle = () => { if (!currentUser) { navigation.navigate('Login'); return; } isInWishlist ? handleDeleteFromWishlist(product._id) : handleAddToWishlist(product._id); };
  const handleAddToCartClick = () => {
    if (!currentUser) { navigation.navigate('Login'); return; }
    if (!allOptionsSelected) { Toast.show({ type: 'error', text1: 'Please select all options' }); return; }
    handleAddToCart(product._id, selectedColor, selectedOptions);
  };

  const handleSubmitReview = async () => {
    if (!currentUser) { navigation.navigate('Login'); return; }
    if (!reviewComment.trim()) { Toast.show({ type: 'error', text1: 'Error', text2: 'Please write a comment' }); return; }
    setSubmittingReview(true);
    try {
      await api.post(`/api/products/add-review/${productId}`, { rating: reviewRating, comment: reviewComment.trim() });
      Toast.show({ type: 'success', text1: 'Review Submitted!' }); setReviewModalVisible(false); setReviewComment(''); setReviewRating(5); fetchProduct();
    } catch (error) { Toast.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed' }); }
    finally { setSubmittingReview(false); }
  };

  const scrollToImage = (index) => { setSelectedImageIndex(index); flatListRef.current?.scrollToIndex({ index, animated: true }); };

  const renderStars = (rating) => {
    const stars = []; const full = Math.floor(rating); const half = rating % 1 >= 0.5;
    for (let i = 0; i < 5; i++) {
      if (i < full) stars.push(<Ionicons key={i} name="star" size={16} color={palette.colors.star} />);
      else if (i === full && half) stars.push(<Ionicons key={i} name="star-half" size={16} color={palette.colors.star} />);
      else stars.push(<Ionicons key={i} name="star-outline" size={16} color={palette.colors.star} />);
    }
    return stars;
  };

  if (isLoading) return <GlassBackground><View style={styles.center}><Loader fullScreen size="large" /></View></GlassBackground>;
  if (!product) return null;

  const images = product.images?.length > 0 ? product.images : [{ url: product.image }];

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        {/* Image Gallery */}
        <View style={styles.imageSection}>
          <FlatList ref={flatListRef} data={images} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => setSelectedImageIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item }) => (
              <View style={styles.imageContainer}>
                <Image source={{ uri: item.url }} style={styles.mainImage} contentFit="contain" cachePolicy="memory-disk" transition={200} />
              </View>
            )}
            keyExtractor={(_, index) => index.toString()}
          />
          <View style={styles.badgesContainer}>
            {product.isFeatured && <View style={styles.featuredBadge}><Ionicons name="flash" size={12} color="#fff" /><Text style={styles.badgeText}>Featured</Text></View>}
            {discountPercentage > 0 && <View style={styles.discountBadge}><Text style={styles.badgeText}>-{discountPercentage}% OFF</Text></View>}
          </View>
          {images.length > 1 && (
            <View style={styles.indicatorContainer}>
              {images.map((_, index) => <TouchableOpacity key={index} onPress={() => scrollToImage(index)} style={[styles.indicator, index === selectedImageIndex && styles.indicatorActive]} />)}
            </View>
          )}
          {/* Back & Share floating */}
          <TouchableOpacity style={styles.floatBack} onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.floatShare} onPress={handleShare}>
            <Ionicons name="share-outline" size={20} color={palette.colors.text} />
          </TouchableOpacity>
        </View>

        {/* Product Info */}
        <View style={{ padding: spacing.md }}>
          <GlassPanel variant="card" style={styles.infoCard}>
            <Text style={styles.category}>{product.category}</Text>
            <Text style={styles.name}>{product.name}</Text>

            <View style={styles.ratingRow}>
              <View style={{ flexDirection: 'row', marginRight: spacing.sm }}>{renderStars(product.rating || 0)}</View>
              <Text style={styles.ratingText}>({product.numReviews || 0} reviews)</Text>
              <View style={styles.dot} />
              <Text style={[styles.stockText, product.stock > 0 ? { color: palette.colors.success } : { color: palette.colors.error }]}>
                {product.stock > 0 ? `In Stock (${product.stock})` : 'Out of Stock'}
              </Text>
            </View>

            <View style={styles.priceRow}>
              <Text style={styles.price}>{formatProductPrice(product, { field: product.discountedPrice ? 'discountedPrice' : 'price' })}</Text>
              {discountPercentage > 0 && (
                <>
                  <Text style={styles.originalPrice}>{formatProductPrice(product, { field: 'price' })}</Text>
                  <View style={styles.saveBadge}><Text style={styles.saveText}>Save {discountPercentage}%</Text></View>
                </>
              )}
            </View>

            <Text style={styles.description}>{product.description}</Text>

            {/* Dynamic Product Options (Size, Color, Material...) */}
            {product.optionGroups?.length > 0 ? (
              <View style={{ marginTop: spacing.md }}>
                {product.optionGroups.map((group) => (
                  <View key={group.name} style={styles.colorSection}>
                    <Text style={styles.colorLabel}>{group.name}: <Text style={{ color: palette.colors.text, fontWeight: fontWeight.semibold }}>{selectedOptions[group.name] || `Select ${group.name.toLowerCase()}`}</Text></Text>
                    <View style={styles.colorRow}>
                      {group.values.map((val) => {
                        const active = selectedOptions[group.name] === val;
                        return (
                          <TouchableOpacity key={val} onPress={() => setSelectedOptions(prev => ({ ...prev, [group.name]: active ? undefined : val }))}
                            style={[styles.colorChip, active && styles.colorChipActive]}>
                            <Text style={[styles.colorChipText, active && styles.colorChipTextActive]}>{val}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            ) : product.colors?.length > 0 && (
              <View style={styles.colorSection}>
                <Text style={styles.colorLabel}>Color: <Text style={{ color: palette.colors.text, fontWeight: fontWeight.semibold }}>{selectedColor || 'Select a color'}</Text></Text>
                <View style={styles.colorRow}>
                  {product.colors.map((color, i) => (
                    <TouchableOpacity key={i} onPress={() => setSelectedColor(color)}
                      style={[styles.colorChip, selectedColor === color && styles.colorChipActive]}>
                      <Text style={[styles.colorChipText, selectedColor === color && styles.colorChipTextActive]}>{color}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {product.tags?.length > 0 && (
              <View style={styles.tagsContainer}>
                {product.tags.map((tag, i) => <View key={i} style={styles.tag}><Text style={styles.tagText}>{tag}</Text></View>)}
              </View>
            )}
          </GlassPanel>

          {/* Store Card */}
          {storeData && (
            <GlassPanel variant="card" style={styles.storeCard}>
              <TouchableOpacity style={styles.storeRow} onPress={() => navigation.navigate('Store', { slug: storeData.storeSlug })}>
                {storeData.storeLogo ? <Image source={{ uri: storeData.storeLogo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} /> :
                  <View style={[styles.storeLogo, styles.storeLogoPlaceholder]}><Ionicons name="storefront" size={22} color="#fff" /></View>}
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={styles.storeName}>{storeData.storeName}</Text>
                    {storeData.isVerified && <VerifiedBadge size="sm" />}
                  </View>
                  <Text style={styles.storeStats}>{storeData.trustCount || 0} trusted · {storeData.productCount || 0} products</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            </GlassPanel>
          )}

          {/* Details */}
          <GlassPanel variant="card" style={styles.detailsSection}>
            <View style={styles.detailRow}><Text style={styles.detailLabel}>Category</Text><Text style={styles.detailValue}>{product.category}</Text></View>
            <View style={styles.detailRow}><Text style={styles.detailLabel}>Brand</Text><Text style={styles.detailValue}>{product.brand}</Text></View>
          </GlassPanel>

          {/* Reviews */}
          <GlassPanel variant="card" style={styles.reviewsSection}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <View><Text style={styles.reviewsTitle}>Customer Reviews</Text><Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>{product.numReviews || 0} reviews</Text></View>
              <TouchableOpacity style={styles.writeReviewBtn} onPress={() => { if (!currentUser) { navigation.navigate('Login'); return; } setReviewModalVisible(true); }}>
                <Ionicons name="create-outline" size={14} color="#fff" /><Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: '#fff' }}>Write</Text>
              </TouchableOpacity>
            </View>
            {product.reviews?.length > 0 ? product.reviews.slice(0, 5).map((review, i) => (
              <View key={i} style={styles.reviewCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                  <View style={styles.reviewAvatar}><Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#fff' }}>{(review.user?.name || 'U')[0].toUpperCase()}</Text></View>
                  <View style={{ flex: 1 }}><Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: palette.colors.text }}>{review.user?.name || 'Anonymous'}</Text>
                    <View style={{ flexDirection: 'row', gap: 2 }}>{[1,2,3,4,5].map(s => <Ionicons key={s} name={s <= review.rating ? 'star' : 'star-outline'} size={11} color={palette.colors.star} />)}</View>
                  </View>
                </View>
                <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, lineHeight: 18 }}>{review.comment}</Text>
              </View>
            )) : (
              <View style={{ alignItems: 'center', paddingVertical: spacing.xl }}>
                <Ionicons name="chatbubble-ellipses-outline" size={32} color="rgba(255,255,255,0.3)" />
                <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, marginTop: spacing.sm }}>No reviews yet. Be the first!</Text>
              </View>
            )}
          </GlassPanel>
        </View>
      </ScrollView>

      {/* Review Modal */}
      <Modal visible={reviewModalVisible} animationType="slide" transparent onRequestClose={() => setReviewModalVisible(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <GlassPanel variant="strong" style={styles.modalSheet}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text }}>Write a Review</Text>
              <TouchableOpacity onPress={() => setReviewModalVisible(false)} style={styles.modalClose}><Ionicons name="close" size={20} color={palette.colors.text} /></TouchableOpacity>
            </View>
            <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, marginBottom: spacing.lg }} numberOfLines={1}>{product.name}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md }}>
              {[1,2,3,4,5].map(s => <TouchableOpacity key={s} onPress={() => setReviewRating(s)}><Ionicons name={s <= reviewRating ? 'star' : 'star-outline'} size={34} color={palette.colors.star} /></TouchableOpacity>)}
            </View>
            <TextInput style={styles.reviewInput} value={reviewComment} onChangeText={setReviewComment} placeholder="Share your experience..." placeholderTextColor="rgba(255,255,255,0.3)" multiline numberOfLines={4} textAlignVertical="top" maxLength={500} />
            <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary, textAlign: 'right', marginBottom: spacing.md }}>{reviewComment.length}/500</Text>
            <TouchableOpacity style={[styles.submitReviewBtn, submittingReview && { opacity: 0.6 }]} onPress={handleSubmitReview} disabled={submittingReview}>
              {submittingReview ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="send" size={16} color="#fff" /><Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: '#fff' }}>Submit Review</Text></>}
            </TouchableOpacity>
          </GlassPanel>
        </KeyboardAvoidingView>
      </Modal>

      {/* Bottom Bar */}
      <Animated.View style={[styles.bottomBar, { transform: [{ translateY: bottomBarAnim.interpolate({ inputRange: [0, 1], outputRange: [100, 0] }) }] }]}>
        <GlassPanel variant="floating" style={styles.bottomBarInner}>
          <TouchableOpacity style={[styles.iconBtn, isInWishlist && { backgroundColor: 'rgba(239,68,68,0.15)' }]} onPress={handleWishlistToggle}>
            <Ionicons name={isInWishlist ? 'heart' : 'heart-outline'} size={22} color={isInWishlist ? palette.colors.heart : palette.colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={handleShare}>
            <Ionicons name="share-outline" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.addToCartBtn, product.stock === 0 && { backgroundColor: palette.glass.bg }, isInCart && { backgroundColor: palette.colors.successLight }]}
            onPress={handleAddToCartClick} disabled={product.stock === 0 || (isCartLoading && loadingProductId === productId)}>
            {isCartLoading && loadingProductId === productId ? <InlineLoader size="small" color="#fff" /> :
              product.stock === 0 ? <Text style={{ color: palette.colors.textSecondary, fontSize: fontSize.md }}>Out of Stock</Text> :
              isInCart ? <><Ionicons name="checkmark-circle" size={18} color={palette.colors.success} /><Text style={{ color: palette.colors.success, fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>Added to Cart</Text></> :
              <><Ionicons name="cart-outline" size={18} color="#fff" /><Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>Add to Cart</Text></>}
          </TouchableOpacity>
        </GlassPanel>
      </Animated.View>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  imageSection: { position: 'relative' },
  imageContainer: { width, height: 340, backgroundColor: 'rgba(255,255,255,0.05)' },
  mainImage: { width: '100%', height: '100%' },
  badgesContainer: { position: 'absolute', top: spacing.md, left: spacing.md, gap: 6 },
  featuredBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.colors.secondary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, gap: 4 },
  discountBadge: { backgroundColor: p.colors.error, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  indicatorContainer: { flexDirection: 'row', justifyContent: 'center', position: 'absolute', bottom: spacing.md, left: 0, right: 0, gap: 6 },
  indicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.4)' },
  indicatorActive: { backgroundColor: p.colors.primary, width: 24 },
  floatBack: { position: 'absolute', top: spacing.xl, left: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.85)', justifyContent: 'center', alignItems: 'center', ...shadows.sm },
  floatShare: { position: 'absolute', top: spacing.xl, right: spacing.md, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.85)', justifyContent: 'center', alignItems: 'center', ...shadows.sm },
  infoCard: { padding: spacing.lg, marginBottom: spacing.md },
  category: { fontSize: fontSize.xs, color: p.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  name: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.md },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, flexWrap: 'wrap' },
  ratingText: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  dot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', marginHorizontal: spacing.sm },
  stockText: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  price: { fontSize: 28, fontWeight: fontWeight.bold, color: p.colors.text },
  originalPrice: { fontSize: fontSize.lg, color: p.colors.textSecondary, textDecorationLine: 'line-through' },
  saveBadge: { backgroundColor: 'rgba(239,68,68,0.12)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  saveText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.error },
  description: { fontSize: fontSize.md, color: p.colors.textSecondary, lineHeight: 22, marginBottom: spacing.md },
  colorSection: { marginBottom: spacing.lg },
  colorLabel: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.sm },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  colorChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: p.glass.bgSubtle, borderWidth: 1.5, borderColor: p.glass.borderSubtle },
  colorChipActive: { borderColor: p.colors.primary, backgroundColor: 'rgba(99,102,241,0.12)' },
  colorChipText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  colorChipTextActive: { color: p.colors.primary },
  tagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { backgroundColor: 'rgba(99,102,241,0.1)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  tagText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.medium },
  storeCard: { padding: spacing.md, marginBottom: spacing.md },
  storeRow: { flexDirection: 'row', alignItems: 'center' },
  storeLogo: { width: 44, height: 44, borderRadius: 22, marginRight: spacing.md, backgroundColor: p.glass.bgSubtle },
  storeLogoPlaceholder: { backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  storeName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  storeStats: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  detailsSection: { padding: spacing.lg, marginBottom: spacing.md },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  detailLabel: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  detailValue: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: p.colors.text },
  reviewsSection: { padding: spacing.lg, marginBottom: spacing.md },
  reviewsTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  writeReviewBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: p.colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  reviewCard: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: spacing.md, marginBottom: spacing.md, borderWidth: 1, borderColor: p.glass.borderSubtle },
  reviewAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.xl, paddingBottom: spacing.xxxl },
  modalClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  reviewInput: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, borderWidth: 1, borderColor: p.glass.borderSubtle, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, minHeight: 100, marginBottom: 4 },
  submitReviewBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, borderRadius: 16, paddingVertical: 14, ...shadows.md },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing.md },
  bottomBarInner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  iconBtn: { width: 48, height: 48, borderRadius: 16, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  addToCartBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, borderRadius: 16, paddingVertical: 14, gap: spacing.sm },
});
