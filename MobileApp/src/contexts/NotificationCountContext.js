/**
 * NotificationCountContext — global unread badge count.
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../config/api';
import { useAuth } from './AuthContext';
import { getNotificationsModule } from '../utils/notificationRuntime';

const Notifications = getNotificationsModule();

const NOTIF_STORE_KEY = 'notification_inbox';
const NOTIF_READ_KEY = 'notifications_read_ids';

const NotificationCountContext = createContext();

export const NotificationCountProvider = ({ children }) => {
  const { currentUser } = useAuth();
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const notifListenerRef = useRef(null);

  const refreshUnreadCount = useCallback(async () => {
    try {
      const [storedRaw, readRaw] = await Promise.all([
        AsyncStorage.getItem(NOTIF_STORE_KEY),
        AsyncStorage.getItem(NOTIF_READ_KEY),
      ]);
      const stored = storedRaw ? JSON.parse(storedRaw) : [];
      const readSet = readRaw ? new Set(JSON.parse(readRaw)) : new Set();

      let orderUnread = 0;
      if (currentUser) {
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
      setUnreadNotifCount(pushUnread + orderUnread);
    } catch {
      setUnreadNotifCount(0);
    }
  }, [currentUser]);

  useEffect(() => {
    refreshUnreadCount();
    if (!Notifications) return undefined;
    notifListenerRef.current = Notifications.addNotificationReceivedListener(() => {
      setUnreadNotifCount(prev => prev + 1);
    });
    return () => {
      if (notifListenerRef.current) notifListenerRef.current.remove();
    };
  }, [refreshUnreadCount]);

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
