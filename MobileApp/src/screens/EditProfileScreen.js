/**
 * EditProfileScreen
 * Allows users to update their profile name/username.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
} from '../styles/theme';

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
      if (status !== 'granted') {
        Toast.show({ type: 'error', text1: 'Permission Required', text2: 'Please allow photo library access in Settings.' });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setIsUploadingAvatar(true);

      const formData = new FormData();
      formData.append('profileImage', {
        uri: asset.uri,
        type: asset.mimeType || 'image/jpeg',
        name: `avatar_${Date.now()}.jpg`,
      });

      await api.post('/api/upload/profile-image', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setAvatarUri(asset.uri);
      await fetchAndUpdateCurrentUser();
      Toast.show({ type: 'success', text1: 'Photo Updated', text2: 'Your profile photo has been updated.' });
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Upload Failed', text2: err.response?.data?.msg || 'Could not upload photo.' });
    } finally {
      setIsUploadingAvatar(false);
    }
  }, [fetchAndUpdateCurrentUser]);

  const validate = useCallback(() => {
    const newErrors = {};
    const trimmed = name.trim();
    if (!trimmed) {
      newErrors.name = 'Name is required';
    } else if (trimmed.length < 2) {
      newErrors.name = 'Name must be at least 2 characters';
    } else if (trimmed.length > 50) {
      newErrors.name = 'Name must be under 50 characters';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [name]);

  const handleSave = useCallback(async () => {
    if (!validate()) return;

    setIsSaving(true);
    try {
      await api.patch('/api/user/update', { username: name.trim() });
      await fetchAndUpdateCurrentUser();
      Toast.show({
        type: 'success',
        text1: 'Profile Updated',
        text2: 'Your name has been updated successfully.',
      });
      navigation.goBack();
    } catch (err) {
      const msg = err.response?.data?.msg || 'Failed to update profile. Please try again.';
      Toast.show({ type: 'error', text1: 'Error', text2: msg });
    } finally {
      setIsSaving(false);
    }
  }, [name, validate, fetchAndUpdateCurrentUser, navigation]);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Hero Header */}
        <View style={styles.heroHeader}>
          <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={colors.white} />
          </TouchableOpacity>
          <View style={styles.heroCenter}>
            <Text style={styles.heroTitle}>Edit Profile</Text>
            <Text style={styles.heroSubtitle}>Update your account details</Text>
          </View>
          <View style={styles.heroIconWrap}>
            <Ionicons name="person-outline" size={22} color={colors.white} />
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* Avatar - tappable photo picker */}
          <View style={styles.avatarSection}>
            <TouchableOpacity style={styles.avatarWrapper} onPress={pickAvatar} activeOpacity={0.8} disabled={isUploadingAvatar}>
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={styles.avatarImage} contentFit="cover" cachePolicy="memory-disk" transition={200} />
              ) : (
                <View style={styles.avatarCircle}>
                  <Text style={styles.avatarText}>
                    {(name || currentUser?.name || 'U').charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={styles.cameraOverlay}>
                {isUploadingAvatar
                  ? <ActivityIndicator size="small" color={colors.white} />
                  : <Ionicons name="camera" size={16} color={colors.white} />
                }
              </View>
            </TouchableOpacity>
            <Text style={styles.avatarHint}>Tap photo to change your profile picture</Text>
          </View>

          {/* Name Field */}
          <View style={styles.formCard}>
            <Text style={styles.fieldLabel}>Display Name</Text>
            <TextInput
              style={[styles.input, errors.name && styles.inputError]}
              value={name}
              onChangeText={(t) => { setName(t); setErrors({}); }}
              placeholder="Enter your name"
              placeholderTextColor={colors.textLight}
              autoCapitalize="words"
              autoCorrect={false}
              maxLength={50}
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />
            {errors.name ? <Text style={styles.errorText}>{errors.name}</Text> : null}

            {/* Email (read-only info) */}
            <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Email Address</Text>
            <View style={styles.readOnlyField}>
              <Ionicons name="mail-outline" size={18} color={colors.textLight} />
              <Text style={styles.readOnlyText}>{currentUser?.email || '—'}</Text>
              <View style={styles.lockedBadge}>
                <Ionicons name="lock-closed-outline" size={12} color={colors.textLight} />
              </View>
            </View>
            <Text style={styles.readOnlyHint}>Email cannot be changed here. Contact support.</Text>
          </View>

          {/* Save Button */}
          <TouchableOpacity
            style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
            onPress={handleSave}
            activeOpacity={0.85}
            disabled={isSaving}
          >
            {isSaving
              ? <ActivityIndicator color={colors.white} size="small" />
              : <Text style={styles.saveButtonText}>Save Changes</Text>
            }
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  heroHeader: {
    backgroundColor: colors.primaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  heroBackBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center', alignItems: 'center',
  },
  heroCenter: { flex: 1, marginLeft: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.white },
  heroSubtitle: { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  heroIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center', alignItems: 'center',
  },
  content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  avatarSection: { alignItems: 'center', marginBottom: spacing.xl },
  avatarWrapper: {
    position: 'relative',
    width: 90, height: 90,
    marginBottom: spacing.sm,
  },
  avatarImage: {
    width: 90, height: 90, borderRadius: 45,
    ...shadows.md,
  },
  avatarCircle: {
    width: 90, height: 90, borderRadius: 45,
    backgroundColor: colors.primary,
    justifyContent: 'center', alignItems: 'center',
    ...shadows.md,
  },
  avatarText: { fontSize: 36, fontWeight: fontWeight.bold, color: colors.white },
  cameraOverlay: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: colors.primaryDark,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: colors.white,
  },
  avatarHint: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center' },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...shadows.sm,
  },
  fieldLabel: {
    fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
    color: colors.textSecondary, marginBottom: spacing.xs,
  },
  input: {
    borderWidth: 1, borderColor: colors.light,
    borderRadius: borderRadius.md, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, fontSize: fontSize.md,
    color: colors.text, backgroundColor: colors.background,
  },
  inputError: { borderColor: colors.error },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginTop: 4 },
  readOnlyField: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    borderWidth: 1, borderColor: colors.light,
    borderRadius: borderRadius.md, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, backgroundColor: colors.grayLightest || '#f8f9fa',
  },
  readOnlyText: { flex: 1, fontSize: fontSize.md, color: colors.textSecondary },
  lockedBadge: { padding: 2 },
  readOnlyHint: {
    fontSize: fontSize.xs, color: colors.textLight,
    marginTop: 6, fontStyle: 'italic',
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md + 2,
    alignItems: 'center',
    ...shadows.md,
  },
  saveButtonDisabled: { backgroundColor: colors.primaryLight, opacity: 0.7 },
  saveButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.white },
});
