import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
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
import api from '../../config/api';
import Feedback from '../../utils/feedback';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import Loader from '../../components/common/Loader';
import PremiumBackHeader from '../../components/common/PremiumBackHeader';
import { borderRadius, fontSize, fontWeight, spacing, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const WHATSAPP_GREEN = '#22C55E';

const NOTIFICATION_CATEGORIES = [
  { key: 'newOrders', label: 'New orders', desc: 'When a customer places an order', icon: 'bag-handle-outline' },
  { key: 'orderUpdates', label: 'Order updates', desc: 'Buyer confirmations and cancellations', icon: 'git-compare-outline' },
  { key: 'subscriptionAlerts', label: 'Subscription', desc: 'Plan changes, renewals, and billing', icon: 'card-outline' },
  { key: 'bonusAlerts', label: 'Bonuses', desc: 'Bonus features and expiry reminders', icon: 'gift-outline' },
  { key: 'storeAlerts', label: 'Store status', desc: 'Verification and important store updates', icon: 'storefront-outline' },
];

const maskNumber = (value) => {
  if (!value) return 'Not connected';
  const text = String(value);
  if (text.length <= 5) return text;
  const prefixLength = text.length > 7 ? 3 : 1;
  return `${text.slice(0, prefixLength)}${'\u2022'.repeat(Math.max(3, text.length - prefixLength - 4))}${text.slice(-4)}`;
};

const normalizePhone = (value) => String(value || '').replace(/\s+/g, '');
const isValidPhone = (value) => /^\+?[1-9]\d{7,14}$/.test(normalizePhone(value));

export default function SellerWhatsAppSettingsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const cooldownRef = useRef(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [whatsappVerified, setWhatsappVerified] = useState(false);
  const [prefs, setPrefs] = useState({
    enabled: true,
    newOrders: true,
    orderUpdates: true,
    subscriptionAlerts: true,
    bonusAlerts: true,
    storeAlerts: true,
  });
  const [showChange, setShowChange] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [inlineNotice, setInlineNotice] = useState(null);

  const fetchPrefs = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/seller-whatsapp/prefs');
      setWhatsappNumber(response.data?.whatsappNumber || '');
      setWhatsappVerified(!!response.data?.whatsappVerified);
      if (response.data?.prefs) setPrefs(response.data.prefs);
      setInlineNotice(null);
    } catch (error) {
      setInlineNotice({
        type: 'error',
        text: error.response?.data?.msg || 'We could not load your seller WhatsApp settings.',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrefs();
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const savePrefs = async (updated) => {
    setSaving(true);
    try {
      await api.put('/api/seller-whatsapp/prefs', updated);
      setInlineNotice(null);
    } catch (error) {
      setInlineNotice({
        type: 'error',
        text: error.response?.data?.msg || 'We could not save that alert preference.',
      });
      await fetchPrefs();
    } finally {
      setSaving(false);
    }
  };

  const togglePref = (key) => {
    if (!whatsappVerified) {
      setInlineNotice({
        type: 'error',
        text: 'Verify your seller WhatsApp number before changing alert preferences.',
      });
      return;
    }
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    savePrefs(next);
  };

  const startCooldown = () => {
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    setCooldown(60);
    cooldownRef.current = setInterval(() => {
      setCooldown((current) => {
        if (current <= 1) {
          clearInterval(cooldownRef.current);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  };

  const activeNumber = () => normalizePhone(showChange ? newNumber : whatsappNumber);

  const sendOtp = async () => {
    const number = activeNumber();
    if (!isValidPhone(number)) {
      setInlineNotice({
        type: 'error',
        text: 'Enter a valid WhatsApp number with country code, for example +923001234567.',
      });
      return;
    }
    setInlineNotice(null);
    setSendingOtp(true);
    try {
      await api.post('/api/seller-whatsapp/send-otp', { whatsappNumber: number });
      setNewNumber(number);
      setOtpSent(true);
      setOtp('');
      startCooldown();
      Feedback.show({
        type: 'success',
        text1: 'Verification code sent',
        text2: 'Check your seller WhatsApp number',
      });
    } catch (error) {
      setInlineNotice({
        type: 'error',
        text: error.response?.data?.msg || 'We could not send the verification code.',
      });
    } finally {
      setSendingOtp(false);
    }
  };

  const verifyOtp = async () => {
    if (otp.length !== 6) {
      setInlineNotice({ type: 'error', text: 'Enter the complete 6-digit verification code.' });
      return;
    }
    const number = activeNumber();
    setInlineNotice(null);
    setVerifyingOtp(true);
    try {
      await api.post('/api/seller-whatsapp/verify-otp', { whatsappNumber: number, otp });
      setWhatsappNumber(number);
      setWhatsappVerified(true);
      setOtpSent(false);
      setShowChange(false);
      setNewNumber('');
      setOtp('');
      Feedback.show({
        type: 'success',
        text1: 'Seller WhatsApp verified',
        text2: 'Business alerts are ready',
      });
    } catch (error) {
      setInlineNotice({
        type: 'error',
        text: error.response?.data?.msg || 'That verification code is not valid.',
      });
    } finally {
      setVerifyingOtp(false);
    }
  };

  const beginNumberFlow = () => {
    setNewNumber(whatsappNumber || '');
    setShowChange(true);
    setOtpSent(false);
    setOtp('');
    setInlineNotice(null);
  };

  const cancelFlow = () => {
    setOtpSent(false);
    setShowChange(false);
    setNewNumber('');
    setOtp('');
    setCooldown(0);
    setInlineNotice(null);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
  };

  const header = (
    <PremiumBackHeader
      title="Seller WhatsApp"
      subtitle="Business alerts and orders"
      icon="logo-whatsapp"
      rightIcon={whatsappVerified ? 'checkmark-circle-outline' : 'briefcase-outline'}
      rightLabel={whatsappVerified ? 'Linked' : 'Seller'}
      onBack={() => navigation.goBack()}
    />
  );

  if (loading) {
    return (
      <GlassBackground>
        {header}
        <View style={styles.loading}><Loader /></View>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      {header}
      <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={0} style={styles.keyboardView}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        >
          <GlassPanel variant="strong" style={styles.hero}>
            <LinearGradient
              colors={['rgba(34,197,94,0.22)', 'rgba(14,165,233,0.08)', 'rgba(99,102,241,0.12)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.heroIcon}>
              <Ionicons name="briefcase-outline" size={27} color="#fff" />
            </View>
            <View style={styles.heroCopy}>
              <Text style={styles.heroEyebrow}>YOUR BUSINESS, IN REAL TIME</Text>
              <Text style={styles.heroTitle}>Important store activity on WhatsApp</Text>
              <Text style={styles.heroText}>
                Keep new orders, buyer updates, billing, and store alerts close without mixing them with the buyer AI line.
              </Text>
            </View>
          </GlassPanel>

          {!!inlineNotice && (
            <View style={styles.inlineNotice}>
              <Ionicons name="alert-circle-outline" size={18} color={palette.colors.error} />
              <Text style={styles.inlineNoticeText}>{inlineNotice.text}</Text>
              <TouchableOpacity onPress={() => setInlineNotice(null)} hitSlop={8}>
                <Ionicons name="close" size={17} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}

          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <Ionicons name="phone-portrait-outline" size={19} color={WHATSAPP_GREEN} />
              </View>
              <View style={styles.sectionCopy}>
                <Text style={styles.sectionTitle}>Seller alert number</Text>
                <Text style={styles.sub}>A dedicated, verified business connection</Text>
              </View>
            </View>

            <View style={styles.numberRow}>
              <View style={styles.numberCopy}>
                <Text style={styles.label}>CURRENT NUMBER</Text>
                <Text style={styles.numberText}>{maskNumber(whatsappNumber)}</Text>
              </View>
              <View style={[styles.badge, whatsappVerified ? styles.badgeVerified : styles.badgePending]}>
                <Ionicons
                  name={whatsappVerified ? 'checkmark-circle' : 'alert-circle'}
                  size={13}
                  color={whatsappVerified ? palette.colors.success : palette.colors.warning}
                />
                <Text style={[styles.badgeText, { color: whatsappVerified ? palette.colors.success : palette.colors.warning }]}>
                  {whatsappVerified ? 'Verified' : 'Not verified'}
                </Text>
              </View>
            </View>

            {!showChange && !otpSent && (
              <View style={styles.actions}>
                <TouchableOpacity onPress={beginNumberFlow} style={styles.secondaryButton} activeOpacity={0.8}>
                  <Ionicons name="create-outline" size={16} color={palette.colors.text} />
                  <Text style={styles.secondaryButtonText}>{whatsappNumber ? 'Change number' : 'Add number'}</Text>
                </TouchableOpacity>
                {!!whatsappNumber && !whatsappVerified && (
                  <TouchableOpacity
                    onPress={sendOtp}
                    disabled={sendingOtp}
                    style={[styles.primaryButton, sendingOtp && styles.disabled]}
                    activeOpacity={0.85}
                  >
                    {sendingOtp
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Ionicons name="shield-checkmark-outline" size={16} color="#fff" />}
                    <Text style={styles.primaryButtonText}>Verify</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {showChange && !otpSent && (
              <View style={styles.flowBox}>
                <Text style={styles.inputLabel}>NUMBER WITH COUNTRY CODE</Text>
                <View style={styles.inputShell}>
                  <Ionicons name="logo-whatsapp" size={18} color={WHATSAPP_GREEN} />
                  <TextInput
                    style={styles.input}
                    value={newNumber}
                    onChangeText={setNewNumber}
                    placeholder="+923001234567"
                    placeholderTextColor={palette.colors.textSecondary}
                    keyboardType="phone-pad"
                    textContentType="telephoneNumber"
                    autoComplete="tel"
                    autoFocus
                  />
                </View>
                <View style={styles.actions}>
                  <TouchableOpacity
                    onPress={sendOtp}
                    disabled={sendingOtp || !isValidPhone(newNumber)}
                    style={[styles.primaryButton, styles.flexButton, (sendingOtp || !isValidPhone(newNumber)) && styles.disabled]}
                    activeOpacity={0.85}
                  >
                    {sendingOtp
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Ionicons name="send-outline" size={16} color="#fff" />}
                    <Text style={styles.primaryButtonText}>Send code</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={cancelFlow} style={[styles.secondaryButton, styles.flexButton]} activeOpacity={0.8}>
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {otpSent && (
              <View style={styles.flowBox}>
                <Text style={styles.inputLabel}>6-DIGIT CODE FROM WHATSAPP</Text>
                <TextInput
                  style={styles.otpInput}
                  value={otp}
                  onChangeText={(value) => setOtp(value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  placeholderTextColor={palette.colors.textSecondary}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoFocus
                />
                <View style={styles.actions}>
                  <TouchableOpacity
                    onPress={verifyOtp}
                    disabled={verifyingOtp || otp.length !== 6}
                    style={[styles.primaryButton, styles.flexButton, (verifyingOtp || otp.length !== 6) && styles.disabled]}
                    activeOpacity={0.85}
                  >
                    {verifyingOtp
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Ionicons name="checkmark" size={16} color="#fff" />}
                    <Text style={styles.primaryButtonText}>Verify</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={sendOtp}
                    disabled={cooldown > 0 || sendingOtp}
                    style={[styles.secondaryButton, (cooldown > 0 || sendingOtp) && styles.disabled]}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.secondaryButtonText}>{cooldown > 0 ? `${cooldown}s` : 'Resend'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={cancelFlow} style={styles.iconButton} accessibilityLabel="Cancel verification">
                    <Ionicons name="close" size={18} color={palette.colors.textSecondary} />
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.section}>
            <ToggleRow
              palette={palette}
              icon={prefs.enabled ? 'notifications' : 'notifications-off'}
              label="WhatsApp business alerts"
              desc={whatsappVerified ? 'Master switch for the seller alert channel' : 'Verify your number to unlock alerts'}
              value={prefs.enabled && whatsappVerified}
              onToggle={() => togglePref('enabled')}
              disabled={!whatsappVerified}
            />
          </GlassPanel>

          <GlassPanel variant="card" style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIcon}>
                <Ionicons name="options-outline" size={19} color={WHATSAPP_GREEN} />
              </View>
              <View style={styles.sectionCopy}>
                <Text style={styles.sectionTitle}>Choose your alerts</Text>
                <Text style={styles.sub}>Fine tune what reaches your business number</Text>
              </View>
              {saving && <ActivityIndicator size="small" color={palette.colors.primary} />}
            </View>
            {NOTIFICATION_CATEGORIES.map((category, index) => (
              <View key={category.key}>
                <ToggleRow
                  palette={palette}
                  icon={category.icon}
                  label={category.label}
                  desc={category.desc}
                  value={prefs[category.key] && prefs.enabled && whatsappVerified}
                  onToggle={() => togglePref(category.key)}
                  disabled={!whatsappVerified || !prefs.enabled || saving}
                />
                {index < NOTIFICATION_CATEGORIES.length - 1 && <View style={styles.divider} />}
              </View>
            ))}
          </GlassPanel>

          <View style={styles.privacyRow}>
            <Ionicons name="lock-closed-outline" size={15} color={palette.colors.success} />
            <Text style={styles.privacyText}>
              Seller alerts are private to your account and separate from your buyer AI connection.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

function ToggleRow({ palette, icon, label, desc, value, onToggle, disabled }) {
  return (
    <View style={[rowStyles.row, disabled && rowStyles.disabled]}>
      <View style={[rowStyles.icon, { backgroundColor: 'rgba(34,197,94,0.12)' }]}>
        <Ionicons name={icon} size={18} color={WHATSAPP_GREEN} />
      </View>
      <View style={rowStyles.copy}>
        <Text style={[rowStyles.title, { color: palette.colors.text }]}>{label}</Text>
        {!!desc && <Text style={[rowStyles.description, { color: palette.colors.textSecondary }]}>{desc}</Text>}
      </View>
      <TouchableOpacity
        disabled={disabled}
        onPress={onToggle}
        activeOpacity={0.82}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
        style={[
          rowStyles.switch,
          {
            backgroundColor: value ? WHATSAPP_GREEN : palette.glass.bgStrong,
            borderColor: value ? WHATSAPP_GREEN : palette.glass.borderStrong,
          },
        ]}
      >
        <View style={[rowStyles.knob, value ? rowStyles.knobOn : rowStyles.knobOff]} />
      </TouchableOpacity>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  disabled: { opacity: 0.52 },
  icon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1 },
  title: { fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  description: { marginTop: 2, fontSize: fontSize.xs, lineHeight: 16 },
  switch: { width: 48, height: 28, borderRadius: 14, padding: 3, borderWidth: 1, justifyContent: 'center' },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', shadowColor: '#0F172A', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 2 },
  knobOn: { alignSelf: 'flex-end' },
  knobOff: { alignSelf: 'flex-start' },
});

const makeStyles = (p) => StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  keyboardView: { flex: 1 },
  scroll: { padding: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xxl * 2 },
  hero: { minHeight: 158, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, padding: spacing.lg, marginBottom: spacing.md },
  heroIcon: { width: 62, height: 62, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: WHATSAPP_GREEN, borderWidth: 1, borderColor: 'rgba(255,255,255,0.64)', shadowColor: '#16A34A', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.28, shadowRadius: 18, elevation: 8 },
  heroCopy: { flex: 1 },
  heroEyebrow: { fontSize: 9, letterSpacing: 1.05, fontWeight: fontWeight.extrabold, color: '#16A34A', marginBottom: spacing.xs },
  heroTitle: { ...typography.h4, color: p.colors.text, lineHeight: 24 },
  heroText: { ...typography.caption, color: p.colors.textSecondary, lineHeight: 17, marginTop: spacing.xs },
  inlineNotice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: `${p.colors.error}35`, backgroundColor: `${p.colors.error}0D`, marginBottom: spacing.md },
  inlineNoticeText: { flex: 1, ...typography.caption, color: p.colors.error, lineHeight: 17 },
  section: { padding: spacing.lg, marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  sectionIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,197,94,0.12)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.20)' },
  sectionCopy: { flex: 1 },
  sectionTitle: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.lg },
  sub: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  numberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  numberCopy: { flex: 1 },
  label: { fontSize: 9, color: p.colors.textSecondary, fontWeight: fontWeight.extrabold, letterSpacing: 0.8 },
  numberText: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 5, borderRadius: borderRadius.full },
  badgeVerified: { backgroundColor: `${p.colors.success}18` },
  badgePending: { backgroundColor: `${p.colors.warning}18` },
  badgeText: { fontSize: 10, fontWeight: fontWeight.bold },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  flowBox: { marginTop: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  inputLabel: { fontSize: 9, color: p.colors.textSecondary, fontWeight: fontWeight.extrabold, letterSpacing: 0.7, marginBottom: spacing.sm },
  inputShell: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderStrong },
  input: { flex: 1, minHeight: 48, color: p.colors.text, fontSize: fontSize.md },
  otpInput: { minHeight: 54, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderStrong, paddingHorizontal: spacing.md, color: p.colors.text, fontSize: 22, fontWeight: fontWeight.bold, letterSpacing: 8, textAlign: 'center' },
  primaryButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: spacing.lg, borderRadius: borderRadius.lg, backgroundColor: WHATSAPP_GREEN },
  primaryButtonText: { ...typography.bodySmall, color: '#fff', fontWeight: fontWeight.bold },
  secondaryButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: spacing.lg, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderStrong },
  secondaryButtonText: { ...typography.bodySmall, color: p.colors.text, fontWeight: fontWeight.semibold },
  iconButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: borderRadius.lg, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderStrong },
  flexButton: { flex: 1 },
  disabled: { opacity: 0.48 },
  divider: { height: 1, backgroundColor: p.glass.borderSubtle, marginVertical: spacing.xs },
  privacyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  privacyText: { flex: 1, ...typography.caption, color: p.colors.textSecondary, lineHeight: 17 },
});
