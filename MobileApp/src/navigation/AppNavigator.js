/**
 * AppNavigator
 * Modern navigation system with enhanced tab bar and consistent styling
 * 
 * Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6, 29.7
 */

import React, { useEffect, useRef } from 'react';
import { createStackNavigator, CardStyleInterpolators } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { View, Text, StyleSheet, Animated, Platform, Alert } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { selection as hapticSelection } from '../utils/haptics';

// Glass tab-bar background — BlurView on iOS, opaque-glass fallback on Android.
function GlassTabBarBackground({ isDark, palette }) {
  if (Platform.OS === 'ios') {
    return (
      <BlurView
        tint={isDark ? 'dark' : 'light'}
        intensity={60}
        style={[StyleSheet.absoluteFill, { borderTopWidth: 1, borderTopColor: palette.glass.borderSubtle }]}
      />
    );
  }
  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor: isDark ? 'rgba(20,26,46,0.96)' : 'rgba(255,255,255,0.96)',
          borderTopWidth: 1,
          borderTopColor: palette.glass.borderSubtle,
        },
      ]}
    />
  );
}
import { 
  colors, 
  spacing, 
  fontSize, 
  fontWeight, 
  borderRadius,
  shadows,
} from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

// Auth Screens
import LoginScreen from '../screens/auth/LoginScreen';
import SignUpScreen from '../screens/auth/SignUpScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';
import ResetPasswordScreen from '../screens/auth/ResetPasswordScreen';
import OTPVerificationScreen from '../screens/auth/OTPVerificationScreen';
import SellerSignUpScreen from '../screens/auth/SellerSignUpScreen';
import ChangePasswordScreen from '../screens/ChangePasswordScreen';

// Main Screens
import HomeScreen from '../screens/HomeScreen';
import ProductDetailScreen from '../screens/ProductDetailScreen';
import StoreScreen from '../screens/StoreScreen';
import StoresListingScreen from '../screens/StoresListingScreen';
import CartScreen from '../screens/CartScreen';
import ProfileScreen from '../screens/ProfileScreen';
import CheckoutScreen from '../screens/CheckoutScreen';
import OrdersScreen from '../screens/OrdersScreen';
import OrderDetailScreen from '../screens/OrderDetailScreen';
import OrderConfirmationScreen from '../screens/OrderConfirmationScreen';
import WishlistScreen from '../screens/WishlistScreen';

// Admin Screens
import AdminDashboardScreen from '../screens/admin/AdminDashboardScreen';
import AdminUserManagementScreen from '../screens/admin/AdminUserManagementScreen';
import AdminTaxConfigurationScreen from '../screens/admin/AdminTaxConfigurationScreen';
import AdminSubdomainManagementScreen from '../screens/admin/AdminSubdomainManagementScreen';
import AdminComplaintsScreen from '../screens/admin/AdminComplaintsScreen';
import AdminSubscriptionsScreen from '../screens/admin/AdminSubscriptionsScreen';
import AdminBroadcastScreen from '../screens/admin/AdminBroadcastScreen';
import AdminWhatsAppVerificationScreen from '../screens/admin/AdminWhatsAppVerificationScreen';
import AdminPaymentsScreen from '../screens/admin/AdminPaymentsScreen';

// Seller Screens
import SellerDashboardScreen from '../screens/seller/SellerDashboardScreen';
import SellerStoreSettingsScreen from '../screens/seller/SellerStoreSettingsScreen';
import SellerShippingConfigurationScreen from '../screens/seller/SellerShippingConfigurationScreen';
import SellerAnalyticsScreen from '../screens/seller/SellerAnalyticsScreen';
import SellerSubscriptionScreen from '../screens/seller/SellerSubscriptionScreen';
import SellerSubdomainManagementScreen from '../screens/seller/SellerSubdomainManagementScreen';
import SellerCouponManagementScreen from '../screens/seller/SellerCouponManagementScreen';
import SellerWhatsAppSettingsScreen from '../screens/seller/SellerWhatsAppSettingsScreen';
import SellerComplaintsScreen from '../screens/seller/SellerComplaintsScreen';
import SellerPaymentsScreen from '../screens/seller/SellerPaymentsScreen';

