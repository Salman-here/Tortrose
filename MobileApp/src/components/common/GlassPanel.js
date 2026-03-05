/**
 * GlassPanel Component — Liquid Glass Design
 * Single-layer translucent card with blur and border effects
 * No nested inner box — styles applied directly to the main container
 */

import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { borderRadius as br, shadows, spacing } from '../../styles/theme';

const VARIANTS = {
  default: {
    ios: { backgroundColor: 'rgba(255,255,255,0.45)', borderColor: 'rgba(255,255,255,0.5)', blurIntensity: 40 },
    android: { backgroundColor: 'rgba(255,255,255,0.88)', borderColor: 'rgba(0,0,0,0.06)' },
  },
  card: {
    ios: { backgroundColor: 'rgba(255,255,255,0.5)', borderColor: 'rgba(255,255,255,0.55)', blurIntensity: 50 },
    android: { backgroundColor: 'rgba(255,255,255,0.92)', borderColor: 'rgba(0,0,0,0.06)' },
  },
  strong: {
    ios: { backgroundColor: 'rgba(255,255,255,0.6)', borderColor: 'rgba(255,255,255,0.65)', blurIntensity: 60 },
    android: { backgroundColor: 'rgba(255,255,255,0.95)', borderColor: 'rgba(0,0,0,0.05)' },
  },
  floating: {
    ios: { backgroundColor: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.6)', blurIntensity: 55 },
    android: { backgroundColor: 'rgba(255,255,255,0.93)', borderColor: 'rgba(0,0,0,0.06)' },
  },
  inner: {
    ios: { backgroundColor: 'rgba(255,255,255,0.3)', borderColor: 'rgba(255,255,255,0.4)', blurIntensity: 30 },
    android: { backgroundColor: 'rgba(255,255,255,0.82)', borderColor: 'rgba(0,0,0,0.04)' },
  },
};

export default function GlassPanel({ children, style, variant = 'default' }) {
  const config = VARIANTS[variant] || VARIANTS.default;

  if (Platform.OS === 'ios') {
    const v = config.ios;
    return (
      <View
        style={[
          styles.panel,
          {
            backgroundColor: v.backgroundColor,
            borderColor: v.borderColor,
          },
          style,
        ]}
      >
        <BlurView intensity={v.blurIntensity} tint="light" style={StyleSheet.absoluteFill} />
        {children}
      </View>
    );
  }

  // Android — higher opacity, subtle colored border, and a soft shadow for depth
  const v = config.android;
  return (
    <View style={[styles.panel, styles.androidPanel, { backgroundColor: v.backgroundColor, borderColor: v.borderColor }, style]}>
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
    // Soft shadow for Android — no colored shadow to avoid double-box look
    elevation: 2,
    shadowColor: 'rgba(0, 0, 0, 0.08)',
  },
});
