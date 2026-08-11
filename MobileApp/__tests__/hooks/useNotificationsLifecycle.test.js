import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import useNotifications from '../../src/hooks/useNotifications';

const mockFlushRevocations = jest.fn();
const mockGetStagedToken = jest.fn();
const mockRegisterToken = jest.fn();
const mockSaveToken = jest.fn();
const mockSetIdentity = jest.fn();
const mockWaitRegistrations = jest.fn();
let mockCurrentUser = null;

jest.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ currentUser: mockCurrentUser }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

jest.mock('../../src/services/notifications', () => ({
  flushPendingPushTokenRevocations: (...args) => mockFlushRevocations(...args),
  getStagedPushTokenForIdentity: (...args) => mockGetStagedToken(...args),
  registerForPushNotifications: (...args) => mockRegisterToken(...args),
  savePushTokenToServer: (...args) => mockSaveToken(...args),
  setActiveNotificationIdentity: (...args) => mockSetIdentity(...args),
  waitForPushTokenRegistrations: (...args) => mockWaitRegistrations(...args),
  NotificationTypes: {},
}));

const mockNotificationSubscriptions = [];
jest.mock('../../src/utils/notificationRuntime', () => ({
  getNotificationsModule: () => ({
    addNotificationReceivedListener: jest.fn(() => {
      const subscription = { remove: jest.fn() };
      mockNotificationSubscriptions.push(subscription);
      return subscription;
    }),
    addNotificationResponseReceivedListener: jest.fn(() => {
      const subscription = { remove: jest.fn() };
      mockNotificationSubscriptions.push(subscription);
      return subscription;
    }),
    addPushTokenListener: jest.fn(() => {
      const subscription = { remove: jest.fn() };
      mockNotificationSubscriptions.push(subscription);
      return subscription;
    }),
  }),
}));

const Probe = () => {
  useNotifications();
  return null;
};

const flushPromises = async () => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

describe('useNotifications durable maintenance lifecycle', () => {
  let root;
  let networkListener;
  let appStateListener;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockNotificationSubscriptions.length = 0;
    mockCurrentUser = null;
    mockSetIdentity.mockResolvedValue(1);
    mockWaitRegistrations.mockResolvedValue(undefined);
    mockFlushRevocations.mockResolvedValue({ revoked: 0, retained: 0 });
    mockGetStagedToken.mockResolvedValue(null);
    mockRegisterToken.mockResolvedValue(null);
    mockSaveToken.mockResolvedValue(true);
    NetInfo.addEventListener.mockImplementation((listener) => {
      networkListener = listener;
      return jest.fn();
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
      appStateListener = listener;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
      root = null;
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('drains guest logout tickets at startup and retries a transient 503 without another event', async () => {
    mockFlushRevocations
      .mockResolvedValueOnce({ revoked: 0, retained: 1 })
      .mockResolvedValueOnce({ revoked: 1, retained: 0 });

    await act(async () => {
      root = TestRenderer.create(<Probe />);
      await flushPromises();
    });
    expect(mockFlushRevocations).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await flushPromises();
    });
    expect(mockFlushRevocations).toHaveBeenCalledTimes(2);

    await act(async () => {
      networkListener({ isConnected: true, isInternetReachable: true });
      appStateListener('active');
      await flushPromises();
    });
    expect(mockFlushRevocations.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('re-posts the same staged token after an offline registration failure', async () => {
    mockCurrentUser = { _id: 'seller-1', role: 'seller' };
    mockGetStagedToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('ExpoPushToken[offline-staged]');
    mockRegisterToken.mockResolvedValueOnce('ExpoPushToken[offline-staged]');
    mockSaveToken
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await act(async () => {
      root = TestRenderer.create(<Probe />);
      await flushPromises();
    });
    expect(mockSaveToken).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await flushPromises();
    });
    expect(mockSaveToken).toHaveBeenCalledTimes(2);
    expect(mockSaveToken.mock.calls[1][0]).toBe('ExpoPushToken[offline-staged]');
    expect(mockRegisterToken).toHaveBeenCalledTimes(1);
  });

  it('uses the server Retry-After delay instead of retrying too early', async () => {
    mockFlushRevocations
      .mockResolvedValueOnce({ revoked: 0, retained: 1, retryAfterMs: 7000 })
      .mockResolvedValueOnce({ revoked: 1, retained: 0 });

    await act(async () => {
      root = TestRenderer.create(<Probe />);
      await flushPromises();
    });
    await act(async () => {
      jest.advanceTimersByTime(6999);
      await flushPromises();
    });
    expect(mockFlushRevocations).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      await flushPromises();
    });
    expect(mockFlushRevocations).toHaveBeenCalledTimes(2);
  });

  it('recovers when the native notification permission call rejects', async () => {
    mockCurrentUser = { _id: 'seller-native-retry', role: 'seller' };
    mockRegisterToken
      .mockRejectedValueOnce(new Error('native notification service unavailable'))
      .mockResolvedValueOnce('ExpoPushToken[native-retry]');

    await act(async () => {
      root = TestRenderer.create(<Probe />);
      await flushPromises();
    });
    expect(mockRegisterToken).toHaveBeenCalledTimes(1);
    expect(mockSaveToken).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await flushPromises();
    });
    expect(mockRegisterToken).toHaveBeenCalledTimes(2);
    expect(mockSaveToken).toHaveBeenCalledWith(
      'ExpoPushToken[native-retry]',
      expect.objectContaining({ user: mockCurrentUser })
    );
  });
});
