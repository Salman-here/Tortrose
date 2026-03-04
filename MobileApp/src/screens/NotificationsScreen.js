/**
 * NotificationsScreen — Liquid Glass Design
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, FlatList, StyleSheet, SafeAreaView, TouchableOpacity, RefreshControl } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';

const NOTIF_READ_KEY = 'notifications_read_ids';
const NOTIF_DISMISSED_KEY = 'notifications_dismissed_ids';

const NOTIFICATION_TYPES = {
  order: { icon: 'receipt-outline', color: colors.primary, bg: 'rgba(99,102,241,0.15)' },
  delivery: { icon: 'bicycle-outline', color: colors.success, bg: 'rgba(16,185,129,0.15)' },
  promo: { icon: 'pricetag-outline', color: colors.warning, bg: 'rgba(245,158,11,0.15)' },
  system: { icon: 'information-circle-outline', color: colors.info, bg: 'rgba(59,130,246,0.15)' },
  alert: { icon: 'alert-circle-outline', color: colors.error, bg: 'rgba(239,68,68,0.15)' },
};

function formatTime(dateStr) {
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

function buildNotificationsFromOrders(orders) {
  const items = [];
  let id = 0;
  orders.forEach((order) => {
    const shortId = (order._id || '').slice(-6).toUpperCase();
    const status = (order.orderStatus || order.status || '').toLowerCase();
    const createdAt = order.createdAt || new Date().toISOString();
    items.push({ id: `${order._id}_placed_${id++}`, orderId: order._id, type: 'order', title: 'Order Confirmed', body: `Order #${shortId} is being processed.`, createdAt, read: true });
    if (['shipped', 'out_for_delivery', 'delivered'].includes(status)) items.push({ id: `${order._id}_shipped_${id++}`, orderId: order._id, type: 'delivery', title: 'Order Shipped', body: `Order #${shortId} is on its way.`, createdAt: order.shippedAt || createdAt, read: status === 'delivered' });
    if (status === 'delivered') items.push({ id: `${order._id}_delivered_${id++}`, orderId: order._id, type: 'order', title: 'Order Delivered ✅', body: `Order #${shortId} has been delivered!`, createdAt: order.deliveredAt || createdAt, read: false });
    if (status === 'cancelled') items.push({ id: `${order._id}_cancelled_${id++}`, orderId: order._id, type: 'alert', title: 'Order Cancelled', body: `Order #${shortId} has been cancelled.`, createdAt: order.updatedAt || createdAt, read: false });
  });
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export default function NotificationsScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const readIds = useRef(new Set());
  const dismissedIds = useRef(new Set());

  useEffect(() => {
    (async () => {
      try {
        const [r, d] = await Promise.all([AsyncStorage.getItem(NOTIF_READ_KEY), AsyncStorage.getItem(NOTIF_DISMISSED_KEY)]);
        if (r) readIds.current = new Set(JSON.parse(r));
        if (d) dismissedIds.current = new Set(JSON.parse(d));
      } catch (e) {}
    })();
  }, []);

  const fetchNotifications = useCallback(async () => {
    if (!currentUser) { setIsLoading(false); return; }
    try {
      const res = await api.get('/api/order/user-orders');
      const built = buildNotificationsFromOrders(res.data?.orders || []);
      setNotifications(built.filter(n => !dismissedIds.current.has(n.id)).map(n => readIds.current.has(n.id) ? { ...n, read: true } : n));
    } catch { setNotifications([{ id: 'welcome', type: 'system', title: 'Welcome to Tortrose 👋', body: 'Start shopping to see notifications here.', createdAt: new Date().toISOString(), read: false }]); }
    finally { setIsLoading(false); setRefreshing(false); }
  }, [currentUser]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const handlePress = useCallback((item) => {
    readIds.current.add(item.id);
    setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, read: true } : n));
    AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current])).catch(() => {});
    if (item.orderId) navigation.navigate('OrderDetail', { orderId: item.orderId });
  }, [navigation]);

  const handleDismiss = useCallback((id) => {
    dismissedIds.current.add(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
    AsyncStorage.setItem(NOTIF_DISMISSED_KEY, JSON.stringify([...dismissedIds.current])).catch(() => {});
  }, []);

  const handleMarkAllRead = useCallback(() => {
    setNotifications(prev => { prev.forEach(n => readIds.current.add(n.id)); AsyncStorage.setItem(NOTIF_READ_KEY, JSON.stringify([...readIds.current])).catch(() => {}); return prev.map(n => ({ ...n, read: true })); });
  }, []);

  const renderItem = useCallback(({ item }) => {
    const tc = NOTIFICATION_TYPES[item.type] || NOTIFICATION_TYPES.system;
    return (
      <TouchableOpacity onPress={() => handlePress(item)} activeOpacity={0.75}>
        <GlassPanel variant="card" style={[styles.notifCard, !item.read && styles.notifCardUnread]}>
          {!item.read && <View style={styles.unreadDot} />}
          <View style={[styles.notifIcon, { backgroundColor: tc.bg }]}>
            <Ionicons name={tc.icon} size={22} color={tc.color} />
          </View>
          <View style={styles.notifContent}>
            <Text style={styles.notifTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.notifBody} numberOfLines={2}>{item.body}</Text>
            <Text style={styles.notifTime}>{formatTime(item.createdAt)}</Text>
          </View>
          <TouchableOpacity style={styles.dismissBtn} onPress={() => handleDismiss(item.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={16} color="rgba(255,255,255,0.3)" />
          </TouchableOpacity>
        </GlassPanel>
      </TouchableOpacity>
    );
  }, [handlePress, handleDismiss]);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <GlassPanel variant="floating" style={styles.heroHeader}>
          <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.heroCenter}>
            <Text style={styles.heroTitle}>Notifications</Text>
            {unreadCount > 0 && <View style={styles.heroBadge}><Text style={styles.heroBadgeText}>{unreadCount} new</Text></View>}
          </View>
          {unreadCount > 0 ? (
            <TouchableOpacity style={styles.heroAction} onPress={handleMarkAllRead}><Text style={styles.heroActionText}>Mark all read</Text></TouchableOpacity>
          ) : <View style={{ width: 80 }} />}
        </GlassPanel>

        {isLoading ? (
          <View style={styles.loadingContainer}>
            <Ionicons name="notifications-outline" size={40} color={colors.primaryLight} />
            <Text style={styles.loadingText}>Loading notifications...</Text>
          </View>
        ) : (
          <FlatList
            data={notifications}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={[styles.listContent, notifications.length === 0 && styles.listContentEmpty]}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <View style={styles.emptyIconWrap}><Ionicons name="notifications-off-outline" size={56} color={colors.primaryLight} /></View>
                <Text style={styles.emptyTitle}>No notifications yet</Text>
                <Text style={styles.emptySubtitle}>We'll notify you about orders, deals, and more</Text>
              </View>
            }
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchNotifications(); }} colors={[colors.primary]} tintColor={colors.primary} />}
          />
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
  loadingText: { fontSize: fontSize.md, color: colors.textSecondary },
  heroHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm },
  heroBackBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  heroCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: spacing.md, gap: spacing.sm },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  heroBadge: { backgroundColor: colors.error, borderRadius: borderRadius.full, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  heroBadgeText: { color: colors.white, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  heroAction: { backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: borderRadius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  heroActionText: { color: colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  listContent: { padding: spacing.md },
  listContentEmpty: { flex: 1 },
  notifCard: { padding: spacing.md, marginBottom: spacing.sm, flexDirection: 'row', alignItems: 'flex-start', position: 'relative', overflow: 'hidden' },
  notifCardUnread: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  unreadDot: { position: 'absolute', top: spacing.md, right: spacing.md, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  notifIcon: { width: 44, height: 44, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md, flexShrink: 0 },
  notifContent: { flex: 1, paddingRight: spacing.lg },
  notifTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: 2 },
  notifBody: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 18, marginBottom: spacing.xs },
  notifTime: { fontSize: fontSize.xs, color: colors.textLight, fontWeight: fontWeight.medium },
  dismissBtn: { position: 'absolute', top: spacing.sm, right: spacing.sm, padding: spacing.xs },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl },
  emptyIconWrap: { width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(99,102,241,0.1)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  emptySubtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
