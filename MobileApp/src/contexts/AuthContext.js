import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import axios from 'axios';
import Toast from 'react-native-toast-message';
import api, { API_BASE_URL } from '../config/api';

const AuthContext = createContext();

// Secure storage helpers
const secureSet = async (key, value) => {
  await SecureStore.setItemAsync(key, value);
};
const secureGet = async (key) => {
  return await SecureStore.getItemAsync(key);
};
const secureDel = async (key) => {
  await SecureStore.deleteItemAsync(key);
};

export const AuthProvider = ({ children }) => {
  const [currentUser, setCurrentUser] = useState(null);
  const [token, setToken] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

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
      await secureSet('currentUser', JSON.stringify(user));
    } catch (error) {
      if (error.response?.status !== 403) {
        console.error('Error fetching user:', error);
      }
    }
  };

  // Step 1 of registration: send OTP to email
  const signup = async (data) => {
    try {
      const res = await axios.post(`${API_BASE_URL}/api/auth/send-otp`, data);
      Toast.show({
        type: 'success',
        text1: 'OTP Sent!',
        text2: res.data.msg || 'Check your email for the verification code'
      });
      return { success: true };
    } catch (error) {
      console.error(error);
      Toast.show({
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
      Toast.show({
        type: 'success',
        text1: 'Account Created!',
        text2: res.data.msg || 'Welcome to Tortrose!'
      });
      return { success: true };
    } catch (error) {
      console.error(error);
      Toast.show({
        type: 'error',
        text1: 'Verification Failed',
        text2: error.response?.data?.msg || 'Invalid or expired OTP'
      });
      return { success: false, error: error.response?.data?.msg };
    }
  };

  const login = async (data) => {
    try {
      const res = await axios.post(`${API_BASE_URL}/api/auth/login`, data);

      await secureSet('jwtToken', res.data.token);
      await secureSet('currentUser', JSON.stringify(res.data.user));

      setCurrentUser(res.data.user);
      setToken(res.data.token);

      Toast.show({
        type: 'success',
        text1: 'Welcome back!',
        text2: res.data.msg
      });

      return { success: true };
    } catch (error) {
      console.error(error);
      Toast.show({
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
      const redirectUrl = 'tortrose://auth/google/success';
      const authUrl = `${API_BASE_URL}/api/auth/google/mobile`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);

      if (result.type === 'success' && result.url) {
        // Extract token from the redirect URL
        const match = result.url.match(/[?&]token=([^&]*)/);
        if (!match) {
          Toast.show({ type: 'error', text1: 'Sign-In Failed', text2: 'No token received from Google.' });
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

        Toast.show({
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
      Toast.show({ type: 'error', text1: 'Sign-In Failed', text2: 'Could not sign in with Google. Try again.' });
      return { success: false, error: error.message };
    }
  };

  const logout = async () => {
    try {
      await secureDel('jwtToken');
      await secureDel('currentUser');
      setCurrentUser(null);
      setToken(null);

      Toast.show({
        type: 'info',
        text1: 'Logged out',
        text2: 'You have been logged out successfully'
      });
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        setCurrentUser,
        token,
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
