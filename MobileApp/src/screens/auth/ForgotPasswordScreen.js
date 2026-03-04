/**
 * ForgotPasswordScreen — Liquid Glass Design
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../../styles/theme';

export default function ForgotPasswordScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');

  const validateEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleForgotPassword = async () => {
    setError('');
    if (!email.trim()) { setError('Please enter your email address'); return; }
    if (!validateEmail(email)) { setError('Please enter a valid email address'); return; }
    setIsLoading(true);
    try {
      const res = await api.post('/api/password/forgot', { email });
      setIsSuccess(true);
      Toast.show({ type: 'success', text1: 'Email Sent', text2: res.data.msg || 'Password reset link sent' });
    } catch (err) {
      const msg = err.response?.data?.msg || 'Failed to send reset link';
      setError(msg); Toast.show({ type: 'error', text1: 'Error', text2: msg });
    } finally { setIsLoading(false); }
  };

  return (
    <GlassBackground>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: spacing.md, paddingBottom: spacing.xxxl }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {/* Header */}
          <GlassPanel variant="floating" style={styles.topHeader}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
              <Ionicons name="arrow-back" size={20} color={colors.text} />
            </TouchableOpacity>
            <View style={styles.logoRow}>
              <View style={styles.logoIcon}><Ionicons name="storefront" size={18} color={colors.primary} /></View>
              <Text style={styles.logoText}>Tortrose</Text>
            </View>
            <View style={{ width: 36 }} />
          </GlassPanel>

          {/* Hero */}
          <GlassPanel variant="strong" style={styles.hero}>
            <View style={styles.heroIconWrap}>
              <Ionicons name={isSuccess ? 'checkmark-circle' : 'lock-open-outline'} size={32} color={colors.primary} />
            </View>
            <Text style={styles.heroTitle}>{isSuccess ? 'Email Sent! 📧' : 'Reset Password 🔐'}</Text>
            <Text style={styles.heroSub}>{isSuccess ? `We sent a reset link to\n${email}` : "Enter your email and we'll send a reset link"}</Text>
          </GlassPanel>

          {/* Form Card */}
          <GlassPanel variant="card" style={styles.card}>
            {!isSuccess ? (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Email Address</Text>
                  <View style={[styles.inputContainer, error && styles.inputError]}>
                    <Ionicons name="mail-outline" size={18} color={error ? colors.error : 'rgba(255,255,255,0.4)'} style={{ marginRight: spacing.sm }} />
                    <TextInput style={styles.input} placeholder="john@example.com" placeholderTextColor="rgba(255,255,255,0.3)"
                      value={email} onChangeText={(t) => { setEmail(t); if (error) setError(''); }} keyboardType="email-address" autoCapitalize="none" />
                  </View>
                  {error ? <Text style={styles.errorText}>{error}</Text> : null}
                </View>
                <TouchableOpacity style={[styles.submitBtn, isLoading && { opacity: 0.6 }]} onPress={handleForgotPassword} disabled={isLoading}>
                  {isLoading ? <ActivityIndicator color="#fff" /> : <><Ionicons name="send" size={16} color="#fff" /><Text style={styles.submitText}>Send Reset Link</Text></>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.backToLogin} onPress={() => navigation.navigate('Login')}>
                  <Ionicons name="arrow-back" size={14} color={colors.primary} /><Text style={{ color: colors.primary, fontWeight: fontWeight.semibold }}>Back to Sign In</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={{ alignItems: 'center', paddingVertical: spacing.lg }}>
                <View style={styles.successIcon}><Ionicons name="mail-open" size={48} color={colors.success} /></View>
                <Text style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.md }}>Check your inbox!</Text>
                <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl, lineHeight: 22 }}>Click the link in the email to create a new password. Expires in 15 minutes.</Text>
                <TouchableOpacity style={styles.tryAgainBtn} onPress={() => { setIsSuccess(false); setEmail(''); setError(''); }}>
                  <Ionicons name="refresh" size={16} color={colors.primary} /><Text style={{ color: colors.primary, fontWeight: fontWeight.semibold }}>Try a Different Email</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.loginBtn} onPress={() => navigation.navigate('Login')}>
                  <Text style={{ color: '#fff', fontWeight: fontWeight.semibold }}>Return to Sign In</Text><Ionicons name="arrow-forward" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.divider} />
            <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
              <Text style={{ color: colors.textSecondary }}>Remember your password?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}><Text style={{ color: colors.primary, fontWeight: fontWeight.bold }}> Sign In</Text></TouchableOpacity>
            </View>
          </GlassPanel>
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  topHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  logoText: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  hero: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  heroIconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  heroTitle: { fontSize: 26, fontWeight: fontWeight.extrabold, color: colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  heroSub: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  card: { padding: spacing.xl },
  inputGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.sm },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bgSubtle, borderRadius: 16, borderWidth: 1.5, borderColor: glass.borderSubtle, paddingHorizontal: spacing.md, height: 52 },
  inputError: { borderColor: colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  input: { flex: 1, fontSize: fontSize.md, color: colors.text },
  errorText: { fontSize: fontSize.sm, color: colors.error, marginTop: 4 },
  submitBtn: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, ...shadows.md, marginBottom: spacing.md },
  submitText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  backToLogin: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, gap: 4 },
  successIcon: { width: 88, height: 88, borderRadius: 44, backgroundColor: 'rgba(34,197,94,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xl },
  tryAgainBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.1)', paddingVertical: spacing.md, borderRadius: 16, gap: spacing.sm, width: '100%', marginBottom: spacing.md },
  loginBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, paddingVertical: spacing.md, borderRadius: 16, gap: spacing.sm, width: '100%', ...shadows.md },
  divider: { height: 1, backgroundColor: glass.borderSubtle, marginVertical: spacing.xl },
});
