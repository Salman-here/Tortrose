/**
 * Manages push registration, durable logout cleanup, listeners, and tap routes.
 */

import { useEffect } from 'react';
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
  NotificationTypes,
} from '../services/notifications';
import { isNotificationAllowedForRole } from '../utils/notificationScope';

const Notifications = getNotificationsModule();
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

export default function useNotifications() {
  const { currentUser } = useAuth();
  const navigation = useNavigation();

  useEffect(() => {
    let active = true;
    let running = false;
    let rerunRequested = false;
    let generation = 0;
    let retryAttempt = 0;
    let retryTimer = null;

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
      handleNotificationTap(response.notification.request.content.data);
    });
    const pushTokenSubscription = Notifications?.addPushTokenListener?.(() => runMaintenance());

    return () => {
      active = false;
      clearRetryTimer();
      unsubscribeNetwork?.();
      appStateSubscription?.remove?.();
      receivedSubscription?.remove?.();
      responseSubscription?.remove?.();
      pushTokenSubscription?.remove?.();
    };
  }, [currentUser]);

  const handleNotificationTap = (data) => {
    if (!data?.type) return;
    if (!isNotificationAllowedForRole({ data, category: data.category }, currentUser)) return;

    switch (data.type) {
      case NotificationTypes.ORDER_PLACED:
      case NotificationTypes.ORDER_CONFIRMED:
      case NotificationTypes.ORDER_SHIPPED:
      case NotificationTypes.ORDER_DELIVERED:
      case NotificationTypes.ORDER_CANCELLED:
        if (data.orderId) navigation.navigate('OrderDetail', { orderId: data.orderId });
        else navigation.navigate('Orders');
        break;

      case NotificationTypes.NEW_ORDER_RECEIVED:
      case NotificationTypes.ORDER_CANCELLED_BY_BUYER:
        if (data.orderObjectId) {
          navigation.navigate('OrderDetailManagement', { orderId: data.orderObjectId, isAdmin: false });
        } else navigation.navigate('SellerOrderManagement');
        break;

      case NotificationTypes.RETURN_REQUESTED:
        navigation.navigate('SellerOrderManagement', {
          initialTab: 'returns',
          returnRequestId: data.returnRequestId,
        });
        break;

      case NotificationTypes.RETURN_STATUS_UPDATE:
        if (data.orderId) navigation.navigate('OrderDetail', { orderId: data.orderId });
        else navigation.navigate('Orders');
        break;

      case NotificationTypes.ORDER_CONFIRMED_BY_BUYER:
        if (data.orderObjectId) {
          navigation.navigate('OrderDetailManagement', { orderId: data.orderObjectId, isAdmin: false });
        } else navigation.navigate('SellerOrderManagement');
        break;

      case NotificationTypes.LOW_STOCK:
        navigation.navigate('SellerProductManagement');
        break;
      case NotificationTypes.STORE_VERIFIED:
        navigation.navigate('SellerStoreSettings');
        break;

      case NotificationTypes.PRICE_DROP:
      case NotificationTypes.BACK_IN_STOCK:
      case NotificationTypes.WISHLIST_SALE:
        if (data.productId) navigation.navigate('ProductDetail', { productId: data.productId });
        else navigation.navigate('MainTabs', { screen: 'Wishlist' });
        break;

      case NotificationTypes.CART_REMINDER:
        navigation.navigate('MainTabs', { screen: 'Cart' });
        break;
      case NotificationTypes.COUPON_AVAILABLE:
        navigation.navigate('MainTabs', { screen: 'Home' });
        break;
      default:
        navigation.navigate('Notifications');
        break;
    }
  };
}
