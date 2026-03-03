/**
 * OrderDetailScreen
 * Displays complete order details with timeline and actions
 * 
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
  statusColors,
  cardStyles,
  buttonStyles,
} from '../styles/theme';
import Loader from '../components/common/Loader';
import { ErrorState } from '../components/common/EmptyState';

// Status configuration with icons and colors
const statusConfig = {
  pending: { 
    color: statusColors.pending.solid, 
    bgColor: statusColors.pending.bg,
    icon: 'time-outline', 
    label: 'Pending',
    description: 'Your order is being reviewed'
  },
  confirmed: { 
    color: statusColors.confirmed?.solid || colors.info, 
    bgColor: statusColors.confirmed?.bg || colors.infoLight,
    icon: 'checkmark-circle-outline', 
    label: 'Confirmed',
    description: 'Your order has been confirmed'
  },
  processing: { 
    color: statusColors.processing.solid, 
    bgColor: statusColors.processing.bg,
    icon: 'hourglass-outline', 
    label: 'Processing',
    description: 'Your order is being prepared'
  },
  shipped: { 
    color: statusColors.shipped.solid, 
    bgColor: statusColors.shipped.bg,
    icon: 'airplane-outline', 
    label: 'Shipped',
    description: 'Your order is on the way'
  },
  delivered: { 
    color: statusColors.delivered.solid, 
    bgColor: statusColors.delivered.bg,
    icon: 'checkmark-done-outline', 
    label: 'Delivered',
    description: 'Your order has been delivered'
  },
  cancelled: { 
    color: statusColors.cancelled.solid, 
    bgColor: statusColors.cancelled.bg,
    icon: 'close-circle-outline', 
    label: 'Cancelled',
    description: 'Your order has been cancelled'
  }
};

// Status timeline order
const statusTimeline = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];

/**
 * Check if order can be cancelled
 * Property 29: Order Cancellation Eligibility
 * Validates: Requirements 11.5
 */
export const canCancelOrder = (status) => {
  const cancellableStatuses = ['pending', 'processing'];
  return cancellableStatuses.includes(status?.toLowerCase());
};

/**
 * Calculate estimated delivery date
 */
const getEstimatedDelivery = (order) => {
  if (!order?.createdAt) return null;
  
  // Get estimated days from shipping method or default to 5-7 days
  let estimatedDays = 7;
  if (order.sellerShipping && order.sellerShipping.length > 0) {
    const maxDays = Math.max(...order.sellerShipping.map(s => 
      s.shippingMethod?.estimatedDays || 7
    ));
    estimatedDays = maxDays;
  } else if (order.shippingMethod?.estimatedDays) {
    estimatedDays = order.shippingMethod.estimatedDays;
  }
  
  const orderDate = new Date(order.createdAt);
  const deliveryDate = new Date(orderDate);
  deliveryDate.setDate(deliveryDate.getDate() + estimatedDays);
  
  return deliveryDate;
};

