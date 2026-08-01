/**
 * My Orders — premium buyer order hub.
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  Platform,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { spacing, fontSize, fontWeight } from '../styles/theme';
import { CartItemSkeleton } from '../components/common/Skeleton';
import { EmptyOrders, LoginRequired, ErrorState } from '../components/common/EmptyState';
import OrderCard from '../components/common/OrderCard';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useTheme } from '../contexts/ThemeContext';
import { ACTIVE_ORDER_STATUSES, filterOrders, normalizeOrderStatus } from '../utils/orderPresentation';

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'pending', label: 'Pending' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'processing', label: 'Processing' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

export const sortOrdersByDate = (orders) => {
  if (!Array.isArray(orders)) return [];
  return [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

export default function OrdersScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const { currentUser } = useAuth();
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('all');
  const hasLoaded = useRef(false);

  const fetchOrders = useCallback(async ({ silent = false } = {}) => {
    if (!currentUser) {
      setOrders([]);
      setIsLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      setError(null);
      if (!silent) setIsLoading(true);
      const res = await api.get('/api/order/user-orders');
      setOrders(sortOrdersByDate(res.data?.orders || []));
    } catch (err) {
      setError(err.response?.data?.msg || err.response?.data?.message || 'Failed to load your orders');
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [currentUser]);

  useFocusEffect(useCallback(() => {
    fetchOrders({ silent: hasLoaded.current });
    hasLoaded.current = true;
  }, [fetchOrders]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOrders({ silent: true });
  }, [fetchOrders]);

  const stats = useMemo(() => {
    const active = orders.filter((order) => ACTIVE_ORDER_STATUSES.has(normalizeOrderStatus(order.orderStatus))).length;
    const delivered = orders.filter((order) => normalizeOrderStatus(order.orderStatus) === 'delivered').length;
    const paid = orders.filter((order) => order.isPaid).length;
    return { active, delivered, paid };
  }, [orders]);

  const visibleOrders = useMemo(() => filterOrders(orders, {
    search,
    status: statusFilter,
    payment: paymentFilter,
  }), [orders, search, statusFilter, paymentFilter]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatusFilter('all');
    setPaymentFilter('all');
  }, []);

  const heroHeader = (
    <>
      <PremiumBackHeader
        title="My Orders"
        subtitle="Everything you bought, beautifully organized"
        icon="receipt-outline"
        onBack={() => navigation.goBack()}
        rightElement={orders.length > 0 ? (
          <View style={styles.headerCount}>
            <Text style={styles.headerCountValue}>{orders.length}</Text>
            <Text style={styles.headerCountLabel}>ORDERS</Text>
          </View>
        ) : undefined}
        style={styles.premiumHeader}
      />

      {currentUser && orders.length > 0 && (
        <>
          <GlassPanel variant="strong" style={styles.overview}>
            <LinearGradient
              colors={['rgba(99,102,241,0.17)', 'rgba(14,165,233,0.07)', 'rgba(20,184,166,0.08)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.overviewTitleRow}>
              <View>
                <Text style={styles.overviewEyebrow}>YOUR ORDER HUB</Text>
                <Text style={styles.overviewTitle}>{stats.active ? `${stats.active} order${stats.active === 1 ? '' : 's'} in progress` : 'All caught up'}</Text>
                <Text style={styles.overviewSubtitle}>{stats.active ? 'Follow every store and delivery from one place.' : 'Your completed purchases stay safely organized here.'}</Text>
              </View>
              <View style={styles.overviewIcon}>
                <Ionicons name={stats.active ? 'navigate-outline' : 'checkmark-done'} size={25} color="#fff" />
              </View>
            </View>
            <View style={styles.statsRow}>
              <Stat value={stats.active} label="Active" icon="time-outline" color={palette.colors.primary} styles={styles} />
              <View style={styles.statDivider} />
              <Stat value={stats.delivered} label="Delivered" icon="checkmark-circle-outline" color={palette.colors.success} styles={styles} />
              <View style={styles.statDivider} />
              <Stat value={stats.paid} label="Paid" icon="shield-checkmark-outline" color={palette.colors.info} styles={styles} />
            </View>
          </GlassPanel>

          <GlassPanel variant="inner" style={styles.finder}>
            <View style={styles.searchRow}>
              <Ionicons name="search-outline" size={19} color={palette.colors.textSecondary} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search order ID or product"
                placeholderTextColor={palette.colors.textLight}
                style={styles.searchInput}
                returnKeyType="search"
                autoCorrect={false}
              />
              {!!search && (
                <TouchableOpacity onPress={() => setSearch('')} style={styles.clearSearch} accessibilityLabel="Clear order search">
                  <Ionicons name="close" size={16} color={palette.colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
          </GlassPanel>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filtersContent}
          >
            {STATUS_FILTERS.map((filter) => {
              const selected = statusFilter === filter.key;
              return (
                <TouchableOpacity
                  key={filter.key}
                  style={[styles.filterChip, selected && styles.filterChipSelected]}
                  onPress={() => setStatusFilter(filter.key)}
                  activeOpacity={0.8}
                >
                  {selected && <Ionicons name="checkmark" size={13} color="#fff" />}
                  <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{filter.label}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.paymentFilterRow}>
            <Text style={styles.resultsText}>{visibleOrders.length} result{visibleOrders.length === 1 ? '' : 's'}</Text>
            <View style={styles.paymentSegment}>
              {[['all', 'Any payment'], ['paid', 'Paid'], ['unpaid', 'Unpaid']].map(([key, label]) => (
                <TouchableOpacity
                  key={key}
                  style={[styles.paymentOption, paymentFilter === key && styles.paymentOptionSelected]}
                  onPress={() => setPaymentFilter(key)}
                >
                  <Text style={[styles.paymentOptionText, paymentFilter === key && styles.paymentOptionTextSelected]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </>
      )}
    </>
  );

  if (!currentUser) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {heroHeader}
          <LoginRequired onLogin={() => navigation.navigate('Login', { returnTo: 'Orders' })} onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (isLoading) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {heroHeader}
          <View style={styles.skeletons}>{[0, 1, 2].map((item) => <CartItemSkeleton key={item} />)}</View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (error && orders.length === 0) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {heroHeader}
          <ErrorState message={error} onRetry={() => fetchOrders()} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  if (orders.length === 0) {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
          {heroHeader}
          <EmptyOrders onBrowse={() => navigation.navigate('MainTabs', { screen: 'Home' })} />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <FlatList
          data={visibleOrders}
          keyExtractor={(item) => item._id || item.orderId}
          renderItem={({ item }) => (
            <OrderCard
              order={item}
              onPress={() => navigation.navigate('OrderDetail', { orderId: item._id })}
              style={styles.orderCard}
            />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={heroHeader}
          ListEmptyComponent={(
            <GlassPanel variant="card" style={styles.filteredEmpty}>
              <View style={styles.filteredEmptyIcon}><Ionicons name="search-outline" size={28} color={palette.colors.primary} /></View>
              <Text style={styles.filteredEmptyTitle}>No matching orders</Text>
              <Text style={styles.filteredEmptyText}>Try another order ID, product name, status, or payment filter.</Text>
              <TouchableOpacity style={styles.resetButton} onPress={clearFilters}>
                <Text style={styles.resetButtonText}>Reset filters</Text>
              </TouchableOpacity>
            </GlassPanel>
          )}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
          ListFooterComponent={<View style={styles.listFooter} />}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

function Stat({ value, label, icon, color, styles }) {
  return (
    <View style={styles.stat}>
      <View style={[styles.statIcon, { backgroundColor: `${color}18` }]}>
        <Ionicons name={icon} size={15} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm, marginBottom: spacing.md },
  headerCount: { minWidth: 48, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 13, backgroundColor: 'rgba(99,102,241,0.11)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.18)' },
  headerCountValue: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.primary, lineHeight: 15 },
  headerCountLabel: { marginTop: 2, fontSize: 7, letterSpacing: 0.8, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  overview: { marginHorizontal: spacing.md, marginBottom: spacing.md, padding: spacing.lg, borderRadius: 24 },
  overviewTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  overviewEyebrow: { fontSize: 9, letterSpacing: 1.5, fontWeight: fontWeight.extrabold, color: p.colors.primary },
  overviewTitle: { marginTop: 4, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.35 },
  overviewSubtitle: { maxWidth: 265, marginTop: 4, fontSize: 11, lineHeight: 16, color: p.colors.textSecondary },
  overviewIcon: { width: 48, height: 48, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 7 }, shadowOpacity: 0.27, shadowRadius: 12, elevation: 5 },
  statsRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  stat: { flex: 1, alignItems: 'center' },
  statIcon: { width: 28, height: 28, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  statValue: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  statLabel: { marginTop: 1, fontSize: 9, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  statDivider: { width: 1, height: 38, backgroundColor: p.glass.borderSubtle },
  finder: { marginHorizontal: spacing.md, marginBottom: spacing.sm, padding: 0, borderRadius: 18 },
  searchRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md },
  searchInput: { flex: 1, marginHorizontal: spacing.sm, paddingVertical: spacing.sm, fontSize: fontSize.md, color: p.colors.text },
  clearSearch: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  filtersContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.sm },
  filterChip: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: spacing.md, borderRadius: 14, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border },
  filterChipSelected: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  filterText: { fontSize: 11, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  filterTextSelected: { color: '#fff', fontWeight: fontWeight.bold },
  paymentFilterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.md, gap: spacing.sm },
  resultsText: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  paymentSegment: { flexDirection: 'row', alignItems: 'center', padding: 3, borderRadius: 12, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.borderSubtle },
  paymentOption: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: 9 },
  paymentOptionSelected: { backgroundColor: 'rgba(99,102,241,0.14)' },
  paymentOptionText: { fontSize: 9, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  paymentOptionTextSelected: { color: p.colors.primary, fontWeight: fontWeight.bold },
  listContent: { paddingBottom: spacing.xxxl, flexGrow: 1 },
  orderCard: { marginHorizontal: spacing.md },
  skeletons: { paddingHorizontal: spacing.md },
  filteredEmpty: { marginHorizontal: spacing.md, marginTop: spacing.sm, alignItems: 'center', padding: spacing.xxl },
  filteredEmptyIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: 'rgba(99,102,241,0.10)', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md },
  filteredEmptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  filteredEmptyText: { maxWidth: 280, marginTop: spacing.sm, textAlign: 'center', fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  resetButton: { marginTop: spacing.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: 12, backgroundColor: p.colors.primary },
  resetButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  listFooter: { height: spacing.xxl },
});