// Shared Screens
import ProductManagementScreen from '../screens/shared/ProductManagementScreen';
import ProductFormScreen from '../screens/shared/ProductFormScreen';
import OrderManagementScreen from '../screens/shared/OrderManagementScreen';
import OrderDetailManagementScreen from '../screens/shared/OrderDetailManagementScreen';
import StoreOverviewScreen from '../screens/shared/StoreOverviewScreen';

// Payment Screens
import PaymentSuccessScreen from '../screens/PaymentSuccessScreen';
import PaymentCancelScreen from '../screens/PaymentCancelScreen';

// New Feature Screens
import TrustedStoresScreen from '../screens/TrustedStoresScreen';
import BecomeSellerScreen from '../screens/BecomeSellerScreen';
import StoreVerificationScreen from '../screens/admin/StoreVerificationScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import EditProfileScreen from '../screens/EditProfileScreen';
import AdminNotificationsScreen from '../screens/admin/AdminNotificationsScreen';
import SellerNotificationsScreen from '../screens/seller/SellerNotificationsScreen';
import AdminAnalyticsScreen from '../screens/admin/AdminAnalyticsScreen';
import NotificationSettingsScreen from '../screens/shared/NotificationSettingsScreen';
import SellerHomeScreen from '../screens/seller/SellerHomeScreen';
import UserDashboardScreen from '../screens/UserDashboardScreen';
import AIChatScreen from '../screens/AIChatScreen';
import UserWhatsAppSettingsScreen from '../screens/UserWhatsAppSettingsScreen';

// Informational Screens
import FAQScreen from '../screens/FAQScreen';
import ContactScreen from '../screens/ContactScreen';
import AboutScreen from '../screens/AboutScreen';
import TermsOfServiceScreen from '../screens/TermsOfServiceScreen';
import PrivacyPolicyScreen from '../screens/PrivacyPolicyScreen';
import TrackOrderScreen from '../screens/TrackOrderScreen';
import NotificationPreferencesScreen from '../screens/NotificationPreferencesScreen';
import SavedAddressesScreen from '../screens/SavedAddressesScreen';
import DocsScreen from '../screens/DocsScreen';
import SellerProfileScreen from '../screens/seller/SellerProfileScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

/**
 * Role guard HOC factory.
 * Returns a React component that checks `currentUser.role` before rendering.
 * If the user lacks the required role it shows an Alert and navigates back.
 * @param {React.ComponentType} Component - Screen to guard
 * @param {string[]} allowedRoles - e.g. ['admin'] or ['seller', 'admin']
 */
function createRoleGuard(Component, allowedRoles) {
  return function RoleGuardedScreen(props) {
    const { currentUser } = useAuth();
    const { navigation } = props;
    const hasAccess = currentUser && allowedRoles.includes(currentUser.role);

    useEffect(() => {
      if (!hasAccess) {
        Alert.alert(
          'Access Denied',
          currentUser
            ? 'You do not have permission to access this page.'
            : 'Please log in to continue.',
          [{ text: 'OK', onPress: () => navigation.goBack() }]
        );
      }
    }, [hasAccess, navigation]);

    if (!hasAccess) return null;
    return <Component {...props} />;
  };
}

// Guarded admin screens (admin only)
const GuardedAdminDashboard = createRoleGuard(AdminDashboardScreen, ['admin']);
const GuardedAdminUserManagement = createRoleGuard(AdminUserManagementScreen, ['admin']);
const GuardedAdminTaxConfiguration = createRoleGuard(AdminTaxConfigurationScreen, ['admin']);
const GuardedStoreVerification = createRoleGuard(StoreVerificationScreen, ['admin']);
const GuardedAdminStoreOverview = createRoleGuard(StoreOverviewScreen, ['admin']);
const GuardedAdminProductManagement = createRoleGuard(ProductManagementScreen, ['admin']);
const GuardedAdminOrderManagement = createRoleGuard(OrderManagementScreen, ['admin']);
const GuardedAdminNotifications = createRoleGuard(AdminNotificationsScreen, ['admin']);
const GuardedAdminAnalytics = createRoleGuard(AdminAnalyticsScreen, ['admin']);
const GuardedAdminSubdomainManagement = createRoleGuard(AdminSubdomainManagementScreen, ['admin']);
const GuardedAdminComplaints = createRoleGuard(AdminComplaintsScreen, ['admin']);
const GuardedAdminSubscriptions = createRoleGuard(AdminSubscriptionsScreen, ['admin']);
const GuardedAdminBroadcast = createRoleGuard(AdminBroadcastScreen, ['admin']);
const GuardedAdminWhatsApp = createRoleGuard(AdminWhatsAppVerificationScreen, ['admin']);
const GuardedAdminPayments = createRoleGuard(AdminPaymentsScreen, ['admin']);

