import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

export default function SavedSafepayCardPicker({ cards, selectedCardId, setSelectedCardId, loading, disabled, currency }) {
  const { palette } = useTheme();
  if (loading) return <ActivityIndicator accessibilityLabel="Checking saved cards" color={palette.colors.primary} />;
  if (!cards.length) return null;
  return <View style={{ gap: 8, marginVertical: 14 }} accessibilityRole="radiogroup">
    <Text style={{ color: palette.colors.text, fontWeight: '600' }}>Saved card or secure checkout</Text>
    {[...cards.map(card => ({ id: card.id, label: `${String(card.brand || 'Card').toUpperCase()} ending ${card.last4}` })),
      { id: '', label: currency === 'PKR' ? 'Choose card or Raast in Safepay' : 'Use a new card' }].map(card => <TouchableOpacity key={card.id || 'new'}
        accessibilityRole="radio" accessibilityLabel={card.label} accessibilityState={{ checked: card.id === selectedCardId, disabled: !!disabled }}
        onPress={() => setSelectedCardId(card.id)} disabled={disabled}
        style={{ flexDirection: 'row', gap: 10, alignItems: 'center', padding: 13, borderRadius: 14, borderWidth: 1,
          borderColor: card.id === selectedCardId ? palette.colors.primary : palette.colors.border || '#d7ddec', backgroundColor: '#ffffff40' }}>
        <Ionicons name={card.id === selectedCardId ? 'radio-button-on' : 'radio-button-off'} size={19} color={palette.colors.primary} />
        <Text style={{ color: palette.colors.text, flex: 1 }}>{card.label}</Text>
      </TouchableOpacity>)}
  </View>;
}
