/**
 * GlassBlurFill — absolute-fill blur layer for glass surfaces that aren't GlassPanel.
 * Drop as the FIRST child of any View/Touchable with a translucent glass background
 * and `overflow: 'hidden'` to get the website-navbar glass effect.
 * SDK 55 Android surfaces share the screen's BlurTargetView. This gives all
 * non-opted-out glass surfaces real blur without a capture target per card.
 */

import React from 'react';
import { Platform, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '../../contexts/ThemeContext';
import { useGlassBlurTarget } from '../../contexts/GlassBlurContext';

export default function GlassBlurFill({
  intensity = 40,
  androidBlur = true,
}) {
  const { isDark } = useTheme();
  const blurTarget = useGlassBlurTarget();

  if (Platform.OS === 'android') {
    if (!androidBlur || !blurTarget) return null;
    const androidApiLevel = Number.parseInt(String(Platform.Version), 10);
    if (androidApiLevel < 31) return null;
    return (
      <BlurView
        intensity={Math.min(intensity + 10, 68)}
        tint={isDark ? 'dark' : 'light'}
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        blurReductionFactor={4}
        style={styles.androidBlurLayer}
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

const styles = StyleSheet.create({
  androidBlurLayer: {
    position: 'absolute',
    top: -48,
    right: -48,
    bottom: -48,
    left: -48,
  },
});
