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
import AppNavigator from './src/navigation/AppNavigator';

// ─── Sentry Crash Reporting ──────────────────────────────────────────────────
// Replace the DSN below with your own from https://sentry.io
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN || 'https://examplePublicKey@o0.ingest.sentry.io/0',
  environment: __DEV__ ? 'development' : 'production',
  enableInExpoDevelopment: false,   // disable in local dev to reduce noise
  debug: false,
  tracesSampleRate: __DEV__ ? 0 : 0.2,   // capture 20% of transactions in prod
});

/**
 * ErrorBoundary — catches unhandled React render errors so the app
 * shows a friendly screen instead of a blank white crash.
 */
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

/**
 * OfflineBanner — slides in from top when internet connection is lost,
 * slides out when reconnected.
 */
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

/**
 * Deep Linking Configuration
 * Maps URLs (tortrose:// and https://tortrose.com) to screens.
 */
const linking = {
  prefixes: ['tortrose://', 'https://tortrose.com', 'http://tortrose.com'],
  config: {
    screens: {
      MainTabs: {
        screens: {
          Home: 'home',
          Stores: 'stores',
          Cart: 'cart',
          Wishlist: 'wishlist',
          Account: 'account',
        },
      },
      ProductDetail: 'product/:productId',
      Store: 'store/:storeSlug',
      Orders: 'orders',
      OrderDetail: 'order/:orderId',
      Login: 'login',
      SignUp: 'signup',
      ForgotPassword: 'forgot-password',
      Checkout: 'checkout',
      Notifications: 'notifications',
      Settings: 'settings',
      EditProfile: 'edit-profile',
      TrustedStores: 'trusted-stores',
      BecomeSeller: 'become-seller',
      PaymentSuccess: 'payment-success',
      PaymentCancel: 'payment-cancel',
      GoogleAuthSuccess: 'auth/google/success',
    },
  },
};

function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider>
          <GlobalProvider>
            <CurrencyProvider>
              <NavigationContainer linking={linking}>
                <AppNavigator />
              </NavigationContainer>
              <Toast />
              <OfflineBanner />
            </CurrencyProvider>
          </GlobalProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

export default Sentry.wrap(App);
