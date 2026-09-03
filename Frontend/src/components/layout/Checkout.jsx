import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, Minus, Plus, CreditCard, DollarSign, Truck, MapPin, User, Mail, Phone, Home, Navigation, CreditCardIcon, X, Loader2, ChevronDown, ChevronUp, Zap, Ticket, Tag, Check, WalletCards } from "lucide-react";
import { useForm, Controller } from "react-hook-form";
import { useGlobal } from "../../contexts/GlobalContext";
import { useCurrency } from "../../contexts/CurrencyContext";
import { useAuth } from "../../contexts/AuthContext";
import { useBuyerLocation } from "../../contexts/BuyerLocationContext";
import axios from "axios";
import { toast } from "react-toastify";
import { useNavigate } from "react-router-dom";
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
import { formatOrderItemOptions, getExactLineUnitAmount } from "../../utils/orderItems";
import { rememberPostAuthRedirect } from "../../utils/postAuthRedirect";
import {
  addCurrencyAmounts,
  checkoutHasUnsupportedCurrency,
  checkoutRequiresCurrencyConversion,
  checkoutRequiresTrustedRates,
  couponHasCurrencyAmount,
  getEffectiveProductSourcePrice,
  hasCurrencyAmount,
  percentageCurrencyAmount,
  shouldRetainIdempotencyKey,
  toCurrencyMinorUnits,
} from "../../utils/currencySafety";
import {
  createCheckoutFingerprint,
} from "../../utils/checkoutIdempotency";
import {
  calculateCheckoutCouponPricing,
  createCheckoutMoneyCartSignature,
  getCheckoutSellerDisplayName,
  getCheckoutSellerLogo,
  isCheckoutRepriceRequired,
  isPositiveSourceAmountRoundedToZero,
  parseCheckoutCouponAvailabilityResponse,
  parseCheckoutShippingMethodsResponse,
  parseCheckoutTaxConfigResponse,
  parseValidatedCheckoutCouponResponse,
  reconcileAppliedCheckoutCoupons,
  selectCheckoutShippingMethods,
} from "../../utils/checkoutPricing";
import {
  clearPersistedMutationAttemptFromLedger,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttemptInLedger,
} from "../../utils/persistedMutationAttempt";
import { requireWalletSummaryResponse } from '../../utils/walletPaymentRisk';
import { getCartPresentationProductCurrency } from '../../utils/cartPresentation';
import StoreAvatar from '../common/StoreAvatar';

const CHECKOUT_ATTEMPT_STORAGE_KEY = 'rozare_checkout_attempt_v1';
const ORDER_SUCCESS_STORAGE_KEY = 'rozare_order_success_v1';
const STRIPE_RETURN_STORAGE_KEY = 'rozare_stripe_return_v1';

const cartLineKey = (item) => String(
  item?._id
  || `${item?.product?._id || 'product'}:${item?.selectedColor || ''}:${JSON.stringify(item?.selectedOptions || item?.options || {})}`
);

const rememberConfirmedOrder = (orderId, paymentMethod, {
  noPaymentRequired = false,
  attemptStorageKey = '',
  attemptFingerprint = '',
  attemptKey = '',
} = {}) => {
  const locallyConfirmed = ['cash_on_delivery', 'wallet'].includes(paymentMethod)
    || (paymentMethod === 'stripe' && noPaymentRequired === true);
  if (
    !orderId
    || !locallyConfirmed
    || !attemptStorageKey
    || !attemptFingerprint
    || !attemptKey
  ) return false;
  try {
    const record = {
      orderId,
      paymentMethod,
      noPaymentRequired: noPaymentRequired === true,
      attemptStorageKey,
      attemptFingerprint,
      attemptKey,
      receivedAt: Date.now(),
    };
    sessionStorage.setItem(ORDER_SUCCESS_STORAGE_KEY, JSON.stringify(record));
    const confirmed = JSON.parse(sessionStorage.getItem(ORDER_SUCCESS_STORAGE_KEY) || 'null');
    return confirmed?.orderId === record.orderId
      && confirmed?.paymentMethod === record.paymentMethod
      && confirmed?.noPaymentRequired === record.noPaymentRequired
      && confirmed?.attemptStorageKey === record.attemptStorageKey
      && confirmed?.attemptFingerprint === record.attemptFingerprint
      && confirmed?.attemptKey === record.attemptKey
      && confirmed?.receivedAt === record.receivedAt;
  } catch (_) {
    return false;
  }
};

const rememberStripeCheckoutReturn = (
  orderId,
  sessionId,
  attemptStorageKey,
  attemptFingerprint,
  attemptKey,
) => {
  if (!orderId || !sessionId || !attemptStorageKey || !attemptFingerprint || !attemptKey) {
    return false;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STRIPE_RETURN_STORAGE_KEY) || '{}');
    const checkoutSession = {
      id: sessionId,
      orderId,
      path: '/success',
      attemptStorageKey,
      attemptFingerprint,
      attemptKey,
      receivedAt: Date.now(),
    };
    saved.checkoutSession = checkoutSession;
    sessionStorage.setItem(STRIPE_RETURN_STORAGE_KEY, JSON.stringify(saved));
    const confirmed = JSON.parse(sessionStorage.getItem(STRIPE_RETURN_STORAGE_KEY) || '{}')
      ?.checkoutSession;
    return confirmed?.id === checkoutSession.id
      && confirmed?.orderId === checkoutSession.orderId
      && confirmed?.path === checkoutSession.path
      && confirmed?.attemptStorageKey === checkoutSession.attemptStorageKey
      && confirmed?.attemptFingerprint === checkoutSession.attemptFingerprint
      && confirmed?.attemptKey === checkoutSession.attemptKey
      && confirmed?.receivedAt === checkoutSession.receivedAt;
  } catch (_) {
    return false;
  }
};

