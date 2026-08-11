/**
 * SignUpScreen — Liquid Glass Design
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

export default function SignUpScreen({ navigation, route }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);

  const { signup, googleSignIn } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [focused, setFocused] = useState({});
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

  const handleGoogleSignUp = async () => {
    setGoogleLoading(true);
    const result = await googleSignIn();
    setGoogleLoading(false);
    if (result?.success) finishAuthentication();
  };

  const handleSignUp = async () => {
    const newErrors = {};
    if (!name.trim()) newErrors.name = 'Full name is required';
    if (!email.trim()) newErrors.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) newErrors.email = 'Enter a valid email';
    if (!password.trim()) newErrors.password = 'Password is required';
    else if (password.length < 6) newErrors.password = 'Password must be at least 6 characters';
    if (!confirmPassword.trim()) newErrors.confirmPassword = 'Please confirm your password';
    else if (password !== confirmPassword) newErrors.confirmPassword = 'Passwords do not match';
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }
    setErrors({});
    setIsLoading(true);
    const result = await signup({ username: name.trim(), email: email.trim(), password });
    setIsLoading(false);
    if (result.success) navigation.navigate('OTPVerification', {
      email: email.trim(),
      name: name.trim(),
      password,
      returnTo,
    });
  };

  const setField = (field, value) => {
    if (field === 'name') setName(value);
    if (field === 'email') setEmail(value);
    if (field === 'password') setPassword(value);
    if (field === 'confirmPassword') setConfirmPassword(value);
    setErrors(e => ({ ...e, [field]: null }));
  };

  const inputStyle = (field) => [
    styles.inputContainer,
    focused[field] && styles.inputFocused,
    errors[field] && styles.inputError,
  ];

  const fields = [
    { field: 'name', label: 'Full Name', placeholder: 'John Doe', icon: 'person-outline', autoCapitalize: 'words' },
    { field: 'email', label: 'Email Address', placeholder: 'john@example.com', icon: 'mail-outline', keyboardType: 'email-address', autoCapitalize: 'none' },
  ];

  return (
    <GlassBackground>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      <KeyboardAwareFormScrollView contentContainerStyle={styles.scrollContent} bottomOffset={32}>
          <AuthTopHeader
            title="Create Account"
            subtitle="Start your synced shopping journey"
            icon="person-add-outline"
            onBack={() => navigation.goBack()}
            rightLabel="Protected"
          />

          {/* Form Card */}
          <GlassPanel variant="strong" style={styles.card}>
            <View style={styles.signupGlowTop} pointerEvents="none">
              <LinearGradient colors={['rgba(20,184,166,0.40)', 'rgba(14,165,233,0.04)']} style={styles.signupGlowFill} />
            </View>
            <View style={styles.signupGlowBottom} pointerEvents="none">
              <LinearGradient colors={['rgba(99,102,241,0.32)', 'rgba(168,85,247,0.03)']} style={styles.signupGlowFill} />
            </View>

            {/* Logo + heading */}
            <View style={styles.logoWrap}>
              <View style={styles.logoPlate}>
                <RozareLogo width={170} height={44} />
              </View>
            </View>
            <View style={styles.tagPill}>
              <Ionicons name="sparkles" size={12} color={palette.colors.primary} />
              <Text style={styles.tagPillText}>JOIN ROZARE</Text>
            </View>
            <Text style={styles.title}>Your shopping, remembered</Text>
            <Text style={styles.subtitle}>Create one account for your cart, favourites, trusted stores, orders and AI shopping.</Text>

            <View style={styles.benefitStrip}>
              <View style={styles.benefitItem}>
                <Ionicons name="sync-outline" size={14} color={palette.colors.info} />
                <Text style={styles.benefitText}>Sync every device</Text>
              </View>
              <View style={styles.benefitDivider} />
              <View style={styles.benefitItem}>
                <Ionicons name="logo-whatsapp" size={14} color={palette.colors.success} />
                <Text style={styles.benefitText}>WhatsApp updates</Text>
              </View>
            </View>

            {fields.map(({ field, label, placeholder, icon, ...rest }) => (
              <View key={field} style={styles.inputGroup}>
                <Text style={styles.label}>{label}</Text>
                <View style={inputStyle(field)}>
                  <Ionicons name={icon} size={20} color={focused[field] ? palette.colors.primary : palette.colors.grayLight} style={styles.inputIcon} />
                  <TextInput
                    style={styles.input} placeholder={placeholder} placeholderTextColor={palette.colors.grayLight}
                    value={field === 'name' ? name : email}
                    onChangeText={(v) => setField(field, v)}
                    onFocus={() => setFocused(f => ({ ...f, [field]: true }))}
                    onBlur={() => setFocused(f => ({ ...f, [field]: false }))}
                    autoCorrect={false} {...rest}
                  />
                </View>
                {errors[field] && <Text style={styles.errorText}>{errors[field]}</Text>}
              </View>
            ))}

            {/* Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={inputStyle('password')}>
                <Ionicons name="lock-closed-outline" size={20} color={focused.password ? palette.colors.primary : palette.colors.grayLight} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="Min. 6 characters" placeholderTextColor={palette.colors.grayLight}
                  secureTextEntry={!showPassword} value={password} onChangeText={(v) => setField('password', v)}
                  onFocus={() => setFocused(f => ({ ...f, password: true }))} onBlur={() => setFocused(f => ({ ...f, password: false }))} />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={palette.colors.grayLight} />
                </TouchableOpacity>
              </View>
              {errors.password && <Text style={styles.errorText}>{errors.password}</Text>}
            </View>

            {/* Confirm Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Confirm Password</Text>
              <View style={inputStyle('confirmPassword')}>
                <Ionicons name="shield-checkmark-outline" size={20} color={focused.confirmPassword ? palette.colors.primary : palette.colors.grayLight} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="Re-enter password" placeholderTextColor={palette.colors.grayLight}
                  secureTextEntry={!showConfirmPassword} value={confirmPassword} onChangeText={(v) => setField('confirmPassword', v)}
                  onFocus={() => setFocused(f => ({ ...f, confirmPassword: true }))} onBlur={() => setFocused(f => ({ ...f, confirmPassword: false }))} />
                <TouchableOpacity onPress={() => setShowConfirmPassword(!showConfirmPassword)} style={styles.eyeButton}>
                  <Ionicons name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={palette.colors.grayLight} />
                </TouchableOpacity>
              </View>
              {errors.confirmPassword && <Text style={styles.errorText}>{errors.confirmPassword}</Text>}
            </View>

            <TouchableOpacity style={styles.signUpButton} onPress={handleSignUp} disabled={isLoading} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              {isLoading ? <ActivityIndicator color="#fff" size="small" /> : (
                <><Text style={styles.signUpButtonText}>Create Account</Text><Ionicons name="arrow-forward" size={20} color="#fff" /></>
              )}
            </TouchableOpacity>

            <View style={styles.divider}>
              <View style={styles.dividerLine} /><Text style={styles.dividerText}>or continue with</Text><View style={styles.dividerLine} />
            </View>

            <GoogleSignInButton
              onPress={handleGoogleSignUp}
              loading={googleLoading}
              label="Sign up with Google"
              style={styles.googleButton}
            />

            <View style={styles.loginRow}>
              <Text style={styles.loginText}>Already have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login', { returnTo })}><Text style={styles.loginLink}> Sign In</Text></TouchableOpacity>
            </View>

            <View style={[styles.loginRow, { marginTop: spacing.md }]}>
              <Text style={styles.loginText}>Want to sell?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('BecomeSeller')}><Text style={styles.loginLink}> Become a seller</Text></TouchableOpacity>
            </View>
          </GlassPanel>

          <Text style={styles.footerText}>By creating an account, you agree to our Terms of Service and Privacy Policy</Text>
      </KeyboardAwareFormScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  keyboardView: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  card: { width: '100%', maxWidth: 440, alignSelf: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl, marginTop: spacing.lg, marginBottom: spacing.lg, borderRadius: 30 },
  signupGlowTop: { position: 'absolute', width: 190, height: 190, borderRadius: 95, top: -92, right: -56, opacity: 0.52 },
  signupGlowBottom: { position: 'absolute', width: 180, height: 180, borderRadius: 90, bottom: -96, left: -62, opacity: 0.38 },
  signupGlowFill: { flex: 1, borderRadius: 999 },
  logoWrap: { alignItems: 'center', marginBottom: spacing.lg },
  logoPlate: { minWidth: 202, minHeight: 62, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.22)', borderWidth: 1, borderColor: p.glass.borderSubtle, alignItems: 'center', justifyContent: 'center' },
  tagPill: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(99,102,241,0.12)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: borderRadius.full, marginBottom: spacing.md },
  tagPillText: { color: p.colors.primary, fontSize: 9, letterSpacing: 0.8, fontWeight: fontWeight.bold },
  title: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: p.colors.text, textAlign: 'center', marginBottom: spacing.sm, letterSpacing: -0.5 },
  subtitle: { fontSize: fontSize.md, lineHeight: 21, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg, paddingHorizontal: spacing.sm },
  benefitStrip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, marginBottom: spacing.xl, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  benefitItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  benefitText: { fontSize: 9, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  benefitDivider: { width: 1, height: 18, backgroundColor: p.glass.borderSubtle },
  inputGroup: { marginBottom: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.sm, letterSpacing: 0.3 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: p.glass.border, paddingHorizontal: spacing.md, height: 56 },
  inputFocused: { borderColor: p.colors.primary, backgroundColor: p.glass.bgStrong },
  inputError: { borderColor: p.colors.error, backgroundColor: p.colors.errorSubtle },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, fontSize: fontSize.md, color: p.colors.text, paddingVertical: 0 },
  eyeButton: { padding: spacing.sm },
  errorText: { fontSize: fontSize.sm, color: p.colors.error, marginTop: spacing.xs, marginLeft: spacing.xs },
  signUpButton: { flexDirection: 'row', paddingVertical: spacing.lg, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, overflow: 'hidden', marginBottom: spacing.xl, marginTop: spacing.sm, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  signUpButtonText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: p.glass.border },
  dividerText: { marginHorizontal: spacing.md, fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  googleButton: { marginBottom: spacing.xl },
  loginRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  loginText: { fontSize: fontSize.md, color: p.colors.textSecondary },
  loginLink: { fontSize: fontSize.md, color: p.colors.primary, fontWeight: fontWeight.bold },
  footerText: { fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center', paddingHorizontal: spacing.xxl, marginTop: spacing.md },
});
