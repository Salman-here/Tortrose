/**
 * NotificationsScreen
 * Displays user notifications with modern design
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';

const NOTIF_READ_KEY = 'notifications_read_ids';
const NOTIF_DISMISSED_KEY = 'notifications_dismissed_ids';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
} from '../styles/theme';

// Notification type config
const NOTIFICATION_TYPES = {
  order: { icon: 'receipt-outline', color: colors.primary, bg: colors.primarySubtle },
  delivery: { icon: 'bicycle-outline', color: colors.success, bg: colors.successSubtle },
  promo: { icon: 'pricetag-outline', color: colors.warning, bg: colors.warningSubtle },
  system: { icon: 'information-circle-outline', color: colors.info, bg: colors.infoSubtle },
  alert: { icon: 'alert-circle-outline', color: colors.error, bg: colors.errorSubtle },
};

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function NotificationItem({ item, onPress, onDismiss }) {
  const typeConfig = NOTIFICATION_TYPES[item.type] || NOTIFICATION_TYPES.system;

  return (
    <TouchableOpacity
      style={[styles.notifCard, !item.read && styles.notifCardUnread]}
      onPress={() => onPress(item)}
      activeOpacity={0.75}
    >
      {!item.read && <View style={styles.unreadDot} />}
      <View style={[styles.notifIcon, { backgroundColor: typeConfig.bg }]}>
        <Ionicons name={typeConfig.icon} size={22} color={typeConfig.color} />
      </View>
      <View style={styles.notifContent}>
        <Text style={styles.notifTitle} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.notifBody} numberOfLines={2}>{item.body}</Text>
        <Text style={styles.notifTime}>{formatTime(item.createdAt)}</Text>
      </View>
      <TouchableOpacity style={styles.dismissBtn} onPress={() => onDismiss(item.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Ionicons name="close" size={16} color={colors.grayLight} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function EmptyNotifications() {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="notifications-off-outline" size={56} color={colors.primaryLight} />
      </View>
      <Text style={styles.emptyTitle}>No notifications yet</Text>
      <Text style={styles.emptySubtitle}>We'll notify you about orders, deals, and more</Text>
    </View>
  );
}

/**
 * Build notification items from an order object.
 * Each order can generate 1–3 notification events based on its status.
 */
