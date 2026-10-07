import React from 'react';
import { render } from '@testing-library/react-native';
import SellerPaymentsScreen from '../../../src/screens/seller/SellerPaymentsScreen';
import api from '../../../src/config/api';

const sellerId = '64b000000000000000000001';
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }) => children }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }) => children }));
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/common/KeyboardAwareFormScrollView', () => ({ children }) => children);
jest.mock('../../../src/utils/feedback', () => ({ show: jest.fn() }));
jest.mock('../../../src/contexts/AuthContext', () => ({ useAuth: () => ({ currentUser: { _id: '64b000000000000000000001', role: 'seller' } }) }));
jest.mock('../../../src/contexts/CurrencyContext', () => ({ useCurrency: () => ({
  currencies: { USD: { code: 'USD' }, PKR: { code: 'PKR' }, EUR: { code: 'EUR' }, GBP: { code: 'GBP' } },
  formatAmount: (amount, { targetCurrency }) => `${targetCurrency} ${Number(amount).toFixed(2)}`,
}) }));
jest.mock('../../../src/contexts/ThemeContext', () => ({ useTheme: () => ({ palette: {
  colors: { primary: '#4338ca', text: '#111827', textSecondary: '#64748b', success: '#16a34a', warning: '#eab308', error: '#dc2626', info: '#0ea5e9' },
  glass: { bgSubtle: '#fafafa', bgStrong: '#fff', borderSubtle: '#ddd', borderStrong: '#ccc' },
} }) }));
jest.mock('@react-native-picker/picker', () => {
  const R = require('react'), { View, Text } = require('react-native');
  const Picker = ({ children, ...props }) => R.createElement(View, props, children);
  Picker.Item = ({ label }) => R.createElement(Text, null, label);
  return { Picker };
});
jest.mock('../../../src/components/seller/SellerUI', () => {
  const R = require('react'), { Text } = require('react-native');
  return { SellerScreenHeader: ({ title }) => R.createElement(Text, null, title), SellerSectionHeader: ({ title }) => R.createElement(Text, null, title),
    SellerScreenSkeleton: () => R.createElement(Text, null, 'Loading payments'), SellerInlineError: ({ message }) => R.createElement(Text, null, message),
    SellerEmptyState: ({ title }) => R.createElement(Text, null, title) };
});
jest.mock('../../../src/config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
  API_ENDPOINTS: { STORES: { PRODUCT_CURRENCY: '/currency' }, PAYMENTS: { SELLER_SUMMARY: '/summary', SELLER_WITHDRAWALS: '/withdrawals', SELLER_ACCOUNT: '/account' } } }));

const paidWithdrawal = () => ({ _id: 'qa-paid-withdrawal', status: 'paid', balanceVersion: 2,
  amount: 15, currency: 'USD', requestedAmount: 15, requestedCurrency: 'USD', payoutAmount: 15, payoutCurrency: 'USD',
  payoutWorkflowVersion: 1, createdAt: '2026-10-07T00:00:00.000Z',
  payoutWorkflow: { version: 1, state: 'paid', attemptCount: 1,
    paidPayoutProvider: 'QA simulation - no bank transfer', paidTransferReference: 'QA-NO-BANK-20261007-15' } });

