/**
 * SellerStoreSettingsScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Alert, RefreshControl, Modal, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api, { API_ENDPOINTS } from '../../config/api';
import Loader from '../../components/common/Loader';
import VerifiedBadge from '../../components/VerifiedBadge';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import LocationAutocomplete from '../../components/common/LocationAutocomplete';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const VISIBILITY_MODES = [
  { mode: 'global', label: 'Global', icon: 'earth-outline', desc: 'Visible to all buyers' },
  { mode: 'country', label: 'Country', icon: 'flag-outline', desc: 'Visible in one country' },
  { mode: 'region', label: 'State', icon: 'map-outline', desc: 'Visible in one state or province' },
  { mode: 'city', label: 'City', icon: 'business-outline', desc: 'Visible in one city' },
  { mode: 'town', label: 'Town', icon: 'location-outline', desc: 'Visible in a town or area' },
];

const THEME_PREVIEWS = [
  ['Rozare professional store', '#3b82f6', '#8b5cf6', '#10b981'],
  ['Pearl Boutique', '#d86f91', '#f1a37c', '#69b7a8'],
  ['Sage Studio', '#5f9f83', '#8abfbc', '#d9a441'],
  ['Skyline Market', '#4f8fd8', '#7fb8e8', '#6fcfbd'],
  ['Lilac Gallery', '#9b7ad7', '#d19ad8', '#75c5b8'],
  ['Sunlit Minimal', '#d9a441', '#76b7a5', '#6f93d6'],
  ['Coral Showroom', '#e77f75', '#efb069', '#6dbbd2'],
  ['Aqua Retail', '#45a9c9', '#5ec7ba', '#8e8bd8'],
  ['Orchid Luxe', '#a46ed1', '#dc8fc5', '#73b6d8'],
  ['Mint Catalog', '#5abf9f', '#84d4c2', '#7d9fe3'],
];

export default function SellerStoreSettingsScreen({ navigation }) {
  const { palette } = useTheme();
  const { currency, currencies } = useCurrency();
  const styles = buildStyles(palette);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [formData, setFormData] = useState({ storeName: '', description: '', sellerType: 'store' });
  const [logo, setLogo] = useState(null);
  const [banner, setBanner] = useState(null);
  const [errors, setErrors] = useState({});
  const [verification, setVerification] = useState(null);
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [verificationForm, setVerificationForm] = useState({ applicationMessage: '', contactEmail: '', contactPhone: '' });
  const [submittingVerification, setSubmittingVerification] = useState(false);
  const [productCurrencyInfo, setProductCurrencyInfo] = useState({ activeCurrency: currency || 'USD', status: 'active' });
  const [productCurrencyDraft, setProductCurrencyDraft] = useState(currency || 'USD');
  const [productCurrencySaving, setProductCurrencySaving] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibility, setVisibility] = useState({ mode: 'country', country: '', countryCode: '', region: '', regionCode: '', city: '', town: '' });

  useEffect(() => { fetchSettings(); fetchVerificationStatus(); fetchProductCurrency(); }, []);

  const fetchSettings = async () => {
    try {
      const response = await api.get('/api/stores/my-store');
      const storeData = response.data?.store || response.data;
      setStore(storeData);
      setFormData({ storeName: storeData?.name || storeData?.storeName || '', description: storeData?.description || '', sellerType: storeData?.sellerType || 'store' });
      setLogo(storeData?.logo || null);
      setBanner(storeData?.banner || null);
      setVisibility(storeData?.visibility || { mode: 'country', country: storeData?.address?.country || '', countryCode: storeData?.address?.countryCode || '', region: storeData?.address?.state || '', regionCode: storeData?.address?.stateCode || '', city: storeData?.address?.city || '', town: '' });
    } catch (error) { console.error('Error fetching settings:', error); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const fetchProductCurrency = async () => {
    try {
      const res = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY);
      const info = res.data?.productCurrency || {};
      setProductCurrencyInfo(info);
      setProductCurrencyDraft(info.pendingCurrency || info.activeCurrency || currency || 'USD');
    } catch (_) {
      setProductCurrencyDraft(currency || 'USD');
    }
  };

  const fetchVerificationStatus = async () => {
    try { const response = await api.get('/api/stores/verification/status'); setVerification(response.data); }
    catch (error) { console.log('Verification status unavailable'); }
  };

  const submitVerificationApplication = async () => {
    const { applicationMessage, contactEmail, contactPhone } = verificationForm;
    if (!applicationMessage.trim() || !contactEmail.trim() || !contactPhone.trim()) {
      Alert.alert('Missing Fields', 'Please fill in all fields before submitting.'); return;
    }
    setSubmittingVerification(true);
    try {
      await api.post('/api/stores/verification/apply', { applicationMessage: applicationMessage.trim(), contactEmail: contactEmail.trim(), contactPhone: contactPhone.trim() });
      setShowVerificationModal(false);
      setVerificationForm({ applicationMessage: '', contactEmail: '', contactPhone: '' });
      await fetchVerificationStatus();
      Alert.alert('Application Submitted', 'Your verification request has been submitted.');
    } catch (error) {
      Alert.alert('Submission Failed', error.response?.data?.msg || 'Failed to submit verification request.');
    } finally { setSubmittingVerification(false); }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([fetchSettings(), fetchVerificationStatus(), fetchProductCurrency()]).finally(() => setRefreshing(false));
  }, []);

  const updateField = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }));
  }, [errors]);

  const pickImage = useCallback(async (type) => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true,
        aspect: type === 'logo' ? [1, 1] : [16, 9], quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        if (type === 'logo') setLogo(result.assets[0].uri);
        else setBanner(result.assets[0].uri);
      }
    } catch (error) { Alert.alert('Error', 'Failed to pick image'); }
  }, []);

  const saveSettings = async () => {
    if (!formData.storeName.trim()) { setErrors({ storeName: 'Store name is required' }); return; }
    setSaving(true);
    try {
      await api.put('/api/stores/update', { storeName: formData.storeName.trim(), description: formData.description.trim(), sellerType: formData.sellerType || 'store', logo, banner });
      Alert.alert('Success', 'Store settings saved successfully');
    } catch (error) { Alert.alert('Error', error.response?.data?.message || 'Failed to save settings'); }
    finally { setSaving(false); }
  };

  const updateProductCurrency = async (nextCurrency, confirm = false) => {
    if (!nextCurrency || nextCurrency === productCurrencyDraft && !confirm) return;
    setProductCurrencyDraft(nextCurrency);
    setProductCurrencySaving(true);
    try {
      const res = await api.patch(API_ENDPOINTS.STORES.PRODUCT_CURRENCY, { currency: nextCurrency, confirm });
      const info = res.data?.productCurrency || {};
      setProductCurrencyInfo(info);
      setProductCurrencyDraft(info.pendingCurrency || info.activeCurrency || nextCurrency);
      Alert.alert('Product currency', res.data?.msg || 'Product currency updated');
    } catch (error) {
      if (error.response?.status === 409 && error.response?.data?.requiresConfirmation) {
        Alert.alert(
          'Confirm currency change',
          error.response?.data?.msg || `Change product currency to ${nextCurrency}? Existing products may need conversion.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => setProductCurrencyDraft(productCurrencyInfo.pendingCurrency || productCurrencyInfo.activeCurrency || currency || 'USD') },
            { text: `Change to ${nextCurrency}`, style: 'destructive', onPress: () => updateProductCurrency(nextCurrency, true) },
          ]
        );
      } else {
        Alert.alert('Product currency', error.response?.data?.msg || 'Failed to update product currency');
        setProductCurrencyDraft(productCurrencyInfo.pendingCurrency || productCurrencyInfo.activeCurrency || currency || 'USD');
      }
    } finally {
      setProductCurrencySaving(false);
    }
  };

  const convertProductCurrency = async () => {
    setProductCurrencySaving(true);
    try {
      const res = await api.post(API_ENDPOINTS.STORES.PRODUCT_CURRENCY_CONVERT, {});
      setProductCurrencyInfo(res.data?.productCurrency || {});
      setProductCurrencyDraft(res.data?.productCurrency?.activeCurrency || productCurrencyDraft);
      Alert.alert('Product currency', res.data?.msg || 'Product prices converted');
    } catch (error) {
      Alert.alert('Product currency', error.response?.data?.msg || 'Failed to convert product prices');
    } finally {
      setProductCurrencySaving(false);
    }
  };

  const cancelProductCurrencyChange = async () => {
    setProductCurrencySaving(true);
    try {
      const res = await api.post(API_ENDPOINTS.STORES.PRODUCT_CURRENCY_CANCEL, {});
      setProductCurrencyInfo(res.data?.productCurrency || {});
      setProductCurrencyDraft(res.data?.productCurrency?.activeCurrency || currency || 'USD');
      Alert.alert('Product currency', res.data?.msg || 'Product currency change canceled');
    } catch (error) {
      Alert.alert('Product currency', error.response?.data?.msg || 'Failed to cancel currency change');
    } finally {
      setProductCurrencySaving(false);
    }
  };

  const updateVisibilityField = (field, value) => setVisibility((previous) => ({ ...previous, [field]: value }));

  const saveVisibility = async () => {
    if (visibility.mode !== 'global' && !String(visibility.country || '').trim()) {
      Alert.alert('Visibility', 'Country is required for this visibility mode.');
      return;
    }
    if ((visibility.mode === 'city' || visibility.mode === 'town') && !String(visibility.city || '').trim()) {
      Alert.alert('Visibility', 'City is required for this visibility mode.');
      return;
    }
    setVisibilitySaving(true);
    try {
      const res = await api.put(API_ENDPOINTS.STORES.UPDATE, { visibility });
      setVisibility(res.data?.store?.visibility || visibility);
      Alert.alert('Visibility', 'Store visibility updated');
    } catch (error) {
      Alert.alert('Visibility', error.response?.data?.msg || 'Failed to update store visibility');
    } finally {
      setVisibilitySaving(false);
    }
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading settings..." /></GlassBackground>;

  const isVerified = store?.verification?.isVerified;
  const verificationStatus = verification?.status || (isVerified ? 'verified' : 'none');
  const canApplyForVerification = verificationStatus === 'none' || verificationStatus === 'rejected';

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        
        <GlassPanel variant="floating" style={styles.header}>
          <View style={styles.headerIcon}><Ionicons name="settings-outline" size={28} color={palette.colors.primary} /></View>
          <Text style={styles.headerTitle}>Store Settings</Text>
          <Text style={styles.headerSubtitle}>Manage your store information</Text>
        </GlassPanel>

        {/* Verification Status */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Verification</Text>
          <View style={[styles.verificationCard, {
            borderLeftColor: verificationStatus === 'verified' ? palette.colors.success : verificationStatus === 'pending' ? palette.colors.warning : palette.colors.textSecondary,
          }]}>
            <Ionicons name={verificationStatus === 'verified' ? 'shield-checkmark' : verificationStatus === 'pending' ? 'time-outline' : 'shield-outline'} size={32}
              color={verificationStatus === 'verified' ? palette.colors.success : verificationStatus === 'pending' ? palette.colors.warning : palette.colors.textSecondary} />
            <View style={{ flex: 1, marginLeft: spacing.md }}>
              <Text style={styles.verificationTitle}>
                {verificationStatus === 'verified' ? 'Verified Store' : verificationStatus === 'pending' ? 'Pending Review' : 'Not Verified'}
              </Text>
              <Text style={styles.verificationText}>
                {verificationStatus === 'verified' ? 'Your store is verified' : verificationStatus === 'pending' ? 'Your application is being reviewed' : 'Get your store verified'}
              </Text>
            </View>
            {isVerified && <VerifiedBadge size="md" />}
          </View>
          {canApplyForVerification && (
            <TouchableOpacity style={styles.applyBtn} onPress={() => setShowVerificationModal(true)} activeOpacity={0.8}>
              <Ionicons name="shield-checkmark-outline" size={18} color="white" />
              <Text style={styles.applyBtnText}>{verificationStatus === 'rejected' ? 'Reapply' : 'Apply for Verification'}</Text>
            </TouchableOpacity>
          )}
        </GlassPanel>

        {/* Images */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Images</Text>
          <Text style={styles.label}>Store Banner</Text>
          <TouchableOpacity style={styles.bannerPicker} onPress={() => pickImage('banner')} activeOpacity={0.8}>
            {banner ? (
              <Image source={{ uri: banner }} style={styles.bannerImage} contentFit="cover" />
            ) : (
              <View style={styles.bannerPlaceholder}>
                <Ionicons name="image-outline" size={32} color={palette.colors.textSecondary} />
                <Text style={styles.pickerText}>Tap to add banner</Text>
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.label}>Store Logo</Text>
          <TouchableOpacity style={styles.logoPicker} onPress={() => pickImage('logo')} activeOpacity={0.8}>
            {logo ? (
              <Image source={{ uri: logo }} style={styles.logoImage} contentFit="cover" />
            ) : (
              <View style={styles.logoPlaceholder}><Ionicons name="storefront-outline" size={32} color={palette.colors.textSecondary} /></View>
            )}
          </TouchableOpacity>
        </GlassPanel>

        {/* Store Details */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Details</Text>
          <Text style={styles.label}>Store Name <Text style={{ color: palette.colors.error }}>*</Text></Text>
          <TextInput style={[styles.input, errors.storeName && styles.inputError]} value={formData.storeName}
            onChangeText={(v) => updateField('storeName', v)} placeholder="Enter store name" placeholderTextColor={palette.colors.textSecondary} />
          {errors.storeName && <Text style={styles.errorText}>{errors.storeName}</Text>}
          
          <Text style={[styles.label, { marginTop: spacing.lg }]}>Description</Text>
          <TextInput style={[styles.input, styles.textArea]} value={formData.description}
            onChangeText={(v) => updateField('description', v)} placeholder="Describe your store..." placeholderTextColor={palette.colors.textSecondary}
            multiline numberOfLines={4} textAlignVertical="top" />

          <Text style={[styles.label, { marginTop: spacing.lg }]}>Listing Type</Text>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {['store', 'brand'].map(t => {
              const active = formData.sellerType === t;
              return (
                <TouchableOpacity
                  key={t}
                  onPress={() => updateField('sellerType', t)}
                  activeOpacity={0.8}
                  style={{
                    flex: 1,
                    paddingVertical: spacing.md,
                    borderRadius: borderRadius.lg,
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: 6,
                    backgroundColor: active ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.06)',
                    borderWidth: 1,
                    borderColor: active ? palette.colors.primary : 'rgba(255,255,255,0.15)',
                  }}
                >
                  <Ionicons name={t === 'brand' ? 'pricetag-outline' : 'storefront-outline'} size={16} color={active ? palette.colors.primary : palette.colors.textSecondary} />
                  <Text style={{ color: active ? palette.colors.primary : palette.colors.textSecondary, fontWeight: '600' }}>
                    {t === 'brand' ? 'Brand' : 'Store'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </GlassPanel>

        {/* Product Currency */}
        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.cardHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Product Price Currency</Text>
              <Text style={styles.helperText}>New product prices are saved in this currency.</Text>
            </View>
            <View style={styles.currencyStatusPill}>
              <Text style={styles.currencyStatusText}>
                {productCurrencyInfo.status === 'pending_conversion'
                  ? `${productCurrencyInfo.previousCurrency || productCurrencyInfo.activeCurrency} to ${productCurrencyInfo.pendingCurrency}`
                  : productCurrencyInfo.activeCurrency || productCurrencyDraft}
              </Text>
            </View>
          </View>
          <View style={styles.currencyGrid}>
            {Object.entries(currencies || {}).map(([code, info]) => {
              const active = productCurrencyDraft === code;
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.currencyChip, active && styles.currencyChipActive]}
                  onPress={() => updateProductCurrency(code)}
                  disabled={productCurrencySaving}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.currencyChipText, active && styles.currencyChipTextActive]}>{code}</Text>
                  <Text style={[styles.currencyChipName, active && styles.currencyChipTextActive]} numberOfLines={1}>{info.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {productCurrencyInfo.status === 'pending_conversion' && (
            <View style={styles.warningPanel}>
              <Ionicons name="alert-circle-outline" size={18} color={palette.colors.warning} />
              <View style={{ flex: 1 }}>
                <Text style={styles.warningTitle}>Conversion required</Text>
                <Text style={styles.warningText}>
                  Existing products are still in {productCurrencyInfo.previousCurrency || productCurrencyInfo.activeCurrency}. Convert all product prices to {productCurrencyInfo.pendingCurrency}, or cancel and keep the previous currency.
                </Text>
                <View style={styles.warningActions}>
                  <TouchableOpacity style={styles.warningSecondaryBtn} onPress={cancelProductCurrencyChange} disabled={productCurrencySaving}>
                    <Text style={styles.warningSecondaryText}>Keep {productCurrencyInfo.previousCurrency || productCurrencyInfo.activeCurrency}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.warningPrimaryBtn} onPress={convertProductCurrency} disabled={productCurrencySaving}>
                    {productCurrencySaving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.warningPrimaryText}>Convert to {productCurrencyInfo.pendingCurrency}</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </GlassPanel>

        {/* Visibility */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Visibility</Text>
          <Text style={styles.helperText}>Control which buyers can discover your store and products. GPS radius targeting is commented out for now.</Text>
          <View style={styles.visibilityModes}>
            {VISIBILITY_MODES.map((item) => {
              const active = visibility.mode === item.mode;
              return (
                <TouchableOpacity
                  key={item.mode}
                  style={[styles.visibilityModeCard, active && styles.visibilityModeActive]}
                  onPress={() => updateVisibilityField('mode', item.mode)}
                  activeOpacity={0.8}
                >
                  <Ionicons name={item.icon} size={18} color={active ? palette.colors.primary : palette.colors.textSecondary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.visibilityModeLabel, active && { color: palette.colors.primary }]}>{item.label}</Text>
                    <Text style={styles.visibilityModeDesc}>{item.desc}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {visibility.mode !== 'global' && (
            <View style={styles.visibilityFields}>
              <LocationAutocomplete
                type="country"
                label="Country"
                required
                value={visibility.country}
                code={visibility.countryCode}
                placeholder="Select country"
                onSelect={(option) => setVisibility(prev => ({
                  ...prev,
                  country: option.name,
                  countryCode: option.isoCode,
                  region: '',
                  regionCode: '',
                  city: '',
                  town: '',
                }))}
                onClear={() => setVisibility(prev => ({ ...prev, country: '', countryCode: '', region: '', regionCode: '', city: '', town: '' }))}
              />
              {(visibility.mode === 'region' || visibility.mode === 'city' || visibility.mode === 'town') && (
                <LocationAutocomplete
                  type="state"
                  label="State / Province"
                  value={visibility.region}
                  code={visibility.regionCode}
                  countryCode={visibility.countryCode}
                  countryName={visibility.country}
                  placeholder="Select state"
                  disabled={!visibility.countryCode && !visibility.country}
                  onSelect={(option) => setVisibility(prev => ({
                    ...prev,
                    region: option.name,
                    regionCode: option.isoCode,
                    city: '',
                    town: '',
                  }))}
                  onClear={() => setVisibility(prev => ({ ...prev, region: '', regionCode: '', city: '', town: '' }))}
                />
              )}
              {(visibility.mode === 'city' || visibility.mode === 'town') && (
                <LocationAutocomplete
                  type="city"
                  label="City"
                  required
                  value={visibility.city}
                  countryCode={visibility.countryCode}
                  countryName={visibility.country}
                  stateCode={visibility.regionCode}
                  stateName={visibility.region}
                  placeholder="Select city"
                  disabled={!visibility.countryCode && !visibility.country}
                  onSelect={(option) => setVisibility(prev => ({
                    ...prev,
                    city: option.name,
                    region: prev.region || option.stateName || '',
                    regionCode: prev.regionCode || option.stateCode || '',
                    town: '',
                  }))}
                  onClear={() => setVisibility(prev => ({ ...prev, city: '', town: '' }))}
                />
              )}
              {visibility.mode === 'town' && (
                <>
                  <Text style={[styles.label, { marginTop: spacing.md }]}>Town / Area</Text>
                  <TextInput style={styles.input} value={visibility.town} onChangeText={(value) => updateVisibilityField('town', value)} placeholder="Gulberg" placeholderTextColor={palette.colors.textSecondary} />
                </>
              )}
            </View>
          )}
          <TouchableOpacity style={[styles.applyBtn, visibilitySaving && { opacity: 0.6 }]} onPress={saveVisibility} disabled={visibilitySaving} activeOpacity={0.8}>
            {visibilitySaving ? <ActivityIndicator color="white" /> : <Ionicons name="save-outline" size={18} color="white" />}
            <Text style={styles.applyBtnText}>Save Visibility</Text>
          </TouchableOpacity>
        </GlassPanel>

        {/* Themes */}
        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.cardHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Store Themes</Text>
              <Text style={styles.helperText}>Preview-only for now. Theme selection and custom themes are coming soon.</Text>
            </View>
            <View style={styles.comingSoonPill}><Text style={styles.comingSoonText}>Coming soon</Text></View>
          </View>
          <View style={styles.themeGrid}>
            {THEME_PREVIEWS.map(([name, primary, secondary, accent]) => (
              <View key={name} style={styles.themeCard}>
                <View style={[styles.themePreview, { backgroundColor: primary }]}>
                  <View style={[styles.themeDot, { backgroundColor: secondary }]} />
                  <View style={[styles.themeMiniCard, { borderColor: accent }]} />
                </View>
                <Text style={styles.themeName} numberOfLines={1}>{name}</Text>
                <View style={styles.swatchRow}>
                  {[primary, secondary, accent].map((color) => <View key={color} style={[styles.swatch, { backgroundColor: color }]} />)}
                </View>
              </View>
            ))}
          </View>
        </GlassPanel>

        <View style={styles.submitContainer}>
          <TouchableOpacity style={[styles.submitButton, saving && { opacity: 0.6 }]} onPress={saveSettings} disabled={saving} activeOpacity={0.8}>
            {saving ? <ActivityIndicator color="white" /> : (
              <><Ionicons name="checkmark-circle" size={22} color="white" /><Text style={styles.submitButtonText}>Save Settings</Text></>
            )}
          </TouchableOpacity>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Verification Modal */}
      <Modal visible={showVerificationModal} animationType="slide" transparent onRequestClose={() => setShowVerificationModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <GlassPanel variant="strong" style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Apply for Verification</Text>
              <TouchableOpacity onPress={() => setShowVerificationModal(false)}><Ionicons name="close" size={24} color={palette.colors.text} /></TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Contact Email <Text style={{ color: palette.colors.error }}>*</Text></Text>
              <TextInput style={styles.input} value={verificationForm.contactEmail}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactEmail: v }))} placeholder="your@email.com" placeholderTextColor={palette.colors.textSecondary} keyboardType="email-address" autoCapitalize="none" />
              <Text style={[styles.label, { marginTop: spacing.md }]}>Contact Phone <Text style={{ color: palette.colors.error }}>*</Text></Text>
              <TextInput style={styles.input} value={verificationForm.contactPhone}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactPhone: v }))} placeholder="+1 234 567 8900" placeholderTextColor={palette.colors.textSecondary} keyboardType="phone-pad" />
              <Text style={[styles.label, { marginTop: spacing.md }]}>Message <Text style={{ color: palette.colors.error }}>*</Text></Text>
              <TextInput style={[styles.input, styles.textArea]} value={verificationForm.applicationMessage}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, applicationMessage: v }))} placeholder="Why should your store be verified?" placeholderTextColor={palette.colors.textSecondary} multiline numberOfLines={5} textAlignVertical="top" />
              <TouchableOpacity style={[styles.submitButton, submittingVerification && { opacity: 0.6 }, { marginTop: spacing.lg }]} onPress={submitVerificationApplication} disabled={submittingVerification} activeOpacity={0.8}>
                {submittingVerification ? <ActivityIndicator color="white" /> : (
                  <><Ionicons name="shield-checkmark-outline" size={20} color="white" /><Text style={styles.submitButtonText}>Submit Application</Text></>
                )}
              </TouchableOpacity>
            </ScrollView>
          </GlassPanel>
        </KeyboardAvoidingView>
      </Modal>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  header: { alignItems: 'center', margin: spacing.lg, padding: spacing.xl },
  headerIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  headerTitle: { ...typography.h2, color: p.colors.text, marginBottom: spacing.xs },
  headerSubtitle: { ...typography.body, color: p.colors.textSecondary },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: p.colors.text, marginBottom: spacing.md },
  helperText: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: -spacing.xs, marginBottom: spacing.md, lineHeight: 19 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.sm },
  currencyStatusPill: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full, backgroundColor: `${p.colors.primary}16`, borderWidth: 1, borderColor: `${p.colors.primary}28` },
  currencyStatusText: { ...typography.caption, color: p.colors.primary, fontWeight: fontWeight.bold },
  currencyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  currencyChip: { width: '48%', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  currencyChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  currencyChipText: { ...typography.bodySemibold, color: p.colors.text },
  currencyChipName: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  currencyChipTextActive: { color: 'white' },
  warningPanel: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.warning}12`, borderWidth: 1, borderColor: `${p.colors.warning}28` },
  warningTitle: { ...typography.bodySemibold, color: p.colors.warning },
  warningText: { ...typography.caption, color: p.colors.textSecondary, lineHeight: 17, marginTop: 2 },
  warningActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  warningSecondaryBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.borderSubtle },
  warningSecondaryText: { ...typography.caption, color: p.colors.text, fontWeight: fontWeight.semibold },
  warningPrimaryBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, minHeight: 36, justifyContent: 'center' },
  warningPrimaryText: { ...typography.caption, color: 'white', fontWeight: fontWeight.bold },
  visibilityModes: { gap: spacing.sm },
  visibilityModeCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  visibilityModeActive: { borderColor: p.colors.primary, backgroundColor: `${p.colors.primary}12` },
  visibilityModeLabel: { ...typography.bodySemibold, color: p.colors.text },
  visibilityModeDesc: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  visibilityFields: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  comingSoonPill: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full, backgroundColor: `${p.colors.warning}14`, borderWidth: 1, borderColor: `${p.colors.warning}28` },
  comingSoonText: { ...typography.caption, color: p.colors.warning, fontWeight: fontWeight.bold },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  themeCard: { width: '48%', borderRadius: borderRadius.lg, padding: spacing.sm, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  themePreview: { height: 70, borderRadius: borderRadius.md, overflow: 'hidden', marginBottom: spacing.sm },
  themeDot: { width: 32, height: 12, borderRadius: 6, margin: spacing.sm },
  themeMiniCard: { position: 'absolute', right: spacing.sm, bottom: spacing.sm, width: 44, height: 28, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.72)', borderWidth: 2 },
  themeName: { ...typography.caption, color: p.colors.text, fontWeight: fontWeight.bold },
  swatchRow: { flexDirection: 'row', gap: 4, marginTop: spacing.xs },
  swatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  verificationCard: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.08)', borderLeftWidth: 3 },
  verificationTitle: { ...typography.bodySemibold, color: p.colors.text },
  verificationText: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: 2 },
  applyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.md, marginTop: spacing.md },
  applyBtnText: { ...typography.bodySemibold, color: 'white' },
  label: { ...typography.bodySemibold, color: p.colors.text, marginBottom: spacing.sm },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  inputError: { borderColor: p.colors.error },
  textArea: { minHeight: 100 },
  errorText: { ...typography.caption, color: p.colors.error, marginTop: spacing.xs },
  bannerPicker: { borderRadius: borderRadius.xl, overflow: 'hidden', marginBottom: spacing.lg },
  bannerImage: { width: '100%', height: 160, borderRadius: borderRadius.xl },
  bannerPlaceholder: { width: '100%', height: 160, borderRadius: borderRadius.xl, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderStyle: 'dashed' },
  pickerText: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: spacing.sm },
  logoPicker: { alignSelf: 'flex-start' },
  logoImage: { width: 80, height: 80, borderRadius: 40 },
  logoPlaceholder: { width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderStyle: 'dashed' },
  submitContainer: { paddingHorizontal: spacing.lg, marginTop: spacing.md },
  submitButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.lg },
  submitButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: 'white' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { maxHeight: '85%', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  modalTitle: { ...typography.h3, color: p.colors.text },
});
