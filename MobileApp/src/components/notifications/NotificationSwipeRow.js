import React, { useEffect, useRef } from 'react';
import { Pressable } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useIsFocused } from '@react-navigation/native';

export default function NotificationSwipeRow({ children, onDismiss, renderRightActions }) {
  const ref = useRef(null);
  const focused = useIsFocused();
  const pending = useRef(false);
  useEffect(() => { ref.current?.close(); }, [focused]);
  const dismiss = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (!await onDismiss()) ref.current?.close();
    } catch { ref.current?.close(); }
    finally { pending.current = false; }
  };
  return <Swipeable ref={ref} rightThreshold={60} overshootRight={false}
    renderRightActions={(progress, dragX) => <Pressable accessibilityRole="button" accessibilityLabel="Dismiss notification" onPress={dismiss}>{renderRightActions(progress, dragX)}</Pressable>}
    onSwipeableOpen={dismiss}>
    {children}
  </Swipeable>;
}
