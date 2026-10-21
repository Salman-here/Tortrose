import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';
import OrderDetailScreen from '../../src/screens/OrderDetailScreen';
import api from '../../src/config/api';
import { useTheme } from '../../src/contexts/ThemeContext';

jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() } }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: jest.fn() }));
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
jest.mock('../../src/components/BuyerWarrantySection', () => 'BuyerWarrantySection');
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
beforeEach(() => {
  jest.clearAllMocks();
  useTheme.mockReturnValue({ palette: require('../../src/styles/palettes').lightPalette });
});

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

test.each(['light', 'dark'])('%s: multi-seller breakdowns combine shipping without changing purchase amounts', async (theme) => {
  useTheme.mockReturnValue({ palette: require('../../src/styles/palettes')[`${theme}Palette`] });
  const before = JSON.stringify(purchase);
  api.get.mockResolvedValue({ data: { order: purchase } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: purchase._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Travel Mug')).toBeTruthy());
  expect(screen.getAllByText('YOUR CHECKOUT BREAKDOWN FOR THIS STORE')).toHaveLength(2);
  expect(screen.getAllByText('Total')).toHaveLength(3);
  expect(screen.queryByText('Store total')).toBeNull();
  expect(screen.getByText('Standard - 3 days · PKR 100.00')).toBeTruthy();
  expect(screen.getByText('2 days · Free')).toBeTruthy();
  expect(screen.queryByText(/estimated delivery/)).toBeNull();
  expect(screen.getByText('PKR 1100.00')).toBeTruthy();
  expect(screen.getAllByText('PKR 500.00').length).toBeGreaterThan(0);
  expect(screen.getAllByText('PKR 1600.00').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Store One shipment status: Pending')).toBeTruthy();
  expect(screen.getByLabelText('Store Two shipment status: Pending')).toBeTruthy();
  expect(JSON.stringify(purchase)).toBe(before);
  expect(api.patch).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

test.each(['light', 'dark'])('%s: three products from one seller have no extra shipping card or per-store breakdown', async (theme) => {
  useTheme.mockReturnValue({ palette: require('../../src/styles/palettes')[`${theme}Palette`] });
  const order = {
    ...purchase,
    orderItems: [
      { productId: 'notebook', seller: 'seller-a', name: 'Notebook', price: 475, lineSubtotal: 475, quantity: 1,
        selectedOptions: { Size: 'A5', Color: 'Blue' } },
      { productId: 'mug', seller: 'seller-a', name: 'Mug', price: 100, lineSubtotal: 100, quantity: 1 },
      { productId: 'replacement-mug', seller: 'seller-a', name: 'Replacement Mug', price: 100, lineSubtotal: 100, quantity: 1 },
    ],
    orderSummary: { subtotal: 675, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 675 },
    sellerGroups: [{ ...purchase.sellerGroups[0], itemIndexes: [0, 1, 2], itemCount: 3, units: 3, canCancel: true,
      shippingMethod: { name: 'free', price: 0, estimatedDays: 5 },
      summary: { subtotal: 675, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 675 } }],
  };
  api.get.mockResolvedValue({ data: { order } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: order._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Notebook')).toBeTruthy());
  expect(screen.getByText('Mug')).toBeTruthy();
  expect(screen.getByText('Replacement Mug')).toBeTruthy();
  expect(screen.getByText(/Size: A5\s+•\s+Color: Blue/)).toBeTruthy();
  expect(screen.queryByText('YOUR CHECKOUT BREAKDOWN FOR THIS STORE')).toBeNull();
  expect(screen.queryByText('Store total')).toBeNull();
  expect(screen.getAllByText('Total')).toHaveLength(1);
  expect(screen.queryByText('free')).toBeNull();
  expect(screen.queryByText(/5 days/)).toBeNull();
  expect(screen.getAllByText('Free')).toHaveLength(1); // The overall order summary remains.
  expect(screen.getAllByText('PKR 675.00').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Cancel Store One items')).toBeTruthy();
});

test.each([
  [{ name: 'free', price: 0, estimatedDays: 5 }, '5 days · Free'],
  [{ name: 'Free Shipping', price: 0, estimatedDays: 1 }, '1 day · Free'],
  [{ name: 'standard', price: 300, estimatedDays: 3 }, 'standard - 3 days · PKR 300.00'],
  [{ name: 'Express', price: 300, estimatedDays: 1 }, 'Express - 1 day · PKR 300.00'],
  [{ name: 'Collection', price: 0, estimatedDays: null }, 'Collection · Free'],
  [{ name: 'Standard', price: 100, estimatedDays: null }, 'Standard · PKR 100.00'],
  [null, 'PKR 100.00'],
])('shipping uses the saved method and estimate: %s', async (method, expected) => {
  const shippingCost = method?.price ?? 100;
  const order = { ...purchase,
    sellerGroups: purchase.sellerGroups.map((group, index) => index ? group : { ...group,
      shippingMethod: method, summary: { ...group.summary, shippingCost, totalAmount: 1000 + shippingCost } }),
    orderSummary: { ...purchase.orderSummary, shippingCost, totalAmount: 1500 + shippingCost },
  };
  api.get.mockResolvedValue({ data: { order } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: order._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Travel Mug')).toBeTruthy());
  expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  expect(screen.queryByText(/estimated delivery/)).toBeNull();
  if (method) expect(StyleSheet.flatten(screen.getByText(expected).props.style)).toMatchObject({ flexShrink: 1, textAlign: 'right' });
});

test.each([-0.01, 0.01])('stored tax, discounts and signed rounding remain unchanged (%s)', async (adjustment) => {
  const totalAmount = 1000 + 100 + 50 - 20 + adjustment;
  const order = { ...purchase,
    sellerGroups: purchase.sellerGroups.map((group, index) => index ? group : { ...group,
      summary: { ...group.summary, tax: 50, couponDiscount: 20, reconciliationAdjustment: adjustment, totalAmount } }),
    orderSummary: { ...purchase.orderSummary, tax: 50, couponDiscount: 20, reconciliationAdjustment: adjustment, totalAmount: totalAmount + 500 },
  };
  api.get.mockResolvedValue({ data: { order } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: order._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Travel Mug')).toBeTruthy());
  expect(screen.getByText(`PKR ${totalAmount.toFixed(2)}`)).toBeTruthy();
  expect(screen.getAllByText('-PKR 20.00')).toHaveLength(2);
  expect(screen.getAllByText(`${adjustment > 0 ? '+' : '-'}PKR 0.01`)).toHaveLength(2);
  expect(screen.getAllByText('PKR 50.00')).toHaveLength(2);
  expect(screen.getByText('Standard - 3 days · PKR 100.00')).toBeTruthy();
});

test('a cancelled store does not hide the breakdowns of a multi-seller purchase', async () => {
  const order = { ...purchase, sellerGroups: purchase.sellerGroups.map((group, index) => ({ ...group,
    status: index ? 'confirmed' : 'cancelled', canCancel: index === 1 })) };
  api.get.mockResolvedValue({ data: { order } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: order._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Travel Mug')).toBeTruthy());
  expect(screen.getAllByText('YOUR CHECKOUT BREAKDOWN FOR THIS STORE')).toHaveLength(2);
  expect(screen.queryByLabelText('Cancel Store One items')).toBeNull();
  expect(screen.getByLabelText('Cancel Store Two items')).toBeTruthy();
  expect(screen.getByText("This store's portion was cancelled.")).toBeTruthy();
});

test('the unchanged store cancellation control still previews only that seller without cancelling', async () => {
  api.get.mockResolvedValue({ data: { order: { ...purchase,
    sellerGroups: purchase.sellerGroups.map(group => ({ ...group, canCancel: true })) } } });
  api.post.mockRejectedValue({ response: { data: { msg: 'Preview unavailable in this test' } } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: purchase._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText('Travel Mug')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Cancel Store Two items'));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/order/cancel/owned-order/preview', { sellerIds: ['seller-b'] }));
  expect(api.patch).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Close cancellation'));
  expect(screen.getByText('Standard - 3 days · PKR 100.00')).toBeTruthy();
});

test('inconsistent stored shipping is still rejected instead of recalculated', async () => {
  const order = { ...purchase, sellerGroups: purchase.sellerGroups.map((group, index) => index ? group
    : { ...group, shippingMethod: { ...group.shippingMethod, price: 300 } }) };
  api.get.mockResolvedValue({ data: { order } });
  const screen = render(<OrderDetailScreen route={{ params: { orderId: order._id } }} navigation={navigation} />);
  await waitFor(() => expect(screen.getByText(/This order contains information that could not be verified/)).toBeTruthy());
  expect(screen.queryByText('Travel Mug')).toBeNull();
  expect(api.patch).not.toHaveBeenCalled();
});
