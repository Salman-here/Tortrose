/**
 * EditProfileScreen — Liquid Glass Design
 */

import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../utils/feedback';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function EditProfileScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [name, setName] = useState(currentUser?.name || currentUser?.username || '');
  const [avatarUri, setAvatarUri] = useState(currentUser?.avatar || null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const pickAvatar = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { Feedback.show({ type: 'error', text1: 'Permission Required' }); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setIsUploadingAvatar(true);
      const formData = new FormData();
      formData.append('profileImage', { uri: asset.uri, type: asset.mimeType || 'image/jpeg', name: `avatar_${Date.now()}.jpg` });
      await api.post('/api/upload/profile-image', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setAvatarUri(asset.uri);
      await fetchAndUpdateCurrentUser();
      Feedback.show({ type: 'success', text1: 'Photo Updated' });
    } catch (err) { Feedback.show({ type: 'error', text1: 'Upload Failed', text2: err.response?.data?.msg || 'Could not upload photo.' }); }
    finally { setIsUploadingAvatar(false); }
  }, [fetchAndUpdateCurrentUser]);

  const handleSave = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) { setErrors({ name: 'Name must be at least 2 characters' }); return; }
    setIsSaving(true);
    try {
      await api.patch('/api/user/update', { username: trimmed });
      await fetchAndUpdateCurrentUser();
      Feedback.show({ type: 'success', text1: 'Profile Updated' });
      navigation.goBack();
    } catch (err) { Feedback.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to update profile.' }); }
    finally { setIsSaving(false); }
  }, [name, fetchAndUpdateCurrentUser, navigation]);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <PremiumBackHeader
            title="Edit Profile"
            subtitle="Update your account details"
            icon="person-outline"
            onBack={() => navigation.goBack()}
            rightIcon="sparkles-outline"
            rightLabel="Profile"
            style={styles.premiumHeader}
          />

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.avatarSection}>
              <TouchableOpacity style={styles.avatarWrapper} onPress={pickAvatar} activeOpacity={0.8} disabled={isUploadingAvatar}>
                {avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatarImage} contentFit="cover" transition={200} /> : (
                  <View style={styles.avatarCircle}><Text style={styles.avatarText}>{(name || 'U').charAt(0).toUpperCase()}</Text></View>
                )}
                <View style={styles.cameraOverlay}>
                  {isUploadingAvatar ? <ActivityIndicator size="small" color={palette.colors.white} /> : <Ionicons name="camera" size={16} color={palette.colors.white} />}
                </View>
              </TouchableOpacity>
              <Text style={styles.avatarHint}>Tap photo to change</Text>
            </View>

            <GlassPanel variant="panel" style={styles.formCard}>
              <Text style={styles.fieldLabel}>Display Name</Text>
              <TextInput style={[styles.input, errors.name && styles.inputError]} value={name} onChangeText={(t) => { setName(t); setErrors({}); }} placeholder="Enter your name" placeholderTextColor={palette.colors.textLight} autoCapitalize="words" maxLength={50} />
              {errors.name ? <Text style={styles.errorText}>{errors.name}</Text> : null}

              <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Email Address</Text>
              <View style={styles.readOnlyField}>
                <Ionicons name="mail-outline" size={18} color={palette.colors.textLight} />
                <Text style={styles.readOnlyText}>{currentUser?.email || '—'}</Text>
                <Ionicons name="lock-closed-outline" size={12} color={palette.colors.textLight} />
              </View>
              <Text style={styles.readOnlyHint}>Email cannot be changed here.</Text>
            </GlassPanel>

            <TouchableOpacity style={[styles.saveButton, isSaving && { opacity: 0.7 }]} onPress={handleSave} disabled={isSaving} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              {isSaving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveButtonText}>Save Changes</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  avatarSection: { alignItems: 'center', marginBottom: spacing.xl },
  avatarWrapper: { position: 'relative', width: 90, height: 90, marginBottom: spacing.sm },
  avatarImage: { width: 90, height: 90, borderRadius: 45, borderWidth: 3, borderColor: 'rgba(255,255,255,0.25)' },
  avatarCircle: { width: 90, height: 90, borderRadius: 45, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.25)' },
  avatarText: { fontSize: 36, fontWeight: fontWeight.bold, color: p.colors.white },
  cameraOverlay: { position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: 14, backgroundColor: p.colors.primaryDark, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)' },
  avatarHint: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  formCard: { padding: spacing.lg, marginBottom: spacing.lg },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.textSecondary, marginBottom: spacing.xs },
  input: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: p.colors.text, backgroundColor: 'rgba(255,255,255,0.08)' },
  inputError: { borderColor: p.colors.error },
  errorText: { fontSize: fontSize.xs, color: p.colors.error, marginTop: 4 },
  readOnlyField: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: 'rgba(255,255,255,0.05)' },
  readOnlyText: { flex: 1, fontSize: fontSize.md, color: p.colors.textSecondary },
  readOnlyHint: { fontSize: fontSize.xs, color: p.colors.textLight, marginTop: 6, fontStyle: 'italic' },
  saveButton: { borderRadius: borderRadius.xl, paddingVertical: spacing.md + 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  saveButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.white },
});
