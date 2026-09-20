import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { shoppingCountryPatch } from '../../utils/shoppingLocation';
import LocationAutocomplete from './LocationAutocomplete';

export default function ShoppingLocationFields({ value, onChange, advanced = true, disabled = false, onInteraction }) {
  const { palette } = useTheme();
  const patch = changes => onChange({ ...value, ...changes });
  const input = { countryCode: value.countryCode, countryName: value.country, disabled: disabled || !value.countryCode };
  return <View style={styles.container}>
    <View style={styles.cards}>
      {[{ mode: 'country', label: 'Country', icon: 'location-outline', detail: 'Stores serving your selected country' }, { mode: 'global', label: 'Global', icon: 'earth-outline', detail: 'Global stores + stores in your country' }].map(option => {
        const active = value.mode === option.mode;
        return <TouchableOpacity key={option.mode} accessibilityRole="radio" accessibilityLabel={'Shop from: ' + option.label} accessibilityState={{ checked: active, disabled }} disabled={disabled} onPress={() => patch({ mode: option.mode })} style={[styles.card, { borderColor: active ? palette.colors.primary : palette.glass.borderSubtle, backgroundColor: active ? palette.colors.primarySubtle : palette.glass.bgSubtle }]}>
          <Ionicons name={option.icon} size={22} color={palette.colors.primary} /><Text style={[styles.label, { color: palette.colors.text }]}>{option.label}</Text><Text style={[styles.detail, { color: palette.colors.textSecondary }]}>{option.detail}</Text>
        </TouchableOpacity>;
      })}
    </View>
    {value.mode === 'country' && <>
      <LocationAutocomplete type="country" label="Country" value={value.country} code={value.countryCode} required disabled={disabled} placeholder="Choose a country" onInteraction={onInteraction} onSelect={option => patch(shoppingCountryPatch(option))} onClear={() => patch(shoppingCountryPatch(null))} />
      {advanced && <>
        <Text style={[styles.detail, { color: palette.colors.textSecondary }]}>Optional: select a matching local area to include stores serving your state, city or town.</Text>
        <LocationAutocomplete {...input} type="state" label="State / Province (optional)" value={value.region} code={value.regionCode} onSelect={option => patch({ region: option.name, regionCode: option.isoCode, city: '', cityStateCode: '', town: '', townStateCode: '' })} onClear={() => patch({ region: '', regionCode: '', city: '', cityStateCode: '', town: '', townStateCode: '' })} />
        <LocationAutocomplete {...input} type="city" label="City (optional)" value={value.city} code={value.cityStateCode} stateCode={value.regionCode} stateName={value.region} onSelect={option => patch({ city: option.name, cityStateCode: option.stateCode || value.regionCode, town: '', townStateCode: '' })} onClear={() => patch({ city: '', cityStateCode: '', town: '', townStateCode: '' })} />
        <View><Text style={[styles.label, { color: palette.colors.text }]}>Town / Area (optional)</Text><TextInput accessibilityLabel="Shopping town or area" value={value.town} maxLength={80} placeholder="Select a city, then enter your town or area" placeholderTextColor={palette.colors.textSecondary} editable={!disabled && !!value.city} onChangeText={town => patch({ town, townStateCode: value.cityStateCode || value.regionCode })} style={{ padding: 14, marginTop: 8, borderRadius: 12, borderWidth: 1, borderColor: palette.glass.borderSubtle, color: palette.colors.text }} /></View>
      </>}
    </>}
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 14 }, cards: { flexDirection: 'row', gap: 10 },
  card: { flex: 1, borderWidth: 2, borderRadius: 18, padding: 14, minHeight: 122 },
  label: { fontWeight: '700', fontSize: 15, marginTop: 8 }, detail: { fontSize: 12, lineHeight: 18, marginTop: 4 },
});