// Guarded seller screens (seller or admin)
const GuardedSellerDashboard = createRoleGuard(SellerDashboardScreen, ['seller', 'admin']);
const GuardedSellerAnalytics = createRoleGuard(SellerAnalyticsScreen, ['seller', 'admin']);
const GuardedSellerStoreOverview = createRoleGuard(StoreOverviewScreen, ['seller', 'admin']);
const GuardedSellerProductManagement = createRoleGuard(ProductManagementScreen, ['seller', 'admin']);
const GuardedSellerOrderManagement = createRoleGuard(OrderManagementScreen, ['seller', 'admin']);
const GuardedSellerStoreSettings = createRoleGuard(SellerStoreSettingsScreen, ['seller', 'admin']);
const GuardedSellerShippingConfiguration = createRoleGuard(SellerShippingConfigurationScreen, ['seller', 'admin']);
const GuardedProductForm = createRoleGuard(ProductFormScreen, ['seller', 'admin']);
const GuardedOrderDetailManagement = createRoleGuard(OrderDetailManagementScreen, ['seller', 'admin']);
const GuardedSellerNotifications = createRoleGuard(SellerNotificationsScreen, ['seller', 'admin']);
const GuardedSellerHome = createRoleGuard(SellerHomeScreen, ['seller', 'admin']);
const GuardedNotificationSettings = createRoleGuard(NotificationSettingsScreen, ['seller', 'admin']);
const GuardedSellerSubscription = createRoleGuard(SellerSubscriptionScreen, ['seller', 'admin']);
const GuardedSellerSubdomainManagement = createRoleGuard(SellerSubdomainManagementScreen, ['seller', 'admin']);
const GuardedSellerCouponManagement = createRoleGuard(SellerCouponManagementScreen, ['seller', 'admin']);
const GuardedSellerWhatsAppSettings = createRoleGuard(SellerWhatsAppSettingsScreen, ['seller', 'admin']);
const GuardedSellerComplaints = createRoleGuard(SellerComplaintsScreen, ['seller', 'admin']);
const GuardedSellerProfile = createRoleGuard(SellerProfileScreen, ['seller', 'admin']);
const GuardedSellerPayments = createRoleGuard(SellerPaymentsScreen, ['seller', 'admin']);
const GuardedUserWhatsAppSettings = createRoleGuard(UserWhatsAppSettingsScreen, ['user', 'admin']);

// Helper function to calculate cart item count - exported for testing
export const calculateCartItemCount = (cartItems) => {
  if (!cartItems?.cart || !Array.isArray(cartItems.cart)) return 0;
  return cartItems.cart.reduce((total, item) => total + (item.qty || 1), 0);
};

// Helper function to get tab icon name - exported for testing
export const getTabIconName = (routeName, focused) => {
  const iconMap = {
    Home: { active: 'home', inactive: 'home-outline' },
    Stores: { active: 'storefront', inactive: 'storefront-outline' },
    Marketplace: { active: 'storefront', inactive: 'storefront-outline' },
    Cart: { active: 'cart', inactive: 'cart-outline' },
    Wishlist: { active: 'heart', inactive: 'heart-outline' },
    Notifications: { active: 'notifications', inactive: 'notifications-outline' },
    Account: { active: 'person', inactive: 'person-outline' },
  };
  const icons = iconMap[routeName] || { active: 'help', inactive: 'help-outline' };
  return focused ? icons.active : icons.inactive;
};

// Helper function to get tab color - exported for testing
export const getTabColor = (focused) => {
  return focused ? colors.primary : colors.grayLight;
};

