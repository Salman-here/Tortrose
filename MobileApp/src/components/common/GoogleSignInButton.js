import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../contexts/ThemeContext';
import GlassBlurFill from './GlassBlurFill';
import { fontSize, fontWeight } from '../../styles/theme';

function GoogleG({ size = 19 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityLabel="Google">
      <Path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <Path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <Path fill="#FBBC05" d="M5.84 14.09A6.5 6.5 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <Path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </Svg>
  );
}

/**
 * Compact glass Google action using the official, unmodified multicolor Super G.
 */
export default function GoogleSignInButton({
  onPress,
  loading = false,
  disabled = false,
  style,
  label = 'Continue with Google',
}) {
  const { palette } = useTheme();
  const inactive = disabled || loading;

  return (
    <TouchableOpacity
      style={[
        styles.touchTarget,
        {
          backgroundColor: palette.glass.bgSubtle,
          borderColor: palette.glass.border,
        },
        inactive && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={inactive}
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <GlassBlurFill intensity={42} />
      {loading
        ? <ActivityIndicator color="#4285F4" size="small" />
        : (
          <>
            <GoogleG />
            <Text style={[styles.label, { color: palette.colors.text }]}>{label}</Text>
          </>
        )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  touchTarget: {
    width: '100%',
    maxWidth: 238,
    minHeight: 46,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  disabled: {
    opacity: 0.68,
  },
});
