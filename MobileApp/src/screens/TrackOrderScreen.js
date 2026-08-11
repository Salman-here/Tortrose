import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTheme } from '../contexts/ThemeContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../components/common/KeyboardAwareFormScrollView';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { fontSize, fontWeight, shadows, spacing, typography } from '../styles/theme';

const STATUS_STEPS = ['pending', 'confirmed', 'processing', 'shipped', 'delivered'];
const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'processing', 'shipped']);
const STATUS_CONFIG = {
  pending: {
    icon: 'time-outline',
    color: '#D97706',
    label: 'Order received',
    shortLabel: 'Pending',
    detail: 'We received your order and are checking the details.',
  },
  confirmed: {
    icon: 'checkmark-circle-outline',
    color: '#16A34A',
    label: 'Confirmed',
    shortLabel: 'Confirmed',
    detail: 'The seller confirmed your order.',
  },
  processing: {
    icon: 'cube-outline',
    color: '#2563EB',
    label: 'Being prepared',
    shortLabel: 'Processing',
    detail: 'Your items are being prepared for dispatch.',
  },
  shipped: {
    icon: 'car-outline',
    color: '#7C3AED',
    label: 'On the way',
    shortLabel: 'Shipped',
    detail: 'Your order is with the delivery partner.',
  },
  delivered: {
    icon: 'checkmark-done-circle-outline',
    color: '#16A34A',
    label: 'Delivered',
    shortLabel: 'Delivered',
    detail: 'Your order reached its delivery address.',
  },
  cancelled: {
    icon: 'close-circle-outline',
    color: '#DC2626',
    label: 'Order cancelled',
    shortLabel: 'Cancelled',
    detail: 'This order will not continue through delivery.',
  },
};

