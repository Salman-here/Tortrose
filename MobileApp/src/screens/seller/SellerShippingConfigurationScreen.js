/**
 * SellerShippingConfigurationScreen - website-parity fixed shipping methods.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Alert, RefreshControl, ActivityIndicator, Switch, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import { SellerInlineError, SellerScreenHeader, SellerScreenSkeleton } from '../../components/seller/SellerUI';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useAuth } from '../../contexts/AuthContext';

const DEFAULT_METHODS = (currency) => [
  { type: 'free', cost: 0, currency, costCurrency: currency, costInputAmount: 0, deliveryDays: 5, isActive: true },
  { type: 'standard', cost: 5.99, currency, costCurrency: currency, costInputAmount: 5.99, deliveryDays: 5, isActive: false },
  { type: 'fast', cost: 12.99, currency, costCurrency: currency, costInputAmount: 12.99, deliveryDays: 2, isActive: false },
];

const METHOD_COPY = {
  free: { title: 'Free Shipping', desc: 'No cost shipping option for customers', icon: 'gift-outline' },
  standard: { title: 'Standard Shipping', desc: 'Regular delivery with standard rates', icon: 'car-outline' },
  fast: { title: 'Fast Shipping', desc: 'Express delivery for urgent orders', icon: 'flash-outline' },
};

export default function SellerShippingConfigurationScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currentUser } = useAuth();
  const { currency, convertAmount, formatPrice, getCurrencySymbol } = useCurrency();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [methods, setMethods] = useState(DEFAULT_METHODS(currency));
  const [loadError, setLoadError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);

  const normalizeForDisplay = useCallback((method) => {
    const methodCurrency = method?.currency || method?.costCurrency || currency;
    const cost = method?.type === 'free' ? 0 : convertAmount(method?.cost || 0, methodCurrency, currency);
    return {
      ...method,
      cost: method?.type === 'free' ? '0' : String(Math.round(cost * 100) / 100),
      currency,
      costCurrency: currency,
      costInputAmount: cost,
      deliveryDays: String(Number(method?.deliveryDays || 1)),
      isActive: method?.isActive !== false,
    };
  }, [currency, convertAmount]);

  const mergeWithDefaults = useCallback((remoteMethods = []) => {
    const byType = new Map(remoteMethods.map(method => [method.type, method]));
    return DEFAULT_METHODS(currency).map(defaultMethod => normalizeForDisplay(byType.get(defaultMethod.type) || defaultMethod));
  }, [currency, normalizeForDisplay]);

  const fetchConfig = useCallback(async () => {
    try {
      const sellerId = currentUser?._id || currentUser?.id;
      if (!sellerId) {
        setLoadError('Your seller session could not be identified. Please sign in again.');
        return;
      }
      const res = await api.get(`${API_ENDPOINTS.SHIPPING.SELLER}/${sellerId}`);
      const remoteMethods = res.data?.shippingMethods?.methods || [];
      setMethods(mergeWithDefaults(remoteMethods));
      setLoadError('');
      setHasLoaded(true);
    } catch (e) {
      setLoadError(e.response?.data?.msg || 'Shipping methods could not be loaded. Saving is disabled until live settings are available.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentUser?._id, currentUser?.id, mergeWithDefaults]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchConfig();
  }, [fetchConfig]);

  const updateMethod = (type, field, value) => {
    setMethods(prev => prev.map(method => {
      if (method.type !== type) return method;
      if (type === 'free' && field === 'cost') return method;
      if (field === 'cost') {
        const cleaned = String(value).replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
        return { ...method, cost: cleaned, currency, costCurrency: currency };
      }
      if (field === 'deliveryDays') {
        return { ...method, deliveryDays: String(value).replace(/[^0-9]/g, '') };
      }
      return { ...method, [field]: value };
    }));
  };

  const validate = () => {
    if (!methods.some(method => method.isActive)) {
      Alert.alert('Validation', 'At least one shipping method must be active.');
      return false;
    }
    for (const method of methods) {
      if (!method.isActive) continue;
      if (method.type === 'free' && Number(method.cost) !== 0) {
        Alert.alert('Validation', 'Free shipping must have 0 cost.');
        return false;
      }
      if (method.type !== 'free' && Number(method.cost) <= 0) {
        Alert.alert('Validation', 'Paid shipping methods must have cost greater than 0.');
        return false;
      }
      if (Number(method.deliveryDays) < 1) {
        Alert.alert('Validation', 'Delivery days must be at least 1.');
        return false;
      }
    }
    return true;
  };

  const saveMethods = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = methods.map(method => ({
        ...method,
        cost: method.type === 'free' ? 0 : Number(method.cost || 0),
        currency,
        costCurrency: currency,
        costInputAmount: method.type === 'free' ? 0 : Number(method.cost || 0),
        deliveryDays: Number(method.deliveryDays || 1),
      }));
      const res = await api.put(API_ENDPOINTS.SHIPPING.METHODS, { methods: payload, currency });
      if (res.data?.shippingMethods?.methods) {
        setMethods(mergeWithDefaults(res.data.shippingMethods.methods));
      }
      Alert.alert('Saved', 'Shipping methods updated successfully.');
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to save shipping methods');
    } finally {
      setSaving(false);
    }
  };

  const methodColor = (type) => ({
    free: palette.colors.success,
    standard: palette.colors.primary,
    fast: palette.colors.warning,
  }[type] || palette.colors.primary);

  if (loading) return <SellerScreenSkeleton navigation={navigation} title="Shipping Methods" subtitle="Loading your live delivery settings" icon="car-outline" variant="form" />;

  if (loadError && !hasLoaded) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
          <SellerScreenHeader navigation={navigation} title="Shipping Methods" subtitle="Delivery choices and rates" icon="car-outline" />
          <SellerInlineError title="Shipping settings unavailable" message={loadError} onRetry={fetchConfig} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <SellerScreenHeader navigation={navigation} title="Shipping Methods" subtitle="Delivery choices and rates" icon="car-outline" rightIcon="refresh" rightLabel="Refresh" onRightPress={onRefresh} />
      <KeyboardAwareFormScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        bottomOffset={32}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        <View style={styles.content}>
          {!!loadError && <SellerInlineError compact title="Refresh incomplete" message={loadError} onRetry={fetchConfig} />}
          {methods.map((method) => {
            const copy = METHOD_COPY[method.type] || METHOD_COPY.standard;
            const color = methodColor(method.type);
            return (
              <GlassPanel key={method.type} variant="card" style={[styles.methodCard, method.isActive && { borderColor: `${color}70`, borderWidth: 1.5 }]}>
                <View style={styles.methodHeader}>
                  <View style={[styles.methodIcon, { backgroundColor: `${color}18` }]}>
                    <Ionicons name={copy.icon} size={24} color={color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.methodTitleRow}>
                      <Text style={styles.methodName}>{copy.title}</Text>
                      {method.type === 'free' && <Text style={styles.recommended}>Recommended</Text>}
                    </View>
                    <Text style={styles.methodDesc}>{copy.desc}</Text>
                  </View>
                  <Switch
                    value={method.isActive}
                    onValueChange={(value) => updateMethod(method.type, 'isActive', value)}
                    trackColor={{ false: palette.colors.grayLighter, true: `${color}70` }}
                    thumbColor={method.isActive ? color : palette.colors.grayLight}
                  />
                </View>

                <View style={styles.inputsRow}>
                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Cost ({getCurrencySymbol()})</Text>
                    <TextInput
                      style={[styles.input, (!method.isActive || method.type === 'free') && styles.inputDisabled]}
                      value={method.type === 'free' ? '0' : String(method.cost ?? '')}
                      onChangeText={(value) => updateMethod(method.type, 'cost', value)}
                      keyboardType="decimal-pad"
                      editable={method.isActive && method.type !== 'free'}
                      placeholder="0.00"
                      placeholderTextColor={palette.colors.textSecondary}
                    />
                  </View>
                  <View style={styles.inputGroup}>
                    <Text style={styles.label}>Delivery Days</Text>
                    <TextInput
                      style={[styles.input, !method.isActive && styles.inputDisabled]}
                      value={String(method.deliveryDays ?? '')}
                      onChangeText={(value) => updateMethod(method.type, 'deliveryDays', value)}
                      keyboardType="number-pad"
                      editable={method.isActive}
                      placeholder="5"
                      placeholderTextColor={palette.colors.textSecondary}
                    />
                  </View>
                </View>

                {method.isActive && (
                  <View style={styles.preview}>
                    <Ionicons name="eye-outline" size={14} color={palette.colors.textSecondary} />
                    <Text style={styles.previewText}>
                      Customers see {method.type === 'free' ? 'Free' : formatPrice(method.cost, { sourceCurrency: currency })} - {method.deliveryDays} {method.deliveryDays === 1 ? 'day' : 'days'}
                    </Text>
                  </View>
                )}
              </GlassPanel>
            );
          })}

          <GlassPanel variant="card" style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={18} color={palette.colors.info} />
            <Text style={styles.infoText}>Free shipping is active by default. If you enable paid methods, checkout will show the cheapest active method for each seller unless the buyer chooses another option on the website.</Text>
          </GlassPanel>

          <TouchableOpacity style={[styles.submitButton, saving && { opacity: 0.6 }]} onPress={saveMethods} disabled={saving} activeOpacity={0.8}>
            {saving ? <ActivityIndicator color="white" /> : (
              <>
                <Ionicons name="save-outline" size={20} color="white" />
                <Text style={styles.submitButtonText}>Save Shipping Methods</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        <View style={{ height: 100 }} />
      </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safe: { flex: 1 },
  scroll: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingTop: spacing.md, paddingBottom: 100 },
  content: { paddingHorizontal: spacing.lg },
  methodCard: { padding: spacing.lg, marginBottom: spacing.md, opacity: 1 },
  methodHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  methodIcon: { width: 48, height: 48, borderRadius: borderRadius.xl, justifyContent: 'center', alignItems: 'center' },
  methodTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  methodName: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.md },
  methodDesc: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: 2 },
  recommended: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.success, backgroundColor: `${p.colors.success}18`, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.full },
  inputsRow: { flexDirection: 'row', gap: spacing.md },
  inputGroup: { flex: 1 },
  label: { ...typography.caption, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginBottom: spacing.xs },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  inputDisabled: { opacity: 0.55 },
  preview: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.lg, padding: spacing.md, marginTop: spacing.md },
  previewText: { ...typography.bodySmall, color: p.colors.textSecondary, flex: 1 },
  infoBox: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.md },
  infoText: { ...typography.bodySmall, color: p.colors.textSecondary, flex: 1 },
  submitButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.lg, marginTop: spacing.sm },
  submitButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: 'white' },
});
