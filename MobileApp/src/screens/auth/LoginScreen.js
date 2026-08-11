/**
 * LoginScreen — Liquid Glass Design, matched to the website's auth layout:
 * centered glass card with the Rozare logo, a "Welcome Back" tag pill,
 * gradient Sign In button, and a glass Google button.
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, StatusBar,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import RozareLogo from '../../components/common/RozareLogo';
import GoogleSignInButton from '../../components/common/GoogleSignInButton';
import AuthTopHeader from '../../components/common/AuthTopHeader';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

export default function LoginScreen({ navigation, route }) {
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
  const returnTo = route?.params?.returnTo;

  const finishAuthentication = () => {
    navigation.reset({
      index: 0,
      routes: [{
        name: 'MainTabs',
        ...(returnTo === 'Cart' ? { params: { screen: 'Cart' } } : {}),
      }],
    });
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    const result = await googleSignIn();
    setGoogleLoading(false);
    if (result?.success) finishAuthentication();
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
    if (result.success) finishAuthentication();
  };

  return (
    <GlassBackground>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <KeyboardAwareFormScrollView contentContainerStyle={styles.scrollContent} bottomOffset={32}>
          <AuthTopHeader
            title="Sign In"
            subtitle="Continue to your Rozare account"
            icon="person-outline"
            onBack={() => navigation.goBack()}
            rightLabel="Secure"
          />

          {/* Form Card */}
          <GlassPanel variant="strong" style={styles.card}>
            <View style={styles.loginGlowTop} pointerEvents="none">
              <LinearGradient colors={['rgba(20,184,166,0.40)', 'rgba(14,165,233,0.04)']} style={styles.loginGlowFill} />
            </View>
            <View style={styles.loginGlowBottom} pointerEvents="none">
              <LinearGradient colors={['rgba(99,102,241,0.34)', 'rgba(168,85,247,0.03)']} style={styles.loginGlowFill} />
            </View>

            {/* Logo + heading */}
            <View style={styles.logoWrap}>
              <View style={styles.logoPlate}>
                <RozareLogo width={174} height={44} />
              </View>
            </View>
            <View style={styles.tagPill}>
              <Ionicons name="sparkles" size={12} color={palette.colors.primary} />
              <Text style={styles.tagPillText}>YOUR ROZARE ACCOUNT</Text>
            </View>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sync your cart, orders, favourites and AI shopping journey.</Text>

            <View style={styles.benefitStrip}>
              <View style={styles.benefitItem}>
                <Ionicons name="sync-outline" size={14} color={palette.colors.info} />
                <Text style={styles.benefitText}>Synced shopping</Text>
              </View>
              <View style={styles.benefitDivider} />
              <View style={styles.benefitItem}>
                <Ionicons name="lock-closed-outline" size={13} color={palette.colors.success} />
                <Text style={styles.benefitText}>Protected checkout</Text>
              </View>
            </View>

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
              <View style={styles.dividerLine} /><Text style={styles.dividerText}>or continue with</Text><View style={styles.dividerLine} />
            </View>

            <GoogleSignInButton
              onPress={handleGoogleSignIn}
              loading={googleLoading}
              label="Sign in with Google"
              style={styles.googleButton}
            />

            <View style={styles.signUpRow}>
              <Text style={styles.signUpText}>Don't have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('SignUp', { returnTo })}><Text style={styles.signUpLink}> Sign up</Text></TouchableOpacity>
            </View>
          </GlassPanel>

          <View style={styles.footer}>
            <Ionicons name="lock-closed-outline" size={12} color={palette.colors.textLight} />
            <Text style={styles.footerText}>By signing in, you agree to our Terms of Service and Privacy Policy</Text>
          </View>
      </KeyboardAwareFormScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  card: { width: '100%', maxWidth: 440, alignSelf: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl, alignItems: 'stretch', borderRadius: 30, marginTop: spacing.lg },
  loginGlowTop: { position: 'absolute', width: 190, height: 190, borderRadius: 95, top: -92, right: -56, opacity: 0.52 },
  loginGlowBottom: { position: 'absolute', width: 180, height: 180, borderRadius: 90, bottom: -96, left: -62, opacity: 0.38 },
  loginGlowFill: { flex: 1, borderRadius: 999 },
  logoWrap: { alignItems: 'center', marginBottom: spacing.lg },
  logoPlate: { minWidth: 204, minHeight: 62, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)', borderWidth: 1, borderColor: p.glass.borderSubtle, alignItems: 'center', justifyContent: 'center' },
  tagPill: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(99,102,241,0.10)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: borderRadius.full, marginBottom: spacing.md },
  tagPillText: { color: p.colors.primary, fontSize: 9, letterSpacing: 0.8, fontWeight: fontWeight.bold },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: p.colors.text, textAlign: 'center', marginBottom: spacing.sm, letterSpacing: -0.5 },
  subtitle: { fontSize: fontSize.md, lineHeight: 21, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg, paddingHorizontal: spacing.md },
  benefitStrip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.xl, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  benefitItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  benefitText: { fontSize: 10, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  benefitDivider: { width: 1, height: 18, backgroundColor: p.glass.borderSubtle },
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
  loginButton: { flexDirection: 'row', minHeight: 56, paddingVertical: spacing.md, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, overflow: 'hidden', marginBottom: spacing.xl, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  loginButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: p.glass.border },
  dividerText: { marginHorizontal: spacing.md, fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  googleButton: { marginBottom: spacing.xl },
  signUpRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  signUpText: { fontSize: fontSize.md, color: p.colors.textSecondary },
  signUpLink: { fontSize: fontSize.md, color: p.colors.primary, fontWeight: fontWeight.bold },
  footer: { maxWidth: 400, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: spacing.xl, marginTop: spacing.lg },
  footerText: { flexShrink: 1, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary, textAlign: 'center' },
});