export default function Checkout() {

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
  const checkoutAttemptStorageKey = createScopedMutationStorageKey(
    CHECKOUT_ATTEMPT_STORAGE_KEY,
    currentUser?._id || currentUser?.id || 'guest'
  );
  const { buyerLocation } = useBuyerLocation();

  // Tax and Shipping state
  const [taxConfig, setTaxConfig] = useState(null);
  const [taxStatus, setTaxStatus] = useState('loading');
  const [taxError, setTaxError] = useState('');
  const [sellerShippingMethods, setSellerShippingMethods] = useState({});
  const [selectedShippingPerSeller, setSelectedShippingPerSeller] = useState({});
  const [shippingStatus, setShippingStatus] = useState('loading');
  const [shippingError, setShippingError] = useState('');
  const [expandedSellers, setExpandedSellers] = useState({});

  // Saved shipping info for auto-fill
  const [savedShippingInfo, setSavedShippingInfo] = useState(null);
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const [pendingOrderData, setPendingOrderData] = useState(null);

  // Coupon state
  const [sellerCoupons, setSellerCoupons] = useState({}); // { sellerId: [coupon, ...] }
  const [couponInputs, setCouponInputs] = useState({}); // { key: 'CODE' }
  const [appliedCoupons, setAppliedCoupons] = useState({}); // { key: { coupon, applicableProductIds } }
  const restoredCouponCandidatesRef = useRef((() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CHECKOUT_STORAGE_KEY) || 'null');
      return saved?.appliedCoupons && typeof saved.appliedCoupons === 'object' && !Array.isArray(saved.appliedCoupons)
        ? saved.appliedCoupons
        : null;
    } catch (_) {
      return null;
    }
  })());
  const [couponLoading, setCouponLoading] = useState({});
  const [wallet, setWallet] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const taxRequestRef = useRef(0);
  const couponRequestRef = useRef(0);
  const shippingRequestRef = useRef(0);
  const walletRequestRef = useRef(0);


  const {
    currency,
    formatPrice,
    convertAmount,
    convertLineAmounts,
    convertAmountForMoneyAction,
    exchangeRates,
    exchangeRatesLoading,
    exchangeRatesFallback,
    refreshExchangeRates,
  } = useCurrency();

  const { cartItems, handleQtyInc, handleQtyDec, handleRemoveCartItem, isCartLoading,
    isCartReady, cartHydrationStatus, cartHydrationError, retryCartHydration,
    qtyUpdateId, fetchCart
  } = useGlobal();
  const cartMoneySignature = createCheckoutMoneyCartSignature(cartItems?.cart || []);
  const checkoutUserId = currentUser?._id || currentUser?.id || '';

  const productCurrency = getCartPresentationProductCurrency;
  const couponCurrency = (coupon) => coupon?.currency || '';
  const currentMoney = (amount, options = {}) => formatPrice(amount, { ...options, sourceCurrency: currency });
  const productPriceInCheckoutCurrency = (product, amount = undefined) => {
    const value = amount === undefined
      ? getEffectiveProductSourcePrice(product)
      : amount;
    return convertAmount(value, productCurrency(product), currency);
  };
  const cartLineTotals = convertLineAmounts((cartItems?.cart || []).map((item) => ({
    unitAmount: getEffectiveProductSourcePrice(item?.product),
    quantity: item?.qty,
    sourceCurrency: productCurrency(item?.product),
  })), currency);
  const cartLineTotalsByItem = new Map((cartItems?.cart || []).map((item, index) => (
    [item, cartLineTotals[index]]
  )));
  const getCartLineTotal = (item) => cartLineTotalsByItem.get(item);
  const shippingMethodCurrency = (method, sellerInfo = null) => (
    method?.currency
    || sellerInfo?.methods?.find((candidate) => candidate?.type === method?.type)?.currency
    || ''
  );
  const shippingCostInCheckoutCurrency = (method, sellerInfo = null) =>
    convertAmount(method?.cost, shippingMethodCurrency(method, sellerInfo), currency);
  const getShippingMethodTitle = (method) => ({
    free: 'Free Shipping',
    standard: 'Standard Shipping',
    fast: 'Fast Shipping',
  }[method?.type] || `${method?.type || 'Shipping'} Shipping`);
  const couponAmountInCheckoutCurrency = (amount, coupon = null) => convertAmount(amount, couponCurrency(coupon), currency);
  const formatCouponAmount = (amount, coupon = null) => {
    const conversionUnavailable = checkoutRequiresCurrencyConversion([couponCurrency(coupon)], currency)
      && (exchangeRatesLoading || exchangeRatesFallback);
    return `${conversionUnavailable ? '≈' : ''}${currentMoney(couponAmountInCheckoutCurrency(amount, coupon))}`;
  };

  // Fetch tax configuration on mount
  useEffect(() => {
    fetchTaxConfig();
    fetchSavedShippingInfo();
    return () => {
      taxRequestRef.current += 1;
      couponRequestRef.current += 1;
      shippingRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const requestId = walletRequestRef.current + 1;
    walletRequestRef.current = requestId;
    const token = getAuthToken();
    if (!token || !checkoutUserId) {
      setWallet(null);
      setWalletLoading(false);
      return;
    }
    setWallet(null);
    setWalletLoading(true);
    axios.get(`${import.meta.env.VITE_API_URL}api/wallet/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => {
        const inspected = requireWalletSummaryResponse(response.data);
        if (walletRequestRef.current === requestId) setWallet(inspected.wallet);
      })
      .catch((error) => {
        if (walletRequestRef.current === requestId) {
          setWallet(null);
          console.error('Failed to load wallet:', error);
        }
      })
      .finally(() => {
        if (walletRequestRef.current === requestId) setWalletLoading(false);
      });
    return () => {
      if (walletRequestRef.current === requestId) walletRequestRef.current += 1;
    };
  }, [checkoutUserId]);

  // Product and seller identity drive both endpoints. Object replacement,
  // quantity updates, and list reordering do not create redundant requests.
  useEffect(() => {
    if (cartItems?.cart && cartItems.cart.length > 0) {
      const couponCandidates = restoredCouponCandidatesRef.current || appliedCoupons;
      restoredCouponCandidatesRef.current = null;
      setAppliedCoupons({});
      fetchAvailableCoupons(cartItems.cart, couponCandidates);
    } else {
      couponRequestRef.current += 1;
      setSellerCoupons({});
      setAppliedCoupons({});
      setCouponInputs({});
    }
    // Product/seller identity is deliberately the sole cart dependency here;
    // quantity and object-identity changes cannot affect coupon availability.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartMoneySignature, checkoutUserId]);

  useEffect(() => {
    if (cartItems?.cart && cartItems.cart.length > 0) {
      fetchShippingMethods(cartItems.cart);
    } else {
      shippingRequestRef.current += 1;
      setSellerShippingMethods({});
      setSelectedShippingPerSeller({});
      setShippingStatus('idle');
      setShippingError('');
    }
    // Shipping methods are seller/product scoped. Depending on cart object
    // identity would race redundant requests on every quantity/context update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartMoneySignature]);

  const fetchTaxConfig = async () => {
    const requestId = taxRequestRef.current + 1;
    taxRequestRef.current = requestId;
    setTaxStatus('loading');
    setTaxError('');
    try {
      const res = await axios.get(`${import.meta.env.VITE_API_URL}api/tax/config`);
      if (taxRequestRef.current !== requestId) return false;
      const confirmedConfig = parseCheckoutTaxConfigResponse(res.data);
      setTaxConfig(confirmedConfig);
      setTaxStatus('ready');
      return true;
    } catch (error) {
      if (taxRequestRef.current !== requestId) return false;
      console.error('Error fetching tax config:', error);
      setTaxConfig(null);
      setTaxStatus('error');
      setTaxError(error?.response?.data?.msg || error.message || 'Tax could not be confirmed.');
      return false;
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

  const fetchAvailableCoupons = async (
    cartSnapshot = cartItems?.cart || [],
    couponCandidates = appliedCoupons,
  ) => {
    const requestId = couponRequestRef.current + 1;
    couponRequestRef.current = requestId;
    const isStale = () => couponRequestRef.current !== requestId;
    setSellerCoupons({});
    setAppliedCoupons({});
    try {
      const token = getAuthToken();
      if (!token) {
        if (isStale()) return false;
        setSellerCoupons({});
        setAppliedCoupons({});
        return false;
      }
      const sellerIds = [...new Set(cartSnapshot.map((item) => String(
        item?.product?.seller?._id || item?.product?.seller || ''
      )).filter(Boolean))];
      const productIds = [...new Set(cartSnapshot.map((item) => String(item?.product?._id || '')).filter(Boolean))];
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/coupons/checkout-coupons`,
        { sellerIds, productIds },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (isStale()) return false;
      const availableCoupons = parseCheckoutCouponAvailabilityResponse(res.data, sellerIds);
      setSellerCoupons(availableCoupons);
      setAppliedCoupons(reconcileAppliedCheckoutCoupons(
        couponCandidates,
        cartSnapshot,
        availableCoupons,
      ));
      return true;
    } catch (error) {
      if (isStale()) return false;
      console.error('Error fetching coupons:', error);
      setSellerCoupons({});
      setAppliedCoupons({});
      return false;
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

  const applyCoupon = async (inputKey, productIds, sellerId) => {
    if (checkoutDisplayRatesUnavailable) {
      toast.info(checkoutHasUnsupportedMoney
        ? 'Checkout contains an unsupported currency and cannot apply coupons safely.'
        : 'Refresh live exchange rates before applying coupons to this cross-currency checkout.');
      return;
    }
    const code = couponInputs[inputKey]?.trim();
    if (!code) {
      toast.error('Please enter a coupon code');
      return;
    }
    setCouponLoading(prev => ({ ...prev, [inputKey]: true }));
    try {
      const token = getAuthToken();
      const res = await axios.post(`${import.meta.env.VITE_API_URL}api/coupons/validate`,
        { code, productIds, sellerId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.data?.valid !== true) throw new Error('Coupon terms could not be confirmed.');
      if (res.data.valid) {
        const coupon = parseValidatedCheckoutCouponResponse(res.data, {
          expectedSellerIds: [String(sellerId)],
          expectedProductIds: [...new Set(productIds.map(String))],
        });
        const couponNeedsRates = couponHasCurrencyAmount(coupon)
          && checkoutRequiresCurrencyConversion([couponCurrency(coupon)], currency);
        if (couponNeedsRates && (exchangeRatesLoading || exchangeRatesFallback)) {
          toast.info('This coupon uses another currency. Refresh live exchange rates before applying it.');
          return;
        }
        const claimedProductIds = new Set(
          Object.entries(appliedCoupons)
            .filter(([key]) => key !== inputKey)
            .flatMap(([, appliedCoupon]) => appliedCoupon?.applicableProductIds || [])
            .map(String)
        );
        const overlappingProductIds = (coupon.applicableProductIds || [])
          .map(String)
          .filter((productId) => claimedProductIds.has(productId));
        if (overlappingProductIds.length > 0) {
          toast.error('A product can only receive one coupon per order. Remove the overlapping coupon first.');
          return;
        }
        // Check min order amount for applicable products
        const applicableProductIds = new Set((coupon.applicableProductIds || []).map(String));
        const applicableItems = cartItems.cart.filter((item) => applicableProductIds.has(String(item.product?._id)));
        const applicableSubtotal = addCurrencyAmounts(...applicableItems.map((item) => (
          getCartLineTotal(item)
        )));
        const minOrderAmount = couponAmountInCheckoutCurrency(coupon.minOrderAmount, coupon);

        if (minOrderAmount > 0 && toCurrencyMinorUnits(applicableSubtotal) < toCurrencyMinorUnits(minOrderAmount)) {
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

  const couponPricing = calculateCheckoutCouponPricing({
    appliedCoupons,
    cartItems: cartItems?.cart || [],
    getItemLineTotal: (item) => getCartLineTotal(item),
    getItemKey: (item) => cartLineKey(item),
    convertCouponAmount: couponAmountInCheckoutCurrency,
    getCouponCurrency: couponCurrency,
    targetCurrency: currency,
    exchangeRates,
  });

  const getProductCouponDiscount = (item) => (
    couponPricing.lineDiscounts.get(cartLineKey(item)) || 0
  );
  const totalCouponDiscount = couponPricing.totalDiscount;

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

  const fetchShippingMethods = async (cartSnapshot = cartItems?.cart || []) => {
    const requestId = shippingRequestRef.current + 1;
    shippingRequestRef.current = requestId;
    const isStale = () => shippingRequestRef.current !== requestId;
    setShippingStatus('loading');
    setShippingError('');
    try {
      const expectedSellerIds = [...new Set(cartSnapshot.map((item) => {
        const seller = item?.product?.seller;
        return typeof seller?._id === 'string'
          ? seller._id
          : typeof seller === 'string'
            ? seller
            : '';
      }).filter(Boolean))];
      const cartItemsData = cartSnapshot.map(item => ({
        productId: item.product._id
      }));

      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/shipping/cart`,
        { cartItems: cartItemsData }
      );
      if (isStale()) return false;
      const shippingData = parseCheckoutShippingMethodsResponse(res.data, expectedSellerIds);
      setSellerShippingMethods(shippingData);
      setSelectedShippingPerSeller((previous) => (
        selectCheckoutShippingMethods(shippingData, previous)
      ));
      setShippingStatus('ready');
      return true;
    } catch (error) {
      if (isStale()) return false;
      console.error('Error fetching shipping methods:', error);
      setSellerShippingMethods({});
      setSelectedShippingPerSeller({});
      setShippingStatus('error');
      setShippingError(error?.response?.data?.msg || error.message || 'Delivery methods could not be confirmed.');
      toast.error('Failed to load shipping methods');
      return false;
    }
  };

  // Calculate tax based on subtotal
  const calculateTax = (subtotal) => {
    if (!taxConfig || taxConfig.type === 'none') return 0;

    if (taxConfig.type === 'percentage') {
      return percentageCurrencyAmount(subtotal, taxConfig.value);
    }

    if (taxConfig.type === 'fixed') {
      return convertAmount(taxConfig.value, taxConfig.currency, currency);
    }

    return 0;
  };


  const {
    register,
    handleSubmit,
    watch,
    trigger,
    setValue,
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
      // Persisted coupons remain only as inert candidates. The cart-identity
      // effect activates them after the availability endpoint confirms terms.
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
  const subtotal = cartItems?.cart
    ? addCurrencyAmounts(...cartLineTotals)
    : 0;

  // Keep seller order aligned with the cart/server. This order is also the
  // deterministic tie-breaker when a globally converted shipping total has a
  // remainder cent to allocate.
  const cartItemsBySeller = useMemo(() => {
    if (!cartItems?.cart) return {};
    const grouped = {};
    cartItems.cart.forEach((item) => {
      const rawSeller = item?.product?.seller;
      const sellerId = String(rawSeller?._id || rawSeller || '');
      if (!sellerId) return;
      if (!grouped[sellerId]) grouped[sellerId] = [];
      grouped[sellerId].push(item);
    });
    return grouped;
  }, [cartItems]);

  // Calculate tax and shipping
  const tax = calculateTax(subtotal);

  // The backend converts all foreign shipping fees as one exact amount and
  // then allocates target cents to sellers. Mirroring that allocation avoids
  // losing tiny fees (for example two PKR 1 fees that jointly become USD .01).
  const cartSellerIds = Object.keys(cartItemsBySeller);
  const selectedShippingEntries = cartSellerIds
    .map((sellerId) => {
      const selectedType = selectedShippingPerSeller[sellerId]?.type
        || selectedShippingPerSeller[sellerId]?.name;
      const method = sellerShippingMethods[sellerId]?.methods?.find((candidate) => (
        candidate.type === selectedType
      ));
      return method ? { sellerId, method } : null;
    })
    .filter(Boolean);
  const shippingLineAmounts = convertLineAmounts(selectedShippingEntries.map(({ sellerId, method }) => ({
    unitAmount: method.cost,
    quantity: 1,
    sourceCurrency: shippingMethodCurrency(method, sellerShippingMethods[sellerId]),
  })), currency);
  const shippingAmountBySeller = new Map(selectedShippingEntries.map((entry, index) => (
    [entry.sellerId, shippingLineAmounts[index]]
  )));
  const shippingCost = addCurrencyAmounts(...shippingLineAmounts);

  const totalAmount = Math.max(0, addCurrencyAmounts(subtotal, tax, shippingCost, -totalCouponDiscount));
  const checkoutSourceCurrencies = [
    ...(cartItems?.cart || []).map((item) => (
      hasCurrencyAmount(getEffectiveProductSourcePrice(item?.product))
        ? productCurrency(item?.product)
        : null
    )),
    ...selectedShippingEntries.map(({ method }) => (
      hasCurrencyAmount(method?.cost)
        ? shippingMethodCurrency(method)
        : null
    )),
    taxConfig?.type === 'fixed' && hasCurrencyAmount(taxConfig.value)
      ? taxConfig.currency
      : null,
    ...Object.values(appliedCoupons).map((coupon) => (
      couponHasCurrencyAmount(coupon) ? couponCurrency(coupon) : null
    )),
  ];
  const checkoutHasUnsupportedMoney = checkoutHasUnsupportedCurrency(checkoutSourceCurrencies);
  const checkoutDisplayNeedsExchangeRates = checkoutRequiresCurrencyConversion(checkoutSourceCurrencies, currency);
  const checkoutNeedsExchangeRates = checkoutRequiresTrustedRates(checkoutSourceCurrencies, currency);
  const checkoutRatesUnavailable = checkoutHasUnsupportedMoney
    || (checkoutNeedsExchangeRates && (exchangeRatesLoading || exchangeRatesFallback));
  const checkoutDisplayRatesUnavailable = checkoutHasUnsupportedMoney
    || (checkoutDisplayNeedsExchangeRates && (exchangeRatesLoading || exchangeRatesFallback));
  const checkoutMoney = (amount, options = {}) => {
    const { sourceCurrency = null, ...formatOptions } = options;
    const sourceRatesUnavailable = sourceCurrency
      ? checkoutHasUnsupportedCurrency([sourceCurrency])
        || (checkoutRequiresCurrencyConversion([sourceCurrency], currency)
          && (exchangeRatesLoading || exchangeRatesFallback))
      : checkoutDisplayRatesUnavailable;
    return `${sourceRatesUnavailable ? '≈' : ''}${currentMoney(amount, formatOptions)}`;
  };
  const taxUnavailable = taxStatus !== 'ready';
  const shippingReady = shippingStatus === 'ready'
    && cartSellerIds.length > 0
    && selectedShippingEntries.length === cartSellerIds.length;
  const checkoutBlocked = !isCartReady || taxUnavailable || !shippingReady || checkoutRatesUnavailable;
  const formatShippingOptionPrice = (method, sellerInfo = null) => {
    const sourceAmount = method.cost;
    const sourceCurrency = shippingMethodCurrency(method, sellerInfo);
    const targetAmount = shippingCostInCheckoutCurrency(method, sellerInfo);
    if (
      !checkoutHasUnsupportedCurrency([sourceCurrency])
      && isPositiveSourceAmountRoundedToZero(sourceAmount, targetAmount)
    ) {
      const nativeAmount = formatPrice(sourceAmount, {
        sourceCurrency,
        targetCurrency: sourceCurrency,
        showCode: true,
      });
      return `${nativeAmount} (<${currentMoney(0.01, { showCode: true })})`;
    }
    return checkoutMoney(targetAmount, { sourceCurrency });
  };
  const rawWalletBalance = wallet?.balances?.[currency];
  const walletBalance = typeof rawWalletBalance === 'number'
    && Number.isFinite(rawWalletBalance)
    && rawWalletBalance >= 0
    && toCurrencyMinorUnits(rawWalletBalance) / 100 === rawWalletBalance
    ? rawWalletBalance
    : null;
  const canPayWithWallet = Boolean(
    currentUser
    && wallet?.status === 'active'
    && walletBalance !== null
    && toCurrencyMinorUnits(walletBalance) >= toCurrencyMinorUnits(totalAmount)
  );
  const walletDisabledReason = !currentUser
    ? 'Log in to use Rozare Wallet.'
    : wallet?.status && wallet.status !== 'active'
      ? 'Your Rozare Wallet is locked.'
      : walletBalance === null
        ? 'Your wallet balance could not be verified. Refresh it before paying.'
        : `Balance: ${currentMoney(walletBalance)}. Add funds from your Wallet page.`;

  const codRestrictedSellers = useMemo(() => (
    Object.entries(sellerShippingMethods)
      .filter(([, sellerData]) => sellerData?.allowsCashOnDelivery === false)
      .map(([, sellerData]) => sellerData?.store?.storeName || sellerData?.seller?.username || 'A seller')
  ), [sellerShippingMethods]);
  const isCashOnDeliveryAvailable = codRestrictedSellers.length === 0;
  const codRestrictionText = codRestrictedSellers.length > 0
    ? `Cash on Delivery is unavailable because ${codRestrictedSellers.join(', ')} ${codRestrictedSellers.length === 1 ? 'accepts' : 'accept'} online payment only.`
    : '';

  useEffect(() => {
    if (!isCashOnDeliveryAvailable && paymentMethod === 'cash_on_delivery') {
      setValue('paymentMethod', 'stripe', { shouldDirty: true, shouldValidate: true });
    }
  }, [isCashOnDeliveryAvailable, paymentMethod, setValue]);

  useEffect(() => {
    if (paymentMethod === 'wallet' && !canPayWithWallet) {
      setValue('paymentMethod', 'stripe', { shouldDirty: true, shouldValidate: true });
    }
  }, [canPayWithWallet, paymentMethod, setValue]);

  // Next step with validation
  const nextStep = async () => {
    if (!isCartReady) {
      toast.info(cartHydrationStatus === 'error'
        ? 'Retry cart synchronization before continuing.'
        : 'Wait while your saved cart is synchronized.');
      return;
    }
    if (couponPricing.error) {
      toast.error(couponPricing.error);
      return;
    }
    if (taxUnavailable) {
      toast.error(taxStatus === 'loading'
        ? 'Wait while tax is confirmed.'
        : 'Tax could not be confirmed. Retry tax before continuing.');
      return;
    }
    if (checkoutRatesUnavailable) {
      toast.error(checkoutHasUnsupportedMoney
        ? 'Checkout contains an unsupported currency. Refresh the cart or contact support.'
        : 'Live exchange rates are required to lock checkout settlement amounts.');
      return;
    }
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
      const hasAllShippingSelected = shippingReady;

      if (!hasAllShippingSelected) {
        toast.error("Please select a shipping method for all sellers");
        return;
      }

      trackInitiateCheckout(cartItems?.cart || [], totalAmount, currency, cartLineTotals);
      setCurrentStep((p) => p + 1);
      return;
    }


  };

  const prevStep = () => {
    if (currentStep > 0) setCurrentStep((p) => p - 1);
  };

  // Final form submit
  const onPlaceOrder = async (data) => {
    if (!isCartReady) {
      toast.error(cartHydrationStatus === 'error'
        ? 'Your cart could not be verified. Retry synchronization before placing the order.'
        : 'Your saved cart is still being synchronized. Please wait.');
      return;
    }
    const token = getAuthToken();
    if (!currentUser || !token) {
      try {
        sessionStorage.setItem(
          CHECKOUT_STORAGE_KEY,
          JSON.stringify({
            currentStep,
            formValues: data,
            selectedShippingPerSeller,
            appliedCoupons,
          })
        );
      } catch (_) {}
      rememberPostAuthRedirect('/checkout');
      toast.info('Sign in to place your order. Your checkout details have been saved.');
      navigate('/login?redirect=%2Fcheckout');
      return;
    }

    if (couponPricing.error) {
      toast.error(couponPricing.error);
      return;
    }

    if (taxUnavailable) {
      toast.error(taxStatus === 'loading'
        ? 'Wait while tax is confirmed.'
        : 'Tax could not be confirmed. Retry tax before placing the order.');
      return;
    }

    if (checkoutRatesUnavailable) {
      toast.error(checkoutHasUnsupportedMoney
        ? 'Checkout contains an unsupported currency and cannot be priced safely.'
        : 'Live exchange rates are required to lock the order and its USD settlement snapshot.');
      return;
    }

    // Rendered totals may use the retained rate table so the checkout can show
    // an honest estimate during an outage. Re-assert the trusted-rate contract
    // at the money-action boundary before any order payload is constructed.
    try {
      if (String(currency).toUpperCase() !== 'USD') {
        convertAmountForMoneyAction(0, currency, 'USD');
      }
      checkoutSourceCurrencies
        .filter(Boolean)
        .forEach((sourceCurrency) => convertAmountForMoneyAction(0, sourceCurrency, currency));
    } catch {
      toast.error('Live exchange rates changed while checkout was open. Refresh rates and try again.');
      return;
    }

    if (data.paymentMethod === 'cash_on_delivery' && !isCashOnDeliveryAvailable) {
      toast.error(`${codRestrictionText} Please pay by card or Rozare Wallet, or remove those items.`);
      return;
    }
    if (data.paymentMethod === 'wallet' && !canPayWithWallet) {
      toast.error(walletDisabledReason);
      return;
    }
    // Validate shipping method is selected for all sellers
    const hasAllShippingSelected = shippingReady;

    if (!hasAllShippingSelected) {
      toast.error("Please select a shipping method for all sellers");
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true);

    // Build seller shipping array
    const sellerShipping = selectedShippingEntries.map(({ sellerId, method }, index) => ({
      seller: sellerId,
      shippingMethod: {
        name: method.type,
        price: shippingLineAmounts[index],
        estimatedDays: method.deliveryDays
      }
    }));

    // Use first seller's shipping as primary (for backward compatibility)
    const primaryShipping = sellerShipping[0].shippingMethod;

    const tiktokPlaceOrderEventId = createTikTokEventId('place_order');
    const tiktokPurchaseEventId = createTikTokEventId('purchase');

    const order = {
      orderItems: cartItems.cart.map((item) => {
        const sourcePrice = getEffectiveProductSourcePrice(item.product);
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
        data.paymentMethod === 'wallet'
          ? 'wallet'
          : data.paymentMethod === "stripe"
            ? "stripe"
            : "cash_on_delivery",

      tracking: {
        ...getTikTokTrackingContext(),
        tiktokPlaceOrderEventId,
        tiktokPurchaseEventId,
      },
    };


    if (data.instructions !== '') order.instructions = data.instructions

    let fingerprint = '';
    let attemptKey = '';
    try {
      const intentFingerprint = createCheckoutFingerprint(order, 'checkout_session', 'web');
      const actorId = String(currentUser?._id || currentUser?.id || 'guest');
      fingerprint = `${actorId}:${intentFingerprint}`;
      const attempt = await getOrCreatePersistedMutationAttemptInLedger({
        storage: localStorage,
        storageKey: checkoutAttemptStorageKey,
        fingerprint,
        keyPrefix: 'web-checkout',
      });
      attemptKey = attempt.key;
      order.idempotencyKey = attempt.key;

      const headers = {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': attempt.key,
      };
      const res = await axios.post(
        `${import.meta.env.VITE_API_URL}api/order/place`,
        { order, paymentFlow: 'checkout_session', clientSurface: 'web' },
        { headers }
      );
      const authoritativeEventCurrency = res.data?.order?.currency || currency;
      const authoritativeEventTotal = res.data?.order?.totalAmount ?? totalAmount;

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
      }

      if (['cash_on_delivery', 'wallet'].includes(order.paymentMethod)) {
        const confirmedOrderId = res.data.orderId || res.data.order?.orderId;
        const successAuthenticated = rememberConfirmedOrder(
          confirmedOrderId,
          order.paymentMethod,
          {
            noPaymentRequired: res.data?.noPaymentRequired === true,
            attemptStorageKey: checkoutAttemptStorageKey,
            attemptFingerprint: fingerprint,
            attemptKey,
          },
        );
        setIsProcessing(false);
        trackPlaceAnOrder({
          orderId: res.data.order?.orderId || res.data.order?._id,
          cartItems: cartItems?.cart || [],
          lineTotals: cartLineTotals,
          totalAmount: authoritativeEventTotal,
          currency: authoritativeEventCurrency,
          eventId: tiktokPlaceOrderEventId,
        });

        if (!successAuthenticated) {
          // The order already reached the server, so its durable retry key must
          // remain replayable. Never trust query parameters as proof of COD or
          // Wallet success when the same-tab confirmation record was not
          // durably written and read back.
          toast.warning(
            'Your order was placed, but this tab could not save its secure confirmation. Open My Orders to view it safely.',
            { autoClose: 9000 },
          );
          if (token) await fetchCart().catch(error => console.error('Error refreshing cart:', error));
          navigate('/user-dashboard/orders', { replace: true });
          return;
        }

        if (hasChanged && currentUser) {
          setPendingOrderData({ order, data: res.data, currentShipping });
          setShowUpdatePrompt(true);
          return;
        }

        setTimeout(async () => {
          if (token) await fetchCart().catch(error => console.error('Error refreshing cart:', error));
          try { sessionStorage.removeItem(CHECKOUT_STORAGE_KEY); } catch (_) {}
          navigate(`/success?payment=${order.paymentMethod}&orderId=${encodeURIComponent(confirmedOrderId || '')}`);
        }, 1500);
        return;
      }

      if (res.data?.noPaymentRequired !== true) {
        trackAddPaymentInfo({
          cartItems: cartItems?.cart || [],
          lineTotals: cartLineTotals,
          totalAmount: authoritativeEventTotal,
          currency: authoritativeEventCurrency,
        });
      }
      trackPlaceAnOrder({
        orderId: res.data.order?.orderId,
        cartItems: cartItems?.cart || [],
        lineTotals: cartLineTotals,
        totalAmount: authoritativeEventTotal,
        currency: authoritativeEventCurrency,
        eventId: tiktokPlaceOrderEventId,
      });

      if (res.data?.isPaid === true && res.data?.orderId) {
        if (
          res.data.noPaymentRequired === true
          && rememberConfirmedOrder(res.data.orderId, 'stripe', {
            noPaymentRequired: true,
            attemptStorageKey: checkoutAttemptStorageKey,
            attemptFingerprint: fingerprint,
            attemptKey,
          })
        ) {
          navigate(`/success?payment=stripe&orderId=${encodeURIComponent(res.data.orderId)}`, { replace: true });
        } else if (rememberStripeCheckoutReturn(
          res.data.orderId,
          res.data.id,
          checkoutAttemptStorageKey,
          fingerprint,
          attemptKey,
        )) {
          navigate(`/success?orderId=${encodeURIComponent(res.data.orderId)}`, { replace: true });
        } else {
          toast.warning(
            'Payment is complete, but this tab could not save its secure confirmation. Open My Orders to view it safely.',
            { autoClose: 9000 },
          );
          navigate('/user-dashboard/orders', { replace: true });
        }
        return;
      }

      if (!res.data?.url) {
        throw new Error('Stripe did not return a secure checkout URL. Please try again.');
      }
      const stripeOrderId = res.data.orderId || res.data.order?.orderId;
      if (!rememberStripeCheckoutReturn(
        stripeOrderId,
        res.data.id,
        checkoutAttemptStorageKey,
        fingerprint,
        attemptKey,
      )) {
        // The Stripe session is recoverable with this same backend key. Do not
        // open it unless the return page can authenticate the exact order and
        // clear only this exact durable attempt after signed verification.
        setIsProcessing(false);
        toast.error(
          'Secure payment could not start because this tab cannot save its payment return. Enable site storage, then try again.',
          { autoClose: 9000 },
        );
        return;
      }
      window.location.assign(res.data.url);


    } catch (error) {
      if (isCheckoutRepriceRequired(error)) {
        if (fingerprint && attemptKey) {
          await clearPersistedMutationAttemptFromLedger(
            localStorage,
            checkoutAttemptStorageKey,
            fingerprint,
            attemptKey,
          );
        }
        await Promise.allSettled([
          Promise.resolve().then(() => fetchCart()),
          Promise.resolve().then(() => fetchTaxConfig()),
          Promise.resolve().then(() => refreshExchangeRates()),
          Promise.resolve().then(() => fetchShippingMethods()),
          Promise.resolve().then(() => fetchAvailableCoupons()),
        ]);
        setIsProcessing(false);
        toast.warning(
          error.response?.data?.msg
            ? `${error.response.data.msg} We refreshed checkout details. Review the new total and press the payment button again.`
            : 'Checkout pricing changed. We refreshed checkout details. Review the new total and press the payment button again.',
          { autoClose: 9000 },
        );
        return;
      }
      if (!shouldRetainIdempotencyKey(error.response?.status)) {
        if (fingerprint && attemptKey) {
          await clearPersistedMutationAttemptFromLedger(
            localStorage,
            checkoutAttemptStorageKey,
            fingerprint,
            attemptKey,
          );
        }
      }
      if (error.response?.status === 401 || error.response?.status === 403) {
        try {
          sessionStorage.setItem(
            CHECKOUT_STORAGE_KEY,
            JSON.stringify({
              currentStep,
              formValues: data,
              selectedShippingPerSeller,
              appliedCoupons,
            })
          );
        } catch (_) {}
        rememberPostAuthRedirect('/checkout');
        toast.info('Please sign in again to finish your order. Your checkout details are saved.');
        navigate('/login?redirect=%2Fcheckout');
        return;
      }
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

            {!isCartReady && (
              <div className="mb-6 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert" aria-live="polite"
                style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.24)' }}>
                <div className="flex-1">
                  <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                    {cartHydrationStatus === 'error' ? 'Cart synchronization required' : 'Preparing your saved cart'}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {cartHydrationError || 'Rozare is merging saved guest items and fetching the authoritative cart before checkout.'}
                  </p>
                </div>
                <button type="button" onClick={retryCartHydration} disabled={isCartLoading}
                  className="px-3 py-2 rounded-xl glass-inner text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
                  <Loader2 size={14} className={isCartLoading ? 'animate-spin' : ''} /> Retry cart sync
                </button>
              </div>
            )}

            {checkoutRatesUnavailable && (
              <div className="mb-6 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert" aria-live="polite"
                style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.24)' }}>
                <div className="flex-1">
                  <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>{checkoutHasUnsupportedMoney ? 'Unsupported checkout currency' : 'Live exchange rates required'}</p>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {checkoutHasUnsupportedMoney
                      ? 'One or more cart, delivery, tax, or coupon amounts use a currency this checkout does not support.'
                      : checkoutDisplayRatesUnavailable
                        ? exchangeRatesLoading
                          ? 'Refreshing rates. Converted values marked with ≈ are estimates and checkout is paused.'
                          : 'Only fallback rates are available. Converted values marked with ≈ are estimates; retry before paying.'
                        : `Amounts already in ${currency} remain exact. Checkout is paused until a live rate can freeze the USD settlement snapshot.`}
                  </p>
                </div>
                <button type="button" onClick={refreshExchangeRates} disabled={exchangeRatesLoading || checkoutHasUnsupportedMoney}
                  className="px-3 py-2 rounded-xl glass-inner text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
                  <Loader2 size={14} className={exchangeRatesLoading ? 'animate-spin' : ''} /> Retry rates
                </button>
              </div>
            )}
            {taxUnavailable && (
              <div className="mb-6 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3" role="alert" aria-live="polite"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)' }}>
                <div className="flex-1">
                  <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>
                    {taxStatus === 'loading' ? 'Confirming tax' : 'Tax unavailable'}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    {taxStatus === 'loading'
                      ? 'Checkout is paused until the current tax configuration is confirmed.'
                      : `${taxError || 'Tax could not be confirmed.'} Retry before placing the order.`}
                  </p>
                </div>
                <button type="button" onClick={fetchTaxConfig} disabled={taxStatus === 'loading'}
                  className="px-3 py-2 rounded-xl glass-inner text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60">
                  <Loader2 size={14} className={taxStatus === 'loading' ? 'animate-spin' : ''} /> Retry tax
                </button>
              </div>
            )}

            {!!couponPricing.error && (
              <div className="mb-6 rounded-2xl p-4" role="alert" aria-live="polite"
                style={{ background: 'rgba(239,68,68,0.09)', border: '1px solid rgba(239,68,68,0.24)' }}>
                <p className="text-sm font-bold" style={{ color: 'hsl(var(--foreground))' }}>Coupon needs attention</p>
                <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                  {couponPricing.error} Remove or replace the coupon to continue.
                </p>
              </div>
            )}

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
                                  const itemLineTotal = getCartLineTotal(item);
                                  const exactUnitAmount = getExactLineUnitAmount(itemLineTotal, qty);
                                  const productCouponDiscount = getProductCouponDiscount(item);
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
                                              <span className="font-bold text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                                                {exactUnitAmount === null
                                                  ? `Complete line: ${checkoutMoney(itemLineTotal, { sourceCurrency: itemSourceCurrency })}`
                                                  : checkoutMoney(exactUnitAmount, { sourceCurrency: itemSourceCurrency })}
                                              </span>
                                              {productCouponDiscount > 0 && (
                                                <span className="ml-2 text-xs font-semibold" style={{ color: 'hsl(150, 60%, 45%)' }}>
                                                  -{checkoutMoney(productCouponDiscount)} coupon
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
                                          onApply={() => applyCoupon(productKey, [_id], sellerId)}
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
                                    onApply={() => applyCoupon(groupKey, sellerItems.map(i => i.product._id), sellerId)}
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

                            {shippingStatus === 'error' ? (
                              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                                <p>{shippingError || 'Delivery methods could not be confirmed.'}</p>
                                <button
                                  type="button"
                                  onClick={() => fetchShippingMethods(cartItems?.cart || [])}
                                  className="mt-3 rounded-md bg-red-600 px-3 py-2 font-medium text-white disabled:opacity-50"
                                  disabled={shippingStatus === 'loading'}
                                >
                                  Retry delivery options
                                </button>
                              </div>
                            ) : Object.keys(sellerShippingMethods).length === 0 ? (
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
                                {Object.entries(sellerShippingMethods).map(([sellerId, sellerData]) => {
                                  const { seller, methods } = sellerData;
                                  const sellerProducts = cartItemsBySeller[sellerId] || [];
                                  const isExpanded = expandedSellers[sellerId] === true; // Default to collapsed
                                  const storeName = getCheckoutSellerDisplayName(sellerData);

                                  return (
                                    <div key={sellerId} className="border border-gray-200 rounded-lg p-4 bg-gray-50">
                                      <div className="flex items-center gap-3 mb-3 pb-3 border-b border-gray-200">
                                        <StoreAvatar
                                          logo={getCheckoutSellerLogo(sellerData)}
                                          storeName={storeName}
                                        />
                                        <div className="min-w-0">
                                          <p className="font-semibold text-sm text-gray-900 truncate">{storeName}</p>
                                          <p className="text-xs text-gray-500">
                                            {sellerProducts.length} {sellerProducts.length === 1 ? 'item' : 'items'} in this shipment
                                          </p>
                                        </div>
                                      </div>
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
                                                      Total: {checkoutMoney(addCurrencyAmounts(...sellerProducts.map((item) => (
                                                        getCartLineTotal(item)
                                                      ))))}
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
                                                          <span className="font-semibold text-sm">{checkoutMoney(getCartLineTotal(item), { sourceCurrency: productCurrency(item.product) })}</span>
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
                                              {formatShippingOptionPrice(method, { seller })}
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

                    {!isCashOnDeliveryAvailable && (
                      <div className="rounded-xl p-4 mb-5" style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.22)' }}>
                        <p className="text-sm font-semibold" style={{ color: 'hsl(220, 70%, 45%)' }}>Advance payment required</p>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          {codRestrictionText} This checkout must be paid by card or Rozare Wallet.
                        </p>
                      </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                      <PaymentOption
                        value="stripe"
                        title="Credit/Debit Card"
                        description="Pay securely with Stripe"
                        icon={<CreditCardIcon className="w-6 h-6" />}
                        selected={paymentMethod === "stripe"}
                        {...register("paymentMethod")}
                      />
                      <PaymentOption
                        value="wallet"
                        title="Rozare Wallet"
                        description={walletLoading
                          ? 'Checking balance...'
                          : walletBalance === null
                            ? 'Balance unavailable'
                            : `Balance ${currentMoney(walletBalance)}`}
                        icon={<WalletCards className="w-6 h-6" />}
                        selected={paymentMethod === "wallet"}
                        disabled={!canPayWithWallet}
                        disabledReason={walletDisabledReason}
                        {...register("paymentMethod")}
                      />
                      <PaymentOption
                        value="cash_on_delivery"
                        title="Cash on Delivery"
                        description="Pay when you receive your order"
                        icon={<DollarSign className="w-6 h-6" />}
                        selected={paymentMethod === "cash_on_delivery"}
                        disabled={!isCashOnDeliveryAvailable}
                        disabledReason={codRestrictionText}
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
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold" style={{ color: 'hsl(220, 70%, 55%)' }}>
                              Continue to Stripe's secure checkout.
                            </p>
                            <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
                              Choose a saved card or securely save a new card for purchases and wallet top-ups you initiate.
                            </p>
                          </div>
                          {currentUser && (
                            <button
                              type="button"
                              onClick={() => navigate('/user-dashboard/payment-methods')}
                              className="glass-button rounded-xl px-3 py-2 text-xs font-semibold whitespace-nowrap"
                            >
                              Manage saved cards
                            </button>
                          )}
                        </div>
                      </motion.div>
                    )}

                    {paymentMethod === 'wallet' && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="glass-inner p-4 rounded-xl mb-6">
                        <p className="text-sm font-semibold" style={{ color: 'hsl(150, 60%, 38%)' }}>Your wallet will be debited immediately after stock is verified.</p>
                        <p className="text-xs mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>This order uses {checkoutMoney(totalAmount)} from your {currency} wallet balance.</p>
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
                    disabled={isSubmitting || isProcessing || checkoutBlocked || !!couponPricing.error || !cartItems?.cart || cartItems.cart.length == 0}
                    className="px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:-translate-y-0.5 flex items-center gap-2 text-sm sm:text-base glow-soft"
                    style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))', color: 'white' }}
                  >
                    {isProcessing ? (
                      <>
                        <div className="w-4 h-4 sm:w-5 sm:h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Processing...
                      </>
                    ) : !currentUser ? (
                      <>
                        <User className="w-4 h-4 sm:w-5 sm:h-5" />
                        Sign In to Place Order
                      </>
                    ) : paymentMethod === "cash_on_delivery" ? (
                      <>
                        <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                        Place Order
                      </>
                    ) : paymentMethod === 'wallet' ? (
                      <>
                        <WalletCards className="w-4 h-4 sm:w-5 sm:h-5" />
                        Pay with Wallet
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
                    disabled={checkoutBlocked || !!couponPricing.error || !cartItems?.cart || cartItems.cart.length == 0}
                    className={`px-4 sm:px-6 py-2.5 sm:py-3 rounded-xl font-medium flex items-center gap-2 text-sm sm:text-base transition-all ${checkoutBlocked || !!couponPricing.error || !cartItems?.cart || cartItems.cart.length === 0
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:-translate-y-0.5 glow-soft"
                      }`}
                    style={{
                      background: checkoutBlocked || !!couponPricing.error || !cartItems?.cart || cartItems.cart.length === 0 ? 'hsl(var(--muted))' : 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(260, 60%, 60%))',
                      color: checkoutBlocked || !!couponPricing.error || !cartItems?.cart || cartItems.cart.length === 0 ? 'hsl(var(--muted-foreground))' : 'white',
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
                        <span className="font-semibold">{checkoutMoney(getCartLineTotal(item), { sourceCurrency: productCurrency(item.product) })}</span>
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
                  <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{checkoutMoney(subtotal)}</span>
                </div>

                {Object.keys(selectedShippingPerSeller).length > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-sm font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>
                      <span>Shipping</span>
                      <span style={{ color: 'hsl(var(--foreground))' }}>{checkoutMoney(shippingCost)}</span>
                    </div>
                    {selectedShippingEntries.map(({ sellerId, method }) => {
                      const sellerInfo = sellerShippingMethods[sellerId];
                      return (
                        <div key={sellerId} className="flex justify-between text-xs pl-4" style={{ color: 'hsl(var(--muted-foreground))' }}>
                          <span>{getShippingMethodTitle(method)}</span>
                          <span>{checkoutMoney(shippingAmountBySeller.get(sellerId), { sourceCurrency: shippingMethodCurrency(method, sellerInfo) })}</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {tax > 0 && (
                  <div className="flex justify-between text-sm" style={{ color: 'hsl(var(--muted-foreground))' }}>
                    <span>Tax {taxConfig?.type === 'percentage' && `(${taxConfig.value}%)`}</span>
                    <span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{checkoutMoney(tax)}</span>
                  </div>
                )}

                {totalCouponDiscount > 0 && (
                  <div className="flex justify-between text-sm" style={{ color: 'hsl(150, 60%, 45%)' }}>
                    <span className="flex items-center gap-1"><Ticket size={14} /> Coupon Discount</span>
                    <span className="font-semibold">-{checkoutMoney(totalCouponDiscount)}</span>
                  </div>
                )}

                <div className="flex justify-between text-base sm:text-lg font-semibold pt-3" style={{ borderTop: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
                  <span>Total</span>
                  <span style={{ color: 'hsl(220, 70%, 55%)' }}>{checkoutMoney(totalAmount)}</span>
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
                      if (['cash_on_delivery', 'wallet'].includes(pendingOrderData.order?.paymentMethod)) {
                        fetchCart().catch(() => {});
                        try { sessionStorage.removeItem(CHECKOUT_STORAGE_KEY); } catch (_) {}
                        navigate(`/success?payment=${pendingOrderData.order.paymentMethod}&orderId=${encodeURIComponent(pendingOrderData.data?.orderId || '')}`);
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
                    if (['cash_on_delivery', 'wallet'].includes(pendingOrderData?.order?.paymentMethod)) {
                      fetchCart().catch(() => {});
                      try { sessionStorage.removeItem(CHECKOUT_STORAGE_KEY); } catch (_) {}
                      navigate(`/success?payment=${pendingOrderData.order.paymentMethod}&orderId=${encodeURIComponent(pendingOrderData.data?.orderId || '')}`);
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

const ShippingOption = React.forwardRef(({ value, title, price, days, selected, formatPrice: formatShippingPrice = () => 'Currency unavailable', ...props }, ref) => (
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

const PaymentOption = React.forwardRef(({ value, title, description, icon, selected, disabled, disabledReason, ...props }, ref) => (
  <label className={`glass-inner rounded-xl p-4 transition-all ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} ${selected ? "ring-2" : disabled ? "" : "hover:bg-white/10"}`}
    style={{ ringColor: selected ? 'hsl(220, 70%, 55%)' : undefined }}>
    <input
      type="radio"
      value={value}
      ref={ref}
      className="sr-only"
      disabled={disabled}
      {...props}
    />
    <div className="flex items-start gap-3">
      <div className="p-2 rounded-full" style={{ background: selected ? 'hsla(220, 70%, 55%, 0.15)' : 'hsl(var(--muted))', color: selected ? 'hsl(220, 70%, 55%)' : 'hsl(var(--muted-foreground))' }}>
        {icon}
      </div>
      <div>
        <h4 className="font-medium text-sm sm:text-base" style={{ color: 'hsl(var(--foreground))' }}>{title}</h4>
        <p className="text-xs sm:text-sm mt-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>{description}</p>
        {disabled && disabledReason && (
          <p className="text-[11px] mt-1" style={{ color: 'hsl(30, 90%, 45%)' }}>{disabledReason}</p>
        )}
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
