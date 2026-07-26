/**
 * GlassBackground Component — Liquid Glass Design
 * Full-screen gradient background with animated floating aurora orbs.
 * Orbs are SVG radial gradients (soft glow fading to transparent) so they render
 * softly on every platform — matching the web's blurred gradient blobs.
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated, Dimensions, Platform, StatusBar } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurTargetView } from 'expo-blur';
import Svg, { Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';
import { GlassBlurTargetProvider } from '../../contexts/GlassBlurContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const Orb = ({ id, size, color, opacity, initialX, initialY, duration, animate = true }) => {
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate) return undefined;

    const animateX = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, { toValue: 30, duration: duration, useNativeDriver: true }),
        Animated.timing(translateX, { toValue: -30, duration: duration * 1.2, useNativeDriver: true }),
      ])
    );
    const animateY = Animated.loop(
      Animated.sequence([
        Animated.timing(translateY, { toValue: -25, duration: duration * 0.9, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 25, duration: duration * 1.1, useNativeDriver: true }),
      ])
    );
    animateX.start();
    animateY.start();
    return () => { animateX.stop(); animateY.stop(); };
  }, [animate, duration, translateX, translateY]);

  const gradientId = `orb-gradient-${id}`;
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: initialX,
        top: initialY,
        width: size,
        height: size,
        transform: [{ translateX }, { translateY }],
      }}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={gradientId} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={color} stopOpacity={opacity} />
            <Stop offset="55%" stopColor={color} stopOpacity={opacity * 0.45} />
            <Stop offset="100%" stopColor={color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${gradientId})`} />
      </Svg>
    </Animated.View>
  );
};

export default function GlassBackground({ children, style, variant = 'default' }) {
  const { palette, isDark } = useTheme();
  const blurTargetRef = useRef(null);
  const [blurTargetReady, setBlurTargetReady] = useState(false);
  const gradientColors = palette.gradients.background;
  // Moving a full-screen blur target makes every Android BlurView recapture on
  // every animation frame. Keep the aurora static on Android so scrolling has
  // the GPU budget, while iOS/web retain the ambient movement.
  const animateAurora = Platform.OS !== 'android';

  // Aurora orbs — brand hues, soft glow; slightly brighter in dark mode for depth
  const orbOpacity = isDark
    ? { a: 0.22, b: 0.18, c: 0.2, d: 0.16 }
    : { a: 0.2, b: 0.16, c: 0.18, d: 0.14 };
  const orbColors = isDark
    ? { a: '#818cf8', b: '#a78bfa', c: '#60a5fa', d: '#c084fc' }
    : { a: '#6366f1', b: '#8b5cf6', c: '#3b82f6', d: '#a855f7' };

  return (
    <View style={[styles.container, style]}>
      <BlurTargetView
        ref={blurTargetRef}
        style={styles.backdropTarget}
        onLayout={() => setBlurTargetReady(true)}
      >
        <LinearGradient colors={gradientColors} style={styles.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
          {/* Floating aurora orbs for depth */}
          <View style={styles.orbContainer} pointerEvents="none">
            <Orb id="a" size={320} color={orbColors.a} opacity={orbOpacity.a} initialX={-90} initialY={40} duration={8000} animate={animateAurora} />
            <Orb id="b" size={280} color={orbColors.b} opacity={orbOpacity.b} initialX={SCREEN_WIDTH - 160} initialY={260} duration={10000} animate={animateAurora} />
            <Orb id="c" size={240} color={orbColors.c} opacity={orbOpacity.c} initialX={10} initialY={SCREEN_HEIGHT - 340} duration={9000} animate={animateAurora} />
            <Orb id="d" size={300} color={orbColors.d} opacity={orbOpacity.d} initialX={SCREEN_WIDTH - 200} initialY={-60} duration={11000} animate={animateAurora} />
          </View>
        </LinearGradient>
      </BlurTargetView>

      {/* Keep controls below Android's status bar without pushing the gradient
          down. The aurora now paints edge-to-edge behind the time/battery row. */}
      {/* Mount Android BlurViews only after the native target has completed its
          first layout. This avoids Expo BlurView permanently falling back to
          `none` when its ref is still null during the first native commit. */}
      <GlassBlurTargetProvider targetRef={blurTargetReady ? blurTargetRef : null}>
        <View style={[styles.contentFrame, Platform.OS === 'android' && styles.androidSafeTop]}>
          <SafeAreaView style={styles.content} edges={['bottom', 'left', 'right']}>
            {children}
          </SafeAreaView>
        </View>
      </GlassBlurTargetProvider>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  backdropTarget: {
    ...StyleSheet.absoluteFillObject,
  },
  androidSafeTop: {
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0,
  },
  gradient: {
    ...StyleSheet.absoluteFillObject,
  },
  contentFrame: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
  orbContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
});
