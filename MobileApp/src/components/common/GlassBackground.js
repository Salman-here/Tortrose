/**
 * GlassBackground Component — Liquid Glass Design
 * Full-screen gradient background with animated floating orbs
 * Matches the web platform's multi-step HSL gradient aesthetic
 */

import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Dimensions, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../styles/theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

const Orb = ({ size, color, initialX, initialY, duration }) => {
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animateX = Animated.loop(
      Animated.sequence([
        Animated.timing(translateX, { toValue: 30, duration: duration, useNativeDriver: true }),
        Animated.timing(translateX, { toValue: -30, duration: duration * 1.2, useNativeDriver: true }),
      ])
    );
    const animateY = Animated.loop(
      Animated.sequence([
        Animated.timing(translateY, { toValue: -25, duration: duration * 0.9, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 25, duration: duration * 1.1, useNativeDriver: true }),
      ])
    );
    animateX.start();
    animateY.start();
    return () => { animateX.stop(); animateY.stop(); };
  }, []);

  return (
    <Animated.View
      style={[
        styles.orb,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          left: initialX,
          top: initialY,
          transform: [{ translateX }, { translateY }],
        },
      ]}
    />
  );
};

export default function GlassBackground({ children, style, variant = 'default' }) {
  const gradientColors = variant === 'dark'
    ? ['#1a1a2e', '#16213e', '#0f3460', '#1a1a2e']
    : ['#eef2ff', '#e0e7ff', '#dbeafe', '#ede9fe', '#e0e7ff'];

  return (
    <View style={[styles.container, style]}>
      <LinearGradient colors={gradientColors} style={styles.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        {/* Floating orbs for depth */}
        <View style={styles.orbContainer} pointerEvents="none">
          <Orb size={200} color={Platform.OS === 'ios' ? 'rgba(99, 102, 241, 0.08)' : 'rgba(99, 102, 241, 0.12)'} initialX={-50} initialY={100} duration={8000} />
          <Orb size={160} color={Platform.OS === 'ios' ? 'rgba(139, 92, 246, 0.06)' : 'rgba(139, 92, 246, 0.1)'} initialX={SCREEN_WIDTH - 100} initialY={300} duration={10000} />
          <Orb size={120} color={Platform.OS === 'ios' ? 'rgba(59, 130, 246, 0.07)' : 'rgba(59, 130, 246, 0.11)'} initialX={50} initialY={SCREEN_HEIGHT - 300} duration={9000} />
          <Orb size={180} color={Platform.OS === 'ios' ? 'rgba(168, 85, 247, 0.05)' : 'rgba(168, 85, 247, 0.09)'} initialX={SCREEN_WIDTH - 150} initialY={50} duration={11000} />
        </View>
        {children}
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  gradient: {
    flex: 1,
  },
  orbContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  orb: {
    position: 'absolute',
    ...(Platform.OS === 'ios' ? {
      shadowColor: 'rgba(99, 102, 241, 0.3)',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 1,
      shadowRadius: 40,
    } : {}),
  },
});
