/**
 * PriceRangeFilter — themed dual-input price range selector with quick presets.
 */
import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

const PRESETS = [
  { label: 'Under', min: 0, max: 25 },
  { label: 'Range', min: 25, max: 100 },
  { label: 'Range', min: 100, max: 500 },
  { label: 'Over', min: 500, max: 99999 },
];

export default function PriceRangeFilter({ min, max, onChange }) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const { formatAmount } = useCurrency();
  const [minStr, setMinStr] = useState(min ? String(min) : '');
  const [maxStr, setMaxStr] = useState(max ? String(max) : '');

  useEffect(() => {
    setMinStr(min ? String(min) : '');
    setMaxStr(max ? String(max) : '');
  }, [min, max]);

  const commit = (newMin, newMax) => {
    const m = parseFloat(newMin) || 0;
    const x = parseFloat(newMax) || 0;
    onChange?.({ min: m, max: x > 0 ? x : null });
  };

  const applyPreset = (preset) => {
    setMinStr(String(preset.min));
    setMaxStr(String(preset.max));
    commit(preset.min, preset.max);
  };

  return (
    <View>
      <View style={styles.inputRow}>
        <View style={styles.inputBox}>
          <Text style={styles.inputLabel}>Min</Text>
          <TextInput value={minStr} onChangeText={(v) => { setMinStr(v); commit(v, maxStr); }} keyboardType="numeric" placeholder="0" placeholderTextColor={colors.textLight} style={styles.input} accessibilityLabel="Minimum price" />
        </View>
        <View style={styles.dash}><Ionicons name="remove" size={16} color={colors.textSecondary} /></View>
        <View style={styles.inputBox}>
          <Text style={styles.inputLabel}>Max</Text>
          <TextInput value={maxStr} onChangeText={(v) => { setMaxStr(v); commit(minStr, v); }} keyboardType="numeric" placeholder="Any" placeholderTextColor={colors.textLight} style={styles.input} accessibilityLabel="Maximum price" />
        </View>
      </View>

      <View style={styles.presetRow}>
        {PRESETS.map((p) => {
          const active = String(min) === String(p.min) && String(max) === String(p.max);
          const label = p.min === 0
            ? `Under ${formatAmount(p.max, { decimals: 0 })}`
            : p.max >= 99999
              ? `Over ${formatAmount(p.min, { decimals: 0 })}`
              : `${formatAmount(p.min, { decimals: 0 })} - ${formatAmount(p.max, { decimals: 0 })}`;
          return (
            <TouchableOpacity key={`${p.min}-${p.max}`} style={[styles.presetChip, active && styles.presetChipActive]} onPress={() => applyPreset(p)} accessibilityLabel={label}>
              <Text style={[styles.presetText, active && styles.presetTextActive]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; return StyleSheet.create({
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  inputBox: { flex: 1, backgroundColor: colors.primarySubtle, borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.primaryLighter },
  inputLabel: { fontSize: 10, color: colors.textSecondary, fontWeight: fontWeight.semibold, letterSpacing: 0.5 },
  input: { fontSize: fontSize.lg, color: colors.text, fontWeight: fontWeight.semibold, padding: 0, paddingTop: 2 },
  dash: { paddingHorizontal: spacing.xs },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  presetChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: palette.glass.bgSubtle, borderWidth: 1, borderColor: palette.glass.borderSubtle },
  presetChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  presetText: { fontSize: fontSize.sm, color: colors.text, fontWeight: fontWeight.medium },
  presetTextActive: { color: '#ffffff', fontWeight: fontWeight.bold },
}); };
