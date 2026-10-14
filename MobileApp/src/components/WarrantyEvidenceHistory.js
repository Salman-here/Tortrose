import React, { useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useTheme } from '../contexts/ThemeContext';
import Feedback from '../utils/feedback';

export default function WarrantyEvidenceHistory({ entries }) {
  const [expanded, setExpanded] = useState(false);
  const { palette } = useTheme();
  if (!Array.isArray(entries) || entries.length < 2) return null;
  return <View style={{ gap: 10, marginTop: 12 }}>
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
      <Text style={{ color: palette.colors.primary, fontWeight: '700', fontSize: 12 }}>{expanded ? 'Hide evidence history' : 'Original claim and appeal evidence'}</Text>
    </TouchableOpacity>
    {expanded && entries.map(entry => <View key={entry.version} style={{ gap: 8, padding: 12, borderRadius: 14,
      borderWidth: 1, borderColor: palette.glass?.borderSubtle || palette.colors.grayLight }}>
      <Text style={{ color: palette.colors.text, fontWeight: '700', fontSize: 13 }}>{entry.version ? `Appeal ${entry.version}` : 'Original on-time claim'}</Text>
      <Text style={{ color: palette.colors.textSecondary, fontSize: 11 }}>{new Date(entry.submittedAt).toLocaleString()}</Text>
      <Text style={{ color: palette.colors.text, fontSize: 13, lineHeight: 19 }}>{entry.reason}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{entry.urls.map((url, index) => <TouchableOpacity
        key={`${entry.version}-${index}`} accessibilityLabel={`View evidence submission ${entry.version} photo ${index + 1}`}
        onPress={() => Linking.openURL(url).catch(() => Feedback.show({ type: 'error', text1: 'Unable to open photo' }))}>
        <Image source={{ uri: url }} style={{ width: 72, height: 72, borderRadius: 12 }} contentFit="cover" />
      </TouchableOpacity>)}</View>
    </View>)}
  </View>;
}
