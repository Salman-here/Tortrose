/**
 * SellerSignUpScreen — 4-step seller registration
 * Step 1: Account Info, Step 2: Business Details, Step 3: Store Setup, Step 4: OTP
 * Liquid Glass Design
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { secureSet } from '../../utils/secureStorage';
import Feedback from '../../utils/feedback';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight, shadows } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const STEPS = ['Account', 'Business', 'Store', 'Verify'];

export default function SellerSignUpScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { setCurrentUser } = useAuth();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const [accountForm, setAccountForm] = useState({ username: '', email: '', password: '' });
  const [businessForm, setBusinessForm] = useState({ phoneNumber: '', businessName: '', address: '', city: '', country: '' });
  const [storeForm, setStoreForm] = useState({ storeName: '', storeDescription: '', sellerType: 'store', website: '', instagram: '', facebook: '', twitter: '', youtube: '', tiktok: '' });
  const [otp, setOtp] = useState('');

  const handleAccountNext = () => {
    if (!accountForm.username || !accountForm.email || !accountForm.password) { setError('Please fill in all fields'); return; }
    if (accountForm.password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setError(''); setStep(1);
  };

  const handleBusinessNext = () => {
    if (!businessForm.phoneNumber || businessForm.phoneNumber.trim().length < 10) { setError('Enter a valid phone number (at least 10 digits)'); return; }
    if (!businessForm.address || businessForm.address.trim().length < 5) { setError('Enter a valid address'); return; }
    if (!businessForm.city || businessForm.city.trim().length < 2) { setError('Enter your city'); return; }
    if (!businessForm.country || businessForm.country.trim().length < 2) { setError('Enter your country'); return; }
    setError(''); setStep(2);
  };

  const handleStoreNext = async (skip = false) => {
    if (!skip && storeForm.storeName && storeForm.storeName.trim().length < 3) {
      setError('Store name must be at least 3 characters'); return;
    }
    setLoading(true); setError('');
    try {
      const res = await api.post('/api/auth/seller/send-otp', { ...accountForm, ...businessForm });
      Feedback.show({ type: 'success', text1: 'OTP Sent!', text2: res.data.msg || 'Check your email' });
      setStep(3);
    } catch (err) {
      setError(err.response?.data?.msg || 'Failed to send OTP');
    } finally { setLoading(false); }
  };

  const handleVerifyOTP = async () => {
    if (!otp.trim()) { setError('Please enter the OTP'); return; }
    setLoading(true); setError('');
    try {
      const socialLinks = {};
      ['website', 'instagram', 'facebook', 'twitter', 'youtube', 'tiktok'].forEach(key => {
        if (storeForm[key]) socialLinks[key] = storeForm[key];
      });

      const res = await api.post('/api/auth/seller/verify-otp', {
        email: accountForm.email, otp, ...businessForm,
        storeName: storeForm.storeName?.trim() || '',
        storeDescription: storeForm.storeDescription?.trim() || '',
        sellerType: storeForm.sellerType || 'store',
        socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
      });
      await secureSet('jwtToken', res.data.token);
      setCurrentUser(res.data.user);
      Feedback.show({ type: 'success', text1: '🎉 Welcome!', text2: 'Seller account created successfully!' });
      setTimeout(() => navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }, { name: 'SellerDashboard' }] }), 1200);
    } catch (err) {
      setError(err.response?.data?.msg || 'Invalid OTP');
    } finally { setLoading(false); }
  };

  const renderStepIndicator = () => (
    <View style={styles.stepRow}>
      {STEPS.map((s, i) => (
        <View key={s} style={styles.stepItem}>
          <View style={[styles.stepDot, i <= step && styles.stepDotActive]}>
            {i < step ? <Ionicons name="checkmark" size={14} color="#fff" /> : <Text style={[styles.stepNum, i <= step && styles.stepNumActive]}>{i + 1}</Text>}
          </View>
          <Text style={[styles.stepLabel, i <= step && styles.stepLabelActive]}>{s}</Text>
          {i < STEPS.length - 1 && <View style={[styles.stepLine, i < step && styles.stepLineActive]} />}
        </View>
      ))}
    </View>
  );

  const renderInput = (value, onChange, placeholder, opts = {}) => (
    <View style={styles.inputGroup}>
      {opts.label && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
          {opts.icon && <Ionicons name={opts.icon} size={14} color={palette.colors.primary} />}
          <Text style={styles.label}>{opts.label}</Text>
        </View>
      )}
      <View style={styles.inputWrap}>
        <TextInput
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={palette.colors.grayLight}
          value={value}
          onChangeText={(v) => { onChange(v); if (error) setError(''); }}
          keyboardType={opts.keyboardType || 'default'}
          autoCapitalize={opts.autoCapitalize || 'sentences'}
          secureTextEntry={opts.secureTextEntry}
          multiline={opts.multiline}
        />
        {opts.rightIcon}
      </View>
    </View>
  );

  return (
    <GlassBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}>
          {/* Header */}
          <GlassPanel variant="floating" style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => step > 0 ? setStep(step - 1) : navigation.goBack()}>
              <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Seller Registration</Text>
              <Text style={styles.headerSubtitle}>Step {step + 1} of {STEPS.length}</Text>
            </View>
          </GlassPanel>

          {renderStepIndicator()}

          {error ? (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={16} color={palette.colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Step 1: Account */}
          {step === 0 && (
            <GlassPanel variant="card" style={styles.formCard}>
              <Text style={styles.formTitle}>Account Information</Text>
              <Text style={styles.formSubtitle}>Create your seller account credentials</Text>
              {renderInput(accountForm.username, v => setAccountForm(p => ({ ...p, username: v })), 'Full name', { label: 'Full Name *', icon: 'person-outline' })}
              {renderInput(accountForm.email, v => setAccountForm(p => ({ ...p, email: v })), 'seller@email.com', { label: 'Email *', icon: 'mail-outline', keyboardType: 'email-address', autoCapitalize: 'none' })}
              {renderInput(accountForm.password, v => setAccountForm(p => ({ ...p, password: v })), '••••••••', {
                label: 'Password *', icon: 'lock-closed-outline', secureTextEntry: !showPassword,
                rightIcon: <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={{ padding: 8 }}><Ionicons name={showPassword ? 'eye-off' : 'eye'} size={20} color="rgba(255,255,255,0.5)" /></TouchableOpacity>
              })}
              <TouchableOpacity style={styles.nextBtn} onPress={handleAccountNext} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                <Text style={styles.nextBtnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color="#fff" />
              </TouchableOpacity>
            </GlassPanel>
          )}

          {/* Step 2: Business */}
          {step === 1 && (
            <GlassPanel variant="card" style={styles.formCard}>
              <Text style={styles.formTitle}>Business Details</Text>
              <Text style={styles.formSubtitle}>Tell us about your business</Text>
              {renderInput(businessForm.phoneNumber, v => setBusinessForm(p => ({ ...p, phoneNumber: v })), '+1 234 567 8900', { label: 'Phone Number *', icon: 'call-outline', keyboardType: 'phone-pad' })}
              {renderInput(businessForm.businessName, v => setBusinessForm(p => ({ ...p, businessName: v })), 'Your brand name', { label: 'Business Name (Optional)', icon: 'storefront-outline' })}
              {renderInput(businessForm.address, v => setBusinessForm(p => ({ ...p, address: v })), 'Street address', { label: 'Address *', icon: 'location-outline' })}
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  {renderInput(businessForm.city, v => setBusinessForm(p => ({ ...p, city: v })), 'City', { label: 'City *' })}
                </View>
                <View style={{ flex: 1 }}>
                  {renderInput(businessForm.country, v => setBusinessForm(p => ({ ...p, country: v })), 'Country', { label: 'Country *' })}
                </View>
              </View>
              <TouchableOpacity style={styles.nextBtn} onPress={handleBusinessNext} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                <Text style={styles.nextBtnText}>Continue</Text>
                <Ionicons name="arrow-forward" size={18} color="#fff" />
              </TouchableOpacity>
            </GlassPanel>
          )}

          {/* Step 3: Store Setup */}
          {step === 2 && (
            <GlassPanel variant="card" style={styles.formCard}>
              <Text style={styles.formTitle}>Store Setup</Text>
              <Text style={styles.formSubtitle}>Set up your store (you can complete this later)</Text>
              {renderInput(storeForm.storeName, v => setStoreForm(p => ({ ...p, storeName: v })), 'My Awesome Store', { label: 'Store Name', icon: 'storefront-outline' })}
              {renderInput(storeForm.storeDescription, v => setStoreForm(p => ({ ...p, storeDescription: v })), 'What do you sell?', { label: 'Store Description', icon: 'document-text-outline', multiline: true })}

              <Text style={[styles.label, { marginTop: spacing.md, marginBottom: spacing.sm }]}>Listing Type</Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm }}>
                {['store', 'brand'].map(t => {
                  const active = storeForm.sellerType === t;
                  return (
                    <TouchableOpacity
                      key={t}
                      onPress={() => setStoreForm(p => ({ ...p, sellerType: t }))}
                      activeOpacity={0.8}
                      style={{
                        flex: 1,
                        paddingVertical: spacing.md,
                        borderRadius: 14,
                        alignItems: 'center',
                        flexDirection: 'row',
                        justifyContent: 'center',
                        gap: 6,
                        backgroundColor: active ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.06)',
                        borderWidth: 1,
                        borderColor: active ? palette.colors.primary : palette.glass.borderSubtle,
                      }}
                    >
                      <Ionicons name={t === 'brand' ? 'pricetag-outline' : 'storefront-outline'} size={16} color={active ? palette.colors.primary : palette.colors.textSecondary} />
                      <Text style={{ color: active ? palette.colors.primary : palette.colors.textSecondary, fontWeight: '600' }}>
                        {t === 'brand' ? 'Brand' : 'Store'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              
              <Text style={[styles.label, { marginTop: spacing.md, marginBottom: spacing.sm }]}>Social Links (Optional)</Text>
              {renderInput(storeForm.website, v => setStoreForm(p => ({ ...p, website: v })), 'https://yourwebsite.com', { label: 'Website', icon: 'globe-outline', autoCapitalize: 'none' })}
              {renderInput(storeForm.instagram, v => setStoreForm(p => ({ ...p, instagram: v })), '@yourbrand', { label: 'Instagram', icon: 'logo-instagram', autoCapitalize: 'none' })}
              {renderInput(storeForm.facebook, v => setStoreForm(p => ({ ...p, facebook: v })), 'facebook.com/yourbrand', { label: 'Facebook', icon: 'logo-facebook', autoCapitalize: 'none' })}
              {renderInput(storeForm.twitter, v => setStoreForm(p => ({ ...p, twitter: v })), '@yourbrand', { label: 'Twitter', icon: 'logo-twitter', autoCapitalize: 'none' })}

              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
                <TouchableOpacity style={styles.skipBtn} onPress={() => handleStoreNext(true)}>
                  {loading ? <ActivityIndicator color={palette.colors.text} size="small" /> : (
                    <><Ionicons name="play-skip-forward" size={16} color={palette.colors.text} /><Text style={styles.skipBtnText}>Skip</Text></>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={[styles.nextBtn, { flex: 2 }]} onPress={() => handleStoreNext(false)} disabled={loading} activeOpacity={0.85}>
                  <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                  {loading ? <ActivityIndicator color="#fff" size="small" /> : (
                    <><Text style={styles.nextBtnText}>Continue</Text><Ionicons name="arrow-forward" size={18} color="#fff" /></>
                  )}
                </TouchableOpacity>
              </View>
            </GlassPanel>
          )}

          {/* Step 4: OTP Verification */}
          {step === 3 && (
            <GlassPanel variant="card" style={styles.formCard}>
              <View style={{ alignItems: 'center', marginBottom: spacing.lg }}>
                <View style={styles.otpIcon}>
                  <Ionicons name="shield-checkmark" size={36} color={palette.colors.primary} />
                </View>
                <Text style={styles.formTitle}>Verify Your Email</Text>
                <Text style={styles.formSubtitle}>We sent a code to {accountForm.email}</Text>
              </View>
              {renderInput(otp, setOtp, 'Enter 6-digit OTP', { label: 'OTP Code *', icon: 'keypad-outline', keyboardType: 'number-pad' })}
              <TouchableOpacity style={[styles.nextBtn, loading && { opacity: 0.6 }]} onPress={handleVerifyOTP} disabled={loading} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                {loading ? <ActivityIndicator color="#fff" size="small" /> : (
                  <><Ionicons name="checkmark-circle" size={18} color="#fff" /><Text style={styles.nextBtnText}>Verify & Create Account</Text></>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={styles.resendBtn} onPress={() => handleStoreNext(true)} disabled={loading}>
                <Text style={styles.resendText}>Didn't receive? Resend OTP</Text>
              </TouchableOpacity>
            </GlassPanel>
          )}

          {/* Login Link */}
          <View style={styles.loginRow}>
            <Text style={styles.loginText}>Already have an account? </Text>
            <TouchableOpacity onPress={() => navigation.navigate('Login')}>
              <Text style={styles.loginLink}>Login</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginBottom: spacing.md },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  headerSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  stepRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg, paddingHorizontal: spacing.md },
  stepItem: { alignItems: 'center', flex: 1, position: 'relative' },
  stepDot: { width: 30, height: 30, borderRadius: 15, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: p.glass.borderSubtle },
  stepDotActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  stepNum: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  stepNumActive: { color: '#fff' },
  stepLabel: { fontSize: 10, color: p.colors.textSecondary, marginTop: 4, fontWeight: fontWeight.medium },
  stepLabelActive: { color: p.colors.primary },
  stepLine: { position: 'absolute', top: 15, left: '65%', right: '-35%', height: 2, backgroundColor: p.glass.borderSubtle },
  stepLineActive: { backgroundColor: p.colors.primary },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: 'rgba(239,68,68,0.1)', padding: spacing.md, borderRadius: 14, marginBottom: spacing.md },
  errorText: { fontSize: fontSize.sm, color: p.colors.error, flex: 1 },
  formCard: { padding: spacing.lg },
  formTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center' },
  formSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: spacing.lg },
  inputGroup: { marginBottom: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: 14, borderWidth: 1, borderColor: p.glass.borderSubtle },
  input: { flex: 1, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text },
  nextBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: 14, borderRadius: 16, marginTop: spacing.md, overflow: 'hidden', shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  nextBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  skipBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, backgroundColor: p.glass.bgSubtle, paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: p.glass.borderSubtle },
  skipBtnText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  otpIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  resendBtn: { alignItems: 'center', marginTop: spacing.lg },
  resendText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  loginRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.xl },
  loginText: { fontSize: fontSize.md, color: p.colors.textSecondary },
  loginLink: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.primary },
});
