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
import { useAuth } from '../../contexts/AuthContext';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';

export default function SignUpScreen({ navigation }) {
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

  const handleGoogleSignUp = async () => {
    setGoogleLoading(true);
    const result = await googleSignIn();
    setGoogleLoading(false);
    if (result?.success) {
      navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
    }
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
    const result = await signup({ name, email, password });
    setIsLoading(false);
    if (result.success) navigation.navigate('OTPVerification', { email, name });
  };

  const setField = (field, value) => {
    if (field === 'name') setName(value);
    if (field === 'email') setEmail(value);
    if (field === 'password') setPassword(value);
    if (field === 'confirmPassword') setConfirmPassword(value);
    setErrors(e => ({ ...e, [field]: null }));
  };

  const inputProps = (field, extra = {}) => ({
    value: field === 'name' ? name : field === 'email' ? email : field === 'password' ? password : confirmPassword,
    onChangeText: (v) => setField(field, v),
    onFocus: () => setFocused(f => ({ ...f, [field]: true })),
    onBlur: () => setFocused(f => ({ ...f, [field]: false })),
    ...extra,
  });

  const inputStyle = (field) => [
    styles.inputContainer,
    focused[field] && styles.inputFocused,
    errors[field] && styles.inputError,
  ];

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
            <Text style={styles.heroTitle}>Create Account ✨</Text>
            <Text style={styles.heroSubtitle}>Join thousands of shoppers on Tortrose</Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            {/* Full Name */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Full Name</Text>
              <View style={inputStyle('name')}>
                <Ionicons name="person-outline" size={20} color={focused.name ? colors.primary : colors.grayLight} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="John Doe" placeholderTextColor={colors.grayLight} autoCapitalize="words" {...inputProps('name')} />
              </View>
              {errors.name && <Text style={styles.errorText}>{errors.name}</Text>}
            </View>

            {/* Email */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={inputStyle('email')}>
                <Ionicons name="mail-outline" size={20} color={focused.email ? colors.primary : colors.grayLight} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="john@example.com" placeholderTextColor={colors.grayLight} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} {...inputProps('email')} />
              </View>
              {errors.email && <Text style={styles.errorText}>{errors.email}</Text>}
            </View>

            {/* Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={inputStyle('password')}>
                <Ionicons name="lock-closed-outline" size={20} color={focused.password ? colors.primary : colors.grayLight} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="Min. 6 characters" placeholderTextColor={colors.grayLight} secureTextEntry={!showPassword} {...inputProps('password')} />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.grayLight} />
                </TouchableOpacity>
              </View>
              {errors.password && <Text style={styles.errorText}>{errors.password}</Text>}
            </View>

            {/* Confirm Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Confirm Password</Text>
              <View style={inputStyle('confirmPassword')}>
                <Ionicons name="shield-checkmark-outline" size={20} color={focused.confirmPassword ? colors.primary : colors.grayLight} style={styles.inputIcon} />
                <TextInput style={styles.input} placeholder="Re-enter password" placeholderTextColor={colors.grayLight} secureTextEntry={!showConfirmPassword} {...inputProps('confirmPassword')} />
                <TouchableOpacity onPress={() => setShowConfirmPassword(!showConfirmPassword)} style={styles.eyeButton}>
                  <Ionicons name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.grayLight} />
                </TouchableOpacity>
              </View>
              {errors.confirmPassword && <Text style={styles.errorText}>{errors.confirmPassword}</Text>}
            </View>

            {/* Create Account Button */}
            <TouchableOpacity style={[styles.signUpButton, isLoading && styles.signUpButtonDisabled]} onPress={handleSignUp} disabled={isLoading} activeOpacity={0.85}>
              {isLoading ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <>
                  <Text style={styles.signUpButtonText}>Create Account</Text>
                  <Ionicons name="arrow-forward" size={20} color={colors.white} />
                </>
              )}
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} /><Text style={styles.dividerText}>or continue with</Text><View style={styles.dividerLine} />
            </View>

            {/* Google Sign-Up Button */}
            <TouchableOpacity
              style={[styles.googleButton, googleLoading && styles.googleButtonDisabled]}
              onPress={handleGoogleSignUp}
              disabled={googleLoading}
              activeOpacity={0.85}
            >
              {googleLoading ? (
                <ActivityIndicator color="#4285F4" size="small" />
              ) : (
                <>
                  <View style={styles.googleIcon}>
                    <Text style={styles.googleIconText}>G</Text>
                  </View>
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </>
              )}
            </TouchableOpacity>

            {/* Login Link */}
            <View style={styles.loginRow}>
              <Text style={styles.loginText}>Already have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                <Text style={styles.loginLink}> Sign In</Text>
              </TouchableOpacity>
            </View>
          </View>

          <Text style={styles.footerText}>By creating an account, you agree to our Terms of Service and Privacy Policy</Text>
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
  heroSection: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xl, paddingBottom: spacing.xxxl },
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: colors.white, marginBottom: spacing.sm },
  heroSubtitle: { fontSize: fontSize.md, color: 'rgba(255,255,255,0.75)', lineHeight: 22 },
  card: { backgroundColor: colors.white, borderTopLeftRadius: borderRadius.xxxl, borderTopRightRadius: borderRadius.xxxl, padding: spacing.xxl, paddingTop: spacing.xxxl, flex: 1, minHeight: 580 },
  inputGroup: { marginBottom: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark, marginBottom: spacing.sm, letterSpacing: 0.3 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.lighter, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: colors.light, paddingHorizontal: spacing.md, height: 56 },
  inputFocused: { borderColor: colors.primary, backgroundColor: colors.primarySubtle },
  inputError: { borderColor: colors.error, backgroundColor: colors.errorSubtle },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, fontSize: fontSize.md, color: colors.text, paddingVertical: 0 },
  eyeButton: { padding: spacing.sm },
  errorText: { fontSize: fontSize.sm, color: colors.error, marginTop: spacing.xs, marginLeft: spacing.xs },
  signUpButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: spacing.lg, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, ...shadows.primaryMd, marginBottom: spacing.xl, marginTop: spacing.sm },
  signUpButtonDisabled: { opacity: 0.7 },
  signUpButtonText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.light },
  dividerText: { marginHorizontal: spacing.md, fontSize: fontSize.sm, color: colors.grayLight, fontWeight: fontWeight.medium },
  googleButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.light, borderRadius: borderRadius.xl, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xl, gap: spacing.sm, ...shadows.sm },
  googleButtonDisabled: { opacity: 0.7 },
  googleIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#4285F4', alignItems: 'center', justifyContent: 'center' },
  googleIconText: { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.bold, lineHeight: 20 },
  googleButtonText: { fontSize: fontSize.md, color: colors.dark, fontWeight: fontWeight.semibold },
  loginRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  loginText: { fontSize: fontSize.md, color: colors.textSecondary },
  loginLink: { fontSize: fontSize.md, color: colors.primary, fontWeight: fontWeight.bold },
  footerText: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.5)', textAlign: 'center', paddingHorizontal: spacing.xxl, marginTop: spacing.xl },
});
