import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import Modal from './common/AppModal';
import GlassPanel from './common/GlassPanel';
import ProductOptionsModal from './common/ProductOptionsModal';
import { useTheme } from '../contexts/ThemeContext';
import { useGlobal } from '../contexts/GlobalContext';
import { cartVariantLabel, findProductCartLine, getCartProductQuantity } from '../utils/cartProductSelection';
const EMPTY = Object.freeze({});
export default function CartVariantsDialog({ open, product, onClose }) {
  const { palette } = useTheme();
  const { cartItems, handleAddToCart, handleEditCartVariant, handleQtyInc, handleQtyDec, handleRemoveCartItem, qtyUpdateId, isCartLoading } = useGlobal();
  const lines = (cartItems?.cart || []).filter(line => String(line.product?._id || line.productId) === String(product?._id));
  const [view,setView] = useState('manage'),[editing,setEditing] = useState(null),[error,setError] = useState(''),[busy,setBusy] = useState(false);
  const working = useRef(false);
  const seeded = useRef(null);
  useEffect(() => { if (!open) { seeded.current = null; return; } if (seeded.current === product?._id) return; seeded.current = product?._id; setView(lines.length ? 'manage' : 'add'); setEditing(null); setError(''); }, [open,product?._id,lines.length]);
  const blocked = busy || Boolean(qtyUpdateId) || isCartLoading;
  const submit = async choices => {
    if (working.current) return; working.current = true; setBusy(true); setError('');
    try {
      if (view === 'edit') await handleEditCartVariant(editing,product,choices);
      else if (findProductCartLine(product,cartItems?.cart,choices.selectedOptions,choices.selectedColor)) { setError('That variant is already in your bag. Adjust its quantity below.'); setView('manage'); return; }
      else if (!await handleAddToCart(product._id,choices.selectedColor,choices.selectedOptions,product,'add')) throw new Error('The variant was not added. Try again.');
      setView('manage'); setEditing(null);
    } catch (failure) { setError(failure.message); }
    finally { working.current = false; setBusy(false); }
  };
  if (!open || !product) return null;
  if (view !== 'manage') return <ProductOptionsModal visible product={product} selectedOptions={editing?.selectedOptions || EMPTY} selectedColor={editing?.selectedColor || null}
    title={view === 'edit' ? 'Edit variant' : lines.length ? 'Add another variant' : 'Choose options'} confirmLabel={view === 'edit' ? 'Save changes' : 'Add variant to cart'}
    description={view === 'edit' ? 'Your quantity stays the same. Matching variants are combined into one line.' : 'Choose one combination. Repeat to add other colors or sizes.'}
    error={error} submitting={busy} onConfirm={submit} onClose={() => { if (!working.current) { if (lines.length) setView('manage'); else onClose(); setError(''); } }} />;
  const button = (label,onPress,disabled = blocked,caption = label) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ padding:12,borderRadius:12,borderWidth:1,borderColor:palette.colors.border,opacity:disabled?0.45:1 }}><Text style={{ color:palette.colors.primary,fontWeight:'700',fontSize:13 }}>{caption}</Text></TouchableOpacity>;
  return <Modal visible transparent animationType="fade" onRequestClose={() => !blocked && onClose()}><View style={{ flex:1,justifyContent:'center',padding:20,backgroundColor:'rgba(0,0,0,0.55)' }}><GlassPanel variant="modal" style={{ width:'100%',maxWidth:520,height:'85%',maxHeight:700,padding:20,alignSelf:'center' }}>
    <View style={{ flexDirection:'row',alignItems:'center',gap:12 }}><Text style={{ color:palette.colors.text,fontSize:23,fontWeight:'800',flex:1 }}>Your variants</Text>{button('Close',onClose)}</View><Text style={{ color:palette.colors.textSecondary,marginTop:10 }}>{product.name}</Text><Text style={{ color:palette.colors.textSecondary,fontSize:13,lineHeight:20,marginVertical:14 }}>Add colors or sizes separately. Edit changes an existing choice; it does not add a copy.</Text>
    <ScrollView style={{ flex:1 }} contentContainerStyle={{ gap:12,paddingBottom:16 }}>{lines.map(line => { const label = cartVariantLabel(product,line) || 'Options need updating'; return <View key={line._id} style={{ padding:14,borderRadius:16,borderWidth:1,borderColor:palette.colors.border,gap:12 }}><Text style={{ color:palette.colors.text,fontWeight:'700' }}>{label}</Text><View style={{ flexDirection:'row',alignItems:'center',gap:12 }}>{button(`Decrease ${label}`,() => handleQtyDec(line._id),blocked,'−')}<Text accessibilityLabel={`Quantity ${label}`} style={{ color:palette.colors.text,fontWeight:'700' }}>{line.qty}</Text>{button(`Increase ${label}`,() => handleQtyInc(line._id),blocked || getCartProductQuantity(product,cartItems?.cart)>=product.stock,'+')}</View><View style={{ flexDirection:'row',gap:10 }}>{button(`Edit ${label}`,() => { setEditing({...line}); setError(''); setView('edit'); },blocked,'Edit')}{button(`Remove ${label}`,() => handleRemoveCartItem(line._id),blocked,'Remove')}</View></View>; })}{!lines.length && <Text style={{ color:palette.colors.text }}>No variants in your bag yet.</Text>}</ScrollView>
    {!!error && <Text accessibilityRole="alert" style={{ color:palette.colors.error,marginVertical:10 }}>{error}</Text>}
    {button('+ Add another variant',() => { setEditing(null); setError(''); setView('add'); },blocked || getCartProductQuantity(product,cartItems?.cart)>=product.stock)}
  </GlassPanel></View></Modal>;
}
