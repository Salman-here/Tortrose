/**
 * UserDashboardScreen — Liquid Glass
 * Account overview with quick links
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import Loader from '../components/common/Loader';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import {
  colors, spacing, fontSize, fontWeight, borderRadius, typography, glass,
} from '../styles/theme';

export default function UserDashboardScreen({ navigation }) {
  const { currentUser } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState([]);

  const fetchData = async () => {
    try {
      const res = await api.get('/api/order/my-orders');
      setOrders(res.data?.orders || res.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { fetchData(); }, []);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, []);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading..." /></GlassBackground>;

  const pendingOrders = orders.filter(o => o.status === 'pending' || o.orderStatus === 'pending').length;
  const deliveredOrders = orders.filter(o => o.status === 'delivered' || o.orderStatus === 'delivered').length;

  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };

  const menuItems = [
    { label: 'My Orders', desc: `${orders.length} orders`, icon: 'receipt-outline', screen: 'Orders', color: colors.primary },
    { label: 'Edit Profile', desc: 'Update your info', icon: 'person-outline', screen: 'EditProfile', color: '#8b5cf6' },
    { label: 'Wishlist', desc: 'Saved items', icon: 'heart-outline', screen: 'MainTabs', params: { screen: 'Wishlist' }, color: colors.error },
    { label: 'Settings', desc: 'Preferences', icon: 'settings-outline', screen: 'Settings', color: colors.textSecondary },
  ];

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        <GlassPanel variant="strong" style={styles.welcomeCard}>
          <View style={styles.avatarContainer}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{currentUser?.username?.[0]?.toUpperCase() || 'U'}</Text>
            </View>
          </View>
          <Text style={styles.welcomeTitle}>{greeting()}, {currentUser?.username || 'User'}</Text>
          <Text style={styles.welcomeSubtitle}>Welcome to your account dashboard</Text>
        </GlassPanel>

        {/* Quick Stats */}
        <View style={styles.statsRow}>
          <GlassPanel variant="card" style={styles.miniStat}>
            <Text style={[styles.miniStatValue, { color: colors.primary }]}>{orders.length}</Text>
            <Text style={styles.miniStatLabel}>Total Orders</Text>
          </GlassPanel>
          <GlassPanel variant="card" style={styles.miniStat}>
            <Text style={[styles.miniStatValue, { color: colors.warning }]}>{pendingOrders}</Text>
            <Text style={styles.miniStatLabel}>Pending</Text>
          </GlassPanel>
          <GlassPanel variant="card" style={styles.miniStat}>
            <Text style={[styles.miniStatValue, { color: colors.success }]}>{deliveredOrders}</Text>
            <Text style={styles.miniStatLabel}>Delivered</Text>
          </GlassPanel>
        </View>

        {/* Menu */}
        <GlassPanel variant="card" style={styles.menuSection}>
          <Text style={styles.sectionTitle}>Quick Links</Text>
          {menuItems.map((item, i) => (
            <TouchableOpacity key={i} style={styles.menuRow}
              onPress={() => navigation.navigate(item.screen, item.params)} activeOpacity={0.7}>
              <View style={[styles.menuIcon, { backgroundColor: item.color + '20' }]}>
                <Ionicons name={item.icon} size={18} color={item.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.menuLabel}>{item.label}</Text>
                <Text style={styles.menuDesc}>{item.desc}</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          ))}
        </GlassPanel>

        {/* Recent Orders */}
        {orders.length > 0 && (
          <GlassPanel variant="card" style={styles.menuSection}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>Recent Orders</Text>
              <TouchableOpacity onPress={() => navigation.navigate('Orders')}>
                <Text style={styles.viewAllText}>View all</Text>
              </TouchableOpacity>
            </View>
            {[...orders].reverse().slice(0, 3).map((order, i) => {
              const status = order.orderStatus || order.status || 'pending';
              const statusColor = status === 'delivered' ? colors.success : status === 'pending' ? colors.warning : colors.info;
              return (
                <TouchableOpacity key={order._id || i} style={styles.orderRow}
                  onPress={() => navigation.navigate('OrderDetail', { orderId: order._id })}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.orderId}>#{(order._id || '').slice(-8).toUpperCase()}</Text>
                    <Text style={styles.orderDate}>{new Date(order.createdAt).toLocaleDateString()}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
                    <Text style={[styles.statusText, { color: statusColor }]}>{status}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </GlassPanel>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  welcomeCard: { margin: spacing.lg, padding: spacing.xl, alignItems: 'center' },
  avatarContainer: { marginBottom: spacing.md },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: 'white' },
  welcomeTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  welcomeSubtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2 },
  statsRow: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg },
  miniStat: { flex: 1, alignItems: 'center', padding: spacing.md },
  miniStatValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, letterSpacing: -0.5 },
  miniStatLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  menuSection: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  sectionTitle: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.md },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  viewAllText: { ...typography.caption, color: colors.primary, fontWeight: fontWeight.semibold },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  menuIcon: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  menuLabel: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  menuDesc: { ...typography.caption, color: colors.textSecondary },
  orderRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  orderId: { ...typography.bodySemibold, color: colors.text, fontSize: fontSize.sm },
  orderDate: { ...typography.caption, color: colors.textSecondary },
  statusBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.full },
  statusText: { fontSize: 10, fontWeight: fontWeight.semibold, textTransform: 'capitalize' },
});
