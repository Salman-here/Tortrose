import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { useTheme } from '../contexts/ThemeContext';
import { fontSize, fontWeight, spacing } from '../styles/theme';

export default function BlockedAccountsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/safety/blocks');
      setBlocks(response.data?.blocks || []);
    } catch (error) {
      Alert.alert('Could not load blocked accounts', error.response?.data?.msg || 'Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const unblock = async (row) => {
    const userId = row.blocked?._id || row.blocked?.id;
    if (!userId) return;
    setBusyId(String(userId));
    try {
      await api.delete(`/api/safety/blocks/${userId}`);
      setBlocks(previous => previous.filter(item => String(item.blocked?._id || item.blocked?.id) !== String(userId)));
    } catch (error) {
      Alert.alert('Could not unblock account', error.response?.data?.msg || 'Please try again.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader title="Blocked accounts" subtitle="Control what you see" icon="shield-checkmark-outline" onBack={() => navigation.goBack()} style={styles.header} />
        {loading ? <View style={styles.center}><ActivityIndicator color={palette.colors.primary} /><Text style={styles.loadingText}>Loading your safety preferences…</Text></View> : (
          <FlatList data={blocks} keyExtractor={item => String(item._id)} contentContainerStyle={styles.list} renderItem={({ item }) => {
            const user = item.blocked || {};
            const label = user.store?.storeName || user.username || 'Account';
            const userId = user._id || user.id;
            return <GlassPanel variant="card" style={styles.card}>{user.avatar ? <Image source={{ uri: user.avatar }} style={styles.avatar} contentFit="cover" /> : <View style={styles.avatarFallback}><Text style={styles.avatarText}>{label.charAt(0).toUpperCase()}</Text></View>}<View style={styles.copy}><Text style={styles.name} numberOfLines={1}>{label}</Text><Text style={styles.meta}>{user.role === 'seller' ? 'Seller and store content hidden' : 'Account content hidden'}</Text></View><TouchableOpacity style={styles.unblockButton} onPress={() => unblock(item)} disabled={busyId === String(userId)} accessibilityRole="button" accessibilityLabel={`Unblock ${label}`}>{busyId === String(userId) ? <ActivityIndicator size="small" color={palette.colors.primary} /> : <Text style={styles.unblockText}>Unblock</Text>}</TouchableOpacity></GlassPanel>;
          }} ListEmptyComponent={<View style={styles.empty}><View style={styles.emptyIcon}><Ionicons name="shield-checkmark-outline" size={34} color={palette.colors.primary} /></View><Text style={styles.emptyTitle}>No blocked accounts</Text><Text style={styles.emptyText}>Accounts you block will appear here, where you can restore them at any time.</Text></View>} />
        )}
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = p => StyleSheet.create({
  container: { flex: 1 }, header: { marginTop: spacing.sm }, list: { padding: spacing.md, paddingBottom: spacing.xxl, flexGrow: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md }, loadingText: { color: p.colors.textSecondary, fontSize: fontSize.sm }, card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, marginBottom: spacing.sm }, avatar: { width: 48, height: 48, borderRadius: 16 }, avatarFallback: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary }, avatarText: { color: '#fff', fontSize: fontSize.lg, fontWeight: fontWeight.extrabold }, copy: { flex: 1, minWidth: 0 }, name: { color: p.colors.text, fontSize: fontSize.md, fontWeight: fontWeight.bold }, meta: { color: p.colors.textSecondary, fontSize: fontSize.xs, marginTop: 3 }, unblockButton: { minWidth: 78, minHeight: 40, borderRadius: 13, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: p.colors.primary, backgroundColor: `${p.colors.primary}0D` }, unblockText: { color: p.colors.primary, fontSize: fontSize.xs, fontWeight: fontWeight.bold }, empty: { flex: 1, minHeight: 430, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl }, emptyIcon: { width: 68, height: 68, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: `${p.colors.primary}12`, marginBottom: spacing.md }, emptyTitle: { color: p.colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.extrabold }, emptyText: { color: p.colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20, textAlign: 'center', marginTop: spacing.sm },
});
