import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import useNotificationInbox from '../../src/hooks/useNotificationInbox';
import api from '../../src/config/api';
import { getNotificationStorageKeys } from '../../src/utils/notificationScope';

let mockReceivedListener = null;

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn(), post: jest.fn() },
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
  _id: `64b00000000000000000001${user._id.endsWith('1') ? '0' : '1'}`,
  user: user._id,
  title: `Receipt for ${user._id}`,
  body: 'PKR 500.00 was credited.',
  category: 'payment',
  linkTo: '/user-dashboard/wallet',
  source: 'system',
  targetRole: 'user',
  audience: 'specific',
  read: false,
  eventKey: `wallet:credit:${user._id}:v1`,
  eventType: 'wallet.transaction_completed',
  aggregateType: 'WalletTransaction',
  aggregateId: `transaction-${user._id}`,
  createdAt: '2026-08-25T10:00:00.000Z',
  ...overrides,
});

const inboxResponse = (user, overrides = {}) => ({
  data: {
    account: { userId: user._id, role: user.role },
    items: [notificationRow(user)],
    unread: 1,
    ...overrides,
  },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

let latestInbox;
const Probe = ({ currentUser }) => {
  latestInbox = useNotificationInbox({ currentUser, onCountChange: jest.fn() });
  return null;
};

const flushPromises = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe('useNotificationInbox durable lifecycle', () => {
  let root;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockReceivedListener = null;
    latestInbox = null;
    await AsyncStorage.clear();
    api.get.mockImplementation((url) => Promise.resolve(
      url === '/api/order/user-orders' ? { data: { orders: [] } } : inboxResponse(USER_A)
    ));
    api.patch.mockReset();
    api.post.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = null;
    }
  });

  test('dedupes a foreground financial event against state and AsyncStorage', async () => {
    await act(async () => {
      root = TestRenderer.create(<Probe currentUser={USER_A} />);
      await flushPromises();
    });
    expect(latestInbox.notifications).toHaveLength(1);
    expect(mockReceivedListener).toEqual(expect.any(Function));

    const push = {
      request: {
        identifier: 'provider-ticket',
        content: {
          title: 'Push receipt',
          body: 'PKR 500.00 was credited.',
          data: {
            notificationEventKey: `wallet:credit:${USER_A._id}:v1`,
            recipientUserId: USER_A._id,
            targetRole: 'user',
            category: 'payment',
            type: 'wallet_transaction_completed',
          },
        },
      },
    };
    await act(async () => {
      await mockReceivedListener(push);
      await mockReceivedListener(push);
      await flushPromises();
    });

    expect(latestInbox.notifications).toHaveLength(1);
    expect(latestInbox.notifications[0].title).toContain('Receipt for');
    const stored = JSON.parse(await AsyncStorage.getItem(getNotificationStorageKeys(USER_A).inbox));
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(`event:wallet:credit:${USER_A._id}:v1`);
  });

  test('PATCHes persistent reads and rolls back a failed or unverified transition', async () => {
    await act(async () => {
      root = TestRenderer.create(<Probe currentUser={USER_A} />);
      await flushPromises();
    });
    const inboxId = latestInbox.notifications[0].id;

    api.patch.mockRejectedValueOnce(new Error('offline'));
    let result;
    await act(async () => {
      result = await latestInbox.markRead(inboxId);
      await flushPromises();
    });
    expect(result).toBe(false);
    expect(latestInbox.notifications[0].read).toBe(false);
    expect(latestInbox.actionError).toMatch(/could not/i);

    api.patch.mockResolvedValueOnce({
      data: {
        account: { userId: USER_B._id, role: USER_B.role },
        notification: notificationRow(USER_A, { read: true }),
      },
    });
    await act(async () => {
      result = await latestInbox.markRead(inboxId);
      await flushPromises();
    });
    expect(result).toBe(false);
    expect(latestInbox.notifications[0].read).toBe(false);

    api.patch.mockResolvedValueOnce({
      data: {
        account: { userId: USER_A._id, role: USER_A.role },
        notification: notificationRow(USER_A, { read: true }),
      },
    });
    await act(async () => {
      result = await latestInbox.markRead(inboxId);
      await flushPromises();
    });
    expect(result).toBe(true);
    expect(api.patch).toHaveBeenLastCalledWith(
      `/api/notifications/${notificationRow(USER_A)._id}/read`
    );
    expect(latestInbox.notifications[0].read).toBe(true);
  });

  test('POSTs read-all, rolls back on failure, and ignores a late prior-account fetch', async () => {
    await act(async () => {
      root = TestRenderer.create(<Probe currentUser={USER_A} />);
      await flushPromises();
    });
    api.post.mockResolvedValueOnce({
      data: { ok: true, account: { userId: USER_B._id, role: USER_B.role } },
    });
    await act(async () => {
      expect(await latestInbox.markAllRead()).toBe(false);
      await flushPromises();
    });
    expect(latestInbox.notifications[0].read).toBe(false);

    api.post.mockResolvedValueOnce({
      data: { ok: true, account: { userId: USER_A._id, role: USER_A.role } },
    });
    await act(async () => {
      expect(await latestInbox.markAllRead()).toBe(true);
      await flushPromises();
    });
    expect(api.post).toHaveBeenLastCalledWith('/api/notifications/read-all');
    expect(latestInbox.notifications[0].read).toBe(true);

    const lateUserA = deferred();
    let inboxCalls = 0;
    api.get.mockImplementation((url) => {
      if (url === '/api/order/user-orders') return Promise.resolve({ data: { orders: [] } });
      inboxCalls += 1;
      return inboxCalls === 1 ? lateUserA.promise : Promise.resolve(inboxResponse(USER_B));
    });
    let lateFetchPromise;
    await act(async () => {
      root.update(<Probe currentUser={USER_A} />);
      lateFetchPromise = latestInbox.fetchNotifications();
      await flushPromises();
    });
    expect(inboxCalls).toBe(1);
    await act(async () => {
      root.update(<Probe currentUser={USER_B} />);
      await flushPromises();
    });
    expect(latestInbox.notifications[0].title).toContain(USER_B._id);

    await act(async () => {
      lateUserA.resolve(inboxResponse(USER_A));
      await lateUserA.promise;
      await lateFetchPromise;
      await flushPromises();
    });
    expect(latestInbox.notifications[0].title).toContain(USER_B._id);
  });
});
