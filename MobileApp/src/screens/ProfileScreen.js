/**
 * ProfileScreen — Liquid Glass Design
 * User profile with role-based menu options
 */

import React, { useCallback, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, TextInput, Modal,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import GlassBlurFill from '../components/common/GlassBlurFill';
import RozareLogo from '../components/common/RozareLogo';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const APP_VERSION = '1.0.0';

export const getMenuItemsForRole = (role, palette) => {
  const baseItems = [
    { id: 'orders', title: 'My Orders', icon: 'receipt-outline', screen: 'Orders', color: palette.colors.primary },
    { id: 'track-order', title: 'Track My Order', icon: 'navigate-outline', screen: 'TrackOrder', color: palette.colors.warning },
    { id: 'wallet', title: 'Rozare Wallet', icon: 'wallet-outline', screen: 'Wallet', color: palette.colors.success },
    { id: 'addresses', title: 'Saved Addresses', icon: 'location-outline', screen: 'SavedAddresses', color: palette.colors.info },
    { id: 'change-password', title: 'Change Password', icon: 'lock-closed-outline', screen: 'ChangePassword', color: palette.colors.warning },
    { id: 'settings', title: 'Settings', icon: 'settings-outline', screen: 'Settings', color: palette.colors.textSecondary },
  ];
  switch (role) {
    case 'seller':
      return [...baseItems, { id: 'seller', title: 'Seller Dashboard', icon: 'storefront-outline', screen: 'SellerDashboard', highlight: true, color: palette.colors.success }];
    case 'user':
    default:
      return [...baseItems, { id: 'become-seller', title: 'Become a Seller', icon: 'storefront-outline', screen: 'BecomeSeller', color: palette.colors.secondary }];
  }
};

export default function ProfileScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser, logout } = useAuth();
  const [savedShipping, setSavedShipping] = useState(null);
  const [editingShipping, setEditingShipping] = useState(false);
  const [shippingForm, setShippingForm] = useState({
    fullName: '', email: '', phone: '', address: '', city: '', state: '', postalCode: '', country: 'Pakistan',
  });
  const [savingShipping, setSavingShipping] = useState(false);

  useEffect(() => {
    if (currentUser) fetchShippingInfo();
  }, [currentUser]);

  const fetchShippingInfo = async () => {
    try {
      const res = await api.get('/api/user/shipping-info');
      if (res.data?.shippingInfo) {
        setSavedShipping(res.data.shippingInfo);
        setShippingForm(res.data.shippingInfo);
      }
    } catch {}
  };

  const saveShippingInfo = async () => {
    setSavingShipping(true);
    try {
      await api.patch('/api/user/shipping-info', { shippingInfo: shippingForm });
      setSavedShipping(shippingForm);
      setEditingShipping(false);
      Toast.show({ type: 'success', text1: 'Saved!', text2: 'Shipping info updated' });
    } catch { Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to update' }); }
    finally { setSavingShipping(false); }
  };

  const handleLogout = useCallback(() => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Logout', style: 'destructive', onPress: logout },
    ]);
  }, [logout]);

  // Guest View
  if (!currentUser) {
    const guestFeatures = [
      { icon: 'sparkles-outline', title: 'Shop with your AI', desc: 'Discover and buy by chatting in the app or on WhatsApp', color: palette.colors.secondary },
      { icon: 'receipt-outline', title: 'Track every order', desc: 'Keep confirmations and delivery updates in one place', color: palette.colors.info },
      { icon: 'heart-outline', title: 'Save what you love', desc: 'Sync favourite products and trusted stores across devices', color: palette.colors.heart },
      { icon: 'logo-whatsapp', title: 'Stay updated on WhatsApp', desc: 'Receive order progress when your WhatsApp is connected', color: palette.colors.success },
    ];

    return (
      <GlassBackground>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.guestScroll}
        >
          <View style={styles.guestTopBar}>
            <RozareLogo width={126} height={32} />
            <View style={styles.accountPill}>
              <View style={styles.accountPillDot} />
              <Text style={styles.accountPillText}>YOUR ACCOUNT</Text>
            </View>
          </View>

          <GlassPanel variant="strong" style={styles.guestCard}>
            <View style={styles.guestGlowTop} pointerEvents="none">
              <LinearGradient colors={['rgba(20,184,166,0.42)', 'rgba(14,165,233,0.06)']} style={styles.guestGlowFill} />
            </View>
            <View style={styles.guestGlowBottom} pointerEvents="none">
              <LinearGradient colors={['rgba(99,102,241,0.30)', 'rgba(168,85,247,0.04)']} style={styles.guestGlowFill} />
            </View>

            <View style={styles.guestEyebrow}>
              <Ionicons name="sparkles" size={12} color={palette.colors.primary} />
              <Text style={styles.guestEyebrowText}>YOUR SHOPPING, BEAUTIFULLY SYNCED</Text>
            </View>

            <View style={styles.guestAvatarShell}>
              <LinearGradient colors={palette.gradients.cta} style={styles.guestAvatarGradient}>
                <Ionicons name="person-outline" size={42} color="#fff" />
              </LinearGradient>
              <View style={styles.guestAvatarBadge}>
                <Ionicons name="checkmark" size={13} color="#fff" />
              </View>
            </View>

            <Text style={styles.guestTitle}>Your Rozare, everywhere</Text>
            <Text style={styles.guestSubtitle}>
              Sign in once to keep your cart, favourites, trusted stores and order journey together.
            </Text>

            <TouchableOpacity style={styles.loginButton} onPress={() => navigation.navigate('Login')} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              <Ionicons name="person-outline" size={18} color="#fff" />
              <Text style={styles.loginButtonText}>Sign in to Rozare</Text>
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>

            <View style={styles.createAccountRow}>
              <Text style={styles.createAccountText}>New to Rozare?</Text>
              <TouchableOpacity onPress={() => navigation.navigate('SignUp')} activeOpacity={0.7}>
                <Text style={styles.createAccountLink}> Create an account</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.sellerButton}
              onPress={() => navigation.navigate('BecomeSeller')}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Become a seller"
            >
              <GlassBlurFill intensity={42} />
              <View style={styles.sellerButtonIcon}>
                <Ionicons name="storefront-outline" size={18} color={palette.colors.secondary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sellerButtonTitle}>Become a seller</Text>
                <Text style={styles.sellerButtonText}>Open your store and sell with AI</Text>
              </View>
              <Ionicons name="arrow-forward" size={17} color={palette.colors.primary} />
            </TouchableOpacity>

            <View style={styles.guestTrustRow}>
              {[
                { icon: 'shield-checkmark-outline', label: 'Secure' },
                { icon: 'sync-outline', label: 'Synced' },
                { icon: 'sparkles-outline', label: 'AI powered' },
              ].map((item) => (
                <View key={item.label} style={styles.guestTrustChip}>
                  <Ionicons name={item.icon} size={13} color={palette.colors.primary} />
                  <Text style={styles.guestTrustText}>{item.label}</Text>
                </View>
              ))}
            </View>
          </GlassPanel>

          <View style={styles.guestSectionHeading}>
            <View>
              <Text style={styles.guestSectionKicker}>ONE ACCOUNT</Text>
              <Text style={styles.guestSectionTitle}>Everything stays with you</Text>
            </View>
            <View style={styles.guestSectionIcon}>
              <Ionicons name="infinite-outline" size={19} color={palette.colors.primary} />
            </View>
          </View>

          <GlassPanel variant="card" style={styles.featuresCard}>
            {guestFeatures.map((feature, index) => (
              <View
                key={feature.title}
                style={[styles.featureRow, index < guestFeatures.length - 1 && styles.featureRowDivider]}
              >
                <View style={[styles.featureIcon, { backgroundColor: `${feature.color}14` }]}>
                  <Ionicons name={feature.icon} size={21} color={feature.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.featureTitle}>{feature.title}</Text>
                  <Text style={styles.featureDesc}>{feature.desc}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={palette.colors.textLight} />
              </View>
            ))}
          </GlassPanel>

          <GlassPanel variant="inner" androidBlur={false} style={styles.guestPrivacyStrip}>
            <View style={styles.guestPrivacyIcon}>
              <Ionicons name="lock-closed-outline" size={16} color={palette.colors.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.guestPrivacyTitle}>Private by design</Text>
              <Text style={styles.guestPrivacyText}>Your account keeps checkout and shopping activity protected.</Text>
            </View>
          </GlassPanel>

          <Text style={styles.appVersion}>Rozare v{APP_VERSION}</Text>
        </ScrollView>
      </GlassBackground>
    );
  }

  const menuItems = getMenuItemsForRole(currentUser.role, palette);
  const roleLabel = currentUser.role?.charAt(0).toUpperCase() + currentUser.role?.slice(1);

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {/* Profile Header */}
        <GlassPanel variant="strong" style={styles.profileHeader}>
          <View style={styles.avatarWrapper}>
            {currentUser.avatar ? (
              <Image source={{ uri: currentUser.avatar }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" transition={200} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>{currentUser.name?.charAt(0)?.toUpperCase() || 'U'}</Text>
              </View>
            )}
          </View>
          <Text style={styles.profileName}>{currentUser.name}</Text>
          <Text style={styles.profileEmail}>{currentUser.email}</Text>
          <View style={styles.rolePill}>
            <Text style={styles.rolePillText}>{roleLabel}</Text>
          </View>
          <TouchableOpacity style={styles.editProfileBtn} onPress={() => navigation.navigate('EditProfile')} activeOpacity={0.8}>
            <Ionicons name="pencil-outline" size={14} color={palette.colors.primary} />
            <Text style={styles.editProfileBtnText}>Edit Profile</Text>
          </TouchableOpacity>
        </GlassPanel>

        {/* Menu Section */}
        <GlassPanel variant="card" style={styles.menuCard}>
          <Text style={styles.sectionLabel}>MY ACCOUNT</Text>
          {menuItems.map((item, index) => (
            <TouchableOpacity
              key={item.id}
              style={[styles.menuRow, index < menuItems.length - 1 && styles.menuRowBorder]}
              onPress={() => navigation.navigate(item.screen)}
              activeOpacity={0.7}
            >
              <View style={[styles.menuIcon, { backgroundColor: (item.color || palette.colors.primary) + '18' }]}>
                <Ionicons name={item.icon} size={20} color={item.color || palette.colors.primary} />
              </View>
              <Text style={styles.menuRowText}>{item.title}</Text>
              <Ionicons name="chevron-forward" size={18} color={palette.colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </GlassPanel>

        {/* Saved Shipping Address */}
        <GlassPanel variant="card" style={{ marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="location-outline" size={18} color={palette.colors.primary} />
              <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.text }}>Shipping Address</Text>
            </View>
            <TouchableOpacity onPress={() => { setShippingForm(savedShipping || { fullName: '', email: '', phone: '', address: '', city: '', state: '', postalCode: '', country: 'Pakistan' }); setEditingShipping(true); }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="pencil-outline" size={14} color={palette.colors.primary} />
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.primary, fontWeight: fontWeight.medium }}>{savedShipping?.fullName ? 'Edit' : 'Add'}</Text>
            </TouchableOpacity>
          </View>
          {savedShipping?.fullName ? (
            <View style={{ backgroundColor: palette.glass.bgSubtle, borderRadius: 14, padding: spacing.md, borderWidth: 1, borderColor: palette.glass.borderSubtle }}>
              <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: palette.colors.text, marginBottom: 4 }}>{savedShipping.fullName}</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary }}>{savedShipping.address}</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary }}>{savedShipping.city}, {savedShipping.state} {savedShipping.postalCode}</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary }}>{savedShipping.country}</Text>
              <View style={{ flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm }}>
                <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>{savedShipping.email}</Text>
                <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>{savedShipping.phone}</Text>
              </View>
            </View>
          ) : (
            <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, textAlign: 'center', paddingVertical: spacing.md }}>No shipping address saved yet. Add one for faster checkout!</Text>
          )}
        </GlassPanel>

        {/* Edit Shipping Modal */}
        <Modal visible={editingShipping} transparent animationType="slide" onRequestClose={() => setEditingShipping(false)}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
            <GlassPanel variant="strong" style={{ borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.xl, paddingBottom: spacing.xxxl }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg }}>
                <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text }}>Edit Shipping Info</Text>
                <TouchableOpacity onPress={() => setEditingShipping(false)} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: palette.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' }}>
                  <Ionicons name="close" size={20} color={palette.colors.text} />
                </TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 400 }}>
                {['fullName', 'email', 'phone', 'address', 'city', 'state', 'postalCode', 'country'].map(field => (
                  <View key={field} style={{ marginBottom: spacing.md }}>
                    <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: palette.colors.textSecondary, marginBottom: 4, textTransform: 'capitalize' }}>{field.replace(/([A-Z])/g, ' $1')}</Text>
                    <TextInput style={{ backgroundColor: palette.glass.bgSubtle, borderRadius: 12, borderWidth: 1, borderColor: palette.glass.borderSubtle, padding: spacing.md, fontSize: fontSize.md, color: palette.colors.text }}
                      value={shippingForm[field]} onChangeText={v => setShippingForm(p => ({ ...p, [field]: v }))}
                      placeholderTextColor={palette.colors.textSecondary} placeholder={`Enter ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}`}
                      keyboardType={field === 'email' ? 'email-address' : field === 'phone' || field === 'postalCode' ? 'phone-pad' : 'default'} />
                  </View>
                ))}
              </ScrollView>
              <TouchableOpacity style={{ borderRadius: 16, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md, opacity: savingShipping ? 0.6 : 1, overflow: 'hidden' }}
                onPress={saveShippingInfo} disabled={savingShipping} activeOpacity={0.85}>
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: '#fff' }}>{savingShipping ? 'Saving...' : 'Save Address'}</Text>
              </TouchableOpacity>
            </GlassPanel>
          </View>
        </Modal>

        <GlassPanel variant="card" style={styles.logoutCard}>
          <TouchableOpacity style={styles.menuRow} onPress={handleLogout} activeOpacity={0.7}>
            <View style={[styles.menuIcon, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
              <Ionicons name="log-out-outline" size={20} color={palette.colors.error} />
            </View>
            <Text style={[styles.menuRowText, { color: palette.colors.error }]}>Logout</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.colors.errorLight} />
          </TouchableOpacity>
        </GlassPanel>

        <Text style={styles.appVersion}>Rozare v{APP_VERSION}</Text>
        <View style={{ height: 80 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: 110 },
  // Guest
  guestScroll: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 124 },
  guestTopBar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  accountPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.md, paddingVertical: 7, borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle,
  },
  accountPillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: p.colors.success },
  accountPillText: { fontSize: 9, letterSpacing: 0.9, color: p.colors.textSecondary, fontWeight: fontWeight.bold },
  guestCard: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.lg, alignItems: 'center', marginBottom: spacing.xl, borderRadius: 28 },
  guestGlowTop: { position: 'absolute', top: -72, right: -58, width: 184, height: 184, borderRadius: 92, opacity: 0.56 },
  guestGlowBottom: { position: 'absolute', bottom: -86, left: -60, width: 190, height: 190, borderRadius: 95, opacity: 0.42 },
  guestGlowFill: { flex: 1, borderRadius: 999 },
  guestEyebrow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle,
    marginBottom: spacing.lg,
  },
  guestEyebrowText: { fontSize: 9, letterSpacing: 0.8, color: p.colors.primary, fontWeight: fontWeight.bold },
  guestAvatarShell: {
    width: 94, height: 94, borderRadius: 31, padding: 7, marginBottom: spacing.lg,
    backgroundColor: 'rgba(255,255,255,0.34)', borderWidth: 1, borderColor: p.glass.borderStrong,
    transform: [{ rotate: '-3deg' }],
  },
  guestAvatarGradient: { flex: 1, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  guestAvatarBadge: {
    position: 'absolute', right: -5, bottom: -5, width: 27, height: 27, borderRadius: 14,
    backgroundColor: p.colors.success, borderWidth: 3, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  guestTitle: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: p.colors.text, marginBottom: spacing.sm, textAlign: 'center', letterSpacing: -0.6 },
  guestSubtitle: { fontSize: fontSize.md, lineHeight: 22, color: p.colors.textSecondary, marginBottom: spacing.xl, textAlign: 'center', maxWidth: 330 },
  loginButton: {
    width: '100%', minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: borderRadius.xl, overflow: 'hidden',
    shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6,
  },
  loginButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold, flexShrink: 1 },
  createAccountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  createAccountText: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  createAccountLink: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.bold },
  sellerButton: {
    width: '100%', minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginTop: spacing.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: 18, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.border,
    overflow: 'hidden',
  },
  sellerButtonIcon: {
    width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: `${p.colors.secondary}12`, borderWidth: 1, borderColor: `${p.colors.secondary}22`,
  },
  sellerButtonTitle: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.bold },
  sellerButtonText: { marginTop: 2, fontSize: 10, color: p.colors.textSecondary },
  guestTrustRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.xs, marginTop: spacing.lg, flexWrap: 'wrap' },
  guestTrustChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: spacing.sm + 2, paddingVertical: 6, borderRadius: borderRadius.full,
    backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle,
  },
  guestTrustText: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  guestSectionHeading: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: spacing.xs, marginBottom: spacing.md,
  },
  guestSectionKicker: { fontSize: 9, color: p.colors.primary, fontWeight: fontWeight.bold, letterSpacing: 1.1, marginBottom: 3 },
  guestSectionTitle: { fontSize: fontSize.xl, color: p.colors.text, fontWeight: fontWeight.extrabold, letterSpacing: -0.3 },
  guestSectionIcon: {
    width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle,
  },
  featuresCard: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 24 },
  featureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, gap: spacing.md },
  featureRowDivider: { borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  featureIcon: {
    width: 44, height: 44, borderRadius: 15, justifyContent: 'center', alignItems: 'center',
    borderWidth: 1, borderColor: p.glass.borderSubtle,
  },
  featureTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  featureDesc: { fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary, marginTop: 3 },
  guestPrivacyStrip: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    marginTop: spacing.md, padding: spacing.md, borderRadius: 18,
  },
  guestPrivacyIcon: {
    width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(16,185,129,0.10)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.18)',
  },
  guestPrivacyTitle: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.bold, marginBottom: 2 },
  guestPrivacyText: { fontSize: fontSize.xs, lineHeight: 16, color: p.colors.textSecondary },
  // Profile
  profileHeader: { margin: spacing.lg, padding: spacing.xl, alignItems: 'center' },
  avatarWrapper: { marginBottom: spacing.md },
  avatar: { width: 88, height: 88, borderRadius: 44, borderWidth: 3, borderColor: 'rgba(99,102,241,0.3)' },
  avatarPlaceholder: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: 'rgba(99,102,241,0.15)', justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: 'rgba(99,102,241,0.2)',
  },
  avatarText: { fontSize: 36, fontWeight: fontWeight.bold, color: p.colors.primary },
  profileName: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.xs },
  profileEmail: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.md },
  rolePill: {
    paddingHorizontal: spacing.lg, paddingVertical: spacing.xs, borderRadius: borderRadius.full,
    backgroundColor: 'rgba(99,102,241,0.12)',
  },
  rolePillText: { color: p.colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  editProfileBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full, borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)',
    backgroundColor: 'rgba(99,102,241,0.06)',
  },
  editProfileBtnText: { color: p.colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  // Menu
  menuCard: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md },
  sectionLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textLight, letterSpacing: 1, marginBottom: spacing.sm, paddingLeft: spacing.sm },
  menuRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.sm, gap: spacing.md },
  menuRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  menuIcon: { width: 40, height: 40, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  menuRowText: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.medium, color: p.colors.text },
  logoutCard: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md },
  appVersion: { fontSize: fontSize.xs, color: p.colors.textLight, textAlign: 'center', paddingVertical: spacing.xl },
});
