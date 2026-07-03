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
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader } from '../components/common';
import VerifiedBadge from '../components/VerifiedBadge';
import ProductCard from '../components/ProductCard';
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
  const { wishlistItems, handleAddToWishlist, handleDeleteFromWishlist, cartItems, handleAddToCart, handleQtyInc, handleQtyDec, qtyUpdateId, isCartLoading, loadingProductId } = useGlobal();
  const { formatProductPrice, formatPrice } = useCurrency();

  const [product, setProduct] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedColor, setSelectedColor] = useState(null);
  const [selectedOptions, setSelectedOptions] = useState({});
  const [storeData, setStoreData] = useState(null);
  const [availableCoupons, setAvailableCoupons] = useState([]);
  const [copiedCoupon, setCopiedCoupon] = useState(null);
  const [relatedProducts, setRelatedProducts] = useState([]);
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
  const cartLineItem = product && cartItems?.cart?.find((item) =>
    item.product?._id === product._id &&
    (item.selectedColor || null) === (selectedColor || null) &&
    optionsKeyOf(item.selectedOptions) === myOptKey
  );
  const isInCart = !!cartLineItem;

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
      const prod = res.data.product;
      setProduct(prod);
      const sellerId = typeof prod.seller === 'string' ? prod.seller : prod.seller?._id;
      if (sellerId) {
        try { const storeRes = await api.get(`/api/stores/seller/${sellerId}`); setStoreData(storeRes.data.store); } catch {}
        // Coupons applicable to this product (matches website behavior)
        try {
          const couponRes = await api.get(`/api/coupons/store/${sellerId}`);
          const coupons = (couponRes.data.coupons || []).filter(c =>
            c.applicableTo === 'all' || (c.applicableProducts || []).some(pid => (pid?._id || pid) === prod._id)
          );
          setAvailableCoupons(coupons);
        } catch { setAvailableCoupons([]); }
      }
      // Related products from the same category
      if (prod.category) {
        try {
          const relRes = await api.get(`/api/products/get-products?categories=${encodeURIComponent(prod.category)}&limit=6`);
          setRelatedProducts((relRes.data.products || []).filter(p => p._id !== prod._id).slice(0, 4));
        } catch { setRelatedProducts([]); }
      }
    } catch { Toast.show({ type: 'error', text1: 'Error', text2: 'Product not found' }); navigation.goBack(); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const copyCouponCode = async (code) => {
    await Clipboard.setStringAsync(code);
    setCopiedCoupon(code);
    Toast.show({ type: 'success', text1: 'Copied!', text2: 'Coupon code copied' });
    setTimeout(() => setCopiedCoupon(null), 2000);
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

  // Normalize images: accept string or {url} entries, drop values that aren't real URLs
  // (some legacy products store a text label in the image field)
  const isValidImageUri = (u) => typeof u === 'string' && /^(https?:|data:|file:)/.test(u);
  const rawImages = product.images?.length > 0 ? product.images : [product.image];
  const validImages = rawImages
    .map((img) => ({ url: typeof img === 'string' ? img : img?.url }))
    .filter((img) => isValidImageUri(img.url));
  const images = validImages.length > 0 ? validImages : [{ url: null }];

  return (
    <GlassBackground>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        {/* Image Gallery */}
        <View style={styles.imageSection}>
          <FlatList ref={flatListRef} data={images} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => setSelectedImageIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
            renderItem={({ item }) => (
              <View style={styles.imageContainer}>
                {item.url ? (
                  <Image source={{ uri: item.url }} style={styles.mainImage} contentFit="contain" cachePolicy="memory-disk" transition={200} />
                ) : (
                  <View style={[styles.mainImage, { justifyContent: 'center', alignItems: 'center' }]}>
                    <Ionicons name="image-outline" size={64} color={palette.colors.textLight} />
                  </View>
                )}
              </View>
            )}
            keyExtractor={(_, index) => index.toString()}
          />
          <View style={styles.badgesContainer}>
            {product.isFeatured && <View style={styles.featuredBadge}><Ionicons name="flash" size={12} color="#2563eb" /><Text style={styles.featuredBadgeText}>Featured</Text></View>}
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
                            {active && <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
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
                      {selectedColor === color && <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
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

            {/* Return & Warranty — matches website panel */}
            {(() => {
              const rp = product.returnPolicy?.useStorePolicy === false ? product.returnPolicy : storeData?.returnPolicy;
              if (!rp) {
                return (
                  <View style={styles.returnRow}>
                    <Ionicons name="refresh-outline" size={16} color={palette.colors.primary} />
                    <Text style={styles.returnRowText}>Contact seller for return policy</Text>
                  </View>
                );
              }
              const noneAtAll = !rp.returnsEnabled && (!rp.refundType || rp.refundType === 'none') && !rp.warrantyEnabled;
              return (
                <View style={styles.returnPanel}>
                  <Text style={styles.sectionLabelSmall}>RETURN & WARRANTY</Text>
                  <View style={styles.returnPillsRow}>
                    {rp.returnsEnabled ? (
                      <View style={[styles.returnPill, { backgroundColor: 'rgba(16,185,129,0.12)' }]}>
                        <Ionicons name="refresh-outline" size={12} color="#10b981" />
                        <Text style={[styles.returnPillText, { color: '#10b981' }]}>{rp.returnDuration}-Day Returns</Text>
                      </View>
                    ) : (
                      <View style={[styles.returnPill, { backgroundColor: 'rgba(239,68,68,0.1)' }]}>
                        <Text style={[styles.returnPillText, { color: palette.colors.error }]}>No Returns</Text>
                      </View>
                    )}
                    {rp.refundType && rp.refundType !== 'none' && (
                      <View style={[styles.returnPill, { backgroundColor: 'rgba(99,102,241,0.1)' }]}>
                        <Text style={[styles.returnPillText, { color: palette.colors.primary }]}>
                          {rp.refundType === 'full_refund' ? '💰 Full Refund' : rp.refundType === 'replacement_only' ? '🔄 Replacement Only' : '🎁 Store Credit'}
                        </Text>
                      </View>
                    )}
                    {rp.warrantyEnabled && (
                      <View style={[styles.returnPill, { backgroundColor: 'rgba(245,158,11,0.1)' }]}>
                        <Text style={[styles.returnPillText, { color: '#b45309' }]}>🛡️ {rp.warrantyDuration}-Month Warranty</Text>
                      </View>
                    )}
                    {noneAtAll && (
                      <View style={[styles.returnPill, { backgroundColor: 'rgba(107,114,128,0.1)' }]}>
                        <Text style={[styles.returnPillText, { color: palette.colors.textSecondary }]}>No returns, refunds, or warranty</Text>
                      </View>
                    )}
                  </View>
                  {rp.policyDescription ? <Text style={styles.returnDesc}>{rp.policyDescription}</Text> : null}
                  {rp.warrantyDescription ? <Text style={styles.returnDesc}>Warranty: {rp.warrantyDescription}</Text> : null}
                </View>
              );
            })()}

            {/* Available Coupons — matches website */}
            {availableCoupons.length > 0 && (
              <View style={{ marginTop: spacing.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: spacing.sm }}>
                  <Ionicons name="ticket-outline" size={13} color="#a855f7" />
                  <Text style={styles.sectionLabelSmall}>AVAILABLE COUPONS</Text>
                </View>
                {availableCoupons.map(coupon => (
                  <View key={coupon._id} style={styles.couponRow}>
                    <View style={styles.couponIconBox}><Ionicons name="ticket-outline" size={14} color="#a855f7" /></View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={styles.couponCode}>{coupon.code}</Text>
                        <View style={styles.couponOffBadge}>
                          <Text style={styles.couponOffText}>
                            {coupon.discountType === 'percentage' ? `${coupon.discountValue}% OFF` : `${formatPrice(coupon.discountValue, { sourceCurrency: coupon.currency || 'USD' })} OFF`}
                          </Text>
                        </View>
                      </View>
                      {coupon.description ? <Text style={styles.couponDesc} numberOfLines={1}>{coupon.description}</Text> : null}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 }}>
                        {coupon.minOrderAmount > 0 && <Text style={styles.couponMeta}>Min: {formatPrice(coupon.minOrderAmount, { sourceCurrency: coupon.currency || 'USD' })}</Text>}
                        <Text style={styles.couponMeta}>Expires {new Date(coupon.expiryDate).toLocaleDateString()}</Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={[styles.couponCopyBtn, copiedCoupon === coupon.code && { backgroundColor: 'rgba(16,185,129,0.15)' }]}
                      onPress={() => copyCouponCode(coupon.code)} activeOpacity={0.8}>
                      <Ionicons name={copiedCoupon === coupon.code ? 'checkmark' : 'copy-outline'} size={12} color={copiedCoupon === coupon.code ? '#10b981' : '#a855f7'} />
                      <Text style={[styles.couponCopyText, copiedCoupon === coupon.code && { color: '#10b981' }]}>
                        {copiedCoupon === coupon.code ? 'Copied' : 'Copy'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ))}
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
              <TouchableOpacity style={styles.writeReviewBtn} onPress={() => { if (!currentUser) { navigation.navigate('Login'); return; } setReviewModalVisible(true); }} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
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
                <Ionicons name="chatbubble-ellipses-outline" size={32} color={palette.colors.textLight} />
                <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, marginTop: spacing.sm }}>No reviews yet. Be the first!</Text>
              </View>
            )}
          </GlassPanel>

          {/* Related Products — matches website */}
          {relatedProducts.length > 0 && (
            <View style={{ marginBottom: spacing.md }}>
              <View style={styles.relatedHeader}>
                <Text style={styles.relatedTitle}>Related Products</Text>
                <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }} onPress={() => navigation.navigate('MainTabs', { screen: 'Home' })}>
                  <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: palette.colors.primary }}>View all</Text>
                  <Ionicons name="chevron-forward" size={14} color={palette.colors.primary} />
                </TouchableOpacity>
              </View>
              <View style={styles.relatedGrid}>
                {relatedProducts.map((p, idx) => (
                  <View key={p._id} style={styles.relatedItem}>
                    <ProductCard product={p} index={idx} onPress={() => navigation.push('ProductDetail', { productId: p._id })} />
                  </View>
                ))}
              </View>
            </View>
          )}
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
            <TextInput style={styles.reviewInput} value={reviewComment} onChangeText={setReviewComment} placeholder="Share your experience..." placeholderTextColor={palette.colors.grayLight} multiline numberOfLines={4} textAlignVertical="top" maxLength={500} />
            <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary, textAlign: 'right', marginBottom: spacing.md }}>{reviewComment.length}/500</Text>
            <TouchableOpacity style={[styles.submitReviewBtn, submittingReview && { opacity: 0.6 }]} onPress={handleSubmitReview} disabled={submittingReview} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
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
          {isInCart && cartLineItem ? (
            /* In-cart quantity stepper — matches website */
            <View style={styles.inCartStepper}>
              <TouchableOpacity
                style={styles.stepperBtn}
                onPress={() => handleQtyDec(cartLineItem._id)}
                disabled={qtyUpdateId === cartLineItem._id}
                accessibilityLabel="Decrease quantity"
              >
                <Ionicons name={cartLineItem.qty <= 1 ? 'close' : 'remove'} size={16} color={palette.colors.text} />
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="sparkles" size={13} color="#10b981" />
                <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: '#10b981' }}>In cart</Text>
                {qtyUpdateId === cartLineItem._id
                  ? <ActivityIndicator size="small" color={palette.colors.primary} />
                  : <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.text, minWidth: 22, textAlign: 'center' }}>{cartLineItem.qty}</Text>}
              </View>
              <TouchableOpacity
                onPress={() => handleQtyInc(cartLineItem._id)}
                disabled={qtyUpdateId === cartLineItem._id || cartLineItem.qty >= product.stock}
                accessibilityLabel="Increase quantity"
              >
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.stepperBtnGradient}>
                  <Ionicons name="add" size={16} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity style={[styles.addToCartBtn, product.stock === 0 && { backgroundColor: palette.glass.bg }]}
              onPress={handleAddToCartClick} disabled={product.stock === 0 || (isCartLoading && loadingProductId === productId)}>
              {product.stock > 0 && (
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              )}
              {isCartLoading && loadingProductId === productId ? <InlineLoader size="small" color="#fff" /> :
                product.stock === 0 ? <Text style={{ color: palette.colors.textSecondary, fontSize: fontSize.md }}>Out of Stock</Text> :
                <><Ionicons name="cart-outline" size={18} color="#fff" /><Text style={{ color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.semibold }}>Add to Cart</Text></>}
            </TouchableOpacity>
          )}
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
  // Below the floating back/share buttons so they never overlap
  badgesContainer: { position: 'absolute', top: spacing.xl + 48, left: spacing.md, gap: 6 },
  featuredBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20, gap: 4 },
  discountBadge: { backgroundColor: p.colors.error, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  featuredBadgeText: { color: '#2563eb', fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
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
  colorChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: p.glass.bgSubtle, borderWidth: 1.5, borderColor: p.glass.borderSubtle, overflow: 'hidden' },
  colorChipActive: { borderColor: 'transparent', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 4 },
  colorChipText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  colorChipTextActive: { color: '#fff', fontWeight: fontWeight.semibold },
  tagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { backgroundColor: 'rgba(56,189,248,0.1)', borderWidth: 1, borderColor: 'rgba(56,189,248,0.18)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  tagText: { fontSize: fontSize.sm, color: '#0284c7', fontWeight: fontWeight.medium },
  // Return & Warranty
  sectionLabelSmall: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary, letterSpacing: 1 },
  returnRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, borderRadius: 14, padding: spacing.md, marginTop: spacing.md },
  returnRowText: { fontSize: fontSize.sm, color: p.colors.text },
  returnPanel: { backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, borderRadius: 14, padding: spacing.md, marginTop: spacing.md },
  returnPillsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  returnPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999 },
  returnPillText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium },
  returnDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: spacing.sm, lineHeight: 16 },
  // Coupons
  couponRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, borderRadius: 14, padding: spacing.md, marginBottom: spacing.sm },
  couponIconBox: { width: 28, height: 28, borderRadius: 8, backgroundColor: 'rgba(168,85,247,0.1)', justifyContent: 'center', alignItems: 'center' },
  couponCode: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#a855f7', letterSpacing: 1.2 },
  couponOffBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(16,185,129,0.1)' },
  couponOffText: { fontSize: 10, fontWeight: fontWeight.semibold, color: '#10b981' },
  couponDesc: { fontSize: 10, color: p.colors.textSecondary, marginTop: 2 },
  couponMeta: { fontSize: 10, color: p.colors.textSecondary },
  couponCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(168,85,247,0.12)' },
  couponCopyText: { fontSize: 11, fontWeight: fontWeight.semibold, color: '#a855f7' },
  // Related products
  relatedHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md, paddingHorizontal: spacing.xs },
  relatedTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  relatedGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  relatedItem: { width: '49%', marginBottom: spacing.sm },
  // In-cart stepper (bottom bar)
  inCartStepper: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 16, paddingHorizontal: spacing.md, paddingVertical: 9, backgroundColor: 'rgba(16,185,129,0.1)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)' },
  stepperBtn: { width: 30, height: 30, borderRadius: 10, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, justifyContent: 'center', alignItems: 'center' },
  stepperBtnGradient: { width: 30, height: 30, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
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
  writeReviewBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, overflow: 'hidden' },
  reviewCard: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: spacing.md, marginBottom: spacing.md, borderWidth: 1, borderColor: p.glass.borderSubtle },
  reviewAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.xl, paddingBottom: spacing.xxxl },
  modalClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  reviewInput: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, borderWidth: 1, borderColor: p.glass.borderSubtle, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, minHeight: 100, marginBottom: 4 },
  submitReviewBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: 16, paddingVertical: 14, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  bottomBar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing.md },
  bottomBarInner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  iconBtn: { width: 48, height: 48, borderRadius: 16, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  addToCartBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 16, paddingVertical: 14, gap: spacing.sm, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 6 },
});
