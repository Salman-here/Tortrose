/**
 * NotificationsScreen — In-App Notification Inbox
 * Layout-only: state/persistence lives in useNotificationInbox.
 * Card rendering lives in NotificationCard / OrderGroupCard.
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  RefreshControl, Animated, Platform, UIManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import OrderGroupCard from '../components/notifications/OrderGroupCard';
import NotificationCard from '../components/notifications/NotificationCard';
import useNotificationInbox, { groupNotifications } from '../hooks/useNotificationInbox';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

if (
  Platform.OS === 'android'
  && !globalThis.nativeFabricUIManager
  && UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Website --logo-gradient (teal → sky → indigo) — the app-wide CTA gradient.
const CTA_GRADIENT = ['#14B8A6', '#0EA5E9', '#6366F1'];
// Cool indigo-forward sheen so the inbox header reads distinct from the store
// top bar (which carries a warmer violet wash).
const NOTIF_SHEEN = ['rgba(99,102,241,0.13)', 'rgba(14,165,233,0.05)', 'rgba(139,92,246,0.11)'];

const CATEGORIES = [
  { key: 'all', label: 'All', icon: 'apps-outline' },
  { key: 'order', label: 'Orders', icon: 'receipt-outline' },
  { key: 'delivery', label: 'Delivery', icon: 'bicycle-outline' },
  { key: 'promo', label: 'Promos', icon: 'pricetag-outline' },
  { key: 'seller', label: 'Seller', icon: 'storefront-outline' },
  { key: 'system', label: 'System', icon: 'information-circle-outline' },
];

export default function NotificationsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const { refreshUnreadCount } = useGlobal();
  const [activeCategory, setActiveCategory] = useState('all');

  const {
    notifications, isLoading, refreshing, readIds,
    refresh, markRead, markAllRead, clearAll, dismiss, dismissGroup,
  } = useNotificationInbox({ currentUser, onCountChange: refreshUnreadCount });

  const filtered = activeCategory === 'all'
    ? notifications
    : notifications.filter(n => n.category === activeCategory);
  const grouped = groupNotifications(filtered);

  const unreadCount = notifications.filter(n => !n.read).length;
  const unreadByCategory = {};
  notifications.forEach(n => { if (!n.read) unreadByCategory[n.category] = (unreadByCategory[n.category] || 0) + 1; });

  const handlePress = useCallback((item) => {
    markRead(item.id);
    if (item.orderId) navigation.navigate('OrderDetail', { orderId: item.orderId });
    else if (item.data?.productId) navigation.navigate('ProductDetail', { productId: item.data.productId });
    else if (item.data?.type === 'new_order_received') navigation.navigate('SellerOrderManagement');
    else if (item.data?.type === 'low_stock') navigation.navigate('SellerProductManagement');
  }, [navigation, markRead]);

  const renderRightActions = useCallback((progress, dragX) => {
    const scale = dragX.interpolate({ inputRange: [-100, 0], outputRange: [1, 0.5], extrapolate: 'clamp' });
    const opacity = dragX.interpolate({ inputRange: [-100, -20, 0], outputRange: [1, 0.7, 0], extrapolate: 'clamp' });
    return (
      <Animated.View style={[styles.swipeAction, { opacity }]}>
        <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}>
          <Ionicons name="trash-outline" size={24} color={palette.colors.white} />
          <Text style={styles.swipeActionText}>Dismiss</Text>
        </Animated.View>
      </Animated.View>
    );
  }, []);

  const renderItem = useCallback(({ item: group }) => {
    if (group.type === 'group' && group.items.length > 1) {
      const ids = group.items.map(i => i.id);
      return (
        <Swipeable
          renderRightActions={renderRightActions}
          onSwipeableOpen={() => dismissGroup(ids)}
          rightThreshold={60}
          overshootRight={false}
        >
          <OrderGroupCard group={group} onPress={handlePress} onMarkRead={markRead} readIds={readIds} />
        </Swipeable>
      );
    }
    const item = group.type === 'group' ? group.items[0] : group.item;
    return (
      <Swipeable
        renderRightActions={renderRightActions}
        onSwipeableOpen={() => dismiss(item.id)}
        rightThreshold={60}
        overshootRight={false}
      >
        <NotificationCard item={item} onPress={handlePress} />
      </Swipeable>
    );
  }, [handlePress, markRead, dismiss, dismissGroup, renderRightActions, readIds]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {/* Header */}
          <GlassPanel variant="floating" style={styles.heroHeader}>
            <LinearGradient colors={NOTIF_SHEEN} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
            <TouchableOpacity style={styles.heroBackBtn} onPress={() => { refreshUnreadCount(); navigation.goBack(); }} activeOpacity={0.75} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
            </TouchableOpacity>
            <View style={styles.heroCenter}>
              <LinearGradient colors={CTA_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.heroTitleTile}>
                <Ionicons name="notifications" size={17} color="#fff" />
              </LinearGradient>
              <Text style={styles.heroTitle}>Inbox</Text>
              {unreadCount > 0 && <View style={styles.heroBadge}><Text style={styles.heroBadgeText}>{unreadCount}</Text></View>}
            </View>
            <View style={styles.heroActions}>
              {unreadCount > 0 && (
                <TouchableOpacity style={styles.heroPrimaryBtn} onPress={markAllRead} activeOpacity={0.85} accessibilityLabel="Mark all as read" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <LinearGradient colors={CTA_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                  <Ionicons name="checkmark-done" size={18} color="#fff" />
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.heroActionBtn} onPress={() => navigation.navigate('NotificationPreferences')} accessibilityLabel="Notification settings" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="settings-outline" size={18} color={palette.colors.text} />
              </TouchableOpacity>
              {notifications.length > 0 && (
                <TouchableOpacity style={styles.heroActionBtn} onPress={clearAll} accessibilityLabel="Clear all notifications" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="trash-outline" size={18} color={palette.colors.error} />
                </TouchableOpacity>
              )}
            </View>
          </GlassPanel>

          {/* Category Filter Chips */}
          <FlatList
            horizontal
            data={CATEGORIES}
            keyExtractor={c => c.key}
            showsHorizontalScrollIndicator={false}
            style={styles.chipListBar}
            contentContainerStyle={styles.chipList}
            renderItem={({ item: cat }) => {
              const isActive = activeCategory === cat.key;
              const badge = cat.key === 'all' ? unreadCount : (unreadByCategory[cat.key] || 0);
              return (
                <TouchableOpacity style={[styles.chip, isActive && styles.chipActive]} onPress={() => setActiveCategory(cat.key)} activeOpacity={0.7}>
                  <Ionicons name={cat.icon} size={14} color={isActive ? palette.colors.white : palette.colors.textSecondary} />
                  <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{cat.label}</Text>
                  {badge > 0 && (
                    <View style={[styles.chipBadge, isActive && styles.chipBadgeActive]}>
                      <Text style={[styles.chipBadgeText, isActive && { color: palette.colors.primary }]}>{badge}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            }}
          />

          {/* Notification List */}
          {isLoading ? (
            <View style={styles.loadingContainer}>
              <Ionicons name="notifications-outline" size={40} color={palette.colors.primaryLight} />
              <Text style={styles.loadingText}>Loading notifications...</Text>
            </View>
          ) : (
            <FlatList
              data={grouped}
              keyExtractor={(item) => item.type === 'group' ? `g_${item.orderId}` : `s_${item.item.id}`}
              renderItem={renderItem}
              contentContainerStyle={[styles.listContent, grouped.length === 0 && styles.listContentEmpty]}
              showsVerticalScrollIndicator={false}
              ListHeaderComponent={
                grouped.length > 0 ? (
                  <View style={styles.swipeHint}>
                    <Ionicons name="swap-horizontal-outline" size={12} color={palette.colors.textLight} />
                    <Text style={styles.swipeHintText}>Swipe left on a notification to dismiss</Text>
                  </View>
                ) : null
              }
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <View style={styles.emptyIconWrap}><Ionicons name="notifications-off-outline" size={56} color={palette.colors.primaryLight} /></View>
                  <Text style={styles.emptyTitle}>{activeCategory === 'all' ? 'No notifications yet' : `No ${activeCategory} notifications`}</Text>
                  <Text style={styles.emptySubtitle}>We'll notify you about orders, deals, and more</Text>
                </View>
              }
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
            />
          )}
        </SafeAreaView>
      </GlassBackground>
    </GestureHandlerRootView>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
  loadingText: { fontSize: fontSize.md, color: p.colors.textSecondary },
  heroHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: 22 },
  heroBackBtn: { width: 42, height: 42, borderRadius: 14, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, justifyContent: 'center', alignItems: 'center' },
  heroCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  heroTitleTile: { width: 34, height: 34, borderRadius: 11, justifyContent: 'center', alignItems: 'center', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 4 },
  heroTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.4 },
  heroBadge: { backgroundColor: p.colors.error, borderRadius: borderRadius.full, minWidth: 24, height: 24, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6 },
  heroBadgeText: { color: p.colors.white, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  heroActionBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, justifyContent: 'center', alignItems: 'center' },
  heroPrimaryBtn: { width: 36, height: 36, borderRadius: 12, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 8, elevation: 4 },
  chipListBar: { flexGrow: 0, flexShrink: 0 },
  chipList: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  chipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  chipText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  chipTextActive: { color: p.colors.white },
  chipBadge: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(239,68,68,0.2)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4 },
  chipBadgeActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  chipBadgeText: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.error },
  listContent: { padding: spacing.md, paddingBottom: 110 },
  listContentEmpty: { flex: 1 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl },
  emptyIconWrap: { width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(99,102,241,0.1)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  emptySubtitle: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  swipeAction: { backgroundColor: p.colors.error, justifyContent: 'center', alignItems: 'center', width: 90, marginBottom: spacing.sm, borderRadius: borderRadius.lg, marginLeft: spacing.sm },
  swipeActionText: { color: p.colors.white, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, marginTop: 2 },
  swipeHint: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: spacing.sm, opacity: 0.7 },
  swipeHintText: { fontSize: fontSize.xs, color: p.colors.textLight, fontStyle: 'italic' },
});
