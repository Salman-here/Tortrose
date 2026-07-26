import React from 'react';
import { ActivityIndicator, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../../contexts/ThemeContext';

const GOOGLE_BUTTONS = {
  android: {
    light: require('../../../assets/google-signin-android-light.png'),
    dark: require('../../../assets/google-signin-android-dark.png'),
  },
  ios: {
    light: require('../../../assets/google-signin-ios-light.png'),
    dark: require('../../../assets/google-signin-ios-dark.png'),
  },
};

/**
 * Google's pre-approved Sign in with Google artwork.
 * The whole asset is scaled together so the official Super G, type, spacing,
 * border, and aspect ratio remain untouched on Android, iOS, and web.
 */
export default function GoogleSignInButton({
  onPress,
  loading = false,
  disabled = false,
  style,
}) {
  const { isDark } = useTheme();
  const platformAssets = Platform.OS === 'ios' ? GOOGLE_BUTTONS.ios : GOOGLE_BUTTONS.android;
  const source = isDark ? platformAssets.dark : platformAssets.light;
  const inactive = disabled || loading;

  return (
    <TouchableOpacity
      style={[styles.touchTarget, inactive && styles.disabled, style]}
      onPress={onPress}
      disabled={inactive}
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel="Sign in with Google"
    >
      {loading ? (
        <View style={[styles.loadingSurface, isDark && styles.loadingSurfaceDark]}>
          <ActivityIndicator color="#4285F4" size="small" />
        </View>
      ) : (
        <Image source={source} style={styles.asset} contentFit="contain" transition={0} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  touchTarget: {
    width: '100%',
    maxWidth: 270,
    aspectRatio: 4.5,
    alignSelf: 'center',
  },
  asset: {
    width: '100%',
    height: '100%',
  },
  loadingSurface: {
    flex: 1,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#747775',
  },
  loadingSurfaceDark: {
    backgroundColor: '#131314',
    borderColor: '#8E918F',
  },
  disabled: {
    opacity: 0.68,
  },
});
