import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import axios from 'axios';
import Feedback from '../utils/feedback';
import api, { API_BASE_URL } from '../config/api';
import { trackAuthEvent, trackError, setUserContext } from '../utils/breadcrumbs';
import { setBuyerLocation } from '../utils/buyerLocation';
import {
  clearAllNotifications,
  preparePushTokenLogout,
  setActiveNotificationIdentity,
} from '../services/notifications';
import { registerUnauthorizedSessionHandler } from '../services/authSessionEvents';

const AuthContext = createContext();

// Seed the buyer location from the signed-in user's saved address so their
// catalog matches their shipping country even when their device IP differs.
// No-op when the user has no country on file (IP auto-detection then wins).
const seedBuyerLocationFromUser = (user) => {
  if (!user) return;
  const defaultAddress = Array.isArray(user.savedAddresses)
    ? user.savedAddresses.find((a) => a?.isDefault) || user.savedAddresses[0]
    : null;
  const country = defaultAddress?.country || user.savedShippingInfo?.country || user.sellerInfo?.country;
  if (!country) return;
  setBuyerLocation({
    country,
    countryCode: defaultAddress?.countryCode || user.savedShippingInfo?.countryCode || user.sellerInfo?.countryCode,
    region: defaultAddress?.state || user.savedShippingInfo?.state,
    city: defaultAddress?.city || user.savedShippingInfo?.city || user.sellerInfo?.city,
  }).catch(() => {});
};

// Secure storage helpers — SecureStore on native, AsyncStorage fallback on web
const isWeb = Platform.OS === 'web';
const secureSet = async (key, value) => {
  if (isWeb) return AsyncStorage.setItem(key, value);
  await SecureStore.setItemAsync(key, value);
};
const secureGet = async (key) => {
  if (isWeb) return AsyncStorage.getItem(key);
  return await SecureStore.getItemAsync(key);
};
const secureDel = async (key) => {
  if (isWeb) return AsyncStorage.removeItem(key);
  await SecureStore.deleteItemAsync(key);
};

