/**
 * OrdersScreen — Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, FlatList, StyleSheet, RefreshControl, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { useAuth } from '../contexts/AuthContext';
import { spacing, fontSize, fontWeight } from '../styles/theme';
import { CartItemSkeleton } from '../components/common/Skeleton';
import { EmptyOrders, LoginRequired, ErrorState } from '../components/common/EmptyState';
import OrderCard from '../components/common/OrderCard';
import GlassBackground from '../components/common/GlassBackground';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useTheme } from '../contexts/ThemeContext';

export const sortOrdersByDate = (orders) => {
  if (!Array.isArray(orders)) return [];
  return [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

export default function OrdersScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

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
  }, [currentUser]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchOrders(); }, [fetchOrders]);

  const heroHeader = (
    <PremiumBackHeader
      title="My Orders"
      subtitle="Purchases, delivery and order history"
      icon="receipt-outline"
      onBack={() => navigation.goBack()}
      rightIcon="bag-check-outline"
      rightLabel="Orders"
      style={styles.premiumHeader}
      rightElement={orders.length > 0 ? (
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>{orders.length}</Text>
        </View>
      ) : undefined}
    />
  );

  const content = !currentUser ? <LoginRequired onLogin={() => navigation.navigate('Login')} onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />
    : isLoading ? <View style={{ paddingTop: spacing.sm }}>{[0,1,2].map((i) => <CartItemSkeleton key={i} />)}</View>
    : error ? <ErrorState message={error} onRetry={fetchOrders} />
    : orders.length === 0 ? <EmptyOrders onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />
    : null;

  if (content) {
    return <GlassBackground><SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>{heroHeader}{content}</SafeAreaView></GlassBackground>;
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
          ListFooterComponent={<View style={styles.listFooter} />}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  premiumHeader: { marginTop: spacing.sm, marginBottom: spacing.sm },
  heroBadge: { minWidth: 36, height: 34, backgroundColor: 'rgba(99,102,241,0.15)', borderRadius: 12, paddingHorizontal: spacing.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(99,102,241,0.2)' },
  heroBadgeText: { color: p.colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  listContent: { padding: spacing.sm, flexGrow: 1 },
  firstCard: { marginTop: 0 },
  listFooter: { height: spacing.xxl },
});
