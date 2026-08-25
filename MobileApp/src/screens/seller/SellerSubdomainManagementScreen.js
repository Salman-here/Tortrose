import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Linking,
  Platform,
  RefreshControl,
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
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import api from '../../config/api';
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
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';
import { subdomainAnalyticsResponseIsValid } from '../../utils/subdomainAnalyticsSafety';

const SUBDOMAIN_RETURN_URL = 'rozare://seller-subdomain';
const SLUG_COOLDOWN_DAYS = 30;

export const sanitizeSubdomain = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, '')
  .replace(/^-+|-+$/g, '')
  .replace(/-{2,}/g, '-')
  .slice(0, 50);

export const getSubdomainCooldown = (lastChangedAt, nowValue = Date.now()) => {
  if (!lastChangedAt) return { canChange: true, daysRemaining: 0, nextAllowedAt: null };
  const changedAt = new Date(lastChangedAt).getTime();
  if (!Number.isFinite(changedAt)) return { canChange: true, daysRemaining: 0, nextAllowedAt: null };
  const nextAllowedAt = changedAt + SLUG_COOLDOWN_DAYS * 86400000;
  const remaining = nextAllowedAt - Number(nowValue);
  return {
    canChange: remaining <= 0,
    daysRemaining: remaining > 0 ? Math.max(1, Math.ceil(remaining / 86400000)) : 0,
    nextAllowedAt: new Date(nextAllowedAt).toISOString(),
  };
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export const resolveSubdomainOwnershipTerms = (value) => {
  const directMinor = value?.priceMinor;
  const legacyMajor = value?.price;
  const hasDirectMinor = Number.isSafeInteger(directMinor) && directMinor >= 0;
  const amountMinor = hasDirectMinor
    ? directMinor
    : (typeof legacyMajor === 'number'
      && Number.isFinite(legacyMajor)
      && legacyMajor >= 0
      && Number.isSafeInteger(Math.round(legacyMajor * 100))
      && Math.round(legacyMajor * 100) / 100 === legacyMajor
      ? Math.round(legacyMajor * 100)
      : null);
  const currency = typeof value?.priceCurrency === 'string'
    ? value.priceCurrency.trim().toUpperCase()
    : (!hasDirectMinor && amountMinor !== null ? 'USD' : '');
  const years = Number.isSafeInteger(value?.ownershipYears) && value.ownershipYears > 0
    ? value.ownershipYears
    : null;
  if (amountMinor === null || currency !== 'USD' || years === null) return null;
  return {
    amountMinor,
    currency,
    years,
    priceLabel: `$${(amountMinor / 100).toFixed(2)} ${currency}`,
  };
};

const validDateOrNull = (value) => (
  value === null
  || (typeof value === 'string' && Number.isFinite(new Date(value).getTime()))
  || (value instanceof Date && Number.isFinite(value.getTime()))
);

export const subdomainOwnershipResponseIsValid = (value) => {
  const state = value?.ownership;
  const slug = value?.subdomain;
  return Boolean(
    resolveSubdomainOwnershipTerms(value)
    && typeof slug === 'string'
    && /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/.test(slug)
    && value?.url === `${slug}.rozare.com`
    && state
    && typeof state.isPurchased === 'boolean'
    && typeof state.isOwned === 'boolean'
    && (!state.isOwned || state.isPurchased)
    && validDateOrNull(state.purchasedAt)
    && validDateOrNull(state.expiresAt)
    && Number.isSafeInteger(state.daysRemaining)
    && state.daysRemaining >= 0
    && (!state.isOwned || (state.daysRemaining >= 1 && state.expiresAt))
    && (state.isOwned || state.daysRemaining === 0)
  );
};

function MetricCard({ icon, label, value, color, styles }) {
  return (
    <GlassPanel variant="card" style={styles.metricCard}>
      <View style={[styles.metricIcon, { backgroundColor: `${color}14` }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={styles.metricValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </GlassPanel>
  );
}

export default function SellerSubdomainManagementScreen({ navigation, route }) {
  const { palette } = useTheme();
  const { currency, formatPrice } = useCurrency();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [noStore, setNoStore] = useState(false);
  const [data, setData] = useState(null);
  const [ownership, setOwnership] = useState(null);
  const [editing, setEditing] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [slugChecking, setSlugChecking] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState(null);
  const [slugMessage, setSlugMessage] = useState('');
  const [operation, setOperation] = useState('');
  const checkoutOpenRef = useRef(false);
  const handledReturnRef = useRef('');
  const checkoutRefreshTimersRef = useRef([]);
  const dataRequestRef = useRef(0);
  const availabilityRequestRef = useRef(0);

  const fetchData = useCallback(async () => {
    const requestId = dataRequestRef.current + 1;
    dataRequestRef.current = requestId;
    setLoading(true);
    setData(null);
    setOwnership(null);
    setError('');
    setNoStore(false);
    try {
      const [analyticsResponse, ownershipResponse] = await Promise.all([
        api.get(`/api/subdomain/analytics/seller?currency=${encodeURIComponent(currency)}`),
        api.get('/api/subscription/subdomain/ownership'),
      ]);
      if (dataRequestRef.current !== requestId) return null;
      const nextData = analyticsResponse.data;
      if (!subdomainAnalyticsResponseIsValid(nextData, currency)) {
        throw new Error('Subdomain analytics returned invalid or inconsistent money data.');
      }
      if (!subdomainOwnershipResponseIsValid(ownershipResponse.data)) {
        throw new Error('Subdomain ownership details returned an invalid or inconsistent state.');
      }
      setData(nextData);
      setOwnership(ownershipResponse.data);
      setNewSlug(nextData?.subdomain?.slug || '');
      setSlugAvailable(null);
      setSlugMessage('');
      return nextData;
    } catch (requestError) {
      if (dataRequestRef.current !== requestId) return null;
      const isMissingStore = requestError.response?.status === 404;
      setData(null);
      setOwnership(null);
      setNoStore(isMissingStore);
      setError(requestError.response?.data?.msg || requestError.message || 'Could not load your subdomain details.');
      return null;
    } finally {
      if (dataRequestRef.current === requestId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [currency]);

  const refreshAfterCheckout = useCallback(() => {
    checkoutRefreshTimersRef.current.forEach(clearTimeout);
    checkoutRefreshTimersRef.current = [];
    fetchData();
    checkoutRefreshTimersRef.current = [1500, 4500].map((delay) => (
      setTimeout(() => fetchData(), delay)
    ));
  }, [fetchData]);

  useEffect(() => {
    fetchData({ initial: true });
  }, [currency]);

  useEffect(() => () => {
    checkoutRefreshTimersRef.current.forEach(clearTimeout);
    dataRequestRef.current += 1;
    availabilityRequestRef.current += 1;
  }, []);

  useEffect(() => {
    const listener = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && checkoutOpenRef.current) {
        checkoutOpenRef.current = false;
        refreshAfterCheckout();
      }
    });
    return () => listener.remove();
  }, [refreshAfterCheckout]);

  useEffect(() => {
    const purchaseResult = route?.params?.purchase;
    if (!purchaseResult || handledReturnRef.current === purchaseResult) return;
    handledReturnRef.current = purchaseResult;
    if (purchaseResult === 'success') {
      Alert.alert('Purchase processing', 'Payment completed. Ownership will refresh as soon as Stripe confirms it.');
      refreshAfterCheckout();
    } else if (purchaseResult === 'cancelled') {
      Alert.alert('Checkout cancelled', 'No charge was made and your current subdomain remains unchanged.');
    }
    navigation?.setParams?.({ purchase: undefined });
  }, [navigation, refreshAfterCheckout, route?.params?.purchase]);

  const subdomain = data?.subdomain;
  const analytics = data?.analytics || {};
  const ownershipState = ownership?.ownership || {};
  const ownershipTerms = resolveSubdomainOwnershipTerms(ownership);
  const isOwned = Boolean(ownershipState.isOwned);
  const cooldown = getSubdomainCooldown(subdomain?.lastSlugChangeAt);
  const currentUrl = subdomain?.url ? `https://${subdomain.url}` : '';

  useEffect(() => {
    const requestId = availabilityRequestRef.current + 1;
    availabilityRequestRef.current = requestId;
    if (!editing) {
      setSlugChecking(false);
      return undefined;
    }
    if (!newSlug || newSlug.length < 3) {
      setSlugChecking(false);
      setSlugAvailable(false);
      setSlugMessage('Use at least 3 letters, numbers or hyphens.');
      return undefined;
    }
    if (newSlug === subdomain?.slug) {
      setSlugChecking(false);
      setSlugAvailable(null);
      setSlugMessage('This is your current subdomain.');
      return undefined;
    }

    const timer = setTimeout(async () => {
      setSlugChecking(true);
      try {
        const response = await api.get(`/api/stores/check-subdomain/${encodeURIComponent(newSlug)}`);
        if (availabilityRequestRef.current !== requestId) return;
        if (typeof response.data?.available !== 'boolean') throw new Error('Availability response is invalid.');
        setSlugAvailable(Boolean(response.data?.available));
        setSlugMessage(response.data?.msg || (response.data?.available
          ? 'Available — save to claim it.'
          : 'This subdomain is unavailable.'));
      } catch (requestError) {
        if (availabilityRequestRef.current !== requestId) return;
        setSlugAvailable(null);
        setSlugMessage(requestError.response?.data?.msg || 'Availability could not be checked. Try again.');
      } finally {
        if (availabilityRequestRef.current === requestId) setSlugChecking(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [editing, newSlug, subdomain?.slug]);

  const copyUrl = useCallback(async () => {
    if (!currentUrl) return;
    try {
      await Clipboard.setStringAsync(currentUrl);
      Alert.alert('Link copied', `${subdomain.url} is ready to share.`);
    } catch {
      Alert.alert('Could not copy', 'Press and hold the link to copy it manually.');
    }
  }, [currentUrl, subdomain?.url]);

  const saveSlug = useCallback(async (confirmSubdomainChange = false) => {
    setOperation('save-slug');
    try {
      await api.put('/api/stores/update', {
        storeSlug: newSlug,
        ...(confirmSubdomainChange ? { confirmSubdomainChange: true } : {}),
      });
      Alert.alert('Subdomain changed', `${newSlug}.rozare.com is now your store address.`);
      setEditing(false);
      await fetchData();
    } catch (requestError) {
      const response = requestError.response?.data;
      if (response?.requiresConfirmation && !confirmSubdomainChange) {
        Alert.alert(
          'Purchased ownership will be forfeited',
          `Changing from ${response.currentSubdomain}.rozare.com to ${response.newSubdomain}.rozare.com permanently releases the ownership you purchased for the old address.`,
          [
            { text: 'Keep current address', style: 'cancel' },
            { text: 'Change and forfeit', style: 'destructive', onPress: () => saveSlug(true) },
          ],
        );
      } else {
        const cooldownInfo = response?.cooldown;
        if (cooldownInfo) {
          setSlugMessage(`You can change this again in ${cooldownInfo.daysRemaining} day(s).`);
        }
        Alert.alert('Could not change subdomain', response?.msg || 'Please try again.');
      }
    } finally {
      setOperation('');
    }
  }, [fetchData, newSlug]);

  const confirmSave = useCallback(() => {
    if (subdomain?.blocked) {
      Alert.alert('Store is blocked', 'Reactivate your subscription before changing the subdomain.');
      return;
    }
    if (!cooldown.canChange) {
      Alert.alert('Change unavailable', `You can change your subdomain again in ${cooldown.daysRemaining} day(s), on ${formatDate(cooldown.nextAllowedAt)}.`);
      return;
    }
    if (newSlug.length < 3 || newSlug === subdomain?.slug || slugAvailable !== true) {
      Alert.alert('Choose an available address', slugMessage || 'Check that the new subdomain is available first.');
      return;
    }

    const commonMessage = `The old URL stops working immediately, and this address cannot be changed again for ${SLUG_COOLDOWN_DAYS} days.`;
    if (isOwned) {
      Alert.alert(
        'Change purchased subdomain?',
        `${commonMessage}\n\nYour paid ownership protects ${subdomain.url}, not the replacement. Changing now permanently forfeits that ownership.`,
        [
          { text: 'Keep current address', style: 'cancel' },
          { text: 'Change and forfeit', style: 'destructive', onPress: () => saveSlug(true) },
        ],
      );
      return;
    }

    Alert.alert(
      'Change subdomain?',
      `${newSlug}.rozare.com will become your new public store address. ${commonMessage}`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Change address', onPress: () => saveSlug(false) },
      ],
    );
  }, [cooldown, isOwned, newSlug, saveSlug, slugAvailable, slugMessage, subdomain]);

  const purchaseSubdomain = useCallback(() => {
    const isRenewal = isOwned;
    if (!ownershipTerms) {
      Alert.alert(
        'Pricing unavailable',
        'Refresh to load the authoritative ownership price and duration before opening Checkout.',
      );
      return;
    }
    Alert.alert(
      isRenewal ? 'Renew ownership?' : 'Protect this subdomain?',
      isRenewal
        ? `A one-time ${ownershipTerms.priceLabel} payment extends ownership by ${ownershipTerms.years} years from the current expiry date.`
        : `A one-time ${ownershipTerms.priceLabel} payment protects ${subdomain?.url} for ${ownershipTerms.years} years, even if the store is later blocked. This is separate from your seller subscription.`,
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: isRenewal ? 'Continue to Stripe' : 'Buy securely',
          onPress: async () => {
            setOperation('purchase');
            try {
              const response = await api.post('/api/subscription/subdomain/purchase', { checkoutClient: 'mobile' });
              if (!response.data?.url) throw new Error('Checkout URL was not returned.');
              checkoutOpenRef.current = true;
              const result = await WebBrowser.openAuthSessionAsync(response.data.url, SUBDOMAIN_RETURN_URL);
              checkoutOpenRef.current = false;
              if (result?.type === 'success') refreshAfterCheckout();
            } catch (requestError) {
              checkoutOpenRef.current = false;
              Alert.alert('Checkout unavailable', requestError.response?.data?.msg || requestError.message || 'Please try again.');
            } finally {
              setOperation('');
            }
          },
        },
      ],
    );
  }, [isOwned, ownershipTerms, refreshAfterCheckout, subdomain?.url]);

  if (loading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Store Subdomain"
        subtitle="Loading ownership and traffic details"
        icon="globe-outline"
        variant="dashboard"
      />
    );
  }

  if (noStore) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader
            navigation={navigation}
            title="Store Subdomain"
            subtitle="Your branded Rozare address"
            icon="globe-outline"
          />
          <View style={styles.centerState}>
            <SellerEmptyState
              icon="storefront-outline"
              title="Create your store first"
              message="A subdomain is assigned with your store. Complete Store Settings to create or restore your seller storefront."
              actionLabel="Open Store Settings"
              onAction={() => navigation.navigate('SellerStoreSettings')}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }


  if (!data || !ownership) {
    return (
      <GlassBackground>
        <SafeAreaView
          style={styles.safeArea}
          edges={Platform.OS === 'android' ? [] : ['top']}
        >
          <SellerScreenHeader
            navigation={navigation}
            title="Store Subdomain"
            subtitle="Your branded Rozare address"
            icon="globe-outline"
          />
          <View style={styles.fullErrorState}>
            <SellerInlineError
              title="Subdomain unavailable"
              message={error || 'We could not load your address and ownership details. No changes are available until this refreshes.'}
              onRetry={() => fetchData({ initial: true })}
            />
          </View>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const metrics = [
    ['eye-outline', 'Store views', analytics.totalViews.toLocaleString(), palette.colors.primary],
    ['receipt-outline', 'Recognized orders', analytics.totalOrders.toLocaleString(), palette.colors.success],
    ['cash-outline', 'Recognized revenue', formatPrice(analytics.totalRevenue, { sourceCurrency: analytics.currency }), palette.colors.info],
    ['trending-up-outline', 'Conversion', `${analytics.conversionRate.toFixed(2).replace(/\.00$/, '')}%`, palette.colors.secondary],
  ];
  const traffic = analytics.monthlyTraffic;
  const maxTraffic = Math.max(...traffic.map((item) => item.views), 1);
  const canRenew = isOwned && ownershipState.daysRemaining < 90;

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
        <SellerScreenHeader
          navigation={navigation}
          title="Store Subdomain"
          subtitle="Your branded Rozare address"
          icon="globe-outline"
          rightIcon="refresh"
          onRightPress={() => fetchData()}
        />

        <KeyboardAwareFormScrollView
          contentContainerStyle={styles.scroll}
          bottomOffset={32}
          showsVerticalScrollIndicator={false}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              tintColor={palette.colors.primary}
              onRefresh={() => {
                setRefreshing(true);
                fetchData();
              }}
            />
          )}
        >
          {!!error && (
            <SellerInlineError
              compact
              title="Subdomain details unavailable"
              message={error}
              onRetry={() => fetchData({ initial: true })}
            />
          )}

          <LinearGradient colors={palette.gradients.cta} style={styles.hero}>
            <View style={styles.heroTop}>
              {subdomain?.logo ? (
                <Image source={{ uri: subdomain.logo }} style={styles.storeLogo} contentFit="cover" />
              ) : (
                <View style={styles.storeLogoPlaceholder}>
                  <Ionicons name="storefront" size={23} color="#fff" />
                </View>
              )}
              <View style={styles.heroCopy}>
                <Text style={styles.heroEyebrow}>YOUR STOREFRONT</Text>
                <Text style={styles.heroTitle}>{subdomain?.storeName}</Text>
                <Text style={styles.heroUrl} numberOfLines={1}>{subdomain?.url}</Text>
              </View>
              <View style={styles.heroStatus}>
                <View style={[styles.liveDot, !subdomain?.isActive && styles.offlineDot]} />
                <Text style={styles.heroStatusText}>{subdomain?.isActive ? 'LIVE' : 'OFFLINE'}</Text>
              </View>
            </View>

            <Text style={styles.heroDescription}>
              {subdomain?.isActive
                ? 'Your branded link is live now. Verification is separate and only adds a trust badge.'
                : isOwned
                  ? 'Your store is not public right now, but this purchased address remains protected.'
                  : subdomain?.daysUntilRemoval != null
                    ? `Your store is blocked. This unpurchased address may be released in ${subdomain.daysUntilRemoval} day(s).`
                    : 'Your store is not public right now. Reactivate the subscription to bring this address back online.'}
            </Text>

            <View style={styles.heroActions}>
              <TouchableOpacity style={styles.heroAction} onPress={copyUrl}>
                <Ionicons name="copy-outline" size={16} color="#fff" />
                <Text style={styles.heroActionText}>Copy link</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.heroAction, !subdomain?.isActive && styles.heroActionDisabled]}
                disabled={!subdomain?.isActive}
                onPress={() => Linking.openURL(currentUrl)}
              >
                <Ionicons name="open-outline" size={16} color="#fff" />
                <Text style={styles.heroActionText}>Open store</Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>

          {!subdomain?.isActive && (
            <GlassPanel variant="card" style={styles.blockedCard}>
              <View style={styles.blockedIcon}>
                <Ionicons name="alert-circle" size={20} color={palette.colors.warning} />
              </View>
              <View style={styles.blockedCopy}>
                <Text style={styles.blockedTitle}>Storefront currently unavailable</Text>
                <Text style={styles.blockedText}>
                  Subdomains are live whenever the store is active. Verification is optional for routing and only adds a verified badge.
                </Text>
                <TouchableOpacity
                  style={styles.inlineLink}
                  onPress={() => navigation.navigate('SellerSubscription')}
                >
                  <Text style={styles.inlineLinkText}>Review subscription</Text>
                  <Ionicons name="arrow-forward" size={13} color={palette.colors.primary} />
                </TouchableOpacity>
              </View>
            </GlassPanel>
          )}

          <View style={styles.metricGrid}>
            {metrics.map(([icon, label, value, color]) => (
              <MetricCard key={label} icon={icon} label={label} value={value} color={color} styles={styles} />
            ))}
          </View>

          <GlassPanel variant="strong" style={[styles.ownershipCard, isOwned && styles.ownedCard]}>
            <SellerSectionHeader
              title="Subdomain ownership"
              subtitle="Protection is separate from your seller subscription"
              icon="shield-checkmark-outline"
            />

            {isOwned ? (
              <>
                <View style={styles.ownershipStatusRow}>
                  <View style={styles.ownedIcon}>
                    <Ionicons name="shield-checkmark" size={22} color={palette.colors.success} />
                  </View>
                  <View style={styles.ownershipCopy}>
                    <Text style={styles.ownershipTitle}>Protected for {ownershipState.daysRemaining} more days</Text>
                    <Text style={styles.ownershipText}>{subdomain?.url} cannot be claimed by another seller before expiry.</Text>
                  </View>
                  <Text style={styles.ownedBadge}>OWNED</Text>
                </View>
                <View style={styles.dateGrid}>
                  <View style={styles.dateItem}>
                    <Text style={styles.dateLabel}>Purchased</Text>
                    <Text style={styles.dateValue}>{formatDate(ownershipState.purchasedAt)}</Text>
                  </View>
                  <View style={styles.dateDivider} />
                  <View style={styles.dateItem}>
                    <Text style={styles.dateLabel}>Expires</Text>
                    <Text style={styles.dateValue}>{formatDate(ownershipState.expiresAt)}</Text>
                  </View>
                </View>
                {canRenew && (
                  <TouchableOpacity
                    style={[styles.primaryButton, (operation === 'purchase' || !ownershipTerms) && styles.disabledButton]}
                    disabled={operation === 'purchase' || !ownershipTerms}
                    onPress={purchaseSubdomain}
                  >
                    <Ionicons name="refresh-outline" size={17} color="#fff" />
                    <Text style={styles.primaryButtonText}>
                      {operation === 'purchase' ? 'Opening Stripe…' : `Renew for ${ownershipTerms?.priceLabel || 'price unavailable'}`}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <>
                <View style={styles.ownershipStatusRow}>
                  <View style={styles.protectionIcon}>
                    <Ionicons name="shield-outline" size={22} color={palette.colors.primary} />
                  </View>
                  <View style={styles.ownershipCopy}>
                    <Text style={styles.ownershipTitle}>Protect {subdomain?.url}</Text>
                    <Text style={styles.ownershipText}>
                      One payment protects this exact address for {ownershipTerms?.years || 'the stated number of'} years, including while your account is blocked.
                    </Text>
                  </View>
                </View>
                {[
                  ['shield-checkmark-outline', 'No other seller can claim it'],
                  ['calendar-outline', ownershipTerms ? `${ownershipTerms.years}-year ownership, renewable near expiry` : 'Ownership duration unavailable — refresh required'],
                  ['card-outline', ownershipTerms ? `${ownershipTerms.priceLabel} one-time payment, separate from your plan` : 'Ownership price unavailable — refresh required'],
                ].map(([icon, text]) => (
                  <View key={text} style={styles.benefitRow}>
                    <Ionicons name={icon} size={16} color={palette.colors.primary} />
                    <Text style={styles.benefitText}>{text}</Text>
                  </View>
                ))}
                <View style={styles.releaseNotice}>
                  <Ionicons name="alert-triangle-outline" size={16} color={palette.colors.warning} />
                  <Text style={styles.releaseText}>
                    Without ownership, a subdomain is released after a blocked account remains blocked for 7 days.
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.primaryButton, (operation === 'purchase' || !ownershipTerms) && styles.disabledButton]}
                  disabled={operation === 'purchase' || !ownershipTerms}
                  onPress={purchaseSubdomain}
                >
                  <Ionicons name="card-outline" size={17} color="#fff" />
                  <Text style={styles.primaryButtonText}>
                    {operation === 'purchase'
                      ? 'Opening Stripe…'
                      : `Protect for ${ownershipTerms?.priceLabel || 'price unavailable'} · one time`}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.changeCard}>
            <SellerSectionHeader
              title="Change address"
              subtitle={`A saved change starts a ${SLUG_COOLDOWN_DAYS}-day cooldown`}
              icon="create-outline"
              actionLabel={!editing && cooldown.canChange && !subdomain?.blocked ? 'Edit' : undefined}
              onAction={() => setEditing(true)}
            />

            {!cooldown.canChange && (
              <View style={styles.cooldownNotice}>
                <Ionicons name="time-outline" size={17} color={palette.colors.warning} />
                <Text style={styles.cooldownText}>
                  Available again in {cooldown.daysRemaining} day(s) · {formatDate(cooldown.nextAllowedAt)}
                </Text>
              </View>
            )}

            {editing ? (
              <>
                <Text style={styles.inputLabel}>New subdomain</Text>
                <View style={[
                  styles.slugField,
                  slugAvailable === true && styles.slugFieldSuccess,
                  slugAvailable === false && newSlug.length >= 3 && styles.slugFieldError,
                ]}>
                  <Text style={styles.slugPrefix}>https://</Text>
                  <TextInput
                    value={newSlug}
                    onChangeText={(value) => {
                      setNewSlug(sanitizeSubdomain(value));
                      setSlugAvailable(null);
                      setSlugMessage('');
                    }}
                    style={styles.slugInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={50}
                    placeholder="your-store"
                    placeholderTextColor={palette.colors.textLight}
                    accessibilityLabel="New store subdomain"
                  />
                  <Text style={styles.slugSuffix}>.rozare.com</Text>
                  <View style={styles.slugState}>
                    {slugChecking
                      ? <Ionicons name="hourglass-outline" size={16} color={palette.colors.textSecondary} />
                      : slugAvailable === true
                        ? <Ionicons name="checkmark-circle" size={17} color={palette.colors.success} />
                        : slugAvailable === false && newSlug.length >= 3
                          ? <Ionicons name="close-circle" size={17} color={palette.colors.error} />
                          : null}
                  </View>
                </View>
                {!!slugMessage && (
                  <Text style={[
                    styles.slugMessage,
                    slugAvailable === true && styles.slugMessageSuccess,
                    slugAvailable === false && styles.slugMessageError,
                  ]}>{slugMessage}</Text>
                )}
                {isOwned && (
                  <View style={styles.forfeitNotice}>
                    <Ionicons name="warning-outline" size={16} color={palette.colors.error} />
                    <Text style={styles.forfeitText}>Changing this purchased address permanently forfeits its paid ownership.</Text>
                  </View>
                )}
                <View style={styles.editActions}>
                  <TouchableOpacity
                    style={[
                      styles.saveButton,
                      (operation === 'save-slug' || slugAvailable !== true) && styles.disabledButton,
                    ]}
                    disabled={operation === 'save-slug' || slugAvailable !== true}
                    onPress={confirmSave}
                  >
                    <Ionicons name="checkmark" size={16} color="#fff" />
                    <Text style={styles.saveButtonText}>{operation === 'save-slug' ? 'Saving…' : 'Save address'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => {
                      setEditing(false);
                      setNewSlug(subdomain?.slug || '');
                      setSlugAvailable(null);
                      setSlugMessage('');
                    }}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <TouchableOpacity style={styles.currentUrlCard} onPress={copyUrl} activeOpacity={0.78}>
                <View style={styles.currentUrlIcon}>
                  <Ionicons name="globe-outline" size={18} color={palette.colors.primary} />
                </View>
                <View style={styles.currentUrlCopy}>
                  <Text style={styles.currentUrlLabel}>Current address</Text>
                  <Text style={styles.currentUrlText} numberOfLines={1}>{subdomain?.url}</Text>
                </View>
                <Ionicons name="copy-outline" size={18} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.trafficCard}>
            <SellerSectionHeader
              title="Traffic snapshot"
              subtitle="Real storefront activity only"
              icon="bar-chart-outline"
            />
            {traffic.length > 0 && analytics.totalViews > 0 ? (
              <View style={styles.chart} accessibilityLabel="Estimated monthly store view chart">
                {traffic.map((item) => {
                  const value = Number(item.views || 0);
                  const height = Math.max(6, Math.round((value / maxTraffic) * 112));
                  return (
                    <View key={item.month} style={styles.barColumn}>
                      <Text style={styles.barValue}>{value}</Text>
                      <View style={styles.barTrack}>
                        <LinearGradient
                          colors={palette.gradients.cta}
                          style={[styles.bar, { height }]}
                        />
                      </View>
                      <Text style={styles.barLabel}>{item.month}</Text>
                    </View>
                  );
                })}
              </View>
            ) : (
              <SellerEmptyState
                icon="analytics-outline"
                title={analytics.totalViews > 0 ? 'Monthly history unavailable' : 'No traffic yet'}
                message={analytics.totalViews > 0
                  ? 'Your lifetime view total above is accurate. Monthly view history is not available yet.'
                  : 'Share your storefront link. Views and conversions will appear after shoppers visit.'}
                actionLabel="Copy store link"
                onAction={copyUrl}
              />
            )}
          </GlassPanel>

          <GlassPanel variant="card" style={styles.infoCard}>
            <SellerSectionHeader title="Good to know" icon="information-circle-outline" />
            {[
              ['When is it live?', 'Your subdomain is live whenever your store is active. Store verification is separate and adds a trust badge only.'],
              ['Can I change it?', `Yes, when the ${SLUG_COOLDOWN_DAYS}-day cooldown is clear. The old link stops working immediately.`],
              ['What does ownership cover?', ownershipTerms
                ? `The ${ownershipTerms.priceLabel} payment protects the exact address for ${ownershipTerms.years} years. It does not replace the seller subscription.`
                : 'Refresh to load the authoritative ownership price and duration before opening Checkout.'],
            ].map(([question, answer]) => (
              <View key={question} style={styles.faqRow}>
                <Text style={styles.faqQuestion}>{question}</Text>
                <Text style={styles.faqAnswer}>{answer}</Text>
              </View>
            ))}
          </GlassPanel>
        </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  centerState: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg, paddingBottom: 72 },
  fullErrorState: { flex: 1, justifyContent: 'center', paddingBottom: 72 },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: 96 },
  hero: { padding: spacing.xl, borderRadius: borderRadius.xxxl, marginBottom: spacing.md, overflow: 'hidden' },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  storeLogo: { width: 52, height: 52, borderRadius: 17, borderWidth: 2, borderColor: 'rgba(255,255,255,0.55)' },
  storeLogoPlaceholder: { width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' },
  heroCopy: { flex: 1 },
  heroEyebrow: { color: 'rgba(255,255,255,0.7)', fontSize: 9, letterSpacing: 1.2, fontWeight: fontWeight.extrabold },
  heroTitle: { marginTop: 2, color: '#fff', fontSize: fontSize.xl, fontWeight: fontWeight.extrabold },
  heroUrl: { marginTop: 2, color: 'rgba(255,255,255,0.86)', fontSize: fontSize.xs, fontWeight: fontWeight.semibold },
  heroStatus: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: borderRadius.full, backgroundColor: 'rgba(255,255,255,0.14)' },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#6EE7B7' },
  offlineDot: { backgroundColor: '#FCD34D' },
  heroStatusText: { color: '#fff', fontSize: 8, letterSpacing: 0.5, fontWeight: fontWeight.extrabold },
  heroDescription: { marginTop: spacing.lg, color: 'rgba(255,255,255,0.88)', fontSize: fontSize.sm, lineHeight: 20 },
  heroActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  heroAction: { minHeight: 42, flex: 1, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: 'rgba(255,255,255,0.15)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' },
  heroActionDisabled: { opacity: 0.45 },
  heroActionText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  blockedCard: { flexDirection: 'row', gap: spacing.md, padding: spacing.lg, marginBottom: spacing.md, borderColor: `${p.colors.warning}35` },
  blockedIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.warningSubtle },
  blockedCopy: { flex: 1 },
  blockedTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  blockedText: { marginTop: 3, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  inlineLink: { alignSelf: 'flex-start', marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28 },
  inlineLinkText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  metricCard: { width: '48.7%', minHeight: 132, padding: spacing.lg },
  metricIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  metricValue: { marginTop: spacing.md, color: p.colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold },
  metricLabel: { marginTop: 2, color: p.colors.textSecondary, fontSize: fontSize.xs },
  ownershipCard: { padding: spacing.xl, marginBottom: spacing.md },
  ownedCard: { borderWidth: 1.5, borderColor: `${p.colors.success}40` },
  ownershipStatusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  ownedIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.successSubtle },
  protectionIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  ownershipCopy: { flex: 1 },
  ownershipTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  ownershipText: { marginTop: 3, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  ownedBadge: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: borderRadius.full, overflow: 'hidden', backgroundColor: p.colors.successSubtle, color: p.colors.successDark, fontSize: 8, fontWeight: fontWeight.extrabold },
  dateGrid: { marginTop: spacing.lg, padding: spacing.md, borderRadius: 15, flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.border },
  dateItem: { flex: 1 },
  dateDivider: { width: 1, height: 34, marginHorizontal: spacing.md, backgroundColor: p.glass.borderStrong },
  dateLabel: { color: p.colors.textSecondary, fontSize: 9, fontWeight: fontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
  dateValue: { marginTop: 4, color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  benefitRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.border },
  benefitText: { flex: 1, color: p.colors.text, fontSize: fontSize.xs, lineHeight: 17 },
  releaseNotice: { marginTop: spacing.md, padding: spacing.md, borderRadius: 14, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, backgroundColor: p.colors.warningSubtle },
  releaseText: { flex: 1, color: p.colors.warningDark, fontSize: 10, lineHeight: 15 },
  primaryButton: { minHeight: 48, marginTop: spacing.lg, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary },
  primaryButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  disabledButton: { opacity: 0.5 },
  changeCard: { padding: spacing.xl, marginBottom: spacing.md },
  cooldownNotice: { marginBottom: spacing.md, padding: spacing.md, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: p.colors.warningSubtle },
  cooldownText: { flex: 1, color: p.colors.warningDark, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  inputLabel: { marginBottom: spacing.sm, color: p.colors.textSecondary, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  slugField: { minHeight: 50, borderRadius: 15, flexDirection: 'row', alignItems: 'center', overflow: 'hidden', backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.borderStrong },
  slugFieldSuccess: { borderColor: p.colors.success },
  slugFieldError: { borderColor: p.colors.error },
  slugPrefix: { alignSelf: 'stretch', paddingHorizontal: spacing.sm, textAlignVertical: 'center', color: p.colors.textSecondary, fontSize: 10, backgroundColor: p.glass.bgStrong },
  slugInput: { flex: 1, minWidth: 0, paddingHorizontal: spacing.xs, color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  slugSuffix: { color: p.colors.textSecondary, fontSize: 10 },
  slugState: { width: 30, alignItems: 'center' },
  slugMessage: { marginTop: spacing.sm, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 16 },
  slugMessageSuccess: { color: p.colors.successDark },
  slugMessageError: { color: p.colors.error },
  forfeitNotice: { marginTop: spacing.md, padding: spacing.md, borderRadius: 14, flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, backgroundColor: p.colors.errorSubtle },
  forfeitText: { flex: 1, color: p.colors.errorDark, fontSize: 10, lineHeight: 15 },
  editActions: { marginTop: spacing.lg, flexDirection: 'row', gap: spacing.sm },
  saveButton: { minHeight: 44, flex: 1, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary },
  saveButtonText: { color: '#fff', fontSize: fontSize.xs, fontWeight: fontWeight.extrabold },
  cancelButton: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.borderStrong },
  cancelButtonText: { color: p.colors.text, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  currentUrlCard: { minHeight: 66, padding: spacing.md, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: p.glass.backgroundInner, borderWidth: 1, borderColor: p.glass.border },
  currentUrlIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  currentUrlCopy: { flex: 1 },
  currentUrlLabel: { color: p.colors.textSecondary, fontSize: 9, fontWeight: fontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.4 },
  currentUrlText: { marginTop: 3, color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  trafficCard: { padding: spacing.xl, marginBottom: spacing.md },
  chart: { minHeight: 170, flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs, paddingTop: spacing.md },
  barColumn: { flex: 1, alignItems: 'center' },
  barValue: { marginBottom: 4, color: p.colors.textSecondary, fontSize: 8, fontWeight: fontWeight.bold },
  barTrack: { height: 112, width: '72%', justifyContent: 'flex-end', borderRadius: 8, overflow: 'hidden', backgroundColor: p.glass.backgroundInner },
  bar: { width: '100%', borderRadius: 8 },
  barLabel: { marginTop: 6, color: p.colors.textSecondary, fontSize: 8, textAlign: 'center' },
  infoCard: { padding: spacing.xl, marginBottom: spacing.md },
  faqRow: { paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.glass.border },
  faqQuestion: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold },
  faqAnswer: { marginTop: 4, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 18 },
});
