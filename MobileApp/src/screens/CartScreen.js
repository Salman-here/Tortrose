/**
 * CartScreen
 * Modern cart screen with item management and checkout
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */

import React, { useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  Alert,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader, EmptyCart, LoginRequired } from '../components/common';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';

export default function CartScreen({ navigation }) {
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
  const { formatPrice } = useCurrency();

  useEffect(() => {
    if (currentUser) {
      fetchCart();
    }
  }, [currentUser]);

  // Calculate discounted price for a product
  const getDiscountedPrice = (product) => {
    if (!product) return 0;
    return product.discountedPrice || product.price;
  };

  // Calculate subtotal
  const calculateSubtotal = () => {
    if (!cartItems?.cart) return 0;
    return cartItems.cart.reduce((total, item) => {
      if (!item.product) return total;
      const itemPrice = getDiscountedPrice(item.product);
      return total + (itemPrice * item.qty);
    }, 0);
  };

  const handleCheckout = () => {
    if (!currentUser) {
      navigation.navigate('Login');
      return;
    }
    if (!cartItems?.cart || cartItems.cart.length === 0) {
      Alert.alert('Empty Cart', 'Please add items to your cart before checkout');
      return;
    }
    navigation.navigate('Checkout');
  };

  const subtotal = calculateSubtotal();

  // Guest View
  if (!currentUser) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.heroHeader}>
          <Text style={styles.heroTitle}>Shopping Cart</Text>
        </View>
        <LoginRequired
          onAction={() => navigation.navigate('Login')}
          style={styles.emptyStateContainer}
        />
      </SafeAreaView>
    );
  }

  // Empty Cart
  if (!cartItems?.cart || cartItems.cart.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.heroHeader}>
          <Text style={styles.heroTitle}>Shopping Cart</Text>
        </View>
        <EmptyCart
          onAction={() => navigation.navigate('Home')}
          style={styles.emptyStateContainer}
        />
      </SafeAreaView>
    );
  }

  const renderCartItem = ({ item }) => {
    const { product, qty, _id: itemId } = item;
    if (!product) return null;

    const discountedPrice = getDiscountedPrice(product);
    const originalPrice = product.discountedPrice || product.price;
    const hasDiscount = discountedPrice < originalPrice;
    const isUpdating = qtyUpdateId === itemId;

    return (
      <View style={styles.cartItem}>
        {isUpdating && (
          <View style={styles.itemOverlay}>
            <InlineLoader size="small" />
            <Text style={styles.overlayText}>Updating...</Text>
          </View>
        )}

        <TouchableOpacity onPress={() => navigation.navigate('ProductDetail', { productId: product._id })} activeOpacity={0.85}>
          <Image
            source={{ uri: product.image || product.images?.[0]?.url }}
            style={styles.itemImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={150}
          />
        </TouchableOpacity>

        <View style={styles.itemDetails}>
          {product.category && <Text style={styles.itemCategory}>{product.category}</Text>}
          <Text style={styles.itemName} numberOfLines={2}>{product.name}</Text>

          <View style={styles.priceRow}>
            <Text style={[styles.itemPrice, hasDiscount && styles.itemPriceDiscount]}>
              {formatPrice(discountedPrice)}
            </Text>
            {hasDiscount && (
              <Text style={styles.itemOriginalPrice}>{formatPrice(originalPrice)}</Text>
            )}
          </View>

          {/* Quantity Selector */}
          <View style={styles.bottomRow}>
            <View style={styles.quantityContainer}>
              <TouchableOpacity
                style={styles.qtyButton}
                onPress={() => handleQtyDec(itemId)}
                disabled={isUpdating}
              >
                <Ionicons name="remove" size={16} color={qty <= 1 ? colors.grayLight : colors.primary} />
              </TouchableOpacity>
              <Text style={styles.qtyText}>{qty}</Text>
              <TouchableOpacity
                style={[styles.qtyButton, styles.qtyButtonAdd]}
                onPress={() => handleQtyInc(itemId)}
              >
                <Ionicons name="add" size={16} color={colors.primary} />
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.removeButton}
              onPress={() => handleRemoveCartItem(product._id)}
              disabled={isUpdating}
            >
              <Ionicons name="trash-outline" size={18} color={colors.error} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Hero Header */}
      <View style={styles.heroHeader}>
        <Text style={styles.heroTitle}>Shopping Cart</Text>
        <View style={styles.heroCountBadge}>
          <Text style={styles.heroCount}>{cartItems.cart.length} {cartItems.cart.length === 1 ? 'item' : 'items'}</Text>
        </View>
      </View>

      {isCartLoading && cartItems.cart.length === 0 ? (
        <Loader fullScreen size="medium" />
      ) : (
        <FlatList
          data={cartItems.cart}
          keyExtractor={(item) => item._id}
          renderItem={renderCartItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={
            <View style={styles.orderSummary}>
              <Text style={styles.summaryTitle}>Order Summary</Text>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Subtotal ({cartItems.cart.length} {cartItems.cart.length === 1 ? 'item' : 'items'})</Text>
                <Text style={styles.summaryValue}>{formatPrice(subtotal)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Shipping & Tax</Text>
                <Text style={[styles.summaryValue, styles.calculatedAtCheckout]}>Calculated at checkout</Text>
              </View>
              <View style={[styles.summaryRow, styles.totalRow]}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalValue}>{formatPrice(subtotal)}</Text>
              </View>
            </View>
          }
        />
      )}

      {/* Footer */}
      <View style={styles.footer}>
        <View style={styles.footerTop}>
          <Text style={styles.footerTotalLabel}>Subtotal</Text>
          <Text style={styles.footerTotalValue}>{formatPrice(subtotal)}</Text>
        </View>
        <TouchableOpacity
          style={[styles.checkoutButton, isCartLoading && styles.checkoutButtonDisabled]}
          onPress={handleCheckout}
          disabled={isCartLoading}
          activeOpacity={0.85}
        >
          <Ionicons name="lock-closed-outline" size={18} color={colors.white} />
          <Text style={styles.checkoutButtonText}>Secure Checkout</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.white} />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Hero Header
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
  heroCountBadge: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  heroCount: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  emptyStateContainer: {
    flex: 1,
  },
  listContent: {
    padding: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  // Cart Item
  cartItem: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.md,
    position: 'relative',
    overflow: 'hidden',
  },
  itemOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: borderRadius.xl,
    zIndex: 10,
    flexDirection: 'row',
    gap: spacing.sm,
  },
  overlayText: {
    color: colors.primary,
    fontWeight: fontWeight.medium,
    fontSize: fontSize.sm,
  },
  itemImage: {
    width: 90,
    height: 90,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.light,
  },
  itemDetails: {
    flex: 1,
    marginLeft: spacing.md,
  },
  itemCategory: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  itemName: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: spacing.xs,
    lineHeight: 20,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  itemPrice: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  itemPriceDiscount: {
    color: colors.warning,
  },
  itemOriginalPrice: {
    fontSize: fontSize.sm,
    color: colors.textLight,
    textDecorationLine: 'line-through',
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quantityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primarySubtle,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.primaryLighter,
  },
  qtyButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.white,
    ...shadows.sm,
  },
  qtyButtonAdd: {
    backgroundColor: colors.white,
  },
  qtyText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.primary,
    paddingHorizontal: spacing.md,
    minWidth: 30,
    textAlign: 'center',
  },
  removeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.errorLighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Order Summary
  orderSummary: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  summaryTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
    marginBottom: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  summaryLabel: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
  },
  summaryValue: {
    fontSize: fontSize.md,
    color: colors.text,
    fontWeight: fontWeight.medium,
  },
  calculatedAtCheckout: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: fontWeight.regular,
    fontStyle: 'italic',
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: colors.light,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: 0,
  },
  totalLabel: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  totalValue: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  // Footer
  footer: {
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingBottom: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    ...shadows.lg,
  },
  footerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  footerTotalLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  footerTotalValue: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  checkoutButton: {
    flexDirection: 'row',
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  checkoutButtonDisabled: {
    opacity: 0.6,
  },
  checkoutButtonText: {
    color: colors.white,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
});
