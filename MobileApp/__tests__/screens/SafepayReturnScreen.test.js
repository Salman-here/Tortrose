import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import SafepayReturnScreen from '../../src/screens/SafepayReturnScreen';
import api from '../../src/config/api';
import { openSafepayCheckout, verifySafepayPayment } from '../../src/utils/safepayCheckout';
const mockFetchCart = jest.fn();
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../../src/config/api', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../src/utils/safepayCheckout', () => ({ openSafepayCheckout: jest.fn(), verifySafepayPayment: jest.fn() }));
jest.mock('../../src/utils/checkout', () => ({ clearCheckoutAttempt: jest.fn() }));
jest.mock('../../src/contexts/GlobalContext', () => ({ useGlobal: () => ({ fetchCart: mockFetchCart }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: { colors: { text: '#111', textSecondary: '#555' } } }) }));
jest.mock('../../src/components/common/GlassBackground', () => {
  const React = require('react'); const { View } = require('react-native');
  return ({ children }) => React.createElement(View, null, children);
});
jest.mock('../../src/components/common/GlassPanel', () => {
  const React = require('react'); const { View } = require('react-native');
  return ({ children }) => React.createElement(View, null, children);
});
const paymentId = 'a'.repeat(24);
const pending = { paymentId, status: 'pending', purpose: 'order' };
beforeEach(() => {
  jest.clearAllMocks();
  verifySafepayPayment.mockResolvedValue(pending);
  openSafepayCheckout.mockResolvedValue(pending);
  api.post.mockResolvedValue({ data: pending });
});
test('a dismissed pending payment can reopen only its original owned attempt', async () => {
  const screen = render(<SafepayReturnScreen route={{ params: { paymentId } }} navigation={{ navigate: jest.fn() }} />);
  await waitFor(() => expect(screen.getByText('Resume secure checkout')).toBeTruthy());
  fireEvent.press(screen.getByText('Resume secure checkout'));
  await waitFor(() => expect(openSafepayCheckout).toHaveBeenCalledWith({ apiClient: api, response: { data: pending } }));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith(`/api/safepay/payments/${paymentId}/reopen`, { clientSurface: 'mobile' });
  expect(verifySafepayPayment).toHaveBeenCalledWith({ apiClient: api, paymentId, attempts: 1 });
});
test.each(['manual_review', 'refund_pending', 'refunded', 'reversed', 'cancelled', 'paid'])('%s never offers another payment', async status => {
  verifySafepayPayment.mockResolvedValue({ ...pending, status });
  const screen = render(<SafepayReturnScreen route={{ params: { paymentId } }} navigation={{ navigate: jest.fn() }} />);
  await waitFor(() => expect(verifySafepayPayment).toHaveBeenCalled());
  expect(screen.queryByText('Resume secure checkout')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test('a mismatched reopen reply cannot open another payment', async () => {
  api.post.mockResolvedValue({ data: { ...pending, paymentId: 'b'.repeat(24) } });
  const screen = render(<SafepayReturnScreen route={{ params: { paymentId } }} navigation={{ navigate: jest.fn() }} />);
  await waitFor(() => expect(screen.getByText('Resume secure checkout')).toBeTruthy());
  fireEvent.press(screen.getByText('Resume secure checkout'));
  await waitFor(() => expect(screen.getByText('This payment could not be reopened. Check its status before paying again.')).toBeTruthy());
  expect(openSafepayCheckout).not.toHaveBeenCalled();
});
