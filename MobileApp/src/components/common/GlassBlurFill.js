/**
 * GlassBlurFill — absolute-fill blur layer for glass surfaces that aren't GlassPanel.
 * Drop as the FIRST child of any View/Touchable with a translucent glass background
 * and `overflow: 'hidden'` to get the website-navbar backdrop-blur effect.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '../../contexts/ThemeContext';

export default function GlassBlurFill({ intensity = 40 }) {
  const { isDark } = useTheme();
  return (
    <BlurView
      intensity={intensity}
      tint={isDark ? 'dark' : 'light'}
      experimentalBlurMethod="dimezisBlurView"
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
    />
  );
}
