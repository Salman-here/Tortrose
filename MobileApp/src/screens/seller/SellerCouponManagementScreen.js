import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../../utils/feedback';
import api, { API_ENDPOINTS } from '../../config/api';
import { fetchCompleteSellerCatalog } from '../../utils/sellerCatalog';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import CouponBarChart, { MetricRow } from '../../components/common/CouponBarChart';
import {
  SellerEmptyState,
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { borderRadius, fontSize, fontWeight, shadows, spacing, typography } from '../../styles/theme';
import {
  couponAnalyticsResponseIsValid,
  canonicalCouponObjectId,
  fetchCompleteSellerCoupons,
  inspectCouponPresentation,
  inspectCouponProductCurrencyState,
  isExactCouponMoneyInput,
  isExactCouponPercentageInput,
  isPositiveCouponCountInput,
} from '../../utils/couponSafety';

const FILTERS = ['all', 'active', 'scheduled', 'paused', 'expired'];
const SUPPORTED_STORE_CURRENCIES = new Set(['USD', 'PKR', 'EUR', 'GBP']);

export const normalizeCouponCurrency = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  return SUPPORTED_STORE_CURRENCIES.has(normalized) ? normalized : null;
};

const toDateInput = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
};

const parseDateInput = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || toDateInput(parsed) !== value ? null : parsed;
};

export const normalizeCouponProductIds = (values) => (
  Array.isArray(values)
    ? [...new Set(values
      .map(value => (typeof value === 'string' ? value : value?._id))
      .filter(canonicalCouponObjectId))]
    : []
);

const rawCouponProductIds = values => (
  Array.isArray(values)
    ? values.map(value => (typeof value === 'string' ? value : value?._id))
    : []
);

export const createCouponForm = (currency = null) => ({
  code: '',
  discountType: 'percentage',
  discountValue: '',
  currency,
  applicableTo: 'all',
  applicableProducts: [],
  maxUses: '',
  maxUsesPerUser: '1',
  minOrderAmount: '',
  maxDiscountAmount: '',
  startDate: toDateInput(),
  expiryDate: '',
  description: '',
});

export const validateCouponForm = (form, now = new Date(), { availableProductIds = null } = {}) => {
  const errors = {};
  const rawCode = String(form.code || '').trim().toUpperCase();
  const normalizedCode = rawCode.replace(/[^A-Z0-9_-]/g, '');
  const startsAt = parseDateInput(form.startDate);
  const expiresAt = parseDateInput(form.expiryDate);
  const formCurrency = normalizeCouponCurrency(form.currency);

  if (
    normalizedCode.length < 3
    || normalizedCode.length > 32
    || normalizedCode !== rawCode
  ) errors.code = 'Use 3-32 letters or numbers.';
  if (!formCurrency || form.currency !== formCurrency) errors.currency = 'Coupon currency is unavailable.';
  if (!['percentage', 'fixed'].includes(form.discountType)) {
    errors.discountType = 'Choose a percentage or fixed discount.';
  } else if (form.discountType === 'percentage') {
    if (!isExactCouponPercentageInput(form.discountValue)) {
      errors.discountValue = 'Percentage discounts must be at least 0.01%, at most 100%, and use no more than 6 decimal places.';
    }
  } else if (!isExactCouponMoneyInput(form.discountValue)) {
    errors.discountValue = 'Use an amount of at least 0.01 with at most 2 decimal places.';
  }
  if (!isPositiveCouponCountInput(form.maxUses, { allowEmpty: true })) errors.maxUses = 'Use a whole number greater than zero.';
  if (!isPositiveCouponCountInput(form.maxUsesPerUser)) errors.maxUsesPerUser = 'Use a whole number greater than zero.';
  if (!isExactCouponMoneyInput(form.minOrderAmount, { allowZero: true, allowEmpty: true })) {
    errors.minOrderAmount = 'Use zero or a positive amount with at most 2 decimal places.';
  }
  if (!isExactCouponMoneyInput(form.maxDiscountAmount, { allowEmpty: true })) {
    errors.maxDiscountAmount = 'Use an amount of at least 0.01 with at most 2 decimal places.';
  }
  if (!startsAt) errors.startDate = 'Use YYYY-MM-DD.';
  if (!expiresAt) errors.expiryDate = 'Use YYYY-MM-DD.';
  if (expiresAt && expiresAt.getTime() <= now.getTime()) errors.expiryDate = 'Expiry must be in the future.';
  if (startsAt && expiresAt && startsAt.getTime() >= expiresAt.getTime()) errors.expiryDate = 'Expiry must be after the start date.';
  if (!['all', 'selected'].includes(form.applicableTo)) {
    errors.applicableTo = 'Choose all products or selected products.';
  } else if (form.applicableTo === 'selected') {
    const rawProductIds = rawCouponProductIds(form.applicableProducts);
    const productIds = normalizeCouponProductIds(form.applicableProducts);
    const available = availableProductIds === null ? null : new Set(availableProductIds);
    if (
      productIds.length === 0
      || rawProductIds.length !== productIds.length
      || (available && productIds.some(id => !available.has(id)))
    ) errors.applicableProducts = 'Choose only verified products from your complete catalog.';
  }
  return errors;
};

export const buildCouponPayload = (form) => ({
  code: String(form.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
  discountType: form.discountType,
  discountValue: Number(form.discountValue),
  currency: form.currency,
  applicableTo: form.applicableTo,
  applicableProducts: form.applicableTo === 'selected'
    ? normalizeCouponProductIds(form.applicableProducts)
    : [],
  maxUses: form.maxUses === '' ? null : Number(form.maxUses),
  maxUsesPerUser: Number(form.maxUsesPerUser),
  minOrderAmount: form.minOrderAmount === '' ? 0 : Number(form.minOrderAmount),
  maxDiscountAmount: form.maxDiscountAmount === '' ? null : Number(form.maxDiscountAmount),
  startDate: form.startDate,
  expiryDate: form.expiryDate,
  description: String(form.description || '').trim(),
});

export const getCouponStatus = (coupon, now = new Date()) => {
  const startDate = new Date(coupon?.startDate);
  const expiryDate = new Date(coupon?.expiryDate);
  if (
    typeof coupon?.isActive !== 'boolean'
    || typeof coupon?.startDate !== 'string'
    || typeof coupon?.expiryDate !== 'string'
    || !(now instanceof Date)
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(startDate.getTime())
    || !Number.isFinite(expiryDate.getTime())
    || expiryDate <= startDate
  ) return null;
  if (now > expiryDate) return 'expired';
  if (now < startDate) return 'scheduled';
  return coupon.isActive ? 'active' : 'paused';
};

export const loadVerifiedCouponProductState = async (apiClient = api) => {
  const [products, response] = await Promise.all([
    fetchCompleteSellerCatalog(apiClient),
    apiClient.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY),
  ]);
  const inspected = inspectCouponProductCurrencyState(response?.data?.productCurrency, products);
  if (!inspected.valid) {
    const pending = response?.data?.productCurrency?.status === 'pending_conversion';
    throw new Error(pending
      ? 'Finish or cancel the pending product currency change before managing coupons.'
      : 'Your store product currency and complete product catalog could not be verified.');
  }
  return inspected;
};

