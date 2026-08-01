/**
 * Stripe cancellation/dismissal return. A cancel redirect can race a payment
 * webhook, so the order is checked once before showing a non-success state.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { trackPaymentEvent } from '../utils/breadcrumbs';
import { verifyOrderPayment } from '../utils/checkout';
import { spacing, fontSize, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function PaymentCancelScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const orderId = route.params?.orderId || '';
  const sessionId = route.params?.session_id || route.params?.sessionId || '';
  const paymentIntentId = route.params?.payment_intent || route.params?.paymentIntentId || '';
  const [status, setStatus] = useState('checking');
  const mountedRef = useRef(true);
  const scaleAnim = useRef(new Animated.Value(0.82)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const checkStatus = useCallback(async () => {
    setStatus('checking');
    const result = await verifyOrderPayment({ apiClient: api, orderId, sessionId, paymentIntentId, attempts: 2, delayMs: 700 });
    if (!mountedRef.current) return;
    trackPaymentEvent(`cancel_return_${result.status}`, { orderId, sessionId, paymentIntentId });
    if (result.status === 'paid') {
      navigation.replace('PaymentSuccess', {
        orderId,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(paymentIntentId ? { payment_intent: paymentIntentId } : {}),
      });
      return;
    }
    setStatus(result.status === 'pending' ? 'pending' : 'not_paid');
    Animated.spring(scaleAnim, { toValue: 1, friction: 6, tension: 65, useNativeDriver: true }).start();
  }, [navigation, orderId, paymentIntentId, scaleAnim, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    checkStatus();
    return () => { mountedRef.current = false; };
  }, [checkStatus]);

  const checking = status === 'checking';
  const pending = status === 'pending';
  const title = checking ? 'Checking payment status' : pending ? 'Payment not confirmed yet' : 'Payment not completed';
  const subtitle = checking
    ? 'We are checking with Rozare before showing the final status.'
    : pending
      ? 'Confirmation has not arrived yet. Your cart is safe, and you can check again before retrying.'
      : 'The secure checkout did not complete. Your cart has been kept so you can try again.';
  const accent = pending || checking ? palette.colors.warning : palette.colors.error;

  return (
    <GlassBackground>
      <View style={styles.content}>
        <Animated.View style={[styles.iconOuter, { backgroundColor: `${accent}18`, transform: [{ scale: scaleAnim }] }]}>
          <View style={[styles.iconInner, { backgroundColor: accent }]}>
            {checking ? <ActivityIndicator size="large" color="#fff" /> : <Ionicons name={pending ? 'time-outline' : 'close'} size={50} color="#fff" />}
          </View>
        </Animated.View>
        <Animated.View style={[styles.copy, { opacity: fadeAnim }]}>
          <Text style={styles.eyebrow}>SECURE CHECKOUT</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {!!orderId && (
            <GlassPanel variant="inner" style={styles.orderBadge}>
              <Ionicons name="receipt-outline" size={15} color={accent} />
              <View style={{ flex: 1 }}><Text style={styles.orderLabel}>Order reference</Text><Text style={[styles.orderIdText, { color: accent }]}>{orderId}</Text></View>
            </GlassPanel>
          )}
          <GlassPanel variant="inner" style={styles.tipCard}>
            <Ionicons name="cart-outline" size={19} color={palette.colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.tipTitle}>Nothing was removed from your cart</Text>
              <Text style={styles.tipText}>If your bank shows a completed charge, use Check Status instead of creating another payment.</Text>
            </View>
          </GlassPanel>
        </Animated.View>
      </View>
      <View style={styles.footer}>
        {pending ? (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.replace('PaymentSuccess', {
            orderId,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(paymentIntentId ? { payment_intent: paymentIntentId } : {}),
          })}>
            <Ionicons name="refresh" size={19} color="#fff" /><Text style={styles.primaryBtnText}>Check Status</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.replace('Checkout')} disabled={checking}>
            <Ionicons name="card-outline" size={19} color="#fff" /><Text style={styles.primaryBtnText}>Return to Checkout</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] })}>
          <Text style={styles.secondaryBtnText}>Continue Shopping</Text>
        </TouchableOpacity>
      </View>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.xxl },
  iconOuter: { width: 116, height: 116, borderRadius: 58, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xl },
  iconInner: { width: 88, height: 88, borderRadius: 44, justifyContent: 'center', alignItems: 'center', ...shadows.md },
  copy: { width: '100%', alignItems: 'center' },
  eyebrow: { color: p.colors.primary, fontSize: 10, letterSpacing: 1.5, fontWeight: fontWeight.extrabold, marginBottom: spacing.sm },
  title: { fontSize: 27, fontWeight: fontWeight.extrabold, color: p.colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  subtitle: { maxWidth: 360, fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: spacing.xl },
  orderBadge: { width: '100%', maxWidth: 380, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.md },
  orderLabel: { color: p.colors.textSecondary, fontSize: fontSize.xs },
  orderIdText: { marginTop: 2, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  tipCard: { width: '100%', maxWidth: 380, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md },
  tipTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold, marginBottom: 3 },
  tipText: { fontSize: fontSize.xs, color: p.colors.textSecondary, lineHeight: 18 },
  footer: { padding: spacing.xl, gap: spacing.md },
  primaryBtn: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingVertical: 15, borderRadius: 17, ...shadows.md },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  secondaryBtn: { alignItems: 'center', paddingVertical: 14, borderRadius: 16, borderWidth: 1.5, borderColor: p.glass.border },
  secondaryBtnText: { color: p.colors.textSecondary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
