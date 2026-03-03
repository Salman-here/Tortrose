/**
 * OrderDetailManagementScreen
 * View and manage individual order details
 * 
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
  buttonStyles,
} from '../../styles/theme';

// Status configuration
const STATUS_CONFIG = {
  pending: { color: colors.warning, icon: 'time-outline', label: 'Pending' },
  processing: { color: colors.info, icon: 'sync-outline', label: 'Processing' },
  shipped: { color: colors.primary, icon: 'airplane-outline', label: 'Shipped' },
  delivered: { color: colors.success, icon: 'checkmark-circle-outline', label: 'Delivered' },
  cancelled: { color: colors.error, icon: 'close-circle-outline', label: 'Cancelled' },
};

// Status flow for updates
const STATUS_OPTIONS = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

export default function OrderDetailManagementScreen({ route, navigation }) {
  const { orderId, isAdmin } = route.params;
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState(null);

  useEffect(() => {
    fetchOrder();
  }, [orderId]);

  const fetchOrder = async () => {
    try {
      const response = await api.get(`/api/order/detail/${orderId}`);
      setOrder(response.data);
      setSelectedStatus(response.data.status);
    } catch (error) {
      console.error('Error fetching order:', error);
      Alert.alert('Error', 'Failed to fetch order details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrder();
  }, [orderId]);

  const updateStatus = async (newStatus) => {
    if (newStatus === order.status) return;
    
    Alert.alert(
      'Update Status',
      `Change order status to "${STATUS_CONFIG[newStatus]?.label}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Update',
          onPress: async () => {
            setUpdating(true);
            try {
              await api.patch(`/api/order/update-status/${orderId}`, { status: newStatus });
              setOrder(prev => ({ ...prev, status: newStatus }));
              setSelectedStatus(newStatus);
              Alert.alert('Success', 'Order status updated successfully');
            } catch (error) {
              Alert.alert('Error', 'Failed to update status');
            } finally {
              setUpdating(false);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading order..." />
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.errorContainer}>
          <Ionicons name="receipt-outline" size={64} color={colors.grayLight} />
          <Text style={styles.errorTitle}>Order not found</Text>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const statusConfig = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
      >
        {/* Order Header */}
        <View style={styles.header}>
          <View style={styles.orderIdRow}>
            <Text style={styles.orderIdLabel}>Order</Text>
            <Text style={styles.orderId}>#{order._id.slice(-8).toUpperCase()}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.color }]}>
            <Ionicons name={statusConfig.icon} size={16} color={colors.white} />
            <Text style={styles.statusText}>{statusConfig.label}</Text>
          </View>
        </View>

        {/* Order Timeline */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Timeline</Text>
          <View style={styles.timeline}>
            {STATUS_OPTIONS.filter(s => s !== 'cancelled').map((status, index) => {
              const config = STATUS_CONFIG[status];
              const isCompleted = STATUS_OPTIONS.indexOf(order.status) >= index || 
                (order.status === 'cancelled' && status === 'cancelled');
              const isCurrent = order.status === status;
              
              return (
                <View key={status} style={styles.timelineItem}>
                  <View style={styles.timelineLeft}>
                    <View style={[
                      styles.timelineDot,
                      isCompleted && { backgroundColor: config.color },
                      isCurrent && styles.timelineDotCurrent,
                    ]}>
                      {isCompleted && (
                        <Ionicons name="checkmark" size={12} color={colors.white} />
                      )}
                    </View>
                    {index < 3 && (
                      <View style={[
                        styles.timelineLine,
                        isCompleted && { backgroundColor: config.color },
                      ]} />
                    )}
                  </View>
                  <View style={styles.timelineContent}>
                    <Text style={[
                      styles.timelineLabel,
                      isCurrent && styles.timelineLabelCurrent,
                    ]}>
                      {config.label}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* Customer Information */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Customer Information</Text>
          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Ionicons name="person-outline" size={18} color={colors.primary} />
              <Text style={styles.infoText}>{order.shippingAddress?.fullName || 'N/A'}</Text>
            </View>
            <View style={styles.infoRow}>
              <Ionicons name="mail-outline" size={18} color={colors.primary} />
              <Text style={styles.infoText}>{order.user?.email || 'N/A'}</Text>
            </View>
            <View style={styles.infoRow}>
              <Ionicons name="call-outline" size={18} color={colors.primary} />
              <Text style={styles.infoText}>{order.shippingAddress?.phone || 'N/A'}</Text>
            </View>
            <View style={styles.infoRow}>
              <Ionicons name="location-outline" size={18} color={colors.primary} />
              <Text style={styles.infoText}>
                {order.shippingAddress?.address}, {order.shippingAddress?.city}
                {order.shippingAddress?.postalCode && `, ${order.shippingAddress.postalCode}`}
              </Text>
            </View>
          </View>
        </View>

        {/* Order Items */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Items ({order.items?.length || 0})</Text>
          {order.items?.map((item, index) => (
            <View key={index} style={styles.itemCard}>
              {item.product?.images?.[0] ? (
                <Image
                  source={{ uri: item.product.images[0] }}
                  style={styles.itemImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                />
              ) : (
                <View style={[styles.itemImage, styles.itemImagePlaceholder]}>
                  <Ionicons name="cube-outline" size={24} color={colors.grayLight} />
                </View>
              )}
              <View style={styles.itemInfo}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {item.product?.name || 'Product'}
                </Text>
                <Text style={styles.itemQuantity}>Qty: {item.quantity}</Text>
              </View>
              <View style={styles.itemPricing}>
                <Text style={styles.itemPrice}>${item.price?.toFixed(2)}</Text>
                <Text style={styles.itemTotal}>
                  ${(item.quantity * item.price).toFixed(2)}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {/* Order Summary */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Order Summary</Text>
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>
                ${(order.totalAmount - (order.shippingCost || 0)).toFixed(2)}
              </Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Shipping</Text>
              <Text style={styles.summaryValue}>
                ${(order.shippingCost || 0).toFixed(2)}
              </Text>
            </View>
            <View style={[styles.summaryRow, styles.summaryTotal]}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>${order.totalAmount?.toFixed(2)}</Text>
            </View>
          </View>
        </View>

        {/* Update Status */}
        {order.status !== 'delivered' && order.status !== 'cancelled' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Update Status</Text>
            <View style={styles.statusOptions}>
              {STATUS_OPTIONS.map((status) => {
                const config = STATUS_CONFIG[status];
                const isSelected = selectedStatus === status;
                const isCurrent = order.status === status;
                
                return (
                  <TouchableOpacity
                    key={status}
                    style={[
                      styles.statusOption,
                      isSelected && { borderColor: config.color, backgroundColor: `${config.color}10` },
                    ]}
                    onPress={() => updateStatus(status)}
                    disabled={updating || isCurrent}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={config.icon}
                      size={20}
                      color={isSelected ? config.color : colors.textSecondary}
                    />
                    <Text style={[
                      styles.statusOptionText,
                      isSelected && { color: config.color },
                    ]}>
                      {config.label}
                    </Text>
                    {isCurrent && (
                      <View style={[styles.currentBadge, { backgroundColor: config.color }]}>
                        <Text style={styles.currentBadgeText}>Current</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Bottom Spacing */}
        <View style={styles.bottomSpacing} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Error state
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
  },
  errorTitle: {
    ...typography.h3,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  backButton: {
    ...buttonStyles.primary,
    paddingHorizontal: spacing.xl,
  },
  backButtonText: {
    ...buttonStyles.primaryText,
  },
  // Header
  header: {
    backgroundColor: colors.white,
    padding: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    ...shadows.sm,
  },
  orderIdRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
  },
  orderIdLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  orderId: {
    ...typography.h3,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    gap: spacing.xs,
  },
  statusText: {
    ...typography.bodySemibold,
    color: colors.white,
    fontSize: fontSize.sm,
  },
  // Sections
  section: {
    backgroundColor: colors.white,
    marginTop: spacing.md,
    padding: spacing.lg,
  },
  sectionTitle: {
    ...typography.h4,
    marginBottom: spacing.md,
  },
  // Timeline
  timeline: {
    paddingLeft: spacing.sm,
  },
  timelineItem: {
    flexDirection: 'row',
    minHeight: 50,
  },
  timelineLeft: {
    alignItems: 'center',
    width: 30,
  },
  timelineDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.grayLighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  timelineDotCurrent: {
    borderWidth: 3,
    borderColor: colors.white,
    ...shadows.sm,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    backgroundColor: colors.grayLighter,
    marginVertical: spacing.xs,
  },
  timelineContent: {
    flex: 1,
    paddingLeft: spacing.md,
    paddingBottom: spacing.md,
  },
  timelineLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  timelineLabelCurrent: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  // Info Card
  infoCard: {
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  infoText: {
    ...typography.body,
    flex: 1,
  },
  // Items
  itemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  itemImage: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    backgroundColor: colors.white,
  },
  itemImagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  itemName: {
    ...typography.bodySemibold,
    marginBottom: spacing.xs,
  },
  itemQuantity: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  itemPricing: {
    alignItems: 'flex-end',
  },
  itemPrice: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  itemTotal: {
    ...typography.bodySemibold,
    color: colors.primary,
  },
  // Summary
  summaryCard: {
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
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
  summaryTotal: {
    borderTopWidth: 1,
    borderTopColor: colors.light,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
    marginBottom: 0,
  },
  totalLabel: {
    ...typography.h4,
  },
  totalValue: {
    ...typography.h3,
    color: colors.primary,
  },
  // Status Options
  statusOptions: {
    gap: spacing.sm,
  },
  statusOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: colors.light,
    backgroundColor: colors.white,
    gap: spacing.md,
  },
  statusOptionText: {
    ...typography.body,
    flex: 1,
  },
  currentBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  currentBadgeText: {
    ...typography.caption,
    color: colors.white,
    fontWeight: fontWeight.semibold,
  },
  // Bottom
  bottomSpacing: {
    height: spacing.xxl,
  },
});
