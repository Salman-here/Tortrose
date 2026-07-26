/**
 * SellerProfileScreen — Mobile parity for /seller-dashboard/profile
 * View account info + change WhatsApp number / Email with OTP verification.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Feedback from '../../utils/feedback';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const formatCountdown = (s) => {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};

export default function SellerProfileScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { fetchAndUpdateCurrentUser } = useAuth();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);

  // WhatsApp change
  const [waOpen, setWaOpen] = useState(false);
  const [waNew, setWaNew] = useState('');
  const [waOtp, setWaOtp] = useState('');
  const [waSent, setWaSent] = useState(false);
  const [waBusy, setWaBusy] = useState(false);
  const [waErr, setWaErr] = useState('');
  const [waCountdown, setWaCountdown] = useState(0);

  // Email change
  const [emOpen, setEmOpen] = useState(false);
  const [emNew, setEmNew] = useState('');
  const [emOtp, setEmOtp] = useState('');
  const [emSent, setEmSent] = useState(false);
  const [emBusy, setEmBusy] = useState(false);
  const [emErr, setEmErr] = useState('');
  const [emCountdown, setEmCountdown] = useState(0);

  useEffect(() => {
    if (waCountdown > 0) {
      const t = setTimeout(() => setWaCountdown(waCountdown - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [waCountdown]);

  useEffect(() => {
    if (emCountdown > 0) {
      const t = setTimeout(() => setEmCountdown(emCountdown - 1), 1000);
      return () => clearTimeout(t);
    }
  }, [emCountdown]);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await api.get('/api/user/single');
      setData(res.data.user);
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Failed to load profile' });
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
    if (!waNew || waNew.replace(/[^\d]/g, '').length < 8) {
      setWaErr('Enter a valid WhatsApp number with country code');
      return;
    }
    setWaBusy(true);
    setWaErr('');
    try {
      await api.post('/api/user/seller/change-whatsapp/initiate', { newWhatsappNumber: waNew });
      setWaSent(true);
      setWaCountdown(120);
    } catch (err) {
      setWaErr(err.response?.data?.msg || 'Failed to send code');
    } finally {
      setWaBusy(false);
    }
  };

  const verifyWhatsApp = async () => {
    if (waOtp.length !== 6) {
      setWaErr('Enter the 6-digit code');
      return;
    }
    setWaBusy(true);
    setWaErr('');
    try {
      await api.post('/api/user/seller/change-whatsapp/verify', { newWhatsappNumber: waNew, otp: waOtp });
      Feedback.show({ type: 'success', text1: 'WhatsApp number updated' });
      setWaOpen(false);
      setWaSent(false);
      setWaNew('');
      setWaOtp('');
      setWaCountdown(0);
      fetchProfile();
      fetchAndUpdateCurrentUser();
    } catch (err) {
      setWaErr(err.response?.data?.msg || 'Verification failed');
    } finally {
      setWaBusy(false);
    }
  };

  // Email handlers
  const sendEmailOtp = async () => {
    if (!emNew || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emNew)) {
      setEmErr('Enter a valid email address');
      return;
    }
    setEmBusy(true);
    setEmErr('');
    try {
      await api.post('/api/user/seller/change-email/initiate', { newEmail: emNew });
      setEmSent(true);
      setEmCountdown(600);
    } catch (err) {
      setEmErr(err.response?.data?.msg || 'Failed to send code');
    } finally {
      setEmBusy(false);
    }
  };

  const verifyEmail = async () => {
    if (emOtp.length !== 6) {
      setEmErr('Enter the 6-digit code');
      return;
    }
    setEmBusy(true);
    setEmErr('');
    try {
      await api.post('/api/user/seller/change-email/verify', { newEmail: emNew, otp: emOtp });
      Feedback.show({ type: 'success', text1: 'Email updated' });
      setEmOpen(false);
      setEmSent(false);
      setEmNew('');
      setEmOtp('');
      setEmCountdown(0);
      fetchProfile();
      fetchAndUpdateCurrentUser();
    } catch (err) {
      setEmErr(err.response?.data?.msg || 'Verification failed');
    } finally {
      setEmBusy(false);
    }
  };

  if (loading) {
    return (
      <GlassBackground>
        <SafeAreaView style={[styles.container, styles.center]}>
          <ActivityIndicator size="large" color={palette.colors.primary} />
        </SafeAreaView>
      </GlassBackground>
    );
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
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <GlassPanel variant="floating" style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Seller Profile</Text>
              <Text style={styles.headerSubtitle}>Account & verification details</Text>
            </View>
            <View style={styles.headerIcon}>
              <Ionicons name="person-circle-outline" size={22} color={palette.colors.primary} />
            </View>
          </GlassPanel>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
            keyboardShouldPersistTaps="handled"
          >
            <GlassPanel variant="card" style={styles.card}>
              <Text style={styles.cardTitle}>Account Information</Text>

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
                      />
                      {emCountdown > 0 && (
                        <Text style={styles.helpText}>Code expires in {formatCountdown(emCountdown)}</Text>
                      )}
                      {emErr ? <Text style={styles.errText}>{emErr}</Text> : null}
                      <View style={styles.btnRow}>
                        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: palette.colors.success }]} onPress={verifyEmail} disabled={emBusy || emOtp.length !== 6} activeOpacity={0.8}>
                          {emBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Verify & Update</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setEmOpen(false); setEmSent(false); setEmNew(''); setEmOtp(''); setEmErr(''); setEmCountdown(0); }} activeOpacity={0.8}>
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
                      <TextInput
                        style={styles.input}
                        placeholder="+1 555 123 4567"
                        placeholderTextColor={palette.colors.textLight}
                        value={waNew}
                        onChangeText={(t) => { setWaNew(t); setWaErr(''); }}
                        keyboardType="phone-pad"
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
                      />
                      {waCountdown > 0 && (
                        <Text style={styles.helpText}>Code expires in {formatCountdown(waCountdown)}</Text>
                      )}
                      {waErr ? <Text style={styles.errText}>{waErr}</Text> : null}
                      <View style={styles.btnRow}>
                        <TouchableOpacity style={[styles.primaryBtn, { backgroundColor: palette.colors.success }]} onPress={verifyWhatsApp} disabled={waBusy || waOtp.length !== 6} activeOpacity={0.8}>
                          {waBusy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.primaryBtnText}>Verify & Update</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setWaOpen(false); setWaSent(false); setWaNew(''); setWaOtp(''); setWaErr(''); setWaCountdown(0); }} activeOpacity={0.8}>
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
              <Text style={styles.cardTitle}>Quick Actions</Text>
              <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('SellerStoreSettings')} activeOpacity={0.7}>
                <Ionicons name="storefront-outline" size={18} color={palette.colors.primary} />
                <Text style={styles.linkText}>Store Settings</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('SellerWhatsAppSettings')} activeOpacity={0.7}>
                <Ionicons name="logo-whatsapp" size={18} color="#22C55E" />
                <Text style={styles.linkText}>WhatsApp Settings</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.linkRow} onPress={() => navigation.navigate('SellerSubscription')} activeOpacity={0.7}>
                <Ionicons name="diamond-outline" size={18} color="#8b5cf6" />
                <Text style={styles.linkText}>Subscription Plan</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.linkRow, { borderBottomWidth: 0 }]} onPress={() => navigation.navigate('EditProfile')} activeOpacity={0.7}>
                <Ionicons name="person-outline" size={18} color={palette.colors.info} />
                <Text style={styles.linkText}>Edit Display Name & Photo</Text>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            </GlassPanel>

            <View style={{ height: 100 }} />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  headerCenter: { flex: 1, marginLeft: spacing.md },
  headerTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text },
  headerSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  headerIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  card: { padding: spacing.lg, marginBottom: spacing.md },
  cardTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.md },
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
  btnRow: { flexDirection: 'row', gap: spacing.sm },
  primaryBtn: { flex: 1, backgroundColor: p.colors.primary, borderRadius: borderRadius.md, paddingVertical: spacing.sm, alignItems: 'center' },
  primaryBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.white },
  secondaryBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  secondaryBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  linkText: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.medium, color: p.colors.text },
});