export default function OrderDetailScreen({ route, navigation }) {
  const { orderId } = route.params;
  const { formatPrice } = useCurrency();
  const [order, setOrder] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);

  const fetchOrderDetail = useCallback(async () => {
    try {
      setError(null);
      const res = await api.get(`/api/order/detail/${orderId}`);
      
      setOrder(res.data.order);
    } catch (err) {
      console.error('Error fetching order detail:', err);
      setError(err.response?.data?.message || 'Failed to load order details');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [orderId]);

  useEffect(() => {
    fetchOrderDetail();
  }, [fetchOrderDetail]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrderDetail();
  }, [fetchOrderDetail]);

  const handleCancelOrder = useCallback(() => {
    Alert.alert(
      'Cancel Order',
      'Are you sure you want to cancel this order? This action cannot be undone.',
      [
        { text: 'No, Keep Order', style: 'cancel' },
        { 
          text: 'Yes, Cancel', 
          style: 'destructive',
          onPress: async () => {
            try {
              setCancelling(true);
              await api.patch(`/api/order/cancel/${orderId}`, {});
              
              Alert.alert('Success', 'Your order has been cancelled.');
              fetchOrderDetail();
            } catch (err) {
              Alert.alert(
                'Error',
                err.response?.data?.message || 'Failed to cancel order'
              );
            } finally {
              setCancelling(false);
            }
          }
        }
      ]
    );
  }, [orderId, fetchOrderDetail]);

  const formatDate = (dateString, includeTime = true) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const options = { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
    };
    if (includeTime) {
      options.hour = '2-digit';
      options.minute = '2-digit';
    }
    return date.toLocaleDateString('en-US', options);
  };

  // Loading state
  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Loader size="large" />
      </View>
    );
  }

  // Error state
  if (error) {
    return (
      <View style={styles.container}>
        <ErrorState message={error} onRetry={fetchOrderDetail} />
      </View>
    );
  }

  // Not found state
  if (!order) {
    return (
      <View style={styles.container}>
        <ErrorState 
          message="Order not found" 
          onRetry={() => navigation.goBack()} 
        />
      </View>
    );
  }

  const status = order.orderStatus || 'pending';
  const config = statusConfig[status] || statusConfig.pending;
  const currentStatusIndex = statusTimeline.indexOf(status);
  const isCancellable = canCancelOrder(status);
  const estimatedDelivery = getEstimatedDelivery(order);
  
  // Calculate totals
  const subtotal = order.orderSummary?.subtotal || 0;
  const tax = order.orderSummary?.tax || 0;
  let actualShipping = order.orderSummary?.shippingCost || 0;
  
  if (order.sellerShipping && order.sellerShipping.length > 0) {
    actualShipping = order.sellerShipping.reduce((sum, sellerShip) => 
      sum + (sellerShip.shippingMethod?.price || 0), 0
    );
  }
  
  const total = subtotal + tax + actualShipping;

  return (
    <ScrollView 
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[colors.primary]}
          tintColor={colors.primary}
        />
      }
    >
      {/* Order Status Header */}
      <View style={styles.statusSection}>
        <View style={[styles.statusIcon, { backgroundColor: config.bgColor }]}>
          <Ionicons name={config.icon} size={40} color={config.color} />
        </View>
        <Text style={[styles.statusLabel, { color: config.color }]}>
          {config.label}
        </Text>
        <Text style={styles.statusDescription}>{config.description}</Text>
        <View style={styles.orderIdContainer}>
          <Text style={styles.orderId}>Order #{order.orderId || order._id?.slice(-8).toUpperCase()}</Text>
          <Text style={styles.orderDate}>{formatDate(order.createdAt)}</Text>
        </View>
      </View>

      {/* Status Timeline */}
      {status !== 'cancelled' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Timeline</Text>
          <View style={styles.timeline}>
            {statusTimeline.map((timelineStatus, index) => {
              const isCompleted = index <= currentStatusIndex;
              const isCurrent = index === currentStatusIndex;
              const timelineConfig = statusConfig[timelineStatus];
              
              return (
                <View key={timelineStatus} style={styles.timelineItem}>
                  <View style={styles.timelineLeft}>
                    <View style={[
                      styles.timelineDot,
                      isCompleted && styles.timelineDotCompleted,
                      isCurrent && styles.timelineDotCurrent,
                    ]}>
                      {isCompleted && (
                        <Ionicons 
                          name="checkmark" 
                          size={12} 
                          color={colors.white} 
                        />
                      )}
                    </View>
                    {index < statusTimeline.length - 1 && (
                      <View style={[
                        styles.timelineLine,
                        isCompleted && styles.timelineLineCompleted,
                      ]} />
                    )}
                  </View>
                  <View style={styles.timelineContent}>
                    <Text style={[
                      styles.timelineLabel,
                      isCompleted && styles.timelineLabelCompleted,
                      isCurrent && styles.timelineLabelCurrent,
                    ]}>
                      {timelineConfig.label}
                    </Text>
                    {isCurrent && (
                      <Text style={styles.timelineDescription}>
                        {timelineConfig.description}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Estimated Delivery */}
      {estimatedDelivery && status !== 'delivered' && status !== 'cancelled' && (
        <View style={styles.deliveryBanner}>
          <Ionicons name="calendar-outline" size={20} color={colors.primary} />
          <View style={styles.deliveryInfo}>
            <Text style={styles.deliveryLabel}>Estimated Delivery</Text>
            <Text style={styles.deliveryDate}>{formatDate(estimatedDelivery, false)}</Text>
          </View>
        </View>
      )}

      {/* Order Items */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Order Items ({order.orderItems?.length || 0})
        </Text>
        {order.orderItems?.map((item, index) => (
          <View 
            key={index} 
            style={[
              styles.orderItem,
              index === order.orderItems.length - 1 && styles.lastItem
            ]}
          >
            <Image
              source={{ uri: item.image || 'https://via.placeholder.com/80' }}
              style={styles.itemImage}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
            />
            <View style={styles.itemInfo}>
              <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
              <Text style={styles.itemQuantity}>Qty: {item.quantity || item.qty}</Text>
              <Text style={styles.itemPrice}>{formatPrice(item.price)}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* Shipping Information */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Shipping Address</Text>
        <View style={styles.addressCard}>
          <View style={styles.addressHeader}>
            <Ionicons name="location" size={20} color={colors.primary} />
            <Text style={styles.addressName}>{order.shippingInfo?.fullName}</Text>
          </View>
          <Text style={styles.addressText}>
            {order.shippingInfo?.address}
          </Text>
          <Text style={styles.addressText}>
            {order.shippingInfo?.city}, {order.shippingInfo?.state} {order.shippingInfo?.postalCode}
          </Text>
          <Text style={styles.addressText}>
            {order.shippingInfo?.country}
          </Text>
          <View style={styles.contactRow}>
            <Ionicons name="call-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.contactText}>{order.shippingInfo?.phone}</Text>
          </View>
          <View style={styles.contactRow}>
            <Ionicons name="mail-outline" size={16} color={colors.textSecondary} />
            <Text style={styles.contactText}>{order.shippingInfo?.email}</Text>
          </View>
        </View>
      </View>

      {/* Payment Information */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Payment</Text>
        <View style={styles.paymentCard}>
          <View style={styles.paymentRow}>
            <View style={styles.paymentMethod}>
              <Ionicons 
                name={order.paymentMethod === 'cash_on_delivery' ? 'cash-outline' : 'card-outline'} 
                size={24} 
                color={colors.primary} 
              />
              <Text style={styles.paymentMethodText}>
                {order.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : 'Card Payment'}
              </Text>
            </View>
            <View style={[
              styles.paymentStatus,
              { backgroundColor: order.paymentStatus === 'paid' ? colors.successLight : colors.warningLight }
            ]}>
              <Text style={[
                styles.paymentStatusText,
                { color: order.paymentStatus === 'paid' ? colors.success : colors.warning }
              ]}>
                {order.paymentStatus === 'paid' ? 'Paid' : 'Unpaid'}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Order Summary */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Order Summary</Text>
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Subtotal</Text>
            <Text style={styles.summaryValue}>{formatPrice(subtotal)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Shipping</Text>
            <Text style={styles.summaryValue}>{formatPrice(actualShipping)}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Tax</Text>
            <Text style={styles.summaryValue}>{formatPrice(tax)}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.summaryRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatPrice(total)}</Text>
          </View>
        </View>
      </View>

      {/* Cancel Order Button */}
      {isCancellable && (
        <View style={styles.actionSection}>
          <TouchableOpacity
            style={[styles.cancelButton, cancelling && styles.cancelButtonDisabled]}
            onPress={handleCancelOrder}
            disabled={cancelling}
            activeOpacity={0.7}
          >
            {cancelling ? (
              <Loader size="small" color={colors.error} />
            ) : (
              <>
                <Ionicons name="close-circle-outline" size={20} color={colors.error} />
                <Text style={styles.cancelButtonText}>Cancel Order</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom Spacing */}
      <View style={styles.bottomSpacer} />
    </ScrollView>
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
    backgroundColor: colors.background,
  },
  statusSection: {
    backgroundColor: colors.white,
    padding: spacing.xxl,
    alignItems: 'center',
    ...shadows.sm,
  },
  statusIcon: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  statusLabel: {
    ...typography.h2,
    marginBottom: spacing.xs,
  },
  statusDescription: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  orderIdContainer: {
    alignItems: 'center',
  },
  orderId: {
    ...typography.bodySemibold,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  orderDate: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  section: {
    backgroundColor: colors.white,
    padding: spacing.lg,
    marginTop: spacing.md,
    ...shadows.sm,
  },
  sectionTitle: {
    ...typography.h3,
    marginBottom: spacing.md,
  },
  // Timeline styles
  timeline: {
    paddingLeft: spacing.sm,
  },
  timelineItem: {
    flexDirection: 'row',
    minHeight: 50,
  },
  timelineLeft: {
    alignItems: 'center',
    width: 24,
    marginRight: spacing.md,
  },
  timelineDot: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.full,
    backgroundColor: colors.light,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.grayLight,
  },
  timelineDotCompleted: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  timelineDotCurrent: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    backgroundColor: colors.light,
    marginVertical: spacing.xs,
  },
  timelineLineCompleted: {
    backgroundColor: colors.success,
  },
  timelineContent: {
    flex: 1,
    paddingBottom: spacing.md,
  },
  timelineLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  timelineLabelCompleted: {
    color: colors.text,
  },
  timelineLabelCurrent: {
    ...typography.bodySemibold,
    color: colors.primary,
  },
  timelineDescription: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  // Delivery banner
  deliveryBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primaryLighter,
    padding: spacing.md,
    marginTop: spacing.md,
    marginHorizontal: spacing.md,
    borderRadius: borderRadius.md,
  },
  deliveryInfo: {
    marginLeft: spacing.md,
  },
  deliveryLabel: {
    ...typography.bodySmall,
    color: colors.primary,
  },
  deliveryDate: {
    ...typography.bodySemibold,
    color: colors.primaryDark,
  },
  // Order items
  orderItem: {
    flexDirection: 'row',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  lastItem: {
    borderBottomWidth: 0,
  },
  itemImage: {
    width: 70,
    height: 70,
    borderRadius: borderRadius.md,
    backgroundColor: colors.light,
  },
  itemInfo: {
    flex: 1,
    marginLeft: spacing.md,
    justifyContent: 'center',
  },
  itemName: {
    ...typography.bodySemibold,
    marginBottom: spacing.xs,
  },
  itemQuantity: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  itemPrice: {
    ...typography.price,
  },
  // Address card
  addressCard: {
    backgroundColor: colors.lighter,
    padding: spacing.md,
    borderRadius: borderRadius.md,
  },
  addressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  addressName: {
    ...typography.bodySemibold,
    marginLeft: spacing.sm,
  },
  addressText: {
    ...typography.body,
    color: colors.textSecondary,
    marginLeft: spacing.xl + spacing.sm,
    lineHeight: 22,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginLeft: spacing.xl + spacing.sm,
  },
  contactText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginLeft: spacing.sm,
  },
  // Payment card
  paymentCard: {
    backgroundColor: colors.lighter,
    padding: spacing.md,
    borderRadius: borderRadius.md,
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  paymentMethod: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  paymentMethodText: {
    ...typography.bodySemibold,
    marginLeft: spacing.sm,
  },
  paymentStatus: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  paymentStatusText: {
    ...typography.caption,
    fontWeight: fontWeight.semibold,
  },
  // Summary card
  summaryCard: {
    backgroundColor: colors.lighter,
    padding: spacing.md,
    borderRadius: borderRadius.md,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  summaryLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  summaryValue: {
    ...typography.body,
  },
  divider: {
    height: 1,
    backgroundColor: colors.grayLight,
    marginVertical: spacing.md,
  },
  totalLabel: {
    ...typography.h3,
  },
  totalValue: {
    ...typography.price,
    fontSize: fontSize.xl,
  },
  // Action section
  actionSection: {
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  cancelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.errorLight,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  cancelButtonDisabled: {
    opacity: 0.6,
  },
  cancelButtonText: {
    ...typography.bodySemibold,
    color: colors.error,
    marginLeft: spacing.sm,
  },
  bottomSpacer: {
    height: spacing.xxxl,
  },
});
