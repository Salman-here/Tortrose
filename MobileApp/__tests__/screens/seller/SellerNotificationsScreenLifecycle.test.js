import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import SellerNotificationsScreen from '../../../src/screens/seller/SellerNotificationsScreen';
import api from '../../../src/config/api';

let mockCurrentUser = null;

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }) => children,
}));
jest.mock('../../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() },
}));
jest.mock('../../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: mockCurrentUser }),
}));
jest.mock('../../../src/contexts/ThemeContext', () => ({
  useTheme: () => ({
    palette: {
      colors: {
        primary: '#4338ca', primarySubtle: '#eef2ff', primaryLighter: '#c7d2fe',
        secondary: '#7c3aed', secondarySubtle: '#f3e8ff', text: '#111827',
        textSecondary: '#64748b', textLight: '#94a3b8', successDark: '#166534',
        successSubtle: '#dcfce7', warningDark: '#92400e', warningSubtle: '#fef3c7',
        error: '#dc2626', errorSubtle: '#fee2e2', infoDark: '#1e40af',
        infoSubtle: '#dbeafe', white: '#fff', grayLighter: '#e2e8f0',
      },
      glass: {
        bgSubtle: '#f8fafc', bgStrong: '#fff', borderSubtle: '#e2e8f0',
        borderStrong: '#cbd5e1',
      },
    },
  }),
}));
jest.mock('../../../src/components/common/GlassBackground', () => ({ children }) => children);
jest.mock('../../../src/components/common/GlassPanel', () => ({ children }) => children);
jest.mock('../../../src/components/seller/SellerUI', () => {
  const ReactModule = require('react');
  const { Text, View } = require('react-native');
  return {
    SellerEmptyState: ({ title, message }) => ReactModule.createElement(
      View,
      null,
      ReactModule.createElement(Text, null, title),
      ReactModule.createElement(Text, null, message),
    ),
    SellerInlineError: ({ title, message }) => ReactModule.createElement(
      View,
      null,
      ReactModule.createElement(Text, null, title),
      ReactModule.createElement(Text, null, message),
    ),
    SellerScreenHeader: ({ title }) => ReactModule.createElement(Text, null, title),
    SellerScreenSkeleton: () => ReactModule.createElement(Text, null, 'Loading notifications'),
    SellerSectionHeader: ({ title }) => ReactModule.createElement(Text, null, title),
  };
});

const SELLER_A = '64b000000000000000000001';
const SELLER_B = '64b000000000000000000002';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const analyticsResponse = (sellerId, label) => ({
  data: {
    sellerId,
    audienceRole: 'seller',
    notifications: [{
      id: `paid-${label}`,
      type: 'success',
      category: 'payment',
      title: `${label} payment`,
      description: `${label} frozen amount`,
      time: '2026-08-25T10:00:00.000Z',
      read: false,
      orderId: `order-${label}`,
    }],
  },
});

const inboxResponse = (sellerId) => ({
  data: {
    account: { userId: sellerId, role: 'seller', surface: 'seller' },
    items: [],
    unread: 0,
  },
});

