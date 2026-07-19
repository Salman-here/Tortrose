/**
 * SellerSubscriptionScreen — Subscription management with trial, blocked banners, Stripe checkout
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, SafeAreaView,
  RefreshControl, Alert, Linking, ActivityIndicator, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import Loader from '../../components/common/Loader';
import { spacing, fontSize, borderRadius, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const getStatusMap = (palette) => ({
  trial: { label: 'Free Trial', color: palette.colors.primary, icon: 'time-outline' },
  free_period: { label: '30-Day Free', color: palette.colors.success, icon: 'sparkles-outline' },
  active: { label: 'Active', color: palette.colors.success, icon: 'checkmark-circle-outline' },
  past_due: { label: 'Past Due', color: palette.colors.warning, icon: 'alert-circle-outline' },
  blocked: { label: 'Blocked', color: palette.colors.error, icon: 'lock-closed-outline' },
  cancelled: { label: 'Cancelled', color: palette.colors.gray, icon: 'close-circle-outline' },
});

const FEATURES = [
  { icon: 'storefront-outline', text: 'Keep your store & products visible to all customers' },
  { icon: 'chatbubbles-outline', text: 'Unlimited seller AI chat' },
  { icon: 'globe-outline', text: 'Custom subdomain stays active' },
  { icon: 'headset-outline', text: 'Priority support & new features early access' },
  { icon: 'analytics-outline', text: 'Advanced analytics & growth insights' },
  { icon: 'star-outline', text: 'Featured product highlighting on the homepage (Bonus)' },
  { icon: 'logo-whatsapp', text: 'Automated WhatsApp order verification — poll-based, no typing (Bonus)' },
];

const ELITE_FEATURES = [
  { icon: 'layers-outline', text: 'Everything in Starter' },
  { icon: 'star-outline', text: 'Featured product highlighting (12 products)' },
  { icon: 'analytics-outline', text: 'Advanced analytics, coupons, and smart AI tools permanently' },
  { icon: 'color-palette-outline', text: 'Customizable store themes' },
  { icon: 'megaphone-outline', text: 'Rozare-run TikTok ads for your store and featured products' },
];

export default function SellerSubscriptionScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const requestedCoupon = String(route?.params?.couponCode || '').trim().toUpperCase();
  const [couponCode, setCouponCode] = useState(requestedCoupon);
  const [founderCouponApplied, setFounderCouponApplied] = useState(false);
  const [includeMetaAds, setIncludeMetaAds] = useState(false);

  const fetchSubscription = useCallback(async () => {
    try {
      const res = await api.get('/api/subscription/status');
      const nextSubscription = res.data.subscription;
      setSubscription(nextSubscription);
      if (requestedCoupon) {
        const promotion = nextSubscription?.founderPromotion;
        const canApplyRequestedCoupon = requestedCoupon === promotion?.code
          && promotion?.available
          && promotion?.sellerEligible;
        setCouponCode(canApplyRequestedCoupon ? requestedCoupon : '');
        setFounderCouponApplied(Boolean(canApplyRequestedCoupon));
      }
    } catch (err) {
      console.error('Subscription fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchSubscription(); }, []);

  const handleSubscribe = async (plan) => {
    setCheckoutLoading(plan);
    try {
      const payload = { plan };
      if (plan === 'elite') payload.includeMetaAds = includeMetaAds;
      if (founderCouponApplied) payload.couponCode = subscription?.founderPromotion?.code;
      const res = await api.post('/api/subscription/create-checkout', payload);
      if (res.data.url) {
        await Linking.openURL(res.data.url);
      }
    } catch (err) {
      Alert.alert('Error', err.response?.data?.msg || 'Failed to create checkout');
    } finally {
      setCheckoutLoading(null);
    }
  };

  const applyFounderCoupon = () => {
    const promotion = subscription?.founderPromotion;
    const normalized = String(couponCode || '').trim().toUpperCase();
    if (!promotion || normalized !== promotion.code) {
      Alert.alert('Invalid coupon', 'Enter a valid subscription coupon code.');
      return;
    }
    if (!promotion.available || !promotion.sellerEligible) {
      Alert.alert('Coupon unavailable', promotion.forfeited
        ? 'This account already used and forfeited its founder rate.'
        : 'The founder offer is no longer available for this account.');
      return;
    }
    setCouponCode(normalized);
    setFounderCouponApplied(true);
    Alert.alert('FIRST100 applied', 'Your founder price will lock when Stripe Checkout completes.');
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel Subscription?',
      `Your store and products will be hidden from customers after the current period ends.${subscription?.founderOffer?.active ? ' Your FIRST100 founder rate will be permanently lost when the subscription ends.' : ''}`,
      [
        { text: 'Keep Plan', style: 'cancel' },
        {
          text: 'Cancel Subscription', style: 'destructive', onPress: async () => {
            setCancelLoading(true);
            try {
              await api.post('/api/subscription/cancel');
              Alert.alert('Done', 'Subscription will be cancelled at the end of the current period.');
              fetchSubscription();
            } catch (err) {
              Alert.alert('Error', err.response?.data?.msg || 'Failed to cancel');
            } finally {
              setCancelLoading(false);
            }
          }
        },
      ]
    );
  };

  const handleResume = async () => {
    setResumeLoading(true);
    try {
      const res = await api.post('/api/subscription/resume');
      Alert.alert('Subscription resumed', res.data?.msg || 'Your subscription will continue.');
      await fetchSubscription();
    } catch (err) {
      Alert.alert('Error', err.response?.data?.msg || 'Failed to resume subscription');
    } finally {
      setResumeLoading(false);
    }
  };

  if (loading) return <GlassBackground><SafeAreaView style={{ flex: 1 }}><Loader fullScreen message="Loading subscription..." /></SafeAreaView></GlassBackground>;

  const STATUS_MAP = getStatusMap(palette);
  const isEnding = Boolean(
    subscription?.cancelledAt
    && !subscription?.pendingDowngrade
    && ['active', 'free_period'].includes(subscription?.status)
  );
  const status = isEnding
    ? { label: 'Ending', color: palette.colors.error, icon: 'close-circle-outline' }
    : subscription?.status === 'free_period'
    ? { ...STATUS_MAP.free_period, label: subscription?.plan === 'elite' ? '45-Day Free' : '30-Day Free' }
    : (STATUS_MAP[subscription?.status] || STATUS_MAP.trial);
  const isBlocked = subscription?.status === 'blocked';
  const isTrial = subscription?.status === 'trial';
  const isPastDue = subscription?.status === 'past_due';
  const isSubscribed = ['active', 'free_period'].includes(subscription?.status);
  const showSubscribeButton = !isSubscribed && !isPastDue;
  const founderRateActive = Boolean(subscription?.founderOffer?.active);
  const useFounderRate = founderRateActive || founderCouponApplied;
  const pricing = {
    starter: {
      listAmountCents: 1175,
      standardAmountCents: 999,
      founderAmountCents: 599,
      advertisedDiscountPercent: 15,
      ...(subscription?.pricing?.starter || {}),
    },
    elite: {
      listAmountCents: 3093,
      standardAmountCents: 2165,
      founderAmountCents: 1299,
      advertisedDiscountPercent: 30,
      ...(subscription?.pricing?.elite || {}),
    },
    metaAdsAddonCents: Number(subscription?.pricing?.metaAdsAddonCents || 400),
  };
  const formatUsd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
  const starterPrice = useFounderRate ? pricing.starter.founderAmountCents : pricing.starter.standardAmountCents;
  const eliteBasePrice = useFounderRate ? pricing.elite.founderAmountCents : pricing.elite.standardAmountCents;
  const elitePrice = eliteBasePrice + (includeMetaAds ? pricing.metaAdsAddonCents : 0);
  const currentPlanPrice = subscription?.plan === 'elite'
    ? (founderRateActive ? pricing.elite.founderAmountCents : pricing.elite.standardAmountCents)
      + (subscription?.metaAdsIncluded ? pricing.metaAdsAddonCents : 0)
    : (founderRateActive ? pricing.starter.founderAmountCents : pricing.starter.standardAmountCents);
  const getsIntroductoryFreePeriod = !subscription?.hasUsedFreePeriod;
  const STEPS = [
    { step: '1', title: 'Free Trial', desc: '15 days to set up your store, add products, and start selling' },
    { step: '2', title: 'Subscribe', desc: `Choose Starter (${formatUsd(starterPrice)}/mo) or Elite (${formatUsd(elitePrice)}/mo)` },
    { step: '3', title: 'Free Period', desc: '30 days on Starter or 45 days on Elite when eligible' },
    { step: '4', title: 'Monthly Billing', desc: 'Your selected price renews monthly until cancelled.' },
  ];

  const getActiveStep = () => {
    if (isTrial) return '1';
    if (subscription?.status === 'free_period') return '3';
    if (subscription?.status === 'active') return '4';
    return '0';
  };

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <View style={styles.navBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <Text style={styles.navTitle}>Subscription</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchSubscription(); }} tintColor={palette.colors.primary} />}
        >
          {/* Blocked Banner */}
          {isBlocked && (
            <GlassPanel variant="card" style={styles.blockedBanner}>
              <View style={styles.blockedRow}>
                <View style={styles.blockedIconWrap}>
                  <Ionicons name="lock-closed" size={20} color={palette.colors.error} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.blockedTitle}>Store Temporarily Blocked</Text>
                  <Text style={styles.blockedDesc}>
                    {subscription?.blockedReason || 'Your trial has expired. Subscribe to reactivate your store, products, and subdomain.'}
                  </Text>
                  <View style={styles.blockedTags}>
                    <View style={styles.blockedTag}>
                      <Ionicons name="storefront-outline" size={11} color={palette.colors.error} />
                      <Text style={styles.blockedTagText}>Store hidden</Text>
                    </View>
                    <View style={styles.blockedTag}>
                      <Ionicons name="cube-outline" size={11} color={palette.colors.error} />
                      <Text style={styles.blockedTagText}>Products hidden</Text>
                    </View>
                  </View>
                </View>
              </View>
            </GlassPanel>
          )}

          {/* Status Badge */}
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.pageTitle}>Subscription</Text>
              <Text style={styles.pageSubtitle}>Manage your seller plan</Text>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: `${status.color}15` }]}>
              <Ionicons name={status.icon} size={12} color={status.color} />
              <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
            </View>
          </View>

          {/* Current Plan */}
          <GlassPanel variant="strong" style={styles.planCard}>
            <View style={styles.planHeader}>
              <View style={[styles.planIcon, { backgroundColor: isSubscribed ? palette.colors.success : palette.colors.primary }]}>
                <Ionicons name="diamond-outline" size={22} color={palette.colors.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.planTitle}>
                  {isSubscribed ? (subscription?.planName || 'Starter Plan') : isTrial ? 'Free Trial' : 'No Active Plan'}
                </Text>
                <Text style={styles.planDesc}>
                  {isSubscribed
                    ? subscription?.status === 'free_period'
                      ? `Free until ${new Date(subscription.freePeriodEndDate).toLocaleDateString()}, then ${formatUsd(currentPlanPrice)}/mo`
                      : `${formatUsd(currentPlanPrice)}/month - Cancel anytime`
                    : isTrial
                      ? `${subscription?.trialDaysRemaining} day${subscription?.trialDaysRemaining !== 1 ? 's' : ''} remaining`
                      : 'Subscribe to activate your store'
                  }
                </Text>
              </View>
              {isSubscribed && !subscription?.cancelledAt && (
                <TouchableOpacity onPress={handleCancel} style={styles.cancelBtn}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              )}
              {isEnding && (
                <TouchableOpacity onPress={handleResume} disabled={resumeLoading} style={styles.keepBtn}>
                  {resumeLoading
                    ? <ActivityIndicator size="small" color={palette.colors.white} />
                    : <Text style={styles.keepBtnText}>Keep Plan</Text>}
                </TouchableOpacity>
              )}
            </View>

            {/* AI Chat Info */}
            <View style={styles.aiLimitRow}>
              <Ionicons name="chatbubbles-outline" size={16} color={palette.colors.primary} />
              <View style={{ flex: 1, marginLeft: spacing.sm }}>
                <Text style={styles.aiLimitTitle}>AI Chat</Text>
                <Text style={styles.aiLimitDesc}>Unlimited seller AI chat on web, mobile, and WhatsApp</Text>
              </View>
            </View>
          </GlassPanel>

          {founderRateActive && (
            <GlassPanel variant="card" style={styles.founderPanel}>
              <Ionicons name="pricetag-outline" size={20} color={palette.colors.success} />
              <View style={{ flex: 1 }}>
                <Text style={styles.founderTitle}>FIRST100 founder rate locked</Text>
                <Text style={styles.founderText}>Your extra 40% discount stays through plan changes while the subscription remains uninterrupted.</Text>
              </View>
            </GlassPanel>
          )}

          {showSubscribeButton && subscription?.founderPromotion?.sellerEligible && subscription?.founderPromotion?.available && (
            <GlassPanel variant="card" style={styles.couponPanel}>
              <Text style={styles.couponTitle}>First 100 Sellers</Text>
              <Text style={styles.couponText}>
                {subscription.founderPromotion.sellerHasReservation
                  ? 'A founder spot is reserved for your account. Apply FIRST100 to continue.'
                  : `Use FIRST100 for an extra 40% off. ${subscription.founderPromotion.remaining} founder spots remain.`}
              </Text>
              <View style={styles.couponRow}>
                <TextInput
                  value={couponCode}
                  onChangeText={(value) => {
                    setCouponCode(value.toUpperCase());
                    setFounderCouponApplied(false);
                  }}
                  placeholder="Coupon code"
                  placeholderTextColor={palette.colors.textSecondary}
                  autoCapitalize="characters"
                  style={styles.couponInput}
                />
                <TouchableOpacity
                  onPress={founderCouponApplied ? () => { setFounderCouponApplied(false); setCouponCode(''); } : applyFounderCoupon}
                  style={[styles.couponButton, founderCouponApplied && { backgroundColor: palette.colors.success }]}
                >
                  <Text style={styles.couponButtonText}>{founderCouponApplied ? 'Applied' : 'Apply'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.couponFootnote}>Checkout reserves your spot for 35 minutes. The locked price ends permanently if you unsubscribe.</Text>
            </GlassPanel>
          )}

          {/* Pricing Cards */}
          {showSubscribeButton && ([
            {
              id: 'starter',
              name: 'Rozare Starter',
              price: starterPrice,
              definition: pricing.starter,
              freeDays: 30,
              features: FEATURES,
            },
            {
              id: 'elite',
              name: 'Rozare Elite',
              price: elitePrice,
              definition: pricing.elite,
              freeDays: 45,
              features: ELITE_FEATURES,
            },
          ]).map((plan) => (
            <GlassPanel key={plan.id} variant="strong" style={[styles.pricingCard, { borderColor: `${palette.colors.primary}40`, borderWidth: 2 }]}>
              <View style={styles.badgeRow}>
                {getsIntroductoryFreePeriod && (
                  <View style={styles.pricingBadge}>
                    <Ionicons name="sparkles" size={12} color={palette.colors.success} />
                    <Text style={styles.pricingBadgeText}>{plan.freeDays} DAYS FREE</Text>
                  </View>
                )}
                <View style={[styles.pricingBadge, { backgroundColor: `${palette.colors.primary}12` }]}>
                  <Text style={[styles.pricingBadgeText, { color: palette.colors.primary }]}>{plan.definition.advertisedDiscountPercent}% OFF</Text>
                </View>
              </View>

              <Text style={styles.pricingName}>{plan.name}</Text>
              <View style={styles.pricingPriceRow}>
                <Text style={styles.pricingOld}>{formatUsd(plan.definition.listAmountCents)}</Text>
                {useFounderRate && <Text style={styles.pricingOld}>{formatUsd(plan.definition.standardAmountCents)}</Text>}
                <Text style={styles.pricingNew}>{formatUsd(plan.price)}</Text>
                <Text style={styles.pricingPeriod}>/mo</Text>
              </View>
              <Text style={styles.pricingAfter}>
                {getsIntroductoryFreePeriod ? `First ${plan.freeDays} days free, then ` : ''}{formatUsd(plan.price)}/month
              </Text>
              {useFounderRate && <Text style={styles.founderAppliedText}>Extra 40% FIRST100 founder discount included</Text>}

              {plan.features.map((feature, index) => (
                <View key={`${plan.id}-${index}`} style={styles.featureRow}>
                  <View style={styles.featureIcon}>
                    <Ionicons name={feature.icon} size={14} color={palette.colors.success} />
                  </View>
                  <Text style={styles.featureText}>{feature.text}</Text>
                </View>
              ))}

              {plan.id === 'elite' && (
                <TouchableOpacity onPress={() => setIncludeMetaAds(value => !value)} style={styles.metaToggle}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.metaTitle}>Include Meta ads</Text>
                    <Text style={styles.metaText}>Adds {formatUsd(pricing.metaAdsAddonCents)}/month at full price.</Text>
                  </View>
                  <Ionicons name={includeMetaAds ? 'checkbox' : 'square-outline'} size={22} color={palette.colors.primary} />
                </TouchableOpacity>
              )}

              <TouchableOpacity
                onPress={() => handleSubscribe(plan.id)}
                disabled={Boolean(checkoutLoading)}
                style={styles.subscribeBtn}
                activeOpacity={0.8}
              >
                {checkoutLoading === plan.id ? (
                  <ActivityIndicator color={palette.colors.white} size="small" />
                ) : (
                  <>
                    <Ionicons name="card-outline" size={16} color={palette.colors.white} />
                    <Text style={styles.subscribeBtnText}>
                      {getsIntroductoryFreePeriod ? `Subscribe - ${plan.freeDays} Days Free` : `Subscribe - ${formatUsd(plan.price)}/month`}
                    </Text>
                    <Ionicons name="arrow-forward" size={16} color={palette.colors.white} />
                  </>
                )}
              </TouchableOpacity>

              <Text style={styles.stripeNote}>Secure checkout powered by Stripe. Cancel anytime.</Text>
            </GlassPanel>
          ))}

          {/* Timeline */}
          <GlassPanel variant="card" style={styles.timelineCard}>
            <Text style={styles.timelineTitle}>How it works</Text>
            {STEPS.map((s, i) => {
              const isActive = getActiveStep() === s.step;
              return (
                <View key={i} style={styles.stepRow}>
                  <View style={[styles.stepCircle, isActive && styles.stepCircleActive]}>
                    <Text style={[styles.stepNum, isActive && styles.stepNumActive]}>{s.step}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: spacing.md }}>
                    <Text style={[styles.stepTitle, isActive && { color: palette.colors.text }]}>{s.title}</Text>
                    <Text style={styles.stepDesc}>{s.desc}</Text>
                  </View>
                </View>
              );
            })}
          </GlassPanel>

          <View style={{ height: 100 }} />
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  navBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.04)', justifyContent: 'center', alignItems: 'center' },
  navTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },

  blockedBanner: { marginBottom: spacing.lg, padding: spacing.lg, backgroundColor: `${p.colors.error}08`, borderColor: `${p.colors.error}25`, borderWidth: 1 },
  blockedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  blockedIconWrap: { width: 36, height: 36, borderRadius: 12, backgroundColor: `${p.colors.error}15`, justifyContent: 'center', alignItems: 'center' },
  blockedTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.error },
  blockedDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  blockedTags: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  blockedTag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: `${p.colors.error}10`, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: borderRadius.md },
  blockedTagText: { fontSize: 10, fontWeight: fontWeight.medium, color: p.colors.error },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  pageTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  pageSubtitle: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold },

  planCard: { padding: spacing.lg, marginBottom: spacing.lg },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  planIcon: { width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  planTitle: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text },
  planDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  cancelBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.md, backgroundColor: `${p.colors.error}10` },
  cancelBtnText: { fontSize: fontSize.xs, color: p.colors.error, fontWeight: fontWeight.semibold },
  keepBtn: { minWidth: 76, minHeight: 32, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.md, backgroundColor: p.colors.primary, alignItems: 'center', justifyContent: 'center' },
  keepBtnText: { fontSize: fontSize.xs, color: p.colors.white, fontWeight: fontWeight.semibold },

  aiLimitRow: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.primary}08` },
  aiLimitTitle: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  aiLimitDesc: { fontSize: 10, color: p.colors.textSecondary },

  founderPanel: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.lg, borderColor: `${p.colors.success}35`, borderWidth: 1 },
  founderTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  founderText: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 3 },
  couponPanel: { padding: spacing.lg, marginBottom: spacing.lg },
  couponTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  couponText: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 4 },
  couponRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  couponInput: { flex: 1, minHeight: 42, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', color: p.colors.text, paddingHorizontal: spacing.md, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  couponButton: { minWidth: 84, minHeight: 42, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  couponButtonText: { color: p.colors.white, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  couponFootnote: { fontSize: 10, color: p.colors.textSecondary, marginTop: spacing.sm },

  pricingCard: { padding: spacing.lg, marginBottom: spacing.lg, alignItems: 'center' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md },
  pricingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: `${p.colors.success}12`, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  pricingBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.success },
  pricingName: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.xs },
  pricingPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs, marginBottom: spacing.xs },
  pricingOld: { fontSize: fontSize.md, color: p.colors.textSecondary, textDecorationLine: 'line-through' },
  pricingNew: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: p.colors.text },
  pricingPeriod: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  pricingAfter: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginBottom: spacing.lg },
  founderAppliedText: { fontSize: 10, fontWeight: fontWeight.semibold, color: p.colors.success, marginTop: -spacing.md, marginBottom: spacing.md },

  featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs, alignSelf: 'stretch' },
  featureIcon: { width: 24, height: 24, borderRadius: 8, backgroundColor: `${p.colors.success}12`, justifyContent: 'center', alignItems: 'center' },
  featureText: { fontSize: fontSize.xs, color: p.colors.text, flex: 1 },

  metaToggle: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.primary}08`, marginTop: spacing.md },
  metaTitle: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.text },
  metaText: { fontSize: 10, color: p.colors.textSecondary, marginTop: 2 },

  subscribeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingVertical: spacing.md + 2, borderRadius: borderRadius.lg, marginTop: spacing.lg, alignSelf: 'stretch' },
  subscribeBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.white },
  stripeNote: { fontSize: 9, color: p.colors.textSecondary, textAlign: 'center', marginTop: spacing.sm },

  timelineCard: { padding: spacing.lg, marginBottom: spacing.lg },
  timelineTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.md },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.md },
  stepCircle: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.06)', justifyContent: 'center', alignItems: 'center' },
  stepCircleActive: { backgroundColor: p.colors.primary },
  stepNum: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  stepNumActive: { color: p.colors.white },
  stepTitle: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  stepDesc: { fontSize: 10, color: p.colors.textSecondary, marginTop: 1 },
});
