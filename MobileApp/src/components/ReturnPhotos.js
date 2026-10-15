import React from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../contexts/ThemeContext';
import Feedback from '../utils/feedback';

export default function ReturnPhotos({ photos = [], onRemove, disabled = false }) {
  const { palette } = useTheme();
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>{photos.map((photo, index) => {
    const url = typeof photo === 'string' ? photo : photo.url;
    if (typeof url !== 'string' || !url.startsWith('https://')) return null;
    return <View key={photo._id || `${url}-${index}`} style={{ gap: 5 }}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`View return photo ${index + 1}`} onPress={() => Linking.openURL(url).catch(() => Feedback.show({ type: 'error', text1: 'Unable to open photo' }))}>
        <Image source={{ uri: url }} style={{ width: 88, height: 88, borderRadius: 12 }} contentFit="cover" />
      </TouchableOpacity>
      {onRemove && <TouchableOpacity disabled={disabled} accessibilityRole="button" accessibilityLabel={`Remove return photo ${index + 1}`} onPress={() => onRemove(photo._id)}><Text style={{ color: palette.colors.textSecondary, fontSize: 12 }}>Remove</Text></TouchableOpacity>}
    </View>;
  })}</View>;
}
