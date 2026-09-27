import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import PaymentMethodsScreen from '../../src/screens/PaymentMethodsScreen';
import api from '../../src/config/api';

const mockUser = { _id: 'buyer-test', username: 'Test Buyer', role: 'user' };
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: mockUser }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, palette: {
  colors: { primary: '#6366f1', text: '#111827', textSecondary: '#64748b', textLight: '#94a3b8', success: '#10b981', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6' },
  glass: { bg: '#fff', bgStrong: '#fff', bgSubtle: '#f8fafc', border: '#ddd', borderSubtle: '#ddd', borderStrong: '#ccc' },
  gradients: { cta: ['#14b8a6', '#6366f1'] },
} }) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'Gradient' }));
jest.mock('expo-linking', () => ({ createURL: path => `rozare://${path}` }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { appOwnership: 'standalone' } }));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../src/components/common/PremiumBackHeader', () => 'Header');
jest.mock('../../src/components/common/LocationAutocomplete', () => 'LocationAutocomplete');
jest.mock('../../src/components/common/PhoneNumberInput', () => 'PhoneNumberInput');
jest.mock('../../src/utils/breadcrumbs', () => ({ trackError: jest.fn(), trackPaymentEvent: jest.fn() }));
const navigation = { addListener: jest.fn(() => jest.fn()), canGoBack: () => true, goBack: jest.fn(), navigate: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { provider: 'safepay', cards: [], defaultPaymentMethodId: null } });
});

test.each(['user', 'seller'])('opens Payment Methods for %s without removed Stripe config', async role => {
  mockUser.role = role;
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  expect(screen.getByText('Your cards, protected by Safepay')).toBeTruthy();
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
  expect(api.get).toHaveBeenCalledWith('/api/safepay/cards');
  expect(screen.getByTestId('saved-cards-status').props.accessibilityLabel).toBe('Saved cards ready');
});

test('renders owned Safepay card data and changes default using the Safepay endpoint', async () => {
  api.get.mockResolvedValue({ data: { cards: [{ id: 'pm_owned-card', brand: 'visa', last4: '1111', expMonth: 12, expYear: 2030, usable: true }], defaultPaymentMethodId: null } });
  api.patch.mockResolvedValue({ data: { success: true } });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('1111')).toBeTruthy());
  expect(screen.getByText('12/30')).toBeTruthy();
  fireEvent.press(screen.getByText('Make default'));
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/safepay/cards/pm_owned-card/default', { clientSurface: 'mobile' }));
  expect(screen.getByText('Default card updated')).toBeTruthy();
});

test('shows a recoverable loading error instead of crashing or claiming there are no cards', async () => {
  api.get.mockRejectedValueOnce({ response: { data: { msg: 'Payment service unavailable for this test.' } } });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Cards unavailable')).toBeTruthy());
  expect(screen.getByText('Payment service unavailable for this test.')).toBeTruthy();
  expect(screen.getByTestId('saved-cards-status').props.accessibilityLabel).toBe('Saved cards unavailable');
  expect(screen.queryByText('No card saved yet')).toBeNull();
  fireEvent.press(screen.getByText('Try again'));
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
});
