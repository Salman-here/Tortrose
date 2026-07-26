/**
 * GlassPanel Component — Liquid Glass Design (theme-aware)
 * Pulls glass surface colors from the active theme palette so dark mode swaps cleanly.
 * iOS/web use real blur. Expo SDK 54's Android blur is experimental, so only
 * larger floating/strong surfaces use it on Android. Smaller and repeated
 * cards use a gradient as the surface itself (not an absolute child), avoiding
 * Android's sharp content-box rectangle inside padded cards.
 */

import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { borderRadius as br, shadows, spacing } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const buildVariants = (palette) => {
  const g = palette.glass;
  return {
    default: { bg: g.bg, border: g.border, blur: g.blur },
    card:    { bg: g.bg, border: g.border, blur: g.blur },
    strong:  { bg: g.bgStrong, border: g.borderStrong, blur: g.blurStrong },
    floating:{ bg: g.bgStrong, border: g.borderStrong, blur: g.blurStrong },
    inner:   { bg: g.bgSubtle, border: g.borderSubtle, blur: 30 },
  };
};

export default function GlassPanel({
  children,
  style,
  variant = 'default',
  androidBlur = true,
  ...viewProps
}) {
  const { palette, isDark } = useTheme();
  const VARIANTS = buildVariants(palette);
  const v = VARIANTS[variant] || VARIANTS.default;
  const tint = isDark ? 'dark' : 'light';
  const useNativeAndroidBlur = androidBlur
    && (variant === 'floating' || variant === 'strong');
  const androidSheen = isDark
    ? ['rgba(255,255,255,0.055)', 'rgba(99,102,241,0.05)', 'rgba(255,255,255,0.015)']
    : ['rgba(255,255,255,0.18)', 'rgba(99,102,241,0.035)', 'rgba(255,255,255,0.05)'];
  const surfaceStyle = [
    styles.panel,
    { backgroundColor: v.bg, borderColor: v.border },
    Platform.OS === 'android' && styles.androidPanel,
    style,
  ];

  if (Platform.OS === 'android' && !useNativeAndroidBlur) {
    return (
      <LinearGradient
        {...viewProps}
        colors={androidSheen}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={surfaceStyle}
      >
        {children}
      </LinearGradient>
    );
  }

  return (
    <View
      {...viewProps}
      style={surfaceStyle}
    >
      <BlurView
        intensity={Platform.OS === 'android' ? Math.min(v.blur, 52) : v.blur}
        tint={tint}
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
        blurReductionFactor={Platform.OS === 'android' ? 6 : undefined}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: br.xl,
    borderWidth: 1,
    padding: spacing.lg,
    overflow: 'hidden',
    ...shadows.md,
  },
  androidPanel: {
    elevation: 0,
  },
});
