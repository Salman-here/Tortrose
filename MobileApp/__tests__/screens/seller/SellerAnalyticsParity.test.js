import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import SellerAnalyticsScreen from '../../../src/screens/seller/SellerAnalyticsScreen';
import SellerAnalyticsCharts, { SellerDailyChart } from '../../../src/components/seller/SellerAnalyticsCharts';
import api from '../../../src/config/api';

let mockUser = { _id: 'seller-a', role: 'seller' };
let mockPalette;
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/Skeleton', () => () => null);
jest.mock('../../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: mockUser }) }));
jest.mock('../../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: mockPalette }) }));
jest.mock('../../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatAmount: (amount, { targetCurrency }) => `${targetCurrency} ${amount.toFixed(2)}` }) }));
jest.mock('../../../src/components/seller/SellerUI', () => {
  const R = require('react'), { Text, TouchableOpacity } = require('react-native');
  return { SellerScreenHeader: ({ onRightPress }) => R.createElement(TouchableOpacity, { accessibilityLabel: 'Refresh all analytics', onPress: onRightPress }),
    SellerInlineError: ({ message, onRetry }) => R.createElement(TouchableOpacity, { accessibilityLabel: 'Retry analytics', onPress: onRetry }, R.createElement(Text, null, message)) };
});
jest.mock('react-native-svg', () => {
  const R = require('react'), { View } = require('react-native');
  const shape = name => ({ children, ...props }) => R.createElement(View, { ...props, testID: `svg-${name}` }, children);
  return { __esModule: true, default: shape('Svg'), Circle: shape('Circle'), Defs: shape('Defs'), Line: shape('Line'),
    LinearGradient: shape('LinearGradient'), Path: shape('Path'), Rect: shape('Rect'), Stop: shape('Stop') };
});
jest.mock('../../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
  API_ENDPOINTS: { STORES: { PRODUCT_CURRENCY: '/currency' } } }));

const currency = { hasStore: true, activeCurrency: 'PKR', status: 'active', pendingCurrency: null, previousCurrency: null,
  productCount: 1, productCurrencies: ['PKR'], productCurrencyCounts: { PKR: 1 }, canAddProduct: true };
const dates = days => Array.from({ length: days }, (_, index) => new Date(Date.UTC(2026, 9, 14 - days + index)).toISOString().slice(0, 10));
const report = (days, amount = 5000) => ({ currency: 'PKR', summary: { totalRevenue: amount, paidOrders: 1, avgOrderValue: amount, totalUnitsSold: 2 },
  revenueByDay: dates(days).map((date, index) => ({ date, revenue: index === 0 ? amount : 0, orders: index === 0 ? 1 : 0 })),
  topProducts: [{ productId: 'product-a', name: 'Travel Mug', image: 'https://example.com/product.png', revenue: amount, sold: 2 }],
  categoryBreakdown: Array.from({ length: 8 }, (_, index) => ({ name: `Category ${index}`, count: index + 1 })),
  statusBreakdown: [{ name: 'pending', value: 0 }, { name: 'delivered', value: 1 }],
});
const overview = (days, sellerId = mockUser._id) => ({ version: 1, sellerId, currency: 'PKR', scope: days === 'all' ? 'all_time' : 'period',
  period: { days: days === 'all' ? null : Number(days), startDate: days === 'all' ? null : `${dates(Number(days))[0]}T00:00:00.000Z`, endDateExclusive: days === 'all' ? null : '2026-10-14T00:00:00.000Z', timezone: 'UTC', basis: 'order_created_at' },
  exchangeRateStatus: { fallback: false, frozen: true }, onlineEarningsBasis: 'native_balance_currency',
  onlineGrossEarnings: 6000, codDeliveredRevenue: 4000, onlineDeliveredRevenue: 6000, totalDeliveredRevenue: 10000,
  onlinePendingRevenue: 1500, codPendingRevenue: 500, estimatedRevenue: 12000,
});
const defaults = async url => {
  if (url === '/currency') return { data: { productCurrency: currency } };
  const days = new URLSearchParams(url.split('?')[1]).get('days');
  if (url.startsWith('/api/analytics')) return { data: { analytics: report(Number(days)) } };
  return { data: { overview: overview(days) } };
};

beforeEach(() => {
  jest.clearAllMocks(); mockUser = { _id: 'seller-a', role: 'seller' };
  mockPalette = require('../../../src/styles/palettes').lightPalette;
  api.get.mockImplementation(defaults);
});

test.each(['light', 'dark'])('renders web-equivalent reporting and every section in %s mode', async theme => {
  mockPalette = require('../../../src/styles/palettes')[`${theme}Palette`];
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByLabelText('Revenue Trend, 30 daily values');
  expect(screen.getAllByText('Total Online Earnings (PKR)')).toHaveLength(2);
  for (const name of ['Delivered COD Revenue', 'Total Delivered Revenue', 'Estimated Revenue']) expect(screen.getAllByText(name)).toHaveLength(2);
  for (const title of ['Order Volume', 'Order Status', 'Top Products', 'Category Breakdown', 'Category 7']) expect(screen.getByText(title)).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith('/api/analytics/seller?days=30&currency=PKR', expect.objectContaining({ signal: expect.any(Object) }));
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

test('all ranges retain exact daily values, including revenue earlier than the last fourteen days', async () => {
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByLabelText('Revenue Trend, 30 daily values');
  for (const days of ['7', '90', '30']) {
    fireEvent.press(screen.getByLabelText(`${days} Days`));
    const chart = await screen.findByLabelText(`Revenue Trend, ${days} daily values`);
    fireEvent.press(chart, { nativeEvent: { locationX: 0 } });
    expect(screen.getByLabelText(`Revenue Trend, ${days} daily values`).props.accessibilityValue.text).toContain('PKR 5000.00');
    expect(screen.getByLabelText(`Order Volume, ${days} daily values`)).toBeTruthy();
  }
});

test('refreshes lifetime, selected-period revenue and performance without a write', async () => {
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByLabelText('Revenue Trend, 30 daily values');
  api.get.mockClear(); fireEvent.press(screen.getByLabelText('Refresh all analytics'));
  await waitFor(() => expect(api.get.mock.calls.some(([url]) => url.endsWith('days=all'))).toBe(true));
  await screen.findByLabelText('Revenue Trend, 30 daily values');
  expect(api.get.mock.calls.some(([url]) => url.includes('revenue-overview') && url.endsWith('days=30'))).toBe(true);
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

test('ignores late old-range and old-account responses', async () => {
  const pending = [];
  api.get.mockImplementation(url => url.startsWith('/api/analytics') ? new Promise(resolve => pending.push({ url, resolve })) : defaults(url));
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await waitFor(() => expect(pending).toHaveLength(1));
  fireEvent.press(screen.getByLabelText('7 Days'));
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => { pending[1].resolve({ data: { analytics: report(7, 700) } }); });
  await screen.findByLabelText('Revenue Trend, 7 daily values');
  await act(async () => { pending[0].resolve({ data: { analytics: report(30, 30000) } }); });
  expect(screen.queryByText('PKR 30000.00')).toBeNull();
  mockUser = { _id: 'seller-b', role: 'seller' }; screen.rerender(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await waitFor(() => expect(pending).toHaveLength(3));
  expect(screen.queryByLabelText('Revenue Trend, 7 daily values')).toBeNull();
});

test('invalid period data fails closed without hiding the independent revenue cards', async () => {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/api/analytics')) return { data: { analytics: { ...report(30), revenueByDay: report(30).revenueByDay.slice(-14) } } };
    return defaults(url);
  });
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Analytics returned an incomplete or invalid reporting period. Please retry.');
  expect(screen.queryByLabelText('Revenue Trend, 30 daily values')).toBeNull();
  expect(screen.getAllByText('Total Online Earnings (PKR)')).toHaveLength(2);
});

test('zero data keeps all sections visible and draws no positive order bars', () => {
  const empty = report(7); empty.revenueByDay = dates(7).map(date => ({ date, revenue: 0, orders: 0 }));
  empty.topProducts = []; empty.categoryBreakdown = []; empty.statusBreakdown = [];
  const screen = render(<SellerAnalyticsCharts analytics={empty} days="7" />);
  expect(screen.getByText('No sales data yet.')).toBeTruthy(); expect(screen.getByText('No products yet.')).toBeTruthy();
  expect(screen.getByText('Order Status')).toBeTruthy();
  expect(screen.queryAllByTestId('svg-Rect')).toHaveLength(0);
});

test('daily value controls and screen-reader adjustment remain within the selected date interval', () => {
  const screen = render(<SellerDailyChart rows={report(7).revenueByDay} field="orders" currency="PKR" title="Orders" subtitle="Daily" kind="bars" />);
  fireEvent.press(screen.getByLabelText('Orders, 7 daily values'), { nativeEvent: { locationX: 0 } });
  expect(screen.getByLabelText('Orders: previous day').props.accessibilityState.disabled).toBe(true);
  fireEvent(screen.getByLabelText('Orders, 7 daily values'), 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
  expect(screen.getByLabelText('Orders, 7 daily values').props.accessibilityValue.now).toBe(1);
});
