/**
 * NotificationSettingsScreen — Liquid Glass
 * Shared between admin and seller with role-based sections
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Switch,
  Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../../styles/theme';

const defaultPrefs = {
  stockAlerts: true, lowStockAlerts: true, orderAlerts: true,
  paymentAlerts: true, deliveryAlerts: true, storeCreation: true, storeVerification: true,
};

export default function NotificationSettingsScreen({ route }) {
  const isAdmin = route.params?.isAdmin ?? false;
  const [prefs, setPrefs] = useState(defaultPrefs);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try { const res = await api.get('/api/analytics/notification-prefs'); setPrefs({ ...defaultPrefs, ...res.data.prefs }); } catch { }
      finally { setLoading(false); }
    })();
  }, []);

  const handleToggle = (key) => { setPrefs(prev => ({ ...prev, [key]: !prev[key] })); setSaved(false); };

  const handleSave = async () => {
    setSaving(true);
    try { await api.put('/api/analytics/notification-prefs', { prefs }); setSaved(true); setTimeout(() => setSaved(false), 2000); Alert.alert('Success', 'Preferences saved'); }
    catch { Alert.alert('Error', 'Failed to save'); }
    finally { setSaving(false); }
  };

  const handleReset = async () => {
    setPrefs(defaultPrefs);
    try { await api.put('/api/analytics/notification-prefs', { prefs: defaultPrefs }); Alert.alert('Reset', 'Defaults restored'); } catch { }
  };

  const sections = [
    { title: 'Stock Alerts', desc: 'Inventory notifications', items: [
      { key: 'stockAlerts', label: 'Out of stock alerts', desc: 'When a product runs out', icon: 'cube-outline' },
      { key: 'lowStockAlerts', label: 'Low stock warnings', desc: 'Stock below 10 units', icon: 'cube-outline' },
    ]},
    { title: 'Order Alerts', desc: 'Order activity', items: [
      { key: 'orderAlerts', label: 'New orders', desc: 'When orders are placed', icon: 'cart-outline' },
      { key: 'paymentAlerts', label: 'Payment confirmations', desc: 'When payments received', icon: 'checkmark-circle-outline' },
      { key: 'deliveryAlerts', label: 'Delivery updates', desc: 'When orders delivered', icon: 'car-outline' },
    ]},
    ...(isAdmin ? [{ title: 'Store Alerts', desc: 'Admin-specific', items: [
      { key: 'storeCreation', label: 'New store creation', desc: 'When sellers create stores', icon: 'storefront-outline' },
      { key: 'storeVerification', label: 'Verification requests', desc: 'Stores needing review', icon: 'shield-outline' },
    ]}] : []),
  ];

  if (loading) return <GlassBackground><Loader fullScreen message="Loading preferences..." /></GlassBackground>;

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <View style={styles.headerRow}>
          <View style={styles.tagPill}><Ionicons name="settings-outline" size={12} color={colors.primary} /><Text style={styles.tagText}>Settings</Text></View>
          <Text style={styles.headerTitle}>Notification Settings</Text>
          <Text style={styles.headerSubtitle}>Choose which notifications to receive</Text>
        </View>

        {sections.map((section, si) => (
          <GlassPanel key={section.title} variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              <Text style={styles.sectionDesc}>{section.desc}</Text>
            </View>
            {section.items.map(item => (
              <View key={item.key} style={styles.toggleRow}>
                <View style={[styles.toggleIcon, { backgroundColor: prefs[item.key] ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.06)' }]}>
                  <Ionicons name={item.icon} size={16} color={prefs[item.key] ? colors.primary : colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>{item.label}</Text>
                  <Text style={styles.toggleDesc}>{item.desc}</Text>
                </View>
                <Switch value={prefs[item.key]} onValueChange={() => handleToggle(item.key)}
                  trackColor={{ false: 'rgba(255,255,255,0.1)', true: colors.primary }}
                  thumbColor="white" />
              </View>
            ))}
          </GlassPanel>
        ))}

        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
            <Text style={styles.resetBtnText}>Reset to defaults</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="white" size="small" /> : saved ? (
              <><Ionicons name="checkmark-circle" size={16} color="white" /><Text style={styles.saveBtnText}>Saved!</Text></>
            ) : (
              <><Ionicons name="save-outline" size={16} color="white" /><Text style={styles.saveBtnText}>Save</Text></>
            )}
          </TouchableOpacity>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  headerRow: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, marginBottom: spacing.lg },
  tagPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.12)', alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: borderRadius.full, marginBottom: spacing.sm },
  tagText: { ...typography.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  headerTitle: { fontSize: fontSize.xxl + 4, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: -0.5 },
  headerSubtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2 },
  section: { marginHorizontal: spacing.lg, marginBottom: spacing.md, overflow: 'hidden' },
  sectionHeader: { padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  sectionTitle: { ...typography.bodySemibold, color: colors.text },
  sectionDesc: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  toggleIcon: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  toggleLabel: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  toggleDesc: { ...typography.caption, color: colors.textSecondary },
  actionsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginTop: spacing.md, gap: spacing.md },
  resetBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, backgroundColor: 'rgba(255,255,255,0.08)' },
  resetBtnText: { ...typography.bodySmall, color: colors.textSecondary },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, backgroundColor: colors.primary },
  saveBtnText: { ...typography.bodySemibold, color: 'white' },
});
