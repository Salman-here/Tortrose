/**
 * Seller order centre with server-backed filters, exports and return handling.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import OrderCard from '../../components/common/OrderCard';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import SellerReturnsPanel from '../../components/SellerReturnsPanel';
import {
  SellerEmptyState,
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
  SellerSectionHeader,
} from '../../components/seller/SellerUI';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';
import {
  getConfirmationSourceLabel,
  hasWhatsAppPhone,
  isOrderConfirmedByBuyer,
  openWhatsAppVerify,
} from '../../utils/whatsapp';
import {
  buildOrderFilterParams,
  ORDER_EXPORT_FORMATS,
  shareSellerOrderExport,
  validateOrderDateRange,
} from '../../utils/sellerOrderExport';

const STATUS_TABS = [
  { id: 'all', label: 'All', icon: 'grid-outline', color: '#64748B' },
  { id: 'pending', label: 'Pending', icon: 'time-outline', color: '#F97316' },
  { id: 'confirmed', label: 'Confirmed', icon: 'checkmark-circle-outline', color: '#10B981' },
  { id: 'processing', label: 'Processing', icon: 'sync-outline', color: '#6366F1' },
  { id: 'shipped', label: 'Shipped', icon: 'car-outline', color: '#0EA5E9' },
  { id: 'delivered', label: 'Delivered', icon: 'checkmark-done-outline', color: '#059669' },
  { id: 'cancelled', label: 'Cancelled', icon: 'close-circle-outline', color: '#EF4444' },
];

const PAYMENT_FILTERS = [
  { id: 'all', label: 'All payments' },
  { id: 'paid', label: 'Paid' },
  { id: 'unpaid', label: 'Unpaid' },
];

export const filterOrdersByStatus = (orders = [], status) => {
  if (!status || status === 'all') return orders;
  return orders.filter((order) => (order.orderStatus || order.status) === status);
};

export const newestOrdersFirst = (orders = []) => [...orders].sort((left, right) => {
  const leftTime = new Date(left?.createdAt || 0).getTime();
  const rightTime = new Date(right?.createdAt || 0).getTime();
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return 0;
  if (!Number.isFinite(leftTime)) return 1;
  if (!Number.isFinite(rightTime)) return -1;
  return rightTime - leftTime;
});

const getApiError = (error, fallback) => (
  error?.response?.data?.msg || error?.response?.data?.message || error?.message || fallback
);

function PrimaryViewTabs({ active, onChange, styles, palette }) {
  return (
    <GlassPanel variant="strong" style={styles.primaryTabs}>
      {[
        { id: 'orders', label: 'Orders', icon: 'receipt-outline' },
        { id: 'returns', label: 'Returns', icon: 'return-down-back-outline' },
      ].map((item) => {
        const selected = active === item.id;
        return (
          <TouchableOpacity
            key={item.id}
            style={[styles.primaryTab, selected && styles.primaryTabActive]}
            onPress={() => onChange(item.id)}
            activeOpacity={0.78}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
          >
            <Ionicons name={item.icon} size={17} color={selected ? '#fff' : palette.colors.textSecondary} />
            <Text style={[styles.primaryTabText, selected && styles.primaryTabTextActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </GlassPanel>
  );
}

export default function OrderManagementScreen({ navigation, route }) {
  const { palette } = useTheme();
  const { formatPrice, currency } = useCurrency();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const isAdmin = route?.params?.isAdmin === true;

  const [primaryView, setPrimaryView] = useState(
    !isAdmin && route?.params?.tab === 'returns' ? 'returns' : 'orders',
  );
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [filterError, setFilterError] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [paymentStatus, setPaymentStatus] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [exportFormat, setExportFormat] = useState('pdf');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const initialLoadStarted = useRef(false);

  useEffect(() => {
    if (!isAdmin && route?.params?.tab === 'returns') setPrimaryView('returns');
  }, [isAdmin, route?.params?.tab]);

  const filters = useMemo(() => ({ search, status, paymentStatus, startDate, endDate }), [
    endDate,
    paymentStatus,
    search,
    startDate,
    status,
  ]);

  const loadOrders = useCallback(async ({ initial = false, refresh = false } = {}) => {
    const dateError = validateOrderDateRange(startDate, endDate);
    if (dateError) {
      setFilterError(dateError);
      setLoading(false);
      setRefreshing(false);
      setFiltering(false);
      return;
    }

    if (initial) setLoading(true);
    else if (!refresh) setFiltering(true);
    setFilterError('');
    setLoadError('');
    try {
      const response = await api.get(API_ENDPOINTS.ORDERS.GET_ALL, {
        params: buildOrderFilterParams(filters),
      });
      const nextOrders = response?.data?.orders;
      if (!Array.isArray(nextOrders)) throw new Error('The seller order list is invalid.');
      setOrders(newestOrdersFirst(nextOrders));
      setHasLoaded(true);
    } catch (error) {
      setLoadError(getApiError(error, 'Your seller orders could not be loaded.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
      setFiltering(false);
    }
  }, [endDate, filters, startDate]);

  useEffect(() => {
    const initial = !initialLoadStarted.current;
    initialLoadStarted.current = true;
    const timeout = setTimeout(
      () => loadOrders({ initial }),
      !initial && search.trim() ? 350 : 0,
    );
    return () => clearTimeout(timeout);
  }, [filters, loadOrders, search]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadOrders({ refresh: true });
  }, [loadOrders]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatus('all');
    setPaymentStatus('all');
    setStartDate('');
    setEndDate('');
    setFilterError('');
  }, []);

  const activeFilterCount = useMemo(
    () => Object.keys(buildOrderFilterParams(filters)).length,
    [filters],
  );

  const statusCounts = useMemo(() => orders.reduce((counts, order) => {
    const key = order.orderStatus || order.status || 'pending';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {}), [orders]);

  const exportOrders = useCallback(async () => {
    const dateError = validateOrderDateRange(startDate, endDate);
    if (dateError) {
      setFilterError(dateError);
      return;
    }
    setExporting(true);
    setExportError('');
    try {
      await shareSellerOrderExport({ format: exportFormat, filters, currency });
    } catch (error) {
      setExportError(getApiError(error, 'The report could not be prepared. Please try again.'));
    } finally {
      setExporting(false);
    }
  }, [currency, endDate, exportFormat, filters, startDate]);

  const viewTabs = !isAdmin ? (
    <PrimaryViewTabs
      active={primaryView}
      onChange={setPrimaryView}
      styles={styles}
      palette={palette}
    />
  ) : null;

  const openOrder = useCallback((order) => {
    navigation.navigate('OrderDetailManagement', { orderId: order._id, isAdmin });
  }, [isAdmin, navigation]);

  const renderOrder = useCallback(({ item }) => {
    const confirmationLabel = getConfirmationSourceLabel(item);
    const canVerify = hasWhatsAppPhone(item) && !isOrderConfirmedByBuyer(item);
    return (
      <OrderCard
        order={item}
        showCustomer
        sellerView={!isAdmin}
        confirmationLabel={confirmationLabel}
        onPress={() => openOrder(item)}
        onWhatsApp={canVerify ? (order) => openWhatsAppVerify(order, formatPrice) : undefined}
      />
    );
  }, [formatPrice, isAdmin, openOrder]);

  const listHeader = (
    <View>
      {viewTabs}

      <GlassPanel variant="strong" style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons name="bag-handle-outline" size={24} color={palette.colors.primary} />
        </View>
        <View style={styles.heroCopy}>
          <Text style={styles.heroEyebrow}>ORDER CENTRE</Text>
          <Text style={styles.heroTitle}>{orders.length} matching order{orders.length === 1 ? '' : 's'}</Text>
          <Text style={styles.heroSubtitle}>Search, fulfil, verify and export from one reliable view.</Text>
        </View>
        {filtering && <ActivityIndicator color={palette.colors.primary} />}
      </GlassPanel>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.statusStats}
      >
        {STATUS_TABS.slice(1).map((item) => (
          <TouchableOpacity
            key={item.id}
            style={[styles.statusStat, status === item.id && styles.statusStatActive]}
            onPress={() => setStatus(status === item.id ? 'all' : item.id)}
            activeOpacity={0.78}
            accessibilityRole="button"
            accessibilityState={{ selected: status === item.id }}
          >
            <View style={[styles.statusStatIcon, { backgroundColor: `${item.color}18` }]}>
              <Ionicons name={item.icon} size={15} color={item.color} />
            </View>
            <Text style={[styles.statusStatValue, { color: item.color }]}>{statusCounts[item.id] || 0}</Text>
            <Text style={styles.statusStatLabel}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <GlassPanel variant="card" style={styles.filtersCard}>
        <TouchableOpacity
          style={styles.filtersHeader}
          onPress={() => setFiltersExpanded((value) => !value)}
          activeOpacity={0.78}
          accessibilityRole="button"
          accessibilityState={{ expanded: filtersExpanded }}
        >
          <View style={styles.filtersHeading}>
            <View style={styles.filtersIcon}>
              <Ionicons name="options-outline" size={17} color={palette.colors.primary} />
            </View>
            <View>
              <Text style={styles.filtersTitle}>Filters & reports</Text>
              <Text style={styles.filtersSubtitle}>
                {activeFilterCount ? `${activeFilterCount} active filter${activeFilterCount === 1 ? '' : 's'}` : 'All seller orders'}
              </Text>
            </View>
          </View>
          <Ionicons name={filtersExpanded ? 'chevron-up' : 'chevron-down'} size={19} color={palette.colors.textSecondary} />
        </TouchableOpacity>

        <View style={styles.searchWrap}>
          <Ionicons name="search-outline" size={18} color={palette.colors.textSecondary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search by order ID or customer"
            placeholderTextColor={palette.colors.textLight}
            style={styles.searchInput}
            returnKeyType="search"
            accessibilityLabel="Search seller orders"
          />
          {!!search && (
            <TouchableOpacity onPress={() => setSearch('')} accessibilityLabel="Clear order search">
              <Ionicons name="close-circle" size={19} color={palette.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {filtersExpanded && (
          <View style={styles.filtersBody}>
            <Text style={styles.fieldLabel}>Order status</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {STATUS_TABS.map((item) => {
                const selected = status === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.chip, selected && styles.chipActive]}
                    onPress={() => setStatus(item.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextActive]}>{item.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <Text style={styles.fieldLabel}>Payment</Text>
            <View style={styles.paymentChips}>
              {PAYMENT_FILTERS.map((item) => {
                const selected = paymentStatus === item.id;
                return (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.paymentChip, selected && styles.chipActive]}
                    onPress={() => setPaymentStatus(item.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextActive]}>{item.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.fieldLabel}>Date range</Text>
            <View style={styles.dateRow}>
              <View style={styles.dateField}>
                <Text style={styles.dateCaption}>FROM</Text>
                <TextInput
                  value={startDate}
                  onChangeText={setStartDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={palette.colors.textLight}
                  style={styles.dateInput}
                  maxLength={10}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel="Order start date"
                />
              </View>
              <Ionicons name="arrow-forward" size={16} color={palette.colors.textLight} />
              <View style={styles.dateField}>
                <Text style={styles.dateCaption}>TO</Text>
                <TextInput
                  value={endDate}
                  onChangeText={setEndDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={palette.colors.textLight}
                  style={styles.dateInput}
                  maxLength={10}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel="Order end date"
                />
              </View>
            </View>

            {!!filterError && <Text style={styles.validationText}>{filterError}</Text>}

            <View style={styles.reportRow}>
              <View style={styles.formatSelector}>
                {Object.keys(ORDER_EXPORT_FORMATS).map((format) => {
                  const selected = exportFormat === format;
                  return (
                    <TouchableOpacity
                      key={format}
                      style={[styles.formatButton, selected && styles.formatButtonActive]}
                      onPress={() => setExportFormat(format)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.formatText, selected && styles.formatTextActive]}>{format === 'excel' ? 'XLSX' : format.toUpperCase()}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <TouchableOpacity
                style={[styles.exportButton, (exporting || orders.length === 0) && styles.buttonDisabled]}
                onPress={exportOrders}
                disabled={exporting || orders.length === 0}
                accessibilityRole="button"
                accessibilityState={{ disabled: exporting || orders.length === 0 }}
              >
                {exporting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name="download-outline" size={17} color="#fff" />}
                <Text style={styles.exportText}>{exporting ? 'Preparing' : 'Export'}</Text>
              </TouchableOpacity>
            </View>

            {activeFilterCount > 0 && (
              <TouchableOpacity style={styles.clearButton} onPress={clearFilters} accessibilityRole="button">
                <Ionicons name="close-circle-outline" size={15} color={palette.colors.textSecondary} />
                <Text style={styles.clearText}>Clear all filters</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </GlassPanel>

      {!!loadError && hasLoaded && (
        <SellerInlineError compact title="Orders did not refresh" message={loadError} onRetry={onRefresh} />
      )}
      {!!exportError && (
        <SellerInlineError compact title="Report unavailable" message={exportError} onRetry={exportOrders} />
      )}

      <SellerSectionHeader
        title="Customer orders"
        subtitle="Tap an order to review fulfilment and buyer confirmation"
        icon="receipt-outline"
      />
    </View>
  );

  if (loading && !hasLoaded) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Order Centre"
        subtitle="Fulfilment, returns and reports"
        icon="receipt-outline"
        variant="list"
        rows={5}
      />
    );
  }

  if (!hasLoaded && primaryView === 'orders') {
    return (
      <GlassBackground>
        <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top']}>
          <SellerScreenHeader navigation={navigation} title="Order Centre" subtitle="Fulfilment, returns and reports" icon="receipt-outline" />
          <View style={styles.fullError}>
            <SellerInlineError title="Orders unavailable" message={loadError} onRetry={() => loadOrders({ initial: true })} />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.safeArea} edges={Platform.OS === 'android' ? [] : ['top']}>
        <SellerScreenHeader
          navigation={navigation}
          title={primaryView === 'returns' ? 'Return Centre' : 'Order Centre'}
          subtitle={primaryView === 'returns' ? 'Review requests and fund approved returns' : 'Fulfilment, verification and reports'}
          icon={primaryView === 'returns' ? 'return-down-back-outline' : 'receipt-outline'}
          rightIcon="refresh-outline"
          rightLabel="Refresh"
          onRightPress={primaryView === 'orders' ? onRefresh : undefined}
        />

        {primaryView === 'returns' && !isAdmin ? (
          <SellerReturnsPanel header={viewTabs} route={route} navigation={navigation} />
        ) : (
          <FlatList
            data={orders}
            renderItem={renderOrder}
            keyExtractor={(item) => String(item._id || item.orderId)}
            ListHeaderComponent={listHeader}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            automaticallyAdjustKeyboardInsets
            ListEmptyComponent={(
              <SellerEmptyState
                icon="receipt-outline"
                title="No matching orders"
                message={activeFilterCount ? 'Try clearing a filter or changing the date range.' : 'New customer orders will appear here.'}
                actionLabel={activeFilterCount ? 'Clear filters' : undefined}
                onAction={activeFilterCount ? clearFilters : undefined}
              />
            )}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            refreshControl={(
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={palette.colors.primary}
                colors={[palette.colors.primary]}
              />
            )}
          />
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  fullError: { flex: 1, justifyContent: 'center' },
  list: { flexGrow: 1, width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 100 },
  primaryTabs: { flexDirection: 'row', gap: 5, padding: 5, marginBottom: spacing.md, borderRadius: borderRadius.xl },
  primaryTab: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: 13 },
  primaryTabActive: { backgroundColor: p.colors.primary },
  primaryTabText: { color: p.colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  primaryTabTextActive: { color: '#fff' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md, borderRadius: borderRadius.xxl },
  heroIcon: { width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  heroCopy: { flex: 1 },
  heroEyebrow: { color: p.colors.primary, fontSize: 9, letterSpacing: 1.3, fontWeight: fontWeight.extrabold },
  heroTitle: { marginTop: 3, color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  heroSubtitle: { marginTop: 3, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  statusStats: { gap: spacing.sm, paddingBottom: spacing.md },
  statusStat: { width: 92, minHeight: 96, alignItems: 'center', justifyContent: 'center', padding: spacing.sm, borderRadius: 18, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  statusStatActive: { borderColor: p.colors.primary, backgroundColor: p.colors.primarySubtle },
  statusStatIcon: { width: 28, height: 28, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  statusStatValue: { marginTop: 5, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  statusStatLabel: { marginTop: 1, color: p.colors.textSecondary, fontSize: 10, fontWeight: fontWeight.semibold },
  filtersCard: { padding: spacing.md, marginBottom: spacing.lg, borderRadius: borderRadius.xxl },
  filtersHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filtersHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  filtersIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  filtersTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  filtersSubtitle: { marginTop: 1, color: p.colors.textSecondary, fontSize: 10 },
  searchWrap: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, paddingHorizontal: spacing.md, borderRadius: 14, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, paddingVertical: spacing.sm },
  filtersBody: { paddingTop: spacing.md },
  fieldLabel: { marginTop: spacing.sm, marginBottom: spacing.sm, color: p.colors.textSecondary, fontSize: 10, letterSpacing: 0.8, fontWeight: fontWeight.extrabold, textTransform: 'uppercase' },
  chips: { gap: spacing.sm },
  chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  chipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  chipText: { color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  chipTextActive: { color: '#fff' },
  paymentChips: { flexDirection: 'row', gap: spacing.sm },
  paymentChip: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dateField: { flex: 1, paddingHorizontal: spacing.md, paddingTop: spacing.sm, borderRadius: 13, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  dateCaption: { color: p.colors.textLight, fontSize: 8, letterSpacing: 0.8, fontWeight: fontWeight.bold },
  dateInput: { color: p.colors.text, fontSize: fontSize.sm, paddingVertical: 7 },
  validationText: { marginTop: spacing.sm, color: p.colors.error, fontSize: fontSize.xs, lineHeight: 17 },
  reportRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  formatSelector: { flex: 1, flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  formatButton: { flex: 1, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  formatButtonActive: { backgroundColor: p.colors.primarySubtle },
  formatText: { color: p.colors.textSecondary, fontSize: 9, fontWeight: fontWeight.extrabold },
  formatTextActive: { color: p.colors.primary },
  exportButton: { minWidth: 104, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: 13, backgroundColor: p.colors.success },
  exportText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  buttonDisabled: { opacity: 0.5 },
  clearButton: { alignSelf: 'center', minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.md, paddingHorizontal: spacing.md },
  clearText: { color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
});
