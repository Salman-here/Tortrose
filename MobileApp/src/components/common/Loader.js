/**
 * Loader Component — Liquid Glass Design
 * Orbiting gradient dots around a frosted glass backdrop with pulsing center
 * Matches the web platform's Loader component
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing, Platform } from 'react-native';
import { colors, spacing } from '../../styles/theme';

const SIZES = {
  small: { container: 48, orb: 10, gap: 12 },
  medium: { container: 80, orb: 14, gap: 18 },
  large: { container: 112, orb: 18, gap: 24 },
};

const ORB_COLORS = [
  ['#60a5fa', '#6366f1'], // blue to indigo
  ['#a78bfa', '#ec4899'], // purple to pink
  ['#22d3ee', '#3b82f6'], // cyan to blue
  ['#818cf8', '#a855f7'], // indigo to purple
];

const Loader = ({ size = 'medium', text = '', fullScreen = false, style }) => {
  const s = SIZES[size] || SIZES.medium;
  const orbAnims = useRef(ORB_COLORS.map(() => new Animated.Value(0))).current;
  const scaleAnims = useRef(ORB_COLORS.map(() => new Animated.Value(1))).current;
  const centerScale = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    // Orbit rotations
    orbAnims.forEach((anim, i) => {
      Animated.loop(
        Animated.timing(anim, {
          toValue: 1,
          duration: 2400,
          delay: i * 150,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      ).start();
    });

    // Scale pulses for orbs
    scaleAnims.forEach((anim, i) => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 1.3, duration: 600, delay: i * 300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(anim, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      ).start();
    });

    // Center pulse
    Animated.loop(
      Animated.sequence([
        Animated.timing(centerScale, { toValue: 1.2, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(centerScale, { toValue: 0.8, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    ).start();

    return () => {
      orbAnims.forEach(a => a.stopAnimation());
      scaleAnims.forEach(a => a.stopAnimation());
      centerScale.stopAnimation();
    };
  }, []);

  const renderLoader = () => (
    <View style={[styles.loaderWrap, style]}>
      <View style={[styles.container, { width: s.container, height: s.container }]}>  
        {/* Glass backdrop circle */}
        <View style={[styles.glassBackdrop, { width: s.container, height: s.container, borderRadius: s.container / 2 }]} />

        {/* Orbiting dots */}
        {ORB_COLORS.map((colorPair, i) => {
          const rotation = orbAnims[i].interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
          return (
            <Animated.View
              key={i}
              style={[
                styles.orbiter,
                { width: s.container, height: s.container, transform: [{ rotate: rotation }] },
              ]}
            >
              <Animated.View
                style={[
                  styles.orb,
                  {
                    width: s.orb,
                    height: s.orb,
                    borderRadius: s.orb / 2,
                    backgroundColor: colorPair[0],
                    top: (s.container / 2) - s.gap - (s.orb / 2),
                    left: (s.container - s.orb) / 2,
                    transform: [{ scale: scaleAnims[i] }],
                    ...Platform.select({
                      ios: { shadowColor: colorPair[0], shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.5, shadowRadius: 4 },
                      android: { elevation: 4 },
                    }),
                  },
                ]}
              />
            </Animated.View>
          );
        })}

        {/* Center pulse dot */}
        <Animated.View
          style={[
            styles.centerDot,
            {
              width: 10,
              height: 10,
              borderRadius: 5,
              transform: [{ scale: centerScale }],
            },
          ]}
        />
      </View>

      {text ? (
        <Text style={styles.text}>{text}</Text>
      ) : null}
    </View>
  );

  if (fullScreen) {
    return (
      <View style={styles.fullScreen}>
        <View style={styles.backdrop} />
        {renderLoader()}
      </View>
    );
  }

  return renderLoader();
};

// Loading overlay for screens
export const LoadingOverlay = ({ visible, message }) => {
  if (!visible) return null;
  return (
    <View style={styles.overlayContainer}>
      <View style={styles.overlayContent}>
        <Loader size="medium" text={message} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  loaderWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  glassBackdrop: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.06, shadowRadius: 32 },
      android: { elevation: 2 },
    }),
  },
  orbiter: {
    position: 'absolute',
  },
  orb: {
    position: 'absolute',
  },
  centerDot: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  text: {
    fontSize: 14,
    fontWeight: '500',
    color: 'rgba(100,110,130,0.8)',
  },
  fullScreen: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  overlayContent: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    padding: spacing.xxl,
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12 },
      android: { elevation: 8 },
    }),
  },
});

export default Loader;
