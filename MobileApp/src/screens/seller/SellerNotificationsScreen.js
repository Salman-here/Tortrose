import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  SellerEmptyState,
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';
import {
  SELLER_NOTIFICATION_CATEGORIES,
  buildAnalyticsNotificationReadKey,
  filterSellerNotifications,
  formatSellerNotificationTime,
  mergeNormalizedSellerNotifications,
  parseSellerAnalyticsNotificationsResponse,
  parseSellerInboxNotificationsResponse,
  resolveSellerNotificationTarget,
} from '../../utils/sellerNotifications';
import {
  parseNotificationReadAllResponse,
  parseNotificationReadResponse,
} from '../../utils/notificationInboxSafety';

const getNotificationVisuals = (palette) => ({
  order: {
    icon: 'receipt-outline',
    color: palette.colors.primary,
    background: palette.colors.primarySubtle,
    label: 'Order',
  },
  stock: {
    icon: 'cube-outline',
    color: palette.colors.warningDark,
    background: palette.colors.warningSubtle,
    label: 'Stock',
  },
  payment: {
    icon: 'wallet-outline',
    color: palette.colors.successDark,
    background: palette.colors.successSubtle,
    label: 'Payment',
  },
  review: {
    icon: 'star-outline',
    color: palette.colors.warningDark,
    background: palette.colors.warningSubtle,
    label: 'Review',
  },
  promotion: {
    icon: 'megaphone-outline',
    color: palette.colors.secondary,
    background: palette.colors.secondarySubtle,
    label: 'Update',
  },
  store: {
    icon: 'storefront-outline',
    color: palette.colors.successDark,
    background: palette.colors.successSubtle,
    label: 'Store',
  },
  system: {
    icon: 'information-circle-outline',
    color: palette.colors.infoDark,
    background: palette.colors.infoSubtle,
    label: 'System',
  },
});

