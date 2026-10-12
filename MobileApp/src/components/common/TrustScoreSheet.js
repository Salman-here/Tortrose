/**
 * TrustScoreSheet — themed bottom-sheet modal showing a trust score breakdown.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import Modal from './AppModal';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import GlassPanel from './GlassPanel';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';
import { getModalPalette } from '../../styles/modalTheme';

const ScoreRow = ({ item, palette }) => {
  const colors = palette.colors;
  const glass = palette.glass;
  const pct = item.max > 0 ? Math.min(100, Math.round((item.score / item.max) * 100)) : 0;
  const filled = item.score >= item.max;
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text }}>{item.label}</Text>
        <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: filled ? colors.success : colors.primary }}>
          {item.score}<Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: fontWeight.medium }}> / {item.max}</Text>
        </Text>
      </View>
      <View style={{ height: 8, backgroundColor: glass.bgSubtle, borderRadius: 4, overflow: 'hidden', marginBottom: 6 }}>
        <View style={{ width: `${pct}%`, height: '100%', borderRadius: 4, backgroundColor: filled ? colors.success : colors.primary }} />
      </View>
      <Text style={{ fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: 16 }}>{item.description}</Text>
    </View>
  );
};

export default function TrustScoreSheet({ visible, onClose, storeId, storeName }) {
  const { palette: modalBasePalette } = useTheme();
  const palette = getModalPalette(modalBasePalette);
  const colors = palette.colors;
  const glass = palette.glass;
  const styles = makeStyles(palette);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const labelColor = (label) => {
    switch (label) {
      case 'Excellent': return colors.success;
      case 'Strong': return colors.primary;
      case 'Building': return colors.warning;
      default: return colors.textSecondary;
    }
  };

  useEffect(() => {
    if (!visible || !storeId) return;
    let cancel = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const res = await api.get(`/api/stores/${storeId}/trust-metrics`);
        if (!cancel) setData(res.data?.data);
      } catch (e) {
        if (!cancel) setError(e.response?.data?.message || 'Failed to load trust data');
      } finally { if (!cancel) setLoading(false); }
    })();
    return () => { cancel = true; };
  }, [visible, storeId]);

  const score = data?.score || 0;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />
        <GlassPanel variant="modal" style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Trust Score</Text>
              {storeName ? <Text style={styles.subtitle} numberOfLines={1}>{storeName}</Text> : null}
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View>
          ) : error ? (
            <Text style={styles.error}>{error}</Text>
          ) : data ? (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing.xxl }}>
              <View style={styles.heroRow}>
                <View style={[styles.scoreCircle, { borderColor: labelColor(data.label) }]}>
                  <Text style={[styles.scoreNumber, { color: labelColor(data.label) }]}>{score}</Text>
                  <Text style={styles.scoreOutOf}>/100</Text>
                </View>
                <View style={{ flex: 1, marginLeft: spacing.lg }}>
                  <Text style={[styles.heroLabel, { color: labelColor(data.label) }]}>{data.label}</Text>
                  <View style={styles.metaRow}>
                    {data.isVerified && (
                      <View style={[styles.pill, { backgroundColor: colors.successSubtle }]}>
                        <Ionicons name="shield-checkmark" size={12} color={colors.success} />
                        <Text style={[styles.pillText, { color: colors.success }]}>Verified</Text>
                      </View>
                    )}
                    <View style={[styles.pill, { backgroundColor: colors.primarySubtle }]}>
                      <Ionicons name="heart" size={12} color={colors.heart} />
                      <Text style={[styles.pillText, { color: colors.primary }]}>{data.trustCount} trust</Text>
                    </View>
                    <View style={[styles.pill, { backgroundColor: colors.infoSubtle }]}>
                      <Ionicons name="calendar-outline" size={12} color={colors.info} />
                      <Text style={[styles.pillText, { color: colors.info }]}>{data.ageDays}d</Text>
                    </View>
                  </View>
                </View>
              </View>

              <View style={styles.divider} />

              {data.breakdown.map((item) => <ScoreRow key={item.key} item={item} palette={palette} />)}

              <View style={styles.footer}>
                <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
                <Text style={styles.footerText}>Trust scores update as the store grows, gains followers, and verifies its identity.</Text>
              </View>
            </ScrollView>
          ) : null}
        </GlassPanel>
      </View>
    </Modal>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; const glass = palette.glass; return StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg, paddingTop: spacing.sm, maxHeight: '88%' },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: glass.borderStrong, marginBottom: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  closeBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  loading: { paddingVertical: spacing.xxl, alignItems: 'center' },
  error: { color: colors.error, textAlign: 'center', paddingVertical: spacing.xl },
  heroRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  scoreCircle: { width: 92, height: 92, borderRadius: 46, borderWidth: 4, justifyContent: 'center', alignItems: 'center', backgroundColor: glass.bgSubtle },
  scoreNumber: { fontSize: 30, fontWeight: fontWeight.bold, lineHeight: 32 },
  scoreOutOf: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  heroLabel: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, marginBottom: 6 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: fontWeight.semibold },
  divider: { height: 1, backgroundColor: glass.borderSubtle, marginVertical: spacing.md },
  footer: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: glass.borderSubtle },
  footerText: { flex: 1, fontSize: fontSize.xs, color: colors.textSecondary, lineHeight: 16 },
}); };
