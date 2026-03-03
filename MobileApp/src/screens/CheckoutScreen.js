/**
 * CheckoutScreen
 * Modern checkout screen with shipping form and order summary
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import api from '../config/api';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader } from '../components/common';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
} from '../styles/theme';

export default function CheckoutScreen({ navigation }) {
  const { cartItems, fetchCart } = useGlobal();
  const { formatPrice } = useCurrency();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errors, setErrors] = useState({});
  const [paymentMethod, setPaymentMethod] = useState('cash_on_delivery');
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'Pakistan',
  });

  // Dynamic shipping & tax state
  const [shippingCost, setShippingCost] = useState(0);
  const [shippingLabel, setShippingLabel] = useState('Loading...');
  const [tax, setTax] = useState(0);
  const [taxLabel, setTaxLabel] = useState('Tax');
  const [summaryLoading, setSummaryLoading] = useState(true);

  // Get the effective price for a product (discounted or regular)
  const getDiscountedPrice = (product) => {
    return product?.discountedPrice || product?.price || 0;
  };

  // Calculate subtotal
  const subtotal = cartItems?.cart?.reduce((total, item) => {
    const price = getDiscountedPrice(item.product);
    return total + (price * (item.qty || item.quantity || 1));
  }, 0) || 0;

  const totalAmount = subtotal + shippingCost + tax;

  // Fetch shipping and tax from backend
  useEffect(() => {
    if (!cartItems?.cart?.length) return;
    fetchSummary();
  }, [cartItems?.cart]);

  const fetchSummary = async () => {
    setSummaryLoading(true);
    try {
      // Fetch tax config
      const taxRes = await api.get('/api/tax/config');
      const taxConfig = taxRes.data.taxConfig;
      if (taxConfig && taxConfig.type !== 'none') {
        const computedTax = taxConfig.type === 'percentage'
          ? subtotal * (taxConfig.value / 100)
          : taxConfig.value;
        setTax(computedTax);
        setTaxLabel(taxConfig.type === 'percentage' ? `Tax (${taxConfig.value}%)` : `Tax (Fixed)`);
      } else {
        setTax(0);
        setTaxLabel('Tax');
      }
    } catch {
      setTax(0);
      setTaxLabel('Tax');
    }

    try {
      // Fetch shipping cost
      const cartPayload = cartItems.cart.map(item => ({
        productId: item.product?._id,
        qty: item.qty || item.quantity || 1,
      }));
      const shipRes = await api.post('/api/shipping/cart', { cartItems: cartPayload });
      const sellerMap = shipRes.data.shippingMethods || {};
      // Sum the cheapest active method per seller
      let totalShipping = 0;
      let methodNames = [];
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
    } catch {
      setShippingCost(0);
      setShippingLabel('Shipping (free)');
    }
    setSummaryLoading(false);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    // Clear error when user types
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: null }));
    }
  };

  const validateForm = () => {
    const newErrors = {};
    const required = ['fullName', 'email', 'phone', 'address', 'city', 'state', 'postalCode'];
    
    for (let field of required) {
      if (!formData[field]?.trim()) {
        newErrors[field] = `${field.replace(/([A-Z])/g, ' $1').trim()} is required`;
      }
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (formData.email && !emailRegex.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address';
    }

    // Phone validation
    const phoneDigits = formData.phone?.replace(/[\s\-\(\)\+]/g, '') || '';
    if (formData.phone && (phoneDigits.length < 10 || !/^\d+$/.test(phoneDigits))) {
      newErrors.phone = 'Please enter a valid phone number';
    }
    
    setErrors(newErrors);
    
    if (Object.keys(newErrors).length > 0) {
      Toast.show({
        type: 'error',
        text1: 'Missing Information',
        text2: 'Please fill in all required fields correctly',
      });
      return false;
    }
    
    return true;
  };

  const buildOrder = () => ({
    orderItems: cartItems.cart.map(item => ({
      id: item.product._id,
      name: item.product.name,
      image: item.product.image || item.product.images?.[0]?.url,
      price: getDiscountedPrice(item.product),
      quantity: item.qty || item.quantity || 1,
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
        // Stripe checkout — open in-app browser
        const { url } = res.data;
        if (!url) throw new Error('No Stripe URL returned');
        // Opens Stripe-hosted checkout; when payment succeeds Stripe redirects
        // to tortrose://payment-success?orderId=... which deep-links back to app
        await WebBrowser.openBrowserAsync(url, {
          dismissButtonStyle: 'cancel',
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        });
        // Browser closed (either done or user dismissed). Deep link will
        // navigate to PaymentSuccessScreen if payment went through.
      } else {
        // Cash on delivery — immediate confirmation
        Toast.show({
          type: 'success',
          text1: '🎉 Order Placed!',
          text2: res.data.msg || 'Your order has been placed successfully',
        });
        await api.delete('/api/cart/clear');
        fetchCart();
        setTimeout(() => {
          navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] });
        }, 1200);
      }
    } catch (error) {
      console.error('Order placement error:', error);
      Toast.show({
        type: 'error',
        text1: 'Order Failed',
        text2: error.response?.data?.msg || 'Failed to place order. Please try again.',
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const renderInput = (field, placeholder, options = {}) => {
    const hasError = !!errors[field];
    return (
      <View style={[styles.inputGroup, options.halfWidth && styles.halfInput]}>
        <View style={[styles.inputContainer, hasError && styles.inputContainerError]}>
          {options.icon && (
            <Ionicons 
              name={options.icon} 
              size={18} 
              color={hasError ? colors.error : colors.gray} 
              style={styles.inputIcon}
            />
          )}
          <TextInput
            style={styles.input}
            placeholder={placeholder}
            placeholderTextColor={colors.grayLight}
            value={formData[field]}
            onChangeText={(value) => handleInputChange(field, value)}
            keyboardType={options.keyboardType || 'default'}
            autoCapitalize={options.autoCapitalize || 'sentences'}
            multiline={options.multiline}
            numberOfLines={options.numberOfLines}
            accessibilityLabel={placeholder}
          />
        </View>
        {hasError && (
          <Text style={styles.errorText}>{errors[field]}</Text>
        )}
      </View>
    );
  };

  if (!cartItems?.cart || cartItems.cart.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.emptyContainer}>
          <Ionicons name="cart-outline" size={64} color={colors.grayLight} />
          <Text style={styles.emptyTitle}>Your cart is empty</Text>
          <TouchableOpacity 
            style={styles.shopButton}
            onPress={() => navigation.navigate('Home')}
          >
            <Text style={styles.shopButtonText}>Continue Shopping</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}
      >
        {/* Hero Header */}
        <View style={styles.heroHeader}>
          <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={colors.white} />
          </TouchableOpacity>
          <View style={styles.heroLeft}>
            <Text style={styles.heroTitle}>Checkout</Text>
            <Text style={styles.heroSubtitle}>{cartItems.cart.length} {cartItems.cart.length === 1 ? 'item' : 'items'} · {formatPrice(totalAmount)}</Text>
          </View>
          <View style={styles.heroIcon}>
            <Ionicons name="lock-closed" size={22} color={colors.white} />
          </View>
        </View>

        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Order Items Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="bag-outline" size={20} color={colors.primary} />
              <Text style={styles.sectionTitle}>Order Items</Text>
              <View style={styles.itemCountBadge}>
                <Text style={styles.itemCountText}>{cartItems.cart.length}</Text>
              </View>
            </View>
            
            {cartItems.cart.map((item, index) => {
              const price = getDiscountedPrice(item.product);
              const originalPrice = item.product?.discountedPrice || item.product?.price;
              const hasDiscount = price < originalPrice;
              
              return (
                <View key={index} style={styles.cartItem}>
                  <Image
                    source={{ uri: item.product?.image || item.product?.images?.[0]?.url }}
                    style={styles.cartItemImage}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={150}
                  />
                  <View style={styles.cartItemInfo}>
                    <Text style={styles.cartItemName} numberOfLines={2}>
                      {item.product?.name}
                    </Text>
                    <Text style={styles.cartItemQuantity}>
                      Qty: {item.qty || item.quantity || 1}
                    </Text>
                  </View>
                  <View style={styles.cartItemPriceContainer}>
                    <Text style={[styles.cartItemPrice, hasDiscount && styles.discountedPrice]}>
                      {formatPrice(price)}
                    </Text>
                    {hasDiscount && (
                      <Text style={styles.originalPrice}>{formatPrice(originalPrice)}</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>

          {/* Shipping Information Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="location-outline" size={20} color={colors.secondary} />
              <Text style={styles.sectionTitle}>Shipping Information</Text>
            </View>
            
            {renderInput('fullName', 'Full Name', { icon: 'person-outline' })}
            {renderInput('email', 'Email Address', { 
              icon: 'mail-outline', 
              keyboardType: 'email-address',
              autoCapitalize: 'none',
            })}
            {renderInput('phone', 'Phone Number', { 
              icon: 'call-outline', 
              keyboardType: 'phone-pad',
            })}
            {renderInput('address', 'Street Address', { 
              icon: 'home-outline',
              multiline: true,
              numberOfLines: 2,
            })}
            
            <View style={styles.row}>
              {renderInput('city', 'City', { halfWidth: true })}
              {renderInput('state', 'State/Province', { halfWidth: true })}
            </View>
            
            <View style={styles.row}>
              {renderInput('postalCode', 'Postal Code', { 
                halfWidth: true,
                keyboardType: 'numeric',
              })}
              {renderInput('country', 'Country', { halfWidth: true })}
            </View>
          </View>

          {/* Payment Method Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="card-outline" size={20} color={colors.info} />
              <Text style={styles.sectionTitle}>Payment Method</Text>
            </View>
            
            {/* Cash on Delivery */}
            <TouchableOpacity
              style={[styles.paymentOption, paymentMethod === 'cash_on_delivery' && styles.paymentOptionSelected]}
              onPress={() => setPaymentMethod('cash_on_delivery')}
              activeOpacity={0.8}
            >
              <View style={[styles.paymentRadio, paymentMethod === 'cash_on_delivery' && styles.paymentRadioSelected]}>
                {paymentMethod === 'cash_on_delivery' && <View style={styles.paymentRadioInner} />}
              </View>
              <Ionicons name="cash-outline" size={24} color={colors.success} />
              <View style={styles.paymentInfo}>
                <Text style={styles.paymentTitle}>Cash on Delivery</Text>
                <Text style={styles.paymentSubtitle}>Pay when you receive your order</Text>
              </View>
            </TouchableOpacity>

            <View style={{ height: 10 }} />

            {/* Card / Stripe */}
            <TouchableOpacity
              style={[styles.paymentOption, paymentMethod === 'card' && styles.paymentOptionSelected]}
              onPress={() => setPaymentMethod('card')}
              activeOpacity={0.8}
            >
              <View style={[styles.paymentRadio, paymentMethod === 'card' && styles.paymentRadioSelected]}>
                {paymentMethod === 'card' && <View style={styles.paymentRadioInner} />}
              </View>
              <Ionicons name="card-outline" size={24} color={colors.primary} />
              <View style={styles.paymentInfo}>
                <Text style={styles.paymentTitle}>Credit / Debit Card</Text>
                <Text style={styles.paymentSubtitle}>Secure payment via Stripe</Text>
              </View>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.success} />
            </TouchableOpacity>
          </View>

          {/* Order Summary Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="receipt-outline" size={20} color={colors.warning} />
              <Text style={styles.sectionTitle}>Order Summary</Text>
              {summaryLoading && <Loader size="small" />}
            </View>

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>{formatPrice(subtotal)}</Text>
            </View>

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>{shippingLabel}</Text>
              <Text style={[styles.summaryValue, shippingCost === 0 && styles.freeShipping]}>
                {shippingCost === 0 ? 'Free' : formatPrice(shippingCost)}
              </Text>
            </View>

            {tax > 0 && (
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{taxLabel}</Text>
                <Text style={styles.summaryValue}>{formatPrice(tax)}</Text>
              </View>
            )}

            <View style={styles.divider} />

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>{formatPrice(totalAmount)}</Text>
            </View>
          </View>

          {/* Spacer for footer */}
          <View style={{ height: 100 }} />
        </ScrollView>

        {/* Footer */}
        <View style={styles.footer}>
          <View style={styles.footerTotal}>
            <Text style={styles.footerTotalLabel}>Total</Text>
            <Text style={styles.footerTotalValue}>{formatPrice(totalAmount)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.placeOrderButton, isProcessing && styles.buttonDisabled]}
            onPress={handlePlaceOrder}
            disabled={isProcessing}
            accessibilityLabel="Place order"
            accessibilityRole="button"
          >
            {isProcessing ? (
              <InlineLoader size="small" color={colors.white} />
            ) : (
              <>
                <Ionicons
                  name={paymentMethod === 'card' ? 'card-outline' : 'bag-check-outline'}
                  size={20}
                  color={colors.white}
                />
                <Text style={styles.placeOrderText}>
                  {paymentMethod === 'card' ? 'Pay with Card' : 'Place Order'}
                </Text>
                <Ionicons name="arrow-forward" size={20} color={colors.white} />
              </>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  // Hero Header
  heroHeader: {
    backgroundColor: colors.primaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  heroBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
  },
  heroLeft: {
    flex: 1,
  },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
    marginBottom: 2,
  },
  heroSubtitle: {
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.75)',
  },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Section styles
  section: {
    backgroundColor: colors.white,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.dark,
    flex: 1,
  },
  itemCountBadge: {
    backgroundColor: colors.primaryLighter,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  itemCountText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  // Cart item styles
  cartItem: {
    flexDirection: 'row',
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  cartItemImage: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    backgroundColor: colors.light,
  },
  cartItemInfo: {
    flex: 1,
    marginLeft: spacing.md,
    justifyContent: 'center',
  },
  cartItemName: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.dark,
    marginBottom: spacing.xs,
  },
  cartItemQuantity: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
  },
  cartItemPriceContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  cartItemPrice: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  discountedPrice: {
    color: '#f59e0b',
  },
  originalPrice: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  // Input styles
  inputGroup: {
    marginBottom: spacing.md,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.light,
    paddingHorizontal: spacing.md,
  },
  inputContainerError: {
    borderColor: colors.error,
    backgroundColor: 'rgba(239, 68, 68, 0.05)',
  },
  inputIcon: {
    marginRight: spacing.sm,
  },
  input: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
  },
  errorText: {
    fontSize: fontSize.xs,
    color: colors.error,
    marginTop: spacing.xs,
    marginLeft: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  halfInput: {
    flex: 1,
  },
  // Payment styles
  paymentOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: colors.light,
    gap: spacing.md,
  },
  paymentOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySubtle || '#eef2ff',
  },
  paymentRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.grayLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  paymentRadioSelected: {
    borderColor: colors.primary,
  },
  paymentRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  paymentInfo: {
    flex: 1,
  },
  paymentTitle: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  paymentSubtitle: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  // Summary styles
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
  divider: {
    height: 1,
    backgroundColor: colors.light,
    marginVertical: spacing.md,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  totalLabel: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.dark,
  },
  totalValue: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  // Footer styles
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.light,
    ...shadows.lg,
    gap: spacing.lg,
  },
  footerTotal: {
    flex: 1,
  },
  footerTotalLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  footerTotalValue: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  placeOrderButton: {
    flexDirection: 'row',
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    gap: spacing.sm,
    ...shadows.md,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  placeOrderText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  shopButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: borderRadius.lg,
  },
  shopButtonText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  freeShipping: {
    color: colors.success,
    fontWeight: fontWeight.semibold,
  },
});
