/**
 * GlassPanel Component — Liquid Glass Design (theme-aware)
 * Pulls glass surface colors from the active theme palette so dark mode swaps cleanly.
 * SDK 55 uses a shared BlurTargetView for stable Android background blur.
 * Android 12+ uses RenderNode; older Android versions keep native blur only on
 * larger surfaces and use the translucent theme surface for repeated cards.
 */

import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { borderRadius as br, shadows, spacing } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useGlassBlurTarget } from '../../contexts/GlassBlurContext';

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
  const blurTarget = useGlassBlurTarget();
  const androidApiLevel = Platform.OS === 'android'
    ? Number.parseInt(String(Platform.Version), 10)
    : 0;
  const isModernAndroid = androidApiLevel >= 31;
  const isLargeSurface = variant === 'floating' || variant === 'strong';
  const useNativeAndroidBlur = Platform.OS === 'android'
    && androidBlur
    && blurTarget
    && (isModernAndroid || isLargeSurface);
  const surfaceStyle = [
    styles.panel,
    { backgroundColor: v.bg, borderColor: v.border },
    Platform.OS === 'android' && styles.androidPanel,
    style,
  ];

  if (Platform.OS === 'android' && !useNativeAndroidBlur) {
    return (
      <View
        {...viewProps}
        style={surfaceStyle}
      >
        {children}
      </View>
    );
  }

  return (
    <View
      {...viewProps}
      style={surfaceStyle}
    >
      <BlurView
        intensity={Platform.OS === 'android' ? Math.min(v.blur + 8, 68) : v.blur}
        tint={tint}
        blurTarget={Platform.OS === 'android' ? blurTarget : undefined}
        blurMethod={Platform.OS === 'android'
          ? (isModernAndroid ? 'dimezisBlurViewSdk31Plus' : 'dimezisBlurView')
          : undefined}
        blurReductionFactor={Platform.OS === 'android' ? 4 : undefined}
        style={Platform.OS === 'android' ? styles.androidBlurLayer : StyleSheet.absoluteFill}
        pointerEvents="none"
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
  // React Native positions absolute children from a padded content box on some
  // Android renderers. Overscanning and clipping removes the inset rectangle.
  androidBlurLayer: {
    position: 'absolute',
    top: -48,
    right: -48,
    bottom: -48,
    left: -48,
  },
});
