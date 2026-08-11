import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  stockAlerts: true,
  lowStockAlerts: true,
  orderAlerts: true,
  paymentAlerts: true,
  deliveryAlerts: true,
  storeCreation: true,
  storeVerification: true,
});

export function normalizeNotificationPreferences(value = {}) {
  return Object.keys(DEFAULT_NOTIFICATION_PREFS).reduce((preferences, key) => {
    preferences[key] = value[key] !== false;
    return preferences;
  }, {});
}

const BASE_SECTIONS = [
  {
    title: 'Inventory alerts',
    subtitle: 'Stay ahead of stock issues before they affect sales.',
    icon: 'cube-outline',
    items: [
      {
        key: 'stockAlerts',
        label: 'Out-of-stock alerts',
        description: 'Know immediately when a product reaches zero inventory.',
        icon: 'alert-circle-outline',
      },
      {
        key: 'lowStockAlerts',
        label: 'Low-stock warnings',
        description: 'Get an early warning when inventory drops below 10 units.',
        icon: 'trending-down-outline',
      },
    ],
  },
  {
    title: 'Order and payment alerts',
    subtitle: 'Follow every important step from checkout to delivery.',
    icon: 'receipt-outline',
    items: [
      {
        key: 'orderAlerts',
        label: 'New orders',
        description: 'Receive an alert when a customer places an order.',
        icon: 'cart-outline',
      },
      {
        key: 'paymentAlerts',
        label: 'Payment confirmations',
        description: 'Know when a payment is confirmed for an order.',
        icon: 'wallet-outline',
      },
      {
        key: 'deliveryAlerts',
        label: 'Delivery updates',
        description: 'Track shipped and delivered order milestones.',
        icon: 'car-outline',
      },
    ],
  },
];

const ADMIN_SECTION = {
  title: 'Store administration alerts',
  subtitle: 'Platform-level events available to administrators.',
  icon: 'shield-checkmark-outline',
  items: [
    {
      key: 'storeCreation',
      label: 'New store creation',
      description: 'Receive an alert when a seller creates a new store.',
      icon: 'storefront-outline',
    },
    {
      key: 'storeVerification',
      label: 'Verification requests',
      description: 'Be notified when a store is ready for review.',
      icon: 'shield-outline',
    },
  ],
};

