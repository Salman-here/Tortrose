import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SellerSubscriptionScreen from '../../../src/screens/seller/SellerSubscriptionScreen';
import api from '../../../src/config/api';

jest.mock('../../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));
jest.mock('../../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { _id: 'seller-fixture', role: 'seller' } }) }));
jest.mock('../../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../../src/styles/palettes').lightPalette }) }));
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('../../../src/components/seller/SellerUI', () => ({ SellerInlineError: 'InlineError', SellerScreenHeader: 'Header', SellerScreenSkeleton: 'Skeleton', SellerSectionHeader: 'SectionHeader' }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'Gradient' }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
jest.mock('@react-native-picker/picker', () => {
  const React = require('react');
  const Picker = props => React.createElement('Picker', props, props.children);
  Picker.Item = 'PickerItem';
  return { Picker };
});

const subscription = { status: 'trial', plan: 'free_trial', hasUsedFreePeriod: false, billingVersion: 0,
  pricing: { schemaVersion: 1, currency: 'USD', metaAdsAddonCents: 500,
    starter: { plan: 'starter', planName: 'Rozare Starter', listAmountCents: 1427, standardAmountCents: 999, founderAmountCents: 599, advertisedDiscountPercent: 30, freePeriodDays: 30 },
    elite: { plan: 'elite', planName: 'Rozare Elite', listAmountCents: 3093, standardAmountCents: 2165, founderAmountCents: 1299, advertisedDiscountPercent: 30, freePeriodDays: 45 } } };
const navigation = { navigate: jest.fn(), setParams: jest.fn() };
let cards;
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  cards = [{ id: 'pm_owned', brand: 'visa', last4: '1111', usable: true }];
  api.get.mockImplementation(async path => ({ data: path === '/api/subscription/status' ? { subscription }
    : path === '/api/safepay/cards' ? { cards, defaultPaymentMethodId: 'pm_owned' } : { completed: true } }));
  api.post.mockResolvedValue({ data: { quoteId: 'owned-quote', status: 'quoted', currency: 'USD', planName: 'Rozare Starter',
    monthlyAmountMinor: 999, dueNowMinor: 0, freePeriodDays: 30, consentVersion: 'rozare-safepay-recurring-v1',
    expiresAt: new Date(Date.now() + 600000).toISOString(), terms: 'USD 9.99 monthly after 30 free days. Cancel anytime.' } });
});
afterEach(() => jest.restoreAllMocks());

const openReview = async screen => {
  await waitFor(() => expect(screen.getByLabelText('Start with 30 days free')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Start with 30 days free'));
  await waitFor(() => expect(screen.getByTestId('subscription-billing-dialog')).toBeTruthy());
};

test('a seller with a saved card sees the complete review without starting billing', async () => {
  const screen = render(<SellerSubscriptionScreen navigation={navigation} route={{ params: {} }} />);
  await openReview(screen);
  expect(screen.getByText('Due now: $0.00 USD')).toBeTruthy();
  expect(screen.getByText('Recurring price: $9.99 USD/month')).toBeTruthy();
  expect(screen.getByText('First 30 days free.')).toBeTruthy();
  expect(screen.getByLabelText('Subscription payment card').props.selectedValue).toBe('pm_owned');
  expect(screen.getByLabelText('Confirm subscription').props.accessibilityState.disabled).toBe(true);
  expect(api.post.mock.calls.map(([path]) => path)).toEqual(['/api/safepay/subscription/quote']);
  fireEvent.press(screen.getByLabelText('Not now'));
  expect(screen.queryByTestId('subscription-billing-dialog')).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('returning after adding the first card fetches it and opens a nonempty review', async () => {
  cards = [];
  const screen = render(<SellerSubscriptionScreen navigation={navigation} route={{ params: {} }} />);
  await waitFor(() => expect(screen.getByLabelText('Start with 30 days free')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Start with 30 days free'));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Add a payment card', expect.any(String), expect.any(Array)));
  expect(api.post).not.toHaveBeenCalled();
  const buttons = Alert.alert.mock.calls.find(([title]) => title === 'Add a payment card')[2];
  buttons.find(button => button.text === 'Add card').onPress();
  expect(navigation.navigate).toHaveBeenCalledWith('PaymentMethods');
  cards = [{ id: 'pm_newly_saved', brand: 'visa', last4: '1111', usable: true }];
  await openReview(screen);
  expect(screen.getByLabelText('Subscription payment card').props.selectedValue).toBe('pm_newly_saved');
  expect(screen.getByText('Review your subscription')).toBeTruthy();
  expect(screen.getByLabelText('Confirm subscription').props.accessibilityState.disabled).toBe(true);
});

test('acceptance still requires the user consent action and sends the owned quote/card contract', async () => {
  const screen = render(<SellerSubscriptionScreen navigation={navigation} route={{ params: {} }} />);
  await openReview(screen);
  fireEvent.press(screen.getByLabelText('Confirm subscription'));
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByLabelText('Agree to the displayed subscription price and automatic renewal terms'), 'valueChange', true);
  fireEvent.press(screen.getByLabelText('Confirm subscription'));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/safepay/subscription/accept', {
    clientSurface: 'mobile', quoteId: 'owned-quote', cardId: 'pm_owned', consentAccepted: true,
    consentVersion: 'rozare-safepay-recurring-v1',
  }));
});
