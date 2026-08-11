import React, { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { resolveBuyerLocation } from '../../utils/buyerLocation';
import {
  allFallbackCountryOptions,
  countryCodeFromLocale,
  countryDisplayName,
  countryFlag,
  countryFromPhoneNumber,
  fallbackCountryOption,
  getDeviceCountryCode,
  nationalDigitsFromPhone,
  normalizeCountryCode,
  toE164PhoneNumber,
} from '../../utils/phoneNumber';
import { useTheme } from '../../contexts/ThemeContext';
import { borderRadius, fontSize, fontWeight, spacing } from '../../styles/theme';

const CATALOG_CACHE_KEY = 'rozare:phone-country-catalog:v1';
const CATALOG_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
let catalogMemoryCache = null;

const cleanPhoneCode = (value) => String(value || '').replace(/\D/g, '');
const normalizeName = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const normalizeOption = (option) => {
  const isoCode = normalizeCountryCode(option?.isoCode);
  if (!isoCode) return null;
  const fallback = fallbackCountryOption(isoCode);
  return {
    name: String(option?.name || fallback.name),
    isoCode,
    phonecode: cleanPhoneCode(option?.phonecode) || fallback.phonecode,
  };
};

const uniqueOptions = (options) => {
  const seen = new Set();
  return (options || []).map(normalizeOption).filter((option) => {
    if (!option || seen.has(option.isoCode)) return false;
    seen.add(option.isoCode);
    return true;
  });
};

async function readCatalogCache() {
  if (catalogMemoryCache?.length) return catalogMemoryCache;
  try {
    const raw = await AsyncStorage.getItem(CATALOG_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.savedAt && Date.now() - parsed.savedAt < CATALOG_CACHE_TTL) {
      catalogMemoryCache = uniqueOptions(parsed.countries);
      return catalogMemoryCache;
    }
  } catch (_) {}
  return null;
}

async function writeCatalogCache(countries) {
  const normalized = uniqueOptions(countries);
  if (!normalized.length) return;
  catalogMemoryCache = normalized;
  try {
    await AsyncStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      countries: normalized,
    }));
  } catch (_) {}
}

export async function fetchPhoneCountries(query = '') {
  const search = String(query || '').trim();
  if (!search) {
    const cached = await readCatalogCache();
    if (cached?.length) return cached;
  }

  try {
    const response = await api.get('/api/locations/countries', {
      params: { ...(search ? { q: search } : {}), limit: 100 },
    });
    const countries = search
      ? uniqueOptions(response.data?.countries)
      : uniqueOptions([...(response.data?.countries || []), ...allFallbackCountryOptions()]);
    if (countries.length) {
      if (!search) await writeCatalogCache(countries);
      return countries;
    }
  } catch (_) {}

  const fallback = allFallbackCountryOptions();
  if (!search) return fallback;
  const needle = normalizeName(search);
  return fallback.filter(option => (
    normalizeName(option.name).includes(needle)
    || option.isoCode.toLowerCase().includes(needle)
    || option.phonecode.includes(search.replace(/\D/g, ''))
  )).slice(0, 100);
}

async function resolveCountryOption({
  value,
  defaultCountryCode,
  profileCountryCode,
  profileCountry,
}) {
  let code = countryFromPhoneNumber(value)
    || normalizeCountryCode(defaultCountryCode)
    || normalizeCountryCode(profileCountryCode);

  if (!code && profileCountry) {
    const candidates = await fetchPhoneCountries(profileCountry);
    const name = normalizeName(profileCountry);
    code = candidates.find(option => normalizeName(option.name) === name)?.isoCode || '';
  }

  if (!code) {
    const detected = await resolveBuyerLocation().catch(() => null);
    code = normalizeCountryCode(detected?.countryCode);
  }
  if (!code) code = getDeviceCountryCode();
  if (!code && typeof Intl !== 'undefined') {
    code = countryCodeFromLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  }
  code = code || 'PK';

  const candidates = await fetchPhoneCountries(code);
  return candidates.find(option => option.isoCode === code) || fallbackCountryOption(code);
}

