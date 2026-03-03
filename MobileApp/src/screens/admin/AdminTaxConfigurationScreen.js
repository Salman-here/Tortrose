/**
 * AdminTaxConfigurationScreen
 * Admin screen for managing the global tax configuration
 * Uses single global config model: { type: 'none'|'percentage'|'fixed', value: number, isActive: boolean }
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  RefreshControl,
  Switch,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
} from '../../styles/theme';
import api from '../../config/api';
import { Loader } from '../../components/common';

const TAX_TYPES = [
  { key: 'none', label: 'No Tax', icon: 'close-circle-outline', color: colors.gray, desc: 'Customers are not charged any tax' },
  { key: 'percentage', label: 'Percentage (%)', icon: 'trending-up-outline', color: colors.info, desc: 'Tax calculated as a percentage of subtotal' },
  { key: 'fixed', label: 'Fixed Amount', icon: 'cash-outline', color: colors.success, desc: 'A flat tax amount added to every order' },
];

export default function AdminTaxConfigurationScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Config state (mirrors backend model)
  const [taxType, setTaxType] = useState('none');
  const [taxValue, setTaxValue] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [valueError, setValueError] = useState('');

  useEffect(() => {
    fetchTaxConfig();
  }, []);

  const fetchTaxConfig = async () => {
    try {
      const res = await api.get('/api/tax/config');
      const config = res.data.taxConfig;
      if (config) {
        setTaxType(config.type || 'none');
        setTaxValue(config.value !== undefined ? String(config.value) : '0');
        setIsActive(config.isActive !== false);
      }
    } catch (error) {
      console.error('Error fetching tax config:', error);
      Alert.alert('Error', 'Failed to load tax configuration');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchTaxConfig();
  }, []);

  const validate = () => {
    if (taxType === 'none') return true;
    const val = parseFloat(taxValue);
    if (isNaN(val) || val < 0) {
      setValueError('Please enter a valid non-negative number');
      return false;
    }
    if (taxType === 'percentage' && val > 100) {
      setValueError('Percentage cannot exceed 100');
      return false;
    }
    setValueError('');
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      await api.put('/api/tax/config', {
        type: taxType,
        value: taxType === 'none' ? 0 : parseFloat(taxValue) || 0,
      });
      Alert.alert('Success', 'Tax configuration updated successfully');
    } catch (error) {
      console.error('Error saving tax config:', error);
      Alert.alert('Error', error.response?.data?.msg || 'Failed to update tax configuration');
    } finally {
      setSaving(false);
    }
  };

  const getPreviewText = () => {
    const val = parseFloat(taxValue) || 0;
    if (taxType === 'none') return 'No tax will be applied to orders';
    if (taxType === 'percentage') return `A $${val}% tax will be added to every order subtotal`;
    if (taxType === 'fixed') return `A fixed $${val.toFixed(2)} tax will be added to every order`;
    return '';
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <Loader size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
      >
        {/* Header Card */}
        <View style={styles.heroCard}>
          <View style={styles.heroIconWrap}>
            <Ionicons name="calculator" size={32} color={colors.white} />
          </View>
          <Text style={styles.heroTitle}>Tax Configuration</Text>
          <Text style={styles.heroSubtitle}>Set a global tax rule applied to all orders at checkout</Text>
        </View>

        {/* Info Banner */}
        <View style={styles.infoBanner}>
          <Ionicons name="information-circle-outline" size={18} color={colors.info} />
          <Text style={styles.infoText}>
            This is a global tax rule. It applies uniformly to all orders across all sellers.
          </Text>
        </View>

        {/* Tax Type Selection */}
        <Text style={styles.sectionLabel}>TAX TYPE</Text>
        <View style={styles.card}>
          {TAX_TYPES.map((type, idx) => (
            <TouchableOpacity
              key={type.key}
              style={[
                styles.typeRow,
                idx < TAX_TYPES.length - 1 && styles.typeRowBorder,
                taxType === type.key && styles.typeRowActive,
              ]}
              onPress={() => { setTaxType(type.key); setValueError(''); }}
              activeOpacity={0.7}
            >
              <View style={[styles.typeIconWrap, { backgroundColor: taxType === type.key ? type.color + '20' : colors.light }]}>
                <Ionicons name={type.icon} size={22} color={taxType === type.key ? type.color : colors.gray} />
              </View>
              <View style={styles.typeInfo}>
                <Text style={[styles.typeLabel, taxType === type.key && { color: type.color }]}>{type.label}</Text>
                <Text style={styles.typeDesc}>{type.desc}</Text>
              </View>
              <View style={[styles.radioOuter, taxType === type.key && { borderColor: type.color }]}>
                {taxType === type.key && <View style={[styles.radioInner, { backgroundColor: type.color }]} />}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Value Input (hidden for 'none') */}
        {taxType !== 'none' && (
          <>
            <Text style={styles.sectionLabel}>{taxType === 'percentage' ? 'TAX RATE (%)' : 'FIXED AMOUNT ($)'}</Text>
            <View style={styles.card}>
              <View style={styles.valueInputRow}>
                <View style={styles.prefixBadge}>
                  <Text style={styles.prefixText}>{taxType === 'percentage' ? '%' : '$'}</Text>
                </View>
                <TextInput
                  style={[styles.valueInput, valueError ? styles.valueInputError : null]}
                  value={taxValue}
                  onChangeText={(t) => { setTaxValue(t.replace(/[^0-9.]/g, '')); setValueError(''); }}
                  keyboardType="decimal-pad"
                  placeholder={taxType === 'percentage' ? 'e.g. 10' : 'e.g. 5.00'}
                  placeholderTextColor={colors.grayLight}
                />
              </View>
              {valueError ? <Text style={styles.errorText}>{valueError}</Text> : null}
            </View>
          </>
        )}

        {/* Live Preview */}
        <View style={styles.previewCard}>
          <Ionicons name="eye-outline" size={18} color={colors.secondary} />
          <Text style={styles.previewText}>{getPreviewText()}</Text>
        </View>

        {/* Save Button */}
        <TouchableOpacity
          style={[styles.saveButton, saving && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={saving}
          activeOpacity={0.85}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <>
              <Ionicons name="checkmark-circle-outline" size={20} color={colors.white} />
              <Text style={styles.saveButtonText}>Save Tax Configuration</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },

  // Hero Card
  heroCard: {
    backgroundColor: colors.primaryDark,
    borderRadius: borderRadius.xxl,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.lg,
    ...shadows.md,
  },
  heroIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
    marginBottom: spacing.xs,
  },
  heroSubtitle: {
    ...typography.bodySmall,
    color: 'rgba(255,255,255,0.75)',
    textAlign: 'center',
    lineHeight: 20,
  },

  // Info Banner
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.infoSubtle,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.info,
    gap: spacing.sm,
  },
  infoText: {
    ...typography.bodySmall,
    color: colors.infoDark,
    flex: 1,
    lineHeight: 20,
  },

  // Section Labels
  sectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    color: colors.textSecondary,
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },

  // Card
  card: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    marginBottom: spacing.lg,
    ...shadows.sm,
    overflow: 'hidden',
  },

  // Type Selection
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.md,
  },
  typeRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  typeRowActive: {
    backgroundColor: colors.lighter,
  },
  typeIconWrap: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  typeInfo: {
    flex: 1,
  },
  typeLabel: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: 2,
  },
  typeDesc: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.grayLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },

  // Value Input
  valueInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  prefixBadge: {
    width: 50,
    height: 56,
    backgroundColor: colors.primarySubtle,
    justifyContent: 'center',
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: colors.light,
  },
  prefixText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  valueInput: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  valueInputError: {
    backgroundColor: colors.errorSubtle,
  },
  errorText: {
    ...typography.bodySmall,
    color: colors.error,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },

  // Preview
  previewCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.secondarySubtle,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.secondary,
  },
  previewText: {
    ...typography.bodySmall,
    color: colors.secondaryDark,
    flex: 1,
    lineHeight: 20,
  },

  // Save Button
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.lg,
    ...shadows.md,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
});
