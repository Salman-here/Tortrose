/**
 * CheckoutScreen — Liquid Glass Design
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, Modal, Alert, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import Feedback from '../utils/feedback';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as WebBrowser from 'expo-web-browser';
import api, { API_ENDPOINTS } from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { Loader, InlineLoader } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import LocationAutocomplete from '../components/common/LocationAutocomplete';
import { trackCheckoutStep, trackPaymentEvent, trackError } from '../utils/breadcrumbs';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function CheckoutScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const { cartItems, fetchCart } = useGlobal();
  const {
    currency,
    convertAmount,
    formatAmount,
    formatProductPrice,
    getProductCurrency,
    getProductPriceNumber,
  } = useCurrency();

  const [isProcessing, setIsProcessing] = useState(false);
  const [errors, setErrors] = useState({});
  const [paymentMethod, setPaymentMethod] = useState('cash_on_delivery');
  const [formData, setFormData] = useState({
    fullName: '', email: '', phone: '', address: '',
    city: '', state: '', stateCode: '', postalCode: '', country: 'Pakistan', countryCode: 'PK',
  });
  const [savedShippingInfo, setSavedShippingInfo] = useState(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const [pendingOrderData, setPendingOrderData] = useState(null);

  const [shippingCost, setShippingCost] = useState(0);
  const [shippingLabel, setShippingLabel] = useState('Loading...');
  const [sellerShipping, setSellerShipping] = useState([]);
  const [codRestrictedSellers, setCodRestrictedSellers] = useState([]);
  const [tax, setTax] = useState(0);
  const [taxLabel, setTaxLabel] = useState('Tax');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [wallet, setWallet] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);

  // Coupon state
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponLoading, setCouponLoading] = useState(false);
  const [couponDiscount, setCouponDiscount] = useState(0);

  const getEffectivePriceField = (product) => (
    Number(product?.discountedPrice || 0) > 0 && Number(product?.discountedPrice) < Number(product?.price)
      ? 'discountedPrice'
      : 'price'
  );

  const getSourcePrice = (product) => {
    const price = Number(product?.price || 0);
    const discountedPrice = Number(product?.discountedPrice || 0);
    return discountedPrice > 0 && discountedPrice < price ? discountedPrice : price;
  };

  const productPriceInCheckoutCurrency = (product, amount = undefined) => {
    if (!product) return 0;
    if (amount !== undefined) return convertAmount(amount, getProductCurrency(product), currency);
    return getProductPriceNumber(product, getEffectivePriceField(product));
  };

  const shippingMethodCurrency = (method, sellerInfo = null) => method?.currency || method?.costCurrency || sellerInfo?.seller?.currency || currency;
  const shippingCostInCheckoutCurrency = (method, sellerInfo = null) =>
    convertAmount(method?.cost || 0, shippingMethodCurrency(method, sellerInfo), currency);

  const couponCurrency = (coupon) => coupon?.currency || currency;
  const couponAmountInCheckoutCurrency = (amount, coupon = null) =>
    convertAmount(amount || 0, couponCurrency(coupon), currency);

  const getShippingMethodTitle = (method) => ({
    free: 'Free Shipping',
    standard: 'Standard Shipping',
    fast: 'Fast Shipping',
  }[method?.type] || `${method?.type || 'Shipping'} Shipping`);

  const subtotal = cartItems?.cart?.reduce((total, item) => {
    return total + (productPriceInCheckoutCurrency(item.product) * (item.qty || item.quantity || 1));
  }, 0) || 0;

  const totalAmount = subtotal + shippingCost + tax - couponDiscount;
  const walletBalance = Number(wallet?.balances?.[currency] || 0);
  const walletAvailable = !!currentUser && wallet?.status === 'active' && walletBalance + 0.001 >= totalAmount;

  // Fetch saved shipping info
  useEffect(() => {
    const fetchShippingInfo = async () => {
      try {
        const res = await api.get('/api/user/shipping-info');
        if (res.data?.shippingInfo) {
          setSavedShippingInfo(res.data.shippingInfo);
        }
      } catch {}
    };
    if (currentUser) fetchShippingInfo();
  }, [currentUser]);

  useEffect(() => {
    if (!cartItems?.cart?.length) return;
    fetchSummary();
  }, [cartItems?.cart, subtotal, currency]);

  useEffect(() => {
    const fetchWallet = async () => {
      if (!currentUser) {
        setWallet(null);
        return;
      }
      setWalletLoading(true);
      try {
        const response = await api.get('/api/wallet/me?limit=1');
        setWallet(response.data?.wallet || null);
      } catch {
        setWallet(null);
      } finally {
        setWalletLoading(false);
      }
    };
    fetchWallet();
    const unsubscribe = navigation.addListener('focus', fetchWallet);
    return unsubscribe;
  }, [currentUser, currency, navigation]);

  const fetchSummary = async () => {
    setSummaryLoading(true);
    try {
      const taxRes = await api.get('/api/tax/config');
      const taxConfig = taxRes.data.taxConfig;
      if (taxConfig && taxConfig.type !== 'none') {
        const computedTax = taxConfig.type === 'percentage' ? subtotal * (taxConfig.value / 100) : Number(taxConfig.value || 0);
        setTax(computedTax);
        setTaxLabel(taxConfig.type === 'percentage' ? `Tax (${taxConfig.value}%)` : `Tax (Fixed)`);
      } else { setTax(0); setTaxLabel('Tax'); }
    } catch { setTax(0); setTaxLabel('Tax'); }

    try {
      const cartPayload = cartItems.cart.map(item => ({ productId: item.product?._id, qty: item.qty || item.quantity || 1 }));
      const shipRes = await api.post(API_ENDPOINTS.SHIPPING.CART, { cartItems: cartPayload });
      const sellerMap = shipRes.data.shippingMethods || {};
      let totalShipping = 0;
      const methodNames = [];
      const nextSellerShipping = [];
      const nextCodRestrictedSellers = [];
      Object.entries(sellerMap).forEach(([sellerId, sellerData]) => {
        if (sellerData?.allowsCashOnDelivery === false) {
          nextCodRestrictedSellers.push(sellerData?.store?.storeName || sellerData?.seller?.username || 'A seller');
        }
        const methods = sellerData.methods || [];
        if (methods.length > 0) {
          const sorted = [...methods].sort((a, b) => shippingCostInCheckoutCurrency(a, sellerData) - shippingCostInCheckoutCurrency(b, sellerData));
          const selectedMethod = sorted[0];
          const selectedCost = shippingCostInCheckoutCurrency(selectedMethod, sellerData);
          totalShipping += selectedCost;
          methodNames.push(getShippingMethodTitle(selectedMethod));
          nextSellerShipping.push({
            seller: sellerId,
            shippingMethod: {
              name: selectedMethod.type || 'free',
              price: selectedCost,
              estimatedDays: selectedMethod.deliveryDays || 5,
            },
          });
        }
      });
      setShippingCost(totalShipping);
      setSellerShipping(nextSellerShipping);
      setCodRestrictedSellers(nextCodRestrictedSellers);
      if (nextCodRestrictedSellers.length > 0 && paymentMethod === 'cash_on_delivery') {
        setPaymentMethod('card');
      }
      setShippingLabel(methodNames.length > 0 ? `Shipping (${methodNames.length === 1 ? methodNames[0] : `${methodNames.length} sellers`})` : 'Shipping (Free)');
    } catch {
      setShippingCost(0);
      setSellerShipping([]);
      setCodRestrictedSellers([]);
      setShippingLabel('Shipping (Free)');
    }
    setSummaryLoading(false);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }));
  };

  const validateForm = () => {
    const newErrors = {};
    const required = ['fullName', 'email', 'phone', 'address', 'country', 'city', 'postalCode'];
    for (let field of required) {
      if (!formData[field]?.trim()) newErrors[field] = `${field.replace(/([A-Z])/g, ' $1').trim()} is required`;
    }
    if (!formData.countryCode) newErrors.country = 'Please select your country from the list';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (formData.email && !emailRegex.test(formData.email)) newErrors.email = 'Please enter a valid email address';
    const phoneDigits = formData.phone?.replace(/[\s\-\(\)\+]/g, '') || '';
    if (formData.phone && (phoneDigits.length < 10 || !/^\d+$/.test(phoneDigits))) newErrors.phone = 'Please enter a valid phone number';
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      Feedback.show({ type: 'error', text1: 'Missing Information', text2: 'Please fill in all required fields correctly' });
      return false;
    }
    return true;
  };

  const autoFillShipping = () => {
    if (savedShippingInfo) {
      setFormData({
        fullName: savedShippingInfo.fullName || '',
        email: savedShippingInfo.email || '',
        phone: savedShippingInfo.phone || '',
        address: savedShippingInfo.address || '',
        city: savedShippingInfo.city || '',
        state: savedShippingInfo.state || '',
        stateCode: savedShippingInfo.stateCode || '',
        postalCode: savedShippingInfo.postalCode || '',
        country: savedShippingInfo.country || 'Pakistan',
        countryCode: savedShippingInfo.countryCode || 'PK',
      });
      Feedback.show({ type: 'success', text1: 'Auto-Filled!', text2: 'Shipping info loaded from your profile' });
    }
  };

  const hasShippingInfoChanged = () => {
    if (!savedShippingInfo) return true;
    return Object.keys(formData).some(key => (formData[key] || '') !== (savedShippingInfo[key] || ''));
  };

  const handleApplyCoupon = async () => {
    if (!couponCode.trim()) { Feedback.show({ type: 'error', text1: 'Enter a coupon code' }); return; }
    setCouponLoading(true);
    try {
      const productIds = cartItems.cart.map(item => item.product._id);
      const res = await api.post(API_ENDPOINTS.COUPONS.VALIDATE, { code: couponCode.trim(), productIds, currency });
      if (res.data.valid) {
        const coupon = res.data.coupon;
        let discount = 0;
        const applicableIds = (coupon.applicableProductIds || []).map(id => String(id));
        cartItems.cart.forEach(item => {
          if (applicableIds.includes(String(item.product._id))) {
            const price = productPriceInCheckoutCurrency(item.product);
            const qty = item.qty || item.quantity || 1;
            if (coupon.discountType === 'percentage') discount += (price * qty * coupon.discountValue) / 100;
            else discount += couponAmountInCheckoutCurrency(coupon.discountValue, coupon);
          }
        });
        const maxDiscount = coupon.maxDiscountAmount ? couponAmountInCheckoutCurrency(coupon.maxDiscountAmount, coupon) : null;
        if (maxDiscount && discount > maxDiscount) discount = maxDiscount;
        setCouponDiscount(discount);
        setAppliedCoupon(coupon);
        Feedback.show({ type: 'success', text1: 'Coupon Applied!', text2: `${coupon.discountType === 'percentage' ? `${coupon.discountValue}%` : formatAmount(couponAmountInCheckoutCurrency(coupon.discountValue, coupon))} off` });
      }
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Invalid Coupon', text2: err.response?.data?.msg || 'Coupon not valid' });
    } finally { setCouponLoading(false); }
  };

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null); setCouponDiscount(0); setCouponCode('');
    Feedback.show({ type: 'info', text1: 'Coupon removed' });
  };

  const buildOrder = () => {
    const primaryShipping = sellerShipping[0]?.shippingMethod || {
      name: shippingCost === 0 ? 'free' : 'standard',
      price: shippingCost,
      estimatedDays: 5,
    };

    return {
      orderItems: cartItems.cart.map(item => {
        const sourcePrice = getSourcePrice(item.product);
        return {
          id: item.product._id,
          name: item.product.name,
          image: item.product.image || item.product.images?.[0]?.url,
          price: productPriceInCheckoutCurrency(item.product, sourcePrice),
          sourcePrice,
          sourceCurrency: getProductCurrency(item.product),
          quantity: item.qty || item.quantity || 1,
          selectedColor: item.selectedColor || null,
          selectedOptions: item.selectedOptions || undefined,
        };
      }),
      shippingInfo: formData,
      buyerLocation: {
        country: formData.country || 'Pakistan',
        countryCode: formData.countryCode || '',
        region: formData.state || '',
        regionCode: formData.stateCode || '',
        city: formData.city || '',
        cityStateCode: formData.stateCode || '',
        town: '',
        townStateCode: '',
        lat: '',
        lng: '',
      },
      shippingMethod: { ...primaryShipping, seller: sellerShipping[0]?.seller },
      sellerShipping,
      orderSummary: { subtotal, shippingCost, tax, couponDiscount, totalAmount },
      currency,
      appliedCoupons: appliedCoupon ? [{
        couponId: appliedCoupon._id,
        code: appliedCoupon.code,
        discountType: appliedCoupon.discountType,
        discountValue: appliedCoupon.discountType === 'fixed'
          ? couponAmountInCheckoutCurrency(appliedCoupon.discountValue, appliedCoupon)
          : appliedCoupon.discountValue,
        currency,
        sourceDiscountValue: appliedCoupon.discountValue,
        sourceCurrency: couponCurrency(appliedCoupon),
        applicableProductIds: appliedCoupon.applicableProductIds,
      }] : [],
      paymentMethod: paymentMethod === 'card'
        ? 'stripe'
        : paymentMethod === 'wallet'
          ? 'wallet'
          : 'cash_on_delivery',
      platform: paymentMethod === 'card' ? 'mobile' : undefined,
    };
  };

  const completeOrder = async (order, shouldSaveInfo) => {
    if (shouldSaveInfo) {
      try { await api.patch('/api/user/shipping-info', { shippingInfo: formData }); setSavedShippingInfo(formData); } catch {}
    }
    if (paymentMethod !== 'card') {
      Feedback.show({
        type: 'success',
        text1: paymentMethod === 'wallet' ? 'Payment Successful!' : 'Order Placed!',
        text2: paymentMethod === 'wallet'
          ? 'Your Rozare Wallet payment is complete.'
          : 'Your order has been placed successfully',
      });
      await api.delete(API_ENDPOINTS.CART.CLEAR);
      fetchCart();
      setTimeout(() => { navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] }); }, 1200);
    }
  };

  const handlePlaceOrder = async () => {
    trackCheckoutStep('place_order_clicked', { paymentMethod, items: cartItems?.cart?.length, total: totalAmount });
    if (paymentMethod === 'cash_on_delivery' && codRestrictedSellers.length > 0) {
      Feedback.show({
        type: 'error',
        text1: 'Advance payment required',
        text2: 'One or more sellers require online payment.',
      });
      setPaymentMethod('card');
      return;
    }
    if (paymentMethod === 'wallet' && !currentUser) {
      Feedback.show({ type: 'error', text1: 'Login required', text2: 'Log in to pay with Rozare Wallet.' });
      return;
    }
    if (paymentMethod === 'wallet' && !walletAvailable) {
      Feedback.show({
        type: 'error',
        text1: wallet?.status === 'locked' ? 'Wallet locked' : 'Insufficient wallet balance',
        text2: wallet?.status === 'locked'
          ? (wallet.lockedReason || 'Contact support to unlock your wallet.')
          : `Available: ${formatAmount(walletBalance)}. Add balance before paying.`,
      });
      return;
    }
    if (!validateForm()) {
      trackCheckoutStep('validation_failed');
      return;
    }
    setIsProcessing(true);
    try {
      const order = buildOrder();
      trackCheckoutStep('order_built', { itemCount: order.orderItems.length });
      const res = await api.post('/api/order/place', { order });
      trackCheckoutStep('order_api_success', { orderId: res.data?.orderId });
      if (paymentMethod === 'card') {
        const { url } = res.data;
        if (!url) throw new Error('No Stripe URL returned');
        trackPaymentEvent('stripe_redirect', { url: url.substring(0, 60) });
        await WebBrowser.openBrowserAsync(url, { dismissButtonStyle: 'cancel', presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN });
        // Save shipping info on first order
        if (!savedShippingInfo?.fullName) {
          try { await api.patch('/api/user/shipping-info', { shippingInfo: formData }); setSavedShippingInfo(formData); } catch {}
        }
      } else {
        // Check if info changed
        if (savedShippingInfo?.fullName && hasShippingInfoChanged()) {
          setPendingOrderData({ order, data: res.data });
          setShowUpdatePrompt(true);
        } else {
          // First time or no change - auto-save
          await completeOrder(order, !savedShippingInfo?.fullName);
        }
      }
    } catch (error) {
      trackError('checkout', error, { step: 'place_order', paymentMethod });
      Feedback.show({ type: 'error', text1: 'Order Failed', text2: error.response?.data?.msg || 'Failed to place order.' });
    } finally { setIsProcessing(false); }
  };

  const renderInput = (field, placeholder, options = {}) => {
    const hasError = !!errors[field];
    return (
      <View style={[styles.inputGroup, options.halfWidth && styles.halfInput]}>
        <View style={[styles.inputContainer, hasError && styles.inputContainerError]}>
          {options.icon && <Ionicons name={options.icon} size={18} color={hasError ? palette.colors.error : 'rgba(255,255,255,0.5)'} style={styles.inputIcon} />}
          <TextInput
            style={styles.input} placeholder={placeholder} placeholderTextColor={palette.colors.grayLight}
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
            <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Checkout</Text>
            <Text style={styles.headerSubtitle}>{cartItems.cart.length} items - {formatAmount(totalAmount)}</Text>
          </View>
          <View style={styles.lockIcon}>
            <Ionicons name="lock-closed" size={18} color={palette.colors.primary} />
          </View>
        </GlassPanel>

        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: 120, paddingTop: spacing.md }}>
          {/* Order Items */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="bag-outline" size={18} color={palette.colors.primary} />
              <Text style={styles.sectionTitle}>Order Items</Text>
              <View style={styles.badge}><Text style={styles.badgeText}>{cartItems.cart.length}</Text></View>
            </View>
            {cartItems.cart.map((item, index) => {
              const priceField = getEffectivePriceField(item.product);
              const selectedOptions = item.selectedOptions && typeof item.selectedOptions === 'object'
                ? Object.entries(item.selectedOptions).filter(([, value]) => value)
                : [];
              return (
                <View key={index} style={styles.cartItem}>
                  <Image source={{ uri: item.product?.image || item.product?.images?.[0]?.url }} style={styles.cartItemImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                  <View style={styles.cartItemInfo}>
                    <Text style={styles.cartItemName} numberOfLines={2}>{item.product?.name}</Text>
                    {item.selectedColor && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                        <Ionicons name="color-palette-outline" size={11} color={palette.colors.primary} />
                        <Text style={{ fontSize: 11, color: palette.colors.primary }}>{item.selectedColor}</Text>
                      </View>
                    )}
                    {selectedOptions.map(([name, value]) => (
                      <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                        <Ionicons name="options-outline" size={11} color={palette.colors.primary} />
                        <Text style={{ fontSize: 11, color: palette.colors.primary }}>{name}: {value}</Text>
                      </View>
                    ))}
                    <Text style={styles.cartItemQty}>Qty: {item.qty || item.quantity || 1}</Text>
                  </View>
                  <Text style={styles.cartItemPrice}>{formatProductPrice(item.product, { field: priceField })}</Text>
                </View>
              );
            })}
          </GlassPanel>

          {/* Shipping Info */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="location-outline" size={18} color={palette.colors.secondary} />
              <Text style={styles.sectionTitle}>Shipping Information</Text>
              {savedShippingInfo?.fullName && (
                <TouchableOpacity onPress={autoFillShipping} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.1)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16 }}>
                  <Ionicons name="flash-outline" size={14} color={palette.colors.primary} />
                  <Text style={{ fontSize: 12, color: palette.colors.primary, fontWeight: fontWeight.semibold }}>Auto Fill</Text>
                </TouchableOpacity>
              )}
            </View>
            {renderInput('fullName', 'Full Name', { icon: 'person-outline' })}
            {renderInput('email', 'Email Address', { icon: 'mail-outline', keyboardType: 'email-address', autoCapitalize: 'none' })}
            {renderInput('phone', 'Phone Number', { icon: 'call-outline', keyboardType: 'phone-pad' })}
            {renderInput('address', 'Street Address', { icon: 'home-outline', multiline: true, numberOfLines: 2 })}
            <LocationAutocomplete
              type="country"
              label="Country"
              required
              value={formData.country}
              code={formData.countryCode}
              placeholder="Select country"
              error={errors.country}
              onSelect={(option) => {
                setFormData(prev => ({
                  ...prev,
                  country: option.name,
                  countryCode: option.isoCode,
                  state: '',
                  stateCode: '',
                  city: '',
                }));
                setErrors(prev => ({ ...prev, country: null, city: null, state: null }));
              }}
              onClear={() => {
                setFormData(prev => ({ ...prev, country: '', countryCode: '', state: '', stateCode: '', city: '' }));
                setErrors(prev => ({ ...prev, country: 'Country is required' }));
              }}
            />
            <LocationAutocomplete
              type="state"
              label="State / Province"
              value={formData.state}
              code={formData.stateCode}
              countryCode={formData.countryCode}
              countryName={formData.country}
              placeholder="Select state"
              disabled={!formData.countryCode && !formData.country}
              error={errors.state}
              onSelect={(option) => {
                setFormData(prev => ({
                  ...prev,
                  state: option.name,
                  stateCode: option.isoCode,
                  city: '',
                }));
                setErrors(prev => ({ ...prev, state: null }));
              }}
              onClear={() => setFormData(prev => ({ ...prev, state: '', stateCode: '', city: '' }))}
            />
            <LocationAutocomplete
              type="city"
              label="City"
              required
              value={formData.city}
              countryCode={formData.countryCode}
              countryName={formData.country}
              stateCode={formData.stateCode}
              stateName={formData.state}
              placeholder="Select city"
              disabled={!formData.countryCode && !formData.country}
              error={errors.city}
              onSelect={(option) => {
                setFormData(prev => ({
                  ...prev,
                  city: option.name,
                  state: prev.state || option.stateName || '',
                  stateCode: prev.stateCode || option.stateCode || '',
                }));
                setErrors(prev => ({ ...prev, city: null }));
              }}
              onClear={() => {
                setFormData(prev => ({ ...prev, city: '' }));
                setErrors(prev => ({ ...prev, city: 'City is required' }));
              }}
            />
            {renderInput('postalCode', 'Postal Code', { keyboardType: 'numeric' })}
          </GlassPanel>

          {/* Coupon Code */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="pricetag-outline" size={18} color="#f97316" />
              <Text style={styles.sectionTitle}>Coupon Code</Text>
            </View>
            {appliedCoupon ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(34,197,94,0.1)', padding: spacing.md, borderRadius: 14, gap: spacing.sm }}>
                <Ionicons name="checkmark-circle" size={20} color={palette.colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.success }}>{appliedCoupon.code}</Text>
                  <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>
                    {appliedCoupon.discountType === 'percentage' ? `${appliedCoupon.discountValue}% off` : `${formatAmount(couponAmountInCheckoutCurrency(appliedCoupon.discountValue, appliedCoupon))} off`} - Saving {formatAmount(couponDiscount)}
                  </Text>
                </View>
                <TouchableOpacity onPress={handleRemoveCoupon}><Ionicons name="close-circle" size={22} color={palette.colors.error} /></TouchableOpacity>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={[styles.inputContainer, { flex: 1 }]}>
                  <Ionicons name="pricetag-outline" size={16} color="rgba(255,255,255,0.5)" style={styles.inputIcon} />
                  <TextInput style={styles.input} placeholder="Enter coupon code" placeholderTextColor={palette.colors.grayLight} value={couponCode} onChangeText={setCouponCode} autoCapitalize="characters" />
                </View>
                <TouchableOpacity style={{ backgroundColor: palette.colors.primary, paddingHorizontal: spacing.lg, borderRadius: 14, justifyContent: 'center', alignItems: 'center' }} onPress={handleApplyCoupon} disabled={couponLoading}>
                  {couponLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ color: '#fff', fontWeight: fontWeight.bold, fontSize: fontSize.sm }}>Apply</Text>}
                </TouchableOpacity>
              </View>
            )}
          </GlassPanel>

          {/* Payment Method */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="card-outline" size={18} color={palette.colors.info} />
              <Text style={styles.sectionTitle}>Payment Method</Text>
            </View>
            {codRestrictedSellers.length > 0 && (
              <View style={styles.advanceOnlyNotice}>
                <Ionicons name="information-circle-outline" size={18} color={palette.colors.info} />
                <Text style={styles.advanceOnlyNoticeText}>
                  Cash on Delivery is unavailable because {codRestrictedSellers.join(', ')} {codRestrictedSellers.length === 1 ? 'accepts' : 'accept'} online payment only.
                </Text>
              </View>
            )}
            <TouchableOpacity
              style={[
                styles.paymentOption,
                paymentMethod === 'cash_on_delivery' && styles.paymentSelected,
                codRestrictedSellers.length > 0 && styles.paymentDisabled,
              ]}
              onPress={() => {
                if (codRestrictedSellers.length > 0) {
                  Feedback.show({ type: 'info', text1: 'Advance payment required', text2: 'Please pay with card or Rozare Wallet for this cart.' });
                  return;
                }
                setPaymentMethod('cash_on_delivery');
              }}
            >
              <View style={[styles.radio, paymentMethod === 'cash_on_delivery' && styles.radioSelected]}>
                {paymentMethod === 'cash_on_delivery' && <View style={styles.radioInner} />}
              </View>
              <Ionicons name="cash-outline" size={22} color={palette.colors.success} />
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
              <Ionicons name="card-outline" size={22} color={palette.colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentTitle}>Credit / Debit Card</Text>
                <Text style={styles.paymentSub}>Secure payment via Stripe</Text>
              </View>
              <Ionicons name="shield-checkmark-outline" size={16} color={palette.colors.success} />
            </TouchableOpacity>
            <View style={{ height: 10 }} />
            <TouchableOpacity
              style={[
                styles.paymentOption,
                paymentMethod === 'wallet' && styles.paymentSelected,
                wallet?.status === 'locked' && styles.paymentDisabled,
              ]}
              onPress={() => {
                if (!currentUser) {
                  navigation.navigate('Login');
                  return;
                }
                if (wallet?.status === 'locked') {
                  Feedback.show({ type: 'error', text1: 'Wallet locked', text2: wallet.lockedReason || 'Contact support for help.' });
                  return;
                }
                setPaymentMethod('wallet');
              }}
            >
              <View style={[styles.radio, paymentMethod === 'wallet' && styles.radioSelected]}>
                {paymentMethod === 'wallet' && <View style={styles.radioInner} />}
              </View>
              <Ionicons name="wallet-outline" size={22} color={palette.colors.info} />
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentTitle}>Rozare Wallet</Text>
                <Text style={styles.paymentSub}>
                  {walletLoading ? 'Checking balance...' : `Available: ${formatAmount(walletBalance)}`}
                </Text>
              </View>
              {walletLoading ? (
                <ActivityIndicator size="small" color={palette.colors.primary} />
              ) : walletAvailable ? (
                <Ionicons name="checkmark-circle-outline" size={18} color={palette.colors.success} />
              ) : (
                <TouchableOpacity onPress={() => navigation.navigate('Wallet')} hitSlop={8}>
                  <Text style={{ color: palette.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.bold }}>Add balance</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          </GlassPanel>

          {/* Order Summary */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="receipt-outline" size={18} color={palette.colors.warning} />
              <Text style={styles.sectionTitle}>Order Summary</Text>
              {summaryLoading && <Loader size="small" />}
            </View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>{formatAmount(subtotal)}</Text></View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{shippingLabel}</Text><Text style={[styles.summaryValue, shippingCost === 0 && { color: palette.colors.success }]}>{shippingCost === 0 ? 'Free' : formatAmount(shippingCost)}</Text></View>
            {tax > 0 && <View style={styles.summaryRow}><Text style={styles.summaryLabel}>{taxLabel}</Text><Text style={styles.summaryValue}>{formatAmount(tax)}</Text></View>}
            {couponDiscount > 0 && <View style={styles.summaryRow}><Text style={[styles.summaryLabel, { color: palette.colors.success }]}>Coupon Discount</Text><Text style={[styles.summaryValue, { color: palette.colors.success }]}>-{formatAmount(couponDiscount)}</Text></View>}
            <View style={styles.divider} />
            <View style={styles.summaryRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{formatAmount(totalAmount)}</Text></View>
          </GlassPanel>
        </ScrollView>

        {/* Footer */}
        <GlassPanel variant="floating" style={styles.footer}>
          <View style={{ flex: 1 }}>
            <Text style={styles.footerLabel}>Total</Text>
            <Text style={styles.footerValue}>{formatAmount(totalAmount)}</Text>
          </View>
          <TouchableOpacity style={[styles.placeOrderBtn, isProcessing && { opacity: 0.6 }]} onPress={handlePlaceOrder} disabled={isProcessing}>
            <LinearGradient colors={['#14B8A6', '#0EA5E9', '#6366F1']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            {isProcessing ? <InlineLoader size="small" color="#fff" /> : (
              <>
                <Ionicons name={paymentMethod === 'card' ? 'card-outline' : paymentMethod === 'wallet' ? 'wallet-outline' : 'bag-check-outline'} size={20} color="#fff" />
                <Text style={styles.placeOrderText}>{paymentMethod === 'card' ? 'Pay with Card' : paymentMethod === 'wallet' ? 'Pay with Wallet' : 'Place Order'}</Text>
              </>
            )}
          </TouchableOpacity>
        </GlassPanel>
      </KeyboardAvoidingView>

      {/* Update Shipping Info Modal */}
      <Modal visible={showUpdatePrompt} transparent animationType="fade" onRequestClose={() => setShowUpdatePrompt(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: spacing.lg }}>
          <GlassPanel variant="strong" style={{ padding: spacing.xl, width: '100%', maxWidth: 360, borderRadius: 24 }}>
            <View style={{ alignItems: 'center', marginBottom: spacing.lg }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md }}>
                <Ionicons name="location" size={28} color={palette.colors.primary} />
              </View>
              <Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.colors.text, marginBottom: spacing.xs }}>Update Shipping Info?</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, textAlign: 'center' }}>Your shipping details have changed. Save them for future orders?</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <TouchableOpacity style={{ flex: 1, paddingVertical: 12, borderRadius: 14, backgroundColor: palette.glass.bgSubtle, alignItems: 'center', borderWidth: 1, borderColor: palette.glass.borderSubtle }}
                onPress={async () => { setShowUpdatePrompt(false); await completeOrder(pendingOrderData?.order, false); }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: palette.colors.text }}>No, Keep</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ flex: 1, paddingVertical: 12, borderRadius: 14, backgroundColor: palette.colors.primary, alignItems: 'center' }}
                onPress={async () => { setShowUpdatePrompt(false); await completeOrder(pendingOrderData?.order, true); }}>
                <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#fff' }}>Yes, Update</Text>
              </TouchableOpacity>
            </View>
          </GlassPanel>
        </View>
      </Modal>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.md, marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  headerSubtitle: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  lockIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  section: { marginBottom: spacing.md, padding: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, gap: spacing.sm },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, flex: 1 },
  badge: { backgroundColor: 'rgba(99,102,241,0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 },
  badgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },
  cartItem: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  cartItemImage: { width: 52, height: 52, borderRadius: 12, backgroundColor: p.glass.bgSubtle },
  cartItemInfo: { flex: 1, marginLeft: spacing.md },
  cartItemName: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: p.colors.text, marginBottom: 2 },
  cartItemQty: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  cartItemPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text },
  inputGroup: { marginBottom: spacing.md },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: 14, borderWidth: 1, borderColor: p.glass.borderSubtle, paddingHorizontal: spacing.md },
  inputContainerError: { borderColor: p.colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, paddingVertical: 13, fontSize: fontSize.md, color: p.colors.text },
  errorText: { fontSize: fontSize.xs, color: p.colors.error, marginTop: 4, marginLeft: 4 },
  row: { flexDirection: 'row', gap: spacing.md },
  halfInput: { flex: 1 },
  paymentOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, padding: spacing.md, borderRadius: 16, borderWidth: 1.5, borderColor: p.glass.borderSubtle, gap: spacing.md },
  paymentSelected: { borderColor: p.colors.primary, backgroundColor: 'rgba(99,102,241,0.08)' },
  paymentDisabled: { opacity: 0.55 },
  advanceOnlyNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: 14, backgroundColor: `${p.colors.info}12`, borderWidth: 1, borderColor: `${p.colors.info}28`, marginBottom: spacing.md },
  advanceOnlyNoticeText: { flex: 1, fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 18 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', justifyContent: 'center', alignItems: 'center' },
  radioSelected: { borderColor: p.colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: p.colors.primary },
  paymentTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  paymentSub: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  summaryLabel: { fontSize: fontSize.md, color: p.colors.textSecondary },
  summaryValue: { fontSize: fontSize.md, color: p.colors.text, fontWeight: fontWeight.medium },
  divider: { height: 1, backgroundColor: p.glass.borderSubtle, marginVertical: spacing.md },
  totalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  totalValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.primary },
  footer: { position: 'absolute', bottom: 0, left: spacing.md, right: spacing.md, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.lg, marginBottom: spacing.sm },
  footerLabel: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  footerValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  placeOrderBtn: { flexDirection: 'row', paddingVertical: 14, paddingHorizontal: spacing.xl, borderRadius: 16, alignItems: 'center', gap: spacing.sm, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 6 },
  placeOrderText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  emptyCard: { alignItems: 'center', padding: spacing.xxl },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: p.colors.text, marginTop: spacing.lg, marginBottom: spacing.xl },
  shopButton: { backgroundColor: p.colors.primary, paddingVertical: 14, paddingHorizontal: spacing.xl, borderRadius: 16 },
  shopButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
