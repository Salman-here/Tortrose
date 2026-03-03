/**
 * ForgotPasswordScreen
 * Modern password reset screen matching website design
 * 
 * Requirements: 5.3
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../../config/api';
import { 
  colors, 
  spacing, 
  fontSize, 
  borderRadius, 
  shadows, 
  fontWeight,
  typography,
} from '../../styles/theme';

export default function ForgotPasswordScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');

  // Validate email format
  const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleForgotPassword = async () => {
    // Clear previous error
    setError('');

    // Validate email
    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }

    if (!validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/password/forgot', { email });
      setIsSuccess(true);
      Toast.show({
        type: 'success',
        text1: 'Email Sent',
        text2: res.data.msg || 'Password reset link sent to your email',
      });
    } catch (error) {
      const errorMsg = error.response?.data?.msg || 'Failed to send reset link';
      setError(errorMsg);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: errorMsg,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTryAgain = () => {
    setIsSuccess(false);
    setEmail('');
    setError('');
  };

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
            <View style={styles.heroIconWrap}>
              <Ionicons name={isSuccess ? 'checkmark-circle' : 'lock-open-outline'} size={36} color={colors.white} />
            </View>
            <Text style={styles.heroTitle}>{isSuccess ? 'Email Sent! 📧' : 'Reset Password 🔐'}</Text>
            <Text style={styles.heroSubtitle}>
              {isSuccess ? `We sent a reset link to\n${email}` : "Enter your email and we'll send you a link to reset your password"}
            </Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            {!isSuccess ? (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Email Address</Text>
                  <View style={[styles.inputContainer, error && styles.inputError]}>
                    <Ionicons name="mail-outline" size={20} color={error ? colors.error : colors.grayLight} style={styles.inputIcon} />
                    <TextInput
                      style={styles.input}
                      placeholder="john@example.com"
                      placeholderTextColor={colors.grayLight}
                      value={email}
                      onChangeText={(t) => { setEmail(t); if (error) setError(''); }}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                  {error ? <Text style={styles.errorText}>{error}</Text> : null}
                </View>

                <TouchableOpacity style={[styles.submitButton, isLoading && styles.submitButtonDisabled]} onPress={handleForgotPassword} disabled={isLoading} activeOpacity={0.85}>
                  {isLoading ? <ActivityIndicator color={colors.white} /> : (
                    <>
                      <Ionicons name="send" size={18} color={colors.white} />
                      <Text style={styles.submitButtonText}>Send Reset Link</Text>
                    </>
                  )}
                </TouchableOpacity>

                <TouchableOpacity style={styles.backToLogin} onPress={() => navigation.navigate('Login')}>
                  <Ionicons name="arrow-back" size={16} color={colors.primary} />
                  <Text style={styles.backToLoginText}>Back to Sign In</Text>
                </TouchableOpacity>
              </>
            ) : (
              <View style={styles.successContainer}>
                <View style={styles.successIconContainer}>
                  <Ionicons name="mail-open" size={52} color={colors.success} />
                </View>
                <Text style={styles.successTitle}>Check your inbox!</Text>
                <Text style={styles.successText}>Click the link in the email to create a new password. The link expires in 15 minutes.</Text>
                <Text style={styles.successNote}>Didn't receive it? Check your spam folder.</Text>
                <TouchableOpacity style={styles.tryAgainButton} onPress={handleTryAgain}>
                  <Ionicons name="refresh" size={18} color={colors.primary} />
                  <Text style={styles.tryAgainText}>Try a Different Email</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.loginButton} onPress={() => navigation.navigate('Login')}>
                  <Text style={styles.loginButtonText}>Return to Sign In</Text>
                  <Ionicons name="arrow-forward" size={18} color={colors.white} />
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.divider}><View style={styles.dividerLine} /></View>
            <View style={styles.signInRow}>
              <Text style={styles.signInText}>Remember your password?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                <Text style={styles.signInLink}> Sign In</Text>
              </TouchableOpacity>
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
  heroSection: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xl, paddingBottom: spacing.xxxl, alignItems: 'center' },
  heroIconWrap: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: colors.white, marginBottom: spacing.sm, textAlign: 'center' },
  heroSubtitle: { fontSize: fontSize.md, color: 'rgba(255,255,255,0.75)', lineHeight: 22, textAlign: 'center' },
  card: { backgroundColor: colors.white, borderTopLeftRadius: borderRadius.xxxl, borderTopRightRadius: borderRadius.xxxl, padding: spacing.xxl, paddingTop: spacing.xxxl, flex: 1, minHeight: 380 },
  inputGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark, marginBottom: spacing.sm, letterSpacing: 0.3 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.lighter, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: colors.light, paddingHorizontal: spacing.md, height: 56 },
  inputError: { borderColor: colors.error, backgroundColor: colors.errorSubtle },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, fontSize: fontSize.md, color: colors.text, paddingVertical: 0 },
  errorText: { fontSize: fontSize.sm, color: colors.error, marginTop: spacing.xs, marginLeft: spacing.xs },
  submitButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: spacing.lg, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, ...shadows.primaryMd, marginBottom: spacing.lg },
  submitButtonDisabled: { opacity: 0.7 },
  submitButtonText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  backToLogin: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, gap: spacing.xs },
  backToLoginText: { color: colors.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  successContainer: { alignItems: 'center', paddingVertical: spacing.lg },
  successIconContainer: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.successSubtle, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xl },
  successTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.dark, marginBottom: spacing.md, textAlign: 'center' },
  successText: { fontSize: fontSize.md, color: colors.text, textAlign: 'center', marginBottom: spacing.md, lineHeight: 22 },
  successNote: { fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
  tryAgainButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySubtle, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm, width: '100%', marginBottom: spacing.md },
  tryAgainText: { color: colors.primary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  loginButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm, width: '100%', ...shadows.primaryMd },
  loginButtonText: { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  divider: { marginVertical: spacing.xl },
  dividerLine: { height: 1, backgroundColor: colors.light },
  signInRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  signInText: { fontSize: fontSize.md, color: colors.textSecondary },
  signInLink: { fontSize: fontSize.md, color: colors.primary, fontWeight: fontWeight.bold },
});
