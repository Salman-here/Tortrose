import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../src/config/api';
import { CurrencyProvider, currencyForDeviceFallback, useCurrency } from '../../src/contexts/CurrencyContext';
import { resolveBuyerCountrySuggestion } from '../../src/utils/buyerLocation';
let mockUser = null, mockToken = null, current, root;
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: mockUser, token: mockToken, isLoading: false }) }));
jest.mock('../../src/utils/buyerLocation', () => ({ resolveBuyerCountrySuggestion: jest.fn() }));
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn() } }));
const Probe = () => { current = useCurrency(); return null; };
const mount = async () => act(async () => { root = TestRenderer.create(<CurrencyProvider><Probe/></CurrencyProvider>); for (let i = 0; i < 12; i++) await Promise.resolve(); });
beforeEach(async () => {
  jest.clearAllMocks(); await AsyncStorage.clear(); mockUser = null; mockToken = null;
  resolveBuyerCountrySuggestion.mockResolvedValue({ countryCode: 'PK' });
  api.get.mockImplementation(async path => ({ data: path === '/api/currency/rates'
    ? { success: true, rates: { USD: 1, PKR: 280, EUR: 0.9, GBP: 0.8 }, fallback: false }
    : { user: { currency: mockUser?.currency || 'USD' } } }));
  api.patch.mockResolvedValue({ data: { success: true } });
});
afterEach(() => { if (root) act(() => root.unmount()); root = null; });
test('a fresh guest in Pakistan gets PKR without changing an account', async () => {
  await mount(); expect(current.currency).toBe('PKR'); expect(resolveBuyerCountrySuggestion).toHaveBeenCalledTimes(1); expect(api.patch).not.toHaveBeenCalled();
  expect(JSON.parse(await AsyncStorage.getItem('guestCurrencyChoice:v1'))).toEqual({ source: 'automatic', currency: 'PKR' });
});
test('an unmarked old USD default is detected again, while an explicit USD choice is preserved', async () => {
  await AsyncStorage.setItem('userCurrency', 'USD'); await mount(); expect(current.currency).toBe('PKR');
  await act(async () => { expect(await current.setCurrency('USD')).toBe(true); });
  expect(JSON.parse(await AsyncStorage.getItem('guestCurrencyChoice:v1'))).toEqual({ source: 'manual', currency: 'USD' });
  act(() => root.unmount()); root = null; resolveBuyerCountrySuggestion.mockClear();
  await mount(); expect(current.currency).toBe('USD'); expect(resolveBuyerCountrySuggestion).not.toHaveBeenCalled();
});
test('a signed-in USD account remains authoritative, independent of the device and IP', async () => {
  mockUser = { _id: 'signed-in', currency: 'USD' }; mockToken = 'owned-token';
  await mount(); expect(current.currency).toBe('USD'); expect(resolveBuyerCountrySuggestion).not.toHaveBeenCalled(); expect(api.patch).not.toHaveBeenCalled();
});
test('device language en-US does not turn a Pakistan time zone into USD', () => {
  expect(currencyForDeviceFallback('Asia/Karachi', 'US')).toBe('PKR');
  expect(currencyForDeviceFallback('Europe/London', 'US')).toBe('GBP');
  expect(currencyForDeviceFallback('Unknown/Zone', 'DE')).toBe('EUR');
});
test('a late location result cannot overwrite an explicit selection', async () => {
  let finish; resolveBuyerCountrySuggestion.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await mount(); await act(async () => { await current.setCurrency('EUR'); });
  await act(async () => { finish({ countryCode: 'PK' }); for (let i = 0; i < 5; i++) await Promise.resolve(); });
  expect(current.currency).toBe('EUR'); expect(JSON.parse(await AsyncStorage.getItem('guestCurrencyChoice:v1')).source).toBe('manual');
});
