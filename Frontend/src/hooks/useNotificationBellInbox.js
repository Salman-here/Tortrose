import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { getAuthToken } from '../utils/cookieHelper';
import {
  createNotificationRequestGuard,
  inspectAnalyticsNotificationResponse,
  inspectNotificationInboxResponse,
  mergeNotificationStreams,
  resolveNotificationAccount,
} from '../utils/notificationInboxSafety';

const EMPTY_SNAPSHOT = Object.freeze({
  accountKey: null,
  notifications: [],
  badgeCount: 0,
  loaded: false,
  error: '',
});

const inspectSellerNotificationPreferences = payload => {
  const prefs = payload?.prefs;
  if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) return null;
  const keys = ['stockAlerts', 'lowStockAlerts', 'orderAlerts', 'paymentAlerts'];
  if (keys.some(key => prefs[key] !== undefined && typeof prefs[key] !== 'boolean')) return null;
  return prefs;
};

const applySellerPreferences = (items, prefs) => items.filter(item => {
  if (item.category === 'stock' && item.type === 'critical' && prefs.stockAlerts === false) return false;
  if (item.category === 'stock' && item.type === 'warning' && prefs.lowStockAlerts === false) return false;
  if (item.category === 'order' && prefs.orderAlerts === false) return false;
  if (item.category === 'payment' && prefs.paymentAlerts === false) return false;
  return true;
});

export const useNotificationBellInbox = ({ currentUser, role }) => {
  const currentUserId = currentUser?.id;
  const currentUserUnderscoreId = currentUser?._id;
  const currentUserRole = currentUser?.role;
  const account = useMemo(() => resolveNotificationAccount({
    id: currentUserId,
    _id: currentUserUnderscoreId,
    role: currentUserRole,
  }, role), [currentUserId, currentUserUnderscoreId, currentUserRole, role]);
  const accountKey = account?.key || null;
  const inboxSurface = role === 'seller' ? 'seller' : role === 'admin' ? 'admin' : null;
  const guardRef = useRef(createNotificationRequestGuard());
  const controllerRef = useRef(null);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loadingAccountKey, setLoadingAccountKey] = useState(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    if (!account) {
      guardRef.current.activate(null);
      setSnapshot({
        ...EMPTY_SNAPSHOT,
        loaded: true,
        error: 'Notifications are unavailable because the active account could not be verified.',
      });
      setLoadingAccountKey(null);
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    const request = guardRef.current.begin(account.key);
    setLoadingAccountKey(account.key);
    try {
    const headers = { Authorization: `Bearer ${getAuthToken()}` };
    const analyticsPath = role === 'admin'
      ? 'api/analytics/admin/notifications'
      : 'api/analytics/notifications';
    const inboxPromise = axios.get(`${import.meta.env.VITE_API_URL}api/notifications/me`, {
      headers,
      signal: controller.signal,
      params: { surface: inboxSurface },
    });
    const analyticsPromise = axios.get(`${import.meta.env.VITE_API_URL}${analyticsPath}`, {
      headers,
      signal: controller.signal,
    });
    const preferencesPromise = role === 'seller'
      ? axios.get(`${import.meta.env.VITE_API_URL}api/analytics/notification-prefs`, {
        headers,
        signal: controller.signal,
      })
      : Promise.resolve(null);

    const [inboxResult, analyticsResult, preferencesResult] = await Promise.allSettled([
      inboxPromise,
      analyticsPromise,
      preferencesPromise,
    ]);
    if (!guardRef.current.isCurrent(request, account.key)) return;

    const problems = [];
    let durableItems = [];
    let inboxUnread = 0;
    if (inboxResult.status === 'fulfilled') {
      const inspectedInbox = inspectNotificationInboxResponse(
        inboxResult.value.data,
        account,
        { surface: inboxSurface },
      );
      if (inspectedInbox.valid) {
        durableItems = inspectedInbox.items;
        inboxUnread = inspectedInbox.unread;
      } else {
        problems.push('The durable inbox response could not be verified.');
      }
    } else {
      problems.push('The durable inbox could not be loaded.');
    }

    let analyticsItems = [];
    if (analyticsResult.status === 'fulfilled') {
      const inspectedAnalytics = inspectAnalyticsNotificationResponse(
        analyticsResult.value.data,
        account,
        role,
      );
      if (inspectedAnalytics.valid) analyticsItems = inspectedAnalytics.items;
      else problems.push('The operational alerts response could not be verified.');
    } else {
      problems.push('Operational alerts could not be loaded.');
    }

    if (role === 'seller') {
      const prefs = preferencesResult.status === 'fulfilled'
        ? inspectSellerNotificationPreferences(preferencesResult.value.data)
        : null;
      if (prefs) analyticsItems = applySellerPreferences(analyticsItems, prefs);
      else {
        analyticsItems = [];
        problems.push('Notification preferences could not be verified.');
      }
    }

    const notifications = mergeNotificationStreams({ durableItems, analyticsItems });
    const analyticsUnread = notifications.filter(item => (
      item._stream === 'analytics' && item.read === false
    )).length;
    const combinedUnread = inboxUnread + analyticsUnread;
    const badgeCount = Number.isSafeInteger(combinedUnread) ? combinedUnread : 0;
    if (!Number.isSafeInteger(combinedUnread)) {
      problems.push('The combined unread count is outside the supported range.');
    }
    setSnapshot({
      accountKey: account.key,
      notifications,
      badgeCount,
      loaded: true,
      error: problems.join(' '),
    });
    setLoadingAccountKey(null);
    } catch {
      if (!guardRef.current.isCurrent(request, account.key)) return;
      setSnapshot({
        accountKey: account.key,
        notifications: [],
        badgeCount: 0,
        loaded: true,
        error: 'Notifications could not be loaded.',
      });
      setLoadingAccountKey(null);
    }
  }, [account, inboxSurface, role]);

  useEffect(() => {
    const guard = guardRef.current;
    guard.activate(accountKey);
    controllerRef.current?.abort();
    setSnapshot(EMPTY_SNAPSHOT);
    setLoadingAccountKey(accountKey);
    load();
    return () => {
      controllerRef.current?.abort();
      guard.invalidate();
    };
  }, [account, accountKey, load]);

  const currentSnapshot = snapshot.accountKey === accountKey ? snapshot : EMPTY_SNAPSHOT;
  return {
    accountKey,
    notifications: currentSnapshot.notifications,
    notificationBadgeCount: currentSnapshot.badgeCount,
    notificationsLoaded: currentSnapshot.loaded,
    notificationsError: currentSnapshot.error,
    notificationsLoading: Boolean(accountKey) && (
      loadingAccountKey === accountKey || snapshot.accountKey !== accountKey
    ),
    reloadNotifications: load,
  };
};
