const mockSecureGet = jest.fn();
const mockSecureSet = jest.fn();
const mockSecureDel = jest.fn();

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: {} },
}));

jest.mock('../../src/config/api', () => ({
  __esModule: true,
  API_BASE_URL: 'https://api.test',
  default: {
    delete: jest.fn(),
    post: jest.fn(),
  },
}));

jest.mock('../../src/utils/secureStorage', () => ({
  secureGet: (...args) => mockSecureGet(...args),
  secureSet: (...args) => mockSecureSet(...args),
  secureDel: (...args) => mockSecureDel(...args),
}));

import {
  clearAllNotifications,
  flushPendingPushTokenRevocations,
  getForegroundNotificationBehavior,
  preparePushTokenLogout,
  registerForPushNotifications,
  savePushTokenToServer,
  setActiveNotificationIdentity,
  unregisterPushTokenFromServer,
  waitForPushTokenRegistrations,
} from '../../src/services/notifications';

const mockApi = require('../../src/config/api').default;
const mockPublicAxios = require('axios');
const mockNotifications = require('expo-notifications');
const mockForegroundHandler = mockNotifications.setNotificationHandler.mock.calls[0][0].handleNotification;
const STATE_KEY = 'pushTokenRegistrationState.v2';
const CREDENTIAL = 'a'.repeat(43);
let secureValues;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(check, message = 'condition') {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

const writeState = ({ active = null, pending = [] } = {}) => {
  secureValues.set(STATE_KEY, JSON.stringify({ active, pending }));
};

const readState = () => JSON.parse(secureValues.get(STATE_KEY) || '{"active":null,"pending":[]}');

describe('notification runtime isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    secureValues = new Map();
    mockSecureGet.mockImplementation(async key => secureValues.get(key) ?? null);
    mockSecureSet.mockImplementation(async (key, value) => { secureValues.set(key, value); });
    mockSecureDel.mockImplementation(async key => { secureValues.delete(key); });
    mockApi.post.mockResolvedValue({ data: { registered: true } });
    mockApi.delete.mockResolvedValue({ data: { ok: true } });
    mockPublicAxios.post.mockResolvedValue({ data: { revoked: true } });
  });

  it('unregisters the locally stored Expo token using a bounded legacy request', async () => {
    secureValues.set('pushToken', 'ExpoPushToken[test-device]');
    await expect(unregisterPushTokenFromServer()).resolves.toBe(true);
    expect(mockApi.delete).toHaveBeenCalledWith('/api/user/push-token', {
      data: { pushToken: 'ExpoPushToken[test-device]' },
      skipAuthSessionCleanup: true,
      timeout: 1500,
    });
  });

  it('exposes transient Expo token acquisition failures for lifecycle retry', async () => {
    const previousProjectId = process.env.EXPO_PUBLIC_PROJECT_ID;
    process.env.EXPO_PUBLIC_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
    mockNotifications.getPermissionsAsync = jest.fn().mockResolvedValue({ status: 'granted' });
    mockNotifications.getExpoPushTokenAsync = jest.fn()
      .mockRejectedValueOnce(new Error('Expo token service unavailable'))
      .mockResolvedValueOnce({ data: 'ExpoPushToken[recovered]' });

    await expect(registerForPushNotifications())
      .rejects.toThrow('Expo token service unavailable');
    await expect(registerForPushNotifications())
      .resolves.toBe('ExpoPushToken[recovered]');

    if (previousProjectId === undefined) delete process.env.EXPO_PUBLIC_PROJECT_ID;
    else process.env.EXPO_PUBLIC_PROJECT_ID = previousProjectId;
  });

  it('stores and clears the identity used by the foreground handler', async () => {
    await setActiveNotificationIdentity({ _id: 'seller-1', role: 'seller' });
    expect(secureValues.get('activeNotificationRole')).toBe('seller');
    expect(secureValues.get('activeNotificationUserId')).toBe('seller-1');

    await setActiveNotificationIdentity(null);
    expect(secureValues.has('activeNotificationRole')).toBe(false);
    expect(secureValues.has('activeNotificationUserId')).toBe(false);
  });

  it('uses only native SecureStore-compatible keys during push registration', async () => {
    const user = { _id: 'seller-secure-store', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);

    await expect(savePushTokenToServer('ExpoPushToken[secure-store]', { user, generation }))
      .resolves.toBe(true);

    const touchedKeys = [mockSecureGet, mockSecureSet, mockSecureDel]
      .flatMap(mock => mock.mock.calls.map(call => call[0]));
    expect(touchedKeys.length).toBeGreaterThan(0);
    expect(touchedKeys).toEqual(expect.arrayContaining([STATE_KEY]));
    expect(touchedKeys.every(key => /^[A-Za-z0-9._-]+$/.test(key))).toBe(true);
  });

  it('repairs identity storage when rapid changes resolve in reverse order', async () => {
    const delayedWrites = [];
    mockSecureSet.mockImplementation((key, value) => {
      if (delayedWrites.length < 2 && key.startsWith('activeNotification')) {
        const gate = deferred();
        delayedWrites.push({ key, value, gate });
        return gate.promise.then(() => { secureValues.set(key, value); });
      }
      secureValues.set(key, value);
      return Promise.resolve();
    });

    const first = setActiveNotificationIdentity({ _id: 'seller-old', role: 'seller' });
    await waitFor(() => delayedWrites.length === 2, 'initial identity writes');
    const second = setActiveNotificationIdentity({ _id: 'buyer-new', role: 'user' });
    const logout = setActiveNotificationIdentity(null);
    delayedWrites.slice().reverse().forEach(item => item.gate.resolve());
    await Promise.all([first, second, logout]);

    expect(secureValues.has('activeNotificationRole')).toBe(false);
    expect(secureValues.has('activeNotificationUserId')).toBe(false);
  });

  it('uses the new in-memory identity while native identity persistence is pending', async () => {
    await setActiveNotificationIdentity({ _id: 'seller-old', role: 'seller' });
    const delayedWrites = [];
    mockSecureSet.mockImplementation((key, value) => {
      if (key.startsWith('activeNotification')) {
        const gate = deferred();
        delayedWrites.push({ key, value, gate });
        return gate.promise.then(() => { secureValues.set(key, value); });
      }
      secureValues.set(key, value);
      return Promise.resolve();
    });

    const switching = setActiveNotificationIdentity({ _id: 'seller-new', role: 'seller' });
    await waitFor(() => delayedWrites.length === 2, 'new identity persistence');
    const oldAccountPush = await mockForegroundHandler({
      request: { content: { data: {
        type: 'new_order_received',
        targetRole: 'seller',
        recipientUserId: 'seller-old',
      } } },
    });

    expect(oldAccountPush.shouldShowBanner).toBe(false);
    delayedWrites.forEach(item => item.gate.resolve());
    await switching;
  });

  it('rejects a token save from an identity invalidated before staging', async () => {
    const user = { _id: 'seller-1', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    await setActiveNotificationIdentity(null);

    await expect(savePushTokenToServer('ExpoPushToken[stale]', { user, generation }))
      .resolves.toBe(false);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('waits for the complete registration lifecycle, including deferred secure persistence', async () => {
    let stateWrites = 0;
    const completionWrite = deferred();
    mockSecureSet.mockImplementation((key, value) => {
      if (key === STATE_KEY) {
        stateWrites += 1;
        if (stateWrites === 2) {
          return completionWrite.promise.then(() => { secureValues.set(key, value); });
        }
      }
      secureValues.set(key, value);
      return Promise.resolve();
    });

    const user = { _id: 'seller-1', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    const save = savePushTokenToServer('ExpoPushToken[in-flight]', { user, generation });
    await waitFor(() => stateWrites === 2, 'post-response state persistence');

    let finished = false;
    const waiting = waitForPushTokenRegistrations().then(() => { finished = true; });
    await tick();
    expect(finished).toBe(false);

    completionWrite.resolve();
    await Promise.all([save, waiting]);
    expect(finished).toBe(true);
  });

  it('queues a registration that finishes after logout', async () => {
    const response = deferred();
    mockApi.post.mockReturnValueOnce(response.promise);
    mockPublicAxios.post.mockRejectedValueOnce({ response: { status: 503 } });
    const user = { _id: 'seller-late', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    const save = savePushTokenToServer('ExpoPushToken[late]', { user, generation });
    await waitFor(() => mockApi.post.mock.calls.length === 1, 'registration request');
    const sentCredential = mockApi.post.mock.calls[0][1].revocationCredential;

    await setActiveNotificationIdentity(null);
    response.resolve({ data: { registered: true } });
    await save;
    await tick();

    expect(readState().active).toBeNull();
    expect(readState().pending).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pushToken: 'ExpoPushToken[late]',
        revocationCredential: sentCredential,
      }),
    ]));
  });

  it('persists a client-generated credential before sending it to the server', async () => {
    const user = { _id: 'seller-1', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    await expect(savePushTokenToServer('ExpoPushToken[current]', { user, generation }))
      .resolves.toBe(true);

    const payload = mockApi.post.mock.calls[0][1];
    expect(payload.revocationCredential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readState().active).toMatchObject({
      pushToken: 'ExpoPushToken[current]',
      revocationCredential: payload.revocationCredential,
      accountIdentity: 'seller:seller-1',
    });
  });

  it('treats a malformed 200 registration response as an ambiguous failure', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { ok: true } });
    const user = { _id: 'seller-contract', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);

    await expect(savePushTokenToServer('ExpoPushToken[malformed]', { user, generation }))
      .resolves.toBe(false);
    expect(readState().active.revocationCredential)
      .toBe(mockApi.post.mock.calls[0][1].revocationCredential);
  });

  it('never sends registration when the crash-safe credential state cannot persist', async () => {
    mockSecureSet.mockImplementation(async (key, value) => {
      if (key === STATE_KEY) throw new Error('secure storage unavailable');
      secureValues.set(key, value);
    });
    const user = { _id: 'seller-storage', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);

    await expect(savePushTokenToServer('ExpoPushToken[no-state]', { user, generation }))
      .resolves.toBe(false);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('can revoke a committed registration even when its HTTP response is lost', async () => {
    mockApi.post.mockRejectedValueOnce(new Error('response connection dropped'));
    const user = { _id: 'seller-lost-response', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    await expect(savePushTokenToServer('ExpoPushToken[lost-response]', { user, generation }))
      .resolves.toBe(false);
    const committedCredential = mockApi.post.mock.calls[0][1].revocationCredential;
    expect(readState().active.revocationCredential).toBe(committedCredential);

    secureValues.set('pushToken', 'ExpoPushToken[lost-response]');
    mockPublicAxios.post.mockRejectedValueOnce({ response: { status: 503 } });
    await preparePushTokenLogout({ authToken: 'expired-session' });
    await tick();
    expect(readState().pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ revocationCredential: committedCredential }),
    ]));
    expect(mockPublicAxios.post).toHaveBeenCalledWith(
      'https://api.test/api/user/push-token/revoke',
      expect.objectContaining({ revocationCredential: committedCredential }),
      { timeout: 1500 }
    );
  });

  it('queues durable cleanup and returns without waiting for an offline network', async () => {
    const deleteRequest = deferred();
    const publicRequest = deferred();
    secureValues.set('pushToken', 'ExpoPushToken[offline]');
    writeState({ active: {
      pushToken: 'ExpoPushToken[offline]',
      revocationCredential: CREDENTIAL,
    } });
    mockApi.delete.mockReturnValue(deleteRequest.promise);
    mockPublicAxios.post.mockReturnValue(publicRequest.promise);

    await expect(preparePushTokenLogout({ authToken: 'session-token' }))
      .resolves.toEqual({ queued: true });
    expect(readState().active).toBeNull();
    expect(readState().pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ pushToken: 'ExpoPushToken[offline]' }),
    ]));

    deleteRequest.resolve({ data: { ok: true } });
    publicRequest.resolve({ data: { revoked: true } });
    await tick();
  });

  it('orders detached logout cleanup after an in-flight registration settles', async () => {
    const registration = deferred();
    mockApi.post.mockReturnValueOnce(registration.promise);
    secureValues.set('pushToken', 'ExpoPushToken[logout-race]');
    const user = { _id: 'seller-logout-race', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    const saving = savePushTokenToServer('ExpoPushToken[logout-race]', { user, generation });
    await waitFor(() => mockApi.post.mock.calls.length === 1, 'registration request');

    await setActiveNotificationIdentity(null);
    await expect(preparePushTokenLogout({ authToken: 'old-session-token' }))
      .resolves.toEqual({ queued: true });
    await tick();
    expect(mockApi.delete).not.toHaveBeenCalled();
    expect(mockPublicAxios.post).not.toHaveBeenCalled();

    registration.resolve({ data: { registered: true } });
    await saving;
    await waitFor(
      () => mockApi.delete.mock.calls.length === 1 && mockPublicAxios.post.mock.calls.length >= 1,
      'post-registration logout cleanup'
    );

    expect(mockApi.delete).toHaveBeenCalledWith('/api/user/push-token', expect.objectContaining({
      data: { pushToken: 'ExpoPushToken[logout-race]' },
      headers: { Authorization: 'Bearer old-session-token' },
      skipAuthSessionCleanup: true,
    }));
    expect(readState().active).toBeNull();
  });

  it('retains pending cleanup on temporary failure and rolling-deployment 404', async () => {
    const entry = { pushToken: 'ExpoPushToken[retry]', revocationCredential: CREDENTIAL };
    for (const status of [503, 404]) {
      writeState({ pending: [entry] });
      mockPublicAxios.post.mockRejectedValueOnce({ response: { status } });
      await expect(flushPendingPushTokenRevocations({ timeoutMs: 25 })).resolves.toEqual({
        revoked: 0,
        retained: 1,
      });
      expect(readState().pending).toEqual([entry]);
    }
  });

  it('honors Retry-After while retaining a rate-limited cleanup ticket', async () => {
    writeState({ pending: [{
      pushToken: 'ExpoPushToken[rate-limited]',
      revocationCredential: CREDENTIAL,
    }] });
    mockPublicAxios.post.mockRejectedValueOnce({
      response: { status: 429, headers: { 'retry-after': '7' } },
    });
    await expect(flushPendingPushTokenRevocations()).resolves.toEqual({
      revoked: 0,
      retained: 1,
      retryAfterMs: 7000,
    });
    expect(readState().pending).toHaveLength(1);
  });

  it('drains a ticket enqueued while another revocation flush is in flight', async () => {
    const firstRequest = deferred();
    const first = { pushToken: 'ExpoPushToken[first]', revocationCredential: CREDENTIAL };
    const second = { pushToken: 'ExpoPushToken[second]', revocationCredential: 'b'.repeat(43) };
    secureValues.set('pushToken', second.pushToken);
    writeState({ active: second, pending: [first] });
    mockPublicAxios.post
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValue({ data: { revoked: true } });

    const flushing = flushPendingPushTokenRevocations();
    await waitFor(() => mockPublicAxios.post.mock.calls.length === 1, 'first revocation request');
    await preparePushTokenLogout({ authToken: 'session-token' });
    firstRequest.resolve({ data: { revoked: true } });
    await flushing;

    expect(mockPublicAxios.post.mock.calls.map(call => call[1].pushToken))
      .toEqual(expect.arrayContaining([first.pushToken, second.pushToken]));
    expect(secureValues.has(STATE_KEY)).toBe(false);
  });

  it('removes a pending cleanup after a successful retry', async () => {
    writeState({ pending: [{
      pushToken: 'ExpoPushToken[retry]',
      revocationCredential: CREDENTIAL,
    }] });
    await expect(flushPendingPushTokenRevocations()).resolves.toEqual({
      revoked: 1,
      retained: 0,
    });
    expect(secureValues.has(STATE_KEY)).toBe(false);
  });

  it('discards a rotated credential without clearing the new account session', async () => {
    secureValues.set('jwtToken', 'new-account-session');
    secureValues.set('currentUser', JSON.stringify({ _id: 'new-account' }));
    writeState({ pending: [{
      pushToken: 'ExpoPushToken[transferred]',
      revocationCredential: CREDENTIAL,
    }] });
    mockPublicAxios.post.mockRejectedValueOnce({ response: { status: 401 } });

    await expect(flushPendingPushTokenRevocations()).resolves.toEqual({
      revoked: 0,
      retained: 0,
    });
    expect(secureValues.has(STATE_KEY)).toBe(false);
    expect(secureValues.get('jwtToken')).toBe('new-account-session');
    expect(secureValues.get('currentUser')).toBe(JSON.stringify({ _id: 'new-account' }));
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('preserves both old and new token credentials across T1 to T2 and offline logout', async () => {
    const user = { _id: 'seller-rotation', role: 'seller' };
    const generation = await setActiveNotificationIdentity(user);
    await savePushTokenToServer('ExpoPushToken[T1]', { user, generation });
    const t1Credential = readState().active.revocationCredential;

    mockPublicAxios.post.mockRejectedValue({ response: { status: 503 } });
    await savePushTokenToServer('ExpoPushToken[T2]', { user, generation });
    await tick();
    const t2Credential = readState().active.revocationCredential;
    expect(t2Credential).not.toBe(t1Credential);
    expect(readState().pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ pushToken: 'ExpoPushToken[T1]', revocationCredential: t1Credential }),
    ]));

    secureValues.set('pushToken', 'ExpoPushToken[T2]');
    await preparePushTokenLogout({ authToken: 'session-token' });
    await tick();
    expect(readState().active).toBeNull();
    expect(readState().pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ pushToken: 'ExpoPushToken[T1]', revocationCredential: t1Credential }),
      expect.objectContaining({ pushToken: 'ExpoPushToken[T2]', revocationCredential: t2Credential }),
    ]));
  });

  it('attempts tray, scheduled-notification, and badge cleanup independently', async () => {
    mockNotifications.dismissAllNotificationsAsync.mockRejectedValueOnce(new Error('tray unavailable'));
    await expect(clearAllNotifications()).resolves.toBeUndefined();
    expect(mockNotifications.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(mockNotifications.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(mockNotifications.setBadgeCountAsync).toHaveBeenCalledWith(0);
  });

  it('suppresses seller alerts for buyers and cross-account pushes', () => {
    const sellerAlert = getForegroundNotificationBehavior({
      request: { content: { data: { type: 'new_order_received' } } },
    }, 'user', 'buyer-1');
    const wrongAccount = getForegroundNotificationBehavior({
      request: { content: { data: { type: 'order_shipped', recipientUserId: 'buyer-old' } } },
    }, 'user', 'buyer-current');
    expect(sellerAlert.shouldShowBanner).toBe(false);
    expect(wrongAccount.shouldShowBanner).toBe(false);
  });

  it('allows buyer order alerts for a seller who is also shopping', () => {
    const result = getForegroundNotificationBehavior({
      request: { content: { data: { type: 'order_shipped' } } },
    }, 'seller', 'seller-1');
    expect(result.shouldShowBanner).toBe(true);
    expect(result.shouldSetBadge).toBe(true);
  });
});
