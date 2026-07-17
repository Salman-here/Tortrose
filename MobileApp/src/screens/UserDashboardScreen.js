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
import { useCurrency } from '../contexts/CurrencyContext';
import Loader from '../components/common/Loader';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius, typography } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function UserDashboardScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const { convertAmount, formatAmount, currency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState([]);

  const fetchData = async () => {
    try {
      const res = await api.get('/api/order/user-orders');
      setOrders(res.data?.orders || res.data || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { fetchData(); }, []);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, []);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading..." /></GlassBackground>;

  const pendingOrders = orders.filter(o => o.status === 'pending' || o.orderStatus === 'pending').length;
  const deliveredOrders = orders.filter(o => o.status === 'delivered' || o.orderStatus === 'delivered').length;
  const totalSpent = orders.reduce((acc, o) => {
    if (o.isPaid) {
      const total = o.orderSummary?.totalAmount ?? 0;
      return acc + convertAmount(total, o.currency || 'USD', currency);
    }
    return acc;
  }, 0);

  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  };

  const menuItems = [
    { label: 'My Orders', desc: `${orders.length} orders`, icon: 'receipt-outline', screen: 'Orders', color: palette.colors.primary },
    { label: 'Rozare Wallet', desc: 'Balance, refunds & top-ups', icon: 'wallet-outline', screen: 'Wallet', color: palette.colors.success },
    { label: 'AI Shopping Assistant', desc: 'Chat to shop, track & more', icon: 'sparkles-outline', screen: 'AIChat', color: '#6366f1' },
    { label: 'WhatsApp AI', desc: 'Link buyer WhatsApp', icon: 'logo-whatsapp', screen: 'UserWhatsAppSettings', color: '#22C55E' },
    { label: 'Edit Profile', desc: 'Update your info', icon: 'person-outline', screen: 'EditProfile', color: '#8b5cf6' },
    { label: 'Wishlist', desc: 'Saved items', icon: 'heart-outline', screen: 'MainTabs', params: { screen: 'Wishlist' }, color: palette.colors.error },
    { label: 'Trusted Stores', desc: 'Stores you follow', icon: 'shield-checkmark-outline', screen: 'TrustedStores', color: palette.colors.success },
    { label: 'Notifications', desc: 'Inbox & alerts', icon: 'notifications-outline', screen: 'Notifications', color: palette.colors.warning },
    { label: 'Settings', desc: 'Preferences', icon: 'settings-outline', screen: 'Settings', color: palette.colors.textSecondary },
  ];

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}>
        
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
            <Text style={[styles.miniStatValue, { color: palette.colors.primary }]}>{orders.length}</Text>
            <Text style={styles.miniStatLabel}>Total Orders</Text>
          </GlassPanel>
          <GlassPanel variant="card" style={styles.miniStat}>
            <Text style={[styles.miniStatValue, { color: palette.colors.warning }]}>{pendingOrders}</Text>
            <Text style={styles.miniStatLabel}>Pending</Text>
          </GlassPanel>
          <GlassPanel variant="card" style={styles.miniStat}>
            <Text style={[styles.miniStatValue, { color: palette.colors.success }]}>{deliveredOrders}</Text>
            <Text style={styles.miniStatLabel}>Delivered</Text>
          </GlassPanel>
        </View>
        <View style={[styles.statsRow, { marginTop: spacing.md }]}>
          <GlassPanel variant="card" style={[styles.miniStat, { flex: 1 }]}>  
            <Ionicons name="card-outline" size={18} color={palette.colors.info} style={{ marginBottom: 4 }} />
            <Text style={[styles.miniStatValue, { color: palette.colors.info, fontSize: fontSize.lg }]}>{formatAmount(totalSpent)}</Text>
            <Text style={styles.miniStatLabel}>Total Spent</Text>
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
              <Ionicons name="chevron-forward" size={16} color={palette.colors.textSecondary} />
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
              const statusColor = status === 'delivered' ? palette.colors.success : status === 'pending' ? palette.colors.warning : palette.colors.info;
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

const buildStyles = (p) => StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  welcomeCard: { margin: spacing.lg, padding: spacing.xl, alignItems: 'center' },
  avatarContainer: { marginBottom: spacing.md },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: 'white' },
  welcomeTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  welcomeSubtitle: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: 2 },
  statsRow: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg },
  miniStat: { flex: 1, alignItems: 'center', padding: spacing.md },
  miniStatValue: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, letterSpacing: -0.5 },
  miniStatLabel: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  menuSection: { marginHorizontal: spacing.lg, marginTop: spacing.lg, padding: spacing.lg },
  sectionTitle: { ...typography.bodySemibold, color: p.colors.text, marginBottom: spacing.md },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  viewAllText: { ...typography.caption, color: p.colors.primary, fontWeight: fontWeight.semibold },
  menuRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  menuIcon: { width: 36, height: 36, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center' },
  menuLabel: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.sm },
  menuDesc: { ...typography.caption, color: p.colors.textSecondary },
  orderRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  orderId: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.sm },
  orderDate: { ...typography.caption, color: p.colors.textSecondary },
  statusBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.full },
  statusText: { fontSize: 10, fontWeight: fontWeight.semibold, textTransform: 'capitalize' },
});
