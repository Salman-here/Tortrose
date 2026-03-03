/**
 * ProfileScreen
 * User profile with role-based menu options
 * 
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 4.8
 */

import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Alert,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
  buttonStyles,
} from '../styles/theme';

// App version
const APP_VERSION = '1.0.0';

/**
 * Get menu sections based on user role
 * Property 4: Role-Based Menu Visibility
 * Validates: Requirements 13.3, 13.4, 13.5
 */
export const getMenuItemsForRole = (role) => {
  const baseItems = [
    { id: 'orders', title: 'My Orders', icon: 'receipt-outline', screen: 'Orders', color: colors.primary },
    { id: 'notifications', title: 'Notifications', icon: 'notifications-outline', screen: 'Notifications', color: colors.secondary },
    { id: 'trusted', title: 'Trusted Stores', icon: 'shield-checkmark-outline', screen: 'TrustedStores', color: colors.info },
    { id: 'change-password', title: 'Change Password', icon: 'lock-closed-outline', screen: 'ChangePassword', color: colors.warning },
    { id: 'settings', title: 'Settings', icon: 'settings-outline', screen: 'Settings', color: colors.textSecondary },
  ];

  switch (role) {
    case 'admin':
      return [
        ...baseItems,
        { id: 'admin', title: 'Admin Dashboard', icon: 'settings-outline', screen: 'AdminDashboard', highlight: true, color: colors.error },
      ];
    case 'seller':
      return [
        ...baseItems,
        { id: 'seller', title: 'Seller Dashboard', icon: 'storefront-outline', screen: 'SellerDashboard', highlight: true, color: colors.success },
      ];
    case 'user':
    default:
      return [
        ...baseItems,
        { id: 'become-seller', title: 'Become a Seller', icon: 'storefront-outline', screen: 'BecomeSeller', color: colors.secondary },
      ];
  }
};

