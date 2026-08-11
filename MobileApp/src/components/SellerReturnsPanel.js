import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
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
import KeyboardAwareFormScrollView from './common/KeyboardAwareFormScrollView';
import Skeleton from './common/Skeleton';
import { SellerEmptyState, SellerInlineError } from './seller/SellerUI';
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
  ['pickup_scheduled', 'Scheduled'],
  ['picked_up', 'Picked Up'],
  ['in_transit_to_seller', 'In Transit'],
  ['received_by_seller', 'Received'],
  ['under_review', 'Reviewing'],
  ['accepted_pending_payment', 'Payment Due'],
  ['returned', 'Returned'],
  ['replacement_approved', 'Replacement'],
  ['rejected', 'Rejected'],
  ['cancelled_by_buyer', 'Cancelled'],
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

const ACTION_ICONS = {
  approved: 'checkmark-outline',
  pickup_scheduled: 'calendar-outline',
  picked_up: 'cube-outline',
  in_transit_to_seller: 'car-outline',
  received_by_seller: 'download-outline',
  under_review: 'search-outline',
  rejected: 'close-outline',
};

const REASON_LABELS = {
  damaged: 'Damaged item',
  defective: 'Defective item',
  wrong_item: 'Wrong item',
  not_as_described: 'Not as described',
  size_or_fit: 'Size or fit',
  changed_mind: 'Changed mind',
  other: 'Other reason',
};

const SELLER_ACTION_STATUSES = new Set([
  'requested',
  'approved',
  'pickup_scheduled',
  'picked_up',
  'in_transit_to_seller',
  'received_by_seller',
  'under_review',
  'accepted_pending_payment',
]);

const getApiError = (error, fallback) => (
  error?.response?.data?.msg || error?.response?.data?.message || error?.message || fallback
);

export const summarizeSellerReturns = (requests = []) => requests.reduce((summary, request) => {
  summary.total += 1;
  if (SELLER_ACTION_STATUSES.has(request?.status)) summary.actionable += 1;
  if (request?.status === 'accepted_pending_payment') summary.paymentDue += 1;
  return summary;
}, { total: 0, actionable: 0, paymentDue: 0 });

const formatDateTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
};

function ReturnFiltersSkeleton({ styles }) {
  return (
    <GlassPanel
      variant="strong"
      style={styles.filtersCard}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading return filters"
    >
      <View style={styles.filterHeadingRow}>
        <Skeleton width={42} height={42} radius={14} />
        <View style={styles.skeletonCopy}>
          <Skeleton width={136} height={15} radius={6} />
          <Skeleton width="72%" height={10} radius={5} style={styles.skeletonGap} />
        </View>
        <Skeleton width={58} height={34} radius={17} />
      </View>
      <Skeleton width="100%" height={48} radius={15} style={styles.skeletonSectionGap} />
      <View style={styles.skeletonChips}>
        <Skeleton width={58} height={36} radius={18} />
        <Skeleton width={86} height={36} radius={18} />
        <Skeleton width={78} height={36} radius={18} />
      </View>
    </GlassPanel>
  );
}

function ReturnListSkeleton({ styles, rows = 4 }) {
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading return requests"
      style={styles.skeletonList}
    >
      {Array.from({ length: rows }).map((_, index) => (
        <GlassPanel key={index} variant="card" style={styles.skeletonCard}>
          <View style={styles.skeletonCardHeader}>
            <Skeleton width={44} height={44} radius={15} />
            <View style={styles.skeletonCopy}>
              <Skeleton width="62%" height={15} radius={6} />
              <Skeleton width="82%" height={10} radius={5} style={styles.skeletonGap} />
            </View>
            <Skeleton width={76} height={27} radius={14} />
          </View>
          <Skeleton width="100%" height={74} radius={15} style={styles.skeletonSectionGap} />
          <View style={styles.skeletonCardFooter}>
            <View style={styles.skeletonCopy}>
              <Skeleton width="54%" height={10} radius={5} />
              <Skeleton width={92} height={20} radius={7} style={styles.skeletonGap} />
            </View>
            <Skeleton width={122} height={42} radius={13} />
          </View>
        </GlassPanel>
      ))}
    </View>
  );
}

