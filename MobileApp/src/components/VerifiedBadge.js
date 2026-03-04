/**
 * VerifiedBadge — Liquid Glass Design
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../styles/theme';

const VerifiedBadge = ({ size = 'md', style }) => {
  const sizes = { xs: 14, sm: 16, md: 20, lg: 24 };
  const iconSize = sizes[size] || sizes.md;

  return (
    <View style={[styles.container, style]}>
      <Ionicons name="checkmark-circle" size={iconSize} color={colors.primary} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { justifyContent: 'center', alignItems: 'center' },
});

export default VerifiedBadge;
