import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import GlassBackground from '../common/GlassBackground';
import GlassPanel from '../common/GlassPanel';
import PremiumBackHeader from '../common/PremiumBackHeader';
import Skeleton from '../common/Skeleton';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

export function SellerHeaderAction({
  icon,
  label,
  badge = 0,
  onPress,
  accessibilityLabel,
}) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  return (
    <TouchableOpacity
      style={styles.headerAction}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
    >
      <Ionicons name={icon} size={18} color={palette.colors.primary} />
      {!!label && <Text style={styles.headerActionLabel} numberOfLines={1}>{label}</Text>}
      {badge > 0 && (
        <View style={styles.headerBadge}>
          <Text style={styles.headerBadgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

export function SellerScreenHeader({
  navigation,
  title,
  subtitle,
  icon = 'storefront-outline',
  onBack,
  rightIcon,
  rightLabel,
  rightBadge,
  onRightPress,
  rightElement,
  style,
  fallbackScreen = 'SellerDashboard',
}) {
  const handleBack = onBack || (() => {
    if (navigation?.canGoBack?.()) {
      navigation.goBack();
      return;
    }

    if (fallbackScreen === 'Account') {
      navigation?.navigate?.('MainTabs', { screen: 'Account' });
      return;
    }

    navigation?.navigate?.(fallbackScreen);
  });
  const action = rightElement || (rightIcon && onRightPress ? (
    <SellerHeaderAction
      icon={rightIcon}
      label={rightLabel}
      badge={rightBadge}
      onPress={onRightPress}
    />
  ) : undefined);

  return (
    <PremiumBackHeader
      title={title}
      subtitle={subtitle}
      icon={icon}
      onBack={handleBack}
      rightElement={action}
      rightIcon="shield-checkmark-outline"
      rightLabel="Seller"
      style={style}
    />
  );
}

export function SellerSectionHeader({ title, subtitle, actionLabel, onAction, icon }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionCopy}>
        {!!icon && (
          <View style={styles.sectionIcon}>
            <Ionicons name={icon} size={15} color={palette.colors.primary} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
        </View>
      </View>
      {!!actionLabel && !!onAction && (
        <TouchableOpacity
          style={styles.sectionAction}
          onPress={onAction}
          activeOpacity={0.72}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
        >
          <Text style={styles.sectionActionText}>{actionLabel}</Text>
          <Ionicons name="arrow-forward" size={13} color={palette.colors.primary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

export function SellerInlineError({
  title = 'Something went wrong',
  message = 'We could not load this seller information.',
  onRetry,
  compact = false,
}) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  return (
    <GlassPanel
      variant="card"
      style={[styles.errorCard, compact && styles.errorCardCompact]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={styles.errorIcon}>
        <Ionicons name="cloud-offline-outline" size={22} color={palette.colors.error} />
      </View>
      <View style={styles.errorCopy}>
        <Text style={styles.errorTitle}>{title}</Text>
        <Text style={styles.errorMessage}>{message}</Text>
      </View>
      {!!onRetry && (
        <TouchableOpacity
          style={styles.retryButton}
          onPress={onRetry}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Ionicons name="refresh" size={15} color="#fff" />
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      )}
    </GlassPanel>
  );
}

export function SellerEmptyState({
  icon = 'sparkles-outline',
  title,
  message,
  actionLabel,
  onAction,
}) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  return (
    <GlassPanel variant="inner" style={styles.emptyCard}>
      <LinearGradient colors={palette.gradients.cta} style={styles.emptyIcon}>
        <Ionicons name={icon} size={23} color="#fff" />
      </LinearGradient>
      <Text style={styles.emptyTitle}>{title}</Text>
      {!!message && <Text style={styles.emptyMessage}>{message}</Text>}
      {!!actionLabel && !!onAction && (
        <TouchableOpacity style={styles.emptyAction} onPress={onAction} activeOpacity={0.78}>
          <Text style={styles.emptyActionText}>{actionLabel}</Text>
          <Ionicons name="arrow-forward" size={15} color="#fff" />
        </TouchableOpacity>
      )}
    </GlassPanel>
  );
}

function DashboardSkeleton({ styles }) {
  return (
    <>
      <GlassPanel variant="strong" style={styles.skeletonHero}>
        <Skeleton width={92} height={22} radius={11} />
        <Skeleton width="76%" height={27} radius={9} style={styles.skeletonGapMd} />
        <Skeleton width="92%" height={13} radius={6} style={styles.skeletonGapSm} />
        <Skeleton width="100%" height={48} radius={16} style={styles.skeletonGapLg} />
      </GlassPanel>
      <View style={styles.skeletonGrid}>
        {Array.from({ length: 4 }).map((_, index) => (
          <GlassPanel key={index} variant="card" style={styles.skeletonMetric}>
            <Skeleton width={40} height={40} radius={13} />
            <Skeleton width="68%" height={10} radius={5} style={styles.skeletonGapMd} />
            <Skeleton width="48%" height={22} radius={7} style={styles.skeletonGapSm} />
          </GlassPanel>
        ))}
      </View>
      <GlassPanel variant="card" style={styles.skeletonBlock}>
        <Skeleton width={126} height={18} radius={7} />
        <View style={styles.skeletonTools}>
          {Array.from({ length: 8 }).map((_, index) => (
            <View key={index} style={styles.skeletonTool}>
              <Skeleton width={42} height={42} radius={14} />
              <Skeleton width={58} height={10} radius={5} />
            </View>
          ))}
        </View>
      </GlassPanel>
      <GlassPanel variant="card" style={styles.skeletonBlock}>
        <Skeleton width={112} height={18} radius={7} />
        {Array.from({ length: 3 }).map((_, index) => (
          <View key={index} style={styles.skeletonRow}>
            <Skeleton width={44} height={44} radius={14} />
            <View style={{ flex: 1, gap: 7 }}>
              <Skeleton width="74%" height={12} radius={5} />
              <Skeleton width="46%" height={10} radius={5} />
            </View>
            <Skeleton width={58} height={24} radius={12} />
          </View>
        ))}
      </GlassPanel>
    </>
  );
}

function ListSkeleton({ styles, rows = 6 }) {
  return (
    <>
      <GlassPanel variant="card" style={styles.skeletonFilters}>
        <Skeleton width="100%" height={46} radius={15} />
        <View style={styles.skeletonChips}>
          <Skeleton width={68} height={32} radius={16} />
          <Skeleton width={84} height={32} radius={16} />
          <Skeleton width={74} height={32} radius={16} />
        </View>
      </GlassPanel>
      {Array.from({ length: rows }).map((_, index) => (
        <GlassPanel key={index} variant="card" style={styles.skeletonListCard}>
          <Skeleton width={52} height={52} radius={16} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton width="78%" height={14} radius={6} />
            <Skeleton width="56%" height={10} radius={5} />
            <Skeleton width="36%" height={10} radius={5} />
          </View>
          <Skeleton width={64} height={28} radius={14} />
        </GlassPanel>
      ))}
    </>
  );
}

function FormSkeleton({ styles }) {
  return (
    <>
      {Array.from({ length: 3 }).map((_, sectionIndex) => (
        <GlassPanel key={sectionIndex} variant="card" style={styles.skeletonBlock}>
          <Skeleton width={136} height={18} radius={7} />
          {Array.from({ length: sectionIndex === 1 ? 3 : 2 }).map((__, rowIndex) => (
            <View key={rowIndex} style={styles.skeletonField}>
              <Skeleton width={86} height={10} radius={5} />
              <Skeleton width="100%" height={48} radius={14} />
            </View>
          ))}
        </GlassPanel>
      ))}
    </>
  );
}

export function SellerScreenSkeleton({
  navigation,
  title = 'Seller Dashboard',
  subtitle = 'Preparing your workspace',
  icon = 'storefront-outline',
  variant = 'list',
  rows = 6,
  fallbackScreen,
  onBack,
}) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title={title}
          subtitle={subtitle}
          icon={icon}
          fallbackScreen={fallbackScreen}
          onBack={onBack}
        />
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.skeletonScroll}
          accessibilityLabel={`${title} loading`}
        >
          {variant === 'dashboard' && <DashboardSkeleton styles={styles} />}
          {variant === 'form' && <FormSkeleton styles={styles} />}
          {variant === 'list' && <ListSkeleton styles={styles} rows={rows} />}
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  headerAction: {
    minWidth: 38,
    height: 38,
    maxWidth: 88,
    paddingHorizontal: spacing.sm,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  headerActionLabel: {
    flexShrink: 1,
    fontSize: 9,
    fontWeight: fontWeight.bold,
    color: p.colors.primary,
  },
  headerBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.error,
    borderWidth: 2,
    borderColor: p.colors.surface,
  },
  headerBadgeText: { color: '#fff', fontSize: 8, fontWeight: fontWeight.extrabold },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  sectionCopy: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionIcon: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  sectionSubtitle: { marginTop: 2, fontSize: fontSize.xs, lineHeight: 16, color: p.colors.textSecondary },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 34, paddingHorizontal: spacing.sm },
  sectionActionText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    padding: spacing.lg,
    borderColor: `${p.colors.error}35`,
  },
  errorCardCompact: { marginHorizontal: 0, marginVertical: spacing.sm },
  errorIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.errorSubtle,
  },
  errorCopy: { flex: 1 },
  errorTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  errorMessage: { marginTop: 2, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  retryButton: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: p.colors.primary,
  },
  retryText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  emptyCard: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl },
  emptyIcon: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { marginTop: spacing.md, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text, textAlign: 'center' },
  emptyMessage: { marginTop: spacing.xs, maxWidth: 290, fontSize: fontSize.sm, lineHeight: 20, color: p.colors.textSecondary, textAlign: 'center' },
  emptyAction: { marginTop: spacing.lg, minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary },
  emptyActionText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  skeletonScroll: { paddingTop: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: 80 },
  skeletonHero: { padding: spacing.xl },
  skeletonGapSm: { marginTop: spacing.sm },
  skeletonGapMd: { marginTop: spacing.md },
  skeletonGapLg: { marginTop: spacing.lg },
  skeletonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  skeletonMetric: { width: '48.7%', minHeight: 130, padding: spacing.lg },
  skeletonBlock: { marginTop: spacing.md, padding: spacing.lg },
  skeletonTools: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg },
  skeletonTool: { width: '21%', alignItems: 'center', gap: spacing.sm },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  skeletonFilters: { padding: spacing.md, gap: spacing.md },
  skeletonChips: { flexDirection: 'row', gap: spacing.sm },
  skeletonListCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md, padding: spacing.md },
  skeletonField: { marginTop: spacing.lg, gap: spacing.sm },
});
