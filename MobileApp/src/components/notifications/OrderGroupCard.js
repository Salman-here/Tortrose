/**
 * OrderGroupCard — themed expandable card grouping all updates for a single order.
 */

import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, LayoutAnimation, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from '../common/GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';
import { formatTime } from '../../hooks/useNotificationInbox';
import { getNotificationMeta } from './NotificationCard';

export default function OrderGroupCard({ group, onPress, onMarkRead, readIds }) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const META = getNotificationMeta(palette);
  const [expanded, setExpanded] = useState(false);
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const { items, orderId } = group;
  const displayOrderId = String(group.publicOrderId || orderId.slice(-6)).toUpperCase();
  const unreadCount = items.filter(i => !i.read && !readIds.has(i.id)).length;
  const latestItem = items[0];
  const latestMeta = META[latestItem.category] || META.system;

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(!expanded);
    Animated.timing(rotateAnim, { toValue: expanded ? 0 : 1, duration: 200, useNativeDriver: true }).start();
  };

  const rotation = rotateAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  return (
    <GlassPanel variant="card" style={[styles.groupCard, unreadCount > 0 && styles.unreadBorder]}>
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.7}>
        {unreadCount > 0 && <View style={styles.unreadDot} />}
        <View style={[styles.icon, { backgroundColor: latestMeta.bg }]}>
          <Ionicons name="cube-outline" size={22} color={latestMeta.color} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title}>Order #{displayOrderId}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>{latestItem.title} · {items.length} updates</Text>
          <Text style={styles.time}>{formatTime(group.latestDate)}</Text>
        </View>
        <View style={styles.right}>
          {unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadCount}</Text>
            </View>
          )}
          <Animated.View style={{ transform: [{ rotate: rotation }] }}>
            <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
          </Animated.View>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.items}>
          {items.map((item, idx) => {
            const meta = META[item.category] || META.system;
            const isRead = item.read || readIds.has(item.id);
            return (
              <TouchableOpacity key={item.id} style={[styles.item, idx < items.length - 1 && styles.itemBorder, !isRead && styles.itemUnread]} onPress={() => onPress(item)} activeOpacity={0.7}>
                <View style={[styles.timelineDot, { backgroundColor: meta.color }]} />
                {idx < items.length - 1 && <View style={styles.timelineLine} />}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.itemTitle, !isRead && { fontWeight: fontWeight.bold }]}>{item.title}</Text>
                  <Text style={styles.itemBody} numberOfLines={1}>{item.body}</Text>
                  <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
          {unreadCount > 0 && (
            <TouchableOpacity style={styles.markReadBtn} onPress={() => onMarkRead(items.map(i => i.id))}>
              <Ionicons name="checkmark-done-outline" size={14} color={colors.primary} />
              <Text style={styles.markReadText}>Mark all read</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </GlassPanel>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; const glass = palette.glass; return StyleSheet.create({
  groupCard: { marginBottom: spacing.sm, overflow: 'hidden' },
  unreadBorder: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, position: 'relative' },
  unreadDot: { position: 'absolute', top: spacing.md, right: spacing.md, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  icon: { width: 44, height: 44, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md, flexShrink: 0 },
  headerText: { flex: 1, marginLeft: spacing.md },
  title: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 1 },
  time: { fontSize: fontSize.xs, color: colors.textLight, fontWeight: fontWeight.medium },
  right: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badge: { backgroundColor: colors.error, borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 5 },
  badgeText: { color: '#ffffff', fontSize: 10, fontWeight: fontWeight.bold },
  items: { borderTopWidth: 1, borderTopColor: glass.borderSubtle, paddingHorizontal: spacing.md },
  item: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: spacing.md, paddingLeft: spacing.lg, position: 'relative' },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: glass.borderSubtle },
  itemUnread: { backgroundColor: colors.primarySubtle },
  itemTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text },
  itemBody: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, position: 'absolute', left: 0, top: 18 },
  timelineLine: { position: 'absolute', left: 4, top: 30, width: 2, bottom: 0, backgroundColor: glass.borderSubtle },
  markReadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: glass.borderSubtle },
  markReadText: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.semibold },
}); };
