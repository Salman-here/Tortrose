import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import SellerProfileScreen from '../../../src/screens/seller/SellerProfileScreen';
import api from '../../../src/config/api';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/common/KeyboardAwareFormScrollView', () => ({ children }) => children);
jest.mock('../../../src/components/common/PhoneNumberInput', () => () => null);
jest.mock('../../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ fetchAndUpdateCurrentUser: jest.fn(), replaceAuthToken: jest.fn() }),
}));
jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: require('../../../src/styles/theme').colors,
      glass: { bgSubtle: '#fff', borderSubtle: '#cbd5e1' },
    },
  }),
}));
jest.mock('../../../src/components/seller/SellerUI', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    SellerInlineError: () => null,
    SellerScreenHeader: () => null,
    SellerScreenSkeleton: () => null,
    SellerSectionHeader: ({ title }) => ReactModule.createElement(Text, null, title),
  };
});
jest.mock('../../../src/utils/feedback', () => ({ __esModule: true, default: { show: jest.fn() } }));
jest.mock('../../../src/config/api', () => ({
  __esModule: true, default: { get: jest.fn(), post: jest.fn() },
}));

describe('seller profile email stays read-only on mobile', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
  });

  test.each([null, '2026-10-12T12:00:00Z'])('hides changes regardless of the former cooldown (%s)', async (lastEmailChange) => {
    api.get.mockResolvedValue({ data: { user: {
      username: 'Seller QA', email: 'seller@example.com', role: 'seller',
      sellerInfo: { whatsappNumber: '+923001234567', lastEmailChange },
    } } });
    const screen = render(<SellerProfileScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText('seller@example.com');
    expect(screen.getByText('Email changes are currently unavailable.')).toBeTruthy();
    expect(screen.queryByLabelText('Change seller email')).toBeNull();
    expect(screen.queryByLabelText('New seller email address')).toBeNull();
    expect(screen.queryByLabelText('Email verification code')).toBeNull();
    // WhatsApp is a separate, still-available account action.
    fireEvent.press(screen.getByLabelText('Change seller WhatsApp number'));
    expect(screen.getByText('Send Code')).toBeTruthy();
    expect(screen.queryByLabelText('Change seller email')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
