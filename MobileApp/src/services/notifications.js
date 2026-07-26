/**
 * Push Notification Service
 * Handles registration, permissions, token management, and local notifications.
 * Uses expo-notifications.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import api from '../config/api';
import { getNotificationsModule } from '../utils/notificationRuntime';

const Notifications = getNotificationsModule();

// ─── Configure how notifications appear when app is in foreground ────────────
if (Notifications) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
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
    const projectId = process.env.EXPO_PUBLIC_PROJECT_ID;
    // Skip remote push-token fetch if no valid EAS projectId is configured
    // (e.g. when running in Expo Go during development without an EAS project).
    // Expo's server requires a real UUID; a missing/placeholder value throws a 400.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!projectId || !UUID_RE.test(projectId)) {
      console.log('Skipping push token fetch: EXPO_PUBLIC_PROJECT_ID not set to a valid UUID.');
      return null;
    }

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    // Save locally
    await SecureStore.setItemAsync('pushToken', token);

    return token;
  } catch (err) {
    console.log('Error getting push token:', err?.message || err);
    return null;
  }
}

// ─── Send push token to backend so it can send server-side pushes ────────────
export async function savePushTokenToServer(token) {
  try {
    await api.post('/api/user/push-token', { pushToken: token });
  } catch (err) {
    console.log('Failed to save push token to server:', err.message);
  }
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

  // Seller alerts
  NEW_ORDER_RECEIVED: 'new_order_received',
  ORDER_CONFIRMED_BY_BUYER: 'order_confirmed_by_buyer',
  LOW_STOCK: 'low_stock',
  NEW_REVIEW: 'new_review',
  STORE_VERIFIED: 'store_verified',
  SUBSCRIPTION_EXPIRING: 'subscription_expiring',
  PAYOUT_RECEIVED: 'payout_received',

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

export async function setBadgeCount(count) {
  if (!Notifications) return;
  await Notifications.setBadgeCountAsync(count);
}

// ─── Clear all delivered notifications ───────────────────────────────────────
export async function clearAllNotifications() {
  if (!Notifications) return;
  await Notifications.dismissAllNotificationsAsync();
  await setBadgeCount(0);
}
