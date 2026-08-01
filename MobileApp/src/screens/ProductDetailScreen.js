/**
 * ProductDetailScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  useWindowDimensions, FlatList, Share, Animated, Modal, TextInput,
  Platform, ActivityIndicator, RefreshControl,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import Feedback from '../utils/feedback';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader } from '../components/common';
import VerifiedBadge from '../components/VerifiedBadge';
import ProductCard from '../components/ProductCard';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumTopBar, { PremiumTopBarAction } from '../components/common/PremiumTopBar';
import { trackProductView } from '../utils/recentlyViewed';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const PRODUCT_TOPBAR_SHEEN = [
  'rgba(14,165,233,0.12)',
  'rgba(20,184,166,0.06)',
  'rgba(99,102,241,0.12)',
];

export default function ProductDetailScreen({ route, navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { width: viewportWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const contentWidth = Math.max(280, Math.min(viewportWidth - (spacing.md * 2), 720));
  // GlassPanel's width includes its 1px borders and spacing.sm padding.
  // Keep each native page exactly equal to the visible inner gallery width.
  const galleryWidth = Math.max(256, contentWidth - (spacing.sm * 2) - 2);
  const galleryHeight = Math.min(500, Math.max(300, galleryWidth * 0.78));
  // GlassBackground already accounts for Android's status bar.
  const topInset = Platform.OS === 'android' ? 0 : insets.top;

  const productId = route?.params?.productId;
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
  const [storeProductCount, setStoreProductCount] = useState(null);
  const [storePolicy, setStorePolicy] = useState(null);
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
  const allOptionsSelected = product?.optionGroups?.length
    ? product.optionGroups.every(g => selectedOptions[g.name])
    : (!product?.colors?.length || !!selectedColor);
  const isInWishlist = product && wishlistItems?.some((item) => item._id === product._id);
  const cartLineItem = product && cartItems?.cart?.find((item) =>
    item.product?._id === product._id &&
    (item.selectedColor || null) === (selectedColor || null) &&
    optionsKeyOf(item.selectedOptions) === myOptKey
  );
  const isInCart = !!cartLineItem;
  const cartCount = Array.isArray(cartItems?.cart)
    ? cartItems.cart.reduce((total, item) => total + (item.qty || 1), 0)
    : 0;

  const handleBack = useCallback(() => {
    if (navigation.canGoBack?.()) navigation.goBack();
    else navigation.navigate('MainTabs', { screen: 'Marketplace' });
  }, [navigation]);

  const handleOpenCart = useCallback(() => {
    navigation.navigate('MainTabs', { screen: 'Cart' });
  }, [navigation]);

  useEffect(() => {
    fetchProduct();
    if (productId) trackProductView(productId);
    Animated.spring(bottomBarAnim, { toValue: 1, friction: 8, tension: 40, useNativeDriver: true }).start();
  }, [productId]);

  const handleShare = async () => {
    if (!product) return;
    try { await Share.share({ message: `Check out ${product.name} on Rozare! ${formatProductPrice(product, { field: product.discountedPrice ? 'discountedPrice' : 'price' })}`, title: product.name }); } catch {}
  };

  const fetchProduct = async () => {
    setIsLoading(true);
    setStoreData(null);
    setStoreProductCount(null);
    try {
      const res = await api.get(`/api/products/get-single-product/${productId}`);
      const prod = res.data.product;
      setProduct(prod);
      setStorePolicy(res.data.storePolicy || null);
      const sellerId = typeof prod.seller === 'string' ? prod.seller : prod.seller?._id;
      if (sellerId) {
        try {
          const storeRes = await api.get(`/api/stores/seller/${sellerId}`);
          const fetchedStore = storeRes.data.store;
          setStoreData(fetchedStore);

          const fallbackCount = [
            fetchedStore?.productCount,
            fetchedStore?.productsCount,
            fetchedStore?.totalProducts,
          ]
            .map((value) => (
              value === null || value === undefined || value === ''
                ? Number.NaN
                : Number(value)
            ))
            .find(Number.isFinite);
          const storeSlug = fetchedStore?.storeSlug || fetchedStore?.slug;

          // The seller-store response does not consistently carry a catalog count.
          // Read the authoritative pagination total instead of showing a false zero.
          if (storeSlug) {
            try {
              const productsRes = await api.get(
                `/api/stores/${encodeURIComponent(storeSlug)}/products?page=1&limit=1`
              );
              const rawCatalogTotal = productsRes.data?.pagination?.total;
              const catalogTotal = rawCatalogTotal === null
                || rawCatalogTotal === undefined
                || rawCatalogTotal === ''
                ? Number.NaN
                : Number(rawCatalogTotal);
              setStoreProductCount(
                Number.isFinite(catalogTotal)
                  ? catalogTotal
                  : Number.isFinite(fallbackCount)
                    ? fallbackCount
                    : null
              );
            } catch {
              setStoreProductCount(Number.isFinite(fallbackCount) ? fallbackCount : null);
            }
          } else {
            setStoreProductCount(Number.isFinite(fallbackCount) ? fallbackCount : null);
          }
        } catch {
          setStoreData(null);
          setStoreProductCount(null);
        }
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
    } catch { Feedback.show({ type: 'error', text1: 'Error', text2: 'Product not found' }); handleBack(); }
    finally { setIsLoading(false); setRefreshing(false); }
  };

  const copyCouponCode = async (code) => {
    await Clipboard.setStringAsync(code);
    setCopiedCoupon(code);
    Feedback.show({ type: 'success', text1: 'Copied!', text2: 'Coupon code copied' });
    setTimeout(() => setCopiedCoupon(null), 2000);
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchProduct();
  }, [productId]);

  const discountPercentage = product?.discountedPrice && product.discountedPrice < product.price ? Math.round(((product.price - product.discountedPrice) / product.price) * 100) : 0;

  const handleWishlistToggle = () => { if (!currentUser) { navigation.navigate('Login'); return; } isInWishlist ? handleDeleteFromWishlist(product._id) : handleAddToWishlist(product._id); };
  const handleAddToCartClick = () => {
    if (!allOptionsSelected) { Feedback.show({ type: 'error', text1: 'Please select all options' }); return; }
    handleAddToCart(product._id, selectedColor, selectedOptions, product);
  };

  const handleAskAI = () => {
    if (!product) return;
    const price = formatProductPrice(product, {
      field: product.discountedPrice ? 'discountedPrice' : 'price',
    });
    const storeName = storeData?.storeName ? ` from ${storeData.storeName}` : '';
    const optionNames = product.optionGroups?.map((group) => group.name).filter(Boolean) || [];
    const optionsNote = optionNames.length
      ? ` It has ${optionNames.join(', ')} options.`
      : product.colors?.length
        ? ` It is available in ${product.colors.join(', ')}.`
        : '';
    navigation.navigate('AIChat', {
      role: 'user',
      productId: product._id,
      prompt: `I'm viewing "${product.name}"${storeName} for ${price}.${optionsNote} Help me decide if it suits my needs, explain the important details, and suggest alternatives if useful.`,
    });
  };

  const handleSubmitReview = async () => {
    if (!currentUser) { navigation.navigate('Login'); return; }
    if (!reviewComment.trim()) { Feedback.show({ type: 'error', text1: 'Error', text2: 'Please write a comment' }); return; }
    setSubmittingReview(true);
    try {
      await api.post(`/api/products/add-review/${productId}`, { rating: reviewRating, comment: reviewComment.trim() });
      Feedback.show({ type: 'success', text1: 'Review Submitted!' }); setReviewModalVisible(false); setReviewComment(''); setReviewRating(5); fetchProduct();
    } catch (error) { Feedback.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed' }); }
    finally { setSubmittingReview(false); }
  };

  const scrollToImage = (index) => {
    setSelectedImageIndex(index);
    flatListRef.current?.scrollToIndex({ index, animated: true });
  };

  const updateGalleryIndex = (offsetX, imageCount) => {
    const lastIndex = Math.max(0, imageCount - 1);
    const nextIndex = Math.max(
      0,
      Math.min(lastIndex, Math.round(offsetX / galleryWidth))
    );
    setSelectedImageIndex(nextIndex);
  };

  const renderStars = (rating) => {
    const stars = []; const full = Math.floor(rating); const half = rating % 1 >= 0.5;
    for (let i = 0; i < 5; i++) {
      if (i < full) stars.push(<Ionicons key={i} name="star" size={16} color={palette.colors.star} />);
      else if (i === full && half) stars.push(<Ionicons key={i} name="star-half" size={16} color={palette.colors.star} />);
      else stars.push(<Ionicons key={i} name="star-outline" size={16} color={palette.colors.star} />);
    }
    return stars;
  };

  const topBar = (
    <PremiumTopBar
      title="Product details"
      subtitle={product?.name || 'A closer look before you buy'}
      icon="bag-handle"
      onBack={handleBack}
      sheenColors={PRODUCT_TOPBAR_SHEEN}
      style={[styles.topBar, { width: contentWidth }]}
      right={(
        <>
          <PremiumTopBarAction
            icon="bag-outline"
            onPress={handleOpenCart}
            accessibilityLabel={`Open cart with ${cartCount} ${cartCount === 1 ? 'item' : 'items'}`}
            badge={cartCount}
          />
          <PremiumTopBarAction
            icon="share-social-outline"
            onPress={handleShare}
            accessibilityLabel="Share product"
            disabled={!product}
          />
        </>
      )}
    />
  );

  if (isLoading && !product) {
    return (
      <GlassBackground>
        <View style={[styles.screen, { paddingTop: topInset }]}>
          {topBar}
          <View style={styles.loadingState}>
            <Loader size="large" text="Preparing product details..." />
          </View>
        </View>
      </GlassBackground>
    );
  }

  if (!product) {
    return (
      <GlassBackground>
        <View style={[styles.screen, { paddingTop: topInset }]}>
          {topBar}
          <View style={styles.missingState}>
            <View style={styles.missingIcon}>
              <Ionicons name="bag-remove-outline" size={36} color={palette.colors.primary} />
            </View>
            <Text style={styles.missingTitle}>Product unavailable</Text>
            <Text style={styles.missingText}>This item may have moved or is no longer available.</Text>
            <TouchableOpacity style={styles.missingButton} onPress={() => navigation.navigate('MainTabs', { screen: 'Marketplace' })} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              <Ionicons name="storefront-outline" size={17} color="#fff" />
              <Text style={styles.missingButtonText}>Browse marketplace</Text>
            </TouchableOpacity>
          </View>
        </View>
      </GlassBackground>
    );
  }

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
      <View style={[styles.screen, { paddingTop: topInset }]}>
        {topBar}
        <ScrollView
          style={styles.scroll}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 154 + Math.max(insets.bottom, spacing.sm) }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        >
        {/* Premium media gallery */}
        <GlassPanel variant="strong" style={[styles.galleryCard, { width: contentWidth }]}>
          <View style={[styles.imageSection, { width: galleryWidth, height: galleryHeight }]}>
            <LinearGradient
              colors={['rgba(255,255,255,0.10)', 'rgba(99,102,241,0.05)', 'rgba(14,165,233,0.08)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <FlatList
              key={`product-gallery-${product._id}-${galleryWidth}`}
              ref={flatListRef}
              data={images}
              horizontal
              pagingEnabled
              nestedScrollEnabled
              directionalLockEnabled
              disableIntervalMomentum
              decelerationRate="fast"
              snapToInterval={galleryWidth}
              snapToAlignment="start"
              scrollEnabled={images.length > 1}
              style={{ width: galleryWidth }}
              contentContainerStyle={styles.galleryTrack}
              showsHorizontalScrollIndicator={false}
              removeClippedSubviews={false}
              scrollEventThrottle={16}
              getItemLayout={(_, index) => ({ length: galleryWidth, offset: galleryWidth * index, index })}
              onScrollEndDrag={(e) => updateGalleryIndex(e.nativeEvent.contentOffset.x, images.length)}
              onMomentumScrollEnd={(e) => updateGalleryIndex(e.nativeEvent.contentOffset.x, images.length)}
              onScrollToIndexFailed={({ index }) => {
                flatListRef.current?.scrollToOffset({
                  offset: index * galleryWidth,
                  animated: true,
                });
              }}
              renderItem={({ item }) => (
                <View style={[styles.imageContainer, { width: galleryWidth, height: galleryHeight }]}>
                  {item.url ? (
                    <Image source={{ uri: item.url }} style={styles.mainImage} contentFit="contain" cachePolicy="memory-disk" transition={200} />
                  ) : (
                    <View style={[styles.mainImage, styles.imagePlaceholder]}>
                      <Ionicons name="image-outline" size={64} color={palette.colors.textLight} />
                      <Text style={styles.imagePlaceholderText}>Product image unavailable</Text>
                    </View>
                  )}
                </View>
              )}
              keyExtractor={(_, index) => index.toString()}
            />
            <View style={styles.badgesContainer}>
              {product.isFeatured && (
                <View style={styles.featuredBadge}>
                  <Ionicons name="flash" size={12} color="#2563eb" />
                  <Text style={styles.featuredBadgeText}>Featured</Text>
                </View>
              )}
              {discountPercentage > 0 && (
                <View style={styles.discountBadge}>
                  <Text style={styles.badgeText}>Save {discountPercentage}%</Text>
                </View>
              )}
            </View>
            <View style={styles.imageCountPill}>
              <Ionicons name="images-outline" size={12} color={palette.colors.text} />
              <Text style={styles.imageCountText}>{selectedImageIndex + 1}/{images.length}</Text>
            </View>
            {images.length > 1 && (
              <View style={styles.indicatorContainer}>
                {images.map((_, index) => (
                  <TouchableOpacity
                    key={index}
                    onPress={() => scrollToImage(index)}
                    style={[styles.indicator, index === selectedImageIndex && styles.indicatorActive]}
                    accessibilityRole="button"
                    accessibilityLabel={`Show product image ${index + 1}`}
                    hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                  />
                ))}
              </View>
            )}
          </View>
        </GlassPanel>

        {/* Product Info */}
        <View style={[styles.contentColumn, { width: contentWidth }]}>
          <GlassPanel variant="card" style={styles.infoCard}>
            <View style={styles.eyebrowRow}>
              <View style={styles.categoryPill}>
                <Ionicons name="pricetag-outline" size={12} color={palette.colors.primary} />
                <Text style={styles.category}>{product.category}</Text>
              </View>
              {!!product.brand && <Text style={styles.brandText}>{product.brand}</Text>}
            </View>
            <Text style={styles.name}>{product.name}</Text>

            <View style={styles.ratingRow}>
              <View style={styles.ratingPill}>
                <View style={styles.starRow}>{renderStars(product.rating || 0)}</View>
                <Text style={styles.ratingText}>{Number(product.rating || 0).toFixed(1)}</Text>
                <Text style={styles.reviewCount}>· {product.numReviews || 0} reviews</Text>
              </View>
              <View style={[
                styles.stockPill,
                { backgroundColor: product.stock > 0 ? `${palette.colors.success}14` : `${palette.colors.error}14` },
              ]}>
                <View style={[styles.stockDot, { backgroundColor: product.stock > 0 ? palette.colors.success : palette.colors.error }]} />
                <Text style={[styles.stockText, { color: product.stock > 0 ? palette.colors.success : palette.colors.error }]}>
                  {product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'}
                </Text>
              </View>
            </View>

            <View style={styles.priceRow}>
              <View>
                <Text style={styles.priceLabel}>YOUR PRICE</Text>
                <Text style={styles.price}>{formatProductPrice(product, { field: product.discountedPrice ? 'discountedPrice' : 'price' })}</Text>
              </View>
              {discountPercentage > 0 && (
                <View style={styles.priceSavings}>
                  <Text style={styles.originalPrice}>{formatProductPrice(product, { field: 'price' })}</Text>
                  <View style={styles.saveBadge}><Text style={styles.saveText}>Save {discountPercentage}%</Text></View>
                </View>
              )}
            </View>

            {!!product.description && (
              <View style={styles.descriptionBlock}>
                <Text style={styles.sectionLabelSmall}>ABOUT THIS ITEM</Text>
                <Text style={styles.description}>{product.description}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.aiAssistButton}
              onPress={handleAskAI}
              activeOpacity={0.84}
              accessibilityRole="button"
              accessibilityLabel={`Ask Rozare AI about ${product.name}`}
            >
              <LinearGradient
                colors={['rgba(20,184,166,0.16)', 'rgba(14,165,233,0.12)', 'rgba(99,102,241,0.16)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.aiAssistIcon}>
                <Ionicons name="sparkles" size={18} color="#fff" />
              </LinearGradient>
              <View style={styles.aiAssistCopy}>
                <Text style={styles.aiAssistTitle}>Ask AI about this</Text>
                <Text style={styles.aiAssistText}>Compare, check the fit, or find an alternative</Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={palette.colors.primary} />
            </TouchableOpacity>

            <View style={styles.confidencePanel}>
              <View style={styles.confidenceRow}>
                <View style={[styles.confidenceIcon, { backgroundColor: `${palette.colors.success}14` }]}>
                  <Ionicons name="shield-checkmark-outline" size={18} color={palette.colors.success} />
                </View>
                <View style={styles.confidenceCopy}>
                  <Text style={styles.confidenceTitle}>Confident checkout</Text>
                  <Text style={styles.confidenceText}>Live stock, secure payment, and seller-backed policies.</Text>
                </View>
              </View>
              <View style={styles.confidenceDivider} />
              <View style={styles.confidenceRow}>
                <View style={[styles.confidenceIcon, { backgroundColor: 'rgba(34,197,94,0.12)' }]}>
                  <Ionicons name="logo-whatsapp" size={18} color="#22C55E" />
                </View>
                <View style={styles.confidenceCopy}>
                  <Text style={styles.confidenceTitle}>Updates wherever you are</Text>
                  <Text style={styles.confidenceText}>Follow every order in the app, plus WhatsApp updates when connected.</Text>
                </View>
              </View>
            </View>

            <View style={styles.policyPanel}>
              <View style={styles.policyHeading}>
                <View style={styles.policyIcon}>
                  <Ionicons
                    name={(storePolicy?.paymentPolicy || storeData?.paymentPolicy) === 'advance_only' ? 'card-outline' : 'cash-outline'}
                    size={18}
                    color={(storePolicy?.paymentPolicy || storeData?.paymentPolicy) === 'advance_only' ? palette.colors.primary : palette.colors.success}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionLabelSmall}>PAYMENT AVAILABILITY</Text>
                  <Text style={styles.policyTitle}>
                    {(storePolicy?.paymentPolicy || storeData?.paymentPolicy) === 'advance_only'
                      ? 'Online payment only'
                      : 'Online payment or Cash on Delivery'}
                  </Text>
                </View>
              </View>
              <Text style={styles.policyDescription}>
                {(storePolicy?.paymentPolicy || storeData?.paymentPolicy) === 'advance_only'
                  ? 'Pay online by card or Rozare Wallet. Cash on Delivery is unavailable.'
                  : 'Pay by card or Rozare Wallet, or pay when this product is delivered.'}
              </Text>
            </View>

            {/* Dynamic Product Options (Size, Color, Material...) */}
            {product.optionGroups?.length > 0 ? (
              <View style={styles.optionsBlock}>
                <View style={styles.sectionTitleRow}>
                  <View style={styles.sectionIcon}>
                    <Ionicons name="options-outline" size={16} color={palette.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sectionTitle}>Choose your options</Text>
                    <Text style={styles.sectionSubtitle}>Select each option before adding to cart</Text>
                  </View>
                </View>
                {product.optionGroups.map((group) => (
                  <View key={group.name} style={styles.colorSection}>
                    <Text style={styles.colorLabel}>{group.name}: <Text style={{ color: palette.colors.text, fontWeight: fontWeight.semibold }}>{selectedOptions[group.name] || `Select ${group.name.toLowerCase()}`}</Text></Text>
                    <View style={styles.colorRow}>
                      {group.values.map((val) => {
                        const active = selectedOptions[group.name] === val;
                        return (
                          <TouchableOpacity key={val} onPress={() => setSelectedOptions(prev => ({ ...prev, [group.name]: active ? undefined : val }))}
                            style={[styles.colorChip, active && styles.colorChipActive]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={`${group.name}: ${val}`}>
                            {active && <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
                            {active && <Ionicons name="checkmark-circle" size={14} color="#fff" />}
                            <Text style={[styles.colorChipText, active && styles.colorChipTextActive]}>{val}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                ))}
              </View>
            ) : product.colors?.length > 0 && (
              <View style={styles.optionsBlock}>
                <View style={styles.sectionTitleRow}>
                  <View style={styles.sectionIcon}>
                    <Ionicons name="color-palette-outline" size={16} color={palette.colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sectionTitle}>Choose a color</Text>
                    <Text style={styles.sectionSubtitle}>Select one before adding to cart</Text>
                  </View>
                </View>
                <View style={styles.colorSection}>
                <Text style={styles.colorLabel}>Color: <Text style={{ color: palette.colors.text, fontWeight: fontWeight.semibold }}>{selectedColor || 'Select a color'}</Text></Text>
                <View style={styles.colorRow}>
                  {product.colors.map((color, i) => (
                    <TouchableOpacity key={i} onPress={() => setSelectedColor(color)}
                      style={[styles.colorChip, selectedColor === color && styles.colorChipActive]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: selectedColor === color }}
                      accessibilityLabel={`Color: ${color}`}>
                      {selectedColor === color && <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
                      {selectedColor === color && <Ionicons name="checkmark-circle" size={14} color="#fff" />}
                      <Text style={[styles.colorChipText, selectedColor === color && styles.colorChipTextActive]}>{color}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
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
              const rp = product.returnPolicy?.useStorePolicy === false
                ? product.returnPolicy
                : (storePolicy?.returnPolicy || storeData?.returnPolicy);
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
                          {rp.refundType === 'full_refund' ? 'Full Refund to Rozare Wallet' : rp.refundType === 'replacement_only' ? 'Replacement Only' : 'Rozare Wallet Credit'}
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
              <TouchableOpacity
                style={styles.storeRow}
                onPress={() => navigation.navigate('Store', { slug: storeData.storeSlug })}
                activeOpacity={0.82}
                accessibilityRole="button"
                accessibilityLabel={`Visit ${storeData.storeName}`}
              >
                {(storeData.storeLogo || storeData.logo) ? <Image source={{ uri: storeData.storeLogo || storeData.logo }} style={styles.storeLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} /> :
                  <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.storeLogo, styles.storeLogoPlaceholder]}><Ionicons name="storefront" size={22} color="#fff" /></LinearGradient>}
                <View style={styles.storeCopy}>
                  <Text style={styles.storeEyebrow}>SOLD BY</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={styles.storeName} numberOfLines={1}>{storeData.storeName}</Text>
                    {(storeData.isVerified || storeData.verification?.isVerified) && <VerifiedBadge size="sm" />}
                  </View>
                  <Text style={styles.storeStats}>
                    {storeData.trustCount || 0} trusted {'\u00B7'}{' '}
                    {Number.isFinite(storeProductCount)
                      ? `${storeProductCount} ${storeProductCount === 1 ? 'product' : 'products'}`
                      : 'Catalog available'}
                  </Text>
                </View>
                <View style={styles.storeArrow}>
                  <Ionicons name="chevron-forward" size={18} color={palette.colors.primary} />
                </View>
              </TouchableOpacity>
            </GlassPanel>
          )}

          {/* Details */}
          <GlassPanel variant="card" style={styles.detailsSection}>
            <View style={styles.sectionTitleRow}>
              <View style={styles.sectionIcon}>
                <Ionicons name="information-circle-outline" size={17} color={palette.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Product details</Text>
                <Text style={styles.sectionSubtitle}>The essentials at a glance</Text>
              </View>
            </View>
            <View style={styles.detailRow}><Text style={styles.detailLabel}>Category</Text><Text style={styles.detailValue}>{product.category}</Text></View>
            <View style={styles.detailRow}><Text style={styles.detailLabel}>Brand</Text><Text style={styles.detailValue}>{product.brand}</Text></View>
          </GlassPanel>

          {/* Reviews */}
          <GlassPanel variant="card" style={styles.reviewsSection}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <View><Text style={styles.reviewsTitle}>Customer Reviews</Text><Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>{product.numReviews || 0} reviews</Text></View>
              <TouchableOpacity
                style={styles.writeReviewBtn}
                onPress={() => { if (!currentUser) { navigation.navigate('Login'); return; } setReviewModalVisible(true); }}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Write a product review"
              >
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
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <GlassPanel variant="strong" style={styles.modalSheet}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md }}>
              <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text }}>Write a Review</Text>
              <TouchableOpacity
                onPress={() => setReviewModalVisible(false)}
                style={styles.modalClose}
                accessibilityRole="button"
                accessibilityLabel="Close review form"
              >
                <Ionicons name="close" size={20} color={palette.colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, marginBottom: spacing.lg }} numberOfLines={1}>{product.name}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md }}>
              {[1,2,3,4,5].map(s => (
                <TouchableOpacity
                  key={s}
                  onPress={() => setReviewRating(s)}
                  accessibilityRole="button"
                  accessibilityLabel={`${s} star rating`}
                  accessibilityState={{ selected: reviewRating === s }}
                >
                  <Ionicons name={s <= reviewRating ? 'star' : 'star-outline'} size={34} color={palette.colors.star} />
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              style={styles.reviewInput}
              value={reviewComment}
              onChangeText={setReviewComment}
              placeholder="Share your experience..."
              placeholderTextColor={palette.colors.grayLight}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={500}
              accessibilityLabel="Review comment"
            />
            <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary, textAlign: 'right', marginBottom: spacing.md }}>{reviewComment.length}/500</Text>
            <TouchableOpacity
              style={[styles.submitReviewBtn, submittingReview && { opacity: 0.6 }]}
              onPress={handleSubmitReview}
              disabled={submittingReview}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Submit review"
              accessibilityState={{ disabled: submittingReview, busy: submittingReview }}
            >
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              {submittingReview ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="send" size={16} color="#fff" /><Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: '#fff' }}>Submit Review</Text></>}
            </TouchableOpacity>
          </GlassPanel>
        </KeyboardAvoidingView>
      </Modal>

      {/* Safe-area-aware persistent purchase controls */}
      <Animated.View
        style={[
          styles.bottomBar,
          {
            transform: [{
              translateY: bottomBarAnim.interpolate({ inputRange: [0, 1], outputRange: [100, 0] }),
            }],
          },
        ]}
      >
        <GlassPanel variant="floating" style={[styles.bottomBarInner, { width: contentWidth }]}>
          <TouchableOpacity
            style={[
              styles.favoriteDockButton,
              isInWishlist && styles.favoriteDockButtonActive,
            ]}
            onPress={handleWishlistToggle}
            activeOpacity={0.82}
            accessibilityRole="button"
            accessibilityLabel={isInWishlist ? 'Remove from wishlist' : 'Add to wishlist'}
            accessibilityState={{ selected: !!isInWishlist }}
          >
            <Ionicons
              name={isInWishlist ? 'heart' : 'heart-outline'}
              size={23}
              color={isInWishlist ? palette.colors.heart : palette.colors.text}
            />
          </TouchableOpacity>
          {isInCart && cartLineItem ? (
            <View style={styles.inCartStepper}>
              <TouchableOpacity
                style={styles.stepperBtn}
                onPress={() => handleQtyDec(cartLineItem._id)}
                disabled={qtyUpdateId === cartLineItem._id}
                accessibilityRole="button"
                accessibilityLabel="Decrease quantity"
                accessibilityState={{ disabled: qtyUpdateId === cartLineItem._id }}
                hitSlop={{ top: 5, bottom: 5, left: 5, right: 5 }}
              >
                <Ionicons name={cartLineItem.qty <= 1 ? 'close' : 'remove'} size={16} color={palette.colors.text} />
              </TouchableOpacity>
              <View style={styles.inCartStatus}>
                <Text style={styles.inCartLabel}>IN CART</Text>
                {qtyUpdateId === cartLineItem._id
                  ? <ActivityIndicator size="small" color={palette.colors.primary} />
                  : <Text style={styles.inCartQuantity}>{cartLineItem.qty}</Text>}
              </View>
              <TouchableOpacity
                onPress={() => handleQtyInc(cartLineItem._id)}
                disabled={qtyUpdateId === cartLineItem._id || cartLineItem.qty >= product.stock}
                accessibilityRole="button"
                accessibilityLabel="Increase quantity"
                accessibilityState={{ disabled: qtyUpdateId === cartLineItem._id || cartLineItem.qty >= product.stock }}
                hitSlop={{ top: 5, bottom: 5, left: 5, right: 5 }}
              >
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.stepperBtnGradient}>
                  <Ionicons name="add" size={16} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.addToCartBtn, product.stock === 0 && styles.addToCartBtnDisabled]}
              onPress={handleAddToCartClick}
              disabled={product.stock === 0 || (isCartLoading && loadingProductId === productId)}
              activeOpacity={0.86}
              accessibilityRole="button"
              accessibilityLabel={
                product.stock === 0
                  ? 'Out of stock'
                  : allOptionsSelected
                    ? `Add ${product.name} to cart`
                    : 'Choose product options'
              }
              accessibilityState={{
                disabled: product.stock === 0 || (isCartLoading && loadingProductId === productId),
                busy: isCartLoading && loadingProductId === productId,
              }}
            >
              {product.stock > 0 && (
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              )}
              {isCartLoading && loadingProductId === productId
                ? <InlineLoader size="small" color="#fff" />
                : product.stock === 0
                  ? (
                    <>
                      <Ionicons name="alert-circle-outline" size={18} color={palette.colors.textSecondary} />
                      <Text style={styles.addToCartDisabledText}>Out of stock</Text>
                    </>
                  )
                  : (
                    <>
                      <Ionicons name={allOptionsSelected ? 'bag-add-outline' : 'options-outline'} size={18} color="#fff" />
                      <Text style={styles.addToCartText}>{allOptionsSelected ? 'Add to cart' : 'Choose options'}</Text>
                      <Ionicons name="arrow-forward" size={16} color="rgba(255,255,255,0.9)" />
                    </>
                  )}
            </TouchableOpacity>
          )}
        </GlassPanel>
      </Animated.View>
      </View>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  screen: {
    flex: 1,
  },
  topBar: {
    alignSelf: 'center',
    marginHorizontal: 0,
    zIndex: 10,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  missingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl,
  },
  missingIcon: {
    width: 76,
    height: 76,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
    marginBottom: spacing.lg,
    ...shadows.md,
  },
  missingTitle: {
    color: p.colors.text,
    fontSize: fontSize.xxxl,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  missingText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  missingButton: {
    minHeight: 48,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 6,
  },
  missingButtonText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingTop: spacing.sm,
  },
  galleryCard: {
    padding: spacing.sm,
    borderRadius: 28,
    marginBottom: spacing.md,
  },
  imageSection: {
    position: 'relative',
    overflow: 'hidden',
    alignSelf: 'center',
    borderRadius: 22,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  galleryTrack: {
    alignItems: 'stretch',
  },
  imageContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainImage: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  imagePlaceholderText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  badgesContainer: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    gap: 6,
    alignItems: 'flex-start',
  },
  featuredBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    gap: 4,
    ...shadows.sm,
  },
  discountBadge: {
    backgroundColor: p.colors.error,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    ...shadows.sm,
  },
  featuredBadgeText: {
    color: p.colors.infoDark,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  badgeText: {
    color: '#fff',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  imageCountPill: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    minHeight: 28,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    ...shadows.sm,
  },
  imageCountText: {
    color: p.colors.text,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  indicatorContainer: {
    position: 'absolute',
    bottom: spacing.md,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  indicatorActive: {
    width: 26,
    backgroundColor: p.colors.primary,
    borderColor: p.colors.primary,
  },
  contentColumn: {
    alignSelf: 'center',
  },
  infoCard: {
    padding: spacing.xl,
    borderRadius: borderRadius.xxxl,
    marginBottom: spacing.md,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  categoryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  category: {
    fontSize: fontSize.xs,
    color: p.colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: fontWeight.bold,
  },
  brandText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  name: {
    fontSize: fontSize.xxxl,
    lineHeight: 30,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.55,
    color: p.colors.text,
    marginBottom: spacing.md,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  ratingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  starRow: {
    flexDirection: 'row',
    gap: 1,
  },
  ratingText: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  reviewCount: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  stockPill: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: borderRadius.full,
  },
  stockDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  stockText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: p.glass.borderSubtle,
  },
  priceLabel: {
    color: p.colors.textSecondary,
    fontSize: 9,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.3,
    marginBottom: 3,
  },
  price: {
    fontSize: fontSize.title,
    lineHeight: 33,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.8,
    color: p.colors.text,
  },
  priceSavings: {
    alignItems: 'flex-end',
    gap: 4,
  },
  originalPrice: {
    fontSize: fontSize.md,
    color: p.colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  saveBadge: {
    backgroundColor: p.colors.errorSubtle,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  saveText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: p.colors.error,
  },
  descriptionBlock: {
    paddingTop: spacing.lg,
  },
  sectionLabelSmall: {
    fontSize: 9,
    fontWeight: fontWeight.bold,
    color: p.colors.textSecondary,
    letterSpacing: 1.15,
  },
  description: {
    fontSize: fontSize.md,
    color: p.colors.textSecondary,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  aiAssistButton: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    marginTop: spacing.lg,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: p.glass.border,
    overflow: 'hidden',
  },
  aiAssistIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 4,
  },
  aiAssistCopy: {
    flex: 1,
    minWidth: 0,
  },
  aiAssistTitle: {
    color: p.colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  aiAssistText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 16,
    marginTop: 2,
  },
  confidencePanel: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.xxl,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  confidenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  confidenceIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confidenceCopy: {
    flex: 1,
    minWidth: 0,
  },
  confidenceTitle: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  confidenceText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 16,
    marginTop: 2,
  },
  confidenceDivider: {
    height: 1,
    backgroundColor: p.glass.borderSubtle,
    marginVertical: spacing.md,
    marginLeft: 50,
  },
  policyPanel: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.xxl,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  policyHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  policyIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
  },
  policyTitle: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
  policyDescription: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 17,
    marginTop: spacing.sm,
    marginLeft: 50,
  },
  optionsBlock: {
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: p.glass.borderSubtle,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  sectionIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  sectionTitle: {
    color: p.colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  sectionSubtitle: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 16,
    marginTop: 1,
  },
  colorSection: {
    marginBottom: spacing.lg,
  },
  colorLabel: {
    fontSize: fontSize.sm,
    color: p.colors.textSecondary,
    marginBottom: spacing.sm,
  },
  colorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  colorChip: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    overflow: 'hidden',
  },
  colorChipActive: {
    borderColor: 'transparent',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 9,
    elevation: 4,
  },
  colorChipText: {
    fontSize: fontSize.sm,
    color: p.colors.textSecondary,
    fontWeight: fontWeight.semibold,
  },
  colorChipTextActive: {
    color: '#fff',
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  tag: {
    backgroundColor: p.colors.infoSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
  },
  tagText: {
    fontSize: fontSize.xs,
    color: p.colors.infoDark,
    fontWeight: fontWeight.semibold,
  },
  returnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  returnRowText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: p.colors.text,
  },
  returnPanel: {
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  returnPillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  returnPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  returnPillText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  returnDesc: {
    fontSize: fontSize.xs,
    color: p.colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 17,
  },
  couponRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  couponIconBox: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: p.colors.secondarySubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  couponCode: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: p.colors.accent,
    letterSpacing: 1.1,
  },
  couponOffBadge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 7,
    backgroundColor: p.colors.successSubtle,
  },
  couponOffText: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: p.colors.success,
  },
  couponDesc: {
    fontSize: 10,
    color: p.colors.textSecondary,
    marginTop: 3,
  },
  couponMeta: {
    fontSize: 10,
    color: p.colors.textSecondary,
  },
  couponCopyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: p.colors.secondarySubtle,
  },
  couponCopyText: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: p.colors.accent,
  },
  storeCard: {
    padding: spacing.md,
    borderRadius: borderRadius.xxxl,
    marginBottom: spacing.md,
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  storeLogo: {
    width: 50,
    height: 50,
    borderRadius: 17,
    marginRight: spacing.md,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  storeLogoPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  storeCopy: {
    flex: 1,
    minWidth: 0,
  },
  storeEyebrow: {
    color: p.colors.textSecondary,
    fontSize: 9,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.1,
    marginBottom: 2,
  },
  storeName: {
    flexShrink: 1,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: p.colors.text,
  },
  storeStats: {
    fontSize: fontSize.xs,
    color: p.colors.textSecondary,
    marginTop: 3,
  },
  storeArrow: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    marginLeft: spacing.sm,
  },
  detailsSection: {
    padding: spacing.lg,
    borderRadius: borderRadius.xxxl,
    marginBottom: spacing.md,
  },
  detailRow: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: p.glass.borderSubtle,
  },
  detailLabel: {
    fontSize: fontSize.sm,
    color: p.colors.textSecondary,
  },
  detailValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: p.colors.text,
  },
  reviewsSection: {
    padding: spacing.lg,
    borderRadius: borderRadius.xxxl,
    marginBottom: spacing.md,
  },
  reviewsTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
    letterSpacing: -0.25,
  },
  writeReviewBtn: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  reviewCard: {
    backgroundColor: p.glass.bgSubtle,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  reviewAvatar: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: p.colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  relatedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  relatedTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
    letterSpacing: -0.3,
  },
  relatedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  relatedItem: {
    width: '49%',
    marginBottom: spacing.sm,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: p.colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  modalClose: {
    width: 38,
    height: 38,
    borderRadius: 13,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reviewInput: {
    backgroundColor: p.glass.bgSubtle,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    padding: spacing.md,
    fontSize: fontSize.md,
    color: p.colors.text,
    minHeight: 112,
    marginBottom: 4,
  },
  submitReviewBtn: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 6,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bottomBarInner: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 9,
    gap: spacing.sm,
    borderRadius: 24,
    shadowColor: p.colors.shadowDark,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 22,
    elevation: 12,
  },
  favoriteDockButton: {
    width: 52,
    height: 52,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
    shadowColor: p.colors.shadowDark,
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 3,
  },
  favoriteDockButtonActive: {
    backgroundColor: p.colors.errorSubtle,
    borderColor: p.colors.errorLighter,
  },
  inCartStepper: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.sm,
    backgroundColor: p.colors.successSubtle,
    borderWidth: 1,
    borderColor: p.colors.successLighter,
  },
  stepperBtn: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepperBtnGradient: {
    width: 34,
    height: 34,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inCartStatus: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  inCartLabel: {
    color: p.colors.success,
    fontSize: 8,
    fontWeight: fontWeight.bold,
    letterSpacing: 1,
  },
  inCartQuantity: {
    color: p.colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.extrabold,
    lineHeight: 20,
    minWidth: 22,
    textAlign: 'center',
  },
  addToCartBtn: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    overflow: 'hidden',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.34,
    shadowRadius: 16,
    elevation: 6,
  },
  addToCartBtnDisabled: {
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    shadowOpacity: 0,
    elevation: 0,
  },
  addToCartText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  addToCartDisabledText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
});
