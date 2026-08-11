import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
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
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

const SUBSCRIPTION_RETURN_URL = 'rozare://seller-subscription';

const CORE_FEATURES = [
  ['storefront-outline', 'Public store and unlimited product listings'],
  ['card-outline', 'Secure payments and order management'],
  ['globe-outline', 'Custom store subdomain'],
  ['logo-whatsapp', 'WhatsApp management and new-order alerts'],
  ['sparkles-outline', 'Up to 6 featured products'],
];

const ELITE_FEATURES = [
  ['checkmark-done-outline', 'Everything in Starter'],
  ['star-outline', 'Up to 12 featured products'],
  ['analytics-outline', 'Advanced analytics and growth tools'],
  ['pricetag-outline', 'Coupons, bulk tools and smart AI'],
  ['color-palette-outline', 'Custom store themes'],
  ['megaphone-outline', 'Rozare-run TikTok ads'],
];

const STATUS_PRESENTATION = {
  trial: ['Free trial', 'time-outline', 'primary'],
  free_period: ['Intro period', 'sparkles-outline', 'success'],
  active: ['Active', 'checkmark-circle-outline', 'success'],
  past_due: ['Payment due', 'alert-circle-outline', 'warning'],
  blocked: ['Blocked', 'lock-closed-outline', 'error'],
  cancelled: ['Cancelled', 'close-circle-outline', 'gray'],
};

const formatUsd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
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
  const pricing = {
    starter: {
      listAmountCents: 1175,
      standardAmountCents: 999,
      founderAmountCents: 599,
      advertisedDiscountPercent: 15,
      ...(safe.pricing?.starter || {}),
    },
    elite: {
      listAmountCents: 3093,
      standardAmountCents: 2165,
      founderAmountCents: 1299,
      advertisedDiscountPercent: 30,
      ...(safe.pricing?.elite || {}),
    },
    metaAdsAddonCents: Number(safe.pricing?.metaAdsAddonCents ?? safe.metaAdsAddonCents ?? 400),
  };
  const starterPrice = founderRateActive
    ? pricing.starter.founderAmountCents
    : pricing.starter.standardAmountCents;
  const eliteBasePrice = founderRateActive
    ? pricing.elite.founderAmountCents
    : pricing.elite.standardAmountCents;

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
    pricing,
    starterPrice,
    eliteBasePrice,
    selectedElitePrice: eliteBasePrice + (eliteMetaAds ? pricing.metaAdsAddonCents : 0),
    activeElitePrice: eliteBasePrice + (safe.metaAdsIncluded ? pricing.metaAdsAddonCents : 0),
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

function FeatureList({ items, styles, palette, accent }) {
  return items.map(([icon, label]) => (
    <View key={label} style={styles.featureRow}>
      <View style={[styles.featureIcon, { backgroundColor: `${accent}14` }]}>
        <Ionicons name={icon} size={14} color={accent} />
      </View>
      <Text style={styles.featureText}>{label}</Text>
      <Ionicons name="checkmark" size={15} color={palette.colors.success} />
    </View>
  ));
}

