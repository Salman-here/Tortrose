import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import GlassPanel from './GlassPanel';
import { spacing, fontSize, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const HEADER_SHEEN = [
  'rgba(168,85,247,0.12)',
  'rgba(14,165,233,0.05)',
  'rgba(20,184,166,0.10)',
];

export default function AuthTopHeader({
  title,
  subtitle,
  icon = 'person-outline',
  onBack,
  rightIcon = 'shield-checkmark-outline',
  rightLabel = 'Secure',
  rightElement,
  style,
}) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  return (
    <GlassPanel variant="floating" style={[styles.header, style]}>
      <LinearGradient
        colors={HEADER_SHEEN}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <TouchableOpacity
        style={styles.backButton}
        onPress={onBack}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
      </TouchableOpacity>

      <LinearGradient
        colors={palette.gradients.cta}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.titleTile}
      >
        <Ionicons name={icon} size={18} color="#fff" />
      </LinearGradient>

      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
      </View>

      {rightElement || (
        <View style={styles.securePill}>
          <Ionicons name={rightIcon} size={14} color={palette.colors.success} />
          <Text style={styles.secureText} numberOfLines={1}>{rightLabel}</Text>
        </View>
      )}
    </GlassPanel>
  );
}

const buildStyles = (p) => StyleSheet.create({
  header: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 22,
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
  titleTile: {
    width: 36,
    height: 36,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.32,
    shadowRadius: 8,
    elevation: 4,
  },
  copy: { flex: 1, minWidth: 0 },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
    letterSpacing: -0.25,
  },
  subtitle: {
    marginTop: 1,
    fontSize: 10,
    color: p.colors.textSecondary,
  },
  securePill: {
    minHeight: 34,
    maxWidth: 82,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  secureText: {
    flexShrink: 1,
    fontSize: 9,
    color: p.colors.textSecondary,
    fontWeight: fontWeight.bold,
  },
});
