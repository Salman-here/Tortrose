import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

jest.mock('../../src/components/common/KeyboardAwareFormScrollView', () => {
  const ReactModule = require('react');
  const { ScrollView: NativeScrollView } = require('react-native');
  return {
    __esModule: true,
    default: ReactModule.forwardRef((props, ref) => ReactModule.createElement(NativeScrollView, { ...props, ref })),
  };
});

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserPresentationStyle: { FULL_SCREEN: 'fullScreen' },
}));

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

jest.mock('../../src/utils/feedback', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock('../../src/components/common/GlassPanel', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');
  return ({ children, ...props }) => ReactModule.createElement(NativeView, props, children);
});

jest.mock('../../src/components/common/Skeleton', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');
  return () => ReactModule.createElement(NativeView, { testID: 'skeleton-block' });
});

jest.mock('../../src/components/seller/SellerUI', () => {
  const ReactModule = require('react');
  const {
    Text: NativeText,
    TouchableOpacity: NativeTouchableOpacity,
    View: NativeView,
  } = require('react-native');
  return {
    SellerEmptyState: ({ title, message }) => ReactModule.createElement(
      NativeView,
      null,
      ReactModule.createElement(NativeText, null, title),
      ReactModule.createElement(NativeText, null, message),
    ),
    SellerInlineError: ({ title, message, onRetry }) => ReactModule.createElement(
      NativeView,
      null,
      ReactModule.createElement(NativeText, null, title),
      ReactModule.createElement(NativeText, null, message),
      onRetry
        ? ReactModule.createElement(
          NativeTouchableOpacity,
          { accessibilityRole: 'button', onPress: onRetry },
          ReactModule.createElement(NativeText, null, 'Retry'),
        )
        : null,
    ),
  };
});

jest.mock('../../src/contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatAmount: value => `$${Number(value).toFixed(2)}` }),
}));

jest.mock('../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        primary: '#6366f1', primaryLighter: '#c7d2fe', primarySubtle: '#eef2ff',
        text: '#111827', textSecondary: '#6b7280', success: '#10b981',
        successDark: '#059669', successLighter: '#d1fae5', successSubtle: '#ecfdf5',
        warning: '#f59e0b', warningDark: '#d97706', warningLighter: '#fef3c7', warningSubtle: '#fffbeb',
        error: '#ef4444', errorLighter: '#fee2e2', errorSubtle: '#fef2f2',
      },
      glass: { bgSubtle: 'transparent', borderSubtle: 'transparent', borderStrong: 'transparent' },
    },
  }),
}));

const api = require('../../src/config/api').default;
const SellerReturnsPanel = require('../../src/components/SellerReturnsPanel').default;
const { summarizeSellerReturns } = require('../../src/components/SellerReturnsPanel');

describe('SellerReturnsPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows skeletons while the first real request is pending', () => {
    api.get.mockReturnValue(new Promise(() => {}));

    const screen = render(<SellerReturnsPanel header={<Text>Returns tab</Text>} navigation={{ setParams: jest.fn() }} route={{ params: {} }} />);
    act(() => jest.runOnlyPendingTimers());

    expect(screen.getByLabelText('Loading return filters')).toBeTruthy();
    expect(screen.getByLabelText('Loading return requests')).toBeTruthy();
    expect(screen.queryByText('No return requests yet')).toBeNull();
  });

  it('shows an honest retryable error instead of an empty state when the first request fails', async () => {
    api.get.mockRejectedValue({ response: { data: { msg: 'Network is unavailable.' } } });

    const screen = render(<SellerReturnsPanel navigation={{ setParams: jest.fn() }} route={{ params: {} }} />);
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });

    expect(screen.getByText('Returns unavailable')).toBeTruthy();
    expect(screen.getByText('Network is unavailable.')).toBeTruthy();
    expect(screen.queryByText('No return requests yet')).toBeNull();

    api.get.mockResolvedValue({ data: { returns: [] } });
    fireEvent.press(screen.getByText('Retry'));
    await act(async () => Promise.resolve());

    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('counts only active workflow states as needing seller action', () => {
    const summary = summarizeSellerReturns([
      { status: 'requested' },
      { status: 'under_review' },
      { status: 'accepted_pending_payment' },
      { status: 'returned' },
      { status: 'replacement_approved' },
      { status: 'rejected' },
      { status: 'cancelled_by_buyer' },
    ]);

    expect(summary).toEqual({ total: 7, actionable: 3, paymentDue: 1 });
  });
});
