import React, { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, Minus, Plus, CreditCard, DollarSign, Truck, MapPin, User, Mail, Phone, Home, Navigation, CreditCardIcon, X, Loader2, ChevronDown, ChevronUp, Zap, Ticket, Tag, Check } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { useGlobal } from "../../contexts/GlobalContext";
import { useCurrency } from "../../contexts/CurrencyContext";
import { useAuth } from "../../contexts/AuthContext";
import { useBuyerLocation } from "../../contexts/BuyerLocationContext";
import axios from "axios";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
import { loadStripe } from '@stripe/stripe-js'
import Loader from "../common/Loader";
import PhoneField, { isValidPhone } from "../common/PhoneField";
import LocationAutocomplete from "../common/LocationAutocomplete";
import { getAuthToken } from "../../utils/cookieHelper";
import {
  createTikTokEventId,
  getTikTokTrackingContext,
  trackAddPaymentInfo,
  trackInitiateCheckout,
  trackPlaceAnOrder
} from "../../utils/tiktokPixel";
import { formatOrderItemOptions } from "../../utils/orderItems";

export default function Checkout() {

  // Stripe configuration with live/test mode support
  const STRIPE_MODE = import.meta.env.VITE_STRIPE_MODE || 'test';
  const STRIPE_PUBLISHABLE_KEY = STRIPE_MODE === 'live'
    ? import.meta.env.VITE_STRIPE_LIVE_PUBLISHABLE_KEY
    : import.meta.env.VITE_STRIPE_TEST_PUBLISHABLE_KEY;

  const stripePromise = loadStripe(STRIPE_PUBLISHABLE_KEY);

  const steps = ["Cart", "Shipping", "Payment"];
  const CHECKOUT_STORAGE_KEY = 'checkoutProgress_v1';
  const [currentStep, setCurrentStep] = useState(() => {
    try {
      const saved = sessionStorage.getItem(CHECKOUT_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed.currentStep === 'number') return parsed.currentStep;
      }
    } catch (_) {}
    return 0;
  });

  const [isProcessing, setIsProcessing] = useState(false);
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const { buyerLocation } = useBuyerLocation();

  // Tax and Shipping state
  const [taxConfig, setTaxConfig] = useState(null);
  const [sellerShippingMethods, setSellerShippingMethods] = useState({});
  const [selectedShippingPerSeller, setSelectedShippingPerSeller] = useState({});
  const [expandedSellers, setExpandedSellers] = useState({});

  // Saved shipping info for auto-fill
  const [savedShippingInfo, setSavedShippingInfo] = useState(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const [pendingOrderData, setPendingOrderData] = useState(null);

  // Coupon state
  const [sellerCoupons, setSellerCoupons] = useState({}); // { sellerId: [coupon, ...] }
  const [couponInputs, setCouponInputs] = useState({}); // { key: 'CODE' }
  const [appliedCoupons, setAppliedCoupons] = useState({}); // { key: { coupon, applicableProductIds } }
  const [couponLoading, setCouponLoading] = useState({});


  const { currency, formatPrice, convertAmount } = useCurrency();

  const { cartItems, handleQtyInc, handleQtyDec, handleRemoveCartItem, isCartLoading,
    qtyUpdateId, fetchCart
  } = useGlobal();

  const productCurrency = (product) => product?.currency || product?.priceCurrency || 'USD';
  const couponCurrency = (coupon) => coupon?.currency || 'USD';
  const currentMoney = (amount, options = {}) => formatPrice(amount, { ...options, sourceCurrency: currency });
  const productPriceInCheckoutCurrency = (product, amount = undefined) => {
    const productPrice = Number(product?.price || 0);
    const discountedPrice = Number(product?.discountedPrice || 0);
    const value = amount === undefined
      ? (discountedPrice > 0 && discountedPrice < productPrice ? discountedPrice : productPrice)
      : amount;
    return convertAmount(value, productCurrency(product), currency);
  };
  const shippingMethodCurrency = (method, sellerInfo = null) => method?.currency || method?.costCurrency || sellerInfo?.seller?.currency || currency;
  const shippingCostInCheckoutCurrency = (method, sellerInfo = null) =>
    convertAmount(method?.cost || 0, shippingMethodCurrency(method, sellerInfo), currency);
  const getShippingMethodTitle = (method) => ({
    free: 'Free Shipping',
    standard: 'Standard Shipping',
    fast: 'Fast Shipping',
  }[method?.type] || `${method?.type || 'Shipping'} Shipping`);
  const couponAmountInCheckoutCurrency = (amount, coupon = null) => convertAmount(amount || 0, couponCurrency(coupon), currency);
  const formatCouponAmount = (amount, coupon = null) => currentMoney(couponAmountInCheckoutCurrency(amount, coupon));

  // Fetch tax configuration on mount
  useEffect(() => {
    fetchTaxConfig();
    fetchSavedShippingInfo();
  }, []);

  // Fetch coupons when cart items change
  useEffect(() => {
    if (cartItems?.cart && cartItems.cart.length > 0) {
      fetchAvailableCoupons();
    } else {
      setSellerCoupons({});
      setAppliedCoupons({});
      setCouponInputs({});
    }
  }, [cartItems?.cart?.length]);

  // Fetch shipping methods when cart changes
  useEffect(() => {
    if (cartItems?.cart && cartItems.cart.length > 0) {
      fetchShippingMethods();
    }
  }, [cartItems?.cart?.length]);

  const fetchTaxConfig = async () => {
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/tax/config`);
      if (res.data.success) {
        setTaxConfig(res.data.taxConfig);
      }
    } catch (error) {
      console.error('Error fetching tax config:', error);
    }
  };

  const fetchSavedShippingInfo = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/user/shipping-info`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const info = res.data.shippingInfo;
      if (info && info.fullName) {
        setSavedShippingInfo(info);
      }
    } catch (error) {
      console.error('Error fetching saved shipping info:', error);
    }
  };

  const fetchAvailableCoupons = async () => {
    try {
      const token = getAuthToken();
      if (!token) return;
      const sellerIds = [...new Set(cartItems.cart.map(item => item.product.seller))];
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/coupons/checkout-coupons`,
        { sellerIds },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSellerCoupons(res.data.sellerCoupons || {});
    } catch (error) {
      console.error('Error fetching coupons:', error);
    }
  };

  // Determine where to show coupon inputs for a given seller
  const getCouponInputConfig = (sellerId, sellerProducts) => {
    const coupons = sellerCoupons[sellerId];
    if (!coupons || coupons.length === 0) return null;

    // Check if ANY coupon from this seller applies to ALL products
    const hasAllCoupon = coupons.some(c => c.applicableTo === 'all');
    // Check if coupons target selected products
    const selectedCoupons = coupons.filter(c => c.applicableTo === 'selected');

    if (hasAllCoupon && selectedCoupons.length === 0) {
      // Only "all" coupons — show single input for the seller group
      return { type: 'group', sellerId };
    }

    if (!hasAllCoupon && selectedCoupons.length > 0) {
      // Only "selected" coupons — determine which products have coupons
      const productIdsWithCoupons = new Set();
      selectedCoupons.forEach(c => c.applicableProducts.forEach(pid => productIdsWithCoupons.add(pid)));

      const productsWithCoupons = sellerProducts.filter(item => productIdsWithCoupons.has(item.product._id));

      if (productsWithCoupons.length === sellerProducts.length) {
        // All products have coupons — show group input
        return { type: 'group', sellerId };
      }
      // Show per-product inputs for eligible products
      return { type: 'per-product', productIds: [...productIdsWithCoupons] };
    }

    // Mix of "all" and "selected" coupons — show group input (simplest UX)
    return { type: 'group', sellerId };
  };

  const applyCoupon = async (inputKey, productIds) => {
    const code = couponInputs[inputKey]?.trim();
    if (!code) {
      toast.error('Please enter a coupon code');
      return;
    }
    setCouponLoading(prev => ({ ...prev, [inputKey]: true }));
    try {
      const token = getAuthToken();
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/coupons/validate`,
        { code, productIds },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.data.valid) {
        const coupon = res.data.coupon;
        // Check min order amount for applicable products
        const applicableItems = cartItems.cart.filter(item => coupon.applicableProductIds.includes(item.product._id));
        const applicableSubtotal = applicableItems.reduce((sum, item) => {
          return sum + (productPriceInCheckoutCurrency(item.product) * item.qty);
        }, 0);
        const minOrderAmount = couponAmountInCheckoutCurrency(coupon.minOrderAmount || 0, coupon);

        if (minOrderAmount > 0 && applicableSubtotal < minOrderAmount) {
          toast.error(`Minimum order amount of ${currentMoney(minOrderAmount)} required for this coupon`);
          return;
        }

        setAppliedCoupons(prev => ({ ...prev, [inputKey]: coupon }));
        toast.success(`Coupon ${coupon.code} applied! ${coupon.discountType === 'percentage' ? `${coupon.discountValue}% off` : `${formatCouponAmount(coupon.discountValue, coupon)} off`}`);
      }
    } catch (err) {
      toast.error(err.response?.data?.msg || 'Invalid coupon code');
    } finally {
      setCouponLoading(prev => ({ ...prev, [inputKey]: false }));
    }
  };

  const removeCoupon = (inputKey) => {
    setAppliedCoupons(prev => {
      const copy = { ...prev };
      delete copy[inputKey];
      return copy;
    });
    setCouponInputs(prev => ({ ...prev, [inputKey]: '' }));
    toast.info('Coupon removed');
  };

  // Calculate coupon discount for a specific product
  const getProductCouponDiscount = (productId, itemPrice, qty) => {
    let totalDiscount = 0;
    Object.values(appliedCoupons).forEach(coupon => {
      if (coupon.applicableProductIds.includes(productId)) {
        const applicableItems = cartItems.cart.filter(item => coupon.applicableProductIds.includes(item.product._id));
        const applicableSubtotal = applicableItems.reduce((sum, item) => {
          return sum + (productPriceInCheckoutCurrency(item.product) * item.qty);
        }, 0);
        if (applicableSubtotal <= 0) return;

        const lineSubtotal = itemPrice * qty;
        let couponDiscount = 0;
        if (coupon.discountType === 'percentage') {
          couponDiscount = (applicableSubtotal * coupon.discountValue) / 100;
        } else {
          couponDiscount = couponAmountInCheckoutCurrency(coupon.discountValue, coupon);
        }
        const maxDiscountAmount = coupon.maxDiscountAmount
          ? couponAmountInCheckoutCurrency(coupon.maxDiscountAmount, coupon)
          : 0;
        if (maxDiscountAmount && couponDiscount > maxDiscountAmount) {
          couponDiscount = maxDiscountAmount;
        }
        totalDiscount += couponDiscount * (lineSubtotal / applicableSubtotal);
      }
    });
    return totalDiscount;
  };

  // Total coupon discount
  const totalCouponDiscount = useMemo(() => {
    if (!cartItems?.cart || Object.keys(appliedCoupons).length === 0) return 0;
    let total = 0;
    cartItems.cart.forEach(item => {
      const price = productPriceInCheckoutCurrency(item.product);
      total += getProductCouponDiscount(item.product._id, price, item.qty);
    });
    return total;
  }, [cartItems, appliedCoupons, currency, convertAmount]);

  const handleAutoFill = () => {
    if (!savedShippingInfo) return;
    setValue('fullName', savedShippingInfo.fullName || '');
    setValue('email', savedShippingInfo.email || '');
    setValue('phone', savedShippingInfo.phone || '');
    setValue('address', savedShippingInfo.address || '');
    setValue('city', savedShippingInfo.city || '');
    setValue('state', savedShippingInfo.state || '');
    setValue('stateCode', savedShippingInfo.stateCode || '');
    setValue('postalCode', savedShippingInfo.postalCode || '');
    setValue('country', savedShippingInfo.country || 'Pakistan');
    setValue('countryCode', savedShippingInfo.countryCode || (savedShippingInfo.country === 'Pakistan' ? 'PK' : ''));
    toast.success('Shipping info auto-filled!');
  };

  const fetchShippingMethods = async () => {
    try {
      const cartItemsData = cartItems.cart.map(item => ({
        productId: item.product._id
      }));

      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/shipping/cart`,
        { cartItems: cartItemsData }
      );

      if (res.data.success) {
        const shippingData = res.data.shippingMethods;
        setSellerShippingMethods(shippingData);

        // Set default shipping method for each seller - prefer free shipping
        const defaultSelections = {};
        Object.keys(shippingData).forEach(sellerId => {
          const methods = shippingData[sellerId].methods;
          if (methods.length > 0) {
            const freeShipping = methods.find(m => m.type === 'free');
            defaultSelections[sellerId] = freeShipping || methods[0];
          }
        });
        setSelectedShippingPerSeller(defaultSelections);
      }
    } catch (error) {
      console.error('Error fetching shipping methods:', error);
      toast.error('Failed to load shipping methods');
    }
  };

  // Calculate tax based on subtotal
  const calculateTax = (subtotal) => {
    if (!taxConfig || taxConfig.type === 'none') return 0;

    if (taxConfig.type === 'percentage') {
      return (subtotal * taxConfig.value) / 100;
    }

    if (taxConfig.type === 'fixed') {
      return convertAmount(taxConfig.value, 'USD', currency);
    }

    return 0;
  };


  const {
    register,
    handleSubmit,
    watch,
    trigger,
    setValue,
    getValues,
    control,
    formState: { errors, isSubmitting },
  } = useForm({
    mode: "all",
    reValidateMode: "onChange",
    defaultValues: {
      // Shipping
      fullName: "",
      email: "",
      phone: "",
      address: "",
      city: "",
      state: "",
      stateCode: "",
      postalCode: "",
      country: "Pakistan",
      countryCode: "PK",
      shippingMethod: "standard",
      instructions: "",
      // Payment
      paymentMethod: "stripe", // Default to Stripe
      // Billing address (optional)
      billingSameAsShipping: true,
      billingAddress: "",
      billingCity: "",
      billingState: "",
      billingStateCode: "",
      billingPostalCode: "",
      billingCountry: "Pakistan",
      billingCountryCode: "PK",
    },
  });

  const paymentMethod = watch("paymentMethod");
  const selectedShipping = watch("shippingMethod");
  const billingSameAsShipping = watch("billingSameAsShipping");
  const allFormValues = watch();

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(CHECKOUT_STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed.formValues) {
        Object.entries(parsed.formValues).forEach(([key, value]) => {
          if (value !== undefined && value !== null) setValue(key, value);
        });
      }
      if (parsed.selectedShippingPerSeller) {
        setSelectedShippingPerSeller(parsed.selectedShippingPerSeller);
      }
      if (parsed.appliedCoupons) {
        setAppliedCoupons(parsed.appliedCoupons);
      }
    } catch (_) {}
  }, [setValue]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        CHECKOUT_STORAGE_KEY,
        JSON.stringify({
          currentStep,
          formValues: allFormValues,
          selectedShippingPerSeller,
          appliedCoupons,
        })
      );
    } catch (_) {}
  }, [currentStep, allFormValues, selectedShippingPerSeller, appliedCoupons]);

  // Subtotal
  const subtotal = useMemo(() => {
    if (!cartItems?.cart) return 0;
    return cartItems.cart.reduce((total, item) => {
      const itemPrice = productPriceInCheckoutCurrency(item.product);
      return total + (itemPrice * item.qty);
    }, 0);
  }, [cartItems, currency, convertAmount]);

  // Calculate tax and shipping
  const tax = useMemo(() => calculateTax(subtotal), [subtotal, taxConfig]);

  // Calculate total shipping cost from all sellers
  const shippingCost = useMemo(() => {
    return Object.values(selectedShippingPerSeller).reduce((total, method) => {
      return total + shippingCostInCheckoutCurrency(method);
    }, 0);
  }, [selectedShippingPerSeller, currency, convertAmount]);

  const totalAmount = subtotal + tax + shippingCost - totalCouponDiscount;

  // Group cart items by seller
  const cartItemsBySeller = useMemo(() => {
    if (!cartItems?.cart) return {};

    const grouped = {};
    cartItems.cart.forEach(item => {
      const sellerId = item.product.seller;
      if (!grouped[sellerId]) {
        grouped[sellerId] = [];
      }
      grouped[sellerId].push(item);
    });
    return grouped;
  }, [cartItems]);

  // Prevent Enter key from submitting the form
  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      if (currentStep !== steps.length - 1) {
        e.preventDefault();
      }
    }
  };

  // Next step with validation
  const nextStep = async () => {
    // CART step: ensure there's at least one item
    if (currentStep === 0) {
      if (!cartItems?.cart || cartItems.cart.length === 0) {
        toast.error("Your cart is empty. Add items to proceed.");
        return;
      }
      setCurrentStep((p) => p + 1);
      return;
    }

    // SHIPPING step: validate shipping related fields
    if (currentStep === 1) {
      const valid = await trigger([
        "fullName",
        "email",
        "phone",
        "address",
        "city",
        "state",
        "postalCode",
        "country",
        "countryCode",
      ]);
      if (!valid) return;

      // Validate shipping method is selected for all sellers
      const sellerIds = Object.keys(sellerShippingMethods);
      const hasAllShippingSelected = sellerIds.every(sellerId => selectedShippingPerSeller[sellerId]);

      if (!hasAllShippingSelected) {
        toast.error("Please select a shipping method for all sellers");
        return;
      }

      trackInitiateCheckout(cartItems?.cart || [], totalAmount);
      setCurrentStep((p) => p + 1);
      return;
    }


  };

  const prevStep = () => {
    if (currentStep > 0) setCurrentStep((p) => p - 1);
  };

  // Final form submit
  const onPlaceOrder = async (data) => {
    // Validate shipping method is selected for all sellers
    const sellerIds = Object.keys(sellerShippingMethods);
    const hasAllShippingSelected = sellerIds.every(sellerId => selectedShippingPerSeller[sellerId]);

    if (!hasAllShippingSelected) {
      toast.error("Please select a shipping method for all sellers");
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true);

    // Build seller shipping array
    const sellerShipping = Object.entries(selectedShippingPerSeller).map(([sellerId, method]) => ({
      seller: sellerId,
      shippingMethod: {
        name: method.type,
        price: shippingCostInCheckoutCurrency(method, sellerShippingMethods[sellerId]),
        estimatedDays: method.deliveryDays
      }
    }));

    // Use first seller's shipping as primary (for backward compatibility)
    const primaryShipping = sellerShipping[0]?.shippingMethod || {
      name: 'standard',
      price: 0,
      estimatedDays: 5
    };

    const tiktokPlaceOrderEventId = createTikTokEventId('place_order');
    const tiktokPurchaseEventId = createTikTokEventId('purchase');

    const order = {
      orderItems: cartItems.cart.map((item) => {
        const productPrice = Number(item.product.price || 0);
        const discountedPrice = Number(item.product.discountedPrice || 0);
        const sourcePrice = discountedPrice > 0 && discountedPrice < productPrice ? discountedPrice : productPrice;
        const itemPrice = productPriceInCheckoutCurrency(item.product, sourcePrice);

        return {
          id: item.product._id,
          name: item.product.name,
          image: item.product.image,
          price: itemPrice,
          sourcePrice,
          sourceCurrency: productCurrency(item.product),
          quantity: item.qty,
          selectedColor: item.selectedColor || null,
          selectedOptions: item.selectedOptions || undefined,
        };
      }),

      shippingInfo: {
        fullName: data.fullName,
        email: data.email,
        phone: data.phone,
        address: data.address,
        city: data.city,
        state: data.state,
        stateCode: data.stateCode || "",
        postalCode: data.postalCode,
        country: data.country || "Pakistan",
        countryCode: data.countryCode || "",
      },
      buyerLocation: {
        country: buyerLocation.country || data.country || "Pakistan",
        countryCode: buyerLocation.countryCode || data.countryCode || "",
        region: buyerLocation.region || data.state || "",
        regionCode: buyerLocation.regionCode || data.stateCode || "",
        city: buyerLocation.city || data.city || "",
        cityStateCode: buyerLocation.cityStateCode || data.stateCode || "",
        town: buyerLocation.town || "",
        townStateCode: buyerLocation.townStateCode || "",
        lat: buyerLocation.lat || "",
        lng: buyerLocation.lng || "",
      },

      shippingMethod: {
        name: primaryShipping.name,
        price: primaryShipping.price,
        estimatedDays: primaryShipping.estimatedDays,
        seller: sellerShipping[0]?.seller
      },

      sellerShipping: sellerShipping, // Multi-seller shipping details

      orderSummary: {
        subtotal,
        shippingCost,
        tax,
        couponDiscount: totalCouponDiscount,
        totalAmount,
      },
      currency,

      appliedCoupons: Object.values(appliedCoupons).map(c => ({
        couponId: c._id,
        code: c.code,
        discountType: c.discountType,
        discountValue: c.discountType === 'fixed'
          ? couponAmountInCheckoutCurrency(c.discountValue, c)
          : c.discountValue,
        currency,
        sourceDiscountValue: c.discountValue,
        sourceCurrency: couponCurrency(c),
        applicableProductIds: c.applicableProductIds,
      })),

      paymentMethod:
        data.paymentMethod === "stripe"
          ? "stripe"
          : "cash_on_delivery",

      tracking: {
        ...getTikTokTrackingContext(),
        tiktokPlaceOrderEventId,
        tiktokPurchaseEventId,
      },
    };


    if (data.instructions !== '') order.instructions = data.instructions

    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/order/place`,
        { order },
        { headers }
      );

      toast.success(res.data.msg)

      // Check if shipping info changed - save it
      const currentShipping = {
        fullName: data.fullName, email: data.email, phone: data.phone,
        address: data.address, city: data.city, state: data.state, stateCode: data.stateCode || '',
        postalCode: data.postalCode, country: data.country || 'Pakistan', countryCode: data.countryCode || '',
      };
      const hasChanged = !savedShippingInfo ||
        Object.keys(currentShipping).some(k => currentShipping[k] !== (savedShippingInfo[k] || ''));

      if (!savedShippingInfo && currentUser) {
        // First time - auto-save silently
        try {
          await axios.patch(`${import.meta.env.VITE_API_URL}api/user/shipping-info`,
            { shippingInfo: currentShipping },
            { headers: { Authorization: `Bearer ${token}` } }
          );
          setSavedShippingInfo(currentShipping);
        } catch (e) { console.error(e); }
      } else if (hasChanged && currentUser) {
        setPendingOrderData({ order, data: res.data, currentShipping });
        setShowUpdatePrompt(true);
      }

      if (order.paymentMethod == 'cash_on_delivery') {
        setIsProcessing(false);
        trackPlaceAnOrder({
          orderId: res.data.order?.orderId || res.data.order?._id,
          cartItems: cartItems?.cart || [],
          totalAmount,
          eventId: tiktokPlaceOrderEventId,
        });

        // If update prompt is showing, don't navigate yet - modal handles it
        if (hasChanged && currentUser) return;

        setTimeout(async () => {
          if (token) {
            axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`, {
              headers: { Authorization: `Bearer ${token}` }
            }).then(() => fetchCart()).catch(error => console.error('Error clearing cart:', error));
          } else {
            // Guest: clear local cart
            localStorage.removeItem('guestCart');
            fetchCart();
          }
          try { sessionStorage.removeItem(CHECKOUT_STORAGE_KEY); } catch (_) {}
          navigate('/success');
        }, 1500);
        return;
      }

      trackAddPaymentInfo({
        cartItems: cartItems?.cart || [],
        totalAmount,
      });
      trackPlaceAnOrder({
        orderId: res.data.order?.orderId,
        cartItems: cartItems?.cart || [],
        totalAmount,
        eventId: tiktokPlaceOrderEventId,
      });

      const stripe = await stripePromise;
      await stripe.redirectToCheckout({ sessionId: res.data.id })


    } catch (error) {
      if (order.paymentMethod === 'stripe') {
        console.error("Checkout session creation error:", error);
        toast.error(error.response?.data?.msg || "Server error while creating checkout session. Try again!");
      }
      else {
        console.error("Ordder placing error:", error);
        toast.error(error.response?.data?.msg || "Server error while placing Order. Try again!");
      }
      setIsProcessing(false);
    }
  };


  // // Helper function to complete order placement
  // const completeOrderPlacement = async (token) => {
  //   try {
  //     // This would be your actual order placement API call
  //     // For demonstration, we're using a timeout
  //     setTimeout(async () => {
  //       // Simulate API call

  //       // Clear cart after order placement
  //       const clearCartRes = await axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`,
  //         {
  //           headers: {
  //             Authorization: `Bearer ${token}`
  //           }
  //         }
  //       );
  //       console.log(clearCartRes.data.msg);
  //       fetchCart();

  //       // Move to confirmation step
  //       // setCurrentStep(3);
  //       setIsProcessing(false);

  //       // Navigate to home after delay
  //       // setTimeout(() => {
  //       //   navigate('/');
  //       // }, 6000);
  //     }, 1500);
  //   } catch (error) {
  //     console.error("Order completion error:", error);
  //     toast.error("Failed to complete order. Please try again.");
  //     setIsProcessing(false);
  //   }
  // };

  return (
    <div className="min-h-screen py-8 sm:py-12 px-3 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight" style={{ color: 'hsl(var(--foreground))' }}>Checkout</h1>
          <p className="mt-1.5 text-sm sm:text-base" style={{ color: 'hsl(var(--muted-foreground))' }}>Complete your purchase with confidence</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 lg:gap-8">
          <form
            className="lg:col-span-2 glass-panel p-4 sm:p-6"
          >

            {/* Progress Steps */}
            <div className="mb-8 sm:mb-12">
              <div className="relative px-1 sm:px-4">
                <div className="absolute left-[16.666%] right-[16.666%] top-4 sm:top-5 h-1 overflow-hidden rounded-full" style={{ background: 'hsl(var(--muted))' }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${(currentStep / (steps.length - 1)) * 100}%`, background: 'linear-gradient(90deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' }}
                  />
                </div>

                <div className="relative z-10 grid grid-cols-3">
                  {steps.map((step, index) => (
                    <div key={step} className="flex flex-col items-center">
                      <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 text-sm sm:text-base shadow-sm transition-colors duration-300"
                        style={{
                          background: index <= currentStep ? 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))' : 'hsl(var(--background))',
                          borderColor: index <= currentStep ? 'hsl(220, 70%, 55%)' : 'hsl(var(--border))',
                          color: index <= currentStep ? 'white' : 'hsl(var(--muted-foreground))',
                        }}>
                        {index < currentStep ? (
                          <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                        ) : (
                          <span className="text-xs sm:text-sm font-semibold">{index + 1}</span>
                        )}
                      </div>
                      <span className="mt-1.5 text-xs sm:text-sm font-medium"
                        style={{ color: index <= currentStep ? 'hsl(220, 70%, 55%)' : 'hsl(var(--muted-foreground))' }}>
                        {step}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>


            {/* Step Content */}
            <AnimatePresence mode="wait">
              <motion.div
                key={currentStep}
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.35 }}
              >
                {/* CART STEP */}
                {currentStep === 0 && (
                  <div>
                    <h2 className="text-lg sm:text-xl font-semibold mb-4 sm:mb-6 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                      <div className="p-2 rounded-full" style={{ background: 'hsla(220, 70%, 55%, 0.12)' }}>
                        <Truck className="w-5 h-5" style={{ color: 'hsl(220, 70%, 55%)' }} />
                      </div>
                      Your Cart
                    </h2>

                    {
                      !cartItems?.cart || cartItems.cart.length === 0 ? (
                        <div className="text-center py-8">
                          <p style={{ color: 'hsl(var(--muted-foreground))' }}>Your cart is empty</p>
                          <button
                            type="button"
                            className="mt-4 font-medium"
                            style={{ color: 'hsl(var(--primary))' }}
                            onClick={() => navigate('/')}
                          >
                            Continue Shopping
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          {Object.entries(cartItemsBySeller).map(([sellerId, sellerItems]) => {
                            const couponConfig = getCouponInputConfig(sellerId, sellerItems);
                            const groupKey = `seller-${sellerId}`;

                            return (
                              <div key={sellerId} className="space-y-3">
                                {/* Seller items */}
                                {sellerItems.map((item) => {
                                  const { product, qty } = item;
                                  const { _id, name, image } = product;
                                  const itemSourceCurrency = productCurrency(product);
                                  const itemPrice = productPriceInCheckoutCurrency(product);
                                  const productCouponDiscount = getProductCouponDiscount(_id, itemPrice, qty);
                                  const productKey = `product-${_id}`;
                                  const showPerProductInput = couponConfig?.type === 'per-product' && couponConfig.productIds.includes(_id);

                                  return (
                                    <div key={item._id}>
                                      <motion.div
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ duration: 0.3 }}
                                        className="flex items-center relative justify-between p-3 sm:p-4 glass-inner rounded-xl"
                                      >
                                        <div className="flex items-center gap-4">
                                          <AnimatePresence mode="wait">
                                            {qtyUpdateId === item._id && (
                                              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                                className="w-full h-full absolute backdrop-blur-lg top-0 left-0 z-2 flex justify-center items-center gap-1 rounded-xl"
                                                style={{ color: 'hsl(220, 70%, 55%)' }}>
                                                Processing <span className="animate-spin"><Loader2 /></span>
                                              </motion.div>
                                            )}
                                          </AnimatePresence>
                                          <img className="h-16 w-16 rounded-lg object-cover" src={image} alt={name} />
                                          <div>
                                            <h4 className="font-medium text-sm sm:text-base" style={{ color: 'hsl(var(--foreground))' }}>{name}</h4>
                                            <p>
                                              <span className="font-bold text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatPrice(itemPrice, { sourceCurrency: currency })}</span>
                                              {productCouponDiscount > 0 && (
                                                <span className="ml-2 text-xs font-semibold" style={{ color: 'hsl(150, 60%, 45%)' }}>
                                                  -{currentMoney(productCouponDiscount)} coupon
                                                </span>
                                              )}
                                            </p>
                                            <QuantitySelector
                                              qty={qty}
                                              onIncrement={() => handleQtyInc(item._id)}
                                              onDecrement={() => handleQtyDec(item._id)}
                                            />
                                          </div>
                                        </div>
                                        <button onClick={() => handleRemoveCartItem(_id)} type="button" className="absolute cursor-pointer top-2 right-2">
                                          <X />
                                        </button>
                                      </motion.div>

                                      {/* Per-product coupon input */}
                                      {showPerProductInput && (
                                        <CouponInput
                                          inputKey={productKey}
                                          couponInputs={couponInputs}
                                          setCouponInputs={setCouponInputs}
                                          appliedCoupons={appliedCoupons}
                                          couponLoading={couponLoading}
                                          onApply={() => applyCoupon(productKey, [_id])}
                                          onRemove={() => removeCoupon(productKey)}
                                          formatPrice={formatCouponAmount}
                                        />
                                      )}
                                    </div>
                                  );
                                })}

                                {/* Group-level coupon input for this seller */}
                                {couponConfig?.type === 'group' && (
                                  <CouponInput
                                    inputKey={groupKey}
                                    couponInputs={couponInputs}
                                    setCouponInputs={setCouponInputs}
                                    appliedCoupons={appliedCoupons}
                                    couponLoading={couponLoading}
                                    onApply={() => applyCoupon(groupKey, sellerItems.map(i => i.product._id))}
                                    onRemove={() => removeCoupon(groupKey)}
                                    formatPrice={formatCouponAmount}
                                    isGroup
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                  </div>
                )}

                {/* SHIPPING STEP */}
                {currentStep === 1 && (
                  <div>
                    <div className="flex items-center justify-between mb-4 sm:mb-6">
                      <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                        <div className="p-2 rounded-full" style={{ background: 'hsla(220, 70%, 55%, 0.12)' }}>
                          <MapPin className="w-5 h-5" style={{ color: 'hsl(220, 70%, 55%)' }} />
                        </div>
                        Shipping Information
                      </h2>
                      {savedShippingInfo && (
                        <motion.button type="button" whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
                          onClick={handleAutoFill}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold"
                          style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white', boxShadow: '0 0 15px -3px hsl(220, 70%, 55%, 0.3)' }}>
                          <Zap size={14} /> Auto Fill
                        </motion.button>
                      )}
                    </div>

                    {
                      cartItems?.cart && cartItems.cart.length >= 1 ? (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <InputField
                              icon={<User className="w-5 h-5  text-gray-400" />}
                              placeholder="Full Name"
                              {...register("fullName", { required: "Full name is required" })}
                              error={errors.fullName}
                            />
                            <InputField
                              icon={<Mail className="w-5 h-5  text-gray-400" />}
                              placeholder="Email"
                              type="email"
                              {...register("email", {
                                required: "Email is required",
                                pattern: { value: /^\S+@\S+$/i, message: "Invalid email" },
                              })}
                              error={errors.email}
                            />
                            <Controller
                              name="phone"
                              control={control}
                              rules={{
                                required: "Phone is required",
                                validate: (v) => isValidPhone(v) || "Enter a valid phone number (pick the country and enter your number)",
                              }}
                              render={({ field, fieldState }) => (
                                <PhoneField
                                  {...field}
                                  placeholder="Phone (WhatsApp will use this)"
                                  profileCountry={watch("country")}
                                  error={fieldState.error}
                                />
                              )}
                            />
                            <InputField
                              icon={<Home className="w-5 h-5  text-gray-400" />}
                              placeholder="Address"
                              {...register("address", { required: "Address is required" })}
                              error={errors.address}
                            />
                            <input type="hidden" {...register("country", { required: "Country is required" })} />
                            <input type="hidden" {...register("countryCode", { required: "Country is required" })} />
                            <input type="hidden" {...register("state")} />
                            <input type="hidden" {...register("stateCode")} />
                            <input type="hidden" {...register("city", { required: "City is required" })} />
                            <LocationAutocomplete
                              type="country"
                              label="Country"
                              value={watch("country")}
                              code={watch("countryCode")}
                              placeholder="Select country"
                              required
                              onSelect={(option) => {
                                setValue("country", option.name, { shouldValidate: true, shouldDirty: true });
                                setValue("countryCode", option.isoCode, { shouldValidate: true, shouldDirty: true });
                                setValue("state", "", { shouldValidate: true, shouldDirty: true });
                                setValue("stateCode", "", { shouldValidate: true, shouldDirty: true });
                                setValue("city", "", { shouldValidate: true, shouldDirty: true });
                              }}
                              onClear={() => {
                                setValue("country", "", { shouldValidate: true, shouldDirty: true });
                                setValue("countryCode", "", { shouldValidate: true, shouldDirty: true });
                                setValue("state", "", { shouldValidate: true, shouldDirty: true });
                                setValue("stateCode", "", { shouldValidate: true, shouldDirty: true });
                                setValue("city", "", { shouldValidate: true, shouldDirty: true });
                              }}
                            />
                            <LocationAutocomplete
                              type="state"
                              label="State/Province"
                              value={watch("state")}
                              code={watch("stateCode")}
                              countryCode={watch("countryCode")}
                              countryName={watch("country")}
                              placeholder="Select state"
                              disabled={!watch("country") && !watch("countryCode")}
                              onSelect={(option) => {
                                setValue("state", option.name, { shouldValidate: true, shouldDirty: true });
                                setValue("stateCode", option.isoCode, { shouldValidate: true, shouldDirty: true });
                                setValue("city", "", { shouldValidate: true, shouldDirty: true });
                              }}
                              onClear={() => {
                                setValue("state", "", { shouldValidate: true, shouldDirty: true });
                                setValue("stateCode", "", { shouldValidate: true, shouldDirty: true });
                                setValue("city", "", { shouldValidate: true, shouldDirty: true });
                              }}
                            />
                            <LocationAutocomplete
                              type="city"
                              label="City"
                              value={watch("city")}
                              code={watch("stateCode")}
                              countryCode={watch("countryCode")}
                              countryName={watch("country")}
                              stateCode={watch("stateCode")}
                              stateName={watch("state")}
                              placeholder="Select city"
                              disabled={!watch("country") && !watch("countryCode")}
                              required
                              onSelect={(option) => {
                                setValue("city", option.name, { shouldValidate: true, shouldDirty: true });
                                if (!watch("stateCode") && option.stateCode) setValue("stateCode", option.stateCode, { shouldValidate: true, shouldDirty: true });
                              }}
                              onClear={() => setValue("city", "", { shouldValidate: true, shouldDirty: true })}
                            />
                            <InputField
                              placeholder="Postal Code"
                              {...register("postalCode", { required: "Postal code is required" })}
                              error={errors.postalCode}
                            />
                            {(errors.country || errors.city) && (
                              <p className="md:col-span-2 text-sm" style={{ color: 'hsl(0, 72%, 55%)' }}>
                                {errors.country?.message || errors.city?.message}
                              </p>
                            )}
                          </div>

                          {/* Shipping Method Selection - Grouped by Seller */}
                          <div className="mt-6">
                            <label className="block text-sm font-medium text-gray-700 mb-3">
                              <div className="flex items-center gap-2">
                                <Truck className="w-5 h-5" />
                                Select Shipping Method
                              </div>
                            </label>

                            {Object.keys(sellerShippingMethods).length === 0 ? (
                              <p className="text-gray-500 text-sm">Loading shipping options...</p>
                            ) : (
                              <>
                                {/* Info Message for Multi-Seller Orders */}
                                {Object.keys(sellerShippingMethods).length > 1 && (
                                  <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                                    <div className="flex gap-3">
                                      <div className="flex-shrink-0">
                                        <svg className="w-5 h-5 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
                                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                                        </svg>
                                      </div>
                                      <div className="flex-1">
                                        <h4 className="text-sm font-semibold text-blue-900 mb-1">
                                          Multiple Seller's products in Your Cart!
                                        </h4>
                                        <p className="text-xs text-blue-800">
                                          Your items are from <span className="font-semibold">{Object.keys(sellerShippingMethods).length} different sellers</span>.
                                          Each seller has their own shipping methods and costs. Please select a shipping method for each seller's products below.
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                )}

                                <div className="space-y-6">
                                {Object.entries(sellerShippingMethods).map(([sellerId, { seller, methods }]) => {
                                  const sellerProducts = cartItemsBySeller[sellerId] || [];
                                  const isExpanded = expandedSellers[sellerId] === true; // Default to collapsed
                                  const hasMultipleProducts = sellerProducts.length > 1;

                                  return (
                                    <div key={sellerId} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                                      {/* Products from this Seller */}
                                      <div className="mb-3">
                                        {sellerProducts.length > 0 && (
                                          <div className="space-y-2">
                                            {/* Collapsed View - Summary with Remove All */}
                                            {!isExpanded && (
                                              <div className="flex items-center justify-between p-3 bg-white rounded-lg">
                                                <div className="flex items-center gap-3">
                                                  <div className="relative">
                                                    <img
                                                      className="h-12 w-12 rounded object-cover"
                                                      src={sellerProducts[0].product.image}
                                                      alt={sellerProducts[0].product.name}
                                                    />
                                                    {sellerProducts.length > 1 && (
                                                      <div className="absolute -top-1 -right-1 bg-indigo-600 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                                                        {sellerProducts.length}
                                                      </div>
                                                    )}
                                                  </div>
                                                  <div>
                                                    <p className="font-medium text-sm text-gray-900">
                                                      {sellerProducts.length === 1
                                                        ? sellerProducts[0].product.name
                                                        : `${sellerProducts.length} items`
                                                      }
                                                    </p>
                                                    {sellerProducts.length === 1 && formatOrderItemOptions(sellerProducts[0]) && (
                                                      <p className="text-xs text-gray-500 leading-snug">
                                                        {formatOrderItemOptions(sellerProducts[0])}
                                                      </p>
                                                    )}
                                                    <p className="text-xs text-gray-500">
                                                      Total: {currentMoney(sellerProducts.reduce((sum, item) =>
                                                        sum + (productPriceInCheckoutCurrency(item.product) * item.qty), 0
                                                      ))}
                                                    </p>
                                                  </div>
                                                </div>
                                                <button
                                                  type="button"
                                                  onClick={async () => {
                                                    // Remove all products from this seller sequentially
                                                    for (const item of sellerProducts) {
                                                      await handleRemoveCartItem(item.product._id);
                                                    }
                                                  }}
                                                  className="text-gray-400 hover:text-red-600 transition-colors"
                                                  title="Remove all items"
                                                >
                                                  <X className="w-5 h-5" />
                                                </button>
                                              </div>
                                            )}

                                            {/* Expanded View - All Products with Individual Remove */}
                                            <AnimatePresence>
                                              {isExpanded && (
                                                <motion.div
                                                  initial={{ opacity: 0, height: 0 }}
                                                  animate={{ opacity: 1, height: 'auto' }}
                                                  exit={{ opacity: 0, height: 0 }}
                                                  transition={{ duration: 0.2 }}
                                                  className="space-y-2"
                                                >
                                                  {sellerProducts.map((item) => {
                                                    const itemPrice = productPriceInCheckoutCurrency(item.product);
                                                    // const hasSpinDiscount = false; // SPIN WHEEL DISABLED

                                                    return (
                                                      <div key={item._id} className="flex items-center gap-3 p-2 bg-white rounded-lg relative">
                                                        <img
                                                          className="h-12 w-12 rounded object-cover"
                                                          src={item.product.image}
                                                          alt={item.product.name}
                                                        />
                                                        <div className="flex-1">
                                                          <p className="font-medium text-sm text-gray-900">{item.product.name}</p>
                                                          {formatOrderItemOptions(item) && (
                                                            <p className="text-xs text-gray-500 leading-snug">{formatOrderItemOptions(item)}</p>
                                                          )}
                                                          <p className="text-xs text-gray-500">Qty: {item.qty}</p>
                                                        </div>
                                                        <div className="text-right">
                                                          <span className="font-semibold text-sm">{currentMoney(itemPrice * item.qty)}</span>
                                                          {/* SPIN WHEEL DISABLED - spin discount strikethrough removed */}
                                                          {/* {hasSpinDiscount && (<p className="text-xs text-gray-500 line-through">{formatPrice(originalPrice * item.qty)}</p>)} */}
                                                        </div>
                                                        <button
                                                          type="button"
                                                          onClick={() => handleRemoveCartItem(item.product._id)}
                                                          className="absolute top-2 right-2 text-gray-400 hover:text-red-600 transition-colors"
                                                        >
                                                          <X className="w-4 h-4" />
                                                        </button>
                                                      </div>
                                                    );
                                                  })}
                                                </motion.div>
                                              )}
                                            </AnimatePresence>

                                            {/* Expand/Collapse Button */}
                                            <button
                                              type="button"
                                              onClick={() => setExpandedSellers(prev => ({
                                                ...prev,
                                                [sellerId]: !isExpanded
                                              }))}
                                              className="w-full flex items-center justify-center gap-2 py-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
                                            >
                                              {isExpanded ? (
                                                <>
                                                  <ChevronUp className="w-4 h-4" />
                                                  Collapse
                                                </>
                                              ) : (
                                                <>
                                                  <ChevronDown className="w-4 h-4" />
                                                  {sellerProducts.length === 1 ? 'View details' : `View all ${sellerProducts.length} items`}
                                                </>
                                              )}
                                            </button>
                                          </div>
                                        )}
                                      </div>

                                    {/* Shipping Options for these Products */}
                                    <div className="space-y-2 pt-3 border-t border-gray-300">
                                      <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs font-medium text-gray-600">Choose shipping method:</p>
                                        <p className="text-xs text-gray-500">
                                          {methods.length === 1
                                            ? '1 method available'
                                            : `${methods.length} methods available`
                                          }
                                        </p>
                                      </div>
                                      {methods.map((method) => (
                                        <motion.div
                                          key={method.type}
                                          whileHover={{ scale: 1.01 }}
                                          onClick={() => setSelectedShippingPerSeller(prev => ({
                                            ...prev,
                                            [sellerId]: method
                                          }))}
                                          className={`border-2 rounded-lg p-3 cursor-pointer transition-all ${
                                            selectedShippingPerSeller[sellerId]?.type === method.type
                                              ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-100'
                                              : 'border-gray-300 hover:border-gray-400 bg-white'
                                          }`}
                                        >
                                          <div className="flex justify-between items-center">
                                            <div className="flex items-center gap-3">
                                              <div className={`p-2 rounded-full ${
                                                selectedShippingPerSeller[sellerId]?.type === method.type
                                                  ? 'bg-blue-100 text-blue-600'
                                                  : 'bg-gray-100 text-gray-600'
                                              }`}>
                                                <Truck className="w-4 h-4" />
                                              </div>
                                              <div>
                                                <div className="flex items-center gap-2">
                                                  <h5 className="font-medium capitalize text-sm">
                                                    {getShippingMethodTitle(method)}
                                                  </h5>
                                                  {method.type === 'free' && (
                                                    <span className="px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-700 rounded-full">
                                                      Recommended
                                                    </span>
                                                  )}
                                                </div>
                                                <p className="text-xs text-gray-500">
                                                  Delivery in {method.deliveryDays} {method.deliveryDays === 1 ? 'day' : 'days'}
                                                </p>
                                              </div>
                                            </div>
                                            <span className="font-semibold">
                                              {currentMoney(shippingCostInCheckoutCurrency(method, { seller }))}
                                            </span>
                                          </div>
                                        </motion.div>
                                      ))}
                                    </div>
                                  </div>
                                  );
                                })}
                              </div>
                              </>
                            )}
                          </div>

                          <div className="mt-6">
                            <label className="block text-sm font-medium mb-2" style={{ color: 'hsl(var(--foreground))' }}>Delivery Instructions (Optional)</label>
                            <textarea
                              placeholder="Any special delivery instructions?"
                              className="glass-input w-full h-24 resize-none"
                              {...register("instructions")}
                            />
                          </div>
                        </>
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-gray-500">Your cart is empty</p>
                        </div>
                      )
                    }
                  </div>
                )}

                {/* PAYMENT STEP */}
                {currentStep === 2 && (
                  <div>
                    <h2 className="text-lg sm:text-xl font-semibold mb-4 sm:mb-6 flex items-center gap-2" style={{ color: 'hsl(var(--foreground))' }}>
                      <div className="p-2 rounded-full" style={{ background: 'hsla(220, 70%, 55%, 0.12)' }}>
                        <CreditCard className="w-5 h-5" style={{ color: 'hsl(220, 70%, 55%)' }} />
                      </div>
                      Payment Method
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                      <PaymentOption
                        value="stripe"
                        title="Credit/Debit Card"
                        description="Pay securely with Stripe"
                        icon={<CreditCardIcon className="w-6 h-6" />}
                        selected={paymentMethod === "stripe"}
                        {...register("paymentMethod")}
                      />
                      <PaymentOption
                        value="cash_on_delivery"
                        title="Cash on Delivery"
                        description="Pay when you receive your order"
                        icon={<DollarSign className="w-6 h-6" />}
                        selected={paymentMethod === "cash_on_delivery"}
                        {...register("paymentMethod")}
                      />
                    </div>

                    {paymentMethod === "stripe" && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.3 }}
                        className="glass-inner p-4 rounded-xl mb-6"
                      >
                        <p className="text-sm" style={{ color: 'hsl(220, 70%, 55%)' }}>
                          You will be redirected to Stripe's secure payment page to complete your transaction.
                        </p>
                      </motion.div>
                    )}

                    {/* Billing Address Section */}
                    <div className="mt-6">
                      <div className="flex items-center mb-4">
                        <input
                          type="checkbox"
                          id="billingSameAsShipping"
                          className="h-4 w-4 rounded accent-[hsl(220,70%,55%)]"
                          {...register("billingSameAsShipping")}
                        />
                        <label htmlFor="billingSameAsShipping" className="ml-2 block text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                          Billing address same as shipping address
                        </label>
                      </div>

                      {!billingSameAsShipping && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          transition={{ duration: 0.3 }}
                          className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"
                        >
                          <h3 className="md:col-span-2 text-lg font-semibold mb-2">Billing Address</h3>
                          <InputField
                            placeholder="Billing Address"
                            {...register("billingAddress", {
                              required: !billingSameAsShipping && "Billing address is required"
                            })}
                            error={errors.billingAddress}
                          />
                          <input type="hidden" {...register("billingCountry", { required: !billingSameAsShipping && "Billing country is required" })} />
                          <input type="hidden" {...register("billingCountryCode", { required: !billingSameAsShipping && "Billing country is required" })} />
                          <input type="hidden" {...register("billingState")} />
                          <input type="hidden" {...register("billingStateCode")} />
                          <input type="hidden" {...register("billingCity", { required: !billingSameAsShipping && "Billing city is required" })} />
                          <LocationAutocomplete
                            type="country"
                            label="Billing Country"
                            value={watch("billingCountry")}
                            code={watch("billingCountryCode")}
                            placeholder="Select billing country"
                            required={!billingSameAsShipping}
                            onSelect={(option) => {
                              setValue("billingCountry", option.name, { shouldValidate: true, shouldDirty: true });
                              setValue("billingCountryCode", option.isoCode, { shouldValidate: true, shouldDirty: true });
                              setValue("billingState", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingStateCode", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingCity", "", { shouldValidate: true, shouldDirty: true });
                            }}
                            onClear={() => {
                              setValue("billingCountry", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingCountryCode", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingState", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingStateCode", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingCity", "", { shouldValidate: true, shouldDirty: true });
                            }}
                          />
                          <LocationAutocomplete
                            type="state"
                            label="Billing State/Province"
                            value={watch("billingState")}
                            code={watch("billingStateCode")}
                            countryCode={watch("billingCountryCode")}
                            countryName={watch("billingCountry")}
                            placeholder="Select billing state"
                            disabled={!watch("billingCountry") && !watch("billingCountryCode")}
                            onSelect={(option) => {
                              setValue("billingState", option.name, { shouldValidate: true, shouldDirty: true });
                              setValue("billingStateCode", option.isoCode, { shouldValidate: true, shouldDirty: true });
                              setValue("billingCity", "", { shouldValidate: true, shouldDirty: true });
                            }}
                            onClear={() => {
                              setValue("billingState", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingStateCode", "", { shouldValidate: true, shouldDirty: true });
                              setValue("billingCity", "", { shouldValidate: true, shouldDirty: true });
                            }}
                          />
                          <LocationAutocomplete
                            type="city"
                            label="Billing City"
                            value={watch("billingCity")}
                            code={watch("billingStateCode")}
                            countryCode={watch("billingCountryCode")}
                            countryName={watch("billingCountry")}
                            stateCode={watch("billingStateCode")}
                            stateName={watch("billingState")}
                            placeholder="Select billing city"
                            disabled={!watch("billingCountry") && !watch("billingCountryCode")}
                            required={!billingSameAsShipping}
                            onSelect={(option) => {
                              setValue("billingCity", option.name, { shouldValidate: true, shouldDirty: true });
                              if (!watch("billingStateCode") && option.stateCode) setValue("billingStateCode", option.stateCode, { shouldValidate: true, shouldDirty: true });
                            }}
                            onClear={() => setValue("billingCity", "", { shouldValidate: true, shouldDirty: true })}
                          />
                          <InputField
                            placeholder="Billing Postal Code"
                            {...register("billingPostalCode", {
                              required: !billingSameAsShipping && "Billing postal code is required"
                            })}
                            error={errors.billingPostalCode}
                          />
                          {(errors.billingCountry || errors.billingCity) && (
                            <p className="md:col-span-2 text-sm" style={{ color: 'hsl(0, 72%, 55%)' }}>
                              {errors.billingCountry?.message || errors.billingCity?.message}
                            </p>
                          )}
                        </motion.div>
                      )}
                    </div>
                  </div>
                )}


              </motion.div>
            </AnimatePresence>

            {/* Navigation Buttons */}
            {currentStep < steps.length && (
              <div className="flex justify-between mt-6 sm:mt-8">
                <button
                  type="button"
                  onClick={prevStep}
                  disabled={currentStep === 0 || isProcessing}
                  className={`px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl font-medium flex items-center gap-2 text-sm sm:text-base transition-all ${currentStep === 0 || isProcessing
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:-translate-y-0.5"
                    }`}
                  style={{
                    background: currentStep === 0 || isProcessing ? 'hsl(var(--muted))' : 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                    color: currentStep === 0 || isProcessing ? 'hsl(var(--muted-foreground))' : 'white',
                  }}
                >
                  <Navigation className="w-4 h-4 sm:w-5 sm:h-5 rotate-180" />
                  Back
                </button>

                {currentStep === steps.length - 1 ? (
                  <button
                    type="button"
                    onClick={handleSubmit(onPlaceOrder)}
                    disabled={isSubmitting || isProcessing || !cartItems?.cart || cartItems.cart.length == 0}
                    className="px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-0.5 flex items-center gap-2 text-sm sm:text-base glow-soft"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}
                  >
                    {isProcessing ? (
                      <>
                        <div className="w-4 h-4 sm:w-5 sm:h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Processing...
                      </>
                    ) : paymentMethod === "cash_on_delivery" ? (
                      <>
                        <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                        Place Order
                      </>
                    ) : (
                      <>
                        <CreditCard className="w-4 h-4 sm:w-5 sm:h-5" />
                        Pay Securely
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={nextStep}
                    disabled={!cartItems?.cart || cartItems.cart.length == 0}
                    className={`px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl font-medium flex items-center gap-2 text-sm sm:text-base transition-all ${!cartItems?.cart || cartItems.cart.length === 0
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:-translate-y-0.5 glow-soft"
                      }`}
                    style={{
                      background: !cartItems?.cart || cartItems.cart.length === 0 ? 'hsl(var(--muted))' : 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                      color: !cartItems?.cart || cartItems.cart.length === 0 ? 'hsl(var(--muted-foreground))' : 'white',
                    }}
                  >
                    Next
                    <Navigation className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                )}
              </div>
            )}
          </form>

          {/* Order Summary */}
          <div className="lg:col-span-1">
            <div className="sticky top-6 glass-panel p-4 sm:p-6">
              <h3 className="text-lg font-semibold mb-4 pb-2 border-b" style={{ color: 'hsl(var(--foreground))', borderColor: 'hsl(var(--border))' }}>Order Summary</h3>

              <div className="max-h-80 overflow-y-auto mb-4">
                {cartItems.cart.map((item) => {
                  const itemPrice = productPriceInCheckoutCurrency(item.product);
                  // const hasSpinDiscount = false; // SPIN WHEEL DISABLED

                  return (
                    <div key={item._id} className="flex items-center justify-between py-3" style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                      <div className="flex items-center gap-3">
                        <img
                          className="h-12 w-12 rounded object-cover"
                          src={item.product.image}
                          alt={item.product.name}
                        />
                        <div>
                          <p className="font-medium text-xs sm:text-sm" style={{ color: 'hsl(var(--foreground))' }}>{item.product.name}</p>
                          {formatOrderItemOptions(item) && (
                            <p className="text-xs leading-snug" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatOrderItemOptions(item)}</p>
                          )}
                          <p className="text-xs sm:text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>Qty: {item.qty}</p>
                          {/* SPIN WHEEL DISABLED - spin discount badge removed */}
                          {/* {hasSpinDiscount && (<p className="text-xs text-green-600 font-semibold">🎉 Spin Discount Applied!</p>)} */}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="font-semibold">{currentMoney(itemPrice * item.qty)}</span>
                        {/* SPIN WHEEL DISABLED - spin discount strikethrough removed */}
                        {/* {hasSpinDiscount && (<p className="text-xs text-gray-500 line-through">{formatPrice(originalPrice * item.qty)}</p>)} */}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex justify-between text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  <span>Subtotal</span>
                  <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{currentMoney(subtotal)}</span>
                </div>

                {Object.keys(selectedShippingPerSeller).length > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <span>Shipping</span>
                      <span style={{ color: 'hsl(var(--foreground))' }}>{currentMoney(shippingCost)}</span>
                    </div>
                    {Object.entries(selectedShippingPerSeller).map(([sellerId, method]) => {
                      const sellerInfo = sellerShippingMethods[sellerId];
                      return (
                        <div key={sellerId} className="flex justify-between text-xs pl-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          <span>{getShippingMethodTitle(method)}</span>
                          <span>{currentMoney(shippingCostInCheckoutCurrency(method, sellerInfo))}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {tax > 0 && (
                  <div className="flex justify-between text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <span>Tax {taxConfig?.type === 'percentage' && `(${taxConfig.value}%)`}</span>
                    <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{currentMoney(tax)}</span>
                  </div>
                )}

                {totalCouponDiscount > 0 && (
                  <div className="flex justify-between text-sm" style={{ color: 'hsl(150, 60%, 45%)' }}>
                    <span className="flex items-center gap-1"><Ticket size={14} /> Coupon Discount</span>
                    <span className="font-semibold">-{currentMoney(totalCouponDiscount)}</span>
                  </div>
                )}

                <div className="flex justify-between text-base sm:text-lg font-semibold pt-3" style={{ borderTop: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
                  <span>Total</span>
                  <span style={{ color: 'hsl(220, 70%, 55%)' }}>{currentMoney(totalAmount)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Update Shipping Info Prompt Modal */}
      <AnimatePresence>
        {showUpdatePrompt && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              className="glass-panel-strong p-6 max-w-md w-full">
              <h3 className="text-lg font-semibold mb-2" style={{ color: 'hsl(var(--foreground))' }}>Update Shipping Info?</h3>
              <p className="text-sm mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>
                Your shipping details have changed. Would you like to save them for future orders?
              </p>
              <div className="flex justify-end gap-3">
                <motion.button whileTap={{ scale: 0.97 }}
                  onClick={() => {
                    setShowUpdatePrompt(false);
                    // Continue with order flow
                    if (pendingOrderData?.data) {
                      const token = getAuthToken();
                      if (pendingOrderData.order?.paymentMethod === 'cash_on_delivery') {
                        axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`, { headers: { Authorization: `Bearer ${token}` } })
                          .then(() => fetchCart()).catch(() => {});
                        try { sessionStorage.removeItem(CHECKOUT_STORAGE_KEY); } catch (_) {}
                        navigate('/success');
                      }
                    }
                  }}
                  className="px-4 py-2 rounded-xl glass-inner font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>
                  No, Keep Previous
                </motion.button>
                <motion.button whileTap={{ scale: 0.97 }}
                  onClick={async () => {
                    try {
                      const token = getAuthToken();
                      await axios.patch(`${import.meta.env.VITE_API_URL}api/user/shipping-info`,
                        { shippingInfo: pendingOrderData?.currentShipping },
                        { headers: { Authorization: `Bearer ${token}` } }
                      );
                      toast.success('Shipping info updated!');
                      setSavedShippingInfo(pendingOrderData?.currentShipping);
                    } catch (e) { console.error(e); }
                    setShowUpdatePrompt(false);
                    if (pendingOrderData?.order?.paymentMethod === 'cash_on_delivery') {
                      const token = getAuthToken();
                      axios.delete(`${import.meta.env.VITE_API_URL}api/cart/clear`, { headers: { Authorization: `Bearer ${token}` } })
                        .then(() => fetchCart()).catch(() => {});
                      try { sessionStorage.removeItem(CHECKOUT_STORAGE_KEY); } catch (_) {}
                      navigate('/success');
                    }
                  }}
                  className="px-4 py-2 rounded-xl text-white font-semibold text-sm"
                  style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', boxShadow: '0 0 15px -3px hsl(220, 70%, 55%, 0.3)' }}>
                  Yes, Update
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Subcomponents ---------- */

const InputField = React.forwardRef(({ icon, error, ...props }, ref) => (
  <div className="relative">
    <div className="relative">
      {icon && (
        <div className="absolute inset-y-0 right-2 pl-3 flex items-center pointer-events-none">
          {icon}
        </div>
      )}
      <input
        ref={ref}
        className={`glass-input w-full ${icon ? "pl-10" : ""} ${error ? "border-red-400" : ""}`}
        {...props}
      />
    </div>
    {error?.message && (
      <p className="text-xs mt-1" style={{ color: 'hsl(0, 72%, 55%)' }}>{String(error.message)}</p>
    )}
  </div>
));

function QuantitySelector({ qty, onIncrement, onDecrement }) {
  return (
    <div className="flex items-center glass-inner w-max rounded-xl px-2 py-1 mt-2">
      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={onDecrement}
        className="p-1 rounded-lg hover:bg-white/15 transition-colors"
        aria-label="Decrease quantity"
      >
        <Minus className="w-4 h-4" style={{ color: 'hsl(var(--muted-foreground))' }} />
      </motion.button>
      <AnimatePresence mode="popLayout">
        <motion.span
          key={qty}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0 }}
          transition={{ duration: 0.2 }}
          className="px-3 sm:px-4 text-sm font-semibold select-none"
          style={{ color: 'hsl(var(--foreground))' }}
        >
          {qty}
        </motion.span>
      </AnimatePresence>
      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={onIncrement}
        className="p-1 rounded-lg hover:bg-white/15 transition-colors"
        aria-label="Increase quantity"
      >
        <Plus className="w-4 h-4" style={{ color: 'hsl(var(--muted-foreground))' }} />
      </motion.button>
    </div>
  );
}

