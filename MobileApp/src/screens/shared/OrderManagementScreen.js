/**
 * OrderManagementScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import OrderCard from '../../components/common/OrderCard';
import Loader from '../../components/common/Loader';
import { EmptyOrders } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { openWhatsAppVerify } from '../../utils/whatsapp';
import SellerReturnsPanel from '../../components/SellerReturnsPanel';

const STATUS_TABS = [
  { id: 'all', label: 'All' }, { id: 'pending', label: 'Pending' },
  { id: 'confirmed', label: 'Confirmed' }, { id: 'processing', label: 'Processing' }, { id: 'shipped', label: 'Shipped' },
  { id: 'delivered', label: 'Delivered' }, { id: 'cancelled', label: 'Cancelled' },
];

export const filterOrdersByStatus = (orders, status) => {
  if (!status || status === 'all') return orders;
  return orders.filter(o => (o.orderStatus || o.status) === status);
};

export default function OrderManagementScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { isAdmin } = route.params || {};
  const [primaryView, setPrimaryView] = useState(!isAdmin && route.params?.tab === 'returns' ? 'returns' : 'orders');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('all');

  useEffect(() => { fetchOrders(); }, []);
  useEffect(() => {
    if (!isAdmin && route.params?.tab === 'returns') setPrimaryView('returns');
  }, [isAdmin, route.params?.tab]);

  const fetchOrders = async () => {
    try {
      const res = await api.get('/api/order/get');
      setOrders(res.data?.orders || res.data || []);
    } catch (e) { Alert.alert('Error', 'Failed to fetch orders'); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchOrders(); }, []);
  const handleOrderPress = useCallback((order) => { navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin }); }, [navigation, isAdmin]);

  const filteredOrders = filterOrdersByStatus(orders, activeTab);
  const statusCounts = orders.reduce((acc, o) => {
    const key = o.orderStatus || o.status || 'pending';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const renderHeader = useCallback(() => (
    <View style={styles.headerContainer}>
      <GlassPanel variant="floating" style={styles.titleRow}>
        <View style={styles.titleIcon}><Ionicons name="receipt-outline" size={24} color="white" /></View>
        <View>
          <Text style={styles.title}>{primaryView === 'returns' ? 'Return Orders' : 'Order Management'}</Text>
          <Text style={styles.subtitle}>{primaryView === 'returns' ? 'Review returns and fund approved refunds' : `${orders.length} total orders`}</Text>
        </View>
      </GlassPanel>

      {!isAdmin && (
        <View style={styles.primaryTabs}>
          <TouchableOpacity style={[styles.primaryTab, primaryView === 'orders' && styles.primaryTabActive]} onPress={() => setPrimaryView('orders')}>
            <Ionicons name="receipt-outline" size={17} color={primaryView === 'orders' ? '#fff' : palette.colors.textSecondary} />
            <Text style={[styles.primaryTabText, primaryView === 'orders' && styles.primaryTabTextActive]}>Orders</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.primaryTab, primaryView === 'returns' && styles.primaryTabActive]} onPress={() => setPrimaryView('returns')}>
            <Ionicons name="return-down-back-outline" size={17} color={primaryView === 'returns' ? '#fff' : palette.colors.textSecondary} />
            <Text style={[styles.primaryTabText, primaryView === 'returns' && styles.primaryTabTextActive]}>Return Orders</Text>
          </TouchableOpacity>
        </View>
      )}

      {primaryView === 'orders' && <FlatList horizontal data={STATUS_TABS} keyExtractor={i => i.id} showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabsContainer}
        renderItem={({ item }) => {
          const isActive = activeTab === item.id;
          const count = item.id === 'all' ? orders.length : (statusCounts[item.id] || 0);
          return (
            <TouchableOpacity style={[styles.tab, isActive && styles.tabActive]} onPress={() => setActiveTab(item.id)} activeOpacity={0.7}>
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{item.label}</Text>
              {count > 0 && (
                <View style={[styles.tabBadge, isActive && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, isActive && styles.tabBadgeTextActive]}>{count}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />}
      {primaryView === 'orders' && <Text style={styles.resultsText}>Showing <Text style={styles.resultsCount}>{filteredOrders.length}</Text> orders</Text>}
    </View>
  ), [orders.length, activeTab, statusCounts, filteredOrders.length, primaryView, isAdmin, palette.colors.textSecondary]);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading orders..." /></GlassBackground>;

  if (primaryView === 'returns' && !isAdmin) {
    return (
      <GlassBackground>
        <SellerReturnsPanel header={renderHeader()} route={route} navigation={navigation} />
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <FlatList data={filteredOrders} renderItem={({ item }) => <OrderCard order={item} onPress={() => handleOrderPress(item)} onWhatsApp={openWhatsAppVerify} showCustomer />}
        keyExtractor={i => i._id} contentContainerStyle={styles.list}
        ListHeaderComponent={renderHeader()} ListEmptyComponent={<EmptyOrders onBrowse={null} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        showsVerticalScrollIndicator={false} />
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  headerContainer: { paddingBottom: spacing.md, marginBottom: spacing.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', margin: spacing.lg, marginBottom: spacing.md, padding: spacing.lg },
  titleIcon: { width: 44, height: 44, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  title: { ...typography.h3, color: p.colors.text },
  subtitle: { ...typography.bodySmall, color: p.colors.textSecondary },
  primaryTabs: { flexDirection: 'row', marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: 4, borderRadius: 14, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  primaryTab: { flex: 1, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: 11 },
  primaryTabActive: { backgroundColor: p.colors.primary },
  primaryTabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  primaryTabTextActive: { color: '#fff' },
  tabsContainer: { paddingHorizontal: spacing.lg, gap: spacing.sm, marginBottom: spacing.md },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: 'rgba(255,255,255,0.08)', gap: spacing.xs },
  tabActive: { backgroundColor: p.colors.primary },
  tabText: { ...typography.bodySmall, fontWeight: fontWeight.medium, color: p.colors.textSecondary },
  tabTextActive: { color: 'white' },
  tabBadge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.xs },
  tabBadgeActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  tabBadgeText: { ...typography.caption, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  tabBadgeTextActive: { color: 'white' },
  resultsText: { ...typography.bodySmall, color: p.colors.textSecondary, paddingHorizontal: spacing.lg },
  resultsCount: { fontWeight: fontWeight.bold, color: p.colors.text },
  list: { paddingHorizontal: spacing.md, paddingBottom: 100, flexGrow: 1 },
});
