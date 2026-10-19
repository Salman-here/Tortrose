import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import SafepayCheckoutProvider from '../../src/components/SafepayCheckoutProvider';
import { presentSafepaySheet } from '../../src/utils/safepaySheet';
import * as WebBrowser from 'expo-web-browser';
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
let mockCurrentUser = { _id: 'buyer' };
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: mockCurrentUser }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: { colors: {
  background: '#fff', text: '#111', textSecondary: '#555', primary: '#6366f1',
} } }) }));
const payment = { paymentId: 'a'.repeat(24), environment: 'sandbox', checkoutUrl: 'https://sandbox.api.getsafepay.com/embedded/?tbt=private-test-token' };
beforeEach(() => { jest.clearAllMocks(); WebBrowser.openAuthSessionAsync.mockReset(); mockCurrentUser = { _id: 'buyer' }; });
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

test('standard checkout automatically opens the normal browser; closing and reopening keeps the same payment', async () => {
  let closeBrowser;
  WebBrowser.openAuthSessionAsync.mockImplementationOnce(() => new Promise(resolve => { closeBrowser = resolve; }));
  const screen = render(<SafepayCheckoutProvider />);
  let done;
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  expect(screen.queryByLabelText('Open this payment in browser')).toBeNull();
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(browserPayment().checkoutUrl,
    'rozare://safepay-return', { preferEphemeralSession: false, showTitle: true });
  await act(async () => { closeBrowser({ type: 'cancel' }); await done; });
  await expect(done).resolves.toEqual({ type: 'dismiss' });
  WebBrowser.openAuthSessionAsync.mockImplementationOnce(() => new Promise(resolve => { closeBrowser = resolve; }));
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(2);
  await act(async () => { closeBrowser({ type: 'cancel' }); await done; });
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});

test('repeated opens cannot launch duplicate browsers or overlap a different payment', async () => {
  let closeBrowser;
  WebBrowser.openAuthSessionAsync.mockImplementationOnce(() => new Promise(resolve => { closeBrowser = resolve; }));
  render(<SafepayCheckoutProvider />); let first, second;
  await act(async () => { first = presentSafepaySheet(browserPayment()); second = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  expect(first).toBe(second); expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  await expect(presentSafepaySheet({ ...browserPayment(), paymentId: 'b'.repeat(24) })).rejects.toThrow('Finish');
  await act(async () => { closeBrowser({ type: 'cancel' }); await first; });
});

test('browser unavailability offers a controlled same-payment retry, never a silent private WebView fallback', async () => {
  WebBrowser.openAuthSessionAsync.mockRejectedValueOnce(new Error('Browser unavailable'));
  const screen = render(<SafepayCheckoutProvider />);
  let done, closeBrowser;
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  expect(screen.getByText('Could not open secure checkout')).toBeTruthy();
  expect(screen.getByText(/Your browser could not open/)).toBeTruthy();
  WebBrowser.openAuthSessionAsync.mockImplementationOnce(() => new Promise(resolve => { closeBrowser = resolve; }));
  await act(async () => {
    const retry = screen.getByLabelText('Try opening browser again');
    fireEvent.press(retry); fireEvent.press(retry); await Promise.resolve();
  });
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(2);
  expect(WebBrowser.openAuthSessionAsync.mock.calls[1][0]).toBe(browserPayment().checkoutUrl);
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  await act(async () => { closeBrowser({ type: 'cancel' }); await done; });
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});

test('a failed browser can also be closed for authenticated status verification', async () => {
  WebBrowser.openAuthSessionAsync.mockRejectedValueOnce(new Error('Browser unavailable'));
  const screen = render(<SafepayCheckoutProvider />); let done;
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  fireEvent.press(screen.getByText('Check payment status'));
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});

test('an invalid hosted callback opens neither an embedded form nor a browser', async () => {
  const screen = render(<SafepayCheckoutProvider />), invalid = browserPayment();
  const url = new URL(invalid.checkoutUrl); url.searchParams.set('redirect_url', 'https://evil.example/collect');
  let done;
  await act(async () => { done = presentSafepaySheet({ ...invalid, checkoutUrl: url.toString() }); await Promise.resolve(); });
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  expect(screen.queryByLabelText('Open this payment in browser')).toBeNull();
  expect(screen.queryByLabelText('Try opening browser again')).toBeNull();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  expect(screen.getByText('Reference: browser_invalid')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Close payment screen'));
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});

test('saved-card bank verification keeps its grant and never enables the ordinary-wallet handoff', async () => {
  const screen = render(<SafepayCheckoutProvider />);
  const saved = { ...payment, checkoutPresentation: 'saved-card', checkoutSessionGrant: 'fixture.signed.grant',
    checkoutUrl: `https://rozare.up.railway.app/api/safepay/saved-checkout/${payment.paymentId}#ticket=fixture.signed.ticket` };
  let done; act(() => { done = presentSafepaySheet(saved); });
  expect(screen.getByTestId('safepay-webview').props.source).toEqual({ uri: saved.checkoutUrl,
    headers: { 'X-Rozare-Checkout-Grant': saved.checkoutSessionGrant } });
  expect(screen.getByTestId('safepay-webview').props.paymentRequestEnabled).toBeFalsy();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Open this payment in browser')).toBeNull();
  fireEvent.press(screen.getByLabelText('Close payment screen'));
  await expect(done).resolves.toEqual({ type: 'dismiss' });
});

test('a late browser failure after logout cannot restore the old owner payment form', async () => {
  let failBrowser;
  WebBrowser.openAuthSessionAsync.mockImplementationOnce(() => new Promise((_, reject) => { failBrowser = reject; }));
  const screen = render(<SafepayCheckoutProvider />); let done;
  await act(async () => { done = presentSafepaySheet(browserPayment()); await Promise.resolve(); });
  mockCurrentUser = null;
  screen.rerender(<SafepayCheckoutProvider />);
  await expect(done).resolves.toEqual({ type: 'dismiss' });
  await act(async () => { failBrowser(new Error('Browser unavailable')); await Promise.resolve(); });
  expect(screen.queryByTestId('safepay-webview')).toBeNull();
  expect(screen.queryByText(/Your browser could not open/)).toBeNull();
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