const statusPresentation = (status, palette) => ({
  active: { label: 'Active', icon: 'checkmark-circle', color: palette.colors.success },
  scheduled: { label: 'Scheduled', icon: 'calendar', color: palette.colors.info },
  paused: { label: 'Paused', icon: 'pause-circle', color: palette.colors.warning },
  expired: { label: 'Expired', icon: 'time', color: palette.colors.error },
}[status]);

export default function SellerCouponManagementScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currency, formatPrice } = useCurrency();
  const hasLoaded = useRef(false);
  const fetchRequestRef = useRef(0);

  const [coupons, setCoupons] = useState([]);
  const [products, setProducts] = useState([]);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [accessRestricted, setAccessRestricted] = useState(false);
  const [productError, setProductError] = useState('');
  const [storeCurrency, setStoreCurrency] = useState(null);
  const [verifiedProductCurrencyState, setVerifiedProductCurrencyState] = useState(null);
  const [productCurrencyError, setProductCurrencyError] = useState('');
  const [analyticsError, setAnalyticsError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('manage');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState(() => createCouponForm(null));
  const [formErrors, setFormErrors] = useState({});

  const fetchAll = useCallback(async ({ refresh = false } = {}) => {
    const requestId = fetchRequestRef.current + 1;
    fetchRequestRef.current = requestId;
    if (refresh) setRefreshing(true);
    else if (!hasLoaded.current) setInitialLoading(true);
    setAnalyticsData(null);
    setAnalyticsError('');

    const [couponResult, productResult, analyticsResult, productCurrencyResult] = await Promise.allSettled([
      fetchCompleteSellerCoupons(api),
      fetchCompleteSellerCatalog(api),
      api.get(`/api/coupons/analytics?currency=${encodeURIComponent(currency)}`),
      api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY),
    ]);
    if (fetchRequestRef.current !== requestId) return;

    let verifiedCoupons = null;
    if (couponResult.status === 'fulfilled') {
      verifiedCoupons = couponResult.value;
      setCoupons(verifiedCoupons);
      setLoadError('');
      setAccessRestricted(false);
    } else {
      setCoupons([]);
      setAccessRestricted(couponResult.reason?.response?.status === 403);
      setLoadError(couponResult.reason?.response?.data?.msg || couponResult.reason?.message || 'We could not load your coupons.');
      setShowForm(false);
      setEditingCoupon(null);
      setFormErrors({});
    }

    let verifiedCurrencyState = null;
    if (productResult.status === 'fulfilled' && productCurrencyResult.status === 'fulfilled') {
      const inspected = inspectCouponProductCurrencyState(
        productCurrencyResult.value.data?.productCurrency,
        productResult.value,
      );
      if (inspected.valid) verifiedCurrencyState = inspected;
    }

    if (verifiedCurrencyState) {
      setProducts(verifiedCurrencyState.products);
      setProductError('');
      setStoreCurrency(verifiedCurrencyState.activeCurrency);
      setVerifiedProductCurrencyState(verifiedCurrencyState);
      setProductCurrencyError('');
      setForm(current => current.currency ? current : createCouponForm(verifiedCurrencyState.activeCurrency));
    } else {
      setProducts([]);
      setStoreCurrency(null);
      setVerifiedProductCurrencyState(null);
      setShowForm(false);
      setEditingCoupon(null);
      setForm(createCouponForm(null));
      setFormErrors({});
      setProductError(
        productResult.status === 'rejected'
          ? productResult.reason?.response?.data?.msg || productResult.reason?.message || 'Products are unavailable right now.'
          : 'The complete product catalog could not be verified.',
      );
      const pending = productCurrencyResult.status === 'fulfilled'
        && productCurrencyResult.value.data?.productCurrency?.status === 'pending_conversion';
      setProductCurrencyError(
        productCurrencyResult.status === 'rejected'
          ? productCurrencyResult.reason?.response?.data?.msg || productCurrencyResult.reason?.message || 'Your store product currency could not be loaded.'
          : pending
            ? 'Finish or cancel the pending product currency change before managing coupons.'
            : 'Your store product currency or product-price breakdown is invalid or inconsistent.',
      );
    }

    if (
      analyticsResult.status === 'fulfilled'
      && couponAnalyticsResponseIsValid(analyticsResult.value.data, currency)
    ) {
      setAnalyticsData(analyticsResult.value.data);
      setAnalyticsError('');
    } else {
      setAnalyticsData(null);
      setAnalyticsError(
        analyticsResult.status === 'rejected'
          ? analyticsResult.reason?.response?.data?.msg || 'Coupon analytics are unavailable right now.'
          : 'Coupon analytics returned invalid or inconsistent money data.'
      );
    }

    hasLoaded.current = true;
    setInitialLoading(false);
    setRefreshing(false);
    return {
      coupons: verifiedCoupons,
      productCurrencyState: verifiedCurrencyState,
    };
  }, [currency]);

  useEffect(() => {
    fetchAll();
    return () => { fetchRequestRef.current += 1; };
  }, [fetchAll]);

  const resetForm = useCallback(() => {
    setForm(createCouponForm(storeCurrency));
    setFormErrors({});
    setEditingCoupon(null);
  }, [storeCurrency]);

  const openCreate = () => {
    if (!storeCurrency || productCurrencyError || !verifiedProductCurrencyState?.valid) {
      Feedback.show({ type: 'error', text1: 'Currency unavailable', text2: 'Your store product currency must be loaded before creating a coupon.' });
      fetchAll({ refresh: true });
      return;
    }
    resetForm();
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    resetForm();
  };

  const handleEdit = (coupon) => {
    const presentation = inspectCouponPresentation(coupon);
    const availableProductIds = new Set(products.map(product => product._id));
    if (
      !presentation.valid
      || !verifiedProductCurrencyState?.valid
      || presentation.productIds.some(id => !availableProductIds.has(id))
    ) {
      Feedback.show({
        type: 'error',
        text1: 'Coupon unavailable',
        text2: 'This coupon or its complete product catalog cannot be verified. Refresh before editing it.',
      });
      fetchAll({ refresh: true });
      return;
    }
    setForm({
      code: presentation.code,
      discountType: presentation.discountType,
      discountValue: String(presentation.discountValue),
      currency: presentation.currency,
      applicableTo: presentation.applicableTo,
      applicableProducts: presentation.productIds,
      maxUses: presentation.maxUses === null ? '' : String(presentation.maxUses),
      maxUsesPerUser: String(coupon.maxUsesPerUser),
      minOrderAmount: String(coupon.minOrderAmount),
      maxDiscountAmount: coupon.maxDiscountAmount === null ? '' : String(coupon.maxDiscountAmount),
      startDate: toDateInput(presentation.startDate),
      expiryDate: toDateInput(presentation.expiryDate),
      description: coupon.description,
    });
    setFormErrors({});
    setEditingCoupon(coupon);
    setShowForm(true);
  };

  const setField = (field, value) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setFormErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const handleSave = async () => {
    const formCurrency = normalizeCouponCurrency(form.currency);
    if (
      !formCurrency
      || !verifiedProductCurrencyState?.valid
      || productCurrencyError
      || (!editingCoupon && formCurrency !== storeCurrency)
    ) {
      Feedback.show({ type: 'error', text1: 'Currency unavailable', text2: 'New coupons must use your verified store product currency.' });
      return;
    }
    const availableProductIds = products.map(product => product._id);
    const errors = validateCouponForm(form, new Date(), { availableProductIds });
    setFormErrors(errors);
    if (Object.keys(errors).length) {
      Feedback.show({ type: 'error', text1: 'Check coupon details', text2: Object.values(errors)[0] });
      return;
    }

    setSaving(true);
    let productStateVerifiedThisAttempt = false;
    try {
      const latestProductState = await loadVerifiedCouponProductState(api);
      productStateVerifiedThisAttempt = true;
      setVerifiedProductCurrencyState(latestProductState);
      setProducts(latestProductState.products);
      setStoreCurrency(latestProductState.activeCurrency);
      setProductError('');
      setProductCurrencyError('');
      if (!editingCoupon && formCurrency !== latestProductState.activeCurrency) {
        Feedback.show({
          type: 'error',
          text1: 'Store currency changed',
          text2: `Your store now saves products in ${latestProductState.activeCurrency}. Review the coupon before creating it.`,
        });
        setForm(current => ({ ...current, currency: latestProductState.activeCurrency }));
        return;
      }
      const latestProductIds = new Set(latestProductState.products.map(product => product._id));
      const selectedProductIds = normalizeCouponProductIds(form.applicableProducts);
      if (
        form.applicableTo === 'selected'
        && selectedProductIds.some(id => !latestProductIds.has(id))
      ) {
        setFormErrors(current => ({
          ...current,
          applicableProducts: 'Choose only verified products from your complete catalog.',
        }));
        Feedback.show({ type: 'error', text1: 'Products changed', text2: 'Refresh and choose the products again.' });
        return;
      }
      const editingPresentation = editingCoupon ? inspectCouponPresentation(editingCoupon) : null;
      if (
        editingCoupon
        && (
          !editingPresentation.valid
          || !coupons.some(item => item === editingCoupon && item._id === editingPresentation.id)
        )
      ) {
        Feedback.show({ type: 'error', text1: 'Coupon changed', text2: 'Refresh this coupon before saving it.' });
        return;
      }
      const payload = buildCouponPayload({ ...form, currency: formCurrency });
      let response;
      if (editingCoupon) {
        response = await api.put(`/api/coupons/update/${editingPresentation.id}`, payload);
      } else {
        response = await api.post('/api/coupons/create', payload);
      }
      const saved = response?.data?.coupon;
      const savedPresentation = inspectCouponPresentation(saved);
      const expectedId = editingPresentation?.id || savedPresentation.id;
      const savedProductIds = [...savedPresentation.productIds].sort();
      const payloadProductIds = [...payload.applicableProducts].sort();
      if (
        !savedPresentation.valid
        || savedPresentation.id !== expectedId
        || savedPresentation.code !== payload.code
        || savedPresentation.currency !== payload.currency
        || savedPresentation.discountType !== payload.discountType
        || savedPresentation.discountValue !== payload.discountValue
        || savedPresentation.applicableTo !== payload.applicableTo
        || savedProductIds.length !== payloadProductIds.length
        || savedProductIds.some((id, index) => id !== payloadProductIds[index])
        || savedPresentation.maxUses !== payload.maxUses
        || saved.maxUsesPerUser !== payload.maxUsesPerUser
        || saved.minOrderAmount !== payload.minOrderAmount
        || saved.maxDiscountAmount !== payload.maxDiscountAmount
        || toDateInput(savedPresentation.startDate) !== payload.startDate
        || toDateInput(savedPresentation.expiryDate) !== payload.expiryDate
        || saved.description !== payload.description
      ) {
        closeForm();
        await fetchAll({ refresh: true });
        Feedback.show({
          type: 'error',
          text1: 'Coupon saved but not verified',
          text2: 'The server accepted the change, but its stored coupon response was inconsistent. Review the refreshed list before retrying.',
        });
        return;
      }
      const refreshed = await fetchAll();
      const refreshedCoupon = refreshed?.coupons?.find(coupon => coupon._id === savedPresentation.id);
      const refreshedPresentation = inspectCouponPresentation(refreshedCoupon);
      if (
        !refreshedPresentation.valid
        || refreshedPresentation.code !== payload.code
        || refreshedPresentation.currency !== payload.currency
        || refreshedPresentation.discountType !== payload.discountType
        || refreshedPresentation.discountValue !== payload.discountValue
      ) {
        closeForm();
        Feedback.show({
          type: 'error',
          text1: 'Coupon saved; refresh required',
          text2: 'The change was accepted, but the authoritative coupon list could not be verified.',
        });
        return;
      }
      Feedback.show({
        type: 'success',
        text1: editingCoupon ? 'Coupon updated' : 'Coupon created',
        text2: `${payload.code} is ready in your campaign workspace.`,
      });
      closeForm();
    } catch (error) {
      if (!productStateVerifiedThisAttempt) {
        setVerifiedProductCurrencyState(null);
        setStoreCurrency(null);
        setProductCurrencyError(error.response?.data?.msg || error.message || 'Your store product currency could not be verified.');
      }
      Feedback.show({ type: 'error', text1: 'Coupon not saved', text2: error.response?.data?.msg || error.message || 'Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (coupon) => {
    const presentation = inspectCouponPresentation(coupon);
    if (!presentation.valid || !coupons.some(item => item === coupon)) {
      Feedback.show({ type: 'error', text1: 'Coupon unavailable', text2: 'Refresh coupons before deleting this item.' });
      fetchAll({ refresh: true });
      return;
    }
    Alert.alert(
      `Delete ${presentation.code}?`,
      'This permanently removes the coupon. Existing order records will not be changed.',
      [
        { text: 'Keep coupon', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete(`/api/coupons/delete/${presentation.id}`);
              const refreshed = await fetchAll({ refresh: true });
              if (!Array.isArray(refreshed?.coupons) || refreshed.coupons.some(item => item._id === presentation.id)) {
                Feedback.show({
                  type: 'error',
                  text1: 'Deletion needs verification',
                  text2: 'The request was accepted, but the refreshed coupon list could not confirm deletion.',
                });
                return;
              }
              Feedback.show({ type: 'success', text1: 'Coupon deleted' });
            } catch (error) {
              Feedback.show({ type: 'error', text1: 'Could not delete coupon', text2: error.response?.data?.msg || 'Please try again.' });
            }
          },
        },
      ]
    );
  };

  const handleToggle = async (coupon) => {
    const presentation = inspectCouponPresentation(coupon);
    if (!presentation.valid || !coupons.some(item => item === coupon)) {
      Feedback.show({ type: 'error', text1: 'Coupon unavailable', text2: 'Refresh coupons before changing this status.' });
      fetchAll({ refresh: true });
      return;
    }
    try {
      if (!presentation.isActive) {
        const latestProductState = await loadVerifiedCouponProductState(api);
        setVerifiedProductCurrencyState(latestProductState);
        setProducts(latestProductState.products);
        setStoreCurrency(latestProductState.activeCurrency);
        setProductError('');
        setProductCurrencyError('');
      }
      const response = await api.patch(`/api/coupons/toggle/${presentation.id}`);
      const saved = response.data?.coupon;
      const savedPresentation = inspectCouponPresentation(saved);
      if (
        !savedPresentation.valid
        || savedPresentation.id !== presentation.id
        || savedPresentation.isActive !== !presentation.isActive
      ) throw new Error('The server returned an inconsistent coupon status.');
      const refreshed = await fetchAll({ refresh: true });
      const authoritative = refreshed?.coupons?.find(item => item._id === presentation.id);
      if (
        !inspectCouponPresentation(authoritative).valid
        || authoritative.isActive !== savedPresentation.isActive
      ) throw new Error('The refreshed coupon status could not be verified.');
    } catch (error) {
      if (!presentation.isActive) {
        setVerifiedProductCurrencyState(null);
        setStoreCurrency(null);
        setProductCurrencyError('Your store product currency must be refreshed before enabling coupons.');
      }
      Feedback.show({ type: 'error', text1: 'Status not verified', text2: error.response?.data?.msg || error.message || 'Please try again.' });
    }
  };

  const filteredCoupons = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return coupons.filter((coupon) => {
      const matchesSearch = !needle
        || String(coupon.code || '').toLowerCase().includes(needle)
        || String(coupon.description || '').toLowerCase().includes(needle);
      const matchesFilter = filter === 'all' || getCouponStatus(coupon) === filter;
      return matchesSearch && matchesFilter;
    });
  }, [coupons, filter, search]);

  const counts = useMemo(() => FILTERS.reduce((result, key) => ({
    ...result,
    [key]: key === 'all' ? coupons.length : coupons.filter((coupon) => getCouponStatus(coupon) === key).length,
  }), {}), [coupons]);

  const analyticsCurrency = analyticsData?.summary?.currency || null;
  const formatAnalyticsMoney = (amount) => (
    analyticsCurrency && typeof amount === 'number'
      ? formatPrice(amount, { sourceCurrency: analyticsCurrency })
      : 'Unavailable'
  );
  const formatCouponMoney = (amount, coupon) => {
    const sourceCurrency = coupon?.currency;
    if (
      normalizeCouponCurrency(sourceCurrency) !== sourceCurrency
      || !isExactCouponMoneyInput(amount, { allowZero: true })
    ) return 'Unavailable';
    return formatPrice(amount, { sourceCurrency });
  };

  const renderCoupon = ({ item }) => {
    const inspected = inspectCouponPresentation(item);
    if (!inspected.valid) return null;
    const status = getCouponStatus(item);
    const presentation = statusPresentation(status, palette);
    return (
      <GlassPanel variant="card" style={styles.couponCard}>
        <View style={styles.couponTopRow}>
          <View style={[styles.codeBadge, { backgroundColor: `${presentation.color}16` }]}>
            <Ionicons name="ticket-outline" size={14} color={presentation.color} />
            <Text style={[styles.couponCode, { color: presentation.color }]}>{item.code}</Text>
          </View>
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => handleEdit(item)}
              accessibilityRole="button"
              accessibilityLabel={`Edit coupon ${item.code}`}
            >
              <Ionicons name="create-outline" size={18} color={palette.colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => handleDelete(item)}
              accessibilityRole="button"
              accessibilityLabel={`Delete coupon ${item.code}`}
            >
              <Ionicons name="trash-outline" size={18} color={palette.colors.error} />
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.discountText}>
          {inspected.discountType === 'percentage' ? `${inspected.discountValue}% off` : `${formatCouponMoney(inspected.discountValue, item)} off`}
        </Text>
        {!!item.description && <Text style={styles.description} numberOfLines={2}>{item.description}</Text>}

        <View style={styles.detailGrid}>
          <CouponDetail icon="cube-outline" label="Applies to" value={inspected.applicableTo === 'all' ? 'All products' : `${inspected.productIds.length} selected`} color={palette.colors.primary} styles={styles} />
          <CouponDetail icon="people-outline" label="Usage" value={`${inspected.usedCount}${inspected.maxUses === null ? ' / Unlimited' : ` / ${inspected.maxUses}`}`} color={palette.colors.primary} styles={styles} />
          <CouponDetail icon="calendar-outline" label="Starts" value={inspected.startDate.toLocaleDateString()} color={palette.colors.primary} styles={styles} />
          <CouponDetail icon="time-outline" label="Expires" value={inspected.expiryDate.toLocaleDateString()} color={palette.colors.primary} styles={styles} />
        </View>

        <View style={styles.couponFooter}>
          <View style={[styles.statusPill, { backgroundColor: `${presentation.color}16` }]}>
            <Ionicons name={presentation.icon} size={13} color={presentation.color} />
            <Text style={[styles.statusText, { color: presentation.color }]}>{presentation.label}</Text>
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{inspected.isActive ? 'Enabled' : 'Disabled'}</Text>
            <Switch
              value={inspected.isActive}
              onValueChange={() => handleToggle(item)}
              disabled={status === 'expired'}
              accessibilityLabel={`${inspected.isActive ? 'Disable' : 'Enable'} coupon ${inspected.code}`}
              trackColor={{ false: palette.glass.bgStrong, true: palette.colors.primaryLight }}
              thumbColor={inspected.isActive ? palette.colors.primary : palette.colors.textLight}
            />
          </View>
        </View>
      </GlassPanel>
    );
  };

  if (initialLoading) {
    return <SellerScreenSkeleton navigation={navigation} title="Coupons" subtitle="Loading campaign workspace" icon="ticket-outline" variant="list" rows={4} />;
  }

  if (accessRestricted) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader navigation={navigation} title="Coupons" subtitle="Premium campaign tools" icon="ticket-outline" />
          <View style={styles.accessState}>
            <SellerEmptyState
              icon="diamond-outline"
              title="Coupon Management requires Elite"
              message={loadError || 'Upgrade your seller plan to create, schedule, and measure coupon campaigns.'}
              actionLabel="View Elite plan"
              onAction={() => navigation.navigate('SellerSubscription')}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Coupons"
          subtitle={`${coupons.length} campaign${coupons.length === 1 ? '' : 's'} · ${counts.active} active`}
          icon="ticket-outline"
          rightIcon="add"
          rightLabel="New"
          onRightPress={openCreate}
        />

        <View style={styles.tabShell} accessibilityRole="tablist">
          {[
            { id: 'manage', label: 'Manage', icon: 'options-outline' },
            { id: 'analytics', label: 'Analytics', icon: 'bar-chart-outline' },
          ].map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[styles.tab, activeTab === tab.id && styles.tabActive]}
              onPress={() => setActiveTab(tab.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab.id }}
            >
              <Ionicons name={tab.icon} size={16} color={activeTab === tab.id ? '#fff' : palette.colors.textSecondary} />
              <Text style={[styles.tabText, activeTab === tab.id && styles.tabTextActive]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {activeTab === 'manage' ? (
          <FlatList
            data={filteredCoupons}
            renderItem={renderCoupon}
            keyExtractor={(item) => String(item._id)}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchAll({ refresh: true })} tintColor={palette.colors.primary} />}
            ListHeaderComponent={(
              <>
                {!!loadError && <SellerInlineError compact title="Coupons unavailable" message={loadError} onRetry={fetchAll} />}
                {!!productCurrencyError && <SellerInlineError compact title="Store currency unavailable" message={`${productCurrencyError} New coupons are paused until it can be verified.`} onRetry={() => fetchAll({ refresh: true })} />}
                <GlassPanel variant="card" style={styles.filterCard}>
                  <View style={styles.searchShell}>
                    <Ionicons name="search" size={18} color={palette.colors.textSecondary} />
                    <TextInput
                      style={styles.searchInput}
                      value={search}
                      onChangeText={setSearch}
                      placeholder="Search code or description"
                      placeholderTextColor={palette.colors.textSecondary}
                      autoCapitalize="none"
                      accessibilityLabel="Search coupons"
                    />
                    {!!search && (
                      <TouchableOpacity onPress={() => setSearch('')} accessibilityLabel="Clear coupon search">
                        <Ionicons name="close-circle" size={18} color={palette.colors.textSecondary} />
                      </TouchableOpacity>
                    )}
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                    {FILTERS.map((value) => (
                      <TouchableOpacity
                        key={value}
                        style={[styles.filterChip, filter === value && styles.filterChipActive]}
                        onPress={() => setFilter(value)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: filter === value }}
                      >
                        <Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{value[0].toUpperCase() + value.slice(1)}</Text>
                        <View style={[styles.countBadge, filter === value && styles.countBadgeActive]}>
                          <Text style={[styles.countText, filter === value && styles.countTextActive]}>{counts[value]}</Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </GlassPanel>
              </>
            )}
            ListEmptyComponent={loadError && coupons.length === 0 ? null : (
              <SellerEmptyState
                icon={coupons.length ? 'search-outline' : 'ticket-outline'}
                title={coupons.length ? 'No matching coupons' : 'Create your first campaign'}
                message={coupons.length ? 'Try another search or status filter.' : 'Offer a percentage or fixed discount, schedule it, and track its performance.'}
                actionLabel={coupons.length ? 'Clear filters' : 'Create coupon'}
                onAction={coupons.length ? () => { setSearch(''); setFilter('all'); } : openCreate}
              />
            )}
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.analyticsContent}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchAll({ refresh: true })} tintColor={palette.colors.primary} />}
          >
            {!!analyticsError && <SellerInlineError compact title="Analytics unavailable" message={analyticsError} onRetry={fetchAll} />}
            <SellerSectionHeader
              title="Campaign performance"
              subtitle={analyticsCurrency
                ? `Attributed sales are recognized eligible-product subtotals before discounts in ${analyticsCurrency}; shipping and tax are excluded.`
                : 'Live monetary analytics are unavailable.'}
              icon="sparkles-outline"
            />
            <View style={styles.statsGrid}>
              {[
                { label: 'Total', value: analyticsData?.summary?.totalCoupons ?? 'Unavailable', icon: 'ticket', color: palette.colors.primary },
                { label: 'Active', value: analyticsData?.summary?.activeCoupons ?? 'Unavailable', icon: 'checkmark-circle', color: palette.colors.success },
                { label: 'Uses', value: analyticsData?.summary?.totalUses ?? 'Unavailable', icon: 'people', color: palette.colors.info },
                { label: 'Attributed sales', value: formatAnalyticsMoney(analyticsData?.summary?.totalRevenueFromCoupons), icon: 'trending-up', color: palette.colors.warning },
              ].map((stat) => (
                <GlassPanel key={stat.label} variant="card" style={styles.statCard}>
                  <View style={[styles.statIcon, { backgroundColor: `${stat.color}16` }]}>
                    <Ionicons name={stat.icon} size={19} color={stat.color} />
                  </View>
                  <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{stat.value}</Text>
                  <Text style={styles.statLabel}>{stat.label}</Text>
                </GlassPanel>
              ))}
            </View>

            <GlassPanel variant="strong" style={styles.impactCard}>
              <LinearGradient colors={['rgba(99,102,241,0.18)', 'rgba(14,165,233,0.08)', 'rgba(16,185,129,0.12)']} style={StyleSheet.absoluteFill} />
              <View style={styles.impactIcon}><Ionicons name="cash-outline" size={22} color="#fff" /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.impactLabel}>CUSTOMER SAVINGS</Text>
                <Text style={styles.impactValue}>{formatAnalyticsMoney(analyticsData?.summary?.totalDiscountGiven)}</Text>
                <Text style={styles.impactText}>Top campaign · {analyticsData?.summary?.topCouponCode || 'No usage yet'}</Text>
              </View>
            </GlassPanel>

            <SellerSectionHeader title="Coupon breakdown" subtitle="Orders, buyers, usage, attributed sales, and discounts" icon="analytics-outline" />
            {analyticsError && !analyticsData ? null : !analyticsData?.analytics?.length ? (
              <SellerEmptyState icon="bar-chart-outline" title="No performance data yet" message="Results appear here after a customer uses one of your coupons." />
            ) : analyticsData.analytics.map((item) => {
              const status = getCouponStatus(item);
              const presentation = statusPresentation(status, palette);
              return (
                <GlassPanel key={String(item._id)} variant="card" style={styles.analyticsCard}>
                  <View style={styles.analyticsTop}>
                    <View>
                      <Text style={styles.analyticsCode}>{item.code}</Text>
                      <Text style={styles.analyticsDiscount}>{item.discountType === 'percentage' ? `${item.discountValue}% off` : `${formatCouponMoney(item.discountValue, item)} off`}</Text>
                    </View>
                    <View style={[styles.statusPill, { backgroundColor: `${presentation.color}16` }]}>
                      <Text style={[styles.statusText, { color: presentation.color }]}>{presentation.label}</Text>
                    </View>
                  </View>
                  <MetricRow palette={palette} items={[
                    { label: 'Uses', value: `${item.usedCount}${item.maxUses === null ? '' : `/${item.maxUses}`}` },
                    { label: 'Orders', value: item.ordersGenerated },
                    { label: 'Buyers', value: item.uniqueUsers },
                    { label: 'Conversion', value: item.conversionRate == null ? '—' : `${item.conversionRate}%` },
                  ]} />
                  <View style={styles.moneyRow}>
                    <MoneyMetric label="Attributed sales" value={formatAnalyticsMoney(item.totalRevenue)} color={palette.colors.success} styles={styles} />
                    <MoneyMetric label="Discounts" value={formatAnalyticsMoney(item.totalDiscount)} color={palette.colors.warning} styles={styles} />
                    <MoneyMetric label="Avg. order" value={formatAnalyticsMoney(item.avgOrderValue)} color={palette.colors.text} styles={styles} />
                  </View>
                  <CouponBarChart
                    data={[item.usedCount, item.ordersGenerated, item.uniqueUsers]}
                    labels={['Uses', 'Orders', 'Buyers']}
                    height={84}
                    color={palette.colors.primary}
                    textColor={palette.colors.textSecondary}
                  />
                </GlassPanel>
              );
            })}
          </ScrollView>
        )}

        <CouponFormModal
          visible={showForm}
          editing={!!editingCoupon}
          form={form}
          errors={formErrors}
          products={products}
          productError={productError}
          saving={saving}
          palette={palette}
          styles={styles}
          onClose={closeForm}
          onChange={setField}
          onSave={handleSave}
          onRetryProducts={fetchAll}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

