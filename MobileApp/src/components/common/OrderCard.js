/**
 * Premium buyer/seller order card.
 * Uses the human order ID and the backend's authoritative total/status fields.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import GlassPanel from './GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius, statusColors } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import {
  ORDER_STAGES,
  formatOrderItemOptions,
  getEstimatedDeliveryDate,
  getOrderDisplayId,
  getOrderItemCount,
  getOrderLeadItem,
  getOrderProgress,
  getOrderTotal,
  normalizeOrderStatus,
} from '../../utils/orderPresentation';

const STATUS_META = {
  pending: { icon: 'time-outline', label: 'Pending' },
  confirmed: { icon: 'checkmark-circle-outline', label: 'Confirmed' },
  processing: { icon: 'sparkles-outline', label: 'Processing' },
  shipped: { icon: 'car-outline', label: 'Shipped' },
  delivered: { icon: 'checkmark-done-outline', label: 'Delivered' },
  cancelled: { icon: 'close-circle-outline', label: 'Cancelled' },
};

const formatDate = (value, options = {}) => {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', ...options,
  });
};

const paymentLabel = (method) => ({
  stripe: 'Paid online',
  wallet: 'Rozare Wallet',
  cash_on_delivery: 'Cash on delivery',
}[method] || 'Payment');

const OrderCard = ({ order, onPress, showCustomer = false, onWhatsApp, style }) => {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const styles = React.useMemo(() => buildStyles(palette), [palette]);
  if (!order) return null;

  const status = normalizeOrderStatus(order.orderStatus || order.status);
  const meta = STATUS_META[status];
  const fallbackStatusStyle = statusColors.pending;
  const statusStyle = status === 'confirmed'
    ? { bg: palette.colors.infoLight, text: palette.colors.infoDark || palette.colors.info, solid: palette.colors.info }
    : (statusColors[status] || fallbackStatusStyle);
  const leadItem = getOrderLeadItem(order);
  const options = formatOrderItemOptions(leadItem);
  const itemCount = getOrderItemCount(order);
  const total = getOrderTotal(order);
  const currency = order.currency || order.orderCurrency || 'USD';
  const progress = getOrderProgress(status);
  const estimate = getEstimatedDeliveryDate(order);
  const customerName = order.user?.name || order.shippingInfo?.fullName;
  const additionalLines = Math.max(0, (order.orderItems?.length || 0) - 1);

  const deliveryLabel = status === 'delivered'
    ? `Delivered${order.deliveredAt ? ` ${formatDate(order.deliveredAt, { year: undefined })}` : ''}`
    : status === 'cancelled'
      ? 'Order closed'
      : estimate
        ? `Arrives by ${formatDate(estimate, { year: undefined })}`
        : 'Delivery estimate pending';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.86}
      style={style}
      accessibilityRole="button"
      accessibilityLabel={`Open ${getOrderDisplayId(order)}`}
    >
      <GlassPanel variant="card" style={styles.container}>
        <LinearGradient
          colors={['rgba(99,102,241,0.10)', 'rgba(14,165,233,0.025)', 'rgba(255,255,255,0)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />

        <View style={styles.header}>
          <View style={styles.identity}>
            <Text style={styles.eyebrow}>ORDER</Text>
            <Text style={styles.orderId} numberOfLines={1}>{getOrderDisplayId(order)}</Text>
            <Text style={styles.date}>{formatDate(order.createdAt)}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusStyle.bg, borderColor: `${statusStyle.solid}38` }]}>
            <Ionicons name={meta.icon} size={14} color={statusStyle.text} />
            <Text style={[styles.statusText, { color: statusStyle.text }]}>{meta.label}</Text>
          </View>
        </View>

        {showCustomer && customerName ? (
          <View style={styles.customerPill}>
            <Ionicons name="person-outline" size={13} color={palette.colors.textSecondary} />
            <Text style={styles.customerText} numberOfLines={1}>{customerName}</Text>
          </View>
        ) : null}

        <View style={styles.productRow}>
          <View style={styles.imageFrame}>
            {leadItem?.image || leadItem?.product?.image || leadItem?.productId?.image ? (
              <Image
                source={{ uri: leadItem.image || leadItem.product?.image || leadItem.productId?.image }}
                style={styles.productImage}
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={160}
              />
            ) : (
              <View style={styles.imagePlaceholder}>
                <Ionicons name="cube-outline" size={25} color={palette.colors.primary} />
              </View>
            )}
            {itemCount > 1 && (
              <View style={styles.quantityBadge}>
                <Text style={styles.quantityText}>{itemCount}</Text>
              </View>
            )}
          </View>

          <View style={styles.productCopy}>
            <Text style={styles.productName} numberOfLines={2}>{leadItem?.name || 'Your Rozare order'}</Text>
            {!!options && <Text style={styles.options} numberOfLines={1}>{options}</Text>}
            {additionalLines > 0 && (
              <Text style={styles.moreProducts}>+ {additionalLines} more product{additionalLines === 1 ? '' : 's'}</Text>
            )}
            <View style={styles.deliveryRow}>
              <Ionicons
                name={status === 'delivered' ? 'checkmark-circle' : status === 'cancelled' ? 'remove-circle-outline' : 'calendar-outline'}
                size={14}
                color={status === 'cancelled' ? palette.colors.textSecondary : statusStyle.solid}
              />
              <Text style={[styles.deliveryText, status === 'delivered' && { color: palette.colors.success }]} numberOfLines={1}>{deliveryLabel}</Text>
            </View>
          </View>
        </View>

        <View style={styles.progressTrack} accessibilityLabel={`${meta.label} order progress`}>
          {ORDER_STAGES.map((stage, index) => (
            <View
              key={stage}
              style={[
                styles.progressSegment,
                index < progress && { backgroundColor: status === 'cancelled' ? palette.colors.error : statusStyle.solid },
              ]}
            />
          ))}
        </View>

        <View style={styles.footer}>
          <View style={styles.paymentInfo}>
            <View style={styles.paymentLabelRow}>
              <Ionicons
                name={order.paymentMethod === 'cash_on_delivery' ? 'cash-outline' : order.paymentMethod === 'wallet' ? 'wallet-outline' : 'card-outline'}
                size={14}
                color={palette.colors.textSecondary}
              />
              <Text style={styles.paymentMethod}>{paymentLabel(order.paymentMethod)}</Text>
            </View>
            <Text style={[styles.paymentState, { color: order.isPaid ? palette.colors.success : palette.colors.warning }]}>
              {order.isPaid ? 'Payment complete' : order.paymentMethod === 'cash_on_delivery' ? 'Pay on delivery' : 'Payment pending'}
            </Text>
          </View>

          <View style={styles.totalBlock}>
            <Text style={styles.totalCaption}>ORDER TOTAL</Text>
            <Text style={styles.total}>{formatPrice(total, { sourceCurrency: currency })}</Text>
          </View>

          {onWhatsApp ? (
            <TouchableOpacity
              onPress={(event) => { event?.stopPropagation?.(); onWhatsApp(order); }}
              style={styles.whatsAppButton}
              accessibilityLabel="Order help on WhatsApp"
            >
              <Ionicons name="logo-whatsapp" size={18} color="#16a34a" />
            </TouchableOpacity>
          ) : (
            <View style={styles.chevron}>
              <Ionicons name="chevron-forward" size={18} color={palette.colors.primary} />
            </View>
          )}
        </View>
      </GlassPanel>
    </TouchableOpacity>
  );
};

export const CompactOrderCard = ({ order, onPress }) => {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const styles = React.useMemo(() => buildStyles(palette), [palette]);
  if (!order) return null;
  const status = normalizeOrderStatus(order.orderStatus || order.status);
  const color = status === 'confirmed' ? palette.colors.info : (statusColors[status]?.solid || palette.colors.warning);
  return (
    <TouchableOpacity style={styles.compactContainer} onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <View style={styles.compactContent}>
        <Text style={styles.compactOrderId}>{getOrderDisplayId(order)}</Text>
        <Text style={styles.compactStatus}>{STATUS_META[status].label}</Text>
      </View>
      <Text style={styles.compactAmount}>{formatPrice(getOrderTotal(order), { sourceCurrency: order.currency || 'USD' })}</Text>
      <Ionicons name="chevron-forward" size={16} color={palette.colors.textLight} />
    </TouchableOpacity>
  );
};

const buildStyles = (p) => StyleSheet.create({
  container: { padding: spacing.lg, marginBottom: spacing.md, borderRadius: 24 },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  identity: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 9, letterSpacing: 1.4, fontWeight: fontWeight.extrabold, color: p.colors.primary, marginBottom: 2 },
  orderId: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.25 },
  date: { marginTop: 3, fontSize: fontSize.xs, color: p.colors.textSecondary },
  statusBadge: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, borderRadius: borderRadius.full, borderWidth: 1 },
  statusText: { fontSize: 11, fontWeight: fontWeight.bold },
  customerPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: 10, backgroundColor: p.glass.bgSubtle },
  customerText: { maxWidth: 220, fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  productRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg },
  imageFrame: { position: 'relative', width: 76, height: 76 },
  productImage: { width: 76, height: 76, borderRadius: 20, backgroundColor: p.glass.bgSubtle },
  imagePlaceholder: { width: 76, height: 76, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.10)', borderWidth: 1, borderColor: p.glass.borderSubtle },
  quantityBadge: { position: 'absolute', right: -5, top: -5, minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 5, backgroundColor: p.colors.primary, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  quantityText: { color: '#fff', fontSize: 10, fontWeight: fontWeight.extrabold },
  productCopy: { flex: 1, marginLeft: spacing.md, minWidth: 0 },
  productName: { fontSize: fontSize.md, lineHeight: 19, fontWeight: fontWeight.bold, color: p.colors.text },
  options: { marginTop: 4, fontSize: 10, color: p.colors.textSecondary },
  moreProducts: { marginTop: 4, fontSize: fontSize.xs, color: p.colors.primary, fontWeight: fontWeight.semibold },
  deliveryRow: { marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 5 },
  deliveryText: { flex: 1, fontSize: 11, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  progressTrack: { flexDirection: 'row', gap: 4, marginTop: spacing.lg },
  progressSegment: { flex: 1, height: 4, borderRadius: 3, backgroundColor: p.glass.borderSubtle },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  paymentInfo: { flex: 1, minWidth: 0 },
  paymentLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  paymentMethod: { fontSize: 11, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  paymentState: { marginTop: 3, fontSize: 10, fontWeight: fontWeight.bold },
  totalBlock: { alignItems: 'flex-end', marginHorizontal: spacing.sm },
  totalCaption: { fontSize: 8, letterSpacing: 0.8, fontWeight: fontWeight.bold, color: p.colors.textLight },
  total: { marginTop: 2, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  chevron: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.10)' },
  whatsAppButton: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,197,94,0.12)' },
  compactContainer: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.md },
  compactContent: { flex: 1 },
  compactOrderId: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  compactStatus: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  compactAmount: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginRight: spacing.sm },
});

export default OrderCard;
