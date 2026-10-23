import React from 'react';
import { TextInput } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import axios from 'axios';
import api from '../../../src/config/api';
import { AuthProvider, useAuth } from '../../../src/contexts/AuthContext';
import { CurrencyProvider, useCurrency } from '../../../src/contexts/CurrencyContext';
import SignUpScreen from '../../../src/screens/auth/SignUpScreen';
import OTPVerificationScreen from '../../../src/screens/auth/OTPVerificationScreen';
import LoginScreen from '../../../src/screens/auth/LoginScreen';

jest.setTimeout(15000);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../../../src/config/api', () => ({ __esModule: true, API_BASE_URL: 'https://qa.example.test', default: { get: jest.fn(), patch: jest.fn() } }));
jest.mock('../../../src/utils/feedback', () => ({ show: jest.fn() }));
jest.mock('../../../src/utils/breadcrumbs', () => ({ trackAuthEvent: jest.fn(), trackError: jest.fn(), setUserContext: jest.fn() }));
jest.mock('../../../src/utils/buyerLocation', () => ({
  suggestBuyerLocation: jest.fn().mockResolvedValue(null), resolveBuyerCountrySuggestion: jest.fn().mockResolvedValue({ countryCode: 'PK' }),
}));
jest.mock('../../../src/services/notifications', () => ({
  clearAllNotifications: jest.fn(), preparePushTokenLogout: jest.fn(), setActiveNotificationIdentity: jest.fn(),
}));
jest.mock('../../../src/services/authSessionEvents', () => ({ registerUnauthorizedSessionHandler: () => () => {} }));
jest.mock('../../../src/contexts/ThemeContext', () => ({ useTheme: () => ({
  palette: require('../../../src/styles/palettes').lightPalette, isDark: false,
}) }));
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/common/KeyboardAwareFormScrollView', () => ({ children }) => children);
jest.mock('../../../src/components/common/AuthTopHeader', () => () => null);
jest.mock('../../../src/components/common/RozareLogo', () => () => null);
jest.mock('../../../src/components/common/GoogleSignInButton', () => {
  const ReactModule = require('react');
  return ({ onPress }) => ReactModule.createElement(require('react-native').TouchableOpacity, { testID: 'google-signup', onPress });
});
jest.mock('../../../src/hooks/useOtpCountdown', () => () => ({ isExpired: false, canResend: true, expiryLabel: '10:00', start: jest.fn() }));

let currentCurrency, currentAuth, serverUser, frozenCurrency, currencyHistory;
const Probe = () => { currentCurrency = useCurrency(); currentAuth = useAuth(); currencyHistory.push(currentCurrency.currency); return null; };
const navigation = { navigate: jest.fn(), reset: jest.fn(), goBack: jest.fn() };
const tree = (Screen = SignUpScreen, params) => <AuthProvider><CurrencyProvider><Probe/><Screen navigation={navigation} route={{ params }}/></CurrencyProvider></AuthProvider>;
beforeEach(async () => {
  jest.clearAllMocks(); await AsyncStorage.clear(); currencyHistory = []; serverUser = null; frozenCurrency = null;
  const secure = new Map();
  SecureStore.getItemAsync.mockImplementation(async key => secure.get(key) || null);
  SecureStore.setItemAsync.mockImplementation(async (key, value) => { secure.set(key, value); });
  api.get.mockImplementation(async path => ({ data: path === '/api/currency/rates'
    ? { success: true, rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, fallback: false } : { user: serverUser } }));
  api.patch.mockResolvedValue({ data: { success: true } });
  axios.post.mockImplementation(async (url, data) => {
    if (url.endsWith('/send-otp')) { frozenCurrency = data.currency; return { data: { msg: 'Verification code sent' } }; }
    if (url.endsWith('/verify-otp')) {
      serverUser = { id: 'new-buyer', username: 'Currency QA', role: 'user', currency: frozenCurrency };
      return { data: { token: 'qa-session', user: serverUser } };
    }
    throw new Error('Unexpected auth fixture request');
  });
});

test.each([['PKR', false], ['EUR', true], ['USD', true]])('the actual signup and OTP screens retain %s through the new-account handoff', async (currency, manual) => {
  const screen = render(tree()); await waitFor(() => expect(currentCurrency.currency).toBe('PKR'));
  if (manual) await act(async () => { await currentCurrency.setCurrency(currency); });
  fireEvent.changeText(screen.getByPlaceholderText('John Doe'), 'Currency QA');
  fireEvent.changeText(screen.getByPlaceholderText('john@example.com'), 'currency@example.test');
  fireEvent.changeText(screen.getByPlaceholderText('Min. 6 characters'), 'QA-password');
  fireEvent.changeText(screen.getByPlaceholderText('Re-enter password'), 'QA-password');
  fireEvent.press(screen.getByText('Create Account'));
  await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('OTPVerification', expect.any(Object)));
  expect(axios.post).toHaveBeenCalledWith('https://qa.example.test/api/auth/send-otp', expect.objectContaining({ currency }));
  const params = navigation.navigate.mock.calls[0][1];
  screen.rerender(tree(OTPVerificationScreen, params)); currencyHistory = [];
  const inputs = screen.UNSAFE_getAllByType(TextInput);
  for (let index = 0; index < 6; index += 1) fireEvent.changeText(inputs[index], String(index + 1));
  await waitFor(() => expect(currentAuth.currentUser?.currency).toBe(currency));
  await waitFor(() => expect(currentCurrency.currency).toBe(currency));
  expect(await AsyncStorage.getItem('accountCurrency:new-buyer')).toBe(currency);
  if (currency !== 'USD') expect(currencyHistory).not.toContain('USD');
  expect(api.patch).not.toHaveBeenCalled();
  screen.unmount();
});

test('resending the OTP includes the current browsing currency rather than falling back to USD', async () => {
  const screen = render(tree(OTPVerificationScreen, { email: 'currency@example.test', name: 'Currency QA', password: 'QA-password' }));
  await waitFor(() => expect(currentCurrency.currency).toBe('PKR'));
  fireEvent.press(screen.getByText('Resend Code'));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('https://qa.example.test/api/auth/send-otp', expect.objectContaining({ currency: 'PKR' })));
  screen.unmount();
});

test.each([SignUpScreen, LoginScreen])('Google entry from the auth screen carries PKR but keeps an existing USD account authoritative', async Screen => {
  serverUser = { _id: 'existing-google', username: 'Existing QA', role: 'user', currency: 'USD' };
  WebBrowser.openAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'rozare://auth/google/success?token=qa-google-session' });
  const screen = render(tree(Screen)); await waitFor(() => expect(currentCurrency.currency).toBe('PKR'));
  fireEvent.press(screen.getByTestId('google-signup'));
  await waitFor(() => expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith('https://qa.example.test/api/auth/google/mobile?currency=PKR', 'rozare://auth/google/success'));
  await waitFor(() => expect(currentAuth.currentUser?._id).toBe('existing-google'));
  await waitFor(() => expect(currentCurrency.currency).toBe('USD'));
  expect(api.patch).not.toHaveBeenCalled(); screen.unmount();
});
