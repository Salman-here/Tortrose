/**
 * PaymentCancelScreen — Liquid Glass Design
 */

import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

export default function PaymentCancelScreen({ navigation, route }) {
  const { orderId } = route.params || {};
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 1, friction: 4, tension: 60, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <GlassBackground>
      <View style={styles.content}>
        <Animated.View style={[styles.iconOuter, { transform: [{ scale: scaleAnim }] }]}>
          <View style={styles.iconInner}><Ionicons name="close" size={52} color="#fff" /></View>
        </Animated.View>
        <Animated.View style={{ opacity: fadeAnim, alignItems: 'center' }}>
          <Text style={styles.title}>Payment Cancelled</Text>
          <Text style={styles.subtitle}>Your payment was not completed. No charges have been made.</Text>
          {orderId && <GlassPanel variant="inner" style={styles.orderBadge}><Ionicons name="receipt-outline" size={14} color={colors.warning} /><Text style={styles.orderIdText}>Order: {orderId}</Text></GlassPanel>}
          <GlassPanel variant="inner" style={styles.tipCard}>
            <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.tipText}>Your cart items are still saved. You can try again or choose a different payment method.</Text>
          </GlassPanel>
        </Animated.View>
      </View>
      <Animated.View style={[styles.footer, { opacity: fadeAnim }]}>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('Checkout')}>
          <Ionicons name="refresh-outline" size={18} color="#fff" /><Text style={styles.primaryBtnText}>Try Again</Text>
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
  iconOuter: { width: 120, height: 120, borderRadius: 60, backgroundColor: 'rgba(239,68,68,0.15)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.xxl },
  iconInner: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.error, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 26, fontWeight: fontWeight.extrabold, color: colors.text, marginBottom: spacing.md, textAlign: 'center' },
  subtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: spacing.xl },
  orderBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, marginBottom: spacing.lg },
  orderIdText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.warning },
  tipCard: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md },
  tipText: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },
  footer: { padding: spacing.xl, gap: spacing.md },
  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, paddingVertical: 16, borderRadius: 16, ...shadows.md },
  primaryBtnText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  secondaryBtn: { alignItems: 'center', paddingVertical: 14, borderRadius: 16, borderWidth: 1.5, borderColor: glass.border },
  secondaryBtnText: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
