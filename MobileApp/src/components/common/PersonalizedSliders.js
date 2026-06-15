/**
 * PersonalizedSliders - themed Recommended / Trending / Recently Viewed / Price Drops
 */
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import { clearRecentlyViewed, getRecentlyViewed, subscribeRecentlyViewed } from '../../utils/recentlyViewed';
import { SliderSkeleton } from './Skeleton';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

const SectionHeader = ({ icon, title, subtitle, color, palette }) => {
  const styles = makeStyles(palette);
  return (
    <View style={styles.sectionHeader}>
      <View style={[styles.sectionIcon, { backgroundColor: color + '22' }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      </View>
    </View>
  );
};

const SliderCard = ({ product, onPress, formatPrice, palette }) => {
  const { formatProductPrice } = useCurrency();
  const styles = makeStyles(palette);
  const hasDiscount = product.discountedPrice > 0 && product.discountedPrice < product.price;
  const discountPct = hasDiscount ? Math.round(((product.price - product.discountedPrice) / product.price) * 100) : 0;
  const imageSource = product.images?.[0]?.url || product.image;

  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={onPress} accessibilityLabel={`View ${product.name}`}>
      <View style={styles.cardImageWrap}>
        <Image source={{ uri: imageSource }} style={styles.cardImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
        {discountPct > 0 && (
          <View style={styles.discountBadge}>
            <Text style={styles.discountText}>-{discountPct}%</Text>
          </View>
        )}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardName} numberOfLines={2}>{product.name}</Text>
        <View style={styles.cardPriceRow}>
          <Text style={styles.cardPrice}>{formatProductPrice(product, { field: hasDiscount ? 'discountedPrice' : 'price' })}</Text>
          {hasDiscount && <Text style={styles.cardOriginalPrice}>{formatProductPrice(product, { field: 'price' })}</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );
};

const Section = ({ icon, title, subtitle, color, products, formatPrice, navigation, palette, sectionKey }) => {
  const styles = makeStyles(palette);
  if (!products || products.length === 0) return null;
  // Deduplicate by _id to guard against backend responses that return the same product twice.
  const seen = new Set();
  const unique = products.filter((p) => {
    if (!p?._id || seen.has(p._id)) return false;
    seen.add(p._id);
    return true;
  });
  return (
    <View style={styles.section}>
      <SectionHeader icon={icon} title={title} subtitle={subtitle} color={color} palette={palette} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollRow} decelerationRate="fast" snapToInterval={172} snapToAlignment="start">
        {unique.map((p) => (
          <SliderCard key={`${sectionKey}_${p._id}`} product={p} formatPrice={formatPrice} palette={palette} onPress={() => navigation.navigate('ProductDetail', { productId: p._id })} />
        ))}
      </ScrollView>
    </View>
  );
};

export default function PersonalizedSliders({ navigation }) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const { formatPrice } = useCurrency();
  const [picked, setPicked] = useState([]);
  const [trending, setTrending] = useState([]);
  const [priceDrops, setPriceDrops] = useState([]);
  const [recentlyViewed, setRecentlyViewed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [allRes, viewedIds] = await Promise.all([
        api.get('/api/products/get-products?limit=50'),
        getRecentlyViewed(),
      ]);
      const all = allRes.data?.products || [];
      const allById = new Map(all.map((product) => [product._id, product]));
      const missingIds = viewedIds.filter((id) => !allById.has(id)).slice(0, 10);
      const fetchedMissing = await Promise.allSettled(
        missingIds.map((id) => api.get(`/api/products/get-single-product/${id}`))
      );
      fetchedMissing.forEach((result) => {
        const product = result.status === 'fulfilled' ? result.value?.data?.product : null;
        if (product?._id) allById.set(product._id, product);
      });
      const viewed = viewedIds.map((id) => allById.get(id)).filter(Boolean).slice(0, 10);
      setRecentlyViewed(viewed);
      const preferredCategories = [...new Set(viewed.map((p) => p.category))];
      const preferredBrands = [...new Set(viewed.map((p) => p.brand))];
      let pickedItems = [];
      if (preferredCategories.length > 0) {
        pickedItems = all.filter((p) => preferredCategories.includes(p.category) || preferredBrands.includes(p.brand)).filter((p) => !viewedIds.includes(p._id)).slice(0, 12);
      }
      if (pickedItems.length < 4) {
        const fillers = all.filter((p) => !pickedItems.find((x) => x._id === p._id)).sort(() => Math.random() - 0.5).slice(0, 12 - pickedItems.length);
        pickedItems = [...pickedItems, ...fillers];
      }
      setPicked(pickedItems);
      setTrending([...all].sort((a, b) => (b.numReviews || 0) * (b.rating || 0) - (a.numReviews || 0) * (a.rating || 0)).slice(0, 12));
      setPriceDrops(all.filter((p) => p.discountedPrice > 0 && p.discountedPrice < p.price).sort((a, b) => {
        const da = ((a.price - a.discountedPrice) / a.price) * 100;
        const db = ((b.price - b.discountedPrice) / b.price) * 100;
        return db - da;
      }).slice(0, 12));
    } catch (e) {
      console.error('Personalized fetch failed:', e?.message);
    } finally { setLoading(false); }
  }, []);

  const handleClearRecentlyViewed = useCallback(async () => {
    await clearRecentlyViewed();
    setRecentlyViewed([]);
  }, []);

  useEffect(() => {
    fetchData();
    const unsub = subscribeRecentlyViewed(() => fetchData());
    return unsub;
  }, [fetchData]);

  if (loading && !expanded) return null;
  if (loading) {
    return (
      <View style={{ paddingHorizontal: spacing.md, marginBottom: spacing.md }}>
        <View style={[styles.sectionHeader, { paddingHorizontal: spacing.lg }]}>
          <View style={[styles.sectionIcon, { backgroundColor: colors.primarySubtle }]}>
            <Ionicons name="sparkles" size={18} color={colors.primary} />
          </View>
          <Text style={styles.sectionTitle}>Loading personalized picks...</Text>
        </View>
        <SliderSkeleton count={3} />
      </View>
    );
  }

  const hasAnything = picked.length > 0 || trending.length > 0 || priceDrops.length > 0 || recentlyViewed.length > 0;
  if (!hasAnything) return null;

  return (
    <View style={{ paddingHorizontal: spacing.md, marginBottom: spacing.md, gap: spacing.sm }}>
      {/* Toggle pill — matches website's "Show Personalized Picks" */}
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => setExpanded((v) => !v)}
        style={styles.toggleBtn}
        accessibilityLabel={expanded ? 'Hide personalized picks' : 'Show personalized picks'}
      >
        <Ionicons name="grid-outline" size={16} color={colors.primary} />
        <Text style={styles.toggleText}>
          {expanded ? 'Hide Personalized Picks' : 'Show Personalized Picks'}
        </Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={colors.textSecondary}
        />
      </TouchableOpacity>

      {expanded && (
        <View>
          {recentlyViewed.length > 0 && (
            <TouchableOpacity style={styles.clearRecentBtn} activeOpacity={0.8} onPress={handleClearRecentlyViewed}>
              <Ionicons name="trash-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.clearRecentText}>Clear recently viewed</Text>
            </TouchableOpacity>
          )}
          <Section sectionKey="recent" icon="time-outline" title="Recently Viewed" subtitle="Continue where you left off" color={colors.info} products={recentlyViewed} formatPrice={formatPrice} navigation={navigation} palette={palette} />
          <Section sectionKey="picked" icon="sparkles" title="Picked for You" subtitle="Based on what you've explored" color={colors.primary} products={picked} formatPrice={formatPrice} navigation={navigation} palette={palette} />
          <Section sectionKey="drops" icon="pricetag" title="Price Drops" subtitle="Hot deals right now" color={colors.error} products={priceDrops} formatPrice={formatPrice} navigation={navigation} palette={palette} />
          <Section sectionKey="trending" icon="trending-up" title="Trending Now" subtitle="Most popular products" color={colors.success} products={trending} formatPrice={formatPrice} navigation={navigation} palette={palette} />
        </View>
      )}
    </View>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; const glass = palette.glass; return StyleSheet.create({
  section: { marginBottom: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  sectionIcon: { width: 32, height: 32, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  sectionSubtitle: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  scrollRow: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xs },
  card: { width: 160, backgroundColor: glass.bg, borderRadius: 16, borderWidth: 1, borderColor: glass.border, overflow: 'hidden', marginRight: spacing.sm },
  cardImageWrap: { width: '100%', aspectRatio: 1, backgroundColor: glass.bgSubtle },
  cardImage: { width: '100%', height: '100%' },
  discountBadge: { position: 'absolute', top: 6, left: 6, backgroundColor: colors.error, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  discountText: { color: '#fff', fontSize: 10, fontWeight: fontWeight.bold },
  cardBody: { padding: spacing.sm, gap: 4 },
  cardName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, minHeight: 36 },
  cardPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.text },
  cardOriginalPrice: { fontSize: fontSize.xs, color: colors.textSecondary, textDecorationLine: 'line-through' },
  clearRecentBtn: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.lg,
    marginBottom: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: glass.bgSubtle,
    borderWidth: 1,
    borderColor: glass.borderSubtle,
  },
  clearRecentText: { fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: colors.textSecondary },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.xl,
    backgroundColor: glass.bg,
    borderWidth: 1,
    borderColor: glass.border,
  },
  toggleText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text },
}); };
