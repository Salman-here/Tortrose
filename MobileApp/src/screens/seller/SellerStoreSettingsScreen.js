/**
 * SellerStoreSettingsScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Alert, RefreshControl, Modal, Platform, ActivityIndicator, Switch, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api, { API_ENDPOINTS } from '../../config/api';
import VerifiedBadge from '../../components/VerifiedBadge';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import { SellerInlineError, SellerScreenHeader, SellerScreenSkeleton } from '../../components/seller/SellerUI';
import LocationAutocomplete from '../../components/common/LocationAutocomplete';
import PhoneNumberInput from '../../components/common/PhoneNumberInput';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { isValidPhoneNumber } from '../../utils/phoneNumber';

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

const isRemoteImage = (uri) => /^https?:\/\//i.test(String(uri || ''));
const imageMimeType = (uri) => {
  const clean = String(uri || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
};

const cooldownDaysRemaining = (changedAt, windowDays) => {
  if (!changedAt) return 0;
  const nextAllowedAt = new Date(changedAt).getTime() + windowDays * 86400000;
  if (!Number.isFinite(nextAllowedAt) || nextAllowedAt <= Date.now()) return 0;
  return Math.max(1, Math.ceil((nextAllowedAt - Date.now()) / 86400000));
};

export default function SellerStoreSettingsScreen({ navigation }) {
  const { palette } = useTheme();
  const { currency, currencies } = useCurrency();
  const styles = buildStyles(palette);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingStore, setDeletingStore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [formData, setFormData] = useState({
    storeName: '',
    description: '',
    sellerType: 'store',
    paymentPolicy: 'online_and_cod',
    address: { street: '', city: '', state: '', stateCode: '', country: '', countryCode: '', postalCode: '' },
    socialLinks: { website: '', facebook: '', instagram: '', twitter: '', youtube: '', tiktok: '' },
    returnPolicy: {
      returnsEnabled: false,
      returnDuration: 0,
      refundType: 'none',
      warrantyEnabled: false,
      warrantyDuration: 0,
      warrantyDescription: '',
      policyDescription: '',
    },
  });
  const [logo, setLogo] = useState(null);
  const [banner, setBanner] = useState(null);
  const [errors, setErrors] = useState({});
  const [verification, setVerification] = useState(null);
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [verificationForm, setVerificationForm] = useState({ applicationMessage: '', contactEmail: '', contactPhone: '' });
  const [submittingVerification, setSubmittingVerification] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const [productCurrencyInfo, setProductCurrencyInfo] = useState({ activeCurrency: currency || 'USD', status: 'active' });
  const [productCurrencyDraft, setProductCurrencyDraft] = useState(currency || 'USD');
  const [productCurrencySaving, setProductCurrencySaving] = useState(false);
  const [productCurrencyError, setProductCurrencyError] = useState('');
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibility, setVisibility] = useState({ mode: 'country', country: '', countryCode: '', region: '', regionCode: '', city: '', town: '' });
  const [loadError, setLoadError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => { fetchSettings(); fetchVerificationStatus(); fetchProductCurrency(); }, []);

  const fetchSettings = async () => {
    try {
      const response = await api.get('/api/stores/my-store');
      const storeData = response.data?.store || response.data;
      setStore(storeData);
      setFormData({
        storeName: storeData?.name || storeData?.storeName || '',
        description: storeData?.description || '',
        sellerType: storeData?.sellerType || 'store',
        paymentPolicy: storeData?.paymentPolicy || 'online_and_cod',
        address: {
          street: storeData?.address?.street || '',
          city: storeData?.address?.city || '',
          state: storeData?.address?.state || '',
          stateCode: storeData?.address?.stateCode || '',
          country: storeData?.address?.country || '',
          countryCode: storeData?.address?.countryCode || '',
          postalCode: storeData?.address?.postalCode || '',
        },
        socialLinks: {
          website: storeData?.socialLinks?.website || '',
          facebook: storeData?.socialLinks?.facebook || '',
          instagram: storeData?.socialLinks?.instagram || '',
          twitter: storeData?.socialLinks?.twitter || '',
          youtube: storeData?.socialLinks?.youtube || '',
          tiktok: storeData?.socialLinks?.tiktok || '',
        },
        returnPolicy: {
          returnsEnabled: storeData?.returnPolicy?.returnsEnabled === true,
          returnDuration: Number(storeData?.returnPolicy?.returnDuration || 0),
          refundType: storeData?.returnPolicy?.refundType || 'none',
          warrantyEnabled: storeData?.returnPolicy?.warrantyEnabled === true,
          warrantyDuration: Number(storeData?.returnPolicy?.warrantyDuration || 0),
          warrantyDescription: storeData?.returnPolicy?.warrantyDescription || '',
          policyDescription: storeData?.returnPolicy?.policyDescription || '',
        },
      });
      setLogo(storeData?.logo || null);
      setBanner(storeData?.banner || null);
      setVisibility(storeData?.visibility || { mode: 'country', country: storeData?.address?.country || '', countryCode: storeData?.address?.countryCode || '', region: storeData?.address?.state || '', regionCode: storeData?.address?.stateCode || '', city: storeData?.address?.city || '', town: '' });
      setLoadError('');
      setHasLoaded(true);
    } catch (error) {
      if (error.response?.status === 404) {
        setStore(null);
        setLoadError('');
        setHasLoaded(true);
      } else {
        setLoadError(error.response?.data?.msg || 'Live store settings could not be loaded. Saving is disabled until you retry.');
      }
    }
    finally { setLoading(false); setRefreshing(false); }
  };

  const fetchProductCurrency = async () => {
    try {
      const res = await api.get(API_ENDPOINTS.STORES.PRODUCT_CURRENCY);
      const info = res.data?.productCurrency || {};
      setProductCurrencyInfo(info);
      setProductCurrencyDraft(info.pendingCurrency || info.activeCurrency || currency || 'USD');
      setProductCurrencyError('');
    } catch (error) {
      setProductCurrencyError(error.response?.data?.msg || 'Product currency settings could not be loaded.');
    }
  };

  const fetchVerificationStatus = async () => {
    try {
      const response = await api.get('/api/stores/verification/status');
      setVerification(response.data);
      setVerificationError('');
    } catch (error) {
      setVerificationError(error.response?.data?.msg || 'Verification status could not be loaded.');
    }
  };

  const submitVerificationApplication = async () => {
    const { applicationMessage, contactEmail, contactPhone } = verificationForm;
    if (!applicationMessage.trim() || !contactEmail.trim() || !contactPhone.trim()) {
      Alert.alert('Missing Fields', 'Please fill in all fields before submitting.'); return;
    }
    if (!isValidPhoneNumber(contactPhone)) {
      Alert.alert('Invalid Phone', 'Select a country and enter a valid contact phone number.');
      return;
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

  const updateReturnPolicy = useCallback((field, value) => {
    setFormData(previous => ({
      ...previous,
      returnPolicy: { ...previous.returnPolicy, [field]: value },
    }));
  }, []);

  const updateNestedField = useCallback((group, field, value) => {
    setFormData(previous => ({
      ...previous,
      [group]: { ...(previous[group] || {}), [field]: value },
    }));
  }, []);

  const toggleReturns = useCallback((enabled) => {
    setFormData(previous => ({
      ...previous,
      returnPolicy: {
        ...previous.returnPolicy,
        returnsEnabled: enabled,
        returnDuration: enabled
          ? Math.max(1, Number(previous.returnPolicy?.returnDuration) || 14)
          : 0,
        refundType: enabled && previous.returnPolicy?.refundType !== 'none'
          ? previous.returnPolicy.refundType
          : enabled ? 'full_refund' : 'none',
      },
    }));
  }, []);

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

  const uploadStoreImage = async (uri, type) => {
    if (!uri || isRemoteImage(uri)) return uri || '';
    const mimeType = imageMimeType(uri);
    const extension = mimeType.split('/')[1] || 'jpg';
    const body = new FormData();
    body.append('storeImage', {
      uri,
      type: mimeType,
      name: `store_${type}_${Date.now()}.${extension}`,
    });
    const response = await api.post(API_ENDPOINTS.UPLOAD.STORE_IMAGE, body, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    if (!response.data?.imageUrl) throw new Error(`The ${type} upload did not return a secure URL.`);
    return response.data.imageUrl;
  };

  const saveSettings = async (cooldownConfirmed = false) => {
    const storeName = formData.storeName.trim();
    if (storeName.length < 3 || storeName.length > 50) {
      setErrors({ storeName: 'Store name must be between 3 and 50 characters' });
      return;
    }
    if (formData.description.trim().length > 500) {
      Alert.alert('Description too long', 'Store description must be 500 characters or fewer.');
      return;
    }
    if (formData.returnPolicy?.returnsEnabled) {
      const days = Number(formData.returnPolicy.returnDuration);
      if (!Number.isInteger(days) || days < 1 || days > 365 || !['full_refund', 'store_credit', 'replacement_only'].includes(formData.returnPolicy.refundType)) {
        Alert.alert('Review return policy', 'Choose a valid resolution and a return window between 1 and 365 days.');
        return;
      }
    }
    if (formData.returnPolicy?.warrantyEnabled) {
      const months = Number(formData.returnPolicy.warrantyDuration);
      if (!Number.isInteger(months) || months < 1 || months > 120) {
        Alert.alert('Review warranty', 'Warranty duration must be between 1 and 120 months.');
        return;
      }
    }
    if (!hasLoaded || loadError) {
      Alert.alert('Store settings unavailable', 'Retry loading your live store before saving changes.');
      return;
    }
    if (store?._id && store.isActive === false) {
      Alert.alert(
        'Store is blocked',
        'Reactivate your seller subscription before changing store settings.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'View subscription', onPress: () => navigation.navigate('SellerSubscription') },
        ],
      );
      return;
    }

    const identityChanges = [];
    if (store?._id && storeName.toLowerCase() !== String(store.storeName || '').trim().toLowerCase()) {
      identityChanges.push('Store name will be locked for 7 days');
    }
    if (store?._id && (formData.sellerType || 'store') !== (store.sellerType || 'store')) {
      identityChanges.push('Listing type will be locked for 30 days');
    }
    if (!cooldownConfirmed && identityChanges.length > 0) {
      Alert.alert(
        'Confirm identity changes',
        `After saving:\n\n${identityChanges.map((item) => `• ${item}`).join('\n')}`,
        [
          { text: 'Review', style: 'cancel' },
          { text: 'Confirm & Save', onPress: () => saveSettings(true) },
        ],
      );
      return;
    }
    setSaving(true);
    try {
      const [uploadedLogo, uploadedBanner] = await Promise.all([
        uploadStoreImage(logo, 'logo'),
        uploadStoreImage(banner, 'banner'),
      ]);
      const payload = {
        storeName,
        description: formData.description.trim(),
        sellerType: formData.sellerType || 'store',
        paymentPolicy: formData.paymentPolicy || 'online_and_cod',
        returnPolicy: formData.returnPolicy,
        address: formData.address,
        socialLinks: formData.socialLinks,
        logo: uploadedLogo,
        banner: uploadedBanner,
        visibility,
      };
      const response = store?._id
        ? await api.put('/api/stores/update', payload)
        : await api.post('/api/stores/create', payload);
      const savedStore = response.data?.store || response.data?.newStore || store;
      if (savedStore) setStore(savedStore);
      setLogo(uploadedLogo || null);
      setBanner(uploadedBanner || null);
      if (!store?._id) await Promise.all([fetchProductCurrency(), fetchVerificationStatus()]);
      Alert.alert('Saved', store?._id ? 'Store settings updated successfully.' : 'Your store is ready.');
    } catch (error) { Alert.alert('Could not save store', error.response?.data?.msg || error.message || 'Failed to save settings'); }
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
    if (store?.isActive === false) {
      Alert.alert('Store is blocked', 'Reactivate your seller subscription before changing visibility.');
      return;
    }
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

  const deleteStore = () => {
    if (!store?._id || deletingStore) return;
    Alert.alert(
      'Delete this store?',
      'This permanently removes the storefront and its store settings. This action cannot be undone.',
      [
        { text: 'Keep Store', style: 'cancel' },
        {
          text: 'Delete Permanently',
          style: 'destructive',
          onPress: async () => {
            setDeletingStore(true);
            try {
              await api.delete('/api/stores/delete');
              Alert.alert('Store deleted', 'Your storefront has been removed. You can create a new store later.', [
                { text: 'OK', onPress: () => navigation.goBack() },
              ]);
            } catch (error) {
              Alert.alert('Could not delete store', error.response?.data?.msg || 'Try again later.');
            } finally {
              setDeletingStore(false);
            }
          },
        },
      ]
    );
  };

  if (loading) return <SellerScreenSkeleton navigation={navigation} title="Store Settings" subtitle="Loading your live storefront" icon="settings-outline" variant="form" />;

  if (loadError && !hasLoaded) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
          <SellerScreenHeader navigation={navigation} title="Store Settings" subtitle="Brand, policies and visibility" icon="settings-outline" />
          <SellerInlineError title="Store settings unavailable" message={loadError} onRetry={fetchSettings} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const isVerified = store?.verification?.isVerified;
  const verificationStatus = verification?.status || (isVerified ? 'verified' : 'none');
  const storeBlocked = Boolean(store?._id && store.isActive === false);
  const canApplyForVerification = Boolean(store?._id) && !storeBlocked && !verificationError && (verificationStatus === 'none' || verificationStatus === 'rejected');
  const purchasedSubdomain = Boolean(
    store?.subdomainPurchase?.isPurchased
    && store?.subdomainPurchase?.expiresAt
    && new Date(store.subdomainPurchase.expiresAt).getTime() > Date.now()
  );
  const removalAt = store?.subdomainPurchase?.removalScheduledAt;
  const daysUntilRemoval = storeBlocked && !purchasedSubdomain && removalAt
    ? Math.max(0, Math.ceil((new Date(removalAt).getTime() - Date.now()) / 86400000))
    : null;
  const nameCooldownDays = cooldownDaysRemaining(store?.lastNameChangeAt, 7);
  const typeCooldownDays = cooldownDaysRemaining(store?.lastTypeChangeAt, 30);

  const previewStore = async () => {
    if (!store?.storeSlug) return;
    try {
      await Linking.openURL(`https://${store.storeSlug}.rozare.com`);
    } catch {
      Alert.alert('Could not open store', 'Please try again after checking your connection.');
    }
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safe} edges={Platform.OS === 'android' ? [] : ['top']}>
      <SellerScreenHeader navigation={navigation} title="Store Settings" subtitle="Brand, policies and visibility" icon="settings-outline" rightIcon="refresh" rightLabel="Refresh" onRightPress={onRefresh} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>

        {!!loadError && <SellerInlineError title="Refresh incomplete" message={loadError} onRetry={fetchSettings} />}

        {storeBlocked && (
          <GlassPanel variant="card" style={[styles.section, styles.blockedBanner]} accessibilityRole="alert">
            <View style={styles.blockedRow}>
              <View style={styles.blockedIcon}>
                <Ionicons name="lock-closed-outline" size={20} color={palette.colors.error} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.blockedTitle}>Store blocked — subscription inactive</Text>
                <Text style={styles.blockedText}>
                  {purchasedSubdomain
                    ? 'Your purchased subdomain remains protected. Reactivate your subscription to restore the storefront and editing.'
                    : daysUntilRemoval !== null
                      ? `${store.storeSlug}.rozare.com may be released in ${daysUntilRemoval} day${daysUntilRemoval === 1 ? '' : 's'}. Reactivate to keep it.`
                      : 'Reactivate your subscription to restore the storefront and editing.'}
                </Text>
                <TouchableOpacity style={styles.blockedAction} onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.78} accessibilityRole="button">
                  <Text style={styles.blockedActionText}>View subscription</Text>
                  <Ionicons name="arrow-forward" size={14} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          </GlassPanel>
        )}

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
          {!!store?._id && !!verificationError && (
            <SellerInlineError compact title="Verification status unavailable" message={verificationError} onRetry={fetchVerificationStatus} />
          )}
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
            onChangeText={(v) => updateField('storeName', v)} placeholder="Enter store name" placeholderTextColor={palette.colors.textSecondary}
            editable={!storeBlocked && nameCooldownDays === 0} />
          {errors.storeName && <Text style={styles.errorText}>{errors.storeName}</Text>}
          {nameCooldownDays > 0 && <Text style={styles.cooldownHint}>Name changes unlock again in {nameCooldownDays} day{nameCooldownDays === 1 ? '' : 's'}.</Text>}
          
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
                  disabled={storeBlocked || typeCooldownDays > 0}
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

          <Text style={[styles.label, { marginTop: spacing.lg }]}>Payment Options</Text>
          <Text style={styles.helperText}>Choose whether buyers can pay on delivery for your products.</Text>
          <View style={styles.paymentPolicyGrid}>
            {[
              { value: 'online_and_cod', title: 'Online + COD', desc: 'Buyers can choose card or Cash on Delivery.', icon: 'cash-outline' },
              { value: 'advance_only', title: 'Online payment only', desc: 'Buyers must pay online before the order is sent to you.', icon: 'card-outline' },
            ].map((option) => {
              const active = (formData.paymentPolicy || 'online_and_cod') === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={[styles.paymentPolicyCard, active && styles.paymentPolicyCardActive]}
                  onPress={() => updateField('paymentPolicy', option.value)}
                  activeOpacity={0.8}
                >
                  <Ionicons name={option.icon} size={18} color={active ? palette.colors.primary : palette.colors.textSecondary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.paymentPolicyTitle, active && { color: palette.colors.primary }]}>{option.title}</Text>
                    <Text style={styles.paymentPolicyDesc}>{option.desc}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          {typeCooldownDays > 0 && <Text style={styles.cooldownHint}>Listing type changes unlock again in {typeCooldownDays} day{typeCooldownDays === 1 ? '' : 's'}.</Text>}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Business Address</Text>
          <Text style={styles.helperText}>Used for store identity, regional visibility and buyer confidence.</Text>
          <Text style={styles.label}>Street address</Text>
          <TextInput
            style={styles.input}
            value={formData.address?.street || ''}
            onChangeText={(value) => updateNestedField('address', 'street', value)}
            placeholder="Building, street or area"
            placeholderTextColor={palette.colors.textSecondary}
          />
          <View style={{ marginTop: spacing.md }}>
            <LocationAutocomplete
              type="country"
              label="Country"
              value={formData.address?.country || ''}
              code={formData.address?.countryCode || ''}
              placeholder="Select country"
              onSelect={(option) => setFormData(previous => ({
                ...previous,
                address: { ...previous.address, country: option.name, countryCode: option.isoCode, state: '', stateCode: '', city: '' },
              }))}
              onClear={() => setFormData(previous => ({ ...previous, address: { ...previous.address, country: '', countryCode: '', state: '', stateCode: '', city: '' } }))}
            />
            <LocationAutocomplete
              type="state"
              label="State / Province"
              value={formData.address?.state || ''}
              code={formData.address?.stateCode || ''}
              countryCode={formData.address?.countryCode || ''}
              countryName={formData.address?.country || ''}
              placeholder="Select state"
              disabled={!formData.address?.country}
              onSelect={(option) => setFormData(previous => ({ ...previous, address: { ...previous.address, state: option.name, stateCode: option.isoCode, city: '' } }))}
              onClear={() => setFormData(previous => ({ ...previous, address: { ...previous.address, state: '', stateCode: '', city: '' } }))}
            />
            <LocationAutocomplete
              type="city"
              label="City"
              value={formData.address?.city || ''}
              countryCode={formData.address?.countryCode || ''}
              countryName={formData.address?.country || ''}
              stateCode={formData.address?.stateCode || ''}
              stateName={formData.address?.state || ''}
              placeholder="Select city"
              disabled={!formData.address?.country}
              onSelect={(option) => setFormData(previous => ({ ...previous, address: { ...previous.address, city: option.name, state: previous.address?.state || option.stateName || '', stateCode: previous.address?.stateCode || option.stateCode || '' } }))}
              onClear={() => updateNestedField('address', 'city', '')}
            />
          </View>
          <Text style={[styles.label, { marginTop: spacing.md }]}>Postal code</Text>
          <TextInput style={styles.input} value={formData.address?.postalCode || ''} onChangeText={(value) => updateNestedField('address', 'postalCode', value)} placeholder="Postal or ZIP code" placeholderTextColor={palette.colors.textSecondary} />
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Social Links</Text>
          <Text style={styles.helperText}>Add only official profiles buyers can safely recognize.</Text>
          {[
            ['website', 'Website', 'https://yourstore.com', 'globe-outline'],
            ['instagram', 'Instagram', 'https://instagram.com/yourstore', 'logo-instagram'],
            ['facebook', 'Facebook', 'https://facebook.com/yourstore', 'logo-facebook'],
            ['tiktok', 'TikTok', 'https://tiktok.com/@yourstore', 'logo-tiktok'],
            ['youtube', 'YouTube', 'https://youtube.com/@yourstore', 'logo-youtube'],
            ['twitter', 'X / Twitter', 'https://x.com/yourstore', 'logo-twitter'],
          ].map(([field, label, placeholder, icon], index) => (
            <View key={field} style={index ? styles.socialField : null}>
              <Text style={styles.label}>{label}</Text>
              <View style={styles.iconInput}>
                <Ionicons name={icon} size={17} color={palette.colors.textSecondary} />
                <TextInput
                  style={styles.iconInputText}
                  value={formData.socialLinks?.[field] || ''}
                  onChangeText={(value) => updateNestedField('socialLinks', field, value)}
                  placeholder={placeholder}
                  placeholderTextColor={palette.colors.textSecondary}
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
          ))}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.returnHeader}>
            <View style={styles.returnHeaderText}>
              <Text style={styles.sectionTitle}>Returns</Text>
              <Text style={styles.helperText}>Let buyers request seller-specific returns after delivery.</Text>
            </View>
            <Switch
              value={formData.returnPolicy?.returnsEnabled === true}
              onValueChange={toggleReturns}
              trackColor={{ false: palette.glass.border, true: `${palette.colors.primary}80` }}
              thumbColor={formData.returnPolicy?.returnsEnabled ? palette.colors.primary : palette.colors.textSecondary}
            />
          </View>

          {formData.returnPolicy?.returnsEnabled && (
            <>
              <Text style={[styles.label, { marginTop: spacing.md }]}>Return window (days)</Text>
              <TextInput
                style={styles.input}
                value={String(formData.returnPolicy.returnDuration || '')}
                onChangeText={value => updateReturnPolicy('returnDuration', Math.min(365, Math.max(0, Number(value.replace(/\D/g, '')) || 0)))}
                keyboardType="number-pad"
                placeholder="14"
                placeholderTextColor={palette.colors.textSecondary}
              />
              <Text style={[styles.label, { marginTop: spacing.lg }]}>Resolution</Text>
              <View style={styles.paymentPolicyGrid}>
                {[
                  { value: 'full_refund', title: 'Full refund', desc: 'Refund the approved amount to the buyer Rozare Wallet.', icon: 'wallet-outline' },
                  { value: 'store_credit', title: 'Rozare Wallet credit', desc: 'Credit the approved amount to the buyer Rozare Wallet.', icon: 'card-outline' },
                  { value: 'replacement_only', title: 'Replacement only', desc: 'Approve a replacement instead of a wallet refund.', icon: 'swap-horizontal-outline' },
                ].map(option => {
                  const active = formData.returnPolicy.refundType === option.value;
                  return (
                    <TouchableOpacity key={option.value} style={[styles.paymentPolicyCard, active && styles.paymentPolicyCardActive]} onPress={() => updateReturnPolicy('refundType', option.value)} activeOpacity={0.8}>
                      <Ionicons name={option.icon} size={18} color={active ? palette.colors.primary : palette.colors.textSecondary} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.paymentPolicyTitle, active && { color: palette.colors.primary }]}>{option.title}</Text>
                        <Text style={styles.paymentPolicyDesc}>{option.desc}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[styles.label, { marginTop: spacing.lg }]}>Policy details (optional)</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={formData.returnPolicy.policyDescription}
                onChangeText={value => updateReturnPolicy('policyDescription', value)}
                maxLength={500}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
                placeholder="Add condition, packaging, or pickup details."
                placeholderTextColor={palette.colors.textSecondary}
              />
              <View style={styles.refundNotice}>
                <Ionicons name="shield-checkmark-outline" size={18} color={palette.colors.info} />
                <Text style={styles.refundNoticeText}>A wallet refund is issued only after you fund the exact approved amount from seller balance or by card through Stripe.</Text>
              </View>
            </>
          )}
          <View style={styles.policyDivider} />
          <View style={styles.returnHeader}>
            <View style={styles.returnHeaderText}>
              <Text style={styles.sectionTitle}>Warranty</Text>
              <Text style={styles.helperText}>Show buyers how long eligible products are covered.</Text>
            </View>
            <Switch
              value={formData.returnPolicy?.warrantyEnabled === true}
              onValueChange={(value) => updateReturnPolicy('warrantyEnabled', value)}
              trackColor={{ false: palette.glass.border, true: `${palette.colors.primary}80` }}
              thumbColor={formData.returnPolicy?.warrantyEnabled ? palette.colors.primary : palette.colors.textSecondary}
            />
          </View>
          {formData.returnPolicy?.warrantyEnabled && (
            <>
              <Text style={[styles.label, { marginTop: spacing.md }]}>Warranty duration (months)</Text>
              <TextInput
                style={styles.input}
                value={String(formData.returnPolicy.warrantyDuration || '')}
                onChangeText={(value) => updateReturnPolicy('warrantyDuration', Math.min(120, Math.max(0, Number(value.replace(/\D/g, '')) || 0)))}
                keyboardType="number-pad"
                placeholder="12"
                placeholderTextColor={palette.colors.textSecondary}
              />
              <Text style={[styles.label, { marginTop: spacing.lg }]}>Warranty details</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={formData.returnPolicy.warrantyDescription}
                onChangeText={(value) => updateReturnPolicy('warrantyDescription', value)}
                maxLength={200}
                multiline
                textAlignVertical="top"
                placeholder="Explain what is covered and how buyers can claim warranty support."
                placeholderTextColor={palette.colors.textSecondary}
              />
            </>
          )}
        </GlassPanel>

        {/* Product Currency */}
        {Boolean(store?._id) && (
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
          {!!productCurrencyError && (
            <SellerInlineError
              compact
              title="Currency settings unavailable"
              message={productCurrencyError}
              onRetry={fetchProductCurrency}
            />
          )}
          <View style={styles.currencyGrid}>
            {Object.entries(currencies || {}).map(([code, info]) => {
              const active = productCurrencyDraft === code;
              return (
                <TouchableOpacity
                  key={code}
                  style={[styles.currencyChip, active && styles.currencyChipActive]}
                  onPress={() => updateProductCurrency(code)}
                  disabled={productCurrencySaving || storeBlocked || Boolean(productCurrencyError)}
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
                  <TouchableOpacity style={styles.warningSecondaryBtn} onPress={cancelProductCurrencyChange} disabled={productCurrencySaving || storeBlocked || Boolean(productCurrencyError)}>
                    <Text style={styles.warningSecondaryText}>Keep {productCurrencyInfo.previousCurrency || productCurrencyInfo.activeCurrency}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.warningPrimaryBtn} onPress={convertProductCurrency} disabled={productCurrencySaving || storeBlocked || Boolean(productCurrencyError)}>
                    {productCurrencySaving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.warningPrimaryText}>Convert to {productCurrencyInfo.pendingCurrency}</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
        </GlassPanel>
        )}

        {/* Visibility */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Visibility</Text>
          <Text style={styles.helperText}>Control which buyers can discover your store and products.</Text>
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
          <TouchableOpacity style={[styles.applyBtn, (visibilitySaving || storeBlocked || !store?._id) && { opacity: 0.6 }]} onPress={saveVisibility} disabled={visibilitySaving || storeBlocked || !store?._id} activeOpacity={0.8}>
            {visibilitySaving ? <ActivityIndicator color="white" /> : <Ionicons name="save-outline" size={18} color="white" />}
            <Text style={styles.applyBtnText}>{store?._id ? 'Save Visibility' : 'Saved when store is created'}</Text>
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
          <TouchableOpacity style={[styles.submitButton, (saving || storeBlocked) && { opacity: 0.6 }]} onPress={() => saveSettings(false)} disabled={saving || storeBlocked} activeOpacity={0.8}>
            {saving ? <ActivityIndicator color="white" /> : (
              <><Ionicons name="checkmark-circle" size={22} color="white" /><Text style={styles.submitButtonText}>Save Settings</Text></>
            )}
          </TouchableOpacity>
          {Boolean(store?.storeSlug) && !storeBlocked && (
            <TouchableOpacity style={styles.previewButton} onPress={previewStore} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Preview live store">
              <Ionicons name="eye-outline" size={19} color={palette.colors.primary} />
              <Text style={styles.previewButtonText}>Preview Store</Text>
            </TouchableOpacity>
          )}
        </View>

        {Boolean(store?._id) && (
          <GlassPanel variant="card" style={[styles.section, styles.dangerSection]}>
            <View style={styles.dangerRow}>
              <View style={styles.dangerIcon}><Ionicons name="trash-outline" size={19} color={palette.colors.error} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.dangerTitle}>Delete store</Text>
                <Text style={styles.dangerText}>Permanently remove this storefront and its settings.</Text>
              </View>
              <TouchableOpacity style={styles.deleteButton} onPress={deleteStore} disabled={deletingStore} activeOpacity={0.75}>
                {deletingStore ? <ActivityIndicator size="small" color={palette.colors.error} /> : <Text style={styles.deleteButtonText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </GlassPanel>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Verification Modal */}
      <Modal visible={showVerificationModal} animationType="slide" transparent onRequestClose={() => setShowVerificationModal(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Apply for Verification</Text>
              <TouchableOpacity onPress={() => setShowVerificationModal(false)}><Ionicons name="close" size={24} color={palette.colors.text} /></TouchableOpacity>
            </View>
            <KeyboardAwareFormScrollView>
              <Text style={styles.label}>Contact Email <Text style={{ color: palette.colors.error }}>*</Text></Text>
              <TextInput style={styles.input} value={verificationForm.contactEmail}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactEmail: v }))} placeholder="your@email.com" placeholderTextColor={palette.colors.textSecondary} keyboardType="email-address" autoCapitalize="none" />
              <PhoneNumberInput
                label="Contact Phone"
                required
                value={verificationForm.contactPhone}
                onChangeText={(value) => setVerificationForm(previous => ({ ...previous, contactPhone: value }))}
                defaultCountryCode={formData.address?.countryCode}
                profileCountry={formData.address?.country}
                helperText="Verification staff will use this number only if they need to confirm your application."
                testID="store-verification-phone"
              />
              <Text style={[styles.label, { marginTop: spacing.md }]}>Message <Text style={{ color: palette.colors.error }}>*</Text></Text>
              <TextInput style={[styles.input, styles.textArea]} value={verificationForm.applicationMessage}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, applicationMessage: v }))} placeholder="Why should your store be verified?" placeholderTextColor={palette.colors.textSecondary} multiline numberOfLines={5} textAlignVertical="top" />
              <TouchableOpacity style={[styles.submitButton, submittingVerification && { opacity: 0.6 }, { marginTop: spacing.lg }]} onPress={submitVerificationApplication} disabled={submittingVerification} activeOpacity={0.8}>
                {submittingVerification ? <ActivityIndicator color="white" /> : (
                  <><Ionicons name="shield-checkmark-outline" size={20} color="white" /><Text style={styles.submitButtonText}>Submit Application</Text></>
                )}
              </TouchableOpacity>
            </KeyboardAwareFormScrollView>
          </GlassPanel>
        </View>
      </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safe: { flex: 1 },
  scroll: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingTop: spacing.md, paddingBottom: 100 },
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
  paymentPolicyGrid: { gap: spacing.sm },
  paymentPolicyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  paymentPolicyCardActive: { borderColor: p.colors.primary, backgroundColor: `${p.colors.primary}12` },
  paymentPolicyTitle: { ...typography.bodySemibold, color: p.colors.text },
  paymentPolicyDesc: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  socialField: { marginTop: spacing.md },
  iconInput: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  iconInputText: { flex: 1, paddingVertical: spacing.sm, fontSize: fontSize.sm, color: p.colors.text },
  returnHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  returnHeaderText: { flex: 1 },
  policyDivider: { height: 1, backgroundColor: p.glass.borderSubtle, marginVertical: spacing.lg },
  refundNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.info}10`, borderWidth: 1, borderColor: `${p.colors.info}26` },
  refundNoticeText: { flex: 1, ...typography.caption, color: p.colors.textSecondary, lineHeight: 17 },
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
  cooldownHint: { marginTop: spacing.sm, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.warningDark, fontWeight: fontWeight.semibold },
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
  previewButton: { marginTop: spacing.sm, minHeight: 50, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, borderRadius: borderRadius.xl, borderWidth: 1, borderColor: p.colors.primaryLighter, backgroundColor: p.colors.primarySubtle },
  previewButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.primary },
  blockedBanner: { borderColor: `${p.colors.error}35`, backgroundColor: p.colors.errorSubtle },
  blockedRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  blockedIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: `${p.colors.error}14` },
  blockedTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.error },
  blockedText: { marginTop: 4, fontSize: fontSize.xs, lineHeight: 18, color: p.colors.textSecondary },
  blockedAction: { alignSelf: 'flex-start', marginTop: spacing.md, minHeight: 38, paddingHorizontal: spacing.md, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: p.colors.error },
  blockedActionText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  dangerSection: { borderColor: `${p.colors.error}30`, backgroundColor: p.colors.errorSubtle },
  dangerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dangerIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: `${p.colors.error}14` },
  dangerTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  dangerText: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  deleteButton: { minHeight: 38, paddingHorizontal: spacing.md, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: `${p.colors.error}45`, backgroundColor: `${p.colors.error}0D` },
  deleteButtonText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.error },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { maxHeight: '85%', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  modalTitle: { ...typography.h3, color: p.colors.text },
});