function MetaPill({ icon, children, styles, palette }) {
  return (
    <View style={styles.metaPill}>
      <Ionicons name={icon} size={13} color={palette.colors.textSecondary} />
      <Text style={styles.metaPillText} numberOfLines={1}>{children}</Text>
    </View>
  );
}

export default function SellerReturnsPanel({ header, route, navigation }) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const { formatAmount } = useCurrency();
  const requestSequence = useRef(0);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submittingRequestId, setSubmittingRequestId] = useState('');

  const load = useCallback(async ({ quiet = false } = {}) => {
    const requestId = ++requestSequence.current;
    if (!quiet) setLoading(true);
    setLoadError('');
    try {
      const response = await api.get('/api/returns/seller', {
        params: {
          ...(status !== 'all' ? { status } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
        },
      });
      if (requestId !== requestSequence.current) return;
      if (!Array.isArray(response.data?.returns)) {
        throw new Error('The returns service sent an invalid response. Please try again.');
      }
      setRequests(response.data.returns);
      setHasLoaded(true);
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      setLoadError(getApiError(error, 'Failed to load return requests.'));
    } finally {
      if (requestId === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [search, status]);

  useEffect(() => {
    setLoading(true);
    setLoadError('');
    const timeout = setTimeout(() => load(), search.trim() ? 300 : 0);
    return () => {
      clearTimeout(timeout);
      requestSequence.current += 1;
    };
  }, [load, search]);

  useEffect(() => {
    if (!route?.params?.return_payment) return;
    Feedback.show({
      type: route.params.return_payment === 'success' ? 'success' : 'info',
      text1: route.params.return_payment === 'success' ? 'Payment submitted' : 'Payment cancelled',
      text2: route.params.return_payment === 'success'
        ? 'The return will complete after Stripe confirms the payment.'
        : 'The return remains open and its payment can be resumed later.',
    });
    load({ quiet: true });
    navigation?.setParams?.({ return_payment: undefined, returnId: undefined });
  }, [load, navigation, route?.params?.return_payment]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load({ quiet: true });
  }, [load]);

  const clearFilters = useCallback(() => {
    setSearch('');
    setStatus('all');
  }, []);

  const updateStatus = async () => {
    if (!dialog?.request || !dialog?.status) return;
    if (dialog.status === 'rejected' && note.trim().length < 5) {
      Feedback.show({ type: 'error', text1: 'Add a clear rejection reason' });
      return;
    }
    setSubmitting(true);
    setSubmittingRequestId(String(dialog.request._id));
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
      Feedback.show({ type: 'error', text1: 'Update failed', text2: getApiError(error, 'Could not update this return.') });
    } finally {
      setSubmitting(false);
      setSubmittingRequestId('');
    }
  };

  const accept = async (request, fundingSource) => {
    setSubmitting(true);
    setSubmittingRequestId(String(request._id));
    try {
      const response = await api.post(`/api/returns/${request._id}/accept`, {
        ...(fundingSource ? { fundingSource } : {}),
        platform: 'mobile',
      });
      if (response.data?.requiresPayment) {
        if (!response.data.url) throw new Error('The secure payment page is unavailable. Please try again.');
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
        text2: `${getApiError(error, 'Try again.')}${Number.isFinite(available) ? ` Available balance: $${available.toFixed(2)}.` : ''}`,
      });
    } finally {
      setSubmitting(false);
      setSubmittingRequestId('');
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
    const buyerName = request.buyer?.username || request.buyer?.email || 'Buyer';
    const requestedAt = formatDateTime(request.requestedAt || request.createdAt);
    const deadline = formatDateTime(request.eligibilityDeadline);
    const itemCount = (request.items || []).reduce((total, item) => total + Number(item.quantity || 0), 0);
    const requestBusy = submitting && submittingRequestId === String(request._id);
    const resolution = returnResolutionLabel(request.policySnapshot?.refundType);

    return (
      <GlassPanel variant="card" style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.returnIcon}>
            <Ionicons name="return-down-back-outline" size={21} color={palette.colors.primary} />
          </View>
          <View style={styles.cardTitleCopy}>
            <Text style={styles.returnNumber}>Return #{request.returnNumber}</Text>
            {!!requestedAt && <Text style={styles.meta}>Requested {requestedAt}</Text>}
          </View>
          <View style={[styles.badge, { backgroundColor: `${color}18`, borderColor: `${color}45` }]}>
            <View style={[styles.badgeDot, { backgroundColor: color }]} />
            <Text style={[styles.badgeText, { color }]}>{RETURN_STATUS_LABELS[request.status] || request.status}</Text>
          </View>
        </View>

        <View style={styles.metaPills}>
          <MetaPill icon="receipt-outline" styles={styles} palette={palette}>Order #{request.orderId}</MetaPill>
          <MetaPill icon="person-outline" styles={styles} palette={palette}>{buyerName}</MetaPill>
          {!!deadline && <MetaPill icon="calendar-outline" styles={styles} palette={palette}>Eligible until {deadline}</MetaPill>}
        </View>

        <View style={styles.reasonBox}>
          <View style={styles.reasonHeading}>
            <View style={styles.reasonIcon}>
              <Ionicons name="chatbox-ellipses-outline" size={15} color={palette.colors.primary} />
            </View>
            <View style={styles.reasonCopy}>
              <Text style={styles.reasonLabel}>Buyer reason</Text>
              <Text style={styles.reasonCategory}>{REASON_LABELS[request.reasonCategory] || 'Return details'}</Text>
            </View>
          </View>
          <Text style={styles.reasonBody}>{request.reasonDetails}</Text>
        </View>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Items to return</Text>
          <Text style={styles.sectionCount}>{itemCount} {itemCount === 1 ? 'item' : 'items'}</Text>
        </View>
        <View style={styles.itemsBox}>
          {(request.items || []).map((item, index) => (
            <View
              key={String(item.orderItemId)}
              style={[styles.itemRow, index > 0 && styles.itemRowDivider]}
            >
              <View style={styles.quantityBadge}>
                <Text style={styles.quantityText}>{item.quantity}x</Text>
              </View>
              <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
              <Text style={styles.itemPrice}>{formatAmount(item.lineSubtotal || 0, { targetCurrency: request.currency })}</Text>
            </View>
          ))}
        </View>

        <View style={styles.refundBox}>
          <View style={styles.refundIcon}>
            <Ionicons
              name={request.policySnapshot?.refundType === 'replacement_only' ? 'swap-horizontal-outline' : 'wallet-outline'}
              size={20}
              color={palette.colors.success}
            />
          </View>
          <View style={styles.refundCopy}>
            <Text style={styles.refundLabel}>Resolution</Text>
            <Text style={styles.refundResolution}>{resolution}</Text>
            {request.policySnapshot?.refundType !== 'replacement_only' && (
              <Text style={styles.refundValue}>{formatAmount(request.refund?.totalAmount || 0, { targetCurrency: request.currency })}</Text>
            )}
          </View>
          {request.status === 'under_review' && (
            <TouchableOpacity
              style={[styles.acceptButton, submitting && styles.disabled]}
              onPress={() => chooseFunding(request)}
              disabled={submitting}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel={request.policySnapshot?.refundType === 'replacement_only' ? 'Approve replacement' : 'Accept return'}
              accessibilityHint="Opens the refund funding confirmation"
              accessibilityState={{ disabled: submitting, busy: requestBusy }}
            >
              {requestBusy
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="checkmark-circle-outline" size={18} color="#fff" />}
              <Text style={styles.acceptText}>{request.policySnapshot?.refundType === 'replacement_only' ? 'Approve replacement' : 'Accept return'}</Text>
            </TouchableOpacity>
          )}
          {request.status === 'accepted_pending_payment' && (
            <TouchableOpacity
              style={[styles.acceptButton, styles.paymentButton, submitting && styles.disabled]}
              onPress={() => accept(request, 'card')}
              disabled={submitting}
              activeOpacity={0.78}
              accessibilityRole="button"
              accessibilityLabel="Resume refund payment"
              accessibilityHint="Opens the secure Stripe payment page"
              accessibilityState={{ disabled: submitting, busy: requestBusy }}
            >
              {requestBusy
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="card-outline" size={18} color="#fff" />}
              <Text style={styles.acceptText}>Resume payment</Text>
            </TouchableOpacity>
          )}
        </View>

        {transitions.length > 0 && (
          <View style={styles.actionSection}>
            <Text style={styles.actionLabel}>Next action</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.actions}
              keyboardShouldPersistTaps="handled"
            >
              {transitions.map(nextStatus => {
                const isReject = nextStatus === 'rejected';
                const label = ACTION_LABELS[nextStatus] || RETURN_STATUS_LABELS[nextStatus] || nextStatus;
                return (
                  <TouchableOpacity
                    key={nextStatus}
                    style={[styles.actionButton, isReject && styles.rejectButton, submitting && styles.disabled]}
                    onPress={() => { setNote(''); setDialog({ request, status: nextStatus }); }}
                    disabled={submitting}
                    activeOpacity={0.76}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityHint={`Updates return ${request.returnNumber} after confirmation`}
                    accessibilityState={{ disabled: submitting }}
                  >
                    <Ionicons
                      name={ACTION_ICONS[nextStatus] || 'arrow-forward-outline'}
                      size={15}
                      color={isReject ? palette.colors.error : palette.colors.primary}
                    />
                    <Text style={[styles.actionText, isReject && styles.rejectText]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {request.statusHistory?.length > 0 && (
          <View style={styles.history}>
            <View style={styles.historyHeader}>
              <View style={styles.historyHeading}>
                <Ionicons name="time-outline" size={15} color={palette.colors.textSecondary} />
                <Text style={styles.historyLabel}>Activity</Text>
              </View>
              <Text style={styles.historyCount}>{request.statusHistory.length} updates</Text>
            </View>
            {request.statusHistory.map((entry, index) => {
              const changedAt = formatDateTime(entry.changedAt);
              return (
                <View key={`${entry.status}-${entry.changedAt}-${index}`} style={styles.historyRow}>
                  <View style={styles.timelineRail}>
                    <View style={[styles.dot, { backgroundColor: returnStatusColor(entry.status, palette) }]} />
                    {index < request.statusHistory.length - 1 && <View style={styles.timelineLine} />}
                  </View>
                  <View style={styles.historyCopy}>
                    <Text style={styles.historyTitle}>{RETURN_STATUS_LABELS[entry.status] || entry.status}</Text>
                    {!!changedAt && <Text style={styles.historyText}>{changedAt}</Text>}
                    {!!entry.note && <Text style={styles.historyNote}>{entry.note}</Text>}
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </GlassPanel>
    );
  };

  const initialLoading = loading && !hasLoaded;
  const filterActive = status !== 'all' || !!search.trim();
  const summary = summarizeSellerReturns(requests);
  const activeFilterLabel = STATUS_FILTERS.find(([value]) => value === status)?.[1] || 'All';

  const filterHeader = (
    <View>
      {header}
      {initialLoading ? (
        <ReturnFiltersSkeleton styles={styles} />
      ) : (
        <GlassPanel variant="strong" style={styles.filtersCard}>
          <View style={styles.filterHeadingRow}>
            <View style={styles.filterIcon}>
              <Ionicons name="return-down-back-outline" size={20} color={palette.colors.primary} />
            </View>
            <View style={styles.filterHeadingCopy}>
              <Text style={styles.filterEyebrow}>RETURN OPERATIONS</Text>
              <Text style={styles.filterTitle}>Return requests</Text>
              <Text style={styles.filterSubtitle}>
                {loadError ? 'Last successful results remain below.' : `${activeFilterLabel} returns in this view`}
              </Text>
            </View>
            {hasLoaded && !loading && (
              <View style={styles.resultCount} accessible accessibilityLabel={`${summary.total} returns shown`}>
                <Text style={styles.resultCountValue}>{summary.total}</Text>
                <Text style={styles.resultCountLabel}>shown</Text>
              </View>
            )}
          </View>

          {hasLoaded && !loading && (summary.actionable > 0 || summary.paymentDue > 0) && (
            <View style={styles.summaryPills}>
              {summary.actionable > 0 && (
                <View style={[styles.summaryPill, styles.actionablePill]}>
                  <Ionicons name="flash-outline" size={13} color={palette.colors.primary} />
                  <Text style={[styles.summaryPillText, { color: palette.colors.primary }]}>{summary.actionable} need action</Text>
                </View>
              )}
              {summary.paymentDue > 0 && (
                <View style={[styles.summaryPill, styles.paymentDuePill]}>
                  <Ionicons name="card-outline" size={13} color={palette.colors.warningDark || palette.colors.warning} />
                  <Text style={[styles.summaryPillText, { color: palette.colors.warningDark || palette.colors.warning }]}>{summary.paymentDue} payment due</Text>
                </View>
              )}
            </View>
          )}

          <View style={styles.searchWrap}>
            <Ionicons name="search-outline" size={18} color={palette.colors.textSecondary} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search return number, order or reason"
              placeholderTextColor={palette.colors.textSecondary}
              style={styles.searchInput}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Search return requests"
            />
            {!!search && (
              <TouchableOpacity
                style={styles.clearSearch}
                onPress={() => setSearch('')}
                activeOpacity={0.72}
                accessibilityRole="button"
                accessibilityLabel="Clear return search"
              >
                <Ionicons name="close" size={16} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.statusLabel}>STATUS</Text>
          <FlatList
            horizontal
            data={STATUS_FILTERS}
            keyExtractor={item => item[0]}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.statusFilters}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: [value, label] }) => {
              const selected = status === value;
              return (
                <TouchableOpacity
                  style={[styles.filterChip, selected && styles.filterChipActive]}
                  onPress={() => setStatus(value)}
                  activeOpacity={0.76}
                  accessibilityRole="tab"
                  accessibilityLabel={`Show ${label.toLowerCase()} returns`}
                  accessibilityState={{ selected }}
                >
                  {selected && <Ionicons name="checkmark" size={13} color="#fff" />}
                  <Text style={[styles.filterText, selected && styles.filterTextActive]}>{label}</Text>
                </TouchableOpacity>
              );
            }}
          />

          {filterActive && (
            <TouchableOpacity
              style={styles.clearFilters}
              onPress={clearFilters}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel="Clear all return filters"
            >
              <Ionicons name="refresh-outline" size={14} color={palette.colors.textSecondary} />
              <Text style={styles.clearFiltersText}>Clear filters</Text>
            </TouchableOpacity>
          )}

          {loading && hasLoaded && (
            <View style={styles.updatingResults} accessibilityLiveRegion="polite">
              <Skeleton width="100%" height={4} radius={2} />
              <Text style={styles.updatingText}>Updating results...</Text>
            </View>
          )}
        </GlassPanel>
      )}

      {!!loadError && hasLoaded && (
        <SellerInlineError
          compact
          title="Returns did not refresh"
          message={`${loadError} Showing the last successfully loaded results.`}
          onRetry={onRefresh}
        />
      )}
    </View>
  );

  const emptyContent = (() => {
    if (initialLoading) return <ReturnListSkeleton styles={styles} />;
    if (!hasLoaded && loadError) {
      return (
        <View style={styles.fullError}>
          <SellerInlineError
            title="Returns unavailable"
            message={loadError}
            onRetry={() => load()}
          />
        </View>
      );
    }
    if (loading && hasLoaded) return <ReturnListSkeleton styles={styles} rows={2} />;
    if (loadError) return null;
    return (
      <SellerEmptyState
        icon="return-down-back-outline"
        title={filterActive ? 'No matching returns' : 'No return requests yet'}
        message={filterActive
          ? 'Try another status or clear your search to see more requests.'
          : 'New buyer return requests will appear here with their refund and replacement details.'}
        actionLabel={filterActive ? 'Clear filters' : undefined}
        onAction={filterActive ? clearFilters : undefined}
      />
    );
  })();

  const visibleRequests = loading && hasLoaded ? [] : requests;
  const rejectionNoteInvalid = dialog?.status === 'rejected' && note.trim().length < 5;
  const confirmDisabled = submitting || rejectionNoteInvalid;

  return (
    <>
      <FlatList
        data={visibleRequests}
        keyExtractor={item => String(item._id)}
        renderItem={renderRequest}
        ListHeaderComponent={filterHeader}
        ListEmptyComponent={emptyContent}
        contentContainerStyle={styles.list}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={palette.colors.primary}
            colors={[palette.colors.primary]}
          />
        )}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={6}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
      />

      <Modal
        visible={!!dialog}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => !submitting && setDialog(null)}
      >
        <View
          style={styles.modalOverlay}
          accessibilityViewIsModal
        >
          <GlassPanel variant="strong" style={styles.modalCard}>
            <KeyboardAwareFormScrollView
              contentContainerStyle={styles.modalContent}
            >
              <View style={styles.modalHeader}>
                <View style={[styles.modalIcon, dialog?.status === 'rejected' && styles.modalRejectIcon]}>
                  <Ionicons
                    name={dialog?.status === 'rejected' ? 'close-circle-outline' : ACTION_ICONS[dialog?.status] || 'git-branch-outline'}
                    size={22}
                    color={dialog?.status === 'rejected' ? palette.colors.error : palette.colors.primary}
                  />
                </View>
                <View style={styles.modalTitleCopy}>
                  <Text style={styles.modalEyebrow}>CONFIRM STATUS</Text>
                  <Text style={styles.modalTitle}>{ACTION_LABELS[dialog?.status] || 'Update return'}</Text>
                  <Text style={styles.meta}>Return #{dialog?.request?.returnNumber} - Order #{dialog?.request?.orderId}</Text>
                </View>
                <TouchableOpacity
                  style={styles.closeButton}
                  onPress={() => setDialog(null)}
                  disabled={submitting}
                  activeOpacity={0.72}
                  accessibilityRole="button"
                  accessibilityLabel="Close return update"
                  accessibilityState={{ disabled: submitting }}
                >
                  <Ionicons name="close" size={20} color={palette.colors.text} />
                </TouchableOpacity>
              </View>

              <View style={styles.modalNotice}>
                <Ionicons name="notifications-outline" size={17} color={palette.colors.primary} />
                <Text style={styles.modalNoticeText}>The buyer will be notified when you confirm this update.</Text>
              </View>

              <Text style={styles.noteLabel}>{dialog?.status === 'rejected' ? 'Rejection reason' : 'Note for buyer (optional)'}</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                multiline
                maxLength={1000}
                textAlignVertical="top"
                placeholder={dialog?.status === 'rejected' ? 'Explain why this return cannot be accepted.' : 'Add pickup, shipping or review details.'}
                placeholderTextColor={palette.colors.textSecondary}
                style={[styles.noteInput, rejectionNoteInvalid && note.length > 0 && styles.noteInputError]}
                accessibilityLabel={dialog?.status === 'rejected' ? 'Required rejection reason' : 'Optional note for buyer'}
              />
              <View style={styles.noteMetaRow}>
                <Text
                  style={[styles.noteHelper, rejectionNoteInvalid && styles.noteHelperError]}
                  accessibilityLiveRegion="polite"
                >
                  {dialog?.status === 'rejected' ? 'At least 5 characters required' : 'Keep the update clear and useful.'}
                </Text>
                <Text style={styles.characterCount}>{note.length}/1000</Text>
              </View>

              <TouchableOpacity
                style={[
                  styles.confirmButton,
                  dialog?.status === 'rejected' && styles.confirmReject,
                  confirmDisabled && styles.disabled,
                ]}
                onPress={updateStatus}
                disabled={confirmDisabled}
                activeOpacity={0.78}
                accessibilityRole="button"
                accessibilityLabel={dialog?.status === 'rejected' ? 'Confirm return rejection' : 'Confirm return status update'}
                accessibilityState={{ disabled: confirmDisabled, busy: submitting }}
              >
                {submitting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Ionicons name={dialog?.status === 'rejected' ? 'close-outline' : 'checkmark-outline'} size={18} color="#fff" />}
                <Text style={styles.confirmText}>{dialog?.status === 'rejected' ? 'Reject return' : 'Confirm update'}</Text>
              </TouchableOpacity>
            </KeyboardAwareFormScrollView>
          </GlassPanel>
        </View>
      </Modal>
    </>
  );
}

const buildStyles = (p) => StyleSheet.create({
  list: {
    flexGrow: 1,
    width: '100%',
    maxWidth: 840,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 112,
  },
  filtersCard: { padding: spacing.lg, marginBottom: spacing.lg, borderRadius: borderRadius.xxl },
  filterHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  filterIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  filterHeadingCopy: { flex: 1, minWidth: 0 },
  filterEyebrow: { color: p.colors.primary, fontSize: 9, letterSpacing: 1.2, fontWeight: fontWeight.extrabold },
  filterTitle: { marginTop: 2, color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  filterSubtitle: { marginTop: 2, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 16 },
  resultCount: { minWidth: 58, minHeight: 42, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 15, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  resultCountValue: { color: p.colors.primary, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  resultCountLabel: { marginTop: -2, color: p.colors.textSecondary, fontSize: 8, fontWeight: fontWeight.bold, textTransform: 'uppercase' },
  summaryPills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  summaryPill: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, borderRadius: borderRadius.full, borderWidth: 1 },
  actionablePill: { backgroundColor: p.colors.primarySubtle, borderColor: p.colors.primaryLighter },
  paymentDuePill: { backgroundColor: p.colors.warningSubtle, borderColor: p.colors.warningLighter },
  summaryPillText: { fontSize: 10, fontWeight: fontWeight.bold },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 50, marginTop: spacing.lg, paddingHorizontal: spacing.md, borderRadius: 15, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, paddingVertical: spacing.sm },
  clearSearch: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: p.colors.primarySubtle },
  statusLabel: { marginTop: spacing.md, marginBottom: spacing.sm, color: p.colors.textSecondary, fontSize: 9, letterSpacing: 1, fontWeight: fontWeight.extrabold },
  statusFilters: { gap: spacing.sm, paddingRight: spacing.sm },
  filterChip: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: spacing.md, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  filterChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  filterText: { color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  filterTextActive: { color: '#fff' },
  clearFilters: { alignSelf: 'flex-start', minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.sm, paddingHorizontal: spacing.sm },
  clearFiltersText: { color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  updatingResults: { marginTop: spacing.md },
  updatingText: { marginTop: 5, color: p.colors.textSecondary, fontSize: 10, textAlign: 'center' },
  card: { padding: spacing.lg, marginBottom: spacing.lg, borderRadius: borderRadius.xxl },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  returnIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  cardTitleCopy: { flex: 1, minWidth: 132, paddingTop: 2 },
  returnNumber: { color: p.colors.text, fontSize: fontSize.md, fontWeight: fontWeight.extrabold },
  meta: { marginTop: 3, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  badge: { maxWidth: '48%', minHeight: 29, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, borderWidth: 1 },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { flexShrink: 1, fontSize: 9, fontWeight: fontWeight.extrabold, textAlign: 'center' },
  metaPills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  metaPill: { maxWidth: '100%', minHeight: 31, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  metaPillText: { flexShrink: 1, color: p.colors.textSecondary, fontSize: 10, fontWeight: fontWeight.semibold },
  reasonBox: { padding: spacing.md, borderRadius: 16, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter, marginBottom: spacing.lg },
  reasonHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  reasonIcon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: p.glass.bgSubtle },
  reasonCopy: { flex: 1 },
  reasonLabel: { color: p.colors.textSecondary, fontSize: 9, letterSpacing: 0.8, fontWeight: fontWeight.extrabold, textTransform: 'uppercase' },
  reasonCategory: { marginTop: 1, color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  reasonBody: { marginTop: spacing.sm, color: p.colors.text, fontSize: fontSize.sm, lineHeight: 20 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  sectionTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  sectionCount: { color: p.colors.textSecondary, fontSize: 10, fontWeight: fontWeight.semibold },
  itemsBox: { overflow: 'hidden', borderRadius: 15, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  itemRow: { minHeight: 53, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  itemRowDivider: { borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  quantityBadge: { minWidth: 32, height: 28, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5, borderRadius: 9, backgroundColor: p.colors.primarySubtle },
  quantityText: { color: p.colors.primary, fontSize: 10, fontWeight: fontWeight.extrabold },
  itemName: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, lineHeight: 18 },
  itemPrice: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  refundBox: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.lg, padding: spacing.md, borderRadius: 17, backgroundColor: p.colors.successSubtle, borderWidth: 1, borderColor: p.colors.successLighter },
  refundIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: p.glass.bgSubtle },
  refundCopy: { flex: 1, minWidth: 135 },
  refundLabel: { color: p.colors.textSecondary, fontSize: 9, letterSpacing: 0.8, fontWeight: fontWeight.extrabold, textTransform: 'uppercase' },
  refundResolution: { marginTop: 2, color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  refundValue: { marginTop: 3, color: p.colors.successDark || p.colors.success, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  acceptButton: { minHeight: 43, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: spacing.md, borderRadius: 13, backgroundColor: p.colors.success },
  paymentButton: { backgroundColor: p.colors.warningDark || p.colors.warning },
  acceptText: { maxWidth: 118, color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold, textAlign: 'center' },
  actionSection: { marginTop: spacing.lg },
  actionLabel: { marginBottom: spacing.sm, color: p.colors.textSecondary, fontSize: 9, letterSpacing: 0.9, fontWeight: fontWeight.extrabold, textTransform: 'uppercase' },
  actions: { gap: spacing.sm, paddingRight: spacing.sm },
  actionButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, borderRadius: 13, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  actionText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  rejectButton: { backgroundColor: p.colors.errorSubtle, borderColor: p.colors.errorLighter },
  rejectText: { color: p.colors.error },
  history: { marginTop: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.md },
  historyHeading: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  historyLabel: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  historyCount: { color: p.colors.textSecondary, fontSize: 9, fontWeight: fontWeight.semibold },
  historyRow: { minHeight: 42, flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm },
  timelineRail: { width: 12, alignItems: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 3 },
  timelineLine: { width: 1, flex: 1, minHeight: 24, marginVertical: 3, backgroundColor: p.glass.borderStrong },
  historyCopy: { flex: 1, paddingBottom: spacing.md },
  historyTitle: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  historyText: { marginTop: 2, color: p.colors.textSecondary, fontSize: 10, lineHeight: 15 },
  historyNote: { marginTop: 4, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17, fontStyle: 'italic' },
  fullError: { paddingVertical: spacing.lg },
  skeletonList: { gap: spacing.lg },
  skeletonCard: { padding: spacing.lg, borderRadius: borderRadius.xxl },
  skeletonCardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  skeletonCopy: { flex: 1, minWidth: 0 },
  skeletonGap: { marginTop: spacing.sm },
  skeletonSectionGap: { marginTop: spacing.lg },
  skeletonChips: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  skeletonCardFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  modalOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: 'rgba(15,23,42,0.66)' },
  modalCard: { width: '100%', maxWidth: 540, maxHeight: '88%', padding: 0, borderRadius: borderRadius.xxxl },
  modalContent: { padding: spacing.lg },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  modalIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  modalRejectIcon: { backgroundColor: p.colors.errorSubtle, borderColor: p.colors.errorLighter },
  modalTitleCopy: { flex: 1, minWidth: 0 },
  modalEyebrow: { color: p.colors.primary, fontSize: 9, letterSpacing: 1.1, fontWeight: fontWeight.extrabold },
  modalTitle: { marginTop: 2, color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  closeButton: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  modalNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.lg, padding: spacing.md, borderRadius: 14, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  modalNoticeText: { flex: 1, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 18 },
  noteLabel: { marginTop: spacing.lg, marginBottom: spacing.sm, color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  noteInput: { minHeight: 128, borderRadius: 15, padding: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, color: p.colors.text, fontSize: fontSize.sm, lineHeight: 20 },
  noteInputError: { borderColor: p.colors.error },
  noteMetaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.sm },
  noteHelper: { flex: 1, color: p.colors.textSecondary, fontSize: 10 },
  noteHelperError: { color: p.colors.error },
  characterCount: { color: p.colors.textSecondary, fontSize: 10 },
  confirmButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg, borderRadius: 15, backgroundColor: p.colors.primary },
  confirmReject: { backgroundColor: p.colors.error },
  confirmText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  disabled: { opacity: 0.5 },
});
