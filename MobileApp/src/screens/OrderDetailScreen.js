/**
 * Premium buyer order detail — truthful aggregate and per-seller fulfillment.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { useGlobal } from '../contexts/GlobalContext';
import { spacing, fontSize, fontWeight, statusColors } from '../styles/theme';
import Loader from '../components/common/Loader';
import { ErrorState } from '../components/common/EmptyState';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import BuyerReturnsSection from '../components/BuyerReturnsSection';
import { shareInvoice } from '../utils/invoiceUtils';
import { useTheme } from '../contexts/ThemeContext';
import {
  ORDER_STAGES,
  assertOrderDetailPresentation,
  canCancelOrder,
  formatOrderItemOptions,
  getEstimatedDeliveryDate,
  getOrderCurrency,
  getOrderDisplayId,
  getOrderItemCount,
  getOrderItemLineSubtotal,
  getOrderItemQuantity,
  getOrderSellerGroups,
  getOrderSummaryAmount,
  getOrderTotal,
  normalizeOrderStatus,
} from '../utils/orderPresentation';

const STATUS_META = {
  pending: { icon: 'time-outline', label: 'Pending', description: 'Your order is waiting for confirmation.' },
  confirmed: { icon: 'checkmark-circle-outline', label: 'Confirmed', description: 'Your order has been confirmed.' },
  processing: { icon: 'sparkles-outline', label: 'Processing', description: 'The seller is preparing your products.' },
  shipped: { icon: 'car-outline', label: 'Shipped', description: 'Your order is on its way.' },
  delivered: { icon: 'checkmark-done-outline', label: 'Delivered', description: 'Your order has arrived.' },
  cancelled: { icon: 'close-circle-outline', label: 'Cancelled', description: 'This order is closed.' },
};

const formatDate = (value, includeTime = false) => {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    ...(includeTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
};

const paymentMethodLabel = (method) => ({
  cash_on_delivery: 'Cash on Delivery',
  wallet: 'Rozare Wallet',
  stripe: 'Online Card Payment',
}[method] || 'Payment');

const getConfirmationNotice = (order) => {
  const confirmation = order?.confirmation || {};
  if (
    order?.orderStatus === 'cancelled'
    && ['admin', 'seller', 'system'].includes(confirmation.cancelledByRole)
  ) {
    const actorLabel = confirmation.cancelledByRole === 'admin'
      ? 'a Rozare administrator'
      : confirmation.cancelledByRole === 'seller'
        ? 'the seller'
        : 'Rozare';
    return {
      type: 'error', icon: 'close-circle-outline',
      title: confirmation.cancelledByRole === 'system'
        ? 'Cancelled automatically by Rozare'
        : `Cancelled by ${actorLabel}`,
      body: confirmation.confirmedAt
        ? `This happened after you confirmed via ${confirmation.confirmedVia || 'Rozare'}. Nothing has been charged.`
        : 'Nothing has been charged.',
      date: confirmation.cancelledAt || confirmation.cancelledFromDashboardAt || confirmation.declinedAt,
    };
  }
  if (confirmation.cancelledFromDashboardAt && confirmation.confirmedAt) {
    return {
      type: 'error', icon: 'close-circle-outline', title: 'Cancelled after confirmation',
      body: `This order was first confirmed via ${confirmation.confirmedVia || 'Rozare'}, then cancelled from your account.`,
      date: confirmation.cancelledFromDashboardAt,
    };
  }
  if (confirmation.declinedAt) {
    return {
      type: 'error', icon: 'close-circle-outline', title: 'Order declined',
      body: `The order was declined via ${confirmation.decidedVia || confirmation.confirmedVia || 'your account'}.`,
      date: confirmation.declinedAt,
    };
  }
  if (confirmation.confirmedAt) {
    return {
      type: 'success', icon: 'checkmark-circle-outline', title: 'Order confirmed',
      body: `Confirmed via ${confirmation.confirmedVia || confirmation.decidedVia || 'Rozare'}. The seller has been notified.`,
      date: confirmation.confirmedAt,
    };
  }
  if (order?.paymentMethod === 'cash_on_delivery' && normalizeOrderStatus(order?.orderStatus) === 'pending') {
    return {
      type: 'info', icon: 'chatbubble-ellipses-outline', title: 'Confirmation requested',
      body: 'Confirm from your email or Rozare WhatsApp message so the seller can start preparing the order.',
      date: confirmation.emailSentAt || confirmation.whatsappSentAt,
    };
  }
  return null;
};

const couponPresentationText = (coupon, formatMoney) => {
  if (coupon.appliedDiscountAmount !== null && coupon.appliedDiscountAmount !== undefined) {
    return `${formatMoney(coupon.appliedDiscountAmount)} saved`;
  }
  if (coupon.discountType === 'percentage') return `${coupon.discountValue}% discount`;
  return 'Discount included in the order total';
};

export { canCancelOrder };

export default function OrderDetailScreen({ route, navigation }) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
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

  const orderMoney = useCallback(
    (amount) => {
      const orderCurrency = getOrderCurrency(order);
      return formatPrice(amount, {
        sourceCurrency: orderCurrency,
        targetCurrency: orderCurrency,
        showCode: true,
      });
    },
    [formatPrice, order],
  );

  const fetchOrderDetail = useCallback(async () => {
    try {
      setError(null);
      const res = await api.get(`/api/order/detail/${orderId}`);
      const nextOrder = res.data?.order;
      assertOrderDetailPresentation(nextOrder);
      setOrder(nextOrder);
    } catch (err) {
      setOrder(null);
      setError(
        err.code === 'ORDER_PRESENTATION_DATA_INVALID'
          ? 'This order contains information that could not be verified. Refresh before using any order action.'
          : (err.response?.data?.msg || err.response?.data?.message || 'Failed to load order details'),
      );
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [orderId]);

  useEffect(() => { fetchOrderDetail(); }, [fetchOrderDetail]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrderDetail();
  }, [fetchOrderDetail]);

  const handleCancelOrder = useCallback(() => {
    Alert.alert(
      'Cancel this order?',
      'The seller will be notified and this action cannot be undone.',
      [
        { text: 'Keep Order', style: 'cancel' },
        {
          text: 'Cancel Order',
          style: 'destructive',
          onPress: async () => {
            try {
              setCancelling(true);
              const res = await api.patch(`/api/order/cancel/${orderId}`, {});
              if (res.data?.order) {
                assertOrderDetailPresentation(res.data.order);
                setOrder(res.data.order);
              } else {
                await fetchOrderDetail();
              }
              Alert.alert('Order cancelled', 'The order has been cancelled successfully.');
            } catch (err) {
              if (!err.response || err.code === 'ORDER_PRESENTATION_DATA_INVALID') {
                setOrder(null);
                setError('The latest order state could not be verified. Refresh before using another order action.');
              }
              Alert.alert('Could not cancel', err.response?.data?.msg || err.response?.data?.message || 'Please try again.');
            } finally {
              setCancelling(false);
            }
          },
        },
      ],
    );
  }, [orderId, fetchOrderDetail]);

  const handleReorder = useCallback(async () => {
    try {
      setReordering(true);
      const res = await api.post(`/api/order/reorder/${orderId}`);
      const added = res.data?.added;
      const unavailable = res.data?.unavailable;
      if (
        !Number.isSafeInteger(added)
        || added < 0
        || !Number.isSafeInteger(unavailable)
        || unavailable < 0
      ) throw new Error('Rozare returned an invalid re-order result. Refresh your cart before trying again.');
      await fetchCart();
      Alert.alert(
        added ? 'Added to your cart' : 'Products unavailable',
        added
          ? `${added} product${added === 1 ? '' : 's'} added${unavailable ? `. ${unavailable} unavailable.` : '.'}`
          : 'These products are currently unavailable.',
        added ? [
          { text: 'Keep Browsing', style: 'cancel' },
          { text: 'View Cart', onPress: () => navigation.navigate('MainTabs', { screen: 'Cart' }) },
        ] : [{ text: 'OK' }],
      );
    } catch (err) {
      Alert.alert('Re-order unavailable', err.response?.data?.msg || err.response?.data?.message || 'Please try again.');
    } finally {
      setReordering(false);
    }
  }, [orderId, fetchCart, navigation]);

  const handleShareInvoice = useCallback(async () => {
    try {
      setSharingInvoice(true);
      await shareInvoice(order?._id);
    } catch (err) {
      Alert.alert('Invoice unavailable', err.response?.data?.msg || err.message || 'Please try again.');
    } finally {
      setSharingInvoice(false);
    }
  }, [order]);

  const sellerGroups = useMemo(() => {
    if (!order) return [];
    return getOrderSellerGroups(order);
  }, [order]);

  if (isLoading) {
    return <GlassBackground><SafeAreaView style={styles.safeArea}><View style={styles.center}><Loader size="large" /></View></SafeAreaView></GlassBackground>;
  }
  if (error) {
    return <GlassBackground><SafeAreaView style={styles.safeArea}><PremiumBackHeader title="Order Details" subtitle="Your purchase" icon="receipt-outline" onBack={() => navigation.goBack()} style={styles.header} /><View style={styles.center}><ErrorState message={error} onRetry={fetchOrderDetail} /></View></SafeAreaView></GlassBackground>;
  }
  if (!order) {
    return <GlassBackground><SafeAreaView style={styles.safeArea}><PremiumBackHeader title="Order Details" subtitle="Your purchase" icon="receipt-outline" onBack={() => navigation.goBack()} style={styles.header} /><View style={styles.center}><ErrorState message="Order not found" onRetry={() => navigation.goBack()} /></View></SafeAreaView></GlassBackground>;
  }

  const status = normalizeOrderStatus(order.orderStatus);
  const meta = STATUS_META[status];
  const statusStyle = status === 'confirmed'
    ? { solid: palette.colors.info, bg: palette.colors.infoLight, text: palette.colors.infoDark || palette.colors.info }
    : (statusColors[status] || statusColors.pending);
  const currentStage = ORDER_STAGES.indexOf(status);
  const estimatedDelivery = getEstimatedDeliveryDate(order);
  const confirmationNotice = getConfirmationNotice(order);
  const itemCount = getOrderItemCount(order);
  const total = getOrderTotal(order);
  const orderCurrency = getOrderCurrency(order);
  const subtotal = getOrderSummaryAmount(order, ['subtotal'], 'order subtotal');
  const tax = getOrderSummaryAmount(order, ['tax', 'taxAmount'], 'order tax');
  const shipping = getOrderSummaryAmount(order, ['shippingCost', 'shippingFee'], 'order shipping');
  const discount = getOrderSummaryAmount(
    order,
    ['couponDiscount', 'discountAmount'],
    'order coupon discount',
  );
  const reconciliationAdjustment = getOrderSummaryAmount(
    order,
    ['reconciliationAdjustment'],
    'order reconciliation adjustment',
    { signed: true },
  );
  const cancellable = !refreshing && canCancelOrder(order);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top', 'bottom']}>
        <PremiumBackHeader
          title="Order Details"
          subtitle={getOrderDisplayId(order)}
          icon="receipt-outline"
          onBack={() => navigation.goBack()}
          rightElement={(
            <View style={[styles.headerStatus, { backgroundColor: statusStyle.bg }]}>
              <Ionicons name={meta.icon} size={14} color={statusStyle.text} />
              <Text style={[styles.headerStatusText, { color: statusStyle.text }]}>{meta.label}</Text>
            </View>
          )}
          style={styles.header}
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: 128 + insets.bottom }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
        >
          <GlassPanel variant="strong" style={styles.hero}>
            <LinearGradient
              colors={[`${statusStyle.solid}24`, 'rgba(14,165,233,0.06)', 'rgba(255,255,255,0)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.heroTop}>
              <View style={[styles.heroIcon, { backgroundColor: statusStyle.bg, borderColor: `${statusStyle.solid}35` }]}>
                <Ionicons name={meta.icon} size={30} color={statusStyle.solid} />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.heroEyebrow}>CURRENT STATUS</Text>
                <Text style={[styles.heroStatus, { color: statusStyle.solid }]}>{meta.label}</Text>
                <Text style={styles.heroDescription}>{meta.description}</Text>
              </View>
            </View>
            <View style={styles.heroFacts}>
              <View style={styles.heroFact}>
                <Text style={styles.factLabel}>ORDER</Text>
                <Text style={styles.factValue} numberOfLines={1}>{getOrderDisplayId(order)}</Text>
              </View>
              <View style={styles.factDivider} />
              <View style={styles.heroFact}>
                <Text style={styles.factLabel}>PLACED</Text>
                <Text style={styles.factValue}>{formatDate(order.createdAt)}</Text>
              </View>
              <View style={styles.factDivider} />
              <View style={styles.heroFact}>
                <Text style={styles.factLabel}>TOTAL</Text>
                <Text style={[styles.factValue, { color: palette.colors.primary }]}>{orderMoney(total)}</Text>
              </View>
            </View>
          </GlassPanel>

          {confirmationNotice && (
            <NoticeCard notice={confirmationNotice} formatDate={formatDate} palette={palette} styles={styles} />
          )}

          {status !== 'cancelled' && (
            <Section title="Order journey" subtitle="Live progress across your purchase" icon="navigate-outline" styles={styles}>
              <View style={styles.journey}>
                {ORDER_STAGES.map((stage, index) => {
                  const stageMeta = STATUS_META[stage];
                  const complete = index < currentStage || status === 'delivered';
                  const current = index === currentStage;
                  return (
                    <View key={stage} style={styles.journeyStep}>
                      <View style={styles.journeyRail}>
                        <View style={[
                          styles.journeyDot,
                          (complete || current) && { backgroundColor: current ? palette.colors.primary : palette.colors.success, borderColor: current ? palette.colors.primary : palette.colors.success },
                        ]}>
                          {complete ? <Ionicons name="checkmark" size={12} color="#fff" /> : current ? <View style={styles.currentDot} /> : null}
                        </View>
                        {index < ORDER_STAGES.length - 1 && <View style={[styles.journeyLine, complete && { backgroundColor: palette.colors.success }]} />}
                      </View>
                      <View style={styles.journeyCopy}>
                        <Text style={[styles.journeyLabel, (complete || current) && { color: palette.colors.text, fontWeight: fontWeight.bold }]}>{stageMeta.label}</Text>
                        <Text style={styles.journeyState}>{current ? 'Current stage' : complete ? 'Completed' : 'Upcoming'}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
              {estimatedDelivery && status !== 'delivered' && (
                <View style={styles.etaCard}>
                  <View style={styles.etaIcon}><Ionicons name="calendar-outline" size={19} color={palette.colors.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.etaLabel}>Estimated arrival</Text>
                    <Text style={styles.etaValue}>{formatDate(estimatedDelivery)}</Text>
                  </View>
                  <Text style={styles.etaHint}>Latest seller estimate</Text>
                </View>
              )}
            </Section>
          )}

          {sellerGroups.length > 0 && (
            <Section
              title="Seller shipments"
              subtitle={`One order split into ${sellerGroups.length} store shipment${sellerGroups.length === 1 ? '' : 's'}. Each store controls only its own products, shipping, and status.`}
              icon="storefront-outline"
              styles={styles}
            >
              {sellerGroups.map((group, index) => (
                <SellerShipmentGroup
                  key={group.sellerId}
                  group={group}
                  formatMoney={orderMoney}
                  palette={palette}
                  styles={styles}
                  last={index === sellerGroups.length - 1}
                />
              ))}
            </Section>
          )}

          {sellerGroups.length === 0 && <Section title={`Products (${itemCount})`} subtitle="Items included in this order" icon="bag-handle-outline" styles={styles}>
            {(order.orderItems || []).map((item, index) => {
              const options = formatOrderItemOptions(item);
              return (
                <View key={item._id || `${item.productId}-${index}`} style={[styles.productRow, index === order.orderItems.length - 1 && { borderBottomWidth: 0, paddingBottom: 0 }]}>
                  <Image
                    source={{ uri: item.image || 'https://rozare.com/favicon-512.png' }}
                    style={styles.productImage}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={150}
                  />
                  <View style={styles.productCopy}>
                    <Text style={styles.productName} numberOfLines={2}>{item.name || 'Product'}</Text>
                    {!!options && <Text style={styles.productOptions} numberOfLines={2}>{options}</Text>}
                    <View style={styles.productBottom}>
                      <Text style={styles.productQty}>Qty {getOrderItemQuantity(item)}</Text>
                      <Text style={styles.productPrice}>{orderMoney(getOrderItemLineSubtotal(item))}</Text>
                    </View>
                  </View>
                </View>
              );
            })}
          </Section>}

          <BuyerReturnsSection order={order} formatMoney={orderMoney} />

          <Section title="Delivery details" subtitle="Where this order is going" icon="location-outline" styles={styles}>
            <InfoRow icon="person-outline" label="Recipient" value={order.shippingInfo?.fullName} styles={styles} palette={palette} />
            <InfoRow icon="call-outline" label="Phone" value={order.shippingInfo?.phone} styles={styles} palette={palette} />
            <InfoRow icon="mail-outline" label="Email" value={order.shippingInfo?.email} styles={styles} palette={palette} />
            <View style={styles.addressCard}>
              <Ionicons name="navigate-outline" size={18} color={palette.colors.primary} />
              <Text style={styles.addressText}>
                {[order.shippingInfo?.address, order.shippingInfo?.city, order.shippingInfo?.state, order.shippingInfo?.postalCode, order.shippingInfo?.country].filter(Boolean).join(', ')}
              </Text>
            </View>
          </Section>

          <Section title="Payment" subtitle="Secure payment information" icon="card-outline" styles={styles}>
            <View style={styles.paymentCard}>
              <View style={styles.paymentIcon}>
                <Ionicons name={order.paymentMethod === 'cash_on_delivery' ? 'cash-outline' : order.paymentMethod === 'wallet' ? 'wallet-outline' : 'card-outline'} size={22} color={palette.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.paymentTitle}>{paymentMethodLabel(order.paymentMethod)}</Text>
                <Text style={styles.paymentSub}>
                  {order.isPaid ? `Paid${order.paidAt ? ` on ${formatDate(order.paidAt)}` : ''}` : order.paymentMethod === 'cash_on_delivery' ? 'Payment is collected at delivery' : 'Payment has not completed'}
                </Text>
              </View>
              <View style={[styles.paidBadge, { backgroundColor: order.isPaid ? 'rgba(16,185,129,0.13)' : 'rgba(245,158,11,0.13)' }]}>
                <Ionicons name={order.isPaid ? 'shield-checkmark' : 'time-outline'} size={13} color={order.isPaid ? palette.colors.success : palette.colors.warning} />
                <Text style={[styles.paidText, { color: order.isPaid ? palette.colors.success : palette.colors.warning }]}>{order.isPaid ? 'PAID' : 'UNPAID'}</Text>
              </View>
            </View>
            {order.paymentResult?.paymentIntentId && (
              <Text style={styles.referenceText}>Payment reference: ••••{String(order.paymentResult.paymentIntentId).slice(-8)}</Text>
            )}
          </Section>

          {(order.appliedCoupons?.length > 0 || order.instructions) && (
            <Section title="Order notes" subtitle="Discounts and delivery preferences" icon="pricetag-outline" styles={styles}>
              {(order.appliedCoupons || []).map((coupon, index) => (
                <View key={coupon._id || coupon.couponId || index} style={styles.couponRow}>
                  <View style={styles.couponIcon}><Ionicons name="ticket-outline" size={17} color={palette.colors.success} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.couponCode}>{coupon.code || 'Coupon applied'}</Text>
                    <Text style={styles.couponValue}>
                      {couponPresentationText(coupon, orderMoney)}
                    </Text>
                  </View>
                </View>
              ))}
              {!!order.instructions && (
                <View style={styles.instructionsCard}>
                  <Ionicons name="document-text-outline" size={18} color={palette.colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.instructionsLabel}>DELIVERY INSTRUCTIONS</Text>
                    <Text style={styles.instructionsText}>{order.instructions}</Text>
                  </View>
                </View>
              )}
            </Section>
          )}

          <Section title="Order summary" subtitle={`${itemCount} item${itemCount === 1 ? '' : 's'} in this purchase`} icon="calculator-outline" styles={styles}>
            <SummaryRow label="Subtotal" value={orderMoney(subtotal)} styles={styles} />
            <SummaryRow label="Shipping" value={shipping > 0 ? orderMoney(shipping) : 'Free'} styles={styles} />
            <SummaryRow label="Tax" value={orderMoney(tax)} styles={styles} />
            {discount > 0 && <SummaryRow label="Coupon savings" value={`-${orderMoney(discount)}`} positive styles={styles} palette={palette} />}
            {reconciliationAdjustment !== 0 && <SummaryRow label="Rounding adjustment" value={`${reconciliationAdjustment > 0 ? '+' : '-'}${orderMoney(Math.abs(reconciliationAdjustment))}`} styles={styles} />}
            <View style={styles.summaryDivider} />
            <View style={styles.totalRow}>
              <View>
                <Text style={styles.totalLabel}>Total</Text>
                <Text style={styles.totalCurrency}>
                  {orderCurrency} checkout total
                </Text>
              </View>
              <Text style={styles.totalValue}>{orderMoney(total)}</Text>
            </View>
          </Section>

          {cancellable && (
            <TouchableOpacity style={styles.cancelButton} onPress={handleCancelOrder} disabled={cancelling} activeOpacity={0.8}>
              {cancelling ? <Loader size="small" color={palette.colors.error} /> : <Ionicons name="close-circle-outline" size={19} color={palette.colors.error} />}
              <View style={{ flex: 1 }}>
                <Text style={styles.cancelTitle}>{cancelling ? 'Cancelling…' : 'Cancel this order'}</Text>
                <Text style={styles.cancelSubtitle}>Available before payment or shipment begins</Text>
              </View>
              {!cancelling && <Ionicons name="chevron-forward" size={17} color={palette.colors.error} />}
            </TouchableOpacity>
          )}
        </ScrollView>

        <GlassPanel variant="floating" style={[styles.actionDock, { bottom: Math.max(spacing.sm, insets.bottom + spacing.xs) }]}>
          <TouchableOpacity style={styles.invoiceButton} onPress={handleShareInvoice} disabled={sharingInvoice || refreshing} activeOpacity={0.8}>
            {sharingInvoice ? <Loader size="small" color={palette.colors.primary} /> : <Ionicons name="share-outline" size={19} color={palette.colors.primary} />}
            <Text style={styles.invoiceText}>{sharingInvoice ? 'Preparing' : 'Invoice'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.reorderButton} onPress={handleReorder} disabled={reordering || refreshing} activeOpacity={0.86}>
            <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            {reordering ? <Loader size="small" color="#fff" /> : <Ionicons name="repeat-outline" size={20} color="#fff" />}
            <Text style={styles.reorderText}>{reordering ? 'Adding…' : 'Buy Again'}</Text>
          </TouchableOpacity>
        </GlassPanel>
      </SafeAreaView>
    </GlassBackground>
  );
}

function Section({ title, subtitle, icon, children, styles }) {
  return (
    <GlassPanel variant="card" style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionIcon}><Ionicons name={icon} size={18} color="#6366f1" /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {!!subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
        </View>
      </View>
      {children}
    </GlassPanel>
  );
}

function SellerShipmentGroup({ group, formatMoney, palette, styles, last }) {
  const meta = STATUS_META[group.status] || STATUS_META.pending;
  const tone = group.status === 'confirmed'
    ? { solid: palette.colors.info, bg: palette.colors.infoLight }
    : (statusColors[group.status] || statusColors.pending);
  const activeIndex = Math.max(0, ORDER_STAGES.indexOf(group.status));
  const summary = group.summary;

  return (
    <View style={[styles.sellerShipment, last && { marginBottom: 0 }]}>
      <View style={styles.sellerShipmentHeader}>
        <View style={[styles.storeIcon, { backgroundColor: `${tone.solid}16` }]}>
          <Ionicons name="storefront-outline" size={20} color={tone.solid} />
        </View>
        <View style={styles.storeCopy}>
          <Text style={styles.storeName} numberOfLines={1}>{group.storeName}</Text>
          <Text style={styles.storeMeta}>
            {group.itemCount} product line{group.itemCount === 1 ? '' : 's'} · {group.units} unit{group.units === 1 ? '' : 's'}
          </Text>
        </View>
        <View style={[styles.smallStatus, { backgroundColor: tone.bg }]}>
          <Ionicons name={meta.icon} size={12} color={tone.solid} />
          <Text style={[styles.smallStatusText, { color: tone.solid }]}>{meta.label}</Text>
        </View>
      </View>

      {group.status === 'cancelled' ? (
        <View style={styles.cancelledShipment}>
          <Ionicons name="close-circle-outline" size={16} color={palette.colors.error} />
          <Text style={styles.cancelledShipmentText}>This store's portion was cancelled.</Text>
        </View>
      ) : (
        <View style={styles.sellerProgress} accessibilityLabel={`${group.storeName} shipment status: ${meta.label}`}>
          {ORDER_STAGES.map((stage, index) => (
            <View key={stage} style={styles.sellerProgressStep}>
              <View style={[
                styles.sellerProgressBar,
                index <= activeIndex && { backgroundColor: (statusColors[stage] || statusColors.pending).solid },
              ]} />
              <Ionicons
                name={STATUS_META[stage].icon}
                size={13}
                color={index <= activeIndex ? (statusColors[stage] || statusColors.pending).solid : palette.colors.textLight}
              />
            </View>
          ))}
        </View>
      )}

      <View style={styles.sellerItems}>
        {group.items.map((item, index) => {
          const options = formatOrderItemOptions(item);
          return (
            <View key={`${group.itemIndexes[index]}:${item.productId || item.name}`} style={styles.sellerItemRow}>
              <Image
                source={{ uri: item.image || 'https://rozare.com/favicon-512.png' }}
                style={styles.sellerItemImage}
                contentFit="cover"
                cachePolicy="memory-disk"
              />
              <View style={styles.sellerItemCopy}>
                <Text style={styles.sellerItemName} numberOfLines={2}>{item.name || 'Product'}</Text>
                {!!options && <Text style={styles.sellerItemOptions}>{options}</Text>}
                <Text style={styles.sellerItemQuantity}>Qty {getOrderItemQuantity(item)}</Text>
              </View>
              <Text style={styles.sellerItemAmount}>{formatMoney(getOrderItemLineSubtotal(item))}</Text>
            </View>
          );
        })}
      </View>

      <View style={styles.sellerShippingCard}>
        <View style={styles.sellerShippingCopy}>
          <Text style={styles.sellerShippingName}>
            {group.shippingMethod?.name || 'Shipping details unavailable for this legacy order'}
          </Text>
          {!!group.shippingMethod?.estimatedDays && (
            <Text style={styles.sellerShippingMeta}>
              {group.shippingMethod.estimatedDays} day{group.shippingMethod.estimatedDays === 1 ? '' : 's'} estimated delivery
            </Text>
          )}
        </View>
        {!!group.shippingMethod && (
          <Text style={styles.sellerShippingAmount}>
            {group.shippingMethod.price === 0 ? 'Free' : formatMoney(group.shippingMethod.price)}
          </Text>
        )}
      </View>

      <View style={styles.sellerAllocation}>
        <Text style={styles.sellerAllocationCaption}>YOUR CHECKOUT BREAKDOWN FOR THIS STORE</Text>
        <View style={styles.groupSummaryRow}><Text style={styles.groupSummaryLabel}>Products</Text><Text style={styles.groupSummaryValue}>{formatMoney(summary.subtotal)}</Text></View>
        <View style={styles.groupSummaryRow}><Text style={styles.groupSummaryLabel}>Shipping</Text><Text style={styles.groupSummaryValue}>{summary.shippingCost === 0 ? 'Free' : formatMoney(summary.shippingCost)}</Text></View>
        {summary.tax > 0 && <View style={styles.groupSummaryRow}><Text style={styles.groupSummaryLabel}>Tax</Text><Text style={styles.groupSummaryValue}>{formatMoney(summary.tax)}</Text></View>}
        {summary.couponDiscount > 0 && <View style={styles.groupSummaryRow}><Text style={styles.groupSummaryLabel}>Discount</Text><Text style={[styles.groupSummaryValue, { color: palette.colors.success }]}>-{formatMoney(summary.couponDiscount)}</Text></View>}
        {summary.reconciliationAdjustment !== 0 && <View style={styles.groupSummaryRow}><Text style={styles.groupSummaryLabel}>Rounding</Text><Text style={styles.groupSummaryValue}>{summary.reconciliationAdjustment > 0 ? '+' : '-'}{formatMoney(Math.abs(summary.reconciliationAdjustment))}</Text></View>}
        <View style={[styles.groupSummaryRow, styles.groupSummaryTotal]}><Text style={styles.groupTotalLabel}>Store total</Text><Text style={styles.groupTotalValue}>{formatMoney(summary.totalAmount)}</Text></View>
      </View>
    </View>
  );
}

function NoticeCard({ notice, formatDate: renderDate, palette, styles }) {
  const isError = notice.type === 'error';
  const isSuccess = notice.type === 'success';
  const color = isError ? palette.colors.error : isSuccess ? palette.colors.success : palette.colors.info;
  return (
    <GlassPanel variant="inner" style={[styles.notice, { borderColor: `${color}45`, backgroundColor: `${color}0F` }]}>
      <View style={[styles.noticeIcon, { backgroundColor: `${color}18` }]}><Ionicons name={notice.icon} size={21} color={color} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.noticeTitle, { color }]}>{notice.title}</Text>
        <Text style={styles.noticeBody}>{notice.body}</Text>
        {!!notice.date && <Text style={styles.noticeDate}>{renderDate(notice.date, true)}</Text>}
      </View>
    </GlassPanel>
  );
}

function InfoRow({ icon, label, value, styles, palette }) {
  if (!value) return null;
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoIcon}><Ionicons name={icon} size={16} color={palette.colors.primary} /></View>
      <View style={{ flex: 1 }}><Text style={styles.infoLabel}>{label}</Text><Text style={styles.infoValue}>{value}</Text></View>
    </View>
  );
}

function SummaryRow({ label, value, positive, styles, palette }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, positive && { color: palette?.colors.success }]}>{value}</Text>
    </View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  header: { marginTop: spacing.sm, marginBottom: spacing.sm },
  headerStatus: { minHeight: 34, maxWidth: 92, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: spacing.sm, borderRadius: 12 },
  headerStatusText: { fontSize: 9, fontWeight: fontWeight.bold },
  content: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: 128 },
  hero: { padding: spacing.lg, marginBottom: spacing.md, borderRadius: 26 },
  heroTop: { flexDirection: 'row', alignItems: 'center' },
  heroIcon: { width: 62, height: 62, borderRadius: 21, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  heroCopy: { flex: 1, marginLeft: spacing.md },
  heroEyebrow: { fontSize: 9, letterSpacing: 1.4, color: p.colors.textSecondary, fontWeight: fontWeight.extrabold },
  heroStatus: { marginTop: 3, fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, letterSpacing: -0.4 },
  heroDescription: { marginTop: 3, fontSize: 11, lineHeight: 16, color: p.colors.textSecondary },
  heroFacts: { flexDirection: 'row', alignItems: 'stretch', marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  heroFact: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  factDivider: { width: 1, backgroundColor: p.glass.borderSubtle },
  factLabel: { fontSize: 8, letterSpacing: 1, fontWeight: fontWeight.bold, color: p.colors.textLight },
  factValue: { marginTop: 4, fontSize: 11, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, padding: spacing.md, marginBottom: spacing.md, borderRadius: 18 },
  noticeIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  noticeTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  noticeBody: { marginTop: 3, fontSize: 11, lineHeight: 16, color: p.colors.textSecondary },
  noticeDate: { marginTop: 5, fontSize: 9, color: p.colors.textLight, fontWeight: fontWeight.medium },
  section: { padding: spacing.lg, marginBottom: spacing.md, borderRadius: 22 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  sectionIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: 'rgba(99,102,241,0.11)', alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.2 },
  sectionSubtitle: { marginTop: 2, fontSize: 10, color: p.colors.textSecondary },
  journey: { paddingHorizontal: 2 },
  journeyStep: { minHeight: 52, flexDirection: 'row' },
  journeyRail: { width: 24, alignItems: 'center', marginRight: spacing.md },
  journeyDot: { width: 24, height: 24, borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 2, borderColor: p.glass.border, alignItems: 'center', justifyContent: 'center' },
  currentDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  journeyLine: { width: 2, flex: 1, marginVertical: 3, backgroundColor: p.glass.borderSubtle },
  journeyCopy: { flex: 1, paddingTop: 2 },
  journeyLabel: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  journeyState: { marginTop: 2, fontSize: 9, color: p.colors.textLight },
  etaCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, padding: spacing.md, borderRadius: 15, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.14)' },
  etaIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.11)' },
  etaLabel: { fontSize: 9, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  etaValue: { marginTop: 2, fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.extrabold },
  etaHint: { maxWidth: 75, textAlign: 'right', fontSize: 8, lineHeight: 12, color: p.colors.textLight },
  sellerShipment: { marginBottom: spacing.md, overflow: 'hidden', borderRadius: 18, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  sellerShipmentHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  storeIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  storeCopy: { flex: 1, minWidth: 0 },
  storeName: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.bold },
  storeMeta: { marginTop: 3, fontSize: 9, color: p.colors.textSecondary },
  smallStatus: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 5, borderRadius: 10 },
  smallStatusText: { fontSize: 8, fontWeight: fontWeight.bold },
  sellerProgress: { flexDirection: 'row', gap: 4, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  sellerProgressStep: { flex: 1, alignItems: 'center', gap: 5 },
  sellerProgressBar: { width: '100%', height: 4, borderRadius: 3, backgroundColor: p.glass.borderSubtle },
  cancelledShipment: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, margin: spacing.md, padding: spacing.sm, borderRadius: 12, backgroundColor: p.colors.errorSubtle },
  cancelledShipmentText: { flex: 1, color: p.colors.error, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  sellerItems: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  sellerItemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  sellerItemImage: { width: 52, height: 52, borderRadius: 14, backgroundColor: p.glass.bgStrong },
  sellerItemCopy: { flex: 1, minWidth: 0 },
  sellerItemName: { color: p.colors.text, fontSize: fontSize.xs, lineHeight: 16, fontWeight: fontWeight.bold },
  sellerItemOptions: { marginTop: 3, color: p.colors.primary, fontSize: 9, lineHeight: 13, fontWeight: fontWeight.semibold },
  sellerItemQuantity: { marginTop: 3, color: p.colors.textSecondary, fontSize: 9 },
  sellerItemAmount: { maxWidth: 105, color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, textAlign: 'right' },
  sellerShippingCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, margin: spacing.md, padding: spacing.sm, borderRadius: 13, backgroundColor: p.glass.bgStrong },
  sellerShippingCopy: { flex: 1, minWidth: 0 },
  sellerShippingName: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  sellerShippingMeta: { marginTop: 2, color: p.colors.textSecondary, fontSize: 9 },
  sellerShippingAmount: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  sellerAllocation: { marginHorizontal: spacing.md, marginBottom: spacing.md, padding: spacing.md, borderRadius: 14, backgroundColor: 'rgba(99,102,241,0.07)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.13)' },
  sellerAllocationCaption: { marginBottom: spacing.sm, color: p.colors.textLight, fontSize: 8, letterSpacing: 0.7, fontWeight: fontWeight.extrabold },
  groupSummaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 4 },
  groupSummaryLabel: { color: p.colors.textSecondary, fontSize: fontSize.xs },
  groupSummaryValue: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  groupSummaryTotal: { marginTop: spacing.xs, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  groupTotalLabel: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  groupTotalValue: { color: p.colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  productRow: { flexDirection: 'row', paddingBottom: spacing.md, marginBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  productImage: { width: 76, height: 76, borderRadius: 18, backgroundColor: p.glass.bgSubtle },
  productCopy: { flex: 1, minWidth: 0, marginLeft: spacing.md },
  productName: { fontSize: fontSize.sm, lineHeight: 18, fontWeight: fontWeight.bold, color: p.colors.text },
  productOptions: { marginTop: 4, fontSize: 10, lineHeight: 14, color: p.colors.textSecondary },
  productBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  productQty: { fontSize: 10, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  productPrice: { fontSize: fontSize.md, color: p.colors.primary, fontWeight: fontWeight.extrabold },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  infoIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.08)' },
  infoLabel: { fontSize: 9, color: p.colors.textLight, fontWeight: fontWeight.semibold },
  infoValue: { marginTop: 2, fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.semibold },
  addressCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.sm, padding: spacing.md, borderRadius: 15, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  addressText: { flex: 1, fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  paymentCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: 16, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  paymentIcon: { width: 43, height: 43, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(99,102,241,0.10)' },
  paymentTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  paymentSub: { marginTop: 3, fontSize: 9, color: p.colors.textSecondary },
  paidBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 5, borderRadius: 9 },
  paidText: { fontSize: 8, fontWeight: fontWeight.extrabold, letterSpacing: 0.5 },
  referenceText: { marginTop: spacing.sm, fontSize: 9, color: p.colors.textLight, textAlign: 'right' },
  couponRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.sm, borderRadius: 15, backgroundColor: 'rgba(16,185,129,0.08)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.15)' },
  couponIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(16,185,129,0.10)' },
  couponCode: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.text },
  couponValue: { marginTop: 2, fontSize: 9, color: p.colors.success },
  instructionsCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, borderRadius: 15, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  instructionsLabel: { fontSize: 8, letterSpacing: 0.8, color: p.colors.textLight, fontWeight: fontWeight.extrabold },
  instructionsText: { marginTop: 4, fontSize: fontSize.sm, lineHeight: 18, color: p.colors.textSecondary },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  summaryLabel: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  summaryValue: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.semibold },
  summaryDivider: { height: 1, marginVertical: spacing.xs, marginBottom: spacing.md, backgroundColor: p.glass.borderSubtle },
  totalRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  totalLabel: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  totalCurrency: { marginTop: 2, fontSize: 9, color: p.colors.textLight },
  totalValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.extrabold, color: p.colors.primary },
  cancelButton: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.md, borderRadius: 17, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.20)' },
  cancelTitle: { fontSize: fontSize.sm, color: p.colors.error, fontWeight: fontWeight.bold },
  cancelSubtitle: { marginTop: 2, fontSize: 9, color: p.colors.textSecondary },
  actionDock: { position: 'absolute', left: spacing.md, right: spacing.md, bottom: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: 23 },
  invoiceButton: { minWidth: 104, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 16, backgroundColor: 'rgba(99,102,241,0.09)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.16)' },
  invoiceText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.bold },
  reorderButton: { flex: 1, height: 50, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: 16, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.26, shadowRadius: 12, elevation: 5 },
  reorderText: { fontSize: fontSize.md, color: '#fff', fontWeight: fontWeight.extrabold },
});
