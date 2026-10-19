import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Modal from './common/AppModal';
import GlassPanel from './common/GlassPanel';
import ProductOptionsModal from './common/ProductOptionsModal';
import { useTheme } from '../contexts/ThemeContext';
import { useGlobal } from '../contexts/GlobalContext';
import { getModalPalette } from '../styles/modalTheme';
import { cartVariantLabel, findProductCartLine, getCartProductQuantity } from '../utils/cartProductSelection';

const EMPTY = Object.freeze({});
export default function CartVariantsDialog({ open, product, onClose }) {
  const { palette: basePalette } = useTheme();
  const palette = getModalPalette(basePalette);
  const insets = useSafeAreaInsets(), { height } = useWindowDimensions();
  const { cartItems, handleAddToCart, handleEditCartVariant, handleQtyInc, handleQtyDec, handleRemoveCartItem, qtyUpdateId, isCartLoading } = useGlobal();
  const lines = (cartItems?.cart || []).filter(line => String(line.product?._id || line.productId) === String(product?._id));
  const [view, setView] = useState('manage'), [editing, setEditing] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const working = useRef(false), seeded = useRef(null);
  useEffect(() => {
    if (!open) { seeded.current = null; return; }
    if (seeded.current === product?._id) return;
    seeded.current = product?._id; setView(lines.length ? 'manage' : 'add'); setEditing(null); setError('');
  }, [open, product?._id, lines.length]);
  const blocked = busy || Boolean(qtyUpdateId) || isCartLoading;
  const displayView = seeded.current === product?._id ? view : lines.length ? 'manage' : 'add';
  const submit = async choices => {
    if (working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      if (displayView === 'edit') {
        if (await handleEditCartVariant(editing, product, choices) === false) throw new Error('The variant was not updated. Try again.');
      } else if (findProductCartLine(product, cartItems?.cart, choices.selectedOptions, choices.selectedColor)) {
        setError('This variant is already in your cart. Close options to adjust its quantity.'); return;
      } else if (!await handleAddToCart(product._id, choices.selectedColor, choices.selectedOptions, product, 'add')) {
        throw new Error('The variant was not added. Try again.');
      }
      setEditing(null); onClose();
    } catch (failure) { setError(failure.message); }
    finally { working.current = false; setBusy(false); }
  };
  const updateLine = async action => {
    if (working.current || blocked) return;
    working.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { setError(failure.message || 'Your cart could not be updated. Please try again.'); }
    finally { working.current = false; setBusy(false); }
  };
  if (!open || !product) return null;
  if (displayView !== 'manage') return <ProductOptionsModal visible product={product} selectedOptions={displayView === 'edit' ? editing?.selectedOptions || EMPTY : EMPTY} selectedColor={displayView === 'edit' ? editing?.selectedColor || null : null}
    title={displayView === 'edit' ? 'Edit variant' : lines.length ? 'Add another variant' : 'Choose options'} confirmLabel={displayView === 'edit' ? 'Save changes' : 'Add variant to cart'}
    description={displayView === 'edit' ? 'Your quantity stays the same. Matching variants are combined.' : 'Select the options for this item.'}
    error={error} submitting={busy} onConfirm={submit} onClose={() => { if (!working.current) { onClose(); setError(''); } }} />;
  const total = getCartProductQuantity(product, cartItems?.cart), photo = product.image || product.images?.[0]?.url;
  const border = { borderColor: palette.glass.borderSubtle };
  const iconButton = (label, icon, onPress, disabled = blocked, destructive = false) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={[styles.iconButton, border, { backgroundColor: palette.glass.bgSubtle, opacity: disabled ? 0.4 : 1 }]}><Ionicons name={icon} size={18} color={destructive ? palette.colors.error : palette.colors.text} /></TouchableOpacity>;
  return <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => !blocked && onClose()}>
    <View style={[styles.overlay, { paddingTop: insets.top + 16, paddingBottom: Math.max(insets.bottom, 16) }]}>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Dismiss cart variants" onPress={() => !blocked && onClose()} />
      <GlassPanel variant="modal" style={[styles.panel, { maxHeight: Math.max(180, Math.min(height - insets.top - Math.max(insets.bottom, 16) - 32, 680)) }]}>
        <View style={[styles.heading, border]}><View style={styles.headingCopy}><Text style={[styles.eyebrow, { color: palette.colors.primary }]}>IN YOUR CART</Text><Text style={[styles.title, { color: palette.colors.text }]}>Your variants</Text></View>{iconButton('Close', 'close', onClose)}</View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={[styles.product, border, { backgroundColor: palette.glass.bgSubtle }]}>
            {photo ? <Image source={{ uri: photo }} style={styles.photo} contentFit="cover" /> : <View style={[styles.photo, styles.placeholder]}><Ionicons name="bag-handle-outline" size={25} color={palette.colors.primary} /></View>}
            <View style={styles.productCopy}><Text numberOfLines={2} style={[styles.productName, { color: palette.colors.text }]}>{product.name}</Text><Text style={[styles.count, { color: palette.colors.textSecondary }]}>{total} {total === 1 ? 'item' : 'items'} · {lines.length} {lines.length === 1 ? 'variant' : 'variants'}</Text></View>
          </View>
          {lines.map(line => { const label = cartVariantLabel(product, line) || 'Options need updating'; return <View key={line._id} style={[styles.variant, border]}>
            <View style={styles.row}><View style={[styles.choiceMark, { backgroundColor: palette.glass.bgSubtle }]}><Ionicons name="checkmark" size={15} color={palette.colors.primary} /></View><Text style={[styles.variantName, { color: palette.colors.text }]}>{label}</Text>{iconButton(`Remove ${label}`, 'trash-outline', () => updateLine(() => handleRemoveCartItem(line._id)), blocked, true)}</View>
            <View style={[styles.row, styles.controls]}><View style={[styles.stepper, border, { backgroundColor: palette.glass.bgSubtle }]}>
              {iconButton(`Decrease ${label}`, line.qty === 1 ? 'close' : 'remove', () => updateLine(() => handleQtyDec(line._id)))}<Text accessibilityLabel={`Quantity ${label}`} style={[styles.quantity, { color: palette.colors.text }]}>{line.qty}</Text>{iconButton(`Increase ${label}`, 'add', () => updateLine(() => handleQtyInc(line._id)), blocked || total >= product.stock)}
            </View><TouchableOpacity accessibilityRole="button" accessibilityLabel={`Edit ${label}`} disabled={blocked} onPress={() => { setEditing({ ...line }); setError(''); setView('edit'); }} style={[styles.edit, { opacity: blocked ? 0.4 : 1 }]}><Ionicons name="options-outline" size={16} color={palette.colors.primary} /><Text style={{ color: palette.colors.primary, fontWeight: '700', fontSize: 13 }}>Change options</Text></TouchableOpacity></View>
          </View>; })}
          {!lines.length && <Text style={{ color: palette.colors.textSecondary }}>No variants in your cart yet.</Text>}
          {!!error && <Text accessibilityRole="alert" style={{ color: palette.colors.error, lineHeight: 19 }}>{error}</Text>}
        </ScrollView>
        <View style={[styles.footer, border]}><TouchableOpacity accessibilityRole="button" accessibilityLabel="+ Add another variant" disabled={blocked || total >= product.stock} onPress={() => { setEditing(null); setError(''); setView('add'); }} style={[styles.add, { opacity: blocked || total >= product.stock ? 0.45 : 1 }]}>
          <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />{busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="add-circle-outline" size={20} color="#fff" />}<Text style={styles.addText}>Add another variant</Text>
        </TouchableOpacity></View>
      </GlassPanel>
    </View>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: 'rgba(7,12,28,0.40)' },
  panel: { width: '100%', maxWidth: 540, alignSelf: 'center', padding: 0, borderRadius: 26, overflow: 'hidden', flexShrink: 1 },
  heading: { flexDirection: 'row', alignItems: 'center', padding: 18, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexShrink: 0 },
  headingCopy: { flex: 1 }, eyebrow: { fontSize: 9, letterSpacing: 1.5, fontWeight: '800', marginBottom: 3 }, title: { fontSize: 21, fontWeight: '800' },
  scroll: { flexGrow: 0, flexShrink: 1, minHeight: 0 }, content: { padding: 16, gap: 12 },
  product: { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 12, borderRadius: 18, borderWidth: 1 },
  photo: { width: 60, height: 60, borderRadius: 13 }, placeholder: { alignItems: 'center', justifyContent: 'center' },
  productCopy: { flex: 1, minWidth: 0 }, productName: { fontSize: 14, lineHeight: 19, fontWeight: '700' }, count: { marginTop: 5, fontSize: 12 },
  variant: { borderWidth: 1, borderRadius: 18, padding: 12, gap: 10 }, row: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  choiceMark: { width: 26, height: 26, borderRadius: 9, justifyContent: 'center', alignItems: 'center' },
  variantName: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, fontWeight: '700' }, controls: { justifyContent: 'space-between', flexWrap: 'wrap' },
  iconButton: { width: 36, height: 36, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  stepper: { flexDirection: 'row', alignItems: 'center', borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, padding: 3, gap: 8 },
  quantity: { minWidth: 24, textAlign: 'center', fontWeight: '800', fontSize: 14 }, edit: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 10 },
  footer: { padding: 16, borderTopWidth: StyleSheet.hairlineWidth, flexShrink: 0 }, add: { minHeight: 50, padding: 14, borderRadius: 15, overflow: 'hidden', flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center' }, addText: { color: '#fff', fontWeight: '700', fontSize: 14, flexShrink: 1, textAlign: 'center' },
});
