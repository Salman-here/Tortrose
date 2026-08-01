/**
 * CheckoutScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity,
  StyleSheet, Platform, Modal, ActivityIndicator,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Image } from 'expo-image';
import Feedback from '../utils/feedback';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Crypto from 'expo-crypto';
import { useStripe } from '@stripe/stripe-react-native';
import api, { API_ENDPOINTS } from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useStripeConfig } from '../contexts/StripeContext';
import { Loader, InlineLoader } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import LocationAutocomplete from '../components/common/LocationAutocomplete';
import { trackCheckoutStep, trackPaymentEvent, trackError } from '../utils/breadcrumbs';
import { spacing, fontSize, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import {
  buildSellerShipping,
  cancelOrderPaymentAttempt,
  calculateCouponPricing,
  createCheckoutAttemptKey,
  findCouponOverlap,
  getCartItemQuantity,
  getCartItemSellerId,
  getSellerDisplayName,
  selectDefaultShippingMethods,
  verifyOrderPayment,
} from '../utils/checkout';
import {
  assertPaymentSheetPayload,
  buildPaymentSheetOptions,
  normalizePaymentSheetPayload,
  runPaymentSheet,
} from '../utils/stripePaymentSheet';

export default function CheckoutScreen({ navigation }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { ensureReady: ensureStripeReady } = useStripeConfig();

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
  const [paymentMethod, setPaymentMethod] = useState('card');
  const [formData, setFormData] = useState({
    fullName: '', email: '', phone: '', address: '',
    city: '', state: '', stateCode: '', postalCode: '', country: 'Pakistan', countryCode: 'PK',
  });
  const [savedShippingInfo, setSavedShippingInfo] = useState(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const [pendingOrderData, setPendingOrderData] = useState(null);

  const [sellerShippingMethods, setSellerShippingMethods] = useState({});
  const [selectedShippingPerSeller, setSelectedShippingPerSeller] = useState({});
  const [shippingError, setShippingError] = useState('');
  const [tax, setTax] = useState(0);
  const [taxLabel, setTaxLabel] = useState('Tax');
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [wallet, setWallet] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [paymentNotice, setPaymentNotice] = useState(null);
  const checkoutAttemptKeyRef = useRef(null);
  const submittingRef = useRef(false);

  // Coupon state
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupons, setAppliedCoupons] = useState([]);
  const [sellerCoupons, setSellerCoupons] = useState({});
  const [couponLoading, setCouponLoading] = useState(false);

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
    return total + (productPriceInCheckoutCurrency(item.product) * getCartItemQuantity(item));
  }, 0) || 0;

  const cartItemsBySeller = useMemo(() => {
    const grouped = {};
    (cartItems?.cart || []).forEach((item) => {
      const sellerId = getCartItemSellerId(item);
      if (!sellerId) return;
      if (!grouped[sellerId]) grouped[sellerId] = [];
      grouped[sellerId].push(item);
    });
    return grouped;
  }, [cartItems?.cart]);

  const shippingPricing = buildSellerShipping({
    sellerMap: sellerShippingMethods,
    selections: selectedShippingPerSeller,
    convertShippingCost: shippingCostInCheckoutCurrency,
  });
  const shippingCost = shippingPricing.shippingCost;
  const sellerShipping = shippingPricing.sellerShipping;
  const shippingLabel = Object.keys(sellerShippingMethods).length > 1
    ? `Shipping (${Object.keys(sellerShippingMethods).length} sellers)`
    : 'Shipping';

  const codRestrictedSellers = useMemo(() => Object.entries(sellerShippingMethods)
    .filter(([, sellerData]) => sellerData?.allowsCashOnDelivery === false)
    .map(([, sellerData]) => getSellerDisplayName(sellerData, 'A seller')), [sellerShippingMethods]);

  const couponPricing = calculateCouponPricing({
    appliedCoupons,
    cartItems: cartItems?.cart || [],
    getItemPrice: (item) => productPriceInCheckoutCurrency(item.product),
    convertCouponAmount: couponAmountInCheckoutCurrency,
  });
  const couponDiscount = couponPricing.totalDiscount;
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

  useEffect(() => {
    const cartProductIds = new Set((cartItems?.cart || []).map((item) => String(item.product?._id || '')));
    setAppliedCoupons((previous) => previous
      .map((coupon) => ({
        ...coupon,
        applicableProductIds: (coupon.applicableProductIds || []).filter((id) => cartProductIds.has(String(id))),
      }))
      .filter((coupon) => coupon.applicableProductIds.length > 0));
  }, [cartItems?.cart]);

  const fetchSummary = async () => {
    setSummaryLoading(true);
    setShippingError('');
    try {
      const taxRes = await api.get('/api/tax/config');
      const taxConfig = taxRes.data.taxConfig;
      if (taxConfig && taxConfig.type !== 'none') {
        const computedTax = taxConfig.type === 'percentage'
          ? subtotal * (taxConfig.value / 100)
          : convertAmount(Number(taxConfig.value || 0), taxConfig.currency || 'USD', currency);
        setTax(computedTax);
        setTaxLabel(taxConfig.type === 'percentage' ? `Tax (${taxConfig.value}%)` : `Tax (Fixed)`);
      } else { setTax(0); setTaxLabel('Tax'); }
    } catch { setTax(0); setTaxLabel('Tax'); }

    try {
      const cartPayload = cartItems.cart.map(item => ({ productId: item.product?._id, qty: item.qty || item.quantity || 1 }));
      const shipRes = await api.post(API_ENDPOINTS.SHIPPING.CART, { cartItems: cartPayload });
      const sellerMap = shipRes.data.shippingMethods || {};
      if (!Object.keys(sellerMap).length) throw new Error('No delivery methods were returned for this cart.');
      const unavailableSeller = Object.values(sellerMap).find((sellerData) => !(sellerData?.methods || []).some((method) => method?.isActive !== false));
      if (unavailableSeller) throw new Error(`${getSellerDisplayName(unavailableSeller)} has no delivery method available.`);
      setSellerShippingMethods(sellerMap);
      setSelectedShippingPerSeller((previous) => selectDefaultShippingMethods(sellerMap, previous));
      const restricted = Object.values(sellerMap).some((sellerData) => sellerData?.allowsCashOnDelivery === false);
      if (restricted && paymentMethod === 'cash_on_delivery') setPaymentMethod('card');
    } catch (error) {
      setSellerShippingMethods({});
      setSelectedShippingPerSeller({});
      setShippingError(error?.response?.data?.msg || error.message || 'Delivery options could not be loaded.');
    }

    try {
      if (currentUser) {
        const sellerIds = [...new Set((cartItems?.cart || []).map(getCartItemSellerId).filter(Boolean))];
        const couponResponse = await api.post(API_ENDPOINTS.COUPONS.CHECKOUT, { sellerIds });
        setSellerCoupons(couponResponse.data?.sellerCoupons || {});
      }
    } catch {
      setSellerCoupons({});
    }
    setSummaryLoading(false);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }));
  };

  const validateForm = () => {
    const newErrors = {};
    const required = ['fullName', 'email', 'phone', 'address', 'country', 'state', 'city', 'postalCode'];
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

  const handleApplyCoupon = async (suggestedCode = '') => {
    const requestedCode = String(suggestedCode || couponCode).trim();
    if (!requestedCode) { Feedback.show({ type: 'error', text1: 'Enter a coupon code' }); return; }
    if (appliedCoupons.some((coupon) => coupon.code === requestedCode.toUpperCase())) {
      Feedback.show({ type: 'info', text1: 'Coupon already applied' });
      return;
    }
    setCouponLoading(true);
    try {
      const productIds = cartItems.cart.map(item => item.product._id);
      const res = await api.post(API_ENDPOINTS.COUPONS.VALIDATE, { code: requestedCode, productIds, currency });
      if (res.data.valid) {
        const coupon = res.data.coupon;
        const overlap = findCouponOverlap(coupon, appliedCoupons);
        if (overlap.length) {
          Feedback.show({ type: 'error', text1: 'Coupon overlaps', text2: 'A product can only receive one coupon per order.' });
          return;
        }
        const applicableIds = new Set((coupon.applicableProductIds || []).map(String));
        const applicableSubtotal = cartItems.cart.reduce((sum, item) => (
          applicableIds.has(String(item.product?._id))
            ? sum + productPriceInCheckoutCurrency(item.product) * getCartItemQuantity(item)
            : sum
        ), 0);
        const minimum = couponAmountInCheckoutCurrency(coupon.minOrderAmount || 0, coupon);
        if (minimum > 0 && applicableSubtotal + 0.0001 < minimum) {
          Feedback.show({ type: 'error', text1: 'Minimum not reached', text2: `Spend ${formatAmount(minimum)} on eligible products to use this coupon.` });
          return;
        }
        setAppliedCoupons((previous) => [...previous, coupon]);
        setCouponCode('');
        Feedback.show({ type: 'success', text1: 'Coupon applied', text2: `${coupon.code} is ready for checkout.` });
      }
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Invalid Coupon', text2: err.response?.data?.msg || 'Coupon not valid' });
    } finally { setCouponLoading(false); }
  };

  const handleRemoveCoupon = (couponId) => {
    setAppliedCoupons((previous) => previous.filter((coupon) => String(coupon._id) !== String(couponId)));
    Feedback.show({ type: 'info', text1: 'Coupon removed' });
  };

  const buildOrder = (idempotencyKey) => {
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
      appliedCoupons: appliedCoupons.map((coupon) => ({
        couponId: coupon._id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountType === 'fixed'
          ? couponAmountInCheckoutCurrency(coupon.discountValue, coupon)
          : coupon.discountValue,
        currency,
        sourceDiscountValue: coupon.discountValue,
        sourceCurrency: couponCurrency(coupon),
        applicableProductIds: coupon.applicableProductIds,
      })),
      paymentMethod: paymentMethod === 'card'
        ? 'stripe'
        : paymentMethod === 'wallet'
          ? 'wallet'
          : 'cash_on_delivery',
      platform: paymentMethod === 'card' ? 'mobile' : undefined,
      paymentFlow: paymentMethod === 'card' ? 'payment_sheet' : undefined,
      clientSurface: 'mobile',
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      idempotencyKey,
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
      await fetchCart();
      checkoutAttemptKeyRef.current = null;
      setTimeout(() => { navigation.reset({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] }); }, 700);
    }
  };

  const handlePlaceOrder = async () => {
    if (submittingRef.current || isProcessing) return;
    trackCheckoutStep('place_order_clicked', { paymentMethod, items: cartItems?.cart?.length, total: totalAmount });
    setPaymentNotice(null);
    if (!currentUser) {
      Feedback.show({ type: 'info', text1: 'Sign in to checkout', text2: 'Your cart will be kept while you sign in.' });
      navigation.navigate('Login', { returnTo: 'Cart', intent: 'checkout' });
      return;
    }
    if (summaryLoading) {
      Feedback.show({ type: 'info', text1: 'Preparing checkout', text2: 'Please wait while delivery and tax are confirmed.' });
      return;
    }
    if (shippingError || !shippingPricing.valid) {
      Feedback.show({ type: 'error', text1: 'Choose delivery', text2: shippingError || 'Select one delivery method for every store.' });
      return;
    }
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
    submittingRef.current = true;
    setIsProcessing(true);
    try {
      if (!checkoutAttemptKeyRef.current) {
        checkoutAttemptKeyRef.current = createCheckoutAttemptKey(Crypto.randomUUID);
      }
      const idempotencyKey = checkoutAttemptKeyRef.current;
      const order = buildOrder(idempotencyKey);
      trackCheckoutStep('order_built', { itemCount: order.orderItems.length });
      const stripeConfig = paymentMethod === 'card' ? await ensureStripeReady() : null;
      const res = await api.post('/api/order/place', {
        order,
        ...(paymentMethod === 'card' ? { paymentFlow: 'payment_sheet', clientSurface: 'mobile' } : {}),
      }, {
        headers: { 'X-Idempotency-Key': idempotencyKey },
      });
      trackCheckoutStep('order_api_success', { orderId: res.data?.orderId });
      if (paymentMethod === 'card') {
        const payment = normalizePaymentSheetPayload(res);
        const orderId = payment.orderId || res.data?.orderId || res.data?.order?.orderId;
        if (res.data?.isPaid === true || payment.completed) {
          navigation.replace('PaymentSuccess', { orderId, payment_intent: payment.paymentIntentId });
          return;
        }
        if (!orderId) throw new Error('Secure checkout did not return an order reference.');
        const verifiedPayment = assertPaymentSheetPayload(res, 'payment');
        trackPaymentEvent('payment_sheet_initialized', { orderId });
        const sheetResult = await runPaymentSheet({
          initPaymentSheet,
          presentPaymentSheet,
          options: buildPaymentSheetOptions({
            payment: verifiedPayment,
            config: stripeConfig,
            currentUser,
            billingDetails: {
              name: formData.fullName,
              email: formData.email,
              phone: formData.phone,
              address: {
                line1: formData.address,
                city: formData.city,
                state: formData.state,
                postalCode: formData.postalCode,
                country: formData.countryCode,
              },
            },
            currency,
            palette,
            isDark,
            intentType: 'payment',
          }),
        });

        if (!savedShippingInfo?.fullName || hasShippingInfoChanged()) {
          try {
            await api.patch('/api/user/shipping-info', { shippingInfo: formData });
            setSavedShippingInfo(formData);
          } catch {}
        }

        if (sheetResult.status === 'cancelled') {
          const cancellation = await cancelOrderPaymentAttempt({
            apiClient: api,
            orderId,
            paymentIntentId: verifiedPayment.paymentIntentId,
          });
          if (cancellation.status === 'payment_received') {
            navigation.replace('PaymentSuccess', { orderId, payment_intent: verifiedPayment.paymentIntentId });
            return;
          }
          if (cancellation.status === 'cancelled') {
            checkoutAttemptKeyRef.current = null;
            setPaymentNotice({
              type: 'cancelled',
              title: 'Payment cancelled safely',
              orderId,
              paymentIntentId: verifiedPayment.paymentIntentId,
              text: 'Rozare confirmed the payment attempt is closed. Your cart is safe, and Retry will start a fresh secure payment.',
            });
            return;
          }
          setPaymentNotice({
            type: 'pending',
            title: 'Checking payment status',
            orderId,
            paymentIntentId: verifiedPayment.paymentIntentId,
            text: 'Rozare could not confirm cancellation yet. Use Check before retrying so another payable payment is not created.',
          });
          return;
        }

        const verification = await verifyOrderPayment({
          apiClient: api,
          orderId,
          paymentIntentId: verifiedPayment.paymentIntentId,
          attempts: sheetResult.status === 'presented' ? 2 : 1,
          delayMs: 650,
        });
        if (verification.status === 'paid') {
          navigation.replace('PaymentSuccess', { orderId, payment_intent: verifiedPayment.paymentIntentId });
          return;
        }
        if (sheetResult.status === 'presented') {
          trackPaymentEvent('payment_sheet_presented', { orderId });
          navigation.replace('PaymentSuccess', { orderId, payment_intent: verifiedPayment.paymentIntentId });
          return;
        }
        if (sheetResult.status === 'failed') {
          const sheetError = new Error(sheetResult.error?.localizedMessage || sheetResult.error?.message || 'Your card payment could not be opened.');
          sheetError.code = sheetResult.error?.code;
          throw sheetError;
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
      const code = error.response?.data?.code;
      if (code === 'COD_NOT_AVAILABLE_FOR_CART') setPaymentMethod('card');
      if (code === 'SHIPPING_METHOD_REQUIRED' || code === 'SHIPPING_METHOD_NOT_AVAILABLE' || code === 'SHIPPING_SCOPE_INVALID') {
        fetchSummary();
      }
      if (error.response?.status === 401 || error.response?.status === 403) {
        navigation.navigate('Login', { returnTo: 'Cart', intent: 'checkout' });
      }
      const isRetryable = !error.response || error.response?.status >= 500 || error.response?.status === 408;
      if (!isRetryable) checkoutAttemptKeyRef.current = null;
      Feedback.show({ type: 'error', text1: 'Order not completed', text2: error.response?.data?.msg || error.message || 'Please check your connection and try again.' });
    } finally {
      submittingRef.current = false;
      setIsProcessing(false);
    }
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

          {/* Delivery methods */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="car-outline" size={18} color={palette.colors.info} />
              <Text style={styles.sectionTitle}>Delivery</Text>
              {summaryLoading && <ActivityIndicator size="small" color={palette.colors.primary} />}
            </View>
            {Object.keys(sellerShippingMethods).length > 1 && !shippingError && (
              <View style={styles.multiSellerNotice}>
                <Ionicons name="information-circle-outline" size={18} color={palette.colors.info} />
                <Text style={styles.multiSellerNoticeText}>
                  This cart ships from {Object.keys(sellerShippingMethods).length} stores. Choose delivery for each store.
                </Text>
              </View>
            )}
            {!!shippingError && (
              <View style={styles.shippingErrorCard}>
                <View style={styles.shippingErrorCopy}>
                  <Ionicons name="cloud-offline-outline" size={20} color={palette.colors.error} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.shippingErrorTitle}>Delivery options unavailable</Text>
                    <Text style={styles.shippingErrorText}>{shippingError}</Text>
                  </View>
                </View>
                <TouchableOpacity style={styles.retryButton} onPress={fetchSummary} disabled={summaryLoading}>
                  <Ionicons name="refresh" size={15} color="#fff" />
                  <Text style={styles.retryButtonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
            {!shippingError && Object.entries(sellerShippingMethods).map(([sellerId, sellerData]) => {
              const sellerItems = cartItemsBySeller[sellerId] || [];
              return (
                <View key={sellerId} style={styles.sellerDeliveryCard}>
                  <View style={styles.sellerDeliveryHeader}>
                    <View style={styles.sellerIcon}><Ionicons name="storefront-outline" size={17} color={palette.colors.primary} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sellerName} numberOfLines={1}>{getSellerDisplayName(sellerData)}</Text>
                      <Text style={styles.sellerItemsText}>{sellerItems.length} {sellerItems.length === 1 ? 'item' : 'items'} in this shipment</Text>
                    </View>
                  </View>
                  {(sellerData.methods || []).filter((method) => method?.isActive !== false).map((method) => {
                    const selected = selectedShippingPerSeller[sellerId]?.type === method.type;
                    const methodCost = shippingCostInCheckoutCurrency(method, sellerData);
                    return (
                      <TouchableOpacity
                        key={method.type}
                        activeOpacity={0.78}
                        style={[styles.shippingOption, selected && styles.shippingOptionSelected]}
                        onPress={() => setSelectedShippingPerSeller((previous) => ({ ...previous, [sellerId]: method }))}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                      >
                        <View style={[styles.radio, selected && styles.radioSelected]}>{selected && <View style={styles.radioInner} />}</View>
                        <View style={styles.shippingOptionIcon}><Ionicons name={method.type === 'fast' ? 'flash-outline' : 'car-outline'} size={18} color={selected ? palette.colors.primary : palette.colors.textSecondary} /></View>
                        <View style={{ flex: 1 }}>
                          <View style={styles.shippingTitleRow}>
                            <Text style={styles.shippingOptionTitle}>{getShippingMethodTitle(method)}</Text>
                            {method.type === 'free' && <Text style={styles.recommendedBadge}>Recommended</Text>}
                          </View>
                          <Text style={styles.shippingOptionSub}>Estimated {Math.max(1, Number(method.deliveryDays) || 5)} {Number(method.deliveryDays) === 1 ? 'day' : 'days'}</Text>
                        </View>
                        <Text style={[styles.shippingOptionPrice, methodCost === 0 && { color: palette.colors.success }]}>{methodCost === 0 ? 'Free' : formatAmount(methodCost)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
            <Text style={styles.instructionsLabel}>Delivery instructions <Text style={styles.optionalText}>(optional)</Text></Text>
            <View style={[styles.inputContainer, styles.instructionsInput]}>
              <Ionicons name="chatbox-ellipses-outline" size={18} color={palette.colors.textSecondary} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, styles.instructionsText]}
                placeholder="Gate code, landmark, or delivery note"
                placeholderTextColor={palette.colors.grayLight}
                value={instructions}
                onChangeText={setInstructions}
                multiline
                maxLength={500}
                textAlignVertical="top"
              />
            </View>
          </GlassPanel>

          {/* Coupon codes */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="pricetag-outline" size={18} color="#f97316" />
              <Text style={styles.sectionTitle}>Coupons</Text>
              {!!appliedCoupons.length && <View style={styles.badge}><Text style={styles.badgeText}>{appliedCoupons.length}</Text></View>}
            </View>
            {appliedCoupons.map((coupon) => {
              const pricing = couponPricing.couponDiscounts.find((entry) => String(entry.coupon._id) === String(coupon._id));
              return (
                <View key={String(coupon._id)} style={styles.appliedCouponCard}>
                  <Ionicons name="checkmark-circle" size={20} color={palette.colors.success} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.appliedCouponCode}>{coupon.code}</Text>
                    <Text style={styles.appliedCouponText}>Saving {formatAmount(pricing?.discount || 0)} on eligible items</Text>
                  </View>
                  <TouchableOpacity onPress={() => handleRemoveCoupon(coupon._id)} hitSlop={8}><Ionicons name="close-circle" size={22} color={palette.colors.error} /></TouchableOpacity>
                </View>
              );
            })}
            <View style={styles.couponInputRow}>
              <View style={[styles.inputContainer, { flex: 1 }]}>
                <Ionicons name="pricetag-outline" size={16} color={palette.colors.textSecondary} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="Enter coupon code" placeholderTextColor={palette.colors.grayLight} value={couponCode} onChangeText={setCouponCode} autoCapitalize="characters" autoCorrect={false} returnKeyType="done" onSubmitEditing={() => handleApplyCoupon()} />
              </View>
              <TouchableOpacity style={styles.applyCouponButton} onPress={() => handleApplyCoupon()} disabled={couponLoading}>
                {couponLoading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.applyCouponText}>Apply</Text>}
              </TouchableOpacity>
            </View>
            {!!Object.values(sellerCoupons).flat().length && (
              <View style={styles.availableCoupons}>
                <Text style={styles.availableCouponsLabel}>Available for this cart</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.availableCouponRow}>
                  {Object.values(sellerCoupons).flat().map((coupon) => (
                    <TouchableOpacity key={String(coupon._id)} style={styles.availableCouponChip} onPress={() => handleApplyCoupon(coupon.code)} disabled={couponLoading}>
                      <Ionicons name="ticket-outline" size={14} color={palette.colors.primary} />
                      <Text style={styles.availableCouponCode}>{coupon.code}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </GlassPanel>

          {/* Payment Method */}
          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="card-outline" size={18} color={palette.colors.info} />
              <Text style={styles.sectionTitle}>Payment Method</Text>
            </View>
            {!!paymentNotice && (
              <View style={styles.paymentNotice}>
                <Ionicons name="time-outline" size={19} color={palette.colors.warning} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.paymentNoticeTitle}>{paymentNotice.title || 'Payment status needs confirmation'}</Text>
                  <Text style={styles.paymentNoticeText}>{paymentNotice.text}</Text>
                </View>
                <TouchableOpacity
                  style={styles.verifyPaymentButton}
                  onPress={() => navigation.navigate('PaymentSuccess', {
                    orderId: paymentNotice.orderId,
                    payment_intent: paymentNotice.paymentIntentId,
                  })}
                >
                  <Text style={styles.verifyPaymentButtonText}>Check</Text>
                </TouchableOpacity>
              </View>
            )}
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
          <TouchableOpacity
            style={[styles.placeOrderBtn, (isProcessing || summaryLoading || !!shippingError || !shippingPricing.valid) && { opacity: 0.55 }]}
            onPress={handlePlaceOrder}
            disabled={isProcessing || summaryLoading || !!shippingError || !shippingPricing.valid}
          >
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
      <Modal
        visible={showUpdatePrompt}
        transparent
        animationType="fade"
        onRequestClose={async () => {
          setShowUpdatePrompt(false);
          await completeOrder(pendingOrderData?.order, false);
        }}
      >
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
  multiSellerNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: 14, backgroundColor: `${p.colors.info}12`, borderWidth: 1, borderColor: `${p.colors.info}24`, marginBottom: spacing.md },
  multiSellerNoticeText: { flex: 1, fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  shippingErrorCard: { borderRadius: 16, padding: spacing.md, backgroundColor: `${p.colors.error}0D`, borderWidth: 1, borderColor: `${p.colors.error}28`, gap: spacing.md },
  shippingErrorCopy: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  shippingErrorTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold, marginBottom: 3 },
  shippingErrorText: { color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  retryButton: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12, backgroundColor: p.colors.primary },
  retryButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  sellerDeliveryCard: { padding: spacing.md, borderRadius: 18, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md, gap: spacing.sm },
  sellerDeliveryHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.xs },
  sellerIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: `${p.colors.primary}12`, borderWidth: 1, borderColor: `${p.colors.primary}22` },
  sellerName: { color: p.colors.text, fontSize: fontSize.md, fontWeight: fontWeight.bold },
  sellerItemsText: { marginTop: 2, color: p.colors.textSecondary, fontSize: fontSize.xs },
  shippingOption: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: 15, borderWidth: 1.5, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle },
  shippingOptionSelected: { borderColor: p.colors.primary, backgroundColor: `${p.colors.primary}0D` },
  shippingOptionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgStrong },
  shippingTitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  shippingOptionTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  shippingOptionSub: { marginTop: 3, color: p.colors.textSecondary, fontSize: fontSize.xs },
  shippingOptionPrice: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  recommendedBadge: { color: p.colors.success, backgroundColor: `${p.colors.success}12`, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2, fontSize: 9, fontWeight: fontWeight.bold, overflow: 'hidden' },
  instructionsLabel: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, marginTop: spacing.xs, marginBottom: spacing.sm },
  optionalText: { color: p.colors.textSecondary, fontWeight: fontWeight.regular },
  instructionsInput: { alignItems: 'flex-start', minHeight: 92, paddingTop: spacing.sm },
  instructionsText: { minHeight: 78, paddingTop: 5, lineHeight: 20 },
  appliedCouponCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: `${p.colors.success}0D`, padding: spacing.md, borderRadius: 14, gap: spacing.sm, borderWidth: 1, borderColor: `${p.colors.success}24`, marginBottom: spacing.sm },
  appliedCouponCode: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.success },
  appliedCouponText: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  couponInputRow: { flexDirection: 'row', gap: spacing.sm },
  applyCouponButton: { minWidth: 76, backgroundColor: p.colors.primary, paddingHorizontal: spacing.md, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  applyCouponText: { color: '#fff', fontWeight: fontWeight.bold, fontSize: fontSize.sm },
  availableCoupons: { marginTop: spacing.md },
  availableCouponsLabel: { color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginBottom: spacing.sm },
  availableCouponRow: { gap: spacing.sm, paddingRight: spacing.md },
  availableCouponChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 13, backgroundColor: `${p.colors.primary}0B`, borderWidth: 1, borderColor: `${p.colors.primary}20` },
  availableCouponCode: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  paymentOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, padding: spacing.md, borderRadius: 16, borderWidth: 1.5, borderColor: p.glass.borderSubtle, gap: spacing.md },
  paymentSelected: { borderColor: p.colors.primary, backgroundColor: 'rgba(99,102,241,0.08)' },
  paymentDisabled: { opacity: 0.55 },
  advanceOnlyNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: 14, backgroundColor: `${p.colors.info}12`, borderWidth: 1, borderColor: `${p.colors.info}28`, marginBottom: spacing.md },
  advanceOnlyNoticeText: { flex: 1, fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 18 },
  paymentNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: 14, backgroundColor: `${p.colors.warning}10`, borderWidth: 1, borderColor: `${p.colors.warning}28`, marginBottom: spacing.md },
  paymentNoticeTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  paymentNoticeText: { color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  verifyPaymentButton: { alignSelf: 'center', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 10, backgroundColor: `${p.colors.warning}18` },
  verifyPaymentButtonText: { color: p.colors.warning, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
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
