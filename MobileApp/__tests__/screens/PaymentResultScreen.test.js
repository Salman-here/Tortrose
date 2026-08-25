import React from 'react';
import { Animated } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import PaymentSuccessScreen from '../../src/screens/PaymentSuccessScreen';
import PaymentCancelScreen from '../../src/screens/PaymentCancelScreen';
import api from '../../src/config/api';
import { verifyOrderPayment } from '../../src/utils/checkout';

const mockFetchCart = jest.fn().mockResolvedValue(undefined);
const mockRecordSuccessfulOrder = jest.fn();
const mockClearCheckoutAttempt = jest.fn().mockResolvedValue(undefined);

jest.mock('@expo/vector-icons', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }) => ReactLib.createElement(Text, null, name) };
});

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), delete: jest.fn() },
}));

jest.mock('../../src/utils/checkout', () => ({
  clearCheckoutAttempt: (...args) => mockClearCheckoutAttempt(...args),
  verifyOrderPayment: jest.fn(),
}));

jest.mock('../../src/contexts/GlobalContext', () => ({
  useGlobal: () => ({ fetchCart: mockFetchCart }),
}));

jest.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'buyer-1' } }),
}));

jest.mock('../../src/hooks/useReviewPrompt', () => ({
  recordSuccessfulOrder: (...args) => mockRecordSuccessfulOrder(...args),
}));

jest.mock('../../src/utils/breadcrumbs', () => ({
  trackPaymentEvent: jest.fn(),
}));

jest.mock('../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        primary: '#6366f1', success: '#10b981', warning: '#f59e0b', error: '#ef4444',
        text: '#111827', textSecondary: '#64748b',
      },
      glass: { border: 'rgba(255,255,255,0.4)' },
    },
  }),
}));

jest.mock('../../src/components/common/GlassBackground', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return ({ children }) => ReactLib.createElement(View, null, children);
});

jest.mock('../../src/components/common/GlassPanel', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return ({ children, style }) => ReactLib.createElement(View, { style }, children);
});

