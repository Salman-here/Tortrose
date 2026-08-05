import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Crypto from 'expo-crypto';
import { useStripe } from '@stripe/stripe-react-native';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useAuth } from '../contexts/AuthContext';
import { useStripeConfig } from '../contexts/StripeContext';
import { useTheme } from '../contexts/ThemeContext';
import {
  assertPaymentSheetPayload,
  buildPaymentSheetOptions,
  cancelSetupIntentPaymentAttempt,
  normalizePaymentSheetPayload,
  normalizeSavedCards,
  runSetupIntentPaymentSheetAttempt,
} from '../utils/stripePaymentSheet';
import { trackError, trackPaymentEvent } from '../utils/breadcrumbs';
import { fontSize, fontWeight, shadows, spacing } from '../styles/theme';

const BRAND_META = {
  visa: { label: 'VISA', color: '#1A1F71', tint: 'rgba(26,31,113,0.10)' },
  mastercard: { label: 'mastercard', color: '#EB001B', tint: 'rgba(235,0,27,0.10)' },
  amex: { label: 'AMEX', color: '#2E77BC', tint: 'rgba(46,119,188,0.10)' },
  discover: { label: 'DISCOVER', color: '#F76F20', tint: 'rgba(247,111,32,0.10)' },
  diners: { label: 'DINERS', color: '#0079BE', tint: 'rgba(0,121,190,0.10)' },
  jcb: { label: 'JCB', color: '#0B8A4B', tint: 'rgba(11,138,75,0.10)' },
  unionpay: { label: 'UNIONPAY', color: '#D71920', tint: 'rgba(215,25,32,0.10)' },
  card: { label: 'CARD', color: '#6366F1', tint: 'rgba(99,102,241,0.10)' },
};

const getBrandMeta = (brand) => BRAND_META[brand] || {
  label: String(brand || 'CARD').toUpperCase(),
  color: '#6366F1',
  tint: 'rgba(99,102,241,0.10)',
};

function SkeletonCard({ palette }) {
  const opacity = useRef(new Animated.Value(0.38)).current;

  useEffect(() => {
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.8, duration: 680, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.38, duration: 680, useNativeDriver: true }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <GlassPanel variant="card" style={skeletonStyles.card}>
      <Animated.View style={[skeletonStyles.icon, { opacity, backgroundColor: palette.colors.primaryLighter }]} />
      <View style={skeletonStyles.copy}>
        <Animated.View style={[skeletonStyles.lineLong, { opacity, backgroundColor: palette.colors.primaryLighter }]} />
        <Animated.View style={[skeletonStyles.lineShort, { opacity, backgroundColor: palette.glass.borderStrong }]} />
      </View>
      <Animated.View style={[skeletonStyles.pill, { opacity, backgroundColor: palette.glass.borderStrong }]} />
    </GlassPanel>
  );
}

