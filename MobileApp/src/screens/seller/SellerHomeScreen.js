/**
 * SellerHomeScreen — Liquid Glass
 * Dashboard landing with stats, alerts, quick actions, recent orders
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import StatCard from '../../components/common/StatCard';
import Loader from '../../components/common/Loader';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../../styles/theme';
import { useAuth } from '../../contexts/AuthContext';

export default function SellerHomeScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);

  const fetchData = async () => {
    try {
      const [prodRes, orderRes] = await Promise.allSettled([
        api.get('/api/products/get-seller-products'),
        api.get('/api/order/get'),
      ]);
      if (prodRes.status === 'fulfilled') setProducts(prodRes.value.data || []);
      if (orderRes.status === 'fulfilled') setOrders(orderRes.value.data?.orders || orderRes.value.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { fetchData(); }, []);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, []);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading dashboard..." /></GlassBackground>;

  const totalProducts = products.length;
  const totalOrders = orders.length;
  const pendingOrders = orders.filter(o => o.orderStatus === 'pending' || o.status === 'pending').length;
  const deliveredOrders = orders.filter(o => o.orderStatus === 'delivered' || o.status === 'delivered').length;
  const outOfStock = products.filter(p => p.stock === 0).length;
  const lowStock = products.filter(p => p.stock > 0 && p.stock <= 10).length;
  const totalRevenue = orders.reduce((sum, o) => o.isPaid ? sum + (o.orderSummary?.totalAmount || o.totalAmount || 0) : sum, 0);
  const conversion = totalOrders > 0 ? `${((deliveredOrders / totalOrders) * 100).toFixed(0)}%` : '0%';

  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };

  const quickActions = [
    { label: 'Products', desc: `${totalProducts} products`, icon: 'cube-outline', screen: 'SellerProductManagement', color: colors.primary },
    { label: 'Orders', desc: `${pendingOrders} pending`, icon: 'cart-outline', screen: 'SellerOrderManagement', color: '#f97316' },
    { label: 'Analytics', desc: 'Stats & trends', icon: 'bar-chart-outline', screen: 'SellerAnalytics', color: colors.success },
    { label: 'Settings', desc: 'Store config', icon: 'settings-outline', screen: 'SellerStoreSettings', color: '#8b5cf6' },
  ];

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        {/* Welcome */}
        <GlassPanel variant="strong" style={styles.welcomeCard}>
          <View style={styles.welcomeRow}>
            <View style={{ flex: 1 }}>
              <View style={styles.tagPill}><Ionicons name="sparkles" size={12} color={colors.primary} /><Text style={styles.tagText}>Seller Hub</Text></View>
              <Text style={styles.welcomeTitle}>{greeting()}, {currentUser?.username || 'Seller'}</Text>
              <Text style={styles.welcomeSubtitle}>Here's what's happening with your store</Text>
            </View>
            <TouchableOpacity style={styles.addBtn} onPress={() => navigation.navigate('ProductForm', { isAdmin: false })}>
              <Ionicons name="flash" size={16} color="white" /><Text style={styles.addBtnText}>Add Product</Text>
            </TouchableOpacity>
          </View>
        </GlassPanel>

        {/* Stats */}
        <View style={styles.statsGrid}>
          <StatCard title="Revenue" value={`$${totalRevenue.toFixed(0)}`} icon="cash-outline" iconColor={colors.success} iconBgColor="rgba(16,185,129,0.12)" />
          <StatCard title="Orders" value={totalOrders} icon="cart-outline" iconColor={colors.info} iconBgColor="rgba(99,102,241,0.12)" />
          <StatCard title="Products" value={totalProducts} icon="cube-outline" iconColor={colors.primary} iconBgColor="rgba(14,165,233,0.12)" />
          <StatCard title="Conversion" value={conversion} icon="trending-up-outline" iconColor="#8b5cf6" iconBgColor="rgba(139,92,246,0.12)" />
        </View>

        {/* Alerts */}
        {(outOfStock > 0 || lowStock > 0) && (
          <View style={styles.alertsRow}>
            {outOfStock > 0 && (
              <GlassPanel variant="card" style={[styles.alertCard, { borderLeftColor: colors.error }]}>
                <Ionicons name="alert-circle" size={18} color={colors.error} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.alertTitle}>{outOfStock} out of stock</Text>
                  <Text style={styles.alertDesc}>Update inventory</Text>
                </View>
              </GlassPanel>
            )}
            {lowStock > 0 && (
              <GlassPanel variant="card" style={[styles.alertCard, { borderLeftColor: colors.warning }]}>
                <Ionicons name="warning" size={18} color={colors.warning} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.alertTitle}>{lowStock} running low</Text>
                  <Text style={styles.alertDesc}>Below 10 units</Text>
                </View>
              </GlassPanel>
            )}
          </View>
        )}

        {/* Quick Actions */}
        <GlassPanel variant="card" style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          {quickActions.map((action, i) => (
            <TouchableOpacity key={i} style={styles.actionRow} onPress={() => navigation.navigate(action.screen)} activeOpacity={0.7}>
              <View style={[styles.actionIcon, { backgroundColor: action.color + '20' }]}>
                <Ionicons name={action.icon} size={18} color={action.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.actionLabel}>{action.label}</Text>
                <Text style={styles.actionDesc}>{action.desc}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </GlassPanel>

        {/* Recent Orders */}
        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Recent Orders</Text>
            <TouchableOpacity onPress={() => navigation.navigate('SellerOrderManagement')}>
              <Text style={styles.viewAllText}>View all</Text>
            </TouchableOpacity>
          </View>
          {orders.length === 0 ? (
            <View style={styles.emptyOrders}><Ionicons name="cart-outline" size={32} color={colors.textSecondary} /><Text style={styles.emptyText}>No orders yet</Text></View>
          ) : (
            [...orders].reverse().slice(0, 5).map((order, i) => {
              const status = order.orderStatus || order.status || 'pending';
              const statusColor = status === 'delivered' ? colors.success : status === 'pending' ? colors.warning : colors.info;
              return (
                <TouchableOpacity key={order._id || i} style={styles.orderRow}
                  onPress={() => navigation.navigate('OrderDetailManagement', { orderId: order._id })}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.orderId}>{order.orderId || `#${(order._id || '').slice(-8).toUpperCase()}`}</Text>
                    <Text style={styles.orderCustomer}>{order.shippingInfo?.fullName || order.shippingAddress?.fullName || 'Customer'}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.orderTotal}>${(order.orderSummary?.totalAmount || order.totalAmount || 0).toFixed(2)}</Text>
                    <View style={[styles.orderStatusBadge, { backgroundColor: statusColor + '20' }]}>
                      <Text style={[styles.orderStatusText, { color: statusColor }]}>{status}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </GlassPanel>

        {/* Order Summary */}
        <View style={styles.orderSummaryGrid}>
          {[
            { label: 'Pending', count: pendingOrders, color: '#f97316' },
            { label: 'Delivered', count: deliveredOrders, color: colors.success },
            { label: 'Low Stock', count: lowStock + outOfStock, color: colors.error },
          ].map((item, i) => (
            <GlassPanel key={i} variant="inner" style={styles.summaryCard}>
              <Text style={[styles.summaryCount, { color: item.color }]}>{item.count}</Text>
              <Text style={styles.summaryLabel}>{item.label}</Text>
            </GlassPanel>
          ))}
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  welcomeCard: { margin: spacing.lg, padding: spacing.lg },
  welcomeRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  tagPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(99,102,241,0.12)', alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: borderRadius.full, marginBottom: spacing.sm },
  tagText: { ...typography.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  welcomeTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: -0.5 },
  welcomeSubtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.xl },
  addBtnText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.semibold },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, paddingHorizontal: spacing.lg },
  alertsRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  alertCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderLeftWidth: 3 },
  alertTitle: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  alertDesc: { ...typography.caption, color: colors.textSecondary },
  section: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  sectionTitle: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.md },
  viewAllText: { ...typography.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  actionIcon: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  actionLabel: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  actionDesc: { ...typography.caption, color: colors.textSecondary },
  emptyOrders: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyText: { ...typography.bodySmall, color: colors.textSecondary, marginTop: spacing.sm },
  orderRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  orderId: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  orderCustomer: { ...typography.caption, color: colors.textSecondary },
  orderTotal: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  orderStatusBadge: { paddingHorizontal: spacing.sm, paddingVertical: 1, borderRadius: borderRadius.full, marginTop: 2 },
  orderStatusText: { fontSize: 9, fontWeight: fontWeight.semibold, textTransform: 'capitalize' },
  orderSummaryGrid: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, marginTop: spacing.lg },
  summaryCard: { flex: 1, alignItems: 'center', padding: spacing.md },
  summaryCount: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, letterSpacing: -0.5 },
  summaryLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 2, fontWeight: fontWeight.medium },
});
