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
import { 
  colors, 
  spacing, 
  fontSize, 
  fontWeight, 
  borderRadius,
  shadows,
} from '../styles/theme';

// Auth Screens
import LoginScreen from '../screens/auth/LoginScreen';
import SignUpScreen from '../screens/auth/SignUpScreen';
import ForgotPasswordScreen from '../screens/auth/ForgotPasswordScreen';
import OTPVerificationScreen from '../screens/auth/OTPVerificationScreen';
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
import WishlistScreen from '../screens/WishlistScreen';

// Admin Screens
import AdminDashboardScreen from '../screens/admin/AdminDashboardScreen';
import AdminUserManagementScreen from '../screens/admin/AdminUserManagementScreen';
import AdminTaxConfigurationScreen from '../screens/admin/AdminTaxConfigurationScreen';

// Seller Screens
import SellerDashboardScreen from '../screens/seller/SellerDashboardScreen';
import SellerStoreSettingsScreen from '../screens/seller/SellerStoreSettingsScreen';
import SellerShippingConfigurationScreen from '../screens/seller/SellerShippingConfigurationScreen';
import SellerAnalyticsScreen from '../screens/seller/SellerAnalyticsScreen';

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
const GuardedSellerDashboard = createRoleGuard(SellerDashboardScreen, ['seller', 'admin']);
const GuardedSellerAnalytics = createRoleGuard(SellerAnalyticsScreen, ['seller', 'admin']);
const GuardedSellerStoreOverview = createRoleGuard(StoreOverviewScreen, ['seller', 'admin']);
const GuardedSellerProductManagement = createRoleGuard(ProductManagementScreen, ['seller', 'admin']);
const GuardedSellerOrderManagement = createRoleGuard(OrderManagementScreen, ['seller', 'admin']);
const GuardedSellerStoreSettings = createRoleGuard(SellerStoreSettingsScreen, ['seller', 'admin']);
const GuardedSellerShippingConfiguration = createRoleGuard(SellerShippingConfigurationScreen, ['seller', 'admin']);
const GuardedProductForm = createRoleGuard(ProductFormScreen, ['seller', 'admin']);
const GuardedOrderDetailManagement = createRoleGuard(OrderDetailManagementScreen, ['seller', 'admin']);

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
    Cart: { active: 'cart', inactive: 'cart-outline' },
    Wishlist: { active: 'heart', inactive: 'heart-outline' },
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
  const { cartItems } = useGlobal();
  const cartCount = calculateCartItemCount(cartItems);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          return (
            <View style={styles.tabIconContainer}>
              <TabBarIcon route={route} focused={focused} color={color} size={24} />
              {route.name === 'Cart' && <CartBadge count={cartCount} />}
            </View>
          );
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.grayLight,
        tabBarStyle: styles.tabBar,
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
        name="Stores" 
        component={StoresListingScreen}
        options={{ tabBarLabel: 'Stores' }}
      />
      <Tab.Screen 
        name="Cart" 
        component={CartScreen}
        options={{ tabBarLabel: 'Cart' }}
      />
      <Tab.Screen 
        name="Wishlist" 
        component={WishlistScreen}
        options={{ tabBarLabel: 'Wishlist' }}
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
        options={{ title: 'Product Details' }}
      />
      <Stack.Screen
        name="Store"
        component={StoreScreen}
        options={{ title: 'Store' }}
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
        options={{ title: 'Order Details' }}
      />

      {/* Admin Dashboard (role-guarded: admin only) */}
      <Stack.Screen
        name="AdminDashboard"
        component={GuardedAdminDashboard}
        options={{ title: 'Admin Dashboard' }}
      />
      <Stack.Screen
        name="AdminStoreOverview"
        component={GuardedAdminStoreOverview}
        initialParams={{ isAdmin: true }}
        options={{ title: 'Store Overview' }}
      />
      <Stack.Screen
        name="AdminProductManagement"
        component={GuardedAdminProductManagement}
        initialParams={{ isAdmin: true }}
        options={{ title: 'Product Management' }}
      />
      <Stack.Screen
        name="AdminOrderManagement"
        component={GuardedAdminOrderManagement}
        initialParams={{ isAdmin: true }}
        options={{ title: 'Order Management' }}
      />
      <Stack.Screen
        name="AdminUserManagement"
        component={GuardedAdminUserManagement}
        options={{ title: 'User Management' }}
      />
      <Stack.Screen
        name="AdminTaxConfiguration"
        component={GuardedAdminTaxConfiguration}
        options={{ title: 'Tax Configuration' }}
      />
      <Stack.Screen
        name="StoreVerification"
        component={GuardedStoreVerification}
        options={{ title: 'Store Verification' }}
      />
      <Stack.Screen
        name="AdminNotifications"
        component={GuardedAdminNotifications}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="AdminAnalytics"
        component={GuardedAdminAnalytics}
        options={{ title: 'Platform Analytics' }}
      />

      {/* Seller Dashboard (role-guarded: seller or admin) */}
      <Stack.Screen
        name="SellerDashboard"
        component={GuardedSellerDashboard}
        options={{ title: 'Seller Dashboard' }}
      />
      <Stack.Screen
        name="SellerAnalytics"
        component={GuardedSellerAnalytics}
        options={{ title: 'Store Analytics' }}
      />
      <Stack.Screen
        name="SellerStoreOverview"
        component={GuardedSellerStoreOverview}
        initialParams={{ isAdmin: false }}
        options={{ title: 'Store Overview' }}
      />
      <Stack.Screen
        name="SellerProductManagement"
        component={GuardedSellerProductManagement}
        initialParams={{ isAdmin: false }}
        options={{ title: 'Product Management' }}
      />
      <Stack.Screen
        name="SellerOrderManagement"
        component={GuardedSellerOrderManagement}
        initialParams={{ isAdmin: false }}
        options={{ title: 'Order Management' }}
      />
      <Stack.Screen
        name="SellerStoreSettings"
        component={GuardedSellerStoreSettings}
        options={{ title: 'Store Settings' }}
      />
      <Stack.Screen
        name="SellerShippingConfiguration"
        component={GuardedSellerShippingConfiguration}
        options={{ title: 'Shipping Configuration' }}
      />
      <Stack.Screen
        name="SellerNotifications"
        component={GuardedSellerNotifications}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="SellerHome"
        component={GuardedSellerHome}
        options={{ title: 'Seller Home' }}
      />
      <Stack.Screen
        name="NotificationSettings"
        component={GuardedNotificationSettings}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="UserDashboard"
        component={UserDashboardScreen}
        options={{ headerShown: false }}
      />

      {/* Shared Screens (role-guarded: seller or admin) */}
      <Stack.Screen
        name="ProductForm"
        component={GuardedProductForm}
        options={({ route }) => ({
          title: route.params?.productId ? 'Edit Product' : 'Add Product'
        })}
      />
      <Stack.Screen
        name="OrderDetailManagement"
        component={GuardedOrderDetailManagement}
        options={{ title: 'Order Details' }}
      />

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
      <Stack.Screen
        name="TrustedStores"
        component={TrustedStoresScreen}
        options={{ title: 'Trusted Stores' }}
      />
      <Stack.Screen
        name="BecomeSeller"
        component={BecomeSellerScreen}
        options={{ title: 'Become a Seller' }}
      />

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
    backgroundColor: 'rgba(255, 255, 255, 0.82)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.25)',
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.sm,
    height: Platform.OS === 'ios' ? 85 : 65,
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    elevation: 0,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.06,
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
