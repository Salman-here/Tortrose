/**
 * OrderDetailManagementScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography, glass,
} from '../../styles/theme';

const STATUS_CONFIG = {
  pending: { color: colors.warning, icon: 'time-outline', label: 'Pending' },
  processing: { color: colors.info, icon: 'sync-outline', label: 'Processing' },
  shipped: { color: colors.primary, icon: 'airplane-outline', label: 'Shipped' },
  delivered: { color: colors.success, icon: 'checkmark-circle-outline', label: 'Delivered' },
  cancelled: { color: colors.error, icon: 'close-circle-outline', label: 'Cancelled' },
};

const STATUS_OPTIONS = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

export default function OrderDetailManagementScreen({ route, navigation }) {
  const { orderId, isAdmin } = route.params;
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState(null);

  useEffect(() => { fetchOrder(); }, [orderId]);

  const fetchOrder = async () => {
    try {
      const res = await api.get(`/api/order/detail/${orderId}`);
      setOrder(res.data); setSelectedStatus(res.data.status);
    } catch (e) { Alert.alert('Error', 'Failed to fetch order'); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchOrder(); }, [orderId]);

  const updateStatus = async (newStatus) => {
    if (newStatus === order.status) return;
    Alert.alert('Update Status', `Change to "${STATUS_CONFIG[newStatus]?.label}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Update', onPress: async () => {
        setUpdating(true);
        try { await api.patch(`/api/order/update-status/${orderId}`, { status: newStatus }); setOrder(p => ({ ...p, status: newStatus })); setSelectedStatus(newStatus); Alert.alert('Success', 'Status updated'); }
        catch (e) { Alert.alert('Error', 'Failed to update'); }
        finally { setUpdating(false); }
      }},
    ]);
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading order..." /></GlassBackground>;

  if (!order) return (
    <GlassBackground>
      <View style={styles.errorContainer}>
        <Ionicons name="receipt-outline" size={64} color={colors.textSecondary} />
        <Text style={styles.errorTitle}>Order not found</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    </GlassBackground>
  );

  const statusConfig = STATUS_CONFIG[order.status] || STATUS_CONFIG.pending;

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        <GlassPanel variant="floating" style={styles.header}>
          <View>
            <Text style={styles.orderIdLabel}>Order</Text>
            <Text style={styles.orderId}>#{order._id.slice(-8).toUpperCase()}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.color }]}>
            <Ionicons name={statusConfig.icon} size={16} color="white" />
            <Text style={styles.statusText}>{statusConfig.label}</Text>
          </View>
        </GlassPanel>

        {/* Timeline */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Order Timeline</Text>
          {STATUS_OPTIONS.filter(s => s !== 'cancelled').map((status, index) => {
            const config = STATUS_CONFIG[status];
            const isCompleted = STATUS_OPTIONS.indexOf(order.status) >= index;
            const isCurrent = order.status === status;
            return (
              <View key={status} style={styles.timelineItem}>
                <View style={styles.timelineLeft}>
                  <View style={[styles.timelineDot, isCompleted && { backgroundColor: config.color }, isCurrent && styles.timelineDotCurrent]}>
                    {isCompleted && <Ionicons name="checkmark" size={12} color="white" />}
                  </View>
                  {index < 3 && <View style={[styles.timelineLine, isCompleted && { backgroundColor: config.color }]} />}
                </View>
                <Text style={[styles.timelineLabel, isCurrent && styles.timelineLabelCurrent]}>{config.label}</Text>
              </View>
            );
          })}
        </GlassPanel>

        {/* Customer Info */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Customer</Text>
          <View style={styles.infoCard}>
            {[{ icon: 'person-outline', text: order.shippingAddress?.fullName || 'N/A' },
              { icon: 'mail-outline', text: order.user?.email || 'N/A' },
              { icon: 'location-outline', text: `${order.shippingAddress?.address || ''}, ${order.shippingAddress?.city || ''}` },
            ].map((info, i) => (
              <View key={i} style={styles.infoRow}>
                <Ionicons name={info.icon} size={18} color={colors.primary} />
                <Text style={styles.infoText}>{info.text}</Text>
              </View>
            ))}
          </View>
        </GlassPanel>

        {/* Items */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Items ({order.items?.length || 0})</Text>
          {order.items?.map((item, index) => (
            <View key={index} style={styles.itemCard}>
              {item.product?.images?.[0] ? (
                <Image source={{ uri: item.product.images[0] }} style={styles.itemImage} contentFit="cover" />
              ) : (
                <View style={[styles.itemImage, { justifyContent: 'center', alignItems: 'center' }]}>
                  <Ionicons name="cube-outline" size={24} color={colors.textSecondary} />
                </View>
              )}
              <View style={{ flex: 1, marginLeft: spacing.md }}>
                <Text style={styles.itemName} numberOfLines={2}>{item.product?.name || 'Product'}</Text>
                <Text style={styles.itemQty}>Qty: {item.quantity}</Text>
              </View>
              <Text style={styles.itemTotal}>${(item.quantity * item.price).toFixed(2)}</Text>
            </View>
          ))}
        </GlassPanel>

        {/* Summary */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Summary</Text>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>${(order.totalAmount - (order.shippingCost || 0)).toFixed(2)}</Text></View>
          <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Shipping</Text><Text style={styles.summaryValue}>${(order.shippingCost || 0).toFixed(2)}</Text></View>
          <View style={[styles.summaryRow, styles.summaryTotal]}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>${order.totalAmount?.toFixed(2)}</Text></View>
        </GlassPanel>

        {/* Update Status */}
        {order.status !== 'delivered' && order.status !== 'cancelled' && (
          <GlassPanel variant="card" style={styles.section}>
            <Text style={styles.sectionTitle}>Update Status</Text>
            <View style={styles.statusOptions}>
              {STATUS_OPTIONS.map(status => {
                const config = STATUS_CONFIG[status];
                const isSelected = selectedStatus === status;
                const isCurrent = order.status === status;
                return (
                  <TouchableOpacity key={status} style={[styles.statusOption, isSelected && { borderColor: config.color, backgroundColor: config.color + '15' }]}
                    onPress={() => updateStatus(status)} disabled={updating || isCurrent} activeOpacity={0.7}>
                    <Ionicons name={config.icon} size={20} color={isSelected ? config.color : colors.textSecondary} />
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

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl },
  errorTitle: { ...typography.h3, color: colors.text, marginTop: spacing.lg, marginBottom: spacing.xl },
  backButton: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg },
  backButtonText: { ...typography.bodySemibold, color: 'white' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: spacing.lg, padding: spacing.lg },
  orderIdLabel: { ...typography.body, color: colors.textSecondary },
  orderId: { ...typography.h3, color: colors.text },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, gap: spacing.xs },
  statusText: { ...typography.bodySemibold, color: 'white', fontSize: fontSize.sm },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  sectionTitle: { ...typography.h4, color: colors.text, marginBottom: spacing.md },
  timelineItem: { flexDirection: 'row', minHeight: 50 },
  timelineLeft: { alignItems: 'center', width: 30 },
  timelineDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
  timelineDotCurrent: { borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)' },
  timelineLine: { width: 2, flex: 1, backgroundColor: 'rgba(255,255,255,0.1)', marginVertical: spacing.xs },
  timelineLabel: { ...typography.body, color: colors.textSecondary, paddingLeft: spacing.md, paddingBottom: spacing.md },
  timelineLabelCurrent: { ...typography.bodySemibold, color: colors.text },
  infoCard: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: borderRadius.lg, padding: spacing.md, gap: spacing.md },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  infoText: { ...typography.body, color: colors.text, flex: 1 },
  itemCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: borderRadius.lg, padding: spacing.md, marginBottom: spacing.sm },
  itemImage: { width: 60, height: 60, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.04)' },
  itemName: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.xs },
  itemQty: { ...typography.bodySmall, color: colors.textSecondary },
  itemTotal: { ...typography.bodySemibold, color: colors.primary },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.sm },
  summaryLabel: { ...typography.body, color: colors.textSecondary },
  summaryValue: { ...typography.body, color: colors.text },
  summaryTotal: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', marginTop: spacing.sm, paddingTop: spacing.md },
  totalLabel: { ...typography.bodySemibold, color: colors.text },
  totalValue: { ...typography.h3, color: colors.primary },
  statusOptions: { gap: spacing.sm },
  statusOption: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.12)' },
  statusOptionText: { ...typography.bodySemibold, color: colors.textSecondary, flex: 1 },
  currentBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.md },
  currentBadgeText: { ...typography.caption, color: 'white', fontWeight: fontWeight.bold },
});
