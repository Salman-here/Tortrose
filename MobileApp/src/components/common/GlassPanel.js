/**
 * GlassPanel Component — Liquid Glass Design
 * Single-layer translucent card (no double-boxing)
 */

import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { borderRadius as br, shadows, spacing } from '../../styles/theme';

const VARIANTS = {
  default: {
    backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.72)',
    borderColor: 'rgba(255,255,255,0.5)',
    blurIntensity: 40,
  },
  card: {
    backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.78)',
    borderColor: 'rgba(255,255,255,0.55)',
    blurIntensity: 50,
  },
  strong: {
    backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.85)',
    borderColor: 'rgba(255,255,255,0.65)',
    blurIntensity: 60,
  },
  floating: {
    backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.82)',
    borderColor: 'rgba(255,255,255,0.6)',
    blurIntensity: 55,
  },
  inner: {
    backgroundColor: Platform.OS === 'ios' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.6)',
    borderColor: 'rgba(255,255,255,0.4)',
    blurIntensity: 30,
  },
};

export default function GlassPanel({ children, style, variant = 'default' }) {
  const v = VARIANTS[variant] || VARIANTS.default;

  if (Platform.OS === 'ios') {
    return (
      <View
        style={[
          styles.panel,
          { backgroundColor: v.backgroundColor, borderColor: v.borderColor },
          style,
        ]}
      >
        <BlurView
          intensity={v.blurIntensity}
          tint="light"
          style={StyleSheet.absoluteFill}
        />
        {children}
      </View>
    );
  }

  // Android fallback
  return (
    <View style={[styles.panel, { backgroundColor: v.backgroundColor, borderColor: v.borderColor }, style]}>
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
