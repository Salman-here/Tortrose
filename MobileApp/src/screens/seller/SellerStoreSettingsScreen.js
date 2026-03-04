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
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import VerifiedBadge from '../../components/VerifiedBadge';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography, glass,
} from '../../styles/theme';

export default function SellerStoreSettingsScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [formData, setFormData] = useState({ storeName: '', description: '' });
  const [logo, setLogo] = useState(null);
  const [banner, setBanner] = useState(null);
  const [errors, setErrors] = useState({});
  const [verification, setVerification] = useState(null);
  const [showVerificationModal, setShowVerificationModal] = useState(false);
  const [verificationForm, setVerificationForm] = useState({ applicationMessage: '', contactEmail: '', contactPhone: '' });
  const [submittingVerification, setSubmittingVerification] = useState(false);

  useEffect(() => { fetchSettings(); fetchVerificationStatus(); }, []);

  const fetchSettings = async () => {
    try {
      const response = await api.get('/api/stores/my-store');
      const storeData = response.data?.store || response.data;
      setStore(storeData);
      setFormData({ storeName: storeData?.name || storeData?.storeName || '', description: storeData?.description || '' });
      setLogo(storeData?.logo || null);
      setBanner(storeData?.banner || null);
    } catch (error) { console.error('Error fetching settings:', error); }
    finally { setLoading(false); setRefreshing(false); }
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
    Promise.all([fetchSettings(), fetchVerificationStatus()]).finally(() => setRefreshing(false));
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
      await api.put('/api/stores/update', { storeName: formData.storeName.trim(), description: formData.description.trim(), logo, banner });
      Alert.alert('Success', 'Store settings saved successfully');
    } catch (error) { Alert.alert('Error', error.response?.data?.message || 'Failed to save settings'); }
    finally { setSaving(false); }
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading settings..." /></GlassBackground>;

  const isVerified = store?.verification?.isVerified;
  const verificationStatus = verification?.status || (isVerified ? 'verified' : 'none');
  const canApplyForVerification = verificationStatus === 'none' || verificationStatus === 'rejected';

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        <GlassPanel variant="floating" style={styles.header}>
          <View style={styles.headerIcon}><Ionicons name="settings-outline" size={28} color={colors.primary} /></View>
          <Text style={styles.headerTitle}>Store Settings</Text>
          <Text style={styles.headerSubtitle}>Manage your store information</Text>
        </GlassPanel>

        {/* Verification Status */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Verification</Text>
          <View style={[styles.verificationCard, {
            borderLeftColor: verificationStatus === 'verified' ? colors.success : verificationStatus === 'pending' ? colors.warning : colors.textSecondary,
          }]}>
            <Ionicons name={verificationStatus === 'verified' ? 'shield-checkmark' : verificationStatus === 'pending' ? 'time-outline' : 'shield-outline'} size={32}
              color={verificationStatus === 'verified' ? colors.success : verificationStatus === 'pending' ? colors.warning : colors.textSecondary} />
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
                <Ionicons name="image-outline" size={32} color={colors.textSecondary} />
                <Text style={styles.pickerText}>Tap to add banner</Text>
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.label}>Store Logo</Text>
          <TouchableOpacity style={styles.logoPicker} onPress={() => pickImage('logo')} activeOpacity={0.8}>
            {logo ? (
              <Image source={{ uri: logo }} style={styles.logoImage} contentFit="cover" />
            ) : (
              <View style={styles.logoPlaceholder}><Ionicons name="storefront-outline" size={32} color={colors.textSecondary} /></View>
            )}
          </TouchableOpacity>
        </GlassPanel>

        {/* Store Details */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Store Details</Text>
          <Text style={styles.label}>Store Name <Text style={{ color: colors.error }}>*</Text></Text>
          <TextInput style={[styles.input, errors.storeName && styles.inputError]} value={formData.storeName}
            onChangeText={(v) => updateField('storeName', v)} placeholder="Enter store name" placeholderTextColor={colors.textSecondary} />
          {errors.storeName && <Text style={styles.errorText}>{errors.storeName}</Text>}
          
          <Text style={[styles.label, { marginTop: spacing.lg }]}>Description</Text>
          <TextInput style={[styles.input, styles.textArea]} value={formData.description}
            onChangeText={(v) => updateField('description', v)} placeholder="Describe your store..." placeholderTextColor={colors.textSecondary}
            multiline numberOfLines={4} textAlignVertical="top" />
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
              <TouchableOpacity onPress={() => setShowVerificationModal(false)}><Ionicons name="close" size={24} color={colors.text} /></TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>Contact Email <Text style={{ color: colors.error }}>*</Text></Text>
              <TextInput style={styles.input} value={verificationForm.contactEmail}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactEmail: v }))} placeholder="your@email.com" placeholderTextColor={colors.textSecondary} keyboardType="email-address" autoCapitalize="none" />
              <Text style={[styles.label, { marginTop: spacing.md }]}>Contact Phone <Text style={{ color: colors.error }}>*</Text></Text>
              <TextInput style={styles.input} value={verificationForm.contactPhone}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, contactPhone: v }))} placeholder="+1 234 567 8900" placeholderTextColor={colors.textSecondary} keyboardType="phone-pad" />
              <Text style={[styles.label, { marginTop: spacing.md }]}>Message <Text style={{ color: colors.error }}>*</Text></Text>
              <TextInput style={[styles.input, styles.textArea]} value={verificationForm.applicationMessage}
                onChangeText={(v) => setVerificationForm(p => ({ ...p, applicationMessage: v }))} placeholder="Why should your store be verified?" placeholderTextColor={colors.textSecondary} multiline numberOfLines={5} textAlignVertical="top" />
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

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  header: { alignItems: 'center', margin: spacing.lg, padding: spacing.xl },
  headerIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  headerTitle: { ...typography.h2, color: colors.text, marginBottom: spacing.xs },
  headerSubtitle: { ...typography.body, color: colors.textSecondary },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: colors.text, marginBottom: spacing.md },
  verificationCard: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.08)', borderLeftWidth: 3 },
  verificationTitle: { ...typography.bodySemibold, color: colors.text },
  verificationText: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2 },
  applyBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.md, marginTop: spacing.md },
  applyBtnText: { ...typography.bodySemibold, color: 'white' },
  label: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.sm },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, fontSize: fontSize.md, color: colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  inputError: { borderColor: colors.error },
  textArea: { minHeight: 100 },
  errorText: { ...typography.caption, color: colors.error, marginTop: spacing.xs },
  bannerPicker: { borderRadius: borderRadius.xl, overflow: 'hidden', marginBottom: spacing.lg },
  bannerImage: { width: '100%', height: 160, borderRadius: borderRadius.xl },
  bannerPlaceholder: { width: '100%', height: 160, borderRadius: borderRadius.xl, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderStyle: 'dashed' },
  pickerText: { ...typography.bodySmall, color: colors.textSecondary, marginTop: spacing.sm },
  logoPicker: { alignSelf: 'flex-start' },
  logoImage: { width: 80, height: 80, borderRadius: 40 },
  logoPlaceholder: { width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderStyle: 'dashed' },
  submitContainer: { paddingHorizontal: spacing.lg, marginTop: spacing.md },
  submitButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.lg },
  submitButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: 'white' },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { maxHeight: '85%', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  modalTitle: { ...typography.h3, color: colors.text },
});
