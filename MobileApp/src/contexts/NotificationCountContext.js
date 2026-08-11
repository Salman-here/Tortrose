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

  const refreshUnreadCount = useCallback(async () => {
    const requestIdentity = identity;
    try {
      const [storedRaw, readRaw] = await Promise.all([
        AsyncStorage.getItem(storageKeys.inbox),
        AsyncStorage.getItem(storageKeys.read),
      ]);
      const stored = scopeNotificationsForRole(storedRaw ? JSON.parse(storedRaw) : [], currentUser);
      const readSet = readRaw ? new Set(JSON.parse(readRaw)) : new Set();

      let orderUnread = 0;
      if (currentUser && (role === 'user' || role === 'seller')) {
        try {
          const res = await api.get('/api/order/user-orders');
          const orders = res.data?.orders || [];
          orders.forEach(o => {
            const status = (o.orderStatus || o.status || '').toLowerCase();
            if (status === 'delivered' && !readSet.has(`${o._id}_delivered_0`)) orderUnread++;
            if (status === 'cancelled' && !readSet.has(`${o._id}_cancelled_0`)) orderUnread++;
          });
        } catch {}
      }
      const pushUnread = stored.filter(n => !readSet.has(n.id) && !n.read).length;
      if (activeIdentityRef.current === requestIdentity) {
        setUnreadNotifCount(pushUnread + orderUnread);
      }
    } catch {
      if (activeIdentityRef.current === requestIdentity) setUnreadNotifCount(0);
    }
  }, [currentUser?._id, currentUser?.id, currentUser?.role, identity, role, storageKeys.inbox, storageKeys.read]);

  useEffect(() => {
    setUnreadNotifCount(0);
    refreshUnreadCount();
    if (!Notifications) return undefined;
    notifListenerRef.current = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification?.request?.content?.data || {};
      if (!isNotificationAllowedForRole({ data, category: data.category }, currentUser)) return;
      setUnreadNotifCount((prev) => prev + 1);
    });
    return () => {
      if (notifListenerRef.current) notifListenerRef.current.remove();
    };
  }, [currentUser?._id, currentUser?.id, currentUser?.role, refreshUnreadCount]);

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
