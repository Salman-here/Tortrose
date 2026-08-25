import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../../config/api';
import Feedback from '../../utils/feedback';
import {
  formatSellerAdsUsdCents,
  inspectSellerAdsMutationResponse,
  inspectSellerAdsOverview,
  isCanonicalSellerAdsObjectId,
  selectSellerAdsOverviewOwnership,
  selectSellerAdsProductMoney,
  sellerAdsOverviewReflectsMutation,
} from '../../utils/sellerAdsSafety';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
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

const ADS_OVERVIEW_ENDPOINT = '/api/ads/seller/overview';
const ADS_REQUEST_ENDPOINT = '/api/ads/seller/request';
const NOTE_LIMIT = 500;

export const ADS_REQUEST_LABELS = Object.freeze({
  start: 'Start ads',
  update: 'Change products',
  stop: 'Stop ads',
});
const ADS_REQUEST_TYPES = new Set(Object.keys(ADS_REQUEST_LABELS));

const toId = (value) => String(value?._id || value || '').trim();

const uniqueIds = (values = []) => [
  ...new Set((Array.isArray(values) ? values : []).map(toId).filter(Boolean)),
];

const requestProductIds = (request) => {
  const explicitIds = uniqueIds(request?.productIds);
  return explicitIds.length ? explicitIds : uniqueIds(request?.products);
};

export const getAdProductImage = (product) => {
  if (typeof product?.image === 'string' && product.image.trim()) return product.image;
  const firstImage = product?.images?.[0];
  if (typeof firstImage === 'string') return firstImage;
  return firstImage?.url || firstImage?.secure_url || '';
};

export const getAdsDraftFromOverview = (overview) => {
  const activeIds = requestProductIds(overview?.activeRequest);
  const firstPending = overview?.pendingRequests?.[0];
  const pendingIds = requestProductIds(firstPending);
  const requestedIds = activeIds.length ? activeIds : pendingIds;
  const eligibleIds = Array.isArray(overview?.featuredProducts)
    ? new Set(uniqueIds(overview.featuredProducts))
    : null;

  return {
    // A previously approved product can later stop being featured. Keep the
    // editor draft restricted to IDs the current overview says are eligible,
    // otherwise an unchanged update would be rejected by the API.
    selectedIds: eligibleIds
      ? requestedIds.filter((id) => eligibleIds.has(id))
      : requestedIds,
    includeMeta: Boolean(
      overview?.activeRequest?.channels?.meta
      || firstPending?.channels?.meta
    ),
  };
};

export const buildAdsRequestPayload = ({
  requestType,
  selectedIds,
  includeMeta,
  sellerNote,
}) => {
  if (!ADS_REQUEST_TYPES.has(requestType)) {
    throw new TypeError('Ads request type must be start, update, or stop.');
  }
  if (!Array.isArray(selectedIds) || !selectedIds.every(isCanonicalSellerAdsObjectId)) {
    throw new TypeError('Ads request product IDs must be canonical ObjectId strings.');
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new TypeError('Ads request product IDs must be unique.');
  }
  if (requestType !== 'stop' && selectedIds.length === 0) {
    throw new TypeError('Ads requests require at least one product.');
  }
  if (typeof includeMeta !== 'boolean') {
    throw new TypeError('Ads Meta channel selection must be a boolean.');
  }
  if (typeof sellerNote !== 'string') {
    throw new TypeError('Ads request note must be a string.');
  }
  const trimmedNote = sellerNote.trim();
  if (trimmedNote.length > NOTE_LIMIT) {
    throw new TypeError(`Ads request note cannot exceed ${NOTE_LIMIT} characters.`);
  }

  return {
    requestType,
    productIds: requestType === 'stop' ? [] : [...selectedIds],
    includeMeta: requestType === 'stop' ? false : includeMeta,
    sellerNote: trimmedNote,
  };
};

export const validateAdsRequest = ({ overview, requestType, selectedIds, includeMeta }) => {
  const hasPending = (overview?.pendingRequests || []).length > 0;
  const hasActive = Boolean(overview?.activeRequest?.active);

  if (!overview?.isElite) return { valid: false, code: 'elite_required' };
  if (hasPending) return { valid: false, code: 'pending_request' };
  if (requestType === 'start' && hasActive) {
    return { valid: false, code: 'active_campaign' };
  }
  if (requestType === 'update' && !hasActive) {
    return { valid: false, code: 'no_active_campaign' };
  }
  if (requestType === 'stop' && !hasActive) return { valid: false, code: 'no_active_campaign' };
  if (requestType !== 'stop' && uniqueIds(selectedIds).length === 0) {
    return { valid: false, code: 'products_required' };
  }
  if (requestType !== 'stop' && includeMeta && !overview?.subscription?.metaAdsIncluded) {
    return { valid: false, code: 'meta_addon_required' };
  }
  return { valid: true, code: null };
};

