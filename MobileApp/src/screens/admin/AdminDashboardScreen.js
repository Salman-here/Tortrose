/**
 * AdminDashboardScreen
 * Main dashboard for administrators with statistics and quick actions
 * 
 * Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.7
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
import api, { API_BASE_URL } from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import StatCard, {
  UsersStatCard,
  StoresStatCard,
  ProductsStatCard,
  OrdersStatCard,
  RevenueStatCard,
} from '../../components/common/StatCard';
import ActionCard, {
  UserManagementAction,
  StoreVerificationAction,
  TaxConfigAction,
  AdminProductsAction,
  AdminOrdersAction,
  AdminStoresAction,
} from '../../components/common/ActionCard';
import Loader from '../../components/common/Loader';
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
 * Calculate admin dashboard statistics
 * Exported for property testing
 */
export const calculateAdminStats = (users, stores, products, orders) => {
  const totalUsers = users?.length || 0;
  const totalStores = stores?.length || 0;
  const totalProducts = products?.length || 0;
  const totalOrders = orders?.length || 0;
  const pendingVerifications = stores?.filter(s => !s.verification?.isVerified).length || 0;
  
  const revenue = orders?.reduce((sum, order) => {
    if (order.status !== 'cancelled') {
      return sum + (order.totalAmount || order.total || 0);
    }
    return sum;
  }, 0) || 0;

  return {
    totalUsers,
    totalStores,
    totalProducts,
    totalOrders,
    pendingVerifications,
    revenue,
  };
};

