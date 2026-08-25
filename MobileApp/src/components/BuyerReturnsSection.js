import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import Feedback from '../utils/feedback';
import api from '../config/api';
import GlassPanel from './common/GlassPanel';
import KeyboardAwareFormScrollView from './common/KeyboardAwareFormScrollView';
import { useTheme } from '../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../styles/theme';
import {
  BUYER_CANCELLABLE_RETURN_STATUSES,
  RETURN_STATUS_LABELS,
  returnResolutionLabel,
  returnStatusColor,
} from '../utils/returns';
import {
  fetchCompleteBuyerReturns,
  inspectBuyerReturnEligibilityResponse,
  inspectBuyerReturnMutationResponse,
  inspectBuyerReturnOrderContext,
  inspectBuyerReturnsResponse,
} from '../utils/returnPresentationSafety';

const REASONS = [
  ['damaged', 'Arrived damaged'],
  ['defective', 'Defective'],
  ['wrong_item', 'Wrong item'],
  ['not_as_described', 'Not as described'],
  ['size_or_fit', 'Size or fit'],
  ['changed_mind', 'Changed mind'],
  ['other', 'Other'],
];
const REASON_VALUES = new Set(REASONS.map(([value]) => value));
const canonicalRequestKey = value => (
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value
    : null
);
const responseMessage = (error, fallback) => {
  const value = error?.response?.data?.msg;
  return typeof value === 'string' && value.trim() && value.length <= 500
    ? value.trim()
    : fallback;
};

