import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Feedback from '../utils/feedback';
import api, { API_ENDPOINTS } from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import Loader from '../components/common/Loader';
import { useTheme } from '../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing, typography } from '../styles/theme';

const maskNumber = (value) => {
  if (!value) return 'Not linked';
  const text = String(value);
  if (text.length <= 5) return text;
  return `${text.slice(0, 3)}${'*'.repeat(Math.max(3, text.length - 7))}${text.slice(-4)}`;
};

const isValidPhone = (value) => /^\+?[1-9]\d{7,14}$/.test(String(value || '').replace(/\s+/g, ''));

export default function UserWhatsAppSettingsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const cooldownRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState(null);
  const [number, setNumber] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get(API_ENDPOINTS.USER_WHATSAPP.STATUS);
      setStatus(res.data || {});
      setNumber(res.data?.whatsappNumber || '');
    } catch (error) {
      Alert.alert('WhatsApp AI', error.response?.data?.msg || 'Failed to load WhatsApp status');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, [fetchStatus]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStatus();
  }, [fetchStatus]);

  const startCooldown = () => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setCooldown(60);
    cooldownRef.current = setInterval(() => {
      setCooldown((previous) => {
        if (previous <= 1) {
          clearInterval(cooldownRef.current);
          return 0;
        }
        return previous - 1;
      });
    }, 1000);
  };

  const sendOtp = async () => {
    const normalized = number.replace(/\s+/g, '');
    if (!isValidPhone(normalized)) {
      Alert.alert('Invalid number', 'Enter a valid WhatsApp number with country code.');
      return;
    }
    setSending(true);
    try {
      await api.post(API_ENDPOINTS.USER_WHATSAPP.SEND_OTP, { whatsappNumber: normalized });
      setNumber(normalized);
      setOtpSent(true);
      setOtp('');
      startCooldown();
      Feedback.show({ type: 'success', text1: 'Verification code sent on WhatsApp' });
    } catch (error) {
      Alert.alert('WhatsApp AI', error.response?.data?.msg || 'Could not send verification code');
    } finally {
      setSending(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.length !== 6) {
      Alert.alert('Invalid code', 'Enter the 6-digit verification code.');
      return;
    }
    setVerifying(true);
    try {
      const res = await api.post(API_ENDPOINTS.USER_WHATSAPP.VERIFY_OTP, { whatsappNumber: number, otp });
      Feedback.show({ type: 'success', text1: res.data?.msg || 'WhatsApp connected' });
      setOtpSent(false);
      setOtp('');
      await fetchStatus();
    } catch (error) {
      Alert.alert('WhatsApp AI', error.response?.data?.msg || 'Invalid verification code');
    } finally {
      setVerifying(false);
    }
  };

  const unlink = () => {
    Alert.alert('Unlink WhatsApp', 'Unlink this WhatsApp number from your buyer account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unlink',
        style: 'destructive',
        onPress: async () => {
          setUnlinking(true);
          try {
            await api.post(API_ENDPOINTS.USER_WHATSAPP.UNLINK, {});
            Feedback.show({ type: 'success', text1: 'WhatsApp number unlinked' });
            setOtpSent(false);
            setOtp('');
            await fetchStatus();
          } catch (error) {
            Alert.alert('WhatsApp AI', error.response?.data?.msg || 'Failed to unlink WhatsApp');
          } finally {
            setUnlinking(false);
          }
        },
      },
    ]);
  };

  const openWhatsApp = async () => {
    if (!status?.verified || !status?.aiWhatsAppNumber) return;
    const phone = String(status.aiWhatsAppNumber).replace(/\D/g, '');
    const url = `https://wa.me/${phone}`;
    const canOpen = await Linking.canOpenURL(url);
    if (canOpen) Linking.openURL(url);
    else Alert.alert('WhatsApp AI', 'Could not open WhatsApp on this device.');
  };

  if (loading) {
    return (
      <GlassBackground>
        <Loader fullScreen message="Loading WhatsApp settings..." />
      </GlassBackground>
    );
  }

  const verified = !!status?.verified;

  return (
    <GlassBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        >
          <GlassPanel variant="floating" style={styles.header}>
            <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} activeOpacity={0.8}>
              <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
            </TouchableOpacity>
            <View style={styles.headerIcon}>
              <Ionicons name="logo-whatsapp" size={22} color="white" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>WhatsApp AI</Text>
              <Text style={styles.subtitle}>Connect your number to shop with Rozare AI</Text>
            </View>
          </GlassPanel>

          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.linkedRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Linked Number</Text>
                <Text style={styles.numberText}>{maskNumber(status?.whatsappNumber)}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: verified ? `${palette.colors.success}18` : `${palette.colors.warning}18` }]}>
                <Ionicons name={verified ? 'checkmark-circle' : 'alert-circle'} size={13} color={verified ? palette.colors.success : palette.colors.warning} />
                <Text style={[styles.statusText, { color: verified ? palette.colors.success : palette.colors.warning }]}>{verified ? 'Verified' : 'Not verified'}</Text>
              </View>
            </View>

            <Text style={styles.inputLabel}>WhatsApp number</Text>
            <TextInput
              style={styles.input}
              value={number}
              onChangeText={(value) => { setNumber(value); setOtpSent(false); }}
              placeholder="+923001234567"
              placeholderTextColor={palette.colors.textSecondary}
              keyboardType="phone-pad"
            />

            <TouchableOpacity
              style={[styles.primaryButton, (sending || cooldown > 0 || !isValidPhone(number)) && styles.disabledButton]}
              onPress={sendOtp}
              disabled={sending || cooldown > 0 || !isValidPhone(number)}
              activeOpacity={0.85}
            >
              {sending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name={cooldown > 0 ? 'refresh-outline' : 'send-outline'} size={18} color="#fff" />}
              <Text style={styles.primaryButtonText}>{cooldown > 0 ? `Resend in ${cooldown}s` : verified ? 'Change number' : 'Send code'}</Text>
            </TouchableOpacity>

            {otpSent && (
              <View style={styles.otpBox}>
                <Text style={styles.otpTitle}>Enter the 6-digit code sent to WhatsApp</Text>
                <TextInput
                  style={[styles.input, styles.otpInput]}
                  value={otp}
                  onChangeText={(value) => setOtp(value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={palette.colors.textSecondary}
                  keyboardType="number-pad"
                  maxLength={6}
                />
                <View style={styles.otpActions}>
                  <TouchableOpacity style={[styles.primaryButton, styles.flexButton, (verifying || otp.length !== 6) && styles.disabledButton]} onPress={verifyOtp} disabled={verifying || otp.length !== 6} activeOpacity={0.85}>
                    {verifying ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
                    <Text style={styles.primaryButtonText}>Verify</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.secondaryButton, styles.flexButton]} onPress={() => { setOtpSent(false); setOtp(''); }} activeOpacity={0.8}>
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {verified && (
              <TouchableOpacity style={[styles.dangerButton, unlinking && styles.disabledButton]} onPress={unlink} disabled={unlinking} activeOpacity={0.85}>
                {unlinking ? <ActivityIndicator size="small" color={palette.colors.error} /> : <Ionicons name="trash-outline" size={16} color={palette.colors.error} />}
                <Text style={styles.dangerButtonText}>Unlink WhatsApp</Text>
              </TouchableOpacity>
            )}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <Ionicons name="sparkles-outline" size={20} color={palette.colors.primary} />
              <Text style={styles.sectionTitle}>Buyer AI Line</Text>
            </View>
            <Text style={styles.paragraph}>
              Link and verify your WhatsApp number, then open the Rozare AI chat to discover products, place orders, track deliveries, and ask shopping questions.
            </Text>
            <View style={styles.aiNumberBox}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Rozare AI WhatsApp</Text>
                <Text style={styles.aiNumber}>{verified && status?.aiWhatsAppNumber ? status.aiWhatsAppNumber : 'Locked until verified'}</Text>
                <Text style={styles.helperText}>
                  {!verified
                    ? 'Verify your WhatsApp number to unlock this line.'
                    : status?.instanceConnected
                      ? 'Connected and ready.'
                      : 'The AI WhatsApp line is currently offline. Web chat still works.'}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.openButton, (!verified || !status?.aiWhatsAppNumber) && styles.disabledButton]}
                onPress={openWhatsApp}
                disabled={!verified || !status?.aiWhatsAppNumber}
                activeOpacity={0.85}
              >
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text style={styles.openButtonText}>Open</Text>
              </TouchableOpacity>
            </View>
          </GlassPanel>
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const makeStyles = (p) => StyleSheet.create({
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 2 },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  backButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#22C55E', justifyContent: 'center', alignItems: 'center' },
  title: { ...typography.h4, color: p.colors.text },
  subtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  section: { padding: spacing.lg, marginBottom: spacing.md },
  linkedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md },
  label: { ...typography.caption, color: p.colors.textSecondary, textTransform: 'uppercase', fontWeight: fontWeight.semibold },
  numberText: { ...typography.bodySemibold, color: p.colors.text, marginTop: 3, fontSize: fontSize.lg },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { ...typography.caption, fontWeight: fontWeight.bold },
  inputLabel: { ...typography.caption, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginBottom: spacing.xs },
  input: { minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, paddingHorizontal: spacing.md, color: p.colors.text, fontSize: fontSize.md, marginBottom: spacing.md },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: '#22C55E' },
  primaryButtonText: { ...typography.bodySemibold, color: 'white' },
  disabledButton: { opacity: 0.55 },
  otpBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  otpTitle: { ...typography.bodySmall, color: p.colors.text, marginBottom: spacing.sm },
  otpInput: { fontSize: 22, textAlign: 'center', letterSpacing: 8, fontWeight: fontWeight.bold },
  otpActions: { flexDirection: 'row', gap: spacing.sm },
  flexButton: { flex: 1 },
  secondaryButton: { alignItems: 'center', justifyContent: 'center', minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.borderSubtle },
  secondaryButtonText: { ...typography.bodySemibold, color: p.colors.text },
  dangerButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 44, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: `${p.colors.error}35`, backgroundColor: `${p.colors.error}10`, marginTop: spacing.md },
  dangerButtonText: { ...typography.bodySemibold, color: p.colors.error },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  sectionTitle: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.lg },
  paragraph: { ...typography.bodySmall, color: p.colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  aiNumberBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  aiNumber: { ...typography.bodySemibold, color: p.colors.text, marginTop: 3 },
  helperText: { ...typography.caption, color: p.colors.textSecondary, marginTop: 4 },
  openButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, minHeight: 42, borderRadius: borderRadius.lg, backgroundColor: '#22C55E' },
  openButtonText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.semibold },
});
