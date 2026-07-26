/**
 * StoreCard — Liquid Glass Design
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import VerifiedBadge from '../VerifiedBadge';
import TrustButton from '../TrustButton';
import { colors, spacing, fontSize, fontWeight, borderRadius, shadows, glass, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import GlassBlurFill from './GlassBlurFill';

// Seller-type pill colours mirror the website's SellerTypePill (brand = violet,
// store = blue) as translucent glass chips rather than opaque solids.
const TYPE_STYLE = {
  brand: { bg: 'rgba(168,85,247,0.16)', border: 'rgba(168,85,247,0.42)', color: '#a855f7', icon: 'sparkles' },
  store: { bg: 'rgba(59,130,246,0.16)', border: 'rgba(59,130,246,0.42)', color: '#3b82f6', icon: 'storefront' },
};
const CARD_SHEEN = ['rgba(20,184,166,0.08)', 'rgba(14,165,233,0.025)', 'rgba(99,102,241,0.11)'];

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
  const typeStyle = isBrand ? TYPE_STYLE.brand : TYPE_STYLE.store;
  const handlePress = () => onPress ? onPress(store) : navigation.navigate('Store', { storeSlug: storeSlug || _id });

  return (
    <Animated.View style={[styles.animatedContainer, { transform: [{ scale: scaleAnim }], opacity: opacityAnim }, style]}>
      <TouchableOpacity style={[styles.container, { backgroundColor: g.bg, borderColor: g.border }, compact && styles.containerCompact]} onPress={handlePress} activeOpacity={0.9}>
        {!compact && Platform.OS !== 'android' && <GlassBlurFill intensity={36} />}
        {Platform.OS !== 'android' && (
          <LinearGradient
            colors={CARD_SHEEN}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        )}
        <View style={[styles.bannerContainer, compact && { height: 55 }]}>
          {banner && !bannerError ? (
            <Image source={{ uri: banner }} style={styles.banner} contentFit="cover" cachePolicy="memory-disk" transition={200} onError={() => setBannerError(true)} />
          ) : (
            <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.banner}>
              <Ionicons name={isBrand ? 'sparkles' : 'storefront'} size={compact ? 22 : 30} color="rgba(255,255,255,0.32)" />
            </LinearGradient>
          )}
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.32)']} style={StyleSheet.absoluteFill} pointerEvents="none" />
          <View style={[styles.typePill, { backgroundColor: typeStyle.bg, borderColor: typeStyle.border }]}>
            <Ionicons name={typeStyle.icon} size={9} color={typeStyle.color} />
            <Text style={[styles.typePillText, { color: typeStyle.color }]}>{isBrand ? 'BRAND' : 'STORE'}</Text>
          </View>
        </View>
        <View style={[styles.content, compact && { padding: spacing.sm }]}>
          <View style={[styles.logoContainer, compact && { marginTop: -28 }]}>
            {logo && !logoError ? <Image source={{ uri: logo }} style={[styles.logo, { backgroundColor: g.bgSubtle }, compact && styles.logoCompact]} contentFit="cover" cachePolicy="memory-disk" transition={150} onError={() => setLogoError(true)} /> :
              <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.logoPlaceholder, compact && styles.logoCompact]}><Ionicons name="storefront" size={compact ? 18 : 24} color="#fff" /></LinearGradient>}
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
            <Text style={[styles.trustText, { color: c.textSecondary }]}>{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</Text>
            <Text style={[styles.trustText, { color: c.textSecondary, marginHorizontal: 4 }]}>·</Text>
            <Ionicons name={ratingCount > 0 ? 'star' : 'star-outline'} size={11} color="#fbbf24" />
            <Text style={[styles.trustText, { color: c.textSecondary }]}>{ratingCount > 0 ? `${Number(ratingAverage).toFixed(1)} (${ratingCount})` : 'New'}</Text>
          </View>
          {showDescription && description && !compact && <Text style={[styles.description, { color: c.textSecondary }]} numberOfLines={2}>{description}</Text>}
          {showStats && (
            <View style={[styles.statsRow, { borderTopColor: g.borderSubtle }, compact && { paddingTop: spacing.sm, gap: spacing.md }]}>
              <View style={styles.stat}><Ionicons name="cube" size={12} color={c.primary} /><Text style={[styles.statText, { color: c.primary }]}>{productCount} {compact ? '' : 'items'}</Text></View>
              {!compact && <View style={styles.stat}><Ionicons name="eye" size={12} color="#0ea5e9" /><Text style={[styles.statText, { color: '#0ea5e9' }]}>{views} views</Text></View>}
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
      {Platform.OS !== 'android' && <GlassBlurFill intensity={32} />}
      {Platform.OS !== 'android' && <LinearGradient colors={CARD_SHEEN} style={StyleSheet.absoluteFill} pointerEvents="none" />}
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
          <Text style={styles.listItemStatText}>{trustCount} {trustCount === 1 ? 'truster' : 'trusters'}</Text>
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
  container: { backgroundColor: glass.bg, borderRadius: 22, borderWidth: 1, borderColor: glass.border, overflow: 'hidden', shadowColor: '#1e293b', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.1, shadowRadius: 14, elevation: Platform.OS === 'android' ? 0 : 4 },
  containerCompact: { width: 160, marginRight: spacing.md },
  bannerContainer: { height: 68, overflow: 'hidden', position: 'relative' },
  banner: { width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center' },
  typePill: { position: 'absolute', top: 7, right: 7, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  typePillText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  bannerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.15)' },
  content: { padding: spacing.md, paddingTop: spacing.xs },
  logoContainer: { marginTop: -34, marginBottom: spacing.xs },
  logo: { width: 52, height: 52, borderRadius: 16, borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.55)', backgroundColor: glass.bgSubtle, shadowColor: '#1e293b', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 5 },
  logoCompact: { width: 44, height: 44, borderRadius: 14 },
  logoPlaceholder: { width: 52, height: 52, borderRadius: 16, borderWidth: 2.5, borderColor: 'rgba(255,255,255,0.55)', justifyContent: 'center', alignItems: 'center', shadowColor: '#1e293b', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 5 },
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
