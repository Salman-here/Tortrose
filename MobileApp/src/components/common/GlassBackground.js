/**
 * GlassBackground Component — Liquid Glass Design
 * Full-screen gradient background with animated floating aurora orbs.
 * Orbs are SVG radial gradients (soft glow fading to transparent) so they render
 * softly on every platform — matching the web's blurred gradient blobs.
 */

import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Dimensions, Platform, StatusBar } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../contexts/ThemeContext';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const Orb = ({ id, size, color, opacity, initialX, initialY, duration }) => {
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
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
  }, []);

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
  const gradientColors = palette.gradients.background;

  // Aurora orbs — brand hues, soft glow; slightly brighter in dark mode for depth
  const orbOpacity = isDark
    ? { a: 0.22, b: 0.18, c: 0.2, d: 0.16 }
    : { a: 0.2, b: 0.16, c: 0.18, d: 0.14 };
  const orbColors = isDark
    ? { a: '#818cf8', b: '#a78bfa', c: '#60a5fa', d: '#c084fc' }
    : { a: '#6366f1', b: '#8b5cf6', c: '#3b82f6', d: '#a855f7' };

  return (
    <View style={[styles.container, Platform.OS === 'android' && styles.androidSafeTop, style]}>
      <LinearGradient colors={gradientColors} style={styles.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        {/* Floating aurora orbs for depth */}
        <View style={styles.orbContainer} pointerEvents="none">
          <Orb id="a" size={320} color={orbColors.a} opacity={orbOpacity.a} initialX={-90} initialY={40} duration={8000} />
          <Orb id="b" size={280} color={orbColors.b} opacity={orbOpacity.b} initialX={SCREEN_WIDTH - 160} initialY={260} duration={10000} />
          <Orb id="c" size={240} color={orbColors.c} opacity={orbOpacity.c} initialX={10} initialY={SCREEN_HEIGHT - 340} duration={9000} />
          <Orb id="d" size={300} color={orbColors.d} opacity={orbOpacity.d} initialX={SCREEN_WIDTH - 200} initialY={-60} duration={11000} />
        </View>
        {/* Bounded flex:1 content area so a screen's ScrollView/FlatList has a
            definite height to scroll within (fixes no-scroll when a scroll view
            is the direct child of GlassBackground). SafeAreaView also keeps
            content clear of notches/home indicators. `edges` omits top so
            screens' own glass headers control the top spacing. */}
        <SafeAreaView style={styles.content} edges={['bottom', 'left', 'right']}>{children}</SafeAreaView>
      </LinearGradient>
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  androidSafeTop: {
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0,
  },
  gradient: {
    flex: 1,
  },
  content: {
    // Absolutely fill the gradient so the content area has a DEFINITE height
    // (equal to the screen) regardless of the flex chain. Without this, a screen
    // whose only child is a ScrollView can't establish a scrollable height on web
    // because expo-linear-gradient's wrapper doesn't reliably propagate flex:1.
    ...StyleSheet.absoluteFillObject,
  },
  orbContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
});
