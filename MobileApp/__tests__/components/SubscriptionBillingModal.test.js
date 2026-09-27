import React from 'react';
import { Dimensions, Modal, StyleSheet } from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import SubscriptionBillingModal, { billingDialogHeight } from '../../src/components/seller/SubscriptionBillingModal';
import { spacing } from '../../src/styles/theme';

jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
jest.mock('@react-native-picker/picker', () => {
  const React = require('react');
  const Picker = props => React.createElement('Picker', props, props.children);
  Picker.Item = 'PickerItem';
  return { Picker };
});

const originalWindow = Dimensions.get('window');
const originalScreen = Dimensions.get('screen');
const quote = { planName: 'Rozare Starter', dueNowMinor: 0, monthlyAmountMinor: 999,
  freePeriodDays: 30, terms: 'After the free period, renew at $9.99 USD/month until cancelled.' };
const props = () => ({ quote, cards: [{ id: 'pm_owned', brand: 'visa', last4: '1111' }], cardId: 'pm_owned',
  consent: false, busy: false, onCardChange: jest.fn(), onConsentChange: jest.fn(), onConfirm: jest.fn(), onClose: jest.fn(),
  formatUsd: minor => `$${(minor / 100).toFixed(2)}` });
afterEach(() => { act(() => Dimensions.set({ window: originalWindow, screen: originalScreen })); });

test.each([320, 390, 568, 844, 1200])('dialog has a definite bounded height at window height %s', height => {
  const insets = { top: 24, bottom: 24 };
  const result = billingDialogHeight(height, insets);
  expect(result).toBeGreaterThan(100);
  expect(result).toBeLessThanOrEqual(680);
  expect(result).toBeLessThanOrEqual(height - 48 - spacing.lg * 2);
});

test('renders quote, owned card and terms inside a bounded scroll area with actions outside it', () => {
  const p = props();
  const screen = render(<SubscriptionBillingModal {...p} />);
  const panel = screen.getByTestId('subscription-billing-dialog');
  expect(StyleSheet.flatten(panel.props.style).height).toBeGreaterThan(100);
  expect(panel.props.androidBlur).toBe(false);
  expect(screen.getByText('Review your subscription')).toBeTruthy();
  expect(screen.getByText('Rozare Starter')).toBeTruthy();
  expect(screen.getByText('Due now: $0.00 USD')).toBeTruthy();
  expect(screen.getByText('Recurring price: $9.99 USD/month')).toBeTruthy();
  expect(screen.getByText('First 30 days free.')).toBeTruthy();
  expect(screen.getByText(quote.terms)).toBeTruthy();
  expect(screen.UNSAFE_getByType('PickerItem').props.label).toBe('VISA •••• 1111');
  expect(within(screen.getByTestId('subscription-billing-scroll')).queryByLabelText('Confirm subscription')).toBeNull();
  expect(within(screen.getByTestId('subscription-billing-actions')).getByLabelText('Confirm subscription')).toBeTruthy();
  expect(p.onConfirm).not.toHaveBeenCalled();
});

test('responds to landscape height instead of retaining an oversized or collapsed panel', () => {
  const screen = render(<SubscriptionBillingModal {...props()} />);
  act(() => Dimensions.set({ window: { width: 844, height: 390, scale: 1, fontScale: 1 },
    screen: { width: 844, height: 390, scale: 1, fontScale: 1 } }));
  expect(StyleSheet.flatten(screen.getByTestId('subscription-billing-dialog').props.style).height)
    .toBe(billingDialogHeight(390, { top: 24, bottom: 24 }));
  expect(screen.getByLabelText('Close subscription review')).toBeTruthy();
});

test.each([{ consent: false, cardId: 'pm_owned' }, { consent: true, cardId: '' }])('confirmation remains gated by consent and card: %j', state => {
  const p = { ...props(), ...state };
  const screen = render(<SubscriptionBillingModal {...p} />);
  const confirm = screen.getByLabelText('Confirm subscription');
  expect(confirm.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(confirm);
  expect(p.onConfirm).not.toHaveBeenCalled();
});

test('card choice, consent and explicit confirmation retain their separate handlers', () => {
  const p = { ...props(), consent: true };
  const screen = render(<SubscriptionBillingModal {...p} />);
  fireEvent(screen.getByLabelText('Subscription payment card'), 'valueChange', 'pm_other');
  expect(p.onCardChange).toHaveBeenCalledWith('pm_other');
  fireEvent(screen.getByLabelText('Agree to the displayed subscription price and automatic renewal terms'), 'valueChange', false);
  expect(p.onConsentChange).toHaveBeenCalledWith(false);
  fireEvent.press(screen.getByLabelText('Confirm subscription'));
  expect(p.onConfirm).toHaveBeenCalledTimes(1);
});

test('both visible close controls and Android Back can dismiss without subscribing', () => {
  const p = props();
  const screen = render(<SubscriptionBillingModal {...p} />);
  fireEvent.press(screen.getByLabelText('Close subscription review'));
  fireEvent.press(screen.getByLabelText('Not now'));
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(p.onClose).toHaveBeenCalledTimes(3);
  expect(p.onConfirm).not.toHaveBeenCalled();
});

test('pending billing disables card changes, confirmation and all dismissal paths', () => {
  const p = { ...props(), consent: true, busy: true };
  const screen = render(<SubscriptionBillingModal {...p} />);
  expect(screen.getByLabelText('Subscription payment card').props.enabled).toBe(false);
  expect(screen.getByText('Verifying…')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Confirm subscription'));
  fireEvent.press(screen.getByLabelText('Close subscription review'));
  fireEvent.press(screen.getByLabelText('Not now'));
  act(() => screen.UNSAFE_getByType(Modal).props.onRequestClose());
  expect(p.onConfirm).not.toHaveBeenCalled();
  expect(p.onClose).not.toHaveBeenCalled();
});

test('the shared billing-card change dialog preserves its distinct action and credit display', () => {
  const p = { ...props(), quote: { ...quote, kind: 'card_change', creditMinor: 250 }, consent: true };
  const screen = render(<SubscriptionBillingModal {...p} />);
  expect(screen.getByText('Credit toward future billing: $2.50 USD')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Confirm card change'));
  expect(p.onConfirm).toHaveBeenCalledTimes(1);
});