export default function AdminDashboardScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalStores: 0,
    totalProducts: 0,
    totalOrders: 0,
    pendingVerifications: 0,
    revenue: 0,
  });
  const [recentActivity, setRecentActivity] = useState([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch all data in parallel using the api instance (auto-injects auth token)
      // Use limit=500 to cap data transfer while keeping accurate dashboard stats
      const [usersRes, storesRes, productsRes, ordersRes] = await Promise.all([
        api.get('/api/user/get').catch(() => ({ data: [] })),
        api.get('/api/stores/all').catch(() => ({ data: { stores: [] } })),
        api.get('/api/products/get-products?limit=50&page=1').catch(() => ({ data: [] })),
        api.get('/api/order/get').catch(() => ({ data: [] })),
      ]);

      const users = usersRes.data?.users || usersRes.data || [];
      const stores = storesRes.data?.stores || [];
      const products = productsRes.data?.products || productsRes.data || [];
      // Use pagination total for accurate product count even with page limits
      const totalProductsFromPagination = productsRes.data?.pagination?.totalProducts;
      const orders = ordersRes.data?.orders || ordersRes.data || [];

      // Calculate stats (pass totalProducts override for paginated endpoint)
      const computedStats = calculateAdminStats(users, stores, products, orders);
      if (totalProductsFromPagination !== undefined) {
        computedStats.totalProducts = totalProductsFromPagination;
      }
      setStats(computedStats);

      // Get recent activity (last 5 orders)
      const sortedOrders = [...orders].sort((a, b) => 
        new Date(b.createdAt) - new Date(a.createdAt)
      );
      setRecentActivity(sortedOrders.slice(0, 5));
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
              <Ionicons name="shield-checkmark" size={28} color={colors.white} />
            </View>
            <View style={styles.headerText}>
              <Text style={styles.headerTitle}>Admin Dashboard</Text>
              <Text style={styles.headerSubtitle}>
                Welcome, {currentUser?.name?.split(' ')[0] || 'Admin'}
              </Text>
            </View>
          </View>
        </View>

        {/* Statistics */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Platform Overview</Text>
          <View style={styles.statsGrid}>
            <View style={styles.statRow}>
              <View style={styles.statWrapper}>
                <UsersStatCard
                  value={stats.totalUsers}
                  onPress={() => navigation.navigate('AdminUserManagement')}
                />
              </View>
              <View style={styles.statWrapper}>
                <StoresStatCard
                  value={stats.totalStores}
                  onPress={() => navigation.navigate('StoreVerification')}
                />
              </View>
            </View>
            <View style={styles.statRow}>
              <View style={styles.statWrapper}>
                <ProductsStatCard
                  value={stats.totalProducts}
                  onPress={() => navigation.navigate('AdminProductManagement')}
                />
              </View>
              <View style={styles.statWrapper}>
                <OrdersStatCard
                  value={stats.totalOrders}
                  onPress={() => navigation.navigate('AdminOrderManagement')}
                />
              </View>
            </View>
            <View style={styles.statRow}>
              <View style={styles.statWrapper}>
                <RevenueStatCard value={stats.revenue} />
              </View>
              <View style={styles.statWrapper}>
                <StatCard
                  title="Pending Verifications"
                  value={stats.pendingVerifications}
                  icon="hourglass-outline"
                  iconColor={colors.warning}
                  iconBgColor={colors.warningLighter}
                  onPress={() => navigation.navigate('StoreVerification')}
                />
              </View>
            </View>
          </View>
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <UserManagementAction
            onPress={() => navigation.navigate('AdminUserManagement')}
            badge={stats.totalUsers}
          />
          <StoreVerificationAction
            onPress={() => navigation.navigate('StoreVerification')}
            badge={stats.pendingVerifications}
          />
          <AdminOrdersAction
            onPress={() => navigation.navigate('AdminOrderManagement')}
            badge={stats.totalOrders}
          />
          <AdminProductsAction
            onPress={() => navigation.navigate('AdminProductManagement')}
          />
          <TaxConfigAction
            onPress={() => navigation.navigate('AdminTaxConfiguration')}
          />
        </View>

        {/* Recent Activity */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Activity</Text>
            {recentActivity.length > 0 && (
              <TouchableOpacity
                onPress={() => navigation.navigate('AdminOrderManagement')}
                activeOpacity={0.7}
              >
                <Text style={styles.viewAllText}>View All</Text>
              </TouchableOpacity>
            )}
          </View>
          
          {recentActivity.length > 0 ? (
            <View style={styles.activityList}>
              {recentActivity.map((order, index) => (
                <TouchableOpacity
                  key={order._id || index}
                  style={styles.activityItem}
                  onPress={() => navigation.navigate('OrderDetailManagement', { 
                    orderId: order._id, 
                    isAdmin: true 
                  })}
                  activeOpacity={0.7}
                >
                  <View style={[
                    styles.activityIcon,
                    { backgroundColor: getStatusColor(order.status) + '20' }
                  ]}>
                    <Ionicons
                      name="receipt-outline"
                      size={18}
                      color={getStatusColor(order.status)}
                    />
                  </View>
                  <View style={styles.activityContent}>
                    <Text style={styles.activityTitle}>
                      Order #{order._id?.slice(-6).toUpperCase()}
                    </Text>
                    <Text style={styles.activitySubtitle}>
                      {new Date(order.createdAt).toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={styles.activityRight}>
                    <Text style={styles.activityAmount}>
                      ${(order.totalAmount || order.total || 0).toFixed(2)}
                    </Text>
                    <View style={[
                      styles.statusDot,
                      { backgroundColor: getStatusColor(order.status) }
                    ]} />
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <View style={styles.emptyActivity}>
              <Ionicons name="time-outline" size={48} color={colors.grayLight} />
              <Text style={styles.emptyActivityText}>No recent activity</Text>
            </View>
          )}
        </View>

        {/* Bottom Spacing */}
        <View style={styles.bottomSpacing} />
      </ScrollView>
    </SafeAreaView>
  );
}

const getStatusColor = (status) => {
  switch (status) {
    case 'pending': return colors.warning;
    case 'processing': return colors.info;
    case 'shipped': return colors.primary;
    case 'delivered': return colors.success;
    case 'cancelled': return colors.error;
    default: return colors.gray;
  }
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Header
  header: {
    backgroundColor: colors.error,
    padding: spacing.xl,
    paddingTop: spacing.lg,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
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
  // Activity
  activityList: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    ...shadows.sm,
    overflow: 'hidden',
  },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  activityIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  activityContent: {
    flex: 1,
  },
  activityTitle: {
    ...typography.bodySemibold,
    marginBottom: 2,
  },
  activitySubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  activityRight: {
    alignItems: 'flex-end',
  },
  activityAmount: {
    ...typography.bodySemibold,
    color: colors.primary,
    marginBottom: spacing.xs,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  emptyActivity: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    ...shadows.sm,
  },
  emptyActivityText: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  // Bottom
  bottomSpacing: {
    height: spacing.xxl,
  },
});
