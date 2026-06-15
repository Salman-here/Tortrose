/**
 * SellerSubdomainManagementScreen - Liquid Glass
 * Manage custom subdomain, monitor traffic and performance
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, SafeAreaView, Clipboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

export default function SellerSubdomainManagementScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currency, formatPrice } = useCurrency();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [slugChecking, setSlugChecking] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get(`/api/subdomain/analytics/seller?currency=${currency}`);
      setData(res.data);
      setNewSlug(res.data.subdomain?.slug || '');
    } catch (e) { Alert.alert('Error', 'Failed to load subdomain data'); }
    finally { setLoading(false); setRefreshing(false); }
  }, [currency]);

  useEffect(() => { fetchData(); }, []);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, [fetchData]);

  const sanitize = (v) => v.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');

  useEffect(() => {
    if (!editing || !newSlug || newSlug === data?.subdomain?.slug || newSlug.length < 3) return;
    const t = setTimeout(async () => {
      try {
        setSlugChecking(true);
        const res = await api.get(`/api/stores/check-subdomain/${newSlug}`);
        setSlugAvailable(res.data.available);
      } catch { setSlugAvailable(null); }
      finally { setSlugChecking(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [newSlug, editing]);

  const handleSave = async () => {
    if (!newSlug || newSlug.length < 3) { Alert.alert('Error', 'Subdomain must be at least 3 characters'); return; }
    try {
      setSaving(true);
      await api.put('/api/stores/update', { storeSlug: newSlug });
      Alert.alert('Success', 'Subdomain updated!');
      setEditing(false);
      fetchData();
    } catch (e) { Alert.alert('Error', e.response?.data?.msg || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const copyUrl = (url) => {
    Clipboard.setString(`https://${url}`);
    Alert.alert('Copied', 'URL copied to clipboard');
  };

  if (loading) return <GlassBackground><SafeAreaView style={{ flex: 1 }}><Loader fullScreen message="Loading..." /></SafeAreaView></GlassBackground>;
  if (!data) return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Ionicons name="globe-outline" size={48} color={palette.colors.textLight} />
        <Text style={{ fontSize: fontSize.md, color: palette.colors.textSecondary, marginTop: spacing.md }}>No subdomain data. Create a store first.</Text>
      </SafeAreaView>
    </GlassBackground>
  );

  const { subdomain, analytics } = data;
  const isActive = subdomain.isActive;

  const stats = [
    { label: 'Views', value: analytics.totalViews || 0, icon: 'eye-outline', color: palette.colors.primary },
    { label: 'Orders', value: analytics.totalOrders || 0, icon: 'receipt-outline', color: palette.colors.success },
    { label: 'Revenue', value: formatPrice(analytics.totalRevenue || 0, { sourceCurrency: analytics.currency || currency }), icon: 'cash-outline', color: palette.colors.info },
    { label: 'Conversion', value: `${analytics.conversionRate || 0}%`, icon: 'trending-up-outline', color: palette.colors.secondary },
  ];

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View>
            <Text style={styles.title}>Subdomain Management</Text>
            <Text style={styles.subtitle}>Your custom store URL</Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        >
          {/* Status Card */}
          <GlassPanel variant="strong" style={styles.statusCard}>
            <View style={styles.statusRow}>
              {subdomain.logo ? (
                <Image source={{ uri: subdomain.logo }} style={styles.storeLogo} />
              ) : (
                <View style={[styles.storeLogo, styles.logoPlaceholder]}>
                  <Ionicons name="globe" size={24} color={palette.colors.white} />
                </View>
              )}
              <View style={styles.statusInfo}>
                <Text style={styles.storeName}>{subdomain.storeName}</Text>
                <View style={styles.urlRow}>
                  <Text style={styles.urlText}>{subdomain.url}</Text>
                  <TouchableOpacity onPress={() => copyUrl(subdomain.url)}>
                    <Ionicons name="copy-outline" size={14} color={palette.colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>
            <View style={[styles.statusBadge, { backgroundColor: isActive ? `${palette.colors.success}15` : `${palette.colors.warning}15` }]}>
              <Ionicons name={isActive ? 'checkmark-circle' : 'lock-closed'} size={16} color={isActive ? palette.colors.success : palette.colors.warning} />
              <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: isActive ? palette.colors.success : palette.colors.warning }}>
                {isActive ? 'Active & Live' : 'Inactive'}
              </Text>
            </View>

            {!isActive && (
              <View style={styles.inactiveWarning}>
                <Ionicons name="alert-triangle" size={16} color={palette.colors.warning} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.warningTitle}>Subdomain not active</Text>
                  <Text style={styles.warningText}>
                    {subdomain.verificationStatus === 'pending'
                      ? 'Your verification is under review. Once approved, your subdomain will go live.'
                      : 'Get verified to activate your subdomain. Apply in Store Settings.'}
                  </Text>
                  <TouchableOpacity onPress={() => navigation.navigate('SellerStoreSettings')} style={styles.warningBtn}>
                    <Text style={styles.warningBtnText}>Go to Store Settings</Text>
                    <Ionicons name="arrow-forward" size={12} color={palette.colors.white} />
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </GlassPanel>

          {/* Edit Subdomain */}
          <GlassPanel variant="card" style={styles.editPanel}>
            <View style={styles.editHeader}>
              <Text style={styles.sectionTitle}>
                <Ionicons name="pencil" size={16} color={palette.colors.text} /> Change Subdomain
              </Text>
              {!editing && (
                <TouchableOpacity onPress={() => setEditing(true)} style={styles.editBtn}>
                  <Text style={styles.editBtnText}>Edit</Text>
                </TouchableOpacity>
              )}
            </View>

            {editing ? (
              <View>
                <View style={styles.slugInputRow}>
                  <Text style={styles.slugPrefix}>https://</Text>
                  <TextInput
                    style={styles.slugInput}
                    value={newSlug}
                    onChangeText={(t) => { setNewSlug(sanitize(t)); setSlugAvailable(null); }}
                    placeholder="your-store"
                    placeholderTextColor={palette.colors.textLight}
                    autoCapitalize="none"
                    maxLength={50}
                  />
                  <Text style={styles.slugSuffix}>.rozare.com</Text>
                  <View style={styles.slugCheck}>
                    {slugChecking ? <ActivityIndicator size="small" color={palette.colors.textSecondary} />
                      : slugAvailable === true ? <Ionicons name="checkmark-circle" size={16} color={palette.colors.success} />
                      : slugAvailable === false ? <Ionicons name="close-circle" size={16} color={palette.colors.error} />
                      : null}
                  </View>
                </View>
                <View style={styles.editActions}>
                  <TouchableOpacity onPress={handleSave} disabled={saving || slugAvailable === false || !newSlug || newSlug.length < 3} style={[styles.saveBtn, (saving || slugAvailable === false) && { opacity: 0.5 }]}>
                    {saving ? <ActivityIndicator size="small" color={palette.colors.white} /> : <Ionicons name="checkmark" size={16} color={palette.colors.white} />}
                    <Text style={styles.saveBtnText}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setEditing(false); setNewSlug(subdomain.slug); setSlugAvailable(null); }} style={styles.cancelBtn}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={styles.currentSlug}>
                <Ionicons name="globe-outline" size={16} color={palette.colors.primary} />
                <Text style={styles.currentSlugText}>{subdomain.url}</Text>
                <TouchableOpacity onPress={() => copyUrl(subdomain.url)}>
                  <Ionicons name="copy-outline" size={14} color={palette.colors.textSecondary} />
                </TouchableOpacity>
              </View>
            )}
          </GlassPanel>

          {/* Stats */}
          <View style={styles.statsGrid}>
            {stats.map((s, i) => (
              <GlassPanel key={i} variant="card" style={styles.statCard}>
                <View style={[styles.statIcon, { backgroundColor: `${s.color}15` }]}>
                  <Ionicons name={s.icon} size={18} color={s.color} />
                </View>
                <Text style={styles.statValue}>{s.value}</Text>
                <Text style={styles.statLabel}>{s.label}</Text>
              </GlassPanel>
            ))}
          </View>

          {/* Info */}
          <GlassPanel variant="card" style={styles.infoPanel}>
            <Text style={styles.sectionTitle}>
              <Ionicons name="information-circle-outline" size={16} color={palette.colors.text} /> About Subdomains
            </Text>
            {[
              { q: 'What is a subdomain?', a: 'A custom URL like yourstore.rozare.com for direct store access.' },
              { q: 'When does it activate?', a: 'After your store is verified via Store Settings.' },
              { q: 'Can I change it?', a: 'Yes. Change it anytime; the old URL stops working immediately.' },
            ].map((faq, i) => (
              <View key={i} style={styles.faqItem}>
                <Text style={styles.faqQ}>{faq.q}</Text>
                <Text style={styles.faqA}>{faq.a}</Text>
              </View>
            ))}
          </GlassPanel>

          <View style={{ height: 40 }} />
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  headerBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: `${p.colors.gray}10`, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  subtitle: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  statusCard: { padding: spacing.lg, marginBottom: spacing.md },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  storeLogo: { width: 52, height: 52, borderRadius: borderRadius.xl },
  logoPlaceholder: { backgroundColor: p.colors.primary, alignItems: 'center', justifyContent: 'center' },
  statusInfo: { flex: 1 },
  storeName: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  urlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
  urlText: { fontSize: fontSize.sm, color: p.colors.primary, fontFamily: 'monospace' },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, alignSelf: 'flex-start', marginTop: spacing.md },
  inactiveWarning: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md, backgroundColor: `${p.colors.warning}08`, borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: `${p.colors.warning}20` },
  warningTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.warning },
  warningText: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 4, lineHeight: 18 },
  warningBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: p.colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.md, alignSelf: 'flex-start', marginTop: spacing.sm },
  warningBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.white },
  editPanel: { padding: spacing.lg, marginBottom: spacing.md },
  editHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  editBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.md, backgroundColor: `${p.colors.gray}10` },
  editBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  slugInputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: `${p.colors.gray}06`, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: `${p.colors.gray}15`, overflow: 'hidden' },
  slugPrefix: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, fontSize: fontSize.sm, color: p.colors.textSecondary, backgroundColor: `${p.colors.gray}08`, borderRightWidth: 1, borderRightColor: `${p.colors.gray}15` },
  slugInput: { flex: 1, paddingHorizontal: spacing.sm, paddingVertical: spacing.md, fontSize: fontSize.sm, color: p.colors.text, fontFamily: 'monospace' },
  slugSuffix: { paddingHorizontal: spacing.sm, fontSize: fontSize.sm, color: p.colors.textSecondary },
  slugCheck: { paddingHorizontal: spacing.sm },
  editActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: p.colors.primary, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.lg },
  saveBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.white },
  cancelBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.gray}10` },
  cancelBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  currentSlug: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: `${p.colors.gray}06`, borderRadius: borderRadius.lg, padding: spacing.md },
  currentSlugText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, fontFamily: 'monospace', flex: 1 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { flex: 1, minWidth: '45%', padding: spacing.md, alignItems: 'center' },
  statIcon: { width: 40, height: 40, borderRadius: borderRadius.lg, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs },
  statValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  statLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  infoPanel: { padding: spacing.lg, marginBottom: spacing.md },
  faqItem: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: `${p.colors.gray}08` },
  faqQ: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  faqA: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 4, lineHeight: 18 },
});
