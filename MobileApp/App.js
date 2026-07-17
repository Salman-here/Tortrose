import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import * as Sentry from '@sentry/react-native';
import { AuthProvider } from './src/contexts/AuthContext';
import { GlobalProvider } from './src/contexts/GlobalContext';
import { CurrencyProvider } from './src/contexts/CurrencyContext';
import { ThemeProvider } from './src/contexts/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import OnboardingWalkthrough, { shouldShowOnboarding } from './src/components/OnboardingWalkthrough';
import { isBiometricEnabled, isBiometricAvailable, authenticateBiometric } from './src/utils/biometricLock';

// ─── Sentry Crash Reporting (only when a real DSN is configured) ─────────────
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: __DEV__ ? 'development' : 'production',
    enableInExpoDevelopment: false,
    debug: false,
    tracesSampleRate: __DEV__ ? 0 : 0.2,
  });
}

// ─── ErrorBoundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Unhandled error:', error, info);
    Sentry.captureException(error, { extra: { componentStack: info?.componentStack } });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={errorStyles.container}>
          <Ionicons name="warning-outline" size={64} color="#ef4444" />
          <Text style={errorStyles.title}>Something went wrong</Text>
          <Text style={errorStyles.message}>
            An unexpected error occurred. Please try again.
          </Text>
          {__DEV__ && this.state.error ? (
            <Text style={errorStyles.devError} numberOfLines={4}>
              {this.state.error.toString()}
            </Text>
          ) : null}
          <TouchableOpacity style={errorStyles.retryBtn} onPress={this.handleRetry}>
            <Text style={errorStyles.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

// ─── Offline Banner ──────────────────────────────────────────────────────────
function OfflineBanner() {
  const [isConnected, setIsConnected] = useState(true);
  const slideAnim = React.useRef(new Animated.Value(-60)).current;

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected && state.isInternetReachable !== false;
      setIsConnected(connected);
      Animated.timing(slideAnim, {
        toValue: connected ? -60 : 0,
        duration: 350,
        useNativeDriver: true,
      }).start();
    });
    return () => unsubscribe();
  }, [slideAnim]);

  if (isConnected) return null;

  return (
    <Animated.View style={[offlineBannerStyles.banner, { transform: [{ translateY: slideAnim }] }]}>
      <Ionicons name="wifi-outline" size={16} color="#fff" />
      <Text style={offlineBannerStyles.text}>No internet connection</Text>
    </Animated.View>
  );
}

// ─── Notification Initializer (must be inside NavigationContainer) ───────────
function NotificationInitializer() {
  const useNotifications = require('./src/hooks/useNotifications').default;
  useNotifications();
  return null;
}

const offlineBannerStyles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 9999,
    backgroundColor: '#ef4444',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 48,
    paddingBottom: 10,
    gap: 8,
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '600' },
});

const errorStyles = StyleSheet.create({
  container: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#f8fafc', padding: 32,
  },
  title: { fontSize: 22, fontWeight: '700', color: '#1e293b', marginTop: 16, marginBottom: 8 },
  message: { fontSize: 15, color: '#64748b', textAlign: 'center', lineHeight: 22, marginBottom: 12 },
  devError: {
    fontSize: 11, color: '#ef4444', backgroundColor: '#fef2f2',
    padding: 8, borderRadius: 8, marginBottom: 16, fontFamily: 'monospace',
  },
  retryBtn: {
    backgroundColor: '#6366f1', paddingVertical: 12, paddingHorizontal: 32,
    borderRadius: 12, marginTop: 8,
  },
  retryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

// ─── Deep Linking ────────────────────────────────────────────────────────────
const linking = {
  prefixes: ['rozare://', 'https://rozare.com', 'http://rozare.com'],
  config: {
    screens: {
      MainTabs: {
        screens: {
          Home: '',
          Marketplace: 'marketplace',
          Cart: 'cart',
          Notifications: 'notifications',
          Account: 'profile',
        },
      },
      ProductDetail: 'single-product/:productId',
      Store: 'store/:storeSlug',
      TrustedStores: 'marketplace/trusted',
      Wishlist: 'wishlist',
      Orders: 'orders',
      OrderDetail: 'order/:orderId',
      OrderConfirmation: 'orders/confirm/:token',
      Login: 'login',
      SignUp: 'signup',
      ForgotPassword: 'forgot-password',
      ResetPassword: 'reset-password/:token',
      Checkout: 'checkout',
      Settings: 'settings',
      EditProfile: 'edit-profile',
      BecomeSeller: 'become-seller',
      TrackOrder: 'track-order',
      AIChat: 'ai-chat',
      UserDashboard: 'user-dashboard',
      Wallet: 'wallet',
      PaymentSuccess: 'payment-success',
      PaymentCancel: 'payment-cancel',
      FAQ: 'faq',
      Contact: 'contact',
      About: 'about',
      TermsOfService: 'terms',
      PrivacyPolicy: 'privacy',
      Docs: 'docs',
      SellerDashboard: 'seller-dashboard',
      SellerOrderManagement: 'seller-returns',
    },
  },
};

function BiometricGate({ children }) {
  const [locked, setLocked] = useState(null); // null = checking, true = locked, false = open

  const tryUnlock = React.useCallback(async () => {
    const ok = await authenticateBiometric('Unlock Rozare');
    if (ok) setLocked(false);
  }, []);

  useEffect(() => {
    (async () => {
      const enabled = await isBiometricEnabled();
      if (!enabled) { setLocked(false); return; }
      const available = await isBiometricAvailable();
      if (!available) { setLocked(false); return; }
      setLocked(true);
      tryUnlock();
    })();
  }, [tryUnlock]);

  if (locked === null) return null;
  if (locked) {
    return (
      <View style={biometricStyles.container}>
        <Ionicons name="lock-closed" size={56} color="#6366f1" />
        <Text style={biometricStyles.title}>Rozare is locked</Text>
        <Text style={biometricStyles.subtitle}>Authenticate to continue</Text>
        <TouchableOpacity style={biometricStyles.btn} onPress={tryUnlock} activeOpacity={0.85}>
          <Ionicons name="finger-print" size={20} color="#fff" />
          <Text style={biometricStyles.btnText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return children;
}

const biometricStyles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a', padding: 32, gap: 12 },
  title: { fontSize: 22, fontWeight: '700', color: '#fff', marginTop: 16 },
  subtitle: { fontSize: 14, color: 'rgba(255,255,255,0.65)', marginBottom: 24 },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#6366f1', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});

function App() {
  const [showOnboarding, setShowOnboarding] = useState(null);

  useEffect(() => {
    shouldShowOnboarding().then(setShowOnboarding);
  }, []);

  // Still checking — show nothing briefly
  if (showOnboarding === null) return null;

  if (showOnboarding) {
    return (
      <SafeAreaProvider>
        <ThemeProvider>
          <OnboardingWalkthrough onComplete={() => setShowOnboarding(false)} />
        </ThemeProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <BiometricGate>
            <AuthProvider>
              <GlobalProvider>
                <CurrencyProvider>
                  <NavigationContainer linking={linking}>
                    <NotificationInitializer />
                    <AppNavigator />
                  </NavigationContainer>
                  <Toast />
                  <OfflineBanner />
                </CurrencyProvider>
              </GlobalProvider>
            </AuthProvider>
          </BiometricGate>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

export default SENTRY_DSN ? Sentry.wrap(App) : App;