function buildNotificationsFromOrders(orders) {
  const items = [];
  let idCounter = 0;

  orders.forEach((order) => {
    const shortId = (order._id || '').slice(-6).toUpperCase() || 'ORDER';
    const status = (order.orderStatus || order.status || '').toLowerCase();
    const createdAt = order.createdAt || new Date().toISOString();

    // Order placed notification
    items.push({
      id: `${order._id}_placed_${idCounter++}`,
      orderId: order._id,
      type: 'order',
      title: 'Order Confirmed',
      body: `Your order #${shortId} has been confirmed and is being processed.`,
      createdAt,
      read: true,
    });

    // Shipped notification
    if (['shipped', 'out_for_delivery', 'delivered'].includes(status)) {
      items.push({
        id: `${order._id}_shipped_${idCounter++}`,
        orderId: order._id,
        type: 'delivery',
        title: 'Order Shipped',
        body: `Your order #${shortId} has been shipped and is on its way.`,
        createdAt: order.shippedAt || createdAt,
        read: status === 'delivered',
      });
    }

    // Out for delivery notification
    if (['out_for_delivery', 'delivered'].includes(status)) {
      items.push({
        id: `${order._id}_out_${idCounter++}`,
        orderId: order._id,
        type: 'delivery',
        title: 'Out for Delivery',
        body: `Your order #${shortId} is out for delivery. Expected today!`,
        createdAt: order.outForDeliveryAt || createdAt,
        read: status === 'delivered',
      });
    }

    // Delivered notification
    if (status === 'delivered') {
      items.push({
        id: `${order._id}_delivered_${idCounter++}`,
        orderId: order._id,
        type: 'order',
        title: 'Order Delivered ✅',
        body: `Your order #${shortId} has been delivered. Enjoy your purchase!`,
        createdAt: order.deliveredAt || createdAt,
        read: false,
      });
    }

    // Cancelled notification
    if (status === 'cancelled') {
      items.push({
        id: `${order._id}_cancelled_${idCounter++}`,
        orderId: order._id,
        type: 'alert',
        title: 'Order Cancelled',
        body: `Your order #${shortId} has been cancelled. Contact support if needed.`,
        createdAt: order.updatedAt || createdAt,
        read: false,
      });
    }
  });

  // Sort by date descending (newest first)
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export default function NotificationsScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Track which ids have been read/dismissed — persisted via AsyncStorage
  const readIds = useRef(new Set());
  const dismissedIds = useRef(new Set());

  // Load persisted read/dismissed ids from AsyncStorage on mount
  useEffect(() => {
    const loadPersistedState = async () => {
      try {
        const [readRaw, dismissedRaw] = await Promise.all([
          AsyncStorage.getItem(NOTIF_READ_KEY),
          AsyncStorage.getItem(NOTIF_DISMISSED_KEY),
        ]);
        if (readRaw) readIds.current = new Set(JSON.parse(readRaw));
        if (dismissedRaw) dismissedIds.current = new Set(JSON.parse(dismissedRaw));
      } catch (err) {
        console.error('Failed to load notification state:', err);
      }
    };
    loadPersistedState();
  }, []);

  const fetchNotifications = useCallback(async () => {
    if (!currentUser) {
      setIsLoading(false);
      return;
    }
    try {
      const res = await api.get('/api/order/user-orders');
      const orders = res.data?.orders || [];
      const built = buildNotificationsFromOrders(orders);

      // Apply local read/dismiss state
      const filtered = built
        .filter(n => !dismissedIds.current.has(n.id))
        .map(n => readIds.current.has(n.id) ? { ...n, read: true } : n);

      setNotifications(filtered);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
      // Show welcome message for new users / on error
      setNotifications([{
        id: 'welcome',
        type: 'system',
        title: 'Welcome to Tortrose 👋',
        body: 'Start shopping to see order notifications here.',
        createdAt: new Date().toISOString(),
        read: false,
      }]);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const handlePress = useCallback((item) => {
    readIds.current.add(item.id);
    setNotifications(prev =>
      prev.map(n => n.id === item.id ? { ...n, read: true } : n)
    );
    // Persist read state
    AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current])).catch(() => {});
    if (item.orderId) {
      navigation.navigate('OrderDetail', { orderId: item.orderId });
    }
  }, [navigation]);

  const handleDismiss = useCallback((id) => {
    dismissedIds.current.add(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
    // Persist dismissed state
    AsyncStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify([...dismissedIds.current])).catch(() => {});
  }, []);

  const handleMarkAllRead = useCallback(() => {
    setNotifications(prev => {
      prev.forEach(n => readIds.current.add(n.id));
      // Persist read state
      AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current])).catch(() => {});
      return prev.map(n => ({ ...n, read: true }));
    });
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, [fetchNotifications]);

  const renderItem = useCallback(({ item }) => (
    <NotificationItem item={item} onPress={handlePress} onDismiss={handleDismiss} />
  ), [handlePress, handleDismiss]);

  const keyExtractor = useCallback((item) => item.id, []);

  const heroHeader = (
    <View style={styles.heroHeader}>
      <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
        <Ionicons name="arrow-back" size={22} color={colors.white} />
      </TouchableOpacity>
      <View style={styles.heroCenter}>
        <Text style={styles.heroTitle}>Notifications</Text>
        {unreadCount > 0 && (
          <View style={styles.heroBadge}>
            <Text style={styles.heroBadgeText}>{unreadCount} new</Text>
          </View>
        )}
      </View>
      {unreadCount > 0 ? (
        <TouchableOpacity style={styles.heroAction} onPress={handleMarkAllRead} activeOpacity={0.7}>
          <Text style={styles.heroActionText}>Mark all read</Text>
        </TouchableOpacity>
      ) : (
        <View style={{ width: 80 }} />
      )}
    </View>
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        {heroHeader}
        <View style={styles.loadingContainer}>
          <Ionicons name="notifications-outline" size={40} color={colors.primaryLight} />
          <Text style={styles.loadingText}>Loading notifications...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {heroHeader}

      <FlatList
        data={notifications}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, notifications.length === 0 && styles.listContentEmpty]}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={EmptyNotifications}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListFooterComponent={<View style={styles.listFooter} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  loadingText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  heroHeader: {
    backgroundColor: colors.primaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  heroBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.md,
    gap: spacing.sm,
  },
  heroTitle: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  heroBadge: {
    backgroundColor: colors.error,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  heroBadgeText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  heroAction: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  heroActionText: {
    color: colors.white,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  listContent: {
    padding: spacing.md,
  },
  listContentEmpty: {
    flex: 1,
  },
  listFooter: {
    height: spacing.xxl,
  },
  notifCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'flex-start',
    ...shadows.sm,
    position: 'relative',
    overflow: 'hidden',
  },
  notifCardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  unreadDot: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  notifIcon: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
    flexShrink: 0,
  },
  notifContent: {
    flex: 1,
    paddingRight: spacing.lg,
  },
  notifTitle: {
    ...typography.bodySemibold,
    color: colors.text,
    marginBottom: 2,
  },
  notifBody: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  notifTime: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    fontWeight: fontWeight.medium,
  },
  dismissBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    padding: spacing.xs,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xxl,
  },
  emptyIconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.primarySubtle,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    ...typography.h3,
    color: colors.text,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
});
