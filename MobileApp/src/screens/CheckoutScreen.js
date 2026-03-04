/**
 * CheckoutScreen — Liquid Glass Design
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Image } from 'expo-image';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import api from '../config/api';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

export default function CheckoutScreen({ navigation }) {
  const { cartItems, fetchCart } = useGlobal();
  const { formatPrice } = useCurrency();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errors, setErrors] = useState({});
  const [paymentMethod, setPaymentMethod] = useState('cash_on_delivery');
  const [formData, setFormData] = useState({
    fullName: '', email: '', phone: '', address: '',
    city: '', state: '', postalCode: '', country: 'Pakistan',
  });

  const [shippingCost, setShippingCost] = useState(0);
  const [shippingLabel, setShippingLabel] = useState('Loading...');
  const [tax, setTax] = useState(0);
  const [taxLabel, setTaxLabel] = useState('Tax');
  const [summaryLoading, setSummaryLoading] = useState(true);

  const getDiscountedPrice = (product) => product?.discountedPrice || product?.price || 0;

  const subtotal = cartItems?.cart?.reduce((total, item) => {
    return total + (getDiscountedPrice(item.product) * (item.qty || item.quantity || 1));
  }, 0) || 0;

  const totalAmount = subtotal + shippingCost + tax;

  useEffect(() => {
    if (!cartItems?.cart?.length) return;
    fetchSummary();
  }, [cartItems?.cart]);

  const fetchSummary = async () => {
    setSummaryLoading(true);
    try {
      const taxRes = await api.get('/api/tax/config');
      const taxConfig = taxRes.data.taxConfig;
      if (taxConfig && taxConfig.type !== 'none') {
        const computedTax = taxConfig.type === 'percentage' ? subtotal * (taxConfig.value / 100) : taxConfig.value;
        setTax(computedTax);
        setTaxLabel(taxConfig.type === 'percentage' ? `Tax (${taxConfig.value}%)` : `Tax (Fixed)`);
      } else { setTax(0); setTaxLabel('Tax'); }
    } catch { setTax(0); setTaxLabel('Tax'); }

    try {
      const cartPayload = cartItems.cart.map(item => ({ productId: item.product?._id, qty: item.qty || item.quantity || 1 }));
      const shipRes = await api.post('/api/shipping/cart', { cartItems: cartPayload });
      const sellerMap = shipRes.data.shippingMethods || {};
      let totalShipping = 0; let methodNames = [];
      Object.values(sellerMap).forEach(sellerData => {
        const methods = sellerData.methods || [];
        if (methods.length > 0) {
          const sorted = [...methods].sort((a, b) => a.cost - b.cost);
          totalShipping += sorted[0].cost;
          methodNames.push(sorted[0].type);
        }
      });
      setShippingCost(totalShipping);
      setShippingLabel(`Shipping (${methodNames.length > 0 ? methodNames[0] : 'standard'})`);
    } catch { setShippingCost(0); setShippingLabel('Shipping (free)'); }
    setSummaryLoading(false);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }));
  };

  const validateForm = () => {
    const newErrors = {};
    const required = ['fullName', 'email', 'phone', 'address', 'city', 'state', 'postalCode'];
    for (let field of required) {
      if (!formData[field]?.trim()) newErrors[field] = `${field.replace(/([A-Z])/g, ' $1').trim()} is required`;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (formData.email && !emailRegex.test(formData.email)) newErrors.email = 'Please enter a valid email address';
    const phoneDigits = formData.phone?.replace(/[\s\-\(\)\+]/g, '') || '';
    if (formData.phone && (phoneDigits.length < 10 || !/^\d+$/.test(phoneDigits))) newErrors.phone = 'Please enter a valid phone number';
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      Toast.show({ type: 'error', text1: 'Missing Information', text2: 'Please fill in all required fields correctly' });
      return false;
    }
    return true;
  };

  const buildOrder = () => ({
    orderItems: cartItems.cart.map(item => ({
      id: item.product._id, name: item.product.name,
      image: item.product.image || item.product.images?.[0]?.url,
      price: getDiscountedPrice(item.product), quantity: item.qty || item.quantity || 1,
    })),
    shippingInfo: formData,
    shippingMethod: { name: 'standard', price: shippingCost, estimatedDays: 5 },
    orderSummary: { subtotal, shippingCost, tax, totalAmount },
    paymentMethod: paymentMethod === 'card' ? 'stripe' : 'cash_on_delivery',
    platform: paymentMethod === 'card' ? 'mobile' : undefined,
  });

  const handlePlaceOrder = async () => {
    if (!validateForm()) return;
    setIsProcessing(true);
    try {
      const order = buildOrder();
      const res = await api.post('/api/order/place', { order });
      if (paymentMethod === 'card') {
        const { url } = res.data;
        if (!url) throw new Error('No Stripe URL returned');
        await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: 'cancel', presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN });
      } else {
        Toast.show({ type: 'success', text1: '🎉 Order Placed!', text2: res.data.msg || 'Your order has been placed successfully' });
        await api.delete('/api/cart/clear');
        fetchCart();
        setTimeout(() => { navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] }); }, 1200);
      }
    } catch (error) {
      Toast.show({ type: 'error', text1: 'Order Failed', text2: error.response?.data?.msg || 'Failed to place order.' });
    } finally { setIsProcessing(false); }
  };

  const renderInput = (field, placeholder, options = {}) => {
    const hasError = !!errors[field];
    return (
      <View style={[styles.inputGroup, options.halfWidth && styles.halfInput]}>
        <View style={[styles.inputContainer, hasError && styles.inputContainerError]}>
          {options.icon && <Ionicons name={options.icon} size={18} color={hasError ? colors.error : 'rgba(255,255,255,0.5)'} style={styles.inputIcon} />}
          <TextInput
            style={styles.input} placeholder={placeholder} placeholderTextColor="rgba(255,255,255,0.35)"
            value={formData[field]} onChangeText={(value) => handleInputChange(field, value)}
            keyboardType={options.keyboardType || 'default'} autoCapitalize={options.autoCapitalize || 'sentences'}
            multiline={options.multiline} numberOfLines={options.numberOfLines}
          />
        </View>
        {hasError && <Text style={styles.errorText}>{errors[field]}</Text>}
      </View>
    );
  };

  if (!cartItems?.cart || cartItems.cart.length === 0) {
    return (
      <GlassBackground>
        <View style={styles.emptyContainer}>
          <GlassPanel variant="panel" style={styles.emptyCard}>
            <Ionicons name="cart-outline" size={64} color="rgba(255,255,255,0.4)" />
            <Text style={styles.emptyTitle}>Your cart is empty</Text>
            <TouchableOpacity style={styles.shopButton} onPress={() => navigation.navigate('Home')}>
              <Text style={styles.shopButtonText}>Continue Shopping</Text>
            </TouchableOpacity>
          </GlassPanel>
        </View>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        {/* Glass Header */}
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={20} color={colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Checkout</Text>
            <Text style={styles.headerSubtitle}>{cartItems.cart.length} items · {formatPrice(totalAmount)}</Text>
          </View>
          <View style={styles.lockIcon}>
            <Ionicons name="lock-closed" size={18} color={colors.primary} />
          </View>
        </GlassPanel>

        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: 120, paddingTop: spacing.md }}>
          {/* Order Items */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="bag-outline" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>Order Items</Text>
              <View style={styles.badge}><Text style={styles.badgeText}>{cartItems.cart.length}</Text></View>
            </View>
            {cartItems.cart.map((item, index) => {
              const price = getDiscountedPrice(item.product);
              return (
                <View key={index} style={styles.cartItem}>
                  <Image source={{ uri: item.product?.image || item.product?.images?.[0]?.url }} style={styles.cartItemImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                  <View style={styles.cartItemInfo}>
                    <Text style={styles.cartItemName} numberOfLines={2}>{item.product?.name}</Text>
                    <Text style={styles.cartItemQty}>Qty: {item.qty || item.quantity || 1}</Text>
                  </View>
                  <Text style={styles.cartItemPrice}>{formatPrice(price)}</Text>
                </View>
              );
            })}
          </GlassPanel>

          {/* Shipping Info */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="location-outline" size={18} color={colors.secondary} />
              <Text style={styles.sectionTitle}>Shipping Information</Text>
            </View>
            {renderInput('fullName', 'Full Name', { icon: 'person-outline' })}
            {renderInput('email', 'Email Address', { icon: 'mail-outline', keyboardType: 'email-address', autoCapitalize: 'none' })}
            {renderInput('phone', 'Phone Number', { icon: 'call-outline', keyboardType: 'phone-pad' })}
            {renderInput('address', 'Street Address', { icon: 'home-outline', multiline: true, numberOfLines: 2 })}
            <View style={styles.row}>
              {renderInput('city', 'City', { halfWidth: true })}
              {renderInput('state', 'State/Province', { halfWidth: true })}
            </View>
            <View style={styles.row}>
              {renderInput('postalCode', 'Postal Code', { halfWidth: true, keyboardType: 'numeric' })}
              {renderInput('country', 'Country', { halfWidth: true })}
            </View>
          </GlassPanel>

          {/* Payment Method */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="card-outline" size={18} color={colors.info} />
              <Text style={styles.sectionTitle}>Payment Method</Text>
            </View>
            <TouchableOpacity style={[styles.paymentOption, paymentMethod === 'cash_on_delivery' && styles.paymentSelected]} onPress={() => setPaymentMethod('cash_on_delivery')}>
              <View style={[styles.radio, paymentMethod === 'cash_on_delivery' && styles.radioSelected]}>
                {paymentMethod === 'cash_on_delivery' && <View style={styles.radioInner} />}
              </View>
              <Ionicons name="cash-outline" size={22} color={colors.success} />
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentTitle}>Cash on Delivery</Text>
                <Text style={styles.paymentSub}>Pay when you receive your order</Text>
              </View>
            </TouchableOpacity>
            <View style={{ height: 10 }} />
            <TouchableOpacity style={[styles.paymentOption, paymentMethod === 'card' && styles.paymentSelected]} onPress={() => setPaymentMethod('card')}>
              <View style={[styles.radio, paymentMethod === 'card' && styles.radioSelected]}>
                {paymentMethod === 'card' && <View style={styles.radioInner} />}
              </View>
              <Ionicons name="card-outline" size={22} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentTitle}>Credit / Debit Card</Text>
                <Text style={styles.paymentSub}>Secure payment via Stripe</Text>
              </View>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.success} />
            </TouchableOpacity>
          </GlassPanel>

          {/* Order Summary */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="receipt-outline" size={18} color={colors.warning} />
              <Text style={styles.sectionTitle}>Order Summary</Text>
              {summaryLoading && <Loader size="small" />}
            </View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>{formatPrice(subtotal)}</Text></View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{shippingLabel}</Text><Text style={[styles.summaryValue, shippingCost === 0 && { color: colors.success }]}>{shippingCost === 0 ? 'Free' : formatPrice(shippingCost)}</Text></View>
            {tax > 0 && <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{taxLabel}</Text><Text style={styles.summaryValue}>{formatPrice(tax)}</Text></View>}
            <View style={styles.divider} />
            <View style={styles.summaryRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{formatPrice(totalAmount)}</Text></View>
          </GlassPanel>
        </ScrollView>

        {/* Footer */}
        <GlassPanel variant="floating" style={styles.footer}>
          <View style={{ flex: 1 }}>
            <Text style={styles.footerLabel}>Total</Text>
            <Text style={styles.footerValue}>{formatPrice(totalAmount)}</Text>
          </View>
          <TouchableOpacity style={[styles.placeOrderBtn, isProcessing && { opacity: 0.6 }]} onPress={handlePlaceOrder} disabled={isProcessing}>
            {isProcessing ? <InlineLoader size="small" color="#fff" /> : (
              <>
                <Ionicons name={paymentMethod === 'card' ? 'card-outline' : 'bag-check-outline'} size={20} color="#fff" />
                <Text style={styles.placeOrderText}>{paymentMethod === 'card' ? 'Pay with Card' : 'Place Order'}</Text>
              </>
            )}
          </TouchableOpacity>
        </GlassPanel>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.md, marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  headerSubtitle: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  lockIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  section: { marginBottom: spacing.md, padding: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, gap: spacing.sm },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text, flex: 1 },
  badge: { backgroundColor: 'rgba(99,102,241,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 },
  badgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.primary },
  cartItem: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: glass.borderSubtle },
  cartItemImage: { width: 52, height: 52, borderRadius: 12, backgroundColor: glass.bgSubtle },
  cartItemInfo: { flex: 1, marginLeft: spacing.md },
  cartItemName: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: colors.text, marginBottom: 2 },
  cartItemQty: { fontSize: fontSize.xs, color: colors.textSecondary },
  cartItemPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.text },
  inputGroup: { marginBottom: spacing.md },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bgSubtle, borderRadius: 14, borderWidth: 1, borderColor: glass.borderSubtle, paddingHorizontal: spacing.md },
  inputContainerError: { borderColor: colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, paddingVertical: 13, fontSize: fontSize.md, color: colors.text },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginTop: 4, marginLeft: 4 },
  row: { flexDirection: 'row', gap: spacing.md },
  halfInput: { flex: 1 },
  paymentOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bgSubtle, padding: spacing.md, borderRadius: 16, borderWidth: 1.5, borderColor: glass.borderSubtle, gap: spacing.md },
  paymentSelected: { borderColor: colors.primary, backgroundColor: 'rgba(99,102,241,0.08)' },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', justifyContent: 'center', alignItems: 'center' },
  radioSelected: { borderColor: colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },
  paymentTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  paymentSub: { fontSize: fontSize.sm, color: colors.textSecondary },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  summaryLabel: { fontSize: fontSize.md, color: colors.textSecondary },
  summaryValue: { fontSize: fontSize.md, color: colors.text, fontWeight: fontWeight.medium },
  divider: { height: 1, backgroundColor: glass.borderSubtle, marginVertical: spacing.md },
  totalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  totalValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.primary },
  footer: { position: 'absolute', bottom: 0, left: spacing.md, right: spacing.md, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.lg, marginBottom: spacing.sm },
  footerLabel: { fontSize: fontSize.sm, color: colors.textSecondary },
  footerValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  placeOrderBtn: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: 14, paddingHorizontal: spacing.xl, borderRadius: 16, alignItems: 'center', gap: spacing.sm, ...shadows.md },
  placeOrderText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyCard: { alignItems: 'center', padding: spacing.xxl },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.text, marginTop: spacing.lg, marginBottom: spacing.xl },
  shopButton: { backgroundColor: colors.primary, paddingVertical: 14, paddingHorizontal: spacing.xl, borderRadius: 16 },
  shopButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
