import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ShoppingLocationPrompt from '../../src/components/common/ShoppingLocationPrompt';
import { BuyerLocationProvider } from '../../src/contexts/BuyerLocationContext';
import { clearBuyerLocation, setBuyerLocation } from '../../src/utils/buyerLocation';

jest.setTimeout(30000);
jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: null }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/components/common/LocationAutocomplete', () => {
  const R = require('react'), { View, Text } = require('react-native');
  return props => R.createElement(View, { testID: 'location-' + props.type, onSelect: props.onSelect, onClear: props.onClear }, R.createElement(Text, null, props.value));
});
const mount = (enabled = true) => render(<BuyerLocationProvider><ShoppingLocationPrompt enabled={enabled} /></BuyerLocationProvider>);
beforeEach(async () => {
  await clearBuyerLocation(); await AsyncStorage.clear(); jest.clearAllMocks();
  axios.get.mockResolvedValue({ data: { detected: true, country: 'PK', countryName: 'Pakistan' } });
});

test('first visit recommends the detected country and saves it only after Start shopping', async () => {
  const screen = mount();
  await screen.findByText('Pakistan');
  expect(screen.getByLabelText('Shop from: Country').props.accessibilityState.checked).toBe(true);
  expect(screen.getByText(/change your selection any time in Filters/)).toBeTruthy();
  expect(await AsyncStorage.getItem('rozare:shopping-location:v2')).toBeNull();
  fireEvent.press(screen.getByLabelText('Start shopping'));
  await waitFor(() => expect(screen.queryByText('Where would you like to shop?')).toBeNull());
  expect(JSON.parse(await AsyncStorage.getItem('rozare:shopping-location:v2'))).toMatchObject({ mode: 'country', countryCode: 'PK', confirmed: true });
});

test('Global is selectable and a late detector cannot change that draft or saved preference', async () => {
  let finish;
  axios.get.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const screen = mount();
  fireEvent.press(screen.getByLabelText('Shop from: Global'));
  await waitFor(() => expect(finish).toEqual(expect.any(Function)));
  await act(async () => finish({ data: { detected: true, country: 'PK', countryName: 'Pakistan' } }));
  expect(screen.getByLabelText('Shop from: Global').props.accessibilityState.checked).toBe(true);
  expect(screen.queryByTestId('location-country')).toBeNull();
  fireEvent.press(screen.getByLabelText('Start shopping'));
  await waitFor(() => expect(screen.queryByText('Where would you like to shop?')).toBeNull());
  expect(JSON.parse(await AsyncStorage.getItem('rozare:shopping-location:v2'))).toMatchObject({ mode: 'global', country: '', confirmed: true });
});

test('a failed detector does not preselect the US and another country can be chosen', async () => {
  axios.get.mockResolvedValue({ data: { detected: false, country: 'US' } });
  const screen = mount();
  await screen.findByText('We could not reliably detect your country. Choose a country or Global.');
  expect(screen.queryByText('United States')).toBeNull();
  expect(screen.getByLabelText('Start shopping').props.accessibilityState?.disabled ?? screen.getByLabelText('Start shopping').props.disabled).toBe(true);
  fireEvent(screen.getByTestId('location-country'), 'select', { name: 'Canada', isoCode: 'CA' });
  fireEvent.press(screen.getByLabelText('Start shopping'));
  await waitFor(() => expect(screen.queryByText('Where would you like to shop?')).toBeNull());
  expect(JSON.parse(await AsyncStorage.getItem('rozare:shopping-location:v2'))).toMatchObject({ mode: 'country', countryCode: 'CA' });
});

test('a saved Global preference is not prompted again, and non-shopping routes are not interrupted', async () => {
  await setBuyerLocation({ mode: 'global' });
  const screen = mount();
  await act(async () => {});
  expect(screen.queryByText('Where would you like to shop?')).toBeNull();
  screen.unmount();
  await clearBuyerLocation();
  const other = mount(false);
  await act(async () => {});
  expect(other.queryByText('Where would you like to shop?')).toBeNull();
});
