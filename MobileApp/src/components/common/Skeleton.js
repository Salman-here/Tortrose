/**
 * Skeleton — themed shimmering placeholder
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing } from '../../styles/theme';

export function Skeleton({ width, height = 16, radius = 8, style }) {
  const { palette } = useTheme();
  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(shimmer, { toValue: 1, duration: 900, useNativeDriver: true }),
      Animated.timing(shimmer, { toValue: 0, duration: 900, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  const opacity = shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });
  return (
    <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: palette.colors.primarySubtle, opacity }, style]} />
  );
}

export function ProductCardSkeleton({ width: cardWidth }) {
  const { palette } = useTheme();
  const cardStyle = { backgroundColor: palette.glass.bg, borderColor: palette.glass.border };
  return (
    <View style={[skeletonStyles.card, cardStyle, cardWidth ? { width: cardWidth } : null]}>
      <Skeleton width="100%" height={140} radius={16} />
      <View style={{ padding: 12, gap: 8 }}>
        <Skeleton width="40%" height={9} radius={4} />
        <Skeleton width="90%" height={14} radius={6} />
        <Skeleton width="60%" height={14} radius={6} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
          <Skeleton width={60} height={18} radius={6} />
          <Skeleton width={70} height={28} radius={14} />
        </View>
      </View>
    </View>
  );
}

export function ProductGridSkeleton({ count = 6 }) {
  return (
    <View style={skeletonStyles.grid}>
      {Array.from({ length: count }).map((_, i) => <ProductCardSkeleton key={i} />)}
    </View>
  );
}

export function CartItemSkeleton() {
  const { palette } = useTheme();
  return (
    <View style={[skeletonStyles.cartRow, { backgroundColor: palette.glass.bg, borderColor: palette.glass.border }]}>
      <Skeleton width={90} height={90} radius={12} />
      <View style={{ flex: 1, marginLeft: 12, gap: 8 }}>
        <Skeleton width="40%" height={10} radius={4} />
        <Skeleton width="85%" height={14} radius={6} />
        <Skeleton width="50%" height={18} radius={6} />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          <Skeleton width={100} height={32} radius={16} />
          <Skeleton width={36} height={36} radius={18} />
        </View>
      </View>
    </View>
  );
}

export function StoreGridSkeleton({ count = 6 }) {
  const { palette } = useTheme();
  return <View testID="store-grid-skeleton" accessibilityLabel="Loading stores" accessibilityState={{ busy: true }} style={skeletonStyles.grid}>
    {Array.from({ length: count }, (_, index) => <View key={index} style={{ width: '50%', padding: 5 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={{ minHeight: 224, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: palette.glass.border, backgroundColor: palette.glass.bg }}>
        <Skeleton width="100%" height={72} radius={0} />
        <View style={{ padding: 12, gap: 9 }}>
          <Skeleton width={42} height={42} radius={13} style={{ marginTop: -28 }} />
          <Skeleton width="84%" height={15} /><Skeleton width="58%" height={10} />
          <Skeleton width="96%" height={11} /><Skeleton width="75%" height={11} />
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}><Skeleton width="36%" height={12} /><Skeleton width="36%" height={12} /></View>
        </View>
      </View>
    </View>)}
  </View>;
}

export function SliderSkeleton({ count = 4 }) {
  const { palette } = useTheme();
  const cardStyle = { backgroundColor: palette.glass.bg, borderColor: palette.glass.border };
  return (
    <View style={skeletonStyles.sliderRow}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={[skeletonStyles.sliderCard, cardStyle]}>
          <Skeleton width="100%" height={130} radius={14} />
          <View style={{ padding: 8, gap: 6 }}>
            <Skeleton width="80%" height={12} radius={4} />
            <Skeleton width="50%" height={14} radius={6} />
          </View>
        </View>
      ))}
    </View>
  );
}

const skeletonStyles = StyleSheet.create({
  card: { flex: 1, borderRadius: 20, borderWidth: 1, overflow: 'hidden', margin: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.sm },
  cartRow: { flexDirection: 'row', padding: spacing.md, marginBottom: spacing.md, borderRadius: 22, borderWidth: 1, marginHorizontal: spacing.md },
  sliderRow: { flexDirection: 'row', paddingHorizontal: spacing.md, gap: spacing.sm },
  sliderCard: { width: 160, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
});

export default Skeleton;
