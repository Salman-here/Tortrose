import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feedback from '../../utils/feedback';
import { useTheme } from '../../contexts/ThemeContext';
import { fontSize, fontWeight, spacing } from '../../styles/theme';
import GlassPanel from './GlassPanel';

const TYPE_META = {
  success: {
    icon: 'checkmark',
    color: '#16A34A',
    background: 'rgba(34,197,94,0.13)',
    border: 'rgba(34,197,94,0.25)',
  },
  error: {
    icon: 'alert-circle-outline',
    color: '#DC2626',
    background: 'rgba(239,68,68,0.12)',
    border: 'rgba(239,68,68,0.24)',
  },
  warning: {
    icon: 'warning-outline',
    color: '#D97706',
    background: 'rgba(245,158,11,0.13)',
    border: 'rgba(245,158,11,0.25)',
  },
  info: {
    icon: 'information',
    color: '#4F46E5',
    background: 'rgba(99,102,241,0.12)',
    border: 'rgba(99,102,241,0.24)',
  },
};

export default function FeedbackHost() {
  const { palette, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = buildStyles(palette);
  const [notice, setNotice] = useState(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(18)).current;
  const timerRef = useRef(null);
  const noticeRef = useRef(null);

  const dismiss = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 0, duration: 160, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 12, duration: 180, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) {
        setNotice(null);
        noticeRef.current = null;
      }
    });
  }, [opacity, translateY]);

  useEffect(() => Feedback.subscribe((nextNotice) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    noticeRef.current = nextNotice;
    setNotice(nextNotice);
    opacity.setValue(0);
    translateY.setValue(16);
    AccessibilityInfo.announceForAccessibility(
      [nextNotice.title, nextNotice.message].filter(Boolean).join('. ')
    );
    requestAnimationFrame(() => {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          friction: 9,
          tension: 78,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, { toValue: 1, duration: 190, useNativeDriver: true }),
      ]).start();
    });
    timerRef.current = setTimeout(dismiss, nextNotice.duration);
  }), [dismiss, opacity, translateY]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height || 0);
    });
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!notice) return null;

  const meta = TYPE_META[notice.type] || TYPE_META.info;
  const bottom = keyboardHeight > 0
    ? Platform.OS === 'ios'
      ? keyboardHeight + Math.max(insets.bottom, 10)
      : Math.max(insets.bottom + 10, 16)
    : Math.max(insets.bottom + 82, 94);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.anchor,
        { bottom, opacity, transform: [{ translateY }] },
      ]}
    >
      <GlassPanel
        variant="floating"
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={[
          styles.notice,
          {
            borderColor: meta.border,
            backgroundColor: isDark ? 'rgba(15,23,42,0.88)' : 'rgba(248,250,255,0.88)',
          },
        ]}
      >
        <LinearGradient
          colors={[
            meta.background,
            isDark ? 'rgba(15,23,42,0.54)' : 'rgba(255,255,255,0.42)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={[styles.iconTile, { backgroundColor: meta.background }]}>
          <Ionicons name={meta.icon} size={18} color={meta.color} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title} numberOfLines={1}>{notice.title}</Text>
          {!!notice.message && <Text style={styles.message} numberOfLines={2}>{notice.message}</Text>}
        </View>
        {!!notice.actionLabel && (
          <TouchableOpacity
            onPress={() => {
              const action = noticeRef.current?.onAction;
              dismiss();
              action?.();
            }}
            style={[styles.action, { backgroundColor: meta.background }]}
            accessibilityRole="button"
          >
            <Text style={[styles.actionText, { color: meta.color }]}>{notice.actionLabel}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={dismiss}
          style={styles.close}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
        >
          <Ionicons name="close" size={15} color={palette.colors.textSecondary} />
        </TouchableOpacity>
      </GlassPanel>
    </Animated.View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 10020,
    elevation: 40,
  },
  notice: {
    width: '100%',
    maxWidth: 430,
    alignSelf: 'center',
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: 19,
    backgroundColor: p.glass.bgStrong,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 24,
  },
  iconTile: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1, minWidth: 0 },
  title: {
    color: p.colors.text,
    fontSize: fontSize.sm,
    lineHeight: 18,
    fontWeight: fontWeight.extrabold,
    textShadowColor: 'rgba(255,255,255,0.22)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1,
  },
  message: {
    marginTop: 1,
    color: p.colors.textSecondary,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: fontWeight.medium,
  },
  action: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: 10,
  },
  actionText: { fontSize: 10, fontWeight: fontWeight.bold },
  close: {
    width: 28,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
