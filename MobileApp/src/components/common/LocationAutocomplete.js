import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

const endpointByType = {
  country: 'countries',
  state: 'states',
  city: 'cities',
};

const listKeyByType = {
  country: 'countries',
  state: 'states',
  city: 'cities',
};

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const selectedLabel = (value, code) => {
  const name = clean(value);
  const suffix = clean(code);
  if (!name) return '';
  return suffix && !name.toUpperCase().includes(`(${suffix.toUpperCase()})`) ? `${name} (${suffix})` : name;
};

const optionLabel = (option, type) => {
  if (!option) return '';
  if (type === 'country') return `${option.name} (${option.isoCode})`;
  if (type === 'state') return `${option.name}${option.isoCode ? ` (${option.isoCode})` : ''}`;
  return `${option.name}${option.stateCode ? `, ${option.stateCode}` : ''}${option.countryCode ? `, ${option.countryCode}` : ''}`;
};

export default function LocationAutocomplete({
  type = 'country',
  label = '',
  value = '',
  code = '',
  countryCode = '',
  countryName = '',
  stateCode = '',
  stateName = '',
  placeholder = 'Search location',
  disabled = false,
  required = false,
  error = '',
  onSelect,
  onClear,
  containerStyle,
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => buildStyles(palette), [palette]);
  const [query, setQuery] = useState(() => selectedLabel(value, code));
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    if (!open) setQuery(selectedLabel(value, code));
  }, [code, open, value]);

  useEffect(() => {
    if (!open || disabled) return undefined;

    const endpoint = endpointByType[type] || endpointByType.country;
    const listKey = listKeyByType[type] || listKeyByType.country;
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        setFetchError('');
        const params = new URLSearchParams();
        params.set('limit', '35');
        const search = clean(query).replace(/\([A-Z]{2,3}\)$/i, '').trim();
        if (search) params.set('q', search);
        if (type !== 'country') {
          if (countryCode) params.set('countryCode', countryCode);
          else if (countryName) params.set('country', countryName);
        }
        if (type === 'city') {
          if (stateCode) params.set('stateCode', stateCode);
          else if (stateName) params.set('state', stateName);
        }

        const res = await api.get(`/api/locations/${endpoint}?${params.toString()}`);
        setOptions(res.data?.[listKey] || []);
      } catch (err) {
        setOptions([]);
        setFetchError(err.response?.data?.msg || 'Locations unavailable');
      } finally {
        setLoading(false);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [countryCode, countryName, disabled, open, query, stateCode, stateName, type]);

  const selectOption = (option) => {
    setQuery(optionLabel(option, type));
    setOpen(false);
    setOptions([]);
    onSelect?.(option);
  };

  const clearSelection = () => {
    setQuery('');
    setOptions([]);
    setOpen(false);
    onClear?.();
  };

  const showError = error || fetchError;

  return (
    <View style={[styles.container, containerStyle]}>
      {!!label && (
        <Text style={styles.label}>
          {label}{required ? ' *' : ''}
        </Text>
      )}
      <View style={[styles.inputWrap, disabled && styles.disabledWrap, error && styles.inputError]}>
        <Ionicons name="location-outline" size={17} color={error ? palette.colors.error : palette.colors.primary} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            setOpen(true);
          }}
          onFocus={() => !disabled && setOpen(true)}
          placeholder={placeholder}
          placeholderTextColor={palette.colors.textLight}
          editable={!disabled}
          autoCorrect={false}
          autoCapitalize="words"
        />
        {loading ? <ActivityIndicator size="small" color={palette.colors.primary} /> : null}
        {!!clean(value) && !disabled && (
          <TouchableOpacity onPress={clearSelection} style={styles.iconButton} accessibilityLabel="Clear location">
            <Ionicons name="close" size={15} color={palette.colors.textSecondary} />
          </TouchableOpacity>
        )}
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={palette.colors.textSecondary} />
      </View>

      {open && !disabled && (
        <View style={styles.dropdown}>
          {showError ? (
            <Text style={[styles.emptyText, { color: palette.colors.error }]}>{showError}</Text>
          ) : options.length === 0 && !loading ? (
            <Text style={styles.emptyText}>No matching locations</Text>
          ) : (
            <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{ maxHeight: 220 }}>
              {options.map((option) => {
                const key = `${option.countryCode || option.isoCode || ''}-${option.stateCode || ''}-${option.isoCode || ''}-${option.name}`;
                return (
                  <TouchableOpacity key={key} style={styles.option} onPress={() => selectOption(option)} activeOpacity={0.75}>
                    <Ionicons name="pin-outline" size={14} color={palette.colors.primary} />
                    <Text style={styles.optionText} numberOfLines={1}>{optionLabel(option, type)}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}
    </View>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { marginBottom: spacing.md, zIndex: 5 },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: spacing.xs },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 52, borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  disabledWrap: { opacity: 0.65 },
  inputError: { borderColor: p.colors.error, backgroundColor: p.colors.errorSubtle },
  input: { flex: 1, color: p.colors.text, fontSize: fontSize.md, paddingVertical: spacing.sm },
  iconButton: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  dropdown: { marginTop: spacing.xs, borderRadius: borderRadius.lg, overflow: 'hidden', backgroundColor: p.glass.bgStrong || p.colors.surface, borderWidth: 1, borderColor: p.glass.borderSubtle },
  option: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.glass.borderSubtle },
  optionText: { flex: 1, color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  emptyText: { color: p.colors.textSecondary, fontSize: fontSize.sm, padding: spacing.md },
});
