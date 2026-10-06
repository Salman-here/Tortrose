import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../config/api';
import GlassPanel from './common/GlassPanel';
import { useTheme } from '../contexts/ThemeContext';
import { getOrderSellerGroups, getOrderCurrency, assertOrderDetailPresentation } from '../utils/orderPresentation';
import { assertCancellationQuote } from '../utils/cancellationQuote';

export default function BuyerCancellationModal({ order, sellerIds, formatMoney, onClose, onCancelled, onBusyChange }) {
  const { palette } = useTheme();
  const [quote, setQuote] = useState(null), [destination, setDestination] = useState('wallet');
  const [accepted, setAccepted] = useState(false), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const submitting = useRef(false);
  const scopeKey = sellerIds?.join(',') || 'all';
  useEffect(() => {
    let active = true;
    setQuote(null); setError(''); setLoading(true); setAccepted(false);
    (async () => {
      try {
        const groups = getOrderSellerGroups(order);
        const selected = sellerIds || groups.filter(row => row.canCancel === true).map(row => row.sellerId);
        const grossMinor = groups.filter(row => selected.includes(row.sellerId) && row.canCancel === true)
          .reduce((n, row) => n + Math.round(row.summary.totalAmount * 100), 0);
        const res = await api.post(`/api/order/cancel/${order._id}/preview`, { sellerIds: selected });
        const value = assertCancellationQuote(res.data?.quote, { orderId: order._id, currency: getOrderCurrency(order),
          paymentMethod: order.paymentMethod, sellerIds: selected, grossMinor });
        if (active) { setQuote(value); setDestination(value.defaultDestination); }
      } catch (err) { if (active) setError(err.response?.data?.msg || err.message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [order, scopeKey, reload]);
  const chosen = quote?.options.find(row => row.destination === destination);
  const consentNeeded = (chosen?.deductionMinor || 0) > 0;
  const cancel = async () => {
    if (submitting.current || busy || !quote || !chosen?.available || consentNeeded && !accepted) return;
    submitting.current = true;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      const res = await api.patch(`/api/order/cancel/${order._id}`, { sellerIds: quote.activeSellerIds,
        refundDestination: destination, quoteId: quote.quoteId, acceptDeduction: accepted });
      if (res.data?.order?._id !== order._id) throw new Error('The cancellation response could not be verified. Refresh the order.');
      assertOrderDetailPresentation(res.data.order);
      await onCancelled(res.data.order); onClose();
    } catch (err) { setError(err.response?.data?.msg || err.message); if (err.response?.status === 409) setQuote(null); }
    finally { submitting.current = false; setBusy(false); onBusyChange?.(false); }
  };
  const text = { color: palette.colors.textPrimary }, muted = { color: palette.colors.textSecondary };
  return <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => !busy && onClose()}>
    <View style={styles.overlay}><GlassPanel variant="strong" style={styles.panel}>
      <View style={styles.header}><Text style={[styles.title, text]}>Cancel {sellerIds ? 'this store’s items' : 'order'}?</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close cancellation" disabled={busy} onPress={onClose} style={styles.close}><Ionicons name="close" size={21} color={palette.colors.textPrimary} /></TouchableOpacity></View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.copy, muted]}>{sellerIds ? 'Only this store’s unshipped items will be cancelled. Other stores stay unchanged.' : 'The selected unshipped items will be cancelled and the sellers notified.'}</Text>
        {loading && <View style={styles.loading}><ActivityIndicator color={palette.colors.primary} /><Text style={[styles.copy, muted]}>Checking refund amounts…</Text></View>}
        {!!error && <View style={styles.error}><Text accessibilityRole="alert" style={{ color: palette.colors.error }}>{error}</Text>
          {!busy && <TouchableOpacity accessibilityRole="button" onPress={() => setReload(n => n + 1)}><Text style={[styles.retry, { color: palette.colors.primary }]}>Refresh refund amounts</Text></TouchableOpacity>}</View>}
        {quote && <>
          {quote.paymentMethod === 'safepay' && quote.grossMinor > 0 && <Text style={[styles.heading, text]}>Where would you like your refund?</Text>}
          {quote.options.map(option => <TouchableOpacity key={option.destination} accessibilityRole={quote.options.length > 1 ? 'radio' : 'button'}
            accessibilityState={{ checked: destination === option.destination, disabled: busy || !option.available }}
            disabled={busy || !option.available} onPress={() => { setDestination(option.destination); setAccepted(false); }}
            style={[styles.option, { borderColor: destination === option.destination ? palette.colors.primary : palette.colors.border,
              backgroundColor: destination === option.destination ? `${palette.colors.primary}12` : 'rgba(255,255,255,0.12)', opacity: option.available ? 1 : 0.5 }]}>
            <View style={styles.row}><Ionicons name={option.destination === 'original_card' ? 'card-outline' : 'wallet-outline'} size={21} color={palette.colors.primary} />
              <Text style={[styles.heading, text, { flex: 1 }]}>{option.label}</Text>{destination === option.destination && <Ionicons name="checkmark-circle" size={19} color={palette.colors.primary} />}</View>
            {option.destination === 'wallet' && quote.options.length > 1 && <Text style={[styles.copy, { color: palette.colors.success }]}>Full refund</Text>}
            {option.destination !== 'none' && <>
              <View style={styles.row}><Text style={[styles.copy, muted]}>Cancelled amount</Text><Text style={[styles.copy, text]}>{formatMoney(quote.grossMinor / 100)}</Text></View>
              {option.destination === 'original_card' && <View style={styles.row}><Text style={[styles.copy, muted]}>Processing fee</Text><Text style={[styles.copy, text]}>{formatMoney(option.deductionMinor / 100)}</Text></View>}
              <View style={styles.row}><Text style={[styles.heading, text]}>You receive</Text><Text style={[styles.heading, text]}>{formatMoney(option.amountMinor / 100)}</Text></View>
              {option.destination === 'original_card' && <Text style={[styles.copy, muted]}>Returned to the card used for this order after verification. Your bank may take additional time to display it.</Text>}
            </>}
          </TouchableOpacity>)}
          {consentNeeded && <TouchableOpacity accessibilityRole="checkbox" accessibilityState={{ checked: accepted }} disabled={busy} onPress={() => setAccepted(v => !v)} style={styles.consent}>
            <Ionicons name={accepted ? 'checkbox' : 'square-outline'} size={23} color={palette.colors.primary} /><Text style={[styles.copy, muted, { flex: 1 }]}>I agree to the processing fee shown above.</Text></TouchableOpacity>}
        </>}
      </ScrollView>
      <View style={styles.actions}><TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onClose} style={styles.keep}><Text style={[styles.heading, text]}>Keep order</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={cancel} disabled={loading || busy || !quote || !chosen?.available || consentNeeded && !accepted}
          style={[styles.confirm, { backgroundColor: palette.colors.error, opacity: loading || busy || !quote || !chosen?.available || consentNeeded && !accepted ? 0.4 : 1 }]}>
          <Text style={[styles.heading, { color: '#fff' }]}>{busy ? 'Cancelling…' : sellerIds ? 'Cancel store items' : 'Cancel order'}</Text></TouchableOpacity></View>
    </GlassPanel></View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex:1, backgroundColor:'rgba(12,18,35,0.5)', justifyContent:'center', padding:18 },
  panel: { width:'100%', maxWidth:480, maxHeight:'85%', alignSelf:'center', padding:18, borderRadius:24 },
  header: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:12 },
  title: { fontSize:18, fontWeight:'700', flex:1 }, close: { padding:7 }, scroll: { flexGrow:0 }, content: { gap:12, paddingBottom:4 },
  copy: { fontSize:12, lineHeight:19 }, heading: { fontSize:13, fontWeight:'700' }, option: { borderWidth:1.5, borderRadius:17, padding:14, gap:10 },
  row: { flexDirection:'row', alignItems:'center', justifyContent:'space-between', gap:8 }, consent: { flexDirection:'row', alignItems:'flex-start', gap:10, padding:4 },
  loading: { flexDirection:'row', alignItems:'center', gap:10, paddingVertical:15 }, error: { padding:12, borderRadius:13, backgroundColor:'rgba(239,68,68,0.08)' }, retry: { fontSize:12, fontWeight:'600', marginTop:8 },
  actions: { flexDirection:'row', justifyContent:'flex-end', gap:9, marginTop:15 }, keep: { padding:12, borderRadius:13 }, confirm: { padding:12, borderRadius:13 },
});
