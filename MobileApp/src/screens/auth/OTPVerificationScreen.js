import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, KeyboardAvoidingView, Platform, ScrollView,
  ActivityIndicator, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';

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

    const newOtp = [...otp];
    newOtp[index] = cleaned.slice(-1);
    setOtp(newOtp);
    setError('');

    if (cleaned && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
    // Auto-submit when all digits entered
    if (newOtp.every(d => d !== '') && newOtp.join('').length === OTP_LENGTH) {
      handleVerify(newOtp.join(''));
    }
  };

  const handleKeyPress = (e, index) => {
    if (e.nativeEvent.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleVerify = useCallback(async (code) => {
    const otpCode = code || otp.join('');
    if (otpCode.length !== OTP_LENGTH) {
      setError('Please enter the complete 6-digit code');
      return;
    }
    setIsVerifying(true);
    const result = await verifyOTP({ email, otp: otpCode });
    setIsVerifying(false);
    if (!result.success) {
      setError(result.error || 'Invalid OTP. Please try again.');
      setOtp(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
    }
  }, [otp, email, verifyOTP]);

  const handleResend = async () => {
    if (countdown > 0) return;
    setIsResending(true);
    setOtp(Array(OTP_LENGTH).fill(''));
    setError('');
    // Re-call signup to resend OTP (user data was passed via route params)
    await signup({ name, email, password: '__resend__' });
    setIsResending(false);
    setCountdown(RESEND_COOLDOWN);
    inputRefs.current[0]?.focus();
  };

  const maskedEmail = email
    ? email.replace(/(.{2})(.*)(@.*)/, (_, a, b, c) => a + '*'.repeat(Math.max(0, b.length)) + c)
    : '';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.primaryDark} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardView}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {/* Header */}
          <View style={styles.topHeader}>
            <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
              <Ionicons name="arrow-back" size={22} color={colors.white} />
            </TouchableOpacity>
            <View style={styles.logoRow}>
              <View style={styles.logoIcon}><Ionicons name="storefront" size={20} color={colors.white} /></View>
              <Text style={styles.logoText}>Tortrose</Text>
            </View>
            <View style={{ width: 40 }} />
          </View>

          {/* Hero */}
          <View style={styles.heroSection}>
            <View style={styles.otpIconCircle}>
              <Ionicons name="mail-open-outline" size={40} color={colors.white} />
            </View>
            <Text style={styles.heroTitle}>Verify Your Email</Text>
            <Text style={styles.heroSubtitle}>
              We sent a 6-digit code to{'\n'}<Text style={styles.emailHighlight}>{maskedEmail}</Text>
            </Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            <Text style={styles.codeLabel}>Enter Verification Code</Text>

            {/* OTP Boxes */}
            <View style={styles.otpRow}>
              {otp.map((digit, index) => (
                <TextInput
                  key={index}
                  ref={ref => inputRefs.current[index] = ref}
                  style={[styles.otpBox, digit && styles.otpBoxFilled, error && styles.otpBoxError]}
                  value={digit}
                  onChangeText={val => handleOtpChange(val, index)}
                  onKeyPress={e => handleKeyPress(e, index)}
                  keyboardType="numeric"
                  maxLength={1}
                  textAlign="center"
                  selectTextOnFocus
                  autoFocus={index === 0}
                />
              ))}
            </View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {/* Verify Button */}
            <TouchableOpacity
              style={[styles.verifyButton, (isVerifying || otp.join('').length < OTP_LENGTH) && styles.buttonDisabled]}
              onPress={() => handleVerify()}
              disabled={isVerifying || otp.join('').length < OTP_LENGTH}
              activeOpacity={0.85}
            >
              {isVerifying ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <>
                  <Text style={styles.verifyButtonText}>Verify & Create Account</Text>
                  <Ionicons name="checkmark-circle" size={20} color={colors.white} />
                </>
              )}
            </TouchableOpacity>

            {/* Resend */}
            <View style={styles.resendRow}>
              <Text style={styles.resendText}>Didn't receive the code? </Text>
              {countdown > 0 ? (
                <Text style={styles.countdownText}>Resend in {countdown}s</Text>
              ) : (
                <TouchableOpacity onPress={handleResend} disabled={isResending}>
                  {isResending ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Text style={styles.resendLink}>Resend Code</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.helpRow}>
              <Ionicons name="information-circle-outline" size={16} color={colors.grayLight} />
              <Text style={styles.helpText}>Check your spam folder if you don't see it</Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.primaryDark },
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxxl },
  topHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  backButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  logoText: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.white },
  heroSection: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xl, paddingBottom: spacing.xxxl },
  otpIconCircle: { width: 88, height: 88, borderRadius: 44, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: colors.white, marginBottom: spacing.sm, textAlign: 'center' },
  heroSubtitle: { fontSize: fontSize.md, color: 'rgba(255,255,255,0.75)', lineHeight: 24, textAlign: 'center' },
  emailHighlight: { fontWeight: fontWeight.bold, color: colors.white },
  card: { backgroundColor: colors.white, borderTopLeftRadius: borderRadius.xxxl, borderTopRightRadius: borderRadius.xxxl, padding: spacing.xxl, paddingTop: spacing.xxxl, flex: 1, minHeight: 420 },
  codeLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark, marginBottom: spacing.lg, letterSpacing: 0.3, textAlign: 'center' },
  otpRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md },
  otpBox: { width: 48, height: 58, borderRadius: borderRadius.lg, borderWidth: 2, borderColor: colors.light, backgroundColor: colors.lighter, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  otpBoxFilled: { borderColor: colors.primary, backgroundColor: colors.primarySubtle },
  otpBoxError: { borderColor: colors.error, backgroundColor: colors.errorSubtle },
  errorText: { fontSize: fontSize.sm, color: colors.error, textAlign: 'center', marginBottom: spacing.md },
  verifyButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: spacing.lg, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, ...shadows.primaryMd, marginBottom: spacing.xl, marginTop: spacing.md },
  buttonDisabled: { opacity: 0.6 },
  verifyButtonText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  resendRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  resendText: { fontSize: fontSize.md, color: colors.textSecondary },
  countdownText: { fontSize: fontSize.md, color: colors.grayLight, fontWeight: fontWeight.medium },
  resendLink: { fontSize: fontSize.md, color: colors.primary, fontWeight: fontWeight.bold },
  helpRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  helpText: { fontSize: fontSize.sm, color: colors.grayLight },
});
