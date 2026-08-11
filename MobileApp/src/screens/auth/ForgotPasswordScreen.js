/**
 * ForgotPasswordScreen — Liquid Glass Design
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../../utils/feedback';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import AuthTopHeader from '../../components/common/AuthTopHeader';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

export default function ForgotPasswordScreen({ navigation }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);

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
      Feedback.show({ type: 'success', text1: 'Email Sent', text2: res.data.msg || 'Password reset link sent' });
    } catch (err) {
      const msg = err.response?.data?.msg || 'Failed to send reset link';
      setError(msg); Feedback.show({ type: 'error', text1: 'Error', text2: msg });
    } finally { setIsLoading(false); }
  };

  return (
    <GlassBackground>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <KeyboardAwareFormScrollView contentContainerStyle={{ flexGrow: 1, padding: spacing.md, paddingBottom: spacing.xxxl }} bottomOffset={32}>
          <AuthTopHeader
            title="Reset Password"
            subtitle="Recover your Rozare account"
            icon="key-outline"
            onBack={() => navigation.goBack()}
            rightIcon="lock-closed-outline"
            rightLabel="Private"
          />

          {/* Hero */}
          <GlassPanel variant="strong" style={styles.hero}>
            <View style={styles.heroIconWrap}>
              <Ionicons name={isSuccess ? 'checkmark-circle' : 'lock-open-outline'} size={32} color={palette.colors.primary} />
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
                    <Ionicons name="mail-outline" size={18} color={error ? palette.colors.error : 'rgba(255,255,255,0.4)'} style={{ marginRight: spacing.sm }} />
                    <TextInput style={styles.input} placeholder="john@example.com" placeholderTextColor={palette.colors.grayLight}
                      value={email} onChangeText={(t) => { setEmail(t); if (error) setError(''); }} keyboardType="email-address" autoCapitalize="none" />
                  </View>
                  {error ? <Text style={styles.errorText}>{error}</Text> : null}
                </View>
                <TouchableOpacity style={[styles.submitBtn, isLoading && { opacity: 0.6 }]} onPress={handleForgotPassword} disabled={isLoading} activeOpacity={0.85}>
                  <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                  {isLoading ? <ActivityIndicator color="#fff" /> : <><Ionicons name="send" size={16} color="#fff" /><Text style={styles.submitText}>Send Reset Link</Text></>}
                </TouchableOpacity>
                <TouchableOpacity style={styles.backToLogin} onPress={() => navigation.navigate('Login')}>
                  <Ionicons name="arrow-back" size={14} color={palette.colors.primary} /><Text style={{ color: palette.colors.primary, fontWeight: fontWeight.semibold }}>Back to Sign In</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={{ alignItems: 'center', paddingVertical: spacing.lg }}>
                <View style={styles.successIcon}><Ionicons name="mail-open" size={48} color={palette.colors.success} /></View>
                <Text style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: palette.colors.text, marginBottom: spacing.md }}>Check your inbox!</Text>
                <Text style={{ fontSize: fontSize.md, color: palette.colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl, lineHeight: 22 }}>Click the link in the email to create a new password. Expires in 15 minutes.</Text>
                <TouchableOpacity style={styles.tryAgainBtn} onPress={() => { setIsSuccess(false); setEmail(''); setError(''); }}>
                  <Ionicons name="refresh" size={16} color={palette.colors.primary} /><Text style={{ color: palette.colors.primary, fontWeight: fontWeight.semibold }}>Try a Different Email</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.loginBtn} onPress={() => navigation.navigate('Login')}>
                  <Text style={{ color: '#fff', fontWeight: fontWeight.semibold }}>Return to Sign In</Text><Ionicons name="arrow-forward" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.divider} />
            <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
              <Text style={{ color: palette.colors.textSecondary }}>Remember your password?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}><Text style={{ color: palette.colors.primary, fontWeight: fontWeight.bold }}> Sign In</Text></TouchableOpacity>
            </View>
          </GlassPanel>
      </KeyboardAwareFormScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  hero: { alignItems: 'center', padding: spacing.xl, marginTop: spacing.md, marginBottom: spacing.md },
  heroIconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  heroTitle: { fontSize: 26, fontWeight: fontWeight.extrabold, color: p.colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  heroSub: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  card: { padding: spacing.xl },
  inputGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.sm },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: 16, borderWidth: 1.5, borderColor: p.glass.borderSubtle, paddingHorizontal: spacing.md, height: 52 },
  inputError: { borderColor: p.colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  input: { flex: 1, fontSize: fontSize.md, color: p.colors.text },
  errorText: { fontSize: fontSize.sm, color: p.colors.error, marginTop: 4 },
  submitBtn: { flexDirection: 'row', paddingVertical: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, overflow: 'hidden', marginBottom: spacing.md, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  submitText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  backToLogin: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, gap: 4 },
  successIcon: { width: 88, height: 88, borderRadius: 44, backgroundColor: 'rgba(34,197,94,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xl },
  tryAgainBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.1)', paddingVertical: spacing.md, borderRadius: 16, gap: spacing.sm, width: '100%', marginBottom: spacing.md },
  loginBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, paddingVertical: spacing.md, borderRadius: 16, gap: spacing.sm, width: '100%', ...shadows.md },
  divider: { height: 1, backgroundColor: p.glass.borderSubtle, marginVertical: spacing.xl },
});
