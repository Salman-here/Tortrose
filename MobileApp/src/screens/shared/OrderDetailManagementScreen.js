/**
 * OrderDetailManagementScreen - Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';

const getStatusConfig = (palette) => ({
  pending: { color: palette.colors.warning, icon: 'time-outline', label: 'Pending' },
  confirmed: { color: palette.colors.success, icon: 'checkmark-circle-outline', label: 'Confirmed' },
  processing: { color: palette.colors.info, icon: 'sync-outline', label: 'Processing' },
  shipped: { color: palette.colors.primary, icon: 'airplane-outline', label: 'Shipped' },
  delivered: { color: palette.colors.success, icon: 'checkmark-circle-outline', label: 'Delivered' },
  cancelled: { color: palette.colors.error, icon: 'close-circle-outline', label: 'Cancelled' },
});

const STATUS_OPTIONS = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
const TIMELINE_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];

const getItemImage = (item) => (
  item?.image ||
  item?.product?.image ||
  item?.productId?.image ||
  item?.product?.images?.[0] ||
  item?.productId?.images?.[0]
);

const getItemName = (item) => item?.name || item?.product?.name || item?.productId?.name || 'Product';

const getSelectedOptions = (item) => {
  if (!item?.selectedOptions || typeof item.selectedOptions !== 'object') return [];
  return Object.entries(item.selectedOptions).filter(([, value]) => value);
};

export default function OrderDetailManagementScreen({ route, navigation }) {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const styles = buildStyles(palette);
  const STATUS_CONFIG = getStatusConfig(palette);

  const { orderId, isAdmin } = route.params || {};
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState(null);

  const fetchOrder = useCallback(async () => {
    try {
      const res = await api.get(`/api/order/detail/${orderId}`);
      const nextOrder = res.data?.order || res.data;
      setOrder(nextOrder);
      setSelectedStatus(nextOrder?.orderStatus || nextOrder?.status || 'pending');
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to fetch order');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orderId]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrder();
  }, [fetchOrder]);

  const updateStatus = async (newStatus) => {
    const currentStatus = order?.orderStatus || order?.status;
    if (!order || newStatus === currentStatus) return;

    Alert.alert('Update Status', `Change to "${STATUS_CONFIG[newStatus]?.label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Update',
        onPress: async () => {
          setUpdating(true);
          try {
            await api.patch(`/api/order/update-status/${orderId}`, { newStatus });
            setOrder((previous) => ({ ...previous, orderStatus: newStatus, status: newStatus }));
            setSelectedStatus(newStatus);
            Alert.alert('Success', 'Status updated');
          } catch (e) {
            Alert.alert('Error', e.response?.data?.msg || 'Failed to update status');
          } finally {
            setUpdating(false);
          }
        },
      },
    ]);
  };

  if (loading) {
    return (
      <GlassBackground>
        <Loader fullScreen message="Loading order..." />
      </GlassBackground>
    );
  }

  if (!order) {
    return (
      <GlassBackground>
        <View style={styles.errorContainer}>
          <Ionicons name="receipt-outline" size={64} color={palette.colors.textSecondary} />
          <Text style={styles.errorTitle}>Order not found</Text>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
            <Text style={styles.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </GlassBackground>
    );
  }

  const orderStatus = order.orderStatus || order.status || 'pending';
  const statusConfig = STATUS_CONFIG[orderStatus] || STATUS_CONFIG.pending;
  const orderItems = order.orderItems || order.items || [];
  const shippingInfo = order.shippingInfo || order.shippingAddress || {};
  const summary = order.orderSummary || {};
  const orderCurrency = order.currency || 'USD';
  const money = (amount) => formatPrice(amount || 0, { sourceCurrency: orderCurrency });
  const shippingCost = summary.shippingCost ?? order.shippingCost ?? order.shippingMethod?.price ?? 0;
  const totalAmount = summary.totalAmount ?? order.totalAmount ?? order.total ?? 0;
  const subtotal = summary.subtotal ?? Math.max(0, totalAmount - shippingCost - (summary.tax || 0) + (summary.couponDiscount || 0));
  const customerEmail = order.user?.email || shippingInfo.email || 'N/A';

  return (
    <GlassBackground>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        <GlassPanel variant="floating" style={styles.header}>
          <View>
            <Text style={styles.orderIdLabel}>Order</Text>
            <Text style={styles.orderId}>#{(order.orderId || order._id || '').toString().slice(-8).toUpperCase() || 'N/A'}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.color }]}>
            <Ionicons name={statusConfig.icon} size={16} color="white" />
            <Text style={styles.statusText}>{statusConfig.label}</Text>
          </View>
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Order Timeline</Text>
          {TIMELINE_STATUSES.map((status, index) => {
            const config = STATUS_CONFIG[status];
            const isCompleted = TIMELINE_STATUSES.indexOf(orderStatus) >= index;
            const isCurrent = orderStatus === status;
            return (
              <View key={status} style={styles.timelineItem}>
                <View style={styles.timelineLeft}>
                  <View style={[styles.timelineDot, isCompleted && { backgroundColor: config.color }, isCurrent && styles.timelineDotCurrent]}>
                    {isCompleted && <Ionicons name="checkmark" size={12} color="white" />}
                  </View>
                  {index < TIMELINE_STATUSES.length - 1 && <View style={[styles.timelineLine, isCompleted && { backgroundColor: config.color }]} />}
                </View>
                <Text style={[styles.timelineLabel, isCurrent && styles.timelineLabelCurrent]}>{config.label}</Text>
              </View>
            );
          })}
          {orderStatus === 'cancelled' && (
            <View style={styles.cancelledRow}>
              <Ionicons name="close-circle-outline" size={18} color={palette.colors.error} />
              <Text style={[styles.infoText, { color: palette.colors.error }]}>This order was cancelled.</Text>
            </View>
          )}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>{isAdmin ? 'Customer' : 'Customer'}</Text>
          <View style={styles.infoCard}>
            {[
              { icon: 'person-outline', text: shippingInfo.fullName || 'N/A' },
              { icon: 'mail-outline', text: customerEmail },
              { icon: 'call-outline', text: shippingInfo.phone || 'N/A' },
              { icon: 'location-outline', text: [shippingInfo.address, shippingInfo.city, shippingInfo.state, shippingInfo.postalCode, shippingInfo.country].filter(Boolean).join(', ') || 'N/A' },
            ].map((info) => (
              <View key={`${info.icon}-${info.text}`} style={styles.infoRow}>
                <Ionicons name={info.icon} size={18} color={palette.colors.primary} />
                <Text style={styles.infoText}>{info.text}</Text>
              </View>
            ))}
          </View>
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Items ({orderItems.length})</Text>
          {orderItems.map((item, index) => {
            const itemImage = getItemImage(item);
            const quantity = item.quantity || item.qty || 1;
            const selectedOptions = getSelectedOptions(item);
            return (
              <View key={`${item._id || item.productId?._id || item.productId || index}`} style={styles.itemCard}>
                {itemImage ? (
                  <Image source={{ uri: itemImage }} style={styles.itemImage} contentFit="cover" />
                ) : (
                  <View style={[styles.itemImage, styles.itemImagePlaceholder]}>
                    <Ionicons name="cube-outline" size={24} color={palette.colors.textSecondary} />
                  </View>
                )}
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName} numberOfLines={2}>{getItemName(item)}</Text>
                  <Text style={styles.itemQty}>Qty: {quantity}</Text>
                  {item.selectedColor && <Text style={styles.itemOption}>Color: {item.selectedColor}</Text>}
                  {selectedOptions.map(([name, value]) => (
                    <Text key={name} style={styles.itemOption}>{name}: {value}</Text>
                  ))}
                </View>
                <Text style={styles.itemTotal}>{money(quantity * (Number(item.price) || 0))}</Text>
              </View>
            );
          })}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>{money(subtotal)}</Text></View>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Shipping</Text><Text style={styles.summaryValue}>{shippingCost === 0 ? 'Free' : money(shippingCost)}</Text></View>
          {summary.tax > 0 && <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Tax</Text><Text style={styles.summaryValue}>{money(summary.tax)}</Text></View>}
          {summary.couponDiscount > 0 && <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Coupon Discount</Text><Text style={[styles.summaryValue, { color: palette.colors.success }]}>-{money(summary.couponDiscount)}</Text></View>}
          <View style={[styles.summaryRow, styles.summaryTotal]}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{money(totalAmount)}</Text></View>
        </GlassPanel>

        {orderStatus !== 'delivered' && orderStatus !== 'cancelled' && (
          <GlassPanel variant="card" style={styles.section}>
            <Text style={styles.sectionTitle}>Update Status</Text>
            <View style={styles.statusOptions}>
              {STATUS_OPTIONS.map((status) => {
                const config = STATUS_CONFIG[status];
                const isSelected = selectedStatus === status;
                const isCurrent = orderStatus === status;
                return (
                  <TouchableOpacity
                    key={status}
                    style={[styles.statusOption, isSelected && { borderColor: config.color, backgroundColor: `${config.color}15` }]}
                    onPress={() => updateStatus(status)}
                    disabled={updating || isCurrent}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={config.icon} size={20} color={isSelected ? config.color : palette.colors.textSecondary} />
                    <Text style={[styles.statusOptionText, isSelected && { color: config.color }]}>{config.label}</Text>
                    {isCurrent && <View style={[styles.currentBadge, { backgroundColor: config.color }]}><Text style={styles.currentBadgeText}>Current</Text></View>}
                  </TouchableOpacity>
                );
              })}
            </View>
          </GlassPanel>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl },
  errorTitle: { ...typography.h3, color: p.colors.text, marginTop: spacing.lg, marginBottom: spacing.xl },
  backButton: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg },
  backButtonText: { ...typography.bodySemibold, color: 'white' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: spacing.lg, padding: spacing.lg },
  orderIdLabel: { ...typography.body, color: p.colors.textSecondary },
  orderId: { ...typography.h3, color: p.colors.text },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, gap: spacing.xs },
  statusText: { ...typography.bodySemibold, color: 'white', fontSize: fontSize.sm },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: p.colors.text, marginBottom: spacing.md },
  timelineItem: { flexDirection: 'row', minHeight: 50 },
  timelineLeft: { alignItems: 'center', width: 30 },
  timelineDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
  timelineDotCurrent: { borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)' },
  timelineLine: { width: 2, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', marginVertical: spacing.xs },
  timelineLabel: { ...typography.body, color: p.colors.textSecondary, paddingLeft: spacing.md, paddingBottom: spacing.md },
  timelineLabelCurrent: { ...typography.bodySemibold, color: p.colors.text },
  cancelledRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  infoCard: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: borderRadius.lg, padding: spacing.md, gap: spacing.md },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  infoText: { ...typography.body, color: p.colors.text, flex: 1 },
  itemCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: borderRadius.lg, padding: spacing.md, marginBottom: spacing.sm },
  itemImage: { width: 60, height: 60, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.04)' },
  itemImagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  itemInfo: { flex: 1, marginLeft: spacing.md, minWidth: 0 },
  itemName: { ...typography.bodySemibold, color: p.colors.text, marginBottom: spacing.xs },
  itemQty: { ...typography.bodySmall, color: p.colors.textSecondary },
  itemOption: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  itemTotal: { ...typography.bodySemibold, color: p.colors.primary, marginLeft: spacing.sm },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm, gap: spacing.md },
  summaryLabel: { ...typography.body, color: p.colors.textSecondary },
  summaryValue: { ...typography.body, color: p.colors.text, textAlign: 'right' },
  summaryTotal: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', marginTop: spacing.sm, paddingTop: spacing.md },
  totalLabel: { ...typography.bodySemibold, color: p.colors.text },
  totalValue: { ...typography.h3, color: p.colors.primary, textAlign: 'right' },
  statusOptions: { gap: spacing.sm },
  statusOption: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.12)' },
  statusOptionText: { ...typography.bodySemibold, color: p.colors.textSecondary, flex: 1 },
  currentBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.md },
  currentBadgeText: { ...typography.caption, color: 'white', fontWeight: fontWeight.bold },
});
