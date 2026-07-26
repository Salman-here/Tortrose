/**
 * useNotificationInbox — encapsulates all notification inbox state, persistence,
 * categorization, grouping, and read/dismiss/clear operations.
 * Extracted from NotificationsScreen.js so the screen stays focused on layout.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { LayoutAnimation } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { impact as hapticImpact, notify as hapticNotify } from '../utils/haptics';
import api from '../config/api';
import { getNotificationsModule } from '../utils/notificationRuntime';

const Notifications = getNotificationsModule();

export const NOTIF_STORE_KEY = 'notification_inbox';
export const NOTIF_READ_KEY = 'notifications_read_ids';

export function categorizeNotification(type) {
  if (!type) return 'system';
  if (type === 'order_shipped' || type === 'order_delivered') return 'delivery';
  if (type.startsWith('order_') || type === 'order_placed' || type === 'order_confirmed' || type === 'order_processing') return 'order';
  if (type === 'new_order_received' || type === 'low_stock' || type === 'store_verified' || type === 'new_review' || type === 'subscription_expiring' || type === 'payout_received') return 'seller';
  if (type === 'price_drop' || type === 'back_in_stock' || type === 'wishlist_sale' || type === 'coupon_available' || type === 'cart_reminder') return 'promo';
  return 'system';
}

export function formatTime(dateStr) {
  const diffMs = Date.now() - new Date(dateStr);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(diffMs / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diffMs / 86400000);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function buildNotificationsFromOrders(orders) {
  const items = [];
  let id = 0;
  orders.forEach((order) => {
    const shortId = (order._id || '').slice(-6).toUpperCase();
    const status = (order.orderStatus || order.status || '').toLowerCase();
    const createdAt = order.createdAt || new Date().toISOString();
    items.push({ id: `${order._id}_placed_${id++}`, orderId: order._id, category: 'order', title: 'Order Confirmed', body: `Order #${shortId} is being processed.`, createdAt, read: true });
    if (['shipped', 'out_for_delivery', 'delivered'].includes(status))
      items.push({ id: `${order._id}_shipped_${id++}`, orderId: order._id, category: 'delivery', title: 'Order Shipped', body: `Order #${shortId} is on its way.`, createdAt: order.shippedAt || createdAt, read: status === 'delivered' });
    if (status === 'delivered')
      items.push({ id: `${order._id}_delivered_${id++}`, orderId: order._id, category: 'delivery', title: 'Order Delivered', body: `Order #${shortId} has been delivered!`, createdAt: order.deliveredAt || createdAt, read: false });
    if (status === 'cancelled')
      items.push({ id: `${order._id}_cancelled_${id++}`, orderId: order._id, category: 'alert', title: 'Order Cancelled', body: `Order #${shortId} has been cancelled.`, createdAt: order.updatedAt || createdAt, read: false });
  });
  return items;
}

/** Group notifications by orderId. Non-order notifs get their own group. */
export function groupNotifications(notifications) {
  const groups = [];
  const orderMap = new Map();

  notifications.forEach(n => {
    if (n.orderId) {
      if (!orderMap.has(n.orderId)) {
        const group = { type: 'group', orderId: n.orderId, items: [], latestDate: n.createdAt };
        orderMap.set(n.orderId, group);
        groups.push(group);
      }
      const g = orderMap.get(n.orderId);
      g.items.push(n);
      if (new Date(n.createdAt) > new Date(g.latestDate)) g.latestDate = n.createdAt;
    } else {
      groups.push({ type: 'single', item: n });
    }
  });

  groups.sort((a, b) => {
    const da = a.type === 'group' ? new Date(a.latestDate) : new Date(a.item.createdAt);
    const db = b.type === 'group' ? new Date(b.latestDate) : new Date(b.item.createdAt);
    return db - da;
  });

  return groups;
}

