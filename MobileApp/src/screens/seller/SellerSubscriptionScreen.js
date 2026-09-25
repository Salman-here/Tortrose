import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Modal,
  Platform,
  RefreshControl,
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
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import {
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { useAuth } from '../../contexts/AuthContext';
import { createScopedMutationStorageKey, getOrCreatePersistedMutationAttemptInLedger, clearPersistedMutationAttemptFromLedger } from '../../utils/persistedMutationAttempt';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

const SUBSCRIPTION_RETURN_URL = 'rozare://seller-subscription';

const TRIAL_FEATURES = [
  ['storefront-outline', 'Store and products visible to all customers'],
  ['cube-outline', 'Up to 15 product listings during the free trial'],
  ['card-outline', 'Secure payment processing'],
  ['globe-outline', 'Custom subdomain for your store'],
  ['stats-chart-outline', 'Order management and customer insights'],
  ['chatbubbles-outline', 'Unlimited seller AI chat'],
  ['logo-whatsapp', 'Manage your store, orders and products from WhatsApp by chatting with AI'],
  ['notifications-outline', 'WhatsApp notifications for new orders'],
  ['checkmark-done-outline', 'Rozare WhatsApp order confirmation automation'],
  ['star-outline', 'Featured product highlighting (6 products)'],
];

const STARTER_FEATURES = [
  ['storefront-outline', 'Store and products visible to all customers'],
  ['cube-outline', 'Unlimited product listings'],
  ['card-outline', 'Secure payment processing'],
  ['globe-outline', 'Custom subdomain for your store'],
  ['stats-chart-outline', 'Order management and customer insights'],
  ['chatbubbles-outline', 'Unlimited seller AI chat'],
  ['logo-whatsapp', 'Manage your store, orders and products from WhatsApp by chatting with AI'],
  ['notifications-outline', 'WhatsApp notifications for new orders'],
  ['checkmark-done-outline', 'Rozare WhatsApp order confirmation automation'],
  ['star-outline', 'Featured product highlighting (6 products)'],
];

const BONUS_FEATURES = [
  ['create-outline', 'Smart description generator with AI'],
  ['analytics-outline', 'Advanced analytics and growth insights'],
  ['pricetag-outline', 'Smart tag AI generator for products'],
  ['headset-outline', 'Priority support and early access to new features'],
  ['ticket-outline', 'Coupon and discount management system'],
  ['layers-outline', 'Bulk discount and promotional tools'],
];

const ELITE_ONLY_FEATURES = [
  ['megaphone-outline', 'Rozare-run TikTok ads for your store and featured products'],
  ['color-palette-outline', 'Customizable store themes with your own colors and layouts'],
];

const ELITE_PLAN_FEATURES = [
  ['checkmark-done-outline', 'Everything in Starter'],
  ['star-outline', 'Featured product highlighting (12 products)'],
  ...BONUS_FEATURES,
  ...ELITE_ONLY_FEATURES,
];

const STATUS_PRESENTATION = {
  trial: ['Free Trial', 'time-outline', 'primary'],
  free_period: ['Introductory Period', 'sparkles-outline', 'success'],
  active: ['Active', 'checkmark-circle-outline', 'success'],
  past_due: ['Past Due', 'alert-circle-outline', 'warning'],
  blocked: ['Blocked', 'lock-closed-outline', 'error'],
  cancelled: ['Cancelled', 'close-circle-outline', 'gray'],
};

const featureItems = (values, fallback, icon = 'checkmark-circle-outline') => (
  Array.isArray(values) && values.length > 0 && values.every(value => typeof value === 'string' && value.trim())
    ? values.map(value => [icon, value.trim()])
    : fallback
);

const isSafeMinor = (value, { positive = true } = {}) => (
  typeof value === 'number'
  && Number.isSafeInteger(value)
  && (positive ? value > 0 : value >= 0)
);
const normalizePricingPlan = (plan, expectedPlan) => {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  if (
    plan.plan !== expectedPlan
    || typeof plan.planName !== 'string'
    || !plan.planName.trim()
    || !isSafeMinor(plan.listAmountCents)
    || !isSafeMinor(plan.standardAmountCents)
    || !isSafeMinor(plan.founderAmountCents)
    || !Number.isSafeInteger(plan.advertisedDiscountPercent)
    || plan.advertisedDiscountPercent < 0
    || plan.advertisedDiscountPercent > 100
    || !Number.isSafeInteger(plan.freePeriodDays)
    || plan.freePeriodDays < 0
    || plan.freePeriodDays > 365
    || plan.listAmountCents < plan.standardAmountCents
    || plan.standardAmountCents < plan.founderAmountCents
  ) return null;
  return {
    plan: expectedPlan,
    planName: plan.planName.trim(),
    listAmountCents: plan.listAmountCents,
    standardAmountCents: plan.standardAmountCents,
    founderAmountCents: plan.founderAmountCents,
    advertisedDiscountPercent: plan.advertisedDiscountPercent,
    freePeriodDays: plan.freePeriodDays,
  };
};
const normalizeSubscriptionPricing = pricing => {
  if (
    !pricing
    || typeof pricing !== 'object'
    || Array.isArray(pricing)
    || pricing.schemaVersion !== 1
    || pricing.currency !== 'USD'
    || !isSafeMinor(pricing.metaAdsAddonCents, { positive: false })
  ) return null;
  const starter = normalizePricingPlan(pricing.starter, 'starter');
  const elite = normalizePricingPlan(pricing.elite, 'elite');
  if (!starter || !elite) return null;
  return {
    schemaVersion: 1,
    currency: 'USD',
    starter,
    elite,
    metaAdsAddonCents: pricing.metaAdsAddonCents,
  };
};
const formatUsd = cents => {
  if (!isSafeMinor(cents, { positive: false })) return null;
  const value = BigInt(cents);
  return `$${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};
const formatDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const daysUntil = (value) => {
  if (!value) return 0;
  const diff = new Date(value).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
};

export const getSubscriptionViewModel = (subscription, eliteMetaAds = false) => {
  const safe = subscription || {};
  const isSubscribed = ['active', 'free_period'].includes(safe.status);
  const isElite = safe.plan === 'elite';
  const founderRateActive = Boolean(safe.founderOffer?.active);
  const pricing = normalizeSubscriptionPricing(safe.pricing);
  const starterPrice = pricing && founderRateActive
    ? pricing.starter.founderAmountCents
    : pricing?.starter.standardAmountCents ?? null;
  const eliteBasePrice = pricing && founderRateActive
    ? pricing.elite.founderAmountCents
    : pricing?.elite.standardAmountCents ?? null;

  return {
    isSubscribed,
    isElite,
    isStarter: isSubscribed && !isElite,
    isTrial: safe.status === 'trial',
    isBlocked: safe.status === 'blocked',
    isPastDue: safe.status === 'past_due',
    isEnding: Boolean(safe.cancelledAt && !safe.pendingDowngrade && isSubscribed),
    hasPendingDowngrade: safe.pendingDowngrade === 'starter',
    founderRateActive,
    getsIntroductoryFreePeriod: !safe.hasUsedFreePeriod,
    pricingAvailable: Boolean(pricing),
    pricing,
    starterPrice,
    eliteBasePrice,
    selectedElitePrice: pricing
      ? eliteBasePrice + (eliteMetaAds ? pricing.metaAdsAddonCents : 0)
      : null,
    activeElitePrice: pricing
      ? eliteBasePrice + (safe.metaAdsIncluded ? pricing.metaAdsAddonCents : 0)
      : null,
    metaSelectionChanged: isElite && isSubscribed && Boolean(safe.metaAdsIncluded) !== eliteMetaAds,
  };
};

function ActionButton({
  label,
  icon = 'arrow-forward',
  onPress,
  loading = false,
  disabled = false,
  tone = 'primary',
  styles,
  palette,
}) {
  const toneStyle = tone === 'danger'
    ? styles.buttonDanger
    : tone === 'muted'
      ? styles.buttonMuted
      : styles.buttonPrimary;
  const color = tone === 'muted' ? palette.colors.text : '#fff';
  return (
    <TouchableOpacity
      style={[styles.actionButton, toneStyle, (loading || disabled) && styles.buttonDisabled]}
      onPress={onPress}
      disabled={loading || disabled}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: loading || disabled, busy: loading }}
    >
      {loading
        ? <Ionicons name="hourglass-outline" size={17} color={color} />
        : <Ionicons name={icon} size={17} color={color} />}
      <Text style={[styles.actionButtonText, tone === 'muted' && styles.actionButtonTextMuted]}>
        {loading ? 'Please wait…' : label}
      </Text>
    </TouchableOpacity>
  );
}

function FeatureList({ items, styles, palette, accent, available = true }) {
  return items.map(([icon, label]) => (
    <View key={label} style={styles.featureRow}>
      <View style={[styles.featureIcon, { backgroundColor: `${accent}14` }]}>
        <Ionicons name={icon} size={14} color={accent} />
      </View>
      <Text style={[styles.featureText, !available && styles.featureTextUnavailable]}>{label}</Text>
      <Ionicons
        name={available ? 'checkmark' : 'close'}
        size={15}
        color={available ? palette.colors.success : palette.colors.error}
      />
    </View>
  ));
}

export default function SellerSubscriptionScreen({ navigation, route }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState('');
  const [billingQuote, setBillingQuote] = useState(null);
  const [billingCards, setBillingCards] = useState([]);
  const [billingCardId, setBillingCardId] = useState('');
  const [billingConsent, setBillingConsent] = useState(false);
  const billingAttemptRef = useRef(null);
  const billingBusyRef = useRef(false);
  const [eliteMetaAds, setEliteMetaAds] = useState(false);
  const [couponCode, setCouponCode] = useState(
    String(route?.params?.coupon || route?.params?.couponCode || '').trim().toUpperCase(),
  );
  const [founderCouponApplied, setFounderCouponApplied] = useState(false);
  const checkoutOpenRef = useRef(false);
  const handledReturnRef = useRef('');
  const checkoutRefreshTimersRef = useRef([]);
  const subscriptionRequestRef = useRef(0);

  const fetchSubscription = useCallback(async () => {
    const requestId = subscriptionRequestRef.current + 1;
    subscriptionRequestRef.current = requestId;
    setLoading(true);
    setSubscription(null);
    setError('');
    try {
      const response = await api.get('/api/subscription/status');
      if (subscriptionRequestRef.current !== requestId) return null;
      const next = response.data?.subscription;
      if (!next) throw new Error('Subscription status was not returned.');
      setSubscription(next);
      setEliteMetaAds(Boolean(next.metaAdsIncluded));

      const requestedCoupon = String(
        route?.params?.coupon || route?.params?.couponCode || couponCode || '',
      ).trim().toUpperCase();
      const promotion = next.founderPromotion;
      if (
        requestedCoupon
        && requestedCoupon === promotion?.code
        && promotion?.available
        && promotion?.sellerEligible
      ) {
        setCouponCode(requestedCoupon);
        setFounderCouponApplied(true);
      }
      return next;
    } catch (requestError) {
      if (subscriptionRequestRef.current !== requestId) return null;
      setSubscription(null);
      setError(requestError.response?.data?.msg || requestError.message || 'Could not load your subscription.');
      return null;
    } finally {
      if (subscriptionRequestRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [couponCode, route?.params?.coupon, route?.params?.couponCode]);

  const refreshAfterCheckout = useCallback(() => {
    checkoutRefreshTimersRef.current.forEach(clearTimeout);
    checkoutRefreshTimersRef.current = [];
    fetchSubscription();
    checkoutRefreshTimersRef.current = [1500, 4500].map((delay) => (
      setTimeout(() => fetchSubscription(), delay)
    ));
  }, [fetchSubscription]);

  useEffect(() => {
    fetchSubscription({ initial: true });
  }, []);

  useEffect(() => () => {
    checkoutRefreshTimersRef.current.forEach(clearTimeout);
    subscriptionRequestRef.current += 1;
  }, []);

  useEffect(() => {
    const subscriptionListener = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && checkoutOpenRef.current) {
        checkoutOpenRef.current = false;
        refreshAfterCheckout();
      }
    });
    return () => subscriptionListener.remove();
  }, [refreshAfterCheckout]);

  useEffect(() => {
    const checkoutResult = route?.params?.checkout;
    if (!checkoutResult || handledReturnRef.current === checkoutResult) return;
    handledReturnRef.current = checkoutResult;
    if (checkoutResult === 'success') {
      Alert.alert('Subscription processing', 'Rozare is checking the payment outcome. Your plan changes only after backend verification.');
      refreshAfterCheckout();
    } else if (checkoutResult === 'cancelled') {
      Alert.alert('Checkout cancelled', 'No charge was made. You can choose a plan whenever you are ready.');
    }
    navigation?.setParams?.({ checkout: undefined });
  }, [navigation, refreshAfterCheckout, route?.params?.checkout]);

  const model = getSubscriptionViewModel(subscription, eliteMetaAds);
  const metaAdsAddonCents = model.pricing?.metaAdsAddonCents ?? null;
  const periodDaysRemaining = daysUntil(subscription?.currentPeriodEnd);
  const activeStatus = model.isEnding
    ? [`Ending · ${periodDaysRemaining} day${periodDaysRemaining === 1 ? '' : 's'} remaining`, 'close-circle-outline', 'error']
    : model.hasPendingDowngrade
      ? ['Changing plan', 'swap-horizontal-outline', 'warning']
      : STATUS_PRESENTATION[subscription?.status] || STATUS_PRESENTATION.trial;
  const statusColor = palette.colors[activeStatus[2]] || palette.colors.primary;

  const runMutation = useCallback(async (key, request, successFallback) => {
    setOperation(key);
    try {
      const response = await request();
      Alert.alert('Done', response.data?.msg || successFallback);
    } catch (requestError) {
      Alert.alert(
        'Could not update plan',
        requestError.response?.data?.msg || requestError.message || 'Please try again.'
      );
    } finally {
      // Never infer an entitlement from the client-side payment result. Refresh
      // the server-owned subscription after every mutation outcome, including
      // a next-action authentication whose reconciliation is still pending.
      await fetchSubscription();
      setOperation('');
    }
  }, [fetchSubscription]);

  const checkBillingOperation = useCallback(async (operationId) => {
    const response = await api.get(`/api/safepay/subscription/operations/${operationId}`);
    if (response.data?.completed) {
      const attempt = billingAttemptRef.current;
      if (attempt) await clearPersistedMutationAttemptFromLedger(AsyncStorage, attempt.storageKey, attempt.fingerprint, attempt.key);
      setBillingQuote(null);
      Alert.alert('Subscription updated', response.data.msg || 'Your subscription is ready.');
    } else {
      Alert.alert('Billing status', response.data?.status === 'failed'
        ? 'The payment was not completed. Review your payment card before trying again.'
        : 'Your exact payment is still being verified. No extra payment will be started by checking its status.');
    }
    await fetchSubscription();
    return response.data;
  }, [fetchSubscription]);

  const openCheckout = useCallback(async (plan, kind = 'enrollment') => {
    if (billingBusyRef.current) return;
    if (subscription?.billingProvider === 'stripe' && ['active', 'free_period', 'past_due'].includes(subscription.status)) {
      Alert.alert('Existing subscription', 'This existing plan is still billed through Stripe. Manage it on the website until it ends, so you are not subscribed twice.',
        [{ text: 'Close' }, { text: 'Open website', onPress: () => WebBrowser.openBrowserAsync('https://rozare.com/seller-dashboard/subscription') }]);
      return;
    }
    billingBusyRef.current = true;
    setOperation(`checkout-${plan}`);
    try {
      if (subscription?.pendingBillingOperation) {
        await checkBillingOperation(subscription.pendingBillingOperation);
        return;
      }
      const cardResponse = await api.get('/api/safepay/cards');
      const cards = Array.isArray(cardResponse.data?.cards) ? cardResponse.data.cards.filter(card => card.usable !== false) : null;
      if (!Array.isArray(cards) || !cards.length) {
        Alert.alert('Add a payment card', 'Add a card with Safepay first. You will then review and approve your subscription here. No Safepay account is needed.',
          [{ text: 'Not now', style: 'cancel' }, { text: 'Add card', onPress: () => navigation.navigate('PaymentMethods') }]);
        return;
      }
      const coupon = kind === 'enrollment' && founderCouponApplied ? subscription?.founderPromotion?.code || '' : '';
      const includeMetaAds = plan === 'elite' && eliteMetaAds;
      const storageKey = createScopedMutationStorageKey('rozare_safepay_billing_v1', currentUser?._id || currentUser?.id);
      const fingerprint = JSON.stringify({ kind, plan, includeMetaAds, coupon, version: subscription?.billingVersion || 0 });
      const attempt = await getOrCreatePersistedMutationAttemptInLedger({ storage: AsyncStorage, storageKey, fingerprint, keyPrefix: 'mobile-billing' });
      billingAttemptRef.current = { ...attempt, storageKey, fingerprint };
      const response = await api.post(kind === 'retry' ? '/api/safepay/subscription/retry-quote' : '/api/safepay/subscription/quote', {
        clientSurface: 'mobile', kind, plan, includeMetaAds, couponCode: coupon, requestKey: attempt.key,
        ...(kind === 'retry' ? { failedOperation: subscription?.failedBillingOperation } : {}),
      });
      const quote = response.data;
      if (!quote?.quoteId || !isSafeMinor(quote.monthlyAmountMinor) || !isSafeMinor(quote.dueNowMinor, { positive: false }) || quote.currency !== 'USD') {
        throw new Error('The billing quote could not be verified.');
      }
      if (['accepted', 'awaiting_payment', 'applied'].includes(quote.status)) {
        await checkBillingOperation(quote.quoteId);
        return;
      }
      if (quote.status !== 'quoted' || new Date(quote.expiresAt).getTime() <= Date.now()) {
        await clearPersistedMutationAttemptFromLedger(AsyncStorage, storageKey, fingerprint, attempt.key);
        throw new Error('This quote expired. Tap the plan again to review a fresh quote.');
      }
      setBillingCards(cards);
      setBillingCardId(cards.some(card => card.id === cardResponse.data.defaultPaymentMethodId) ? cardResponse.data.defaultPaymentMethodId : cards[0].id);
      setBillingConsent(false);
      setBillingQuote(quote);
    } catch (requestError) {
      Alert.alert('Checkout unavailable', requestError.response?.data?.msg || requestError.message || 'Please retry the same billing attempt.');
    } finally {
      billingBusyRef.current = false;
      setOperation('');
    }
  }, [currentUser, eliteMetaAds, founderCouponApplied, subscription, navigation, checkBillingOperation]);

  const changeSubscriptionCard = useCallback(async () => {
    if (billingBusyRef.current) return;
    billingBusyRef.current = true; setOperation('change-card');
    try {
      const response = await api.get('/api/safepay/cards');
      const cards = Array.isArray(response.data?.cards) ? response.data.cards.filter(card => card.usable !== false) : [];
      if (!cards.length) {
        Alert.alert('Add a payment card', 'Save a card first, then choose it for subscription billing.',
          [{ text: 'Close' }, { text: 'Add card', onPress: () => navigation.navigate('PaymentMethods') }]);
        return;
      }
      if (!isSafeMinor(subscription?.currentMonthlyAmountCents)) throw new Error('Refresh your subscription to verify its billing price.');
      setBillingCards(cards); setBillingCardId(cards[0].id); setBillingConsent(false);
      setBillingQuote({ kind: 'card_change', planName: subscription.planName, dueNowMinor: 0,
        monthlyAmountMinor: subscription.currentMonthlyAmountCents, billingVersion: subscription.billingVersion,
        consentVersion: 'rozare-safepay-recurring-v1',
        terms: `Authorize this card for your existing ${formatUsd(subscription.currentMonthlyAmountCents)} USD/month agreement. Changing the card does not collect a payment or change your renewal date.` });
    } catch (requestError) {
      Alert.alert('Could not load billing cards', requestError.response?.data?.msg || requestError.message);
    } finally { billingBusyRef.current = false; setOperation(''); }
  }, [subscription, navigation]);

  const acceptBillingQuote = useCallback(async () => {
    if (billingBusyRef.current || !billingQuote || !billingConsent || !billingCardId) return;
    billingBusyRef.current = true;
    setOperation('confirm-billing');
    try {
      if (billingQuote.kind === 'card_change') {
        const response = await api.patch('/api/safepay/subscription/card', { clientSurface: 'mobile', cardId: billingCardId,
          billingVersion: billingQuote.billingVersion, consentAccepted: true, consentVersion: billingQuote.consentVersion });
        setBillingQuote(null); Alert.alert('Subscription card updated', response.data?.msg);
        await fetchSubscription();
        return;
      }
      await api.post('/api/safepay/subscription/accept', { clientSurface: 'mobile', quoteId: billingQuote.quoteId,
        cardId: billingCardId, consentAccepted: true, consentVersion: billingQuote.consentVersion });
      await checkBillingOperation(billingQuote.quoteId);
    } catch (requestError) {
      Alert.alert('Billing not confirmed', requestError.response?.data?.msg || 'Check your subscription before retrying. Your exact billing attempt is retained.');
      await fetchSubscription();
    } finally { billingBusyRef.current = false; setOperation(''); }
  }, [billingQuote, billingConsent, billingCardId, checkBillingOperation, fetchSubscription]);

  const confirmCancel = useCallback(() => {
    const founderWarning = model.founderRateActive
      ? '\n\nYour locked FIRST100 rate will be permanently lost when the subscription ends.'
      : '';
    const bonusWarning = subscription?.plan === 'starter' && subscription?.bonusFeaturesActive
      ? '\n\nAfter the plan ends, you have a 3-day grace period to resubscribe before remaining Starter bonus access is permanently lost.'
      : '';
    Alert.alert(
      'Cancel subscription?',
      `Your plan stays active until the current billing period ends. Your public store will then be hidden.${founderWarning}${bonusWarning}`,
      [
        { text: 'Keep plan', style: 'cancel' },
        {
          text: 'Cancel at period end',
          style: 'destructive',
          onPress: () => runMutation('cancel', () => api.post('/api/subscription/cancel'), 'Cancellation scheduled.'),
        },
      ],
    );
  }, [model.founderRateActive, runMutation, subscription]);

  const confirmUpgrade = useCallback(() => openCheckout('elite', 'upgrade'), [openCheckout]);

  const confirmDowngrade = useCallback(() => {
    Alert.alert(
      'Switch to Starter?',
      'You keep Elite until the current period ends, then Starter begins automatically. Meta ads, permanent Elite tools, themes and the higher featured-product allowance will end. You can undo this before the switch.',
      [
        { text: 'Keep Elite', style: 'cancel' },
        {
          text: 'Schedule downgrade',
          style: 'destructive',
          onPress: () => runMutation(
            'downgrade',
            () => api.post('/api/subscription/downgrade-to-starter'),
            'Downgrade scheduled.',
          ),
        },
      ],
    );
  }, [runMutation]);

  const applyCoupon = useCallback(() => {
    const promotion = subscription?.founderPromotion;
    const normalized = couponCode.trim().toUpperCase();
    if (!promotion || normalized !== promotion.code) {
      Alert.alert('Invalid coupon', 'Enter a valid subscription coupon code.');
      return;
    }
    if (!promotion.available || !promotion.sellerEligible) {
      Alert.alert(
        'Coupon unavailable',
        promotion.forfeited
          ? 'This account already used and forfeited its founder rate.'
          : 'This founder offer is not available for this account.',
      );
      return;
    }
    setCouponCode(normalized);
    setFounderCouponApplied(true);
  }, [couponCode, subscription?.founderPromotion]);

  if (loading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Subscription"
        subtitle="Loading your plan and billing access"
        icon="diamond-outline"
        variant="dashboard"
      />
    );
  }

  if (!subscription) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader
            navigation={navigation}
            title="Subscription"
            subtitle="Plans, benefits and billing control"
            icon="diamond-outline"
          />
          <View style={styles.fullErrorState}>
            <SellerInlineError
              title="Subscription unavailable"
              message={error || 'We could not load your current plan. No billing action is available until this refreshes.'}
              onRetry={() => fetchSubscription({ initial: true })}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (!model.pricingAvailable) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader
            navigation={navigation}
            title="Subscription"
            subtitle="Plans, benefits and billing control"
            icon="diamond-outline"
          />
          <View style={styles.fullErrorState}>
            <SellerInlineError
              title="Live pricing unavailable"
              message="Plan prices could not be verified. Billing actions are disabled so an outdated price is never shown or charged."
              onRetry={() => fetchSubscription({ initial: true })}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const planName = model.isSubscribed
    ? subscription?.planName || (model.isElite ? 'Rozare Elite' : 'Rozare Starter')
    : model.isTrial
      ? 'Rozare Free Trial'
      : 'No active plan';
  const planEndDate = formatDate(subscription?.freePeriodEndDate || subscription?.currentPeriodEnd);
  const trialEndDate = formatDate(subscription?.trialEndDate);
  const starterBonusDays = daysUntil(subscription?.bonusExpiryDate);
  const bonusExpiryDate = formatDate(subscription?.bonusExpiryDate);
  const bonusGraceDeadline = formatDate(subscription?.bonusGraceDeadline);
  const bonusExpiredPermanently = Boolean(
    subscription?.bonusFeaturesExpiredPermanently && subscription?.plan !== 'elite',
  );
  const starterBonusUnavailable = Boolean(
    subscription?.bonusFeaturesExpiredPermanently
    || (model.isElite && subscription?.starterBonusPeriodUsed),
  );
  const blockedFromTrial = model.isBlocked && (
    subscription?.plan === 'free_trial'
    || /trial/i.test(String(subscription?.blockedReason || ''))
  );
  const bonusAboutToExpire = model.isStarter
    && subscription?.bonusFeaturesActive
    && starterBonusDays > 0
    && starterBonusDays <= 7;
  const catalogFeatures = subscription?.catalog?.features;
  const trialFeatures = featureItems(catalogFeatures?.trial, TRIAL_FEATURES);
  const starterFeatures = featureItems(catalogFeatures?.starter, STARTER_FEATURES);
  const bonusFeatures = featureItems(catalogFeatures?.bonus, BONUS_FEATURES, 'sparkles-outline');
  const eliteOnlyFeatures = featureItems(catalogFeatures?.eliteOnly, ELITE_ONLY_FEATURES, 'diamond-outline');
  const elitePlanFeatures = [
    ['checkmark-done-outline', 'Everything in Starter'],
    ['star-outline', `Featured product highlighting (${subscription?.catalog?.elite?.featuredProductLimit || 12} products)`],
    ...bonusFeatures,
    ...eliteOnlyFeatures,
  ];
  const founderPromotion = subscription?.founderPromotion;
  const founderCatalog = subscription?.catalog?.founderPromotion;
  const founderCode = subscription?.founderOffer?.code
    || founderPromotion?.code
    || founderCatalog?.code
    || 'FIRST100';
  const founderDiscountPercent = Number.isSafeInteger(subscription?.founderOffer?.discountPercent)
    ? subscription.founderOffer.discountPercent
    : Number.isSafeInteger(founderPromotion?.discountPercent)
      ? founderPromotion.discountPercent
      : Number.isSafeInteger(founderCatalog?.discountPercent)
        ? founderCatalog.discountPercent
        : null;
  const founderReservationMinutes = Number.isSafeInteger(founderPromotion?.checkoutReservationMinutes)
    && founderPromotion.checkoutReservationMinutes > 0
    ? founderPromotion.checkoutReservationMinutes
    : null;
  const founderPricingSelected = model.founderRateActive || founderCouponApplied;
  const displayedStarterPrice = founderPricingSelected
    ? model.pricing.starter.founderAmountCents
    : model.pricing.starter.standardAmountCents;
  const displayedEliteBasePrice = founderPricingSelected
    ? model.pricing.elite.founderAmountCents
    : model.pricing.elite.standardAmountCents;
  const displayedElitePrice = displayedEliteBasePrice
    + (eliteMetaAds ? model.pricing.metaAdsAddonCents : 0);

  return (
    <GlassBackground>
      <Modal visible={!!billingQuote} transparent animationType="slide" onRequestClose={() => { if (!billingBusyRef.current) setBillingQuote(null); }}>
        <View style={{ flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <GlassPanel style={{ maxHeight: '92%', padding: spacing.lg, backgroundColor: palette.colors.background }}>
            <KeyboardAwareFormScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md }}>
              <Text style={{ color: palette.colors.text, fontSize: fontSize.xl, fontWeight: '700' }}>Review your subscription</Text>
              <Text style={{ color: palette.colors.text, fontSize: fontSize.lg }}>{billingQuote?.planName}</Text>
              <Text style={{ color: palette.colors.text }}>Due now: {formatUsd(billingQuote?.dueNowMinor)} USD</Text>
              <Text style={{ color: palette.colors.text }}>Recurring price: {formatUsd(billingQuote?.monthlyAmountMinor)} USD/month</Text>
              {!!billingQuote?.freePeriodDays && <Text style={{ color: palette.colors.textSecondary }}>First {billingQuote.freePeriodDays} days free.</Text>}
              {!!billingQuote?.creditMinor && <Text style={{ color: palette.colors.textSecondary }}>Credit toward future billing: {formatUsd(billingQuote.creditMinor)} USD</Text>}
              <Text style={{ color: palette.colors.textSecondary }}>Payment card</Text>
              <Picker selectedValue={billingCardId} onValueChange={setBillingCardId} enabled={!operation} style={{ color: palette.colors.text }}>
                {billingCards.map(card => <Picker.Item key={card.id} label={`${String(card.brand || 'Card').toUpperCase()} •••• ${card.last4}`} value={card.id} />)}
              </Picker>
              <Text style={{ color: palette.colors.textSecondary, lineHeight: 21 }}>{billingQuote?.terms}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Switch value={billingConsent} onValueChange={setBillingConsent} disabled={!!operation} accessibilityLabel="Agree to the displayed subscription price and automatic renewal terms" />
                <Text style={{ flex: 1, color: palette.colors.text }}>I agree to this price and automatic renewal terms.</Text>
              </View>
              <TouchableOpacity accessibilityRole="button" disabled={!billingConsent || !billingCardId || !!operation} onPress={acceptBillingQuote}
                style={{ backgroundColor: palette.colors.primary, opacity: !billingConsent || operation ? 0.5 : 1, borderRadius: 14, padding: spacing.md, alignItems: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>{operation ? 'Verifying…' : billingQuote?.kind === 'card_change' ? 'Confirm card change' : 'Confirm subscription'}</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" disabled={!!operation} onPress={() => setBillingQuote(null)} style={{ padding: spacing.md, alignItems: 'center' }}>
                <Text style={{ color: palette.colors.textSecondary }}>Not now</Text>
              </TouchableOpacity>
            </KeyboardAwareFormScrollView>
          </GlassPanel>
        </View>
      </Modal>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Subscription"
          subtitle="Plans, benefits and billing control"
          icon="diamond-outline"
          rightIcon="refresh"
          onRightPress={() => fetchSubscription()}
        />

        <KeyboardAwareFormScrollView
          contentContainerStyle={styles.scroll}
          bottomOffset={32}
          showsVerticalScrollIndicator={false}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              tintColor={palette.colors.primary}
              onRefresh={() => {
                setRefreshing(true);
                fetchSubscription();
              }}
            />
          )}
        >
          {!!error && (
            <SellerInlineError
              compact
              title="Subscription unavailable"
              message={error}
              onRetry={() => fetchSubscription({ initial: true })}
            />
          )}

          {model.isBlocked && (
            <GlassPanel variant="card" style={styles.dangerBanner}>
              <View style={styles.bannerIconDanger}>
                <Ionicons name="lock-closed" size={21} color={palette.colors.error} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle}>Store temporarily hidden</Text>
                <Text style={styles.bannerText}>
                  {subscription?.blockedReason || 'Subscribe to reactivate your store, products and subdomain.'}
                </Text>
                {subscription?.bonusGraceDaysRemaining > 0 && (
                  <Text style={styles.graceText}>
                    {subscription.bonusGraceDaysRemaining} day{subscription.bonusGraceDaysRemaining === 1 ? '' : 's'} remaining to re-subscribe and keep the unused part of your Starter bonus period{bonusGraceDeadline ? ` · deadline ${bonusGraceDeadline}` : ''}. After the grace period, those bonus tools are permanently removed from Starter.
                  </Text>
                )}
              </View>
            </GlassPanel>
          )}

          {model.isPastDue && (
            <GlassPanel variant="card" style={styles.warningBanner}>
              <View style={styles.bannerIconWarning}>
                <Ionicons name="alert-circle" size={21} color={palette.colors.warning} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle}>Payment needs attention</Text>
                <Text style={styles.bannerText}>
                  Your renewal is not confirmed. Review your saved card and the billing status before starting another payment, or contact support.
                </Text>
              </View>
            </GlassPanel>
          )}

          <LinearGradient colors={palette.gradients.cta} style={styles.hero}>
            <View style={styles.heroTop}>
              <View style={styles.heroIcon}>
                <Ionicons name={model.isElite ? 'diamond' : 'sparkles'} size={24} color="#fff" />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.heroEyebrow}>CURRENT ACCESS</Text>
                <Text style={styles.heroTitle}>{planName}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: `${statusColor}25` }]}>
                <Ionicons name={activeStatus[1]} size={13} color="#fff" />
                <Text style={styles.statusPillText}>{activeStatus[0]}</Text>
              </View>
            </View>
            <Text style={styles.heroDescription}>
              {model.isSubscribed
                ? subscription?.status === 'free_period'
                  ? `Your introductory period${planEndDate ? ` runs until ${planEndDate}` : ' is active'}.`
                  : model.isEnding
                    ? `Your plan remains active${planEndDate ? ` until ${planEndDate}` : ' until the current period ends'}.`
                    : model.hasPendingDowngrade
                      ? `Elite remains active${planEndDate ? ` until ${planEndDate}` : ' through this billing period'}, then Starter begins.`
                      : `Your seller workspace and public store are active${planEndDate ? ` through ${planEndDate}` : ''}.`
                : model.isTrial
                  ? `${subscription?.trialDaysRemaining ?? 0} day${subscription?.trialDaysRemaining === 1 ? '' : 's'} remaining${trialEndDate ? ` · ends ${trialEndDate}` : ''}.`
                  : 'Choose a plan below to make your store and seller tools active.'}
            </Text>

            <View style={styles.heroMetaRow}>
              <View style={styles.heroMetaItem}>
                <Ionicons name="chatbubbles-outline" size={15} color="rgba(255,255,255,0.9)" />
                <Text style={styles.heroMetaText}>Unlimited seller AI</Text>
              </View>
              <View style={styles.heroMetaItem}>
                <Ionicons name="shield-checkmark-outline" size={15} color="rgba(255,255,255,0.9)" />
                <Text style={styles.heroMetaText}>{subscription?.billingProvider === 'stripe' ? 'Existing Stripe plan' : 'Safepay secured'}</Text>
              </View>
            </View>
          </LinearGradient>

          {(model.isTrial || model.isBlocked || model.isSubscribed) && (
            <GlassPanel variant="card" style={styles.accessCard}>
              <SellerSectionHeader
                title={model.isBlocked ? 'Access currently unavailable' : 'Your current features'}
                subtitle={model.isTrial
                  ? `Starter features and eligible Elite tools are available during your ${subscription?.catalog?.trial?.days || 15}-day free trial`
                  : model.isBlocked
                      ? 'Subscribe to restore your public store and seller tools'
                    : model.isElite
                      ? 'All Starter and Elite features are active'
                      : 'Your Starter plan features are active'}
                icon={model.isBlocked ? 'lock-closed-outline' : 'checkmark-circle-outline'}
              />

              <Text style={styles.featureGroupTitle}>
                {model.isTrial ? 'FEATURES FROM STARTER' : model.isBlocked ? 'FEATURES TO RESTORE' : 'ACTIVE STARTER FEATURES'}
              </Text>
              <FeatureList
                items={model.isTrial || blockedFromTrial ? trialFeatures : starterFeatures}
                styles={styles}
                palette={palette}
                accent={model.isBlocked ? palette.colors.error : palette.colors.success}
                available={!model.isBlocked}
              />

              {(model.isTrial || model.isElite || subscription?.bonusFeaturesActive || bonusExpiredPermanently || model.isBlocked) && (
                <View style={styles.featureGroup}>
                  <Text style={styles.featureGroupTitle}>
                    ELITE GROWTH TOOLS{model.isElite && model.isSubscribed ? ' · PERMANENT WHILE ELITE IS ACTIVE' : ''}
                  </Text>
                  {bonusExpiredPermanently && model.isStarter ? (
                    <Text style={styles.featureGroupNote}>
                      Your Starter bonus period and grace period have ended. Upgrade to Elite to restore these tools.
                    </Text>
                  ) : (
                    <FeatureList
                      items={bonusFeatures}
                      styles={styles}
                      palette={palette}
                      accent={model.isBlocked ? palette.colors.error : palette.colors.secondary}
                      available={!model.isBlocked}
                    />
                  )}
                </View>
              )}

              {model.isElite && (
                <View style={styles.featureGroup}>
                  <Text style={styles.featureGroupTitle}>ELITE-ONLY FEATURES</Text>
                  <FeatureList
                    items={eliteOnlyFeatures}
                    styles={styles}
                    palette={palette}
                    accent={model.isBlocked ? palette.colors.error : palette.colors.secondary}
                    available={!model.isBlocked}
                  />
                  <View style={styles.allowanceRow}>
                    <Ionicons name="star-outline" size={15} color={model.isBlocked ? palette.colors.error : palette.colors.secondary} />
                    <Text style={[styles.allowanceText, model.isBlocked && styles.featureTextUnavailable]}>
                      Featured product highlighting ({subscription?.catalog?.elite?.featuredProductLimit || 12} products)
                    </Text>
                    <Ionicons name={model.isBlocked ? 'close' : 'checkmark'} size={15} color={model.isBlocked ? palette.colors.error : palette.colors.success} />
                  </View>
                </View>
              )}
            </GlassPanel>
          )}

          {subscription?.billingProvider === 'safepay' && (
            <GlassPanel variant="card" style={{ padding: spacing.md, gap: spacing.sm }}>
              {!!subscription.pendingBillingOperation && <ActionButton label="Check billing status" styles={styles} palette={palette}
                disabled={!!operation} onPress={() => openCheckout(subscription.plan, 'retry')} />}
              {!subscription.pendingBillingOperation && !!subscription.failedBillingOperation && subscription.automaticRenewal && (
                <ActionButton label="Review and retry renewal" styles={styles} palette={palette} disabled={!!operation}
                  onPress={() => openCheckout(subscription.plan, 'retry')} />
              )}
              {subscription.automaticRenewal && !subscription.pendingBillingOperation && (
                <ActionButton label="Change subscription card" icon="card-outline" tone="muted" styles={styles} palette={palette}
                  disabled={!!operation} onPress={changeSubscriptionCard} />
              )}
              {model.isPastDue && <ActionButton label="Cancel automatic renewal" tone="muted" styles={styles} palette={palette}
                disabled={!!operation} onPress={confirmCancel} />}
            </GlassPanel>
          )}

          {model.founderRateActive && (
            <GlassPanel variant="card" style={styles.founderCard}>
              <View style={styles.founderIcon}>
                <Ionicons name="pricetag" size={18} color={palette.colors.success} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.founderTitle}>FIRST100 founder rate locked</Text>
                <Text style={styles.bannerText}>
                  Your {founderCode} price{founderDiscountPercent ? ` gives an extra ${founderDiscountPercent}% off the standard launch price and` : ''} follows Starter/Elite plan changes while the subscription stays uninterrupted. It is permanently lost after the subscription ends.
                </Text>
              </View>
            </GlassPanel>
          )}

          {!model.founderRateActive && subscription?.founderPromotion?.forfeited && (
            <GlassPanel variant="card" style={styles.warningBanner}>
              <View style={styles.bannerIconWarning}>
                <Ionicons name="pricetag-outline" size={21} color={palette.colors.warning} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle}>FIRST100 founder rate forfeited</Text>
                <Text style={styles.bannerText}>
                  This account previously ended its founder subscription. The founder rate cannot be claimed again, but standard Starter and Elite pricing remains available.
                </Text>
              </View>
            </GlassPanel>
          )}

          {model.hasPendingDowngrade && (
            <GlassPanel variant="card" style={styles.pendingCard}>
              <View style={styles.pendingTop}>
                <View style={styles.pendingIcon}>
                  <Ionicons name="swap-horizontal" size={18} color={palette.colors.warning} />
                </View>
                <View style={styles.bannerCopy}>
                  <Text style={styles.bannerTitle}>Switch to Starter scheduled</Text>
                  <Text style={styles.bannerText}>Keep Elite benefits until the current period ends, or cancel the switch now.</Text>
                </View>
              </View>
              <ActionButton
                label="Keep Elite"
                icon="refresh-outline"
                loading={operation === 'cancel-downgrade'}
                onPress={() => runMutation(
                  'cancel-downgrade',
                  () => api.post('/api/subscription/cancel-downgrade'),
                  'You will remain on Elite.',
                )}
                styles={styles}
                palette={palette}
              />
            </GlassPanel>
          )}

          {model.isEnding && (
            <GlassPanel variant="card" style={styles.pendingCard}>
              <View style={styles.pendingTop}>
                <View style={styles.bannerIconDanger}>
                  <Ionicons name="calendar-outline" size={18} color={palette.colors.error} />
                </View>
                <View style={styles.bannerCopy}>
                  <Text style={styles.bannerTitle}>Cancellation scheduled</Text>
                  <Text style={styles.bannerText}>
                    Your plan remains active for {periodDaysRemaining} more day{periodDaysRemaining === 1 ? '' : 's'}{planEndDate ? `, through ${planEndDate}` : ''}. Resume before it ends to keep your store live and preserve any founder rate. If it ends, your store and products are hidden.
                  </Text>
                </View>
              </View>
              <ActionButton
                label="Resume subscription"
                icon="play-circle-outline"
                loading={operation === 'resume'}
                onPress={() => runMutation(
                  'resume',
                  () => api.post('/api/subscription/resume'),
                  'Subscription resumed.',
                )}
                styles={styles}
                palette={palette}
              />
            </GlassPanel>
          )}

          {subscription?.plan === 'starter' && subscription?.bonusFeaturesActive && starterBonusDays > 0 && (
            <GlassPanel variant="card" style={bonusAboutToExpire ? styles.warningBanner : styles.bonusCard}>
              <View style={styles.bonusIcon}>
                <Ionicons name={bonusAboutToExpire ? 'alert-circle-outline' : 'gift-outline'} size={19} color={bonusAboutToExpire ? palette.colors.warning : palette.colors.secondary} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle}>{bonusAboutToExpire ? `Bonus features expire in ${starterBonusDays} day${starterBonusDays === 1 ? '' : 's'}` : 'Starter bonus tools active'}</Text>
                <Text style={styles.bannerText}>
                  Advanced analytics, smart descriptions and tags, priority support, coupons, and bulk promotion tools remain available for {starterBonusDays} more day{starterBonusDays === 1 ? '' : 's'}{bonusExpiryDate ? `, through ${bonusExpiryDate}` : ''}. Elite keeps them permanently while active.
                </Text>
              </View>
            </GlassPanel>
          )}

          {model.isStarter && bonusExpiredPermanently && (
            <GlassPanel variant="card" style={styles.bonusCard}>
              <View style={styles.bonusIcon}>
                <Ionicons name="hourglass-outline" size={19} color={palette.colors.secondary} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle}>Bonus features expired</Text>
                <Text style={styles.bannerText}>
                  Core Starter features remain active. Upgrade to Elite to restore the growth tools permanently while Elite is active.
                </Text>
              </View>
            </GlassPanel>
          )}

          {!model.isSubscribed && !model.isPastDue && founderPromotion?.sellerEligible && founderPromotion?.available && (
            <GlassPanel variant="card" style={styles.couponCard}>
              <SellerSectionHeader
                title="Founder pricing"
                subtitle={founderPromotion.sellerHasReservation
                  ? 'A FIRST100 place is reserved for this account.'
                  : `${founderPromotion.remaining ?? 0} founder place${founderPromotion.remaining === 1 ? '' : 's'} remaining.`}
                icon="pricetag-outline"
              />
              <View style={styles.couponRow}>
                <TextInput
                  value={couponCode}
                  onChangeText={(value) => {
                    setCouponCode(value.toUpperCase());
                    setFounderCouponApplied(false);
                  }}
                  placeholder="Coupon code"
                  placeholderTextColor={palette.colors.textLight}
                  autoCapitalize="characters"
                  style={styles.couponInput}
                  accessibilityLabel="Subscription coupon code"
                />
                <TouchableOpacity
                  style={[styles.couponButton, founderCouponApplied && styles.couponButtonApplied]}
                  onPress={founderCouponApplied
                    ? () => {
                      setFounderCouponApplied(false);
                      setCouponCode('');
                    }
                    : applyCoupon}
                >
                  <Text style={styles.couponButtonText}>{founderCouponApplied ? 'Remove' : 'Apply'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.couponNote}>
                Use {founderCode}{founderDiscountPercent ? ` for an extra ${founderDiscountPercent}% off` : ''}: Starter becomes {formatUsd(model.pricing.starter.founderAmountCents)}/month and Elite becomes {formatUsd(model.pricing.elite.founderAmountCents)}/month. {founderReservationMinutes
                  ? `Checkout reserves a place for ${founderReservationMinutes} minutes.`
                  : 'Checkout reserves your place temporarily.'} The founder price is claimed only after Rozare verifies the completed subscription activation.
              </Text>
            </GlassPanel>
          )}

          <SellerSectionHeader
            title="Choose your plan"
            subtitle="Prices and eligibility are loaded from your account"
            icon="layers-outline"
          />

          <GlassPanel variant="strong" style={[styles.planCard, model.isStarter && styles.currentStarterCard]}>
            <View style={styles.planTop}>
              <View style={styles.planTitleRow}>
                <View style={styles.starterIcon}>
                  <Ionicons name="rocket-outline" size={21} color={palette.colors.primary} />
                </View>
                <View style={styles.planTitleCopy}>
                  <Text style={styles.planTitle}>Rozare Starter</Text>
                  <Text style={styles.planSubtitle}>Core selling tools plus a {subscription?.catalog?.starter?.bonusFeaturesMonths || 6}-month bonus window</Text>
                </View>
              </View>
              {model.isStarter && <Text style={styles.currentBadge}>CURRENT</Text>}
            </View>

            <View style={styles.priceRow}>
              <Text style={styles.listPrice}>{formatUsd(model.pricing.starter.listAmountCents)}</Text>
              {founderPricingSelected && (
                <Text style={styles.listPrice}>{formatUsd(model.pricing.starter.standardAmountCents)}</Text>
              )}
              <Text style={styles.price}>{formatUsd(displayedStarterPrice)}</Text>
              <Text style={styles.period}>/month</Text>
            </View>
            <Text style={styles.priceNote}>
              {model.pricing.starter.advertisedDiscountPercent}% standard launch discount from {formatUsd(model.pricing.starter.listAmountCents)} to {formatUsd(model.pricing.starter.standardAmountCents)}.{founderPricingSelected && founderDiscountPercent ? ` ${founderCode} adds ${founderDiscountPercent}% off that standard launch price.` : ''} {model.getsIntroductoryFreePeriod ? `${model.pricing.starter.freePeriodDays}-day one-time intro, then ` : ''}{formatUsd(displayedStarterPrice)}/month · cancel anytime
            </Text>

            <FeatureList items={starterFeatures} styles={styles} palette={palette} accent={palette.colors.primary} />

            <View style={styles.featureGroup}>
              <Text style={styles.featureGroupTitle}>
                ELITE GROWTH TOOLS · {starterBonusUnavailable
                  ? 'NOT INCLUDED FOR THIS ACCOUNT'
                  : model.isStarter && subscription?.bonusFeaturesActive && starterBonusDays > 0
                    ? `${starterBonusDays} DAY${starterBonusDays === 1 ? '' : 'S'} REMAINING`
                    : `FIRST ${subscription?.catalog?.starter?.bonusFeaturesMonths || 6} MONTHS`}
              </Text>
              <FeatureList
                items={bonusFeatures}
                styles={styles}
                palette={palette}
                accent={palette.colors.secondary}
                available={!starterBonusUnavailable}
              />
              {starterBonusUnavailable && (
                <Text style={styles.featureGroupNote}>Upgrade to Elite to restore these growth tools while Elite is active.</Text>
              )}
            </View>

            {model.isStarter ? (
              <>
                <View style={styles.currentPlanBar}>
                  <Ionicons name="checkmark-circle" size={17} color={palette.colors.success} />
                  <Text style={styles.currentPlanText}>Your current plan</Text>
                </View>
                {!subscription?.cancelledAt && (
                  <ActionButton
                    label="Cancel subscription"
                    icon="close-circle-outline"
                    tone="danger"
                    loading={operation === 'cancel'}
                    onPress={confirmCancel}
                    styles={styles}
                    palette={palette}
                  />
                )}
              </>
            ) : model.isElite && model.isSubscribed ? (
              <ActionButton
                label={model.hasPendingDowngrade ? 'Starter scheduled' : 'Downgrade to Starter'}
                icon="arrow-down-circle-outline"
                tone="muted"
                disabled={model.hasPendingDowngrade}
                loading={operation === 'downgrade'}
                onPress={confirmDowngrade}
                styles={styles}
                palette={palette}
              />
            ) : !model.isPastDue ? (
              <ActionButton
                label={model.getsIntroductoryFreePeriod ? `Start with ${model.pricing.starter.freePeriodDays} days free` : `Choose Starter · ${formatUsd(displayedStarterPrice)}/mo`}
                icon="card-outline"
                loading={operation === 'checkout-starter'}
                onPress={() => openCheckout('starter')}
                styles={styles}
                palette={palette}
              />
            ) : null}
          </GlassPanel>

          <GlassPanel variant="strong" style={[styles.planCard, styles.eliteCard, model.isElite && model.isSubscribed && styles.currentEliteCard]}>
            <View style={styles.recommendedBadge}>
              <Ionicons name="sparkles" size={11} color="#fff" />
              <Text style={styles.recommendedText}>RECOMMENDED</Text>
            </View>
            <View style={styles.planTop}>
              <View style={styles.planTitleRow}>
                <LinearGradient colors={palette.gradients.cta} style={styles.eliteIcon}>
                  <Ionicons name="diamond-outline" size={21} color="#fff" />
                </LinearGradient>
                <View style={styles.planTitleCopy}>
                  <Text style={styles.planTitle}>Rozare Elite</Text>
                  <Text style={styles.planSubtitle}>Permanent growth tools and higher visibility</Text>
                </View>
              </View>
              {model.isElite && model.isSubscribed && <Text style={styles.eliteCurrentBadge}>CURRENT</Text>}
            </View>

            <View style={styles.priceRow}>
              <Text style={styles.listPrice}>{formatUsd(model.pricing.elite.listAmountCents)}</Text>
              {founderPricingSelected && (
                <Text style={styles.listPrice}>{formatUsd(model.pricing.elite.standardAmountCents)}</Text>
              )}
              <Text style={styles.price}>{formatUsd(displayedElitePrice)}</Text>
              <Text style={styles.period}>/month</Text>
            </View>
            <Text style={styles.priceNote}>
              {model.pricing.elite.advertisedDiscountPercent}% standard launch discount from {formatUsd(model.pricing.elite.listAmountCents)} to {formatUsd(model.pricing.elite.standardAmountCents)}.{founderPricingSelected && founderDiscountPercent ? ` ${founderCode} adds ${founderDiscountPercent}% off that standard launch price.` : ''} {model.getsIntroductoryFreePeriod ? `${model.pricing.elite.freePeriodDays}-day one-time intro, then ` : ''}{formatUsd(displayedElitePrice)}/month{eliteMetaAds ? ` including ${formatUsd(model.pricing.metaAdsAddonCents)} Meta ads` : ''} · cancel anytime
            </Text>

            <FeatureList items={elitePlanFeatures} styles={styles} palette={palette} accent={palette.colors.secondary} />

            <TouchableOpacity
              style={[
                styles.metaCard,
                eliteMetaAds && styles.metaCardSelected,
                (model.hasPendingDowngrade || model.isEnding) && styles.buttonDisabled,
              ]}
              disabled={model.hasPendingDowngrade || model.isEnding}
              onPress={() => setEliteMetaAds((value) => !value)}
              activeOpacity={0.8}
              accessibilityRole="switch"
              accessibilityState={{
                checked: eliteMetaAds,
                disabled: model.hasPendingDowngrade || model.isEnding,
              }}
            >
              <View style={styles.metaIcon}>
                <Ionicons name="logo-facebook" size={18} color={palette.colors.info} />
              </View>
              <View style={styles.metaCopy}>
                <Text style={styles.metaTitle}>Include Meta ads</Text>
                <Text style={styles.metaDescription}>
                  {model.hasPendingDowngrade || model.isEnding
                    ? 'Keep or resume Elite before changing add-ons'
                    : `Optional ${formatUsd(model.pricing.metaAdsAddonCents)}/month Elite add-on`}
                </Text>
              </View>
              <Switch
                value={eliteMetaAds}
                onValueChange={setEliteMetaAds}
                disabled={model.hasPendingDowngrade || model.isEnding}
                trackColor={{ false: palette.colors.grayLighter, true: palette.colors.primaryLighter }}
                thumbColor={eliteMetaAds ? palette.colors.primary : palette.colors.white}
              />
            </TouchableOpacity>

            {model.isElite && model.isSubscribed ? (
              <>
                <View style={styles.currentPlanBarElite}>
                  <Ionicons name="checkmark-circle" size={17} color={palette.colors.secondary} />
                  <Text style={styles.currentPlanText}>Your current plan · {formatUsd(model.activeElitePrice)}/month</Text>
                </View>
                {model.metaSelectionChanged && !model.hasPendingDowngrade && !model.isEnding && (
                  <ActionButton
                    label="Apply Meta ads change"
                    icon="megaphone-outline"
                    loading={operation === 'upgrade'}
                    onPress={confirmUpgrade}
                    styles={styles}
                    palette={palette}
                  />
                )}
                {!subscription?.cancelledAt && !model.hasPendingDowngrade && (
                  <ActionButton
                    label="Cancel subscription"
                    icon="close-circle-outline"
                    tone="danger"
                    loading={operation === 'cancel'}
                    onPress={confirmCancel}
                    styles={styles}
                    palette={palette}
                  />
                )}
              </>
            ) : model.isStarter ? (
              <ActionButton
                label={`Upgrade to Elite · ${formatUsd(displayedElitePrice)}/mo`}
                icon="arrow-up-circle-outline"
                loading={operation === 'upgrade'}
                onPress={confirmUpgrade}
                styles={styles}
                palette={palette}
              />
            ) : !model.isPastDue ? (
              <ActionButton
                label={model.getsIntroductoryFreePeriod ? `Start with ${model.pricing.elite.freePeriodDays} days free` : `Choose Elite · ${formatUsd(displayedElitePrice)}/mo`}
                icon="card-outline"
                loading={operation === 'checkout-elite'}
                onPress={() => openCheckout('elite')}
                styles={styles}
                palette={palette}
              />
            ) : null}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.billingCard}>
            <SellerSectionHeader
              title="Billing details"
              subtitle="What happens next"
              icon="calendar-outline"
            />
            {[
              ['shield-checkmark-outline', 'New mobile payments use Safepay. No separate Safepay account is required.'],
              ['calendar-clear-outline', model.getsIntroductoryFreePeriod
                ? `The first paid subscription includes one introductory free period: ${model.pricing.starter.freePeriodDays} days on Starter or ${model.pricing.elite.freePeriodDays} days on Elite.`
                : 'Your one-time introductory free period has already been used.'],
              ['swap-horizontal-outline', 'Elite upgrades and Meta changes apply immediately and may be prorated. Elite-to-Starter changes begin after the current period.'],
              ['close-circle-outline', 'Cancellation takes effect at the end of the current period; access remains active until then.'],
            ].map(([icon, text]) => (
              <View key={text} style={styles.billingRow}>
                <Ionicons name={icon} size={17} color={palette.colors.primary} />
                <Text style={styles.billingText}>{text}</Text>
              </View>
            ))}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.billingCard}>
            <SellerSectionHeader
              title="How it works"
              subtitle="The complete subscription lifecycle"
              icon="git-commit-outline"
            />
            {[
              {
                title: 'Free Trial',
                text: `${subscription?.catalog?.trial?.days || 15} days to set up your store, list up to ${subscription?.catalog?.trial?.productListingLimit || 15} products, and start selling. No credit card is required.`,
              },
              {
                title: 'Subscribe',
                text: `Choose Starter (${formatUsd(displayedStarterPrice)}/month) or Elite (${formatUsd(displayedElitePrice)}/month with the options currently selected).`,
              },
              {
                title: 'One introductory period',
                text: model.getsIntroductoryFreePeriod
                  ? `${model.pricing.starter.freePeriodDays} days on Starter or ${model.pricing.elite.freePeriodDays} days on Elite after the first completed subscription checkout.`
                  : 'This account has already used its one-time introductory period; changing or restarting a plan does not grant another one.',
              },
              {
                title: 'Monthly billing',
                text: 'Your agreed recurring price is billed through your payment provider. Review exact charges before upgrades or add-on changes; downgrades begin at period end.',
              },
              {
                title: 'Bonus features',
                text: model.isElite
                  ? 'Included permanently while Elite remains active.'
                  : `Included during one ${subscription?.catalog?.starter?.bonusFeaturesMonths || 6}-month Starter bonus period. Restarting or switching plans does not grant a fresh period. After a Starter subscription ends, re-subscribe within ${subscription?.catalog?.bonusGraceDays || 3} days to preserve any unused bonus time.`,
              },
            ].map((step, index) => (
              <View key={step.title} style={styles.timelineRow}>
                <View style={styles.timelineNumber}>
                  <Text style={styles.timelineNumberText}>{index + 1}</Text>
                </View>
                <View style={styles.timelineCopy}>
                  <Text style={styles.timelineTitle}>{step.title}</Text>
                  <Text style={styles.timelineText}>{step.text}</Text>
                </View>
              </View>
            ))}
          </GlassPanel>

          <View style={styles.bottomSpace} />
        </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  fullErrorState: { flex: 1, justifyContent: 'center', paddingBottom: 72 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: 96 },
  dangerBanner: { flexDirection: 'row', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md, borderColor: `${p.colors.error}35` },
  warningBanner: { flexDirection: 'row', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md, borderColor: `${p.colors.warning}35` },
  bannerIconDanger: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.errorSubtle },
  bannerIconWarning: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.warningSubtle },
  bannerCopy: { flex: 1 },
  bannerTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.text },
  bannerText: { marginTop: 3, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  graceText: { marginTop: spacing.sm, fontSize: fontSize.xs, lineHeight: 17, fontWeight: fontWeight.bold, color: p.colors.error },
  hero: { borderRadius: borderRadius.xxxl, padding: spacing.xl, marginBottom: spacing.md, overflow: 'hidden' },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.26)' },
  heroCopy: { flex: 1 },
  heroEyebrow: { color: 'rgba(255,255,255,0.72)', fontSize: 9, letterSpacing: 1.25, fontWeight: fontWeight.extrabold },
  heroTitle: { marginTop: 2, color: '#fff', fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold },
  heroDescription: { marginTop: spacing.lg, color: 'rgba(255,255,255,0.86)', fontSize: fontSize.sm, lineHeight: 20 },
  statusPill: { maxWidth: '45%', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: borderRadius.full, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  statusPillText: { flexShrink: 1, color: '#fff', fontSize: 9, lineHeight: 12, fontWeight: fontWeight.extrabold },
  heroMetaRow: { marginTop: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  heroMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 7, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  heroMetaText: { color: 'rgba(255,255,255,0.9)', fontSize: 10, fontWeight: fontWeight.semibold },
  accessCard: { padding: spacing.lg, marginBottom: spacing.md },
  featureGroup: { marginTop: spacing.lg },
  featureGroupTitle: { marginBottom: spacing.xs, color: p.colors.textSecondary, fontSize: 9, letterSpacing: 0.7, fontWeight: fontWeight.extrabold },
  featureGroupNote: { paddingVertical: spacing.sm, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 18 },
  allowanceRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.border },
  allowanceText: { flex: 1, color: p.colors.text, fontSize: fontSize.xs, lineHeight: 17 },
  founderCard: { flexDirection: 'row', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md, borderColor: `${p.colors.success}30` },
  founderIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.successSubtle },
  founderTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.successDark },
  pendingCard: { padding: spacing.lg, marginBottom: spacing.md, borderColor: `${p.colors.warning}30` },
  pendingTop: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  pendingIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.warningSubtle },
  bonusCard: { flexDirection: 'row', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md, borderColor: `${p.colors.secondary}30` },
  bonusIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.secondarySubtle },
  couponCard: { padding: spacing.lg, marginBottom: spacing.xl },
  couponRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  couponInput: { flex: 1, minHeight: 46, paddingHorizontal: spacing.md, borderRadius: 14, color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold, backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.border },
  couponButton: { minWidth: 82, minHeight: 46, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: 14, backgroundColor: p.colors.primary },
  couponButtonApplied: { backgroundColor: p.colors.success },
  couponButtonText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  couponNote: { marginTop: spacing.sm, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  planCard: { position: 'relative', padding: spacing.xl, marginBottom: spacing.md, overflow: 'hidden' },
  eliteCard: { borderColor: `${p.colors.secondary}35` },
  currentStarterCard: { borderWidth: 2, borderColor: `${p.colors.success}50` },
  currentEliteCard: { borderWidth: 2, borderColor: `${p.colors.secondary}55` },
  recommendedBadge: { position: 'absolute', top: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: 6, borderBottomLeftRadius: 14, backgroundColor: p.colors.secondary },
  recommendedText: { color: '#fff', fontSize: 8, letterSpacing: 0.6, fontWeight: fontWeight.extrabold },
  planTop: { marginTop: spacing.xs, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  planTitleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  starterIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  eliteIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  planTitleCopy: { flex: 1 },
  planTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  planSubtitle: { marginTop: 2, fontSize: 10, lineHeight: 14, color: p.colors.textSecondary },
  currentBadge: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, overflow: 'hidden', backgroundColor: p.colors.successSubtle, color: p.colors.successDark, fontSize: 8, fontWeight: fontWeight.extrabold },
  eliteCurrentBadge: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, overflow: 'hidden', backgroundColor: p.colors.secondarySubtle, color: p.colors.secondaryDark, fontSize: 8, fontWeight: fontWeight.extrabold },
  priceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: spacing.xs, marginTop: spacing.xl },
  listPrice: { color: p.colors.textLight, fontSize: fontSize.sm, textDecorationLine: 'line-through' },
  price: { color: p.colors.text, fontSize: fontSize.title, fontWeight: fontWeight.extrabold },
  period: { color: p.colors.textSecondary, fontSize: fontSize.sm },
  priceNote: { marginTop: 2, marginBottom: spacing.lg, color: p.colors.textSecondary, fontSize: fontSize.xs },
  featureRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.border },
  featureIcon: { width: 25, height: 25, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  featureText: { flex: 1, color: p.colors.text, fontSize: fontSize.xs, lineHeight: 17 },
  featureTextUnavailable: { color: p.colors.textSecondary, textDecorationLine: 'line-through' },
  actionButton: { minHeight: 48, marginTop: spacing.lg, paddingHorizontal: spacing.lg, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  buttonPrimary: { backgroundColor: p.colors.primary },
  buttonDanger: { backgroundColor: p.colors.error },
  buttonMuted: { backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.borderStrong },
  buttonDisabled: { opacity: 0.55 },
  actionButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  actionButtonTextMuted: { color: p.colors.text },
  currentPlanBar: { minHeight: 44, marginTop: spacing.lg, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.successSubtle },
  currentPlanBarElite: { minHeight: 44, marginTop: spacing.lg, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.secondarySubtle },
  currentPlanText: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  metaCard: { marginTop: spacing.lg, padding: spacing.md, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.border },
  metaCardSelected: { borderColor: p.colors.primaryLighter, backgroundColor: p.colors.primarySubtle },
  metaIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.infoSubtle },
  metaCopy: { flex: 1 },
  metaTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  metaDescription: { marginTop: 2, color: p.colors.textSecondary, fontSize: 10 },
  billingCard: { padding: spacing.lg, marginTop: spacing.sm },
  billingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.border },
  billingText: { flex: 1, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 18 },
  timelineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.border },
  timelineNumber: { width: 27, height: 27, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  timelineNumberText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  timelineCopy: { flex: 1 },
  timelineTitle: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  timelineText: { marginTop: 2, color: p.colors.textSecondary, fontSize: 10, lineHeight: 16 },
  bottomSpace: { height: spacing.xl },
});
