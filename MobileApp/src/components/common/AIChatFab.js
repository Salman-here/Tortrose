/**
 * AIChatFab — floating AI chat launcher matching the website's ChatBot button:
 * brand gradient circle, white chat icon, pulsing ring, amber sparkle badge.
 */

import React, { useEffect, useRef } from 'react';
import { TouchableOpacity, View, Animated, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

// Same gradient as the website's BRAND_GRADIENT (teal → sky → indigo, 135deg)
const BRAND_GRADIENT = ['#14B8A6', '#0EA5E9', '#6366F1'];

export default function AIChatFab({ onPress, style }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.3, 0.1, 0] });

  return (
    <View style={[styles.wrap, style]} pointerEvents="box-none">
      {/* Pulse ring */}
      <Animated.View
        pointerEvents="none"
        style={[styles.ring, { transform: [{ scale: ringScale }], opacity: ringOpacity }]}
      />
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} accessibilityLabel="Open Rozare AI chat">
        <LinearGradient
          colors={BRAND_GRADIENT}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.fab}
        >
          <Ionicons name="chatbubble" size={24} color="#fff" />
        </LinearGradient>
        {/* Sparkle badge */}
        <View style={styles.badge}>
          <Ionicons name="sparkles" size={9} color="#fff" />
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 96,
    right: 16,
    width: 56,
    height: 56,
    zIndex: 50,
  },
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0EA5E9',
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 10,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#f59e0b',
    borderWidth: 2,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
