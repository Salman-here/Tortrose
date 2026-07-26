/**
 * PremiumTopBar
 *
 * Shared floating glass navigation used by detail and focused-flow screens.
 * It follows the visual language established by StoreScreen and
 * NotificationsScreen: a soft aurora sheen, rounded-square navigation,
 * a compact gradient identity tile, and quiet glass actions.
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import GlassPanel from './GlassPanel';
import {
  spacing,
  fontSize,
  fontWeight,
} from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const DEFAULT_SHEEN = [
  'rgba(99,102,241,0.13)',
  'rgba(14,165,233,0.05)',
  'rgba(139,92,246,0.11)',
];

export function PremiumTopBarAction({
  icon,
  onPress,
  accessibilityLabel,
  badge = 0,
  color,
  primary = false,
  disabled = false,
  style,
}) {
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 360;
  const styles = buildStyles(palette);
  const displayBadge = typeof badge === 'number' && badge > 0
    ? (badge > 9 ? '9+' : String(badge))
    : badge;

  return (
    <TouchableOpacity
      style={[
        styles.actionButton,
        primary && styles.primaryActionButton,
        disabled && styles.disabled,
        style,
      ]}
      onPress={onPress}
      activeOpacity={0.78}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
    >
      {primary && (
        <LinearGradient
          colors={palette.gradients.cta}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFill, styles.actionGradient]}
          pointerEvents="none"
        />
      )}
      <Ionicons
        name={icon}
        size={18}
        color={primary ? '#fff' : (color || palette.colors.text)}
      />
      {!!displayBadge && (
        <View style={styles.actionBadge}>
          <Text style={styles.actionBadgeText}>{displayBadge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export default function PremiumTopBar({
  title,
  subtitle,
  icon = 'sparkles',
  onBack,
  backLabel = 'Go back',
  right,
  sheenColors = DEFAULT_SHEEN,
  iconColors,
  onTitlePress,
  style,
}) {
  const { palette } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 360;
  const styles = buildStyles(palette);
  const resolvedIconColors = iconColors || palette.gradients.cta;

  const titleContent = (
    <>
      {!compact && (
        <LinearGradient
          colors={resolvedIconColors}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.titleTile}
        >
          <Ionicons name={icon} size={17} color="#fff" />
        </LinearGradient>
      )}
      <View style={styles.titleCopy}>
        <Text
          style={[
            styles.title,
            subtitle && styles.titleWithSubtitle,
            compact && styles.compactTitle,
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {!!subtitle && !compact && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
    </>
  );

  return (
    <GlassPanel variant="floating" style={[styles.topBar, compact && styles.compactTopBar, style]}>
      <LinearGradient
        colors={sheenColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {!!onBack && (
        <TouchableOpacity
          style={[styles.backButton, compact && styles.compactBackButton]}
          onPress={onBack}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={backLabel}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
        </TouchableOpacity>
      )}

      {onTitlePress ? (
        <TouchableOpacity
          style={[styles.titleArea, compact && styles.compactTitleArea]}
          onPress={onTitlePress}
          activeOpacity={0.76}
          accessibilityRole="button"
          accessibilityLabel={title}
        >
          {titleContent}
        </TouchableOpacity>
      ) : (
        <View style={[styles.titleArea, compact && styles.compactTitleArea]}>{titleContent}</View>
      )}

      {!!right && <View style={styles.actions}>{right}</View>}
    </GlassPanel>
  );
}

const buildStyles = (p) => StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 58,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: 22,
  },
  compactTopBar: {
    gap: 6,
    paddingHorizontal: spacing.sm,
  },
  backButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: p.glass.bgStrong,
    borderWidth: 1,
    borderColor: p.glass.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  compactBackButton: {
    width: 40,
    height: 40,
    borderRadius: 13,
  },
  titleArea: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  compactTitleArea: {
    gap: 0,
  },
  titleTile: {
    width: 34,
    height: 34,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.32,
    shadowRadius: 8,
    elevation: 4,
  },
  titleCopy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
    letterSpacing: -0.35,
  },
  titleWithSubtitle: {
    fontSize: fontSize.lg,
    letterSpacing: -0.2,
  },
  compactTitle: {
    fontSize: 15,
    letterSpacing: -0.1,
  },
  subtitle: {
    marginTop: 1,
    fontSize: 10,
    lineHeight: 13,
    color: p.colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryActionButton: {
    borderWidth: 0,
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 4,
  },
  actionGradient: {
    borderRadius: 12,
  },
  actionBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: p.colors.error,
    borderWidth: 1.5,
    borderColor: p.glass.bgStrong,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: fontWeight.bold,
  },
  disabled: {
    opacity: 0.48,
  },
});
