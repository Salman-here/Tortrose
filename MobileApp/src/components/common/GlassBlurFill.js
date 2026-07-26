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
import { LinearGradient } from 'expo-linear-gradient';
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
    const androidIntensity = Math.max(28, Math.min(Math.round(intensity * 0.8), 40));
    return (
      <>
        <BlurView
          intensity={androidIntensity}
          tint={isDark ? 'dark' : 'default'}
          blurTarget={blurTarget}
          blurMethod="dimezisBlurViewSdk31Plus"
          blurReductionFactor={1}
          style={styles.androidBlurLayer}
          pointerEvents="none"
        />
        <LinearGradient
          colors={isDark
            ? ['rgba(255,255,255,0.075)', 'rgba(255,255,255,0.012)', 'rgba(99,102,241,0.04)']
            : ['rgba(255,255,255,0.20)', 'rgba(255,255,255,0.025)', 'rgba(99,102,241,0.03)']}
          locations={[0, 0.52, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      </>
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
