/**
 * SellerSubscriptionScreen — Subscription management with trial, blocked banners, Stripe checkout
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, SafeAreaView,
  RefreshControl, Alert, Linking, ActivityIndicator,
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

const STEPS = [
  { step: '1', title: 'Free Trial', desc: '15 days to set up your store, add products, and start selling' },
  { step: '2', title: 'Subscribe', desc: 'Choose the Starter plan — $0 for the first 30 days' },
  { step: '3', title: 'Free Period', desc: '30 days of full access at no cost to grow your business' },
  { step: '4', title: 'Monthly Billing', desc: 'Only $5.99/month after free period. Cancel anytime.' },
];

export default function SellerSubscriptionScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);

  const fetchSubscription = useCallback(async () => {
    try {
      const res = await api.get('/api/subscription/status');
      setSubscription(res.data.subscription);
    } catch (err) {
      console.error('Subscription fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchSubscription(); }, []);

  const handleSubscribe = async () => {
    setCheckoutLoading(true);
    try {
      const res = await api.post('/api/subscription/create-checkout', { plan: 'starter' });
      if (res.data.url) {
        await Linking.openURL(res.data.url);
      }
    } catch (err) {
      Alert.alert('Error', err.response?.data?.msg || 'Failed to create checkout');
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleCancel = () => {
    Alert.alert(
      'Cancel Subscription?',
      'Your store and products will be hidden from customers after the current period ends. You can re-subscribe anytime.',
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

  if (loading) return <GlassBackground><SafeAreaView style={{ flex: 1 }}><Loader fullScreen message="Loading subscription..." /></SafeAreaView></GlassBackground>;

  const STATUS_MAP = getStatusMap(palette);
  const status = STATUS_MAP[subscription?.status] || STATUS_MAP.trial;
  const isBlocked = subscription?.status === 'blocked';
  const isTrial = subscription?.status === 'trial';
  const isSubscribed = ['active', 'free_period'].includes(subscription?.status);
  const showSubscribeButton = !isSubscribed;

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
                      ? `Free until ${new Date(subscription.freePeriodEndDate).toLocaleDateString()}, then $5.99/mo`
                      : '$5.99/month • Cancel anytime'
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

          {/* Pricing Card */}
          {showSubscribeButton && (
            <GlassPanel variant="strong" style={[styles.pricingCard, { borderColor: `${palette.colors.primary}40`, borderWidth: 2 }]}>
              <View style={styles.pricingBadge}>
                <Ionicons name="sparkles" size={12} color={palette.colors.success} />
                <Text style={styles.pricingBadgeText}>30 DAYS FREE</Text>
              </View>

              <View style={styles.pricingPriceRow}>
                <Text style={styles.pricingOld}>$5.99/mo</Text>
                <Text style={styles.pricingNew}>$0</Text>
                <Text style={styles.pricingPeriod}>/first 30 days</Text>
              </View>
              <Text style={styles.pricingAfter}>Then $5.99/month • Cancel anytime</Text>

              {FEATURES.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <View style={styles.featureIcon}>
                    <Ionicons name={f.icon} size={14} color={palette.colors.success} />
                  </View>
                  <Text style={styles.featureText}>{f.text}</Text>
                </View>
              ))}

              <TouchableOpacity
                onPress={handleSubscribe}
                disabled={checkoutLoading}
                style={styles.subscribeBtn}
                activeOpacity={0.8}
              >
                {checkoutLoading ? (
                  <ActivityIndicator color={palette.colors.white} size="small" />
                ) : (
                  <>
                    <Ionicons name="card-outline" size={16} color={palette.colors.white} />
                    <Text style={styles.subscribeBtnText}>Subscribe Now — 30 Days Free</Text>
                    <Ionicons name="arrow-forward" size={16} color={palette.colors.white} />
                  </>
                )}
              </TouchableOpacity>

              <Text style={styles.stripeNote}>Secure checkout powered by Stripe. Cancel anytime.</Text>
            </GlassPanel>
          )}

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

  aiLimitRow: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.primary}08` },
  aiLimitTitle: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  aiLimitDesc: { fontSize: 10, color: p.colors.textSecondary },

  pricingCard: { padding: spacing.lg, marginBottom: spacing.lg, alignItems: 'center' },
  pricingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: `${p.colors.success}12`, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full, marginBottom: spacing.md },
  pricingBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.success },
  pricingPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs, marginBottom: spacing.xs },
  pricingOld: { fontSize: fontSize.md, color: p.colors.textSecondary, textDecorationLine: 'line-through' },
  pricingNew: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: p.colors.text },
  pricingPeriod: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  pricingAfter: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginBottom: spacing.lg },

  featureRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs, alignSelf: 'stretch' },
  featureIcon: { width: 24, height: 24, borderRadius: 8, backgroundColor: `${p.colors.success}12`, justifyContent: 'center', alignItems: 'center' },
  featureText: { fontSize: fontSize.xs, color: p.colors.text, flex: 1 },

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
