/**
 * OrdersScreen
 * Displays user's order history with modern design
 * 
 * Requirements: 10.1, 10.2, 10.4, 10.5, 10.6
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  SafeAreaView,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';
import { useAuth } from '../contexts/AuthContext';
import {
  colors,
  spacing,
  fontSize,
  fontWeight,
  borderRadius,
  shadows,
  typography,
} from '../styles/theme';
import Loader from '../components/common/Loader';
import { EmptyOrders, LoginRequired, ErrorState } from '../components/common/EmptyState';
import OrderCard from '../components/common/OrderCard';

/**
 * Sort orders by date (newest first)
 * Property 10: Order List Sorting
 * Validates: Requirements 10.1
 */
export const sortOrdersByDate = (orders) => {
  if (!Array.isArray(orders)) return [];
  return [...orders].sort((a, b) => {
    const dateA = new Date(a.createdAt);
    const dateB = new Date(b.createdAt);
    return dateB - dateA; // Descending order (newest first)
  });
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
      if (!currentUser) {
        setIsLoading(false);
        return;
      }

      const res = await api.get('/api/order/user-orders');
      
      // Sort orders by date (newest first) - Property 10
      const sortedOrders = sortOrdersByDate(res.data.orders || []);
      setOrders(sortedOrders);
    } catch (err) {
      console.error('Error fetching orders:', err);
      setError(err.response?.data?.message || 'Failed to load orders');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrders();
  }, [fetchOrders]);

  const handleOrderPress = useCallback((order) => {
    navigation.navigate('OrderDetail', { orderId: order._id });
  }, [navigation]);

  const handleStartShopping = useCallback(() => {
    navigation.navigate('MainTabs', { screen: 'Home' });
  }, [navigation]);

  const handleLogin = useCallback(() => {
    navigation.navigate('Login');
  }, [navigation]);

  const renderOrderItem = useCallback(({ item, index }) => {
    // Transform order data for OrderCard component
    const orderData = {
      ...item,
      status: item.orderStatus || item.status || 'pending',
    };

    return (
      <OrderCard
        order={orderData}
        onPress={() => handleOrderPress(item)}
        showItems={true}
        style={index === 0 ? styles.firstCard : undefined}
      />
    );
  }, [handleOrderPress]);

  const keyExtractor = useCallback((item) => item._id, []);

  const heroHeader = (
    <View style={styles.heroHeader}>
      <TouchableOpacity style={styles.heroBackBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
        <Ionicons name="arrow-back" size={22} color={colors.white} />
      </TouchableOpacity>
      <Text style={styles.heroTitle}>My Orders</Text>
      {orders.length > 0 && (
        <View style={styles.heroBadge}>
          <Text style={styles.heroBadgeText}>{orders.length} {orders.length === 1 ? 'order' : 'orders'}</Text>
        </View>
      )}
    </View>
  );

  // Show login prompt for guests
  if (!currentUser) {
    return (
      <SafeAreaView style={styles.container}>
        {heroHeader}
        <LoginRequired onLogin={handleLogin} onBrowse={handleStartShopping} />
      </SafeAreaView>
    );
  }

  // Show loading state
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        {heroHeader}
        <View style={styles.loadingContainer}>
          <Loader size="large" />
        </View>
      </SafeAreaView>
    );
  }

  // Show error state
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        {heroHeader}
        <ErrorState message={error} onRetry={fetchOrders} />
      </SafeAreaView>
    );
  }

  // Show empty state
  if (orders.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        {heroHeader}
        <EmptyOrders onBrowse={handleStartShopping} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={orders}
        keyExtractor={keyExtractor}
        renderItem={renderOrderItem}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={heroHeader}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListFooterComponent={<View style={styles.listFooter} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroHeader: {
    backgroundColor: colors.primaryDark,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.md,
  },
  heroBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  heroTitle: {
    flex: 1,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  heroBadge: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  heroBadgeText: {
    color: colors.white,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  listContent: {
    padding: spacing.md,
    flexGrow: 1,
  },
  firstCard: {
    marginTop: 0,
  },
  listFooter: {
    height: spacing.xxl,
  },
});
