import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import Loader from '../../components/common/Loader';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing, typography } from '../../styles/theme';

const STATUSES = ['pending', 'approved', 'processing', 'paid', 'rejected', 'cancelled'];

const statusColor = (status, palette) => {
  switch (status) {
    case 'paid': return palette.colors.success;
    case 'processing': return palette.colors.info;
    case 'approved': return palette.colors.primary;
    case 'rejected':
    case 'cancelled': return palette.colors.error;
    default: return palette.colors.warning;
  }
};

const StatCard = ({ icon, label, value, color, styles }) => (
  <GlassPanel variant="card" style={styles.statCard}>
    <View style={[styles.statIcon, { backgroundColor: `${color}18` }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </GlassPanel>
);

export default function AdminPaymentsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const { formatPrice } = useCurrency();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingId, setSavingId] = useState('');
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});

  const fetchOverview = useCallback(async () => {
    try {
      const res = await api.get(API_ENDPOINTS.PAYMENTS.ADMIN_OVERVIEW);
      const overview = res.data || {};
      const nextEdits = {};
      (overview.withdrawals || []).forEach((request) => {
        nextEdits[request._id] = {
          status: request.status || 'pending',
          adminNote: request.adminNote || '',
        };
      });
      setData(overview);
      setEdits(nextEdits);
    } catch (error) {
      Alert.alert('Admin payments', error.response?.data?.msg || 'Failed to load admin payments');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchOverview();
  }, [fetchOverview]);

  const updateEdit = (id, field, value) => {
    setEdits((previous) => ({ ...previous, [id]: { ...(previous[id] || {}), [field]: value } }));
  };

  const updateWithdrawal = async (id) => {
    const payload = edits[id] || {};
    if (!STATUSES.includes(payload.status)) {
      Alert.alert('Invalid status', 'Choose a valid withdrawal status');
      return;
    }
    setSavingId(id);
    try {
      await api.patch(`${API_ENDPOINTS.PAYMENTS.ADMIN_WITHDRAWAL}/${id}`, payload);
      Toast.show({ type: 'success', text1: 'Withdrawal updated' });
      await fetchOverview();
    } catch (error) {
      Alert.alert('Withdrawal', error.response?.data?.msg || 'Failed to update withdrawal');
    } finally {
      setSavingId('');
    }
  };

  const pendingRequests = useMemo(
    () => (data?.withdrawals || []).filter((request) => ['pending', 'approved', 'processing'].includes(request.status)).length,
    [data]
  );

  if (loading) {
    return (
      <GlassBackground>
        <Loader fullScreen message="Loading platform payments..." />
      </GlassBackground>
    );
  }

  const summary = data?.summary || {};
  const sellers = data?.sellers || [];
  const withdrawals = data?.withdrawals || [];

  return (
    <GlassBackground>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
      >
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()} activeOpacity={0.8}>
            <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={styles.headerIcon}>
            <Ionicons name="wallet-outline" size={22} color="white" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Seller Payments</Text>
            <Text style={styles.subtitle}>Payout accounts and withdrawal requests</Text>
          </View>
          <TouchableOpacity style={styles.iconButton} onPress={fetchOverview} activeOpacity={0.8}>
            <Ionicons name="refresh-outline" size={18} color={palette.colors.primary} />
          </TouchableOpacity>
        </GlassPanel>

        <View style={styles.statsGrid}>
          <StatCard styles={styles} icon="wallet-outline" label="Stripe Balance" value={formatPrice(summary.withdrawableBalance || 0)} color={palette.colors.success} />
          <StatCard styles={styles} icon="cash-outline" label="Delivered COD" value={formatPrice(summary.codDeliveredRevenue || 0)} color={palette.colors.warning} />
          <StatCard styles={styles} icon="trending-up-outline" label="Estimated" value={formatPrice(summary.estimatedRevenue || 0)} color={palette.colors.primary} />
          <StatCard styles={styles} icon="card-outline" label="Paid Out" value={formatPrice(summary.totalWithdrawn || 0)} color={palette.colors.info} />
          <StatCard styles={styles} icon="alert-circle-outline" label="Open Requests" value={pendingRequests} color={palette.colors.error} />
        </View>

        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Seller Payment Accounts</Text>
              <Text style={styles.sectionSubtitle}>Bank details and revenue by seller</Text>
            </View>
            <Ionicons name="people-outline" size={20} color={palette.colors.textSecondary} />
          </View>

          {sellers.length === 0 ? (
            <EmptyState styles={styles} icon="people-outline" text="No sellers found." />
          ) : (
            sellers.map((row) => (
              <View key={row.seller?._id} style={styles.sellerCard}>
                <View style={styles.sellerHeader}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{row.seller?.username?.[0]?.toUpperCase() || 'S'}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.sellerName} numberOfLines={1}>{row.seller?.username || 'Seller'}</Text>
                    <Text style={styles.sellerMeta} numberOfLines={1}>{row.seller?.email || 'No email'}</Text>
                    <Text style={styles.sellerMeta} numberOfLines={1}>{row.store?.storeName || 'No store'}</Text>
                  </View>
                </View>

                <View style={styles.bankBox}>
                  <Ionicons name={row.paymentAccount ? 'business-outline' : 'alert-circle-outline'} size={18} color={row.paymentAccount ? palette.colors.success : palette.colors.warning} />
                  <View style={{ flex: 1 }}>
                    {row.paymentAccount ? (
                      <>
                        <Text style={styles.bankTitle}>{row.paymentAccount.bankName}</Text>
                        <Text style={styles.bankText}>
                          {row.paymentAccount.accountHolderName}
                          {row.paymentAccount.accountNumber ? ` - ${row.paymentAccount.accountNumber}` : row.paymentAccount.maskedAccountNumber ? ` - ${row.paymentAccount.maskedAccountNumber}` : ''}
                          {row.paymentAccount.iban ? ` - IBAN ${row.paymentAccount.iban}` : ''}
                        </Text>
                      </>
                    ) : (
                      <Text style={styles.bankText}>Payment account not linked</Text>
                    )}
                  </View>
                </View>

                <View style={styles.sellerStats}>
                  <MiniMetric styles={styles} label="Stripe balance" value={formatPrice(row.revenue?.withdrawableBalance || 0)} />
                  <MiniMetric styles={styles} label="COD delivered" value={formatPrice(row.revenue?.codDeliveredRevenue || 0)} />
                  <MiniMetric styles={styles} label="Estimated" value={formatPrice(row.revenue?.estimatedRevenue || 0)} />
                </View>
              </View>
            ))
          )}
        </GlassPanel>

        <GlassPanel variant="card" style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionTitle}>Withdrawal Requests</Text>
              <Text style={styles.sectionSubtitle}>Review and update payout statuses</Text>
            </View>
            <Ionicons name="business-outline" size={20} color={palette.colors.textSecondary} />
          </View>

          {withdrawals.length === 0 ? (
            <EmptyState styles={styles} icon="checkmark-circle-outline" text="No withdrawal requests yet." />
          ) : (
            withdrawals.map((request) => {
              const edit = edits[request._id] || { status: request.status || 'pending', adminNote: request.adminNote || '' };
              return (
                <View key={request._id} style={styles.withdrawalCard}>
                  <View style={styles.withdrawalHeader}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.withdrawalAmount}>{formatPrice(request.amount || 0)}</Text>
                      <Text style={styles.withdrawalMeta}>{request.seller?.username || 'Seller'} - {new Date(request.createdAt).toLocaleString()}</Text>
                    </View>
                    <StatusPill status={request.status} palette={palette} styles={styles} />
                  </View>

                  <View style={styles.bankBox}>
                    <Ionicons name="business-outline" size={18} color={palette.colors.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.bankTitle}>{request.paymentAccountSnapshot?.bankName || 'Bank account'}</Text>
                      <Text style={styles.bankText}>
                        {request.paymentAccountSnapshot?.accountHolderName || 'Account holder'}
                        {request.paymentAccountSnapshot?.accountNumberLast4 ? ` - **** ${request.paymentAccountSnapshot.accountNumberLast4}` : ''}
                        {request.paymentAccountSnapshot?.ibanLast4 ? ` - IBAN **** ${request.paymentAccountSnapshot.ibanLast4}` : ''}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.inputLabel}>Status</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statusChoices}>
                    {STATUSES.map((status) => (
                      <TouchableOpacity
                        key={status}
                        style={[styles.statusChoice, edit.status === status && { backgroundColor: statusColor(status, palette), borderColor: statusColor(status, palette) }]}
                        onPress={() => updateEdit(request._id, 'status', status)}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.statusChoiceText, edit.status === status && { color: 'white' }]}>{status}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>

                  <Text style={styles.inputLabel}>Admin note</Text>
                  <TextInput
                    style={[styles.input, styles.textArea]}
                    value={edit.adminNote}
                    onChangeText={(value) => updateEdit(request._id, 'adminNote', value)}
                    placeholder="Optional note for the seller"
                    placeholderTextColor={palette.colors.textSecondary}
                    multiline
                  />

                  <TouchableOpacity
                    style={[styles.primaryButton, savingId === request._id && styles.disabledButton]}
                    onPress={() => updateWithdrawal(request._id)}
                    disabled={savingId === request._id}
                    activeOpacity={0.85}
                  >
                    {savingId === request._id ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
                    <Text style={styles.primaryButtonText}>Update withdrawal</Text>
                  </TouchableOpacity>
                </View>
              );
            })
          )}
        </GlassPanel>
      </ScrollView>
    </GlassBackground>
  );
}

