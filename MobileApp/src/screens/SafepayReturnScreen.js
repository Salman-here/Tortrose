import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import { useTheme } from '../contexts/ThemeContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useAuth } from '../contexts/AuthContext';
import { useIsFocused } from '@react-navigation/native';
import useSafepayPendingVerification from '../hooks/useSafepayPendingVerification';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { openSafepayCheckout, safepayPaymentExpectation, verifySafepayPayment } from '../utils/safepayCheckout';
import { getOriginalPaymentRefundCopy } from '../utils/paymentPresentation';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearCheckoutAttempt } from '../utils/checkout';

export default function SafepayReturnScreen({ route, navigation }) {
  const { palette } = useTheme();
  const { fetchCart } = useGlobal();
  const { currentUser } = useAuth();
  const owner = String(currentUser?._id || currentUser?.id || '');
  const focused = useIsFocused();
  const paymentId = route.params?.paymentId;
  const [result, setResult] = useState({ status: 'checking' });
  const [checking, setChecking] = useState(false);
  const mounted = useRef(true);
  const completed = useRef('');
  const busy = useRef(false);
  const attempt = route.params || {};
  const applyResult = useCallback(async next => {
    if (!mounted.current) return;
    setResult(next);
    if (next.status === 'paid' && next.purpose === 'order' && completed.current !== paymentId) {
      completed.current = paymentId;
      await fetchCart();
      if (attempt.checkoutAttemptStorageKey && attempt.checkoutAttemptFingerprint && attempt.checkoutAttemptKey) {
        await clearCheckoutAttempt(AsyncStorage, attempt.checkoutAttemptStorageKey, attempt.checkoutAttemptFingerprint, attempt.checkoutAttemptKey);
      }
    }
  }, [paymentId, fetchCart, attempt.checkoutAttemptStorageKey, attempt.checkoutAttemptFingerprint, attempt.checkoutAttemptKey]);
  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      await applyResult(await verifySafepayPayment({ apiClient: api, paymentId, attempts: 1 }));
    } catch (error) {
      if (mounted.current) setResult({ status: 'unavailable', message: error.response?.data?.msg || error.message });
    } finally { busy.current = false; if (mounted.current) setChecking(false); }
  }, [paymentId, applyResult]);
  const resume = async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      const response = await api.post(`/api/safepay/payments/${paymentId}/reopen`, { clientSurface: 'mobile' });
      if (response.data?.paymentId !== paymentId) throw new Error('The original payment could not be verified.');
      if (mounted.current) await applyResult(await openSafepayCheckout({ apiClient: api, response }));
    } catch (error) {
      if (mounted.current) setResult({ status: 'unavailable', message: error.response?.data?.msg || 'This payment could not be reopened. Check its status before paying again.' });
    } finally { busy.current = false; if (mounted.current) setChecking(false); }
  };
  useEffect(() => { mounted.current = true; check(); return () => { mounted.current = false; }; }, [check]);
  const automaticallyChecking = useSafepayPendingVerification({ owner, enabled: focused, paused: checking,
    payment: { ...result, paymentId, safepay: true, owner, expectedPayment: safepayPaymentExpectation(result) }, onVerified: applyResult });
  const paid = result.status === 'paid';
  const authorized = result.status === 'authorized' && result.purpose === 'card_setup';
  const closed = ['cancelled', 'failed', 'refunded', 'reversed'].includes(result.status);
  const title = result.status === 'reversed' ? 'Payment reversed' : result.status === 'refund_pending' ? 'Refund being verified' : result.status === 'refunded' ? 'Payment refunded' : authorized ? 'Card verification complete' : paid ? 'Payment confirmed' : result.status === 'manual_review' ? 'Payment needs review'
    : closed ? 'Payment not completed' : checking || automaticallyChecking ? 'Checking your payment' : result.status === 'unavailable' ? 'Payment status unavailable' : 'Payment not confirmed';
  const message = result.status === 'reversed' ? 'A bank reversal was recorded after review of the final provider decision. Open your account for payment and balance details; do not resume this payment.' : result.status === 'refund_pending' ? `This payment could not complete the purchase. ${getOriginalPaymentRefundCopy(result, result.status)} Do not pay again for this attempt.`
    : result.status === 'refunded' ? getOriginalPaymentRefundCopy(result, result.status)
    : authorized ? 'Return to Saved Cards to review your card. Adding a card does not start a paid subscription.'
    : paid ? 'Rozare has verified your payment and updated your account.'
    : result.status === 'manual_review' ? 'Please contact support with your payment reference. Do not pay again while this is being reviewed.'
      : closed ? 'This payment is closed. You can return to the app.'
        : result.message || 'Your return from Safepay is being verified. Please check again before starting another payment.';
  return <GlassBackground><View style={styles.container}><GlassPanel style={styles.panel}>
    <Ionicons name={paid ? 'checkmark-circle' : 'shield-checkmark-outline'} size={52} color={paid ? '#10b981' : palette.colors.text} />
    <Text style={[styles.title, { color: palette.colors.text }]}>{title}</Text>
    <Text style={[styles.body, { color: palette.colors.textSecondary }]}>{message}</Text>
    {result.environment === 'sandbox' && <Text style={[styles.body, { color: palette.colors.textSecondary }]}>Safepay sandbox · Test payment</Text>}
    {checking ? <ActivityIndicator /> : !paid && !authorized && !closed && <TouchableOpacity onPress={check} style={styles.button} accessibilityRole="button"><Text style={styles.buttonText}>Check payment</Text></TouchableOpacity>}
    {!checking && result.status === 'pending' && <TouchableOpacity onPress={resume} style={styles.button} accessibilityRole="button"><Text style={styles.buttonText}>Resume secure checkout</Text></TouchableOpacity>}
    <TouchableOpacity onPress={() => navigation.navigate('MainTabs')} style={styles.button} accessibilityRole="button"><Text style={styles.buttonText}>Return to Rozare</Text></TouchableOpacity>
  </GlassPanel></View></GlassBackground>;
}
const styles = StyleSheet.create({ container: { flex: 1, justifyContent: 'center', padding: 24 }, panel: { padding: 24, alignItems: 'center', gap: 16 },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center' }, body: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  button: { backgroundColor: '#4f46e5', borderRadius: 12, padding: 14, minWidth: 180, alignItems: 'center' }, buttonText: { color: 'white', fontWeight: '600' } });
