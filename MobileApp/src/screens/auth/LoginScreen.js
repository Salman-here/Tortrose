/**
 * LoginScreen — Liquid Glass Design, matched to the website's auth layout:
 * centered glass card with the Rozare logo, a "Welcome Back" tag pill,
 * gradient Sign In button, and a glass Google button.
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import RozareLogo from '../../components/common/RozareLogo';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

export default function LoginScreen({ navigation }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);

  const { login, googleSignIn } = useAuth();
  const [googleLoading, setGoogleLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [errors, setErrors] = useState({});

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    const result = await googleSignIn();
    setGoogleLoading(false);
    if (result?.success) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
  };

  const handleLogin = async () => {
    const newErrors = {};
    if (!email.trim()) newErrors.email = 'Email is required';
    if (!password.trim()) newErrors.password = 'Password is required';
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setErrors({});
    setIsLoading(true);
    const result = await login({ email, password });
    setIsLoading(false);
    if (result.success) navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
  };

  return (
    <GlassBackground>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardView}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {/* Home / back */}
          <TouchableOpacity style={styles.homeButton} onPress={() => navigation.goBack()}>
            <Ionicons name="arrow-back" size={18} color={palette.colors.primary} />
            <Text style={styles.homeButtonText}>Home</Text>
          </TouchableOpacity>

          {/* Form Card */}
          <GlassPanel variant="strong" style={styles.card}>
            {/* Logo + heading */}
            <View style={styles.logoWrap}>
              <RozareLogo width={158} height={42} />
            </View>
            <View style={styles.tagPill}>
              <Ionicons name="sparkles" size={12} color={palette.colors.primary} />
              <Text style={styles.tagPillText}>Welcome Back</Text>
            </View>
            <Text style={styles.title}>Sign In</Text>
            <Text style={styles.subtitle}>Continue to your account</Text>

            {/* Email */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={[styles.inputContainer, emailFocused && styles.inputFocused, errors.email && styles.inputError]}>
                <Ionicons name="mail-outline" size={20} color={emailFocused ? palette.colors.primary : palette.colors.grayLight} style={styles.inputIcon} />
                <TextInput
                  style={styles.input} placeholder="john@example.com" placeholderTextColor={palette.colors.grayLight}
                  value={email} onChangeText={(t) => { setEmail(t); setErrors(e => ({ ...e, email: null })); }}
                  keyboardType="email-address" autoCapitalize="none" autoCorrect={false}
                  onFocus={() => setEmailFocused(true)} onBlur={() => setEmailFocused(false)}
                />
              </View>
              {errors.email && <Text style={styles.errorText}>{errors.email}</Text>}
            </View>

            {/* Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={[styles.inputContainer, passwordFocused && styles.inputFocused, errors.password && styles.inputError]}>
                <Ionicons name="lock-closed-outline" size={20} color={passwordFocused ? palette.colors.primary : palette.colors.grayLight} style={styles.inputIcon} />
                <TextInput
                  style={styles.input} placeholder="Enter your password" placeholderTextColor={palette.colors.grayLight}
                  value={password} onChangeText={(t) => { setPassword(t); setErrors(e => ({ ...e, password: null })); }}
                  secureTextEntry={!showPassword}
                  onFocus={() => setPasswordFocused(true)} onBlur={() => setPasswordFocused(false)}
                />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={palette.colors.grayLight} />
                </TouchableOpacity>
              </View>
              {errors.password && <Text style={styles.errorText}>{errors.password}</Text>}
            </View>

            <TouchableOpacity style={styles.forgotContainer} onPress={() => navigation.navigate('ForgotPassword')}>
              <Text style={styles.forgotText}>Forgot your password?</Text>
            </TouchableOpacity>

            {/* Gradient Sign In */}
            <TouchableOpacity style={styles.loginButton} onPress={handleLogin} disabled={isLoading} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              {isLoading ? <ActivityIndicator color="#fff" size="small" /> : (
                <><Text style={styles.loginButtonText}>Sign In</Text><Ionicons name="arrow-forward" size={20} color="#fff" /></>
              )}
            </TouchableOpacity>

            <View style={styles.divider}>
              <View style={styles.dividerLine} /><Text style={styles.dividerText}>Or continue with</Text><View style={styles.dividerLine} />
            </View>

            <TouchableOpacity style={[styles.googleButton, googleLoading && styles.googleButtonDisabled]} onPress={handleGoogleSignIn} disabled={googleLoading} activeOpacity={0.85}>
              {googleLoading ? <ActivityIndicator color="#4285F4" size="small" /> : (
                <><View style={styles.googleIcon}><Text style={styles.googleIconText}>G</Text></View><Text style={styles.googleButtonText}>Sign in with Google</Text></>
              )}
            </TouchableOpacity>

            <View style={styles.signUpRow}>
              <Text style={styles.signUpText}>Don't have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('SignUp')}><Text style={styles.signUpLink}> Sign up</Text></TouchableOpacity>
            </View>
          </GlassPanel>

          <Text style={styles.footerText}>By signing in, you agree to our Terms of Service and Privacy Policy</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: spacing.xxxl, paddingHorizontal: spacing.lg },
  homeButton: { position: 'absolute', top: spacing.lg, left: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, zIndex: 10 },
  homeButtonText: { color: p.colors.primary, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  card: { padding: spacing.xxl, alignItems: 'stretch' },
  logoWrap: { alignItems: 'center', marginBottom: spacing.md },
  tagPill: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: borderRadius.full, marginBottom: spacing.md },
  tagPillText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: p.colors.text, textAlign: 'center', marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.xl },
  inputGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.sm, letterSpacing: 0.3 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: p.glass.border, paddingHorizontal: spacing.md, height: 56 },
  inputFocused: { borderColor: p.colors.primary, backgroundColor: p.glass.bgStrong },
  inputError: { borderColor: p.colors.error, backgroundColor: p.colors.errorSubtle },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, fontSize: fontSize.md, color: p.colors.text, paddingVertical: 0 },
  eyeButton: { padding: spacing.sm },
  errorText: { fontSize: fontSize.sm, color: p.colors.error, marginTop: spacing.xs, marginLeft: spacing.xs },
  forgotContainer: { alignSelf: 'flex-end', marginBottom: spacing.lg, marginTop: -spacing.sm },
  forgotText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  loginButton: { flexDirection: 'row', paddingVertical: spacing.lg, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, overflow: 'hidden', marginBottom: spacing.xl, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  loginButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: p.glass.border },
  dividerText: { marginHorizontal: spacing.md, fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  googleButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgStrong, borderWidth: 1.5, borderColor: p.glass.border, borderRadius: borderRadius.xl, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xl, gap: spacing.sm },
  googleButtonDisabled: { opacity: 0.7 },
  googleIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#4285F4', alignItems: 'center', justifyContent: 'center' },
  googleIconText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold, lineHeight: 20 },
  googleButtonText: { fontSize: fontSize.md, color: p.colors.text, fontWeight: fontWeight.semibold },
  signUpRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  signUpText: { fontSize: fontSize.md, color: p.colors.textSecondary },
  signUpLink: { fontSize: fontSize.md, color: p.colors.primary, fontWeight: fontWeight.bold },
  footerText: { fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.xxl, marginTop: spacing.lg },
});