describe('payment result screens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Animated, 'parallel').mockReturnValue({ start: jest.fn() });
    jest.spyOn(Animated, 'spring').mockReturnValue({ start: jest.fn() });
    api.delete.mockResolvedValue({ data: { success: true } });
    mockFetchCart.mockResolvedValue(undefined);
    mockClearCheckoutAttempt.mockResolvedValue(undefined);
  });

  it('refreshes the backend-cleaned cart and celebrates only after server verification says paid', async () => {
    verifyOrderPayment.mockResolvedValue({ status: 'paid', payload: { isPaid: true } });
    const navigation = { reset: jest.fn(), replace: jest.fn() };
    const screen = render(
      <PaymentSuccessScreen
        navigation={navigation}
        route={{ params: {
          orderId: 'ORD-1',
          session_id: 'cs_1',
          checkoutAttemptStorageKey: 'checkout:buyer-1',
          checkoutAttemptFingerprint: 'buyer-1:intent-1',
          checkoutAttemptKey: 'mobile-checkout:v2:digest:0',
        } }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Payment confirmed')).toBeTruthy());
    expect(api.delete).not.toHaveBeenCalled();
    expect(mockFetchCart).toHaveBeenCalledTimes(1);
    expect(mockRecordSuccessfulOrder).toHaveBeenCalledTimes(1);
    expect(mockClearCheckoutAttempt).toHaveBeenCalledWith(
      expect.anything(),
      'checkout:buyer-1',
      'buyer-1:intent-1',
      'mobile-checkout:v2:digest:0',
    );
  });

  it('does not clear any checkout generation when a paid return has no exact correlation', async () => {
    verifyOrderPayment.mockResolvedValue({ status: 'paid' });
    render(
      <PaymentSuccessScreen
        navigation={{ reset: jest.fn(), replace: jest.fn() }}
        route={{ params: { orderId: 'ORD-NO-CORRELATION', session_id: 'cs_uncorrelated' } }}
      />,
    );

    await waitFor(() => expect(mockFetchCart).toHaveBeenCalledTimes(1));
    expect(mockClearCheckoutAttempt).not.toHaveBeenCalled();
  });

  it('keeps the cart when payment remains pending', async () => {
    verifyOrderPayment.mockResolvedValue({ status: 'pending' });
    const screen = render(
      <PaymentSuccessScreen
        navigation={{ reset: jest.fn(), replace: jest.fn() }}
        route={{ params: { orderId: 'ORD-2', session_id: 'cs_2' } }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Confirming your payment')).toBeTruthy());
    expect(api.delete).not.toHaveBeenCalled();
    expect(mockRecordSuccessfulOrder).not.toHaveBeenCalled();
    expect(mockClearCheckoutAttempt).not.toHaveBeenCalled();
  });

  it('retains the durable checkout attempt for transient server verification responses', async () => {
    verifyOrderPayment.mockResolvedValue({
      status: 'pending',
      error: { response: { status: 429, data: { code: 'PAYMENT_RATE_LIMITED' } } },
    });
    const screen = render(
      <PaymentSuccessScreen
        navigation={{ reset: jest.fn(), replace: jest.fn() }}
        route={{ params: {
          orderId: 'ORD-RATE-LIMITED',
          checkoutAttemptStorageKey: 'rozare_checkout_attempt_v1:buyer-1',
        } }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Confirming your payment')).toBeTruthy());
    expect(mockClearCheckoutAttempt).not.toHaveBeenCalled();
    expect(mockFetchCart).not.toHaveBeenCalled();
  });

  it('redirects a cancel return to verified success when the webhook already paid it', async () => {
    verifyOrderPayment.mockResolvedValue({ status: 'paid' });
    const navigation = { replace: jest.fn(), reset: jest.fn() };
    render(
      <PaymentCancelScreen
        navigation={navigation}
        route={{ params: {
          orderId: 'ORD-3',
          session_id: 'cs_3',
          checkoutAttemptStorageKey: 'checkout:buyer-1',
          checkoutAttemptFingerprint: 'buyer-1:intent-3',
          checkoutAttemptKey: 'mobile-checkout:v2:digest:3',
        } }}
      />,
    );

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('PaymentSuccess', {
      orderId: 'ORD-3', session_id: 'cs_3',
      checkoutAttemptStorageKey: 'checkout:buyer-1',
      checkoutAttemptFingerprint: 'buyer-1:intent-3',
      checkoutAttemptKey: 'mobile-checkout:v2:digest:3',
    }));
  });

  it('forwards exact correlation when Check Status moves from cancel to success verification', async () => {
    verifyOrderPayment.mockResolvedValue({ status: 'pending' });
    const navigation = { replace: jest.fn(), reset: jest.fn() };
    const screen = render(
      <PaymentCancelScreen
        navigation={navigation}
        route={{ params: {
          orderId: 'ORD-4',
          payment_intent: 'pi_4',
          checkoutAttemptStorageKey: 'checkout:buyer-1',
          checkoutAttemptFingerprint: 'buyer-1:intent-4',
          checkoutAttemptKey: 'mobile-checkout:v2:digest:4',
        } }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Check Status')).toBeTruthy());
    fireEvent.press(screen.getByText('Check Status'));
    expect(navigation.replace).toHaveBeenCalledWith('PaymentSuccess', {
      orderId: 'ORD-4',
      payment_intent: 'pi_4',
      checkoutAttemptStorageKey: 'checkout:buyer-1',
      checkoutAttemptFingerprint: 'buyer-1:intent-4',
      checkoutAttemptKey: 'mobile-checkout:v2:digest:4',
    });
  });

  it('clears only the exact correlated generation after backend-verified cancellation', async () => {
    verifyOrderPayment.mockResolvedValue({ status: 'cancelled' });
    render(
      <PaymentCancelScreen
        navigation={{ replace: jest.fn(), reset: jest.fn() }}
        route={{ params: {
          orderId: 'ORD-5',
          checkoutAttemptStorageKey: 'checkout:buyer-1',
          checkoutAttemptFingerprint: 'buyer-1:intent-5',
          checkoutAttemptKey: 'mobile-checkout:v2:digest:5',
        } }}
      />,
    );
    await waitFor(() => expect(mockClearCheckoutAttempt).toHaveBeenCalledWith(
      expect.anything(),
      'checkout:buyer-1',
      'buyer-1:intent-5',
      'mobile-checkout:v2:digest:5',
    ));
  });
});