export default function SellerSubscriptionScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState('');
  const [eliteMetaAds, setEliteMetaAds] = useState(false);
  const [couponCode, setCouponCode] = useState(
    String(route?.params?.coupon || route?.params?.couponCode || '').trim().toUpperCase(),
  );
  const [founderCouponApplied, setFounderCouponApplied] = useState(false);
  const checkoutOpenRef = useRef(false);
  const handledReturnRef = useRef('');
  const checkoutRefreshTimersRef = useRef([]);

  const fetchSubscription = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true);
    setError('');
    try {
      const response = await api.get('/api/subscription/status');
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
    } catch (requestError) {
      setError(requestError.response?.data?.msg || requestError.message || 'Could not load your subscription.');
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      Alert.alert('Subscription processing', 'Payment completed. Your plan will refresh as soon as Stripe confirms it.');
      refreshAfterCheckout();
    } else if (checkoutResult === 'cancelled') {
      Alert.alert('Checkout cancelled', 'No charge was made. You can choose a plan whenever you are ready.');
    }
    navigation?.setParams?.({ checkout: undefined });
  }, [navigation, refreshAfterCheckout, route?.params?.checkout]);

  const model = getSubscriptionViewModel(subscription, eliteMetaAds);
  const activeStatus = model.isEnding
    ? ['Ending', 'close-circle-outline', 'error']
    : model.hasPendingDowngrade
      ? ['Changing plan', 'swap-horizontal-outline', 'warning']
      : STATUS_PRESENTATION[subscription?.status] || STATUS_PRESENTATION.trial;
  const statusColor = palette.colors[activeStatus[2]] || palette.colors.primary;

  const runMutation = useCallback(async (key, request, successFallback) => {
    setOperation(key);
    try {
      const response = await request();
      Alert.alert('Done', response.data?.msg || successFallback);
      await fetchSubscription();
    } catch (requestError) {
      Alert.alert('Could not update plan', requestError.response?.data?.msg || 'Please try again.');
    } finally {
      setOperation('');
    }
  }, [fetchSubscription]);

  const openCheckout = useCallback(async (plan) => {
    setOperation(`checkout-${plan}`);
    try {
      const payload = { plan, checkoutClient: 'mobile' };
      if (plan === 'elite') payload.includeMetaAds = eliteMetaAds;
      if (founderCouponApplied) payload.couponCode = subscription?.founderPromotion?.code;
      const response = await api.post('/api/subscription/create-checkout', payload);
      if (!response.data?.url) throw new Error('Checkout URL was not returned.');
      checkoutOpenRef.current = true;
      const result = await WebBrowser.openAuthSessionAsync(response.data.url, SUBSCRIPTION_RETURN_URL);
      checkoutOpenRef.current = false;
      if (result?.type === 'success') refreshAfterCheckout();
    } catch (requestError) {
      checkoutOpenRef.current = false;
      Alert.alert('Checkout unavailable', requestError.response?.data?.msg || requestError.message || 'Please try again.');
    } finally {
      setOperation('');
    }
  }, [eliteMetaAds, founderCouponApplied, refreshAfterCheckout, subscription?.founderPromotion?.code]);

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

  const confirmUpgrade = useCallback(() => {
    const metaText = eliteMetaAds
      ? ` with Meta ads (+${formatUsd(model.pricing.metaAdsAddonCents)}/month)`
      : '';
    Alert.alert(
      model.isElite ? 'Update Elite plan?' : 'Upgrade to Elite?',
      model.isElite
        ? `Apply your Meta ads change${metaText}? Stripe may prorate the billing difference immediately.`
        : `Switch to Elite${metaText}? Stripe may prorate the billing difference immediately. Your founder rate stays locked while your subscription remains uninterrupted.`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: model.isElite ? 'Apply change' : 'Upgrade',
          onPress: () => runMutation(
            'upgrade',
            () => api.post('/api/subscription/upgrade-to-elite', { includeMetaAds: eliteMetaAds }),
            'Your Elite plan is active.',
          ),
        },
      ],
    );
  }, [eliteMetaAds, model.isElite, model.pricing.metaAdsAddonCents, runMutation]);

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

  const planName = model.isSubscribed
    ? subscription?.planName || (model.isElite ? 'Rozare Elite' : 'Rozare Starter')
    : model.isTrial
      ? 'Rozare Free Trial'
      : 'No active plan';
  const planEndDate = formatDate(subscription?.freePeriodEndDate || subscription?.currentPeriodEnd);
  const trialEndDate = formatDate(subscription?.trialEndDate);
  const starterBonusDays = daysUntil(subscription?.bonusExpiryDate);
  const founderPromotion = subscription?.founderPromotion;
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
                    {subscription.bonusGraceDaysRemaining} day grace period remaining to keep eligible Starter bonus tools.
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
                  Stripe could not collect your renewal. Follow the secure payment-update link sent to your account email or contact support.
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
                <Text style={styles.heroMetaText}>Stripe secured</Text>
              </View>
            </View>
          </LinearGradient>

          {model.founderRateActive && (
            <GlassPanel variant="card" style={styles.founderCard}>
              <View style={styles.founderIcon}>
                <Ionicons name="pricetag" size={18} color={palette.colors.success} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.founderTitle}>FIRST100 founder rate locked</Text>
                <Text style={styles.bannerText}>
                  Your founder price follows Starter/Elite plan changes while the subscription stays uninterrupted. It is permanently lost after the subscription ends.
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
                  <Text style={styles.bannerText}>Resume before the period ends to keep your store live and preserve any founder rate.</Text>
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
            <GlassPanel variant="card" style={styles.bonusCard}>
              <View style={styles.bonusIcon}>
                <Ionicons name="gift-outline" size={19} color={palette.colors.secondary} />
              </View>
              <View style={styles.bannerCopy}>
                <Text style={styles.bannerTitle}>Starter bonus tools active</Text>
                <Text style={styles.bannerText}>
                  Advanced analytics, smart AI and promotion tools remain available for {starterBonusDays} more day{starterBonusDays === 1 ? '' : 's'}. Elite keeps them permanently while active.
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
                Checkout reserves a place for 35 minutes. The founder price is claimed only after Stripe confirms payment.
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
                  <Text style={styles.planSubtitle}>Core selling tools plus a 6-month bonus window</Text>
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
              {model.getsIntroductoryFreePeriod ? '30 days free, then ' : ''}{formatUsd(displayedStarterPrice)}/month · cancel anytime
            </Text>

            <FeatureList items={CORE_FEATURES} styles={styles} palette={palette} accent={palette.colors.primary} />

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
            ) : model.isElite ? (
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
                label={model.getsIntroductoryFreePeriod ? 'Start with 30 days free' : `Choose Starter · ${formatUsd(displayedStarterPrice)}/mo`}
                icon="card-outline"
                loading={operation === 'checkout-starter'}
                onPress={() => openCheckout('starter')}
                styles={styles}
                palette={palette}
              />
            ) : null}
          </GlassPanel>

          <GlassPanel variant="strong" style={[styles.planCard, styles.eliteCard, model.isElite && styles.currentEliteCard]}>
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
              {model.isElite && <Text style={styles.eliteCurrentBadge}>CURRENT</Text>}
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
              {model.getsIntroductoryFreePeriod ? '45 days free, then ' : ''}{formatUsd(displayedElitePrice)}/month · cancel anytime
            </Text>

            <FeatureList items={ELITE_FEATURES} styles={styles} palette={palette} accent={palette.colors.secondary} />

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

            {model.isElite ? (
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
                label={model.getsIntroductoryFreePeriod ? 'Start with 45 days free' : `Choose Elite · ${formatUsd(displayedElitePrice)}/mo`}
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
              ['shield-checkmark-outline', 'Checkout and recurring payments are processed by Stripe.'],
              ['calendar-clear-outline', model.getsIntroductoryFreePeriod
                ? 'The first paid subscription includes one introductory free period: 30 days on Starter or 45 days on Elite.'
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
  statusPill: { maxWidth: 105, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: borderRadius.full, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  statusPillText: { color: '#fff', fontSize: 9, fontWeight: fontWeight.extrabold },
  heroMetaRow: { marginTop: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  heroMetaItem: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 7, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)' },
  heroMetaText: { color: 'rgba(255,255,255,0.9)', fontSize: 10, fontWeight: fontWeight.semibold },
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
  bottomSpace: { height: spacing.xl },
});
