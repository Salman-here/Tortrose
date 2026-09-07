import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import BecomeSellerScreen from '../../src/screens/BecomeSellerScreen';
import api from '../../src/config/api';
import axios from 'axios';
import { useAuth } from '../../src/contexts/AuthContext';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('../../src/config/api', () => ({ __esModule: true, API_BASE_URL: 'https://local.test', default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({
  currency: 'USD', currencies: { USD: { name: 'US Dollar' }, PKR: { name: 'Pakistani Rupee' }, GBP: { name: 'British Pound' }, EUR: { name: 'Euro' } },
}) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({
  palette: require('../../src/styles/palettes').lightPalette, isDark: false,
}) }));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../src/components/common/KeyboardAwareFormScrollView', () => ({ children }) => children);
jest.mock('../../src/components/common/GoogleSignInButton', () => () => null);
jest.mock('../../src/components/common/AuthTopHeader', () => {
  const ReactModule = require('react');
  return ({ onBack }) => ReactModule.createElement(require('react-native').TouchableOpacity, { testID: 'onboarding-back', onPress: onBack });
});
jest.mock('../../src/components/common/PhoneNumberInput', () => {
  const ReactModule = require('react');
  return ({ value, onChangeText }) => ReactModule.createElement(require('react-native').TextInput, { testID: 'onboarding-phone', value, onChangeText });
});
jest.mock('../../src/components/common/LocationAutocomplete', () => {
  const ReactModule = require('react');
  const { View, Text } = require('react-native');
  return ({ type, value, onSelect, onClear }) => ReactModule.createElement(View,
    { testID: `onboarding-${type}`, onSelect, onClear },
    ReactModule.createElement(Text, null, value));
});

const navigation = { replace: jest.fn(), navigate: jest.fn(), goBack: jest.fn() };
const user = { _id: 'seller-onboarding-test-buyer', role: 'user', currency: 'USD' };
const country = (screen, code, name) => fireEvent(screen.getByTestId('onboarding-country'), 'select', { isoCode: code, name });

async function openStore(screen) {
  fireEvent.changeText(screen.getByTestId('onboarding-phone'), '+923001234567');
  fireEvent.changeText(screen.getByPlaceholderText('Street and building'), '100 Test Road');
  fireEvent(screen.getByTestId('onboarding-city'), 'select', { name: 'Test City' });
  fireEvent.press(screen.getByText('Continue to store setup'));
  await screen.findByText('PRODUCT LISTING CURRENCY *');
}

describe('seller currency recommendation in the actual onboarding screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuth.mockReturnValue({ currentUser: user });
    axios.get.mockResolvedValue({ data: { detected: true, country: 'PK', countryName: 'Pakistan' } });
    api.get.mockResolvedValue({ data: { available: true } });
    api.post.mockResolvedValue({ data: { success: true } });
  });

  test('a new USD account in Pakistan sees PKR selected and recommended; changing to USD explains the impact', async () => {
    const screen = render(<BecomeSellerScreen navigation={navigation} />);
    fireEvent.press(screen.getByText('Start seller setup'));
    await screen.findByText('Pakistan');
    await openStore(screen);
    expect(screen.getByTestId('become-seller-product-currency-PKR').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('PKR is recommended for Pakistan.')).toBeTruthy();
    fireEvent.press(screen.getByTestId('become-seller-product-currency-USD'));
    expect(screen.getByText('Using USD for your store')).toBeTruthy();
    expect(screen.getByText(/100 means 100 USD/)).toBeTruthy();
    expect(screen.getByTestId('become-seller-product-currency-USD').props.accessibilityState.selected).toBe(true);
  });

  test('country changes update the default until an explicit selection, then preserve that selection', async () => {
    const screen = render(<BecomeSellerScreen navigation={navigation} />);
    fireEvent.press(screen.getByText('Start seller setup'));
    await screen.findByText('Pakistan');
    country(screen, 'GB', 'United Kingdom');
    await openStore(screen);
    expect(screen.getByTestId('become-seller-product-currency-GBP').props.accessibilityState.selected).toBe(true);
    fireEvent.press(screen.getByTestId('become-seller-product-currency-EUR'));
    fireEvent.press(screen.getByTestId('onboarding-back'));
    country(screen, 'PK', 'Pakistan');
    await openStore(screen);
    expect(screen.getByText('PKR is recommended for Pakistan.')).toBeTruthy();
    expect(screen.getByTestId('become-seller-product-currency-EUR').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Using EUR for your store')).toBeTruthy();
  });

  test('late location detection cannot replace a manually selected country or its currency', async () => {
    let finishDetection;
    axios.get.mockReturnValue(new Promise(resolve => { finishDetection = resolve; }));
    const screen = render(<BecomeSellerScreen navigation={navigation} />);
    fireEvent.press(screen.getByText('Start seller setup'));
    country(screen, 'GB', 'United Kingdom');
    await act(async () => finishDetection({ data: { detected: true, country: 'PK', countryName: 'Pakistan' } }));
    expect(screen.queryByText('Pakistan')).toBeNull();
    await openStore(screen);
    expect(screen.getByTestId('become-seller-product-currency-GBP').props.accessibilityState.selected).toBe(true);
  });

  test('failed detection leaves country blank and an unsupported local currency has an explained USD fallback', async () => {
    axios.get.mockResolvedValue({ data: { detected: false, country: 'US', currency: 'USD' } });
    const screen = render(<BecomeSellerScreen navigation={navigation} />);
    fireEvent.press(screen.getByText('Start seller setup'));
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(screen.queryByText('United States')).toBeNull();
    country(screen, 'JP', 'Japan');
    await openStore(screen);
    expect(screen.getByTestId('become-seller-product-currency-USD').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText(/local currency is not currently supported/)).toBeTruthy();
  });

  test.each(['PKR', 'USD'])('seller activation submits the visible %s selection after verification', async selectedCurrency => {
    const screen = render(<BecomeSellerScreen navigation={navigation} />);
    fireEvent.press(screen.getByText('Start seller setup'));
    await screen.findByText('Pakistan');
    await openStore(screen);
    if (selectedCurrency !== 'PKR') fireEvent.press(screen.getByTestId(`become-seller-product-currency-${selectedCurrency}`));
    fireEvent.changeText(screen.getByPlaceholderText('My Awesome Store'), 'Currency Verification Store');
    fireEvent.changeText(screen.getByPlaceholderText('Describe what you sell and what makes your store special'), 'Everyday home and travel accessories.');
    await screen.findByText('This store name is available');
    fireEvent.press(screen.getByText('Continue to verification'));
    fireEvent.press(screen.getByText('Send verification code'));
    await screen.findByPlaceholderText('000000');
    fireEvent.changeText(screen.getByPlaceholderText('000000'), '123456');
    fireEvent.press(screen.getByText('Verify code'));
    await screen.findByText('WhatsApp verified');
    fireEvent.press(screen.getByText('Activate seller account'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/user/become-seller', expect.objectContaining({
      countryCode: 'PK', productCurrency: selectedCurrency,
    })));
  });
});
