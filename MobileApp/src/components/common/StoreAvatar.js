import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

const cleanLogo = value => (
  typeof value === 'string' && value.trim().length <= 4096
    ? value.trim()
    : ''
);

/**
 * Shared store identity image. A missing or failed remote logo falls back to
 * the storefront glyph without changing the surrounding checkout/order UI.
 */
export default function StoreAvatar({
  logo,
  storeName = 'Store',
  size = 40,
  borderRadius = Math.round(size * 0.3),
  fallbackColor,
  fallbackBackgroundColor,
  borderColor,
  style,
}) {
  const { palette } = useTheme();
  const logoUri = cleanLogo(logo);
  const [failedLogo, setFailedLogo] = useState('');
  const showLogo = Boolean(logoUri && failedLogo !== logoUri);

  const frameStyle = {
    width: size,
    height: size,
    borderRadius,
    backgroundColor: fallbackBackgroundColor || `${palette.colors.primary}12`,
    borderColor: borderColor || `${palette.colors.primary}22`,
  };

  return (
    <View
      style={[styles.frame, frameStyle, style]}
      accessibilityRole="image"
      accessibilityLabel={showLogo ? `${storeName} logo` : `${storeName} logo unavailable`}
    >
      {showLogo ? (
        <Image
          source={{ uri: logoUri }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
          onError={() => setFailedLogo(logoUri)}
        />
      ) : (
        <Ionicons
          name="storefront-outline"
          size={Math.max(12, Math.round(size * 0.45))}
          color={fallbackColor || palette.colors.primary}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
  },
});