function seedWithdrawal(withdrawal) {
  const fields = ['withdrawableBalance', 'onlineDeliveredRevenue', 'onlinePendingRevenue', 'stripeDeliveredRevenue', 'stripePendingRevenue',
    'walletDeliveredRevenue', 'walletPendingRevenue', 'codDeliveredRevenue', 'codPendingRevenue', 'totalDeliveredRevenue', 'estimatedRevenue',
    'pendingWithdrawalAmount', 'approvedWithdrawalAmount', 'processingWithdrawalAmount', 'manualReviewWithdrawalAmount', 'totalWithdrawn',
    'totalReservedOrWithdrawn', 'returnRefundDebits', 'paymentReversalDebits', 'balanceAdjustmentCredits', 'deficit', 'paymentRiskHeldAmount', 'returnWindowHeldAmount'];
  const minima = { USD: 5, PKR: 2000, EUR: 5, GBP: 5 };
  const balances = Object.keys(minima).map(currency => {
    const amount = currency === 'USD' ? 50 : 0;
    return { ...Object.fromEntries(fields.map(field => [field, 0])), currency, minimumWithdrawal: minima[currency],
      withdrawableBalance: amount, onlineDeliveredRevenue: amount, stripeDeliveredRevenue: amount, totalDeliveredRevenue: amount, estimatedRevenue: amount };
  });
  const summary = { sellerId, accountingVersion: 2, displayCurrency: 'USD', baseCurrency: 'USD', balances,
    balanceByCurrency: Object.fromEntries(balances.map(balance => [balance.currency, balance])), displayRevenue: balances[0],
    withdrawalLimits: { currency: 'USD', baseCurrency: 'USD', displayCurrency: 'USD', availableDisplayAmount: 50, minimumDisplayAmount: 5 },
    exchangeRateStatus: { fallback: false }, paymentRiskPending: false, recentOrders: { stripe: [], wallet: [], cod: [] },
    paymentAccount: { accountHolderName: 'QA Seller', bankName: 'QA Bank', maskedAccountNumber: '**** 1234', country: 'Pakistan', currency: 'USD' },
    withdrawals: [withdrawal] };
  const currencyState = { hasStore: true, activeCurrency: 'USD', status: 'active', pendingCurrency: null, previousCurrency: null,
    productCount: 1, productCurrencies: ['USD'], productCurrencyCounts: { USD: 1 }, canAddProduct: true };
  api.get.mockImplementation(async url => ({ data: url === '/currency' ? { productCurrency: currencyState } : summary }));
}

beforeEach(() => jest.clearAllMocks());

test('paid history uses seller public provider/reference without reading or rendering admin proof', async () => {
  seedWithdrawal({ ...paidWithdrawal(), paidPayoutAttemptId: 'SECRET_ATTEMPT', payoutAttempts: [{
    transferredAt: 'SECRET_DATE', evidence: { url: 'https://example.com/SECRET_RECEIPT', note: 'SECRET_NOTE' },
  }] });
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Transfer reference: QA-NO-BANK-20261007-15');
  expect(screen.getByText('Provider: QA simulation - no bank transfer')).toBeTruthy();
  expect(screen.getByText('Requested: USD 15.00')).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toContain('SECRET');
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled();
});

test('legacy paid history keeps its money and explains unavailable proof without inventing a provider', async () => {
  seedWithdrawal({ _id: 'legacy-paid', status: 'paid', amount: 15, currency: 'USD', payoutWorkflowVersion: 0,
    payoutWorkflow: { version: 0, state: 'paid', attemptCount: 0 }, createdAt: '2026-10-07T00:00:00.000Z' });
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Recorded payout details unavailable.');
  expect(screen.getByText('Requested: USD 15.00')).toBeTruthy();
  expect(screen.queryByText(/^Provider:/)).toBeNull();
});

test.each(['processing', 'failed'])('non-paid %s cannot display a stale paid reference', async status => {
  seedWithdrawal({ ...paidWithdrawal(), status });
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Requested: USD 15.00');
  expect(screen.queryByText(/^Transfer reference:/)).toBeNull();
  expect(screen.queryByText('Recorded payout details')).toBeNull();
});

test('corrupted paid reference is unavailable and never becomes a link or credible payout detail', async () => {
  const request = paidWithdrawal(); request.payoutWorkflow.paidTransferReference = 'javascript:alert(1)';
  seedWithdrawal(request);
  const screen = render(<SellerPaymentsScreen navigation={{ navigate: jest.fn() }} />);
  await screen.findByText('Recorded payout details unavailable.');
  expect(screen.queryByText(/^Provider:/)).toBeNull();
  expect(JSON.stringify(screen.toJSON())).not.toContain('javascript:');
});
