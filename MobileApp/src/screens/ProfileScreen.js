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
import { useGlobal } from '../contexts/GlobalContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const APP_VERSION = '1.0.0';

export const getMenuItemsForRole = (role, palette) => {
  const baseItems = [
    { id: 'orders', title: 'My Orders', icon: 'receipt-outline', screen: 'Orders', color: palette.colors.primary },
    { id: 'wallet', title: 'Rozare Wallet', icon: 'wallet-outline', screen: 'Wallet', color: palette.colors.success },
    { id: 'addresses', title: 'Saved Addresses', icon: 'location-outline', screen: 'SavedAddresses', color: palette.colors.info },
    { id: 'notifications', title: 'Notifications', icon: 'notifications-outline', screen: 'Notifications', color: palette.colors.secondary },
    { id: 'trusted', title: 'Trusted Stores', icon: 'shield-checkmark-outline', screen: 'TrustedStores', color: palette.colors.info },
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
  const { unreadNotifCount } = useGlobal();
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
    return (
      <GlassBackground>
        <View style={styles.guestContainer}>
          <GlassPanel variant="strong" style={styles.guestCard}>
            <View style={styles.guestAvatarCircle}>
              <Ionicons name="person-outline" size={48} color={palette.colors.primary} />
            </View>
            <Text style={styles.guestTitle}>Welcome to Rozare</Text>
            <Text style={styles.guestSubtitle}>Sign in to access your account</Text>
            <TouchableOpacity style={styles.loginButton} onPress={() => navigation.navigate('Login')} activeOpacity={0.85}>
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
              <Text style={styles.loginButtonText}>Login / Sign Up</Text>
            </TouchableOpacity>
          </GlassPanel>

          <GlassPanel variant="card" style={styles.featuresCard}>
            {[
              { icon: 'receipt-outline', title: 'Track Orders', desc: 'Follow purchase status updates' },
              { icon: 'heart-outline', title: 'Save Favorites', desc: 'Build and manage your wishlist' },
              { icon: 'shield-checkmark-outline', title: 'Trusted Stores', desc: 'Use reviews, badges, and trust signals' },
            ].map((f) => (
              <View key={f.icon} style={styles.featureRow}>
                <View style={styles.featureIcon}>
                  <Ionicons name={f.icon} size={22} color={palette.colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.featureTitle}>{f.title}</Text>
                  <Text style={styles.featureDesc}>{f.desc}</Text>
                </View>
              </View>
            ))}
          </GlassPanel>
          <Text style={styles.appVersion}>Rozare v{APP_VERSION}</Text>
        </View>
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
              {item.id === 'notifications' && unreadNotifCount > 0 && (
                <View style={{ backgroundColor: palette.colors.error, borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6, marginRight: spacing.sm }}>
                  <Text style={{ color: 'white', fontSize: 11, fontWeight: fontWeight.bold }}>{unreadNotifCount > 99 ? '99+' : unreadNotifCount}</Text>
                </View>
              )}
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
  guestContainer: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  guestCard: { padding: spacing.xxl, alignItems: 'center', marginBottom: spacing.lg },
  guestAvatarCircle: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg,
  },
  guestTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.xs },
  guestSubtitle: { fontSize: fontSize.md, color: p.colors.textSecondary, marginBottom: spacing.xl },
  loginButton: {
    paddingVertical: spacing.md, paddingHorizontal: spacing.xxxl, borderRadius: borderRadius.lg, overflow: 'hidden',
    shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6,
  },
  loginButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  featuresCard: { padding: spacing.lg },
  featureRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, gap: spacing.md },
  featureIcon: {
    width: 44, height: 44, borderRadius: borderRadius.lg,
    backgroundColor: 'rgba(99,102,241,0.08)', justifyContent: 'center', alignItems: 'center',
  },
  featureTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  featureDesc: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
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
