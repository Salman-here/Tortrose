import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import SellerRevenueOverview from '../../src/components/seller/SellerRevenueOverview';
import SellerAnalyticsScreen from '../../src/screens/seller/SellerAnalyticsScreen';
import api from '../../src/config/api';

let mockUser = { _id: 'seller-a', role: 'seller' };
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: mockUser }) }));
jest.mock('../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatAmount: (amount, { targetCurrency }) => `${targetCurrency} ${amount.toFixed(2)}` }) }));
jest.mock('../../src/contexts/ThemeContext', () => ({ useTheme: () => ({
  palette: { colors: require('../../src/styles/theme').colors, glass: { bgSubtle: '#fff' } },
}) }));
jest.mock('../../src/components/seller/SellerUI', () => {
  const R = require('react'), { Text } = require('react-native');
  return { SellerScreenHeader: () => null, SellerScreenSkeleton: () => null,
    SellerInlineError: ({ message }) => R.createElement(Text, null, message) };
});
jest.mock('../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
  API_ENDPOINTS: { STORES: { PRODUCT_CURRENCY: '/currency' }, PAYMENTS: { SELLER_SUMMARY: '/summary' } } }));

const currency = { hasStore: true, activeCurrency: 'PKR', status: 'active', pendingCurrency: null, previousCurrency: null,
  productCount: 1, productCurrencies: ['PKR'], productCurrencyCounts: { PKR: 1 }, canAddProduct: true };
const summary = (sellerId = 'seller-a') => {
  return { sellerId, version: 1, currency: 'PKR', scope: 'all_time',
    period: { days: null, startDate: null, endDateExclusive: null, timezone: 'UTC', basis: 'order_created_at' },
    exchangeRateStatus: { fallback: false, frozen: true }, onlineEarningsBasis: 'native_balance_currency', onlineGrossEarnings: 6000,
    codDeliveredRevenue: 4000, onlineDeliveredRevenue: 6000, totalDeliveredRevenue: 10000,
    onlinePendingRevenue: 1500, codPendingRevenue: 500, estimatedRevenue: 12000 };
};

beforeEach(() => {
  mockUser = { _id: 'seller-a', role: 'seller' };
  jest.clearAllMocks();
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currency } : { overview: summary(mockUser._id) } }));
});

test('renders the exact three all-time cards from the original authority without a write', async () => {
  const screen = render(<SellerRevenueOverview />);
  await screen.findByText('PKR 12000.00');
  for (const label of ['Delivered COD Revenue', 'Total Delivered Revenue', 'Estimated Revenue']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('PKR 4000.00')).toBeTruthy();
  expect(screen.getByText('PKR 10000.00')).toBeTruthy();
  expect(screen.getByText(/Lifetime totals/)).toBeTruthy();
  expect(screen.getByText('Total Online Earnings (PKR)')).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith('/api/payments/seller/revenue-overview?currency=PKR&days=all', expect.any(Object));
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

test('a failed refresh removes old totals and does not show invented zero money', async () => {
  const screen = render(<SellerRevenueOverview />);
  await screen.findByText('PKR 12000.00');
  api.get.mockRejectedValue(new Error('Connection unavailable'));
  fireEvent.press(screen.getByLabelText('Refresh all-time revenue'));
  await screen.findByText('Connection unavailable');
  expect(screen.queryByText('PKR 12000.00')).toBeNull();
  expect(screen.queryByText('PKR 0.00')).toBeNull();
});

test.each(['seller-b', 'invalid-currency'])('rejects %s response rather than displaying another balance', async reason => {
  const invalid = summary(reason === 'seller-b' ? reason : 'seller-a');
  if (reason === 'invalid-currency') invalid.currency = 'USD';
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currency } : { overview: invalid } }));
  const screen = render(<SellerRevenueOverview />);
  await screen.findByText('Revenue totals could not be verified. Please retry.');
  expect(screen.queryByText('PKR 12000.00')).toBeNull();
});

test('ignores a late old-account response after switching sellers', async () => {
  const pending = [];
  api.get.mockImplementation(url => url === '/currency' ? Promise.resolve({ data: { productCurrency: currency } })
    : new Promise(resolve => pending.push(resolve)));
  const screen = render(<SellerRevenueOverview />);
  await waitFor(() => expect(pending).toHaveLength(1));
  mockUser = { _id: 'seller-b', role: 'seller' };
  screen.rerender(<SellerRevenueOverview />);
  await waitFor(() => expect(pending).toHaveLength(2));
  const newer = summary('seller-b');
  Object.assign(newer, { codDeliveredRevenue: 0, onlineDeliveredRevenue: 500, onlineGrossEarnings: 600,
    totalDeliveredRevenue: 500, onlinePendingRevenue: 0, codPendingRevenue: 0, estimatedRevenue: 500 });
  await act(async () => { pending[1]({ data: { overview: newer } }); });
  await screen.findAllByText('PKR 500.00');
  await act(async () => { pending[0]({ data: { overview: summary('seller-a') } }); });
  expect(screen.queryByText('PKR 12000.00')).toBeNull();
  expect(screen.getAllByText('PKR 500.00')).toHaveLength(2);
});

test('basic revenue remains available when advanced analytics charts are not included', async () => {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/api/analytics/seller')) throw { response: { status: 403 } };
    if (url === '/currency') return { data: { productCurrency: currency } };
    const value = summary();
    if (url.endsWith('days=30')) {
      value.scope = 'period'; value.period = { days: 30, startDate: '2026-09-14T00:00:00.000Z', endDateExclusive: '2026-10-14T00:00:00.000Z', timezone: 'UTC', basis: 'order_created_at' };
      Object.assign(value, { codDeliveredRevenue: 1000, onlineDeliveredRevenue: 4000, onlineGrossEarnings: 4000, totalDeliveredRevenue: 5000, onlinePendingRevenue: 0, codPendingRevenue: 0, estimatedRevenue: 5000 });
    }
    return { data: { overview: value } };
  });
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('PKR 12000.00');
  expect(screen.getByText(/Advanced Analytics is not included/)).toBeTruthy();
  expect(screen.getAllByText('Delivered COD Revenue')).toHaveLength(2);
  expect(screen.getByText('Revenue · Last 30 days')).toBeTruthy();
});

test('switching the period ignores the previous late response instead of showing old-range money', async () => {
  const pending = [];
  api.get.mockImplementation(url => url === '/currency' ? Promise.resolve({ data: { productCurrency: currency } })
    : new Promise(resolve => pending.push(resolve)));
  const screen = render(<SellerRevenueOverview days="7" />);
  await waitFor(() => expect(pending).toHaveLength(1));
  screen.rerender(<SellerRevenueOverview days="30" />);
  await waitFor(() => expect(pending).toHaveLength(2));
  const current = summary(); current.scope = 'period'; current.period = { days: 30, startDate: '2026-09-14T00:00:00.000Z', endDateExclusive: '2026-10-14T00:00:00.000Z', timezone: 'UTC', basis: 'order_created_at' };
  await act(async () => { pending[1]({ data: { overview: current } }); });
  await screen.findByText('PKR 12000.00');
  const previous = summary(); previous.scope = 'period'; previous.period = { days: 7, startDate: '2026-10-07T00:00:00.000Z', endDateExclusive: '2026-10-14T00:00:00.000Z', timezone: 'UTC', basis: 'order_created_at' };
  previous.estimatedRevenue = 999;
  await act(async () => { pending[0]({ data: { overview: previous } }); });
  expect(screen.getByText('Revenue · Last 30 days')).toBeTruthy();
  expect(screen.queryByText('PKR 999.00')).toBeNull();
});