export default function SellerNotificationsScreen({ navigation }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const notificationVisuals = useMemo(() => getNotificationVisuals(palette), [palette]);
  const analyticReadKeys = useRef(new Set());
  const accountGenerationRef = useRef(0);
  const fetchGenerationRef = useRef(0);
  const sellerId = useMemo(() => {
    const rawId = currentUser?._id || currentUser?.id;
    return currentUser?.role === 'seller' && typeof rawId === 'string' && rawId.trim() === rawId
      ? rawId
      : '';
  }, [currentUser?._id, currentUser?.id, currentUser?.role]);
  const sellerIdRef = useRef(sellerId);
  const readStorageKey = useMemo(() => {
    return sellerId ? `seller:analytics-notification-read:${sellerId}` : '';
  }, [sellerId]);

  const [notifications, setNotifications] = useState([]);
  const [notificationOwner, setNotificationOwner] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [readStateIdentity, setReadStateIdentity] = useState('');

  useEffect(() => {
    const accountGeneration = accountGenerationRef.current + 1;
    accountGenerationRef.current = accountGeneration;
    fetchGenerationRef.current += 1;
    sellerIdRef.current = sellerId;
    analyticReadKeys.current = new Set();
    setNotifications([]);
    setNotificationOwner('');
    setReadStateIdentity('');
    setActiveCategory('all');
    setRefreshing(false);
    setMarkingAll(false);
    setLoadError('');
    setActionError('');

    if (!sellerId || !readStorageKey) {
      setLoading(false);
      setLoadError('Seller notifications require an active seller account.');
      return undefined;
    }

    setLoading(true);
    let active = true;
    AsyncStorage.getItem(readStorageKey)
      .then((stored) => {
        if (
          !active
          || accountGenerationRef.current !== accountGeneration
          || sellerIdRef.current !== sellerId
        ) return;
        const parsed = stored ? JSON.parse(stored) : [];
        analyticReadKeys.current = new Set(Array.isArray(parsed) ? parsed.filter(Boolean).slice(-500) : []);
      })
      .catch(() => {
        if (
          active
          && accountGenerationRef.current === accountGeneration
          && sellerIdRef.current === sellerId
        ) analyticReadKeys.current = new Set();
      })
      .finally(() => {
        if (
          active
          && accountGenerationRef.current === accountGeneration
          && sellerIdRef.current === sellerId
        ) setReadStateIdentity(sellerId);
      });
    return () => { active = false; };
  }, [readStorageKey, sellerId]);

  const persistAnalyticsReadState = useCallback(async () => {
    if (!sellerId || !readStorageKey || sellerIdRef.current !== sellerId) {
      throw new Error('Seller notification account changed.');
    }
    const boundedKeys = Array.from(analyticReadKeys.current).slice(-500);
    analyticReadKeys.current = new Set(boundedKeys);
    await AsyncStorage.setItem(readStorageKey, JSON.stringify(boundedKeys));
  }, [readStorageKey, sellerId]);

  const fetchNotifications = useCallback(async ({ initial = false } = {}) => {
    if (!sellerId || sellerIdRef.current !== sellerId) return;
    const accountGeneration = accountGenerationRef.current;
    const fetchGeneration = fetchGenerationRef.current + 1;
    fetchGenerationRef.current = fetchGeneration;
    if (initial) setLoading(true);
    setLoadError('');

    const [analyticsResult, inboxResult] = await Promise.allSettled([
      api.get('/api/analytics/notifications'),
      api.get('/api/notifications/me?surface=seller'),
    ]);

    if (
      accountGenerationRef.current !== accountGeneration
      || fetchGenerationRef.current !== fetchGeneration
      || sellerIdRef.current !== sellerId
    ) return;

    let analyticsItems = null;
    let inboxItems = null;
    if (analyticsResult.status === 'fulfilled') {
      try {
        analyticsItems = parseSellerAnalyticsNotificationsResponse(analyticsResult.value?.data, {
          sellerId,
          analyticsReadKeys: analyticReadKeys.current,
        });
      } catch {}
    }
    if (inboxResult.status === 'fulfilled') {
      try {
        inboxItems = parseSellerInboxNotificationsResponse(inboxResult.value?.data, { sellerId });
      } catch {}
    }
    const analyticsLoaded = Array.isArray(analyticsItems);
    const inboxLoaded = Array.isArray(inboxItems);

    setNotifications(mergeNormalizedSellerNotifications(analyticsItems || [], inboxItems || []));
    setNotificationOwner(sellerId);

    if (!analyticsLoaded && !inboxLoaded) {
      setLoadError('We could not reach either notification service. Check your connection and try again.');
    } else if (!analyticsLoaded) {
      setLoadError('Your inbox loaded, but live order and stock alerts are temporarily unavailable.');
    } else if (!inboxLoaded) {
      setLoadError('Live seller alerts loaded, but saved announcements are temporarily unavailable.');
    }

    setLoading(false);
    setRefreshing(false);
  }, [sellerId]);

  useEffect(() => {
    if (sellerId && readStateIdentity === sellerId) fetchNotifications({ initial: true });
  }, [fetchNotifications, readStateIdentity, sellerId]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, [fetchNotifications]);

  const visibleNotifications = notificationOwner === sellerId ? notifications : [];
  const unreadCount = useMemo(
    () => visibleNotifications.reduce((count, notification) => count + (notification.read ? 0 : 1), 0),
    [visibleNotifications],
  );
  const filteredNotifications = useMemo(
    () => filterSellerNotifications(visibleNotifications, activeCategory),
    [activeCategory, visibleNotifications],
  );
  const categoryCounts = useMemo(() => {
    const counts = { all: visibleNotifications.length };
    visibleNotifications.forEach(({ category }) => {
      counts[category] = (counts[category] || 0) + 1;
    });
    return counts;
  }, [visibleNotifications]);

  const markNotificationRead = useCallback((notification) => {
    if (notification.read || !sellerId || sellerIdRef.current !== sellerId) return;
    const accountGeneration = accountGenerationRef.current;
    const accountIsCurrent = () => (
      accountGenerationRef.current === accountGeneration
      && sellerIdRef.current === sellerId
    );

    setActionError('');
    if (!notification.persisted) {
      const readKey = buildAnalyticsNotificationReadKey(notification);
      if (readKey) analyticReadKeys.current.add(readKey);
      persistAnalyticsReadState().catch(() => {
        if (accountIsCurrent()) {
          if (readKey) analyticReadKeys.current.delete(readKey);
          setNotifications((current) => current.map((item) => (
            item.id === notification.id ? { ...item, read: false } : item
          )));
          setActionError('The alert opened, but its read status could not be saved on this device.');
        }
      });
    }
    setNotifications((current) => current.map((item) => (
      item.id === notification.id ? { ...item, read: true } : item
    )));

    if (!notification.persisted) return;
    if (!notification.backendId) {
      setNotifications((current) => current.map((item) => (
        item.id === notification.id ? { ...item, read: false } : item
      )));
      setActionError('This saved notification is missing its server identifier and could not be marked as read.');
      return;
    }

    api.patch(`/api/notifications/${encodeURIComponent(notification.backendId)}/read?surface=seller`)
      .then((response) => parseNotificationReadResponse(response.data, {
        currentUser,
        notificationId: notification.backendId,
        expectedSurface: 'seller',
      }))
      .catch(() => {
        if (!accountIsCurrent()) return;
        setNotifications((current) => current.map((item) => (
          item.id === notification.id ? { ...item, read: false } : item
        )));
        setActionError('The notification opened, but its read status could not be saved.');
      });
  }, [currentUser, persistAnalyticsReadState, sellerId]);

  const handleNotificationPress = useCallback((notification) => {
    markNotificationRead(notification);
    const target = resolveSellerNotificationTarget(notification);
    if (target) navigation.navigate(target.screen, target.params);
  }, [markNotificationRead, navigation]);

  const markAllRead = useCallback(async () => {
    if (
      markingAll
      || unreadCount === 0
      || !sellerId
      || sellerIdRef.current !== sellerId
    ) return;
    const accountGeneration = accountGenerationRef.current;
    const accountIsCurrent = () => (
      accountGenerationRef.current === accountGeneration
      && sellerIdRef.current === sellerId
    );

    const previousReadState = new Map(
      visibleNotifications.filter(({ persisted }) => persisted).map(({ id, read }) => [id, read]),
    );
    const previousAnalyticsReadState = new Map(
      visibleNotifications.filter(({ persisted }) => !persisted).map(({ id, read }) => [id, read]),
    );
    const persistedUnread = visibleNotifications.some(({ persisted, read }) => persisted && !read);

    const analyticsUnread = visibleNotifications
      .filter(({ persisted, read }) => !persisted && !read)
      .map((notification) => buildAnalyticsNotificationReadKey(notification))
      .filter(Boolean);
    analyticsUnread.forEach((readKey) => analyticReadKeys.current.add(readKey));
    setActionError('');
    setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));

    setMarkingAll(true);
    if (analyticsUnread.length) {
      try {
        await persistAnalyticsReadState();
      } catch {
        if (accountIsCurrent()) {
          analyticsUnread.forEach((readKey) => analyticReadKeys.current.delete(readKey));
          setNotifications((current) => current.map((notification) => (
            !notification.persisted && previousAnalyticsReadState.has(notification.id)
              ? { ...notification, read: previousAnalyticsReadState.get(notification.id) }
              : notification
          )));
          setActionError('Some alerts could not be marked as read on this device. Please retry.');
        }
      }
    }

    if (!persistedUnread) {
      if (accountIsCurrent()) setMarkingAll(false);
      return;
    }

    try {
      const response = await api.post('/api/notifications/read-all?surface=seller');
      parseNotificationReadAllResponse(response.data, {
        currentUser,
        expectedSurface: 'seller',
      });
    } catch {
      if (!accountIsCurrent()) return;
      setNotifications((current) => current.map((notification) => (
        notification.persisted && previousReadState.has(notification.id)
          ? { ...notification, read: previousReadState.get(notification.id) }
          : notification
      )));
      setActionError('Saved seller inbox items could not be marked as read. Please retry.');
    } finally {
      if (accountIsCurrent()) setMarkingAll(false);
    }
  }, [currentUser, markingAll, persistAnalyticsReadState, sellerId, unreadCount, visibleNotifications]);

  const renderCategory = useCallback((category) => {
    const active = category.key === activeCategory;
    const count = categoryCounts[category.key] || 0;
    return (
      <TouchableOpacity
        key={category.key}
        style={[styles.categoryChip, active && styles.categoryChipActive]}
        onPress={() => setActiveCategory(category.key)}
        activeOpacity={0.76}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={`${category.label}, ${count} notifications`}
      >
        <Ionicons
          name={category.icon}
          size={15}
          color={active ? '#fff' : palette.colors.textSecondary}
        />
        <Text style={[styles.categoryLabel, active && styles.categoryLabelActive]}>{category.label}</Text>
        {count > 0 && (
          <View style={[styles.categoryCount, active && styles.categoryCountActive]}>
            <Text style={[styles.categoryCountText, active && styles.categoryCountTextActive]}>
              {count > 99 ? '99+' : count}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  }, [activeCategory, categoryCounts, palette.colors.textSecondary, styles]);

  const renderNotification = useCallback(({ item }) => {
    const visual = notificationVisuals[item.category] || notificationVisuals.system;
    const target = resolveSellerNotificationTarget(item);
    const critical = item.severity === 'critical';
    return (
      <TouchableOpacity
        onPress={() => handleNotificationPress(item)}
        activeOpacity={0.78}
        accessibilityRole="button"
        accessibilityLabel={`${item.read ? '' : 'Unread. '}${item.title}. ${item.body}`}
        accessibilityHint={target ? 'Opens the related seller screen' : 'Marks this notification as read'}
      >
        <GlassPanel
          variant="card"
          style={[
            styles.notificationCard,
            !item.read && styles.notificationCardUnread,
            critical && styles.notificationCardCritical,
          ]}
        >
          <View style={[styles.notificationIcon, { backgroundColor: visual.background }]}>
            <Ionicons
              name={critical ? 'alert-circle-outline' : visual.icon}
              size={21}
              color={critical ? palette.colors.error : visual.color}
            />
          </View>
          <View style={styles.notificationContent}>
            <View style={styles.notificationMetaRow}>
              <View style={[styles.categoryPill, { backgroundColor: visual.background }]}>
                <Text style={[styles.categoryPillText, { color: visual.color }]}>{visual.label}</Text>
              </View>
              <Text style={styles.notificationTime}>{formatSellerNotificationTime(item.createdAt)}</Text>
              {!item.read && <View style={styles.unreadDot} accessibilityLabel="Unread" />}
            </View>
            <Text style={styles.notificationTitle} numberOfLines={2}>{item.title}</Text>
            {!!item.body && <Text style={styles.notificationBody} numberOfLines={3}>{item.body}</Text>}
            <View style={styles.notificationFooter}>
              <Text style={styles.sourceLabel}>
                {item.persisted ? 'Seller inbox' : 'Live seller activity'}
              </Text>
              {!!target && (
                <View style={styles.openHint}>
                  <Text style={styles.openHintText}>Open</Text>
                  <Ionicons name="arrow-forward" size={13} color={palette.colors.primary} />
                </View>
              )}
            </View>
          </View>
        </GlassPanel>
      </TouchableOpacity>
    );
  }, [handleNotificationPress, notificationVisuals, palette.colors.error, palette.colors.primary, styles]);

  if (loading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Seller Notifications"
        subtitle="Orders, stock and store activity"
        icon="notifications-outline"
        variant="list"
        rows={5}
      />
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Seller Notifications"
          subtitle="Orders, stock and store activity"
          icon="notifications-outline"
          rightIcon="options-outline"
          rightLabel="Preferences"
          rightBadge={unreadCount}
          onRightPress={() => navigation.navigate('NotificationSettings', { isAdmin: false })}
        />

        <View style={styles.controls}>
          <GlassPanel variant="strong" style={styles.summaryCard}>
            <View style={styles.summaryIcon}>
              <Ionicons name="notifications-outline" size={22} color={palette.colors.primary} />
            </View>
            <View style={styles.summaryCopy}>
              <Text style={styles.summaryEyebrow}>SELLER INBOX</Text>
              <Text style={styles.summaryTitle}>
                {unreadCount > 0 ? `${unreadCount} unread update${unreadCount === 1 ? '' : 's'}` : 'You are all caught up'}
              </Text>
              <Text style={styles.summarySubtitle}>Live activity and saved announcements in one place.</Text>
            </View>
            <TouchableOpacity
              style={[styles.markAllButton, (unreadCount === 0 || markingAll) && styles.buttonDisabled]}
              onPress={markAllRead}
              disabled={unreadCount === 0 || markingAll}
              activeOpacity={0.76}
              accessibilityRole="button"
              accessibilityLabel="Mark all notifications as read"
              accessibilityState={{ disabled: unreadCount === 0 || markingAll }}
            >
              <Ionicons name="checkmark-done" size={17} color={palette.colors.primary} />
              <Text style={styles.markAllText}>{markingAll ? 'Saving' : 'Read all'}</Text>
            </TouchableOpacity>
          </GlassPanel>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categories}
            accessibilityRole="tablist"
          >
            {SELLER_NOTIFICATION_CATEGORIES.map(renderCategory)}
          </ScrollView>
        </View>

        <FlatList
          data={filteredNotifications}
          renderItem={renderNotification}
          keyExtractor={({ id }) => id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.notificationList}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={palette.colors.primary}
              colors={[palette.colors.primary]}
            />
          )}
          ListHeaderComponent={(
            <View>
              {(loadError && visibleNotifications.length > 0) && (
                <SellerInlineError
                  compact
                  title="Some notifications are unavailable"
                  message={loadError}
                  onRetry={onRefresh}
                />
              )}
              {!!actionError && (
                <SellerInlineError
                  compact
                  title="Read status was not saved"
                  message={actionError}
                  onRetry={onRefresh}
                />
              )}
              <SellerSectionHeader
                title={activeCategory === 'all'
                  ? 'Latest activity'
                  : SELLER_NOTIFICATION_CATEGORIES.find(({ key }) => key === activeCategory)?.label}
                subtitle={`${filteredNotifications.length} result${filteredNotifications.length === 1 ? '' : 's'}`}
                icon="sparkles-outline"
              />
            </View>
          )}
          ListEmptyComponent={(
            <SellerEmptyState
              icon={loadError ? 'cloud-offline-outline' : 'notifications-off-outline'}
              title={loadError ? 'Notifications unavailable' : 'Nothing here yet'}
              message={loadError || (activeCategory === 'all'
                ? 'New order, stock, payment and store updates will appear here.'
                : 'There are no notifications in this category right now.')}
              actionLabel={loadError ? 'Try again' : undefined}
              onAction={loadError ? onRefresh : undefined}
            />
          )}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  controls: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: borderRadius.xxl,
  },
  summaryIcon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  summaryCopy: { flex: 1 },
  summaryEyebrow: {
    fontSize: 9,
    letterSpacing: 1.1,
    fontWeight: fontWeight.extrabold,
    color: p.colors.primary,
  },
  summaryTitle: {
    marginTop: 2,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
  },
  summarySubtitle: {
    marginTop: 3,
    fontSize: fontSize.xs,
    lineHeight: 16,
    color: p.colors.textSecondary,
  },
  markAllButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  markAllText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  buttonDisabled: { opacity: 0.45 },
  categories: { paddingVertical: spacing.md, gap: spacing.sm },
  categoryChip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: p.glass.bg,
    borderWidth: 1,
    borderColor: p.glass.border,
  },
  categoryChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  categoryLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  categoryLabelActive: { color: '#fff' },
  categoryCount: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.surfaceHover,
  },
  categoryCountActive: { backgroundColor: 'rgba(255,255,255,0.24)' },
  categoryCountText: { fontSize: 9, fontWeight: fontWeight.extrabold, color: p.colors.textSecondary },
  categoryCountTextActive: { color: '#fff' },
  notificationList: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: 96,
    gap: spacing.sm,
  },
  notificationCard: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.xl,
  },
  notificationCardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: p.colors.primary,
    backgroundColor: p.glass.bgStrong,
  },
  notificationCardCritical: { borderColor: `${p.colors.error}45` },
  notificationIcon: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationContent: { flex: 1, minWidth: 0 },
  notificationMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  categoryPill: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: borderRadius.full },
  categoryPillText: { fontSize: 9, fontWeight: fontWeight.extrabold, textTransform: 'uppercase' },
  notificationTime: { flex: 1, fontSize: fontSize.xs, color: p.colors.textLight },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: p.colors.primary },
  notificationTitle: {
    marginTop: spacing.sm,
    fontSize: fontSize.md,
    lineHeight: 19,
    fontWeight: fontWeight.bold,
    color: p.colors.text,
  },
  notificationBody: {
    marginTop: 3,
    fontSize: fontSize.sm,
    lineHeight: 18,
    color: p.colors.textSecondary,
  },
  notificationFooter: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sourceLabel: { fontSize: 9, fontWeight: fontWeight.medium, color: p.colors.textLight },
  openHint: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  openHintText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
});
