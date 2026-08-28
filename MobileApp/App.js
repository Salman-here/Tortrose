import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import * as Sentry from '@sentry/react-native';
import { AuthProvider } from './src/contexts/AuthContext';
import { GlobalProvider } from './src/contexts/GlobalContext';
import { CurrencyProvider } from './src/contexts/CurrencyContext';
import { StripeBootstrapProvider } from './src/contexts/StripeContext';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import AppNavigator from './src/navigation/AppNavigator';
import OnboardingWalkthrough, { shouldShowOnboarding } from './src/components/OnboardingWalkthrough';
import { isBiometricEnabled, isBiometricAvailable, authenticateBiometric } from './src/utils/biometricLock';
import GlassPanel from './src/components/common/GlassPanel';
import AppLaunchScreen from './src/components/common/AppLaunchScreen';

SplashScreen.setOptions({
  duration: 450,
  fade: true,
});

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
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const slideAnim = React.useRef(new Animated.Value(-18)).current;
  const opacityAnim = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected !== false && state.isInternetReachable !== false;
      if (!connected) {
        setVisible(true);
        Animated.parallel([
          Animated.spring(slideAnim, {
            toValue: 0,
            friction: 8,
            tension: 70,
            useNativeDriver: true,
          }),
          Animated.timing(opacityAnim, {
            toValue: 1,
            duration: 220,
            useNativeDriver: true,
          }),
        ]).start();
        return;
      }

      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: -18,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    });
    return () => {
      unsubscribe();
      slideAnim.stopAnimation();
      opacityAnim.stopAnimation();
    };
  }, [opacityAnim, slideAnim]);

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        offlineBannerStyles.anchor,
        {
          top: Math.max(insets.top + 8, 16),
          opacity: opacityAnim,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <GlassPanel
        variant="floating"
        style={[
          offlineBannerStyles.banner,
          {
            borderColor: palette.colors.warningLighter,
            backgroundColor: palette.glass.bgStrong,
          },
        ]}
      >
        <View style={[offlineBannerStyles.iconTile, { backgroundColor: palette.colors.warningSubtle }]}>
          <Ionicons name="cloud-offline-outline" size={20} color={palette.colors.warningDark} />
        </View>
        <View style={offlineBannerStyles.copy}>
          <Text style={[offlineBannerStyles.title, { color: palette.colors.text }]}>You’re offline</Text>
          <Text style={[offlineBannerStyles.text, { color: palette.colors.textSecondary }]} numberOfLines={1}>
            Saved content is still available
          </Text>
        </View>
        <TouchableOpacity
          style={[offlineBannerStyles.retry, { backgroundColor: palette.colors.warningSubtle }]}
          onPress={() => NetInfo.refresh()}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Retry internet connection"
        >
          <Ionicons name="refresh" size={16} color={palette.colors.warningDark} />
        </TouchableOpacity>
      </GlassPanel>
    </Animated.View>
  );
}

function ThemedStatusBar() {
  const { isDark } = useTheme();
  return (
    <ExpoStatusBar
      style={isDark ? 'light' : 'dark'}
      translucent
      backgroundColor="transparent"
    />
  );
}

// ─── Notification Initializer (must be inside NavigationContainer) ───────────
function NotificationInitializer() {
  const useNotifications = require('./src/hooks/useNotifications').default;
  useNotifications();
  return null;
}

const offlineBannerStyles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: 14,
    right: 14,
    zIndex: 9999,
    elevation: 30,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 60,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 20,
  },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
  text: { marginTop: 1, fontSize: 11, lineHeight: 15, fontWeight: '500' },
  retry: {
    width: 36,
    height: 36,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
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
          Wishlist: 'favorites',
          Account: 'profile',
        },
      },
      ProductDetail: 'single-product/:productId',
      Store: 'store/:storeSlug',
      Notifications: 'notifications',
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
      PaymentMethods: 'payment-methods',
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
      SellerSubscription: 'seller-subscription',
      SellerSubdomainManagement: 'seller-subdomain',
      SellerAds: 'seller-ads',
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

  if (locked === null) return <AppLaunchScreen message="Securing your space" />;
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

  // Keep the native splash transition visually continuous while local state hydrates.
  if (showOnboarding === null) return <AppLaunchScreen />;

  if (showOnboarding) {
    return (
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStatusBar />
          <OnboardingWalkthrough onComplete={() => setShowOnboarding(false)} />
        </ThemeProvider>
      </SafeAreaProvider>
    );
  }

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStatusBar />
          <KeyboardProvider
            statusBarTranslucent
            navigationBarTranslucent
            preserveEdgeToEdge
          >
            <StripeBootstrapProvider>
              <BiometricGate>
                <AuthProvider>
                  <GlobalProvider>
                    <CurrencyProvider>
                      <NavigationContainer linking={linking}>
                        <NotificationInitializer />
                        <AppNavigator />
                      </NavigationContainer>
                      <OfflineBanner />
                    </CurrencyProvider>
                  </GlobalProvider>
                </AuthProvider>
              </BiometricGate>
            </StripeBootstrapProvider>
          </KeyboardProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

export default SENTRY_DSN ? Sentry.wrap(App) : App;
