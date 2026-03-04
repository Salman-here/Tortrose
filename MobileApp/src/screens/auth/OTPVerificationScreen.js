/**
 * OTPVerificationScreen — Liquid Glass Design
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../../styles/theme';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 60;

export default function OTPVerificationScreen({ route, navigation }) {
  const { email, name } = route.params || {};
  const { verifyOTP, signup } = useAuth();

  const [otp, setOtp] = useState(Array(OTP_LENGTH).fill(''));
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [countdown, setCountdown] = useState(RESEND_COOLDOWN);
  const [error, setError] = useState('');
  const inputRefs = useRef([]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown(c => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const handleOtpChange = (value, index) => {
    const cleaned = value.replace(/[^0-9]/g, '');
    if (!cleaned && value !== '') return;
    const newOtp = [...otp]; newOtp[index] = cleaned.slice(-1); setOtp(newOtp); setError('');
    if (cleaned && index < OTP_LENGTH - 1) inputRefs.current[index + 1]?.focus();
    if (newOtp.every(d => d !== '') && newOtp.join('').length === OTP_LENGTH) handleVerify(newOtp.join(''));
  };

  const handleKeyPress = (e, index) => { if (e.nativeEvent.key === 'Backspace' && !otp[index] && index > 0) inputRefs.current[index - 1]?.focus(); };

  const handleVerify = useCallback(async (code) => {
    const otpCode = code || otp.join('');
    if (otpCode.length !== OTP_LENGTH) { setError('Please enter the complete 6-digit code'); return; }
    setIsVerifying(true);
    const result = await verifyOTP({ email, otp: otpCode });
    setIsVerifying(false);
    if (!result.success) { setError(result.error || 'Invalid OTP.'); setOtp(Array(OTP_LENGTH).fill('')); inputRefs.current[0]?.focus(); }
  }, [otp, email, verifyOTP]);

  const handleResend = async () => {
    if (countdown > 0) return;
    setIsResending(true); setOtp(Array(OTP_LENGTH).fill('')); setError('');
    await signup({ name, email, password: '__resend__' });
    setIsResending(false); setCountdown(RESEND_COOLDOWN); inputRefs.current[0]?.focus();
  };

  const maskedEmail = email ? email.replace(/(.{2})(.*)(@.*)/, (_, a, b, c) => a + '*'.repeat(Math.max(0, b.length)) + c) : '';

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
            <View style={styles.otpIconCircle}><Ionicons name="mail-open-outline" size={36} color={colors.primary} /></View>
            <Text style={styles.heroTitle}>Verify Your Email</Text>
            <Text style={styles.heroSub}>We sent a 6-digit code to{'\n'}<Text style={{ fontWeight: fontWeight.bold, color: colors.text }}>{maskedEmail}</Text></Text>
          </GlassPanel>

          {/* OTP Card */}
          <GlassPanel variant="card" style={styles.card}>
            <Text style={styles.codeLabel}>Enter Verification Code</Text>
            <View style={styles.otpRow}>
              {otp.map((digit, index) => (
                <TextInput key={index} ref={ref => inputRefs.current[index] = ref}
                  style={[styles.otpBox, digit && styles.otpBoxFilled, error && styles.otpBoxError]}
                  value={digit} onChangeText={val => handleOtpChange(val, index)} onKeyPress={e => handleKeyPress(e, index)}
                  keyboardType="numeric" maxLength={1} textAlign="center" selectTextOnFocus autoFocus={index === 0} />
              ))}
            </View>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <TouchableOpacity style={[styles.verifyBtn, (isVerifying || otp.join('').length < OTP_LENGTH) && { opacity: 0.6 }]}
              onPress={() => handleVerify()} disabled={isVerifying || otp.join('').length < OTP_LENGTH}>
              {isVerifying ? <ActivityIndicator color="#fff" size="small" /> : <><Text style={styles.verifyText}>Verify & Create Account</Text><Ionicons name="checkmark-circle" size={18} color="#fff" /></>}
            </TouchableOpacity>
            <View style={styles.resendRow}>
              <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Didn't receive the code? </Text>
              {countdown > 0 ? <Text style={{ fontSize: fontSize.md, color: colors.textSecondary }}>Resend in {countdown}s</Text> :
                <TouchableOpacity onPress={handleResend} disabled={isResending}>
                  {isResending ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={{ fontSize: fontSize.md, color: colors.primary, fontWeight: fontWeight.bold }}>Resend Code</Text>}
                </TouchableOpacity>}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: spacing.md }}>
              <Ionicons name="information-circle-outline" size={14} color="rgba(255,255,255,0.3)" />
              <Text style={{ fontSize: fontSize.sm, color: colors.textSecondary }}>Check your spam folder if you don't see it</Text>
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
  otpIconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  heroTitle: { fontSize: 26, fontWeight: fontWeight.extrabold, color: colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  heroSub: { fontSize: fontSize.md, color: colors.textSecondary, lineHeight: 24, textAlign: 'center' },
  card: { padding: spacing.xl },
  codeLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.lg, textAlign: 'center' },
  otpRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md },
  otpBox: { width: 46, height: 54, borderRadius: 14, borderWidth: 2, borderColor: glass.border, backgroundColor: glass.bgSubtle, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  otpBoxFilled: { borderColor: colors.primary, backgroundColor: 'rgba(99,102,241,0.08)' },
  otpBoxError: { borderColor: colors.error, backgroundColor: 'rgba(239,68,68,0.08)' },
  errorText: { fontSize: fontSize.sm, color: colors.error, textAlign: 'center', marginBottom: spacing.md },
  verifyBtn: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, ...shadows.md, marginBottom: spacing.xl, marginTop: spacing.md },
  verifyText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  resendRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
});
