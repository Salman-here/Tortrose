/**
 * GradientButton — primary CTA matching the website's --logo-gradient buttons
 * (teal → sky → indigo, 135deg) with the sky glow shadow.
 */

import React from 'react';
import { Text, TouchableOpacity, ActivityIndicator, View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { spacing, fontSize, fontWeight } from '../../styles/theme';

export const LOGO_GRADIENT = ['#14B8A6', '#0EA5E9', '#6366F1'];

export default function GradientButton({
  title,
  onPress,
  icon,
  iconRight,
  loading = false,
  disabled = false,
  size = 'md', // 'sm' | 'md' | 'lg'
  style,
  textStyle,
}) {
  const pad = size === 'lg' ? 16 : size === 'sm' ? 8 : 12;
  const font = size === 'lg' ? fontSize.lg : size === 'sm' ? fontSize.sm : fontSize.md;
  const iconSize = size === 'lg' ? 20 : 16;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
      style={[styles.glow, disabled && styles.disabled, style]}
    >
      <LinearGradient
        colors={LOGO_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.button, { paddingVertical: pad }]}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <View style={styles.content}>
            {icon ? <Ionicons name={icon} size={iconSize} color="#fff" /> : null}
            <Text style={[styles.text, { fontSize: font }, textStyle]}>{title}</Text>
            {iconRight ? <Ionicons name={iconRight} size={iconSize} color="#fff" /> : null}
          </View>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  glow: {
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 6,
  },
  disabled: { opacity: 0.55 },
  button: {
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    minHeight: 44,
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { color: '#fff', fontWeight: fontWeight.bold },
});