export const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null);
  const [token, setToken] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const logoutInFlightRef = useRef(null);
  const logoutHandlerRef = useRef(null);

  // Load user and token from secure storage on mount
  useEffect(() => {
    loadUserFromStorage();
  }, []);

  const loadUserFromStorage = async () => {
    try {
      const [userStr, savedToken] = await Promise.all([
        secureGet('currentUser'),
        secureGet('jwtToken'),
      ]);
      if (userStr) {
        const user = JSON.parse(userStr);
        setCurrentUser(user);
        seedBuyerLocationFromUser(user);
      }
      if (savedToken) {
        setToken(savedToken);
      }
    } catch (error) {
      console.error('Error loading user:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchAndUpdateCurrentUser = async () => {
    try {
      const savedToken = await secureGet('jwtToken');
      if (!savedToken) return;

      const res = await api.get('/api/user/single');
      const user = res.data?.user;
      setCurrentUser(user);
      seedBuyerLocationFromUser(user);
      await secureSet('currentUser', JSON.stringify(user));
    } catch (error) {
      if (error.response?.status !== 403) {
        console.error('Error fetching user:', error);
      }
    }
  };

  // Atomically replace a server-issued session token (for example after a
  // verified seller email change) so subsequent API calls and app restarts use
  // the same authenticated identity.
  const replaceAuthToken = async (nextToken) => {
    if (typeof nextToken !== 'string' || !nextToken.trim()) {
      throw new Error('A valid replacement session token is required.');
    }
    await secureSet('jwtToken', nextToken);
    setToken(nextToken);
  };

  // Step 1 of registration: send OTP to email
  const signup = async (data) => {
    try {
      const res = await axios.post(`${API_BASE_URL}/api/auth/send-otp`, data);
      Feedback.show({
        type: 'success',
        text1: 'OTP Sent!',
        text2: res.data.msg || 'Check your email for the verification code'
      });
      return { success: true };
    } catch (error) {
      console.error(error);
      Feedback.show({
        type: 'error',
        text1: 'Error',
        text2: error.response?.data?.msg || 'Signup failed'
      });
      return { success: false, error: error.response?.data?.msg };
    }
  };

  // Step 2 of registration: verify OTP and create account
  const verifyOTP = async (data) => {
    try {
      const res = await axios.post(`${API_BASE_URL}/api/auth/verify-otp`, data);
      await secureSet('jwtToken', res.data.token);
      await secureSet('currentUser', JSON.stringify(res.data.user));
      setCurrentUser(res.data.user);
      setToken(res.data.token);
      seedBuyerLocationFromUser(res.data.user);
      Feedback.show({
        type: 'success',
        text1: 'Account Created!',
        text2: res.data.msg || 'Welcome to Rozare!'
      });
      return { success: true };
    } catch (error) {
      console.error(error);
      Feedback.show({
        type: 'error',
        text1: 'Verification Failed',
        text2: error.response?.data?.msg || 'Invalid or expired OTP'
      });
      return { success: false, error: error.response?.data?.msg };
    }
  };

  const login = async (data) => {
    trackAuthEvent('login_attempt', { email: data?.email });
    try {
      const res = await axios.post(`${API_BASE_URL}/api/auth/login`, data);

      await secureSet('jwtToken', res.data.token);
      await secureSet('currentUser', JSON.stringify(res.data.user));

      setCurrentUser(res.data.user);
      setToken(res.data.token);
      setUserContext(res.data.user);
      seedBuyerLocationFromUser(res.data.user);
      trackAuthEvent('login_success', { userId: res.data.user?._id });

      Feedback.show({
        type: 'success',
        text1: 'Welcome back!',
        text2: res.data.msg
      });

      return { success: true };
    } catch (error) {
      console.error(error);
      trackError('auth', error, { step: 'login' });
      Feedback.show({
        type: 'error',
        text1: 'Login Failed',
        text2: error.response?.data?.msg || 'Invalid credentials'
      });
      return { success: false, error: error.response?.data?.msg };
    }
  };

  // Google Sign-In via backend OAuth (opens in-app browser, intercepts deep link)
  const googleSignIn = async () => {
    try {
      const redirectUrl = 'rozare://auth/google/success';
      const authUrl = `${API_BASE_URL}/api/auth/google/mobile`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);

      if (result.type === 'success' && result.url) {
        // Extract token from the redirect URL
        const match = result.url.match(/[?&]token=([^&]*)/);
        if (!match) {
          Feedback.show({ type: 'error', text1: 'Sign-In Failed', text2: 'No token received from Google.' });
          return { success: false };
        }
        const jwtToken = decodeURIComponent(match[1]);

        // Save token then fetch full user profile
        await secureSet('jwtToken', jwtToken);
        setToken(jwtToken);

        const res = await api.get('/api/user/single');
        const user = res.data?.user;
        await secureSet('currentUser', JSON.stringify(user));
        setCurrentUser(user);
        seedBuyerLocationFromUser(user);

        Feedback.show({
          type: 'success',
          text1: 'Welcome!',
          text2: `Signed in as ${user?.username || user?.email}`,
        });
        return { success: true };
      } else if (result.type === 'cancel') {
        return { success: false, cancelled: true };
      }
      return { success: false };
    } catch (error) {
      console.error('Google sign-in error:', error);
      Feedback.show({ type: 'error', text1: 'Sign-In Failed', text2: 'Could not sign in with Google. Try again.' });
      return { success: false, error: error.message };
    }
  };

  const logout = (options = {}) => {
    if (logoutInFlightRef.current) return logoutInFlightRef.current;
    const sessionExpired = Boolean(options?.sessionExpired);
    const cleanup = (async () => {
    trackAuthEvent('logout');
    // Invalidate new registrations immediately. Cleanup is durably queued
    // with a per-installation credential, so offline network calls never
    // delay local logout and retry safely on the next app start.
    await setActiveNotificationIdentity(null).catch(() => {});
    await preparePushTokenLogout({ authToken: token }).catch(() => {});
    await clearAllNotifications().catch(() => {});

    const storageCleanup = await Promise.allSettled([
      secureDel('jwtToken'),
      secureDel('currentUser'),
    ]);
    if (storageCleanup.some(result => result.status === 'rejected')) {
      console.error('Logout secure-storage cleanup was incomplete.');
    }

    // Local auth state always clears, even if secure storage or the network is
    // temporarily unavailable. This prevents a failed cleanup from trapping a
    // person inside the previous account.
    setCurrentUser(null);
    setToken(null);
    setUserContext(null);

    Feedback.show({
      type: sessionExpired ? 'warning' : 'info',
      text1: sessionExpired ? 'Session expired' : 'Logged out',
      text2: sessionExpired
        ? 'For your security, please sign in again.'
        : 'You have been logged out successfully'
    });
    })();
    logoutInFlightRef.current = cleanup;
    cleanup.finally(() => {
      if (logoutInFlightRef.current === cleanup) logoutInFlightRef.current = null;
    });
    return cleanup;
  };

  logoutHandlerRef.current = logout;
  useEffect(() => registerUnauthorizedSessionHandler(
    () => logoutHandlerRef.current?.({ sessionExpired: true })
  ), []);

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        setCurrentUser,
        token,
        replaceAuthToken,
        fetchAndUpdateCurrentUser,
        signup,
        verifyOTP,
        login,
        googleSignIn,
        logout,
        isLoading
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
