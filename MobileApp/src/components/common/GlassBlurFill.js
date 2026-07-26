/**
 * GlassBlurFill — absolute-fill blur layer for glass surfaces that aren't GlassPanel.
 * Drop as the FIRST child of any View/Touchable with a translucent glass background
 * and `overflow: 'hidden'` to get the website-navbar glass effect.
 * Android defaults to the parent's translucent surface so repeated list cards
 * stay stable. A small number of large surfaces can explicitly opt into native
 * blur with `nativeAndroidBlur`; this avoids the previous blur-per-card crash.
 */

import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '../../contexts/ThemeContext';

export default function GlassBlurFill({
  intensity = 40,
  androidBlur = true,
  nativeAndroidBlur = false,
}) {
  const { isDark } = useTheme();

  if (Platform.OS === 'android') {
    if (!androidBlur || !nativeAndroidBlur) return null;
    return (
      <BlurView
        intensity={Math.min(intensity, 48)}
        tint={isDark ? 'dark' : 'light'}
        experimentalBlurMethod="dimezisBlurView"
        blurReductionFactor={6}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
    );
  }

  return (
    <BlurView
      intensity={intensity}
      tint={isDark ? 'dark' : 'light'}
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}
