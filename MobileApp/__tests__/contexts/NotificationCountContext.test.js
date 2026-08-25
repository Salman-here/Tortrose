import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NotificationCountProvider,
  useNotificationCount,
} from '../../src/contexts/NotificationCountContext';
import api from '../../src/config/api';
import { getNotificationStorageKeys } from '../../src/utils/notificationScope';

let mockCurrentUser = null;
let mockReceivedListener = null;

jest.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: mockCurrentUser }),
}));

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('../../src/utils/notificationRuntime', () => ({
  getNotificationsModule: () => ({
    addNotificationReceivedListener: jest.fn((listener) => {
      mockReceivedListener = listener;
      return { remove: jest.fn() };
    }),
  }),
}));

const USER_A = { _id: '64b000000000000000000001', role: 'user' };
const USER_B = { _id: '64b000000000000000000002', role: 'user' };

const notificationRow = (user, overrides = {}) => ({
  _id: `64b00000000000000000002${user._id.endsWith('1') ? '0' : '1'}`,
  user: user._id,
  title: 'Payment receipt',
  body: 'PKR 500.00 was received.',
  category: 'payment',
  linkTo: '/user-dashboard/wallet',
  source: 'system',
  targetRole: 'user',
  audience: 'specific',
  read: false,
  eventKey: `payment:${user._id}:v1`,
  eventType: 'wallet.transaction_completed',
  aggregateType: 'WalletTransaction',
  aggregateId: `transaction-${user._id}`,
  createdAt: '2026-08-25T10:00:00.000Z',
  ...overrides,
});

const inboxResponse = (user, { unread = 1, items = [notificationRow(user)] } = {}) => ({
  data: {
    account: { userId: user._id, role: user.role },
    items,
    unread,
  },
});

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

let latestCount;
const Probe = () => {
  latestCount = useNotificationCount();
  return null;
};

const App = () => (
  <NotificationCountProvider>
    <Probe />
  </NotificationCountProvider>
);

const flushPromises = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('NotificationCountContext durable reconciliation', () => {
  let root;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCurrentUser = USER_A;
    mockReceivedListener = null;
    latestCount = null;
    await AsyncStorage.clear();
    api.get.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = null;
    }
  });

  test('uses authoritative unread plus unique local-only pushes and reconciles foreground events', async () => {
    const keys = getNotificationStorageKeys(USER_A);
    await AsyncStorage.setItem(keys.inbox, JSON.stringify([{
      id: 'provider-duplicate',
      read: false,
      category: 'payment',
      data: {
        notificationEventKey: `payment:${USER_A._id}:v1`,
        recipientUserId: USER_A._id,
        targetRole: 'user',
      },
    }, {
      id: 'local-only',
      read: false,
      category: 'promo',
      data: { recipientUserId: USER_A._id, targetRole: 'user' },
    }]));
    await AsyncStorage.setItem(keys.read, '[]');
    api.get.mockResolvedValueOnce(inboxResponse(USER_A, { unread: 3 }));

    await act(async () => {
      root = TestRenderer.create(<App />);
      await flushPromises();
    });
    expect(latestCount.unreadNotifCount).toBe(4);
    expect(mockReceivedListener).toEqual(expect.any(Function));

    await act(async () => {
      mockReceivedListener({
        request: {
          identifier: 'duplicate-provider-id',
          content: { data: {
            notificationEventKey: `payment:${USER_A._id}:v1`,
            recipientUserId: USER_A._id,
            targetRole: 'user',
            category: 'payment',
          } },
        },
      });
      await flushPromises();
    });
    expect(latestCount.unreadNotifCount).toBe(4);
    expect(api.get).toHaveBeenCalledTimes(1);

    api.get.mockResolvedValueOnce(inboxResponse(USER_A, { unread: 4 }));
    await act(async () => {
      mockReceivedListener({
        request: {
          identifier: 'new-provider-id',
          content: { data: {
            notificationEventKey: `payment:${USER_A._id}:second:v1`,
            recipientUserId: USER_A._id,
            targetRole: 'user',
            category: 'payment',
          } },
        },
      });
      await flushPromises();
    });
    expect(latestCount.unreadNotifCount).toBe(5);
  });

  test('fails closed on malformed snapshots and ignores a late prior-account response', async () => {
    api.get.mockResolvedValueOnce(inboxResponse(USER_A, {
      unread: 1.5,
    }));
    await act(async () => {
      root = TestRenderer.create(<App />);
      await flushPromises();
    });
    expect(latestCount.unreadNotifCount).toBe(0);

    const lateA = deferred();
    api.get.mockReset();
    api.get
      .mockImplementationOnce(() => lateA.promise)
      .mockImplementationOnce(() => Promise.resolve(inboxResponse(USER_B, { unread: 7 })));
    let lateRefresh;
    await act(async () => {
      lateRefresh = latestCount.refreshUnreadCount();
      await flushPromises();
    });
    mockCurrentUser = USER_B;
    await act(async () => {
      root.update(<App />);
      await flushPromises();
    });
    expect(latestCount.unreadNotifCount).toBe(7);

    await act(async () => {
      lateA.resolve(inboxResponse(USER_A, { unread: 99 }));
      await lateRefresh;
      await flushPromises();
    });
    expect(latestCount.unreadNotifCount).toBe(7);
  });
});
