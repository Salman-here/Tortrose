import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../../utils/feedback';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import { borderRadius, fontSize, fontWeight, shadows, spacing } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

export default function ResetPasswordScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const token = route?.params?.token || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [complete, setComplete] = useState(false);

  const validate = () => {
    const next = {};
    if (!token) next.token = 'This reset link is invalid or incomplete.';
    if (!password) next.password = 'Enter a new password.';
    else if (password.length < 8) next.password = 'Password must be at least 8 characters.';
    if (!confirmPassword) next.confirmPassword = 'Confirm your new password.';
    else if (password !== confirmPassword) next.confirmPassword = 'Passwords do not match.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const res = await api.post(`/api/password/reset/${token}`, { password });
      setComplete(true);
      Feedback.show({ type: 'success', text1: 'Password reset', text2: res.data?.msg || 'You can sign in now.' });
    } catch (error) {
      const msg = error.response?.data?.msg || 'Reset link is invalid or expired.';
      setErrors({ form: msg });
      Feedback.show({ type: 'error', text1: 'Reset failed', text2: msg });
    } finally {
      setLoading(false);
    }
  };

  const renderField = (label, value, onChangeText, show, setShow, keyName, placeholder) => (
    <View style={styles.fieldGroup}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, errors[keyName] && styles.inputWrapError]}>
        <Ionicons name="lock-closed-outline" size={18} color={errors[keyName] ? palette.colors.error : palette.colors.textLight} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={(text) => {
            onChangeText(text);
            if (errors[keyName] || errors.form) setErrors(prev => ({ ...prev, [keyName]: null, form: null }));
          }}
          placeholder={placeholder}
          placeholderTextColor={palette.colors.textLight}
          secureTextEntry={!show}
          autoCapitalize="none"
          editable={!loading && !complete}
        />
        <TouchableOpacity onPress={() => setShow(!show)} style={styles.eyeButton} accessibilityLabel={show ? 'Hide password' : 'Show password'}>
          <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color={palette.colors.textLight} />
        </TouchableOpacity>
      </View>
      {!!errors[keyName] && <Text style={styles.errorText}>{errors[keyName]}</Text>}
    </View>
  );

  return (
    <GlassBackground>
      <KeyboardAwareFormScrollView contentContainerStyle={styles.container} bottomOffset={32}>
          <GlassPanel variant="floating" style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.navigate('Login')}>
              <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Reset Password</Text>
            <View style={{ width: 36 }} />
          </GlassPanel>

          <GlassPanel variant="strong" style={styles.hero}>
            <View style={styles.heroIcon}>
              <Ionicons name={complete ? 'checkmark-circle' : 'shield-checkmark-outline'} size={34} color={complete ? palette.colors.success : palette.colors.primary} />
            </View>
            <Text style={styles.heroTitle}>{complete ? 'Password Updated' : 'Create a New Password'}</Text>
            <Text style={styles.heroSub}>
              {complete ? 'Your account is ready. Sign in with your new password.' : 'Use at least 8 characters for better account security.'}
            </Text>
          </GlassPanel>

          <GlassPanel variant="card" style={styles.card}>
            {!!errors.token && <Text style={styles.formError}>{errors.token}</Text>}
            {!!errors.form && <Text style={styles.formError}>{errors.form}</Text>}

            {!complete ? (
              <>
                {renderField('New Password', password, setPassword, showPassword, setShowPassword, 'password', 'At least 8 characters')}
                {renderField('Confirm Password', confirmPassword, setConfirmPassword, showConfirm, setShowConfirm, 'confirmPassword', 'Repeat new password')}
                <TouchableOpacity style={[styles.submitBtn, loading && styles.disabledBtn]} onPress={submit} disabled={loading} activeOpacity={0.85}>
                  <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                  {loading ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />
                      <Text style={styles.submitText}>Reset Password</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={styles.submitBtn} onPress={() => navigation.navigate('Login')} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                <Text style={styles.submitText}>Go to Sign In</Text>
                <Ionicons name="arrow-forward" size={18} color="#fff" />
              </TouchableOpacity>
            )}
          </GlassPanel>
      </KeyboardAwareFormScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flexGrow: 1, padding: spacing.md, paddingBottom: spacing.xxxl },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  hero: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  heroIcon: { width: 66, height: 66, borderRadius: 33, backgroundColor: p.colors.primarySubtle, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center', marginBottom: spacing.xs },
  heroSub: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  card: { padding: spacing.lg },
  fieldGroup: { marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.sm },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  inputWrapError: { borderColor: p.colors.error, backgroundColor: p.colors.errorSubtle },
  input: { flex: 1, fontSize: fontSize.md, color: p.colors.text, paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm },
  eyeButton: { padding: spacing.xs },
  errorText: { marginTop: 4, color: p.colors.error, fontSize: fontSize.xs },
  formError: { padding: spacing.sm, borderRadius: borderRadius.md, backgroundColor: p.colors.errorSubtle, color: p.colors.error, marginBottom: spacing.md, fontSize: fontSize.sm },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 52, borderRadius: borderRadius.lg, overflow: 'hidden', shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  disabledBtn: { opacity: 0.65 },
});
