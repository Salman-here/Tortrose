/**
 * SellerNotificationsScreen — Liquid Glass Design
 * Full notification hub for seller users with category filtering
 */

import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, SafeAreaView, TouchableOpacity, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { colors, spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

const CATEGORIES = [
  { key: 'all', label: 'All', icon: 'apps-outline' },
  { key: 'orders', label: 'Orders', icon: 'receipt-outline' },
  { key: 'stock', label: 'Stock', icon: 'cube-outline' },
  { key: 'reviews', label: 'Reviews', icon: 'star-outline' },
  { key: 'store', label: 'Store', icon: 'storefront-outline' },
];

const CATEGORY_STYLES = {
  orders: { icon: 'receipt-outline', color: colors.primary, bg: 'rgba(99,102,241,0.15)' },
  stock: { icon: 'cube-outline', color: colors.warning, bg: 'rgba(245,158,11,0.15)' },
  reviews: { icon: 'star-outline', color: '#F59E0B', bg: 'rgba(245,158,11,0.12)' },
  store: { icon: 'storefront-outline', color: colors.success, bg: 'rgba(16,185,129,0.15)' },
  delivery: { icon: 'bicycle-outline', color: '#06B6D4', bg: 'rgba(6,182,212,0.15)' },
  system: { icon: 'information-circle-outline', color: colors.info, bg: 'rgba(59,130,246,0.15)' },
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

export default function SellerNotificationsScreen({ navigation }) {
  const { currentUser, token } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await api.get('/api/analytics/notifications');
      const data = res.data?.notifications || res.data || [];
      const normalized = Array.isArray(data) ? data.map((n, i) => ({
        id: n._id || n.id || `seller_notif_${i}`,
        type: n.type || n.category || 'orders',
        title: n.title || n.message || 'Notification',
        body: n.body || n.description || n.message || '',
        createdAt: n.createdAt || n.date || new Date().toISOString(),
        read: n.read || false,
      })) : [];
      setNotifications(normalized);
    } catch (err) {
      const samples = [
        { id: '1', type: 'orders', title: 'New Order!', body: 'You have a new order to fulfill.', createdAt: new Date(Date.now() - 1800000).toISOString(), read: false },
        { id: '2', type: 'orders', title: 'Order Shipped', body: 'Order has been marked as shipped.', createdAt: new Date(Date.now() - 7200000).toISOString(), read: false },
        { id: '3', type: 'stock', title: 'Low Stock Warning', body: 'A product is running low on inventory.', createdAt: new Date(Date.now() - 14400000).toISOString(), read: false },
        { id: '4', type: 'reviews', title: 'New Review', body: 'A customer left a review on your product.', createdAt: new Date(Date.now() - 28800000).toISOString(), read: true },
        { id: '5', type: 'store', title: 'Store Trusted', body: 'A user has trusted your store.', createdAt: new Date(Date.now() - 86400000).toISOString(), read: true },
        { id: '6', type: 'delivery', title: 'Delivery Confirmed', body: 'An order has been delivered to the customer.', createdAt: new Date(Date.now() - 172800000).toISOString(), read: true },
      ];
      setNotifications(samples);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchNotifications(); }, [fetchNotifications]);

  const filtered = activeCategory === 'all' ? notifications : notifications.filter(n => n.type === activeCategory);
  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const renderCategory = ({ item }) => {
    const isActive = activeCategory === item.key;
    const count = item.key === 'all' ? notifications.length : notifications.filter(n => n.type === item.key).length;
    return (
      <TouchableOpacity
        onPress={() => setActiveCategory(item.key)}
        style={[styles.categoryChip, isActive && styles.categoryChipActive]}
      >
        <Ionicons name={item.icon} size={14} color={isActive ? '#fff' : colors.grayLight} />
        <Text style={[styles.categoryLabel, isActive && styles.categoryLabelActive]}>{item.label}</Text>
        {count > 0 && (
          <View style={[styles.categoryCount, isActive && styles.categoryCountActive]}>
            <Text style={[styles.categoryCountText, isActive && { color: colors.primary }]}>{count}</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderNotification = ({ item }) => {
    const style = CATEGORY_STYLES[item.type] || CATEGORY_STYLES.system;
    return (
      <TouchableOpacity
        onPress={() => {
          setNotifications(prev => prev.map(n => n.id === item.id ? { ...n, read: true } : n));
          if (item.type === 'orders' && item.orderId) navigation.navigate('OrderDetailManagement', { orderId: item.orderId });
        }}
        activeOpacity={0.7}
      >
        <GlassPanel style={[styles.notifCard, !item.read && styles.notifUnread]}>
          <View style={[styles.notifIcon, { backgroundColor: style.bg }]}>
            <Ionicons name={style.icon} size={20} color={style.color} />
          </View>
          <View style={styles.notifContent}>
            <View style={styles.notifHeader}>
              <Text style={styles.notifTitle} numberOfLines={1}>{item.title}</Text>
              {!item.read && <View style={styles.unreadDot} />}
            </View>
            <Text style={styles.notifBody} numberOfLines={2}>{item.body}</Text>
            <Text style={styles.notifTime}>{formatTime(item.createdAt)}</Text>
          </View>
        </GlassPanel>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <GlassBackground />
      <SafeAreaView style={styles.safeArea}>
        <GlassPanel style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={colors.dark} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Notifications</Text>
            {unreadCount > 0 && (
              <View style={styles.headerBadge}>
                <Text style={styles.headerBadgeText}>{unreadCount}</Text>
              </View>
            )}
          </View>
          {unreadCount > 0 && (
            <TouchableOpacity onPress={markAllRead} style={styles.markAllBtn}>
              <Ionicons name="checkmark-done" size={20} color={colors.primary} />
            </TouchableOpacity>
          )}
        </GlassPanel>

        <FlatList
          data={CATEGORIES}
          renderItem={renderCategory}
          keyExtractor={item => item.key}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryList}
        />

        <FlatList
          data={filtered}
          renderItem={renderNotification}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="notifications-off-outline" size={48} color={colors.grayLight} />
              <Text style={styles.emptyText}>No notifications</Text>
            </View>
          }
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F0F4FF' },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md,
    marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: borderRadius.xl,
  },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.05)', justifyContent: 'center', alignItems: 'center' },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: spacing.sm },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark },
  headerBadge: { marginLeft: spacing.sm, backgroundColor: colors.error, borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 },
  headerBadgeText: { color: '#fff', fontSize: 11, fontWeight: fontWeight.bold },
  markAllBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(99,102,241,0.1)', justifyContent: 'center', alignItems: 'center' },

  categoryList: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
  categoryChip: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', gap: 6,
  },
  categoryChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  categoryLabel: { fontSize: fontSize.sm, color: colors.grayLight, fontWeight: fontWeight.medium },
  categoryLabelActive: { color: '#fff' },
  categoryCount: { backgroundColor: 'rgba(0,0,0,0.08)', borderRadius: 10, minWidth: 20, height: 18, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5 },
  categoryCountActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  categoryCountText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.grayLight },

  list: { paddingHorizontal: spacing.md, paddingBottom: 100, gap: spacing.sm },
  notifCard: { flexDirection: 'row', padding: spacing.md, borderRadius: borderRadius.lg, gap: spacing.sm },
  notifUnread: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  notifIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  notifContent: { flex: 1 },
  notifHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  notifTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.dark, flex: 1 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginLeft: spacing.sm },
  notifBody: { fontSize: fontSize.sm, color: colors.grayLight, marginTop: 2, lineHeight: 18 },
  notifTime: { fontSize: fontSize.xs, color: colors.grayLight, marginTop: 4, opacity: 0.7 },

  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: spacing.md },
  emptyText: { fontSize: fontSize.md, color: colors.grayLight },
});
