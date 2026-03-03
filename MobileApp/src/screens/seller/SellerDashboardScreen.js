/**
 * SellerDashboardScreen
 * Main dashboard for sellers with statistics and quick actions
 * 
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.7
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import StatCard, {
  ProductsStatCard,
  OrdersStatCard,
  RevenueStatCard,
  PendingOrdersStatCard,
} from '../../components/common/StatCard';
import ActionCard, {
  ProductManagementAction,
  OrderManagementAction,
  StoreSettingsAction,
  ShippingConfigAction,
  StoreAnalyticsAction,
} from '../../components/common/ActionCard';
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

/**
 * Calculate seller dashboard statistics
 * Exported for property testing
 */
export const calculateSellerStats = (products, orders) => {
  const totalProducts = products?.length || 0;
  const totalOrders = orders?.length || 0;
  const pendingOrders = orders?.filter(o => 
    o.status === 'pending' || o.status === 'processing'
  ).length || 0;
  
  const revenue = orders?.reduce((sum, order) => {
    if (order.status !== 'cancelled') {
      return sum + (order.total || 0);
    }
    return sum;
  }, 0) || 0;

  return {
    totalProducts,
    totalOrders,
    pendingOrders,
    revenue,
  };
};

export default function SellerDashboardScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState({
    totalProducts: 0,
    totalOrders: 0,
    pendingOrders: 0,
    revenue: 0,
  });

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch store info using api instance (auto-injects auth token)
      const storeRes = await api.get('/api/stores/my-store')
        .catch(() => ({ data: { store: null } }));

      setStore(storeRes.data?.store);

      // Fetch products
      const productsRes = await api.get('/api/products/get-seller-products')
        .catch(() => ({ data: [] }));

      const fetchedProducts = productsRes.data?.products || productsRes.data || [];
      setProducts(fetchedProducts);

      // Fetch orders (backend filters by seller role automatically)
      const ordersRes = await api.get('/api/order/get')
        .catch(() => ({ data: { orders: [] } }));

      const fetchedOrders = ordersRes.data?.orders || [];
      setOrders(fetchedOrders);

      // Calculate stats
      setStats(calculateSellerStats(fetchedProducts, fetchedOrders));
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, []);

  const recentOrders = orders.slice(0, 5);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading dashboard..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerContent}>
            <View style={styles.headerIcon}>
              <Ionicons name="storefront" size={28} color={colors.white} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.headerTitle}>
                {store?.name || 'Seller Dashboard'}
              </Text>
              <Text style={styles.headerSubtitle}>
                Welcome back, {currentUser?.name?.split(' ')[0] || 'Seller'}
              </Text>
            </View>
          </View>
          {store && (
            <TouchableOpacity
              style={styles.viewStoreButton}
              onPress={() => navigation.navigate('Store', { storeSlug: store.slug })}
              activeOpacity={0.8}
            >
              <Text style={styles.viewStoreText}>View Store</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.white} />
            </TouchableOpacity>
          )}
        </View>

        {/* Statistics */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statRow}>
              <View style={styles.statWrapper}>
                <ProductsStatCard
                  value={stats.totalProducts}
                  onPress={() => navigation.navigate('SellerProductManagement')}
                />
              </View>
              <View style={styles.statWrapper}>
                <OrdersStatCard
                  value={stats.totalOrders}
                  onPress={() => navigation.navigate('SellerOrderManagement')}
                />
              </View>
            </View>
            <View style={styles.statRow}>
              <View style={styles.statWrapper}>
                <RevenueStatCard
                  value={stats.revenue}
                />
              </View>
              <View style={styles.statWrapper}>
                <PendingOrdersStatCard
                  value={stats.pendingOrders}
                  onPress={() => navigation.navigate('SellerOrderManagement')}
                />
              </View>
            </View>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <ProductManagementAction
            onPress={() => navigation.navigate('SellerProductManagement')}
            badge={stats.totalProducts}
          />
          <OrderManagementAction
            onPress={() => navigation.navigate('SellerOrderManagement')}
            badge={stats.pendingOrders}
          />
          <StoreSettingsAction
            onPress={() => navigation.navigate('SellerStoreSettings')}
          />
          <ShippingConfigAction
            onPress={() => navigation.navigate('SellerShippingConfiguration')}
          />
          <StoreAnalyticsAction
            onPress={() => navigation.navigate('SellerAnalytics')}
          />
        </View>

        {/* Recent Orders */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Orders</Text>
            {orders.length > 0 && (
              <TouchableOpacity
                onPress={() => navigation.navigate('SellerOrderManagement')}
                activeOpacity={0.7}
              >
                <Text style={styles.viewAllText}>View All</Text>
              </TouchableOpacity>
            )}
          </View>
          
          {recentOrders.length > 0 ? (
            <View style={styles.ordersContainer}>
              {recentOrders.map((order) => (
                <OrderCard
                  key={order._id}
                  order={order}
                  onPress={() => navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin: false })}
                  showCustomer={true}
                />
              ))}
            </View>
          ) : (
            <View style={styles.emptyOrdersContainer}>
              <EmptyOrders onBrowse={null} />
            </View>
          )}
        </View>

        {/* Bottom Spacing */}
        <View style={styles.bottomSpacing} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Header
  header: {
    backgroundColor: colors.primary,
    padding: spacing.xl,
    paddingTop: spacing.lg,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  headerIcon: {
    width: 50,
    height: 50,
    borderRadius: borderRadius.lg,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    ...typography.h2,
    color: colors.white,
    marginBottom: 2,
  },
  headerSubtitle: {
    ...typography.body,
    color: 'rgba(255, 255, 255, 0.8)',
  },
  viewStoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
    gap: spacing.xs,
  },
  viewStoreText: {
    ...typography.bodySemibold,
    color: colors.white,
    fontSize: fontSize.sm,
  },
  // Sections
  section: {
    padding: spacing.lg,
    paddingBottom: 0,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.h3,
    marginBottom: spacing.md,
  },
  viewAllText: {
    ...typography.bodySemibold,
    color: colors.primary,
    fontSize: fontSize.sm,
  },
  // Stats Grid
  statsGrid: {
    gap: spacing.md,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  statWrapper: {
    flex: 1,
  },
  // Orders
  ordersContainer: {
    gap: spacing.sm,
  },
  emptyOrdersContainer: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    ...shadows.sm,
  },
  // Bottom
  bottomSpacing: {
    height: spacing.xxl,
  },
});
