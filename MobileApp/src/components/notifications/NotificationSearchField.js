import React from 'react';
import { StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { spacing } from '../../styles/theme';

export default function NotificationSearchField({ value, onChangeText, style }) {
  const { palette } = useTheme();
  return <View style={[styles.row, { backgroundColor: palette.glass.bgSubtle, borderColor: palette.glass.borderSubtle }, style]}>
    <Ionicons name="search-outline" size={18} color={palette.colors.textSecondary} />
    <TextInput value={value} onChangeText={onChangeText} placeholder="Search notifications…"
      accessibilityLabel="Search notifications" autoCapitalize="none" autoCorrect={false} returnKeyType="search"
      placeholderTextColor={palette.colors.textSecondary} style={[styles.input, { color: palette.colors.text }]} />
    {!!value && <TouchableOpacity onPress={() => onChangeText('')} style={styles.clear} accessibilityRole="button" accessibilityLabel="Clear notification search">
      <Ionicons name="close-circle" size={18} color={palette.colors.textSecondary} />
    </TouchableOpacity>}
  </View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: 14, borderWidth: 1, paddingHorizontal: spacing.md },
  input: { flex: 1, minWidth: 0, fontSize: 14, paddingVertical: spacing.sm },
  clear: { minWidth: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