// Animated Cart Badge Component
function CartBadge({ count }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const prevCount = useRef(count);

  useEffect(() => {
    if (count !== prevCount.current && count > 0) {
      // Animate badge when count changes
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: 1.3,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start();
    }
    prevCount.current = count;
  }, [count, scaleAnim]);

  if (count === 0) return null;

  return (
    <Animated.View style={[styles.badge, { transform: [{ scale: scaleAnim }] }]}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </Animated.View>
  );
}

// Tab Bar Icon Component with animation
function TabBarIcon({ route, focused, color, size }) {
  const iconName = getTabIconName(route.name, focused);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: focused ? 1.1 : 1,
      friction: 5,
      useNativeDriver: true,
    }).start();
  }, [focused, scaleAnim]);

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <Ionicons name={iconName} size={size} color={color} />
    </Animated.View>
  );
}

// Bottom Tab Navigator for main app - accessible to all users (guests included)
function MainTabs() {
  const { cartItems, unreadNotifCount } = useGlobal();
  const cartCount = calculateCartItemCount(cartItems);
  const insets = useSafeAreaInsets();
  const { palette, isDark } = useTheme();
  const themedTabBar = {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    borderTopColor: 'transparent',
  };

  return (
    <Tab.Navigator
      screenListeners={{
        tabPress: () => {
          hapticSelection();
        },
      }}
      screenOptions={({ route }) => ({
        tabBarBackground: () => <GlassTabBarBackground isDark={isDark} palette={palette} />,
        tabBarIcon: ({ focused, color, size }) => {
          return (
            <View style={styles.tabIconContainer}>
              <TabBarIcon route={route} focused={focused} color={color} size={24} />
              {route.name === 'Cart' && <CartBadge count={cartCount} />}
              {route.name === 'Notifications' && <CartBadge count={unreadNotifCount} />}
            </View>
          );
        },
        tabBarActiveTintColor: palette.colors.primary,
        tabBarInactiveTintColor: palette.colors.textLight,
        tabBarStyle: [
          styles.tabBar,
          themedTabBar,
          {
            paddingBottom: Math.max(insets.bottom, Platform.OS === 'ios' ? spacing.xl : spacing.sm),
            height: (Platform.OS === 'ios' ? 85 : 65) + Math.max(insets.bottom - (Platform.OS === 'ios' ? spacing.xl : spacing.sm), 0),
          },
        ],
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
        headerShown: false,
      })}
    >
      <Tab.Screen 
        name="Home" 
        component={HomeScreen}
        options={{ tabBarLabel: 'Home' }}
      />
      <Tab.Screen 
        name="Marketplace" 
        component={StoresListingScreen}
        options={{ tabBarLabel: 'Marketplace' }}
      />
      <Tab.Screen 
        name="Cart" 
        component={CartScreen}
        options={{ tabBarLabel: 'Cart' }}
      />
      <Tab.Screen 
        name="Notifications" 
        component={NotificationsScreen}
        options={{ tabBarLabel: 'Alerts' }}
      />
      <Tab.Screen 
        name="Account" 
        component={ProfileScreen}
        options={{ tabBarLabel: 'Account' }}
      />
    </Tab.Navigator>
  );
}

