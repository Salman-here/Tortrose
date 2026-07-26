/**
 * GlassBlurFill — absolute-fill blur layer for glass surfaces that aren't GlassPanel.
 * Drop as the FIRST child of any View/Touchable with a translucent glass background
 * and `overflow: 'hidden'` to get the website-navbar glass effect.
 * On Android this renders a lightweight glass sheen instead of SDK 54's
 * experimental native blur. High-density cards can opt out with
 * `androidBlur={false}` while retaining their translucent parent surface.
 */

import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../../contexts/ThemeContext';

export default function GlassBlurFill({ intensity = 40, androidBlur = true }) {
  const { isDark } = useTheme();

  if (Platform.OS === 'android' && !androidBlur) return null;

  if (Platform.OS === 'android') {
    return (
      <LinearGradient
        colors={isDark
          ? ['rgba(255,255,255,0.055)', 'rgba(99,102,241,0.05)', 'rgba(255,255,255,0.015)']
          : ['rgba(255,255,255,0.18)', 'rgba(99,102,241,0.035)', 'rgba(255,255,255,0.05)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
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