export default function BuyerReturnsSection({ order, formatMoney }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const [groups, setGroups] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [reasonCategory, setReasonCategory] = useState('damaged');
  const [reasonDetails, setReasonDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestKeyRef = useRef(null);
  const [cancellingId, setCancellingId] = useState(null);
  const loadGenerationRef = useRef(0);
  const orderContext = useMemo(() => inspectBuyerReturnOrderContext(order), [order]);
  const currentOrderIdRef = useRef(null);
  currentOrderIdRef.current = orderContext.valid ? orderContext.orderId : null;

  const clearPresentedState = useCallback(({ closeForm = true } = {}) => {
    setGroups([]);
    setRequests([]);
    setCancellingId(null);
    if (closeForm) {
      setSelectedGroup(null);
      setQuantities({});
    }
  }, []);

  const load = useCallback(async ({ notify = true } = {}) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    clearPresentedState();
    setLoadError('');
    setLoading(true);
    if (!orderContext.valid) {
      const message = 'This order could not be verified, so returns are unavailable.';
      setLoadError(message);
      setLoading(false);
      return { valid: false, requests: [], groups: [] };
    }
    try {
      const [eligibility, existing] = await Promise.all([
        api.get(`/api/returns/order/${orderContext.orderId}/eligibility`),
        fetchCompleteBuyerReturns(async (page, limit) => {
          const response = await api.get('/api/returns/mine', {
            params: { orderId: orderContext.orderId, page, limit },
          });
          return response.data;
        }),
      ]);
      const eligibilityInspection = inspectBuyerReturnEligibilityResponse(
        eligibility.data,
        orderContext,
      );
      const returnsInspection = inspectBuyerReturnsResponse(
        existing,
        orderContext,
        eligibilityInspection,
      );
      if (!eligibilityInspection.valid || !returnsInspection.valid) {
        const error = new Error('Unverified return response');
        error.code = 'RETURN_RESPONSE_UNVERIFIED';
        throw error;
      }
      if (
        generation !== loadGenerationRef.current
        || currentOrderIdRef.current !== orderContext.orderId
      ) {
        return { valid: false, stale: true, requests: [], groups: [] };
      }
      setGroups(eligibilityInspection.groups);
      setRequests(returnsInspection.requests);
      return {
        valid: true,
        groups: eligibilityInspection.groups,
        requests: returnsInspection.requests,
      };
    } catch (error) {
      if (
        generation !== loadGenerationRef.current
        || currentOrderIdRef.current !== orderContext.orderId
      ) {
        return { valid: false, stale: true, requests: [], groups: [] };
      }
      clearPresentedState();
      const message = error?.code === 'RETURN_RESPONSE_UNVERIFIED'
        ? 'The server response could not be verified.'
        : responseMessage(error, 'Could not load verified return information.');
      setLoadError(message);
      if (notify) Feedback.show({ type: 'error', text1: 'Returns unavailable', text2: message });
      return { valid: false, requests: [], groups: [] };
    } finally {
      if (
        generation === loadGenerationRef.current
        && currentOrderIdRef.current === orderContext.orderId
      ) setLoading(false);
    }
  }, [clearPresentedState, orderContext]);

  useEffect(() => {
    void load();
    return () => { loadGenerationRef.current += 1; };
  }, [load]);

  const selection = useMemo(() => {
    if (!selectedGroup) return { valid: false, items: [] };
    const selectable = selectedGroup.items.filter(
      item => item.eligible && item.remainingReturnableQuantity > 0,
    );
    const selectableIds = new Set(selectable.map(item => item.orderItemId));
    if (Object.keys(quantities).some(key => !selectableIds.has(key))) {
      return { valid: false, items: [] };
    }
    const items = [];
    for (const item of selectable) {
      const quantity = Object.prototype.hasOwnProperty.call(quantities, item.orderItemId)
        ? quantities[item.orderItemId]
        : null;
      if (
        !Number.isSafeInteger(quantity)
        || quantity < 0
        || quantity > item.remainingReturnableQuantity
      ) return { valid: false, items: [] };
      if (quantity > 0) items.push({ orderItemId: item.orderItemId, quantity });
    }
    return { valid: true, items };
  }, [quantities, selectedGroup]);

  const selectedItems = selection.items;

  const openRequest = (group) => {
    const current = groups.find(entry => entry.seller._id === group?.seller?._id);
    if (!current?.eligible) {
      Feedback.show({ type: 'error', text1: 'Return option unavailable' });
      return;
    }
    let requestKey = null;
    try {
      requestKey = canonicalRequestKey(Crypto.randomUUID());
    } catch (_) {
      requestKey = null;
    }
    if (!requestKey) {
      Feedback.show({ type: 'error', text1: 'Could not start a secure return request' });
      return;
    }
    const initial = {};
    current.items.forEach(item => {
      if (item.eligible && item.remainingReturnableQuantity > 0) initial[item.orderItemId] = 0;
    });
    setQuantities(initial);
    setReasonCategory('damaged');
    setReasonDetails('');
    requestKeyRef.current = requestKey;
    setSelectedGroup(current);
  };

  const adjustQuantity = (item, change) => {
    const key = item.orderItemId;
    setQuantities((previous) => {
      const current = previous[key];
      if (!Number.isSafeInteger(current) || ![-1, 1].includes(change)) return previous;
      const next = current + change;
      if (next < 0 || next > item.remainingReturnableQuantity) return previous;
      return { ...previous, [key]: next };
    });
  };

  const submit = async () => {
    if (currentOrderIdRef.current !== orderContext.orderId) return;
    if (!selectedGroup || !selection.valid || !selectedItems.length) {
      Feedback.show({ type: 'error', text1: 'Select at least one item' });
      return;
    }
    const cleanReason = reasonDetails.trim();
    if (!REASON_VALUES.has(reasonCategory) || cleanReason.length < 10 || cleanReason.length > 1500) {
      Feedback.show({ type: 'error', text1: 'Add more detail', text2: 'Explain the return reason in at least 10 characters.' });
      return;
    }
    const requestKey = canonicalRequestKey(requestKeyRef.current);
    if (!requestKey) {
      Feedback.show({ type: 'error', text1: 'Return form expired', text2: 'Close it and start again.' });
      return;
    }
    const expectedSellerId = selectedGroup.seller._id;
    const expectedItems = selectedItems.map(item => ({ ...item }));
    setSubmitting(true);
    setGroups([]);
    setRequests([]);
    setLoadError('');
    try {
      const response = await api.post('/api/returns', {
        orderId: orderContext.orderId,
        sellerId: expectedSellerId,
        items: expectedItems,
        reasonCategory,
        reasonDetails: cleanReason,
        requestKey,
      }, {
        headers: { 'Idempotency-Key': requestKey },
      });
      if (currentOrderIdRef.current !== orderContext.orderId) return;
      const mutation = inspectBuyerReturnMutationResponse(response.data, orderContext, {
        mode: 'create',
        expectedSellerId,
        expectedItems,
        expectedReasonCategory: reasonCategory,
        expectedReasonDetails: cleanReason,
      });
      const refreshed = await load({ notify: false });
      if (refreshed.stale || currentOrderIdRef.current !== orderContext.orderId) return;
      const refetched = mutation.valid
        ? refreshed.requests.find(request => request._id === mutation.request._id)
        : null;
      if (!mutation.valid || !refreshed.valid || !refetched) {
        clearPresentedState();
        setLoadError('The saved return state could not be verified. Reload before taking another action.');
        Feedback.show({ type: 'error', text1: 'Return confirmation unavailable', text2: 'Reload before trying again.' });
        return;
      }
      requestKeyRef.current = null;
      Feedback.show({
        type: 'success',
        text1: response.data.replayed ? 'Return request already received' : 'Return request sent',
        text2: 'The saved request was verified.',
      });
    } catch (error) {
      if (currentOrderIdRef.current !== orderContext.orderId) return;
      setGroups([]);
      setRequests([]);
      Feedback.show({ type: 'error', text1: 'Request failed', text2: responseMessage(error, 'You can retry this form safely.') });
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRequest = (request) => {
    const current = requests.find(candidate => candidate._id === request?._id);
    if (!current || !BUYER_CANCELLABLE_RETURN_STATUSES.has(current.status)) {
      Feedback.show({ type: 'error', text1: 'This return can no longer be cancelled' });
      return;
    }
    Alert.alert('Cancel return request', `Cancel return #${current.returnNumber}?`, [
      { text: 'Keep Request', style: 'cancel' },
      {
        text: 'Cancel Return',
        style: 'destructive',
        onPress: async () => {
          if (currentOrderIdRef.current !== orderContext.orderId) return;
          setCancellingId(current._id);
          setGroups([]);
          setRequests([]);
          setLoadError('');
          try {
            const response = await api.post(`/api/returns/${current._id}/cancel`, {});
            if (currentOrderIdRef.current !== orderContext.orderId) return;
            const mutation = inspectBuyerReturnMutationResponse(response.data, orderContext, {
              mode: 'cancel',
              expectedRequestId: current._id,
              expectedStatus: 'cancelled_by_buyer',
            });
            const refreshed = await load({ notify: false });
            if (refreshed.stale || currentOrderIdRef.current !== orderContext.orderId) return;
            const refetched = refreshed.requests.find(candidate => candidate._id === current._id);
            if (!mutation.valid || !refreshed.valid || refetched?.status !== 'cancelled_by_buyer') {
              clearPresentedState();
              setLoadError('The cancellation could not be verified. Reload before taking another action.');
              Feedback.show({ type: 'error', text1: 'Cancellation confirmation unavailable' });
              return;
            }
            Feedback.show({ type: 'success', text1: 'Return request cancelled' });
          } catch (error) {
            if (currentOrderIdRef.current !== orderContext.orderId) return;
            const refreshed = await load({ notify: false });
            if (refreshed.stale || currentOrderIdRef.current !== orderContext.orderId) return;
            const refetched = refreshed.requests.find(candidate => candidate._id === current._id);
            if (refreshed.valid && refetched?.status === 'cancelled_by_buyer') {
              Feedback.show({ type: 'success', text1: 'Return request cancelled' });
              return;
            }
            Feedback.show({ type: 'error', text1: 'Could not cancel', text2: responseMessage(error, 'Try again.') });
          } finally {
            setCancellingId(null);
          }
        },
      },
    ]);
  };

  const moneyLabel = useCallback((amount) => {
    try {
      const label = formatMoney(amount);
      return typeof label === 'string' && label.trim() ? label : 'Money unavailable';
    } catch (_) {
      return 'Money unavailable';
    }
  }, [formatMoney]);

  if (loading) {
    return (
      <GlassPanel variant="card" style={styles.loadingCard}>
        <ActivityIndicator size="small" color={palette.colors.primary} />
        <Text style={styles.mutedText}>Checking seller return policies...</Text>
      </GlassPanel>
    );
  }

  if (!groups.length && !requests.length && !loadError && !selectedGroup) return null;

  return (
    <View style={styles.container}>
      <View style={styles.headingRow}>
        <Ionicons name="return-down-back-outline" size={20} color={palette.colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.heading}>Returns</Text>
          <Text style={styles.mutedText}>Eligibility is calculated separately for each seller.</Text>
        </View>
      </View>

      {loadError ? (
        <GlassPanel variant="card" style={styles.unavailableCard}>
          <Ionicons name="alert-circle-outline" size={20} color={palette.colors.error} />
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>Return information unavailable</Text>
            <Text style={styles.mutedText}>{loadError}</Text>
          </View>
          <TouchableOpacity style={styles.retryButton} onPress={() => load()} disabled={loading} accessibilityRole="button">
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </GlassPanel>
      ) : null}

      {requests.map(request => {
        const statusColor = returnStatusColor(request.status, palette);
        return (
          <GlassPanel key={request._id} variant="card" style={styles.requestCard}>
            <View style={styles.requestHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>Return #{request.returnNumber}</Text>
                <Text style={styles.mutedText}>{request.storeName || request.seller?.username || 'Seller'}</Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: `${statusColor}18`, borderColor: `${statusColor}45` }]}>
                <Text style={[styles.statusText, { color: statusColor }]}>{RETURN_STATUS_LABELS[request.status]}</Text>
              </View>
            </View>
            {request.items.map(item => (
              <View key={item.orderItemId} style={styles.returnItemRow}>
                <Text style={styles.itemName} numberOfLines={1}>{item.name} x {item.quantity}</Text>
                <Text style={styles.itemAmount}>{moneyLabel(item.lineSubtotal)}</Text>
              </View>
            ))}
            <View style={styles.requestFooter}>
              <View style={{ flex: 1 }}>
                <Text style={styles.mutedText}>{returnResolutionLabel(request.policySnapshot.refundType)}</Text>
                {request.policySnapshot.refundType !== 'replacement_only' && (
                  <Text style={styles.refundAmount}>{moneyLabel(request.refund.totalAmount)}</Text>
                )}
              </View>
              {BUYER_CANCELLABLE_RETURN_STATUSES.has(request.status) && (
                <TouchableOpacity style={styles.cancelRequestButton} onPress={() => cancelRequest(request)} disabled={cancellingId === request._id}>
                  {cancellingId === request._id
                    ? <ActivityIndicator size="small" color={palette.colors.error} />
                    : <Ionicons name="close-outline" size={16} color={palette.colors.error} />}
                  <Text style={styles.cancelRequestText}>Cancel</Text>
                </TouchableOpacity>
              )}
            </View>
            {request.statusHistory.length > 0 && (
              <View style={styles.history}>
                {request.statusHistory.map((entry, index) => (
                  <View key={`${entry.status}-${entry.changedAt}-${index}`} style={styles.historyRow}>
                    <View style={[styles.historyDot, { backgroundColor: returnStatusColor(entry.status, palette) }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyTitle}>{RETURN_STATUS_LABELS[entry.status]}</Text>
                      <Text style={styles.historyText}>{new Date(entry.changedAt).toLocaleString()}{entry.note ? ` - ${entry.note}` : ''}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </GlassPanel>
        );
      })}

      {groups.map(group => (
        <GlassPanel key={group.seller._id} variant="card" style={styles.policyCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{group.store?.storeName || group.seller?.username || 'Seller'}</Text>
            <Text style={styles.policyText}>
              {group.policy.returnsEnabled
                ? `${group.policy.returnDuration}-day returns - ${returnResolutionLabel(group.policy.refundType)}`
                : 'Returns are not offered by this seller'}
            </Text>
            {group.eligibilityDeadline && <Text style={styles.deadline}>Request by {new Date(group.eligibilityDeadline).toLocaleString()}</Text>}
            {!group.eligible && <Text style={styles.unavailableText}>{group.reason}</Text>}
          </View>
          {group.eligible && (
            <TouchableOpacity style={styles.requestButton} onPress={() => openRequest(group)}>
              <Ionicons name="return-down-back-outline" size={16} color="#fff" />
              <Text style={styles.requestButtonText}>Request</Text>
            </TouchableOpacity>
          )}
        </GlassPanel>
      ))}

      <Modal visible={!!selectedGroup} animationType="slide" onRequestClose={() => !submitting && setSelectedGroup(null)}>
        <View style={[styles.modalRoot, { backgroundColor: palette.colors.background }]}>
          <View style={styles.modalHeader}>
            <TouchableOpacity style={styles.modalClose} onPress={() => setSelectedGroup(null)} disabled={submitting} accessibilityLabel="Close return request">
              <Ionicons name="close" size={22} color={palette.colors.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle}>Request a return</Text>
              <Text style={styles.mutedText}>{selectedGroup?.store?.storeName || selectedGroup?.seller?.username}</Text>
            </View>
          </View>
          <KeyboardAwareFormScrollView contentContainerStyle={styles.modalScroll} bottomOffset={32}>
            {selectedGroup?.items.filter(item => item.eligible && item.remainingReturnableQuantity > 0).map(item => {
              const key = item.orderItemId;
              const quantity = quantities[key];
              return (
                <GlassPanel key={key} variant="card" style={styles.selectItemCard}>
                  <Image source={{ uri: item.image || 'https://rozare.com/favicon-512.png' }} style={styles.productImage} contentFit="cover" />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.cardTitle} numberOfLines={2}>{item.name}</Text>
                    <Text style={styles.mutedText}>Up to {item.remainingReturnableQuantity} - {returnResolutionLabel(item.returnPolicy?.refundType)}</Text>
                    {item.eligibilityDeadline && <Text style={styles.itemDeadline}>By {new Date(item.eligibilityDeadline).toLocaleString()}</Text>}
                  </View>
                  <View style={styles.stepper}>
                    <TouchableOpacity style={styles.stepButton} onPress={() => adjustQuantity(item, -1)} disabled={!quantity}>
                      <Ionicons name="remove" size={16} color={quantity ? palette.colors.primary : palette.colors.textSecondary} />
                    </TouchableOpacity>
                    <Text style={styles.stepValue}>{quantity}</Text>
                    <TouchableOpacity style={styles.stepButton} onPress={() => adjustQuantity(item, 1)} disabled={quantity >= item.remainingReturnableQuantity}>
                      <Ionicons name="add" size={16} color={quantity < item.remainingReturnableQuantity ? palette.colors.primary : palette.colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                </GlassPanel>
              );
            })}

            {selectedGroup?.policyVariants?.length > 1 && (
              <View style={styles.warningBanner}>
                <Ionicons name="information-circle-outline" size={18} color={palette.colors.warning} />
                <Text style={styles.warningText}>Items with different refund or replacement resolutions must be submitted separately.</Text>
              </View>
            )}

            <Text style={styles.fieldLabel}>Reason</Text>
            <View style={styles.reasonGrid}>
              {REASONS.map(([value, label]) => (
                <TouchableOpacity key={value} style={[styles.reasonChip, reasonCategory === value && styles.reasonChipActive]} onPress={() => setReasonCategory(value)}>
                  <Text style={[styles.reasonText, reasonCategory === value && styles.reasonTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.fieldLabel}>What happened?</Text>
            <TextInput
              value={reasonDetails}
              onChangeText={setReasonDetails}
              multiline
              maxLength={1500}
              textAlignVertical="top"
              placeholder="Describe the issue clearly for the seller."
              placeholderTextColor={palette.colors.textSecondary}
              style={styles.reasonInput}
            />
            <TouchableOpacity style={[styles.submitButton, (submitting || !selection.valid) && styles.disabled]} onPress={submit} disabled={submitting || !selection.valid}>
              {submitting ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send-outline" size={18} color="#fff" />}
              <Text style={styles.submitText}>{submitting ? 'Sending...' : 'Submit Return Request'}</Text>
            </TouchableOpacity>
          </KeyboardAwareFormScrollView>
        </View>
      </Modal>
    </View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { marginBottom: spacing.md },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md, paddingHorizontal: spacing.xs },
  heading: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  mutedText: { fontSize: fontSize.xs, color: p.colors.textSecondary, lineHeight: 17 },
  loadingCard: { minHeight: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.md },
  unavailableCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.md },
  retryButton: { minHeight: 36, justifyContent: 'center', borderRadius: 10, paddingHorizontal: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  retryText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  requestCard: { padding: spacing.lg, marginBottom: spacing.md },
  requestHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.md },
  cardTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  statusBadge: { maxWidth: '48%', paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: fontWeight.bold, textAlign: 'center' },
  returnItemRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 5 },
  itemName: { flex: 1, fontSize: fontSize.sm, color: p.colors.text },
  itemAmount: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text },
  requestFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle, marginTop: spacing.sm, paddingTop: spacing.md },
  refundAmount: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: 2 },
  cancelRequestButton: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, borderRadius: 12, paddingHorizontal: spacing.md, backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)' },
  cancelRequestText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.error },
  history: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle, gap: spacing.sm },
  historyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  historyDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  historyTitle: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.text },
  historyText: { fontSize: 10, lineHeight: 15, color: p.colors.textSecondary, marginTop: 2 },
  policyCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md },
  policyText: { fontSize: fontSize.xs, color: p.colors.textSecondary, lineHeight: 17, marginTop: 3 },
  deadline: { fontSize: 10, color: p.colors.primary, marginTop: 5 },
  unavailableText: { fontSize: fontSize.xs, color: p.colors.textSecondary, lineHeight: 17, marginTop: spacing.sm },
  requestButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: p.colors.primary, borderRadius: 12, paddingHorizontal: spacing.md },
  requestButtonText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  modalRoot: { flex: 1, paddingTop: spacing.xl },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  modalClose: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  modalScroll: { padding: spacing.lg, paddingBottom: 80 },
  selectItemCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, marginBottom: spacing.sm },
  productImage: { width: 54, height: 54, borderRadius: 12, backgroundColor: p.glass.bgSubtle },
  itemDeadline: { fontSize: 9, color: p.colors.primary, marginTop: 3 },
  stepper: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: p.glass.borderSubtle, overflow: 'hidden' },
  stepButton: { width: 32, height: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  stepValue: { minWidth: 28, textAlign: 'center', fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  warningBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderRadius: 12, padding: spacing.md, marginVertical: spacing.sm, backgroundColor: 'rgba(245,158,11,0.09)' },
  warningText: { flex: 1, fontSize: fontSize.xs, color: p.colors.textSecondary, lineHeight: 17 },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text, marginTop: spacing.lg, marginBottom: spacing.sm },
  reasonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  reasonChip: { minHeight: 38, justifyContent: 'center', borderRadius: 12, paddingHorizontal: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  reasonChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  reasonText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  reasonTextActive: { color: '#fff' },
  reasonInput: { minHeight: 130, borderRadius: 14, padding: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, color: p.colors.text, fontSize: fontSize.sm },
  submitButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: 15, marginTop: spacing.lg, backgroundColor: p.colors.primary },
  submitText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
  disabled: { opacity: 0.55 },
});
