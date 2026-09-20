import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { useBuyerLocation } from '../../contexts/BuyerLocationContext';
import { useAuth } from '../../contexts/AuthContext';
import { EMPTY_SHOPPING_LOCATION, shoppingLocationIsValid } from '../../utils/shoppingLocation';
import ShoppingLocationFields from './ShoppingLocationFields';

export default function ShoppingLocationPrompt({ enabled = false, routeName = '' }) {
  const { palette } = useTheme();
  const { currentUser } = useAuth();
  const { height: viewportHeight } = useWindowDimensions();
  const { buyerLocation, detecting, selectionRequired, editorOpen, closeLocationSelector, updateBuyerLocation } = useBuyerLocation();
  const privateChat = routeName === 'AIChat' && ['seller', 'admin'].includes(currentUser?.role);
  const open = editorOpen || (enabled && !privateChat && selectionRequired);
  const [draft, setDraft] = useState(buyerLocation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const touched = useRef(false), wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) { touched.current = false; setError(''); }
    if (open && !touched.current) setDraft(selectionRequired
      ? { ...EMPTY_SHOPPING_LOCATION, country: buyerLocation.country, countryCode: buyerLocation.countryCode }
      : { ...buyerLocation });
    wasOpen.current = open;
  }, [open, buyerLocation, selectionRequired]);
  const save = async () => {
    if (saving || !shoppingLocationIsValid(draft)) return;
    setSaving(true); setError('');
    try { await updateBuyerLocation(draft); } catch (err) { setError(err.message || 'Choose a shopping location.'); }
    finally { setSaving(false); }
  };
  return <Modal visible={open} transparent animationType="fade" onRequestClose={() => { if (!selectionRequired && !saving) closeLocationSelector(); }} statusBarTranslucent navigationBarTranslucent>
    <SafeAreaView style={styles.overlay}>
      <View style={[styles.panel, { height: Math.min(viewportHeight * 0.88, selectionRequired ? 640 : 850), backgroundColor: palette.colors.background, borderColor: palette.glass.borderSubtle }]} accessibilityViewIsModal>
        <ScrollView style={{ flex: 1 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={styles.heading}><Text style={[styles.title, { color: palette.colors.text }]}>Where would you like to shop?</Text>
            {!selectionRequired && <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close shopping location" disabled={saving} onPress={closeLocationSelector}><Ionicons name="close" size={24} color={palette.colors.text} /></TouchableOpacity>}
          </View>
          <Text style={[styles.help, { color: palette.colors.textSecondary }]}>Choose a country or explore stores that sell globally.</Text>
          {detecting ? <Text style={[styles.help, { color: palette.colors.textSecondary }]}>Detecting your country… You can also choose it below.</Text> : selectionRequired && !buyerLocation.country ? <Text style={[styles.help, { color: palette.colors.textSecondary }]}>We could not reliably detect your country. Choose a country or Global.</Text> : null}
          <ShoppingLocationFields value={draft} disabled={saving} advanced={!selectionRequired} onInteraction={() => { touched.current = true; }} onChange={next => { touched.current = true; setDraft(next); }} />
          <Text style={[styles.help, { color: palette.colors.textSecondary }]}>You can change your selection any time in Filters. This does not change your currency or delivery address.</Text>
          {!!error && <Text accessibilityRole="alert" style={{ color: palette.colors.error }}>{error}</Text>}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={selectionRequired ? 'Start shopping' : 'Save shopping location'} disabled={saving || !shoppingLocationIsValid(draft)} onPress={save} style={[styles.save, { backgroundColor: palette.colors.primary, opacity: saving || !shoppingLocationIsValid(draft) ? 0.5 : 1 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveLabel}>{selectionRequired ? 'Start shopping' : 'Save shopping location'}</Text>}
          </TouchableOpacity>
        </ScrollView>
      </View>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.48)', justifyContent: 'center', padding: 16 },
  panel: { maxHeight: '92%', width: '100%', maxWidth: 580, alignSelf: 'center', borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
  content: { padding: 20, gap: 16 }, heading: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  title: { flex: 1, fontSize: 22, lineHeight: 29, fontWeight: '800' }, help: { fontSize: 13, lineHeight: 20 },
  save: { borderRadius: 15, minHeight: 48, padding: 14, alignItems: 'center', justifyContent: 'center' }, saveLabel: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