const ShippingOption = React.forwardRef(({ value, title, price, days, selected, formatPrice: formatShippingPrice = (amount) => `$${Number(amount || 0).toFixed(2)}`, ...props }, ref) => (
  <label className={`border rounded-lg p-4 cursor-pointer transition-all ${selected ? "border-blue-600 bg-blue-50 ring-2 ring-blue-100" : "border-gray-300 hover:border-gray-400"}`}>
    <input
      type="radio"
      value={value}
      ref={ref}
      className="sr-only"
      {...props}
    />
    <div className="flex justify-between items-start">
      <div>
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-gray-500 mt-1">{days}</p>
      </div>
      <span className="font-semibold">{formatShippingPrice(price)}</span>
    </div>
  </label>
));

const PaymentOption = React.forwardRef(({ value, title, description, icon, selected, ...props }, ref) => (
  <label className={`glass-inner rounded-xl p-4 cursor-pointer transition-all ${selected ? "ring-2" : "hover:bg-white/10"}`}
    style={{ ringColor: selected ? 'hsl(220, 70%, 55%)' : undefined }}>
    <input
      type="radio"
      value={value}
      ref={ref}
      className="sr-only"
      {...props}
    />
    <div className="flex items-start gap-3">
      <div className="p-2 rounded-full" style={{ background: selected ? 'hsla(220, 70%, 55%, 0.15)' : 'hsl(var(--muted))', color: selected ? 'hsl(220, 70%, 55%)' : 'hsl(var(--muted-foreground))' }}>
        {icon}
      </div>
      <div>
        <h4 className="font-medium text-sm sm:text-base" style={{ color: 'hsl(var(--foreground))' }}>{title}</h4>
        <p className="text-xs sm:text-sm mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{description}</p>
      </div>
    </div>
  </label>
));

