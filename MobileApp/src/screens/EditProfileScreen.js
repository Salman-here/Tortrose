/**
 * EditProfileScreen — Liquid Glass Design
 */

import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';

export default function EditProfileScreen({ navigation }) {
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [name, setName] = useState(currentUser?.name || currentUser?.username || '');
  const [avatarUri, setAvatarUri] = useState(currentUser?.avatar || null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const pickAvatar = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { Toast.show({ type: 'error', text1: 'Permission Required' }); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setIsUploadingAvatar(true);
      const formData = new FormData();
      formData.append('profileImage', { uri: asset.uri, type: asset.mimeType || 'image/jpeg', name: `avatar_${Date.now()}.jpg` });
      await api.post('/api/upload/profile-image', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      setAvatarUri(asset.uri);
      await fetchAndUpdateCurrentUser();
      Toast.show({ type: 'success', text1: 'Photo Updated' });
    } catch (err) { Toast.show({ type: 'error', text1: 'Upload Failed', text2: err.response?.data?.msg || 'Could not upload photo.' }); }
    finally { setIsUploadingAvatar(false); }
  }, [fetchAndUpdateCurrentUser]);

  const handleSave = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) { setErrors({ name: 'Name must be at least 2 characters' }); return; }
    setIsSaving(true);
    try {
      await api.patch('/api/user/update', { username: trimmed });
      await fetchAndUpdateCurrentUser();
      Toast.show({ type: 'success', text1: 'Profile Updated' });
      navigation.goBack();
    } catch (err) { Toast.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to update profile.' }); }
    finally { setIsSaving(false); }
  }, [name, fetchAndUpdateCurrentUser, navigation]);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <GlassPanel variant="floating" style={styles.heroHeader}>
            <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={22} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.heroCenter}>
              <Text style={styles.heroTitle}>Edit Profile</Text>
              <Text style={styles.heroSubtitle}>Update your account details</Text>
            </View>
          </GlassPanel>

          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.avatarSection}>
              <TouchableOpacity style={styles.avatarWrapper} onPress={pickAvatar} activeOpacity={0.8} disabled={isUploadingAvatar}>
                {avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatarImage} contentFit="cover" transition={200} /> : (
                  <View style={styles.avatarCircle}><Text style={styles.avatarText}>{(name || 'U').charAt(0).toUpperCase()}</Text></View>
                )}
                <View style={styles.cameraOverlay}>
                  {isUploadingAvatar ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="camera" size={16} color={colors.white} />}
                </View>
              </TouchableOpacity>
              <Text style={styles.avatarHint}>Tap photo to change</Text>
            </View>

            <GlassPanel variant="panel" style={styles.formCard}>
              <Text style={styles.fieldLabel}>Display Name</Text>
              <TextInput style={[styles.input, errors.name && styles.inputError]} value={name} onChangeText={(t) => { setName(t); setErrors({}); }} placeholder="Enter your name" placeholderTextColor={colors.textLight} autoCapitalize="words" maxLength={50} />
              {errors.name ? <Text style={styles.errorText}>{errors.name}</Text> : null}

              <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Email Address</Text>
              <View style={styles.readOnlyField}>
                <Ionicons name="mail-outline" size={18} color={colors.textLight} />
                <Text style={styles.readOnlyText}>{currentUser?.email || '—'}</Text>
                <Ionicons name="lock-closed-outline" size={12} color={colors.textLight} />
              </View>
              <Text style={styles.readOnlyHint}>Email cannot be changed here.</Text>
            </GlassPanel>

            <TouchableOpacity style={[styles.saveButton, isSaving && { opacity: 0.7 }]} onPress={handleSave} disabled={isSaving} activeOpacity={0.85}>
              {isSaving ? <ActivityIndicator color={colors.white} size="small" /> : <Text style={styles.saveButtonText}>Save Changes</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heroHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm },
  heroBackBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  heroCenter: { flex: 1, marginLeft: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  heroSubtitle: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl * 2 },
  avatarSection: { alignItems: 'center', marginBottom: spacing.xl },
  avatarWrapper: { position: 'relative', width: 90, height: 90, marginBottom: spacing.sm },
  avatarImage: { width: 90, height: 90, borderRadius: 45, borderWidth: 3, borderColor: 'rgba(255,255,255,0.25)' },
  avatarCircle: { width: 90, height: 90, borderRadius: 45, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: 'rgba(255,255,255,0.25)' },
  avatarText: { fontSize: 36, fontWeight: fontWeight.bold, color: colors.white },
  cameraOverlay: { position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primaryDark, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)' },
  avatarHint: { fontSize: fontSize.sm, color: colors.textSecondary },
  formCard: { padding: spacing.lg, marginBottom: spacing.lg },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary, marginBottom: spacing.xs },
  input: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: colors.text, backgroundColor: 'rgba(255,255,255,0.08)' },
  inputError: { borderColor: colors.error },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginTop: 4 },
  readOnlyField: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: 'rgba(255,255,255,0.05)' },
  readOnlyText: { flex: 1, fontSize: fontSize.md, color: colors.textSecondary },
  readOnlyHint: { fontSize: fontSize.xs, color: colors.textLight, marginTop: 6, fontStyle: 'italic' },
  saveButton: { backgroundColor: colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.md + 2, alignItems: 'center' },
  saveButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.white },
});