export default function NotificationSettingsScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const isAdmin = route?.params?.isAdmin === true;
  const sections = useMemo(() => (isAdmin ? [...BASE_SECTIONS, ADMIN_SECTION] : BASE_SECTIONS), [isAdmin]);

  const [prefs, setPrefs] = useState(() => normalizeNotificationPreferences());
  const [savedPrefs, setSavedPrefs] = useState(() => normalizeNotificationPreferences());
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const loadPreferences = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true);
    setLoadError('');
    try {
      const response = await api.get('/api/analytics/notification-prefs');
      const normalized = normalizeNotificationPreferences(response?.data?.prefs);
      setPrefs(normalized);
      setSavedPrefs(normalized);
      setHasLoaded(true);
    } catch {
      setLoadError('Your saved notification preferences could not be loaded. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadPreferences({ initial: true });
  }, [loadPreferences]);

  const dirty = useMemo(
    () => Object.keys(DEFAULT_NOTIFICATION_PREFS).some((key) => prefs[key] !== savedPrefs[key]),
    [prefs, savedPrefs],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setSuccessMessage('');
    loadPreferences();
  }, [loadPreferences]);

  const handleToggle = useCallback((key) => {
    setPrefs((current) => ({ ...current, [key]: !current[key] }));
    setActionError('');
    setSuccessMessage('');
  }, []);

  const handleSave = useCallback(async () => {
    if (saving || resetting || !dirty) return;
    setSaving(true);
    setActionError('');
    setSuccessMessage('');
    try {
      const response = await api.put('/api/analytics/notification-prefs', { prefs });
      const normalized = normalizeNotificationPreferences(response?.data?.prefs || prefs);
      setPrefs(normalized);
      setSavedPrefs(normalized);
      setSuccessMessage('Your notification preferences are saved.');
    } catch {
      setActionError('Your changes were not saved. Please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }, [dirty, prefs, resetting, saving]);

  const handleReset = useCallback(async () => {
    if (saving || resetting) return;
    const defaults = normalizeNotificationPreferences();
    setResetting(true);
    setActionError('');
    setSuccessMessage('');
    try {
      const response = await api.put('/api/analytics/notification-prefs', { prefs: defaults });
      const normalized = normalizeNotificationPreferences(response?.data?.prefs || defaults);
      setPrefs(normalized);
      setSavedPrefs(normalized);
      setSuccessMessage('Default notification preferences were restored.');
    } catch {
      setActionError('Defaults were not restored. Your current preferences are unchanged.');
    } finally {
      setResetting(false);
    }
  }, [resetting, saving]);

  if (loading && !hasLoaded) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Alert Preferences"
        subtitle="Control the updates you receive"
        icon="options-outline"
        variant="form"
      />
    );
  }

  if (!hasLoaded) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader
            navigation={navigation}
            title="Alert Preferences"
            subtitle="Control the updates you receive"
            icon="options-outline"
          />
          <View style={styles.fullError}>
            <SellerInlineError
              title="Preferences unavailable"
              message={loadError}
              onRetry={() => loadPreferences({ initial: true })}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Alert Preferences"
          subtitle="Control the updates you receive"
          icon="options-outline"
          rightIcon="refresh-outline"
          rightLabel="Refresh"
          onRightPress={onRefresh}
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={palette.colors.primary}
              colors={[palette.colors.primary]}
            />
          )}
        >
          <GlassPanel variant="strong" style={styles.heroCard}>
            <View style={styles.heroIcon}>
              <Ionicons name="notifications-outline" size={24} color={palette.colors.primary} />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>{isAdmin ? 'ADMIN ALERTS' : 'SELLER ALERTS'}</Text>
              <Text style={styles.heroTitle}>Only receive what matters</Text>
              <Text style={styles.heroSubtitle}>
                Fine-tune operational alerts without losing access to important announcements in your inbox.
              </Text>
            </View>
          </GlassPanel>

          {!!loadError && (
            <SellerInlineError
              compact
              title="Refresh failed"
              message={loadError}
              onRetry={onRefresh}
            />
          )}
          {!!actionError && (
            <SellerInlineError
              compact
              title="Preferences were not updated"
              message={actionError}
            />
          )}
          {!!successMessage && (
            <View style={styles.successBanner} accessibilityRole="alert">
              <View style={styles.successIcon}>
                <Ionicons name="checkmark-circle" size={19} color={palette.colors.successDark} />
              </View>
              <Text style={styles.successText}>{successMessage}</Text>
            </View>
          )}

          {sections.map((section) => (
            <View key={section.title} style={styles.sectionWrap}>
              <SellerSectionHeader
                title={section.title}
                subtitle={section.subtitle}
                icon={section.icon}
              />
              <GlassPanel variant="card" style={styles.sectionCard}>
                {section.items.map((item, index) => {
                  const enabled = prefs[item.key];
                  return (
                    <View
                      key={item.key}
                      style={[styles.preferenceRow, index > 0 && styles.preferenceRowBorder]}
                    >
                      <View style={[styles.preferenceIcon, enabled && styles.preferenceIconEnabled]}>
                        <Ionicons
                          name={item.icon}
                          size={18}
                          color={enabled ? palette.colors.primary : palette.colors.textLight}
                        />
                      </View>
                      <View style={styles.preferenceCopy}>
                        <Text style={styles.preferenceLabel}>{item.label}</Text>
                        <Text style={styles.preferenceDescription}>{item.description}</Text>
                      </View>
                      <Switch
                        value={enabled}
                        onValueChange={() => handleToggle(item.key)}
                        trackColor={{
                          false: pColorWithOpacity(palette.colors.textLight, '35'),
                          true: palette.colors.primaryLight,
                        }}
                        thumbColor={enabled ? palette.colors.primary : palette.colors.surface}
                        ios_backgroundColor={pColorWithOpacity(palette.colors.textLight, '35')}
                        accessibilityLabel={`${item.label}. ${enabled ? 'Enabled' : 'Disabled'}`}
                      />
                    </View>
                  );
                })}
              </GlassPanel>
            </View>
          ))}

          <GlassPanel variant="strong" style={styles.actionCard}>
            <View style={styles.actionCopy}>
              <Text style={styles.actionTitle}>{dirty ? 'You have unsaved changes' : 'Preferences are up to date'}</Text>
              <Text style={styles.actionSubtitle}>
                {dirty ? 'Save to apply these settings to your seller account.' : 'Changes are synced with the website and backend.'}
              </Text>
            </View>
            <View style={styles.actionButtons}>
              <TouchableOpacity
                style={[styles.resetButton, (saving || resetting) && styles.buttonDisabled]}
                onPress={handleReset}
                disabled={saving || resetting}
                activeOpacity={0.76}
                accessibilityRole="button"
                accessibilityLabel="Restore default notification preferences"
              >
                {resetting
                  ? <ActivityIndicator size="small" color={palette.colors.textSecondary} />
                  : <Ionicons name="refresh-outline" size={16} color={palette.colors.textSecondary} />}
                <Text style={styles.resetButtonText}>{resetting ? 'Restoring' : 'Defaults'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveButton, (!dirty || saving || resetting) && styles.buttonDisabled]}
                onPress={handleSave}
                disabled={!dirty || saving || resetting}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Save notification preferences"
                accessibilityState={{ disabled: !dirty || saving || resetting }}
              >
                {saving
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="checkmark" size={17} color="#fff" />}
                <Text style={styles.saveButtonText}>{saving ? 'Saving' : 'Save changes'}</Text>
              </TouchableOpacity>
            </View>
          </GlassPanel>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