/* ---------- Coupon Input Component ---------- */
function CouponInput({ inputKey, couponInputs, setCouponInputs, appliedCoupons, couponLoading, onApply, onRemove, formatPrice, isGroup }) {
  const applied = appliedCoupons[inputKey];
  const isLoading = couponLoading[inputKey];

  if (applied) {
    return (
      <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }}
        className={`flex items-center justify-between p-2.5 sm:p-3 rounded-xl ${isGroup ? 'mt-2' : 'mt-1 ml-4 sm:ml-8'}`}
        style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
        <div className="flex items-center gap-2">
          <div className="p-1 rounded-full" style={{ background: 'rgba(16,185,129,0.15)' }}>
            <Check size={14} style={{ color: 'hsl(150, 60%, 45%)' }} />
          </div>
          <div>
            <span className="text-xs font-bold font-mono tracking-wider" style={{ color: 'hsl(150, 60%, 45%)' }}>
              {applied.code}
            </span>
            <span className="text-xs ml-2" style={{ color: 'hsl(var(--muted-foreground))' }}>
              {applied.discountType === 'percentage' ? `${applied.discountValue}% off` : `${formatPrice(applied.discountValue, applied)} off`}
            </span>
          </div>
        </div>
        <button type="button" onClick={onRemove} className="p-1 rounded-lg hover:bg-white/10 transition-colors"
          style={{ color: 'hsl(0, 72%, 55%)' }}>
          <X size={14} />
        </button>
      </motion.div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${isGroup ? 'mt-2' : 'mt-1 ml-4 sm:ml-8'}`}>
      <div className="flex-1 relative">
        <Ticket size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'hsl(var(--muted-foreground))' }} />
        <input
          type="text"
          placeholder="Enter coupon code"
          value={couponInputs[inputKey] || ''}
          onChange={(e) => setCouponInputs(prev => ({ ...prev, [inputKey]: e.target.value.toUpperCase() }))}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onApply())}
          className="glass-input w-full pl-9 pr-3 py-2 text-xs font-mono uppercase tracking-wider"
        />
      </div>
      <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={onApply} disabled={isLoading}
        className="px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap disabled:opacity-50"
        style={{ background: 'linear-gradient(135deg, hsl(280, 60%, 55%), hsl(320, 50%, 55%))', color: 'white' }}>
        {isLoading ? <Loader2 size={14} className="animate-spin" /> : 'Apply'}
      </motion.button>
    </div>
  );
}
