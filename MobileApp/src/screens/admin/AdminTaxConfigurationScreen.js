/**
 * AdminTaxConfigurationScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Alert, RefreshControl, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../../styles/theme';

const TAX_TYPES = [
  { key: 'none', label: 'No Tax', icon: 'close-circle-outline', color: colors.textSecondary, desc: 'No tax charged' },
  { key: 'percentage', label: 'Percentage (%)', icon: 'trending-up-outline', color: colors.info, desc: 'Percentage of subtotal' },
  { key: 'fixed', label: 'Fixed Amount', icon: 'cash-outline', color: colors.success, desc: 'Flat amount per order' },
];

export default function AdminTaxConfigurationScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [taxType, setTaxType] = useState('none');
  const [taxValue, setTaxValue] = useState('');
  const [valueError, setValueError] = useState('');

  useEffect(() => { fetchTaxConfig(); }, []);

  const fetchTaxConfig = async () => {
    try {
      const res = await api.get('/api/tax/config');
      const config = res.data.taxConfig;
      if (config) { setTaxType(config.type || 'none'); setTaxValue(config.value !== undefined ? String(config.value) : '0'); }
    } catch (e) { Alert.alert('Error', 'Failed to load tax configuration'); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchTaxConfig(); }, []);

  const validate = () => {
    if (taxType === 'none') return true;
    const val = parseFloat(taxValue);
    if (isNaN(val) || val < 0) { setValueError('Enter a valid number'); return false; }
    if (taxType === 'percentage' && val > 100) { setValueError('Max 100%'); return false; }
    setValueError(''); return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      await api.put('/api/tax/config', { type: taxType, value: taxType === 'none' ? 0 : parseFloat(taxValue) || 0 });
      Alert.alert('Success', 'Tax configuration updated');
    } catch (e) { Alert.alert('Error', e.response?.data?.msg || 'Failed to update'); }
    finally { setSaving(false); }
  };

  const getPreviewText = () => {
    const val = parseFloat(taxValue) || 0;
    if (taxType === 'none') return 'No tax will be applied';
    if (taxType === 'percentage') return `${val}% tax on every order subtotal`;
    return `$${val.toFixed(2)} flat tax per order`;
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading..." /></GlassBackground>;

  return (
    <GlassBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
          
          <GlassPanel variant="floating" style={styles.hero}>
            <View style={styles.heroIcon}><Ionicons name="calculator" size={32} color="white" /></View>
            <Text style={styles.heroTitle}>Tax Configuration</Text>
            <Text style={styles.heroSubtitle}>Set global tax rules for all orders</Text>
          </GlassPanel>

          <GlassPanel variant="card" style={styles.infoCard}>
            <Ionicons name="information-circle-outline" size={18} color={colors.info} />
            <Text style={styles.infoText}>This is a global tax rule applied uniformly to all orders.</Text>
          </GlassPanel>

          <Text style={styles.sectionLabel}>TAX TYPE</Text>
          <GlassPanel variant="card" style={styles.typeCard}>
            {TAX_TYPES.map((type, idx) => (
              <TouchableOpacity key={type.key} style={[styles.typeRow, taxType === type.key && styles.typeRowActive, idx < TAX_TYPES.length - 1 && styles.typeRowBorder]}
                onPress={() => { setTaxType(type.key); setValueError(''); }} activeOpacity={0.7}>
                <View style={[styles.typeIconWrap, { backgroundColor: taxType === type.key ? type.color + '20' : 'rgba(255,255,255,0.06)' }]}>
                  <Ionicons name={type.icon} size={22} color={taxType === type.key ? type.color : colors.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.typeLabel, taxType === type.key && { color: type.color }]}>{type.label}</Text>
                  <Text style={styles.typeDesc}>{type.desc}</Text>
                </View>
                <View style={[styles.radioOuter, taxType === type.key && { borderColor: type.color }]}>
                  {taxType === type.key && <View style={[styles.radioInner, { backgroundColor: type.color }]} />}
                </View>
              </TouchableOpacity>
            ))}
          </GlassPanel>

          {taxType !== 'none' && (
            <>
              <Text style={styles.sectionLabel}>{taxType === 'percentage' ? 'TAX RATE (%)' : 'FIXED AMOUNT ($)'}</Text>
              <GlassPanel variant="card" style={styles.valueCard}>
                <View style={styles.valueInputRow}>
                  <View style={styles.prefixBadge}><Text style={styles.prefixText}>{taxType === 'percentage' ? '%' : '$'}</Text></View>
                  <TextInput style={styles.valueInput} value={taxValue}
                    onChangeText={(t) => { setTaxValue(t.replace(/[^0-9.]/g, '')); setValueError(''); }}
                    keyboardType="decimal-pad" placeholder={taxType === 'percentage' ? 'e.g. 10' : 'e.g. 5.00'} placeholderTextColor={colors.textSecondary} />
                </View>
                {valueError ? <Text style={styles.errorText}>{valueError}</Text> : null}
              </GlassPanel>
            </>
          )}

          <GlassPanel variant="inner" style={styles.previewCard}>
            <Ionicons name="eye-outline" size={18} color={colors.primary} />
            <Text style={styles.previewText}>{getPreviewText()}</Text>
          </GlassPanel>

          <TouchableOpacity style={[styles.saveButton, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving} activeOpacity={0.85}>
            {saving ? <ActivityIndicator size="small" color="white" /> : (
              <><Ionicons name="checkmark-circle-outline" size={20} color="white" /><Text style={styles.saveButtonText}>Save Tax Configuration</Text></>
            )}
          </TouchableOpacity>

          <View style={{ height: 100 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  hero: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.lg },
  heroIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.xs },
  heroSubtitle: { ...typography.bodySmall, color: colors.textSecondary, textAlign: 'center' },
  infoCard: { flexDirection: 'row', alignItems: 'flex-start', padding: spacing.md, marginBottom: spacing.lg, gap: spacing.sm, borderLeftWidth: 3, borderLeftColor: colors.info },
  infoText: { ...typography.bodySmall, color: colors.textSecondary, flex: 1, lineHeight: 20 },
  sectionLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textSecondary, letterSpacing: 0.8, marginBottom: spacing.sm, marginLeft: spacing.xs },
  typeCard: { marginBottom: spacing.lg, overflow: 'hidden' },
  typeRow: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.md },
  typeRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  typeRowActive: { backgroundColor: 'rgba(255,255,255,0.05)' },
  typeIconWrap: { width: 44, height: 44, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  typeLabel: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: 2 },
  typeDesc: { ...typography.bodySmall, color: colors.textSecondary },
  radioOuter: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  radioInner: { width: 12, height: 12, borderRadius: 6 },
  valueCard: { marginBottom: spacing.lg, overflow: 'hidden' },
  valueInputRow: { flexDirection: 'row', alignItems: 'center' },
  prefixBadge: { width: 50, height: 56, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', borderRightWidth: 1, borderRightColor: 'rgba(255,255,255,0.08)' },
  prefixText: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.primary },
  valueInput: { flex: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, fontSize: fontSize.xl, fontWeight: fontWeight.semibold, color: colors.text },
  errorText: { ...typography.bodySmall, color: colors.error, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  previewCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.lg },
  previewText: { ...typography.bodySmall, color: colors.textSecondary, flex: 1, lineHeight: 20 },
  saveButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.lg },
  saveButtonText: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: 'white' },
});
