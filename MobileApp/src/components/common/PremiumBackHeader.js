import React from 'react';
import { StyleSheet, View } from 'react-native';
import AuthTopHeader from './AuthTopHeader';
import { spacing } from '../../styles/theme';

/**
 * Screen-level wrapper for the shared glass back header.
 *
 * Most destination screens are not horizontally padded, so this keeps the
 * header inset without combining a 100% width with horizontal margins.
 * Auth forms continue to use AuthTopHeader directly inside their padded
 * ScrollViews.
 */
export default function PremiumBackHeader({ inset = true, style, ...props }) {
  return (
    <View style={[styles.frame, inset && styles.inset, style]}>
      <AuthTopHeader {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { width: '100%' },
  inset: { paddingHorizontal: spacing.md },
});