const getStatus = (status) => STATUS_CONFIG[status] || STATUS_CONFIG.pending;
const getOrderKey = (order) => String(order?._id || order?.orderId || '');
const getSelectedOptions = (item) => (
  item?.selectedOptions && typeof item.selectedOptions === 'object'
    ? Object.entries(item.selectedOptions).filter(([, value]) => value)
    : []
);
const formatPlacedDate = (date) => {
  if (!date) return 'Date unavailable';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'Date unavailable';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function TrackOrderScreen({ navigation }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const { formatPrice } = useCurrency();
  const styles = buildStyles(palette);
  const scrollRef = useRef(null);
  const resultOffsetRef = useRef(0);

  const [email, setEmail] = useState(currentUser?.email || '');
  const [orderId, setOrderId] = useState('');
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [showItems, setShowItems] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [trackingSource, setTrackingSource] = useState('manual');
  const [formError, setFormError] = useState('');
  const [resultError, setResultError] = useState('');
  const [activeOrders, setActiveOrders] = useState([]);
  const [activeOrdersExpanded, setActiveOrdersExpanded] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState('');

  useEffect(() => {
    if (currentUser?.email && !email) setEmail(currentUser.email);
  }, [currentUser?.email, email]);

  const orderMoney = useCallback(
    (amount, targetOrder = order) => formatPrice(amount || 0, { sourceCurrency: targetOrder?.currency || 'USD' }),
    [formatPrice, order]
  );

  const fetchActiveOrders = useCallback(async ({ quiet = false } = {}) => {
    if (!currentUser) {
      setActiveOrders([]);
      setAccountError('');
      return [];
    }
    if (!quiet) setAccountLoading(true);
    try {
      const response = await api.get('/api/order/user-orders');
      const orders = Array.isArray(response.data?.orders) ? response.data.orders : [];
      const active = orders
        .filter((item) => ACTIVE_STATUSES.has(item?.orderStatus))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      setActiveOrders(active);
      setAccountError('');
      return active;
    } catch (error) {
      setAccountError(error.response?.data?.msg || 'We could not refresh your active orders.');
      return [];
    } finally {
      setAccountLoading(false);
    }
  }, [currentUser]);

  useFocusEffect(useCallback(() => {
    fetchActiveOrders();
  }, [fetchActiveOrders]));

  const revealResult = useCallback(() => {
    requestAnimationFrame(() => {
      setTimeout(() => {
        scrollRef.current?.scrollTo({
          y: Math.max(0, resultOffsetRef.current - spacing.sm),
          animated: true,
        });
      }, 80);
    });
  }, []);

  const openAccountOrder = useCallback((selectedOrder) => {
    Keyboard.dismiss();
    setOrder(selectedOrder);
    setOrderId(selectedOrder.orderId || '');
    setEmail(selectedOrder.shippingInfo?.email || currentUser?.email || '');
    setTrackingSource('account');
    setSearched(true);
    setShowItems(false);
    setFormError('');
    setResultError('');
    setActiveOrdersExpanded(false);
    revealResult();
  }, [currentUser?.email, revealResult]);

  const trackManualOrder = useCallback(async ({ quiet = false } = {}) => {
    const cleanEmail = email.trim();
    const cleanOrderId = orderId.trim();
    if (!cleanEmail || !cleanOrderId) {
      setFormError('Enter both the order email and order ID.');
      return null;
    }
    Keyboard.dismiss();
    if (!quiet) setLoading(true);
    setFormError('');
    setResultError('');
    setSearched(true);
    try {
      const response = await api.get(
        `/api/order/track?email=${encodeURIComponent(cleanEmail)}&orderId=${encodeURIComponent(cleanOrderId)}`
      );
      setOrder(response.data.order);
      setTrackingSource('manual');
      setShowItems(false);
      revealResult();
      return response.data.order;
    } catch (error) {
      setOrder(null);
      setResultError(error.response?.data?.msg || 'No matching order was found.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [email, orderId, revealResult]);

  const onRefresh = useCallback(async () => {
    if (!order) return;
    setRefreshing(true);
    setResultError('');
    try {
      if (trackingSource === 'account') {
        const refreshed = await fetchActiveOrders({ quiet: true });
        const latest = refreshed.find((item) => getOrderKey(item) === getOrderKey(order));
        if (latest) {
          setOrder(latest);
        } else if (order._id) {
          const response = await api.get(`/api/order/user-orders?search=${encodeURIComponent(order.orderId || '')}`);
          const matches = response.data?.orders || [];
          const exact = matches.find((item) => getOrderKey(item) === getOrderKey(order));
          if (exact) setOrder(exact);
        }
      } else {
        await trackManualOrder({ quiet: true });
      }
    } catch (error) {
      setResultError(error.response?.data?.msg || 'The latest status could not be loaded.');
    } finally {
      setRefreshing(false);
    }
  }, [fetchActiveOrders, order, trackManualOrder, trackingSource]);

  const currentStepIndex = order ? STATUS_STEPS.indexOf(order.orderStatus) : -1;
  const orderItems = order?.orderItems || [];
  const status = getStatus(order?.orderStatus);
  const isCancelled = order?.orderStatus === 'cancelled';

  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('MainTabs', { screen: 'Account' });
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <View style={styles.container}>
          <PremiumBackHeader
            title="Track Order"
            subtitle="Live progress for every delivery"
            icon="navigate-outline"
            onBack={goBack}
            rightElement={(
              <TouchableOpacity
                style={styles.headerAction}
                onPress={order ? onRefresh : () => fetchActiveOrders()}
                disabled={refreshing || accountLoading}
                accessibilityRole="button"
                accessibilityLabel="Refresh order status"
              >
                {refreshing || accountLoading
                  ? <ActivityIndicator size="small" color={palette.colors.primary} />
                  : <Ionicons name="refresh-outline" size={19} color={palette.colors.primary} />}
              </TouchableOpacity>
            )}
            style={styles.premiumHeader}
          />

          <KeyboardAwareFormScrollView
            ref={scrollRef}
            contentContainerStyle={styles.scrollContent}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
          >
            <GlassPanel variant="strong" style={styles.hero}>
              <LinearGradient
                colors={['rgba(20,184,166,0.14)', 'rgba(14,165,233,0.06)', 'rgba(99,102,241,0.15)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
              />
              <View style={styles.heroIcon}>
                <Ionicons name="navigate" size={23} color="#fff" />
              </View>
              <View style={styles.heroCopy}>
                <Text style={styles.eyebrow}>YOUR DELIVERY, CLEARLY</Text>
                <Text style={styles.heroTitle}>Know what is happening at every step</Text>
                <Text style={styles.heroText}>
                  See live order progress here, with app and WhatsApp updates when your number is connected.
                </Text>
              </View>
            </GlassPanel>

            {currentUser && (
              <View style={styles.accountSection}>
                <TouchableOpacity
                  style={styles.sectionHeading}
                  onPress={() => setActiveOrdersExpanded((expanded) => !expanded)}
                  activeOpacity={0.76}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: activeOrdersExpanded }}
                  accessibilityLabel={`${activeOrders.length} active orders`}
                >
                  <View>
                    <Text style={styles.sectionEyebrow}>QUICK ACCESS</Text>
                    <Text style={styles.sectionTitle}>Active orders</Text>
                  </View>
                  <View style={styles.sectionActions}>
                    {accountLoading ? (
                      <ActivityIndicator size="small" color={palette.colors.primary} />
                    ) : (
                      <View style={styles.countPill}>
                        <Text style={styles.countPillText}>{activeOrders.length}</Text>
                      </View>
                    )}
                    <View style={styles.collapseButton}>
                      <Ionicons
                        name={activeOrdersExpanded ? 'chevron-up' : 'chevron-down'}
                        size={17}
                        color={palette.colors.primary}
                      />
                    </View>
                  </View>
                </TouchableOpacity>

                {activeOrdersExpanded && (accountLoading ? (
                  <GlassPanel variant="card" style={styles.accountLoadingCard}>
                    <ActivityIndicator size="small" color={palette.colors.primary} />
                    <Text style={styles.accountLoadingText}>Finding your active deliveries...</Text>
                  </GlassPanel>
                ) : accountError ? (
                  <View style={styles.inlineError}>
                    <Ionicons name="cloud-offline-outline" size={18} color={palette.colors.error} />
                    <Text style={styles.inlineErrorText}>{accountError}</Text>
                    <TouchableOpacity onPress={() => fetchActiveOrders()} hitSlop={8}>
                      <Text style={styles.inlineRetry}>Retry</Text>
                    </TouchableOpacity>
                  </View>
                ) : activeOrders.length > 0 ? (
                  <View style={styles.activeList}>
                    {activeOrders.map((activeOrder, index) => {
                      const activeStatus = getStatus(activeOrder.orderStatus);
                      return (
                        <GlassPanel key={getOrderKey(activeOrder)} variant="card" style={styles.activeOrderCard}>
                          <View style={[styles.activeOrderIcon, { backgroundColor: `${activeStatus.color}18` }]}>
                            <Ionicons name={activeStatus.icon} size={20} color={activeStatus.color} />
                          </View>
                          <View style={styles.activeOrderCopy}>
                            <View style={styles.activeOrderTopline}>
                              <Text style={styles.activeOrderId} numberOfLines={1}>
                                {activeOrder.orderId || `Order ${index + 1}`}
                              </Text>
                              <View style={[styles.statusChip, { backgroundColor: `${activeStatus.color}16` }]}>
                                <Text style={[styles.statusChipText, { color: activeStatus.color }]}>{activeStatus.shortLabel}</Text>
                              </View>
                            </View>
                            <Text style={styles.activeOrderMeta}>
                              {activeOrder.orderItems?.length || 0} item{activeOrder.orderItems?.length === 1 ? '' : 's'} · {formatPlacedDate(activeOrder.createdAt)}
                            </Text>
                          </View>
                          <TouchableOpacity
                            style={styles.viewStatusButton}
                            onPress={() => openAccountOrder(activeOrder)}
                            accessibilityRole="button"
                            accessibilityLabel={`View status for ${activeOrder.orderId}`}
                          >
                            <Ionicons name="arrow-forward" size={17} color="#fff" />
                          </TouchableOpacity>
                        </GlassPanel>
                      );
                    })}
                  </View>
                ) : (
                  <GlassPanel variant="card" style={styles.noActiveCard}>
                    <View style={styles.noActiveIcon}>
                      <Ionicons name="checkmark-done" size={20} color={palette.colors.success} />
                    </View>
                    <View style={styles.noActiveCopy}>
                      <Text style={styles.noActiveTitle}>No active deliveries</Text>
                      <Text style={styles.noActiveText}>New orders will appear here automatically.</Text>
                    </View>
                    <TouchableOpacity onPress={() => navigation.navigate('Orders')} hitSlop={8}>
                      <Text style={styles.ordersLink}>History</Text>
                    </TouchableOpacity>
                  </GlassPanel>
                ))}
              </View>
            )}

            <GlassPanel variant="card" style={styles.formCard}>
              <View style={styles.formHeading}>
                <View style={styles.formIcon}>
                  <Ionicons name="search-outline" size={19} color={palette.colors.primary} />
                </View>
                <View style={styles.formHeadingCopy}>
                  <Text style={styles.formTitle}>{currentUser ? 'Track another order' : 'Find your order'}</Text>
                  <Text style={styles.formSubtitle}>Use the email and order ID from your confirmation.</Text>
                </View>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Email address</Text>
                <View style={styles.inputShell}>
                  <Ionicons name="mail-outline" size={17} color={palette.colors.textSecondary} />
                  <TextInput
                    style={styles.input}
                    placeholder="your@email.com"
                    placeholderTextColor={palette.colors.textLight}
                    value={email}
                    onChangeText={(value) => {
                      setEmail(value);
                      if (formError) setFormError('');
                    }}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                </View>
              </View>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Order ID</Text>
                <View style={styles.inputShell}>
                  <Ionicons name="barcode-outline" size={17} color={palette.colors.textSecondary} />
                  <TextInput
                    style={styles.input}
                    placeholder="ORD-1234567890"
                    placeholderTextColor={palette.colors.textLight}
                    value={orderId}
                    onChangeText={(value) => {
                      setOrderId(value);
                      if (formError) setFormError('');
                    }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="search"
                    onSubmitEditing={() => trackManualOrder()}
                  />
                </View>
              </View>

              {!!formError && (
                <View style={styles.formError}>
                  <Ionicons name="information-circle-outline" size={16} color={palette.colors.error} />
                  <Text style={styles.formErrorText}>{formError}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.trackButton, loading && styles.disabled]}
                onPress={() => trackManualOrder()}
                disabled={loading}
                accessibilityRole="button"
              >
                <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
                {loading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : (
                    <>
                      <Ionicons name="navigate-outline" size={18} color="#fff" />
                      <Text style={styles.trackButtonText}>Show order status</Text>
                      <Ionicons name="arrow-forward" size={17} color="#fff" />
                    </>
                  )}
              </TouchableOpacity>
            </GlassPanel>

            {!!resultError && (
              <GlassPanel variant="card" style={styles.notFoundCard}>
                <View style={styles.notFoundIcon}>
                  <Ionicons name="search-outline" size={24} color={palette.colors.error} />
                </View>
                <Text style={styles.notFoundTitle}>We could not find that order</Text>
                <Text style={styles.notFoundText}>{resultError}</Text>
                <Text style={styles.notFoundHint}>Check for spaces or use the exact email from checkout.</Text>
              </GlassPanel>
            )}

            {order && (
              <View onLayout={(event) => { resultOffsetRef.current = event.nativeEvent.layout.y; }}>
                <GlassPanel variant="strong" style={styles.resultCard}>
                  <LinearGradient
                    colors={[`${status.color}18`, 'rgba(255,255,255,0.02)', 'rgba(99,102,241,0.08)']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={StyleSheet.absoluteFill}
                    pointerEvents="none"
                  />
                  <View style={styles.liveRow}>
                    <View style={[styles.liveIcon, { backgroundColor: `${status.color}18` }]}>
                      <Ionicons name={status.icon} size={25} color={status.color} />
                    </View>
                    <View style={styles.liveCopy}>
                      <Text style={styles.liveEyebrow}>{isCancelled ? 'ORDER UPDATE' : 'CURRENT STATUS'}</Text>
                      <Text style={styles.liveTitle}>{status.label}</Text>
                      <Text style={styles.liveText}>{status.detail}</Text>
                    </View>
                    {!isCancelled && <View style={[styles.liveDot, { backgroundColor: status.color }]} />}
                  </View>

                  <View style={styles.orderSummary}>
                    <View style={styles.summaryBlock}>
                      <Text style={styles.summaryLabel}>ORDER</Text>
                      <Text style={styles.summaryValue} numberOfLines={1}>{order.orderId || 'Order'}</Text>
                    </View>
                    <View style={styles.summaryDivider} />
                    <View style={[styles.summaryBlock, styles.summaryBlockRight]}>
                      <Text style={styles.summaryLabel}>TOTAL</Text>
                      <Text style={styles.summaryValue} numberOfLines={1} adjustsFontSizeToFit>
                        {orderMoney(order.orderSummary?.totalAmount)}
                      </Text>
                    </View>
                  </View>

                  {isCancelled ? (
                    <View style={styles.cancelledPanel}>
                      <Ionicons name="information-circle-outline" size={19} color={palette.colors.error} />
                      <Text style={styles.cancelledText}>
                        {order.cancellationReason || order.cancelReason || 'Contact support if you need help with this cancelled order.'}
                      </Text>
                    </View>
                  ) : (
                    <View style={styles.timeline}>
                      {STATUS_STEPS.map((step, index) => {
                        const stepStatus = getStatus(step);
                        const complete = index < currentStepIndex || order.orderStatus === 'delivered';
                        const current = index === currentStepIndex;
                        const active = complete || current;
                        return (
                          <View key={step} style={styles.timelineRow}>
                            <View style={styles.timelineRail}>
                              <View style={[
                                styles.timelineDot,
                                active && { backgroundColor: stepStatus.color, borderColor: stepStatus.color },
                                current && styles.timelineDotCurrent,
                              ]}>
                                <Ionicons
                                  name={complete ? 'checkmark' : stepStatus.icon}
                                  size={14}
                                  color={active ? '#fff' : palette.colors.textLight}
                                />
                              </View>
                              {index < STATUS_STEPS.length - 1 && (
                                <View style={[
                                  styles.timelineLine,
                                  complete && { backgroundColor: stepStatus.color },
                                ]} />
                              )}
                            </View>
                            <View style={styles.timelineCopy}>
                              <View style={styles.timelineTitleRow}>
                                <Text style={[styles.timelineTitle, active && { color: palette.colors.text }]}>
                                  {stepStatus.label}
                                </Text>
                                <Text style={[
                                  styles.timelineState,
                                  active && { color: stepStatus.color },
                                ]}>
                                  {complete ? 'Completed' : current ? 'Current' : 'Up next'}
                                </Text>
                              </View>
                              <Text style={styles.timelineDetail}>{stepStatus.detail}</Text>
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  <View style={styles.updateCard}>
                    <View style={styles.whatsAppIcon}>
                      <Ionicons name="logo-whatsapp" size={18} color="#fff" />
                    </View>
                    <View style={styles.updateCopy}>
                      <Text style={styles.updateTitle}>Status alerts, your way</Text>
                      <Text style={styles.updateText}>Follow updates in Rozare and on WhatsApp when connected.</Text>
                    </View>
                    {currentUser && (
                      <TouchableOpacity
                        onPress={() => navigation.navigate(
                          currentUser.role === 'seller' ? 'SellerWhatsAppSettings' : 'UserWhatsAppSettings'
                        )}
                        style={styles.updateAction}
                        accessibilityRole="button"
                      >
                        <Ionicons name="settings-outline" size={16} color="#16A34A" />
                      </TouchableOpacity>
                    )}
                  </View>

                  {!!order.shippingInfo && (
                    <View style={styles.infoSection}>
                      <View style={styles.infoTitleRow}>
                        <Ionicons name="location-outline" size={17} color={palette.colors.primary} />
                        <Text style={styles.infoTitle}>Delivery address</Text>
                      </View>
                      <Text style={styles.infoText}>
                        {[order.shippingInfo.fullName, order.shippingInfo.address, order.shippingInfo.city, order.shippingInfo.state, order.shippingInfo.postalCode, order.shippingInfo.country]
                          .filter(Boolean)
                          .join(', ')}
                      </Text>
                    </View>
                  )}

                  <TouchableOpacity style={styles.itemsToggle} onPress={() => setShowItems((value) => !value)}>
                    <View style={styles.itemsToggleCopy}>
                      <Ionicons name="bag-handle-outline" size={18} color={palette.colors.primary} />
                      <Text style={styles.itemsToggleText}>Order items</Text>
                      <View style={styles.itemsCount}>
                        <Text style={styles.itemsCountText}>{orderItems.length}</Text>
                      </View>
                    </View>
                    <Ionicons name={showItems ? 'chevron-up' : 'chevron-down'} size={18} color={palette.colors.textSecondary} />
                  </TouchableOpacity>

                  {showItems && orderItems.map((item, index) => (
                    <View key={item._id || `${item.productId || item.name}-${index}`} style={styles.orderItem}>
                      {item.image ? (
                        <Image source={{ uri: item.image }} style={styles.orderItemImage} contentFit="cover" />
                      ) : (
                        <View style={[styles.orderItemImage, styles.orderItemPlaceholder]}>
                          <Ionicons name="cube-outline" size={18} color={palette.colors.textSecondary} />
                        </View>
                      )}
                      <View style={styles.orderItemCopy}>
                        <Text style={styles.orderItemName} numberOfLines={2}>{item.name}</Text>
                        <Text style={styles.orderItemMeta}>Qty {item.quantity} · {orderMoney(item.price)}</Text>
                        {!!item.selectedColor && <Text style={styles.orderItemOption}>Color: {item.selectedColor}</Text>}
                        {getSelectedOptions(item).map(([name, value]) => (
                          <Text key={name} style={styles.orderItemOption}>{name}: {value}</Text>
                        ))}
                      </View>
                      <Text style={styles.orderItemTotal}>{orderMoney(item.price * item.quantity)}</Text>
                    </View>
                  ))}

                  <View style={styles.paymentRow}>
                    <View>
                      <Text style={styles.paymentLabel}>Payment</Text>
                      <Text style={styles.paymentMethod}>
                        {order.paymentMethod === 'cash_on_delivery'
                          ? 'Cash on Delivery'
                          : order.paymentMethod === 'wallet'
                            ? 'Rozare Wallet'
                            : 'Card'}
                      </Text>
                    </View>
                    <View style={[
                      styles.paymentPill,
                      { backgroundColor: order.isPaid ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)' },
                    ]}>
                      <Ionicons
                        name={order.isPaid ? 'checkmark-circle' : 'time-outline'}
                        size={14}
                        color={order.isPaid ? palette.colors.success : palette.colors.warning}
                      />
                      <Text style={[
                        styles.paymentPillText,
                        { color: order.isPaid ? palette.colors.success : palette.colors.warning },
                      ]}>
                        {order.isPaid ? 'Paid' : 'Pending'}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.placedDate}>Placed {formatPlacedDate(order.createdAt)}</Text>

                  {!!currentUser && !!order._id && (
                    <TouchableOpacity
                      style={styles.fullOrderButton}
                      onPress={() => navigation.navigate('OrderDetail', { orderId: order._id })}
                      accessibilityRole="button"
                    >
                      <Text style={styles.fullOrderButtonText}>Open full order</Text>
                      <Ionicons name="arrow-forward" size={16} color={palette.colors.primary} />
                    </TouchableOpacity>
                  )}
                </GlassPanel>
              </View>
            )}

            {searched && !order && !loading && !resultError && (
              <GlassPanel variant="card" style={styles.notFoundCard}>
                <Ionicons name="cube-outline" size={30} color={palette.colors.textLight} />
                <Text style={styles.notFoundTitle}>No order selected</Text>
              </GlassPanel>
            )}
          </KeyboardAwareFormScrollView>
        </View>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  headerAction: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.xxxl },
  hero: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primary,
    ...shadows.sm,
  },
  heroCopy: { flex: 1, minWidth: 0 },
  eyebrow: {
    fontSize: 9,
    fontWeight: fontWeight.extrabold,
    letterSpacing: 1.1,
    color: p.colors.primary,
    marginBottom: 4,
  },
  heroTitle: { ...typography.h3, color: p.colors.text, lineHeight: 23 },
  heroText: { marginTop: 5, fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  accountSection: {
    marginBottom: spacing.xl,
    padding: spacing.sm,
    borderRadius: 20,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  sectionHeading: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
  sectionActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionEyebrow: {
    fontSize: 9,
    fontWeight: fontWeight.extrabold,
    letterSpacing: 1.1,
    color: p.colors.primary,
  },
  sectionTitle: { marginTop: 3, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  countPill: {
    minWidth: 28,
    height: 25,
    paddingHorizontal: 8,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
  },
  countPillText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  collapseButton: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  activeList: { gap: spacing.sm, paddingTop: spacing.sm },
  activeOrderCard: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: 20,
  },
  activeOrderIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  activeOrderCopy: { flex: 1, minWidth: 0 },
  activeOrderTopline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  activeOrderId: { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  activeOrderMeta: { marginTop: 5, fontSize: 10, color: p.colors.textSecondary },
  statusChip: { minHeight: 22, justifyContent: 'center', paddingHorizontal: 7, borderRadius: 8 },
  statusChipText: { fontSize: 9, fontWeight: fontWeight.extrabold },
  viewStatusButton: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primary,
  },
  accountLoadingCard: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  accountLoadingText: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  inlineError: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: 18,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: p.colors.errorLighter,
  },
  inlineErrorText: { flex: 1, fontSize: fontSize.sm, lineHeight: 18, color: p.colors.text },
  inlineRetry: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.error },
  noActiveCard: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  noActiveIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.successSubtle,
  },
  noActiveCopy: { flex: 1 },
  noActiveTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  noActiveText: { marginTop: 2, fontSize: 10, color: p.colors.textSecondary },
  ordersLink: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  formCard: { padding: spacing.lg, marginBottom: spacing.md },
  formHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  formIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  formHeadingCopy: { flex: 1 },
  formTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  formSubtitle: { marginTop: 2, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  inputGroup: { marginBottom: spacing.md },
  label: { marginBottom: 6, fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  inputShell: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: p.glass.bgSubtle,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  input: { flex: 1, minWidth: 0, paddingVertical: spacing.sm, fontSize: fontSize.sm, color: p.colors.text },
  formError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: -4,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  formErrorText: { flex: 1, fontSize: 11, color: p.colors.error },
  trackButton: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
    borderRadius: 16,
    overflow: 'hidden',
    ...shadows.md,
  },
  trackButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  disabled: { opacity: 0.58 },
  notFoundCard: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  notFoundIcon: {
    width: 50,
    height: 50,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.errorSubtle,
  },
  notFoundTitle: { marginTop: spacing.md, fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  notFoundText: { marginTop: 5, textAlign: 'center', fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  notFoundHint: { marginTop: spacing.sm, textAlign: 'center', fontSize: 10, color: p.colors.textLight },
  resultCard: { padding: spacing.lg, marginBottom: spacing.md },
  liveRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.lg },
  liveIcon: { width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  liveCopy: { flex: 1, minWidth: 0 },
  liveEyebrow: {
    fontSize: 9,
    fontWeight: fontWeight.extrabold,
    letterSpacing: 1,
    color: p.colors.textSecondary,
  },
  liveTitle: { marginTop: 3, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text },
  liveText: { marginTop: 3, fontSize: 11, lineHeight: 16, color: p.colors.textSecondary },
  liveDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, shadowColor: '#22C55E', shadowOpacity: 0.5, shadowRadius: 5 },
  orderSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    marginBottom: spacing.lg,
    borderRadius: 16,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  summaryBlock: { flex: 1, minWidth: 0 },
  summaryBlockRight: { alignItems: 'flex-end' },
  summaryLabel: { fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.8, color: p.colors.textLight },
  summaryValue: { marginTop: 3, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.text },
  summaryDivider: { width: 1, height: 30, marginHorizontal: spacing.md, backgroundColor: p.glass.borderSubtle },
  timeline: { marginBottom: spacing.md },
  timelineRow: { minHeight: 74, flexDirection: 'row' },
  timelineRail: { width: 38, alignItems: 'center' },
  timelineDot: {
    width: 31,
    height: 31,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  timelineDotCurrent: { borderWidth: 3, borderColor: 'rgba(255,255,255,0.78)' },
  timelineLine: { width: 2, flex: 1, backgroundColor: p.glass.borderSubtle },
  timelineCopy: { flex: 1, paddingLeft: spacing.sm, paddingBottom: spacing.md },
  timelineTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  timelineTitle: { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.textLight },
  timelineState: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.textLight },
  timelineDetail: { marginTop: 4, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  cancelledPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 15,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: p.colors.errorLighter,
  },
  cancelledText: { flex: 1, fontSize: fontSize.sm, lineHeight: 19, color: p.colors.text },
  updateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: 16,
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.20)',
  },
  whatsAppIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#22C55E' },
  updateCopy: { flex: 1 },
  updateTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  updateText: { marginTop: 2, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  updateAction: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,197,94,0.12)' },
  infoSection: { padding: spacing.md, marginBottom: spacing.sm, borderRadius: 16, backgroundColor: p.glass.bgSubtle },
  infoTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  infoTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  infoText: { fontSize: 11, lineHeight: 18, color: p.colors.textSecondary },
  itemsToggle: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: p.glass.borderSubtle,
  },
  itemsToggleCopy: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  itemsToggleText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  itemsCount: { minWidth: 22, height: 20, paddingHorizontal: 5, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  itemsCountText: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.primary },
  orderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: 14,
    backgroundColor: p.glass.bgSubtle,
  },
  orderItemImage: { width: 46, height: 46, borderRadius: 12 },
  orderItemPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgStrong },
  orderItemCopy: { flex: 1, minWidth: 0 },
  orderItemName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  orderItemMeta: { marginTop: 3, fontSize: 10, color: p.colors.textSecondary },
  orderItemOption: { marginTop: 2, fontSize: 9, color: p.colors.textSecondary },
  orderItemTotal: { maxWidth: 92, textAlign: 'right', fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.text },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    marginTop: spacing.xs,
    borderRadius: 15,
    backgroundColor: p.glass.bgSubtle,
  },
  paymentLabel: { fontSize: 10, color: p.colors.textSecondary },
  paymentMethod: { marginTop: 2, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  paymentPill: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28, paddingHorizontal: 9, borderRadius: 10 },
  paymentPillText: { fontSize: 10, fontWeight: fontWeight.bold },
  placedDate: { marginTop: spacing.md, textAlign: 'center', fontSize: 10, color: p.colors.textSecondary },
  fullOrderButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    borderRadius: 14,
    backgroundColor: p.colors.primarySubtle,
    borderWidth: 1,
    borderColor: p.colors.primaryLighter,
  },
  fullOrderButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.primary },
});
