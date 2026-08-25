/**
 * Push Notification Service
 * Handles registration, permissions, token management, and local notifications.
 * Uses expo-notifications.
 */

import Constants from 'expo-constants';
import axios from 'axios';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import api, { API_BASE_URL } from '../config/api';
import { getNotificationsModule } from '../utils/notificationRuntime';
import { secureDel, secureGet, secureSet } from '../utils/secureStorage';
import {
  isNotificationAllowedForRole,
  normalizeNotificationRole,
} from '../utils/notificationScope';

const Notifications = getNotificationsModule();
const ACTIVE_NOTIFICATION_ROLE_KEY = 'activeNotificationRole';
const ACTIVE_NOTIFICATION_USER_KEY = 'activeNotificationUserId';
const PUSH_REGISTRATION_STATE_KEY = 'pushTokenRegistrationState:v2';
const LEGACY_ACTIVE_PUSH_REGISTRATION_KEY = 'activePushTokenRegistration:v1';
const LEGACY_PENDING_PUSH_REVOCATIONS_KEY = 'pendingPushTokenRevocations:v1';
const REVOCATION_CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;
let activeNotificationGeneration = 0;
let activeNotificationRole = 'guest';
let activeNotificationUserId = null;
const inFlightPushTokenSaves = new Set();
let identityPersistence = Promise.resolve();
let pushRegistrationStateMutation = Promise.resolve();
let pendingRevocationFlush = null;
let pendingRevocationRerunRequested = false;

const parseStoredJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
};

const validRevocationEntry = (entry) => Boolean(
  entry
  && typeof entry.pushToken === 'string'
  && entry.pushToken.trim()
  && REVOCATION_CREDENTIAL_RE.test(String(entry.revocationCredential || ''))
);

const normalizeRegistrationState = (value = {}) => ({
  active: validRevocationEntry(value?.active) ? value.active : null,
  pending: (Array.isArray(value?.pending) ? value.pending : [])
    .filter(validRevocationEntry)
    .slice(-8),
});

async function readPushRegistrationState() {
  const raw = await secureGet(PUSH_REGISTRATION_STATE_KEY).catch(() => null);
  if (raw) return normalizeRegistrationState(parseStoredJson(raw, {}));

  // One-time migration for local development builds that used the initial
  // two-key implementation before this atomic state contract landed.
  const [legacyActiveRaw, legacyPendingRaw] = await Promise.all([
    secureGet(LEGACY_ACTIVE_PUSH_REGISTRATION_KEY).catch(() => null),
    secureGet(LEGACY_PENDING_PUSH_REVOCATIONS_KEY).catch(() => null),
  ]);
  return normalizeRegistrationState({
    active: parseStoredJson(legacyActiveRaw, null),
    pending: parseStoredJson(legacyPendingRaw, []),
  });
}

const mutatePushRegistrationState = (operation) => {
  const next = pushRegistrationStateMutation
    .catch(() => {})
    .then(async () => {
      const current = await readPushRegistrationState();
      const normalized = normalizeRegistrationState(await operation(current) || current);
      if (normalized.active || normalized.pending.length) {
        await secureSet(PUSH_REGISTRATION_STATE_KEY, JSON.stringify(normalized));
      } else {
        await secureDel(PUSH_REGISTRATION_STATE_KEY).catch(() => {});
      }
      await Promise.all([
        secureDel(LEGACY_ACTIVE_PUSH_REGISTRATION_KEY).catch(() => {}),
        secureDel(LEGACY_PENDING_PUSH_REVOCATIONS_KEY).catch(() => {}),
      ]);
      return normalized;
    });
  pushRegistrationStateMutation = next.catch(() => {});
  return next;
};

async function removePendingRevocation(entry) {
  await mutatePushRegistrationState(current => ({
    ...current,
    pending: current.pending.filter(item => !(
      item.pushToken === entry.pushToken
      && item.revocationCredential === entry.revocationCredential
    )),
  }));
}

