/**
 * PersonalizedSliders — mirrors the website's PersonalizedSections.
 * Each theme (Picked for You / Price Drops / Trending / Recently Viewed / Gift
 * Ideas) is its OWN collapsible glass panel, closed by default, with a coloured
 * icon badge, subtitle, animated chevron and a horizontal slider of rich cards.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Animated,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import { resolveProductPresentationMoney, useCurrency } from '../../contexts/CurrencyContext';
import { useTheme } from '../../contexts/ThemeContext';
import { clearRecentlyViewed, getRecentlyViewed, subscribeRecentlyViewed } from '../../utils/recentlyViewed';
import GlassBlurFill from './GlassBlurFill';
import { SliderSkeleton } from './Skeleton';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';

// Smooth height animation for the expand/collapse on Android.
if (
  Platform.OS === 'android'
  && !globalThis.nativeFabricUIManager
  && UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const CARD_WIDTH = 168;

// Rich product card matching the website's SliderProductCard: portrait image
// with a category pill + discount badge, name, reviews/stock, price + "View →".
const SliderProductCard = ({ product, onPress, palette }) => {
  const { formatProductPrice } = useCurrency();
  const styles = makeStyles(palette);
  const c = palette.colors;
  const price = resolveProductPresentationMoney(product, 'price');
  const discounted = resolveProductPresentationMoney(product, 'discountedPrice');
  const hasDiscount = discounted > 0 && discounted < price;
  const discountPct = hasDiscount ? Math.round(((price - discounted) / price) * 100) : 0;
  const imageSource = product.images?.[0]?.url || product.image;
  const stock = Number(product.stock || 0);
  const validImage = /^(https?:|data:|file:)/.test(String(imageSource || ''));

  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={onPress} accessibilityLabel={`View ${product.name}`}>
      <GlassBlurFill intensity={36} />
      <View style={styles.cardImageWrap}>
        {validImage ? (
          <Image source={{ uri: imageSource }} style={styles.cardImage} contentFit="cover" cachePolicy="memory-disk" transition={150} />
        ) : (
          <View style={[styles.cardImage, styles.cardImagePlaceholder]}>
            <Ionicons name="image-outline" size={26} color={c.grayLight} />
          </View>
        )}
        {discountPct > 0 && (
          <View style={styles.discountBadge}>
            <Text style={styles.discountText}>-{discountPct}%</Text>
          </View>
        )}
        {!!product.category && (
          <View style={styles.categoryPillWrap} pointerEvents="none">
            <View style={styles.categoryPill}>
              <Text style={styles.categoryPillText} numberOfLines={1}>{product.category}</Text>
            </View>
          </View>
        )}
      </View>
      <View style={styles.cardBody}>
        <View>
          <Text style={styles.cardName} numberOfLines={2}>{product.name}</Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {product.numReviews || 0} reviews • {stock > 0 ? `${stock} in stock` : 'Out of stock'}
          </Text>
        </View>
        <View style={styles.cardPriceRow}>
          <View style={styles.cardPriceCol}>
            <Text style={styles.cardPrice} numberOfLines={1}>
              {formatProductPrice(product, { field: hasDiscount ? 'discountedPrice' : 'price' })}
            </Text>
            {hasDiscount && (
              <Text style={styles.cardOriginalPrice} numberOfLines={1}>
                {formatProductPrice(product, { field: 'price' })}
              </Text>
            )}
          </View>
          <Text style={styles.cardView}>View →</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
};

// Collapsible glass panel wrapping one themed slider — matches the website's
// CollapsibleSection (icon badge + title/subtitle + animated chevron + slider).
const CollapsibleSection = ({ icon, title, subtitle, color, iconBg, tint, action, products, navigation, palette }) => {
  const styles = makeStyles(palette);
  const c = palette.colors;
  const [open, setOpen] = useState(false);
  const rotate = useRef(new Animated.Value(0)).current;

  // Deduplicate by _id to guard against backend responses that repeat a product.
  const seen = new Set();
  const unique = (products || []).filter((p) => {
    if (!p?._id || seen.has(p._id)) return false;
    seen.add(p._id);
    return true;
  });
  if (unique.length === 0) return null;

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    Animated.timing(rotate, { toValue: open ? 0 : 1, duration: 220, useNativeDriver: true }).start();
    setOpen((o) => !o);
  };
  const rotateDeg = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  return (
    <View style={[styles.panel, tint ? { backgroundColor: tint } : null]}>
      <GlassBlurFill />
      <View style={styles.panelHeaderRow}>
        <TouchableOpacity style={styles.panelHeaderBtn} activeOpacity={0.7} onPress={toggle} accessibilityRole="button" accessibilityLabel={`${open ? 'Hide' : 'Show'} ${title}`}>
          <View style={[styles.panelIcon, { backgroundColor: iconBg }]}>
            <Ionicons name={icon} size={20} color={color} />
          </View>
          <View style={styles.panelHeaderText}>
            <Text style={styles.panelTitle} numberOfLines={1}>{title}</Text>
            {subtitle ? <Text style={styles.panelSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
          </View>
          <Animated.View style={{ transform: [{ rotate: rotateDeg }] }}>
            <Ionicons name="chevron-down" size={18} color={c.textSecondary} />
          </Animated.View>
        </TouchableOpacity>
        {action ? <View style={styles.panelAction}>{action}</View> : null}
      </View>

      {open && (
        <View style={styles.panelBody}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.scrollRow}
            decelerationRate="fast"
            snapToInterval={CARD_WIDTH + spacing.sm}
            snapToAlignment="start"
          >
            {unique.map((p) => (
              <SliderProductCard
                key={p._id}
                product={p}
                palette={palette}
                onPress={() => navigation.navigate('ProductDetail', { productId: p._id })}
              />
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
};

export default function PersonalizedSliders({ navigation }) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const [picked, setPicked] = useState([]);
  const [trending, setTrending] = useState([]);
  const [priceDrops, setPriceDrops] = useState([]);
  const [recentlyViewed, setRecentlyViewed] = useState([]);
  const [loading, setLoading] = useState(true);

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

  // Gift Ideas mirrors the website: a shuffled subset of "Picked for You".
  const giftIdeas = picked.length > 4 ? [...picked].slice(0, 6).sort(() => Math.random() - 0.5) : [];
  const hasAnything = picked.length > 0 || trending.length > 0 || priceDrops.length > 0 || recentlyViewed.length > 0;

  if (loading) {
    return (
      <View style={styles.wrap}>
        <View style={[styles.panel, styles.panelLoading]}>
          <GlassBlurFill />
          <View style={styles.panelHeaderRow}>
            <View style={[styles.panelIcon, { backgroundColor: colors.primarySubtle }]}>
              <Ionicons name="sparkles" size={20} color={colors.primary} />
            </View>
            <View style={styles.panelHeaderText}>
              <Text style={styles.panelTitle}>Personalized picks</Text>
              <Text style={styles.panelSubtitle}>Curating products for you…</Text>
            </View>
          </View>
          <SliderSkeleton count={3} />
        </View>
      </View>
    );
  }

  if (!hasAnything) return null;

  return (
    <View style={styles.wrap}>
      <CollapsibleSection
        icon="sparkles"
        title="Picked for You"
        subtitle="Products you might love"
        color="hsl(280, 70%, 60%)"
        iconBg="hsla(280, 70%, 60%, 0.14)"
        products={picked}
        navigation={navigation}
        palette={palette}
      />
      <CollapsibleSection
        icon="pricetag"
        title="Price Drops"
        subtitle="Hot deals on watched items"
        color="hsl(0, 72%, 55%)"
        iconBg="hsla(0, 72%, 55%, 0.14)"
        tint="rgba(239, 68, 68, 0.05)"
        products={priceDrops}
        navigation={navigation}
        palette={palette}
      />
      <CollapsibleSection
        icon="trending-up"
        title="Trending Now"
        subtitle="Most popular products"
        color="hsl(150, 60%, 42%)"
        iconBg="hsla(150, 60%, 42%, 0.16)"
        products={trending}
        navigation={navigation}
        palette={palette}
      />
      <CollapsibleSection
        icon="time"
        title="Recently Viewed"
        subtitle="Continue where you left off"
        color="hsl(200, 80%, 52%)"
        iconBg="hsla(200, 80%, 52%, 0.14)"
        products={recentlyViewed}
        navigation={navigation}
        palette={palette}
        action={(
          <TouchableOpacity style={styles.clearBtn} activeOpacity={0.8} onPress={handleClearRecentlyViewed} accessibilityLabel="Clear recently viewed">
            <Text style={styles.clearBtnText}>Clear</Text>
          </TouchableOpacity>
        )}
      />
      <CollapsibleSection
        icon="gift"
        title="Gift Ideas"
        subtitle="Perfect presents for loved ones"
        color="hsl(330, 80%, 60%)"
        iconBg="hsla(330, 80%, 60%, 0.14)"
        tint="rgba(236, 72, 153, 0.05)"
        products={giftIdeas}
        navigation={navigation}
        palette={palette}
      />
    </View>
  );
}

const makeStyles = (palette) => { const colors = palette.colors; const glass = palette.glass; return StyleSheet.create({
  wrap: { paddingHorizontal: spacing.md, marginBottom: spacing.md, gap: spacing.md },

  // Collapsible glass panel
  panel: { borderRadius: borderRadius.xxl, borderWidth: 1, borderColor: glass.border, backgroundColor: glass.bg, overflow: 'hidden' },
  panelLoading: { paddingBottom: spacing.md },
  panelHeaderRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
  panelHeaderBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
  panelHeaderText: { flex: 1, minWidth: 0 },
  panelIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  panelTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.text },
  panelSubtitle: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 1 },
  panelAction: { flexShrink: 0 },
  panelBody: { paddingBottom: spacing.md },
  clearBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full, backgroundColor: glass.bgStrong, borderWidth: 1, borderColor: glass.border },
  clearBtnText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },

  // Slider + card
  scrollRow: { paddingHorizontal: spacing.md, gap: spacing.sm, paddingTop: spacing.xs, paddingBottom: spacing.xs },
  card: { width: CARD_WIDTH, backgroundColor: glass.bg, borderRadius: borderRadius.xl, borderWidth: 1, borderColor: glass.border, overflow: 'hidden' },
  cardImageWrap: { width: '100%', aspectRatio: 4 / 4.8, backgroundColor: glass.bgSubtle },
  cardImage: { width: '100%', height: '100%' },
  cardImagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  discountBadge: { position: 'absolute', top: 8, left: 8, backgroundColor: colors.error, paddingHorizontal: 7, paddingVertical: 3, borderRadius: borderRadius.full },
  discountText: { color: '#fff', fontSize: 10, fontWeight: fontWeight.bold },
  categoryPillWrap: { position: 'absolute', left: 8, right: 8, bottom: 8, flexDirection: 'row' },
  categoryPill: { maxWidth: '100%', backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: borderRadius.full },
  categoryPillText: { color: '#fff', fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.6, textTransform: 'uppercase' },
  cardBody: { padding: spacing.sm, gap: spacing.sm, minHeight: 96, justifyContent: 'space-between' },
  cardName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, minHeight: 34 },
  cardMeta: { fontSize: fontSize.xs, color: colors.textSecondary, marginTop: 2 },
  cardPriceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.xs },
  cardPriceCol: { flex: 1, minWidth: 0 },
  cardPrice: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.text },
  cardOriginalPrice: { fontSize: fontSize.xs, color: colors.textSecondary, textDecorationLine: 'line-through' },
  cardView: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.primary },
}); };
