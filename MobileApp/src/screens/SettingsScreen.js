/**
 * SettingsScreen — Liquid Glass Design
 */

import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Linking, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import api from '../config/api';
import { HAPTICS_KEY, setHapticsEnabled, isHapticsEnabled, impact as hapticImpact, Haptics } from '../utils/haptics';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import { isBiometricEnabled, setBiometricEnabled, isBiometricAvailable, authenticateBiometric } from '../utils/biometricLock';
import { getNotificationsModule, isAndroidExpoGo } from '../utils/notificationRuntime';

const Notifications = getNotificationsModule();
const notificationsUnavailableInExpoGo = isAndroidExpoGo();

const APP_VERSION = '1.0.0';

const SETTINGS_KEYS = { NOTIFICATIONS: 'settings_notifications_enabled', EMAIL_UPDATES: 'settings_email_updates' };

export default function SettingsScreen({ navigation }) {
  const { mode: themeMode, setMode: setThemeMode, palette } = useTheme();
  const styles = buildStyles(palette);

  function SettingRow({ icon, iconColor, iconBg, title, subtitle, onPress, rightElement, showBorder = true }) {
    return (
      <TouchableOpacity style={[styles.settingRow, showBorder && styles.settingRowBorder]} onPress={onPress} activeOpacity={onPress ? 0.7 : 1}>
        <View style={[styles.settingIcon, { backgroundColor: iconBg }]}>
          <Ionicons name={icon} size={20} color={iconColor} />
        </View>
        <View style={styles.settingText}>
          <Text style={styles.settingTitle}>{title}</Text>
          {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
        </View>
        {rightElement || (onPress && <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.3)" />)}
      </TouchableOpacity>
    );
  }

  const { logout } = useAuth();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [hapticsEnabled, setHapticsEnabledState] = useState(isHapticsEnabled());
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [biometricOn, setBiometricOn] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [notifVal, emailVal, hapticsVal, { status }] = await Promise.all([
          AsyncStorage.getItem(SETTINGS_KEYS.NOTIFICATIONS),
          AsyncStorage.getItem(SETTINGS_KEYS.EMAIL_UPDATES),
          AsyncStorage.getItem(HAPTICS_KEY),
          Notifications
            ? Notifications.getPermissionsAsync()
            : Promise.resolve({ status: 'unavailable' }),
        ]);
        setNotificationsEnabled(status === 'granted' && (notifVal !== null ? notifVal === 'true' : true));
        if (emailVal !== null) setEmailUpdates(emailVal === 'true');
        if (hapticsVal !== null) setHapticsEnabledState(hapticsVal === 'true');
      } catch (err) { console.error('Failed to load settings:', err); }
    };
    loadSettings();
    (async () => {
      const [avail, on] = await Promise.all([isBiometricAvailable(), isBiometricEnabled()]);
      setBiometricAvailable(avail);
      setBiometricOn(on);
    })();
  }, []);

  const handleBiometricToggle = useCallback(async (value) => {
    if (value) {
      const ok = await authenticateBiometric('Enable biometric lock');
      if (!ok) return;
    }
    await setBiometricEnabled(value);
    setBiometricOn(value);
    hapticImpact(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleHapticsChange = useCallback((value) => {
    setHapticsEnabledState(value);
    setHapticsEnabled(value);
    if (value) hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
  }, []);

  const handleNotificationsChange = useCallback(async (value) => {
    if (!Notifications) {
      Alert.alert(
        'Development build required',
        'Android push notifications are unavailable in Expo Go. Use a Rozare development build to test them.'
      );
      return;
    }
    if (value) {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') { const { status } = await Notifications.requestPermissionsAsync(); finalStatus = status; }
      if (finalStatus !== 'granted') { Alert.alert('Permission Required', 'Please enable notifications in your device Settings.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }]); return; }
    }
    setNotificationsEnabled(value);
    await AsyncStorage.setItem(SETTINGS_KEYS.NOTIFICATIONS, String(value));
  }, []);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert('Delete Account', 'This will permanently delete your account. This action cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete Account', style: 'destructive', onPress: async () => { setIsDeletingAccount(true); try { await api.delete('/api/user/delete-account'); await logout(); } catch (err) { Alert.alert('Error', err.response?.data?.msg || 'Failed to delete account.'); } finally { setIsDeletingAccount(false); } } },
    ]);
  }, [logout]);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <GlassPanel variant="floating" style={styles.heroHeader}>
          <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={styles.heroCenter}>
            <Text style={styles.heroTitle}>Settings</Text>
            <Text style={styles.heroSubtitle}>App preferences & support</Text>
          </View>
          <View style={styles.heroIconWrap}><Ionicons name="settings-outline" size={22} color={palette.colors.primary} /></View>
        </GlassPanel>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.sectionLabel}>APPEARANCE</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <View style={styles.appearanceRow}>
              <View style={[styles.settingIcon, { backgroundColor: 'rgba(99,102,241,0.15)' }]}>
                <Ionicons name="contrast-outline" size={20} color={palette.colors.primary} />
              </View>
              <View style={styles.settingText}>
                <Text style={styles.settingTitle}>Theme</Text>
                <Text style={styles.settingSubtitle}>Light, dark, or follow system</Text>
              </View>
            </View>
            <View style={styles.segmented}>
              {[
                { key: 'light', label: 'Light', icon: 'sunny-outline' },
                { key: 'dark', label: 'Dark', icon: 'moon-outline' },
                { key: 'system', label: 'System', icon: 'phone-portrait-outline' },
              ].map((opt) => {
                const active = themeMode === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => { setThemeMode(opt.key); hapticImpact(Haptics.ImpactFeedbackStyle.Light); }}
                    activeOpacity={0.8}
                    style={[
                      styles.segment,
                      active && { backgroundColor: palette.colors.primary, borderColor: palette.colors.primary },
                    ]}
                  >
                    <Ionicons
                      name={opt.icon}
                      size={16}
                      color={active ? palette.colors.textInverse : palette.colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.segmentText,
                        { color: active ? palette.colors.textInverse : palette.colors.textSecondary },
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </GlassPanel>

          <Text style={styles.sectionLabel}>SECURITY</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow
              icon="finger-print-outline"
              iconColor={palette.colors.primary}
              iconBg="rgba(99,102,241,0.15)"
              title="Biometric App Lock"
              subtitle={biometricAvailable ? 'Use Face ID / fingerprint to open the app' : 'Not available on this device'}
              showBorder={false}
              rightElement={
                <Switch
                  value={biometricOn}
                  onValueChange={handleBiometricToggle}
                  disabled={!biometricAvailable}
                  trackColor={{ false: palette.colors.grayLighter, true: palette.colors.primaryLight }}
                  thumbColor={biometricOn ? palette.colors.primary : palette.colors.grayLight}
                />
              }
            />
          </GlassPanel>

          <Text style={styles.sectionLabel}>PREFERENCES</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="phone-portrait-outline" iconColor="#EC4899" iconBg="rgba(236,72,153,0.15)" title="Haptic Feedback" subtitle="Vibration on taps and gestures" showBorder={false} rightElement={<Switch value={hapticsEnabled} onValueChange={handleHapticsChange} trackColor={{ false: palette.colors.grayLighter, true: palette.colors.primaryLight }} thumbColor={hapticsEnabled ? palette.colors.primary : palette.colors.grayLight} />} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="notifications-outline" iconColor={palette.colors.primary} iconBg="rgba(99,102,241,0.15)" title="Push Notifications" subtitle={notificationsUnavailableInExpoGo ? 'Use a development build to test on Android' : 'Order updates and alerts'} rightElement={<Switch value={notificationsEnabled} onValueChange={handleNotificationsChange} disabled={!Notifications} trackColor={{ false: palette.colors.grayLighter, true: palette.colors.primaryLight }} thumbColor={notificationsEnabled ? palette.colors.primary : palette.colors.grayLight} />} />
            <SettingRow icon="mail-outline" iconColor={palette.colors.info} iconBg="rgba(59,130,246,0.15)" title="Email Updates" subtitle="Promotions and newsletters" rightElement={<Switch value={emailUpdates} onValueChange={(v) => { setEmailUpdates(v); AsyncStorage.setItem(SETTINGS_KEYS.EMAIL_UPDATES, String(v)); }} trackColor={{ false: palette.colors.grayLighter, true: palette.colors.primaryLight }} thumbColor={emailUpdates ? palette.colors.primary : palette.colors.grayLight} />} />
            <SettingRow icon="options-outline" iconColor="#8B5CF6" iconBg="rgba(139,92,246,0.15)" title="Notification Preferences" subtitle="Choose which categories to receive" showBorder={false} onPress={() => navigation.navigate('NotificationPreferences')} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>SUPPORT</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="navigate-outline" iconColor={palette.colors.warning} iconBg="rgba(245,158,11,0.15)" title="Track Order" subtitle="Track your order with email & order ID" onPress={() => navigation.navigate('TrackOrder')} />
            <SettingRow icon="mail-outline" iconColor={palette.colors.success} iconBg="rgba(16,185,129,0.15)" title="Contact Support" subtitle="Get in touch with us" onPress={() => navigation.navigate('Contact')} />
            <SettingRow icon="help-circle-outline" iconColor={palette.colors.info} iconBg="rgba(59,130,246,0.15)" title="FAQ" subtitle="Frequently asked questions" onPress={() => navigation.navigate('FAQ')} />
            <SettingRow icon="book-outline" iconColor="#0ea5e9" iconBg="rgba(14,165,233,0.15)" title="Documentation" subtitle="The complete Rozare guide" onPress={() => navigation.navigate('Docs')} />
            <SettingRow icon="information-circle-outline" iconColor={palette.colors.primary} iconBg="rgba(99,102,241,0.15)" title="About Rozare" subtitle="Our story and mission" onPress={() => navigation.navigate('About')} />
            <SettingRow icon="star-outline" iconColor={palette.colors.warning} iconBg="rgba(245,158,11,0.15)" title="Rate the App" subtitle="Share your experience" onPress={() => Alert.alert('Rate Us ⭐', 'Enjoying Rozare?', [{ text: 'Maybe Later', style: 'cancel' }, { text: 'Rate Now', onPress: () => Linking.openURL(Platform.OS === 'ios' ? 'https://apps.apple.com' : 'https://play.google.com') }])} showBorder={false} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>LEGAL</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="shield-outline" iconColor={palette.colors.secondary} iconBg="rgba(139,92,246,0.15)" title="Privacy Policy" onPress={() => navigation.navigate('PrivacyPolicy')} />
            <SettingRow icon="document-text-outline" iconColor={palette.colors.info} iconBg="rgba(59,130,246,0.15)" title="Terms of Service" onPress={() => navigation.navigate('TermsOfService')} showBorder={false} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>ACCOUNT</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="trash-outline" iconColor={palette.colors.error} iconBg="rgba(239,68,68,0.15)" title={isDeletingAccount ? 'Deleting Account…' : 'Delete Account'} subtitle="Permanently remove your account" onPress={isDeletingAccount ? undefined : handleDeleteAccount} showBorder={false} />
          </GlassPanel>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Made with ❤️ by Rozare</Text>
            <Text style={styles.footerVersion}>v{APP_VERSION}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm },
  heroBackBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  heroCenter: { flex: 1, marginLeft: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text },
  heroSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  heroIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  scrollContent: { paddingBottom: spacing.xxl },
  sectionLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary, letterSpacing: 0.8, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  settingCard: { marginHorizontal: spacing.md, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  settingRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  settingIcon: { width: 40, height: 40, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  settingText: { flex: 1 },
  settingTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  settingSubtitle: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  footer: { alignItems: 'center', paddingVertical: spacing.xxl },
  footerText: { fontSize: fontSize.md, color: p.colors.textSecondary, marginBottom: spacing.xs },
  footerVersion: { fontSize: fontSize.xs, color: p.colors.textLight },
  appearanceRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  segmented: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: borderRadius.lg,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    gap: 6,
  },
  segmentText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
});