function pColorWithOpacity(color, opacity) {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) return `${color}${opacity}`;
  return color;
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  fullError: { flex: 1, justifyContent: 'center' },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 96,
  },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: borderRadius.xxl,
    marginBottom: spacing.md,
  },
  heroIcon: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  heroCopy: { flex: 1 },
  heroEyebrow: {
    fontSize: 9,
    letterSpacing: 1.1,
    fontWeight: fontWeight.extrabold,
    color: p.colors.primary,
  },
  heroTitle: {
    marginTop: 3,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
  },
  heroSubtitle: {
    marginTop: 4,
    fontSize: fontSize.xs,
    lineHeight: 17,
    color: p.colors.textSecondary,
  },
  successBanner: {
    marginVertical: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: p.colors.successSubtle,
    borderWidth: 1,
    borderColor: p.colors.successLighter,
  },
  successIcon: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.surface,
  },
  successText: { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.successDark },
  sectionWrap: { marginTop: spacing.xl },
  sectionCard: { padding: 0, overflow: 'hidden', borderRadius: borderRadius.xl },
  preferenceRow: {
    minHeight: 82,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  preferenceRowBorder: { borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  preferenceIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.surfaceHover,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  preferenceIconEnabled: {
    backgroundColor: p.colors.primarySubtle,
    borderColor: p.colors.primaryLighter,
  },
  preferenceCopy: { flex: 1, minWidth: 0 },
  preferenceLabel: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text },
  preferenceDescription: {
    marginTop: 3,
    fontSize: fontSize.xs,
    lineHeight: 17,
    color: p.colors.textSecondary,
  },
  actionCard: {
    marginTop: spacing.xxl,
    padding: spacing.lg,
    borderRadius: borderRadius.xxl,
  },
  actionCopy: { marginBottom: spacing.md },
  actionTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  actionSubtitle: { marginTop: 3, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  actionButtons: { flexDirection: 'row', gap: spacing.sm },
  resetButton: {
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: p.colors.surfaceHover,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  resetButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  saveButton: {
    flex: 1,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: p.colors.primary,
  },
  saveButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#fff' },
  buttonDisabled: { opacity: 0.48 },
});
