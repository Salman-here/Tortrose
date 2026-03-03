import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, typography } from '../styles/theme';

export default function ChangePasswordScreen({ navigation }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});

  const validate = () => {
    const e = {};
    if (!currentPassword.trim()) e.currentPassword = 'Current password is required';
    if (!newPassword.trim()) e.newPassword = 'New password is required';
    else if (newPassword.length < 8) e.newPassword = 'Password must be at least 8 characters';
    if (!confirmPassword.trim()) e.confirmPassword = 'Please confirm your new password';
    else if (newPassword !== confirmPassword) e.confirmPassword = 'Passwords do not match';
    if (currentPassword && newPassword && currentPassword === newPassword)
      e.newPassword = 'New password must be different from current password';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleChangePassword = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      await api.patch('/api/password/change', { currentPassword, newPassword });
      Toast.show({ type: 'success', text1: 'Password Changed', text2: 'Your password has been updated successfully' });
      setTimeout(() => navigation.goBack(), 1500);
    } catch (error) {
      const msg = error.response?.data?.msg || 'Failed to change password';
      Toast.show({ type: 'error', text1: 'Error', text2: msg });
    } finally {
      setLoading(false);
    }
  };

  const renderPasswordField = (label, value, setter, show, setShow, fieldKey, placeholder) => (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, errors[fieldKey] && styles.inputWrapError]}>
        <Ionicons name="lock-closed-outline" size={20} color={errors[fieldKey] ? colors.error : colors.gray} style={styles.inputIcon} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={(t) => { setter(t); setErrors(prev => ({ ...prev, [fieldKey]: null })); }}
          placeholder={placeholder}
          placeholderTextColor={colors.grayLight}
          secureTextEntry={!show}
          autoCapitalize="none"
        />
        <TouchableOpacity onPress={() => setShow(!show)} style={styles.eyeBtn}>
          <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.gray} />
        </TouchableOpacity>
      </View>
      {errors[fieldKey] ? <Text style={styles.errorText}>{errors[fieldKey]}</Text> : null}
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Hero Header */}
        <View style={styles.hero}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={colors.white} />
          </TouchableOpacity>
          <View style={styles.heroIconWrap}>
            <Ionicons name="shield-checkmark" size={36} color={colors.white} />
          </View>
          <Text style={styles.heroTitle}>Change Password</Text>
          <Text style={styles.heroSubtitle}>Keep your account secure with a strong password</Text>
        </View>

        {/* Form Card */}
        <View style={styles.card}>
          {renderPasswordField('Current Password', currentPassword, setCurrentPassword, showCurrent, setShowCurrent, 'currentPassword', 'Enter your current password')}
          {renderPasswordField('New Password', newPassword, setNewPassword, showNew, setShowNew, 'newPassword', 'At least 8 characters')}
          {renderPasswordField('Confirm New Password', confirmPassword, setConfirmPassword, showConfirm, setShowConfirm, 'confirmPassword', 'Re-enter new password')}
        </View>

        {/* Password Tip */}
        <View style={styles.tipCard}>
          <Ionicons name="bulb-outline" size={18} color={colors.warning} />
          <Text style={styles.tipText}>Use a mix of letters, numbers, and symbols for a stronger password.</Text>
        </View>

        {/* Submit Button */}
        <TouchableOpacity style={[styles.submitBtn, loading && styles.submitBtnDisabled]} onPress={handleChangePassword} disabled={loading} activeOpacity={0.85}>
          {loading ? <ActivityIndicator size="small" color={colors.white} /> : (
            <>
              <Ionicons name="checkmark-circle-outline" size={20} color={colors.white} />
              <Text style={styles.submitBtnText}>Update Password</Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: spacing.xxl }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxl },

  // Hero
  hero: {
    backgroundColor: colors.primaryDark,
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  backBtn: {
    position: 'absolute',
    top: spacing.lg,
    left: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
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
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.75)',
    textAlign: 'center',
  },

  // Card
  card: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xxl,
    margin: spacing.lg,
    padding: spacing.lg,
    ...shadows.md,
  },
  fieldGroup: { marginBottom: spacing.lg },
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: colors.light,
    paddingHorizontal: spacing.md,
  },
  inputWrapError: {
    borderColor: colors.error,
    backgroundColor: colors.errorSubtle,
  },
  inputIcon: { marginRight: spacing.sm },
  input: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
  },
  eyeBtn: {
    padding: spacing.sm,
  },
  errorText: {
    fontSize: fontSize.xs,
    color: colors.error,
    marginTop: spacing.xs,
    marginLeft: spacing.xs,
  },

  // Tip
  tipCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.warningSubtle,
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    padding: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
  },
  tipText: {
    fontSize: fontSize.sm,
    color: colors.warningDark,
    flex: 1,
    lineHeight: 20,
  },

  // Submit
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.xl,
    paddingVertical: spacing.lg,
    marginHorizontal: spacing.lg,
    ...shadows.md,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
});

