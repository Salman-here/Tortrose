/**
 * SellerProfileScreen — Mobile parity for /seller-dashboard/profile
 * View account info + change WhatsApp number / Email with OTP verification.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, Platform, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Feedback from '../../utils/feedback';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import PhoneNumberInput from '../../components/common/PhoneNumberInput';
import {
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { spacing, fontSize, fontWeight, borderRadius, shadows, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { isValidPhoneNumber } from '../../utils/phoneNumber';
import useOtpCountdown, { formatOtpCountdown } from '../../hooks/useOtpCountdown';

export default function SellerProfileScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { fetchAndUpdateCurrentUser, replaceAuthToken } = useAuth();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');

  // WhatsApp change
  const [waOpen, setWaOpen] = useState(false);
  const [waNew, setWaNew] = useState('');
  const [waOtp, setWaOtp] = useState('');
  const [waSent, setWaSent] = useState(false);
  const [waBusy, setWaBusy] = useState(false);
  const [waErr, setWaErr] = useState('');

  // Email change
  const [emOpen, setEmOpen] = useState(false);
  const [emNew, setEmNew] = useState('');
  const [emOtp, setEmOtp] = useState('');
  const [emSent, setEmSent] = useState(false);
  const [emBusy, setEmBusy] = useState(false);
  const [emErr, setEmErr] = useState('');
  const waTimer = useOtpCountdown({ expirySeconds: 120, resendSeconds: 30 });
  const emTimer = useOtpCountdown({ expirySeconds: 600, resendSeconds: 60 });

  const fetchProfile = useCallback(async () => {
    try {
      const res = await api.get('/api/user/single');
      setData(res.data.user);
      setLoadError('');
    } catch (err) {
      setLoadError(err.response?.data?.msg || 'We could not load your seller profile.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchProfile();
  };

  const cooldownDays = (iso) => {
    if (!iso) return null;
    const d = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
    return d < 30 ? Math.ceil(30 - d) : null;
  };

  const waCooldown = cooldownDays(data?.sellerInfo?.lastWhatsAppChange);
  const emCooldown = cooldownDays(data?.sellerInfo?.lastEmailChange);

  // WhatsApp handlers
  const sendWhatsAppOtp = async () => {
    if (waSent && !waTimer.canResend) {
      setWaErr(`You can request another code in ${formatOtpCountdown(waTimer.resendRemaining)}.`);
      return;
    }
    if (!isValidPhoneNumber(waNew)) {
      setWaErr('Select a country and enter a valid WhatsApp number');
      return;
    }
    setWaBusy(true);
    setWaErr('');
    try {
      await api.post('/api/user/seller/change-whatsapp/initiate', { newWhatsappNumber: waNew });
      setWaSent(true);
      setWaOtp('');
      waTimer.start();
    } catch (err) {
      setWaErr(err.response?.data?.msg || err.message || 'Failed to send code');
    } finally {
      setWaBusy(false);
    }
  };

  const verifyWhatsApp = async () => {
    if (waTimer.isExpired) {
      setWaErr('This code has expired. Request a new code and try again.');
      return;
    }
    if (waOtp.length !== 6) {
      setWaErr('Enter the 6-digit code');
      return;
    }
    setWaBusy(true);
    setWaErr('');
    try {
      await api.post('/api/user/seller/change-whatsapp/verify', { newWhatsappNumber: waNew.trim(), otp: waOtp });
      Feedback.show({ type: 'success', text1: 'WhatsApp number updated' });
      setWaOpen(false);
      setWaSent(false);
      setWaNew('');
      setWaOtp('');
      waTimer.clear();
      await Promise.all([fetchProfile(), fetchAndUpdateCurrentUser()]);
    } catch (err) {
      setWaErr(err.response?.data?.msg || err.message || 'Verification failed');
    } finally {
      setWaBusy(false);
    }
  };

  // Email handlers
  const sendEmailOtp = async () => {
    if (emSent && !emTimer.canResend) {
      setEmErr(`You can request another code in ${formatOtpCountdown(emTimer.resendRemaining)}.`);
      return;
    }
    if (!emNew || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emNew)) {
      setEmErr('Enter a valid email address');
      return;
    }
    setEmBusy(true);
    setEmErr('');
    try {
      const nextEmail = emNew.trim().toLowerCase();
      await api.post('/api/user/seller/change-email/initiate', { newEmail: nextEmail });
      setEmNew(nextEmail);
      setEmSent(true);
      setEmOtp('');
      emTimer.start();
    } catch (err) {
      setEmErr(err.response?.data?.msg || err.message || 'Failed to send code');
    } finally {
      setEmBusy(false);
    }
  };

  const verifyEmail = async () => {
    if (emTimer.isExpired) {
      setEmErr('This code has expired. Request a new code and try again.');
      return;
    }
    if (emOtp.length !== 6) {
      setEmErr('Enter the 6-digit code');
      return;
    }
    setEmBusy(true);
    setEmErr('');
    try {
      const response = await api.post('/api/user/seller/change-email/verify', {
        newEmail: emNew.trim().toLowerCase(),
        otp: emOtp,
      });
      if (!response.data?.token) {
        setEmErr('Your email changed, but the secure session could not be refreshed. Please sign in again before continuing.');
        await fetchProfile();
        return;
      }
      await replaceAuthToken(response.data.token);
      Feedback.show({ type: 'success', text1: 'Email updated' });
      setEmOpen(false);
      setEmSent(false);
      setEmNew('');
      setEmOtp('');
      emTimer.clear();
      await Promise.all([fetchProfile(), fetchAndUpdateCurrentUser()]);
    } catch (err) {
      setEmErr(err.response?.data?.msg || err.message || 'Verification failed');
    } finally {
      setEmBusy(false);
    }
  };

  if (loading) {
    return <SellerScreenSkeleton navigation={navigation} title="Seller Profile" subtitle="Loading account and verification" icon="person-circle-outline" variant="form" />;
  }

  const InfoRow = ({ icon, iconColor, label, value, badge, footer, action }) => (
    <View style={styles.infoRow}>
      <View style={[styles.infoIcon, { backgroundColor: `${iconColor}1F` }]}>
        <Ionicons name={icon} size={16} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue}>{value || '—'}</Text>
        {badge && (
          <View style={styles.badgeRow}>
            <Ionicons name="checkmark-circle" size={12} color={palette.colors.success} />
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        )}
        {footer && <Text style={styles.infoFooter}>{footer}</Text>}
      </View>
      {action}
    </View>
  );

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.container}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Seller Profile"
          subtitle="Identity, contact, and verification"
          icon="person-circle-outline"
        />

          <KeyboardAwareFormScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
          >
            {!!loadError && <SellerInlineError compact title="Profile unavailable" message={loadError} onRetry={fetchProfile} />}

            {!!data && (
              <GlassPanel variant="strong" style={styles.hero}>
                <LinearGradient colors={['rgba(99,102,241,0.20)', 'rgba(14,165,233,0.08)', 'rgba(139,92,246,0.14)']} style={StyleSheet.absoluteFill} />
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{String(data?.username || data?.email || 'S').slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={styles.heroCopy}>
                  <Text style={styles.heroEyebrow}>SELLER ACCOUNT</Text>
                  <Text style={styles.heroTitle} numberOfLines={1}>{data?.username || 'Rozare seller'}</Text>
                  <View style={styles.heroBadge}>
                    <Ionicons name={data?.isVerified ? 'shield-checkmark' : 'shield-outline'} size={13} color={data?.isVerified ? palette.colors.success : palette.colors.warning} />
                    <Text style={[styles.heroBadgeText, { color: data?.isVerified ? palette.colors.success : palette.colors.warning }]}>{data?.isVerified ? 'Email verified' : 'Verification pending'}</Text>
                  </View>
                </View>
              </GlassPanel>
            )}

            {!!data && (
            <>
            <GlassPanel variant="card" style={styles.card}>
              <SellerSectionHeader title="Account information" subtitle="Your protected seller identity" icon="shield-checkmark-outline" />

              <InfoRow icon="person-outline" iconColor={palette.colors.primary} label="Name" value={data?.username} />

              <InfoRow
                icon="mail-outline"
                iconColor={palette.colors.info}
                label="Email"
                value={data?.email}
                footer={emCooldown ? `Can change in ${emCooldown} day${emCooldown > 1 ? 's' : ''}` : null}
                action={
                  !emOpen && (
                    <TouchableOpacity
                      onPress={() => { setEmOpen(true); setWaOpen(false); }}
                      disabled={!!emCooldown}
                      style={[styles.actionBtn, emCooldown && { opacity: 0.4 }]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Change seller email"
                    >
                      <Ionicons name="create-outline" size={14} color={palette.colors.primary} />
                      <Text style={styles.actionBtnText}>Change</Text>
                    </TouchableOpacity>
                  )
                }
              />

              {emOpen && (
                <View style={styles.changeBox}>
                  <View style={styles.warnBox}>
                    <Ionicons name="warning-outline" size={14} color="#d97706" />
                    <Text style={styles.warnText}>You won't be able to change email again for 30 days.</Text>
                  </View>
                  {!emSent ? (
                    <>
                      <TextInput
                        style={styles.input}
                        placeholder="New email address"
                        placeholderTextColor={palette.colors.textLight}
                        value={emNew}
                        onChangeText={(t) => { setEmNew(t); setEmErr(''); }}
                        keyboardType="email-address"
                        autoCapitalize="none"
                        autoComplete="email"
                        textContentType="emailAddress"
                        accessibilityLabel="New seller email address"
                      />
                      {emErr ? <Text style={styles.errText}>{emErr}</Text> : null}
                      <View style={styles.btnRow}>
                        <TouchableOpacity style={styles.primaryBtn} onPress={sendEmailOtp} disabled={emBusy} activeOpacity={0.8}>
                          {emBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Send Code</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setEmOpen(false); setEmNew(''); setEmErr(''); }} activeOpacity={0.8}>
                          <Text style={styles.secondaryBtnText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={styles.helpText}>6-digit code sent to {emNew}</Text>
                      <TextInput
                        style={[styles.input, styles.otpInput]}
                        placeholder="000000"
                        placeholderTextColor={palette.colors.textLight}
                        value={emOtp}
                        onChangeText={(t) => { setEmOtp(t.replace(/\D/g, '').slice(0, 6)); setEmErr(''); }}
                        keyboardType="number-pad"
                        maxLength={6}
                        autoComplete="one-time-code"
                        textContentType="oneTimeCode"
                        accessibilityLabel="Email verification code"
                      />
                      <Text style={[styles.helpText, emTimer.isExpired && styles.errText]} accessibilityLiveRegion="polite">
                        {emTimer.isExpired ? 'Code expired' : `Code expires in ${emTimer.expiryLabel}`}
                      </Text>
                      <TouchableOpacity
                        style={[styles.resendBtn, (emBusy || !emTimer.canResend) && styles.disabled]}
                        onPress={sendEmailOtp}
                        disabled={emBusy || !emTimer.canResend}
                        accessibilityRole="button"
                      >
                        <Ionicons name="refresh-outline" size={14} color={palette.colors.primary} />
                        <Text style={styles.resendText}>
                          {emTimer.canResend ? 'Resend code' : `Resend in ${formatOtpCountdown(emTimer.resendRemaining)}`}
                        </Text>
                      </TouchableOpacity>
                      {emErr ? <Text style={styles.errText}>{emErr}</Text> : null}
                      <View style={styles.btnRow}>
                        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: palette.colors.success }, (emBusy || emOtp.length !== 6 || emTimer.isExpired) && styles.disabled]} onPress={verifyEmail} disabled={emBusy || emOtp.length !== 6 || emTimer.isExpired} activeOpacity={0.8}>
                          {emBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Verify & Update</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setEmOpen(false); setEmSent(false); setEmNew(''); setEmOtp(''); setEmErr(''); emTimer.clear(); }} activeOpacity={0.8}>
                          <Text style={styles.secondaryBtnText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              )}

              <InfoRow
                icon="logo-whatsapp"
                iconColor="#22C55E"
                label="WhatsApp Number"
                value={data?.sellerInfo?.whatsappNumber || data?.sellerInfo?.phoneNumber}
                badge={data?.sellerInfo?.whatsappVerified ? 'Verified' : null}
                footer={waCooldown ? `Can change in ${waCooldown} day${waCooldown > 1 ? 's' : ''}` : null}
                action={
                  !waOpen && (
                    <TouchableOpacity
                      onPress={() => { setWaOpen(true); setEmOpen(false); }}
                      disabled={!!waCooldown}
                      style={[styles.actionBtn, waCooldown && { opacity: 0.4 }]}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Change seller WhatsApp number"
                    >
                      <Ionicons name="create-outline" size={14} color={palette.colors.primary} />
                      <Text style={styles.actionBtnText}>Change</Text>
                    </TouchableOpacity>
                  )
                }
              />

              {waOpen && (
                <View style={styles.changeBox}>
                  <View style={styles.warnBox}>
                    <Ionicons name="warning-outline" size={14} color="#d97706" />
                    <Text style={styles.warnText}>Order notifications move to the new number. Locked for 30 days after change.</Text>
                  </View>
                  {!waSent ? (
                    <>
                      <PhoneNumberInput
                        label="New WhatsApp number"
                        value={waNew}
                        onChangeText={(value) => { setWaNew(value); setWaErr(''); }}
                        defaultCountryCode={data?.sellerInfo?.countryCode}
                        profileCountry={data?.sellerInfo?.country}
                        helperText="The code will be delivered to this WhatsApp number."
                        accessibilityLabel="New seller WhatsApp number"
                        testID="seller-profile-whatsapp"
                      />
                      {waErr ? <Text style={styles.errText}>{waErr}</Text> : null}
                      <View style={styles.btnRow}>
                        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: '#22C55E' }]} onPress={sendWhatsAppOtp} disabled={waBusy} activeOpacity={0.8}>
                          {waBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Send Code</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setWaOpen(false); setWaNew(''); setWaErr(''); }} activeOpacity={0.8}>
                          <Text style={styles.secondaryBtnText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={styles.helpText}>6-digit code sent via WhatsApp to {waNew}</Text>
                      <TextInput
                        style={[styles.input, styles.otpInput]}
                        placeholder="000000"
                        placeholderTextColor={palette.colors.textLight}
                        value={waOtp}
                        onChangeText={(t) => { setWaOtp(t.replace(/\D/g, '').slice(0, 6)); setWaErr(''); }}
                        keyboardType="number-pad"
                        maxLength={6}
                        autoComplete="one-time-code"
                        textContentType="oneTimeCode"
                        accessibilityLabel="WhatsApp verification code"
                      />
                      <Text style={[styles.helpText, waTimer.isExpired && styles.errText]} accessibilityLiveRegion="polite">
                        {waTimer.isExpired ? 'Code expired' : `Code expires in ${waTimer.expiryLabel}`}
                      </Text>
                      <TouchableOpacity
                        style={[styles.resendBtn, (waBusy || !waTimer.canResend) && styles.disabled]}
                        onPress={sendWhatsAppOtp}
                        disabled={waBusy || !waTimer.canResend}
                        accessibilityRole="button"
                      >
                        <Ionicons name="refresh-outline" size={14} color={palette.colors.primary} />
                        <Text style={styles.resendText}>
                          {waTimer.canResend ? 'Resend code' : `Resend in ${formatOtpCountdown(waTimer.resendRemaining)}`}
                        </Text>
                      </TouchableOpacity>
                      {waErr ? <Text style={styles.errText}>{waErr}</Text> : null}
                      <View style={styles.btnRow}>
                        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: palette.colors.success }, (waBusy || waOtp.length !== 6 || waTimer.isExpired) && styles.disabled]} onPress={verifyWhatsApp} disabled={waBusy || waOtp.length !== 6 || waTimer.isExpired} activeOpacity={0.8}>
                          {waBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Verify & Update</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setWaOpen(false); setWaSent(false); setWaNew(''); setWaOtp(''); setWaErr(''); waTimer.clear(); }} activeOpacity={0.8}>
                          <Text style={styles.secondaryBtnText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              )}

              <InfoRow icon="business-outline" iconColor={palette.colors.secondary} label="Business Name" value={data?.sellerInfo?.businessName} />
              <InfoRow icon="location-outline" iconColor={palette.colors.warning} label="Country" value={data?.sellerInfo?.country} />
            </GlassPanel>

            <GlassPanel variant="card" style={styles.card}>
              <SellerSectionHeader title="Account shortcuts" subtitle="Continue managing your business" icon="grid-outline" />
              <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('SellerStoreSettings')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Open store settings">
                <Ionicons name="storefront-outline" size={18} color={palette.colors.primary} />
                <Text style={styles.linkText}>Store Settings</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('SellerWhatsAppSettings')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Open WhatsApp settings">
                <Ionicons name="logo-whatsapp" size={18} color="#22C55E" />
                <Text style={styles.linkText}>WhatsApp Settings</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Open subscription plan">
                <Ionicons name="diamond-outline" size={18} color="#8b5cf6" />
                <Text style={styles.linkText}>Subscription Plan</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.linkRow, { borderBottomWidth: 0 }]} onPress={() => navigation.navigate('EditProfile')} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Edit display name and photo">
                <Ionicons name="person-outline" size={18} color={palette.colors.info} />
                <Text style={styles.linkText}>Edit Display Name & Photo</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            </GlassPanel>
            </>
            )}

            <View style={{ height: 100 }} />
          </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  hero: { minHeight: 126, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, overflow: 'hidden', padding: spacing.xl, marginBottom: spacing.md },
  avatar: { width: 62, height: 62, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, borderWidth: 1, borderColor: 'rgba(255,255,255,0.62)', ...shadows.md },
  avatarText: { color: '#fff', fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold },
  heroCopy: { flex: 1, minWidth: 0 },
  heroEyebrow: { fontSize: 9, letterSpacing: 1, fontWeight: fontWeight.extrabold, color: p.colors.primary },
  heroTitle: { marginTop: 3, ...typography.h4, color: p.colors.text },
  heroBadge: { alignSelf: 'flex-start', minHeight: 26, flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.sm, paddingHorizontal: 9, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle },
  heroBadgeText: { fontSize: 10, fontWeight: fontWeight.bold },
  card: { padding: spacing.lg, marginBottom: spacing.md },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  infoIcon: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  infoLabel: { fontSize: 11, fontWeight: fontWeight.semibold, color: p.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text, marginTop: 2 },
  infoFooter: { fontSize: fontSize.xs, color: p.colors.textLight, marginTop: 4 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  badgeText: { fontSize: 11, color: p.colors.success, fontWeight: fontWeight.semibold },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: borderRadius.md, backgroundColor: 'rgba(99,102,241,0.12)' },
  actionBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  changeBox: { padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.06)', marginTop: spacing.sm, marginBottom: spacing.sm, gap: spacing.sm },
  warnBox: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, padding: spacing.sm, borderRadius: borderRadius.md, backgroundColor: 'rgba(245,158,11,0.1)' },
  warnText: { flex: 1, fontSize: fontSize.xs, color: p.colors.text, lineHeight: 16 },
  input: { borderWidth: 1, borderColor: p.glass.borderSubtle, borderRadius: borderRadius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: fontSize.md, color: p.colors.text, backgroundColor: 'rgba(255,255,255,0.08)' },
  otpInput: { textAlign: 'center', letterSpacing: 8, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
  errText: { fontSize: fontSize.xs, color: p.colors.error },
  helpText: { fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center' },
  resendBtn: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: borderRadius.md, backgroundColor: p.colors.primarySubtle },
  resendText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  btnRow: { flexDirection: 'row', gap: spacing.sm },
  primaryBtn: { flex: 1, backgroundColor: p.colors.primary, borderRadius: borderRadius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  primaryBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.white },
  secondaryBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  disabled: { opacity: 0.52 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  linkText: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.medium, color: p.colors.text },
});
