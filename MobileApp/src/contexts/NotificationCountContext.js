/**
 * NotificationCountContext — global unread badge count.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../config/api';
import { useAuth } from './AuthContext';
import { getNotificationsModule } from '../utils/notificationRuntime';
import {
  getNotificationIdentity,
  getNotificationStorageKeys,
  isNotificationAllowedForRole,
  normalizeNotificationRole,
  scopeNotificationsForRole,
} from '../utils/notificationScope';
import {
  dedupeInboxNotifications,
  getNotificationInboxItemId,
  getPushNotificationInboxId,
} from '../utils/notificationDedupe';
import {
  parseNotificationInboxResponse,
  parseStoredNotificationReadIds,
  persistentInboxIds,
  reconcileNotificationUnreadCount,
} from '../utils/notificationInboxSafety';

const Notifications = getNotificationsModule();

const NotificationCountContext = createContext();

export const NotificationCountProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const role = normalizeNotificationRole(currentUser);
  const identity = getNotificationIdentity(currentUser);
  const activeIdentityRef = useRef(identity);
  activeIdentityRef.current = identity;
  const storageKeys = useMemo(
    () => getNotificationStorageKeys(currentUser),
    [currentUser?._id, currentUser?.id, currentUser?.role]
  );
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const notifListenerRef = useRef(null);
  const knownInboxIdsRef = useRef(new Set());
  const refreshGenerationRef = useRef(0);

  const refreshUnreadCount = useCallback(async () => {
    const requestIdentity = identity;
    const requestGeneration = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = requestGeneration;
    if (!currentUser || role === 'guest') {
      if (activeIdentityRef.current === requestIdentity) {
        knownInboxIdsRef.current = new Set();
        setUnreadNotifCount(0);
      }
      return 0;
    }
    try {
      const [storedRaw, readRaw, inboxResponse] = await Promise.all([
        AsyncStorage.getItem(storageKeys.inbox),
        AsyncStorage.getItem(storageKeys.read),
        api.get('/api/notifications/me'),
      ]);
      const snapshot = parseNotificationInboxResponse(inboxResponse.data, { currentUser });
      let cached = [];
      if (storedRaw) {
        const parsed = JSON.parse(storedRaw);
        cached = dedupeInboxNotifications(scopeNotificationsForRole(
          Array.isArray(parsed) ? parsed : [],
          currentUser
        ));
      }
      const readSet = parseStoredNotificationReadIds(readRaw);
      const reconciled = reconcileNotificationUnreadCount({
        snapshot,
        cachedNotifications: cached,
        readIds: readSet,
        currentUser,
      });
      if (
        activeIdentityRef.current === requestIdentity
        && refreshGenerationRef.current === requestGeneration
      ) {
        knownInboxIdsRef.current = new Set([
          ...persistentInboxIds(snapshot),
          ...cached.map(getNotificationInboxItemId).filter(Boolean),
        ]);
        setUnreadNotifCount(reconciled);
      }
      return reconciled;
    } catch {
      if (
        activeIdentityRef.current === requestIdentity
        && refreshGenerationRef.current === requestGeneration
      ) {
        knownInboxIdsRef.current = new Set();
        setUnreadNotifCount(0);
      }
      return 0;
    }
  }, [currentUser, identity, role, storageKeys.inbox, storageKeys.read]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    setUnreadNotifCount(0);
    knownInboxIdsRef.current = new Set();
    refreshUnreadCount();
    if (!Notifications) return undefined;
    const listenerIdentity = identity;
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      if (activeIdentityRef.current !== listenerIdentity) return;
      const data = notification?.request?.content?.data || {};
      if (!isNotificationAllowedForRole({ data, category: data.category }, currentUser)) return;
      const inboxId = getPushNotificationInboxId(notification, '');
      if (inboxId && knownInboxIdsRef.current.has(inboxId)) return;
      if (inboxId) knownInboxIdsRef.current.add(inboxId);
      setUnreadNotifCount((prev) => prev + 1);
      refreshUnreadCount();
    });
    notifListenerRef.current = subscription;
    return () => {
      subscription?.remove?.();
      if (notifListenerRef.current === subscription) notifListenerRef.current = null;
    };
  }, [currentUser, identity, refreshUnreadCount]);

  return (
    <NotificationCountContext.Provider value={{ unreadNotifCount, refreshUnreadCount }}>
      {children}
    </NotificationCountContext.Provider>
  );
};

export const useNotificationCount = () => {
  const ctx = useContext(NotificationCountContext);
  if (!ctx) throw new Error('useNotificationCount must be used within NotificationCountProvider');
  return ctx;
};
