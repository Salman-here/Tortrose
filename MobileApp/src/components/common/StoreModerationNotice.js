import React, { useEffect, useRef } from 'react';
import { View, Text, AppState } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useTheme } from '../../contexts/ThemeContext';

export default function StoreModerationNotice({ store, onChange }) {
  const { palette } = useTheme();
  const latest = useRef({ store, onChange }); latest.current = { store, onChange };
  const pending = store?.moderationStatus === 'pending';
  useEffect(() => {
    if (!pending || !onChange) return undefined;
    let active = true, busy = false;
    const controller = new AbortController();
    const revision = store?.moderationRevision;
    const timer = setInterval(async () => {
      if (busy || AppState.currentState !== 'active') return;
      busy = true;
      try {
        const response = await api.get('/api/stores/my-store', { signal: controller.signal });
        const updated = response.data.store;
        if (active && updated?._id === latest.current.store?._id && updated?.moderationRevision === revision
          && latest.current.store?.moderationRevision === revision) latest.current.onChange?.(updated);
      } catch (_) { /* Never infer approval from a request failure. */ }
      finally { busy = false; }
    }, 8000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [pending, store?.moderationRevision, onChange]);
  if (!pending && store?.moderationStatus !== 'blocked') return null;
  return <View accessibilityRole='summary' style={{ padding: 16, marginBottom: 16, borderRadius: 16, borderWidth: 1, borderColor: pending ? palette.colors.warning : palette.colors.error, backgroundColor: palette.glass.bg }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Ionicons name={pending ? 'time-outline' : 'shield-outline'} size={20} color={palette.colors.text} /><Text style={{ color: palette.colors.text, fontWeight: '700' }}>{pending ? 'Store under review' : 'Store content blocked'}</Text></View>
    <Text style={{ color: palette.colors.textSecondary, marginTop: 8 }}>{store.moderationReason || 'Automatic content checks are in progress.'}</Text>
    <Text style={{ color: palette.colors.textSecondary, marginTop: 5 }}>{pending ? 'Your store and products remain hidden until the checks pass.' : 'Edit the flagged content to submit it for automatic checks again.'}</Text>
  </View>;
}
