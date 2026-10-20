/**
 * useNotificationInbox — encapsulates all notification inbox state, persistence,
 * categorization, grouping, and read/dismiss/clear operations.
 * Extracted from NotificationsScreen.js so the screen stays focused on layout.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { impact as hapticImpact, notify as hapticNotify } from '../utils/haptics';
import api from '../config/api';
import { getNotificationsModule } from '../utils/notificationRuntime';
import {
  getNotificationIdentity,
  getNotificationStorageKeys,
  normalizeNotificationRole,
  scopeNotificationsForRole,
} from '../utils/notificationScope';
import {
  dedupeInboxNotifications,
  getPersistentNotificationInboxId,
  getPushNotificationInboxId,
  mergeInboxNotification,
} from '../utils/notificationDedupe';
import { inferNotificationCategory } from '../utils/notificationRouting';
import {
  parseNotificationInboxResponse,
  parseNotificationDismissResponse,
  parseNotificationReadAllResponse,
  parseNotificationReadResponse,
  parseStoredNotificationReadIds,
} from '../utils/notificationInboxSafety';

const Notifications = getNotificationsModule();

export const NOTIF_STORE_KEY = 'notification_inbox';
export const NOTIF_READ_KEY = 'notifications_read_ids';

export function categorizeNotification(type, explicitCategory) {
  return inferNotificationCategory(type, explicitCategory);
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

function validEventTime(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function durableOrderIdentifiers(notifications) {
  const identifiers = new Set();
  (Array.isArray(notifications) ? notifications : []).forEach((notification) => {
    const data = notification?.data && typeof notification.data === 'object'
      ? notification.data
      : {};
    const aggregateType = String(data.aggregateType || notification?.aggregateType || '').toLowerCase();
    const aggregateId = data.aggregateId || notification?.aggregateId;
    if (aggregateType === 'order' && aggregateId) identifiers.add(String(aggregateId));
    const orderId = data.orderObjectId || data.orderId || notification?.orderId;
    if (orderId) identifiers.add(String(orderId));
  });
  return identifiers;
}

export function buildNotificationsFromOrders(orders, { durableNotifications = [] } = {}) {
  const items = [];
  const durableOrders = durableOrderIdentifiers(durableNotifications);
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const objectId = String(order?._id || '');
    const publicOrderId = String(order?.orderId || '');
    if (!objectId || durableOrders.has(objectId) || (publicOrderId && durableOrders.has(publicOrderId))) return;

    const shortId = publicOrderId || objectId.slice(-6).toUpperCase();
    const status = (order.orderStatus || order.status || '').toLowerCase();
    const confirmation = order.confirmation || {};
    const cancellationAt = validEventTime(
      order.cancelledAt
      || confirmation.cancelledFromDashboardAt
      || confirmation.declinedAt
      || order.paymentCancelledAt
    );

    // A cancelled snapshot must never retain a synthetic confirmation/payment
    // claim. Without a persisted cancellation timestamp, leave it entirely to
    // the durable notification service rather than inventing one from updatedAt.
    if (status === 'cancelled') {
      if (cancellationAt) {
        items.push({
          id: `${objectId}_cancelled_0`,
          orderId: objectId,
          category: 'order',
          title: 'Order cancelled',
          body: `Order #${shortId} was cancelled.`,
          createdAt: cancellationAt,
          read: false,
        });
      }
      return;
    }

    const paidAt = order.isPaid === true ? validEventTime(order.paidAt) : null;
    const confirmedAt = validEventTime(confirmation.confirmedAt);
    if (paidAt) {
      items.push({
        id: `${objectId}_paid_0`,
        orderId: objectId,
        category: 'payment',
        title: 'Payment confirmed',
        body: `Payment for order #${shortId} was confirmed.`,
        createdAt: paidAt,
        read: false,
      });
    } else if (confirmedAt && ['confirmed', 'processing', 'shipped', 'delivered'].includes(status)) {
      items.push({
        id: `${objectId}_confirmed_0`,
        orderId: objectId,
        category: 'order',
        title: 'Order confirmed',
        body: `Order #${shortId} was confirmed.`,
        createdAt: confirmedAt,
        read: false,
      });
    }

    const shippedAt = validEventTime(order.shippedAt);
    if (shippedAt && ['shipped', 'out_for_delivery', 'delivered'].includes(status)) {
      items.push({
        id: `${objectId}_shipped_0`,
        orderId: objectId,
        category: 'delivery',
        title: 'Order shipped',
        body: `Order #${shortId} is on its way.`,
        createdAt: shippedAt,
        read: false,
      });
    }

    const deliveredAt = validEventTime(order.deliveredAt);
    if (status === 'delivered' && deliveredAt) {
      items.push({
        id: `${objectId}_delivered_0`,
        orderId: objectId,
        category: 'delivery',
        title: 'Order marked delivered',
        body: `Order #${shortId} was marked delivered. View your order for delivery details and available return options.`,
        createdAt: deliveredAt,
        read: false,
      });
    }
  });
  return items;
}

export function normalizePersistentInboxNotification(notification) {
  if (!notification?._id) return null;
  const publicOrderId = String(notification.body || '').match(/\b(ORD-[A-Za-z0-9-]+)\b/i)?.[1] || null;
  return {
    id: getPersistentNotificationInboxId(notification),
    orderId: String(notification.aggregateType || '').toLowerCase() === 'order'
      ? notification.aggregateId || null
      : null,
    publicOrderId,
    category: categorizeNotification(notification.eventType, notification.category),
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt,
    read: !!notification.read,
    data: {
      type: notification.source === 'admin_broadcast' ? 'admin_broadcast' : 'persistent_system',
      source: notification.source,
      category: notification.category,
      linkTo: notification.linkTo,
      broadcastId: notification._id,
      recipientUserId: notification.user,
      targetRole: notification.targetRole,
      audience: notification.audience,
      notificationEventKey: notification.eventKey,
      notificationEventType: notification.eventType,
      aggregateType: notification.aggregateType,
      aggregateId: notification.aggregateId,
    },
  };
}

/** Group notifications by orderId. Non-order notifs get their own group. */
export function groupNotifications(notifications) {
  const groups = [];
  const orderMap = new Map();

  notifications.forEach(n => {
    if (n.orderId) {
      if (!orderMap.has(n.orderId)) {
        const group = {
          type: 'group',
          orderId: n.orderId,
          publicOrderId: n.publicOrderId || n.data?.publicOrderId || null,
          items: [],
          latestDate: n.createdAt,
        };
        orderMap.set(n.orderId, group);
        groups.push(group);
      }
      const g = orderMap.get(n.orderId);
      g.items.push(n);
      if (!g.publicOrderId) g.publicOrderId = n.publicOrderId || n.data?.publicOrderId || null;
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
  const focused = useIsFocused();
  const [notifications, setNotifications] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const readIds = useRef(new Set());
  const dismissedIds = useRef(new Set());
  const serverDismissedIds = useRef(new Set());
  const serverDismissedBackendIds = useRef(new Set());
  const listenerRef = useRef(null);
  const notificationsRef = useRef([]);
  const accountGenerationRef = useRef(0);
  const fetchGenerationRef = useRef(0);
  const mutationRequestGenerationRef = useRef(0);
  const mutationQueueRef = useRef(Promise.resolve(true));
  const storageWriteChainRef = useRef(Promise.resolve());
  const role = normalizeNotificationRole(currentUser);
  const identity = getNotificationIdentity(currentUser);
  const activeIdentityRef = useRef(identity);
  activeIdentityRef.current = identity;
  const storageKeys = useMemo(
    () => getNotificationStorageKeys(currentUser),
    [currentUser?._id, currentUser?.id, currentUser?.role]
  );

  const commitNotifications = useCallback((updater) => {
    setNotifications((previous) => {
      const next = typeof updater === 'function' ? updater(previous) : updater;
      notificationsRef.current = next;
      return next;
    });
  }, []);

  const notifyCountChanged = useCallback(() => {
    Promise.resolve(onCountChange?.()).catch(() => {});
  }, [onCountChange]);

  // Every signed-in account and role gets a separate local inbox. This avoids
  // showing a prior seller session's cached alerts after the same device signs
  // into a buyer account (and vice versa).
  useEffect(() => {
    let cancelled = false;
    const accountGeneration = accountGenerationRef.current + 1;
    accountGenerationRef.current = accountGeneration;
    fetchGenerationRef.current += 1;
    mutationRequestGenerationRef.current += 1;
    mutationQueueRef.current = Promise.resolve(true);
    storageWriteChainRef.current = Promise.resolve();
    setStorageReady(false);
    setIsLoading(true);
    commitNotifications([]);
    setLoadError('');
    setActionError('');
    readIds.current = new Set();
    dismissedIds.current = new Set();
    serverDismissedIds.current = new Set();
    serverDismissedBackendIds.current = new Set();

    (async () => {
      try {
        const [r, dismissed] = await Promise.all([
          AsyncStorage.getItem(storageKeys.read), AsyncStorage.getItem(storageKeys.dismissed),
        ]);
        if (
          !cancelled
          && activeIdentityRef.current === identity
          && accountGenerationRef.current === accountGeneration
        ) {
          readIds.current = parseStoredNotificationReadIds(r);
          dismissedIds.current = parseStoredNotificationReadIds(dismissed);
        }
      } catch {
        if (
          !cancelled
          && activeIdentityRef.current === identity
          && accountGenerationRef.current === accountGeneration
        ) readIds.current = new Set();
      }
      if (
        !cancelled
        && activeIdentityRef.current === identity
        && accountGenerationRef.current === accountGeneration
      ) setStorageReady(true);
    })();

    // The v1 keys were shared by all users. Remove them once so stale
    // cross-account entries can never be revived by a future code path.
    AsyncStorage.multiRemove([NOTIF_STORE_KEY, NOTIF_READ_KEY]).catch(() => {});
    return () => { cancelled = true; };
  }, [commitNotifications, identity, storageKeys.read]);

  // Live push listener
  useEffect(() => {
    if (!Notifications || !storageReady || role === 'guest') return undefined;
    listenerRef.current = Notifications.addNotificationReceivedListener(async (notification) => {
      const accountGeneration = accountGenerationRef.current;
      if (activeIdentityRef.current !== identity) return;
      const content = notification?.request?.content;
      if (!content || typeof content !== 'object') return;
      const data = content.data || {};
      const [newNotif] = scopeNotificationsForRole([{
        id: getPushNotificationInboxId(notification, `push_${Date.now()}`),
        orderId: data.orderId || null,
        category: categorizeNotification(data.type, data.category),
        title: content.title || 'Notification',
        body: content.body || '',
        createdAt: new Date().toISOString(),
        read: false,
        data,
        accountScope: identity,
      }], currentUser);
      if (!newNotif || dismissedIds.current.has(newNotif.id) || serverDismissedIds.current.has(newNotif.id)
        || serverDismissedBackendIds.current.has(newNotif.data?.broadcastId)) return;

      if (
        activeIdentityRef.current !== identity
        || accountGenerationRef.current !== accountGeneration
      ) return;
      commitNotifications((previous) => mergeInboxNotification(previous, newNotif));

      storageWriteChainRef.current = storageWriteChainRef.current
        .catch(() => {})
        .then(async () => {
          if (
            activeIdentityRef.current !== identity
            || accountGenerationRef.current !== accountGeneration
          ) return;
          const stored = await AsyncStorage.getItem(storageKeys.inbox);
          let cached = [];
          if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) cached = parsed;
          }
          const scoped = scopeNotificationsForRole(cached, currentUser);
          const next = mergeInboxNotification(scoped, newNotif);
          if (
            activeIdentityRef.current !== identity
            || accountGenerationRef.current !== accountGeneration
          ) return;
          await AsyncStorage.setItem(storageKeys.inbox, JSON.stringify(next));
        })
        .catch(() => {});
    });
    return () => { if (listenerRef.current) listenerRef.current.remove(); };
  }, [commitNotifications, currentUser, identity, role, storageKeys.inbox, storageReady]);

  const fetchNotifications = useCallback(async ({ preserveExisting = false } = {}) => {
    if (!storageReady) return;
    const requestIdentity = identity;
    const requestAccountGeneration = accountGenerationRef.current;
    const requestGeneration = fetchGenerationRef.current + 1;
    fetchGenerationRef.current = requestGeneration;
    setIsLoading(!preserveExisting || notificationsRef.current.length === 0);
    setLoadError('');
    if (!preserveExisting) commitNotifications([]);
    try {
      let pushNotifs = [];
      try {
        const stored = await AsyncStorage.getItem(storageKeys.inbox);
        if (stored) {
          const parsed = JSON.parse(stored);
          pushNotifs = dedupeInboxNotifications(
            scopeNotificationsForRole(Array.isArray(parsed) ? parsed : [], currentUser)
          );
        }
      } catch {}

      let orderSnapshots = [];
      let broadcastNotifs = [];
      let dismissedMetadata = [];
      if (currentUser && (role === 'user' || role === 'seller')) {
        try { const res = await api.get('/api/order/user-orders'); orderSnapshots = res.data?.orders || []; } catch {}
      }
      if (currentUser && role !== 'guest') {
        const res = await api.get('/api/notifications/me?includeDismissals=true');
        const snapshot = parseNotificationInboxResponse(res.data, { currentUser });
        dismissedMetadata = snapshot.dismissedItems;
        broadcastNotifs = snapshot.items
          .map(normalizePersistentInboxNotification)
          .filter(Boolean);
      }
      const dismissedOrders = [...dismissedIds.current].filter(id => id.startsWith('synthetic-order:'))
        .map(id => ({ orderId: id.slice('synthetic-order:'.length) }));
      const orderNotifs = buildNotificationsFromOrders(orderSnapshots, {
        durableNotifications: [...broadcastNotifs, ...pushNotifs, ...dismissedOrders, ...dismissedMetadata],
      });

      const mergedScoped = dedupeInboxNotifications(scopeNotificationsForRole(
        [...broadcastNotifs, ...orderNotifs, ...pushNotifs],
        currentUser
      ));
      const allMap = new Map(mergedScoped.map((notification) => [notification.id, notification]));

      const archivedIds = new Set(dismissedMetadata.map(getPersistentNotificationInboxId));
      const archivedBackendIds = new Set(dismissedMetadata.map(item => item._id));
      const merged = [...allMap.values()]
        .filter(notification => !dismissedIds.current.has(notification.id) && !archivedIds.has(notification.id)
          && !archivedBackendIds.has(notification.data?.broadcastId))
        .map((notification) => (
          notification.data?.broadcastId || !readIds.current.has(notification.id)
            ? notification
            : { ...notification, read: true }
        ))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      if (
        activeIdentityRef.current !== requestIdentity
        || accountGenerationRef.current !== requestAccountGeneration
        || fetchGenerationRef.current !== requestGeneration
      ) return;
      serverDismissedIds.current = archivedIds;
      serverDismissedBackendIds.current = archivedBackendIds;
      commitNotifications(merged);
    } catch (error) {
      if (
        activeIdentityRef.current === requestIdentity
        && accountGenerationRef.current === requestAccountGeneration
        && fetchGenerationRef.current === requestGeneration
      ) {
        if (!preserveExisting || error?.code === 'NOTIFICATION_INBOX_RESPONSE_INVALID'
          || [401, 403].includes(error?.response?.status)) commitNotifications([]);
        setLoadError('Notifications are unavailable. Pull to refresh and try again.');
      }
    }
    finally {
      if (
        activeIdentityRef.current === requestIdentity
        && accountGenerationRef.current === requestAccountGeneration
        && fetchGenerationRef.current === requestGeneration
      ) {
        setIsLoading(false);
        setRefreshing(false);
      }
    }
  }, [commitNotifications, currentUser, identity, role, storageKeys.inbox, storageReady]);

  useEffect(() => {
    if (storageReady && focused) fetchNotifications({ preserveExisting: true });
  }, [fetchNotifications, focused, storageReady]);

  const persistReadIds = useCallback(async () => {
    try {
      await AsyncStorage.setItem(storageKeys.read, JSON.stringify([...readIds.current]));
      return true;
    } catch {
      return false;
    }
  }, [storageKeys.read]);

  const removeCachedInboxItems = useCallback((ids, { clear = false } = {}) => {
    const requestIdentity = identity;
    const requestAccountGeneration = accountGenerationRef.current;
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    const operation = storageWriteChainRef.current
      .catch(() => {})
      .then(async () => {
        if (
          activeIdentityRef.current !== requestIdentity
          || accountGenerationRef.current !== requestAccountGeneration
        ) return false;
        if (clear) {
          await AsyncStorage.removeItem(storageKeys.inbox);
          return activeIdentityRef.current === requestIdentity
            && accountGenerationRef.current === requestAccountGeneration;
        }

        const stored = await AsyncStorage.getItem(storageKeys.inbox);
        if (!stored) return true;
        const parsed = JSON.parse(stored);
        const next = dedupeInboxNotifications(scopeNotificationsForRole(
          Array.isArray(parsed) ? parsed : [],
          currentUser
        )).filter((notification) => !idSet.has(notification.id));
        if (
          activeIdentityRef.current !== requestIdentity
          || accountGenerationRef.current !== requestAccountGeneration
        ) return false;
        await AsyncStorage.setItem(storageKeys.inbox, JSON.stringify(next));
        return true;
      });
    storageWriteChainRef.current = operation.catch(() => {});
    return operation.catch(() => false);
  }, [currentUser, identity, storageKeys.inbox]);

  const enqueueMutation = useCallback((task) => {
    const queuedIdentity = identity;
    const next = mutationQueueRef.current
      .catch(() => false)
      .then(async () => {
        if (activeIdentityRef.current !== queuedIdentity) return false;
        // A fetch that started before this transition must not restore the old
        // unread snapshot after the mutation has been confirmed.
        fetchGenerationRef.current += 1;
        setIsLoading(false);
        setRefreshing(false);
        const requestGeneration = mutationRequestGenerationRef.current + 1;
        mutationRequestGenerationRef.current = requestGeneration;
        const requestAccountGeneration = accountGenerationRef.current;
        return task({
          requestIdentity: queuedIdentity,
          requestAccountGeneration,
          requestGeneration,
          isCurrent: () => (
            activeIdentityRef.current === queuedIdentity
            && accountGenerationRef.current === requestAccountGeneration
            && mutationRequestGenerationRef.current === requestGeneration
          ),
        });
      });
    mutationQueueRef.current = next.catch(() => false);
    return next;
  }, [identity]);

  const markRead = useCallback((ids) => enqueueMutation(async ({ isCurrent }) => {
    const requestedIds = [...new Set((Array.isArray(ids) ? ids : [ids]).filter((id) => (
      typeof id === 'string' && id && id === id.trim() && id.length <= 500
    )))];
    if (!requestedIds.length || !isCurrent()) return false;

    setActionError('');
    const selected = notificationsRef.current.filter((notification) => requestedIds.includes(notification.id));
    const previousRead = new Map(selected.map((notification) => [notification.id, notification.read === true]));
    selected.forEach((notification) => readIds.current.add(notification.id));
    commitNotifications((previous) => previous.map((notification) => (
      requestedIds.includes(notification.id) ? { ...notification, read: true } : notification
    )));
    const localWriteSucceeded = await persistReadIds();
    if (!isCurrent()) return false;

    const persistentTargets = selected.filter((notification) => (
      notification.read !== true
      && typeof notification.data?.broadcastId === 'string'
      && notification.data.broadcastId
    ));
    const results = await Promise.all(persistentTargets.map(async (notification) => {
      try {
        const backendId = notification.data.broadcastId;
        const response = await api.patch(`/api/notifications/${encodeURIComponent(backendId)}/read`);
        parseNotificationReadResponse(response.data, { currentUser, notificationId: backendId });
        return { id: notification.id, ok: true };
      } catch {
        return { id: notification.id, ok: false };
      }
    }));
    if (!isCurrent()) return false;

    const failedPersistentIds = new Set(results.filter(({ ok }) => !ok).map(({ id }) => id));
    const failedLocalIds = new Set(
      localWriteSucceeded
        ? []
        : selected.filter((notification) => !notification.data?.broadcastId).map(({ id }) => id)
    );
    const failedIds = new Set([...failedPersistentIds, ...failedLocalIds]);
    failedIds.forEach((id) => {
      if (!previousRead.get(id)) readIds.current.delete(id);
    });
    commitNotifications((previous) => previous.map((notification) => {
      if (!requestedIds.includes(notification.id)) return notification;
      if (failedIds.has(notification.id)) {
        return { ...notification, read: previousRead.get(notification.id) === true };
      }
      return { ...notification, read: true };
    }));
    await persistReadIds();
    if (!isCurrent()) return false;

    if (failedIds.size > 0) {
      setActionError('Some notifications could not be marked as read. Please try again.');
    }
    notifyCountChanged();
    return failedIds.size === 0;
  }), [commitNotifications, currentUser, enqueueMutation, notifyCountChanged, persistReadIds]);

  const markAllRead = useCallback(() => enqueueMutation(async ({ isCurrent }) => {
    if (!isCurrent()) return false;
    hapticNotify(Haptics.NotificationFeedbackType.Success);
    setActionError('');
    const previousNotifications = notificationsRef.current;
    const previousReadIds = new Set(readIds.current);
    previousNotifications.forEach((notification) => readIds.current.add(notification.id));
    commitNotifications(previousNotifications.map((notification) => ({ ...notification, read: true })));
    const localWriteSucceeded = await persistReadIds();
    if (!isCurrent()) return false;

    let serverSucceeded = role === 'guest';
    if (role !== 'guest' && currentUser) {
      try {
        const response = await api.post('/api/notifications/read-all');
        parseNotificationReadAllResponse(response.data, { currentUser });
        serverSucceeded = true;
      } catch {
        serverSucceeded = false;
      }
    }
    if (!isCurrent()) return false;

    if (!serverSucceeded) {
      readIds.current = previousReadIds;
      commitNotifications(previousNotifications);
      await persistReadIds();
      if (!isCurrent()) return false;
      setActionError('Notifications could not be marked as read. Please try again.');
      notifyCountChanged();
      return false;
    }

    if (!localWriteSucceeded) {
      readIds.current = previousReadIds;
      commitNotifications(previousNotifications.map((notification) => (
        notification.data?.broadcastId ? { ...notification, read: true } : notification
      )));
      setActionError('Saved notifications were updated, but local read state could not be stored.');
      notifyCountChanged();
      return false;
    }

    notifyCountChanged();
    return true;
  }), [commitNotifications, currentUser, enqueueMutation, notifyCountChanged, persistReadIds, role]);

  const dismissItems = useCallback((ids) => enqueueMutation(async ({ isCurrent }) => {
    if (!isCurrent()) return false;
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    const selected = notificationsRef.current.filter(notification => idSet.has(notification.id));
    if (!selected.length) return true;
    setActionError('');
    const beforeDismissed = new Set(dismissedIds.current);
    selected.forEach(notification => {
      dismissedIds.current.add(notification.id);
      // A dismissed durable order event remains authoritative over legacy
      // order-snapshot fallbacks. Future durable order updates still appear.
      if (notification.orderId) dismissedIds.current.add(`synthetic-order:${notification.orderId}`);
    });
    try {
      const backendIds = [...new Set(selected.map(notification => notification.data?.broadcastId).filter(Boolean))];
      if (backendIds.length) {
        const response = await api.post('/api/notifications/dismiss', { ids: backendIds });
        parseNotificationDismissResponse(response.data, { currentUser, ids: backendIds });
        if (!isCurrent()) return false;
      }
      await AsyncStorage.setItem(storageKeys.dismissed, JSON.stringify([...dismissedIds.current].slice(-10000)));
      if (!isCurrent()) return false;
    } catch {
      if (!isCurrent()) return false;
      dismissedIds.current = beforeDismissed;
      await AsyncStorage.setItem(storageKeys.dismissed, JSON.stringify([...beforeDismissed])).catch(() => {});
      if (isCurrent()) setActionError('Notifications could not be dismissed. Check your connection and try again.');
      return false;
    }
    if (!isCurrent()) return false;
    selected.forEach(notification => readIds.current.add(notification.id));
    await persistReadIds();
    await removeCachedInboxItems(selected.map(notification => notification.id));
    if (!isCurrent()) return false;
    hapticImpact(Haptics.ImpactFeedbackStyle.Medium);
    // Fabric's native layout animation can leave recycled Swipeable children
    // invisible on return. Let the list remove the explicit rows normally.
    commitNotifications(previous => previous.filter(notification => !idSet.has(notification.id)));
    notifyCountChanged();
    return true;
  }), [commitNotifications, currentUser, enqueueMutation, notifyCountChanged, persistReadIds, removeCachedInboxItems, storageKeys.dismissed]);

  const clearAll = useCallback(() => dismissItems(notificationsRef.current.map(notification => notification.id)), [dismissItems]);
  const dismiss = useCallback(id => dismissItems([id]), [dismissItems]);
  const dismissGroup = useCallback(ids => dismissItems(ids), [dismissItems]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications({ preserveExisting: true });
  }, [fetchNotifications]);

  return {
    notifications,
    isLoading,
    refreshing,
    loadError,
    actionError,
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