function CouponDetail({ icon, label, value, color, styles }) {
  return (
    <View style={styles.detailItem}>
      <Ionicons name={icon} size={14} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue} numberOfLines={1}>{value}</Text>
      </View>
    </View>
  );
}

function MoneyMetric({ label, value, color, styles }) {
  return (
    <View style={styles.moneyMetric}>
      <Text style={styles.moneyLabel}>{label}</Text>
      <Text style={[styles.moneyValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

function FormField({ label, error, styles, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {!!error && <Text style={styles.fieldError}>{error}</Text>}
    </View>
  );
}

function CouponFormModal({
  visible,
  editing,
  form,
  errors,
  products,
  productError,
  saving,
  palette,
  styles,
  onClose,
  onChange,
  onSave,
  onRetryProducts,
}) {
  const selectedIds = normalizeCouponProductIds(form.applicableProducts);
  const inputProps = { placeholderTextColor: palette.colors.textSecondary, selectionColor: palette.colors.primary };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalKeyboard}>
          <SafeAreaView style={styles.modalSafe} edges={['bottom', 'left', 'right']}>
            <GlassPanel variant="strong" style={styles.modalContent}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHeader}>
                <View>
                  <Text style={styles.modalEyebrow}>{editing ? 'CAMPAIGN EDITOR' : 'NEW CAMPAIGN'}</Text>
                  <Text style={styles.modalTitle}>{editing ? 'Update coupon' : 'Create coupon'}</Text>
                </View>
                <TouchableOpacity style={styles.modalClose} onPress={onClose} accessibilityLabel="Close coupon form">
                  <Ionicons name="close" size={21} color={palette.colors.text} />
                </TouchableOpacity>
              </View>
              <KeyboardAwareFormScrollView contentContainerStyle={styles.formContent}>
                <FormField label="Coupon code" error={errors.code} styles={styles}>
                  <TextInput
                    {...inputProps}
                    style={[styles.input, errors.code && styles.inputError]}
                    value={form.code}
                    onChangeText={(value) => onChange('code', value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))}
                    placeholder="SAVE20"
                    autoCapitalize="characters"
                    maxLength={32}
                    accessibilityLabel="Coupon code"
                  />
                </FormField>

                <View style={styles.segmentRow}>
                  {[
                    { id: 'percentage', label: 'Percentage', icon: 'percent-outline' },
                    { id: 'fixed', label: `Fixed ${form.currency}`, icon: 'cash-outline' },
                  ].map((type) => (
                    <TouchableOpacity
                      key={type.id}
                      style={[styles.segment, form.discountType === type.id && styles.segmentActive]}
                      onPress={() => onChange('discountType', type.id)}
                      accessibilityState={{ selected: form.discountType === type.id }}
                    >
                      <Ionicons name={type.icon} size={16} color={form.discountType === type.id ? palette.colors.primary : palette.colors.textSecondary} />
                      <Text style={[styles.segmentText, form.discountType === type.id && styles.segmentTextActive]}>{type.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <FormField label={`Discount value ${form.discountType === 'percentage' ? '(%)' : `(${form.currency})`}`} error={errors.discountValue} styles={styles}>
                  <TextInput {...inputProps} style={[styles.input, errors.discountValue && styles.inputError]} value={form.discountValue} onChangeText={(value) => onChange('discountValue', value)} placeholder="20" keyboardType="decimal-pad" accessibilityLabel="Discount value" />
                </FormField>

                <Text style={styles.fieldLabel}>Applies to</Text>
                <View style={styles.segmentRow}>
                  {[
                    { id: 'all', label: 'All products', icon: 'storefront-outline' },
                    { id: 'selected', label: 'Selected', icon: 'cube-outline' },
                  ].map((scope) => (
                    <TouchableOpacity
                      key={scope.id}
                      style={[styles.segment, form.applicableTo === scope.id && styles.segmentActive]}
                      onPress={() => {
                        onChange('applicableTo', scope.id);
                        if (scope.id === 'all') onChange('applicableProducts', []);
                      }}
                      accessibilityState={{ selected: form.applicableTo === scope.id }}
                    >
                      <Ionicons name={scope.icon} size={16} color={form.applicableTo === scope.id ? palette.colors.primary : palette.colors.textSecondary} />
                      <Text style={[styles.segmentText, form.applicableTo === scope.id && styles.segmentTextActive]}>{scope.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {form.applicableTo === 'selected' && (
                  <View style={styles.productPicker}>
                    <View style={styles.productPickerHeader}>
                      <Text style={styles.fieldLabel}>Products</Text>
                      <Text style={styles.selectedCount}>{selectedIds.length} selected</Text>
                    </View>
                    {!!productError && <SellerInlineError compact title="Products unavailable" message={productError} onRetry={onRetryProducts} />}
                    {!productError && products.length === 0 ? (
                      <Text style={styles.helperText}>Add products before creating a selected-product coupon.</Text>
                    ) : (
                      <View style={styles.productList}>
                        {products.map((product) => {
                          const selected = selectedIds.includes(String(product._id));
                          return (
                            <TouchableOpacity
                              key={String(product._id)}
                              style={[styles.productChip, selected && styles.productChipSelected]}
                              onPress={() => onChange('applicableProducts', selected
                                ? selectedIds.filter((id) => id !== String(product._id))
                                : [...selectedIds, String(product._id)])}
                              accessibilityRole="checkbox"
                              accessibilityState={{ checked: selected }}
                            >
                              <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={16} color={selected ? '#fff' : palette.colors.textSecondary} />
                              <Text style={[styles.productChipText, selected && styles.productChipTextSelected]} numberOfLines={1}>{product.name}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                    {!!errors.applicableProducts && <Text style={styles.fieldError}>{errors.applicableProducts}</Text>}
                  </View>
                )}

                <View style={styles.twoColumn}>
                  <View style={styles.column}>
                    <FormField label="Max uses" error={errors.maxUses} styles={styles}>
                      <TextInput {...inputProps} style={[styles.input, errors.maxUses && styles.inputError]} value={form.maxUses} onChangeText={(value) => onChange('maxUses', value.replace(/\D/g, ''))} placeholder="Unlimited" keyboardType="number-pad" />
                    </FormField>
                  </View>
                  <View style={styles.column}>
                    <FormField label="Per buyer" error={errors.maxUsesPerUser} styles={styles}>
                      <TextInput {...inputProps} style={[styles.input, errors.maxUsesPerUser && styles.inputError]} value={form.maxUsesPerUser} onChangeText={(value) => onChange('maxUsesPerUser', value.replace(/\D/g, ''))} placeholder="1" keyboardType="number-pad" />
                    </FormField>
                  </View>
                </View>

                <View style={styles.twoColumn}>
                  <View style={styles.column}>
                    <FormField label={`Min. order (${form.currency})`} error={errors.minOrderAmount} styles={styles}>
                      <TextInput {...inputProps} style={[styles.input, errors.minOrderAmount && styles.inputError]} value={form.minOrderAmount} onChangeText={(value) => onChange('minOrderAmount', value)} placeholder="0" keyboardType="decimal-pad" />
                    </FormField>
                  </View>
                  <View style={styles.column}>
                    <FormField label={`Discount cap (${form.currency})`} error={errors.maxDiscountAmount} styles={styles}>
                      <TextInput {...inputProps} style={[styles.input, errors.maxDiscountAmount && styles.inputError]} value={form.maxDiscountAmount} onChangeText={(value) => onChange('maxDiscountAmount', value)} placeholder="No limit" keyboardType="decimal-pad" />
                    </FormField>
                  </View>
                </View>

                <View style={styles.twoColumn}>
                  <View style={styles.column}>
                    <FormField label="Starts (YYYY-MM-DD)" error={errors.startDate} styles={styles}>
                      <TextInput {...inputProps} style={[styles.input, errors.startDate && styles.inputError]} value={form.startDate} onChangeText={(value) => onChange('startDate', value)} placeholder="2026-08-08" keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'} />
                    </FormField>
                  </View>
                  <View style={styles.column}>
                    <FormField label="Expires (YYYY-MM-DD)" error={errors.expiryDate} styles={styles}>
                      <TextInput {...inputProps} style={[styles.input, errors.expiryDate && styles.inputError]} value={form.expiryDate} onChangeText={(value) => onChange('expiryDate', value)} placeholder="2026-09-08" keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'} />
                    </FormField>
                  </View>
                </View>

                <FormField label="Customer-facing description" styles={styles}>
                  <TextInput {...inputProps} style={[styles.input, styles.textArea]} value={form.description} onChangeText={(value) => onChange('description', value)} placeholder="Optional campaign details" multiline maxLength={500} textAlignVertical="top" />
                </FormField>

                <View style={styles.currencyNotice}>
                  <Ionicons name="information-circle-outline" size={17} color={palette.colors.info} />
                  <Text style={styles.currencyNoticeText}>Fixed values stay stored in {form.currency}. Changing your display currency will not alter this coupon.</Text>
                </View>

                <TouchableOpacity style={[styles.saveButton, saving && styles.disabled]} onPress={onSave} disabled={saving} activeOpacity={0.85} accessibilityRole="button">
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Ionicons name="checkmark-circle-outline" size={19} color="#fff" />}
                  <Text style={styles.saveButtonText}>{editing ? 'Save coupon changes' : 'Create coupon'}</Text>
                </TouchableOpacity>
              </KeyboardAwareFormScrollView>
            </GlassPanel>
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  accessState: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg, paddingBottom: 72 },
  tabShell: { flexDirection: 'row', marginHorizontal: spacing.lg, marginTop: spacing.sm, padding: 4, borderRadius: 16, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  tab: { flex: 1, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 13 },
  tabActive: { backgroundColor: p.colors.primary, ...shadows.sm },
  tabText: { ...typography.bodySmall, color: p.colors.textSecondary, fontWeight: fontWeight.bold },
  tabTextActive: { color: '#fff' },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 96 },
  analyticsContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: 96 },
  filterCard: { padding: spacing.md, marginBottom: spacing.md },
  searchShell: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: 15, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, minHeight: 44, color: p.colors.text, fontSize: fontSize.sm },
  filterRow: { gap: spacing.sm, paddingTop: spacing.md },
  filterChip: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  filterChipActive: { backgroundColor: p.colors.primarySubtle, borderColor: p.colors.primaryLighter },
  filterText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  filterTextActive: { color: p.colors.primary },
  countBadge: { minWidth: 20, height: 20, paddingHorizontal: 4, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgStrong },
  countBadgeActive: { backgroundColor: p.colors.primary },
  countText: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  countTextActive: { color: '#fff' },
  couponCard: { padding: spacing.lg, marginBottom: spacing.md },
  couponTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  codeBadge: { maxWidth: '68%', minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, borderRadius: 11 },
  couponCode: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, letterSpacing: 0.8 },
  cardActions: { flexDirection: 'row', gap: spacing.xs },
  iconButton: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  discountText: { marginTop: spacing.md, fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  description: { marginTop: 4, fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  detailGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  detailItem: { width: '48%', minWidth: 132, flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: 13, backgroundColor: p.glass.bgSubtle },
  detailLabel: { fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.4, textTransform: 'uppercase', color: p.colors.textSecondary },
  detailValue: { marginTop: 2, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  couponFooter: { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusPill: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, borderRadius: borderRadius.full },
  statusText: { fontSize: 10, fontWeight: fontWeight.bold },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  switchLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { minWidth: 140, flexBasis: '47%', flexGrow: 1, padding: spacing.md },
  statIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  statValue: { marginTop: spacing.sm, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  statLabel: { marginTop: 2, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  impactCard: { minHeight: 118, flexDirection: 'row', alignItems: 'center', gap: spacing.md, overflow: 'hidden', padding: spacing.lg, marginBottom: spacing.xl },
  impactIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary },
  impactLabel: { fontSize: 9, letterSpacing: 0.8, fontWeight: fontWeight.extrabold, color: p.colors.primary },
  impactValue: { marginTop: 3, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  impactText: { marginTop: 3, fontSize: fontSize.xs, color: p.colors.textSecondary },
  analyticsCard: { padding: spacing.lg, marginBottom: spacing.md },
  analyticsTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.md },
  analyticsCode: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, letterSpacing: 0.8, color: p.colors.primary },
  analyticsDiscount: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  moneyRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  moneyMetric: { flex: 1 },
  moneyLabel: { fontSize: 9, color: p.colors.textSecondary },
  moneyValue: { marginTop: 3, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(4,8,20,0.62)' },
  modalKeyboard: { flex: 1, justifyContent: 'flex-end' },
  modalSafe: { maxHeight: '94%' },
  modalContent: { maxHeight: '100%', paddingHorizontal: spacing.lg, paddingBottom: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  modalHandle: { alignSelf: 'center', width: 42, height: 4, borderRadius: 2, marginTop: spacing.sm, marginBottom: spacing.md, backgroundColor: p.glass.borderStrong },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.sm },
  modalEyebrow: { fontSize: 9, fontWeight: fontWeight.extrabold, letterSpacing: 1, color: p.colors.primary },
  modalTitle: { marginTop: 2, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  modalClose: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  formContent: { paddingTop: spacing.md, paddingBottom: spacing.xxl },
  field: { marginBottom: spacing.md },
  fieldLabel: { marginBottom: 6, fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  fieldError: { marginTop: 5, fontSize: fontSize.xs, color: p.colors.error },
  input: { minHeight: 48, paddingHorizontal: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, color: p.colors.text, fontSize: fontSize.md },
  inputError: { borderColor: `${p.colors.error}80`, backgroundColor: p.colors.errorSubtle },
  textArea: { minHeight: 88, paddingTop: spacing.md },
  segmentRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  segment: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: spacing.sm, borderRadius: 14, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  segmentActive: { backgroundColor: p.colors.primarySubtle, borderColor: p.colors.primaryLighter },
  segmentText: { flexShrink: 1, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  segmentTextActive: { color: p.colors.primary },
  productPicker: { marginBottom: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  productPickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  selectedCount: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  productList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  productChip: { maxWidth: '100%', minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderSubtle },
  productChipSelected: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  productChipText: { maxWidth: 180, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  productChipTextSelected: { color: '#fff' },
  helperText: { fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  twoColumn: { flexDirection: 'row', gap: spacing.sm },
  column: { flex: 1, minWidth: 0 },
  currencyNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.info}10`, borderWidth: 1, borderColor: `${p.colors.info}25` },
  currencyNoticeText: { flex: 1, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  saveButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, ...shadows.md },
  saveButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  disabled: { opacity: 0.58 },
});
