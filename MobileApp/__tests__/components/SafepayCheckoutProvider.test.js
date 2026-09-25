import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import SafepayCheckoutProvider from '../../src/components/SafepayCheckoutProvider';
import { presentSafepaySheet } from '../../src/utils/safepaySheet';
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { _id: 'buyer' } }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: { colors: {
  background: '#fff', text: '#111', textSecondary: '#555', primary: '#6366f1',
} } }) }));
const payment = { paymentId: 'a'.repeat(24), environment: 'sandbox', checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?tbt=private-test-token' };
test('opens in-app and closing resolves dismissal without claiming a payment outcome', async () => {
  const screen = render(<SafepayCheckoutProvider />);
  let done;
  act(() => { done = presentSafepaySheet(payment); });
  expect(screen.getByTestId('safepay-webview').props.source.uri).toBe(payment.checkoutUrl);
  expect(screen.getByText('Safepay sandbox · Test payment')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close payment screen'));
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});
test('repeated opens share one visible attempt and different payments cannot overlap', async () => {
  render(<SafepayCheckoutProvider />);
  let first, second;
  act(() => { first = presentSafepaySheet(payment); second = presentSafepaySheet(payment); });
  expect(first).toBe(second);
  await expect(presentSafepaySheet({ ...payment, paymentId: 'b'.repeat(24) })).rejects.toThrow('Finish');
});
test('a provider return only resolves navigation for subsequent backend verification', async () => {
  const screen = render(<SafepayCheckoutProvider />);
  let done;
  act(() => { done = presentSafepaySheet(payment); });
  act(() => { expect(screen.getByTestId('safepay-webview').props.onShouldStartLoadWithRequest({
    url: 'https://sandbox.api.getsafepay.com/embedded/external/complete?paid=true',
  })).toBe(false); });
  await expect(done).resolves.toEqual({ type: 'return' });
});
test('unsafe navigation displays recovery, never opens another app', () => {
  const screen = render(<SafepayCheckoutProvider />);
  act(() => { presentSafepaySheet(payment); });
  const webview = screen.getByTestId('safepay-webview');
  expect(webview.props.originWhitelist).toEqual(['*']);
  act(() => { expect(webview.props.onShouldStartLoadWithRequest({ url: 'intent://unknown-app' })).toBe(false); });
  expect(screen.getByText('Payment screen interrupted')).toBeTruthy();
});