describe('SellerNotificationsScreen account isolation', () => {
  beforeEach(() => {
    mockCurrentUser = { _id: SELLER_A, role: 'seller' };
    api.get.mockReset();
    api.patch.mockReset();
    api.post.mockReset();
  });

  test('hides the old account immediately and ignores its late financial response', async () => {
    const requests = [];
    api.get.mockImplementation((url) => {
      const request = deferred();
      requests.push({ url, request });
      return request.promise;
    });
    const navigation = { navigate: jest.fn() };
    const screen = render(<SellerNotificationsScreen navigation={navigation} />);
    await waitFor(() => expect(requests).toHaveLength(2));

    mockCurrentUser = { _id: SELLER_B, role: 'seller' };
    screen.rerender(<SellerNotificationsScreen navigation={navigation} />);
    expect(screen.queryByText('Seller A frozen amount')).toBeNull();
    await waitFor(() => expect(requests).toHaveLength(4));

    const sellerBRequests = requests.slice(2);
    await act(async () => {
      sellerBRequests.find(({ url }) => url.includes('analytics')).request
        .resolve(analyticsResponse(SELLER_B, 'Seller B'));
      sellerBRequests.find(({ url }) => url.includes('notifications/me')).request
        .resolve(inboxResponse(SELLER_B));
      await Promise.all(sellerBRequests.map(({ request }) => request.promise));
    });
    await screen.findByText('Seller B frozen amount');

    const sellerARequests = requests.slice(0, 2);
    await act(async () => {
      sellerARequests.find(({ url }) => url.includes('analytics')).request
        .resolve(analyticsResponse(SELLER_A, 'Seller A'));
      sellerARequests.find(({ url }) => url.includes('notifications/me')).request
        .resolve(inboxResponse(SELLER_A));
      await Promise.all(sellerARequests.map(({ request }) => request.promise));
    });
    expect(screen.queryByText('Seller A frozen amount')).toBeNull();
    expect(screen.getByText('Seller B frozen amount')).toBeTruthy();
  });

  test('rejects a fulfilled response whose account metadata is not the active seller', async () => {
    api.get.mockImplementation((url) => Promise.resolve(
      url.includes('analytics')
        ? analyticsResponse(SELLER_B, 'Wrong Seller')
        : inboxResponse(SELLER_B),
    ));
    const screen = render(<SellerNotificationsScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText('Notifications unavailable');
    expect(screen.queryByText('Wrong Seller frozen amount')).toBeNull();
  });

  test('requests and marks all through the seller-only server surface', async () => {
    const sellerRow = {
      _id: '64b000000000000000000010',
      user: SELLER_A,
      targetRole: 'seller',
      audience: 'specific',
      source: 'system',
      category: 'payment',
      title: 'Seller withdrawal paid',
      body: 'PKR 1,000.00 was paid.',
      linkTo: '/seller-dashboard/payments',
      eventKey: 'seller:withdrawal:paid:v1',
      eventType: 'withdrawal.status_changed',
      aggregateType: 'Withdrawal',
      aggregateId: 'withdrawal-1',
      createdAt: '2026-08-25T10:00:00.000Z',
      read: false,
    };
    api.get.mockImplementation((url) => Promise.resolve(
      url.includes('analytics')
        ? { data: { sellerId: SELLER_A, audienceRole: 'seller', notifications: [] } }
        : {
          data: {
            account: { userId: SELLER_A, role: 'seller', surface: 'seller' },
            items: [sellerRow],
            unread: 1,
          },
        }
    ));
    api.post
      .mockResolvedValueOnce({
        data: {
          ok: true,
          account: { userId: SELLER_A, role: 'seller' },
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          account: { userId: SELLER_A, role: 'seller', surface: 'seller' },
        },
      });

    const screen = render(<SellerNotificationsScreen navigation={{ navigate: jest.fn() }} />);
    await screen.findByText('Seller withdrawal paid');
    expect(api.get).toHaveBeenCalledWith('/api/notifications/me?surface=seller');

    fireEvent.press(screen.getByLabelText('Mark all notifications as read'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/api/notifications/read-all?surface=seller');
    await screen.findByText('Saved seller inbox items could not be marked as read. Please retry.');
    expect(screen.getByLabelText('Mark all notifications as read')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Mark all notifications as read'));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await screen.findByText('You are all caught up');
    expect(api.patch).not.toHaveBeenCalled();
  });

  test('surface-binds mark-one and rolls back a fulfilled response without seller account proof', async () => {
    const sellerRow = {
      _id: '64b000000000000000000010',
      user: SELLER_A,
      targetRole: 'seller',
      audience: 'specific',
      source: 'system',
      category: 'payment',
      title: 'Seller withdrawal paid',
      body: 'PKR 1,000.00 was paid.',
      linkTo: '/seller-dashboard/payments',
      eventKey: 'seller:withdrawal:paid:v1',
      eventType: 'withdrawal.status_changed',
      aggregateType: 'Withdrawal',
      aggregateId: 'withdrawal-1',
      createdAt: '2026-08-25T10:00:00.000Z',
      read: false,
    };
    api.get.mockImplementation((url) => Promise.resolve(
      url.includes('analytics')
        ? { data: { sellerId: SELLER_A, audienceRole: 'seller', notifications: [] } }
        : {
          data: {
            account: { userId: SELLER_A, role: 'seller', surface: 'seller' },
            items: [sellerRow],
            unread: 1,
          },
        }
    ));
    api.patch
      .mockResolvedValueOnce({
        data: {
          account: { userId: SELLER_A, role: 'seller' },
          notification: { ...sellerRow, read: true },
        },
      })
      .mockResolvedValueOnce({
        data: {
          account: { userId: SELLER_A, role: 'seller', surface: 'seller' },
          notification: { ...sellerRow, read: true },
        },
      });

    const screen = render(<SellerNotificationsScreen navigation={{ navigate: jest.fn() }} />);
    const unreadCard = await screen.findByLabelText(/^Unread\. Seller withdrawal paid/);
    fireEvent.press(unreadCard);
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenLastCalledWith(
      '/api/notifications/64b000000000000000000010/read?surface=seller'
    );
    await screen.findByText('The notification opened, but its read status could not be saved.');
    expect(screen.getByLabelText(/^Unread\. Seller withdrawal paid/)).toBeTruthy();

    fireEvent.press(screen.getByLabelText(/^Unread\. Seller withdrawal paid/));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByLabelText(/^Unread\. Seller withdrawal paid/)).toBeNull();
    });
  });
});
