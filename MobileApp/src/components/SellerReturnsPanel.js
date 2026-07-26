import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import Feedback from '../utils/feedback';
import api from '../config/api';
import GlassPanel from './common/GlassPanel';
import { useCurrency } from '../contexts/CurrencyContext';
import { useTheme } from '../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../styles/theme';
import {
  RETURN_STATUS_LABELS,
  RETURN_STATUS_TRANSITIONS,
  returnResolutionLabel,
  returnStatusColor,
} from '../utils/returns';

const STATUS_FILTERS = [
  ['all', 'All'],
  ['requested', 'Requested'],
  ['approved', 'Approved'],
  ['picked_up', 'Picked Up'],
  ['in_transit_to_seller', 'In Transit'],
  ['received_by_seller', 'Received'],
  ['under_review', 'Reviewing'],
  ['accepted_pending_payment', 'Payment Due'],
  ['returned', 'Returned'],
  ['rejected', 'Rejected'],
];

const ACTION_LABELS = {
  approved: 'Approve return',
  pickup_scheduled: 'Pickup scheduled',
  picked_up: 'Mark picked up',
  in_transit_to_seller: 'On the way to seller',
  received_by_seller: 'Mark received',
  under_review: 'Start review',
  rejected: 'Reject return',
};

export default function SellerReturnsPanel({ header, route, navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { formatAmount } = useCurrency();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api.get('/api/returns/seller', {
        params: {
          ...(status !== 'all' ? { status } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
        },
      });
      setRequests(response.data?.returns || []);
    } catch (error) {
      Feedback.show({ type: 'error', text1: 'Returns unavailable', text2: error.response?.data?.msg || 'Failed to load return orders.' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, status]);

  useEffect(() => {
    const timeout = setTimeout(() => load(), search ? 250 : 0);
    return () => clearTimeout(timeout);
  }, [load, search]);

  useEffect(() => {
    if (!route?.params?.return_payment) return;
    Feedback.show({
      type: route.params.return_payment === 'success' ? 'success' : 'info',
      text1: route.params.return_payment === 'success' ? 'Payment submitted' : 'Payment cancelled',
      text2: route.params.return_payment === 'success'
        ? 'The return will complete after Stripe confirms the payment.'
        : 'The return remains under review and can be accepted later.',
    });
    load({ quiet: true });
    navigation.setParams({ return_payment: undefined, returnId: undefined });
  }, [load, navigation, route?.params?.return_payment]);

  const updateStatus = async () => {
    if (!dialog?.request || !dialog?.status) return;
    if (dialog.status === 'rejected' && note.trim().length < 5) {
      Feedback.show({ type: 'error', text1: 'Add a clear rejection reason' });
      return;
    }
    setSubmitting(true);
    try {
      await api.patch(`/api/returns/${dialog.request._id}/status`, {
        status: dialog.status,
        note: note.trim(),
      });
      Feedback.show({ type: 'success', text1: 'Return updated', text2: 'The buyer was notified on Rozare and WhatsApp.' });
      setDialog(null);
      setNote('');
      await load({ quiet: true });
    } catch (error) {
      Feedback.show({ type: 'error', text1: 'Update failed', text2: error.response?.data?.msg || 'Could not update this return.' });
    } finally {
      setSubmitting(false);
    }
  };

  const accept = async (request, fundingSource) => {
    setSubmitting(true);
    try {
      const response = await api.post(`/api/returns/${request._id}/accept`, {
        ...(fundingSource ? { fundingSource } : {}),
        platform: 'mobile',
      });
      if (response.data?.requiresPayment && response.data.url) {
        setDialog(null);
        await WebBrowser.openBrowserAsync(response.data.url, {
          dismissButtonStyle: 'cancel',
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
        });
        await load({ quiet: true });
        return;
      }
      Feedback.show({ type: 'success', text1: response.data?.msg || 'Return completed' });
      setDialog(null);
      await load({ quiet: true });
    } catch (error) {
      const available = error.response?.data?.availableBalanceUSD;
      Feedback.show({
        type: 'error',
        text1: 'Could not accept return',
        text2: `${error.response?.data?.msg || 'Try again.'}${Number.isFinite(available) ? ` Available balance: $${available.toFixed(2)}.` : ''}`,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const chooseFunding = (request) => {
    if (request.policySnapshot?.refundType === 'replacement_only') {
      Alert.alert('Approve replacement', 'Confirm that you reviewed the returned item and approve a replacement.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Approve', onPress: () => accept(request) },
      ]);
      return;
    }
    Alert.alert(
      'Fund buyer wallet refund',
      `Choose how to fund ${formatAmount(request.refund?.totalAmount || 0, { targetCurrency: request.currency })}. The return completes only after the buyer wallet is credited.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Seller Balance', onPress: () => accept(request, 'seller_balance') },
        { text: 'Card via Stripe', onPress: () => accept(request, 'card') },
      ]
    );
  };

  const renderRequest = ({ item: request }) => {
    const color = returnStatusColor(request.status, palette);
    const transitions = RETURN_STATUS_TRANSITIONS[request.status] || [];
    return (
      <GlassPanel variant="card" style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.returnNumber}>Return #{request.returnNumber}</Text>
            <Text style={styles.meta}>Order #{request.orderId} - {request.buyer?.username || request.buyer?.email || 'Buyer'}</Text>
          </View>
          <View style={[styles.badge, { backgroundColor: `${color}18`, borderColor: `${color}45` }]}>
            <Text style={[styles.badgeText, { color }]}>{RETURN_STATUS_LABELS[request.status] || request.status}</Text>
          </View>
        </View>

        <View style={styles.reasonBox}>
          <Text style={styles.reasonLabel}>Buyer reason</Text>
          <Text style={styles.reasonBody}>{request.reasonDetails}</Text>
        </View>

        {request.items.map(item => (
          <View key={String(item.orderItemId)} style={styles.itemRow}>
            <Text style={styles.itemName} numberOfLines={1}>{item.name} x {item.quantity}</Text>
            <Text style={styles.itemPrice}>{formatAmount(item.lineSubtotal || 0, { targetCurrency: request.currency })}</Text>
          </View>
        ))}

        <View style={styles.refundRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.meta}>{returnResolutionLabel(request.policySnapshot?.refundType)}</Text>
            {request.policySnapshot?.refundType !== 'replacement_only' && (
              <Text style={styles.refundValue}>{formatAmount(request.refund?.totalAmount || 0, { targetCurrency: request.currency })}</Text>
            )}
          </View>
          {request.status === 'under_review' && (
            <TouchableOpacity style={styles.acceptButton} onPress={() => chooseFunding(request)} disabled={submitting}>
              <Ionicons name="checkmark-circle-outline" size={17} color="#fff" />
              <Text style={styles.acceptText}>{request.policySnapshot?.refundType === 'replacement_only' ? 'Approve Replacement' : 'Accept Return'}</Text>
            </TouchableOpacity>
          )}
          {request.status === 'accepted_pending_payment' && (
            <TouchableOpacity style={styles.acceptButton} onPress={() => accept(request, 'card')} disabled={submitting}>
              <Ionicons name="card-outline" size={17} color="#fff" />
              <Text style={styles.acceptText}>Resume Payment</Text>
            </TouchableOpacity>
          )}
        </View>

        {transitions.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actions}>
            {transitions.map(nextStatus => (
              <TouchableOpacity
                key={nextStatus}
                style={[styles.actionButton, nextStatus === 'rejected' && styles.rejectButton]}
                onPress={() => { setNote(''); setDialog({ request, status: nextStatus }); }}
              >
                <Text style={[styles.actionText, nextStatus === 'rejected' && styles.rejectText]}>{ACTION_LABELS[nextStatus]}</Text>
                <Ionicons name="arrow-forward-outline" size={14} color={nextStatus === 'rejected' ? palette.colors.error : palette.colors.primary} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {request.statusHistory?.length > 0 && (
          <View style={styles.history}>
            {request.statusHistory.map((entry, index) => (
              <View key={`${entry.status}-${entry.changedAt}-${index}`} style={styles.historyRow}>
                <View style={[styles.dot, { backgroundColor: returnStatusColor(entry.status, palette) }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyTitle}>{RETURN_STATUS_LABELS[entry.status] || entry.status}</Text>
                  <Text style={styles.historyText}>{new Date(entry.changedAt).toLocaleString()}{entry.note ? ` - ${entry.note}` : ''}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </GlassPanel>
    );
  };

  const filterHeader = (
    <View>
      {header}
      <View style={styles.filters}>
        <View style={styles.searchWrap}>
          <Ionicons name="search-outline" size={18} color={palette.colors.textSecondary} />
          <TextInput value={search} onChangeText={setSearch} placeholder="Search return or order" placeholderTextColor={palette.colors.textSecondary} style={styles.searchInput} />
        </View>
        <FlatList
          horizontal
          data={STATUS_FILTERS}
          keyExtractor={item => item[0]}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.statusFilters}
          renderItem={({ item: [value, label] }) => (
            <TouchableOpacity style={[styles.filterChip, status === value && styles.filterChipActive]} onPress={() => setStatus(value)}>
              <Text style={[styles.filterText, status === value && styles.filterTextActive]}>{label}</Text>
            </TouchableOpacity>
          )}
        />
      </View>
    </View>
  );

  return (
    <>
      <FlatList
        data={requests}
        keyExtractor={item => item._id}
        renderItem={renderRequest}
        ListHeaderComponent={filterHeader}
        ListEmptyComponent={loading
          ? <View style={styles.empty}><ActivityIndicator color={palette.colors.primary} /><Text style={styles.emptyText}>Loading return orders...</Text></View>
          : <View style={styles.empty}><Ionicons name="return-down-back-outline" size={34} color={palette.colors.textSecondary} /><Text style={styles.emptyTitle}>No return orders</Text><Text style={styles.emptyText}>Buyer return requests will appear here.</Text></View>}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load({ quiet: true }); }} tintColor={palette.colors.primary} />}
        showsVerticalScrollIndicator={false}
      />

      <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={() => !submitting && setDialog(null)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>{ACTION_LABELS[dialog?.status]}</Text>
                <Text style={styles.meta}>Return #{dialog?.request?.returnNumber}</Text>
              </View>
              <TouchableOpacity style={styles.closeButton} onPress={() => setDialog(null)} disabled={submitting}>
                <Ionicons name="close" size={20} color={palette.colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.noteLabel}>{dialog?.status === 'rejected' ? 'Rejection reason' : 'Note for buyer (optional)'}</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              multiline
              maxLength={1000}
              textAlignVertical="top"
              placeholder={dialog?.status === 'rejected' ? 'Explain why this return cannot be accepted.' : 'Add pickup or review details.'}
              placeholderTextColor={palette.colors.textSecondary}
              style={styles.noteInput}
            />
            <TouchableOpacity style={[styles.confirmButton, dialog?.status === 'rejected' && styles.confirmReject, submitting && styles.disabled]} onPress={updateStatus} disabled={submitting}>
              {submitting && <ActivityIndicator size="small" color="#fff" />}
              <Text style={styles.confirmText}>Confirm update</Text>
            </TouchableOpacity>
          </GlassPanel>
        </View>
      </Modal>
    </>
  );
}

const buildStyles = (p) => StyleSheet.create({
  list: { paddingHorizontal: spacing.md, paddingBottom: 100, flexGrow: 1 },
  filters: { marginBottom: spacing.md },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, marginHorizontal: spacing.lg, marginBottom: spacing.md, paddingHorizontal: spacing.md, borderRadius: 14, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, fontSize: fontSize.sm, color: p.colors.text, paddingVertical: spacing.sm },
  statusFilters: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  filterChip: { minHeight: 38, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  filterChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  filterText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  filterTextActive: { color: '#fff' },
  card: { padding: spacing.lg, marginBottom: spacing.md },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.md },
  returnNumber: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text },
  meta: { fontSize: fontSize.xs, color: p.colors.textSecondary, lineHeight: 17, marginTop: 2 },
  badge: { maxWidth: '47%', paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: fontWeight.bold, textAlign: 'center' },
  reasonBox: { padding: spacing.md, borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.md },
  reasonLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.textSecondary, textTransform: 'uppercase' },
  reasonBody: { fontSize: fontSize.sm, color: p.colors.text, lineHeight: 19, marginTop: 4 },
  itemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 5 },
  itemName: { flex: 1, fontSize: fontSize.sm, color: p.colors.text },
  itemPrice: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  refundRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  refundValue: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: 2 },
  acceptButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: spacing.md, borderRadius: 12, backgroundColor: p.colors.success },
  acceptText: { maxWidth: 110, color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold, textAlign: 'center' },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  actionButton: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.md, borderRadius: 12, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.25)' },
  actionText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.primary },
  rejectButton: { backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' },
  rejectText: { color: p.colors.error },
  history: { gap: spacing.sm, marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  historyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  historyTitle: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  historyText: { fontSize: 10, lineHeight: 15, color: p.colors.textSecondary, marginTop: 2 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  emptyTitle: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text },
  emptyText: { fontSize: fontSize.sm, color: p.colors.textSecondary, textAlign: 'center' },
  modalOverlay: { flex: 1, justifyContent: 'center', padding: spacing.lg, backgroundColor: 'rgba(0,0,0,0.58)' },
  modalCard: { padding: spacing.lg },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  modalTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  closeButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  noteLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.lg, marginBottom: spacing.sm },
  noteInput: { minHeight: 120, borderRadius: 14, padding: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, color: p.colors.text, fontSize: fontSize.sm },
  confirmButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: 14, backgroundColor: p.colors.primary, marginTop: spacing.md },
  confirmReject: { backgroundColor: p.colors.error },
  confirmText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  disabled: { opacity: 0.55 },
});
