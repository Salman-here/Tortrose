import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,

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
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../utils/feedback';
import api, { API_ENDPOINTS } from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import Loader from '../components/common/Loader';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
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
  const [inlineNotice, setInlineNotice] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get(API_ENDPOINTS.USER_WHATSAPP.STATUS);
      setStatus(res.data || {});
      setNumber(res.data?.whatsappNumber || '');
      setInlineNotice(null);
    } catch (error) {
      setInlineNotice({ type: 'error', text: error.response?.data?.msg || 'We could not load your WhatsApp connection.' });
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
      setInlineNotice({ type: 'error', text: 'Enter a valid WhatsApp number with country code, for example +923001234567.' });
      return;
    }
    setInlineNotice(null);
    setSending(true);
    try {
      await api.post(API_ENDPOINTS.USER_WHATSAPP.SEND_OTP, { whatsappNumber: normalized });
      setNumber(normalized);
      setOtpSent(true);
      setOtp('');
      startCooldown();
      Feedback.show({ type: 'success', text1: 'Verification code sent on WhatsApp' });
    } catch (error) {
      setInlineNotice({ type: 'error', text: error.response?.data?.msg || 'We could not send the verification code.' });
    } finally {
      setSending(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.length !== 6) {
      setInlineNotice({ type: 'error', text: 'Enter the complete 6-digit verification code.' });
      return;
    }
    setInlineNotice(null);
    setVerifying(true);
    try {
      const res = await api.post(API_ENDPOINTS.USER_WHATSAPP.VERIFY_OTP, { whatsappNumber: number, otp });
      Feedback.show({ type: 'success', text1: res.data?.msg || 'WhatsApp connected' });
      setOtpSent(false);
      setOtp('');
      await fetchStatus();
    } catch (error) {
      setInlineNotice({ type: 'error', text: error.response?.data?.msg || 'That verification code is not valid.' });
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
            setInlineNotice({ type: 'error', text: error.response?.data?.msg || 'We could not unlink WhatsApp.' });
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
    else setInlineNotice({ type: 'error', text: 'WhatsApp could not be opened on this device.' });
  };

  if (loading) {
    return (
      <GlassBackground>
        <PremiumBackHeader
          title="WhatsApp AI"
          subtitle="Shopping and order updates"
          icon="logo-whatsapp"
          rightIcon="shield-checkmark-outline"
          rightLabel="Private"
          onBack={() => navigation.goBack()}
        />
        <Loader fullScreen message="Loading WhatsApp settings..." />
      </GlassBackground>
    );
  }

  const verified = !!status?.verified;

  return (
    <GlassBackground>
      <PremiumBackHeader
        title="WhatsApp AI"
        subtitle="Shopping and order updates"
        icon="logo-whatsapp"
        rightIcon={verified ? 'checkmark-circle-outline' : 'shield-checkmark-outline'}
        rightLabel={verified ? 'Linked' : 'Private'}
        onBack={() => navigation.goBack()}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        >
          <GlassPanel variant="strong" style={styles.hero}>
            <LinearGradient
              colors={['rgba(34,197,94,0.20)', 'rgba(14,165,233,0.09)', 'rgba(99,102,241,0.12)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.heroIcon}>
              <Ionicons name="logo-whatsapp" size={28} color="#fff" />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>ROZARE ON WHATSAPP</Text>
              <Text style={styles.heroTitle}>Shop and stay updated by chat</Text>
              <Text style={styles.heroText}>
                Discover products with AI, receive order confirmations, and follow delivery progress from one verified number.
              </Text>
            </View>
          </GlassPanel>

          <View style={styles.steps}>
            {[
              { icon: 'call-outline', label: 'Add number' },
              { icon: 'shield-checkmark-outline', label: 'Verify' },
              { icon: 'sparkles-outline', label: 'Start chatting' },
            ].map((step, index) => (
              <React.Fragment key={step.label}>
                <View style={styles.stepItem}>
                  <View style={[styles.stepIcon, index === 0 && styles.stepIconActive]}>
                    <Ionicons name={step.icon} size={15} color={index === 0 ? '#fff' : palette.colors.primary} />
                  </View>
                  <Text style={styles.stepText}>{step.label}</Text>
                </View>
                {index < 2 && <View style={styles.stepLine} />}
              </React.Fragment>
            ))}
          </View>

          {!!inlineNotice && (
            <View style={[styles.inlineNotice, inlineNotice.type === 'error' && styles.inlineNoticeError]}>
              <Ionicons
                name={inlineNotice.type === 'error' ? 'alert-circle-outline' : 'information-circle-outline'}
                size={18}
                color={inlineNotice.type === 'error' ? palette.colors.error : palette.colors.primary}
              />
              <Text style={[styles.inlineNoticeText, inlineNotice.type === 'error' && { color: palette.colors.error }]}>
                {inlineNotice.text}
              </Text>
              <TouchableOpacity onPress={() => setInlineNotice(null)} hitSlop={8}>
                <Ionicons name="close" size={17} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}

          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <Ionicons name="phone-portrait-outline" size={19} color="#22C55E" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Your buyer connection</Text>
                <Text style={styles.sectionSubtitle}>Used for AI shopping and personal order updates</Text>
              </View>
            </View>
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
              textContentType="telephoneNumber"
              autoComplete="tel"
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
              <View style={[styles.sectionIcon, { backgroundColor: `${palette.colors.primary}14` }]}>
                <Ionicons name="sparkles-outline" size={20} color={palette.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sectionTitle}>Rozare AI shopping line</Text>
                <Text style={styles.sectionSubtitle}>Your shortcut to conversational shopping</Text>
              </View>
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
  scroll: { padding: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xxl * 2 },
  hero: { minHeight: 154, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, padding: spacing.lg, marginBottom: spacing.md },
  heroIcon: { width: 62, height: 62, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#22C55E', borderWidth: 1, borderColor: 'rgba(255,255,255,0.64)', shadowColor: '#16A34A', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.28, shadowRadius: 18, elevation: 8 },
  heroCopy: { flex: 1 },
  heroEyebrow: { fontSize: 9, letterSpacing: 1.1, fontWeight: fontWeight.extrabold, color: '#16A34A', marginBottom: spacing.xs },
  heroTitle: { ...typography.h4, color: p.colors.text, lineHeight: 24 },
  heroText: { ...typography.caption, color: p.colors.textSecondary, lineHeight: 17, marginTop: spacing.xs },
  steps: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.md },
  stepItem: { alignItems: 'center', minWidth: 70 },
  stepIcon: { width: 30, height: 30, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  stepIconActive: { backgroundColor: '#22C55E', borderColor: '#22C55E' },
  stepText: { marginTop: 4, fontSize: 9, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  stepLine: { flex: 1, height: 1, backgroundColor: p.glass.borderStrong, marginHorizontal: 2, marginBottom: 16 },
  inlineNotice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: `${p.colors.primary}35`, backgroundColor: `${p.colors.primary}0F`, marginBottom: spacing.md },
  inlineNoticeError: { borderColor: `${p.colors.error}35`, backgroundColor: `${p.colors.error}0D` },
  inlineNoticeText: { flex: 1, ...typography.caption, color: p.colors.text, lineHeight: 17 },
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
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  sectionIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,197,94,0.12)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.20)' },
  sectionTitle: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.lg },
  sectionSubtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  paragraph: { ...typography.bodySmall, color: p.colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  aiNumberBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  aiNumber: { ...typography.bodySemibold, color: p.colors.text, marginTop: 3 },
  helperText: { ...typography.caption, color: p.colors.textSecondary, marginTop: 4 },
  openButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, minHeight: 42, borderRadius: borderRadius.lg, backgroundColor: '#22C55E' },
  openButtonText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.semibold },
});
