/**
 * OrderCard Component — Liquid Glass Design
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from './GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, statusColors, typography,
} from '../../styles/theme';

const OrderCard = ({ order, onPress, showCustomer = false, showItems = false, style }) => {
  if (!order) return null;
  const { _id, orderItems = [], orderSummary = {}, status = 'pending', createdAt, user, shippingInfo } = order;

  const formatOrderId = (id) => id ? `#${id.slice(-8).toUpperCase()}` : 'N/A';
  const formatDate = (d) => {
    if (!d) return 'N/A';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const formatPrice = (p) => typeof p === 'number' ? `$${p.toFixed(2)}` : '$0.00';
  const getStatusStyle = (s) => statusColors[s?.toLowerCase()] || statusColors.pending;

  const statusStyle = getStatusStyle(status);
  const itemCount = orderItems.reduce((sum, item) => sum + (item.qty || 1), 0);
  const customerName = showCustomer ? (user?.name || shippingInfo?.fullName || 'Unknown Customer') : null;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={style}>
      <GlassPanel variant="card" style={styles.container}>
        <View style={styles.header}>
          <View style={styles.orderInfo}>
            <Text style={styles.orderId}>{formatOrderId(_id)}</Text>
            <Text style={styles.date}>{formatDate(createdAt)}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
            <Text style={[styles.statusText, { color: statusStyle.text }]}>
              {status?.charAt(0).toUpperCase() + status?.slice(1) || 'Pending'}
            </Text>
          </View>
        </View>

        {showCustomer && customerName && (
          <View style={styles.customerRow}>
            <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.customerName} numberOfLines={1}>{customerName}</Text>
          </View>
        )}

        {showItems && orderItems.length > 0 && (
          <View style={styles.itemsPreview}>
            {orderItems.slice(0, 3).map((item, index) => (
              <View key={index} style={styles.itemPreviewImage}>
                {item.product?.image ? (
                  <Image source={{ uri: item.product.image }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                ) : (
                  <View style={styles.itemImagePlaceholder}>
                    <Ionicons name="cube-outline" size={16} color={colors.grayLight} />
                  </View>
                )}
              </View>
            ))}
            {orderItems.length > 3 && (
              <View style={styles.moreItems}>
                <Text style={styles.moreItemsText}>+{orderItems.length - 3}</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.footer}>
          <View style={styles.summaryRow}>
            <Text style={styles.itemCount}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>
            <Text style={styles.totalAmount}>{formatPrice(orderSummary.totalAmount)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.3)" />
        </View>
      </GlassPanel>
    </TouchableOpacity>
  );
};

export const CompactOrderCard = ({ order, onPress }) => {
  if (!order) return null;
  const { _id, status = 'pending', orderSummary = {} } = order;
  const statusStyle = statusColors[status?.toLowerCase()] || statusColors.pending;
  const formatOrderId = (id) => id ? `#${id.slice(-6).toUpperCase()}` : 'N/A';
  const formatPrice = (p) => typeof p === 'number' ? `$${p.toFixed(2)}` : '$0.00';

  return (
    <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.statusDot, { backgroundColor: statusStyle.solid }]} />
      <View style={styles.compactContent}>
        <Text style={styles.compactOrderId}>{formatOrderId(_id)}</Text>
        <Text style={styles.compactStatus}>{status}</Text>
      </View>
      <Text style={styles.compactAmount}>{formatPrice(orderSummary.totalAmount)}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.grayLight} />
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: { padding: spacing.lg, marginBottom: spacing.md },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.md },
  orderInfo: { flex: 1 },
  orderId: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: spacing.xs },
  date: { fontSize: fontSize.sm, color: colors.textSecondary },
  statusBadge: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, textTransform: 'capitalize' },
  customerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.12)' },
  customerName: { fontSize: fontSize.sm, color: colors.textSecondary, marginLeft: spacing.xs, flex: 1 },
  itemsPreview: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  itemPreviewImage: { marginRight: -spacing.sm },
  itemImage: { width: 40, height: 40, borderRadius: borderRadius.md, borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)' },
  itemImagePlaceholder: { width: 40, height: 40, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)' },
  moreItems: { width: 40, height: 40, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.15)' },
  moreItemsText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.12)' },
  summaryRow: { flex: 1 },
  itemCount: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.xs },
  totalAmount: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.primary },
  // Compact
  compactContainer: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.md },
  compactContent: { flex: 1 },
  compactOrderId: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text },
  compactStatus: { fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'capitalize' },
  compactAmount: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginRight: spacing.sm },
});

export default OrderCard;
