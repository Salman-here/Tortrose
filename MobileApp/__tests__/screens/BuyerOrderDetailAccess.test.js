import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import OrderDetailScreen from '../../src/screens/OrderDetailScreen';
import api from '../../src/config/api';

jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() } }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: require('../../src/styles/palettes').lightPalette }) }));
jest.mock('../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatPrice: (amount, options) => `${options.targetCurrency} ${amount.toFixed(2)}` }) }));
jest.mock('../../src/contexts/GlobalContext', () => ({ useGlobal: () => ({ fetchCart: jest.fn() }) }));
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassPanel', () => 'GlassPanel');
jest.mock('../../src/components/common/PremiumBackHeader', () => 'Header');
jest.mock('../../src/components/common/StoreAvatar', () => 'StoreAvatar');
jest.mock('../../src/components/common/Loader', () => 'Loader');
jest.mock('../../src/components/common/EmptyState', () => ({ ErrorState: ({ message }) => {
  const React = require('react');
  return React.createElement(require('react-native').Text, null, message);
} }));
jest.mock('../../src/components/BuyerReturnsSection', () => 'BuyerReturnsSection');
jest.mock('../../src/utils/invoiceUtils', () => ({ shareInvoice: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
jest.mock('expo-image', () => ({ Image: 'Image' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'Gradient' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));

const purchase = {
  _id: 'owned-order', orderId: 'ORD-OWNER-1', currency: 'PKR', orderStatus: 'pending',
  paymentMethod: 'cash_on_delivery', isPaid: false, isDelivered: false, createdAt: '2026-09-27T00:00:00.000Z',
  buyerPresentationVersion: 1, sellerGroupingAvailable: true,
  orderItems: [
    { productId: 'product-a', seller: 'seller-a', name: 'Travel Mug', price: 1000, lineSubtotal: 1000, quantity: 1 },
    { productId: 'product-b', seller: 'seller-b', name: 'Desk Organizer', price: 500, lineSubtotal: 500, quantity: 1 },
  ],
  shippingInfo: { fullName: 'Test Buyer', email: 'buyer@example.com', address: 'Test street', city: 'Lahore', country: 'Pakistan' },
  orderSummary: { subtotal: 1500, shippingCost: 100, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 1600 },
  sellerGroups: [
    { sellerId: 'seller-a', storeName: 'Store One', status: 'pending', itemIndexes: [0], itemCount: 1, units: 1,
      shippingMethod: { name: 'Standard', price: 100, estimatedDays: 3 },
      summary: { subtotal: 1000, shippingCost: 100, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 1100 } },
    { sellerId: 'seller-b', storeName: 'Store Two', status: 'pending', itemIndexes: [1], itemCount: 1, units: 1,
      shippingMethod: { name: 'Free', price: 0, estimatedDays: 2 },
      summary: { subtotal: 500, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 500 } },
  ],
};
const navigation = { goBack: jest.fn(), navigate: jest.fn() };
beforeEach(() => { jest.clearAllMocks(); });

test('My Orders requests the buyer view and renders every seller with the frozen purchase total', async () => {
  api.get.mockResolvedValue({ data: { order: purchase } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: 'owned-order' } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Travel Mug')).toBeTruthy());
  expect(api.get).toHaveBeenCalledWith('/api/order/detail/owned-order?view=buyer');
  expect(screen.getByText('Desk Organizer')).toBeTruthy();
  expect(screen.getByText('Store One')).toBeTruthy();
  expect(screen.getByText('Store Two')).toBeTruthy();
  expect(screen.getAllByText('PKR 1600.00').length).toBeGreaterThan(0);
  expect(screen.queryByText('You can only view orders containing your products')).toBeNull();
});

test('a refused foreign order displays the server error without purchase data', async () => {
  api.get.mockRejectedValue({ response: { data: { msg: 'Order not found' }, status: 404 } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: 'foreign-order' } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Order not found')).toBeTruthy());
  expect(api.get).toHaveBeenCalledWith('/api/order/detail/foreign-order?view=buyer');
  expect(screen.queryByText('Travel Mug')).toBeNull();
  expect(api.patch).not.toHaveBeenCalled();
});

test('an active buyer detail quietly replaces a pending refund with the verified completed status', async () => {
  jest.useFakeTimers();
  const originalState = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  const cancellation = { reference: 'cancel-a', currency: 'PKR', destination: 'original_card', amountMinor: 110000,
    refundStatus: 'pending' };
  const pending = { ...purchase, paymentMethod: 'safepay', isPaid: true, orderStatus: 'delivered',
    sellerGroups: purchase.sellerGroups.map((group, index) => ({ ...group,
      status: index ? 'delivered' : 'cancelled', canCancel: false,
      ...(index ? {} : { cancellation }) })) };
  const completed = { ...pending, sellerGroups: pending.sellerGroups.map((group, index) => index ? group
    : { ...group, cancellation: { ...cancellation, refundStatus: 'refunded' } }) };
  api.get.mockResolvedValueOnce({ data: { order: pending } }).mockResolvedValue({ data: { order: completed } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: 'owned-order' } }} navigation={navigation} />);
  try {
    await waitFor(() => expect(screen.getByText('Refund in progress')).toBeTruthy());
    await act(async () => { jest.advanceTimersByTime(5000); });
    await waitFor(() => expect(screen.getByText('Refund completed')).toBeTruthy());
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Desk Organizer')).toBeTruthy();
  } finally {
    screen.unmount();
    if (originalState) Object.defineProperty(AppState, 'currentState', originalState);
    else delete AppState.currentState;
    jest.useRealTimers();
  }
});
