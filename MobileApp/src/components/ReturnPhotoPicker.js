import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Text, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import api, { API_UPLOAD_TIMEOUT_MS } from '../config/api';
import { useTheme } from '../contexts/ThemeContext';
import ReturnPhotos from './ReturnPhotos';

export default function ReturnPhotoPicker({ orderId, photos, onChange, onBusyChange, disabled = false }) {
  const { palette } = useTheme();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const working = useRef(false), generation = useRef(0), abort = useRef(null);
  useEffect(() => () => { generation.current += 1; abort.current?.abort(); onBusyChange(false); }, [orderId, onBusyChange]);
  const choose = async () => {
    if (disabled || working.current || photos.length >= 6) return;
    const current = generation.current;
    working.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error('Allow photo access to attach photos of the returned item.');
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 6 - photos.length, quality: 0.85 });
      if (picked.canceled || generation.current !== current) return;
      if (picked.assets.length + photos.length > 6 || picked.assets.some(asset => asset.fileSize > 5242880 || asset.mimeType && !['image/jpeg','image/png','image/webp'].includes(asset.mimeType))) throw new Error('Choose up to 6 JPEG, PNG or WebP photos, each up to 5 MB.');
      abort.current = new AbortController();
      for (const asset of picked.assets) {
        const form = new FormData(), type = asset.mimeType || 'image/jpeg', name = asset.fileName || `return-${Date.now()}.jpg`;
        if (Platform.OS === 'web') form.append('photo', await (await fetch(asset.uri)).blob(), name);
        else form.append('photo', { uri: asset.uri, type, name });
        form.append('orderId', orderId);
        const response = await api.post('/api/returns/evidence', form, { timeout: API_UPLOAD_TIMEOUT_MS, signal: abort.current.signal, headers: { 'Content-Type': 'multipart/form-data' } });
        if (generation.current !== current) return;
        const photo = response.data?.evidence;
        if (!/^[a-f\d]{24}$/iu.test(photo?._id || '') || typeof photo.url !== 'string' || !photo.url.startsWith('https://')) throw new Error('The uploaded photo could not be verified.');
        onChange(previous => [...previous, photo]);
      }
    } catch (failure) { if (generation.current === current) setError(failure.response?.data?.msg || failure.message || 'Photo upload failed. Try again.'); }
    finally { working.current = false; if (generation.current === current) { setBusy(false); onBusyChange(false); } }
  };
  return <View style={{ gap: 9, marginTop: 18 }}><Text style={{ color: palette.colors.text, fontSize: 14, fontWeight: '700' }}>Photos (required)</Text>
    <Text style={{ color: palette.colors.textSecondary, fontSize: 12, lineHeight: 18 }}>Attach 1–6 JPEG, PNG or WebP photos, up to 5 MB each. Avoid personal or payment information.</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Add return photos (${photos.length}/6)`} disabled={disabled || busy || photos.length >= 6} onPress={choose} style={{ minHeight: 46, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: palette.colors.border, alignItems: 'center' }}>
      {busy ? <ActivityIndicator color={palette.colors.primary} /> : <Text style={{ color: palette.colors.primary, fontWeight: '700' }}>Add photos ({photos.length}/6)</Text>}
    </TouchableOpacity>
    <ReturnPhotos photos={photos} disabled={disabled || busy} onRemove={id => { onChange(previous => previous.filter(photo => photo._id !== id)); setError(''); }} />
    {!!error && <Text accessibilityRole="alert" style={{ color: palette.colors.error, fontSize: 13 }}>{error}</Text>}
  </View>;
}
