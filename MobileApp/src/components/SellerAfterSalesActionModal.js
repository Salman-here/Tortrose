import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import Modal from './common/AppModal';
import GlassPanel from './common/GlassPanel';
import KeyboardAwareFormScrollView from './common/KeyboardAwareFormScrollView';
import { useTheme } from '../contexts/ThemeContext';
import api from '../config/api';
import Feedback from '../utils/feedback';
import { inspectReturnPresentationSnapshot } from '../utils/returnPresentationSafety';

export default function SellerAfterSalesActionModal({ action, kind, onClose, onSuccess }) {
  const { palette } = useTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const [reason, setReason] = useState(''), [resolution, setResolution] = useState('');
  const [method, setMethod] = useState('courier'), [carrier, setCarrier] = useState(''), [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false), working = useRef(false), key = useRef(Crypto.randomUUID());
  const decision = action.type === 'decision', approval = action.status === 'approved';
  const submit = async () => {
    if (working.current || !inspectReturnPresentationSnapshot(action.request).valid) return;
    if (decision && (reason.trim().length < 10 || approval && !resolution)
      || !decision && method === 'courier' && (carrier.trim().length < 2 || tracking.trim().length < 3)) {
      Feedback.show({ type: 'error', text1: decision ? 'Give a reason and declare the resolution' : 'Add the carrier and tracking number' }); return;
    }
    working.current = true; setBusy(true);
    try {
      const base = `/api/${kind === 'warranty' ? 'warranties' : 'returns'}/${action.request._id}`;
      const response = await api.post(`${base}/${decision ? 'decision' : 'replacement/dispatch'}`, decision
        ? { outcome: approval ? 'approve' : 'reject', resolution, reason: reason.trim(), expectedUpdatedAt: action.request.updatedAt }
        : { shippingMethod: method, carrier: carrier.trim(), trackingNumber: tracking.trim(), operationKey: key.current, expectedUpdatedAt: action.request.updatedAt });
      if (!inspectReturnPresentationSnapshot(response.data?.returnRequest).valid) throw new Error('The claim update could not be verified. Refresh before trying again.');
      Feedback.show({ type: 'success', text1: decision ? 'Decision sent to the buyer' : 'Replacement shipped' });
      onClose(); await onSuccess();
    } catch (error) { Feedback.show({ type: 'error', text1: 'Action not completed', text2: error.response?.data?.msg || error.message }); }
    finally { working.current = false; setBusy(false); }
  };
  const field = (label, value, setter, multiline = false, length = 1000) => <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} value={value} onChangeText={setter} style={[styles.input, multiline && styles.multiline]} multiline={multiline} editable={!busy} maxLength={length} textAlignVertical={multiline ? 'top' : 'center'} placeholderTextColor={palette.colors.textSecondary} /></View>;
  const choice = (value, label, active, setter) => <TouchableOpacity key={value} accessibilityRole="radio" accessibilityState={{ checked: active }} style={[styles.choice, active && styles.active]} disabled={busy} onPress={() => setter(value)}><Text style={[styles.text, active && styles.activeText]}>{label}</Text></TouchableOpacity>;
  return <Modal visible transparent animationType="fade" onRequestClose={() => !working.current && onClose()}><View style={styles.overlay}><GlassPanel variant="modal" style={styles.modal}><KeyboardAwareFormScrollView contentContainerStyle={styles.content}>
    <Text style={styles.title}>{decision ? approval ? 'Approve warranty claim' : 'Decline warranty claim' : 'Dispatch replacement'}</Text><Text style={styles.muted}>#{action.request.returnNumber}</Text>
    {decision ? <>{approval && <View style={styles.field}><Text style={styles.label}>Planned resolution</Text>{choice('refund', 'Refund to Rozare Wallet', resolution === 'refund', setResolution)}{choice('replacement', 'Replacement product', resolution === 'replacement', setResolution)}</View>}{field('Decision reason (required)', reason, setReason, true)}<Text style={styles.muted}>The buyer sees your decision and reason. Approval does not reserve earnings or charge a card.</Text></> : <><Text style={styles.muted}>Dispatch the original product and purchased options. Stock is deducted once; the buyer does not pay again.</Text>{choice('courier', 'Courier delivery', method === 'courier', setMethod)}{choice('hand_delivery', 'Hand delivery', method === 'hand_delivery', setMethod)}{method === 'courier' && <>{field('Carrier', carrier, setCarrier, false, 100)}{field('Tracking number', tracking, setTracking, false, 160)}</>}</>}
    <TouchableOpacity accessibilityRole="button" style={[styles.submit, busy && { opacity: 0.5 }]} disabled={busy} onPress={submit}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>{decision ? 'Confirm decision' : 'Confirm dispatch'}</Text>}</TouchableOpacity><TouchableOpacity disabled={busy} onPress={onClose} style={styles.choice}><Text style={styles.text}>Cancel</Text></TouchableOpacity>
  </KeyboardAwareFormScrollView></GlassPanel></View></Modal>;
}
const createStyles = p => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: 20, backgroundColor: 'rgba(0,0,0,0.55)' },
  // Keep the flex scroller inside a real viewport on Android and iOS.
  modal: { width: '100%', maxWidth: 520, height: '88%', maxHeight: 760, padding: 0, alignSelf: 'center', borderRadius: 24 },
  content: { padding: 20, gap: 12 }, title: { color: p.colors.text, fontSize: 21, fontWeight: '800' },
  text: { color: p.colors.text, fontSize: 14 }, muted: { color: p.colors.textSecondary, fontSize: 12, lineHeight: 18 },
  field: { gap: 8 }, label: { color: p.colors.text, fontWeight: '700', fontSize: 13 },
  input: { color: p.colors.text, borderColor: p.colors.border, borderWidth: 1, borderRadius: 14, padding: 12, minHeight: 48 }, multiline: { minHeight: 110 },
  choice: { borderColor: p.colors.border, borderWidth: 1, borderRadius: 14, padding: 14 }, active: { borderColor: p.colors.primary, backgroundColor: p.colors.primary + '12' }, activeText: { color: p.colors.primary, fontWeight: '700' },
  submit: { backgroundColor: p.colors.primary, borderRadius: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 }, submitText: { color: '#fff', fontWeight: '700' },
});
