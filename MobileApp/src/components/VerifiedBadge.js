import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const VerifiedBadge = ({ size = 'md', style }) => {
  const sizes = { xs: 14, sm: 16, md: 20, lg: 24 };
  const iconSize = sizes[size] || sizes.md;
  const tileSize = Math.round(iconSize * 0.72);
  const checkSize = Math.max(8, Math.round(iconSize * 0.58));

  return (
    <View
      style={[styles.container, { width: iconSize, height: iconSize }, style]}
      accessibilityLabel="Verified store"
    >
      <View
        style={[
          styles.badgeTile,
          {
            width: tileSize,
            height: tileSize,
            borderRadius: Math.max(3, Math.round(tileSize * 0.26)),
          },
        ]}
      />
      <View
        style={[
          styles.badgeTile,
          styles.badgeTileRotated,
          {
            width: tileSize,
            height: tileSize,
            borderRadius: Math.max(3, Math.round(tileSize * 0.26)),
          },
        ]}
      />
      <Ionicons name="checkmark" size={checkSize} color="#fff" style={styles.check} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeTile: {
    position: 'absolute',
    backgroundColor: '#3897F0',
    shadowColor: '#1877D2',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.24,
    shadowRadius: 2,
    elevation: 2,
  },
  badgeTileRotated: { transform: [{ rotate: '45deg' }] },
  check: { zIndex: 2, fontWeight: '900' },
});

export default VerifiedBadge;
