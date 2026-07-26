/**
 * CartScreen - premium liquid-glass shopping flow.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import {
  CartItemSkeleton,
  EmptyCart,
  InlineLoader,
} from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassBlurFill from '../components/common/GlassBlurFill';
import GlassPanel from '../components/common/GlassPanel';
import PremiumTopBar, {
  PremiumTopBarAction,
} from '../components/common/PremiumTopBar';
import {
  fontSize,
  fontWeight,
  spacing,
} from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const INITIAL_DOCK_HEIGHT = 148;

export default function CartScreen({ navigation }) {
  const { palette, isDark } = useTheme();
  const styles = useMemo(() => buildStyles(palette, isDark), [palette, isDark]);
  const tabBarHeight = useBottomTabBarHeight();
  const insets = useSafeAreaInsets();

  const { currentUser } = useAuth();
  const {
    cartItems,
    fetchCart,
    handleRemoveCartItem,
    handleQtyInc,
    handleQtyDec,
    isCartLoading,
    qtyUpdateId,
  } = useGlobal();
  const {
    formatAmount,
    formatProductPrice,
    getProductPriceNumber,
  } = useCurrency();

  const [refreshing, setRefreshing] = useState(false);
  const [checkoutDockHeight, setCheckoutDockHeight] = useState(INITIAL_DOCK_HEIGHT);

  const cart = Array.isArray(cartItems?.cart) ? cartItems.cart : [];
  const lineItemCount = cart.length;
  const itemCount = cart.reduce(
    (total, item) => total + Math.max(1, Number(item?.qty) || 1),
    0
  );
  const hasCartItems = lineItemCount > 0;

  useEffect(() => {
    if (currentUser) fetchCart();
  }, [currentUser]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchCart();
    } finally {
      setRefreshing(false);
    }
  }, [fetchCart]);

  const getEffectivePriceField = useCallback((product) => (
    Number(product?.discountedPrice || 0) > 0
      && Number(product?.discountedPrice) < Number(product?.price)
      ? 'discountedPrice'
      : 'price'
  ), []);

  const subtotal = cart.reduce((total, item) => {
    if (!item?.product) return total;
    const quantity = Math.max(1, Number(item.qty) || 1);
    const itemPrice = getProductPriceNumber(
      item.product,
      getEffectivePriceField(item.product)
    );
    return total + (itemPrice * quantity);
  }, 0);

  // The tab bar is an absolute 66px pill with its own safe-area offset.
  // Keep the checkout dock above both the bar and its bottom margin.
  const tabBarBottomOffset = Math.max(insets.bottom, spacing.md);
  const checkoutDockBottom = tabBarHeight + tabBarBottomOffset + spacing.sm;
  const listBottomPadding = checkoutDockBottom + checkoutDockHeight + spacing.xl;
  const stateBottomPadding = tabBarHeight + tabBarBottomOffset + spacing.xl;

  const handleBack = useCallback(() => {
    if (typeof navigation.canGoBack === 'function' && navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate('Marketplace');
  }, [navigation]);

  const handleAIShopping = useCallback(() => {
    const parentNavigation = navigation.getParent?.();
    if (parentNavigation) {
      parentNavigation.navigate('AIChat', { role: 'user' });
      return;
    }
    navigation.navigate('AIChat', { role: 'user' });
  }, [navigation]);

  const handleCheckout = useCallback(() => {
    if (!hasCartItems) {
      Alert.alert('Empty Cart', 'Please add items to your cart before checkout');
      return;
    }
    navigation.navigate('Checkout');
  }, [hasCartItems, navigation]);

  const handleCheckoutDockLayout = useCallback((event) => {
    const measuredHeight = Math.ceil(event.nativeEvent.layout.height);
    setCheckoutDockHeight((currentHeight) => (
      currentHeight === measuredHeight ? currentHeight : measuredHeight
    ));
  }, []);

  const topBarSubtitle = !currentUser
    ? 'Sign in to sync your shopping bag'
    : isCartLoading && !hasCartItems
      ? 'Loading your saved shopping bag'
      : hasCartItems
        ? `${itemCount} ${itemCount === 1 ? 'item' : 'items'} ready to review`
        : 'Ready for your next discovery';

  const topBar = (
    <PremiumTopBar
      title="Cart"
      subtitle={topBarSubtitle}
      icon="bag-handle"
      onBack={handleBack}
      backLabel="Go back to Marketplace"
      sheenColors={[
        'rgba(20,184,166,0.13)',
        'rgba(14,165,233,0.07)',
        'rgba(99,102,241,0.12)',
      ]}
      right={(
        <PremiumTopBarAction
          icon="sparkles"
          onPress={handleAIShopping}
          accessibilityLabel="Shop with Rozare AI"
          primary
        />
      )}
    />
  );

  const channelPromise = (
    <GlassPanel variant="inner" style={styles.channelPromise}>
      <View style={styles.channelIcon}>
        <Ionicons name="logo-whatsapp" size={19} color="#10B981" />
      </View>
      <View style={styles.channelCopy}>
        <Text style={styles.channelTitle}>Shopping that stays with you</Text>
        <Text style={styles.channelText}>
          Chat with AI in the app or on WhatsApp. After checkout, get order
          confirmations and status updates in-app, with WhatsApp updates when connected.
        </Text>
      </View>
    </GlassPanel>
  );

  const guestSignInCard = (
    <GlassPanel variant="strong" style={styles.guestCard}>
      {Platform.OS !== 'android' && (
        <LinearGradient
          colors={[
            'rgba(20,184,166,0.12)',
            'rgba(14,165,233,0.05)',
            'rgba(99,102,241,0.13)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      <View style={styles.guestVisual}>
        <View style={styles.guestIconGlass}>
          <GlassBlurFill intensity={42} />
          <LinearGradient
            colors={palette.gradients.cta}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.guestIconCore}
          >
            <Ionicons name="bag-handle-outline" size={29} color="#fff" />
          </LinearGradient>
        </View>
      </View>

      <View style={styles.guestEyebrow}>
        <Ionicons name="sparkles" size={11} color={palette.colors.primary} />
        <Text style={styles.guestEyebrowText}>YOUR BAG, ON EVERY DEVICE</Text>
      </View>
      <Text style={styles.guestTitle}>Sign in to keep shopping seamlessly</Text>
      <Text style={styles.guestText}>
        Save products, sync quantities, and continue to protected checkout
        without losing what you picked.
      </Text>

      <TouchableOpacity
        style={styles.guestPrimaryButton}
        onPress={() => navigation.navigate('Login')}
        activeOpacity={0.86}
        accessibilityRole="button"
        accessibilityLabel="Sign in to your Rozare account"
      >
        <LinearGradient
          colors={palette.gradients.cta}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Ionicons name="person-outline" size={18} color="#fff" />
        <Text style={styles.guestPrimaryButtonText}>Sign in</Text>
        <Ionicons name="arrow-forward" size={17} color="#fff" />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.guestBrowseButton}
        onPress={() => navigation.navigate('Home')}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel="Continue browsing products"
      >
        <Ionicons name="storefront-outline" size={17} color={palette.colors.primary} />
        <Text style={styles.guestBrowseButtonText}>Continue browsing</Text>
      </TouchableOpacity>
    </GlassPanel>
  );

  if (!currentUser) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {topBar}
          <ScrollView
            contentContainerStyle={[
              styles.stateContent,
              { paddingBottom: stateBottomPadding },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {guestSignInCard}
            {channelPromise}
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (isCartLoading && !hasCartItems) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {topBar}
          <View
            style={[
              styles.loadingContent,
              { paddingBottom: stateBottomPadding },
            ]}
            accessibilityRole="progressbar"
            accessibilityLabel="Loading shopping cart"
          >
            <GlassPanel variant="strong" style={styles.loadingIntro}>
              <View style={styles.loadingIntroIcon}>
                <InlineLoader size="small" />
              </View>
              <View style={styles.loadingIntroCopy}>
                <Text style={styles.loadingTitle}>Preparing your bag</Text>
                <Text style={styles.loadingText}>
                  Checking prices, options, and your latest quantities.
                </Text>
              </View>
            </GlassPanel>
            {[0, 1, 2].map((index) => (
              <CartItemSkeleton key={index} />
            ))}
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (!hasCartItems) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {topBar}
          <ScrollView
            contentContainerStyle={[
              styles.stateContent,
              { paddingBottom: stateBottomPadding },
            ]}
            showsVerticalScrollIndicator={false}
          >
            <EmptyCart onAction={() => navigation.navigate('Home')} />
            {channelPromise}
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const renderCartItem = ({ item }) => {
    const { product, _id: itemId } = item;
    if (!product) return null;

    const quantity = Math.max(1, Number(item.qty) || 1);
    const priceField = getEffectivePriceField(product);
    const unitPrice = getProductPriceNumber(product, priceField);
    const lineTotal = unitPrice * quantity;
    const isUpdating = qtyUpdateId === itemId;
    const isDiscounted = priceField === 'discountedPrice';
    const selectedOptions = item.selectedOptions
      && typeof item.selectedOptions === 'object'
      ? Object.entries(item.selectedOptions).filter(([, value]) => value)
      : [];
    const variantSelections = [
      ...(item.selectedColor ? [['Color', item.selectedColor]] : []),
      ...selectedOptions.filter(([name, value]) => (
        !(String(name).toLowerCase() === 'color' && value === item.selectedColor)
      )),
    ];
    const productImage = product.image || product.images?.[0]?.url;

    return (
      <GlassPanel
        variant="card"
        androidBlur={false}
        style={styles.cartItem}
      >
        {Platform.OS !== 'android' && (
          <LinearGradient
            colors={[
              'rgba(20,184,166,0.12)',
              'rgba(14,165,233,0.03)',
              'rgba(99,102,241,0.09)',
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        )}

        {isUpdating && (
          <View
            style={styles.itemOverlay}
            accessibilityRole="progressbar"
            accessibilityLabel={`Updating ${product.name}`}
          >
            <InlineLoader size="small" />
            <Text style={styles.overlayText}>Updating item...</Text>
          </View>
        )}

        <View style={styles.itemMainRow}>
          <TouchableOpacity
            style={styles.imageButton}
            onPress={() => navigation.navigate('ProductDetail', { productId: product._id })}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`View ${product.name}`}
          >
            <Image
              source={{ uri: productImage }}
              style={styles.itemImage}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
            />
            {isDiscounted && (
              <View style={styles.saleBadge}>
                <Ionicons name="sparkles" size={10} color="#fff" />
                <Text style={styles.saleBadgeText}>SALE</Text>
              </View>
            )}
          </TouchableOpacity>

          <View style={styles.itemDetails}>
            <View style={styles.itemEyebrowRow}>
              {product.category ? (
                <Text style={styles.itemCategory} numberOfLines={1}>
                  {product.category}
                </Text>
              ) : (
                <Text style={styles.itemCategory}>MARKETPLACE ITEM</Text>
              )}
              <View style={styles.inBagPill}>
                <View style={styles.inBagDot} />
                <Text style={styles.inBagText}>In bag</Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={() => navigation.navigate('ProductDetail', { productId: product._id })}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={`Open ${product.name} details`}
            >
              <Text style={styles.itemName} numberOfLines={2}>
                {product.name}
              </Text>
            </TouchableOpacity>

            <View style={styles.priceRow}>
              <Text style={styles.itemPrice}>
                {formatProductPrice(product, { field: priceField })}
              </Text>
              <Text style={styles.priceQualifier}>each</Text>
            </View>
            {quantity > 1 && (
              <Text style={styles.lineTotalText}>
                {formatAmount(lineTotal)} item total
              </Text>
            )}
          </View>
        </View>

        {variantSelections.length > 0 && (
          <View
            style={styles.variantSection}
            accessibilityLabel={`Selected options: ${variantSelections
              .map(([name, value]) => `${name} ${value}`)
              .join(', ')}`}
          >
            <Text style={styles.variantLabel}>SELECTED OPTIONS</Text>
            <View style={styles.variantList}>
              {variantSelections.map(([name, value], index) => (
                <View
                  key={`${name}-${String(value)}-${index}`}
                  style={styles.variantChip}
                >
                  <Ionicons
                    name={String(name).toLowerCase() === 'color'
                      ? 'color-palette-outline'
                      : 'options-outline'}
                    size={12}
                    color={palette.colors.primary}
                  />
                  <Text style={styles.variantChipText} numberOfLines={1}>
                    <Text style={styles.variantChipName}>{name}: </Text>
                    {String(value)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        <View style={styles.itemActions}>
          <View style={styles.quantityContainer}>
            <TouchableOpacity
              style={styles.qtyButton}
              onPress={() => handleQtyDec(itemId)}
              disabled={isUpdating}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={`Decrease ${product.name} quantity`}
              accessibilityState={{ disabled: isUpdating }}
            >
              <Ionicons name="remove" size={18} color={palette.colors.primary} />
            </TouchableOpacity>
            <View style={styles.qtyValueWrap}>
              <Text style={styles.qtyLabel}>QTY</Text>
              <Text style={styles.qtyText}>{quantity}</Text>
            </View>
            <TouchableOpacity
              style={styles.qtyButton}
              onPress={() => handleQtyInc(itemId)}
              disabled={isUpdating}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={`Increase ${product.name} quantity`}
              accessibilityState={{ disabled: isUpdating }}
            >
              <Ionicons name="add" size={18} color={palette.colors.primary} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => handleRemoveCartItem(itemId)}
            disabled={isUpdating}
            activeOpacity={0.72}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${product.name} from cart`}
            accessibilityState={{ disabled: isUpdating }}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            <Ionicons name="trash-outline" size={19} color={palette.colors.error} />
          </TouchableOpacity>
        </View>
      </GlassPanel>
    );
  };

  const cartOverview = (
    <GlassPanel variant="strong" style={styles.cartOverview}>
      {Platform.OS !== 'android' && (
        <LinearGradient
          colors={[
            'rgba(20,184,166,0.18)',
            'rgba(14,165,233,0.08)',
            'rgba(99,102,241,0.16)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      <View style={styles.overviewGlow} pointerEvents="none" />

      <View style={styles.overviewTop}>
        <View style={styles.overviewCopy}>
          <Text style={styles.overviewEyebrow}>YOUR SHOPPING BAG</Text>
          <Text style={styles.overviewTitle}>Everything looks good</Text>
          <Text style={styles.overviewText}>
            Review quantities and options now. Delivery charges and tax are
            calculated before you place the order.
          </Text>
        </View>
        <LinearGradient
          colors={palette.gradients.cta}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.overviewIcon}
        >
          <Ionicons name="bag-check-outline" size={24} color="#fff" />
        </LinearGradient>
      </View>

      <View style={styles.overviewUtilityRow}>
        <View style={styles.securePill}>
          <Ionicons
            name="shield-checkmark-outline"
            size={16}
            color={palette.colors.success}
          />
          <Text style={styles.securePillText}>Protected checkout</Text>
        </View>
        <TouchableOpacity
          style={styles.aiCartButton}
          onPress={handleAIShopping}
          activeOpacity={0.78}
          accessibilityRole="button"
          accessibilityLabel="Ask Rozare AI for shopping help"
        >
          <LinearGradient
            colors={palette.gradients.cta}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <Ionicons name="sparkles" size={16} color="#fff" />
          <Text style={styles.aiCartButtonText}>Ask AI</Text>
        </TouchableOpacity>
      </View>
    </GlassPanel>
  );

  const orderSummary = (
    <GlassPanel variant="strong" style={styles.orderSummary}>
      <View style={styles.summaryHeader}>
        <View style={styles.summaryIcon}>
          <Ionicons
            name="receipt-outline"
            size={20}
            color={palette.colors.primary}
          />
        </View>
        <View style={styles.summaryHeaderCopy}>
          <Text style={styles.summaryTitle}>Order summary</Text>
          <Text style={styles.summarySubtitle}>
            {lineItemCount} {lineItemCount === 1 ? 'product' : 'products'} · {itemCount}{' '}
            {itemCount === 1 ? 'item' : 'items'}
          </Text>
        </View>
      </View>

      <View style={styles.summaryRows}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Items subtotal</Text>
          <Text style={styles.summaryValue}>{formatAmount(subtotal)}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Delivery</Text>
          <Text style={styles.summaryValueMuted}>Calculated next</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Tax</Text>
          <Text style={styles.summaryValueMuted}>Calculated next</Text>
        </View>
      </View>

      <View style={styles.summaryTotalRow}>
        <View style={styles.summaryTotalCopy}>
          <Text style={styles.summaryTotalLabel}>Current subtotal</Text>
          <Text style={styles.summaryTotalHint}>Before delivery and tax</Text>
        </View>
        <Text style={styles.summaryTotalValue} numberOfLines={1}>
          {formatAmount(subtotal)}
        </Text>
      </View>

      <View
        style={styles.orderUpdatesCard}
        accessible
        accessibilityLabel="Order updates. Confirmations and status updates appear in the app, and on WhatsApp when connected."
      >
        <View style={styles.orderUpdatesIcon}>
          <Ionicons name="logo-whatsapp" size={20} color="#10B981" />
        </View>
        <View style={styles.orderUpdatesCopy}>
          <Text style={styles.orderUpdatesTitle}>Stay updated after checkout</Text>
          <Text style={styles.orderUpdatesText}>
            Confirmations and order status updates appear in the app, and on
            WhatsApp when your number is connected.
          </Text>
        </View>
      </View>
    </GlassPanel>
  );

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        {topBar}
        <FlatList
          data={cart}
          keyExtractor={(item, index) => item?._id || `cart-item-${index}`}
          renderItem={renderCartItem}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: listBottomPadding },
          ]}
          scrollIndicatorInsets={{ bottom: checkoutDockHeight + checkoutDockBottom }}
          showsVerticalScrollIndicator={false}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={palette.colors.primary}
              colors={[palette.colors.primary]}
              progressBackgroundColor={palette.colors.surface}
            />
          )}
          ListHeaderComponent={cartOverview}
          ListFooterComponent={orderSummary}
        />

        <View
          style={[
            styles.checkoutDockPosition,
            { bottom: checkoutDockBottom },
          ]}
          onLayout={handleCheckoutDockLayout}
        >
          <GlassPanel
            variant="floating"
            style={styles.checkoutDock}
          >
            {Platform.OS !== 'android' && (
              <LinearGradient
                colors={[
                  'rgba(20,184,166,0.08)',
                  'rgba(14,165,233,0.04)',
                  'rgba(99,102,241,0.09)',
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
            )}
            <View style={styles.dockTop}>
              <View style={styles.dockCopy}>
                <Text style={styles.dockLabel}>Subtotal</Text>
                <Text style={styles.dockHint}>Delivery & tax calculated next</Text>
              </View>
              <Text style={styles.dockValue} numberOfLines={1}>
                {formatAmount(subtotal)}
              </Text>
            </View>

            <TouchableOpacity
              style={[
                styles.checkoutButton,
                isCartLoading && styles.checkoutButtonDisabled,
              ]}
              onPress={handleCheckout}
              disabled={isCartLoading}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`Secure checkout, current subtotal ${formatAmount(subtotal)}`}
              accessibilityHint="Opens delivery and payment details"
              accessibilityState={{ disabled: isCartLoading }}
            >
              <LinearGradient
                colors={palette.gradients.cta}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
              />
              <Ionicons name="lock-closed-outline" size={18} color="#fff" />
              <Text style={styles.checkoutButtonText}>Continue to Secure Checkout</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>

            <View style={styles.dockConfidence}>
              <Ionicons
                name="shield-checkmark-outline"
                size={13}
                color={palette.colors.success}
              />
              <Text style={styles.dockConfidenceText}>
                Protected checkout {'\u00B7'} updates continue in app and WhatsApp
              </Text>
            </View>
          </GlassPanel>
        </View>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p, isDark) => StyleSheet.create({
  container: {
    flex: 1,
  },

  // Guest, empty, and loading states
  stateContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  guestCard: {
    alignItems: 'center',
    marginHorizontal: spacing.sm,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    borderRadius: 28,
    overflow: 'hidden',
  },
  guestVisual: {
    width: 90,
    height: 90,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  guestIconGlass: {
    width: 82,
    height: 82,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 28,
    overflow: 'hidden',
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.borderStrong,
    shadowColor: '#6366F1',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 17,
    elevation: 6,
  },
  guestIconCore: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 4,
  },
  guestEyebrow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: spacing.sm,
    borderRadius: 999,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  guestEyebrowText: {
    color: p.colors.primary,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.85,
  },
  guestTitle: {
    maxWidth: 310,
    color: p.colors.text,
    fontSize: fontSize.xl,
    lineHeight: 27,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.35,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  guestText: {
    maxWidth: 320,
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  guestPrimaryButton: {
    width: '100%',
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 17,
    overflow: 'hidden',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.3,
    shadowRadius: 14,
    elevation: 6,
  },
  guestPrimaryButtonText: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  guestBrowseButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 15,
  },
  guestBrowseButtonText: {
    color: p.colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  channelPromise: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.lg,
    padding: spacing.md,
    borderRadius: 18,
  },
  channelIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: 'rgba(16,185,129,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  channelCopy: {
    flex: 1,
    minWidth: 0,
  },
  channelTitle: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    marginBottom: 3,
  },
  channelText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 17,
  },
  loadingContent: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  loadingIntro: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 20,
  },
  loadingIntroIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: p.glass.bgSubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingIntroCopy: {
    flex: 1,
    minWidth: 0,
  },
  loadingTitle: {
    color: p.colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    marginBottom: 2,
  },
  loadingText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 17,
  },

  // Scroll content and overview
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  cartOverview: {
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: 24,
    overflow: 'hidden',
  },
  overviewGlow: {
    position: 'absolute',
    width: 150,
    height: 150,
    borderRadius: 75,
    right: -66,
    top: -75,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  overviewTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  overviewCopy: {
    flex: 1,
    minWidth: 0,
  },
  overviewEyebrow: {
    color: p.colors.primary,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: fontWeight.bold,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  overviewTitle: {
    color: p.colors.text,
    fontSize: fontSize.xl,
    lineHeight: 26,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.35,
    marginBottom: spacing.xs,
  },
  overviewText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  overviewIcon: {
    width: 50,
    height: 50,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 5,
  },
  overviewUtilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  securePill: {
    minHeight: 44,
    flexGrow: 1,
    minWidth: 165,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 14,
    backgroundColor: 'rgba(16,185,129,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.2)',
  },
  securePillText: {
    color: p.colors.text,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  aiCartButton: {
    minHeight: 44,
    minWidth: 106,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 14,
    overflow: 'hidden',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 9,
    elevation: 4,
  },
  aiCartButtonText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },

  // Product cards
  cartItem: {
    position: 'relative',
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 22,
    overflow: 'hidden',
  },
  itemOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: isDark
      ? 'rgba(11,16,32,0.88)'
      : 'rgba(249,250,251,0.88)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
    flexDirection: 'row',
    gap: spacing.sm,
    borderRadius: 22,
  },
  overlayText: {
    color: p.colors.primary,
    fontWeight: fontWeight.semibold,
    fontSize: fontSize.sm,
  },
  itemMainRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  imageButton: {
    width: 98,
    height: 112,
    borderRadius: 17,
    overflow: 'hidden',
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
    flexShrink: 0,
  },
  itemImage: {
    width: '100%',
    height: '100%',
    backgroundColor: p.glass.bgSubtle,
  },
  saleBadge: {
    position: 'absolute',
    left: 7,
    top: 7,
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(239,68,68,0.92)',
  },
  saleBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: fontWeight.extrabold,
    letterSpacing: 0.45,
  },
  itemDetails: {
    flex: 1,
    minWidth: 0,
    paddingTop: 1,
  },
  itemEyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
    marginBottom: 4,
  },
  itemCategory: {
    flex: 1,
    minWidth: 0,
    color: p.colors.primary,
    fontSize: 9,
    lineHeight: 13,
    fontWeight: fontWeight.bold,
    textTransform: 'uppercase',
    letterSpacing: 0.75,
  },
  inBagPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(16,185,129,0.1)',
    flexShrink: 0,
  },
  inBagDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: p.colors.success,
  },
  inBagText: {
    color: p.colors.success,
    fontSize: 9,
    fontWeight: fontWeight.bold,
  },
  itemName: {
    color: p.colors.text,
    fontSize: fontSize.md,
    lineHeight: 20,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.sm,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: 5,
  },
  itemPrice: {
    color: p.colors.text,
    fontSize: fontSize.lg,
    lineHeight: 23,
    fontWeight: fontWeight.extrabold,
    flexShrink: 1,
  },
  priceQualifier: {
    color: p.colors.textSecondary,
    fontSize: 10,
    fontWeight: fontWeight.medium,
  },
  lineTotalText: {
    color: p.colors.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: fontWeight.medium,
    marginTop: 2,
  },
  variantSection: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: p.glass.borderSubtle,
  },
  variantLabel: {
    color: p.colors.textSecondary,
    fontSize: 9,
    lineHeight: 13,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.85,
    marginBottom: spacing.xs,
  },
  variantList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  variantChip: {
    maxWidth: '100%',
    minHeight: 31,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 11,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  variantChipText: {
    minWidth: 0,
    flexShrink: 1,
    color: p.colors.text,
    fontSize: 11,
    lineHeight: 15,
  },
  variantChipName: {
    color: p.colors.textSecondary,
    fontWeight: fontWeight.semibold,
  },
  itemActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  quantityContainer: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 2,
    paddingVertical: 2,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  qtyButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  qtyValueWrap: {
    minWidth: 48,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyLabel: {
    color: p.colors.textSecondary,
    fontSize: 8,
    lineHeight: 10,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.7,
  },
  qtyText: {
    color: p.colors.text,
    fontSize: fontSize.md,
    lineHeight: 19,
    fontWeight: fontWeight.extrabold,
    textAlign: 'center',
  },
  removeButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: p.colors.errorLighter,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },

  // Order summary
  orderSummary: {
    padding: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    borderRadius: 24,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  summaryIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  summaryHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  summaryTitle: {
    color: p.colors.text,
    fontSize: fontSize.lg,
    lineHeight: 23,
    fontWeight: fontWeight.extrabold,
    letterSpacing: -0.2,
  },
  summarySubtitle: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 16,
    marginTop: 2,
  },
  summaryRows: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  summaryRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  summaryLabel: {
    flex: 1,
    color: p.colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 19,
  },
  summaryValue: {
    maxWidth: '50%',
    color: p.colors.text,
    fontSize: fontSize.sm,
    lineHeight: 19,
    fontWeight: fontWeight.semibold,
    textAlign: 'right',
  },
  summaryValueMuted: {
    maxWidth: '50%',
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 18,
    fontWeight: fontWeight.medium,
    textAlign: 'right',
  },
  summaryTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: p.glass.border,
  },
  summaryTotalCopy: {
    flex: 1,
    minWidth: 0,
  },
  summaryTotalLabel: {
    color: p.colors.text,
    fontSize: fontSize.md,
    lineHeight: 20,
    fontWeight: fontWeight.bold,
  },
  summaryTotalHint: {
    color: p.colors.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 1,
  },
  summaryTotalValue: {
    maxWidth: '52%',
    color: p.colors.primary,
    fontSize: fontSize.xl,
    lineHeight: 27,
    fontWeight: fontWeight.extrabold,
    textAlign: 'right',
    flexShrink: 1,
  },
  orderUpdatesCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: 17,
    backgroundColor: 'rgba(16,185,129,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.18)',
  },
  orderUpdatesIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: 'rgba(16,185,129,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  orderUpdatesCopy: {
    flex: 1,
    minWidth: 0,
  },
  orderUpdatesTitle: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    lineHeight: 18,
    fontWeight: fontWeight.bold,
    marginBottom: 2,
  },
  orderUpdatesText: {
    color: p.colors.textSecondary,
    fontSize: fontSize.xs,
    lineHeight: 17,
  },

  // Safe sticky checkout dock
  checkoutDockPosition: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    borderRadius: 24,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 22,
    elevation: 12,
  },
  checkoutDock: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderRadius: 24,
    overflow: 'hidden',
  },
  dockTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  dockCopy: {
    flex: 1,
    minWidth: 0,
  },
  dockLabel: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    lineHeight: 18,
    fontWeight: fontWeight.bold,
  },
  dockHint: {
    color: p.colors.textSecondary,
    fontSize: 9,
    lineHeight: 13,
    marginTop: 1,
  },
  dockValue: {
    maxWidth: '52%',
    color: p.colors.text,
    fontSize: fontSize.xl,
    lineHeight: 27,
    fontWeight: fontWeight.extrabold,
    textAlign: 'right',
    flexShrink: 1,
  },
  checkoutButton: {
    minHeight: 52,
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    overflow: 'hidden',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 6,
  },
  checkoutButtonDisabled: {
    opacity: 0.58,
  },
  checkoutButtonText: {
    minWidth: 0,
    flexShrink: 1,
    color: '#fff',
    fontSize: fontSize.md,
    lineHeight: 20,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
  },
  dockConfidence: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingTop: spacing.xs,
  },
  dockConfidenceText: {
    minWidth: 0,
    flexShrink: 1,
    color: p.colors.textSecondary,
    fontSize: 9,
    lineHeight: 13,
    fontWeight: fontWeight.medium,
    textAlign: 'center',
  },
});
