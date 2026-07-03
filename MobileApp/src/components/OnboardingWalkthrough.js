/**
 * OnboardingWalkthrough — Liquid Glass first-run experience
 * Matches website's refractive glass aesthetic: aurora background + glass content card.
 */

import React, { useState, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Dimensions, Animated, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { spacing, fontSize, fontWeight, borderRadius, shadows } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import GlassBackground from './common/GlassBackground';
import GlassPanel from './common/GlassPanel';

const { width } = Dimensions.get('window');

const ONBOARDING_KEY = 'onboarding_completed';

const slides = [
  {
    id: '1',
    icon: 'storefront',
    accent: '#6366f1',
    title: 'Discover Stores',
    subtitle: 'Browse seller-run stores across every category, with badges and trust signals where available.',
    features: ['Store trust signals', 'Store reviews', 'Smart category filters'],
  },
  {
    id: '2',
    icon: 'cart',
    accent: '#8b5cf6',
    title: 'Effortless Shopping',
    subtitle: 'Add to cart, apply coupons, and checkout securely — even as a guest.',
    features: ['Guest checkout', 'Multiple payment methods', 'Coupon discounts'],
  },
  {
    id: '3',
    icon: 'navigate',
    accent: '#3b82f6',
    title: 'Order Status Updates',
    subtitle: 'Follow order progress from confirmation to delivery, right inside the app.',
    features: ['Status updates', 'Shipping details', 'Full order history'],
  },
  {
    id: '4',
    icon: 'rocket',
    accent: '#a855f7',
    title: 'Sell on Rozare',
    subtitle: 'Launch a store, manage inventory, and grow your business with AI tools.',
    features: ['Store analytics', 'AI assistant', 'Coupon & subscription tools'],
  },
  {
    id: '5',
    icon: 'sparkles',
    accent: '#ec4899',
    title: 'Stay in the Loop',
    subtitle: 'Instant push alerts for orders, deals, and stock — never miss a beat.',
    features: ['Order notifications', 'Price drop alerts', 'Wishlist updates'],
  },
];

// SecureStore is unavailable on web — fall back to AsyncStorage there so the
// walkthrough doesn't reappear on every visit.
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

export default function OnboardingWalkthrough({ onComplete }) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  const handleNext = () => {
    if (currentIndex < slides.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1 });
      setCurrentIndex(currentIndex + 1);
    } else {
      handleDone();
    }
  };

  const handleSkip = () => handleDone();

  const handleDone = async () => {
    await markOnboardingComplete();
    onComplete();
  };

  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (viewableItems.length > 0) {
      setCurrentIndex(viewableItems[0].index || 0);
    }
  }).current;

  const renderSlide = ({ item }) => (
    <View style={[styles.slide, { width }]}>
      <GlassPanel variant="floating" style={styles.glassCard}>
        {/* Glass icon tile with brand gradient halo */}
        <View style={styles.iconWrap}>
          <LinearGradient
            colors={[item.accent + '33', item.accent + '11']}
            style={styles.iconHalo}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          />
          <View style={[styles.iconTile, { borderColor: item.accent + '55' }]}>
            <Ionicons name={item.icon} size={48} color={item.accent} />
          </View>
        </View>

        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.subtitle}>{item.subtitle}</Text>

        <View style={styles.featuresContainer}>
          {item.features.map((feature, i) => (
            <View key={i} style={styles.featureRow}>
              <View style={[styles.featureDot, { backgroundColor: item.accent }]} />
              <Text style={styles.featureText}>{feature}</Text>
            </View>
          ))}
        </View>
      </GlassPanel>
    </View>
  );

  const isLast = currentIndex === slides.length - 1;

  return (
    <GlassBackground>
      <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        {/* Skip pill */}
        {!isLast && (
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} activeOpacity={0.8}>
            <View style={styles.skipPill}>
              <Text style={styles.skipText}>Skip</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* Slides */}
        <Animated.FlatList
          ref={flatListRef}
          data={slides}
          renderItem={renderSlide}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: false }
          )}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ viewAreaCoveragePercentThreshold: 50 }}
        />

        {/* Bottom controls */}
        <View style={styles.bottomContainer}>
          <View style={styles.pagination}>
            {slides.map((_, i) => {
              const inputRange = [(i - 1) * width, i * width, (i + 1) * width];
              const dotWidth = scrollX.interpolate({
                inputRange,
                outputRange: [8, 28, 8],
                extrapolate: 'clamp',
              });
              const dotOpacity = scrollX.interpolate({
                inputRange,
                outputRange: [0.3, 1, 0.3],
                extrapolate: 'clamp',
              });
              return (
                <Animated.View
                  key={i}
                  style={[styles.dot, { width: dotWidth, opacity: dotOpacity, backgroundColor: colors.primary }]}
                />
              );
            })}
          </View>

          <TouchableOpacity style={styles.nextBtn} onPress={handleNext} activeOpacity={0.85}>
            <LinearGradient
              colors={palette.gradients.primary}
              style={styles.nextBtnGradient}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            >
              <Text style={styles.nextBtnText}>{isLast ? 'Get Started' : 'Next'}</Text>
              <Ionicons name={isLast ? 'checkmark' : 'arrow-forward'} size={20} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </GlassBackground>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; return StyleSheet.create({
  container: { flex: 1 },
  skipBtn: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 20,
    right: spacing.lg,
    zIndex: 10,
  },
  skipPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    backgroundColor: palette.glass.bgStrong,
    borderWidth: 1,
    borderColor: palette.glass.borderStrong,
  },
  skipText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  slide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  glassCard: {
    width: '100%',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    borderRadius: 28,
  },
  iconWrap: {
    width: 128,
    height: 128,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  iconHalo: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 64,
  },
  iconTile: {
    width: 96,
    height: 96,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: palette.glass.bgStrong,
    borderWidth: 1,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: fontWeight.extrabold,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.sm,
  },
  featuresContainer: {
    alignSelf: 'stretch',
    gap: spacing.sm + 2,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: palette.glass.bgSubtle,
    borderWidth: 1,
    borderColor: palette.glass.borderSubtle,
  },
  featureDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  featureText: {
    fontSize: fontSize.sm,
    color: colors.text,
    fontWeight: fontWeight.semibold,
  },
  bottomContainer: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
    gap: spacing.lg,
  },
  pagination: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dot: {
    height: 8,
    borderRadius: 4,
  },
  nextBtn: {
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    ...shadows.primaryMd,
  },
  nextBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  nextBtnText: {
    color: '#fff',
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.3,
  },
}); };
