/**
 * PaymentSuccessScreen — Liquid Glass Design
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useGlobal } from '../contexts/GlobalContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

export default function PaymentSuccessScreen({ navigation, route }) {
  const { fetchCart } = useGlobal();
  const { orderId } = route.params || {};
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    api.delete('/api/cart/clear').then(() => fetchCart()).catch(() => {});
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 1, friction: 4, tension: 60, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <GlassBackground>
      <View style={styles.content}>
        <Animated.View style={[styles.iconOuter, { transform: [{ scale: scaleAnim }] }]}>
          <View style={styles.iconInner}><Ionicons name="checkmark" size={52} color="#fff" /></View>
        </Animated.View>
        <Animated.View style={{ opacity: fadeAnim, alignItems: 'center' }}>
          <Text style={styles.title}>Payment Successful!</Text>
          <Text style={styles.subtitle}>Your order has been placed and payment confirmed.</Text>
          {orderId && <GlassPanel variant="inner" style={styles.orderBadge}><Ionicons name="receipt-outline" size={14} color={colors.primary} /><Text style={styles.orderIdText}>Order: {orderId}</Text></GlassPanel>}
          <View style={styles.infoRow}><Ionicons name="time-outline" size={16} color={colors.textSecondary} /><Text style={styles.infoText}>Processing your order now</Text></View>
          <View style={styles.infoRow}><Ionicons name="mail-outline" size={16} color={colors.textSecondary} /><Text style={styles.infoText}>Confirmation email sent</Text></View>
        </Animated.View>
      </View>
      <Animated.View style={[styles.footer, { opacity: fadeAnim }]}>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] })}>
          <Ionicons name="bag-outline" size={18} color="#fff" /><Text style={styles.primaryBtnText}>Track My Order</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] })}>
          <Text style={styles.secondaryBtnText}>Continue Shopping</Text>
        </TouchableOpacity>
      </Animated.View>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  iconOuter: { width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(34,197,94,0.15)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xxl },
  iconInner: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.success, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 26, fontWeight: fontWeight.extrabold, color: colors.text, marginBottom: spacing.md, textAlign: 'center' },
  subtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: spacing.xl },
  orderBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, marginBottom: spacing.lg },
  orderIdText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primary },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  infoText: { fontSize: fontSize.sm, color: colors.textSecondary },
  footer: { padding: spacing.xl, gap: spacing.md },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, ...shadows.md },
  primaryBtnText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  secondaryBtn: { alignItems: 'center', paddingVertical: 14, borderRadius: 16, borderWidth: 1.5, borderColor: glass.border },
  secondaryBtnText: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
