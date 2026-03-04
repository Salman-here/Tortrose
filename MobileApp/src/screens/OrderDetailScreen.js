/**
 * OrderDetailScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { colors, spacing, fontSize, fontWeight, borderRadius, shadows, glass, typography, statusColors } from '../styles/theme';
import Loader from '../components/common/Loader';
import { ErrorState } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';

const statusConfig = {
  pending: { color: statusColors.pending.solid, bgColor: statusColors.pending.bg, icon: 'time-outline', label: 'Pending', description: 'Your order is being reviewed' },
  confirmed: { color: statusColors.confirmed?.solid || colors.info, bgColor: statusColors.confirmed?.bg || colors.infoLight, icon: 'checkmark-circle-outline', label: 'Confirmed', description: 'Your order has been confirmed' },
  processing: { color: statusColors.processing.solid, bgColor: statusColors.processing.bg, icon: 'hourglass-outline', label: 'Processing', description: 'Your order is being prepared' },
  shipped: { color: statusColors.shipped.solid, bgColor: statusColors.shipped.bg, icon: 'airplane-outline', label: 'Shipped', description: 'Your order is on the way' },
  delivered: { color: statusColors.delivered.solid, bgColor: statusColors.delivered.bg, icon: 'checkmark-done-outline', label: 'Delivered', description: 'Your order has been delivered' },
  cancelled: { color: statusColors.cancelled.solid, bgColor: statusColors.cancelled.bg, icon: 'close-circle-outline', label: 'Cancelled', description: 'Your order has been cancelled' },
};
const statusTimeline = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];

export const canCancelOrder = (status) => ['pending', 'processing'].includes(status?.toLowerCase());

const getEstimatedDelivery = (order) => {
  if (!order?.createdAt) return null;
  let estimatedDays = 7;
  if (order.sellerShipping?.length > 0) estimatedDays = Math.max(...order.sellerShipping.map(s => s.shippingMethod?.estimatedDays || 7));
  else if (order.shippingMethod?.estimatedDays) estimatedDays = order.shippingMethod.estimatedDays;
  const d = new Date(order.createdAt); d.setDate(d.getDate() + estimatedDays);
  return d;
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
    try { setError(null); const res = await api.get(`/api/order/detail/${orderId}`); setOrder(res.data.order); }
    catch (err) { setError(err.response?.data?.message || 'Failed to load order details'); }
    finally { setIsLoading(false); setRefreshing(false); }
  }, [orderId]);

  useEffect(() => { fetchOrderDetail(); }, [fetchOrderDetail]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchOrderDetail(); }, [fetchOrderDetail]);

  const handleCancelOrder = useCallback(() => {
    Alert.alert('Cancel Order', 'Are you sure? This cannot be undone.', [
      { text: 'No, Keep Order', style: 'cancel' },
      { text: 'Yes, Cancel', style: 'destructive', onPress: async () => {
        try { setCancelling(true); await api.patch(`/api/order/cancel/${orderId}`, {}); Alert.alert('Success', 'Order cancelled.'); fetchOrderDetail(); }
        catch (err) { Alert.alert('Error', err.response?.data?.message || 'Failed to cancel'); }
        finally { setCancelling(false); }
      }},
    ]);
  }, [orderId, fetchOrderDetail]);

  const formatDate = (dateString, includeTime = true) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    if (includeTime) { options.hour = '2-digit'; options.minute = '2-digit'; }
    return date.toLocaleDateString('en-US', options);
  };

  if (isLoading) return <GlassBackground><View style={styles.center}><Loader size="large" /></View></GlassBackground>;
  if (error) return <GlassBackground><View style={styles.center}><ErrorState message={error} onRetry={fetchOrderDetail} /></View></GlassBackground>;
  if (!order) return <GlassBackground><View style={styles.center}><ErrorState message="Order not found" onRetry={() => navigation.goBack()} /></View></GlassBackground>;

  const status = order.orderStatus || 'pending';
  const config = statusConfig[status] || statusConfig.pending;
  const currentStatusIndex = statusTimeline.indexOf(status);
  const isCancellable = canCancelOrder(status);
  const estimatedDelivery = getEstimatedDelivery(order);
  const subtotal = order.orderSummary?.subtotal || 0;
  const tax = order.orderSummary?.tax || 0;
  let actualShipping = order.orderSummary?.shippingCost || 0;
  if (order.sellerShipping?.length > 0) actualShipping = order.sellerShipping.reduce((s, ss) => s + (ss.shippingMethod?.price || 0), 0);
  const total = subtotal + tax + actualShipping;

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}>
        
        {/* Status Header */}
        <GlassPanel variant="strong" style={styles.statusSection}>
          <View style={[styles.statusIconWrap, { backgroundColor: config.bgColor }]}>
            <Ionicons name={config.icon} size={36} color={config.color} />
          </View>
          <Text style={[styles.statusLabel, { color: config.color }]}>{config.label}</Text>
          <Text style={styles.statusDesc}>{config.description}</Text>
          <Text style={styles.orderId}>Order #{order.orderId || order._id?.slice(-8).toUpperCase()}</Text>
          <Text style={styles.orderDate}>{formatDate(order.createdAt)}</Text>
        </GlassPanel>

        {/* Timeline */}
        {status !== 'cancelled' && (
          <GlassPanel variant="card" style={styles.section}>
            <Text style={styles.sectionTitle}>Order Timeline</Text>
            {statusTimeline.map((ts, index) => {
              const isCompleted = index <= currentStatusIndex;
              const isCurrent = index === currentStatusIndex;
              const tc = statusConfig[ts];
              return (
                <View key={ts} style={styles.timelineItem}>
                  <View style={styles.timelineLeft}>
                    <View style={[styles.dot, isCompleted && styles.dotDone, isCurrent && styles.dotCurrent]}>
                      {isCompleted && <Ionicons name="checkmark" size={12} color="#fff" />}
                    </View>
                    {index < statusTimeline.length - 1 && <View style={[styles.line, isCompleted && styles.lineDone]} />}
                  </View>
                  <View style={styles.timelineContent}>
                    <Text style={[styles.timelineLabel, isCompleted && { color: colors.text }, isCurrent && { color: colors.primary, fontWeight: fontWeight.semibold }]}>{tc.label}</Text>
                    {isCurrent && <Text style={styles.timelineDesc}>{tc.description}</Text>}
                  </View>
                </View>
              );
            })}
          </GlassPanel>
        )}

        {/* Estimated Delivery */}
        {estimatedDelivery && status !== 'delivered' && status !== 'cancelled' && (
          <GlassPanel variant="inner" style={styles.deliveryBanner}>
            <Ionicons name="calendar-outline" size={18} color={colors.primary} />
            <View style={{ marginLeft: spacing.md }}>
              <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary }}>Estimated Delivery</Text>
              <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text }}>{formatDate(estimatedDelivery, false)}</Text>
            </View>
          </GlassPanel>
        )}

        {/* Items */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Order Items ({order.orderItems?.length || 0})</Text>
          {order.orderItems?.map((item, index) => (
            <View key={index} style={[styles.orderItem, index === order.orderItems.length - 1 && { borderBottomWidth: 0 }]}>
              <Image source={{ uri: item.image || 'https://via.placeholder.com/80' }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
              <View style={styles.itemInfo}>
                <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                <Text style={styles.itemQty}>Qty: {item.quantity || item.qty}</Text>
                <Text style={styles.itemPrice}>{formatPrice(item.price)}</Text>
              </View>
            </View>
          ))}
        </GlassPanel>

        {/* Shipping */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Shipping Address</Text>
          <View style={styles.innerCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
              <Ionicons name="location" size={18} color={colors.primary} />
              <Text style={{ ...typography.bodySemibold, marginLeft: spacing.sm }}>{order.shippingInfo?.fullName}</Text>
            </View>
            <Text style={styles.addressText}>{order.shippingInfo?.address}</Text>
            <Text style={styles.addressText}>{order.shippingInfo?.city}, {order.shippingInfo?.state} {order.shippingInfo?.postalCode}</Text>
            <Text style={styles.addressText}>{order.shippingInfo?.country}</Text>
          </View>
        </GlassPanel>

        {/* Payment */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Payment</Text>
          <View style={[styles.innerCard, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name={order.paymentMethod === 'cash_on_delivery' ? 'cash-outline' : 'card-outline'} size={22} color={colors.primary} />
              <Text style={{ ...typography.bodySemibold, marginLeft: spacing.sm }}>{order.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : 'Card Payment'}</Text>
            </View>
            <View style={[styles.paymentBadge, { backgroundColor: order.paymentStatus === 'paid' ? colors.successLight : colors.warningLight }]}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: order.paymentStatus === 'paid' ? colors.success : colors.warning }}>{order.paymentStatus === 'paid' ? 'Paid' : 'Unpaid'}</Text>
            </View>
          </View>
        </GlassPanel>

        {/* Summary */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Order Summary</Text>
          <View style={styles.innerCard}>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>{formatPrice(subtotal)}</Text></View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Shipping</Text><Text style={styles.summaryValue}>{formatPrice(actualShipping)}</Text></View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Tax</Text><Text style={styles.summaryValue}>{formatPrice(tax)}</Text></View>
            <View style={styles.divider} />
            <View style={styles.summaryRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{formatPrice(total)}</Text></View>
          </View>
        </GlassPanel>

        {/* Cancel */}
        {isCancellable && (
          <TouchableOpacity style={[styles.cancelBtn, cancelling && { opacity: 0.6 }]} onPress={handleCancelOrder} disabled={cancelling}>
            {cancelling ? <Loader size="small" color={colors.error} /> : (
              <>
                <Ionicons name="close-circle-outline" size={20} color={colors.error} />
                <Text style={styles.cancelText}>Cancel Order</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  statusSection: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  statusIconWrap: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  statusLabel: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, marginBottom: 4 },
  statusDesc: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.md },
  orderId: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  orderDate: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  section: { marginBottom: spacing.md, padding: spacing.lg },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text, marginBottom: spacing.md },
  timelineItem: { flexDirection: 'row', minHeight: 48 },
  timelineLeft: { alignItems: 'center', width: 24, marginRight: spacing.md },
  dot: { width: 24, height: 24, borderRadius: 12, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: glass.border },
  dotDone: { backgroundColor: colors.success, borderColor: colors.success },
  dotCurrent: { backgroundColor: colors.primary, borderColor: colors.primary },
  line: { width: 2, flex: 1, backgroundColor: glass.border, marginVertical: 4 },
  lineDone: { backgroundColor: colors.success },
  timelineContent: { flex: 1, paddingBottom: spacing.md },
  timelineLabel: { fontSize: fontSize.md, color: colors.textSecondary },
  timelineDesc: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  deliveryBanner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.md },
  orderItem: { flexDirection: 'row', paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: glass.borderSubtle },
  itemImage: { width: 64, height: 64, borderRadius: 12, backgroundColor: glass.bgSubtle },
  itemInfo: { flex: 1, marginLeft: spacing.md, justifyContent: 'center' },
  itemName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: 4 },
  itemQty: { fontSize: fontSize.xs, color: colors.textSecondary, marginBottom: 4 },
  itemPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.primary },
  innerCard: { backgroundColor: glass.bgSubtle, borderRadius: 14, padding: spacing.md, borderWidth: 1, borderColor: glass.borderSubtle },
  addressText: { fontSize: fontSize.sm, color: colors.textSecondary, marginLeft: spacing.xl + spacing.sm, lineHeight: 20 },
  paymentBadge: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: 12 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  summaryLabel: { fontSize: fontSize.md, color: colors.textSecondary },
  summaryValue: { fontSize: fontSize.md, color: colors.text },
  divider: { height: 1, backgroundColor: glass.borderSubtle, marginVertical: spacing.md },
  totalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  totalValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.primary },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239,68,68,0.1)', paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.error, gap: spacing.sm, marginTop: spacing.sm },
  cancelText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.error },
});
