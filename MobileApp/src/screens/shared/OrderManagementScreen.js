/**
 * OrderManagementScreen
 * Manage orders for sellers and admins
 * 
 * Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import OrderCard from '../../components/common/OrderCard';
import Loader from '../../components/common/Loader';
import { EmptyOrders } from '../../components/common/EmptyState';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
} from '../../styles/theme';

// Order status filter tabs
const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'processing', label: 'Processing' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'cancelled', label: 'Cancelled' },
];

/**
 * Filter orders by status
 * Exported for property testing
 */
export const filterOrdersByStatus = (orders, status) => {
  if (!status || status === 'all') return orders;
  return orders.filter(order => order.status === status);
};

export default function OrderManagementScreen({ navigation, route }) {
  const { isAdmin } = route.params || {};
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('all');

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    try {
      const endpoint = '/api/order/get';
      const response = await api.get(endpoint);
      const orders = response.data?.orders || response.data || [];
      setOrders(orders);
    } catch (error) {
      console.error('Error fetching orders:', error);
      Alert.alert('Error', 'Failed to fetch orders');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrders();
  }, [isAdmin]);

  const handleOrderPress = useCallback((order) => {
    navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin });
  }, [navigation, isAdmin]);

  const filteredOrders = filterOrdersByStatus(orders, activeTab);

  // Count orders by status
  const statusCounts = orders.reduce((acc, order) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {});

  const renderHeader = useCallback(() => (
    <View style={styles.headerContainer}>
      {/* Title */}
      <View style={styles.titleRow}>
        <View style={styles.titleIcon}>
          <Ionicons name="receipt-outline" size={24} color={colors.white} />
        </View>
        <View>
          <Text style={styles.title}>Order Management</Text>
          <Text style={styles.subtitle}>
            {orders.length} total orders
          </Text>
        </View>
      </View>

      {/* Filter Tabs */}
      <FlatList
        horizontal
        data={STATUS_TABS}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsContainer}
        renderItem={({ item }) => {
          const isActive = activeTab === item.id;
          const count = item.id === 'all' ? orders.length : (statusCounts[item.id] || 0);
          
          return (
            <TouchableOpacity
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => setActiveTab(item.id)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {item.label}
              </Text>
              {count > 0 && (
                <View style={[styles.tabBadge, isActive && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, isActive && styles.tabBadgeTextActive]}>
                    {count}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />

      {/* Results Count */}
      <View style={styles.resultsRow}>
        <Text style={styles.resultsText}>
          Showing <Text style={styles.resultsCount}>{filteredOrders.length}</Text> orders
        </Text>
      </View>
    </View>
  ), [orders.length, activeTab, statusCounts, filteredOrders.length]);

  const renderOrder = useCallback(({ item }) => (
    <OrderCard
      order={item}
      onPress={() => handleOrderPress(item)}
      showCustomer={true}
    />
  ), [handleOrderPress]);

  const renderEmptyComponent = useCallback(() => (
    <EmptyOrders onBrowse={null} />
  ), []);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading orders..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={filteredOrders}
        renderItem={renderOrder}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmptyComponent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Header
  headerContainer: {
    backgroundColor: colors.white,
    paddingBottom: spacing.md,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.md,
  },
  titleIcon: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  title: {
    ...typography.h3,
  },
  subtitle: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  // Tabs
  tabsContainer: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.lighter,
    gap: spacing.xs,
  },
  tabActive: {
    backgroundColor: colors.primary,
  },
  tabText: {
    ...typography.bodySmall,
    fontWeight: fontWeight.medium,
    color: colors.textSecondary,
  },
  tabTextActive: {
    color: colors.white,
  },
  tabBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.grayLight,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
  },
  tabBadgeActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  tabBadgeText: {
    ...typography.caption,
    fontWeight: fontWeight.bold,
    color: colors.white,
  },
  tabBadgeTextActive: {
    color: colors.white,
  },
  // Results
  resultsRow: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  resultsText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  resultsCount: {
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  // List
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
});
