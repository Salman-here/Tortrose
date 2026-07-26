/**
 * OnboardingWalkthrough — premium first-run buyer journey.
 *
 * Persistence and navigation semantics intentionally remain simple:
 * Skip and the final CTA both persist completion, while Next advances one page.
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Animated,
  Platform,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { spacing, fontSize, fontWeight, borderRadius, shadows } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import GlassBackground from './common/GlassBackground';
import GlassPanel from './common/GlassPanel';
import GlassBlurFill from './common/GlassBlurFill';
import RozareLogo from './common/RozareLogo';

const ONBOARDING_KEY = 'onboarding_completed';
const WHATSAPP_GREEN = '#22C55E';

const slides = [
  {
    id: 'marketplace',
    icon: 'storefront-outline',
    kicker: 'TRUSTED MARKETPLACE',
    accent: '#6366F1',
    accentSoft: 'rgba(99,102,241,0.14)',
    accentBorder: 'rgba(99,102,241,0.30)',
    gradient: ['#14B8A6', '#0EA5E9', '#6366F1'],
    sheen: ['rgba(20,184,166,0.13)', 'rgba(14,165,233,0.06)', 'rgba(99,102,241,0.15)'],
    title: 'Discover stores you can trust',
    subtitle: 'Explore verified sellers, real reviews, and useful trust signals before you buy.',
    preview: 'marketplace',
    features: [
      { icon: 'shield-checkmark-outline', label: 'Verified sellers' },
      { icon: 'star-outline', label: 'Reviews & trust' },
      { icon: 'options-outline', label: 'Smart filters' },
    ],
  },
  {
    id: 'ai-shopping',
    icon: 'chatbubble-ellipses-outline',
    kicker: 'AI SHOPPING, YOUR WAY',
    accent: '#8B5CF6',
    accentSoft: 'rgba(139,92,246,0.14)',
    accentBorder: 'rgba(139,92,246,0.30)',
    gradient: ['#6366F1', '#8B5CF6', '#EC4899'],
    sheen: ['rgba(99,102,241,0.13)', 'rgba(139,92,246,0.09)', 'rgba(236,72,153,0.11)'],
    title: 'Shop by simply chatting',
    subtitle: 'Tell Rozare AI what you need in the app or on WhatsApp, then shop the matches it finds.',
    preview: 'ai',
    features: [
      { icon: 'sparkles-outline', label: 'Natural conversations' },
      { icon: 'logo-whatsapp', label: 'App + WhatsApp' },
      { icon: 'flash-outline', label: 'Instant product picks' },
    ],
  },
  {
    id: 'checkout',
    icon: 'cart-outline',
    kicker: 'CONFIDENT CHECKOUT',
    accent: '#0EA5E9',
    accentSoft: 'rgba(14,165,233,0.14)',
    accentBorder: 'rgba(14,165,233,0.30)',
    gradient: ['#14B8A6', '#0EA5E9', '#6366F1'],
    sheen: ['rgba(14,165,233,0.13)', 'rgba(20,184,166,0.08)', 'rgba(99,102,241,0.11)'],
    title: 'Cart to checkout, confidently',
    subtitle: 'Review every detail, apply savings, and pay through a clear, secure checkout flow.',
    preview: 'checkout',
    features: [
      { icon: 'pricetag-outline', label: 'Coupons applied' },
      { icon: 'lock-closed-outline', label: 'Protected payments' },
      { icon: 'checkmark-done-outline', label: 'Clear order review' },
    ],
  },
  {
    id: 'tracking',
    icon: 'navigate-outline',
    kicker: 'APP + WHATSAPP UPDATES',
    accent: '#14B8A6',
    accentSoft: 'rgba(20,184,166,0.14)',
    accentBorder: 'rgba(20,184,166,0.30)',
    gradient: ['#14B8A6', '#0EA5E9'],
    sheen: ['rgba(20,184,166,0.14)', 'rgba(14,165,233,0.08)', 'rgba(34,197,94,0.09)'],
    title: 'Always know where your order is',
    subtitle: 'Get order updates in the app and, when connected, on WhatsApp—from checkout to delivery.',
    preview: 'tracking',
    features: [
      { icon: 'notifications-outline', label: 'Live status updates' },
      { icon: 'logo-whatsapp', label: 'WhatsApp updates' },
      { icon: 'location-outline', label: 'Delivery tracking' },
    ],
  },
  {
    id: 'selling',
    icon: 'rocket-outline',
    kicker: 'SMART SELLING',
    accent: '#EC4899',
    accentSoft: 'rgba(236,72,153,0.13)',
    accentBorder: 'rgba(236,72,153,0.28)',
    gradient: ['#8B5CF6', '#EC4899', '#F59E0B'],
    sheen: ['rgba(139,92,246,0.13)', 'rgba(236,72,153,0.09)', 'rgba(245,158,11,0.08)'],
    title: 'Sell smarter. Grow faster.',
    subtitle: 'Launch your store, understand performance, and use AI-powered tools to keep growing.',
    preview: 'selling',
    features: [
      { icon: 'sparkles-outline', label: 'AI store tools' },
      { icon: 'stats-chart-outline', label: 'Live analytics' },
      { icon: 'trending-up-outline', label: 'Growth insights' },
    ],
  },
];

// SecureStore is unavailable on web — fall back to AsyncStorage there so the
// walkthrough does not reappear on every visit.
export async function shouldShowOnboarding() {
  try {
    if (Platform.OS === 'web') {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      return (await AsyncStorage.getItem(ONBOARDING_KEY)) !== 'true';
    }
    const val = await SecureStore.getItemAsync(ONBOARDING_KEY);
    return val !== 'true';
  } catch {
    return true;
  }
}

export async function markOnboardingComplete() {
  try {
    if (Platform.OS === 'web') {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      return;
    }
    await SecureStore.setItemAsync(ONBOARDING_KEY, 'true');
  } catch {}
}

function PreviewFrame({ item, styles, children }) {
  return (
    <View
      style={[styles.previewFrame, { borderColor: item.accentBorder }]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <LinearGradient
        colors={item.sheen}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={[styles.previewGlowLarge, { backgroundColor: item.accentSoft }]} pointerEvents="none" />
      <View style={[styles.previewGlowSmall, { backgroundColor: item.accentSoft }]} pointerEvents="none" />
      {children}
    </View>
  );
}

function MarketplacePreview({ item, palette, styles }) {
  const colors = palette.colors;
  return (
    <PreviewFrame item={item} styles={styles}>
      <View style={styles.previewSearchRow}>
        <View style={styles.previewSearch}>
          <Ionicons name="search-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.previewPlaceholder} numberOfLines={1}>Search trusted stores</Text>
        </View>
        <View style={styles.previewFilter}>
          <Ionicons name="options-outline" size={15} color={colors.primary} />
        </View>
      </View>

      <View style={styles.marketStoreGrid}>
        {[
          { name: 'Nova Market', icon: 'sparkles', trust: '4.9 · 2.4k trusters', colors: ['#14B8A6', '#0EA5E9'] },
          { name: 'The Edit', icon: 'storefront', trust: '4.8 · Verified', colors: ['#8B5CF6', '#6366F1'] },
        ].map((store) => (
          <View key={store.name} style={styles.marketStoreCard}>
            <LinearGradient colors={store.colors} style={styles.marketStoreLogo}>
              <Ionicons name={store.icon} size={15} color="#fff" />
            </LinearGradient>
            <View style={styles.marketStoreCopy}>
              <View style={styles.marketStoreNameRow}>
                <Text style={styles.marketStoreName} numberOfLines={1}>{store.name}</Text>
                <Ionicons name="shield-checkmark" size={12} color={colors.info} />
              </View>
              <View style={styles.marketTrustRow}>
                <Ionicons name="star" size={10} color="#FBBF24" />
                <Text style={styles.marketTrustText} numberOfLines={1}>{store.trust}</Text>
              </View>
            </View>
          </View>
        ))}
      </View>
    </PreviewFrame>
  );
}

function AIShoppingPreview({ item, palette, styles }) {
  const colors = palette.colors;
  return (
    <PreviewFrame item={item} styles={styles}>
      <View style={styles.channelRow}>
        <View style={[styles.channelChip, styles.channelChipActive]}>
          <Ionicons name="sparkles" size={12} color="#fff" />
          <Text style={styles.channelChipActiveText}>In-app AI</Text>
        </View>
        <View style={[styles.channelChip, { backgroundColor: 'rgba(34,197,94,0.13)', borderColor: 'rgba(34,197,94,0.26)' }]}>
          <Ionicons name="logo-whatsapp" size={13} color={WHATSAPP_GREEN} />
          <Text style={[styles.channelChipText, { color: WHATSAPP_GREEN }]}>WhatsApp</Text>
        </View>
        <Text style={styles.channelAnytime}>Shop anywhere</Text>
      </View>

      <View style={styles.aiConversation}>
        <View style={styles.userBubble}>
          <Text style={styles.userBubbleText} numberOfLines={2}>Find running shoes under $80</Text>
        </View>
        <View style={styles.aiAnswerRow}>
          <LinearGradient colors={item.gradient} style={styles.aiAvatar}>
            <Ionicons name="sparkles" size={13} color="#fff" />
          </LinearGradient>
          <View style={styles.aiResultCard}>
            <View style={styles.aiProductIcon}>
              <Ionicons name="footsteps-outline" size={17} color={item.accent} />
            </View>
            <View style={styles.aiResultCopy}>
              <Text style={styles.aiResultTitle}>3 trusted matches</Text>
              <Text style={styles.aiResultMeta}>Compared for price, fit & reviews</Text>
            </View>
            <Ionicons name="arrow-forward-circle" size={19} color={item.accent} />
          </View>
        </View>
      </View>
    </PreviewFrame>
  );
}

function CheckoutPreview({ item, palette, styles }) {
  const colors = palette.colors;
  return (
    <PreviewFrame item={item} styles={styles}>
      <View style={styles.cartProductRow}>
        <LinearGradient colors={['rgba(14,165,233,0.22)', 'rgba(99,102,241,0.18)']} style={styles.cartProductImage}>
          <Ionicons name="footsteps-outline" size={22} color={item.accent} />
        </LinearGradient>
        <View style={styles.cartProductCopy}>
          <Text style={styles.cartProductName}>Everyday Runner</Text>
          <Text style={styles.cartProductMeta}>Size 42 · Qty 1</Text>
        </View>
        <Text style={styles.cartPrice}>$74.00</Text>
      </View>

      <View style={styles.checkoutSavingsRow}>
        <View style={styles.savingsChip}>
          <Ionicons name="pricetag" size={12} color={colors.success} />
          <Text style={styles.savingsText}>ROZARE10 applied</Text>
        </View>
        <Text style={styles.savedText}>You saved $8</Text>
      </View>

      <View style={styles.secureCheckoutBar}>
        <View style={styles.secureCheckoutCopy}>
          <View style={styles.secureIcon}>
            <Ionicons name="lock-closed" size={13} color={colors.success} />
          </View>
          <View>
            <Text style={styles.secureTitle}>Secure checkout</Text>
            <Text style={styles.secureMeta}>Protected payment</Text>
          </View>
        </View>
        <LinearGradient colors={item.gradient} style={styles.checkoutMiniButton}>
          <Text style={styles.checkoutMiniButtonText}>Checkout</Text>
          <Ionicons name="arrow-forward" size={12} color="#fff" />
        </LinearGradient>
      </View>
    </PreviewFrame>
  );
}

function TrackingPreview({ item, palette, styles }) {
  const colors = palette.colors;
  const steps = [
    { label: 'Confirmed', icon: 'checkmark', done: true },
    { label: 'Shipped', icon: 'cube-outline', done: true },
    { label: 'Arriving', icon: 'navigate-outline', done: false },
  ];

  return (
    <PreviewFrame item={item} styles={styles}>
      <View style={styles.trackingChannelRow}>
        <View style={styles.trackingChannel}>
          <Ionicons name="notifications" size={12} color={colors.primary} />
          <Text style={styles.trackingChannelText}>App updates</Text>
        </View>
        <View style={styles.trackingChannelDivider} />
        <View style={styles.trackingChannel}>
          <Ionicons name="logo-whatsapp" size={13} color={WHATSAPP_GREEN} />
          <Text style={[styles.trackingChannelText, { color: WHATSAPP_GREEN }]}>WhatsApp updates</Text>
        </View>
      </View>

      <View style={styles.trackingTimeline}>
        <View style={styles.trackingLine} />
        <View style={[styles.trackingLineProgress, { backgroundColor: item.accent }]} />
        {steps.map((step) => (
          <View key={step.label} style={styles.trackingStep}>
            <View style={[styles.trackingDot, step.done && { backgroundColor: item.accent, borderColor: item.accent }]}>
              <Ionicons name={step.icon} size={12} color={step.done ? '#fff' : colors.textSecondary} />
            </View>
            <Text style={[styles.trackingStepLabel, step.done && { color: colors.text }]}>{step.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.latestUpdate}>
        <View style={[styles.latestUpdateIcon, { backgroundColor: item.accentSoft }]}>
          <Ionicons name="bicycle-outline" size={15} color={item.accent} />
        </View>
        <View style={styles.latestUpdateCopy}>
          <Text style={styles.latestUpdateTitle}>Your order is on the way</Text>
          <Text style={styles.latestUpdateMeta}>Live tracking is now available</Text>
        </View>
        <View style={styles.livePill}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
      </View>
    </PreviewFrame>
  );
}

function SellingPreview({ item, palette, styles }) {
  const colors = palette.colors;
  const bars = [30, 44, 37, 58, 72, 64, 86];
  return (
    <PreviewFrame item={item} styles={styles}>
      <View style={styles.sellerMetricsRow}>
        <View style={styles.sellerMetricPrimary}>
          <View>
            <Text style={styles.sellerMetricLabel}>THIS WEEK</Text>
            <Text style={styles.sellerMetricValue}>$2.8k</Text>
          </View>
          <View style={styles.sellerGrowthPill}>
            <Ionicons name="trending-up" size={11} color={colors.success} />
            <Text style={styles.sellerGrowthText}>24%</Text>
          </View>
        </View>
        <View style={styles.sellerMetricSmall}>
          <Ionicons name="bag-handle-outline" size={16} color={item.accent} />
          <View>
            <Text style={styles.sellerOrdersValue}>18</Text>
            <Text style={styles.sellerOrdersLabel}>new orders</Text>
          </View>
        </View>
      </View>

      <View style={styles.sellerChart}>
        <View style={styles.sellerChartCopy}>
          <Text style={styles.sellerChartTitle}>Store growth</Text>
          <Text style={styles.sellerChartMeta}>Sales are trending up</Text>
        </View>
        <View style={styles.sellerBars}>
          {bars.map((barHeight, index) => (
            <LinearGradient
              key={`${barHeight}-${index}`}
              colors={item.gradient}
              style={[styles.sellerBar, { height: `${barHeight}%`, opacity: 0.48 + (index * 0.07) }]}
            />
          ))}
        </View>
      </View>

      <View style={styles.aiInsight}>
        <LinearGradient colors={item.gradient} style={styles.aiInsightIcon}>
          <Ionicons name="sparkles" size={12} color="#fff" />
        </LinearGradient>
        <Text style={styles.aiInsightText} numberOfLines={1}>AI insight: Restock your fastest seller</Text>
        <Ionicons name="chevron-forward" size={14} color={item.accent} />
      </View>
    </PreviewFrame>
  );
}

function SlidePreview({ item, palette, styles }) {
  if (item.preview === 'ai') return <AIShoppingPreview item={item} palette={palette} styles={styles} />;
  if (item.preview === 'checkout') return <CheckoutPreview item={item} palette={palette} styles={styles} />;
  if (item.preview === 'tracking') return <TrackingPreview item={item} palette={palette} styles={styles} />;
  if (item.preview === 'selling') return <SellingPreview item={item} palette={palette} styles={styles} />;
  return <MarketplacePreview item={item} palette={palette} styles={styles} />;
}

export default function OnboardingWalkthrough({ onComplete }) {
  const { palette } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = height < 760;
  const narrow = width < 360;
  const styles = useMemo(
    () => makeStyles(palette, compact, narrow, width),
    [palette, compact, narrow, width]
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isCompleting, setIsCompleting] = useState(false);
  const flatListRef = useRef(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 55 }).current;

  const handleDone = async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    await markOnboardingComplete();
    onComplete?.();
  };

  const handleNext = () => {
    if (currentIndex < slides.length - 1) {
      const nextIndex = currentIndex + 1;
      flatListRef.current?.scrollToIndex({ index: nextIndex, animated: true });
      setCurrentIndex(nextIndex);
      return;
    }
    handleDone();
  };

  const handleSkip = () => handleDone();

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    const firstVisible = viewableItems.find((entry) => entry.isViewable);
    if (typeof firstVisible?.index === 'number') setCurrentIndex(firstVisible.index);
  }).current;

  const renderSlide = ({ item, index }) => {
    const inputRange = [(index - 1) * width, index * width, (index + 1) * width];
    const cardScale = scrollX.interpolate({
      inputRange,
      outputRange: [0.94, 1, 0.94],
      extrapolate: 'clamp',
    });
    const cardOpacity = scrollX.interpolate({
      inputRange,
      outputRange: [0.58, 1, 0.58],
      extrapolate: 'clamp',
    });

    return (
      <View style={[styles.slide, { width }]}>
        <Animated.View style={[styles.cardMotion, { opacity: cardOpacity, transform: [{ scale: cardScale }] }]}>
          <GlassPanel variant="floating" style={styles.glassCard}>
            <LinearGradient
              colors={item.sheen}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={[styles.cardAura, { backgroundColor: item.accentSoft }]} pointerEvents="none" />

            <View style={styles.slideIntro}>
              <View style={styles.kickerRow}>
                <LinearGradient colors={item.gradient} style={styles.iconTile}>
                  <Ionicons name={item.icon} size={compact ? 20 : 22} color="#fff" />
                </LinearGradient>
                <View style={styles.kickerCopy}>
                  <Text style={[styles.kicker, { color: item.accent }]}>{item.kicker}</Text>
                  <Text style={styles.stepMeta}>STEP {String(index + 1).padStart(2, '0')} · ROZARE</Text>
                </View>
              </View>

              <Text accessibilityRole="header" style={styles.title}>{item.title}</Text>
              <Text style={styles.subtitle}>{item.subtitle}</Text>
            </View>

            <SlidePreview item={item} palette={palette} styles={styles} />

            <View style={styles.featuresGrid}>
              {item.features.map((feature) => (
                <View key={feature.label} style={styles.featureChip}>
                  <View style={[styles.featureIcon, { backgroundColor: item.accentSoft }]}>
                    <Ionicons name={feature.icon} size={14} color={item.accent} />
                  </View>
                  <Text style={styles.featureText} numberOfLines={1}>{feature.label}</Text>
                </View>
              ))}
            </View>
          </GlassPanel>
        </Animated.View>
      </View>
    );
  };

  const isLast = currentIndex === slides.length - 1;
  const topPadding = Platform.OS === 'android'
    ? spacing.sm
    : Math.max(insets.top, spacing.sm);

  return (
    <GlassBackground>
      <View style={[styles.container, { paddingTop: topPadding }]}>
        <View style={styles.topBar}>
          <View style={styles.brandPill}>
            <GlassBlurFill intensity={30} />
            <RozareLogo width={104} height={27} />
          </View>

          {!isLast ? (
            <TouchableOpacity
              style={styles.skipButton}
              onPress={handleSkip}
              disabled={isCompleting}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Skip onboarding"
              accessibilityHint="Finishes onboarding and opens Rozare"
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <GlassBlurFill intensity={30} />
              <Text style={styles.skipText}>Skip</Text>
              <Ionicons name="arrow-forward" size={14} color={palette.colors.textSecondary} />
            </TouchableOpacity>
          ) : (
            <View style={styles.readyPill}>
              <Ionicons name="checkmark-circle" size={15} color={palette.colors.success} />
              <Text style={styles.readyText}>Ready</Text>
            </View>
          )}
        </View>

        <Animated.FlatList
          ref={flatListRef}
          style={styles.slides}
          data={slides}
          renderItem={renderSlide}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          disableIntervalMomentum
          bounces={false}
          showsHorizontalScrollIndicator={false}
          initialNumToRender={2}
          windowSize={3}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: false }
          )}
          scrollEventThrottle={16}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          accessibilityLabel="Rozare onboarding walkthrough"
        />

        <GlassPanel variant="floating" style={styles.bottomDock}>
          <View style={styles.progressBlock}>
            <Text style={styles.progressLabel}>
              STEP {String(currentIndex + 1).padStart(2, '0')} OF {String(slides.length).padStart(2, '0')}
            </Text>
            <View style={styles.pagination}>
              {slides.map((_, index) => {
                const inputRange = [(index - 1) * width, index * width, (index + 1) * width];
                const dotWidth = scrollX.interpolate({
                  inputRange,
                  outputRange: [6, compact ? 20 : 24, 6],
                  extrapolate: 'clamp',
                });
                const dotOpacity = scrollX.interpolate({
                  inputRange,
                  outputRange: [0.24, 1, 0.24],
                  extrapolate: 'clamp',
                });
                return (
                  <Animated.View
                    key={slides[index].id}
                    style={[
                      styles.dot,
                      {
                        width: dotWidth,
                        opacity: dotOpacity,
                        backgroundColor: palette.colors.primary,
                      },
                    ]}
                  />
                );
              })}
            </View>
          </View>

          <TouchableOpacity
            style={[styles.nextButton, isCompleting && styles.buttonDisabled]}
            onPress={handleNext}
            disabled={isCompleting}
            activeOpacity={0.86}
            accessibilityRole="button"
            accessibilityLabel={isLast ? 'Get started with Rozare' : `Continue to step ${currentIndex + 2}`}
            accessibilityHint={isLast ? 'Finishes onboarding and opens Rozare' : 'Shows the next onboarding page'}
          >
            <LinearGradient
              colors={palette.gradients.cta}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.nextButtonGradient}
            >
              <Text style={styles.nextButtonText}>{isLast ? 'Get started' : 'Next'}</Text>
              <View style={styles.nextIcon}>
                <Ionicons name={isLast ? 'checkmark' : 'arrow-forward'} size={17} color="#fff" />
              </View>
            </LinearGradient>
          </TouchableOpacity>
        </GlassPanel>
      </View>
    </GlassBackground>
  );
}

const makeStyles = (palette, compact, narrow, viewportWidth) => {
  const colors = palette.colors;
  const glass = palette.glass;
  return StyleSheet.create({
    container: {
      flex: 1,
      paddingBottom: spacing.sm,
    },
    topBar: {
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: compact ? spacing.xs : spacing.sm,
      minHeight: compact ? 42 : 48,
    },
    brandPill: {
      height: compact ? 36 : 40,
      paddingHorizontal: spacing.sm,
      borderRadius: 14,
      backgroundColor: glass.bgSubtle,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
      overflow: 'hidden',
      justifyContent: 'center',
    },
    skipButton: {
      height: compact ? 36 : 40,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.md,
      borderRadius: borderRadius.full,
      backgroundColor: glass.bgSubtle,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
      overflow: 'hidden',
    },
    skipText: {
      fontSize: fontSize.sm,
      fontWeight: fontWeight.semibold,
      color: colors.text,
    },
    readyPill: {
      height: compact ? 36 : 40,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.md,
      borderRadius: borderRadius.full,
      backgroundColor: colors.successSubtle,
      borderWidth: 1,
      borderColor: colors.successLighter,
    },
    readyText: {
      color: colors.success,
      fontSize: fontSize.sm,
      fontWeight: fontWeight.semibold,
    },
    slides: {
      flex: 1,
    },
    slide: {
      height: '100%',
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: narrow ? spacing.md : spacing.lg,
      paddingVertical: compact ? spacing.xs : spacing.sm,
    },
    cardMotion: {
      width: '100%',
      maxWidth: 540,
      flex: 1,
      maxHeight: compact ? 505 : 620,
    },
    glassCard: {
      flex: 1,
      width: '100%',
      paddingHorizontal: compact ? spacing.md : spacing.xl,
      paddingVertical: compact ? spacing.md : spacing.xl,
      borderRadius: compact ? 24 : 28,
      overflow: 'hidden',
      justifyContent: 'space-between',
      ...shadows.lg,
    },
    cardAura: {
      position: 'absolute',
      width: 220,
      height: 220,
      borderRadius: 110,
      top: -120,
      right: -85,
      opacity: 0.72,
    },
    slideIntro: {
      zIndex: 1,
    },
    kickerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginBottom: compact ? spacing.sm : spacing.md,
    },
    iconTile: {
      width: compact ? 40 : 46,
      height: compact ? 40 : 46,
      borderRadius: compact ? 13 : 15,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#0EA5E9',
      shadowOffset: { width: 0, height: 5 },
      shadowOpacity: 0.28,
      shadowRadius: 10,
      elevation: 5,
    },
    kickerCopy: {
      flex: 1,
      minWidth: 0,
    },
    kicker: {
      fontSize: compact ? 10 : 11,
      lineHeight: compact ? 14 : 15,
      fontWeight: fontWeight.extrabold,
      letterSpacing: 1.25,
    },
    stepMeta: {
      marginTop: 2,
      fontSize: 9,
      color: colors.textLight,
      fontWeight: fontWeight.semibold,
      letterSpacing: 0.7,
    },
    title: {
      maxWidth: 460,
      fontSize: compact ? 24 : fontSize.title,
      lineHeight: compact ? 29 : 34,
      fontWeight: fontWeight.extrabold,
      color: colors.text,
      letterSpacing: -0.65,
      marginBottom: compact ? spacing.xs : spacing.sm,
    },
    subtitle: {
      maxWidth: 480,
      fontSize: compact ? 13 : fontSize.md,
      lineHeight: compact ? 19 : 21,
      color: colors.textSecondary,
    },
    previewFrame: {
      height: compact ? 148 : 194,
      position: 'relative',
      overflow: 'hidden',
      borderRadius: compact ? 18 : 22,
      backgroundColor: glass.bgSubtle,
      borderWidth: 1,
      padding: compact ? spacing.sm : spacing.md,
      marginVertical: compact ? spacing.sm : spacing.md,
      justifyContent: 'space-between',
    },
    previewGlowLarge: {
      position: 'absolute',
      width: 150,
      height: 150,
      borderRadius: 75,
      top: -92,
      right: -55,
      opacity: 0.64,
    },
    previewGlowSmall: {
      position: 'absolute',
      width: 100,
      height: 100,
      borderRadius: 50,
      bottom: -66,
      left: -34,
      opacity: 0.56,
    },

    // Marketplace preview
    previewSearchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    previewSearch: {
      flex: 1,
      minHeight: compact ? 30 : 36,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.sm,
      borderRadius: 11,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    previewPlaceholder: {
      flex: 1,
      fontSize: compact ? 10 : 11,
      color: colors.textSecondary,
    },
    previewFilter: {
      width: compact ? 30 : 36,
      height: compact ? 30 : 36,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    marketStoreGrid: {
      flexDirection: 'row',
      gap: spacing.sm,
      flex: 1,
      alignItems: 'flex-end',
      paddingTop: spacing.sm,
    },
    marketStoreCard: {
      flex: 1,
      minWidth: 0,
      height: compact ? 78 : 108,
      padding: compact ? 7 : spacing.sm,
      borderRadius: compact ? 13 : 16,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
      justifyContent: 'space-between',
    },
    marketStoreLogo: {
      width: compact ? 28 : 34,
      height: compact ? 28 : 34,
      borderRadius: compact ? 9 : 11,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: compact ? 4 : 6,
    },
    marketStoreCopy: {
      minWidth: 0,
    },
    marketStoreNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    marketStoreName: {
      flexShrink: 1,
      fontSize: compact ? 10 : 12,
      color: colors.text,
      fontWeight: fontWeight.bold,
    },
    marketTrustRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      marginTop: 2,
    },
    marketTrustText: {
      flexShrink: 1,
      fontSize: compact ? 8 : 9,
      color: colors.textSecondary,
    },

    // AI preview
    channelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    channelChip: {
      minHeight: compact ? 26 : 30,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: compact ? 7 : spacing.sm,
      borderRadius: borderRadius.full,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
      backgroundColor: glass.bgStrong,
    },
    channelChipActive: {
      borderColor: 'transparent',
      backgroundColor: colors.primary,
    },
    channelChipText: {
      fontSize: compact ? 9 : 10,
      color: colors.textSecondary,
      fontWeight: fontWeight.semibold,
    },
    channelChipActiveText: {
      fontSize: compact ? 9 : 10,
      color: '#fff',
      fontWeight: fontWeight.bold,
    },
    channelAnytime: {
      flex: 1,
      textAlign: 'right',
      fontSize: 9,
      color: colors.textLight,
    },
    aiConversation: {
      flex: 1,
      justifyContent: 'flex-end',
      gap: compact ? 6 : spacing.sm,
      paddingTop: spacing.xs,
    },
    userBubble: {
      maxWidth: '82%',
      alignSelf: 'flex-end',
      paddingHorizontal: spacing.md,
      paddingVertical: compact ? 6 : spacing.sm,
      borderRadius: 14,
      borderBottomRightRadius: 5,
      backgroundColor: colors.primary,
    },
    userBubbleText: {
      fontSize: compact ? 10 : 11,
      lineHeight: compact ? 14 : 16,
      color: '#fff',
      fontWeight: fontWeight.medium,
    },
    aiAnswerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    aiAvatar: {
      width: compact ? 26 : 30,
      height: compact ? 26 : 30,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    aiResultCard: {
      flex: 1,
      minWidth: 0,
      minHeight: compact ? 43 : 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: compact ? 7 : spacing.sm,
      borderRadius: 13,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    aiProductIcon: {
      width: compact ? 27 : 32,
      height: compact ? 27 : 32,
      borderRadius: 9,
      backgroundColor: glass.bgSubtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    aiResultCopy: {
      flex: 1,
      minWidth: 0,
    },
    aiResultTitle: {
      fontSize: compact ? 10 : 11,
      color: colors.text,
      fontWeight: fontWeight.bold,
    },
    aiResultMeta: {
      marginTop: 1,
      fontSize: compact ? 8 : 9,
      color: colors.textSecondary,
    },

    // Cart and checkout preview
    cartProductRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    cartProductImage: {
      width: compact ? 38 : 46,
      height: compact ? 38 : 46,
      borderRadius: compact ? 11 : 13,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cartProductCopy: {
      flex: 1,
      minWidth: 0,
    },
    cartProductName: {
      fontSize: compact ? 11 : 12,
      fontWeight: fontWeight.bold,
      color: colors.text,
    },
    cartProductMeta: {
      marginTop: 2,
      fontSize: compact ? 9 : 10,
      color: colors.textSecondary,
    },
    cartPrice: {
      fontSize: compact ? 12 : 14,
      fontWeight: fontWeight.extrabold,
      color: colors.text,
    },
    checkoutSavingsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: compact ? 5 : spacing.sm,
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: glass.borderSubtle,
    },
    savingsChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 7,
      paddingVertical: 4,
      borderRadius: borderRadius.full,
      backgroundColor: colors.successSubtle,
    },
    savingsText: {
      fontSize: compact ? 8 : 9,
      color: colors.success,
      fontWeight: fontWeight.bold,
    },
    savedText: {
      fontSize: compact ? 8 : 9,
      color: colors.success,
      fontWeight: fontWeight.semibold,
    },
    secureCheckoutBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    secureCheckoutCopy: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    secureIcon: {
      width: compact ? 27 : 32,
      height: compact ? 27 : 32,
      borderRadius: 9,
      backgroundColor: colors.successSubtle,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secureTitle: {
      fontSize: compact ? 9 : 10,
      color: colors.text,
      fontWeight: fontWeight.bold,
    },
    secureMeta: {
      fontSize: compact ? 8 : 9,
      color: colors.textSecondary,
    },
    checkoutMiniButton: {
      minHeight: compact ? 28 : 34,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingHorizontal: compact ? spacing.sm : spacing.md,
      borderRadius: 10,
    },
    checkoutMiniButtonText: {
      color: '#fff',
      fontSize: compact ? 9 : 10,
      fontWeight: fontWeight.bold,
    },

    // Order tracking preview
    trackingChannelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: compact ? 25 : 30,
      paddingHorizontal: spacing.sm,
      borderRadius: borderRadius.full,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    trackingChannel: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    trackingChannelText: {
      fontSize: compact ? 8 : 10,
      color: colors.primary,
      fontWeight: fontWeight.semibold,
    },
    trackingChannelDivider: {
      width: 1,
      height: 14,
      marginHorizontal: spacing.sm,
      backgroundColor: glass.borderSubtle,
    },
    trackingTimeline: {
      position: 'relative',
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      paddingHorizontal: spacing.sm,
      marginVertical: compact ? 2 : 4,
    },
    trackingLine: {
      position: 'absolute',
      height: 2,
      left: '17%',
      right: '17%',
      top: compact ? 12 : 14,
      backgroundColor: glass.borderStrong,
    },
    trackingLineProgress: {
      position: 'absolute',
      height: 2,
      left: '17%',
      width: '34%',
      top: compact ? 12 : 14,
    },
    trackingStep: {
      width: '31%',
      alignItems: 'center',
      zIndex: 1,
    },
    trackingDot: {
      width: compact ? 25 : 29,
      height: compact ? 25 : 29,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: glass.bgStrong,
      borderWidth: 1.5,
      borderColor: glass.borderStrong,
    },
    trackingStepLabel: {
      marginTop: 3,
      fontSize: compact ? 8 : 9,
      color: colors.textSecondary,
      fontWeight: fontWeight.semibold,
    },
    latestUpdate: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: compact ? 37 : 45,
      paddingHorizontal: compact ? 7 : spacing.sm,
      borderRadius: 13,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    latestUpdateIcon: {
      width: compact ? 27 : 31,
      height: compact ? 27 : 31,
      borderRadius: 9,
      alignItems: 'center',
      justifyContent: 'center',
    },
    latestUpdateCopy: {
      flex: 1,
      minWidth: 0,
    },
    latestUpdateTitle: {
      fontSize: compact ? 9 : 11,
      color: colors.text,
      fontWeight: fontWeight.bold,
    },
    latestUpdateMeta: {
      marginTop: 1,
      fontSize: compact ? 8 : 9,
      color: colors.textSecondary,
    },
    livePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: 5,
      paddingVertical: 3,
      borderRadius: borderRadius.full,
      backgroundColor: colors.successSubtle,
    },
    liveDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.success,
    },
    liveText: {
      fontSize: 7,
      color: colors.success,
      fontWeight: fontWeight.extrabold,
      letterSpacing: 0.5,
    },

    // Seller growth preview
    sellerMetricsRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    sellerMetricPrimary: {
      flex: 1.4,
      minHeight: compact ? 43 : 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: compact ? spacing.sm : spacing.md,
      borderRadius: 13,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    sellerMetricSmall: {
      flex: 1,
      minHeight: compact ? 43 : 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: compact ? spacing.sm : spacing.md,
      borderRadius: 13,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    sellerMetricLabel: {
      fontSize: 7,
      color: colors.textLight,
      fontWeight: fontWeight.bold,
      letterSpacing: 0.6,
    },
    sellerMetricValue: {
      marginTop: 1,
      fontSize: compact ? 15 : 18,
      color: colors.text,
      fontWeight: fontWeight.extrabold,
    },
    sellerGrowthPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingHorizontal: 5,
      paddingVertical: 3,
      borderRadius: borderRadius.full,
      backgroundColor: colors.successSubtle,
    },
    sellerGrowthText: {
      fontSize: 8,
      color: colors.success,
      fontWeight: fontWeight.bold,
    },
    sellerOrdersValue: {
      fontSize: compact ? 13 : 15,
      color: colors.text,
      fontWeight: fontWeight.extrabold,
    },
    sellerOrdersLabel: {
      fontSize: compact ? 7 : 8,
      color: colors.textSecondary,
    },
    sellerChart: {
      flex: 1,
      minHeight: compact ? 42 : 58,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: compact ? spacing.sm : spacing.md,
      borderRadius: 13,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    sellerChartCopy: {
      flex: 0.9,
    },
    sellerChartTitle: {
      fontSize: compact ? 9 : 11,
      color: colors.text,
      fontWeight: fontWeight.bold,
    },
    sellerChartMeta: {
      marginTop: 2,
      fontSize: compact ? 7 : 9,
      color: colors.textSecondary,
    },
    sellerBars: {
      flex: 1.1,
      height: compact ? 31 : 43,
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: compact ? 3 : 4,
    },
    sellerBar: {
      flex: 1,
      minHeight: 5,
      borderTopLeftRadius: 3,
      borderTopRightRadius: 3,
    },
    aiInsight: {
      minHeight: compact ? 29 : 34,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: compact ? 7 : spacing.sm,
      borderRadius: 11,
      backgroundColor: glass.bgStrong,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    aiInsightIcon: {
      width: compact ? 21 : 24,
      height: compact ? 21 : 24,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    aiInsightText: {
      flex: 1,
      fontSize: compact ? 8 : 10,
      color: colors.text,
      fontWeight: fontWeight.semibold,
    },

    // Benefits
    featuresGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: compact ? 6 : spacing.sm,
    },
    featureChip: {
      width: '100%',
      flexGrow: 1,
      minHeight: compact ? 30 : 34,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: compact ? 7 : spacing.sm,
      paddingVertical: compact ? 4 : 5,
      borderRadius: 12,
      backgroundColor: glass.bgSubtle,
      borderWidth: 1,
      borderColor: glass.borderSubtle,
    },
    featureIcon: {
      width: compact ? 22 : 25,
      height: compact ? 22 : 25,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    featureText: {
      flexShrink: 1,
      fontSize: compact ? 10 : fontSize.sm,
      color: colors.text,
      fontWeight: fontWeight.semibold,
    },

    // Bottom progress dock
    bottomDock: {
      width: Math.min(viewportWidth - (spacing.lg * 2), 528),
      maxWidth: 528,
      minHeight: compact ? 66 : 76,
      alignSelf: 'center',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: compact ? spacing.md : spacing.lg,
      paddingVertical: compact ? spacing.sm : spacing.md,
      marginHorizontal: spacing.lg,
      marginTop: compact ? spacing.xs : spacing.sm,
      borderRadius: 22,
    },
    progressBlock: {
      flex: 1,
      minWidth: 0,
      gap: compact ? 6 : spacing.sm,
    },
    progressLabel: {
      fontSize: compact ? 8 : 9,
      color: colors.textSecondary,
      fontWeight: fontWeight.bold,
      letterSpacing: 0.9,
    },
    pagination: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: compact ? 5 : 6,
    },
    dot: {
      height: 6,
      borderRadius: 3,
    },
    nextButton: {
      minWidth: narrow ? 124 : compact ? 138 : 154,
      minHeight: compact ? 46 : 50,
      borderRadius: 15,
      overflow: 'hidden',
      shadowColor: '#0EA5E9',
      shadowOffset: { width: 0, height: 7 },
      shadowOpacity: 0.34,
      shadowRadius: 14,
      elevation: 6,
    },
    buttonDisabled: {
      opacity: 0.58,
    },
    nextButtonGradient: {
      minHeight: compact ? 46 : 50,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    nextButtonText: {
      color: '#fff',
      fontSize: compact ? fontSize.sm : fontSize.md,
      fontWeight: fontWeight.bold,
    },
    nextIcon: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.18)',
    },
  });
};
