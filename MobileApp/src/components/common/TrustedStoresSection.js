/**
 * TrustedStoresSection — themed horizontal slider of stores the user trusts.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
import VerifiedBadge from '../VerifiedBadge';
import GlassBlurFill from './GlassBlurFill';
import { spacing, fontSize, fontWeight } from '../../styles/theme';

export default function TrustedStoresSection({ navigation }) {
  const { currentUser } = useAuth();
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      const res = await api.get('/api/stores/trusted');
      if (res.data?.success) setStores(res.data.data.trustedStores || []);
    } catch {} finally { setLoading(false); }
  }, [currentUser]);

  useEffect(() => { fetch(); }, [fetch]);

  if (!currentUser || stores.length === 0) return null;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <View style={[styles.iconWrap, { backgroundColor: colors.errorSubtle }]}>
          <Ionicons name="heart" size={18} color={colors.heart} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Stores You Trust</Text>
          <Text style={styles.subtitle}>Quick access to your favourites</Text>
        </View>
        <TouchableOpacity
          onPress={() => navigation.navigate('Wishlist', { tab: 'stores' })}
          accessibilityRole="button"
          accessibilityLabel="See all trusted stores"
        >
          <Text style={styles.seeAll}>See all</Text>
        </TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} decelerationRate="fast">
        {stores.map((s) => {
          const isVerified = s.verification?.isVerified;
          return (
            <TouchableOpacity key={s._id} style={styles.card} activeOpacity={0.85} onPress={() => navigation.navigate('Store', { storeSlug: s.storeSlug || s._id })} accessibilityLabel={`Visit ${s.storeName}`}>
              <GlassBlurFill intensity={38} />
              <View style={styles.logoWrap}>
                {s.logo ? (
                  <Image source={{ uri: s.logo }} style={styles.logo} contentFit="cover" cachePolicy="memory-disk" transition={150} />
                ) : (
                  <View style={[styles.logo, styles.logoPlaceholder]}>
                    <Ionicons name="storefront" size={26} color="#fff" />
                  </View>
                )}
                {isVerified && (
                  <View style={styles.verifiedDot}>
                    <VerifiedBadge size="xs" />
                  </View>
                )}
              </View>
              <Text style={styles.name} numberOfLines={1}>{s.storeName}</Text>
              <View style={styles.trustRow}>
                <Ionicons name="heart" size={11} color={colors.heart} />
                <Text style={styles.trustText}>{s.trustCount}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; const glass = palette.glass; return StyleSheet.create({
  section: { marginBottom: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  iconWrap: { width: 32, height: 32, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  subtitle: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  seeAll: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  row: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.xs },
  card: { width: 96, alignItems: 'center', backgroundColor: glass.bg, borderRadius: 18, borderWidth: 1, borderColor: glass.border, paddingVertical: spacing.md, paddingHorizontal: spacing.sm, marginRight: spacing.xs, overflow: 'hidden' },
  logoWrap: { position: 'relative', marginBottom: 6 },
  logo: { width: 56, height: 56, borderRadius: 28, backgroundColor: glass.bgSubtle, borderWidth: 2, borderColor: glass.borderSubtle },
  logoPlaceholder: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  verifiedDot: { position: 'absolute', bottom: -2, right: -2, backgroundColor: colors.surface, borderRadius: 999, padding: 1 },
  name: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.text, textAlign: 'center', marginTop: 2 },
  trustRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 },
  trustText: { fontSize: 10, color: colors.textSecondary, fontWeight: fontWeight.medium },
}); };
