import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';

const favicon = require('../../../assets/brand-favicon.png');

export default function AppLaunchScreen({ message = 'Preparing your marketplace' }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 950,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 950,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [pulse]);

  const logoScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.025],
  });
  const glowOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.28, 0.58],
  });

  return (
    <LinearGradient
      colors={['#F0FDFA', '#F4F8FF', '#EEF2FF']}
      locations={[0, 0.54, 1]}
      style={styles.container}
      accessibilityRole="progressbar"
      accessibilityLabel="Rozare is starting"
    >
      <StatusBar style="dark" backgroundColor="transparent" translucent />
      <View pointerEvents="none" style={styles.ambientTop} />
      <View pointerEvents="none" style={styles.ambientBottom} />

      <View style={styles.content}>
        <Animated.View style={[styles.glow, { opacity: glowOpacity }]} />
        <Animated.View style={[styles.logoWrap, { transform: [{ scale: logoScale }] }]}>
          <Image source={favicon} resizeMode="contain" style={styles.logo} accessibilityIgnoresInvertColors />
        </Animated.View>

        <Text style={styles.brand}>ROZARE</Text>
        <Text style={styles.tagline}>AI-POWERED MARKETPLACE</Text>

        <View style={styles.progressTrack}>
          <Animated.View style={[styles.progressGlow, { opacity: glowOpacity }]} />
          <LinearGradient
            colors={['#14B8A6', '#0EA5E9', '#6366F1']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.progressBar}
          />
        </View>
        <Text style={styles.message}>{message}</Text>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ambientTop: {
    position: 'absolute',
    width: 340,
    height: 340,
    borderRadius: 170,
    top: -180,
    right: -135,
    backgroundColor: 'rgba(45, 212, 191, 0.12)',
  },
  ambientBottom: {
    position: 'absolute',
    width: 320,
    height: 320,
    borderRadius: 160,
    bottom: -180,
    left: -130,
    backgroundColor: 'rgba(129, 140, 248, 0.11)',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  glow: {
    position: 'absolute',
    top: -26,
    width: 184,
    height: 184,
    borderRadius: 92,
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
  },
  logoWrap: {
    width: 132,
    height: 132,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 10,
  },
  logo: {
    width: '100%',
    height: '100%',
  },
  brand: {
    marginTop: 26,
    color: '#334155',
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '900',
    letterSpacing: 5.5,
  },
  tagline: {
    marginTop: 7,
    color: '#64748B',
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '700',
    letterSpacing: 2,
  },
  progressTrack: {
    width: 76,
    height: 3,
    marginTop: 32,
    borderRadius: 999,
    backgroundColor: 'rgba(148, 163, 184, 0.2)',
    overflow: 'hidden',
  },
  progressGlow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#7DD3FC',
  },
  progressBar: {
    width: '58%',
    height: '100%',
    borderRadius: 999,
  },
  message: {
    marginTop: 13,
    color: '#64748B',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '600',
    letterSpacing: 0.25,
  },
});
