/**
 * SearchAutocomplete — premium glass recent searches and live marketplace results.
 * Request sequencing prevents an older, slower response replacing a newer query.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../../config/api';
import { useTheme } from '../../contexts/ThemeContext';
import { getSearchHistory, removeSearchHistoryItem, clearSearchHistory } from '../../utils/searchHistory';
import { spacing, fontSize, fontWeight, borderRadius } from '../../styles/theme';
import GlassBlurFill from './GlassBlurFill';

const SEARCH_SHEEN = ['rgba(20,184,166,0.10)', 'rgba(14,165,233,0.045)', 'rgba(99,102,241,0.13)'];
const safeAbort = (controller) => {
  try { controller?.abort(); } catch (_) {}
};

export default function SearchAutocomplete({
  visible,
  query,
  onSelectQuery,
  onSelectProduct,
  onClose,
  onInteraction,
  navigation,
}) {
  const { palette } = useTheme();
  const colors = palette.colors;
  const styles = makeStyles(palette);
  const [history, setHistory] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [storeSuggestions, setStoreSuggestions] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingStores, setLoadingStores] = useState(false);
  const debounceRef = useRef(null);
  const requestSequenceRef = useRef(0);
  const activeControllersRef = useRef({ products: null, stores: null });

  useEffect(() => {
    if (visible) getSearchHistory().then(items => setHistory(items || []));
  }, [visible]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    activeControllersRef.current.products?.abort();
    activeControllersRef.current.stores?.abort();
    const requestId = ++requestSequenceRef.current;
    const term = String(query || '').trim();

    if (!visible || term.length < 2) {
      setSuggestions([]);
      setStoreSuggestions([]);
      setLoadingProducts(false);
      setLoadingStores(false);
      return undefined;
    }

    setSuggestions([]);
    setStoreSuggestions([]);
    setLoadingProducts(true);
    setLoadingStores(true);
    debounceRef.current = setTimeout(() => {
      const productsController = new AbortController();
      const storesController = new AbortController();
      activeControllersRef.current = { products: productsController, stores: storesController };

      api.get('/api/products/get-products', {
        params: { search: term, page: 1, limit: 6, sortBy: 'relevance', sortOrder: 'desc' },
        signal: productsController.signal,
      }).then(response => {
        if (requestId === requestSequenceRef.current && !productsController.signal.aborted) {
          setSuggestions(response.data?.products || []);
        }
      }).catch(() => {
        if (requestId === requestSequenceRef.current && !productsController.signal.aborted) setSuggestions([]);
      }).finally(() => {
        if (requestId === requestSequenceRef.current && !productsController.signal.aborted) setLoadingProducts(false);
      });

      api.get('/api/stores/suggestions', {
        params: { q: term },
        signal: storesController.signal,
      }).then(response => {
        if (requestId === requestSequenceRef.current && !storesController.signal.aborted) {
          setStoreSuggestions((response.data?.suggestions || response.data?.stores || []).slice(0, 4));
        }
      }).catch(() => {
        if (requestId === requestSequenceRef.current && !storesController.signal.aborted) setStoreSuggestions([]);
      }).finally(() => {
        if (requestId === requestSequenceRef.current && !storesController.signal.aborted) setLoadingStores(false);
      });
    }, 260);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      safeAbort(activeControllersRef.current.products);
      safeAbort(activeControllersRef.current.stores);
    };
  }, [query, visible]);

  useEffect(() => () => {
    requestSequenceRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    safeAbort(activeControllersRef.current.products);
    safeAbort(activeControllersRef.current.stores);
  }, []);

  const handleRemove = useCallback(async (searchTerm) => {
    const next = await removeSearchHistoryItem(searchTerm);
    setHistory(next || []);
  }, []);

  const handleClearAll = useCallback(async () => {
    await clearSearchHistory();
    setHistory([]);
  }, []);

  const openStore = useCallback((store) => {
    onClose?.();
    navigation?.navigate('Store', {
      storeSlug: store.storeSlug || store._id,
      storeName: store.storeName,
    });
  }, [navigation, onClose]);

  if (!visible) return null;

  const cleanQuery = String(query || '').trim();
  const showHistory = cleanQuery.length < 2 && history.length > 0;
  const showSuggestions = cleanQuery.length >= 2;
  const loading = loadingProducts || loadingStores;

  return (
    <View style={styles.container} onTouchStart={onInteraction}>
      {Platform.OS !== 'android' && <GlassBlurFill intensity={48} />}
      <LinearGradient
        colors={SEARCH_SHEEN}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.topAccent} />

      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {showHistory && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.headingGroup}>
                <View style={styles.headingIcon}>
                  <Ionicons name="time-outline" size={14} color={colors.primary} />
                </View>
                <View>
                  <Text style={styles.sectionTitle}>Recent searches</Text>
                  <Text style={styles.sectionHint}>Pick up where you left off</Text>
                </View>
              </View>
              <TouchableOpacity onPress={handleClearAll} style={styles.clearButton} accessibilityLabel="Clear search history">
                <Text style={styles.clearText}>Clear all</Text>
              </TouchableOpacity>
            </View>

            {history.map((searchTerm, index) => (
              <View key={searchTerm} style={[styles.historyRow, index > 0 && styles.rowDivider]}>
                <TouchableOpacity
                  style={styles.historyMain}
                  onPress={() => onSelectQuery(searchTerm)}
                  accessibilityLabel={`Search ${searchTerm}`}
                >
                  <View style={styles.historyIcon}>
                    <Ionicons name="search-outline" size={16} color={colors.primary} />
                  </View>
                  <Text style={styles.historyText} numberOfLines={1}>{searchTerm}</Text>
                  <Ionicons name="arrow-up-outline" size={15} color={colors.textSecondary} style={styles.diagonalArrow} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => handleRemove(searchTerm)}
                  style={styles.removeButton}
                  accessibilityLabel={`Remove ${searchTerm} from history`}
                >
                  <Ionicons name="close" size={15} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {showSuggestions && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.headingGroup}>
                <LinearGradient colors={palette.gradients.cta} style={styles.headingIcon}>
                  <Ionicons name="sparkles" size={13} color="#fff" />
                </LinearGradient>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionTitle}>Marketplace matches</Text>
                  <Text style={styles.sectionHint} numberOfLines={1}>Live results for “{cleanQuery}”</Text>
                </View>
              </View>
              {loading && <ActivityIndicator size="small" color={colors.primary} />}
            </View>

            {storeSuggestions.length > 0 && (
              <View style={styles.resultGroup}>
                <Text style={styles.subSectionLabel}>Stores & brands</Text>
                {storeSuggestions.map((store, index) => {
                  const isBrand = store.sellerType === 'brand';
                  const badgeColor = isBrand ? '#a855f7' : '#3b82f6';
                  const logoUri = store.storeLogo || store.logo;
                  return (
                    <TouchableOpacity
                      key={store._id}
                      style={[styles.suggestionRow, index > 0 && styles.rowDivider]}
                      onPress={() => openStore(store)}
                      accessibilityLabel={`View ${store.storeName}`}
                      activeOpacity={0.78}
                    >
                      {logoUri ? (
                        <Image source={{ uri: logoUri }} style={styles.storeLogoImg} contentFit="cover" cachePolicy="memory-disk" />
                      ) : (
                        <View style={[styles.storeLogoImg, styles.imageFallback]}>
                          <Ionicons name={isBrand ? 'sparkles' : 'storefront'} size={20} color={badgeColor} />
                        </View>
                      )}
                      <View style={styles.resultText}>
                        <View style={styles.resultTitleRow}>
                          <Text style={styles.suggestionName} numberOfLines={1}>{store.storeName}</Text>
                          <View style={[styles.typePill, { borderColor: `${badgeColor}55`, backgroundColor: `${badgeColor}16` }]}>
                            <Ionicons name={isBrand ? 'sparkles' : 'storefront'} size={9} color={badgeColor} />
                            <Text style={[styles.typePillText, { color: badgeColor }]}>{isBrand ? 'Brand' : 'Store'}</Text>
                          </View>
                        </View>
                        <Text style={styles.suggestionMeta} numberOfLines={1}>
                          {store.trustCount || 0} {(store.trustCount || 0) === 1 ? 'truster' : 'trusters'}
                        </Text>
                      </View>
                      <View style={styles.openResultIcon}>
                        <Ionicons name="arrow-forward" size={15} color={colors.primary} />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {suggestions.length > 0 && (
              <View style={styles.resultGroup}>
                <Text style={styles.subSectionLabel}>Products</Text>
                {suggestions.map((product, index) => {
                  const imageUri = product.images?.[0]?.url || product.image;
                  return (
                    <TouchableOpacity
                      key={product._id}
                      style={[styles.suggestionRow, index > 0 && styles.rowDivider]}
                      onPress={() => onSelectProduct(product)}
                      accessibilityLabel={`View ${product.name}`}
                      activeOpacity={0.78}
                    >
                      {imageUri ? (
                        <Image source={{ uri: imageUri }} style={styles.suggestionImg} contentFit="cover" cachePolicy="memory-disk" />
                      ) : (
                        <View style={[styles.suggestionImg, styles.imageFallback]}>
                          <Ionicons name="cube-outline" size={20} color={colors.primary} />
                        </View>
                      )}
                      <View style={styles.resultText}>
                        <Text style={styles.suggestionName} numberOfLines={1}>{product.name}</Text>
                        <View style={styles.productMetaRow}>
                          <Ionicons name="grid-outline" size={11} color={colors.textSecondary} />
                          <Text style={styles.suggestionMeta} numberOfLines={1}>{product.category || 'Product'}</Text>
                        </View>
                      </View>
                      <View style={styles.openResultIcon}>
                        <Ionicons name="arrow-forward" size={15} color={colors.primary} />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {!loading && suggestions.length === 0 && storeSuggestions.length === 0 && (
              <View style={styles.emptyResult}>
                <View style={styles.emptyResultIcon}>
                  <Ionicons name="search-outline" size={23} color={colors.primary} />
                </View>
                <Text style={styles.emptyResultTitle}>No exact matches yet</Text>
                <Text style={styles.emptyText}>Try a shorter product, brand or category name.</Text>
                <TouchableOpacity style={styles.searchAnywayButton} onPress={() => onSelectQuery(cleanQuery)}>
                  <Text style={styles.searchAnywayText}>Search full catalog</Text>
                  <Ionicons name="arrow-forward" size={14} color={colors.primary} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {!showHistory && !showSuggestions && (
          <View style={styles.emptyHint}>
            <View style={styles.emptyResultIcon}>
              <Ionicons name="search-outline" size={23} color={colors.primary} />
            </View>
            <Text style={styles.emptyResultTitle}>What are you looking for?</Text>
            <Text style={styles.emptyHintText}>Type at least two characters for live products, stores and brands.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const makeStyles = (palette) => {
  const colors = palette.colors;
  const glass = palette.glass;
  return StyleSheet.create({
    container: { backgroundColor: Platform.OS === 'android' ? glass.bgStrong : glass.bg, marginHorizontal: spacing.md, marginTop: spacing.xs, borderRadius: 26, borderWidth: 1, borderColor: glass.borderStrong, maxHeight: 430, shadowColor: '#1e293b', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.17, shadowRadius: 22, elevation: 10, overflow: 'hidden' },
    topAccent: { width: 52, height: 3, borderRadius: 2, alignSelf: 'center', marginTop: 7, backgroundColor: colors.primary, opacity: 0.72 },
    scrollContent: { paddingTop: spacing.xs, paddingBottom: spacing.sm },
    section: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    sectionHeader: { minHeight: 46, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
    headingGroup: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headingIcon: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySubtle, borderWidth: 1, borderColor: colors.primaryLighter },
    sectionTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.text },
    sectionHint: { fontSize: 10, color: colors.textSecondary, marginTop: 2 },
    clearButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: spacing.sm },
    clearText: { fontSize: fontSize.xs, color: colors.primary, fontWeight: fontWeight.semibold },
    historyRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center' },
    historyMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    historyIcon: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: glass.bgSubtle },
    historyText: { flex: 1, fontSize: fontSize.md, color: colors.text, fontWeight: fontWeight.medium },
    diagonalArrow: { transform: [{ rotate: '45deg' }] },
    removeButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: glass.borderSubtle },
    resultGroup: { marginTop: spacing.sm },
    subSectionLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textSecondary, letterSpacing: 0.8, marginBottom: 3, textTransform: 'uppercase' },
    suggestionRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
    suggestionImg: { width: 46, height: 46, borderRadius: 14, backgroundColor: glass.bgSubtle, borderWidth: 1, borderColor: glass.borderSubtle },
    storeLogoImg: { width: 46, height: 46, borderRadius: 16, backgroundColor: glass.bgSubtle, borderWidth: 1, borderColor: glass.border },
    imageFallback: { alignItems: 'center', justifyContent: 'center' },
    resultText: { flex: 1, minWidth: 0 },
    resultTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    suggestionName: { flexShrink: 1, fontSize: fontSize.sm, color: colors.text, fontWeight: fontWeight.semibold },
    suggestionMeta: { flexShrink: 1, fontSize: fontSize.xs, color: colors.textSecondary },
    productMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
    openResultIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySubtle, borderWidth: 1, borderColor: colors.primaryLighter },
    typePill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
    typePillText: { fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.35, textTransform: 'uppercase' },
    emptyResult: { alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md },
    emptyResultIcon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySubtle, borderWidth: 1, borderColor: colors.primaryLighter, marginBottom: spacing.sm },
    emptyResultTitle: { fontSize: fontSize.md, color: colors.text, fontWeight: fontWeight.bold },
    emptyText: { fontSize: fontSize.sm, color: colors.textSecondary, paddingTop: 4, textAlign: 'center', lineHeight: 19 },
    searchAnywayButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, marginTop: spacing.md, borderRadius: borderRadius.full, backgroundColor: colors.primarySubtle, borderWidth: 1, borderColor: colors.primaryLighter },
    searchAnywayText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
    emptyHint: { padding: spacing.xl, alignItems: 'center' },
    emptyHintText: { maxWidth: 270, fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center', lineHeight: 19, marginTop: 4 },
  });
};
