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
import { useTheme } from '../../contexts/ThemeContext';
import GlassBlurFill from './GlassBlurFill';

const StoreCard = ({ store, index = 0, onPress, showTrustButton = true, showDescription = true, showStats = true, compact = false, style }) => {
  const navigation = useNavigation();
  const { palette } = useTheme();
  const c = palette.colors;
  const g = palette.glass;
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

  const { _id, storeName, storeSlug, description, logo, banner, trustCount = 0, verification, productCount = 0, views = 0, ratingAverage = 0, ratingCount = 0, sellerType } = store;
  const isVerified = verification?.isVerified;
  const isBrand = sellerType === 'brand';
  const handlePress = () => onPress ? onPress(store) : navigation.navigate('Store', { storeSlug: storeSlug || _id });

  return (
    <Animated.View style={[styles.animatedContainer, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }, style]}>
      <TouchableOpacity style={[styles.container, { backgroundColor: g.bg, borderColor: g.border }, compact && styles.containerCompact]} onPress={handlePress} activeOpacity={0.9}>
        <GlassBlurFill />
        <View style={[styles.bannerContainer, compact && { height: 55 }]}>
          {banner && !bannerError ? <Image source={{ uri: banner }} style={styles.banner} contentFit="cover" cachePolicy="memory-disk" transition={200} onError={() => setBannerError(true)} /> :
            <View style={[styles.banner, { backgroundColor: c.primary }]} />}
          <View style={styles.bannerOverlay} />
          <View style={[styles.typePill, { backgroundColor: isBrand ? 'rgba(168,85,247,0.92)' : 'rgba(59,130,246,0.92)' }]}>
            <Ionicons name={isBrand ? 'sparkles' : 'storefront'} size={9} color="#fff" />
            <Text style={styles.typePillText}>{isBrand ? 'BRAND' : 'STORE'}</Text>
          </View>
        </View>
        <View style={[styles.content, compact && { padding: spacing.sm }]}>
          <View style={[styles.logoContainer, compact && { marginTop: -28 }]}>
            {logo && !logoError ? <Image source={{ uri: logo }} style={[styles.logo, { backgroundColor: g.bgSubtle }, compact && styles.logoCompact]} contentFit="cover" cachePolicy="memory-disk" transition={150} onError={() => setLogoError(true)} /> :
              <View style={[styles.logoPlaceholder, { backgroundColor: c.primary }, compact && styles.logoCompact]}><Ionicons name="storefront" size={compact ? 18 : 24} color="#fff" /></View>}
          </View>
          <View style={styles.headerRow}>
            <View style={styles.nameContainer}>
              <Text style={[styles.storeName, { color: c.text }, compact && { fontSize: fontSize.sm }]} numberOfLines={1}>{storeName}</Text>
              {isVerified && <VerifiedBadge size={compact ? 'xs' : 'sm'} style={{ marginLeft: 4 }} />}
            </View>
            {showTrustButton && !compact && <View style={{ flexShrink: 0 }}><TrustButton storeId={_id} storeName={storeName} initialTrustCount={trustCount} compact /></View>}
          </View>
          <View style={styles.trustRow}>
            <Ionicons name="heart" size={11} color={c.heart} />
            <Text style={[styles.trustText, { color: c.textSecondary }]}>{trustCount} trusters</Text>
            {ratingCount > 0 && (
              <>
                <Text style={[styles.trustText, { color: c.textSecondary, marginHorizontal: 4 }]}>·</Text>
                <Ionicons name="star" size={11} color="#fbbf24" />
                <Text style={[styles.trustText, { color: c.textSecondary }]}>{Number(ratingAverage).toFixed(1)} ({ratingCount})</Text>
              </>
            )}
          </View>
          {showDescription && description && !compact && <Text style={[styles.description, { color: c.textSecondary }]} numberOfLines={2}>{description}</Text>}
          {showStats && (
            <View style={[styles.statsRow, { borderTopColor: g.borderSubtle }, compact && { paddingTop: spacing.sm, gap: spacing.md }]}>
              <View style={styles.stat}><Ionicons name="cube-outline" size={13} color={c.info} /><Text style={[styles.statText, { color: c.textSecondary }]}>{productCount} {compact ? '' : 'items'}</Text></View>
              {!compact && <View style={styles.stat}><Ionicons name="eye-outline" size={13} color={c.secondary} /><Text style={[styles.statText, { color: c.textSecondary }]}>{views} views</Text></View>}
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
  const { _id, storeName, storeSlug, description, logo, trustCount = 0, verification, productCount = 0, ratingAverage = 0, ratingCount = 0 } = store;
  const isVerified = verification?.isVerified;
  const handlePress = () => onPress ? onPress(store) : navigation.navigate('Store', { storeSlug: storeSlug || _id });

  return (
    <TouchableOpacity style={styles.listItemContainer} onPress={handlePress} activeOpacity={0.7}>
      <GlassBlurFill />
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
          {ratingCount > 0 && (
            <>
              <Text style={styles.listItemDot}>•</Text>
              <Ionicons name="star" size={10} color="#fbbf24" style={{ marginRight: 2 }} />
              <Text style={styles.listItemStatText}>{Number(ratingAverage).toFixed(1)} ({ratingCount})</Text>
            </>
          )}
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
  bannerContainer: { height: 60, overflow: 'hidden', position: 'relative' },
  banner: { width: '100%', height: '100%' },
  typePill: { position: 'absolute', top: 6, right: 6, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 8 },
  typePillText: { fontSize: 9, fontWeight: '800', color: '#fff', letterSpacing: 0.5 },
  bannerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.15)' },
  content: { padding: spacing.md, paddingTop: spacing.xs },
  logoContainer: { marginTop: -30, marginBottom: spacing.xs },
  logo: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: glass.bgSubtle },
  logoCompact: { width: 42, height: 42, borderRadius: 21 },
  logoPlaceholder: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)', backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  nameContainer: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: spacing.sm },
  storeName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, flex: 1 },
  trustRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  trustText: { fontSize: fontSize.xs, color: colors.textSecondary, marginLeft: 4 },
  description: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: spacing.md, lineHeight: 18 },
  statsRow: { flexDirection: 'row', alignItems: 'center', paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: glass.borderSubtle, gap: spacing.lg },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: fontWeight.medium },
  listItemContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: glass.bg, padding: spacing.md, borderRadius: 16, marginBottom: spacing.sm, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  listItemLogo: { width: 46, height: 46, borderRadius: 14, marginRight: spacing.md },
  listItemLogoPlaceholder: { backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center' },
  listItemName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text, marginRight: 4, flex: 1 },
  listItemDesc: { fontSize: fontSize.sm, color: colors.textSecondary, marginBottom: 4 },
  listItemStatText: { fontSize: fontSize.xs, color: colors.textSecondary },
  listItemDot: { fontSize: fontSize.xs, color: colors.textSecondary, marginHorizontal: 4 },
});

export default StoreCard;