const PhoneNumberInput = forwardRef(function PhoneNumberInput({
  value = '',
  onChangeText,
  onCountryChange,
  defaultCountryCode,
  profileCountryCode,
  profileCountry,
  label = 'Phone number',
  placeholder = 'Phone number',
  error = '',
  helperText = '',
  required = false,
  editable = true,
  autoFocus = false,
  containerStyle,
  inputStyle,
  accessibilityLabel,
  testID,
  onBlur,
  onFocus,
}, ref) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const initialCode = countryFromPhoneNumber(value)
    || normalizeCountryCode(defaultCountryCode)
    || normalizeCountryCode(profileCountryCode)
    || getDeviceCountryCode()
    || 'PK';
  const [country, setCountry] = useState(() => fallbackCountryOption(initialCode));
  const [nationalValue, setNationalValue] = useState(() => nationalDigitsFromPhone(value, initialCode));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [countries, setCountries] = useState([]);
  const [loadingCountries, setLoadingCountries] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [countryReady, setCountryReady] = useState(false);
  const lastEmitted = useRef('');
  const interacted = useRef(false);

  useEffect(() => {
    let active = true;
    resolveCountryOption({ value, defaultCountryCode, profileCountryCode, profileCountry })
      .then((resolved) => {
        if (!active || !resolved) return;
        setCountryReady(true);
        // A late profile/IP lookup must never undo a country the person has
        // already chosen while the lookup was in flight.
        if (interacted.current) return;
        setCountry(resolved);
        if (value) setNationalValue(nationalDigitsFromPhone(value, resolved.isoCode));
      })
      .catch(() => {
        if (active) setCountryReady(true);
      });
    return () => { active = false; };
  }, [defaultCountryCode, profileCountry, profileCountryCode]);

  useEffect(() => {
    if (String(value || '') === lastEmitted.current) return;
    const valueCountry = countryFromPhoneNumber(value);
    if (valueCountry && valueCountry !== country.isoCode) {
      const next = fallbackCountryOption(valueCountry);
      setCountry(next);
      setNationalValue(nationalDigitsFromPhone(value, valueCountry));
      return;
    }
    setNationalValue(nationalDigitsFromPhone(value, country.isoCode));
  }, [country.isoCode, value]);

  useEffect(() => {
    const raw = String(value || '').trim();
    if (!countryReady || interacted.current || !raw || raw.startsWith('+')) return;
    const normalized = toE164PhoneNumber(raw, country.isoCode);
    if (!normalized || normalized === raw || normalized === lastEmitted.current) return;
    // Existing profiles can contain old national-format numbers. Hydrate them
    // into the same E.164 value produced by new input so untouched forms still
    // pass exact validation and backend payloads remain consistent.
    lastEmitted.current = normalized;
    onChangeText?.(normalized);
  }, [country.isoCode, countryReady, onChangeText, value]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    let active = true;
    const timer = setTimeout(async () => {
      setLoadingCountries(true);
      setCatalogError('');
      try {
        const next = await fetchPhoneCountries(query);
        if (!active) return;
        const selectedFirst = query
          ? next
          : uniqueOptions([country, ...next]);
        setCountries(selectedFirst);
      } catch (_) {
        if (active) setCatalogError('Countries are unavailable. Check your connection and try again.');
      } finally {
        if (active) setLoadingCountries(false);
      }
    }, query ? 180 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [country, pickerOpen, query]);

  const emit = (text, selectedCountry = country) => {
    const normalized = toE164PhoneNumber(text, selectedCountry.isoCode);
    lastEmitted.current = normalized;
    onChangeText?.(normalized);
  };

  const changeText = (text) => {
    interacted.current = true;
    if (String(text).trim().startsWith('+')) {
      const full = toE164PhoneNumber(text, country.isoCode);
      const detectedCode = countryFromPhoneNumber(full);
      if (detectedCode && detectedCode !== country.isoCode) {
        const nextCountry = fallbackCountryOption(detectedCode);
        setCountry(nextCountry);
        setNationalValue(nationalDigitsFromPhone(full, detectedCode));
        lastEmitted.current = full;
        onChangeText?.(full);
        onCountryChange?.(nextCountry);
        return;
      }
    }

    const nextNational = String(text || '').replace(/\D/g, '').slice(0, 15);
    setNationalValue(nextNational);
    emit(nextNational);
  };

  const selectCountry = (option) => {
    const next = normalizeOption(option) || fallbackCountryOption(option?.isoCode);
    interacted.current = true;
    setCountry(next);
    setPickerOpen(false);
    setQuery('');
    emit(nationalValue, next);
    onCountryChange?.(next);
  };

  const showLabel = Boolean(label);
  return (
    <View style={[styles.container, containerStyle]} testID={testID}>
      {showLabel && (
        <Text style={styles.label}>{label}{required ? <Text style={styles.required}> *</Text> : null}</Text>
      )}
      <View style={[styles.inputShell, error && styles.inputShellError, !editable && styles.disabled]}>
        <TouchableOpacity
          style={styles.countryButton}
          onPress={() => editable && setPickerOpen(true)}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={`Country code ${country.name}, plus ${country.phonecode}`}
          testID={testID ? `${testID}-country` : undefined}
        >
          <Text style={styles.flag}>{countryFlag(country.isoCode)}</Text>
          <Text style={styles.callingCode}>+{country.phonecode}</Text>
          <Ionicons name="chevron-down" size={14} color={palette.colors.textSecondary} />
        </TouchableOpacity>
        <View style={styles.divider} />
        <TextInput
          ref={ref}
          style={[styles.input, inputStyle]}
          value={nationalValue}
          onChangeText={changeText}
          onBlur={onBlur}
          onFocus={onFocus}
          placeholder={placeholder}
          placeholderTextColor={palette.colors.textLight || palette.colors.textSecondary}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          editable={editable}
          autoFocus={autoFocus}
          maxLength={15}
          accessibilityLabel={accessibilityLabel || label || 'Phone number'}
          testID={testID ? `${testID}-input` : undefined}
        />
      </View>
      {!!error && <Text style={styles.errorText}>{String(error)}</Text>}
      {!error && !!helperText && <Text style={styles.helperText}>{helperText}</Text>}

      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setPickerOpen(false)} accessibilityLabel="Close country picker" />
          <SafeAreaView style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>Select country code</Text>
                <Text style={styles.sheetSubtitle}>Search by country, ISO code, or calling code</Text>
              </View>
              <TouchableOpacity style={styles.closeButton} onPress={() => setPickerOpen(false)} accessibilityLabel="Close country picker">
                <Ionicons name="close" size={20} color={palette.colors.text} />
              </TouchableOpacity>
            </View>
            <View style={styles.searchShell}>
              <Ionicons name="search-outline" size={18} color={palette.colors.primary} />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search countries"
                placeholderTextColor={palette.colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                accessibilityLabel="Search country codes"
              />
              {loadingCountries && <ActivityIndicator size="small" color={palette.colors.primary} />}
            </View>
            {!!catalogError && <Text style={styles.catalogError}>{catalogError}</Text>}
            <FlatList
              data={countries}
              keyExtractor={item => item.isoCode}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.countryList}
              ListEmptyComponent={!loadingCountries ? <Text style={styles.emptyText}>No matching country found.</Text> : null}
              renderItem={({ item }) => {
                const selected = item.isoCode === country.isoCode;
                return (
                  <TouchableOpacity
                    style={[styles.countryRow, selected && styles.countryRowSelected]}
                    onPress={() => selectCountry(item)}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Select ${item.name || countryDisplayName(item.isoCode)}, country code plus ${item.phonecode}`}
                  >
                    <Text style={styles.rowFlag}>{countryFlag(item.isoCode)}</Text>
                    <View style={styles.countryCopy}>
                      <Text style={styles.countryName}>{item.name || countryDisplayName(item.isoCode)}</Text>
                      <Text style={styles.countryIso}>{item.isoCode}</Text>
                    </View>
                    <Text style={styles.rowCode}>+{item.phonecode}</Text>
                    {selected && <Ionicons name="checkmark-circle" size={19} color={palette.colors.primary} />}
                  </TouchableOpacity>
                );
              }}
            />
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
});

const makeStyles = (p) => StyleSheet.create({
  container: { marginBottom: spacing.md },
  label: { marginBottom: spacing.xs, color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  required: { color: p.colors.error },
  inputShell: { minHeight: 54, flexDirection: 'row', alignItems: 'center', borderRadius: borderRadius.lg, borderWidth: 1, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle, overflow: 'hidden' },
  inputShellError: { borderColor: p.colors.error, backgroundColor: p.colors.errorSubtle },
  disabled: { opacity: 0.6 },
  countryButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.sm },
  flag: { fontSize: 21 },
  callingCode: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  divider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: p.glass.borderStrong || p.glass.borderSubtle },
  input: { flex: 1, minHeight: 52, paddingHorizontal: spacing.md, paddingVertical: Platform.OS === 'ios' ? spacing.md : spacing.sm, color: p.colors.text, fontSize: fontSize.md },
  errorText: { marginTop: 4, color: p.colors.error, fontSize: fontSize.xs },
  helperText: { marginTop: 4, color: p.colors.textSecondary, fontSize: fontSize.xs, lineHeight: 17 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,6,23,0.62)' },
  sheet: { height: '78%', paddingTop: spacing.sm, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: p.colors.background || p.colors.surface, borderWidth: 1, borderColor: p.glass.borderStrong || p.glass.borderSubtle, overflow: 'hidden' },
  sheetHandle: { width: 42, height: 5, borderRadius: 3, alignSelf: 'center', marginBottom: spacing.md, backgroundColor: p.glass.borderStrong || p.colors.textLight },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  sheetTitle: { color: p.colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  sheetSubtitle: { marginTop: 2, color: p.colors.textSecondary, fontSize: fontSize.xs },
  closeButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle },
  searchShell: { minHeight: 48, marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: borderRadius.lg, borderWidth: 1, borderColor: p.glass.borderSubtle, backgroundColor: p.glass.bgSubtle },
  searchInput: { flex: 1, color: p.colors.text, fontSize: fontSize.md, paddingVertical: spacing.sm },
  catalogError: { marginHorizontal: spacing.lg, marginBottom: spacing.sm, color: p.colors.error, fontSize: fontSize.xs },
  countryList: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  countryRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: borderRadius.lg },
  countryRowSelected: { backgroundColor: p.colors.primarySubtle || p.glass.bgStrong },
  rowFlag: { width: 32, fontSize: 23 },
  countryCopy: { flex: 1 },
  countryName: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  countryIso: { marginTop: 2, color: p.colors.textSecondary, fontSize: fontSize.xs },
  rowCode: { color: p.colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
  emptyText: { paddingVertical: spacing.xxl, color: p.colors.textSecondary, fontSize: fontSize.sm, textAlign: 'center' },
});

export default PhoneNumberInput;
