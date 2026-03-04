/**
 * StoreCard — Liquid Glass Design
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import VerifiedBadge from '../VerifiedBadge';
import TrustButton from '../TrustButton';
import { colors, spacing, fontSize, fontWeight, borderRadius, shadows, glass, typography } from '../../styles/theme';

const StoreCard = ({ store, index = 0, onPress, showTrustButton = true, showDescription = true, showStats = true, compact = false, style }) => {
  const navigation = useNavigation();
  const [bannerError, setBannerError] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const scaleAnim = useRef(new Animated.Value(0.95)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: 1, friction: 8, tension: 40, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
    }, index * 80);
    return () => clearTimeout(t);
  }, [index]);

  if (!store) return null;

  const { _id, storeName, storeSlug, description, logo, banner, trustCount = 0, verification, productCount = 0, views = 0 } = store;
  const isVerified = verification?.isVerified;
  const handlePress = () => onPress ? onPress(store) : navigation.navigate('Store', { storeSlug: storeSlug || _id });

  return (
    <Animated.View style={[styles.animatedContainer, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }, style]}>
      <TouchableOpacity style={[styles.container, compact && styles.containerCompact]} onPress={handlePress} activeOpacity={0.9}>
        <View style={[styles.bannerContainer, compact && { height: 55 }]}>
          {banner && !bannerError ? <Image source={{ uri: banner }} style={styles.banner} contentFit="cover" cachePolicy="memory-disk" transition={200} onError={() => setBannerError(true)} /> :
            <View style={[styles.banner, { backgroundColor: colors.primary }]} />}
          <View style={styles.bannerOverlay} />
        </View>
        <View style={[styles.content, compact && { padding: spacing.sm }]}>
          <View style={[styles.logoContainer, compact && { marginTop: -28 }]}>
            {logo && !logoError ? <Image source={{ uri: logo }} style={[styles.logo, compact && styles.logoCompact]} contentFit="cover" cachePolicy="memory-disk" transition={150} onError={() => setLogoError(true)} /> :
              <View style={[styles.logoPlaceholder, compact && styles.logoCompact]}><Ionicons name="storefront" size={compact ? 18 : 24} color="#fff" /></View>}
          </View>
          <View style={styles.headerRow}>
            <View style={styles.nameContainer}>
              <Text style={[styles.storeName, compact && { fontSize: fontSize.sm }]} numberOfLines={1}>{storeName}</Text>
              {isVerified && <VerifiedBadge size={compact ? 'xs' : 'sm'} style={{ marginLeft: 4 }} />}
            </View>
            {showTrustButton && !compact && <View style={{ flexShrink: 0 }}><TrustButton storeId={_id} storeName={storeName} initialTrustCount={trustCount} compact /></View>}
          </View>
          <View style={styles.trustRow}><Ionicons name="heart" size={11} color={colors.heart} /><Text style={styles.trustText}>{trustCount} trusters</Text></View>
          {showDescription && description && !compact && <Text style={styles.description} numberOfLines={2}>{description}</Text>}
          {showStats && (
            <View style={[styles.statsRow, compact && { paddingTop: spacing.sm, gap: spacing.md }]}>
              <View style={styles.stat}><Ionicons name="cube-outline" size={13} color={colors.info} /><Text style={styles.statText}>{productCount} {compact ? '' : 'items'}</Text></View>
              {!compact && <View style={styles.stat}><Ionicons name="eye-outline" size={13} color={colors.secondary} /><Text style={styles.statText}>{views} views</Text></View>}
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
};

export const CompactStoreCard = ({ store, onPress }) => <StoreCard store={store} onPress={onPress} compact showDescription={false} showTrustButton={false} />;

export const StoreListItem = ({ store, onPress, showTrustButton = true }) => {
  const navigation = useNavigation();
  if (!store) return null;
  const { _id, storeName, storeSlug, description, logo, trustCount = 0, verification, productCount = 0 } = store;
  const isVerified = verification?.isVerified;
  const handlePress = () => onPress ? onPress(store) : navigation.navigate('Store', { storeSlug: storeSlug || _id });

  return (
    <TouchableOpacity style={styles.listItemContainer} onPress={handlePress} activeOpacity={0.7}>
      {logo ? <Image source={{ uri: logo }} style={styles.listItemLogo} contentFit="cover" cachePolicy="memory-disk" transition={150} /> :
        <View style={[styles.listItemLogo, styles.listItemLogoPlaceholder]}><Ionicons name="storefront" size={22} color="#fff" /></View>}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
          <Text style={styles.listItemName} numberOfLines={1}>{storeName}</Text>
          {isVerified && <VerifiedBadge size="xs" />}
        </View>
        {description && <Text style={styles.listItemDesc} numberOfLines={1}>{description}</Text>}
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={styles.listItemStatText}>{productCount} products</Text>
          <Text style={styles.listItemDot}>•</Text>
          <Text style={styles.listItemStatText}>{trustCount} trusters</Text>
        </View>
      </View>
      {showTrustButton ? <View style={{ marginLeft: spacing.sm }}><TrustButton storeId={_id} storeName={storeName} initialTrustCount={trustCount} compact iconOnly /></View> :
        <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.3)" />}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  animatedContainer: { flex: 1 },
  container: { backgroundColor: glass.bg, borderRadius: 20, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  containerCompact: { width: 160, marginRight: spacing.md },
  bannerContainer: { height: 72, overflow: 'hidden' },
  banner: { width: '100%', height: '100%' },
  bannerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.15)' },
  content: { padding: spacing.md, paddingTop: spacing.sm },
  logoContainer: { marginTop: -36, marginBottom: spacing.sm },
  logo: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: glass.bgSubtle },
  logoCompact: { width: 42, height: 42, borderRadius: 21 },
  logoPlaceholder: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  nameContainer: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: spacing.sm },
  storeName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, flex: 1 },
  trustRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  trustText: { fontSize: fontSize.xs, color: colors.textSecondary, marginLeft: 4 },
  description: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.md, lineHeight: 18 },
  statsRow: { flexDirection: 'row', alignItems: 'center', paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: glass.borderSubtle, gap: spacing.lg },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: fontWeight.medium },
  listItemContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bg, padding: spacing.md, borderRadius: 16, marginBottom: spacing.sm, borderWidth: 1, borderColor: glass.border },
  listItemLogo: { width: 46, height: 46, borderRadius: 14, marginRight: spacing.md },
  listItemLogoPlaceholder: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  listItemName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginRight: 4, flex: 1 },
  listItemDesc: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 4 },
  listItemStatText: { fontSize: fontSize.xs, color: colors.textSecondary },
  listItemDot: { fontSize: fontSize.xs, color: colors.textSecondary, marginHorizontal: 4 },
});

export default StoreCard;
