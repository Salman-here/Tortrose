/**
 * SettingsScreen — Liquid Glass Design
 */

import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Switch, Linking, Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';

const APP_VERSION = '1.0.0';

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

const SETTINGS_KEYS = { NOTIFICATIONS: 'settings_notifications_enabled', EMAIL_UPDATES: 'settings_email_updates' };

export default function SettingsScreen({ navigation }) {
  const { logout } = useAuth();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [notifVal, emailVal, { status }] = await Promise.all([AsyncStorage.getItem(SETTINGS_KEYS.NOTIFICATIONS), AsyncStorage.getItem(SETTINGS_KEYS.EMAIL_UPDATES), Notifications.getPermissionsAsync()]);
        setNotificationsEnabled(status === 'granted' && (notifVal !== null ? notifVal === 'true' : true));
        if (emailVal !== null) setEmailUpdates(emailVal === 'true');
      } catch (err) { console.error('Failed to load settings:', err); }
    };
    loadSettings();
  }, []);

  const handleNotificationsChange = useCallback(async (value) => {
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
      <SafeAreaView style={styles.container}>
        <GlassPanel variant="floating" style={styles.heroHeader}>
          <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.heroCenter}>
            <Text style={styles.heroTitle}>Settings</Text>
            <Text style={styles.heroSubtitle}>App preferences & support</Text>
          </View>
          <View style={styles.heroIconWrap}><Ionicons name="settings-outline" size={22} color={colors.primary} /></View>
        </GlassPanel>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="notifications-outline" iconColor={colors.primary} iconBg="rgba(99,102,241,0.15)" title="Push Notifications" subtitle="Order updates and alerts" rightElement={<Switch value={notificationsEnabled} onValueChange={handleNotificationsChange} trackColor={{ false: colors.grayLighter, true: colors.primaryLight }} thumbColor={notificationsEnabled ? colors.primary : colors.grayLight} />} />
            <SettingRow icon="mail-outline" iconColor={colors.info} iconBg="rgba(59,130,246,0.15)" title="Email Updates" subtitle="Promotions and newsletters" showBorder={false} rightElement={<Switch value={emailUpdates} onValueChange={(v) => { setEmailUpdates(v); AsyncStorage.setItem(SETTINGS_KEYS.EMAIL_UPDATES, String(v)); }} trackColor={{ false: colors.grayLighter, true: colors.primaryLight }} thumbColor={emailUpdates ? colors.primary : colors.grayLight} />} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>SUPPORT</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="mail-outline" iconColor={colors.success} iconBg="rgba(16,185,129,0.15)" title="Contact Support" subtitle="support@tortrose.com" onPress={() => Linking.openURL('mailto:support@tortrose.com')} />
            <SettingRow icon="logo-whatsapp" iconColor="#25D366" iconBg="#e8fdf0" title="WhatsApp Support" subtitle="Chat with us directly" onPress={() => Linking.openURL('https://wa.me/923001234567')} />
            <SettingRow icon="star-outline" iconColor={colors.warning} iconBg="rgba(245,158,11,0.15)" title="Rate the App" subtitle="Share your experience" onPress={() => Alert.alert('Rate Us ⭐', 'Enjoying Tortrose?', [{ text: 'Maybe Later', style: 'cancel' }, { text: 'Rate Now', onPress: () => Linking.openURL(Platform.OS === 'ios' ? 'https://apps.apple.com' : 'https://play.google.com') }])} showBorder={false} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>LEGAL</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="shield-outline" iconColor={colors.secondary} iconBg="rgba(139,92,246,0.15)" title="Privacy Policy" onPress={() => Linking.openURL('https://tortrose.com/privacy-policy')} />
            <SettingRow icon="document-text-outline" iconColor={colors.info} iconBg="rgba(59,130,246,0.15)" title="Terms of Service" onPress={() => Linking.openURL('https://tortrose.com/terms')} showBorder={false} />
          </GlassPanel>

          <Text style={styles.sectionLabel}>ACCOUNT</Text>
          <GlassPanel variant="card" style={styles.settingCard}>
            <SettingRow icon="trash-outline" iconColor={colors.error} iconBg="rgba(239,68,68,0.15)" title={isDeletingAccount ? 'Deleting Account…' : 'Delete Account'} subtitle="Permanently remove your account" onPress={isDeletingAccount ? undefined : handleDeleteAccount} showBorder={false} />
          </GlassPanel>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Made with ❤️ by Tortrose</Text>
            <Text style={styles.footerVersion}>v{APP_VERSION}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm },
  heroBackBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  heroCenter: { flex: 1, marginLeft: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  heroSubtitle: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  heroIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  scrollContent: { paddingBottom: spacing.xxl },
  sectionLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textSecondary, letterSpacing: 0.8, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  settingCard: { marginHorizontal: spacing.md, overflow: 'hidden' },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  settingRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  settingIcon: { width: 40, height: 40, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  settingText: { flex: 1 },
  settingTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  settingSubtitle: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  footer: { alignItems: 'center', paddingVertical: spacing.xxl },
  footerText: { fontSize: fontSize.md, color: colors.textSecondary, marginBottom: spacing.xs },
  footerVersion: { fontSize: fontSize.xs, color: colors.textLight },
});
