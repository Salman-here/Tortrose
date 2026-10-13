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
  const fields = ['withdrawableBalance', 'onlineDeliveredRevenue', 'onlinePendingRevenue', 'pendingWithdrawalAmount',
    'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn',
    'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits', 'totalReservedOrWithdrawn', 'deficit', 'paymentRiskHeldAmount'];
  const minima = { USD: 5, PKR: 2000, EUR: 5, GBP: 5 };
  const balances = Object.keys(minima).map(code => ({ ...Object.fromEntries(fields.map(field => [field, 0])), currency: code, minimumWithdrawal: minima[code] }));
  return { sellerId, accountingVersion: 2, displayCurrency: 'PKR', baseCurrency: 'PKR', balances,
    balanceByCurrency: Object.fromEntries(balances.map(row => [row.currency, { ...row }])), exchangeRateStatus: { fallback: false },
    withdrawalLimits: { currency: 'PKR', availableDisplayAmount: 0, minimumDisplayAmount: 2000 },
    displayRevenue: { codDeliveredRevenue: 4000, onlineDeliveredRevenue: 6000, totalDeliveredRevenue: 10000,
      onlinePendingRevenue: 1500, codPendingRevenue: 500, estimatedRevenue: 12000 } };
};

beforeEach(() => {
  mockUser = { _id: 'seller-a', role: 'seller' };
  jest.clearAllMocks();
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currency } : summary(mockUser._id) }));
});

test('renders the exact three all-time cards from the original authority without a write', async () => {
  const screen = render(<SellerRevenueOverview />);
  await screen.findByText('PKR 12000.00');
  for (const label of ['Delivered COD Revenue', 'Total Delivered Revenue', 'Estimated Revenue']) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText('PKR 4000.00')).toBeTruthy();
  expect(screen.getByText('PKR 10000.00')).toBeTruthy();
  expect(screen.getByText(/Independent of the chart period/)).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith('/summary?currency=PKR', expect.any(Object));
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
  if (reason === 'invalid-currency') invalid.displayCurrency = 'USD';
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currency } : invalid }));
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
  Object.assign(newer.displayRevenue, { codDeliveredRevenue: 0, onlineDeliveredRevenue: 500,
    totalDeliveredRevenue: 500, onlinePendingRevenue: 0, codPendingRevenue: 0, estimatedRevenue: 500 });
  await act(async () => { pending[1]({ data: newer }); });
  await screen.findAllByText('PKR 500.00');
  await act(async () => { pending[0]({ data: summary('seller-a') }); });
  expect(screen.queryByText('PKR 12000.00')).toBeNull();
  expect(screen.getAllByText('PKR 500.00')).toHaveLength(2);
});

test('basic revenue remains available when advanced analytics charts are not included', async () => {
  api.get.mockImplementation(async url => {
    if (url.startsWith('/api/analytics/seller')) throw { response: { status: 403 } };
    return { data: url === '/currency' ? { productCurrency: currency } : summary() };
  });
  const screen = render(<SellerAnalyticsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('PKR 12000.00');
  expect(screen.getByText(/Advanced Analytics is not included/)).toBeTruthy();
  expect(screen.getByText('Delivered COD Revenue')).toBeTruthy();
});
