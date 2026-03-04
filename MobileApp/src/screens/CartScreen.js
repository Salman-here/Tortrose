/**
 * CartScreen — Liquid Glass Design
 */

import React, { useEffect } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, SafeAreaView, Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader, EmptyCart, LoginRequired } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, fontWeight, glass } from '../styles/theme';

export default function CartScreen({ navigation }) {
  const { currentUser } = useAuth();
  const { cartItems, fetchCart, handleRemoveCartItem, handleQtyInc, handleQtyDec, isCartLoading, qtyUpdateId } = useGlobal();
  const { formatPrice } = useCurrency();

  useEffect(() => { if (currentUser) fetchCart(); }, [currentUser]);

  const getDiscountedPrice = (product) => product?.discountedPrice || product?.price || 0;

  const calculateSubtotal = () => {
    if (!cartItems?.cart) return 0;
    return cartItems.cart.reduce((total, item) => {
      if (!item.product) return total;
      return total + (getDiscountedPrice(item.product) * item.qty);
    }, 0);
  };

  const handleCheckout = () => {
    if (!currentUser) { navigation.navigate('Login'); return; }
    if (!cartItems?.cart || cartItems.cart.length === 0) { Alert.alert('Empty Cart', 'Please add items to your cart before checkout'); return; }
    navigation.navigate('Checkout');
  };

  const subtotal = calculateSubtotal();

  const heroHeader = (
    <GlassPanel variant="floating" style={styles.heroHeader}>
      <Text style={styles.heroTitle}>Shopping Cart</Text>
      {cartItems?.cart?.length > 0 && (
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>{cartItems.cart.length} {cartItems.cart.length === 1 ? 'item' : 'items'}</Text>
        </View>
      )}
    </GlassPanel>
  );

  if (!currentUser) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container}>
          {heroHeader}
          <LoginRequired onAction={() => navigation.navigate('Login')} onBrowse={() => navigation.navigate('Home')} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (!cartItems?.cart || cartItems.cart.length === 0) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container}>
          {heroHeader}
          <EmptyCart onAction={() => navigation.navigate('Home')} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const renderCartItem = ({ item }) => {
    const { product, qty, _id: itemId } = item;
    if (!product) return null;
    const discountedPrice = getDiscountedPrice(product);
    const isUpdating = qtyUpdateId === itemId;

    return (
      <GlassPanel variant="card" style={styles.cartItem}>
        {isUpdating && (
          <View style={styles.itemOverlay}>
            <InlineLoader size="small" />
            <Text style={styles.overlayText}>Updating...</Text>
          </View>
        )}
        <TouchableOpacity onPress={() => navigation.navigate('ProductDetail', { productId: product._id })} activeOpacity={0.85}>
          <Image source={{ uri: product.image || product.images?.[0]?.url }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
        </TouchableOpacity>
        <View style={styles.itemDetails}>
          {product.category && <Text style={styles.itemCategory}>{product.category}</Text>}
          <Text style={styles.itemName} numberOfLines={2}>{product.name}</Text>
          <Text style={styles.itemPrice}>{formatPrice(discountedPrice)}</Text>
          <View style={styles.bottomRow}>
            <View style={styles.quantityContainer}>
              <TouchableOpacity style={styles.qtyButton} onPress={() => handleQtyDec(itemId)} disabled={isUpdating}>
                <Ionicons name="remove" size={16} color={colors.primary} />
              </TouchableOpacity>
              <Text style={styles.qtyText}>{qty}</Text>
              <TouchableOpacity style={styles.qtyButton} onPress={() => handleQtyInc(itemId)}>
                <Ionicons name="add" size={16} color={colors.primary} />
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.removeButton} onPress={() => handleRemoveCartItem(product._id)} disabled={isUpdating}>
              <Ionicons name="trash-outline" size={18} color={colors.error} />
            </TouchableOpacity>
          </View>
        </View>
      </GlassPanel>
    );
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        {isCartLoading && cartItems.cart.length === 0 ? (
          <><View>{heroHeader}</View><Loader fullScreen size="medium" /></>
        ) : (
          <FlatList
            data={cartItems.cart}
            keyExtractor={(item) => item._id}
            renderItem={renderCartItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={heroHeader}
            ListFooterComponent={
              <GlassPanel variant="panel" style={styles.orderSummary}>
                <Text style={styles.summaryTitle}>Order Summary</Text>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Subtotal ({cartItems.cart.length} items)</Text>
                  <Text style={styles.summaryValue}>{formatPrice(subtotal)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Shipping & Tax</Text>
                  <Text style={styles.summaryValueSmall}>Calculated at checkout</Text>
                </View>
                <View style={[styles.summaryRow, styles.totalRow]}>
                  <Text style={styles.totalLabel}>Subtotal</Text>
                  <Text style={styles.totalValue}>{formatPrice(subtotal)}</Text>
                </View>
              </GlassPanel>
            }
          />
        )}
        <GlassPanel variant="floating" style={styles.footer}>
          <View style={styles.footerTop}>
            <Text style={styles.footerTotalLabel}>Subtotal</Text>
            <Text style={styles.footerTotalValue}>{formatPrice(subtotal)}</Text>
          </View>
          <TouchableOpacity style={[styles.checkoutButton, isCartLoading && { opacity: 0.6 }]} onPress={handleCheckout} disabled={isCartLoading} activeOpacity={0.85}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.white} />
            <Text style={styles.checkoutButtonText}>Secure Checkout</Text>
            <Ionicons name="arrow-forward" size={18} color={colors.white} />
          </TouchableOpacity>
        </GlassPanel>
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  heroBadge: { backgroundColor: 'rgba(99,102,241,0.15)', borderRadius: borderRadius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  heroBadgeText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  listContent: { padding: spacing.md, paddingBottom: 140 },
  cartItem: { flexDirection: 'row', padding: spacing.md, marginBottom: spacing.md, position: 'relative', overflow: 'hidden' },
  itemOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(255,255,255,0.85)', justifyContent: 'center', alignItems: 'center', zIndex: 10, flexDirection: 'row', gap: spacing.sm, borderRadius: 22 },
  overlayText: { color: colors.primary, fontWeight: fontWeight.medium, fontSize: fontSize.sm },
  itemImage: { width: 90, height: 90, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.1)' },
  itemDetails: { flex: 1, marginLeft: spacing.md },
  itemCategory: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.semibold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  itemName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.xs, lineHeight: 20 },
  itemPrice: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.sm },
  bottomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  quantityContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: borderRadius.full, paddingHorizontal: spacing.xs, paddingVertical: spacing.xs, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  qtyButton: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)' },
  qtyText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primary, paddingHorizontal: spacing.md, minWidth: 30, textAlign: 'center' },
  removeButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(239,68,68,0.1)', justifyContent: 'center', alignItems: 'center' },
  orderSummary: { padding: spacing.lg, marginBottom: spacing.md },
  summaryTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.15)' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  summaryLabel: { fontSize: fontSize.md, color: colors.textSecondary },
  summaryValue: { fontSize: fontSize.md, color: colors.text, fontWeight: fontWeight.medium },
  summaryValueSmall: { fontSize: fontSize.sm, color: colors.textSecondary, fontStyle: 'italic' },
  totalRow: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.15)', paddingTop: spacing.sm, marginTop: spacing.xs, marginBottom: 0 },
  totalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  totalValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.primary },
  footer: { position: 'absolute', bottom: 0, left: spacing.md, right: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, paddingBottom: spacing.xl, marginBottom: spacing.sm },
  footerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  footerTotalLabel: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: fontWeight.medium },
  footerTotalValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  checkoutButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: spacing.md, borderRadius: borderRadius.xl, justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  checkoutButtonText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
});
