import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PaymentMethodsScreen from '../../src/screens/PaymentMethodsScreen';
import api from '../../src/config/api';
import { openSafepayCheckout, verifySafepayPayment } from '../../src/utils/safepayCheckout';

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
jest.mock('../../src/utils/safepayCheckout', () => ({ openSafepayCheckout: jest.fn(), verifySafepayPayment: jest.fn() }));
const navigation = { addListener: jest.fn(() => jest.fn()), canGoBack: () => true, goBack: jest.fn(), navigate: jest.fn() };

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockUser.role = 'user';
  mockUser._id = 'buyer-test';
  api.post.mockReset();
  api.get.mockResolvedValue({ data: { provider: 'safepay', cards: [], defaultPaymentMethodId: null, billingProfileReady: true } });
  openSafepayCheckout.mockReset().mockResolvedValue({ status: 'authorized' });
  verifySafepayPayment.mockReset();
});
afterEach(() => jest.useRealTimers());

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

const newProfileResponse = { data: { cards: [], billingProfileReady: false,
  billingContact: { fullName: 'SingleName', phone: '+923001234567', country: 'Pakistan', countryCode: 'PK' } } };
const consent = screen => fireEvent.press(screen.getByLabelText('Save this card for future payments'));
const add = screen => fireEvent.press(screen.getByLabelText('Add a payment card'));

test('new accounts see prefilled billing fields before attempting customer creation', async () => {
  api.get.mockResolvedValue(newProfileResponse);
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByLabelText('Billing full name').props.value).toBe('SingleName'));
  expect(screen.UNSAFE_getByType('PhoneNumberInput').props.value).toBe('+923001234567');
  expect(screen.UNSAFE_getByType('LocationAutocomplete').props.code).toBe('PK');
  expect(screen.getByText('Use the name shown on your card. Safepay requires both first and last names.')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

test('rejects a one-word name locally, then sends corrected contact without changing the account name', async () => {
  api.get.mockResolvedValue(newProfileResponse);
  api.post.mockResolvedValue({ data: { paymentId: 'owned-setup' } });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByLabelText('Billing full name')).toBeTruthy());
  consent(screen);
  add(screen);
  expect(screen.getByText('Check your billing details')).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Billing full name'), 'Test Seller');
  add(screen);
  await waitFor(() => expect(openSafepayCheckout).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/api/safepay/cards/setup', expect.objectContaining({
    clientSurface: 'mobile', consentToSave: true, requestKey: expect.any(String),
    billingContact: { ...newProfileResponse.data.billingContact, fullName: 'Test Seller' },
  }));
  expect(mockUser.username).toBe('Test Buyer');
});

test('refresh does not overwrite corrected billing input', async () => {
  api.get.mockResolvedValue(newProfileResponse);
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByLabelText('Billing full name')).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText('Billing full name'), 'Corrected Seller');
  await act(async () => { await navigation.addListener.mock.calls[0][1](); });
  expect(screen.getByLabelText('Billing full name').props.value).toBe('Corrected Seller');
});

test('backend billing rejection exposes correction fields and can be retried without a forced wait', async () => {
  api.post.mockRejectedValueOnce({ response: { data: { code: 'SAFEPAY_BILLING_PROFILE_REQUIRED', msg: 'Enter your billing first and last name.' } } });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
  consent(screen);
  add(screen);
  await waitFor(() => expect(screen.getByLabelText('Billing full name')).toBeTruthy());
  expect(screen.getByText('Enter your billing first and last name.')).toBeTruthy();
  expect(screen.getByLabelText('Add a payment card').props.accessibilityState.disabled).toBe(false);
});

test.each(['CHECKOUT_IN_PROGRESS', 'SAFEPAY_CUSTOMER_UNCERTAIN'])('%s waits only the server-requested time and retains the setup attempt', async code => {
  jest.useFakeTimers();
  api.post.mockRejectedValueOnce({ response: { data: { code, msg: 'Wait before retrying.', retryAfterSeconds: 2 } } })
    .mockResolvedValue({ data: { paymentId: 'owned-setup' } });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
  consent(screen);
  add(screen);
  await waitFor(() => expect(screen.getByText('Retry in 2s')).toBeTruthy());
  expect(screen.getByLabelText('Add a payment card').props.accessibilityState.disabled).toBe(true);
  add(screen);
  expect(api.post).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.getByLabelText('Add a payment card').props.accessibilityState.disabled).toBe(false);
  add(screen);
  await waitFor(() => expect(openSafepayCheckout).toHaveBeenCalledTimes(1));
  expect(api.post.mock.calls[0][1].requestKey).toBe(api.post.mock.calls[1][1].requestKey);
});

test('existing provider profiles do not force users to re-enter contact details', async () => {
  api.post.mockResolvedValue({ data: { paymentId: 'owned-setup' } });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
  expect(screen.queryByLabelText('Billing full name')).toBeNull();
  consent(screen);
  add(screen);
  await waitFor(() => expect(openSafepayCheckout).toHaveBeenCalledTimes(1));
  expect(api.post.mock.calls[0][1].billingContact).toBeUndefined();
});

const savedCard = { id: 'pm_new-card', brand: 'visa', last4: '1111', expMonth: 12, expYear: 2030, usable: true };

const pendingPayment = { paymentId: 'aaaaaaaaaaaaaaaaaaaaaaaa', environment: 'sandbox', purpose: 'card_setup',
  currency: 'PKR', amountMinor: 0, status: 'pending' };