const errorMessage = (error, fallback) => (
  error?.response?.data?.msg
  || error?.response?.data?.message
  || error?.message
  || fallback
);

const formatDate = (value) => {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

function StatusPill({ status, active = false, styles, palette }) {
  const resolvedStatus = active ? 'active' : (status || 'pending');
  const config = {
    active: {
      label: 'Active',
      icon: 'sparkles',
      color: palette.colors.success,
      backgroundColor: palette.colors.successSubtle,
    },
    pending: {
      label: 'Pending',
      icon: 'time-outline',
      color: palette.colors.warningDark || palette.colors.warning,
      backgroundColor: palette.colors.warningSubtle,
    },
    approved: {
      label: 'Approved',
      icon: 'checkmark-circle-outline',
      color: palette.colors.success,
      backgroundColor: palette.colors.successSubtle,
    },
    rejected: {
      label: 'Rejected',
      icon: 'close-circle-outline',
      color: palette.colors.error,
      backgroundColor: palette.colors.errorSubtle,
    },
  }[resolvedStatus] || {
    label: resolvedStatus,
    icon: 'information-circle-outline',
    color: palette.colors.info,
    backgroundColor: palette.colors.infoSubtle,
  };

  return (
    <View
      style={[styles.statusPill, { backgroundColor: config.backgroundColor }]}
      accessibilityLabel={`Campaign status: ${config.label}`}
    >
      <Ionicons name={config.icon} size={12} color={config.color} />
      <Text style={[styles.statusPillText, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

function RequestSummary({ request, styles, palette, compact = false }) {
  if (!request) return null;
  const products = Array.isArray(request.products) ? request.products : [];
  const productNames = products.map((product) => product?.name).filter(Boolean);
  const productCount = requestProductIds(request).length;
  const createdAt = request.createdAt || request.updatedAt;
  const productsLabel = request.requestType === 'stop'
    ? 'No products - campaign stop requested'
    : productNames.length
      ? productNames.join(', ')
      : `${productCount} featured product${productCount === 1 ? '' : 's'}`;

  return (
    <View style={[styles.requestSummary, compact && styles.requestSummaryCompact]}>
      <View style={styles.requestSummaryHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.requestTitle}>
            {ADS_REQUEST_LABELS[request.requestType] || 'Ads request'}
          </Text>
          <Text style={styles.requestDate}>Submitted {formatDate(createdAt)}</Text>
        </View>
        <StatusPill
          status={request.status}
          active={request.active}
          styles={styles}
          palette={palette}
        />
      </View>

      <View style={styles.requestMetaRow}>
        <Ionicons name="cube-outline" size={14} color={palette.colors.textSecondary} />
        <Text style={styles.requestMeta} numberOfLines={compact ? 2 : 3}>{productsLabel}</Text>
      </View>
      <View style={styles.requestMetaRow}>
        <Ionicons name="megaphone-outline" size={14} color={palette.colors.textSecondary} />
        <Text style={styles.requestMeta}>
          TikTok{request.channels?.meta ? ' + Meta' : ''}
        </Text>
      </View>

      {!!request.sellerNote && !compact && (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>Your note</Text>
          <Text style={styles.noteText}>{request.sellerNote}</Text>
        </View>
      )}
      {!!request.adminNote && (
        <View style={[styles.noteBox, styles.adminNoteBox]}>
          <Text style={[styles.noteLabel, { color: palette.colors.primary }]}>Rozare team note</Text>
          <Text style={styles.noteText}>{request.adminNote}</Text>
        </View>
      )}
    </View>
  );
}

export default function SellerAdsScreen({ navigation }) {
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const hasLoadedRef = useRef(false);
  const mountedRef = useRef(true);
  const overviewGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);

  const [overview, setOverview] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [includeMeta, setIncludeMeta] = useState(false);
  const [sellerNote, setSellerNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [loadError, setLoadError] = useState('');

  const clearOverviewPresentation = useCallback(() => {
    setOverview(null);
    setSelectedIds([]);
    setIncludeMeta(false);
    setSellerNote('');
  }, []);

  const applyVerifiedOverview = useCallback((nextOverview) => {
    const draft = getAdsDraftFromOverview(nextOverview);
    setOverview(nextOverview);
    setSelectedIds(draft.selectedIds);
    setIncludeMeta(draft.includeMeta);
  }, []);

  const requestVerifiedOverview = useCallback(async () => {
    const response = await api.get(ADS_OVERVIEW_ENDPOINT);
    const verified = inspectSellerAdsOverview(response.data);
    if (!verified) {
      const contractError = new Error('The ads workspace response could not be verified.');
      contractError.code = 'invalid_ads_overview';
      throw contractError;
    }
    return verified;
  }, []);

  const fetchOverview = useCallback(async ({ showFailureToast = false } = {}) => {
    if (mutationInFlightRef.current) {
      return { status: 'blocked', overview: null };
    }
    const generation = ++overviewGenerationRef.current;
    clearOverviewPresentation();
    setLoading(true);
    setLoadError('');
    try {
      const nextOverview = await requestVerifiedOverview();
      if (!mountedRef.current || generation !== overviewGenerationRef.current) {
        return { status: 'stale', overview: null };
      }
      applyVerifiedOverview(nextOverview);
      return { status: 'committed', overview: nextOverview };
    } catch (error) {
      if (!mountedRef.current || generation !== overviewGenerationRef.current) {
        return { status: 'stale', overview: null };
      }
      const message = errorMessage(error, 'We could not load your ads workspace.');
      clearOverviewPresentation();
      setLoadError(message);
      if (showFailureToast) {
        Feedback.show({ type: 'error', text1: 'Ads unavailable', text2: message });
      }
      return { status: 'failed', overview: null, error };
    } finally {
      if (mountedRef.current && generation === overviewGenerationRef.current) {
        hasLoadedRef.current = true;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyVerifiedOverview, clearOverviewPresentation, requestVerifiedOverview]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      overviewGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      mutationInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    fetchOverview({ showSkeleton: true });
  }, [fetchOverview]);

  useEffect(() => {
    const unsubscribe = navigation?.addListener?.('focus', () => {
      if (hasLoadedRef.current && !mutationInFlightRef.current) fetchOverview();
    });
    return typeof unsubscribe === 'function' ? unsubscribe : undefined;
  }, [fetchOverview, navigation]);

  const featuredProducts = overview?.featuredProducts || [];
  const pendingRequests = overview?.pendingRequests || [];
  const recentRequests = overview?.recentRequests || [];
  const hasPending = pendingRequests.length > 0;
  const activeRequest = overview?.activeRequest || null;
  const hasActive = Boolean(activeRequest?.active);
  const requestType = hasActive ? 'update' : 'start';
  const metaAddonIncluded = Boolean(overview?.subscription?.metaAdsIncluded);
  const metaAddonCents = overview?.metaAdsAddonCents;
  const selectedSet = useMemo(() => new Set(uniqueIds(selectedIds)), [selectedIds]);
  const activeSet = useMemo(() => new Set(requestProductIds(activeRequest)), [activeRequest]);
  const pendingSet = useMemo(
    () => new Set(pendingRequests.flatMap(requestProductIds)),
    [pendingRequests]
  );

  const navigateToSubscription = useCallback(() => {
    navigation.navigate('SellerSubscription');
  }, [navigation]);

  const promptEliteUpgrade = useCallback(() => {
    Alert.alert(
      'Rozare Elite required',
      'Rozare-run TikTok ads for your store and featured products are included with the Elite plan.',
      [
        { text: 'Later', style: 'cancel' },
        { text: 'View Elite', onPress: navigateToSubscription },
      ]
    );
  }, [navigateToSubscription]);

  const promptMetaAddon = useCallback(() => {
    Alert.alert(
      'Meta add-on required',
      `Add Meta ads from Subscription first (+${formatSellerAdsUsdCents(metaAddonCents)}/month). TikTok ads remain included with Elite.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open Subscription', onPress: navigateToSubscription },
      ]
    );
  }, [metaAddonCents, navigateToSubscription]);

  const toggleProduct = useCallback((productId) => {
    const id = toId(productId);
    if (!id) return;
    setSelectedIds((previous) => (
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id]
    ));
  }, []);

  const toggleMeta = useCallback(() => {
    if (includeMeta) {
      setIncludeMeta(false);
      return;
    }
    if (!metaAddonIncluded) {
      promptMetaAddon();
      return;
    }
    setIncludeMeta(true);
  }, [includeMeta, metaAddonIncluded, promptMetaAddon]);

  const submitRequest = useCallback(async (type = requestType) => {
    if (mutationInFlightRef.current) return;
    const validation = validateAdsRequest({
      overview,
      requestType: type,
      selectedIds,
      includeMeta,
    });

    if (!validation.valid) {
      if (validation.code === 'elite_required') {
        promptEliteUpgrade();
        return;
      }
      if (validation.code === 'meta_addon_required') {
        promptMetaAddon();
        return;
      }
      const messages = {
        pending_request: 'Wait for the Rozare team to review your pending request before sending another change.',
        active_campaign: 'Use the campaign update action while an approved campaign is active.',
        no_active_campaign: 'There is no active ads campaign to update or stop.',
        products_required: 'Select at least one featured product for ads.',
      };
      Feedback.show({
        type: validation.code === 'pending_request' ? 'warning' : 'error',
        text1: validation.code === 'pending_request' ? 'Approval pending' : 'Request not ready',
        text2: messages[validation.code] || 'Review your campaign request and try again.',
      });
      return;
    }

    let payload;
    let expectedOwnership;
    try {
      expectedOwnership = selectSellerAdsOverviewOwnership(overview);
      if (!expectedOwnership) throw new TypeError('Ads workspace ownership is unavailable.');
      payload = buildAdsRequestPayload({
        requestType: type,
        selectedIds,
        includeMeta,
        sellerNote,
      });
    } catch {
      clearOverviewPresentation();
      setLoadError('The campaign draft could not be verified. Refresh before trying again.');
      Feedback.show({
        type: 'error',
        text1: 'Campaign draft unavailable',
        text2: 'Refresh your ads workspace before submitting this request.',
      });
      return;
    }
    const mutationGeneration = ++mutationGenerationRef.current;
    mutationInFlightRef.current = true;
    overviewGenerationRef.current += 1;
    clearOverviewPresentation();
    setSubmitting(type);
    setLoading(true);
    setRefreshing(false);
    setLoadError('');

    let mutation = null;
    let submissionError = null;
    let refreshedOverview = null;
    let refreshError = null;

    try {
      const response = await api.post(ADS_REQUEST_ENDPOINT, payload);
      mutation = inspectSellerAdsMutationResponse(response.data, {
        ...payload,
        ...expectedOwnership,
      });
      if (!mutation) {
        submissionError = new Error('The ads request response could not be verified.');
        submissionError.code = 'invalid_ads_mutation_response';
      }
    } catch (error) {
      submissionError = error;
    }

    if (mountedRef.current && mutationGeneration === mutationGenerationRef.current) {
      try {
        refreshedOverview = await requestVerifiedOverview();
      } catch (error) {
        refreshError = error;
      }
    }

    if (!mountedRef.current || mutationGeneration !== mutationGenerationRef.current) return;

    const mutationVerified = Boolean(
      mutation
      && refreshedOverview
      && sellerAdsOverviewReflectsMutation(refreshedOverview, mutation)
    );
    const mayRestoreAfterRejectedSubmission = Boolean(
      submissionError
      && submissionError.code !== 'invalid_ads_mutation_response'
      && refreshedOverview
    );

    if (mutationVerified || mayRestoreAfterRejectedSubmission) {
      applyVerifiedOverview(refreshedOverview);
      setLoadError('');
    } else {
      clearOverviewPresentation();
      const verificationMessage = refreshError
        ? errorMessage(refreshError, 'We could not verify the latest ads workspace.')
        : submissionError?.code === 'invalid_ads_mutation_response'
          ? 'The ads request response could not be verified. Refresh and check your requests before trying again.'
          : 'The submitted request could not be confirmed in a fresh ads workspace.';
      setLoadError(verificationMessage);
    }

    if (mutationVerified) {
      Feedback.show({
        type: 'success',
        text1: type === 'stop' ? 'Stop request sent' : 'Ads request sent',
        text2: mutation.message,
      });
    } else if (submissionError) {
      const responseData = submissionError?.response?.data;
      if (responseData?.requiresElite === true) {
        promptEliteUpgrade();
      } else if (responseData?.requiresMetaAddon === true) {
        promptMetaAddon();
      } else {
        const responseMissing = !submissionError?.response;
        const responseContractFailed = submissionError.code === 'invalid_ads_mutation_response';
        Feedback.show({
          type: submissionError?.response?.status === 409 ? 'warning' : 'error',
          text1: submissionError?.response?.status === 409
            ? 'Request already pending'
            : responseMissing || responseContractFailed
              ? 'Request status unverified'
              : 'Request failed',
          text2: responseContractFailed
            ? 'Refresh and check your campaign requests before trying again.'
            : errorMessage(submissionError, 'We could not confirm your ads request.'),
        });
      }
    } else {
      Feedback.show({
        type: 'error',
        text1: 'Request saved; verification needed',
        text2: refreshError
          ? 'The request was accepted, but the latest campaign state could not be loaded.'
          : 'The request was accepted, but it was not present in the verified campaign state.',
      });
    }

    hasLoadedRef.current = true;
    mutationInFlightRef.current = false;
    setLoading(false);
    setRefreshing(false);
    setSubmitting('');
  }, [
    applyVerifiedOverview,
    clearOverviewPresentation,
    includeMeta,
    overview,
    promptEliteUpgrade,
    promptMetaAddon,
    requestVerifiedOverview,
    requestType,
    selectedIds,
    sellerNote,
  ]);

  const confirmStop = useCallback(() => {
    Alert.alert(
      'Stop Rozare ads?',
      'This sends a stop request to the Rozare team. Your current campaign remains active until the request is approved.',
      [
        { text: 'Keep running', style: 'cancel' },
        { text: 'Send stop request', style: 'destructive', onPress: () => submitRequest('stop') },
      ]
    );
  }, [submitRequest]);

  const refresh = useCallback(() => {
    if (refreshing) return;
    setRefreshing(true);
    fetchOverview({ showFailureToast: true });
  }, [fetchOverview, refreshing]);

  if (loading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Rozare Ads"
        subtitle="Preparing your campaign workspace"
        icon="megaphone-outline"
        variant="list"
        rows={5}
      />
    );
  }

  if (!overview) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader
            navigation={navigation}
            title="Rozare Ads"
            subtitle="TikTok and Meta campaigns"
            icon="megaphone-outline"
            rightIcon="refresh"
            rightLabel="Retry"
            onRightPress={() => fetchOverview({ showSkeleton: true })}
          />
          <ScrollView contentContainerStyle={styles.errorScreen}>
            <SellerInlineError
              title="Ads workspace unavailable"
              message={loadError || 'We could not load your ads workspace.'}
              onRetry={() => fetchOverview({ showSkeleton: true })}
            />
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const primaryDisabled = Boolean(submitting)
    || hasPending
    || featuredProducts.length === 0
    || selectedIds.length === 0;
  const planName = overview.subscription.planName;

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Rozare Ads"
          subtitle="TikTok and Meta campaigns"
          icon="megaphone-outline"
          rightIcon="refresh"
          rightLabel="Refresh"
          onRightPress={refresh}
        />

        <KeyboardAwareFormScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          bottomOffset={32}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={palette.colors.primary}
              colors={[palette.colors.primary]}
            />
          )}
        >
          {!!loadError && (
            <SellerInlineError
              compact
              title="Refresh failed"
              message={loadError}
              onRetry={refresh}
            />
          )}

          <GlassPanel variant="strong" style={styles.hero}>
            <LinearGradient colors={palette.gradients.cta} style={styles.heroIcon}>
              <Ionicons name="megaphone" size={24} color="#fff" />
            </LinearGradient>
            <View style={styles.heroCopy}>
              <Text style={styles.eyebrow}>{overview.store?.storeName || 'YOUR STORE'}</Text>
              <Text style={styles.heroTitle}>Campaign control, without the guesswork</Text>
              <Text style={styles.heroSubtitle}>
                Choose featured products and send a reviewed campaign request. TikTok is included with Elite; Meta uses the optional add-on.
              </Text>
            </View>
            <View style={styles.heroStats}>
              <View style={styles.heroStat}>
                <Text style={styles.heroStatValue}>{planName}</Text>
                <Text style={styles.heroStatLabel}>Current access</Text>
              </View>
              <View style={styles.heroDivider} />
              <View style={styles.heroStat}>
                <Text style={styles.heroStatValue}>{selectedIds.length}</Text>
                <Text style={styles.heroStatLabel}>Selected</Text>
              </View>
              <View style={styles.heroDivider} />
              <View style={styles.heroStat}>
                <Text style={styles.heroStatValue}>{hasPending ? 'Review' : hasActive ? 'Live' : 'Ready'}</Text>
                <Text style={styles.heroStatLabel}>Campaign</Text>
              </View>
            </View>
          </GlassPanel>

          {!overview.isElite && (
            <GlassPanel variant="card" style={styles.upgradeBanner}>
              <View style={styles.upgradeCopyRow}>
                <View style={styles.upgradeIcon}>
                  <Ionicons name="diamond-outline" size={22} color={palette.colors.warningDark || palette.colors.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bannerTitle}>Elite is required to submit ads</Text>
                  <Text style={styles.bannerText}>
                    You can prepare your featured-product selection now, then activate Elite when you are ready to send it for review.
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.upgradeButton}
                onPress={navigateToSubscription}
                accessibilityRole="button"
                accessibilityLabel="View Rozare Elite subscription"
              >
                <Text style={styles.upgradeButtonText}>View Elite</Text>
                <Ionicons name="arrow-forward" size={14} color="#fff" />
              </TouchableOpacity>
            </GlassPanel>
          )}

          {hasActive && (
            <GlassPanel variant="card" style={styles.activeCampaignCard}>
              <SellerSectionHeader
                title="Active campaign"
                subtitle="The products currently approved by the Rozare team"
                icon="radio-outline"
              />
              <RequestSummary request={activeRequest} styles={styles} palette={palette} />
            </GlassPanel>
          )}

          {hasPending && (
            <GlassPanel variant="card" style={styles.pendingCard}>
              <View style={styles.pendingHeading}>
                <View style={styles.pendingIcon}>
                  <Ionicons name="time-outline" size={20} color={palette.colors.warningDark || palette.colors.warning} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pendingTitle}>Approval pending</Text>
                  <Text style={styles.pendingText}>
                    Another request cannot be sent until the Rozare team reviews this one.
                  </Text>
                </View>
              </View>
              <RequestSummary request={pendingRequests[0]} styles={styles} palette={palette} compact />
            </GlassPanel>
          )}

          <GlassPanel variant="strong" style={styles.section}>
            <SellerSectionHeader
              title="Featured products"
              subtitle="Only active featured listings are eligible for campaigns"
              icon="star-outline"
            />

            {featuredProducts.length > 0 && (
              <View style={styles.selectionSummary} accessibilityLiveRegion="polite">
                <Ionicons name="checkmark-circle-outline" size={14} color={palette.colors.primary} />
                <Text style={styles.selectionSummaryText}>
                  {selectedIds.length} of {featuredProducts.length} selected
                </Text>
              </View>
            )}

            {featuredProducts.length === 0 ? (
              <SellerEmptyState
                icon="star-outline"
                title="No featured products yet"
                message="Open Product Management and mark at least one active product as featured before requesting ads."
                actionLabel="Open Product Management"
                onAction={() => navigation.navigate('SellerProductManagement')}
              />
            ) : (
              <View style={styles.productList}>
                {featuredProducts.map((product) => {
                  const id = toId(product?._id);
                  const selected = selectedSet.has(id);
                  const active = activeSet.has(id);
                  const pending = pendingSet.has(id);
                  const imageUrl = getAdProductImage(product);
                  const displayMoney = selectSellerAdsProductMoney(product);

                  return (
                    <TouchableOpacity
                      key={id}
                      style={[styles.productCard, selected && styles.productCardSelected]}
                      onPress={() => toggleProduct(id)}
                      activeOpacity={0.78}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`${selected ? 'Remove' : 'Select'} ${product?.name || 'product'} for ads`}
                    >
                      <View style={styles.productImageWrap}>
                        {imageUrl ? (
                          <Image
                            source={{ uri: imageUrl }}
                            style={styles.productImage}
                            contentFit="cover"
                            transition={160}
                            accessibilityLabel={`${product?.name || 'Product'} image`}
                          />
                        ) : (
                          <View style={styles.productImagePlaceholder}>
                            <Ionicons name="image-outline" size={22} color={palette.colors.textSecondary} />
                          </View>
                        )}
                      </View>
                      <View style={styles.productCopy}>
                        <Text style={styles.productName} numberOfLines={2}>{product?.name || 'Untitled product'}</Text>
                        <Text style={styles.productCategory} numberOfLines={1}>{product?.category || 'Uncategorized'}</Text>
                        <Text style={styles.productPrice}>
                          {formatPrice(displayMoney.amount, {
                            sourceCurrency: displayMoney.currency,
                          })}
                        </Text>
                        {(active || pending) && (
                          <View style={styles.productStatusRow}>
                            {active && <StatusPill active styles={styles} palette={palette} />}
                            {pending && <StatusPill status="pending" styles={styles} palette={palette} />}
                          </View>
                        )}
                      </View>
                      <View style={[styles.checkBox, selected && styles.checkBoxSelected]}>
                        {selected && <Ionicons name="checkmark" size={16} color="#fff" />}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </GlassPanel>

          <GlassPanel variant="strong" style={styles.section}>
            <SellerSectionHeader
              title="Campaign channels"
              subtitle="TikTok is standard; Meta follows your Elite add-on"
              icon="share-social-outline"
            />

            <View style={styles.channelCard}>
              <View style={[styles.channelIcon, { backgroundColor: '#111827' }]}
                accessibilityElementsHidden>
                <Ionicons name="logo-tiktok" size={20} color={palette.colors.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.channelTitle}>TikTok ads</Text>
                <Text style={styles.channelDescription}>Always included with an approved Elite campaign request</Text>
              </View>
              <View style={[styles.channelBadge, { backgroundColor: palette.colors.successSubtle }]}>
                <Ionicons name="checkmark" size={12} color={palette.colors.success} />
                <Text style={[styles.channelBadgeText, { color: palette.colors.success }]}>On</Text>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.channelCard, includeMeta && styles.metaChannelSelected]}
              onPress={toggleMeta}
              activeOpacity={0.78}
              accessibilityRole={includeMeta || metaAddonIncluded ? 'switch' : 'button'}
              accessibilityState={includeMeta || metaAddonIncluded ? { checked: includeMeta } : undefined}
              accessibilityLabel={includeMeta
                ? 'Remove Meta ads from this request'
                : metaAddonIncluded ? 'Include Meta ads' : 'Meta ads add-on required'}
              accessibilityHint={includeMeta
                ? 'Turns Meta ads off so this request can continue without the add-on'
                : metaAddonIncluded ? 'Turns Meta ads on for this request' : 'Opens the Meta add-on prompt'}
            >
              <View style={[styles.channelIcon, { backgroundColor: palette.colors.infoSubtle }]}>
                <Ionicons name="logo-facebook" size={20} color={palette.colors.info} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.channelTitleRow}>
                  <Text style={styles.channelTitle}>Meta ads</Text>
                  {!metaAddonIncluded && <Ionicons name="lock-closed" size={12} color={palette.colors.warning} />}
                </View>
                <Text style={styles.channelDescription}>
                  {includeMeta && !metaAddonIncluded
                    ? `Currently selected; turn off to continue without the add-on (+${formatSellerAdsUsdCents(metaAddonCents)}/month)`
                    : metaAddonIncluded
                    ? `Included in your Elite plan (+${formatSellerAdsUsdCents(metaAddonCents)}/month)`
                    : `Add from Subscription (+${formatSellerAdsUsdCents(metaAddonCents)}/month)`}
                </Text>
              </View>
              <View style={[styles.switchTrack, includeMeta && styles.switchTrackOn]}>
                <View style={[styles.switchThumb, includeMeta && styles.switchThumbOn]} />
              </View>
            </TouchableOpacity>
          </GlassPanel>

          <GlassPanel variant="strong" style={styles.section}>
            <SellerSectionHeader
              title={hasActive ? 'Update campaign' : 'Request a campaign'}
              subtitle="Every campaign change is reviewed before it goes live"
              icon="send-outline"
            />

            <Text style={styles.fieldLabel}>Optional note for the Rozare team</Text>
            <TextInput
              value={sellerNote}
              onChangeText={setSellerNote}
              placeholder="Share campaign goals, audience notes, or product priorities"
              placeholderTextColor={palette.colors.textLight}
              style={styles.noteInput}
              multiline
              maxLength={NOTE_LIMIT}
              textAlignVertical="top"
              editable={!Boolean(submitting)}
              accessibilityLabel="Optional campaign note"
            />
            <Text style={styles.characterCount}>{sellerNote.length}/{NOTE_LIMIT}</Text>

            <TouchableOpacity
              style={[styles.primaryButton, primaryDisabled && styles.buttonDisabled]}
              onPress={() => submitRequest()}
              disabled={primaryDisabled}
              activeOpacity={0.82}
              accessibilityRole="button"
              accessibilityLabel={hasActive ? 'Submit campaign product changes' : 'Run Rozare ads'}
              accessibilityState={{ disabled: primaryDisabled, busy: Boolean(submitting) }}
            >
              <LinearGradient colors={palette.gradients.cta} style={styles.primaryButtonGradient}>
                {submitting === requestType ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="send" size={17} color="#fff" />
                )}
                <Text style={styles.primaryButtonText}>
                  {hasActive ? 'Submit Product Changes' : 'Run Ads'}
                </Text>
              </LinearGradient>
            </TouchableOpacity>

            {hasPending && (
              <Text style={styles.disabledReason}>A request is already waiting for approval.</Text>
            )}
            {!hasPending && featuredProducts.length > 0 && selectedIds.length === 0 && (
              <Text style={styles.disabledReason}>Select at least one featured product to continue.</Text>
            )}

            {hasActive && (
              <TouchableOpacity
                style={[styles.stopButton, (Boolean(submitting) || hasPending) && styles.buttonDisabled]}
                onPress={confirmStop}
                disabled={Boolean(submitting) || hasPending}
                activeOpacity={0.78}
                accessibilityRole="button"
                accessibilityLabel="Request to stop Rozare ads"
                accessibilityState={{ disabled: Boolean(submitting) || hasPending, busy: submitting === 'stop' }}
              >
                {submitting === 'stop' ? (
                  <ActivityIndicator size="small" color={palette.colors.error} />
                ) : (
                  <Ionicons name="stop-circle-outline" size={17} color={palette.colors.error} />
                )}
                <Text style={styles.stopButtonText}>Request to Stop Ads</Text>
              </TouchableOpacity>
            )}
          </GlassPanel>

          <GlassPanel variant="strong" style={styles.section}>
            <SellerSectionHeader
              title="Recent requests"
              subtitle="Approval history and notes from the Rozare team"
              icon="time-outline"
            />
            {recentRequests.length === 0 ? (
              <SellerEmptyState
                icon="paper-plane-outline"
                title="No ads requests yet"
                message="Your first submitted campaign request will appear here with its review status."
              />
            ) : (
              <View style={styles.historyList}>
                {recentRequests.map((request, index) => (
                  <RequestSummary
                    key={toId(request?._id) || `${request?.requestType}-${index}`}
                    request={request}
                    styles={styles}
                    palette={palette}
                  />
                ))}
              </View>
            )}
          </GlassPanel>

          <View style={styles.bottomSpacer} />
        </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const makeStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  scroll: {
    width: '100%',
    maxWidth: 920,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxxl,
  },
  errorScreen: { flexGrow: 1, justifyContent: 'center', paddingVertical: spacing.xxl },
  hero: { padding: spacing.xl },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  heroCopy: { maxWidth: 650 },
  eyebrow: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.extrabold,
    color: p.colors.primary,
    letterSpacing: 1.1,
  },
  heroTitle: {
    marginTop: spacing.xs,
    fontSize: fontSize.xxl,
    lineHeight: 27,
    fontWeight: fontWeight.extrabold,
    color: p.colors.text,
  },
  heroSubtitle: {
    marginTop: spacing.sm,
    fontSize: fontSize.sm,
    lineHeight: 20,
    color: p.colors.textSecondary,
  },
  heroStats: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: p.glass.bgSubtle,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
  },
  heroStat: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs },
  heroStatValue: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text, textAlign: 'center' },
  heroStatLabel: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center' },
  heroDivider: { width: 1, backgroundColor: p.glass.borderStrong, marginVertical: 2 },
  upgradeBanner: {
    marginTop: spacing.md,
    gap: spacing.md,
    borderColor: `${p.colors.warning}45`,
    backgroundColor: p.colors.warningSubtle,
  },
  upgradeCopyRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  upgradeIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${p.colors.warning}18`,
  },
  bannerTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: p.colors.text },
  bannerText: { marginTop: 3, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  upgradeButton: {
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: p.colors.primary,
    alignSelf: 'flex-start',
  },
  upgradeButtonText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  activeCampaignCard: { marginTop: spacing.md, borderColor: `${p.colors.success}38` },
  pendingCard: { marginTop: spacing.md, borderColor: `${p.colors.warning}42` },
  pendingHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, marginBottom: spacing.md },
  pendingIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: p.colors.warningSubtle,
  },
  pendingTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  pendingText: { marginTop: 3, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  section: { marginTop: spacing.md, padding: spacing.lg },
  selectionSummary: {
    alignSelf: 'flex-start',
    minHeight: 28,
    marginTop: -spacing.xs,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: p.colors.primarySubtle,
  },
  selectionSummaryText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.primary },
  productList: { gap: spacing.sm },
  productCard: {
    minHeight: 102,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    backgroundColor: p.glass.bgSubtle,
  },
  productCardSelected: { borderColor: `${p.colors.success}88`, backgroundColor: p.colors.successSubtle },
  productImageWrap: {
    width: 72,
    height: 72,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: p.glass.bgSubtle,
  },
  productImage: { width: '100%', height: '100%' },
  productImagePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  productCopy: { flex: 1, minWidth: 0 },
  productName: { fontSize: fontSize.md, lineHeight: 18, fontWeight: fontWeight.extrabold, color: p.colors.text },
  productCategory: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary, textTransform: 'uppercase' },
  productPrice: { marginTop: spacing.xs, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.primary },
  productStatusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  checkBox: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: p.colors.textLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxSelected: { borderColor: p.colors.success, backgroundColor: p.colors.success },
  statusPill: {
    alignSelf: 'flex-start',
    minHeight: 24,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  statusPillText: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, textTransform: 'capitalize' },
  channelCard: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    backgroundColor: p.glass.bgSubtle,
  },
  metaChannelSelected: { borderColor: `${p.colors.info}72`, backgroundColor: p.colors.infoSubtle },
  channelIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  channelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  channelTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  channelDescription: { marginTop: 3, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  channelBadge: { minHeight: 26, paddingHorizontal: spacing.sm, borderRadius: 13, flexDirection: 'row', alignItems: 'center', gap: 3 },
  channelBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  switchTrack: { width: 44, height: 26, borderRadius: 13, padding: 3, justifyContent: 'center', backgroundColor: p.colors.grayLighter },
  switchTrackOn: { backgroundColor: p.colors.info },
  switchThumb: { width: 20, height: 20, borderRadius: 10, backgroundColor: p.colors.white },
  switchThumbOn: { alignSelf: 'flex-end' },
  fieldLabel: { marginBottom: spacing.sm, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  noteInput: {
    minHeight: 112,
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: p.glass.borderStrong,
    backgroundColor: p.glass.bgSubtle,
    fontSize: fontSize.md,
    lineHeight: 20,
    color: p.colors.text,
  },
  characterCount: { marginTop: spacing.xs, textAlign: 'right', fontSize: fontSize.xs, color: p.colors.textSecondary },
  primaryButton: { minHeight: 50, marginTop: spacing.md, borderRadius: 16, overflow: 'hidden' },
  primaryButtonGradient: { flex: 1, minHeight: 50, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  primaryButtonText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.extrabold },
  buttonDisabled: { opacity: 0.5 },
  disabledReason: { marginTop: spacing.sm, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary, textAlign: 'center' },
  stopButton: {
    minHeight: 46,
    marginTop: spacing.sm,
    borderRadius: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: p.colors.errorSubtle,
    borderWidth: 1,
    borderColor: `${p.colors.error}38`,
  },
  stopButtonText: { color: p.colors.error, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  historyList: { gap: spacing.sm },
  requestSummary: {
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: p.glass.borderSubtle,
    backgroundColor: p.glass.bgSubtle,
  },
  requestSummaryCompact: { marginTop: spacing.xs },
  requestSummaryHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  requestTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  requestDate: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  requestMetaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.sm },
  requestMeta: { flex: 1, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.textSecondary },
  noteBox: { marginTop: spacing.sm, padding: spacing.sm, borderRadius: 12, backgroundColor: p.glass.bgSubtle },
  adminNoteBox: { borderLeftWidth: 3, borderLeftColor: p.colors.primary },
  noteLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, color: p.colors.textSecondary },
  noteText: { marginTop: 2, fontSize: fontSize.xs, lineHeight: 17, color: p.colors.text },
  bottomSpacer: { height: 72 },
});
