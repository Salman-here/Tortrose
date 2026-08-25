/**
 * NotificationCard — themed in-app notification row.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from '../common/GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';
import { formatTime } from '../../hooks/useNotificationInbox';

export const getNotificationMeta = (palette) => {
  const c = palette.colors;
  return {
    order:    { icon: 'receipt-outline', color: c.primary,   bg: c.primarySubtle },
    delivery: { icon: 'bicycle-outline', color: c.success,   bg: c.successSubtle },
    promo:    { icon: 'pricetag-outline', color: c.warning,  bg: c.warningSubtle },
    payment:  { icon: 'wallet-outline', color: c.success,    bg: c.successSubtle },
    seller:   { icon: 'storefront-outline', color: c.secondary, bg: c.secondarySubtle },
    system:   { icon: 'information-circle-outline', color: c.info, bg: c.infoSubtle },
    alert:    { icon: 'alert-circle-outline', color: c.error, bg: c.errorSubtle },
  };
};

// Backwards compat — used by OrderGroupCard
import { lightPalette } from '../../styles/palettes';
export const NOTIFICATION_META = getNotificationMeta(lightPalette);

export default function NotificationCard({ item, onPress }) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const meta = getNotificationMeta(palette)[item.category] || getNotificationMeta(palette).system;
  return (
    <TouchableOpacity onPress={() => onPress(item)} activeOpacity={0.75}>
      <GlassPanel variant="card" style={[styles.card, !item.read && styles.cardUnread]}>
        {!item.read && <View style={styles.unreadDot} />}
        <View style={[styles.icon, { backgroundColor: meta.bg }]}>
          <Ionicons name={meta.icon} size={22} color={meta.color} />
        </View>
        <View style={styles.content}>
          <Text style={[styles.title, !item.read && { fontWeight: fontWeight.bold }]} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
          <View style={styles.footer}>
            <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
            <View style={[styles.tag, { backgroundColor: meta.bg }]}>
              <Text style={[styles.tagText, { color: meta.color }]}>{item.category}</Text>
            </View>
          </View>
        </View>
      </GlassPanel>
    </TouchableOpacity>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; return StyleSheet.create({
  card: { padding: spacing.md, marginBottom: spacing.sm, flexDirection: 'row', alignItems: 'flex-start', position: 'relative', overflow: 'hidden' },
  cardUnread: { borderLeftWidth: 3, borderLeftColor: colors.primary },
  unreadDot: { position: 'absolute', top: spacing.md, right: spacing.md, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  icon: { width: 44, height: 44, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md, flexShrink: 0 },
  content: { flex: 1, paddingRight: spacing.lg },
  title: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: 2 },
  body: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 18, marginBottom: spacing.xs },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  time: { fontSize: fontSize.xs, color: colors.textLight, fontWeight: fontWeight.medium },
  tag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: borderRadius.full },
  tagText: { fontSize: 10, fontWeight: fontWeight.semibold, textTransform: 'capitalize' },
}); };
