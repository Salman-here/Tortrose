/**
 * NotificationPreferencesScreen — For ALL users
 * Toggle notification categories: Orders, Promotions, Seller Alerts, System.
 * Persists to backend (notificationPrefs) and locally for offline support.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch,
  Alert, ActivityIndicator, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import Loader from '../components/common/Loader';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius, typography } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const PREFS_LOCAL_KEY = 'notification_preferences';

const defaultPrefs = {
  // Order notifications
  orderPlaced: true,
  orderShipped: true,
  orderDelivered: true,
  orderCancelled: true,
  // Promotions
  priceDrops: true,
  backInStock: true,
  couponAlerts: true,
  cartReminders: true,
  // Seller (only shown to sellers)
  newOrderReceived: true,
  lowStockAlerts: true,
  storeVerification: true,
  subscriptionAlerts: true,
  // System
  accountUpdates: true,
  securityAlerts: true,
};

export default function NotificationPreferencesScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const isSeller = currentUser?.role === 'seller' || currentUser?.role === 'admin';
  const [prefs, setPrefs] = useState(defaultPrefs);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Try backend first
        if (currentUser) {
          const res = await api.get('/api/analytics/notification-prefs');
          if (res.data?.prefs) {
            setPrefs({ ...defaultPrefs, ...res.data.prefs });
            setLoading(false);
            return;
          }
        }
      } catch {}
      // Fallback to local
      try {
        const local = await AsyncStorage.getItem(PREFS_LOCAL_KEY);
        if (local) setPrefs({ ...defaultPrefs, ...JSON.parse(local) });
      } catch {}
      setLoading(false);
    })();
  }, [currentUser]);

  const handleToggle = (key) => {
    setPrefs(prev => ({ ...prev, [key]: !prev[key] }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await AsyncStorage.setItem(PREFS_LOCAL_KEY, JSON.stringify(prefs));
      if (currentUser) {
        await api.put('/api/analytics/notification-prefs', { prefs });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      Alert.alert('Error', 'Failed to save preferences');
    }
    finally { setSaving(false); }
  };

  const handleReset = () => {
    Alert.alert('Reset Preferences', 'Restore all notification preferences to defaults?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: async () => {
        setPrefs(defaultPrefs);
        await AsyncStorage.setItem(PREFS_LOCAL_KEY, JSON.stringify(defaultPrefs));
        if (currentUser) {
          try { await api.put('/api/analytics/notification-prefs', { prefs: defaultPrefs }); } catch {}
        }
      }},
    ]);
  };

  const toggleAllInSection = (keys, value) => {
    setPrefs(prev => {
      const updated = { ...prev };
      keys.forEach(k => { updated[k] = value; });
      return updated;
    });
    setSaved(false);
  };

  const sections = [
    {
      title: 'Order Updates',
      desc: 'Stay informed about your orders',
      icon: 'receipt-outline',
      color: palette.colors.primary,
      items: [
        { key: 'orderPlaced', label: 'Order confirmed', desc: 'When your order is placed', icon: 'checkmark-circle-outline' },
        { key: 'orderShipped', label: 'Shipping updates', desc: 'When your order ships', icon: 'airplane-outline' },
        { key: 'orderDelivered', label: 'Delivery alerts', desc: 'When your order arrives', icon: 'cube-outline' },
        { key: 'orderCancelled', label: 'Cancellation alerts', desc: 'If an order is cancelled', icon: 'close-circle-outline' },
      ],
    },
    {
      title: 'Promotions & Deals',
      desc: 'Never miss a great deal',
      icon: 'pricetag-outline',
      color: palette.colors.warning,
      items: [
        { key: 'priceDrops', label: 'Price drops', desc: 'Wishlist items on sale', icon: 'trending-down-outline' },
        { key: 'backInStock', label: 'Back in stock', desc: 'Items you wanted available again', icon: 'refresh-outline' },
        { key: 'couponAlerts', label: 'Coupon alerts', desc: 'New coupons & discount codes', icon: 'ticket-outline' },
        { key: 'cartReminders', label: 'Cart reminders', desc: 'Items waiting in your cart', icon: 'cart-outline' },
      ],
    },
    ...(isSeller ? [{
      title: 'Seller Alerts',
      desc: 'Manage your store efficiently',
      icon: 'storefront-outline',
      color: '#8B5CF6',
      items: [
        { key: 'newOrderReceived', label: 'New orders', desc: 'When customers place orders', icon: 'bag-add-outline' },
        { key: 'lowStockAlerts', label: 'Low stock warnings', desc: 'Products running low', icon: 'alert-outline' },
        { key: 'storeVerification', label: 'Store verification', desc: 'Verification status updates', icon: 'shield-checkmark-outline' },
        { key: 'subscriptionAlerts', label: 'Subscription alerts', desc: 'Plan expiry reminders', icon: 'card-outline' },
      ],
    }] : []),
    {
      title: 'System',
      desc: 'Account & security notifications',
      icon: 'settings-outline',
      color: palette.colors.info,
      items: [
        { key: 'accountUpdates', label: 'Account updates', desc: 'Profile & account changes', icon: 'person-outline' },
        { key: 'securityAlerts', label: 'Security alerts', desc: 'Login & security events', icon: 'lock-closed-outline' },
      ],
    },
  ];

  if (loading) return <GlassBackground><Loader fullScreen message="Loading preferences..." /></GlassBackground>;

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Notification Preferences"
          subtitle="Choose what you want to be notified about"
          icon="notifications-outline"
          onBack={() => navigation.goBack()}
          rightIcon="options-outline"
          rightLabel="Alerts"
          style={styles.premiumHeader}
        />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
          {sections.map((section) => {
            const allKeys = section.items.map(i => i.key);
            const allOn = allKeys.every(k => prefs[k]);
            const allOff = allKeys.every(k => !prefs[k]);

            return (
              <GlassPanel key={section.title} variant="card" style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={[styles.sectionIconWrap, { backgroundColor: section.color + '20' }]}>
                    <Ionicons name={section.icon} size={18} color={section.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sectionTitle}>{section.title}</Text>
                    <Text style={styles.sectionDesc}>{section.desc}</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.toggleAllBtn}
                    onPress={() => toggleAllInSection(allKeys, !allOn)}
                  >
                    <Text style={[styles.toggleAllText, { color: section.color }]}>
                      {allOn ? 'Disable all' : 'Enable all'}
                    </Text>
                  </TouchableOpacity>
                </View>
                {section.items.map(item => (
                  <View key={item.key} style={styles.toggleRow}>
                    <View style={[styles.toggleIcon, { backgroundColor: prefs[item.key] ? section.color + '18' : 'rgba(255,255,255,0.06)' }]}>
                      <Ionicons name={item.icon} size={16} color={prefs[item.key] ? section.color : palette.colors.textSecondary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.toggleLabel}>{item.label}</Text>
                      <Text style={styles.toggleDesc}>{item.desc}</Text>
                    </View>
                    <Switch
                      value={prefs[item.key]}
                      onValueChange={() => handleToggle(item.key)}
                      trackColor={{ false: 'rgba(255,255,255,0.1)', true: section.color }}
                      thumbColor="white"
                    />
                  </View>
                ))}
              </GlassPanel>
            );
          })}

          {/* Actions */}
          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
              <Ionicons name="refresh-outline" size={16} color={palette.colors.textSecondary} />
              <Text style={styles.resetBtnText}>Reset defaults</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, saving && { opacity: 0.6 }]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color="white" size="small" />
              ) : saved ? (
                <>
                  <Ionicons name="checkmark-circle" size={16} color="white" />
                  <Text style={styles.saveBtnText}>Saved!</Text>
                </>
              ) : (
                <>
                  <Ionicons name="save-outline" size={16} color="white" />
                  <Text style={styles.saveBtnText}>Save Preferences</Text>
                </>
              )}
            </TouchableOpacity>
          </View>

          <View style={{ height: 120 }} />
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  scroll: { paddingTop: spacing.md },
  section: { marginHorizontal: spacing.md, marginBottom: spacing.md, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)', gap: spacing.md },
  sectionIconWrap: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  sectionTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  sectionDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 1 },
  toggleAllBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  toggleAllText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  toggleIcon: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  toggleLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  toggleDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 1 },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginTop: spacing.md, gap: spacing.md },
  resetBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, backgroundColor: 'rgba(255,255,255,0.08)' },
  resetBtnText: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, backgroundColor: p.colors.primary },
  saveBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: 'white' },
});
