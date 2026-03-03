import React, { useState, useRef } from 'react';
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
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../contexts/AuthContext';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight } from '../../styles/theme';

export default function LoginScreen({ navigation }) {
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
    if (result?.success) {
      navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
    }
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
    if (result.success) {
      navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
    }
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
              <View style={styles.logoIcon}>
                <Ionicons name="storefront" size={20} color={colors.white} />
              </View>
              <Text style={styles.logoText}>Tortrose</Text>
            </View>
            <View style={{ width: 40 }} />
          </View>

          {/* Hero Section */}
          <View style={styles.heroSection}>
            <Text style={styles.heroTitle}>Welcome Back! 👋</Text>
            <Text style={styles.heroSubtitle}>Sign in to your account to continue shopping</Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            {/* Email */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email Address</Text>
              <View style={[styles.inputContainer, emailFocused && styles.inputFocused, errors.email && styles.inputError]}>
                <Ionicons name="mail-outline" size={20} color={emailFocused ? colors.primary : colors.grayLight} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="john@example.com"
                  placeholderTextColor={colors.grayLight}
                  value={email}
                  onChangeText={(t) => { setEmail(t); setErrors(e => ({...e, email: null})); }}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onFocus={() => setEmailFocused(true)}
                  onBlur={() => setEmailFocused(false)}
                />
              </View>
              {errors.email && <Text style={styles.errorText}>{errors.email}</Text>}
            </View>

            {/* Password */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={[styles.inputContainer, passwordFocused && styles.inputFocused, errors.password && styles.inputError]}>
                <Ionicons name="lock-closed-outline" size={20} color={passwordFocused ? colors.primary : colors.grayLight} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor={colors.grayLight}
                  value={password}
                  onChangeText={(t) => { setPassword(t); setErrors(e => ({...e, password: null})); }}
                  secureTextEntry={!showPassword}
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.grayLight} />
                </TouchableOpacity>
              </View>
              {errors.password && <Text style={styles.errorText}>{errors.password}</Text>}
            </View>

            {/* Forgot Password */}
            <TouchableOpacity style={styles.forgotContainer} onPress={() => navigation.navigate('ForgotPassword')}>
              <Text style={styles.forgotText}>Forgot your password?</Text>
            </TouchableOpacity>

            {/* Sign In Button */}
            <TouchableOpacity style={[styles.loginButton, isLoading && styles.loginButtonDisabled]} onPress={handleLogin} disabled={isLoading} activeOpacity={0.85}>
              {isLoading ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <>
                  <Text style={styles.loginButtonText}>Sign In</Text>
                  <Ionicons name="arrow-forward" size={20} color={colors.white} />
                </>
              )}
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or continue with</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Google Sign-In Button */}
            <TouchableOpacity
              style={[styles.googleButton, googleLoading && styles.googleButtonDisabled]}
              onPress={handleGoogleSignIn}
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

            {/* Sign Up Link */}
            <View style={styles.signUpRow}>
              <Text style={styles.signUpText}>Don't have an account?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('SignUp')}>
                <Text style={styles.signUpLink}> Create Account</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Footer */}
          <Text style={styles.footerText}>By signing in, you agree to our Terms of Service and Privacy Policy</Text>
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
  heroSection: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl, paddingBottom: spacing.xxxl },
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: colors.white, marginBottom: spacing.sm },
  heroSubtitle: { fontSize: fontSize.md, color: 'rgba(255,255,255,0.75)', lineHeight: 22 },
  card: { backgroundColor: colors.white, borderTopLeftRadius: borderRadius.xxxl, borderTopRightRadius: borderRadius.xxxl, padding: spacing.xxl, paddingTop: spacing.xxxl, flex: 1, minHeight: 480 },
  inputGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dark, marginBottom: spacing.sm, letterSpacing: 0.3 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.lighter, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: colors.light, paddingHorizontal: spacing.md, height: 56 },
  inputFocused: { borderColor: colors.primary, backgroundColor: colors.primarySubtle },
  inputError: { borderColor: colors.error, backgroundColor: colors.errorSubtle },
  inputIcon: { marginRight: spacing.sm },
  input: { flex: 1, fontSize: fontSize.md, color: colors.text, paddingVertical: 0 },
  eyeButton: { padding: spacing.sm },
  errorText: { fontSize: fontSize.sm, color: colors.error, marginTop: spacing.xs, marginLeft: spacing.xs },
  forgotContainer: { alignSelf: 'flex-end', marginBottom: spacing.lg, marginTop: -spacing.sm },
  forgotText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  loginButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: spacing.lg, borderRadius: borderRadius.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, ...shadows.primaryMd, marginBottom: spacing.xl },
  loginButtonDisabled: { opacity: 0.7 },
  loginButtonText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  divider: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.light },
  dividerText: { marginHorizontal: spacing.md, fontSize: fontSize.sm, color: colors.grayLight, fontWeight: fontWeight.medium },
  googleButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.light, borderRadius: borderRadius.xl, paddingVertical: spacing.md, paddingHorizontal: spacing.lg, marginBottom: spacing.xl, gap: spacing.sm, ...shadows.sm },
  googleButtonDisabled: { opacity: 0.7 },
  googleIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#4285F4', alignItems: 'center', justifyContent: 'center' },
  googleIconText: { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.bold, lineHeight: 20 },
  googleButtonText: { fontSize: fontSize.md, color: colors.dark, fontWeight: fontWeight.semibold },
  signUpRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
  signUpText: { fontSize: fontSize.md, color: colors.textSecondary },
  signUpLink: { fontSize: fontSize.md, color: colors.primary, fontWeight: fontWeight.bold },
  footerText: { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.5)', textAlign: 'center', paddingHorizontal: spacing.xxl, marginTop: spacing.xl },
});