export default function ProfileScreen({ navigation }) {
  const { currentUser, logout } = useAuth();

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Logout', style: 'destructive', onPress: logout },
      ]
    );
  }, [logout]);

  const handleLogin = useCallback(() => {
    navigation.navigate('Login');
  }, [navigation]);

  const handleMenuPress = useCallback((screen) => {
    navigation.navigate(screen);
  }, [navigation]);

  // Guest View
  if (!currentUser) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.guestHero}>
          <View style={styles.guestAvatarCircle}>
            <Ionicons name="person-outline" size={48} color={colors.white} />
          </View>
          <Text style={styles.guestHeroTitle}>Welcome to Tortrose</Text>
          <Text style={styles.guestHeroSubtitle}>Sign in to access your account</Text>
          <TouchableOpacity style={styles.heroLoginButton} onPress={handleLogin} activeOpacity={0.85}>
            <Text style={styles.heroLoginButtonText}>Login / Sign Up</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.guestFeaturesSection}>
          {[
            { icon: 'receipt-outline', title: 'Track Orders', desc: 'Monitor your purchases in real time' },
            { icon: 'heart-outline', title: 'Save Favorites', desc: 'Build and manage your wishlist' },
            { icon: 'shield-checkmark-outline', title: 'Trusted Stores', desc: 'Shop from verified sellers' },
          ].map((f) => (
            <View key={f.icon} style={styles.guestFeatureRow}>
              <View style={styles.guestFeatureIcon}>
                <Ionicons name={f.icon} size={22} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.guestFeatureTitle}>{f.title}</Text>
                <Text style={styles.guestFeatureDesc}>{f.desc}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text style={styles.appVersion}>Tortrose v{APP_VERSION}</Text>
      </SafeAreaView>
    );
  }

  const menuItems = getMenuItemsForRole(currentUser.role);
  const roleColors = { admin: colors.error, seller: colors.success, user: colors.primary };
  const roleBgColor = roleColors[currentUser.role] || colors.primary;
  const roleLabel = currentUser.role?.charAt(0).toUpperCase() + currentUser.role?.slice(1);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Hero Header */}
        <View style={styles.heroHeader}>
          <View style={styles.avatarWrapper}>
            {currentUser.avatar ? (
              <Image source={{ uri: currentUser.avatar }} style={styles.avatar} contentFit="cover" cachePolicy="memory-disk" transition={200} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>
                  {currentUser.name?.charAt(0)?.toUpperCase() || 'U'}
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.heroName}>{currentUser.name}</Text>
          <Text style={styles.heroEmail}>{currentUser.email}</Text>
          <View style={[styles.rolePill, { backgroundColor: 'rgba(255,255,255,0.25)' }]}>
            <Text style={styles.rolePillText}>{roleLabel}</Text>
          </View>
          <TouchableOpacity
            style={styles.editProfileBtn}
            onPress={() => navigation.navigate('EditProfile')}
            activeOpacity={0.8}
          >
            <Ionicons name="pencil-outline" size={14} color={colors.white} />
            <Text style={styles.editProfileBtnText}>Edit Profile</Text>
          </TouchableOpacity>
        </View>

        {/* Menu Section */}
        <View style={styles.menuSection}>
          <Text style={styles.sectionLabel}>MY ACCOUNT</Text>
          <View style={styles.menuCard}>
            {menuItems.map((item, index) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.menuRow, index < menuItems.length - 1 && styles.menuRowBorder]}
                onPress={() => handleMenuPress(item.screen)}
                activeOpacity={0.7}
              >
                <View style={[styles.menuIcon, { backgroundColor: (item.color || colors.primary) + '18' }]}>
                  <Ionicons name={item.icon} size={20} color={item.color || colors.primary} />
                </View>
                <Text style={styles.menuRowText}>{item.title}</Text>
                <Ionicons name="chevron-forward" size={18} color={colors.grayLight} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Logout */}
        <View style={styles.menuSection}>
          <View style={styles.menuCard}>
            <TouchableOpacity style={styles.menuRow} onPress={handleLogout} activeOpacity={0.7}>
              <View style={[styles.menuIcon, { backgroundColor: colors.errorLighter }]}>
                <Ionicons name="log-out-outline" size={20} color={colors.error} />
              </View>
              <Text style={[styles.menuRowText, { color: colors.error }]}>Logout</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.errorLight} />
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.appVersion}>Tortrose v{APP_VERSION}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Guest Hero
  guestHero: {
    backgroundColor: colors.primaryDark,
    alignItems: 'center',
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  guestAvatarCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  guestHeroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
    marginBottom: spacing.xs,
  },
  guestHeroSubtitle: {
    fontSize: fontSize.md,
    color: 'rgba(255,255,255,0.75)',
    marginBottom: spacing.xl,
  },
  heroLoginButton: {
    backgroundColor: colors.white,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxxl,
    borderRadius: borderRadius.lg,
  },
  heroLoginButtonText: {
    color: colors.primaryDark,
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
  },
  guestFeaturesSection: {
    backgroundColor: colors.white,
    margin: spacing.md,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    ...shadows.sm,
  },
  guestFeatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  guestFeatureIcon: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primarySubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  guestFeatureTitle: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  guestFeatureDesc: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: 2,
  },
  // Authenticated Hero Header
  heroHeader: {
    backgroundColor: colors.primaryDark,
    alignItems: 'center',
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  avatarWrapper: {
    marginBottom: spacing.md,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  avatarPlaceholder: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  avatarText: {
    fontSize: 36,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  heroName: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
    marginBottom: spacing.xs,
  },
  heroEmail: {
    fontSize: fontSize.sm,
    color: 'rgba(255,255,255,0.75)',
    marginBottom: spacing.md,
  },
  rolePill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  rolePillText: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  editProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  editProfileBtnText: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  // Menu Section
  menuSection: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  sectionLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.textLight,
    letterSpacing: 1,
    marginBottom: spacing.sm,
    paddingLeft: spacing.sm,
  },
  menuCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    ...shadows.sm,
    overflow: 'hidden',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  menuRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuRowText: {
    flex: 1,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
    color: colors.text,
  },
  // App version
  appVersion: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
});
