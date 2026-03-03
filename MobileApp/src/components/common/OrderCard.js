/**
 * OrderCard Component
 * Order display card for lists
 * 
 * Requirements: 10.2, 10.3, 20.2
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  cardStyles,
  statusColors,
  typography,
} from '../../styles/theme';

const OrderCard = ({
  order,
  onPress,
  showCustomer = false,
  showItems = false,
  style,
}) => {
  if (!order) return null;

  const {
    _id,
    orderItems = [],
    orderSummary = {},
    status = 'pending',
    createdAt,
    user,
    shippingInfo,
  } = order;

  // Format order ID (show last 8 characters)
  const formatOrderId = (id) => {
    if (!id) return 'N/A';
    return `#${id.slice(-8).toUpperCase()}`;
  };

  // Format date
  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // Format price
  const formatPrice = (price) => {
    if (typeof price !== 'number') return '$0.00';
    return `$${price.toFixed(2)}`;
  };

  // Get status color
  const getStatusStyle = (orderStatus) => {
    const statusKey = orderStatus?.toLowerCase() || 'pending';
    return statusColors[statusKey] || statusColors.pending;
  };

  const statusStyle = getStatusStyle(status);
  const itemCount = orderItems.reduce((sum, item) => sum + (item.qty || 1), 0);
  const customerName = showCustomer 
    ? (user?.name || shippingInfo?.fullName || 'Unknown Customer')
    : null;

  return (
    <TouchableOpacity
      style={[styles.container, style]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.orderInfo}>
          <Text style={styles.orderId}>{formatOrderId(_id)}</Text>
          <Text style={styles.date}>{formatDate(createdAt)}</Text>
        </View>
        
        {/* Status Badge */}
        <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg }]}>
          <Text style={[styles.statusText, { color: statusStyle.text }]}>
            {status?.charAt(0).toUpperCase() + status?.slice(1) || 'Pending'}
          </Text>
        </View>
      </View>

      {/* Customer Info (for seller/admin views) */}
      {showCustomer && customerName && (
        <View style={styles.customerRow}>
          <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.customerName} numberOfLines={1}>
            {customerName}
          </Text>
        </View>
      )}

      {/* Order Items Preview */}
      {showItems && orderItems.length > 0 && (
        <View style={styles.itemsPreview}>
          {orderItems.slice(0, 3).map((item, index) => (
            <View key={index} style={styles.itemPreviewImage}>
              {item.product?.image ? (
                <Image
                  source={{ uri: item.product.image }}
                  style={styles.itemImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                />
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

      {/* Footer */}
      <View style={styles.footer}>
        <View style={styles.summaryRow}>
          <Text style={styles.itemCount}>
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </Text>
          <Text style={styles.totalAmount}>
            {formatPrice(orderSummary.totalAmount)}
          </Text>
        </View>
        
        <Ionicons
          name="chevron-forward"
          size={20}
          color={colors.grayLight}
        />
      </View>
    </TouchableOpacity>
  );
};

// Compact order card for dashboard recent orders
export const CompactOrderCard = ({ order, onPress }) => {
  if (!order) return null;

  const { _id, status = 'pending', orderSummary = {}, createdAt } = order;
  const statusStyle = statusColors[status?.toLowerCase()] || statusColors.pending;

  const formatOrderId = (id) => id ? `#${id.slice(-6).toUpperCase()}` : 'N/A';
  const formatPrice = (price) => typeof price === 'number' ? `$${price.toFixed(2)}` : '$0.00';

  return (
    <TouchableOpacity
      style={styles.compactContainer}
      onPress={onPress}
      activeOpacity={0.7}
    >
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
  container: {
    ...cardStyles.container,
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  orderInfo: {
    flex: 1,
  },
  orderId: {
    ...typography.bodySemibold,
    marginBottom: spacing.xs,
  },
  date: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  statusText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: 'capitalize',
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  customerName: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginLeft: spacing.xs,
    flex: 1,
  },
  itemsPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  itemPreviewImage: {
    marginRight: -spacing.sm,
  },
  itemImage: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    borderWidth: 2,
    borderColor: colors.white,
  },
  itemImagePlaceholder: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.white,
  },
  moreItems: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.md,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.white,
  },
  moreItemsText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.textSecondary,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.light,
  },
  summaryRow: {
    flex: 1,
  },
  itemCount: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  totalAmount: {
    ...typography.price,
  },
  // Compact styles
  compactContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: borderRadius.full,
    marginRight: spacing.md,
  },
  compactContent: {
    flex: 1,
  },
  compactOrderId: {
    ...typography.bodySemibold,
    fontSize: fontSize.sm,
  },
  compactStatus: {
    ...typography.caption,
    textTransform: 'capitalize',
  },
  compactAmount: {
    ...typography.bodySemibold,
    marginRight: spacing.sm,
  },
});

export default OrderCard;
