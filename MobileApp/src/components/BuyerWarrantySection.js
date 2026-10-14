import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import { Ionicons } from '@expo/vector-icons';
import Modal from './common/AppModal';
import GlassPanel from './common/GlassPanel';
import KeyboardAwareFormScrollView from './common/KeyboardAwareFormScrollView';
import { useTheme } from '../contexts/ThemeContext';
import api, { API_UPLOAD_TIMEOUT_MS } from '../config/api';
import Feedback from '../utils/feedback';
import { inspectWarrantyCoverage, inspectWarrantyList } from '../utils/warrantySafety';
import { BUYER_CANCELLABLE_RETURN_STATUSES, returnStatusColor, warrantyStatusLabel } from '../utils/returns';
import WarrantyEvidenceHistory from './WarrantyEvidenceHistory';
import { publishAfterSalesChange, subscribeAfterSalesChange } from '../utils/afterSalesRefresh';

const API = '/api/warranties';
const date = value => new Date(value).toLocaleString();
export default function BuyerWarrantySection({ order, formatMoney }) {
  const focused = useIsFocused();
  const { palette } = useTheme(), styles = useMemo(() => createStyles(palette), [palette]);
  const [groups, setGroups] = useState([]), [claims, setClaims] = useState([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [dialog, setDialog] = useState(null);
  const [formError, setFormError] = useState('');
  const [reason, setReason] = useState(''), [quantity, setQuantity] = useState('1'), [photos, setPhotos] = useState([]);
  const generation = useRef(0), working = useRef(false), key = useRef(null);
  const load = useCallback(async ({ quiet = false } = {}) => {
    const sequence = ++generation.current;
    if (!quiet) setLoading(true); setError('');
    try {
      const coverage = await api.get(`${API}/order/${order._id}/eligibility`), rows = [];
      for (let page = 1; ; page += 1) {
        const response = await api.get(`${API}/mine`, { params: { orderId: order._id, page, limit: 100 } });
        if (!Array.isArray(response.data?.returns) || response.data.pagination?.page !== page || !Number.isSafeInteger(response.data.pagination.totalPages) || response.data.pagination.totalPages < page) throw new Error('Warranty history could not be verified.');
        rows.push(...response.data.returns);
        if (page >= response.data.pagination.totalPages) break;
        if (page >= 1000) throw new Error('Warranty history needs support review.');
      }
      const checked = inspectWarrantyCoverage(coverage.data, order);
      if (!checked.valid || !inspectWarrantyList(rows, order)) throw new Error('Warranty details could not be verified. Reload before submitting a claim.');
      if (sequence !== generation.current) return;
      setGroups(checked.groups); setClaims(rows);
    } catch (failure) {
      if (sequence !== generation.current) return;
      setGroups([]); setClaims([]); setError(failure.response?.data?.msg || failure.message || 'Warranty details are unavailable.');
    } finally { if (sequence === generation.current) setLoading(false); }
  }, [order]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load]);
  useEffect(() => subscribeAfterSalesChange(orderId => {
    if (orderId === order._id && focused && AppState.currentState === 'active' && !working.current && !dialog) void load({ quiet: true });
  }), [load, order._id, focused, dialog]);
  const activeClaim = claims.some(claim => !['returned', 'replacement_delivered', 'rejected', 'cancelled_by_buyer'].includes(claim.status));
  useEffect(() => {
    const refresh = () => { if (focused && !working.current && !dialog && AppState.currentState === 'active') load({ quiet: true }); };
    const listener = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    const interval = focused && activeClaim ? setInterval(refresh, 30000) : null;
    if (focused) refresh();
    return () => { listener.remove(); if (interval) clearInterval(interval); };
  }, [load, focused, activeClaim, dialog]);
  const open = selection => {
    key.current = Crypto.randomUUID(); setDialog(selection); setReason(''); setQuantity('1'); setFormError('');
    setPhotos(selection.claim ? selection.claim.evidence.map((id, index) => ({ _id: id, url: selection.claim.evidenceUrls[index] })) : []);
  };
  const pickPhotos = async () => {
    if (working.current || photos.length >= 6) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { Alert.alert('Photo access needed', 'Allow photo access to attach evidence of the product issue.'); return; }
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 6 - photos.length, quality: 0.85 });
    if (picked.canceled) return;
    if (picked.assets.length + photos.length > 6 || picked.assets.some(asset => asset.fileSize > 5242880 || asset.mimeType && !['image/jpeg', 'image/png', 'image/webp'].includes(asset.mimeType))) { Alert.alert('Choose supported photos', 'Attach up to 6 JPEG, PNG or WebP photos, each up to 5 MB.'); return; }
    working.current = true; setBusy(true); setFormError('');
    try {
      for (const asset of picked.assets) {
        const form = new FormData(), mime = asset.mimeType || 'image/jpeg', name = asset.fileName || `warranty-${Date.now()}.jpg`;
        if (Platform.OS === 'web') { const photo = await fetch(asset.uri); form.append('photo', await photo.blob(), name); }
        else form.append('photo', { uri: asset.uri, type: mime, name });
        form.append('orderId', order._id); if (dialog.claim) form.append('claimId', dialog.claim._id);
        const response = await api.post(`${API}/evidence`, form, { timeout: API_UPLOAD_TIMEOUT_MS, headers: { 'Content-Type': 'multipart/form-data' } });
        const evidence = response.data?.evidence;
        if (!/^[a-f\d]{24}$/iu.test(evidence?._id || '') || !/^https:\/\//u.test(evidence?.url || '')) throw new Error('Uploaded photo could not be verified.');
        setPhotos(previous => [...previous, evidence]);
      }
    } catch (failure) { setFormError(failure.response?.data?.msg || failure.message || 'The photo could not be uploaded. Try again.'); }
    finally { working.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (working.current) return;
    const count = Number(quantity);
    const current = dialog.claim ? claims.find(claim => claim._id === dialog.claim._id) : groups.flatMap(group => group.items).find(item => item.orderItemId === dialog.item.orderItemId);
    if (error || reason.trim().length < 10 || !photos.length || !Number.isSafeInteger(count) || count < 1
      || dialog.claim && current?.status !== 'rejected'
      || !dialog.claim && (!current?.eligible || count > current.availableQuantity)) { Alert.alert('Complete the claim', 'Refresh the details, explain the issue, attach a photo and select an eligible quantity.'); return; }
    working.current = true; setBusy(true); setFormError('');
    try {
      const body = { reasonDetails: reason.trim(), evidenceIds: photos.map(photo => photo._id), requestKey: key.current };
      const response = dialog.claim ? await api.post(`${API}/${dialog.claim._id}/appeal`, body)
        : await api.post(API, { ...body, orderId: order._id, sellerId: dialog.sellerId, items: [{ orderItemId: dialog.item.orderItemId, quantity: count }] });
      if (!inspectWarrantyList([response.data?.returnRequest], order)
        || dialog.claim && response.data.returnRequest._id !== dialog.claim._id
        || !dialog.claim && (response.data.returnRequest.items[0].orderItemId !== dialog.item.orderItemId || response.data.returnRequest.items[0].quantity !== count)) throw new Error('Claim confirmation could not be verified. Refresh before trying again.');
      setDialog(null); await load(); publishAfterSalesChange(order._id); Feedback.show({ type: 'success', text1: dialog.claim ? 'Original claim appealed' : 'Warranty claim sent to seller' });
    } catch (failure) { setFormError(failure.response?.data?.msg || failure.message || 'The claim could not be completed. Check the details and try again.'); }
    finally { working.current = false; setBusy(false); }
  };
  const act = (claim, action) => Alert.alert(action === 'cancel' ? 'Cancel warranty request?' : 'Replacement received?', action === 'cancel' ? 'Your original purchase stays unchanged.' : 'Confirm only after the replacement arrives. Your original warranty deadline stays unchanged.', [{ text: 'Not now', style: 'cancel' }, { text: 'Confirm', onPress: async () => {
    if (working.current) return; working.current = true; setBusy(true);
    try {
      const response = await api.post(`${API}/${claim._id}/${action === 'cancel' ? 'cancel' : 'replacement/receive'}`);
      if (!inspectWarrantyList([response.data?.returnRequest], order) || response.data.returnRequest._id !== claim._id) throw new Error('Claim update could not be verified.');
      await load(); publishAfterSalesChange(order._id); Feedback.show({ type: 'success', text1: action === 'cancel' ? 'Claim cancelled' : 'Replacement received' });
    } catch (failure) { Feedback.show({ type: 'error', text1: 'Update not completed', text2: failure.response?.data?.msg || failure.message }); }
    finally { working.current = false; setBusy(false); }
  } }]);
  const button = (text, onPress, secondary = false) => <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onPress} style={[styles.button, secondary && styles.secondary, busy && { opacity: 0.5 }]}><Text style={[styles.buttonText, secondary && styles.text]}>{text}</Text></TouchableOpacity>;
  const gallery = urls => <View style={styles.gallery}>{urls.map((url, index) => <TouchableOpacity key={`${url}-${index}`} accessibilityLabel={`View claim photo ${index + 1}`} onPress={() => Linking.openURL(url).catch(() => Feedback.show({ type: 'error', text1: 'Unable to open photo' }))}><Image source={{ uri: url }} style={styles.photo} contentFit="cover" /></TouchableOpacity>)}</View>;
  return <View style={styles.section}>
    <View style={styles.heading}><Ionicons name="shield-checkmark-outline" size={21} color={palette.colors.primary} /><Text style={[styles.title, { flex: 1 }]}>Warranty</Text><TouchableOpacity accessibilityRole="button" disabled={busy || loading} onPress={() => load()}><Text style={styles.status}>Refresh warranty</Text></TouchableOpacity></View><Text style={styles.muted}>Coverage starts at delivery and uses your saved purchase terms.</Text>
    {loading ? <GlassPanel style={styles.card}><ActivityIndicator color={palette.colors.primary} /><Text style={styles.muted}>Checking coverage…</Text></GlassPanel> : error ? <GlassPanel style={styles.card}><Text style={styles.text}>{error}</Text>{button('Retry', load)}</GlassPanel> : <>
      {groups.flatMap(group => group.items.filter(item => item.months > 0).map(item => <GlassPanel key={item.orderItemId} style={styles.card}><Text style={styles.label}>{item.name}</Text><Text style={styles.muted}>{group.store?.storeName || group.seller.username} · {item.months}-month warranty{item.deadline ? ` · Until ${date(item.deadline)}` : ''}</Text>{!!item.description && <Text style={styles.text}>{item.description}</Text>}{item.eligible ? button('Claim warranty', () => open({ item, sellerId: group.seller._id })) : <Text style={styles.muted}>{item.reason}</Text>}</GlassPanel>))}
      {!groups.some(group => group.items.some(item => item.months > 0)) && <Text style={styles.muted}>No warranty was included with these purchased items.</Text>}
      {claims.map(claim => <GlassPanel key={claim._id} style={styles.card}><Text style={styles.label}>Claim #{claim.returnNumber}</Text><Text style={[styles.status, { color: returnStatusColor(claim.status, palette) }]}>{warrantyStatusLabel(claim.status)}</Text><Text style={styles.text}>{claim.items[0].name} × {claim.items[0].quantity}</Text><Text style={styles.muted}>Original deadline: {date(claim.warrantySnapshot.deadline)}{claim.appealVersion ? ` · Appeal ${claim.appealVersion}` : ''}</Text><Text style={styles.text}>{claim.reasonDetails}</Text>{gallery(claim.evidenceUrls)}{!!claim.resolution && <Text style={styles.label}>Planned resolution: {claim.resolution === 'replacement' ? 'Replacement — no additional payment' : `Rozare Wallet refund ${formatMoney(claim.refund.totalAmount)}`}</Text>}{!!claim.decisionReason && <Text style={styles.text}>Seller’s reason: {claim.decisionReason}</Text>}{!!claim.replacement?.shippedAt && <Text style={styles.text}>Shipment: {claim.replacement.shippingMethod === 'courier' ? `${claim.replacement.carrier} · ${claim.replacement.trackingNumber}` : 'Hand delivery'}</Text>}{claim.status === 'rejected' && button('Appeal original claim', () => open({ claim }))}{BUYER_CANCELLABLE_RETURN_STATUSES.has(claim.status) && button('Cancel request', () => act(claim, 'cancel'), true)}{claim.status === 'replacement_shipped' && button('Confirm replacement received', () => act(claim, 'receive'))}<WarrantyEvidenceHistory entries={claim.evidenceHistory} /><Text style={styles.label}>Claim history</Text>{[...claim.statusHistory].reverse().map((entry, index) => <View key={`${entry.changedAt}-${index}`} style={styles.history}><Text style={styles.status}>{warrantyStatusLabel(entry.status)}</Text><Text style={styles.muted}>{date(entry.changedAt)}</Text>{!!entry.note && <Text style={styles.text}>{entry.note}</Text>}</View>)}</GlassPanel>)}
    </>}
    <Modal visible={Boolean(dialog)} transparent animationType="fade" onRequestClose={() => !working.current && setDialog(null)}><View style={styles.overlay}><GlassPanel variant="modal" style={styles.modal}><KeyboardAwareFormScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{dialog?.claim ? 'Appeal original claim' : 'Claim warranty'}</Text><Text style={styles.muted}>{dialog?.claim ? 'This appeal keeps the original claim and warranty deadline.' : dialog?.item?.name}</Text>
      {!dialog?.claim && <><Text style={styles.label}>Quantity</Text><TextInput accessibilityLabel="Claim quantity" keyboardType="number-pad" value={quantity} onChangeText={next => { setQuantity(next); setFormError(''); }} style={styles.input} editable={!busy} /></>}
      <Text style={styles.label}>Describe the issue</Text><TextInput accessibilityLabel="Warranty reason" value={reason} onChangeText={next => { setReason(next); setFormError(''); }} style={[styles.input, styles.multiline]} multiline maxLength={1500} editable={!busy} placeholder="Explain the fault and any troubleshooting." placeholderTextColor={palette.colors.textSecondary} textAlignVertical="top" />
      {button(`Add photos (${photos.length}/6)`, pickPhotos, true)}<Text style={styles.muted}>1–6 JPEG, PNG or WebP photos, up to 5 MB each. Avoid personal or payment information.</Text><View style={styles.gallery}>{photos.map(photo => <View key={photo._id}><Image source={{ uri: photo.url }} style={styles.photo} contentFit="cover" /><TouchableOpacity disabled={busy} accessibilityLabel="Remove photo" onPress={() => setPhotos(photos.filter(row => row._id !== photo._id))}><Text style={styles.muted}>Remove</Text></TouchableOpacity></View>)}</View>
      {!!formError && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{formError}</Text>}
      {busy && <ActivityIndicator color={palette.colors.primary} />}{button(dialog?.claim ? 'Submit appeal' : 'Submit warranty claim', submit)}{button('Cancel', () => setDialog(null), true)}
    </KeyboardAwareFormScrollView></GlassPanel></View></Modal>
  </View>;
}
const createStyles = p => StyleSheet.create({
  section: { marginTop: 24, gap: 12 }, heading: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  title: { fontSize: 20, color: p.colors.text, fontWeight: '800' }, label: { color: p.colors.text, fontSize: 14, fontWeight: '700' },
  error: { color: p.colors.error, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  text: { color: p.colors.text, fontSize: 13, lineHeight: 19 }, muted: { color: p.colors.textSecondary, fontSize: 12, lineHeight: 18 }, status: { color: p.colors.text, fontSize: 12, fontWeight: '700' },
  card: { padding: 16, borderRadius: 20, gap: 10 }, gallery: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, photo: { width: 80, height: 80, borderRadius: 12 }, history: { borderLeftWidth: 2, borderLeftColor: p.colors.primary, paddingLeft: 10, gap: 4 },
  button: { backgroundColor: p.colors.primary, borderRadius: 14, minHeight: 46, padding: 12, alignItems: 'center', justifyContent: 'center' }, buttonText: { color: '#fff', fontSize: 13, fontWeight: '700' }, secondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: p.colors.border },
  // The shared keyboard-aware scroller fills its parent. Give it a bounded
  // viewport; maxHeight alone collapses the native form to an empty panel.
  overlay: { flex: 1, justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.55)', padding: 18 }, modal: { height: '88%', maxHeight: 760, width: '100%', maxWidth: 520, padding: 0, borderRadius: 24, alignSelf: 'center' }, content: { padding: 20, gap: 12 }, input: { borderWidth: 1, borderColor: p.colors.border, color: p.colors.text, padding: 12, borderRadius: 14, minHeight: 46 }, multiline: { minHeight: 110 },
});