export default function PaymentMethodsScreen({ navigation }) {
  const { palette, isDark } = useTheme();
  const styles = buildStyles(palette);
  const { currentUser } = useAuth();
  const { config, ensureReady } = useStripeConfig();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [cards, setCards] = useState([]);
  const [defaultPaymentMethodId, setDefaultPaymentMethodId] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [consentToSave, setConsentToSave] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null);

  const loadCards = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const response = await api.get('/api/payment-methods');
      const normalized = normalizeSavedCards(response);
      setCards(normalized.cards);
      setDefaultPaymentMethodId(normalized.defaultPaymentMethodId);
      setLoadError('');
      return normalized;
    } catch (error) {
      const message = error.response?.data?.msg || 'Your saved cards could not be loaded.';
      setLoadError(message);
      throw error;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadCards().catch(() => {});
    const unsubscribe = navigation.addListener('focus', () => loadCards({ quiet: true }).catch(() => {}));
    return unsubscribe;
  }, [loadCards, navigation]);

  const addCard = async () => {
    if (adding) return;
    if (!consentToSave) {
      setNotice({
        type: 'info',
        title: 'Your permission is required',
        text: 'Confirm that Stripe may save this card for future purchases. You will still approve every charge.',
      });
      return;
    }
    setAdding(true);
    setNotice(null);
    let setupReference = null;
    let setupCleanupAttempted = false;
    try {
      const stripeConfig = await ensureReady();
      trackPaymentEvent('saved_card_setup_started', {
        googlePayEnabled: !!stripeConfig.googlePayEnabled,
      });
      const requestKey = Crypto.randomUUID();
      const response = await api.post('/api/payment-methods/setup', {
        paymentFlow: 'payment_sheet',
        clientSurface: 'mobile',
        consentAccepted: true,
        consentVersion: '2026-08-01',
        requestKey,
      }, {
        headers: { 'X-Idempotency-Key': requestKey },
      });
      setupReference = normalizePaymentSheetPayload(response);
      const payment = assertPaymentSheetPayload(response, 'setup');
      trackPaymentEvent('saved_card_setup_reference_created', {
        hasSetupIntent: !!payment.setupIntentClientSecret,
      });
      const result = await runSetupIntentPaymentSheetAttempt({
        initPaymentSheet,
        presentPaymentSheet,
        apiClient: api,
        setupIntentId: payment.setupIntentId,
        options: buildPaymentSheetOptions({
          payment,
          config: stripeConfig,
          currentUser,
          currency: 'USD',
          palette,
          isDark,
          intentType: 'setup',
        }),
      });
      setupCleanupAttempted = result.status !== 'presented';
      trackPaymentEvent(`saved_card_setup_sheet_${result.status}`, {
        stage: result.stage,
        code: result.error?.code,
      });

      if (result.status === 'cancelled') {
        setNotice({
          type: result.cleanupError ? 'error' : 'info',
          title: result.cleanupError ? 'Closing card setup' : 'Nothing changed',
          text: result.cleanupError
            ? 'The setup was closed, and Rozare is still confirming cleanup with Stripe.'
            : 'Card setup was closed and the incomplete SetupIntent was cancelled.',
        });
        return;
      }
      if (result.status !== 'presented') {
        setNotice({
          type: 'error',
          title: 'Card setup could not open',
          text: result.cleanupError
            ? 'Rozare is still confirming cleanup with Stripe. No card was saved.'
            : 'The failed SetupIntent was cancelled immediately. No card was saved.',
        });
        return;
      }

      await loadCards({ quiet: true });
      setConsentToSave(false);
      setNotice({ type: 'success', title: 'Card saved securely', text: 'It is now ready for faster checkout.' });
    } catch (error) {
      trackError('saved_card_setup', error);
      if (setupReference?.setupIntentId && !setupCleanupAttempted) {
        let cleanupError = null;
        try {
          await cancelSetupIntentPaymentAttempt({
            apiClient: api,
            setupIntentId: setupReference.setupIntentId,
            closeReason: 'payment_sheet_preparation_failed',
          });
        } catch (nextError) {
          cleanupError = nextError;
        }
        setNotice({
          type: 'error',
          title: 'Card setup could not open',
          text: cleanupError
            ? 'Rozare is still confirming cleanup with Stripe. No card was saved.'
            : 'The failed SetupIntent was cancelled immediately. No card was saved.',
        });
        return;
      }
      setNotice({
        type: 'error',
        title: 'Card was not saved',
        text: error.response?.data?.msg || error.localizedMessage || error.message || 'Please try again.',
      });
    } finally {
      setAdding(false);
    }
  };

  const makeDefault = async (card) => {
    if (!card?.id || card.isDefault || busyId) return;
    setBusyId(card.id);
    setNotice(null);
    try {
      await api.patch(`/api/payment-methods/${encodeURIComponent(card.id)}/default`);
      setDefaultPaymentMethodId(card.id);
      setCards((previous) => previous.map((item) => ({ ...item, isDefault: item.id === card.id })));
      setNotice({ type: 'success', title: 'Default card updated', text: `Card ending in ${card.last4} will be offered first at checkout.` });
    } catch (error) {
      setNotice({ type: 'error', title: 'Could not update default', text: error.response?.data?.msg || 'Please try again.' });
    } finally {
      setBusyId('');
    }
  };

  const removeCard = async (card) => {
    if (!card?.id || busyId) return;
    setBusyId(card.id);
    setNotice(null);
    try {
      await api.delete(`/api/payment-methods/${encodeURIComponent(card.id)}`);
      const remaining = cards.filter((item) => item.id !== card.id);
      setCards(remaining);
      if (defaultPaymentMethodId === card.id) {
        const nextDefault = remaining.find((item) => item.isDefault)?.id || '';
        setDefaultPaymentMethodId(nextDefault);
      }
      setNotice({ type: 'success', title: 'Card removed', text: `Card ending in ${card.last4} is no longer saved.` });
    } catch (error) {
      setNotice({ type: 'error', title: 'Card could not be removed', text: error.response?.data?.msg || 'Please try again.' });
    } finally {
      setBusyId('');
    }
  };

  const confirmRemove = (card) => Alert.alert(
    'Remove saved card?',
    `Card ending in ${card.last4} will no longer appear at checkout.`,
    [
      { text: 'Keep card', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeCard(card) },
    ]
  );

  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('MainTabs', { screen: 'Account' });
  };

  const noticeColor = notice?.type === 'success'
    ? palette.colors.success
    : notice?.type === 'error'
      ? palette.colors.error
      : palette.colors.info;

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Payment Methods"
          subtitle="Secure cards for faster checkout"
          icon="card-outline"
          onBack={goBack}
          rightElement={(
            <TouchableOpacity
              style={styles.headerAction}
              onPress={() => loadCards().catch(() => {})}
              disabled={loading || refreshing}
              accessibilityRole="button"
              accessibilityLabel="Refresh saved cards"
            >
              {loading || refreshing
                ? <ActivityIndicator size="small" color={palette.colors.primary} />
                : <Ionicons name="refresh-outline" size={19} color={palette.colors.primary} />}
            </TouchableOpacity>
          )}
          style={styles.header}
        />

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                loadCards({ quiet: true }).catch(() => {});
              }}
              tintColor={palette.colors.primary}
            />
          )}
        >
          <GlassPanel variant="strong" style={styles.hero}>
            <View style={styles.heroGlow} pointerEvents="none">
              <LinearGradient colors={['rgba(20,184,166,0.32)', 'rgba(99,102,241,0.06)']} style={StyleSheet.absoluteFill} />
            </View>
            <View style={styles.heroTopRow}>
              <View style={styles.heroIcon}>
                <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} />
                <Ionicons name="shield-checkmark" size={26} color="#fff" />
              </View>
              <View style={styles.heroBadge}>
                <View style={[styles.statusDot, { backgroundColor: config ? palette.colors.success : palette.colors.warning }]} />
                <Text style={styles.heroBadgeText}>{config?.mode === 'live' ? 'LIVE PAYMENTS' : 'SECURE MODE'}</Text>
              </View>
            </View>
            <Text style={styles.heroTitle}>Your cards, protected by Stripe</Text>
            <Text style={styles.heroText}>
              Rozare receives only a card brand and last four digits. Full card details stay encrypted with Stripe.
            </Text>
            <View style={styles.trustRow}>
              <View style={styles.trustChip}><Ionicons name="lock-closed-outline" size={13} color={palette.colors.primary} /><Text style={styles.trustText}>Encrypted</Text></View>
              <View style={styles.trustChip}><Ionicons name="phone-portrait-outline" size={13} color={palette.colors.primary} /><Text style={styles.trustText}>3D Secure</Text></View>
              <View style={styles.trustChip}><Ionicons name="flash-outline" size={13} color={palette.colors.primary} /><Text style={styles.trustText}>Fast checkout</Text></View>
            </View>
          </GlassPanel>

          {!!notice && (
            <View style={[styles.notice, { borderColor: `${noticeColor}45`, backgroundColor: `${noticeColor}12` }]}>
              <View style={[styles.noticeIcon, { backgroundColor: `${noticeColor}18` }]}>
                <Ionicons
                  name={notice.type === 'success' ? 'checkmark' : notice.type === 'error' ? 'alert' : 'information'}
                  size={18}
                  color={noticeColor}
                />
              </View>
              <View style={styles.noticeCopy}>
                <Text style={styles.noticeTitle}>{notice.title}</Text>
                <Text style={styles.noticeText}>{notice.text}</Text>
              </View>
              <TouchableOpacity onPress={() => setNotice(null)} hitSlop={8} accessibilityLabel="Dismiss message">
                <Ionicons name="close" size={17} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionEyebrow}>SAVED PAYMENT METHODS</Text>
              <Text style={styles.sectionTitle}>{loading ? 'Loading your cards' : `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} ready`}</Text>
            </View>
            {!!cards.length && <Text style={styles.sectionMeta}>•••• only</Text>}
          </View>

          {loading ? (
            <>
              <SkeletonCard palette={palette} />
              <SkeletonCard palette={palette} />
            </>
          ) : loadError && cards.length === 0 ? (
            <GlassPanel variant="card" style={styles.errorCard}>
              <View style={styles.errorIcon}><Ionicons name="cloud-offline-outline" size={28} color={palette.colors.error} /></View>
              <Text style={styles.errorTitle}>Cards unavailable</Text>
              <Text style={styles.errorText}>{loadError}</Text>
              <TouchableOpacity style={styles.retryButton} onPress={() => loadCards().catch(() => {})}>
                <Ionicons name="refresh" size={16} color="#fff" />
                <Text style={styles.retryButtonText}>Try again</Text>
              </TouchableOpacity>
            </GlassPanel>
          ) : cards.length === 0 ? (
            <GlassPanel variant="card" style={styles.emptyCard}>
              <View style={styles.emptyVisual}>
                <View style={styles.emptyHalo} />
                <Ionicons name="card-outline" size={34} color={palette.colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>No card saved yet</Text>
              <Text style={styles.emptyText}>Add a card once, then choose it securely inside Stripe PaymentSheet during checkout.</Text>
            </GlassPanel>
          ) : cards.map((card) => {
            const brand = getBrandMeta(card.brand);
            const isDefault = card.isDefault || card.id === defaultPaymentMethodId;
            const busy = busyId === card.id;
            return (
              <GlassPanel key={card.id} variant="card" style={[styles.card, isDefault && styles.defaultCard]}>
                <View style={styles.cardTopRow}>
                  <View style={[styles.brandTile, { backgroundColor: brand.tint, borderColor: `${brand.color}25` }]}>
                    <Text style={[styles.brandText, { color: brand.color }]}>{brand.label}</Text>
                  </View>
                  {isDefault ? (
                    <View style={styles.defaultBadge}>
                      <Ionicons name="checkmark-circle" size={14} color={palette.colors.success} />
                      <Text style={styles.defaultBadgeText}>DEFAULT</Text>
                    </View>
                  ) : (
                    <TouchableOpacity style={styles.defaultButton} onPress={() => makeDefault(card)} disabled={!!busyId}>
                      <Text style={styles.defaultButtonText}>Make default</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={styles.numberRow}>
                  <Text style={styles.maskedNumber}>••••  ••••  ••••</Text>
                  <Text style={styles.lastFour}>{card.last4}</Text>
                </View>
                <View style={styles.cardBottomRow}>
                  <View>
                    <Text style={styles.cardLabel}>EXPIRES</Text>
                    <Text style={styles.cardValue}>{String(card.expMonth || '').padStart(2, '0')}/{String(card.expYear || '').slice(-2)}</Text>
                  </View>
                  {!!card.funding && (
                    <View>
                      <Text style={styles.cardLabel}>TYPE</Text>
                      <Text style={[styles.cardValue, styles.capitalize]}>{card.funding}</Text>
                    </View>
                  )}
                  <View style={styles.cardSpacer} />
                  <TouchableOpacity
                    style={styles.removeButton}
                    onPress={() => confirmRemove(card)}
                    disabled={!!busyId}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove card ending in ${card.last4}`}
                  >
                    {busy
                      ? <ActivityIndicator size="small" color={palette.colors.error} />
                      : <Ionicons name="trash-outline" size={17} color={palette.colors.error} />}
                  </TouchableOpacity>
                </View>
              </GlassPanel>
            );
          })}

          <View style={styles.consentCard}>
            <TouchableOpacity
              style={styles.consentChoice}
              onPress={() => setConsentToSave((value) => !value)}
              activeOpacity={0.78}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: consentToSave }}
              accessibilityLabel="Consent to save this card securely with Stripe"
            >
              <View style={[styles.checkbox, consentToSave && styles.checkboxChecked]}>
                {consentToSave && <Ionicons name="checkmark" size={15} color="#fff" />}
              </View>
              <View style={styles.consentCopy}>
                <Text style={styles.consentTitle}>Save with my permission</Text>
                <Text style={styles.consentText}>
                  I choose to save this card with Stripe for future purchases and Wallet top-ups that I start and approve. Rozare will not charge it automatically, and I can remove it anytime.
                </Text>
              </View>
            </TouchableOpacity>
            <View style={styles.legalLinks}>
              <Text style={styles.legalLead}>By continuing, I agree to Rozare's </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('TermsOfService')}
                accessibilityRole="link"
                accessibilityLabel="Open Terms of Service"
              >
                <Text style={styles.legalLink}>Terms</Text>
              </TouchableOpacity>
              <Text style={styles.legalLead}> and </Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('PrivacyPolicy')}
                accessibilityRole="link"
                accessibilityLabel="Open Privacy Policy"
              >
                <Text style={styles.legalLink}>Privacy Policy</Text>
              </TouchableOpacity>
              <Text style={styles.legalLead}>.</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.addButton, (adding || !consentToSave) && styles.disabled]}
            onPress={addCard}
            disabled={adding || !!busyId || !consentToSave}
            activeOpacity={0.86}
            accessibilityRole="button"
            accessibilityLabel="Add a payment card"
          >
            <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
            {adding ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="add-circle-outline" size={20} color="#fff" />
                <Text style={styles.addButtonText}>Add a new card</Text>
                <Ionicons name="arrow-forward" size={18} color="#fff" />
              </>
            )}
          </TouchableOpacity>

          <GlassPanel variant="inner" style={styles.securityNote}>
            <Ionicons name="shield-checkmark-outline" size={20} color={palette.colors.success} />
            <View style={styles.securityCopy}>
              <Text style={styles.securityTitle}>Built for safe checkout</Text>
              <Text style={styles.securityText}>Adding a card does not charge it. You approve every payment inside Stripe’s secure sheet.</Text>
            </View>
          </GlassPanel>
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const skeletonStyles = StyleSheet.create({
  card: { minHeight: 116, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, marginBottom: 12, borderRadius: 20 },
  icon: { width: 54, height: 42, borderRadius: 13 },
  copy: { flex: 1, gap: 10 },
  lineLong: { width: '78%', height: 13, borderRadius: 7 },
  lineShort: { width: '46%', height: 10, borderRadius: 5 },
  pill: { width: 64, height: 25, borderRadius: 10 },
});

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  header: { marginTop: spacing.sm },
  headerAction: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxxl },
  hero: { overflow: 'hidden', padding: spacing.lg, marginBottom: spacing.lg },
  heroGlow: { position: 'absolute', top: -70, right: -35, width: 210, height: 180, borderRadius: 90, overflow: 'hidden' },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroIcon: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', ...shadows.md },
  heroBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28, paddingHorizontal: 9, borderRadius: 10, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  heroBadgeText: { fontSize: 9, fontWeight: fontWeight.extrabold, letterSpacing: 0.7, color: p.colors.textSecondary },
  heroTitle: { marginTop: spacing.lg, fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.4 },
  heroText: { marginTop: 6, maxWidth: 350, fontSize: fontSize.sm, lineHeight: 20, color: p.colors.textSecondary },
  trustRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: spacing.md },
  trustChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, minHeight: 27, borderRadius: 10, backgroundColor: p.colors.primarySubtle },
  trustText: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.primary },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, marginBottom: spacing.lg, borderWidth: 1, borderRadius: 17 },
  noticeIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  noticeCopy: { flex: 1 },
  noticeTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  noticeText: { marginTop: 2, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', paddingHorizontal: spacing.xs, marginBottom: spacing.sm },
  sectionEyebrow: { fontSize: 9, fontWeight: fontWeight.extrabold, letterSpacing: 1, color: p.colors.primary },
  sectionTitle: { marginTop: 3, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text },
  sectionMeta: { fontSize: 10, color: p.colors.textSecondary },
  errorCard: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  errorIcon: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.errorSubtle },
  errorTitle: { marginTop: spacing.md, fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  errorText: { marginTop: 5, textAlign: 'center', fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  retryButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md, paddingHorizontal: spacing.lg, borderRadius: 13, backgroundColor: p.colors.primary },
  retryButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: '#fff' },
  emptyCard: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  emptyVisual: { width: 76, height: 62, alignItems: 'center', justifyContent: 'center' },
  emptyHalo: { position: 'absolute', width: 70, height: 54, borderRadius: 22, backgroundColor: p.colors.primarySubtle, transform: [{ rotate: '-7deg' }] },
  emptyTitle: { marginTop: spacing.sm, fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: p.colors.text },
  emptyText: { maxWidth: 310, marginTop: 5, textAlign: 'center', fontSize: fontSize.sm, lineHeight: 19, color: p.colors.textSecondary },
  card: { padding: spacing.lg, marginBottom: spacing.sm, borderRadius: 21 },
  defaultCard: { borderColor: p.colors.successLighter, backgroundColor: p.glass.bgStrong },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandTile: { minWidth: 68, height: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9, borderRadius: 11, borderWidth: 1 },
  brandText: { fontSize: 10, fontWeight: fontWeight.extrabold, letterSpacing: 0.3 },
  defaultBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 28, paddingHorizontal: 8, borderRadius: 10, backgroundColor: p.colors.successSubtle },
  defaultBadgeText: { fontSize: 9, fontWeight: fontWeight.extrabold, color: p.colors.success },
  defaultButton: { minHeight: 30, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 10, backgroundColor: p.colors.primarySubtle },
  defaultButtonText: { fontSize: 9, fontWeight: fontWeight.bold, color: p.colors.primary },
  numberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: spacing.lg, marginBottom: spacing.lg },
  maskedNumber: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, letterSpacing: 1.7, color: p.colors.textLight },
  lastFour: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, letterSpacing: 1.2, color: p.colors.text },
  cardBottomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  cardLabel: { fontSize: 8, fontWeight: fontWeight.extrabold, letterSpacing: 0.8, color: p.colors.textLight },
  cardValue: { marginTop: 3, fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: p.colors.textSecondary },
  capitalize: { textTransform: 'capitalize' },
  cardSpacer: { flex: 1 },
  removeButton: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.errorSubtle },
  addButton: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.sm, borderRadius: 17, overflow: 'hidden', ...shadows.md },
  addButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: '#fff' },
  consentCard: { minHeight: 92, marginTop: spacing.sm, padding: spacing.md, borderRadius: 17, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  consentChoice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  checkbox: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: p.colors.primaryLighter, backgroundColor: p.glass.bgSubtle },
  checkboxChecked: { borderColor: p.colors.primary, backgroundColor: p.colors.primary },
  consentCopy: { flex: 1 },
  consentTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  consentText: { marginTop: 3, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
  legalLinks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: spacing.sm, marginLeft: 24 + spacing.sm },
  legalLead: { fontSize: 10, lineHeight: 16, color: p.colors.textLight },
  legalLink: { fontSize: 10, lineHeight: 16, color: p.colors.primary, fontWeight: fontWeight.bold, textDecorationLine: 'underline' },
  disabled: { opacity: 0.58 },
  securityNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.md, marginTop: spacing.md },
  securityCopy: { flex: 1 },
  securityTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  securityText: { marginTop: 2, fontSize: 10, lineHeight: 15, color: p.colors.textSecondary },
});
