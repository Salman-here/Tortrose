/**
 * OrderDetailManagementScreen - Liquid Glass
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
} from '../../components/seller/SellerUI';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import {
  getConfirmationSourceLabel,
  hasWhatsAppPhone,
  isOrderConfirmedByBuyer,
  openWhatsAppVerify,
} from '../../utils/whatsapp';

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

const getItemImage = (item) => {
  const image = item?.image
    || item?.product?.image
    || item?.productId?.image
    || item?.product?.images?.[0]
    || item?.productId?.images?.[0];
  return typeof image === 'string' ? image : (image?.url || image?.secure_url || '');
};

const getItemName = (item) => item?.name || item?.product?.name || item?.productId?.name || 'Product';

const getSelectedOptions = (item) => {
  if (!item?.selectedOptions || typeof item.selectedOptions !== 'object') return [];
  return Object.entries(item.selectedOptions).filter(([, value]) => value);
};

export default function OrderDetailManagementScreen({ route, navigation }) {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const STATUS_CONFIG = useMemo(() => getStatusConfig(palette), [palette]);

  const { orderId, isAdmin } = route.params || {};
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const fetchOrder = useCallback(async ({ initial = false } = {}) => {
    if (initial) setLoading(true);
    setLoadError('');
    try {
      const res = await api.get(`${API_ENDPOINTS.ORDERS.DETAIL}/${orderId}`);
      const nextOrder = res.data?.order || res.data;
      setOrder(nextOrder);
      setSelectedStatus(nextOrder?.orderStatus || nextOrder?.status || 'pending');
      setHasLoaded(true);
    } catch (e) {
      setLoadError(e.response?.data?.msg || 'This order could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orderId]);

  useEffect(() => {
    fetchOrder({ initial: true });
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
          setActionError('');
          setSuccessMessage('');
          try {
            const response = await api.patch(`${API_ENDPOINTS.ORDERS.UPDATE_STATUS}/${orderId}`, { newStatus });
            const sellerStatus = response?.data?.orderStatus || newStatus;
            setOrder((previous) => ({ ...previous, orderStatus: sellerStatus, status: sellerStatus }));
            setSelectedStatus(sellerStatus);
            setSuccessMessage(`Fulfilment status changed to ${STATUS_CONFIG[sellerStatus]?.label || sellerStatus}.`);
            await fetchOrder();
          } catch (e) {
            setActionError(e.response?.data?.msg || 'The order status could not be updated.');
          } finally {
            setUpdating(false);
          }
        },
      },
    ]);
  };

  if (loading && !hasLoaded) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Order Details"
        subtitle="Customer, items and fulfilment"
        icon="receipt-outline"
        variant="form"
      />
    );
  }

  if (!order || !hasLoaded) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top']}>
          <SellerScreenHeader navigation={navigation} title="Order Details" subtitle="Customer, items and fulfilment" icon="receipt-outline" />
          <View style={styles.errorContainer}>
            <SellerInlineError
              title="Order unavailable"
              message={loadError || 'This order was not found or is outside your seller account.'}
              onRetry={() => fetchOrder({ initial: true })}
            />
          </View>
        </SafeAreaView>
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
  const confirmationLabel = getConfirmationSourceLabel(order);
  const confirmation = order.confirmation || {};
  const canVerifyOnWhatsApp = hasWhatsAppPhone(order) && !isOrderConfirmedByBuyer(order);
  const paymentMethodLabel = {
    cash_on_delivery: 'Cash on delivery',
    stripe: 'Card / Stripe',
    wallet: 'Rozare Wallet',
  }[order.paymentMethod] || order.paymentMethod || 'Payment method unavailable';
  const displayOrderId = order.orderId || `#${String(order._id || '').slice(-8).toUpperCase()}`;

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top']}>
      <SellerScreenHeader
        navigation={navigation}
        title="Order Details"
        subtitle={displayOrderId}
        icon="receipt-outline"
        rightIcon="refresh-outline"
        rightLabel="Refresh"
        onRightPress={onRefresh}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        <GlassPanel variant="floating" style={styles.header}>
          <View>
            <Text style={styles.orderIdLabel}>Order</Text>
            <Text style={styles.orderId} numberOfLines={1}>{displayOrderId}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusConfig.color }]}>
            <Ionicons name={statusConfig.icon} size={16} color="white" />
            <Text style={styles.statusText}>{statusConfig.label}</Text>
          </View>
        </GlassPanel>

        {!!loadError && (
          <SellerInlineError compact title="Order did not refresh" message={loadError} onRetry={onRefresh} />
        )}
        {!!actionError && (
          <SellerInlineError compact title="Status was not updated" message={actionError} />
        )}
        {!!successMessage && (
          <View style={styles.successBanner} accessibilityRole="alert">
            <Ionicons name="checkmark-circle" size={18} color={palette.colors.success} />
            <Text style={styles.successText}>{successMessage}</Text>
          </View>
        )}

        <GlassPanel variant="strong" style={styles.decisionSection}>
          <View style={styles.decisionHeader}>
            <View style={[styles.decisionIcon, { backgroundColor: confirmationLabel && !/cancel/i.test(confirmationLabel) ? palette.colors.successSubtle : palette.colors.primarySubtle }]}>
              <Ionicons
                name={confirmationLabel ? (/cancel/i.test(confirmationLabel) ? 'close-circle-outline' : 'shield-checkmark-outline') : 'help-circle-outline'}
                size={22}
                color={confirmationLabel && !/cancel/i.test(confirmationLabel) ? palette.colors.success : (/cancel/i.test(confirmationLabel) ? palette.colors.error : palette.colors.primary)}
              />
            </View>
            <View style={styles.decisionCopy}>
              <Text style={styles.decisionEyebrow}>BUYER CONFIRMATION</Text>
              <Text style={styles.decisionTitle}>{confirmationLabel || 'Waiting for buyer confirmation'}</Text>
              <Text style={styles.decisionSubtitle}>
                {confirmation.confirmedAt || confirmation.declinedAt
                  ? `Decision recorded ${new Date(confirmation.confirmedAt || confirmation.declinedAt).toLocaleString()}`
                  : 'Use Rozare WhatsApp only when the buyer has not already confirmed.'}
              </Text>
            </View>
          </View>
          {!!confirmation.cancelledFromDashboardNote && (
            <View style={styles.decisionNote}>
              <Ionicons name="information-circle-outline" size={16} color={palette.colors.warning} />
              <Text style={styles.decisionNoteText}>{confirmation.cancelledFromDashboardNote}</Text>
            </View>
          )}
          {canVerifyOnWhatsApp && (
            <TouchableOpacity
              style={styles.whatsAppButton}
              onPress={() => openWhatsAppVerify(order, formatPrice)}
              accessibilityRole="button"
              accessibilityLabel="Verify this order with the buyer on WhatsApp"
            >
              <Ionicons name="logo-whatsapp" size={18} color="#fff" />
              <Text style={styles.whatsAppText}>Verify on WhatsApp</Text>
            </TouchableOpacity>
          )}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Payment & source</Text>
          <View style={styles.paymentGrid}>
            <View style={styles.paymentTile}>
              <Ionicons name={order.paymentMethod === 'cash_on_delivery' ? 'cash-outline' : order.paymentMethod === 'wallet' ? 'wallet-outline' : 'card-outline'} size={19} color={palette.colors.primary} />
              <Text style={styles.paymentCaption}>METHOD</Text>
              <Text style={styles.paymentValue}>{paymentMethodLabel}</Text>
            </View>
            <View style={styles.paymentTile}>
              <Ionicons name={order.isPaid ? 'checkmark-circle-outline' : 'time-outline'} size={19} color={order.isPaid ? palette.colors.success : palette.colors.warning} />
              <Text style={styles.paymentCaption}>PAYMENT</Text>
              <Text style={styles.paymentValue}>{order.isPaid ? 'Paid' : 'Not paid'}</Text>
            </View>
            <View style={styles.paymentTile}>
              <Ionicons name="phone-portrait-outline" size={19} color={palette.colors.secondary} />
              <Text style={styles.paymentCaption}>SOURCE</Text>
              <Text style={styles.paymentValue}>{order.orderSource || order.source || order.platform || 'Rozare checkout'}</Text>
            </View>
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
            {order.isPaid && (
              <View style={styles.paidCancellationNote}>
                <Ionicons name="shield-checkmark-outline" size={16} color={palette.colors.info} />
                <Text style={styles.paidCancellationText}>Paid orders cannot be cancelled from fulfilment. Use the verified return and refund workflow when needed.</Text>
              </View>
            )}
            <View style={styles.statusOptions}>
              {STATUS_OPTIONS.filter((status) => !(order.isPaid && status === 'cancelled')).map((status) => {
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
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  scroll: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingBottom: spacing.xxl },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl },
  errorTitle: { ...typography.h3, color: p.colors.text, marginTop: spacing.lg, marginBottom: spacing.xl },
  backButton: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg },
  backButtonText: { ...typography.bodySemibold, color: 'white' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', margin: spacing.lg, padding: spacing.lg },
  orderIdLabel: { ...typography.body, color: p.colors.textSecondary },
  orderId: { ...typography.h3, color: p.colors.text },
  statusBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, gap: spacing.xs },
  statusText: { ...typography.bodySemibold, color: 'white', fontSize: fontSize.sm },
  successBanner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginTop: spacing.sm, padding: spacing.md, borderRadius: 14, backgroundColor: p.colors.successSubtle, borderWidth: 1, borderColor: `${p.colors.success}35` },
  successText: { flex: 1, color: p.colors.success, fontSize: fontSize.xs, lineHeight: 17, fontWeight: fontWeight.semibold },
  decisionSection: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.lg },
  decisionHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  decisionIcon: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  decisionCopy: { flex: 1 },
  decisionEyebrow: { color: p.colors.primary, fontSize: 9, letterSpacing: 1.1, fontWeight: fontWeight.extrabold },
  decisionTitle: { marginTop: 3, color: p.colors.text, fontSize: fontSize.md, lineHeight: 20, fontWeight: fontWeight.extrabold },
  decisionSubtitle: { marginTop: 4, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  decisionNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, borderRadius: 12, backgroundColor: p.colors.warningSubtle },
  decisionNoteText: { flex: 1, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  whatsAppButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.md, borderRadius: 13, backgroundColor: '#16A34A' },
  whatsAppText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  paymentGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  paymentTile: { flexGrow: 1, flexBasis: '30%', minWidth: 96, minHeight: 100, padding: spacing.md, borderRadius: 14, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  paymentCaption: { marginTop: spacing.sm, color: p.colors.textLight, fontSize: 8, letterSpacing: 0.8, fontWeight: fontWeight.bold },
  paymentValue: { marginTop: 3, color: p.colors.text, fontSize: fontSize.xs, lineHeight: 16, fontWeight: fontWeight.bold, textTransform: 'capitalize' },
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
  paidCancellationNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.md, padding: spacing.md, borderRadius: 12, backgroundColor: p.colors.infoSubtle },
  paidCancellationText: { flex: 1, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  statusOption: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.12)' },
  statusOptionText: { ...typography.bodySemibold, color: p.colors.textSecondary, flex: 1 },
  currentBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.md },
  currentBadgeText: { ...typography.caption, color: 'white', fontWeight: fontWeight.bold },
});
