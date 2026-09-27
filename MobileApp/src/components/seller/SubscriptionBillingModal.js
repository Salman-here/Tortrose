import React, { useMemo } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Picker } from '@react-native-picker/picker';
import { Ionicons } from '@expo/vector-icons';
import GlassPanel from '../common/GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { fontSize, fontWeight, spacing } from '../../styles/theme';

export const billingDialogHeight = (windowHeight, insets) => Math.max(1, Math.min(
  680, windowHeight - insets.top - insets.bottom - spacing.lg * 2,
));

export default function SubscriptionBillingModal({
  quote, cards, cardId, onCardChange, consent, onConsentChange, busy, onConfirm, onClose, formatUsd,
}) {
  const { palette } = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const close = () => { if (!busy) onClose(); };
  const confirmDisabled = !consent || !cardId || busy;
  if (!quote) return null;

  return (
    <Modal transparent visible animationType="slide" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      <View style={[styles.backdrop, {
        paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg,
        paddingLeft: insets.left + spacing.lg, paddingRight: insets.right + spacing.lg,
      }]}>
        {/* A flex scroll view needs a definite parent height. maxHeight alone
            previously collapsed this Android dialog to its padding. A Modal
            is also a separate native window, so do not reuse the screen's blur target. */}
        <GlassPanel testID="subscription-billing-dialog" androidBlur={false}
          style={[styles.panel, { height: billingDialogHeight(height, insets) }]} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>Review your subscription</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close subscription review"
              accessibilityState={{ disabled: busy }} disabled={busy} onPress={close} style={styles.close}>
              <Ionicons name="close" size={22} color={palette.colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView testID="subscription-billing-scroll" style={styles.body}
            contentContainerStyle={styles.content} showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
            <Text style={styles.planName}>{quote.planName}</Text>
            <Text style={styles.text}>Due now: {formatUsd(quote.dueNowMinor)} USD</Text>
            <Text style={styles.text}>Recurring price: {formatUsd(quote.monthlyAmountMinor)} USD/month</Text>
            {!!quote.freePeriodDays && <Text style={styles.secondary}>First {quote.freePeriodDays} days free.</Text>}
            {!!quote.creditMinor && <Text style={styles.secondary}>Credit toward future billing: {formatUsd(quote.creditMinor)} USD</Text>}
            <Text style={styles.secondary}>Payment card</Text>
            <Picker accessibilityLabel="Subscription payment card" selectedValue={cardId}
              onValueChange={onCardChange} enabled={!busy} style={styles.picker} dropdownIconColor={palette.colors.text}>
              {cards.map(card => <Picker.Item key={card.id}
                label={`${String(card.brand || 'Card').toUpperCase()} •••• ${card.last4}`} value={card.id} />)}
            </Picker>
            <Text style={styles.terms}>{quote.terms}</Text>
            <View style={styles.consent}>
              <Switch value={consent} onValueChange={onConsentChange} disabled={busy}
                accessibilityLabel="Agree to the displayed subscription price and automatic renewal terms" />
              <Text style={[styles.text, styles.consentText]}>I agree to this price and automatic renewal terms.</Text>
            </View>
          </ScrollView>
          <View testID="subscription-billing-actions" style={styles.actions}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Not now" disabled={busy}
              accessibilityState={{ disabled: busy }} onPress={close} style={styles.cancel}>
              <Text style={styles.secondary}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button"
              accessibilityLabel={quote.kind === 'card_change' ? 'Confirm card change' : 'Confirm subscription'}
              accessibilityState={{ disabled: confirmDisabled, busy }} disabled={confirmDisabled} onPress={onConfirm}
              style={[styles.confirm, confirmDisabled && styles.disabled]}>
              <Text style={styles.confirmText}>{busy ? 'Verifying…' : quote.kind === 'card_change' ? 'Confirm card change' : 'Confirm subscription'}</Text>
            </TouchableOpacity>
          </View>
        </GlassPanel>
      </View>
    </Modal>
  );
}

const buildStyles = palette => StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)' },
  panel: { width: '100%', maxWidth: 560, padding: 0, backgroundColor: palette.colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.lg,
    borderBottomWidth: 1, borderBottomColor: palette.glass.border },
  title: { flex: 1, color: palette.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minHeight: 0 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl },
  planName: { color: palette.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  text: { color: palette.colors.text, fontSize: fontSize.sm },
  secondary: { color: palette.colors.textSecondary, fontSize: fontSize.sm },
  picker: { color: palette.colors.text, minHeight: 48 },
  terms: { color: palette.colors.textSecondary, fontSize: fontSize.sm, lineHeight: 21 },
  consent: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  consentText: { flex: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg,
    borderTopWidth: 1, borderTopColor: palette.glass.border },
  cancel: { minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.sm },
  confirm: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center',
    backgroundColor: palette.colors.primary, borderRadius: 14, padding: spacing.md },
  confirmText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold, textAlign: 'center' },
  disabled: { opacity: 0.5 },
});
