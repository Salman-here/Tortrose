import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { borderRadius, fontSize, fontWeight, shadows, spacing } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import { useCurrency } from '../contexts/CurrencyContext';

const getSelectedOptions = (item = {}) => {
  if (!item.selectedOptions || typeof item.selectedOptions !== 'object') return [];
  return Object.entries(item.selectedOptions).filter(([, value]) => value);
};

const statusMeta = (order) => {
  if (!order) return { icon: 'time-outline', title: 'Loading order', tone: 'primary' };
  if (order.confirmation?.expired && !order.confirmation?.confirmedAt) return { icon: 'time-outline', title: 'Confirmation link expired', tone: 'warning' };
  if (order.confirmation?.declinedAt || order.orderStatus === 'cancelled') return { icon: 'close-circle-outline', title: 'Order cancelled', tone: 'error' };
  if (order.confirmation?.confirmedAt || order.orderStatus === 'confirmed') return { icon: 'checkmark-circle-outline', title: 'Order confirmed', tone: 'success' };
  return { icon: 'shield-checkmark-outline', title: 'Confirm your order', tone: 'primary' };
};

export default function OrderConfirmationScreen({ navigation, route }) {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const token = route?.params?.token || '';

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const money = useCallback((amount) => formatPrice(amount, { sourceCurrency: order?.currency || 'USD' }), [formatPrice, order?.currency]);

  const fetchOrder = useCallback(async (silent = false) => {
    if (!token) {
      setError('This confirmation link is invalid.');
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const res = await api.get(`/api/order-confirm/${token}`);
      setOrder(res.data?.order || null);
      setError('');
    } catch (err) {
      setError(err.response?.data?.msg || 'Confirmation link is invalid or expired.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    fetchOrder();
  }, [fetchOrder]);

  const submitAction = async (action) => {
    setSubmitting(true);
    try {
      const res = await api.post(`/api/order-confirm/${token}/${action}`);
      setOrder(res.data?.order || null);
      Toast.show({ type: 'success', text1: res.data?.msg || 'Order updated' });
    } catch (err) {
      const msg = err.response?.data?.msg || 'Could not update this order.';
      if (err.response?.data?.order) setOrder(err.response.data.order);
      Toast.show({ type: 'error', text1: 'Order confirmation', text2: msg });
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmOrder = () => submitAction('confirm');
  const reconfirmOrder = () => submitAction('reconfirm');
  const declineOrder = () => {
    Alert.alert(
      'Cancel order?',
      'This will cancel the order and notify the seller.',
      [
        { text: 'Keep Order', style: 'cancel' },
        { text: 'Cancel Order', style: 'destructive', onPress: () => submitAction('decline') },
      ]
    );
  };

  const meta = statusMeta(order);
  const toneColor = palette.colors[meta.tone] || palette.colors.primary;
  const summary = order?.orderSummary || {};

  return (
    <GlassBackground>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchOrder(true); }} />}
        showsVerticalScrollIndicator={false}
      >
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.navigate('MainTabs')}>
            <Ionicons name="home-outline" size={19} color={palette.colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Order Confirmation</Text>
          <View style={{ width: 36 }} />
        </GlassPanel>

        {loading ? (
          <GlassPanel variant="card" style={styles.centerCard}>
            <ActivityIndicator color={palette.colors.primary} />
            <Text style={styles.mutedText}>Loading order...</Text>
          </GlassPanel>
        ) : error && !order ? (
          <GlassPanel variant="card" style={styles.centerCard}>
            <Ionicons name="alert-circle-outline" size={42} color={palette.colors.error} />
            <Text style={styles.errorTitle}>Link Unavailable</Text>
            <Text style={styles.mutedText}>{error}</Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => navigation.navigate('MainTabs')}>
              <Text style={styles.secondaryButtonText}>Back to Home</Text>
            </TouchableOpacity>
          </GlassPanel>
        ) : (
          <>
            <GlassPanel variant="strong" style={styles.hero}>
              <View style={[styles.heroIcon, { backgroundColor: `${toneColor}22` }]}>
                <Ionicons name={meta.icon} size={34} color={toneColor} />
              </View>
              <Text style={styles.heroTitle}>{meta.title}</Text>
              <Text style={styles.heroSub}>Order {order.orderId}</Text>
              <View style={styles.statusPill}>
                <Text style={[styles.statusPillText, { color: toneColor }]}>{String(order.orderStatus || 'pending').toUpperCase()}</Text>
              </View>
            </GlassPanel>

            <GlassPanel variant="card" style={styles.card}>
              <Text style={styles.sectionTitle}>Items</Text>
              {(order.orderItems || []).map((item, index) => {
                const selectedOptions = getSelectedOptions(item);
                return (
                  <View key={`${item.name}-${index}`} style={styles.itemRow}>
                    <Image source={{ uri: item.image || 'https://via.placeholder.com/80' }} style={styles.itemImage} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
                      <Text style={styles.itemMeta}>Qty {item.quantity || 1} • {money(item.price || 0)}</Text>
                      {!!item.selectedColor && <Text style={styles.itemOption}>Color: {item.selectedColor}</Text>}
                      {selectedOptions.map(([name, value]) => (
                        <Text key={name} style={styles.itemOption}>{name}: {String(value)}</Text>
                      ))}
                    </View>
                  </View>
                );
              })}
            </GlassPanel>

            <GlassPanel variant="card" style={styles.card}>
              <Text style={styles.sectionTitle}>Shipping</Text>
              <View style={styles.infoRow}><Ionicons name="person-outline" size={16} color={palette.colors.textSecondary} /><Text style={styles.infoText}>{order.shippingInfo?.fullName || 'Customer'}</Text></View>
              <View style={styles.infoRow}><Ionicons name="location-outline" size={16} color={palette.colors.textSecondary} /><Text style={styles.infoText}>{[order.shippingInfo?.address, order.shippingInfo?.city, order.shippingInfo?.state, order.shippingInfo?.country].filter(Boolean).join(', ')}</Text></View>
              {!!order.shippingInfo?.maskedPhone && <View style={styles.infoRow}><Ionicons name="call-outline" size={16} color={palette.colors.textSecondary} /><Text style={styles.infoText}>Phone ending {order.shippingInfo.maskedPhone}</Text></View>}
            </GlassPanel>

            <GlassPanel variant="card" style={styles.card}>
              <Text style={styles.sectionTitle}>Summary</Text>
              <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Subtotal</Text><Text style={styles.summaryValue}>{money(summary.subtotal || 0)}</Text></View>
              <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Shipping</Text><Text style={styles.summaryValue}>{money(summary.shippingFee || summary.shippingCost || 0)}</Text></View>
              <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Tax</Text><Text style={styles.summaryValue}>{money(summary.taxAmount || 0)}</Text></View>
              {!!summary.discountAmount && <View style={styles.summaryRow}><Text style={styles.summaryLabel}>Discount</Text><Text style={styles.summaryValue}>-{money(summary.discountAmount)}</Text></View>}
              <View style={styles.totalRow}><Text style={styles.totalLabel}>Total</Text><Text style={styles.totalValue}>{money(summary.totalAmount || summary.total || 0)}</Text></View>
              <Text style={styles.paymentText}>{order.paymentMethod || 'Cash on Delivery'}</Text>
            </GlassPanel>

            {!order.confirmation?.expired && !order.confirmation?.confirmedAt && !order.confirmation?.declinedAt && order.orderStatus !== 'cancelled' && (
              <View style={styles.actions}>
                <TouchableOpacity style={[styles.primaryButton, submitting && styles.disabledButton]} onPress={confirmOrder} disabled={submitting}>
                  {submitting ? <ActivityIndicator color="#fff" /> : <><Ionicons name="checkmark-circle-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Confirm Order</Text></>}
                </TouchableOpacity>
                <TouchableOpacity style={[styles.dangerButton, submitting && styles.disabledButton]} onPress={declineOrder} disabled={submitting}>
                  <Text style={styles.dangerButtonText}>Cancel Order</Text>
                </TouchableOpacity>
              </View>
            )}

            {(order.confirmation?.declinedAt || order.orderStatus === 'cancelled') && (
              <TouchableOpacity style={[styles.primaryButton, submitting && styles.disabledButton]} onPress={reconfirmOrder} disabled={submitting}>
                {submitting ? <ActivityIndicator color="#fff" /> : <><Ionicons name="cart-outline" size={18} color="#fff" /><Text style={styles.primaryButtonText}>Place Order Again</Text></>}
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flexGrow: 1, padding: spacing.md, paddingBottom: spacing.xxxl },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.md },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  centerCard: { minHeight: 240, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  mutedText: { color: p.colors.textSecondary, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  errorTitle: { color: p.colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  hero: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  heroIcon: { width: 70, height: 70, borderRadius: 35, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  heroTitle: { color: p.colors.text, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, textAlign: 'center' },
  heroSub: { color: p.colors.textSecondary, fontSize: fontSize.sm, marginTop: 4 },
  statusPill: { marginTop: spacing.sm, borderRadius: borderRadius.full, paddingHorizontal: spacing.md, paddingVertical: 5, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  statusPillText: { fontSize: 11, fontWeight: fontWeight.bold },
  card: { padding: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold, marginBottom: spacing.md },
  itemRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  itemImage: { width: 58, height: 58, borderRadius: borderRadius.md, backgroundColor: p.colors.surfaceVariant },
  itemName: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  itemMeta: { color: p.colors.textSecondary, fontSize: fontSize.xs, marginTop: 3 },
  itemOption: { color: p.colors.primary, fontSize: 11, marginTop: 2 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.sm },
  infoText: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, lineHeight: 20 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  summaryLabel: { color: p.colors.textSecondary, fontSize: fontSize.sm },
  summaryValue: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.borderSubtle, paddingTop: spacing.md, marginTop: spacing.sm },
  totalLabel: { color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  totalValue: { color: p.colors.primary, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  paymentText: { marginTop: spacing.sm, color: p.colors.textSecondary, fontSize: fontSize.xs },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 52, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, ...shadows.md },
  primaryButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  secondaryButton: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: p.colors.primarySubtle },
  secondaryButtonText: { color: p.colors.primary, fontWeight: fontWeight.bold },
  dangerButton: { minHeight: 50, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: p.colors.error, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.errorSubtle },
  dangerButtonText: { color: p.colors.error, fontWeight: fontWeight.bold },
  disabledButton: { opacity: 0.65 },
});
