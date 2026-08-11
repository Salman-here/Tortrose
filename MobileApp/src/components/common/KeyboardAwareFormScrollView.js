import React, { forwardRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

/**
 * Shared form scroller that follows the focused input as the keyboard animates.
 * This is deliberately backed by react-native-keyboard-controller, the same
 * native keyboard pipeline used by Rozare AI chat.
 */
const KeyboardAwareFormScrollView = forwardRef(function KeyboardAwareFormScrollView({
  children,
  style,
  contentContainerStyle,
  bottomOffset = 28,
  extraKeyboardSpace = 16,
  ...props
}, ref) {
  return (
    <KeyboardAwareScrollView
      ref={ref}
      style={[styles.scroll, style]}
      contentContainerStyle={contentContainerStyle}
      bottomOffset={bottomOffset}
      extraKeyboardSpace={extraKeyboardSpace}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      showsVerticalScrollIndicator={false}
      {...props}
    >
      {children}
    </KeyboardAwareScrollView>
  );
});

const styles = StyleSheet.create({
  scroll: { flex: 1 },
});

export default KeyboardAwareFormScrollView;
