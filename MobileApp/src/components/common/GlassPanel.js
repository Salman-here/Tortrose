/**
 * GlassPanel Component — Liquid Glass Design (theme-aware)
 * Pulls glass surface colors from the active theme palette so dark mode swaps cleanly.
 * Real blur on every platform: native UIVisualEffectView on iOS, Dimezis BlurView on
 * Android (expo-blur experimentalBlurMethod), CSS backdrop-filter on web.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
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

export default function GlassPanel({ children, style, variant = 'default' }) {
  const { palette, isDark } = useTheme();
  const VARIANTS = buildVariants(palette);
  const v = VARIANTS[variant] || VARIANTS.default;
  const tint = isDark ? 'dark' : 'light';

  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: v.bg, borderColor: v.border },
        style,
      ]}
    >
      <BlurView
        intensity={v.blur}
        tint={tint}
        experimentalBlurMethod="dimezisBlurView"
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
});