const base64UrlEncode = (bytes) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    encoded += alphabet[(combined >> 18) & 63];
    encoded += alphabet[(combined >> 12) & 63];
    if (index + 1 < bytes.length) encoded += alphabet[(combined >> 6) & 63];
    if (index + 2 < bytes.length) encoded += alphabet[combined & 63];
  }
  return encoded;
};

export async function createPushRevocationCredential() {
  const bytes = await Crypto.getRandomBytesAsync(32);
  const credential = base64UrlEncode(bytes);
  if (!REVOCATION_CREDENTIAL_RE.test(credential)) {
    throw new Error('Unable to create a secure push-token revocation credential.');
  }
  return credential;
}

const hiddenNotificationBehavior = {
  shouldShowAlert: false,
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export function getForegroundNotificationBehavior(notification, activeRole, activeUserId) {
  if (!activeRole || !activeUserId) return hiddenNotificationBehavior;
  const data = notification?.request?.content?.data || {};
  if (!isNotificationAllowedForRole(
    { data, category: data.category },
    { _id: activeUserId, role: activeRole }
  )) {
    return hiddenNotificationBehavior;
  }
  return {
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  };
}

// ─── Configure how notifications appear when app is in foreground ────────────
if (Notifications?.setNotificationHandler) {
  Notifications.setNotificationHandler({
    // The in-memory identity changes synchronously before native persistence.
    // Using it closes the A -> B/logout window where old SecureStore values can
    // remain visible while their asynchronous replacement is still pending.
    // A cold process starts as guest and therefore suppresses safely until
    // AuthContext hydrates and calls setActiveNotificationIdentity.
    handleNotification: async (notification) => getForegroundNotificationBehavior(
      notification,
      activeNotificationRole,
      activeNotificationUserId
    ),
  });
}

export async function setActiveNotificationIdentity(user) {
  const role = normalizeNotificationRole(user);
  const userId = user?._id || user?.id;
  activeNotificationGeneration += 1;
  activeNotificationRole = role;
  activeNotificationUserId = userId ? String(userId) : null;
  const generation = activeNotificationGeneration;

  // Persist serially and repair if another account change happens while native
  // secure storage is still resolving. The foreground handler can therefore
  // never be left with an older account after rapid A -> B -> logout changes.
  const persistLatestIdentity = async () => {
    while (true) {
      const snapshotGeneration = activeNotificationGeneration;
      const snapshotRole = activeNotificationRole;
      const snapshotUserId = activeNotificationUserId;
      if (snapshotRole === 'guest' || !snapshotUserId) {
        await Promise.all([
          secureDel(ACTIVE_NOTIFICATION_ROLE_KEY),
          secureDel(ACTIVE_NOTIFICATION_USER_KEY),
        ]);
      } else {
        await Promise.all([
          secureSet(ACTIVE_NOTIFICATION_ROLE_KEY, snapshotRole),
          secureSet(ACTIVE_NOTIFICATION_USER_KEY, snapshotUserId),
        ]);
      }
      if (snapshotGeneration === activeNotificationGeneration) return;
    }
  };

  identityPersistence = identityPersistence
    .catch(() => {})
    .then(persistLatestIdentity);
  await identityPersistence.catch(() => {});
  return generation;
}

// ─── Channel (Android) ──────────────────────────────────────────────────────
async function createChannels() {
  if (Platform.OS === 'android' && Notifications) {
    await Notifications.setNotificationChannelAsync('orders', {
      name: 'Order Updates',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    });
    await Notifications.setNotificationChannelAsync('seller', {
      name: 'Seller Alerts',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('promotions', {
      name: 'Promotions & Deals',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    await Notifications.setNotificationChannelAsync('general', {
      name: 'General',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

// ─── Request permission & get push token ─────────────────────────────────────
export async function registerForPushNotifications() {
  if (!Notifications) return null;
  await createChannels();

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Push notification permission not granted');
    return null;
  }

  try {
    const projectId =
      process.env.EXPO_PUBLIC_PROJECT_ID ||
      Constants.expoConfig?.extra?.eas?.projectId ||
      Constants.easConfig?.projectId;
    // Skip remote push-token fetch if no valid EAS projectId is configured
    // (e.g. when running in Expo Go during development without an EAS project).
    // Expo's server requires a real UUID; a missing/placeholder value throws a 400.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!projectId || !UUID_RE.test(projectId)) {
      console.log('Skipping push token fetch: no valid EAS project ID is configured.');
      return null;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    // Save locally
    await secureSet('pushToken', token);

    return token;
  } catch (err) {
    console.log('Error getting push token:', err?.message || err);
    // Permission denial and a missing project ID return null above because
    // they are terminal configuration states. Reaching this catch means the
    // native/Expo token acquisition itself failed and can recover, so let the
    // lifecycle scheduler apply its bounded retry policy.
    throw err;
  }
}

// ─── Send push token to backend so it can send server-side pushes ────────────
export function savePushTokenToServer(token, registration = {}) {
  const lifecycle = (async () => {
    if (!token) return false;

    const expectedUserId = registration.user?._id || registration.user?.id;
    const expectedRole = normalizeNotificationRole(registration.user);
    const identityIsCurrent = () => (
      registration.generation === activeNotificationGeneration
      && Boolean(expectedUserId)
      && String(expectedUserId) === activeNotificationUserId
      && expectedRole === activeNotificationRole
    );
    if (!identityIsCurrent()) return false;

    try {
      const accountIdentity = `${expectedRole}:${String(expectedUserId)}`;
      await pushRegistrationStateMutation.catch(() => {});
      const currentState = await readPushRegistrationState();
      let candidate = currentState.active;
      const canReuseCandidate = validRevocationEntry(candidate)
        && candidate.pushToken === token
        && candidate.accountIdentity === accountIdentity;

      if (canReuseCandidate && candidate.acknowledged === true) return true;

      if (!canReuseCandidate) {
        // The client creates and durably stores the credential before POST. If
        // the server commits but the response is lost, logout still possesses
        // the exact authority needed to revoke that ambiguous registration.
        const revocationCredential = await createPushRevocationCredential();
        if (!identityIsCurrent()) return false;
        candidate = {
          pushToken: token,
          revocationCredential,
          accountIdentity,
          acknowledged: false,
        };

        await mutatePushRegistrationState((current) => ({
          active: candidate,
          pending: current.active && validRevocationEntry(current.active)
            ? [...current.pending, current.active]
            : current.pending,
        }));
      }

      if (!identityIsCurrent()) {
        await mutatePushRegistrationState(current => ({
          active: current.active?.revocationCredential === candidate.revocationCredential
            ? null
            : current.active,
          pending: [...current.pending, candidate],
        }));
        return false;
      }

      const response = await api.post('/api/user/push-token', {
        pushToken: token,
        revocationCredential: candidate.revocationCredential,
      });
      const legacyCredential = response?.data?.revocationCredential;
      const acknowledged = response?.data?.registered === true
        || REVOCATION_CREDENTIAL_RE.test(String(legacyCredential || ''));
      if (!acknowledged) {
        // Keep the pre-persisted candidate intact. A malformed 200 is treated
        // as an ambiguous commit and can still be revoked during logout/retry.
        return false;
      }

      const effective = {
        ...candidate,
        acknowledged: true,
        revocationCredential: REVOCATION_CREDENTIAL_RE.test(String(legacyCredential || ''))
          ? legacyCredential
          : candidate.revocationCredential,
      };
      const stillActive = identityIsCurrent();
      await mutatePushRegistrationState((current) => {
        const candidateIsActive = current.active?.revocationCredential === candidate.revocationCredential;
        if (stillActive) {
          return {
            active: candidateIsActive ? effective : current.active,
            // The successful registration rotated credentials for this exact
            // token. Superseded credentials for it are now terminally invalid;
            // pending entries for any older Expo token remain for revocation.
            pending: current.pending.filter(item => item.pushToken !== token),
          };
        }
        return {
          active: candidateIsActive ? null : current.active,
          pending: [...current.pending, effective],
        };
      });

      // Revoke superseded tokens (T1 -> T2) and late registrations. This call
      // is durable and single-flight; failures remain queued for reconnect.
      flushPendingPushTokenRevocations().catch(() => {});
      return stillActive;
    } catch (err) {
      console.log('Failed to save push token to server:', err?.message || 'registration failed');
      return false;
    }
  })();

  // Track the entire lifecycle, including secure-state persistence, rather
  // than only the Axios promise. Account switching can safely await this once
  // without a settled-promise busy loop starving native storage callbacks.
  inFlightPushTokenSaves.add(lifecycle);
  lifecycle.then(
    () => inFlightPushTokenSaves.delete(lifecycle),
    () => inFlightPushTokenSaves.delete(lifecycle)
  );
  return lifecycle;
}

// Logout invalidates the active generation first, then waits for any request
// that already crossed the generation gate. This guarantees the subsequent
// DELETE is the final server-side write for the old account.
export async function waitForPushTokenRegistrations() {
  const pending = Array.from(inFlightPushTokenSaves);
  if (pending.length) await Promise.allSettled(pending);
}

export async function getStagedPushTokenForIdentity(user) {
  const role = normalizeNotificationRole(user);
  const userId = user?._id || user?.id;
  if (role === 'guest' || !userId) return null;
  await pushRegistrationStateMutation.catch(() => {});
  const { active } = await readPushRegistrationState();
  if (
    validRevocationEntry(active)
    && active.acknowledged !== true
    && active.accountIdentity === `${role}:${String(userId)}`
  ) {
    return active.pushToken;
  }
  return null;
}

export async function flushPendingPushTokenRevocations({ timeoutMs = 3000 } = {}) {
  if (pendingRevocationFlush) {
    pendingRevocationRerunRequested = true;
    return pendingRevocationFlush;
  }
  pendingRevocationFlush = (async () => {
    let revoked = 0;
    let retained = 0;
    let retryAfterMs = 0;

    do {
      pendingRevocationRerunRequested = false;
      await pushRegistrationStateMutation.catch(() => {});
      const { pending } = await readPushRegistrationState();

      for (const entry of pending) {
        try {
          // This endpoint authenticates with the per-installation credential,
          // not the account JWT. A plain client prevents an expected 401 for a
          // rotated ticket from triggering the shared auth-clearing interceptor.
          await axios.post(`${API_BASE_URL}/api/user/push-token/revoke`, {
            pushToken: entry.pushToken,
            revocationCredential: entry.revocationCredential,
          }, { timeout: timeoutMs });
          await removePendingRevocation(entry);
          revoked += 1;
        } catch (error) {
          const status = error?.response?.status;
          // Only the documented invalid/rotated credential response is
          // terminal. 404 indicates rollout/proxy mismatch and must retain the
          // sole ticket.
          if (status === 401) {
            await removePendingRevocation(entry);
          } else {
            retained += 1;
            if (status === 429) {
              const retryAfter = error?.response?.headers?.['retry-after'];
              const seconds = Number(retryAfter);
              const parsed = Number.isFinite(seconds)
                ? seconds * 1000
                : Math.max(0, Date.parse(String(retryAfter || '')) - Date.now());
              retryAfterMs = Math.max(retryAfterMs, parsed || 0);
            }
          }
        }
      }
    } while (pendingRevocationRerunRequested);

    return retryAfterMs > 0
      ? { revoked, retained, retryAfterMs }
      : { revoked, retained };
  })().finally(() => {
    pendingRevocationFlush = null;
  });
  return pendingRevocationFlush;
}

export async function preparePushTokenLogout({ authToken } = {}) {
  let queued = false;
  await mutatePushRegistrationState((current) => {
    queued = validRevocationEntry(current.active);
    return {
      active: null,
      pending: queued ? [...current.pending, current.active] : current.pending,
    };
  });

  // Network cleanup stays detached so offline conditions never delay local
  // logout. It must, however, run after every registration lifecycle that had
  // already crossed its identity gate. Otherwise a revoke can receive a
  // terminal 401 before a delayed registration commits, leaving the late
  // server write subscribed with no usable cleanup credential.
  (async () => {
    await waitForPushTokenRegistrations();
    await Promise.allSettled([
      // The authenticated DELETE supports older servers while the public,
      // credential-backed endpoint remains durable across restarts.
      unregisterPushTokenFromServer({ attempts: 1, timeoutMs: 1500, authToken }),
      flushPendingPushTokenRevocations({ timeoutMs: 1500 }),
    ]);
  })().catch(() => {});
  return { queued };
}

// ─── Schedule a local notification (used for immediate in-app alerts) ────────
export async function sendLocalNotification({ title, body, data = {}, channelId = 'general' }) {
  if (!Notifications) return null;
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: 'default',
      ...(Platform.OS === 'android' ? { channelId } : {}),
    },
    trigger: null, // immediate
  });
}

// ─── Notification categories for different events ────────────────────────────
export const NotificationTypes = {
  // Order lifecycle
  ORDER_PLACED: 'order_placed',
  ORDER_CONFIRMED: 'order_confirmed',
  ORDER_PROCESSING: 'order_processing',
  ORDER_SHIPPED: 'order_shipped',
  ORDER_DELIVERED: 'order_delivered',
  ORDER_CANCELLED: 'order_cancelled',
  ORDER_PAID: 'order_paid',
  ORDER_NO_CHARGE_CONFIRMED: 'order_no_charge_confirmed',
  ORDER_CONFIRMATION_REQUESTED: 'order_confirmation_requested',

  // Seller alerts
  NEW_ORDER_RECEIVED: 'new_order_received',
  ORDER_CONFIRMED_BY_BUYER: 'order_confirmed_by_buyer',
  ORDER_CANCELLED_BY_BUYER: 'order_cancelled_by_buyer',
  RETURN_REQUESTED: 'return_requested',
  RETURN_STATUS_UPDATE: 'return_status_update',
  LOW_STOCK: 'low_stock',
  NEW_REVIEW: 'new_review',
  STORE_VERIFIED: 'store_verified',
  SUBSCRIPTION_EXPIRING: 'subscription_expiring',
  PAYOUT_RECEIVED: 'payout_received',
  PAID_ORDER_RECEIVED: 'paid_order_received',
  NO_CHARGE_ORDER_RECEIVED: 'no_charge_order_received',
  COD_ORDER_RECEIVED: 'cod_order_received',
  COD_ORDER_CONFIRMED: 'cod_order_confirmed',
  COD_ORDER_RECONFIRMED: 'cod_order_reconfirmed',
  COD_ORDER_CANCELLED: 'cod_order_cancelled',
  RETURN_SETTLED: 'return_settled',
  WITHDRAWAL_REQUESTED: 'withdrawal_requested',
  WITHDRAWAL_STATUS_CHANGED: 'withdrawal_status_changed',
  WALLET_TRANSACTION_COMPLETED: 'wallet_transaction_completed',
  SUBSCRIPTION_PAYMENT_RECEIVED: 'subscription_payment_received',
  SUBSCRIPTION_PAYMENT_RECOVERED: 'subscription_payment_recovered',
  SUBSCRIPTION_ACTIVATED: 'subscription_activated',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',

  // User engagement
  PRICE_DROP: 'price_drop',
  BACK_IN_STOCK: 'back_in_stock',
  WISHLIST_SALE: 'wishlist_sale',
  COUPON_AVAILABLE: 'coupon_available',
  CART_REMINDER: 'cart_reminder',

  // System
  ACCOUNT_UPDATE: 'account_update',
  SECURITY_ALERT: 'security_alert',
  WELCOME: 'welcome',
};

// ─── Helper to build notification content from type ──────────────────────────
export function buildNotificationContent(type, data = {}) {
  const templates = {
    [NotificationTypes.ORDER_PLACED]: {
      title: '🎉 Order Placed!',
      body: `Your order #${data.orderId || ''} has been placed successfully.`,
      channelId: 'orders',
    },
    [NotificationTypes.ORDER_CONFIRMED]: {
      title: '✅ Order Confirmed',
      body: `Your order #${data.orderId || ''} has been confirmed by the seller.`,
      channelId: 'orders',
    },
    [NotificationTypes.ORDER_SHIPPED]: {
      title: '🚚 Order Shipped!',
      body: `Your order #${data.orderId || ''} is on its way!`,
      channelId: 'orders',
    },
    [NotificationTypes.ORDER_DELIVERED]: {
      title: '📦 Order Delivered',
      body: `Your order #${data.orderId || ''} has been delivered. Enjoy!`,
      channelId: 'orders',
    },
    [NotificationTypes.ORDER_CANCELLED]: {
      title: '❌ Order Cancelled',
      body: `Your order #${data.orderId || ''} has been cancelled.`,
      channelId: 'orders',
    },
    [NotificationTypes.NEW_ORDER_RECEIVED]: {
      title: '🛒 New Order!',
      body: `You received a new order${data.amount ? ` worth ${data.amount}` : ''}. Check your dashboard.`,
      channelId: 'seller',
    },
    [NotificationTypes.LOW_STOCK]: {
      title: '⚠️ Low Stock Alert',
      body: `"${data.productName || 'A product'}" is running low (${data.stock || 0} left).`,
      channelId: 'seller',
    },
    [NotificationTypes.STORE_VERIFIED]: {
      title: '🏆 Store Verified!',
      body: 'Congratulations! Your store has been verified and will display a verified badge.',
      channelId: 'seller',
    },
    [NotificationTypes.PRICE_DROP]: {
      title: '💰 Price Drop!',
      body: `"${data.productName || 'An item'}" in your wishlist is now on sale!`,
      channelId: 'promotions',
    },
    [NotificationTypes.BACK_IN_STOCK]: {
      title: '🔔 Back in Stock',
      body: `"${data.productName || 'An item'}" you wanted is back in stock!`,
      channelId: 'promotions',
    },
    [NotificationTypes.CART_REMINDER]: {
      title: '🛍️ Don\'t forget!',
      body: `You have ${data.itemCount || 'items'} waiting in your cart.`,
      channelId: 'promotions',
    },
    [NotificationTypes.WELCOME]: {
      title: '👋 Welcome to Rozare!',
      body: 'Start exploring amazing products from trusted sellers.',
      channelId: 'general',
    },
  };

  return templates[type] || { title: 'Notification', body: data.message || '', channelId: 'general' };
}

// ─── Fire a typed local notification ─────────────────────────────────────────
export async function triggerNotification(type, data = {}) {
  const content = buildNotificationContent(type, data);
  await sendLocalNotification({ ...content, data: { type, ...data } });
}

// ─── Get badge count ─────────────────────────────────────────────────────────
export async function getBadgeCount() {
  if (!Notifications) return 0;
  return await Notifications.getBadgeCountAsync();
}

// Called before the auth token is cleared. Failure never blocks logout, while
// the role-aware foreground handler still prevents a stale token from showing
// another account's alerts on this device.
export async function unregisterPushTokenFromServer({
  attempts = 1,
  timeoutMs = 1500,
  authToken,
} = {}) {
  const pushToken = await secureGet('pushToken').catch(() => null);
  if (!pushToken) return false;

  const maximumAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await api.delete('/api/user/push-token', {
        data: { pushToken },
        timeout: timeoutMs,
        skipAuthSessionCleanup: true,
        ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
      });
      return true;
    } catch (error) {
      if (attempt === maximumAttempts) {
        console.log('Failed to unregister push token during logout:', error?.message || error);
      }
    }
  }
  return false;
}

export async function setBadgeCount(count) {
  if (!Notifications?.setBadgeCountAsync) return;
  await Notifications.setBadgeCountAsync(count);
}

// ─── Clear all delivered notifications ───────────────────────────────────────
export async function clearAllNotifications() {
  if (!Notifications) return;
  const cleanup = [];
  if (Notifications.dismissAllNotificationsAsync) {
    cleanup.push(Notifications.dismissAllNotificationsAsync());
  }
  if (Notifications.cancelAllScheduledNotificationsAsync) {
    cleanup.push(Notifications.cancelAllScheduledNotificationsAsync());
  }
  cleanup.push(setBadgeCount(0));
  await Promise.allSettled(cleanup);
}
