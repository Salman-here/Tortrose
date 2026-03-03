/**
 * SettingsScreen
 * App settings, support, and about page
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Switch,
  Linking,
  Alert,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import api from '../config/api';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
} from '../styles/theme';

const APP_VERSION = '1.0.0';

function SettingRow({ icon, iconColor, iconBg, title, subtitle, onPress, rightElement, showBorder = true }) {
  return (
    <TouchableOpacity
      style={[styles.settingRow, showBorder && styles.settingRowBorder]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
    >
      <View style={[styles.settingIcon, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={20} color={iconColor} />
      </View>
      <View style={styles.settingText}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle ? <Text style={styles.settingSubtitle}>{subtitle}</Text> : null}
      </View>
      {rightElement || (onPress && (
        <Ionicons name="chevron-forward" size={18} color={colors.grayLight} />
      ))}
    </TouchableOpacity>
  );
}

function SectionHeader({ title }) {
  return <Text style={styles.sectionLabel}>{title}</Text>;
}

const SETTINGS_KEYS = {
  NOTIFICATIONS: 'settings_notifications_enabled',
  EMAIL_UPDATES: 'settings_email_updates',
};

export default function SettingsScreen({ navigation }) {
  const { logout } = useAuth();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  // Load persisted settings on mount and sync with system permissions
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const [notifVal, emailVal, { status }] = await Promise.all([
          AsyncStorage.getItem(SETTINGS_KEYS.NOTIFICATIONS),
          AsyncStorage.getItem(SETTINGS_KEYS.EMAIL_UPDATES),
          Notifications.getPermissionsAsync(),
        ]);

        // Sync with actual system permission — if denied at system level, show as off
        const systemGranted = status === 'granted';
        const savedPref = notifVal !== null ? notifVal === 'true' : true;
        setNotificationsEnabled(systemGranted && savedPref);

        if (emailVal !== null) setEmailUpdates(emailVal === 'true');
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    };
    loadSettings();
  }, []);

  const handleNotificationsChange = useCallback(async (value) => {
    try {
      if (value) {
        // Request notification permissions when enabling
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== 'granted') {
          Alert.alert(
            'Permission Required',
            'Please enable notifications in your device Settings to receive order updates.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open Settings',
                onPress: () => Linking.openSettings(),
              },
            ]
          );
          return; // Don't update the toggle if permission was denied
        }
      }

      setNotificationsEnabled(value);
      await AsyncStorage.setItem(SETTINGS_KEYS.NOTIFICATIONS, String(value));
    } catch (err) {
      console.error('Failed to update notification setting:', err);
    }
  }, []);

  const handleEmailUpdatesChange = useCallback(async (value) => {
    setEmailUpdates(value);
    try {
      await AsyncStorage.setItem(SETTINGS_KEYS.EMAIL_UPDATES, String(value));
    } catch (err) {
      console.error('Failed to save email setting:', err);
    }
  }, []);

  const handleContact = useCallback(() => {
    Linking.openURL('mailto:support@tortrose.com').catch(() =>
      Alert.alert('Email not available', 'Please contact us at support@tortrose.com')
    );
  }, []);

  const handleWhatsApp = useCallback(() => {
    Linking.openURL('https://wa.me/923001234567').catch(() =>
      Alert.alert('WhatsApp not available', 'Please contact us directly.')
    );
  }, []);

  const handlePrivacyPolicy = useCallback(() => {
    Linking.openURL('https://tortrose.com/privacy-policy').catch(() => {});
  }, []);

  const handleTerms = useCallback(() => {
    Linking.openURL('https://tortrose.com/terms').catch(() => {});
  }, []);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account and all associated data. This action cannot be undone.\n\nAre you sure you want to continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: async () => {
            setIsDeletingAccount(true);
            try {
              await api.delete('/api/user/delete-account');
              await logout();
            } catch (err) {
              Alert.alert('Error', err.response?.data?.msg || 'Failed to delete account. Please try again.');
            } finally {
              setIsDeletingAccount(false);
            }
          },
        },
      ]
    );
  }, [logout]);

  const handleRateApp = useCallback(() => {
    const iosUrl = 'https://apps.apple.com/app/tortrose/id0000000000';
    const androidUrl = 'market://details?id=com.tortrose.app';
    const fallbackUrl = 'https://play.google.com/store/apps/details?id=com.tortrose.app';

    Alert.alert('Rate Us ⭐', 'Enjoying Tortrose? Your review helps us grow!', [
      { text: 'Maybe Later', style: 'cancel' },
      {
        text: 'Rate Now',
        onPress: () => {
          const storeUrl = Platform.OS === 'ios' ? iosUrl : androidUrl;
          Linking.canOpenURL(storeUrl)
            .then((supported) => {
              Linking.openURL(supported ? storeUrl : fallbackUrl);
            })
            .catch(() => Linking.openURL(fallbackUrl));
        },
      },
    ]);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      {/* Hero Header */}
      <View style={styles.heroHeader}>
        <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={22} color={colors.white} />
        </TouchableOpacity>
        <View style={styles.heroCenter}>
          <Text style={styles.heroTitle}>Settings</Text>
          <Text style={styles.heroSubtitle}>App preferences & support</Text>
        </View>
        <View style={styles.heroIconWrap}>
          <Ionicons name="settings-outline" size={22} color={colors.white} />
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>

        {/* Notifications */}
        <SectionHeader title="NOTIFICATIONS" />
        <View style={styles.settingCard}>
          <SettingRow
            icon="notifications-outline"
            iconColor={colors.primary}
            iconBg={colors.primarySubtle}
            title="Push Notifications"
            subtitle="Order updates and alerts"
            rightElement={
              <Switch
                value={notificationsEnabled}
                onValueChange={handleNotificationsChange}
                trackColor={{ false: colors.grayLighter, true: colors.primaryLight }}
                thumbColor={notificationsEnabled ? colors.primary : colors.grayLight}
              />
            }
          />
          <SettingRow
            icon="mail-outline"
            iconColor={colors.info}
            iconBg={colors.infoSubtle}
            title="Email Updates"
            subtitle="Promotions and newsletters"
            showBorder={false}
            rightElement={
              <Switch
                value={emailUpdates}
                onValueChange={handleEmailUpdatesChange}
                trackColor={{ false: colors.grayLighter, true: colors.primaryLight }}
                thumbColor={emailUpdates ? colors.primary : colors.grayLight}
              />
            }
          />
        </View>

        {/* Support */}
        <SectionHeader title="SUPPORT" />
        <View style={styles.settingCard}>
          <SettingRow
            icon="mail-outline"
            iconColor={colors.success}
            iconBg={colors.successSubtle}
            title="Contact Support"
            subtitle="support@tortrose.com"
            onPress={handleContact}
          />
          <SettingRow
            icon="logo-whatsapp"
            iconColor="#25D366"
            iconBg="#e8fdf0"
            title="WhatsApp Support"
            subtitle="Chat with us directly"
            onPress={handleWhatsApp}
          />
          <SettingRow
            icon="star-outline"
            iconColor={colors.warning}
            iconBg={colors.warningSubtle}
            title="Rate the App"
            subtitle="Share your experience"
            onPress={handleRateApp}
            showBorder={false}
          />
        </View>

        {/* Legal */}
        <SectionHeader title="LEGAL" />
        <View style={styles.settingCard}>
          <SettingRow
            icon="shield-outline"
            iconColor={colors.secondary}
            iconBg={colors.secondaryLighter}
            title="Privacy Policy"
            onPress={handlePrivacyPolicy}
          />
          <SettingRow
            icon="document-text-outline"
            iconColor={colors.info}
            iconBg={colors.infoSubtle}
            title="Terms of Service"
            onPress={handleTerms}
            showBorder={false}
          />
        </View>

        {/* Account */}
        <SectionHeader title="ACCOUNT" />
        <View style={styles.settingCard}>
          <SettingRow
            icon="trash-outline"
            iconColor={colors.error}
            iconBg={colors.errorSubtle}
            title={isDeletingAccount ? 'Deleting Account…' : 'Delete Account'}
            subtitle="Permanently remove your account and data"
            onPress={isDeletingAccount ? undefined : handleDeleteAccount}
            showBorder={false}
          />
        </View>

        {/* About */}
        <SectionHeader title="ABOUT" />
        <View style={styles.settingCard}>
          <SettingRow
            icon="storefront-outline"
            iconColor={colors.primary}
            iconBg={colors.primarySubtle}
            title="Tortrose"
            subtitle={`Version ${APP_VERSION}`}
            showBorder={false}
          />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Made with ❤️ by Tortrose</Text>
          <Text style={styles.footerVersion}>v{APP_VERSION}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  heroHeader: {
    backgroundColor: colors.primaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  heroBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroCenter: {
    flex: 1,
    marginLeft: spacing.md,
  },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  heroSubtitle: {
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.75)',
    marginTop: 2,
  },
  heroIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    paddingBottom: spacing.xxl,
  },
  sectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.textSecondary,
    letterSpacing: 0.8,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  settingCard: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    ...shadows.sm,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  settingRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  settingIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  settingText: {
    flex: 1,
  },
  settingTitle: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  settingSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  footerText: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  footerVersion: {
    ...typography.caption,
    color: colors.textLight,
  },
});

