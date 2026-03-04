/**
 * OrdersScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, SafeAreaView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { useAuth } from '../contexts/AuthContext';
import { colors, spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import Loader from '../components/common/Loader';
import { EmptyOrders, LoginRequired, ErrorState } from '../components/common/EmptyState';
import OrderCard from '../components/common/OrderCard';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';

export const sortOrdersByDate = (orders) => {
  if (!Array.isArray(orders)) return [];
  return [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

export default function OrdersScreen({ navigation }) {
  const { formatPrice } = useCurrency();
  const { currentUser } = useAuth();
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const fetchOrders = useCallback(async () => {
    try {
      setError(null);
      if (!currentUser) { setIsLoading(false); return; }
      const res = await api.get('/api/order/user-orders');
      setOrders(sortOrdersByDate(res.data.orders || []));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load orders');
    } finally { setIsLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchOrders(); }, [fetchOrders]);

  const heroHeader = (
    <GlassPanel variant="floating" style={styles.heroHeader}>
      <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
        <Ionicons name="arrow-back" size={22} color={colors.text} />
      </TouchableOpacity>
      <Text style={styles.heroTitle}>My Orders</Text>
      {orders.length > 0 && (
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>{orders.length} {orders.length === 1 ? 'order' : 'orders'}</Text>
        </View>
      )}
    </GlassPanel>
  );

  const content = !currentUser ? <LoginRequired onLogin={() => navigation.navigate('Login')} onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />
    : isLoading ? <View style={styles.loadingContainer}><Loader size="large" /></View>
    : error ? <ErrorState message={error} onRetry={fetchOrders} />
    : orders.length === 0 ? <EmptyOrders onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />
    : null;

  if (content) {
    return <GlassBackground><SafeAreaView style={styles.container}>{heroHeader}{content}</SafeAreaView></GlassBackground>;
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <FlatList
          data={orders}
          keyExtractor={(item) => item._id}
          renderItem={({ item, index }) => (
            <OrderCard
              order={{ ...item, status: item.orderStatus || item.status || 'pending' }}
              onPress={() => navigation.navigate('OrderDetail', { orderId: item._id })}
              showItems={true}
              style={index === 0 ? styles.firstCard : undefined}
            />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={heroHeader}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}
          ListFooterComponent={<View style={styles.listFooter} />}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  heroHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm, gap: spacing.md },
  heroBackBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  heroTitle: { flex: 1, fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text },
  heroBadge: { backgroundColor: 'rgba(99,102,241,0.15)', borderRadius: borderRadius.full, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  heroBadgeText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  listContent: { padding: spacing.md, flexGrow: 1 },
  firstCard: { marginTop: 0 },
  listFooter: { height: spacing.xxl },
});
