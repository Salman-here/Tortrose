import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../../config/api';
import Feedback from '../../utils/feedback';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import PhoneNumberInput from '../../components/common/PhoneNumberInput';
import {
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
} from '../../components/seller/SellerUI';
import { borderRadius, fontSize, fontWeight, spacing, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { isValidPhoneNumber } from '../../utils/phoneNumber';
import useOtpCountdown from '../../hooks/useOtpCountdown';

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

export default function SellerWhatsAppSettingsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);

  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [whatsappVerified, setWhatsappVerified] = useState(false);
  const [changeDaysLeft, setChangeDaysLeft] = useState(0);
  const [nextWhatsAppChangeAt, setNextWhatsAppChangeAt] = useState(null);
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
  const [inlineNotice, setInlineNotice] = useState(null);
  const otpTimer = useOtpCountdown({ expirySeconds: 120, resendSeconds: 30 });
  const cooldown = otpTimer.resendRemaining;

  const fetchPrefs = async ({ showSkeleton = false } = {}) => {
    if (showSkeleton) setLoading(true);
    try {
      const response = await api.get('/api/seller-whatsapp/prefs');
      setWhatsappNumber(response.data?.whatsappNumber || '');
      setWhatsappVerified(!!response.data?.whatsappVerified);
      setChangeDaysLeft(Number(response.data?.whatsappChangeDaysLeft || 0));
      setNextWhatsAppChangeAt(response.data?.nextWhatsAppChangeAt || null);
      if (response.data?.prefs) setPrefs(response.data.prefs);
      setHasLoaded(true);
      setLoadError('');
      setInlineNotice(null);
    } catch (error) {
      setLoadError(error.response?.data?.msg || 'We could not load your seller WhatsApp settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPrefs({ showSkeleton: true });
  }, []);

  const savePrefs = async (updated) => {
    setSaving(true);
    try {
      const response = await api.put('/api/seller-whatsapp/prefs', updated);
      if (response.data?.prefs) setPrefs(response.data.prefs);
      setInlineNotice(null);
    } catch (error) {
      const message = error.response?.data?.msg || 'We could not save that alert preference.';
      await fetchPrefs();
      setInlineNotice({ type: 'error', text: message });
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
    otpTimer.start();
  };

  const activeNumber = () => String(showChange ? newNumber : whatsappNumber || '').trim();

  const sendOtp = async () => {
    if (otpSent && !otpTimer.canResend) {
      setInlineNotice({ type: 'error', text: `You can request another code in ${otpTimer.resendRemaining} seconds.` });
      return;
    }
    const number = activeNumber();
    if (!isValidPhoneNumber(number)) {
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
    if (otpTimer.isExpired) {
      setInlineNotice({ type: 'error', text: 'This verification code has expired. Request a new code.' });
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
      otpTimer.clear();
      await fetchPrefs();
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
    if (whatsappVerified && changeDaysLeft > 0) {
      setInlineNotice({
        type: 'error',
        text: `Your verified business number can be changed again in ${changeDaysLeft} day${changeDaysLeft === 1 ? '' : 's'}.`,
      });
      return;
    }
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
    otpTimer.clear();
    setInlineNotice(null);
  };

  if (loading) {
    return <SellerScreenSkeleton navigation={navigation} title="Seller WhatsApp" subtitle="Loading business alerts" icon="logo-whatsapp" variant="form" />;
  }

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
      <SellerScreenHeader
        navigation={navigation}
        title="Seller WhatsApp"
        subtitle="Business alerts and orders"
        icon="logo-whatsapp"
        rightIcon="refresh-outline"
        rightLabel="Refresh"
        onRightPress={fetchPrefs}
      />
        <KeyboardAwareFormScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {!!loadError && (
            <SellerInlineError
              compact
              title="WhatsApp settings unavailable"
              message={loadError}
              onRetry={fetchPrefs}
            />
          )}

          {!hasLoaded ? null : (
            <>
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

            {whatsappVerified && changeDaysLeft > 0 && (
              <View style={styles.changeCooldownNotice}>
                <Ionicons name="time-outline" size={16} color={palette.colors.warning} />
                <Text style={styles.changeCooldownText}>
                  Number changes unlock in {changeDaysLeft} day{changeDaysLeft === 1 ? '' : 's'}
                  {nextWhatsAppChangeAt ? ` (${new Date(nextWhatsAppChangeAt).toLocaleDateString()})` : ''}.
                </Text>
              </View>
            )}

            {!showChange && !otpSent && (
              <View style={styles.actions}>
                <TouchableOpacity
                  onPress={beginNumberFlow}
                  disabled={whatsappVerified && changeDaysLeft > 0}
                  style={[styles.secondaryButton, whatsappVerified && changeDaysLeft > 0 && styles.disabled]}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={whatsappNumber ? 'Change seller WhatsApp number' : 'Add seller WhatsApp number'}
                  accessibilityState={{ disabled: whatsappVerified && changeDaysLeft > 0 }}
                >
                  <Ionicons name="create-outline" size={16} color={palette.colors.text} />
                  <Text style={styles.secondaryButtonText}>
                    {whatsappVerified && changeDaysLeft > 0
                      ? `Change in ${changeDaysLeft}d`
                      : whatsappNumber ? 'Change number' : 'Add number'}
                  </Text>
                </TouchableOpacity>
                {!!whatsappNumber && !whatsappVerified && (
                  <TouchableOpacity
                    onPress={sendOtp}
                    disabled={sendingOtp}
                    style={[styles.primaryButton, sendingOtp && styles.disabled]}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel="Verify current seller WhatsApp number"
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
                <PhoneNumberInput
                  label="WhatsApp number"
                  value={newNumber}
                  onChangeText={setNewNumber}
                  helperText="Choose the country code, then enter the local number."
                  autoFocus
                  accessibilityLabel="Seller WhatsApp number with country code"
                  testID="seller-whatsapp-number"
                />
                <View style={styles.actions}>
                  <TouchableOpacity
                    onPress={sendOtp}
                    disabled={sendingOtp || !isValidPhoneNumber(newNumber)}
                    style={[styles.primaryButton, styles.flexButton, (sendingOtp || !isValidPhoneNumber(newNumber)) && styles.disabled]}
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
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  accessibilityLabel="WhatsApp verification code"
                />
                <Text style={[styles.otpExpiry, otpTimer.expiryRemaining <= 30 && styles.otpExpiryUrgent]}>
                  {otpTimer.isExpired ? 'Code expired. Request a new one.' : `Code expires in ${otpTimer.expiryLabel}`}
                </Text>
                <View style={styles.actions}>
                  <TouchableOpacity
                    onPress={verifyOtp}
                    disabled={verifyingOtp || otp.length !== 6 || otpTimer.isExpired}
                    style={[styles.primaryButton, styles.flexButton, (verifyingOtp || otp.length !== 6 || otpTimer.isExpired) && styles.disabled]}
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
                    <Text style={styles.secondaryButtonText}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend'}</Text>
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
              disabled={!whatsappVerified || saving}
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

          <View style={styles.criticalRow}>
            <Ionicons name="shield-checkmark-outline" size={16} color={palette.colors.warning} />
            <Text style={styles.criticalText}>
              Critical account blocks, trial expiry, and payment-failure alerts are always sent for account safety.
            </Text>
          </View>

          <View style={styles.privacyRow}>
            <Ionicons name="lock-closed-outline" size={15} color={palette.colors.success} />
            <Text style={styles.privacyText}>
              Seller alerts are private to your account and separate from your buyer AI connection.
            </Text>
          </View>
            </>
          )}
        </KeyboardAwareFormScrollView>
      </SafeAreaView>
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
        accessibilityLabel={label}
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
  safeArea: { flex: 1 },
  scroll: { padding: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xxl * 2 },
  hero: { minHeight: 158, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, padding: spacing.lg, marginBottom: spacing.md },
  heroIcon: { width: 62, height: 62, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: WHATSAPP_GREEN, borderWidth: 1, borderColor: 'rgba(255,255,255,0.64)', shadowColor: '#16A34A', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.28, shadowRadius: 18, elevation: 8 },
  heroCopy: { flex: 1 },
  heroEyebrow: { fontSize: 9, letterSpacing: 1.05, fontWeight: fontWeight.extrabold, color: '#16A34A', marginBottom: spacing.xs },
  heroTitle: { ...typography.h4, color: p.colors.text, lineHeight: 24 },
  heroText: { ...typography.caption, color: p.colors.textSecondary, lineHeight: 17, marginTop: spacing.xs },
  inlineNotice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: `${p.colors.error}35`, backgroundColor: `${p.colors.error}0D`, marginBottom: spacing.md },
  inlineNoticeText: { flex: 1, ...typography.caption, color: p.colors.error, lineHeight: 17 },
  changeCooldownNotice: { marginTop: spacing.md, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: `${p.colors.warning}30`, backgroundColor: p.colors.warningSubtle },
  changeCooldownText: { flex: 1, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
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
  otpExpiry: { marginTop: spacing.sm, color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, textAlign: 'center' },
  otpExpiryUrgent: { color: p.colors.error },
  primaryButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: spacing.lg, borderRadius: borderRadius.lg, backgroundColor: WHATSAPP_GREEN },
  primaryButtonText: { ...typography.bodySmall, color: '#fff', fontWeight: fontWeight.bold },
  secondaryButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: spacing.lg, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderStrong },
  secondaryButtonText: { ...typography.bodySmall, color: p.colors.text, fontWeight: fontWeight.semibold },
  iconButton: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center', borderRadius: borderRadius.lg, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderStrong },
  flexButton: { flex: 1 },
  disabled: { opacity: 0.48 },
  divider: { height: 1, backgroundColor: p.glass.borderSubtle, marginVertical: spacing.xs },
  criticalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.sm, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: `${p.colors.warning}10`, borderWidth: 1, borderColor: `${p.colors.warning}25` },
  criticalText: { flex: 1, ...typography.caption, color: p.colors.textSecondary, lineHeight: 17 },
  privacyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  privacyText: { flex: 1, ...typography.caption, color: p.colors.textSecondary, lineHeight: 17 },
});
