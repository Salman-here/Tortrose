import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, shadows, spacing } from '../../styles/theme';
import GlassPanel from './GlassPanel';

const REASONS = [
  ['inappropriate', 'Inappropriate', 'Sexual, abusive, or offensive content'],
  ['harmful', 'Harmful or unsafe', 'Could cause harm or dangerous behavior'],
  ['misleading', 'Misleading', 'False, deceptive, or inaccurate information'],
  ['spam', 'Spam', 'Repeated, promotional, or irrelevant content'],
  ['illegal', 'Illegal content', 'May violate law or someone’s rights'],
  ['other', 'Something else', 'Tell us what our safety team should review'],
];

export default function SafetyActionsSheet({
  visible,
  onClose,
  report,
  block,
  initialMode = 'menu',
  onBlocked,
}) {
  const { currentUser } = useAuth();
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [mode, setMode] = useState(block && initialMode === 'menu' ? 'menu' : 'report');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setMode(block && initialMode === 'menu' ? 'menu' : 'report');
    setReason('');
    setDetails('');
    setBusy(false);
  }, [visible, block, initialMode]);

  const submitReport = async () => {
    if (!reason || busy) return;
    setBusy(true);
    try {
      const response = await api.post('/api/safety/reports', {
        ...report,
        reason,
        details: details.trim(),
      });
      onClose?.();
      Alert.alert('Report received', response.data?.msg || 'Our safety team will review it.');
    } catch (error) {
      Alert.alert('Could not submit report', error.response?.data?.msg || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitBlock = async () => {
    if (!currentUser) {
      Alert.alert('Sign in required', 'Sign in to block sellers and other accounts across Rozare.');
      return;
    }
    if (!block?.userId || busy) return;
    setBusy(true);
    try {
      const response = await api.post('/api/safety/blocks', {
        userId: block.userId,
        source: block.source || 'user',
      });
      onBlocked?.(block.userId);
      onClose?.();
      Alert.alert('Blocked', response.data?.msg || 'You will no longer see content from this account.');
    } catch (error) {
      Alert.alert('Could not block account', error.response?.data?.msg || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'menu' ? 'Safety options' : mode === 'block' ? `Block ${block?.label || 'account'}?` : 'Report content';
  const subtitle = mode === 'menu'
    ? 'Choose how you want Rozare to protect your experience.'
    : mode === 'block'
      ? 'Their products, store, and reviews will be hidden from your account. You can unblock them later in Settings.'
      : 'Reports are confidential. Choose the reason that best describes the issue.';

  return (
    <Modal visible={Boolean(visible)} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <GlassPanel variant="strong" style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <LinearGradient colors={palette.gradients.cta} style={styles.iconWrap}>
              <Ionicons name={mode === 'block' ? 'person-remove-outline' : 'shield-checkmark-outline'} size={20} color="#fff" />
            </LinearGradient>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>{subtitle}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton} accessibilityLabel="Close safety options">
              <Ionicons name="close" size={20} color={palette.colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {mode === 'menu' ? (
            <View style={styles.menu}>
              <TouchableOpacity style={styles.menuCard} onPress={() => setMode('report')} activeOpacity={0.78}>
                <View style={[styles.menuIcon, { backgroundColor: `${palette.colors.warning}15` }]}>
                  <Ionicons name="flag-outline" size={20} color={palette.colors.warning} />
                </View>
                <View style={styles.menuCopy}>
                  <Text style={styles.menuTitle}>Report</Text>
                  <Text style={styles.menuText}>Send this content to the Rozare safety team.</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={palette.colors.textSecondary} />
              </TouchableOpacity>
              {block && (
                <TouchableOpacity style={styles.menuCard} onPress={() => setMode('block')} activeOpacity={0.78}>
                  <View style={[styles.menuIcon, { backgroundColor: `${palette.colors.error}12` }]}>
                    <Ionicons name="person-remove-outline" size={20} color={palette.colors.error} />
                  </View>
                  <View style={styles.menuCopy}>
                    <Text style={styles.menuTitle}>Block {block.label || 'account'}</Text>
                    <Text style={styles.menuText}>Hide their content from your Rozare account.</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={palette.colors.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
          ) : mode === 'block' ? (
            <View style={styles.actions}>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => setMode('menu')} disabled={busy}>
                <Text style={styles.secondaryButtonText}>Go back</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.dangerButton, busy && styles.disabled]} onPress={submitBlock} disabled={busy}>
                {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="person-remove" size={17} color="#fff" />}
                <Text style={styles.primaryButtonText}>Block</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView style={styles.reportScroll} contentContainerStyle={styles.reportContent} keyboardShouldPersistTaps="handled">
              {REASONS.map(([value, label, description]) => {
                const selected = reason === value;
                return (
                  <TouchableOpacity key={value} style={[styles.reasonCard, selected && styles.reasonCardSelected]} onPress={() => setReason(value)} activeOpacity={0.76}>
                    <View style={[styles.radio, selected && styles.radioSelected]}>
                      {selected && <View style={styles.radioDot} />}
                    </View>
                    <View style={styles.reasonCopy}>
                      <Text style={styles.reasonTitle}>{label}</Text>
                      <Text style={styles.reasonText}>{description}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <TextInput
                value={details}
                onChangeText={setDetails}
                maxLength={1000}
                multiline
                textAlignVertical="top"
                placeholder="Add details (optional)"
                placeholderTextColor={palette.colors.textSecondary}
                style={styles.detailsInput}
              />
              <View style={styles.actions}>
                {block && initialMode === 'menu' && (
                  <TouchableOpacity style={styles.secondaryButton} onPress={() => setMode('menu')} disabled={busy}>
                    <Text style={styles.secondaryButtonText}>Go back</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={[styles.primaryButton, (!reason || busy) && styles.disabled]} onPress={submitReport} disabled={!reason || busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="flag" size={17} color="#fff" />}
                  <Text style={styles.primaryButtonText}>Submit report</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
        </GlassPanel>
      </View>
    </Modal>
  );
}

const buildStyles = p => StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.48)' },
  sheet: { maxHeight: '88%', padding: spacing.lg, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  handle: { width: 44, height: 4, borderRadius: 99, backgroundColor: p.glass.border, alignSelf: 'center', marginBottom: spacing.md },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginBottom: spacing.lg },
  iconWrap: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', ...shadows.sm },
  headerCopy: { flex: 1 },
  title: { color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold },
  subtitle: { color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 18, marginTop: 3 },
  closeButton: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  menu: { gap: spacing.sm },
  menuCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle },
  menuIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  menuCopy: { flex: 1 },
  menuTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  menuText: { color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  reportScroll: { flexGrow: 0 },
  reportContent: { gap: spacing.sm, paddingBottom: spacing.sm },
  reasonCard: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle },
  reasonCardSelected: { borderColor: p.colors.primary, backgroundColor: `${p.colors.primary}0F` },
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.5, borderColor: p.colors.textSecondary, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  radioSelected: { borderColor: p.colors.primary },
  radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: p.colors.primary },
  reasonCopy: { flex: 1 },
  reasonTitle: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  reasonText: { color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17, marginTop: 2 },
  detailsInput: { minHeight: 92, marginTop: spacing.xs, borderRadius: 16, borderWidth: 1, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle, padding: spacing.md, color: p.colors.text, fontSize: fontSize.sm },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  secondaryButton: { minHeight: 46, paddingHorizontal: spacing.lg, borderRadius: 15, borderWidth: 1, borderColor: p.glass.border, alignItems: 'center', justifyContent: 'center' },
  secondaryButtonText: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  primaryButton: { flex: 1, minHeight: 46, paddingHorizontal: spacing.lg, borderRadius: 15, flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, ...shadows.sm },
  dangerButton: { flex: 1, minHeight: 46, paddingHorizontal: spacing.lg, borderRadius: 15, flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.error, ...shadows.sm },
  primaryButtonText: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  disabled: { opacity: 0.45 },
});