const StatusPill = ({ status, palette, styles }) => (
  <View style={[styles.statusPill, { backgroundColor: `${statusColor(status, palette)}18` }]}>
    <Text style={[styles.statusText, { color: statusColor(status, palette) }]}>{status || 'pending'}</Text>
  </View>
);

const MiniMetric = ({ styles, label, value }) => (
  <View style={styles.miniMetric}>
    <Text style={styles.miniMetricValue}>{value}</Text>
    <Text style={styles.miniMetricLabel}>{label}</Text>
  </View>
);

const EmptyState = ({ styles, icon, text }) => (
  <View style={styles.emptyState}>
    <Ionicons name={icon} size={34} color="rgba(148,163,184,0.9)" />
    <Text style={styles.emptyText}>{text}</Text>
  </View>
);

const makeStyles = (p) => StyleSheet.create({
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 2 },
  header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  backButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  iconButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  title: { ...typography.h4, color: p.colors.text },
  subtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { width: '48%', padding: spacing.md, minHeight: 112 },
  statIcon: { width: 40, height: 40, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  statValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.sm },
  statLabel: { ...typography.caption, color: p.colors.textSecondary, textTransform: 'uppercase', marginTop: 2 },
  section: { padding: spacing.lg, marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  sectionTitle: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.lg },
  sectionSubtitle: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  sellerCard: { backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md },
  sellerHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: `${p.colors.primary}20`, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: p.colors.primary, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
  sellerName: { ...typography.bodySemibold, color: p.colors.text },
  sellerMeta: { ...typography.caption, color: p.colors.textSecondary, marginTop: 1 },
  bankBox: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md },
  bankTitle: { ...typography.bodySemibold, color: p.colors.text },
  bankText: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2, lineHeight: 16 },
  sellerStats: { flexDirection: 'row', gap: spacing.sm },
  miniMetric: { flex: 1, backgroundColor: p.glass.bg, borderRadius: borderRadius.md, padding: spacing.sm, borderWidth: 1, borderColor: p.glass.borderSubtle },
  miniMetricValue: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.sm },
  miniMetricLabel: { fontSize: 10, color: p.colors.textSecondary, marginTop: 2 },
  withdrawalCard: { backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.lg, padding: spacing.md, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md },
  withdrawalHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  withdrawalAmount: { ...typography.bodySemibold, color: p.colors.text, fontSize: fontSize.lg },
  withdrawalMeta: { ...typography.caption, color: p.colors.textSecondary, marginTop: 2 },
  statusPill: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  statusText: { ...typography.caption, fontWeight: fontWeight.bold, textTransform: 'capitalize' },
  inputLabel: { ...typography.caption, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginTop: spacing.sm, marginBottom: spacing.xs },
  statusChoices: { gap: spacing.sm, paddingBottom: spacing.xs },
  statusChoice: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.borderSubtle },
  statusChoiceText: { ...typography.bodySmall, color: p.colors.textSecondary, fontWeight: fontWeight.semibold, textTransform: 'capitalize' },
  input: { minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.borderSubtle, paddingHorizontal: spacing.md, color: p.colors.text, fontSize: fontSize.md },
  textArea: { minHeight: 84, paddingTop: spacing.md, textAlignVertical: 'top' },
  primaryButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, minHeight: 48, borderRadius: borderRadius.lg, backgroundColor: p.colors.primary, marginTop: spacing.md },
  primaryButtonText: { ...typography.bodySemibold, color: 'white' },
  disabledButton: { opacity: 0.65 },
  emptyState: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyText: { ...typography.bodySmall, color: p.colors.textSecondary, marginTop: spacing.sm },
});