const openPendingSetup = async () => {
  api.post.mockResolvedValue({ data: pendingPayment });
  openSafepayCheckout.mockResolvedValue({ ...pendingPayment });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
  consent(screen); add(screen);
  await waitFor(() => expect(screen.getByText('Card setup is being verified')).toBeTruthy());
  return screen;
};
const refreshFocusedScreen = async () => act(async () => { await navigation.addListener.mock.calls.at(-1)[1](); });

test('refresh settles the exact pending setup and clears its stale notice without another form or setup', async () => {
  const screen = await openPendingSetup();
  api.get.mockResolvedValue({ data: { cards: [savedCard], defaultPaymentMethodId: savedCard.id, billingProfileReady: true } });
  verifySafepayPayment.mockResolvedValue({ ...pendingPayment, status: 'authorized', savedPaymentMethodId: savedCard.id });
  await refreshFocusedScreen();
  expect(verifySafepayPayment).toHaveBeenCalledWith(expect.objectContaining({
    paymentId: pendingPayment.paymentId, expectedPayment: expect.objectContaining({ purpose: 'card_setup', amountMinor: 0, environment: 'sandbox' }), attempts: 1,
  }));
  expect(screen.getByText('Card saved securely')).toBeTruthy();
  expect(screen.queryByText('Card setup is being verified')).toBeNull();
  expect(screen.getByLabelText('Save this card for future payments').props.accessibilityState.checked).toBe(false);
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(openSafepayCheckout).toHaveBeenCalledTimes(1);
  await refreshFocusedScreen();
  expect(verifySafepayPayment).toHaveBeenCalledTimes(1);
});

test('an unrelated saved card never settles an unconfirmed setup or retires its retry key', async () => {
  const screen = await openPendingSetup();
  api.get.mockResolvedValue({ data: { cards: [savedCard], defaultPaymentMethodId: savedCard.id, billingProfileReady: true } });
  verifySafepayPayment.mockResolvedValue(pendingPayment);
  await refreshFocusedScreen();
  expect(screen.getByText('Card setup is being verified')).toBeTruthy();
  expect(screen.queryByText('Card saved securely')).toBeNull();
  add(screen);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post.mock.calls[1][1].requestKey).toBe(api.post.mock.calls[0][1].requestKey);
});

test('a definitively failed setup is closed on refresh, not reported as a saved card', async () => {
  const screen = await openPendingSetup();
  verifySafepayPayment.mockResolvedValue({ ...pendingPayment, status: 'failed' });
  await refreshFocusedScreen();
  expect(screen.getByText('Card setup closed')).toBeTruthy();
  expect(screen.queryByText('Card saved securely')).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('changing account discards the old in-memory setup reference before a refresh', async () => {
  const screen = await openPendingSetup();
  mockUser._id = 'different-account';
  screen.rerender(<PaymentMethodsScreen navigation={navigation} />);
  await refreshFocusedScreen();
  expect(verifySafepayPayment).not.toHaveBeenCalled();
  expect(screen.queryByText('Card setup is being verified')).toBeNull();
});
test('new saved card shows the server-selected default without another client-side selection', async () => {
  api.get.mockResolvedValueOnce({ data: { cards: [], defaultPaymentMethodId: null, billingProfileReady: true } })
    .mockResolvedValue({ data: { cards: [savedCard], defaultPaymentMethodId: savedCard.id, billingProfileReady: true } });
  api.post.mockResolvedValue({ data: { paymentId: 'owned-setup' } });
  openSafepayCheckout.mockResolvedValue({ status: 'authorized', savedPaymentMethodId: savedCard.id });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('No card saved yet')).toBeTruthy());
  expect(screen.getByText('Save this card for future payments')).toBeTruthy();
  consent(screen); add(screen);
  await waitFor(() => expect(screen.getByText('Your card is saved and set as your default for checkout.')).toBeTruthy());
  expect(screen.getByText('DEFAULT')).toBeTruthy();
  expect(api.patch).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Save this card for future payments').props.accessibilityState.checked).toBe(false);
});
test('an unrelated existing card never proves the just-added card was saved', async () => {
  api.get.mockResolvedValue({ data: { cards: [{ ...savedCard, id: 'pm_other-card' }], defaultPaymentMethodId: 'pm_other-card', billingProfileReady: true } });
  api.post.mockResolvedValue({ data: { paymentId: 'owned-setup' } });
  openSafepayCheckout.mockResolvedValue({ status: 'authorized', savedPaymentMethodId: savedCard.id });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('1111')).toBeTruthy());
  consent(screen); add(screen);
  await waitFor(() => expect(screen.getByText('Your saved card is not available yet. Refresh your cards to check before starting another setup.')).toBeTruthy());
  expect(screen.queryByText('Card saved securely')).toBeNull();
  expect(api.patch).not.toHaveBeenCalled();
});
test('a newer explicit default selection is shown as unchanged after card setup', async () => {
  api.get.mockResolvedValue({ data: { cards: [savedCard], defaultPaymentMethodId: 'pm_other-card', billingProfileReady: true } });
  api.post.mockResolvedValue({ data: { paymentId: 'owned-setup' } });
  openSafepayCheckout.mockResolvedValue({ status: 'authorized', savedPaymentMethodId: savedCard.id });
  const screen = render(<PaymentMethodsScreen navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('1111')).toBeTruthy());
  consent(screen); add(screen);
  await waitFor(() => expect(screen.getByText('Your card is saved. Your current default card is unchanged.')).toBeTruthy());
  expect(api.patch).not.toHaveBeenCalled();
});
