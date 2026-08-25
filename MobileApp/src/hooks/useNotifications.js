/**
 * Manages push registration, durable logout cleanup, listeners, and tap routes.
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../contexts/AuthContext';
import { getNotificationsModule } from '../utils/notificationRuntime';
import {
  flushPendingPushTokenRevocations,
  getStagedPushTokenForIdentity,
  registerForPushNotifications,
  savePushTokenToServer,
  setActiveNotificationIdentity,
  waitForPushTokenRegistrations,
} from '../services/notifications';
import {
  getNotificationIdentity,
  isNotificationAllowedForRole,
  normalizeNotificationRole,
} from '../utils/notificationScope';
import { getPushNotificationInboxId } from '../utils/notificationDedupe';
import { resolveNotificationTarget } from '../utils/notificationRouting';

const Notifications = getNotificationsModule();
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];
const consumedResponseKeys = new Set();
const consumedResponseOrder = [];

export function getNotificationResponseKey(response) {
  const notification = response?.notification;
  return getPushNotificationInboxId(notification, '');
}

function rememberConsumedResponse(key) {
  if (!key || consumedResponseKeys.has(key)) return false;
  consumedResponseKeys.add(key);
  consumedResponseOrder.push(key);
  if (consumedResponseOrder.length > 500) {
    consumedResponseKeys.delete(consumedResponseOrder.shift());
  }
  return true;
}

export default function useNotifications() {
  const { currentUser } = useAuth();
  const navigation = useNavigation();
  const identity = getNotificationIdentity(currentUser);
  const activeIdentityRef = useRef(identity);
  activeIdentityRef.current = identity;

  const handleNotificationTap = useCallback((data) => {
    if (!data || typeof data !== 'object') return;
    if (!isNotificationAllowedForRole({ data, category: data.category }, currentUser)) return;

    const target = resolveNotificationTarget(data, currentUser);
    if (target) navigation.navigate(target.screen, target.params);
    else navigation.navigate('Notifications');
    return true;
  }, [currentUser, navigation]);

  const handleNotificationResponse = useCallback((response) => {
    const key = getNotificationResponseKey(response);
    if (!key || !rememberConsumedResponse(key)) return false;
    const data = response?.notification?.request?.content?.data;
    return handleNotificationTap(data);
  }, [handleNotificationTap]);

  useEffect(() => {
    let active = true;
    let running = false;
    let rerunRequested = false;
    let generation = 0;
    let retryAttempt = 0;
    let retryTimer = null;
    const listenerIdentity = identity;

    const clearRetryTimer = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const scheduleRetry = (serverDelayMs = 0) => {
      if (!active) return;
      clearRetryTimer();
      const fallback = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
      retryAttempt = Math.min(retryAttempt + 1, RETRY_DELAYS_MS.length - 1);
      retryTimer = setTimeout(() => runMaintenance(), Math.max(fallback, serverDelayMs || 0));
    };

    const runMaintenance = async () => {
      if (!active) return;
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      try {
        do {
          rerunRequested = false;
          await waitForPushTokenRegistrations();
          if (!active) break;

          // Guests also drain durable logout tickets. This is intentionally
          // independent of authentication and retries on reconnect/app-active.
          const cleanup = await flushPendingPushTokenRevocations()
            .catch(() => ({ revoked: 0, retained: 1 }));
          if (!active) break;

          let registrationNeedsRetry = false;
          if (Notifications && currentUser) {
            // A failed/lost prior POST is retried with the exact credential that
            // was persisted before it. Otherwise fetch the current Expo token;
            // this also discovers T1 -> T2 rotations while the app stays open.
            const stagedToken = await getStagedPushTokenForIdentity(currentUser);
            const token = stagedToken || await registerForPushNotifications();
            if (active && token) {
              const saved = await savePushTokenToServer(token, { user: currentUser, generation });
              registrationNeedsRetry = !saved;
            }
          }

          if (cleanup.retained > 0 || registrationNeedsRetry) {
            scheduleRetry(cleanup.retryAfterMs);
          } else if (!rerunRequested) {
            retryAttempt = 0;
            clearRetryTimer();
          }
        } while (active && rerunRequested);
      } catch (_) {
        // Native permission/channel APIs can reject before registration reaches
        // the network. Never leave the lifecycle in a permanently "running"
        // state; retry while the app remains active and again on lifecycle events.
        if (active) scheduleRetry();
      } finally {
        running = false;
      }
    };

    setActiveNotificationIdentity(currentUser)
      .then((value) => {
        generation = value;
        if (active) runMaintenance();
      })
      .catch(() => {});

    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) runMaintenance();
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') runMaintenance();
    });
    const receivedSubscription = Notifications?.addNotificationReceivedListener?.(() => {});
    const responseSubscription = Notifications?.addNotificationResponseReceivedListener?.((response) => {
      if (activeIdentityRef.current !== listenerIdentity) return;
      handleNotificationResponse(response);
    });
    const pushTokenSubscription = Notifications?.addPushTokenListener?.(() => runMaintenance());

    // Expo retains the response that launched a previously-killed app. Consume
    // it only after a concrete account is active, validate it through the same
    // role/recipient router as live responses, then clear the native snapshot.
    if (
      Notifications?.getLastNotificationResponseAsync
      && currentUser
      && normalizeNotificationRole(currentUser) !== 'guest'
    ) {
      Promise.resolve(Notifications.getLastNotificationResponseAsync())
        .then(async (response) => {
          if (
            !active
            || activeIdentityRef.current !== listenerIdentity
            || !response
          ) return;
          handleNotificationResponse(response);
          if (!active || activeIdentityRef.current !== listenerIdentity) return;
          await Notifications.clearLastNotificationResponseAsync?.();
        })
        .catch(() => {});
    }

    return () => {
      active = false;
      clearRetryTimer();
      unsubscribeNetwork?.();
      appStateSubscription?.remove?.();
      receivedSubscription?.remove?.();
      responseSubscription?.remove?.();
      pushTokenSubscription?.remove?.();
    };
  }, [currentUser, handleNotificationResponse, identity]);
}
