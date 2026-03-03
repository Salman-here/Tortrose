/**
 * SellerStoreSettingsScreen
 * Manage store settings and information
 * 
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6
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
  SafeAreaView,
  RefreshControl,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import VerifiedBadge from '../../components/VerifiedBadge';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
  buttonStyles,
} from '../../styles/theme';

export default function SellerStoreSettingsScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [formData, setFormData] = useState({
    storeName: '',
    description: '',
  });
  const [logo, setLogo] = useState(null);
  const [banner, setBanner] = useState(null);
  const [errors, setErrors] = useState({});

  // Verification state
  const [verification, setVerification] = useState(null);
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [verificationForm, setVerificationForm] = useState({
    applicationMessage: '',
    contactEmail: '',
    contactPhone: '',
  });
  const [submittingVerification, setSubmittingVerification] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchVerificationStatus();
  }, []);

  const fetchSettings = async () => {
    try {
      const response = await api.get('/api/stores/my-store');
      const storeData = response.data?.store || response.data;
      setStore(storeData);
      setFormData({
        storeName: storeData?.name || storeData?.storeName || '',
        description: storeData?.description || '',
      });
      setLogo(storeData?.logo || null);
      setBanner(storeData?.banner || null);
    } catch (error) {
      console.error('Error fetching settings:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const fetchVerificationStatus = async () => {
    try {
      const response = await api.get('/api/stores/verification/status');
      setVerification(response.data);
    } catch (error) {
      // Verification status not critical; silently ignore
      console.log('Verification status unavailable:', error?.response?.status);
    }
  };

  const submitVerificationApplication = async () => {
    const { applicationMessage, contactEmail, contactPhone } = verificationForm;
    if (!applicationMessage.trim() || !contactEmail.trim() || !contactPhone.trim()) {
      Alert.alert('Missing Fields', 'Please fill in all fields before submitting.');
      return;
    }
    setSubmittingVerification(true);
    try {
      await api.post('/api/stores/verification/apply', {
        applicationMessage: applicationMessage.trim(),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim(),
      });
      setShowVerificationModal(false);
      setVerificationForm({ applicationMessage: '', contactEmail: '', contactPhone: '' });
      await fetchVerificationStatus();
      Alert.alert('Application Submitted', 'Your verification request has been submitted. We will review it shortly.');
    } catch (error) {
      Alert.alert('Submission Failed', error.response?.data?.msg || error.response?.data?.message || 'Failed to submit verification request.');
    } finally {
      setSubmittingVerification(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.all([fetchSettings(), fetchVerificationStatus()]).finally(() => setRefreshing(false));
  }, []);

  const updateField = useCallback((field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: null }));
    }
  }, [errors]);

  const pickImage = useCallback(async (type) => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: type === 'logo' ? [1, 1] : [16, 9],
        quality: 0.8,
      });

      if (!result.canceled && result.assets?.[0]) {
        if (type === 'logo') {
          setLogo(result.assets[0].uri);
        } else {
          setBanner(result.assets[0].uri);
        }
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to pick image');
    }
  }, []);

  const validateForm = () => {
    const newErrors = {};
    if (!formData.storeName.trim()) {
      newErrors.storeName = 'Store name is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const saveSettings = async () => {
    if (!validateForm()) {
      Alert.alert('Validation Error', 'Please fix the errors in the form');
      return;
    }

    setSaving(true);
    try {
      await api.put('/api/stores/update', {
        storeName: formData.storeName.trim(),
        description: formData.description.trim(),
        logo,
        banner,
      });
      Alert.alert('Success', 'Store settings saved successfully');
    } catch (error) {
      Alert.alert('Error', error.response?.data?.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading settings..." />
      </SafeAreaView>
    );
  }

  const isVerified = store?.verification?.isVerified;
  const verificationStatus = verification?.status || (isVerified ? 'verified' : 'none');
  const canApplyForVerification = verificationStatus === 'none' || verificationStatus === 'rejected';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
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
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="settings-outline" size={28} color={colors.primary} />
          </View>
          <Text style={styles.headerTitle}>Store Settings</Text>
          <Text style={styles.headerSubtitle}>Manage your store information</Text>
        </View>

        {/* Verification Status */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Store Verification</Text>
          <View style={[
            styles.verificationCard,
            verificationStatus === 'verified' && styles.verificationCardSuccess,
            verificationStatus === 'pending' && styles.verificationCardWarning,
            verificationStatus === 'rejected' && styles.verificationCardError,
          ]}>
            <View style={styles.verificationIcon}>
              <Ionicons
                name={
                  verificationStatus === 'verified' ? 'shield-checkmark' :
                  verificationStatus === 'pending' ? 'time-outline' :
                  verificationStatus === 'rejected' ? 'close-circle-outline' : 'shield-outline'
                }
                size={32}
                color={
                  verificationStatus === 'verified' ? colors.success :
                  verificationStatus === 'pending' ? colors.warning :
                  verificationStatus === 'rejected' ? colors.error : colors.grayLight
                }
              />
            </View>
            <View style={styles.verificationInfo}>
              <Text style={styles.verificationTitle}>
                {verificationStatus === 'verified' ? 'Verified Store' :
                 verificationStatus === 'pending' ? 'Pending Review' :
                 verificationStatus === 'rejected' ? 'Application Rejected' : 'Not Verified'}
              </Text>
              <Text style={styles.verificationText}>
                {verificationStatus === 'verified' ? 'Your store is verified and trusted by customers' :
                 verificationStatus === 'pending' ? 'Your application is being reviewed by our team' :
                 verificationStatus === 'rejected'
                   ? (verification?.rejectionReason ? `Reason: ${verification.rejectionReason}` : 'Your application was rejected. You may reapply.')
                   : 'Get your store verified to build customer trust'}
              </Text>
            </View>
            {isVerified && <VerifiedBadge size="md" />}
          </View>
          {canApplyForVerification && (
            <TouchableOpacity
              style={styles.applyVerificationBtn}
              onPress={() => setShowVerificationModal(true)}
              activeOpacity={0.8}
            >
              <Ionicons name="shield-checkmark-outline" size={18} color={colors.white} />
              <Text style={styles.applyVerificationBtnText}>
                {verificationStatus === 'rejected' ? 'Reapply for Verification' : 'Apply for Verification'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Images Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Store Images</Text>
          
          {/* Banner */}
          <Text style={styles.label}>Store Banner</Text>
          <TouchableOpacity
            style={styles.bannerPicker}
            onPress={() => pickImage('banner')}
            activeOpacity={0.8}
          >
            {banner ? (
              <Image source={{ uri: banner }} style={styles.bannerImage} contentFit="cover" cachePolicy="memory-disk" transition={200} />
            ) : (
              <View style={styles.bannerPlaceholder}>
                <Ionicons name="image-outline" size={32} color={colors.grayLight} />
                <Text style={styles.pickerText}>Tap to add banner</Text>
              </View>
            )}
            <View style={styles.editBadge}>
              <Ionicons name="camera" size={16} color={colors.white} />
            </View>
          </TouchableOpacity>

          {/* Logo */}
          <Text style={styles.label}>Store Logo</Text>
          <TouchableOpacity
            style={styles.logoPicker}
            onPress={() => pickImage('logo')}
            activeOpacity={0.8}
          >
            {logo ? (
              <Image source={{ uri: logo }} style={styles.logoImage} contentFit="cover" cachePolicy="memory-disk" transition={200} />
            ) : (
              <View style={styles.logoPlaceholder}>
                <Ionicons name="storefront-outline" size={32} color={colors.grayLight} />
              </View>
            )}
            <View style={styles.editBadgeLogo}>
              <Ionicons name="camera" size={14} color={colors.white} />
            </View>
          </TouchableOpacity>
        </View>

        {/* Store Details */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Store Details</Text>
          
          <View style={styles.inputGroup}>
            <Text style={styles.label}>
              Store Name <Text style={styles.required}>*</Text>
            </Text>
            <TextInput
              style={[styles.input, errors.storeName && styles.inputError]}
              value={formData.storeName}
              onChangeText={(value) => updateField('storeName', value)}
              placeholder="Enter store name"
              placeholderTextColor={colors.grayLight}
            />
            {errors.storeName && (
              <Text style={styles.errorText}>{errors.storeName}</Text>
            )}
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Store Description</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={formData.description}
              onChangeText={(value) => updateField('description', value)}
              placeholder="Describe your store..."
              placeholderTextColor={colors.grayLight}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </View>
        </View>

        {/* Save Button */}
        <View style={styles.submitContainer}>
          <TouchableOpacity
            style={[styles.submitButton, saving && styles.submitButtonDisabled]}
            onPress={saveSettings}
            disabled={saving}
            activeOpacity={0.8}
          >
            {saving ? (
              <Loader size="small" color={colors.white} />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={22} color={colors.white} />
                <Text style={styles.submitButtonText}>Save Settings</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Bottom Spacing */}
        <View style={styles.bottomSpacing} />
      </ScrollView>

      {/* Verification Application Modal */}
      <Modal
        visible={showVerificationModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowVerificationModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Apply for Verification</Text>
              <TouchableOpacity onPress={() => setShowVerificationModal(false)} style={styles.modalClose}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.modalHint}>
                Provide your contact information and a message explaining why your store should be verified.
              </Text>

              <Text style={styles.label}>Contact Email <Text style={styles.required}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={verificationForm.contactEmail}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactEmail: v }))}
                placeholder="your@email.com"
                placeholderTextColor={colors.grayLight}
                keyboardType="email-address"
                autoCapitalize="none"
              />

              <Text style={[styles.label, { marginTop: spacing.md }]}>Contact Phone <Text style={styles.required}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={verificationForm.contactPhone}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactPhone: v }))}
                placeholder="+1 234 567 8900"
                placeholderTextColor={colors.grayLight}
                keyboardType="phone-pad"
              />

              <Text style={[styles.label, { marginTop: spacing.md }]}>Application Message <Text style={styles.required}>*</Text></Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={verificationForm.applicationMessage}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, applicationMessage: v }))}
                placeholder="Describe your store and why it should be verified..."
                placeholderTextColor={colors.grayLight}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />

              <TouchableOpacity
                style={[styles.submitButton, submittingVerification && styles.submitButtonDisabled, { marginTop: spacing.lg }]}
                onPress={submitVerificationApplication}
                disabled={submittingVerification}
                activeOpacity={0.8}
              >
                {submittingVerification
                  ? <ActivityIndicator color={colors.white} size="small" />
                  : <>
                      <Ionicons name="shield-checkmark-outline" size={20} color={colors.white} />
                      <Text style={styles.submitButtonText}>Submit Application</Text>
                    </>
                }
              </TouchableOpacity>
              <View style={{ height: spacing.xl }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Header
  header: {
    backgroundColor: colors.white,
    padding: spacing.xl,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  headerIcon: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primaryLighter,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headerTitle: {
    ...typography.h2,
    marginBottom: spacing.xs,
  },
  headerSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  // Sections
  section: {
    backgroundColor: colors.white,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  sectionTitle: {
    ...typography.h4,
    marginBottom: spacing.md,
  },
  // Verification
  verificationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  verificationCardSuccess: { backgroundColor: colors.successSubtle },
  verificationCardWarning: { backgroundColor: colors.warningSubtle },
  verificationCardError: { backgroundColor: colors.errorSubtle },
  verificationIcon: {
    marginRight: spacing.md,
  },
  verificationInfo: {
    flex: 1,
  },
  verificationTitle: {
    ...typography.bodySemibold,
    marginBottom: 2,
  },
  verificationText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  applyVerificationBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  applyVerificationBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.white,
  },
  // Verification Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: borderRadius.xxl || 24,
    borderTopRightRadius: borderRadius.xxl || 24,
    maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  modalTitle: {
    ...typography.h4,
  },
  modalClose: {
    padding: spacing.xs,
  },
  modalBody: {
    padding: spacing.lg,
  },
  modalHint: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  // Image Pickers
  bannerPicker: {
    height: 120,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.lighter,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    position: 'relative',
  },
  bannerImage: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoPicker: {
    width: 100,
    height: 100,
    borderRadius: borderRadius.full,
    backgroundColor: colors.lighter,
    overflow: 'hidden',
    position: 'relative',
    alignSelf: 'center',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  logoPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerText: {
    ...typography.bodySmall,
    color: colors.grayLight,
    marginTop: spacing.xs,
  },
  editBadge: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  editBadgeLogo: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.white,
  },
  // Form
  inputGroup: {
    marginBottom: spacing.lg,
  },
  label: {
    ...typography.bodySemibold,
    marginBottom: spacing.sm,
  },
  required: {
    color: colors.error,
  },
  input: {
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
    borderWidth: 2,
    borderColor: colors.lighter,
  },
  inputError: {
    borderColor: colors.error,
  },
  textArea: {
    height: 100,
    textAlignVertical: 'top',
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    marginTop: spacing.xs,
  },
  // Submit
  submitContainer: {
    padding: spacing.lg,
  },
  submitButton: {
    ...buttonStyles.primary,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitButtonText: {
    ...buttonStyles.primaryText,
  },
  // Bottom
  bottomSpacing: {
    height: spacing.xxl,
  },
});