export default function useNotificationInbox({ currentUser, onCountChange } = {}) {
  const [notifications, setNotifications] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const readIds = useRef(new Set());
  const listenerRef = useRef(null);

  // Hydrate read-id set
  useEffect(() => {
    (async () => {
      try {
        const r = await AsyncStorage.getItem(NOTIF_READ_KEY);
        if (r) readIds.current = new Set(JSON.parse(r));
      } catch {}
    })();
  }, []);

  // Live push listener
  useEffect(() => {
    if (!Notifications) return undefined;
    listenerRef.current = Notifications.addNotificationReceivedListener(async (notification) => {
      const content = notification.request.content;
      const data = content.data || {};
      const newNotif = {
        id: notification.request.identifier || `push_${Date.now()}`,
        orderId: data.orderId || null,
        category: categorizeNotification(data.type),
        title: content.title || 'Notification',
        body: content.body || '',
        createdAt: new Date().toISOString(),
        read: false,
        data,
      };
      setNotifications(prev => [newNotif, ...prev]);
      try {
        const stored = await AsyncStorage.getItem(NOTIF_STORE_KEY);
        const arr = stored ? JSON.parse(stored) : [];
        arr.unshift(newNotif);
        await AsyncStorage.setItem(NOTIF_STORE_KEY, JSON.stringify(arr.slice(0, 200)));
      } catch {}
    });
    return () => { if (listenerRef.current) listenerRef.current.remove(); };
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      let pushNotifs = [];
      try { const stored = await AsyncStorage.getItem(NOTIF_STORE_KEY); if (stored) pushNotifs = JSON.parse(stored); } catch {}

      let orderNotifs = [];
      let broadcastNotifs = [];
      if (currentUser) {
        try { const res = await api.get('/api/order/user-orders'); orderNotifs = buildNotificationsFromOrders(res.data?.orders || []); } catch {}
        try {
          const res = await api.get('/api/notifications/me');
          broadcastNotifs = (res.data?.items || []).map(b => ({
            id: `broadcast_${b._id}`,
            category: b.category === 'promo' ? 'promo' : 'system',
            title: b.title,
            body: b.body,
            createdAt: b.createdAt,
            read: !!b.read,
            data: { type: 'admin_broadcast', linkTo: b.linkTo, broadcastId: b._id },
          }));
        } catch {}
      }

      const allMap = new Map();
      [...broadcastNotifs, ...orderNotifs, ...pushNotifs].forEach(n => { if (!allMap.has(n.id)) allMap.set(n.id, n); });

      if (allMap.size === 0) {
        allMap.set('welcome', { id: 'welcome', category: 'system', title: 'Welcome to Rozare', body: 'Start shopping to see notifications here.', createdAt: new Date().toISOString(), read: false });
      }

      const merged = [...allMap.values()]
        .map(n => readIds.current.has(n.id) ? { ...n, read: true } : n)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      setNotifications(merged);
    } catch {}
    finally { setIsLoading(false); setRefreshing(false); }
  }, [currentUser]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const persistReadIds = useCallback(() => {
    AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current])).catch(() => {});
    onCountChange?.();
  }, [onCountChange]);

  const markRead = useCallback((ids) => {
    const arr = Array.isArray(ids) ? ids : [ids];
    arr.forEach(id => readIds.current.add(id));
    setNotifications(prev => prev.map(n => arr.includes(n.id) ? { ...n, read: true } : n));
    persistReadIds();
  }, [persistReadIds]);

  const markAllRead = useCallback(() => {
    hapticNotify(Haptics.NotificationFeedbackType.Success);
    setNotifications(prev => {
      prev.forEach(n => readIds.current.add(n.id));
      return prev.map(n => ({ ...n, read: true }));
    });
    persistReadIds();
  }, [persistReadIds]);

  const clearAll = useCallback(async () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setNotifications([]);
    readIds.current.clear();
    await AsyncStorage.multiRemove([NOTIF_STORE_KEY, NOTIF_READ_KEY]).catch(() => {});
    onCountChange?.();
  }, [onCountChange]);

  const dismiss = useCallback(async (notifId) => {
    hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    readIds.current.add(notifId);
    setNotifications(prev => prev.filter(n => n.id !== notifId));
    try {
      const stored = await AsyncStorage.getItem(NOTIF_STORE_KEY);
      if (stored) {
        const arr = JSON.parse(stored).filter(n => n.id !== notifId);
        await AsyncStorage.setItem(NOTIF_STORE_KEY, JSON.stringify(arr));
      }
      await AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current]));
    } catch {}
    onCountChange?.();
  }, [onCountChange]);

  const dismissGroup = useCallback(async (ids) => {
    hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    ids.forEach(id => readIds.current.add(id));
    setNotifications(prev => prev.filter(n => !ids.includes(n.id)));
    try {
      const stored = await AsyncStorage.getItem(NOTIF_STORE_KEY);
      if (stored) {
        const arr = JSON.parse(stored).filter(n => !ids.includes(n.id));
        await AsyncStorage.setItem(NOTIF_STORE_KEY, JSON.stringify(arr));
      }
      await AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current]));
    } catch {}
    onCountChange?.();
  }, [onCountChange]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, [fetchNotifications]);

  return {
    notifications,
    isLoading,
    refreshing,
    readIds: readIds.current,
    fetchNotifications,
    refresh,
    markRead,
    markAllRead,
    clearAll,
    dismiss,
    dismissGroup,
  };
}
