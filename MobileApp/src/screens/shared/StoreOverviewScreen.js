/**
 * StoreOverviewScreen
 * Modern screen for viewing store details with admin capabilities
 * 
 * Requirements: 28.1, 28.2, 28.3, 28.4, 28.5
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  FlatList,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import VerifiedBadge from '../../components/VerifiedBadge';
import Loader from '../../components/common/Loader';
import EmptyState from '../../components/common/EmptyState';
import StatCard from '../../components/common/StatCard';
import { 
  colors, 
  spacing, 
  fontSize, 
  fontWeight,
  borderRadius, 
  shadows,
  typography,
  statusColors,
} from '../../styles/theme';

// Helper function to format currency - exported for testing
export const formatCurrency = (amount, currency = 'USD') => {
  if (typeof amount !== 'number' || isNaN(amount)) return '$0.00';
  return `$${amount.toFixed(2)}`;
};

// Helper function to get order status info - exported for testing
export const getOrderStatusInfo = (status) => {
  const statusMap = {
    pending: { color: colors.statusPending, bgColor: colors.warningLighter, label: 'Pending' },
    processing: { color: colors.statusProcessing, bgColor: colors.infoLighter, label: 'Processing' },
    shipped: { color: colors.statusShipped, bgColor: colors.primaryLighter, label: 'Shipped' },
    delivered: { color: colors.statusDelivered, bgColor: colors.successLighter, label: 'Delivered' },
    cancelled: { color: colors.statusCancelled, bgColor: colors.errorLighter, label: 'Cancelled' },
  };
  return statusMap[status?.toLowerCase()] || statusMap.pending;
};

export default function StoreOverviewScreen({ route, navigation }) {
  const { storeId, isAdmin } = route.params || {};
  const { currentUser } = useAuth();
  
  const [store, setStore] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState({
    totalProducts: 0,
    totalOrders: 0,
    totalRevenue: 0,
    pendingOrders: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  const fetchStoreData = useCallback(async () => {
    if (!storeId) {
      setIsLoading(false);
      return;
    }

    try {
      // Fetch store details
      const storeResponse = await api.get(`/api/stores/${storeId}`);
      const storeData = storeResponse.data.store || storeResponse.data;
      setStore(storeData);

      // Fetch store products
      try {
        const productsResponse = await api.get(`/api/products/get-products?store=${storeId}`);
        const productsData = productsResponse.data.products || productsResponse.data || [];
        setProducts(productsData);
      } catch (err) {
        console.log('Error fetching products:', err);
        setProducts([]);
      }

      // Fetch store orders (admin only)
      if (isAdmin && currentUser?.role === 'admin') {
        try {
          const ordersResponse = await api.get(`/api/order/store/${storeId}`);
          const ordersData = ordersResponse.data.orders || ordersResponse.data || [];
          setOrders(ordersData);
          
          // Calculate stats from orders
          const totalRevenue = ordersData.reduce((sum, order) => {
            if (order.status !== 'cancelled') {
              return sum + (order.totalPrice || order.orderSummary?.totalAmount || 0);
            }
            return sum;
          }, 0);
          const pendingOrders = ordersData.filter(o => o.status === 'pending').length;
          
          setStats(prev => ({
            ...prev,
            totalOrders: ordersData.length,
            totalRevenue,
            pendingOrders,
          }));
        } catch (err) {
          console.log('Error fetching orders:', err);
          setOrders([]);
        }
      }

      // Update product count in stats
      setStats(prev => ({
        ...prev,
        totalProducts: products.length || storeData.productCount || 0,
      }));

    } catch (error) {
      console.error('Error fetching store data:', error);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Failed to load store data'
      });
    } finally {
      setIsLoading(false);
    }
  }, [storeId, isAdmin, currentUser]);

  useEffect(() => {
    fetchStoreData();
  }, [fetchStoreData]);

  // Update stats when products change
  useEffect(() => {
    setStats(prev => ({
      ...prev,
      totalProducts: products.length,
    }));
  }, [products]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStoreData();
    setRefreshing(false);
  }, [fetchStoreData]);

  const handleVerifyStore = async () => {
    if (!store) return;
    
    const isVerified = store.verification?.isVerified;
    const action = isVerified ? 'unverify' : 'verify';
    
    Alert.alert(
      `${action.charAt(0).toUpperCase() + action.slice(1)} Store`,
      `Are you sure you want to ${action} "${store.storeName || store.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action.charAt(0).toUpperCase() + action.slice(1),
          style: isVerified ? 'destructive' : 'default',
          onPress: performVerification
        }
      ]
    );
  };

  const performVerification = async () => {
    setVerifying(true);
    const isVerified = store.verification?.isVerified;
    const action = isVerified ? 'unverify' : 'verify';

    try {
      await api.patch(`/api/stores/${storeId}/${action}`, {});

      setStore(prev => ({
        ...prev,
        verification: {
          ...prev.verification,
          isVerified: !isVerified,
          verifiedAt: !isVerified ? new Date().toISOString() : null,
          verifiedBy: !isVerified ? currentUser._id : null
        }
      }));

      Toast.show({
        type: 'success',
        text1: 'Success',
        text2: `Store has been ${action === 'verify' ? 'verified' : 'unverified'}`
      });
    } catch (error) {
      console.error(`Error ${action}ing store:`, error);
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error.response?.data?.message || `Failed to ${action} store`
      });
    } finally {
      setVerifying(false);
    }
  };

  const navigateToProducts = () => {
    navigation.navigate('ProductManagement', { storeId, isAdmin: true });
  };

  const navigateToOrders = () => {
    navigation.navigate('OrderManagement', { storeId, isAdmin: true });
  };

  const renderProductItem = ({ item }) => (
    <TouchableOpacity 
      style={styles.productCard}
      onPress={() => navigation.navigate('ProductDetail', { productId: item._id })}
    >
      {item.image || item.images?.[0]?.url ? (
        <Image
          source={{ uri: item.image || item.images[0].url }}
          style={styles.productImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
        />
      ) : (
        <View style={styles.productImagePlaceholder}>
          <Ionicons name="cube-outline" size={24} color={colors.grayLight} />
        </View>
      )}
      <View style={styles.productInfo}>
        <Text style={styles.productName} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.productPrice}>{formatCurrency(item.price)}</Text>
        <View style={styles.productMeta}>
          <Text style={styles.productStock}>
            Stock: {item.stock || 0}
          </Text>
          {item.stock === 0 && (
            <View style={styles.outOfStockBadge}>
              <Text style={styles.outOfStockText}>Out of Stock</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderOrderItem = ({ item }) => {
    const statusInfo = getOrderStatusInfo(item.status);
    return (
      <TouchableOpacity 
        style={styles.orderCard}
        onPress={() => navigation.navigate('OrderDetailManagement', { orderId: item._id })}
      >
        <View style={styles.orderHeader}>
          <Text style={styles.orderId}>#{item._id?.slice(-8).toUpperCase()}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusInfo.bgColor }]}>
            <Text style={[styles.statusText, { color: statusInfo.color }]}>
              {statusInfo.label}
            </Text>
          </View>
        </View>
        <View style={styles.orderDetails}>
          <View style={styles.orderDetailRow}>
            <Ionicons name="person-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.orderDetailText}>
              {item.user?.name || item.shippingInfo?.fullName || 'Customer'}
            </Text>
          </View>
          <View style={styles.orderDetailRow}>
            <Ionicons name="calendar-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.orderDetailText}>
              {new Date(item.createdAt).toLocaleDateString()}
            </Text>
          </View>
        </View>
        <View style={styles.orderFooter}>
          <Text style={styles.orderItems}>
            {item.orderItems?.length || 0} item(s)
          </Text>
          <Text style={styles.orderTotal}>
            {formatCurrency(item.totalPrice || item.orderSummary?.totalAmount)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Loader size="large" />
      </View>
    );
  }

  if (!store) {
    return (
      <View style={styles.container}>
        <EmptyState
          icon="storefront-outline"
          title="Store Not Found"
          subtitle="The store you're looking for doesn't exist or has been removed."
          actionLabel="Go Back"
          onAction={() => navigation.goBack()}
        />
      </View>
    );
  }

  const isVerified = store.verification?.isVerified;

  return (
    <View style={styles.container}>
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
        {/* Store Header */}
        <View style={styles.header}>
          {store.banner ? (
            <Image source={{ uri: store.banner }} style={styles.banner} contentFit="cover" cachePolicy="memory-disk" transition={200} />
          ) : (
            <View style={styles.bannerPlaceholder}>
              <Ionicons name="image-outline" size={48} color={colors.grayLight} />
            </View>
          )}
          
          <View style={styles.storeInfoContainer}>
            <View style={styles.logoContainer}>
              {store.logo ? (
                <Image source={{ uri: store.logo }} style={styles.logo} contentFit="cover" cachePolicy="memory-disk" transition={150} />
              ) : (
                <View style={styles.logoPlaceholder}>
                  <Ionicons name="storefront" size={32} color={colors.primary} />
                </View>
              )}
            </View>
            
            <View style={styles.storeDetails}>
              <View style={styles.storeNameRow}>
                <Text style={styles.storeName}>{store.storeName || store.name}</Text>
                {isVerified && <VerifiedBadge size="md" />}
              </View>
              {store.description && (
                <Text style={styles.storeDescription} numberOfLines={2}>
                  {store.description}
                </Text>
              )}
              <View style={styles.trustRow}>
                <Ionicons name="people" size={16} color={colors.primary} />
                <Text style={styles.trustCount}>{store.trustCount || 0} trusters</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Owner Info (Admin only) */}
        {isAdmin && store.owner && (
          <View style={styles.ownerCard}>
            <View style={styles.sectionHeader}>
              <Ionicons name="person-circle-outline" size={20} color={colors.primary} />
              <Text style={styles.sectionTitle}>Store Owner</Text>
            </View>
            <View style={styles.ownerInfo}>
              <View style={styles.ownerAvatar}>
                <Ionicons name="person" size={24} color={colors.white} />
              </View>
              <View style={styles.ownerDetails}>
                <Text style={styles.ownerName}>{store.owner.name || 'Unknown'}</Text>
                <Text style={styles.ownerEmail}>{store.owner.email || 'No email'}</Text>
              </View>
            </View>
          </View>
        )}

        {/* Statistics (Admin only) */}
        {isAdmin && (
          <View style={styles.statsSection}>
            <View style={styles.sectionHeader}>
              <Ionicons name="stats-chart-outline" size={20} color={colors.primary} />
              <Text style={styles.sectionTitle}>Store Statistics</Text>
            </View>
            <View style={styles.statsGrid}>
              <StatCard
                title="Products"
                value={stats.totalProducts}
                icon="cube-outline"
                iconColor={colors.primary}
                iconBgColor={colors.primaryLighter}
              />
              <StatCard
                title="Orders"
                value={stats.totalOrders}
                icon="receipt-outline"
                iconColor={colors.info}
                iconBgColor={colors.infoLighter}
              />
              <StatCard
                title="Revenue"
                value={formatCurrency(stats.totalRevenue)}
                icon="cash-outline"
                iconColor={colors.success}
                iconBgColor={colors.successLighter}
              />
              <StatCard
                title="Pending"
                value={stats.pendingOrders}
                icon="time-outline"
                iconColor={colors.warning}
                iconBgColor={colors.warningLighter}
              />
            </View>
          </View>
        )}

        {/* Quick Actions (Admin only) */}
        {isAdmin && (
          <View style={styles.actionsSection}>
            <View style={styles.sectionHeader}>
              <Ionicons name="flash-outline" size={20} color={colors.primary} />
              <Text style={styles.sectionTitle}>Quick Actions</Text>
            </View>
            <View style={styles.actionsGrid}>
              <TouchableOpacity
                style={[
                  styles.actionButton,
                  isVerified ? styles.unverifyAction : styles.verifyAction,
                  verifying && styles.disabledAction
                ]}
                onPress={handleVerifyStore}
                disabled={verifying}
              >
                {verifying ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <>
                    <Ionicons 
                      name={isVerified ? 'close-circle' : 'checkmark-circle'} 
                      size={20} 
                      color={colors.white} 
                    />
                    <Text style={styles.actionButtonText}>
                      {isVerified ? 'Unverify' : 'Verify'}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.actionButton, styles.productsAction]}
                onPress={navigateToProducts}
              >
                <Ionicons name="cube" size={20} color={colors.white} />
                <Text style={styles.actionButtonText}>View Products</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.actionButton, styles.ordersAction]}
                onPress={navigateToOrders}
              >
                <Ionicons name="receipt" size={20} color={colors.white} />
                <Text style={styles.actionButtonText}>View Orders</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Tabs */}
        <View style={styles.tabsContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'overview' && styles.activeTab]}
            onPress={() => setActiveTab('overview')}
          >
            <Text style={[styles.tabText, activeTab === 'overview' && styles.activeTabText]}>
              Products ({products.length})
            </Text>
          </TouchableOpacity>
          {isAdmin && (
            <TouchableOpacity
              style={[styles.tab, activeTab === 'orders' && styles.activeTab]}
              onPress={() => setActiveTab('orders')}
            >
              <Text style={[styles.tabText, activeTab === 'orders' && styles.activeTabText]}>
                Orders ({orders.length})
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Content based on active tab */}
        <View style={styles.contentSection}>
          {activeTab === 'overview' ? (
            products.length > 0 ? (
              <FlatList
                data={products.slice(0, 10)}
                renderItem={renderProductItem}
                keyExtractor={(item) => item._id}
                scrollEnabled={false}
                ListFooterComponent={
                  products.length > 10 ? (
                    <TouchableOpacity 
                      style={styles.viewAllButton}
                      onPress={navigateToProducts}
                    >
                      <Text style={styles.viewAllText}>
                        View All {products.length} Products
                      </Text>
                      <Ionicons name="arrow-forward" size={16} color={colors.primary} />
                    </TouchableOpacity>
                  ) : null
                }
              />
            ) : (
              <EmptyState
                icon="cube-outline"
                title="No Products"
                subtitle="This store hasn't added any products yet."
              />
            )
          ) : (
            orders.length > 0 ? (
              <FlatList
                data={orders.slice(0, 10)}
                renderItem={renderOrderItem}
                keyExtractor={(item) => item._id}
                scrollEnabled={false}
                ListFooterComponent={
                  orders.length > 10 ? (
                    <TouchableOpacity 
                      style={styles.viewAllButton}
                      onPress={navigateToOrders}
                    >
                      <Text style={styles.viewAllText}>
                        View All {orders.length} Orders
                      </Text>
                      <Ionicons name="arrow-forward" size={16} color={colors.primary} />
                    </TouchableOpacity>
                  ) : null
                }
              />
            ) : (
              <EmptyState
                icon="receipt-outline"
                title="No Orders"
                subtitle="This store hasn't received any orders yet."
              />
            )
          )}
        </View>

        {/* Verification Info */}
        {isVerified && store.verification?.verifiedAt && (
          <View style={styles.verificationInfo}>
            <Ionicons name="shield-checkmark" size={16} color={colors.success} />
            <Text style={styles.verificationText}>
              Verified on {new Date(store.verification.verifiedAt).toLocaleDateString()}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
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
    backgroundColor: colors.background,
  },

  // Header
  header: {
    backgroundColor: colors.white,
    marginBottom: spacing.md,
  },
  banner: {
    width: '100%',
    height: 150,
    resizeMode: 'cover',
  },
  bannerPlaceholder: {
    width: '100%',
    height: 150,
    backgroundColor: colors.lighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  storeInfoContainer: {
    flexDirection: 'row',
    padding: spacing.lg,
    marginTop: -40,
  },
  logoContainer: {
    marginRight: spacing.md,
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.xl,
    borderWidth: 3,
    borderColor: colors.white,
  },
  logoPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primaryLighter,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: colors.white,
  },
  storeDetails: {
    flex: 1,
    paddingTop: spacing.xxxl,
  },
  storeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  storeName: {
    ...typography.h2,
    color: colors.text,
    flex: 1,
  },
  storeDescription: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  trustCount: {
    ...typography.bodySmall,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },

  // Owner Card
  ownerCard: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    borderRadius: borderRadius.xl,
    ...shadows.md,
  },
  ownerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ownerAvatar: {
    width: 48,
    height: 48,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  ownerDetails: {
    flex: 1,
  },
  ownerName: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  ownerEmail: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },

  // Section Header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.h4,
    color: colors.text,
  },

  // Stats Section
  statsSection: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },

  // Actions Section
  actionsSection: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  actionsGrid: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.lg,
    gap: spacing.xs,
    ...shadows.sm,
  },
  verifyAction: {
    backgroundColor: colors.success,
  },
  unverifyAction: {
    backgroundColor: colors.error,
  },
  productsAction: {
    backgroundColor: colors.primary,
  },
  ordersAction: {
    backgroundColor: colors.info,
  },
  disabledAction: {
    opacity: 0.6,
  },
  actionButtonText: {
    ...typography.bodySmall,
    color: colors.white,
    fontWeight: fontWeight.semibold,
  },

  // Tabs
  tabsContainer: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: colors.primary,
  },
  tabText: {
    ...typography.body,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  activeTabText: {
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },

  // Content Section
  contentSection: {
    padding: spacing.lg,
    minHeight: 200,
  },

  // Product Card
  productCard: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.light,
  },
  productImage: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    marginRight: spacing.md,
  },
  productImagePlaceholder: {
    width: 60,
    height: 60,
    borderRadius: borderRadius.md,
    backgroundColor: colors.lighter,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  productInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  productName: {
    ...typography.bodySemibold,
    color: colors.text,
    marginBottom: spacing.xs,
  },
  productPrice: {
    ...typography.body,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.xs,
  },
  productMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  productStock: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  outOfStockBadge: {
    backgroundColor: colors.errorLighter,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  outOfStockText: {
    ...typography.caption,
    color: colors.error,
    fontWeight: fontWeight.semibold,
  },

  // Order Card
  orderCard: {
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.light,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  orderId: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  statusBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
  },
  statusText: {
    ...typography.caption,
    fontWeight: fontWeight.semibold,
  },
  orderDetails: {
    marginBottom: spacing.sm,
  },
  orderDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  orderDetailText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  orderFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.light,
  },
  orderItems: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  orderTotal: {
    ...typography.bodySemibold,
    color: colors.primary,
  },

  // View All Button
  viewAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  viewAllText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },

  // Verification Info
  verificationInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.lg,
    backgroundColor: colors.successSubtle,
    marginTop: spacing.md,
  },
  verificationText: {
    ...typography.bodySmall,
    color: colors.success,
    fontWeight: fontWeight.medium,
  },
});
