import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import SafepayCheckoutProvider from '../../src/components/SafepayCheckoutProvider';
import { presentSafepaySheet } from '../../src/utils/safepaySheet';
import * as WebBrowser from 'expo-web-browser';
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { _id: 'buyer' } }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: { colors: {
  background: '#fff', text: '#111', textSecondary: '#555', primary: '#6366f1',
} } }) }));
const payment = { paymentId: 'a'.repeat(24), environment: 'sandbox', checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?tbt=private-test-token' };
const browserPayment = () => {
  const url = new URL('https://sandbox.api.getsafepay.com/embedded/');
  url.searchParams.set('environment', 'sandbox'); url.searchParams.set('source', 'hosted');
  for (const [key, outcome] of [['redirect_url', 'return'], ['cancel_url', 'cancel']]) {
    const target = new URL('https://rozare.up.railway.app/api/safepay/return');
    target.search = new URLSearchParams({ browser: '1', attempt: payment.paymentId, purpose: 'order', surface: 'mobile', outcome }).toString();
    url.searchParams.set(key, target.toString());
  }
  return { ...payment, purpose: 'order', checkoutPresentation: 'browser', checkoutUrl: url.toString() };
};

test('standard checkout opens a normal system browser and dismissal releases the original request', async () => {
  let closeBrowser;
  WebBrowser.openAuthSessionAsync.mockImplementationOnce(() => new Promise(resolve => { closeBrowser = resolve; }));
  const screen = render(<SafepayCheckoutProvider />);
  let done;
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(browserPayment().checkoutUrl,
    'rozare://safepay-return', { preferEphemeralSession: false, showTitle: true });
  await act(async () => { closeBrowser({ type: 'cancel' }); await done; });
  await expect(done).resolves.toEqual({ type: 'dismiss' });
  act(() => { done = presentSafepaySheet(payment); });
  expect(screen.getByTestId('safepay-webview')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close payment screen'));
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});

test('an unavailable browser falls back to the same provider attempt, not a new order', async () => {
  WebBrowser.openAuthSessionAsync.mockRejectedValueOnce(new Error('Browser unavailable'));
  const screen = render(<SafepayCheckoutProvider />);
  let done;
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  expect(screen.getByTestId('safepay-webview').props.source.uri).toBe(browserPayment().checkoutUrl);
  expect(screen.getByText(/Your browser could not open/)).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close payment screen'));
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});
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
test('unsafe navigation is blocked without destroying the valid card form or opening another app', () => {
  const screen = render(<SafepayCheckoutProvider />);
  act(() => { presentSafepaySheet(payment); });
  const webview = screen.getByTestId('safepay-webview');
  expect(webview.props.originWhitelist).toEqual(['*']);
  act(() => { expect(webview.props.onShouldStartLoadWithRequest({ url: 'intent://unknown-app' })).toBe(false); });
  expect(screen.queryByText('Payment screen interrupted')).toBeNull();
  expect(screen.getByTestId('safepay-webview')).toBeTruthy();
  expect(screen.getByText(/An unsupported link was blocked/)).toBeTruthy();
});

test('a native loading failure offers verification without leaking a provider token', () => {
  const screen = render(<SafepayCheckoutProvider />);
  act(() => { presentSafepaySheet(payment); });
  act(() => screen.getByTestId('safepay-webview').props.onError({ nativeEvent: {
    code: -2, url: payment.checkoutUrl, description: 'Private details must not be rendered',
  } }));
  expect(screen.getByText('Payment screen interrupted')).toBeTruthy();
  expect(screen.getByText('Reference: load_error:-2')).toBeTruthy();
  expect(screen.queryByText(/private-test-token|Private details/)).toBeNull();
  expect(screen.getByText('Check payment status')).toBeTruthy();
});
