import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, SafeAreaView, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useGlobal } from '../contexts/GlobalContext';
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';

export default function PaymentSuccessScreen({ navigation, route }) {
  const { fetchCart } = useGlobal();
  const { orderId } = route.params || {};

  // Animations
  const scaleAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Clear the cart on mount (payment was successful)
    api.delete('/api/cart/clear').then(() => fetchCart()).catch(() => {});

    // Entrance animation
    Animated.sequence([
      Animated.spring(scaleAnim, { toValue: 1, friction: 4, tension: 60, useNativeDriver: true }),
      Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
    ]).start();
  }, []);

  const goToOrders = () => {
    navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }, { name: 'Orders' }] });
  };

  const goHome = () => {
    navigation.reset({ index: 0, routes: [{ name: 'MainTabs' }] });
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Success Circle */}
        <Animated.View style={[styles.iconCircleOuter, { transform: [{ scale: scaleAnim }] }]}>
          <View style={styles.iconCircleInner}>
            <Ionicons name="checkmark" size={56} color={colors.white} />
          </View>
        </Animated.View>

        <Animated.View style={{ opacity: fadeAnim, alignItems: 'center' }}>
          <Text style={styles.title}>Payment Successful!</Text>
          <Text style={styles.subtitle}>
            Your order has been placed and payment confirmed. We'll send you an email with the details.
          </Text>

          {orderId ? (
            <View style={styles.orderIdBadge}>
              <Ionicons name="receipt-outline" size={16} color={colors.primary} />
              <Text style={styles.orderIdText}>Order: {orderId}</Text>
            </View>
          ) : null}

          <View style={styles.infoRow}>
            <Ionicons name="time-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.infoText}>Processing your order now</Text>
          </View>
          <View style={styles.infoRow}>
            <Ionicons name="mail-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.infoText}>Confirmation email sent</Text>
          </View>
        </Animated.View>
      </View>

      {/* Actions */}
      <Animated.View style={[styles.footer, { opacity: fadeAnim }]}>
        <TouchableOpacity style={styles.primaryBtn} onPress={goToOrders} activeOpacity={0.85}>
          <Ionicons name="bag-outline" size={20} color={colors.white} />
          <Text style={styles.primaryBtnText}>Track My Order</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={goHome} activeOpacity={0.85}>
          <Text style={styles.secondaryBtnText}>Continue Shopping</Text>
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  iconCircleOuter: {
    width: 140, height: 140, borderRadius: 70,
    backgroundColor: '#d1fae5', justifyContent: 'center', alignItems: 'center',
    marginBottom: spacing.xxl, ...shadows.lg,
  },
  iconCircleInner: {
    width: 110, height: 110, borderRadius: 55,
    backgroundColor: colors.success, justifyContent: 'center', alignItems: 'center',
  },
  title: {
    fontSize: fontSize.title, fontWeight: fontWeight.extrabold,
    color: colors.dark, marginBottom: spacing.md, textAlign: 'center',
  },
  subtitle: {
    fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center',
    lineHeight: 22, marginBottom: spacing.xl, paddingHorizontal: spacing.sm,
  },
  orderIdBadge: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.primaryLighter, paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm, borderRadius: borderRadius.full, marginBottom: spacing.lg,
  },
  orderIdText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primary },
  infoRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  infoText: { fontSize: fontSize.sm, color: colors.textSecondary },
  footer: { padding: spacing.xl, gap: spacing.md },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    backgroundColor: colors.primary, paddingVertical: spacing.lg,
    borderRadius: borderRadius.xl, ...shadows.primaryMd,
  },
  primaryBtnText: { color: colors.white, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  secondaryBtn: {
    alignItems: 'center', paddingVertical: spacing.md,
    borderRadius: borderRadius.xl, borderWidth: 1.5, borderColor: colors.light,
  },
  secondaryBtnText: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});

