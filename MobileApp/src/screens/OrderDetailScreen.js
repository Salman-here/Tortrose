/**
 * OrderDetailScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, RefreshControl, SafeAreaView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { useGlobal } from '../contexts/GlobalContext';
import { spacing, fontSize, fontWeight, borderRadius, shadows, typography, statusColors } from '../styles/theme';
import Loader from '../components/common/Loader';
import { ErrorState } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import BuyerReturnsSection from '../components/BuyerReturnsSection';
import { shareInvoice } from '../utils/invoiceUtils';
import { useTheme } from '../contexts/ThemeContext';

const getStatusConfig = (palette) => ({
  pending: { color: statusColors.pending.solid, bgColor: statusColors.pending.bg, icon: 'time-outline', label: 'Pending', description: 'Your order is being reviewed' },
  confirmed: { color: statusColors.confirmed?.solid || palette.colors.info, bgColor: statusColors.confirmed?.bg || palette.colors.infoLight, icon: 'checkmark-circle-outline', label: 'Confirmed', description: 'Your order has been confirmed' },
  processing: { color: statusColors.processing.solid, bgColor: statusColors.processing.bg, icon: 'hourglass-outline', label: 'Processing', description: 'Your order is being prepared' },
  shipped: { color: statusColors.shipped.solid, bgColor: statusColors.shipped.bg, icon: 'airplane-outline', label: 'Shipped', description: 'Your order is on the way' },
  delivered: { color: statusColors.delivered.solid, bgColor: statusColors.delivered.bg, icon: 'checkmark-done-outline', label: 'Delivered', description: 'Your order has been delivered' },
  cancelled: { color: statusColors.cancelled.solid, bgColor: statusColors.cancelled.bg, icon: 'close-circle-outline', label: 'Cancelled', description: 'Your order has been cancelled' },
});
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
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { orderId } = route.params;
  const { formatPrice } = useCurrency();
  const { fetchCart } = useGlobal();
  const [order, setOrder] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);
  const [reordering, setReordering] = useState(false);
  const [sharingInvoice, setSharingInvoice] = useState(false);
  const orderMoney = useCallback((amount) => formatPrice(amount || 0, { sourceCurrency: order?.currency || 'USD' }), [formatPrice, order?.currency]);

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

  const handleReorder = useCallback(async () => {
    try {
      setReordering(true);
      const res = await api.post(`/api/order/reorder/${orderId}`);
      const added = res.data?.addedCount || 0;
      const skipped = res.data?.skippedItems?.length || 0;
      await fetchCart();
      Alert.alert(
        'Re-ordered',
        `${added} item${added !== 1 ? 's' : ''} added to cart${skipped ? `\n${skipped} item${skipped !== 1 ? 's' : ''} unavailable` : ''}.`,
        [
          { text: 'View Cart', onPress: () => navigation.navigate('MainTabs', { screen: 'Cart' }) },
          { text: 'OK' },
        ]
      );
    } catch (err) {
      Alert.alert('Re-order Failed', err.response?.data?.message || 'Unable to re-order.');
    } finally { setReordering(false); }
  }, [orderId, fetchCart, navigation]);

  const handleShareInvoice = useCallback(async () => {
    try {
      setSharingInvoice(true);
      await shareInvoice(order?._id || order?.orderId);
    } catch (err) {
      Alert.alert('Share Failed', err.message || 'Unable to generate invoice.');
    } finally { setSharingInvoice(false); }
  }, [order]);

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

  const statusConfig = getStatusConfig(palette);
  const status = order.orderStatus || 'pending';
  const config = statusConfig[status] || statusConfig.pending;
  const currentStatusIndex = statusTimeline.indexOf(status);
  const fulfillmentStarted = (order.sellerFulfillment || []).some(entry => ['shipped', 'delivered'].includes(entry.status));
  const isCancellable = canCancelOrder(status) && !order.isPaid && !fulfillmentStarted;
  const estimatedDelivery = getEstimatedDelivery(order);
  const subtotal = order.orderSummary?.subtotal || 0;
  const tax = order.orderSummary?.tax || 0;
  let actualShipping = order.orderSummary?.shippingCost || 0;
  if (order.sellerShipping?.length > 0) actualShipping = order.sellerShipping.reduce((s, ss) => s + (ss.shippingMethod?.price || 0), 0);
  const total = order.orderSummary?.totalAmount ?? (subtotal + tax + actualShipping - (order.orderSummary?.couponDiscount || 0));

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
      {/* Custom Header */}
      <GlassPanel variant="floating" style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.md, marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.md }}>
        <TouchableOpacity style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' }} onPress={() => navigation.goBack()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
        </TouchableOpacity>
        <Text style={{ flex: 1, fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text }}>Order Details</Text>
      </GlassPanel>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}>
        
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

        {/* Buyer-side email confirmation status */}
        {order.confirmation?.confirmedAt && (
          <GlassPanel variant="inner" style={[styles.deliveryBanner, { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.08)' }]}>
            <Ionicons name="checkmark-circle" size={20} color="#10b981" />
            <View style={{ marginLeft: spacing.md, flex: 1 }}>
              <Text style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: '#059669' }}>
                You confirmed via {order.confirmation.confirmedVia || 'email'}
              </Text>
              <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary, marginTop: 2 }}>
                {formatDate(order.confirmation.confirmedAt)} - seller has been notified.
              </Text>
            </View>
          </GlassPanel>
        )}

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
                    <Text style={[styles.timelineLabel, isCompleted && { color: palette.colors.text }, isCurrent && { color: palette.colors.primary, fontWeight: fontWeight.semibold }]}>{tc.label}</Text>
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
            <Ionicons name="calendar-outline" size={18} color={palette.colors.primary} />
            <View style={{ marginLeft: spacing.md }}>
              <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>Estimated Delivery</Text>
              <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: palette.colors.text }}>{formatDate(estimatedDelivery, false)}</Text>
            </View>
          </GlassPanel>
        )}

        {/* Items */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Order Items ({order.orderItems?.length || 0})</Text>
          {order.orderItems?.map((item, index) => {
            const selectedOptions = item.selectedOptions && typeof item.selectedOptions === 'object'
              ? Object.entries(item.selectedOptions).filter(([, value]) => value)
              : [];
            return (
              <View key={index} style={[styles.orderItem, index === order.orderItems.length - 1 && { borderBottomWidth: 0 }]}>
                <Image source={{ uri: item.image || 'https://rozare.com/favicon-512.png' }} style={styles.itemImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                <View style={styles.itemInfo}>
                  <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                  {item.selectedColor && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <Ionicons name="color-palette-outline" size={12} color={palette.colors.primary} />
                      <Text style={{ fontSize: 11, color: palette.colors.primary, fontWeight: fontWeight.medium }}>{item.selectedColor}</Text>
                    </View>
                  )}
                  {selectedOptions.map(([name, value]) => (
                    <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                      <Ionicons name="options-outline" size={12} color={palette.colors.primary} />
                      <Text style={{ fontSize: 11, color: palette.colors.primary, fontWeight: fontWeight.medium }}>{name}: {value}</Text>
                    </View>
                  ))}
                  <Text style={styles.itemQty}>Qty: {item.quantity || item.qty}</Text>
                  <Text style={styles.itemPrice}>{orderMoney(item.price)}</Text>
                </View>
              </View>
            );
          })}
        </GlassPanel>

        <BuyerReturnsSection order={order} formatMoney={orderMoney} />

        {/* Shipping */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Shipping Address</Text>
          <View style={styles.innerCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
              <Ionicons name="location" size={18} color={palette.colors.primary} />
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
              <Ionicons name={order.paymentMethod === 'cash_on_delivery' ? 'cash-outline' : order.paymentMethod === 'wallet' ? 'wallet-outline' : 'card-outline'} size={22} color={palette.colors.primary} />
              <Text style={{ ...typography.bodySemibold, marginLeft: spacing.sm }}>
                {order.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : order.paymentMethod === 'wallet' ? 'Rozare Wallet' : 'Card Payment'}
              </Text>
            </View>
            <View style={[styles.paymentBadge, { backgroundColor: order.isPaid ? palette.colors.successLight : palette.colors.warningLight }]}>
              <Text style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: order.isPaid ? palette.colors.success : palette.colors.warning }}>{order.isPaid ? 'Paid' : 'Unpaid'}</Text>
            </View>
          </View>
        </GlassPanel>

        {/* Summary */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Order Summary</Text>
          <View style={styles.innerCard}>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>{orderMoney(subtotal)}</Text></View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Shipping</Text><Text style={styles.summaryValue}>{orderMoney(actualShipping)}</Text></View>
            <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Tax</Text><Text style={styles.summaryValue}>{orderMoney(tax)}</Text></View>
            {(order.orderSummary?.couponDiscount || 0) > 0 && (
              <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Coupon Discount</Text><Text style={[styles.summaryValue, { color: palette.colors.success }]}>-{orderMoney(order.orderSummary.couponDiscount)}</Text></View>
            )}
            <View style={styles.divider} />
            <View style={styles.summaryRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{orderMoney(total)}</Text></View>
          </View>
        </GlassPanel>

        {/* Action Buttons: Re-order + Share Invoice */}
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
          <TouchableOpacity
            style={[styles.actionPrimary, reordering && { opacity: 0.6 }]}
            onPress={handleReorder}
            disabled={reordering}
            activeOpacity={0.85}
          >
            {reordering ? <Loader size="small" color="#fff" /> : (
              <>
                <Ionicons name="repeat" size={18} color="#fff" />
                <Text style={styles.actionPrimaryText}>Re-order</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionSecondary, sharingInvoice && { opacity: 0.6 }]}
            onPress={handleShareInvoice}
            disabled={sharingInvoice}
            activeOpacity={0.85}
          >
            {sharingInvoice ? <Loader size="small" color={palette.colors.primary} /> : (
              <>
                <Ionicons name="share-outline" size={18} color={palette.colors.primary} />
                <Text style={styles.actionSecondaryText}>Invoice</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Cancel */}
        {isCancellable && (
          <TouchableOpacity style={[styles.cancelBtn, cancelling && { opacity: 0.6 }]} onPress={handleCancelOrder} disabled={cancelling}>
            {cancelling ? <Loader size="small" color={palette.colors.error} /> : (
              <>
                <Ionicons name="close-circle-outline" size={20} color={palette.colors.error} />
                <Text style={styles.cancelText}>Cancel Order</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  statusSection: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  statusIconWrap: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  statusLabel: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, marginBottom: 4 },
  statusDesc: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.md },
  orderId: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  orderDate: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  section: { marginBottom: spacing.md, padding: spacing.lg },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.md },
  timelineItem: { flexDirection: 'row', minHeight: 48 },
  timelineLeft: { alignItems: 'center', width: 24, marginRight: spacing.md },
  dot: { width: 24, height: 24, borderRadius: 12, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: p.glass.border },
  dotDone: { backgroundColor: p.colors.success, borderColor: p.colors.success },
  dotCurrent: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  line: { width: 2, flex: 1, backgroundColor: p.glass.border, marginVertical: 4 },
  lineDone: { backgroundColor: p.colors.success },
  timelineContent: { flex: 1, paddingBottom: spacing.md },
  timelineLabel: { fontSize: fontSize.md, color: p.colors.textSecondary },
  timelineDesc: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  deliveryBanner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.md },
  orderItem: { flexDirection: 'row', paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  itemImage: { width: 64, height: 64, borderRadius: 12, backgroundColor: p.glass.bgSubtle },
  itemInfo: { flex: 1, marginLeft: spacing.md, justifyContent: 'center' },
  itemName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: 4 },
  itemQty: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginBottom: 4 },
  itemPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.primary },
  innerCard: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: spacing.md, borderWidth: 1, borderColor: p.glass.borderSubtle },
  addressText: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginLeft: spacing.xl + spacing.sm, lineHeight: 20 },
  paymentBadge: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: 12 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  summaryLabel: { fontSize: fontSize.md, color: p.colors.textSecondary },
  summaryValue: { fontSize: fontSize.md, color: p.colors.text },
  divider: { height: 1, backgroundColor: p.glass.borderSubtle, marginVertical: spacing.md },
  totalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  totalValue: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.primary },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(239,68,68,0.1)', paddingVertical: 14, borderRadius: 16, borderWidth: 1, borderColor: p.colors.error, gap: spacing.sm, marginTop: spacing.sm },
  cancelText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.error },
  actionPrimary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingVertical: 14, borderRadius: 16 },
  actionPrimaryText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: '#fff' },
  actionSecondary: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: 'rgba(99,102,241,0.08)', paddingVertical: 14, borderRadius: 16, borderWidth: 1.5, borderColor: p.colors.primary },
  actionSecondaryText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.primary },
});
