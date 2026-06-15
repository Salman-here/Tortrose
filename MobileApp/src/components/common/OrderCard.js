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
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const OrderCard = ({ order, onPress, showCustomer = false, showItems = false, onWhatsApp, style }) => {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const c = palette.colors;
  const g = palette.glass;
  if (!order) return null;
  const {
    _id,
    orderItems = [],
    orderSummary = {},
    orderStatus,
    status = 'pending',
    createdAt,
    user,
    shippingInfo,
    currency,
  } = order;

  const formatOrderId = (id) => id ? `#${id.slice(-8).toUpperCase()}` : 'N/A';
  const formatDate = (d) => {
    if (!d) return 'N/A';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const getStatusStyle = (s) => statusColors[s?.toLowerCase()] || statusColors.pending;

  const displayStatus = orderStatus || status;
  const statusStyle = getStatusStyle(displayStatus);
  const itemCount = orderItems.reduce((sum, item) => sum + (item.quantity || item.qty || 1), 0);
  const customerName = showCustomer ? (user?.name || shippingInfo?.fullName || 'Unknown Customer') : null;
  const orderTotal = orderSummary.totalAmount ?? order.totalAmount ?? order.total ?? 0;
  const orderCurrency = currency || order.orderCurrency || 'USD';

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={style}>
      <GlassPanel variant="card" style={styles.container}>
        <View style={styles.header}>
          <View style={styles.orderInfo}>
            <Text style={[styles.orderId, { color: c.text }]}>{formatOrderId(_id)}</Text>
            <Text style={[styles.date, { color: c.textSecondary }]}>{formatDate(createdAt)}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
            <Text style={[styles.statusText, { color: statusStyle.text }]}>
              {displayStatus?.charAt(0).toUpperCase() + displayStatus?.slice(1) || 'Pending'}
            </Text>
          </View>
        </View>

        {showCustomer && customerName && (
          <View style={[styles.customerRow, { borderBottomColor: g.borderSubtle }]}>
            <Ionicons name="person-outline" size={14} color={c.textSecondary} />
            <Text style={[styles.customerName, { color: c.textSecondary }]} numberOfLines={1}>{customerName}</Text>
          </View>
        )}

        {showItems && orderItems.length > 0 && (
          <View style={styles.itemsPreview}>
            {orderItems.slice(0, 3).map((item, index) => (
              <View key={index} style={styles.itemPreviewImage}>
                {item.image || item.product?.image || item.productId?.image ? (
                  <Image source={{ uri: item.image || item.product?.image || item.productId?.image }} style={[styles.itemImage, { borderColor: g.borderSubtle }]} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                ) : (
                  <View style={[styles.itemImagePlaceholder, { backgroundColor: g.bgSubtle, borderColor: g.borderSubtle }]}>
                    <Ionicons name="cube-outline" size={16} color={c.textLight} />
                  </View>
                )}
              </View>
            ))}
            {orderItems.length > 3 && (
              <View style={[styles.moreItems, { backgroundColor: g.bgSubtle, borderColor: g.borderSubtle }]}>
                <Text style={[styles.moreItemsText, { color: c.textSecondary }]}>+{orderItems.length - 3}</Text>
              </View>
            )}
          </View>
        )}

        <View style={[styles.footer, { borderTopColor: g.borderSubtle }]}>
          <View style={styles.summaryRow}>
            <Text style={[styles.itemCount, { color: c.textSecondary }]}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>
            <Text style={[styles.totalAmount, { color: c.primary }]}>{formatPrice(orderTotal, { sourceCurrency: orderCurrency })}</Text>
          </View>
          {onWhatsApp && (() => {
            const confirmedByEmail = order?.confirmation?.confirmedAt && order?.confirmation?.confirmedVia === 'email';
            return (
              <View style={{ alignItems: 'flex-end' }}>
                <TouchableOpacity
                  onPress={(e) => { e.stopPropagation && e.stopPropagation(); if (!confirmedByEmail) onWhatsApp(order); }}
                  activeOpacity={confirmedByEmail ? 1 : 0.7}
                  disabled={!!confirmedByEmail}
                  style={[styles.waButton, confirmedByEmail && { backgroundColor: 'rgba(34,197,94,0.18)' }]}
                  accessibilityLabel={confirmedByEmail ? 'Confirmed via email' : 'Verify on WhatsApp'}
                >
                  <Ionicons
                    name={confirmedByEmail ? 'checkmark-circle' : 'logo-whatsapp'}
                    size={18}
                    color={confirmedByEmail ? '#22C55E' : '#25D366'}
                  />
                </TouchableOpacity>
                {confirmedByEmail && (
                  <Text style={{ fontSize: 9, color: '#22C55E', marginTop: 2, fontWeight: '600' }}>
                    Confirmed via email
                  </Text>
                )}
              </View>
            );
          })()}
          <Ionicons name="chevron-forward" size={20} color={c.textLight} />
        </View>
      </GlassPanel>
    </TouchableOpacity>
  );
};

export const CompactOrderCard = ({ order, onPress }) => {
  const { formatPrice } = useCurrency();
  if (!order) return null;
  const { _id, status = 'pending', orderStatus, orderSummary = {}, currency } = order;
  const displayStatus = orderStatus || status;
  const statusStyle = statusColors[displayStatus?.toLowerCase()] || statusColors.pending;
  const formatOrderId = (id) => id ? `#${id.slice(-6).toUpperCase()}` : 'N/A';
  const orderTotal = orderSummary.totalAmount ?? order.totalAmount ?? order.total ?? 0;

  return (
    <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.statusDot, { backgroundColor: statusStyle.solid }]} />
      <View style={styles.compactContent}>
        <Text style={styles.compactOrderId}>{formatOrderId(_id)}</Text>
        <Text style={styles.compactStatus}>{displayStatus}</Text>
      </View>
      <Text style={styles.compactAmount}>{formatPrice(orderTotal, { sourceCurrency: currency || 'USD' })}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.grayLight} />
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: { padding: spacing.md, marginBottom: spacing.sm },
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
  waButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(37, 211, 102, 0.15)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm },
  // Compact
  compactContainer: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.md },
  compactContent: { flex: 1 },
  compactOrderId: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text },
  compactStatus: { fontSize: fontSize.xs, color: colors.textSecondary, textTransform: 'capitalize' },
  compactAmount: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginRight: spacing.sm },
});

export default OrderCard;