// Main App Navigator - No auth gate, everyone can browse
export default function AppNavigator() {
  const { isLoading } = useAuth();

  // Default screen options for stack navigator - defined inside component to ensure styles are available
  const defaultScreenOptions = {
    headerStyle: {
      backgroundColor: colors.primaryDark,
      elevation: 0,
      shadowOpacity: 0,
      borderBottomWidth: 0,
    },
    headerTintColor: colors.white,
    headerTitleStyle: {
      fontWeight: fontWeight.semibold,
      fontSize: fontSize.lg,
      color: colors.white,
    },
    headerBackTitleVisible: false,
    headerLeftContainerStyle: {
      paddingLeft: spacing.sm,
    },
    cardStyleInterpolator: CardStyleInterpolators.forHorizontalIOS,
    gestureEnabled: true,
    gestureDirection: 'horizontal',
  };

  if (isLoading) {
    return null;
  }

  return (
    <Stack.Navigator screenOptions={defaultScreenOptions}>
      {/* Main App - accessible to everyone */}
      <Stack.Screen
        name="MainTabs"
        component={MainTabs}
        options={{ headerShown: false }}
      />
      
      {/* Auth Screens - accessible when not logged in */}
      <Stack.Screen
        name="Login"
        component={LoginScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="SignUp"
        component={SignUpScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="ForgotPassword"
        component={ForgotPasswordScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="ResetPassword"
        component={ResetPasswordScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="OTPVerification"
        component={OTPVerificationScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="ChangePassword"
        component={ChangePasswordScreen}
        options={{ headerShown: false }}
      />

      {/* Product & Store Screens */}
      <Stack.Screen
        name="ProductDetail"
        component={ProductDetailScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Store"
        component={StoreScreen}
        options={{ headerShown: false }}
      />
      
      {/* Protected Screens - require login */}
      <Stack.Screen
        name="Checkout"
        component={CheckoutScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Orders"
        component={OrdersScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="OrderDetail"
        component={OrderDetailScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="OrderConfirmation"
        component={OrderConfirmationScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Wishlist"
        component={WishlistScreen}
        options={{ headerShown: false }}
      />

      {/* Admin Dashboard (role-guarded: admin only) */}
      <Stack.Screen name="AdminDashboard" component={GuardedAdminDashboard} options={{ headerShown: false }} />
      <Stack.Screen name="AdminStoreOverview" component={GuardedAdminStoreOverview} initialParams={{ isAdmin: true }} options={{ headerShown: false }} />
      <Stack.Screen name="AdminProductManagement" component={GuardedAdminProductManagement} initialParams={{ isAdmin: true }} options={{ headerShown: false }} />
      <Stack.Screen name="AdminOrderManagement" component={GuardedAdminOrderManagement} initialParams={{ isAdmin: true }} options={{ headerShown: false }} />
      <Stack.Screen name="AdminUserManagement" component={GuardedAdminUserManagement} options={{ headerShown: false }} />
      <Stack.Screen name="AdminTaxConfiguration" component={GuardedAdminTaxConfiguration} options={{ headerShown: false }} />
      <Stack.Screen name="StoreVerification" component={GuardedStoreVerification} options={{ headerShown: false }} />
      <Stack.Screen name="AdminNotifications" component={GuardedAdminNotifications} options={{ headerShown: false }} />
      <Stack.Screen name="AdminAnalytics" component={GuardedAdminAnalytics} options={{ headerShown: false }} />
      <Stack.Screen name="AdminSubdomainManagement" component={GuardedAdminSubdomainManagement} options={{ headerShown: false }} />
      <Stack.Screen name="AdminComplaints" component={GuardedAdminComplaints} options={{ headerShown: false }} />
      <Stack.Screen name="AdminSubscriptions" component={GuardedAdminSubscriptions} options={{ headerShown: false }} />
      <Stack.Screen name="AdminBroadcast" component={GuardedAdminBroadcast} options={{ headerShown: false }} />
      <Stack.Screen name="AdminWhatsAppVerification" component={GuardedAdminWhatsApp} options={{ headerShown: false }} />
      <Stack.Screen name="AdminPayments" component={GuardedAdminPayments} options={{ headerShown: false }} />

      {/* Seller Dashboard (role-guarded: seller or admin) */}
      <Stack.Screen name="SellerDashboard" component={GuardedSellerDashboard} options={{ headerShown: false }} />
      <Stack.Screen name="SellerAnalytics" component={GuardedSellerAnalytics} options={{ headerShown: false }} />
      <Stack.Screen name="SellerStoreOverview" component={GuardedSellerStoreOverview} initialParams={{ isAdmin: false }} options={{ headerShown: false }} />
      <Stack.Screen name="SellerProductManagement" component={GuardedSellerProductManagement} initialParams={{ isAdmin: false }} options={{ headerShown: false }} />
      <Stack.Screen name="SellerOrderManagement" component={GuardedSellerOrderManagement} initialParams={{ isAdmin: false }} options={{ headerShown: false }} />
      <Stack.Screen name="SellerStoreSettings" component={GuardedSellerStoreSettings} options={{ headerShown: false }} />
      <Stack.Screen name="SellerShippingConfiguration" component={GuardedSellerShippingConfiguration} options={{ headerShown: false }} />
      <Stack.Screen name="SellerNotifications" component={GuardedSellerNotifications} options={{ headerShown: false }} />
      <Stack.Screen name="SellerHome" component={GuardedSellerHome} options={{ headerShown: false }} />
      <Stack.Screen name="NotificationSettings" component={GuardedNotificationSettings} options={{ headerShown: false }} />
      <Stack.Screen name="SellerSubscription" component={GuardedSellerSubscription} options={{ headerShown: false }} />
      <Stack.Screen name="SellerSubdomainManagement" component={GuardedSellerSubdomainManagement} options={{ headerShown: false }} />
      <Stack.Screen name="SellerCouponManagement" component={GuardedSellerCouponManagement} options={{ headerShown: false }} />
      <Stack.Screen name="SellerWhatsAppSettings" component={GuardedSellerWhatsAppSettings} options={{ headerShown: false }} />
      <Stack.Screen name="SellerComplaints" component={GuardedSellerComplaints} options={{ headerShown: false }} />
      <Stack.Screen name="SellerProfile" component={GuardedSellerProfile} options={{ headerShown: false }} />
      <Stack.Screen name="SellerPayments" component={GuardedSellerPayments} options={{ headerShown: false }} />
      <Stack.Screen name="AIChat" component={AIChatScreen} options={{ headerShown: false }} />
      <Stack.Screen name="UserDashboard" component={UserDashboardScreen} options={{ headerShown: false }} />
      <Stack.Screen name="UserWhatsAppSettings" component={GuardedUserWhatsAppSettings} options={{ headerShown: false }} />

      {/* Shared Screens (role-guarded: seller or admin) */}
      <Stack.Screen name="ProductForm" component={GuardedProductForm} options={{ headerShown: false }} />
      <Stack.Screen name="OrderDetailManagement" component={GuardedOrderDetailManagement} options={{ headerShown: false }} />

      {/* Feature Screens */}
      <Stack.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="EditProfile"
        component={EditProfileScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen name="TrustedStores" component={TrustedStoresScreen} options={{ headerShown: false }} />
      <Stack.Screen name="BecomeSeller" component={BecomeSellerScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SellerSignUp" component={SellerSignUpScreen} options={{ headerShown: false }} />
      <Stack.Screen name="TrackOrder" component={TrackOrderScreen} options={{ headerShown: false }} />
      <Stack.Screen name="NotificationPreferences" component={NotificationPreferencesScreen} options={{ headerShown: false }} />
      <Stack.Screen name="SavedAddresses" component={SavedAddressesScreen} options={{ headerShown: false }} />

      {/* Informational Screens */}
      <Stack.Screen name="FAQ" component={FAQScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Contact" component={ContactScreen} options={{ headerShown: false }} />
      <Stack.Screen name="About" component={AboutScreen} options={{ headerShown: false }} />
      <Stack.Screen name="TermsOfService" component={TermsOfServiceScreen} options={{ headerShown: false }} />
      <Stack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Docs" component={DocsScreen} options={{ headerShown: false }} />

      {/* Payment Result Screens */}
      <Stack.Screen
        name="PaymentSuccess"
        component={PaymentSuccessScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="PaymentCancel"
        component={PaymentCancelScreen}
        options={{ headerShown: false }}
      />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  // Tab Bar Styles
  tabBar: {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    paddingTop: spacing.sm,
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    elevation: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
  },
  tabBarLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    marginTop: spacing.xs,
  },
  tabBarItem: {
    paddingVertical: spacing.xs,
  },
  tabIconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },

  // Badge Styles
  badge: {
    position: 'absolute',
    right: -12,
    top: -6,
    backgroundColor: colors.error,
    borderRadius: borderRadius.full,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    borderWidth: 2,
    borderColor: colors.white,
    ...shadows.sm,
  },
  badgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
  },

  // Header Styles
  header: {
    backgroundColor: colors.dark,
    elevation: 0,
    shadowOpacity: 0,
    borderBottomWidth: 0,
  },
  headerTitle: {
    fontWeight: fontWeight.semibold,
    fontSize: fontSize.lg,
    color: colors.white,
  },
  headerLeftContainer: {
    paddingLeft: spacing.sm,
  },
});
