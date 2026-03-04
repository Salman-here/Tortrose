/**
 * ChangePasswordScreen — Liquid Glass Design
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

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
    if (currentPassword && newPassword && currentPassword === newPassword) e.newPassword = 'New password must be different';
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
      Toast.show({ type: 'error', text1: 'Error', text2: error.response?.data?.msg || 'Failed to change password' });
    } finally { setLoading(false); }
  };

  const renderField = (label, value, setter, show, setShow, fieldKey, placeholder) => (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, errors[fieldKey] && styles.inputWrapError]}>
        <Ionicons name="lock-closed-outline" size={18} color={errors[fieldKey] ? colors.error : 'rgba(255,255,255,0.4)'} style={{ marginRight: spacing.sm }} />
        <TextInput style={styles.input} value={value} onChangeText={(t) => { setter(t); setErrors(prev => ({ ...prev, [fieldKey]: null })); }}
          placeholder={placeholder} placeholderTextColor="rgba(255,255,255,0.3)" secureTextEntry={!show} autoCapitalize="none" />
        <TouchableOpacity onPress={() => setShow(!show)} style={{ padding: spacing.sm }}>
          <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color="rgba(255,255,255,0.4)" />
        </TouchableOpacity>
      </View>
      {errors[fieldKey] ? <Text style={styles.errorText}>{errors[fieldKey]}</Text> : null}
    </View>
  );

  return (
    <GlassBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Header */}
          <GlassPanel variant="floating" style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
              <Ionicons name="arrow-back" size={20} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Change Password</Text>
            <View style={{ width: 36 }} />
          </GlassPanel>

          {/* Hero */}
          <GlassPanel variant="strong" style={styles.hero}>
            <View style={styles.heroIcon}>
              <Ionicons name="shield-checkmark" size={32} color={colors.primary} />
            </View>
            <Text style={styles.heroTitle}>Security Update</Text>
            <Text style={styles.heroSub}>Keep your account secure with a strong password</Text>
          </GlassPanel>

          {/* Form */}
          <GlassPanel variant="card" style={styles.card}>
            {renderField('Current Password', currentPassword, setCurrentPassword, showCurrent, setShowCurrent, 'currentPassword', 'Enter your current password')}
            {renderField('New Password', newPassword, setNewPassword, showNew, setShowNew, 'newPassword', 'At least 8 characters')}
            {renderField('Confirm New Password', confirmPassword, setConfirmPassword, showConfirm, setShowConfirm, 'confirmPassword', 'Re-enter new password')}
          </GlassPanel>

          {/* Tip */}
          <GlassPanel variant="inner" style={styles.tipCard}>
            <Ionicons name="bulb-outline" size={16} color={colors.warning} />
            <Text style={styles.tipText}>Use a mix of letters, numbers, and symbols for a stronger password.</Text>
          </GlassPanel>

          {/* Submit */}
          <TouchableOpacity style={[styles.submitBtn, loading && { opacity: 0.6 }]} onPress={handleChangePassword} disabled={loading}>
            {loading ? <ActivityIndicator size="small" color="#fff" /> : (
              <><Ionicons name="checkmark-circle-outline" size={20} color="#fff" /><Text style={styles.submitText}>Update Password</Text></>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  hero: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  heroIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, marginBottom: 4 },
  heroSub: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center' },
  card: { padding: spacing.lg, marginBottom: spacing.md },
  fieldGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bgSubtle, borderRadius: 14, borderWidth: 1, borderColor: glass.borderSubtle, paddingHorizontal: spacing.md },
  inputWrapError: { borderColor: colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  input: { flex: 1, paddingVertical: 13, fontSize: fontSize.md, color: colors.text },
  errorText: { fontSize: fontSize.xs, color: colors.error, marginTop: 4, marginLeft: 4 },
  tipCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.lg },
  tipText: { fontSize: fontSize.sm, color: colors.textSecondary, flex: 1, lineHeight: 20 },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 16, ...shadows.md },
  submitText: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: '#fff' },
});
