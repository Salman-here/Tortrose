import React from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import LocationAutocomplete from './LocationAutocomplete';
import { STORE_VISIBILITY_OPTIONS, GLOBAL_SHIPPING_NOTICE } from '../../utils/storeVisibilityForm';

export default function StoreVisibilityPicker({ value, onChange, disabled = false }) {
  const { palette } = useTheme();
  const patch = changes => onChange({ ...value, ...changes });
  const input = { countryCode: value.countryCode, countryName: value.country, disabled: disabled || !value.countryCode };
  return <View style={styles.container}>
    <View style={styles.cards}>
      {STORE_VISIBILITY_OPTIONS.map(option => {
        const active = value.mode === option.mode;
        return <TouchableOpacity key={option.mode} accessibilityRole="radio" accessibilityLabel={'Store visibility: ' + option.label} accessibilityState={{ checked: active, disabled }} disabled={disabled} onPress={() => patch({ mode: option.mode })} style={[styles.card, { borderColor: active ? palette.colors.primary : palette.glass.borderSubtle, backgroundColor: active ? palette.colors.primarySubtle : palette.glass.bgSubtle }]}>
          <Ionicons name={option.mode === 'global' ? 'earth-outline' : 'location-outline'} size={19} color={active ? palette.colors.primary : palette.colors.textSecondary} />
          <Text style={[styles.label, { color: palette.colors.text }]}>{option.label}</Text>
          <Text style={[styles.detail, { color: palette.colors.textSecondary }]}>{option.description}</Text>
        </TouchableOpacity>;
      })}
    </View>
    {value.mode === 'global' ? <Text style={[styles.notice, { color: palette.colors.text, backgroundColor: palette.colors.primarySubtle }]}>{GLOBAL_SHIPPING_NOTICE}</Text> : <>
      <LocationAutocomplete type="country" label="Country" value={value.country} code={value.countryCode} disabled={disabled} required onSelect={option => patch({ country: option.name, countryCode: option.isoCode, region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} onClear={() => patch({ country: '', countryCode: '', region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} />
      {['region', 'city', 'town'].includes(value.mode) && <LocationAutocomplete {...input} type="state" label="State / Province" value={value.region} code={value.regionCode} onSelect={option => patch({ region: option.name, regionCode: option.isoCode, city: '', cityStateCode: '', town: '', townStateCode: '' })} onClear={() => patch({ region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} />}
      {['city', 'town'].includes(value.mode) && <LocationAutocomplete {...input} type="city" label="City" value={value.city} code={value.cityStateCode} stateCode={value.regionCode} stateName={value.region} onSelect={option => patch({ city: option.name, cityStateCode: option.stateCode || value.regionCode, town: '', townStateCode: '' })} onClear={() => patch({ city: '', cityStateCode: '', town: '', townStateCode: '' })} />}
      {value.mode === 'town' && <View><Text style={[styles.label, { color: palette.colors.text }]}>Town / Area</Text><TextInput accessibilityLabel="Store town or area" value={value.town} maxLength={80} placeholder="For example, Johar Town" placeholderTextColor={palette.colors.textSecondary} editable={!disabled && !!value.city} onChangeText={town => patch({ town, townStateCode: value.cityStateCode || value.regionCode })} style={{ padding: 14, marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: palette.glass.borderSubtle, color: palette.colors.text }} /></View>}
    </>}
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 14 }, cards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: { width: '47%', flexGrow: 1, minHeight: 108, borderWidth: 1, borderRadius: 17, padding: 14 },
  label: { fontSize: 14, fontWeight: '700', marginTop: 8 }, detail: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  notice: { borderRadius: 15, padding: 15, fontSize: 13, lineHeight: 20 },
});
