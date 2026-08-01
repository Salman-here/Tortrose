/**
 * Stripe return screen. The deep link is only a return signal; the backend is
 * the source of truth and must confirm payment before this screen celebrates
 * or clears the cart.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useGlobal } from '../contexts/GlobalContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { recordSuccessfulOrder } from '../hooks/useReviewPrompt';
import { trackPaymentEvent } from '../utils/breadcrumbs';
import { verifyOrderPayment } from '../utils/checkout';
import { spacing, fontSize, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function PaymentSuccessScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { fetchCart } = useGlobal();
  const orderId = route.params?.orderId || '';
  const sessionId = route.params?.session_id || route.params?.sessionId || '';
  const [verification, setVerification] = useState({ status: 'checking' });
  const [retrying, setRetrying] = useState(false);
  const completedRef = useRef(false);
  const mountedRef = useRef(true);
  const scaleAnim = useRef(new Animated.Value(0.82)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const animateIn = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleAnim, { toValue: 1, friction: 6, tension: 65, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 280, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, scaleAnim]);

  const confirmPayment = useCallback(async ({ attempts = 6 } = {}) => {
    setRetrying(true);
    setVerification({ status: 'checking' });
    const result = await verifyOrderPayment({ apiClient: api, orderId, sessionId, attempts, delayMs: 1200 });
    if (!mountedRef.current) return;

    setVerification(result);
    setRetrying(false);
    animateIn();
    trackPaymentEvent(`verification_${result.status}`, { orderId, sessionId });

    if (result.status === 'paid' && !completedRef.current) {
      completedRef.current = true;
      try {
        await api.delete('/api/cart/clear');
        await fetchCart();
      } catch {}
      recordSuccessfulOrder();
    }
  }, [animateIn, fetchCart, orderId, sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    trackPaymentEvent('return_received', { orderId, sessionId });
    confirmPayment();
    return () => { mountedRef.current = false; };
  }, [confirmPayment, orderId, sessionId]);

  const status = verification.status;
  const paid = status === 'paid';
  const pending = status === 'pending' || status === 'checking';
  const icon = paid ? 'checkmark' : pending ? 'time-outline' : 'close';
  const accent = paid ? palette.colors.success : pending ? palette.colors.warning : palette.colors.error;
  const title = paid ? 'Payment confirmed' : pending ? 'Confirming your payment' : 'Payment not completed';
  const subtitle = paid
    ? 'Your order is secured and the stores can now begin preparing it.'
    : pending
      ? 'Stripe may take a few moments to report back. We will not clear your cart or claim success early.'
      : 'We could not verify a successful charge. Your cart has been kept safely.';

  return (
    <GlassBackground>
      <View style={styles.content}>
        <Animated.View style={[styles.iconOuter, { backgroundColor: `${accent}18`, transform: [{ scale: scaleAnim }] }]}>
          <View style={[styles.iconInner, { backgroundColor: accent }]}>
            {status === 'checking' ? <ActivityIndicator size="large" color="#fff" /> : <Ionicons name={icon} size={50} color="#fff" />}
          </View>
        </Animated.View>
        <Animated.View style={[styles.copy, { opacity: fadeAnim }]}>
          <Text style={styles.eyebrow}>{paid ? 'ORDER SECURED' : 'SECURE PAYMENT CHECK'}</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
          {!!orderId && (
            <GlassPanel variant="inner" style={styles.orderBadge}>
              <Ionicons name="receipt-outline" size={15} color={accent} />
              <View style={{ flex: 1 }}><Text style={styles.orderLabel}>Order reference</Text><Text style={[styles.orderIdText, { color: accent }]}>{orderId}</Text></View>
            </GlassPanel>
          )}
          {paid && (
            <GlassPanel variant="inner" style={styles.infoCard}>
              <View style={styles.infoRow}><Ionicons name="shield-checkmark-outline" size={17} color={palette.colors.success} /><Text style={styles.infoText}>Payment verified by Rozare</Text></View>
              <View style={styles.infoRow}><Ionicons name="notifications-outline" size={17} color={palette.colors.primary} /><Text style={styles.infoText}>Order updates will appear in My Orders</Text></View>
            </GlassPanel>
          )}
          {!paid && status !== 'checking' && (
            <GlassPanel variant="inner" style={styles.infoCard}>
              <View style={styles.infoRow}><Ionicons name="cart-outline" size={17} color={palette.colors.primary} /><Text style={styles.infoText}>Your cart has not been cleared</Text></View>
              <View style={styles.infoRow}><Ionicons name="help-circle-outline" size={17} color={palette.colors.warning} /><Text style={styles.infoText}>If your bank shows a charge, check again before retrying</Text></View>
            </GlassPanel>
          )}
        </Animated.View>
      </View>
      <View style={styles.footer}>
        {paid ? (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.reset({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] })}>
            <Ionicons name="bag-handle-outline" size={19} color="#fff" /><Text style={styles.primaryBtnText}>Track My Order</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.primaryBtn} onPress={() => confirmPayment({ attempts: 3 })} disabled={retrying}>
            {retrying ? <ActivityIndicator color="#fff" /> : <><Ionicons name="refresh" size={19} color="#fff" /><Text style={styles.primaryBtnText}>Check Payment Again</Text></>}
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => paid
          ? navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] })
          : navigation.replace('Checkout')}
        >
          <Text style={styles.secondaryBtnText}>{paid ? 'Continue Shopping' : 'Return to Checkout'}</Text>
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
  infoCard: { width: '100%', maxWidth: 380, padding: spacing.md, gap: spacing.sm },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  infoText: { flex: 1, fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 19 },
  footer: { padding: spacing.xl, gap: spacing.md },
  primaryBtn: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingVertical: 15, borderRadius: 17, ...shadows.md },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  secondaryBtn: { alignItems: 'center', paddingVertical: 14, borderRadius: 16, borderWidth: 1.5, borderColor: p.glass.border },
  secondaryBtnText: { color: p.colors.textSecondary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
