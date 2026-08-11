/**
 * HomeScreen
 * Modern home screen with product browsing, search, and filters
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 6.8
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import api from '../config/api';
import ProductCard from '../components/ProductCard';
import CurrencySelector from '../components/CurrencySelector';
import { PersonalizedSliders, SearchAutocomplete, PriceRangeFilter, TrustedStoresSection } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../components/common/KeyboardAwareFormScrollView';
import GlassBlurFill from '../components/common/GlassBlurFill';
import AIChatFab from '../components/common/AIChatFab';
import { addSearchHistory } from '../utils/searchHistory';
import RozareLogo from '../components/common/RozareLogo';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import { PRESET_CATEGORIES, isPresetCategory } from '../utils/categories';
import HomeCatalogSkeleton from '../components/common/HomeCatalogSkeleton';
import { ProductCardSkeleton } from '../components/common/Skeleton';

// Subtle brand aurora (teal → sky → indigo) laid over glass surfaces for depth.
const HERO_SHEEN = ['rgba(20,184,166,0.13)', 'rgba(14,165,233,0.06)', 'rgba(99,102,241,0.15)'];
const STORE_SHEEN = ['rgba(20,184,166,0.10)', 'rgba(14,165,233,0.05)', 'rgba(99,102,241,0.13)'];
const OTHER_BRANDS_FILTER = '__other_brands__';
const DEFAULT_PRICE_RANGE = { min: 0, max: null };
const PRODUCT_SORT_OPTIONS = [
  { key: 'relevance-desc', field: 'relevance', order: 'desc', label: 'Recommended', helper: 'Balanced discovery', icon: 'sparkles-outline' },
  { key: 'price-asc', field: 'price', order: 'asc', label: 'Lowest price', helper: 'Budget first', icon: 'arrow-up-outline' },
  { key: 'price-desc', field: 'price', order: 'desc', label: 'Highest price', helper: 'Premium first', icon: 'arrow-down-outline' },
  // The backend's non-price comparators are already descending, so `asc`
  // preserves the user-facing "highest/newest/most" direction.
  { key: 'rating-desc', field: 'rating', order: 'asc', label: 'Highest rated', helper: 'Buyer favourites', icon: 'star-outline' },
  { key: 'newest-desc', field: 'newest', order: 'asc', label: 'Newest first', helper: 'Fresh arrivals', icon: 'time-outline' },
  { key: 'popular-desc', field: 'popular', order: 'asc', label: 'Most popular', helper: 'Trending now', icon: 'flame-outline' },
  { key: 'sales-desc', field: 'sales', order: 'asc', label: 'Best selling', helper: 'Most purchased', icon: 'trophy-outline' },
];

export default function HomeScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const { fetchCart, unreadNotifCount } = useGlobal();
  const { currency } = useCurrency();

  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [totalProducts, setTotalProducts] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [otherBrandsCount, setOtherBrandsCount] = useState(0);
  const [otherBrandsValue, setOtherBrandsValue] = useState(OTHER_BRANDS_FILTER);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedBrands, setSelectedBrands] = useState([]);
  const [priceRange, setPriceRange] = useState(DEFAULT_PRICE_RANGE);
  const [sortBy, setSortBy] = useState('relevance');
  const [sortOrder, setSortOrder] = useState('desc');
  const [filterDraft, setFilterDraft] = useState({
    categories: [],
    brands: [],
    priceRange: DEFAULT_PRICE_RANGE,
    search: '',
    sortBy: 'relevance',
    sortOrder: 'desc',
  });
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const productRequestRef = useRef(0);
  const baseLoadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const previousCurrencyRef = useRef(currency);
  const searchBlurTimerRef = useRef(null);

  // Animation for header — use ref to avoid re-creating on every render
  const LIMIT = 12;

  const fetchProducts = useCallback(async (pageNum = 1, overrides = {}, options = {}) => {
    const append = options.append === true && pageNum > 1;

    if (append) {
      if (baseLoadingRef.current || loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setIsLoadingMore(true);
    } else {
      // A fresh query supersedes any append request that may still be running.
      baseLoadingRef.current = true;
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
      if (!options.silent) {
        setIsLoading(true);
        setLoadError(false);
        setProducts([]);
        setTotalProducts(0);
      }
    }

    setLoadMoreError(false);
    const requestId = ++productRequestRef.current;
    const requestFilters = {
      categories: overrides.categories ?? selectedCategories,
      brands: overrides.brands ?? selectedBrands,
      search: overrides.search ?? appliedSearchQuery,
      priceRange: overrides.priceRange ?? priceRange,
      sortBy: overrides.sortBy ?? sortBy,
      sortOrder: overrides.sortOrder ?? sortOrder,
    };

    try {
      const params = new URLSearchParams();
      if (requestFilters.categories.length > 0) {
        requestFilters.categories.forEach(cat => params.append('categories', cat));
      }
      if (requestFilters.brands.length > 0) {
        requestFilters.brands.forEach(brand => params.append('brands', brand));
      }
      if (requestFilters.search?.trim()) {
        params.append('search', requestFilters.search.trim());
      }
      if (requestFilters.priceRange.min > 0 || (requestFilters.priceRange.max && requestFilters.priceRange.max > 0)) {
        // The API parses an empty max as zero; Infinity intentionally becomes
        // an unbounded max so min-only price filters keep returning products.
        params.append('priceRange', `${requestFilters.priceRange.min || 0},${requestFilters.priceRange.max || 'Infinity'}`);
      }
      params.append('sortBy', requestFilters.sortBy);
      params.append('sortOrder', requestFilters.sortOrder);
      params.append('currency', currency);
      params.append('page', pageNum);
      params.append('limit', LIMIT);

      const res = await api.get(`/api/products/get-products?${params.toString()}`);
      if (requestId !== productRequestRef.current) return;

      const newProducts = res.data.products || [];
      const paginationInfo = res.data.pagination;
      const pageIds = new Set();
      const uniquePage = newProducts.filter(product => {
        if (!product?._id || pageIds.has(product._id)) return false;
        pageIds.add(product._id);
        return true;
      });

      setProducts(previousProducts => {
        if (!append) return uniquePage;

        const seenIds = new Set(previousProducts.map(product => product?._id).filter(Boolean));
        const nextProducts = uniquePage.filter(product => !seenIds.has(product._id));
        return nextProducts.length > 0
          ? [...previousProducts, ...nextProducts]
          : previousProducts;
      });

      if (paginationInfo) {
        const nextTotalPages = Math.max(
          1,
          Number(paginationInfo.totalPages ?? paginationInfo.pages) || 1
        );
        setHasMore(pageNum < nextTotalPages);
        setTotalProducts(
          Number(paginationInfo.totalProducts ?? paginationInfo.total) || 0
        );
        setPage(pageNum);
      } else {
        const fallbackHasMore = newProducts.length === LIMIT;
        setHasMore(fallbackHasMore);
        setTotalProducts(previousTotal => (
          append ? previousTotal + uniquePage.length : uniquePage.length
        ));
        setPage(pageNum);
      }
      setLoadError(false);
    } catch (error) {
      if (requestId !== productRequestRef.current) return;
      console.error('Error fetching products:', error);
      if (append) {
        // Preserve rendered products and expose a small retry footer.
        setLoadMoreError(true);
      } else if (!options.silent) {
        setHasMore(false);
        setLoadError(true);
      }
    } finally {
      if (requestId === productRequestRef.current) {
        if (append) {
          loadingMoreRef.current = false;
          setIsLoadingMore(false);
        } else {
          baseLoadingRef.current = false;
          setIsLoading(false);
          setRefreshing(false);
        }
      }
    }
  }, [selectedCategories, selectedBrands, appliedSearchQuery, priceRange, sortBy, sortOrder, currency]);

  const fetchFilters = async () => {
    try {
      const res = await api.get('/api/products/get-filters');
      setCategories(res.data.categories || []);
      setBrands(res.data.brands || []);
      setOtherBrandsCount(Number(res.data.otherBrandsCount) || 0);
      setOtherBrandsValue(res.data.brandFilter?.otherValue || OTHER_BRANDS_FILTER);
    } catch (error) {
      console.error('Error fetching filters:', error);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchProducts(1, {}, { silent: true });
  }, [fetchProducts]);

  // Initial load and when currentUser changes
  useEffect(() => {
    setPage(1);
    setHasMore(true);
    fetchProducts(1);
    fetchFilters();
    if (currentUser) {
      fetchCart();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  // Currency affects comparable prices, price filters and price sorting.
  useEffect(() => {
    if (previousCurrencyRef.current === currency) return;
    previousCurrencyRef.current = currency;
    setPage(1);
    setHasMore(true);
    fetchProducts(1);
  }, [currency, fetchProducts]);

  const cancelAutocompleteBlur = useCallback(() => {
    if (searchBlurTimerRef.current) {
      clearTimeout(searchBlurTimerRef.current);
      searchBlurTimerRef.current = null;
    }
  }, []);

  const handleSearchFocus = useCallback(() => {
    cancelAutocompleteBlur();
    setShowAutocomplete(true);
  }, [cancelAutocompleteBlur]);

  const handleSearchBlur = useCallback(() => {
    cancelAutocompleteBlur();
    searchBlurTimerRef.current = setTimeout(() => {
      setShowAutocomplete(false);
      searchBlurTimerRef.current = null;
    }, 320);
  }, [cancelAutocompleteBlur]);

  useEffect(() => () => cancelAutocompleteBlur(), [cancelAutocompleteBlur]);

  const handleSearch = useCallback((explicitQuery = searchQuery) => {
    cancelAutocompleteBlur();
    const nextQuery = String(explicitQuery || '').trim();
    setSearchQuery(nextQuery);
    setAppliedSearchQuery(nextQuery);
    setPage(1);
    setHasMore(true);
    setShowAutocomplete(false);
    if (nextQuery.length >= 2) {
      addSearchHistory(nextQuery);
    }
    fetchProducts(1, { search: nextQuery });
  }, [cancelAutocompleteBlur, fetchProducts, searchQuery]);

  const canonicalizeCategories = useCallback((values) => {
    const seen = new Set();
    return (values || []).reduce((result, value) => {
      const normalized = String(value || '').trim().toLowerCase();
      if (!normalized || seen.has(normalized)) return result;
      const canonical = categories.find(item => String(item).trim().toLowerCase() === normalized)
        || PRESET_CATEGORIES.find(item => item.toLowerCase() === normalized)
        || String(value).trim();
      seen.add(normalized);
      result.push(canonical);
      return result;
    }, []);
  }, [categories]);

  const applyCategorySelection = useCallback((nextCategories) => {
    const canonicalCategories = canonicalizeCategories(nextCategories);
    setSelectedCategories(canonicalCategories);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, { categories: canonicalCategories });
  }, [canonicalizeCategories, fetchProducts]);

  const removeCategory = useCallback((category) => {
    const normalized = String(category || '').trim().toLowerCase();
    applyCategorySelection(selectedCategories.filter(item => String(item || '').trim().toLowerCase() !== normalized));
  }, [applyCategorySelection, selectedCategories]);

  const removeBrand = useCallback((brand) => {
    const nextBrands = selectedBrands.filter(item => item !== brand);
    setSelectedBrands(nextBrands);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, { brands: nextBrands });
  }, [fetchProducts, selectedBrands]);

  const clearPriceFilter = useCallback(() => {
    setPriceRange(DEFAULT_PRICE_RANGE);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, { priceRange: DEFAULT_PRICE_RANGE });
  }, [fetchProducts]);

  const clearSort = useCallback(() => {
    setSortBy('relevance');
    setSortOrder('desc');
    setPage(1);
    setHasMore(true);
    fetchProducts(1, { sortBy: 'relevance', sortOrder: 'desc' });
  }, [fetchProducts]);

  const resetFilters = useCallback(() => {
    setSelectedCategories([]);
    setSelectedBrands([]);
    setSearchQuery('');
    setAppliedSearchQuery('');
    setPriceRange(DEFAULT_PRICE_RANGE);
    setSortBy('relevance');
    setSortOrder('desc');
    setPage(1);
    setHasMore(true);
    fetchProducts(1, {
      categories: [],
      brands: [],
      search: '',
      priceRange: DEFAULT_PRICE_RANGE,
      sortBy: 'relevance',
      sortOrder: 'desc',
    });
  }, [fetchProducts]);

  const openFilters = useCallback(() => {
    setFilterDraft({
      categories: [...selectedCategories],
      brands: [...selectedBrands],
      priceRange: { ...priceRange },
      search: appliedSearchQuery,
      sortBy,
      sortOrder,
    });
    setShowFilters(true);
  }, [selectedCategories, selectedBrands, priceRange, appliedSearchQuery, sortBy, sortOrder]);

  const applyFilters = useCallback(() => {
    const canonicalCategories = canonicalizeCategories(filterDraft.categories);
    const appliedDraft = { ...filterDraft, categories: canonicalCategories, search: filterDraft.search.trim() };
    setSelectedCategories(canonicalCategories);
    setSelectedBrands(filterDraft.brands);
    setPriceRange(filterDraft.priceRange);
    setSearchQuery(appliedDraft.search);
    setAppliedSearchQuery(appliedDraft.search);
    setSortBy(filterDraft.sortBy);
    setSortOrder(filterDraft.sortOrder);
    setShowFilters(false);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, appliedDraft);
  }, [canonicalizeCategories, fetchProducts, filterDraft]);

  const hasActiveFilters = selectedCategories.length > 0
    || selectedBrands.length > 0
    || priceRange.min > 0
    || (priceRange.max && priceRange.max > 0)
    || sortBy !== 'relevance'
    || sortOrder !== 'desc';

  const activeFilterCount = selectedCategories.length
    + selectedBrands.length
    + ((priceRange.min > 0 || (priceRange.max && priceRange.max > 0)) ? 1 : 0)
    + ((sortBy !== 'relevance' || sortOrder !== 'desc') ? 1 : 0);

  const otherCategories = useMemo(
    () => categories.filter(category => !isPresetCategory(category)),
    [categories]
  );

  const loadNextPage = useCallback(() => {
    if (
      products.length === 0
      || !hasMore
      || loadMoreError
      || isLoading
      || baseLoadingRef.current
      || loadingMoreRef.current
    ) {
      return;
    }

    fetchProducts(page + 1, {}, { append: true });
  }, [fetchProducts, hasMore, isLoading, loadMoreError, page, products.length]);

  const retryNextPage = useCallback(() => {
    if (
      products.length === 0
      || !hasMore
      || isLoading
      || baseLoadingRef.current
      || loadingMoreRef.current
    ) {
      return;
    }

    fetchProducts(page + 1, {}, { append: true });
  }, [fetchProducts, hasMore, isLoading, page, products.length]);

  // React Native's onEndReached can be skipped on some web/Android momentum
  // combinations. This distance check is a guarded fallback; the request refs
  // above ensure both callbacks can never append the same page concurrently.
  const handleCatalogScroll = useCallback(({ nativeEvent }) => {
    const viewportHeight = nativeEvent?.layoutMeasurement?.height || 0;
    const scrollY = nativeEvent?.contentOffset?.y || 0;
    const contentHeight = nativeEvent?.contentSize?.height || 0;
    if (
      viewportHeight > 0
      && contentHeight > viewportHeight
      && viewportHeight + scrollY >= contentHeight - (viewportHeight * 0.4)
    ) {
      loadNextPage();
    }
  }, [loadNextPage]);

  // Memoized render item to prevent unnecessary re-renders
  const renderItem = useCallback(({ item, index }) => (
    <ProductCard
      product={item}
      index={index}
      onPress={() => navigation.navigate('ProductDetail', { productId: item._id })}
    />
  ), [navigation]);

  const categoryIcons = {
    'Electronics': 'phone-portrait-outline',
    'Fashion': 'shirt-outline',
    'Home & Kitchen': 'home-outline',
    'Beauty & Personal Care': 'color-palette-outline',
    'Health & Wellness': 'fitness-outline',
    'Sports & Outdoors': 'football-outline',
    'Books': 'book-outline',
    'Toys & Games': 'game-controller-outline',
    'Grocery': 'basket-outline',
    'Automotive': 'car-sport-outline',
    'Jewelry & Accessories': 'diamond-outline',
    'Pet Supplies': 'paw-outline',
    'default': 'grid-outline',
  };

  const renderHeader = () => (
    <View>
      {/* Hero Header — Glass style matching website nav */}
      <GlassPanel variant="floating" style={styles.heroHeader}>
        {Platform.OS !== 'android' && (
          <LinearGradient
            colors={HERO_SHEEN}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        )}
        <View style={styles.heroTopBar}>
          <RozareLogo width={116} height={28} />
          <View style={styles.heroTopRight}>
            <CurrencySelector />
            <TouchableOpacity
              style={styles.bellIconBtn}
              onPress={() => navigation.navigate('Notifications')}
              accessibilityLabel="Notifications"
            >
              <Ionicons name="notifications-outline" size={22} color={palette.colors.primary} />
              {unreadNotifCount > 0 && (
                <View style={styles.bellBadge}>
                  <Text style={styles.bellBadgeText}>
                    {unreadNotifCount > 9 ? '9+' : unreadNotifCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
            {!currentUser ? (
              <TouchableOpacity style={styles.loginButton} onPress={() => navigation.navigate('Login')}>
                <Ionicons name="person-outline" size={16} color={palette.colors.primary} />
                <Text style={styles.loginButtonText}>Sign In</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.cartIconBtn} onPress={() => navigation.navigate('Cart')}>
                <Ionicons name="bag-outline" size={22} color={palette.colors.primary} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Greeting */}
        <View style={styles.greetingSection}>
          <Text style={styles.greetingText}>
            {currentUser ? `Hello, ${currentUser.name?.split(' ')[0] || 'there'}!` : 'Discover Amazing Deals'}
          </Text>
          <Text style={styles.greetingSubtext}>Find the best products from verified stores</Text>
        </View>

        {/* Search Bar */}
        <View style={styles.searchContainer}>
          <View style={styles.searchInputContainer}>
            <Ionicons name="search-outline" size={20} color={palette.colors.grayLight} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search products, brands..."
              placeholderTextColor={palette.colors.grayLight}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={handleSearchFocus}
              onBlur={handleSearchBlur}
              onSubmitEditing={() => handleSearch(searchQuery)}
              returnKeyType="search"
            />
            {searchQuery.length > 0 ? (
              <TouchableOpacity onPress={() => handleSearch('')} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={20} color={palette.colors.grayLight} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={async () => {
                  const { startVoiceSearch } = await import('../utils/voiceSearch');
                  const transcript = await startVoiceSearch();
                  if (transcript) {
                    handleSearch(transcript);
                  }
                }}
                accessibilityLabel="Voice search"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="mic-outline" size={20} color={palette.colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[styles.filterButton, hasActiveFilters && styles.filterButtonActive]}
            onPress={openFilters}
            accessibilityLabel="Open product filters"
          >
            <Ionicons name="options-outline" size={22} color={hasActiveFilters ? '#fff' : palette.colors.primary} />
            {hasActiveFilters && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </GlassPanel>

      {/* Search Autocomplete Overlay */}
      <SearchAutocomplete
        visible={showAutocomplete}
        query={searchQuery}
        navigation={navigation}
        onSelectQuery={(query) => handleSearch(query)}
        onSelectProduct={(p) => {
          cancelAutocompleteBlur();
          setShowAutocomplete(false);
          navigation.navigate('ProductDetail', { productId: p._id });
        }}
        onClose={() => {
          cancelAutocompleteBlur();
          setShowAutocomplete(false);
        }}
        onInteraction={cancelAutocompleteBlur}
      />

      {/* Personalized Sliders rendered once below TrustedStores */}

      {/* Quick Stats Banner */}
      <View style={styles.statsBanner}>
        <GlassBlurFill />
        <View style={styles.statItem}>
          <Ionicons name="shield-checkmark" size={18} color={palette.colors.primary} />
          <Text style={styles.statText}>Verified</Text>
          <Text style={styles.statLabel}>Stores</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Ionicons name="flash" size={18} color={palette.colors.warning} />
          <Text style={styles.statText}>Fast</Text>
          <Text style={styles.statLabel}>Delivery</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Ionicons name="lock-closed" size={18} color={palette.colors.success} />
          <Text style={styles.statText}>Secure</Text>
          <Text style={styles.statLabel}>Payments</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Ionicons name="refresh" size={18} color={palette.colors.info} />
          <Text style={styles.statText}>Easy</Text>
          <Text style={styles.statLabel}>Returns</Text>
        </View>
      </View>

      {/* Categories */}
      {categories.length > 0 && (
        <View style={styles.categoriesSection}>
          <View style={styles.sectionHeader}>
            <View>
              <Text style={styles.sectionEyebrow}>SHOP YOUR WAY</Text>
              <Text style={styles.sectionTitle}>Browse categories</Text>
            </View>
            <TouchableOpacity style={styles.viewAllCategories} onPress={openFilters} accessibilityLabel="View all categories">
              <Text style={styles.sectionLink}>View all</Text>
              <Ionicons name="arrow-forward" size={14} color={palette.colors.primary} />
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoriesScroll}>
            <TouchableOpacity
              style={[styles.categoryCard, selectedCategories.length === 0 && styles.categoryCardActive]}
              onPress={() => applyCategorySelection([])}
              activeOpacity={0.84}
            >
              {Platform.OS === 'android' && <GlassBlurFill intensity={42} />}
              {selectedCategories.length === 0 && (
                <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} pointerEvents="none" />
              )}
              <View style={[styles.categoryIconTile, selectedCategories.length === 0 && styles.categoryIconTileActive]}>
                <Ionicons name="apps-outline" size={21} color={selectedCategories.length === 0 ? '#fff' : palette.colors.primary} />
              </View>
              <Text style={[styles.categoryCardText, selectedCategories.length === 0 && styles.categoryCardTextActive]}>Everything</Text>
              <Text style={[styles.categoryCardHint, selectedCategories.length === 0 && styles.categoryCardHintActive]}>Explore all</Text>
            </TouchableOpacity>
            {categories.map(cat => {
              const normalizedCategory = String(cat).trim().toLowerCase();
              const isActive = selectedCategories.some(item => String(item).trim().toLowerCase() === normalizedCategory);
              const nextCategories = isActive
                ? selectedCategories.filter(item => String(item).trim().toLowerCase() !== normalizedCategory)
                : [...selectedCategories, cat];
              return (
                <TouchableOpacity
                  key={cat}
                  style={[styles.categoryCard, isActive && styles.categoryCardActive]}
                  onPress={() => applyCategorySelection(nextCategories)}
                  activeOpacity={0.84}
                >
                  {Platform.OS === 'android' && <GlassBlurFill intensity={42} />}
                  {isActive && (
                    <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} pointerEvents="none" />
                  )}
                  <View style={[styles.categoryIconTile, isActive && styles.categoryIconTileActive]}>
                    <Ionicons name={categoryIcons[cat] || categoryIcons.default} size={21} color={isActive ? '#fff' : palette.colors.primary} />
                  </View>
                  <Text style={[styles.categoryCardText, isActive && styles.categoryCardTextActive]} numberOfLines={2}>{cat}</Text>
                  <View style={styles.categoryExploreRow}>
                    <Text style={[styles.categoryCardHint, isActive && styles.categoryCardHintActive]}>{isActive ? 'Selected' : 'Browse'}</Text>
                    <Ionicons name={isActive ? 'checkmark-circle' : 'arrow-forward-circle-outline'} size={13} color={isActive ? 'rgba(255,255,255,0.82)' : palette.colors.textSecondary} />
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Trusted Stores Slider */}
      <TrustedStoresSection navigation={navigation} />

      {/* Personalized Sliders (collapsible — matches website) */}
      {!hasActiveFilters && !appliedSearchQuery && (
        <PersonalizedSliders navigation={navigation} />
      )}

      {/* Browse Stores Banner — glass surface with on-brand gradient accent */}
      <TouchableOpacity style={styles.storesBanner} onPress={() => navigation.navigate('Marketplace')} activeOpacity={0.9}>
        <GlassBlurFill />
        {Platform.OS !== 'android' && (
          <LinearGradient
            colors={STORE_SHEEN}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
        )}
        <View style={styles.storesBannerContent}>
          <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.storesBannerIcon}>
            <Ionicons name="storefront" size={24} color="#fff" />
          </LinearGradient>
          <View style={styles.storesBannerText}>
            <Text style={styles.storesBannerTitle}>Explore Our Stores</Text>
            <Text style={styles.storesBannerSub}>Shop from independent stores</Text>
          </View>
        </View>
        <View style={styles.storesBannerArrow}>
          <Ionicons name="chevron-forward" size={20} color={palette.colors.primary} />
        </View>
      </TouchableOpacity>

      {/* Products Section Header */}
      <View style={styles.productsHeader}>
        <Text style={styles.productsTitle}>
          {hasActiveFilters || appliedSearchQuery ? 'Search Results' : 'All Products'}
        </Text>
        <View style={styles.productCountContainer}>
          <Text style={styles.productCount}>
            {totalProducts > 0 ? `${totalProducts} items` : `${products.length} items`}
          </Text>
        </View>
      </View>

      {/* Active Filters */}
      {hasActiveFilters && (
        <View style={styles.activeFiltersContainer}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {selectedCategories.map(cat => (
              <TouchableOpacity key={cat} style={styles.activeFilterChip} onPress={() => removeCategory(cat)}>
                <Text style={styles.activeFilterText}>{cat}</Text>
                <Ionicons name="close" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            ))}
            {selectedBrands.map(brand => (
              <TouchableOpacity key={brand} style={styles.activeFilterChip} onPress={() => removeBrand(brand)}>
                <Text style={styles.activeFilterText}>{brand === otherBrandsValue ? 'Other brands' : brand}</Text>
                <Ionicons name="close" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            ))}
            {(priceRange.min > 0 || (priceRange.max && priceRange.max > 0)) && (
              <TouchableOpacity style={styles.activeFilterChip} onPress={clearPriceFilter}>
                <Ionicons name="cash-outline" size={13} color={palette.colors.primary} />
                <Text style={styles.activeFilterText}>
                  {priceRange.min || 0}–{priceRange.max || 'Any'} {currency}
                </Text>
                <Ionicons name="close" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            )}
            {(sortBy !== 'relevance' || sortOrder !== 'desc') && (
              <TouchableOpacity style={styles.activeFilterChip} onPress={clearSort}>
                <Ionicons name="swap-vertical-outline" size={13} color={palette.colors.primary} />
                <Text style={styles.activeFilterText}>
                  {PRODUCT_SORT_OPTIONS.find(option => option.field === sortBy && option.order === sortOrder)?.label || 'Sorted'}
                </Text>
                <Ionicons name="close" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.clearFiltersButton} onPress={resetFilters}>
              <Text style={styles.clearFiltersText}>Clear All</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}
    </View>
  );

  const renderFilterModal = () => {
    const draftOtherSelected = otherCategories.length > 0
      && otherCategories.every(category => {
        const normalized = String(category).trim().toLowerCase();
        return filterDraft.categories.some(item => String(item).trim().toLowerCase() === normalized);
      });
    const draftFilterCount = filterDraft.categories.length
      + filterDraft.brands.length
      + ((filterDraft.priceRange.min > 0 || (filterDraft.priceRange.max && filterDraft.priceRange.max > 0)) ? 1 : 0)
      + ((filterDraft.sortBy !== 'relevance' || filterDraft.sortOrder !== 'desc') ? 1 : 0);

    const toggleDraftCategory = (category) => {
      const canonical = canonicalizeCategories([category])[0] || category;
      const normalized = String(canonical).trim().toLowerCase();
      setFilterDraft(previous => {
        const exists = previous.categories.some(item => String(item).trim().toLowerCase() === normalized);
        return {
          ...previous,
          categories: exists
            ? previous.categories.filter(item => String(item).trim().toLowerCase() !== normalized)
            : canonicalizeCategories([...previous.categories, canonical]),
        };
      });
    };

    const toggleDraftBrand = (brand) => {
      setFilterDraft(previous => ({
        ...previous,
        brands: previous.brands.includes(brand)
          ? previous.brands.filter(item => item !== brand)
          : [...previous.brands, brand],
      }));
    };

    const toggleOtherCategories = () => {
      setFilterDraft(previous => {
        const presetOnly = previous.categories.filter(isPresetCategory);
        return {
          ...previous,
          categories: canonicalizeCategories(draftOtherSelected ? presetOnly : [...presetOnly, ...otherCategories]),
        };
      });
    };

    return (
      <Modal
        visible={showFilters}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={() => setShowFilters(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdropPress}
            onPress={() => setShowFilters(false)}
            activeOpacity={1}
            accessibilityLabel="Close filters"
          />
          <GlassPanel variant="strong" style={styles.modalContent}>
            <LinearGradient
              colors={HERO_SHEEN}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <View style={styles.modalHandle} />

            <View style={styles.modalHeader}>
              <View style={styles.modalTitleGroup}>
                <LinearGradient colors={palette.gradients.cta} style={styles.modalIconTile}>
                  <Ionicons name="options" size={19} color="#fff" />
                </LinearGradient>
                <View>
                  <View style={styles.modalTitleRow}>
                    <Text style={styles.modalTitle}>Refine your discovery</Text>
                    {draftFilterCount > 0 && (
                      <View style={styles.modalCountBadge}>
                        <Text style={styles.modalCountBadgeText}>{draftFilterCount}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.modalSubtitle}>Search, sort and narrow the catalog</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => setShowFilters(false)}
                style={styles.modalCloseButton}
                accessibilityLabel="Close filters"
                hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
              >
                <Ionicons name="close" size={20} color={palette.colors.text} />
              </TouchableOpacity>
            </View>

            <KeyboardAwareFormScrollView
              style={styles.modalBody}
              contentContainerStyle={styles.modalBodyContent}
              showsVerticalScrollIndicator={false}
              bottomOffset={32}
            >
              <View style={styles.sheetSearchBox}>
                <Ionicons name="search-outline" size={19} color={palette.colors.primary} />
                <TextInput
                  value={filterDraft.search}
                  onChangeText={(search) => setFilterDraft(previous => ({ ...previous, search }))}
                  placeholder="Search products, brands and categories"
                  placeholderTextColor={palette.colors.textLight}
                  style={styles.sheetSearchInput}
                  returnKeyType="done"
                />
                {!!filterDraft.search && (
                  <TouchableOpacity
                    onPress={() => setFilterDraft(previous => ({ ...previous, search: '' }))}
                    accessibilityLabel="Clear filter search"
                  >
                    <Ionicons name="close-circle" size={19} color={palette.colors.textSecondary} />
                  </TouchableOpacity>
                )}
              </View>

              <View style={styles.filterSection}>
                <View style={styles.filterSectionHeader}>
                  <View style={styles.filterSectionIcon}>
                    <Ionicons name="swap-vertical-outline" size={17} color={palette.colors.primary} />
                  </View>
                  <View>
                    <Text style={styles.filterSectionTitle}>SORT BY</Text>
                    <Text style={styles.filterSectionHint}>Choose how products are ordered</Text>
                  </View>
                </View>
                <View style={styles.sortGrid}>
                  {PRODUCT_SORT_OPTIONS.map(option => {
                    const active = filterDraft.sortBy === option.field && filterDraft.sortOrder === option.order;
                    return (
                      <TouchableOpacity
                        key={option.key}
                        style={[styles.sortTile, active && styles.sortTileActive]}
                        onPress={() => setFilterDraft(previous => ({
                          ...previous,
                          sortBy: option.field,
                          sortOrder: option.order,
                        }))}
                        activeOpacity={0.84}
                      >
                        <View style={[styles.sortIconTile, active && styles.sortIconTileActive]}>
                          <Ionicons name={option.icon} size={16} color={active ? '#fff' : palette.colors.primary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.sortTileTitle, active && styles.sortTileTitleActive]}>{option.label}</Text>
                          <Text style={[styles.sortTileHelper, active && styles.sortTileHelperActive]}>{option.helper}</Text>
                        </View>
                        {active && <Ionicons name="checkmark-circle" size={17} color="#fff" />}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.filterSection}>
                <View style={styles.filterSectionHeader}>
                  <View style={styles.filterSectionIcon}>
                    <Ionicons name="grid-outline" size={17} color={palette.colors.primary} />
                  </View>
                  <View>
                    <Text style={styles.filterSectionTitle}>CATEGORIES</Text>
                    <Text style={styles.filterSectionHint}>Select one or more departments</Text>
                  </View>
                </View>
                <View style={styles.filterOptionsGrid}>
                  {PRESET_CATEGORIES.map(category => {
                    const active = filterDraft.categories.some(item => item.toLowerCase() === category.toLowerCase());
                    return (
                      <TouchableOpacity
                        key={category}
                        style={[styles.filterChip, active && styles.filterChipSelected]}
                        onPress={() => toggleDraftCategory(category)}
                        activeOpacity={0.82}
                      >
                        <Ionicons
                          name={categoryIcons[category] || categoryIcons.default}
                          size={15}
                          color={active ? '#fff' : palette.colors.primary}
                        />
                        <Text style={[styles.filterChipText, active && styles.filterChipTextSelected]} numberOfLines={1}>
                          {category}
                        </Text>
                        {active && <Ionicons name="checkmark" size={13} color="#fff" />}
                      </TouchableOpacity>
                    );
                  })}
                  {otherCategories.length > 0 && (
                    <TouchableOpacity
                      style={[styles.filterChip, draftOtherSelected && styles.filterChipSelected]}
                      onPress={toggleOtherCategories}
                      activeOpacity={0.82}
                    >
                      <Ionicons name="ellipsis-horizontal" size={15} color={draftOtherSelected ? '#fff' : palette.colors.primary} />
                      <Text style={[styles.filterChipText, draftOtherSelected && styles.filterChipTextSelected]}>Other</Text>
                      <View style={[styles.optionCount, draftOtherSelected && styles.optionCountActive]}>
                        <Text style={[styles.optionCountText, draftOtherSelected && styles.optionCountTextActive]}>{otherCategories.length}</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              <View style={styles.filterSection}>
                <View style={styles.filterSectionHeader}>
                  <View style={styles.filterSectionIcon}>
                    <Ionicons name="pricetag-outline" size={17} color={palette.colors.info} />
                  </View>
                  <View>
                    <Text style={styles.filterSectionTitle}>BRANDS</Text>
                    <Text style={styles.filterSectionHint}>Shop names you already trust</Text>
                  </View>
                </View>
                {brands.length === 0 && !otherBrandsCount ? (
                  <View style={styles.noFilterBox}>
                    <Ionicons name="information-circle-outline" size={18} color={palette.colors.textSecondary} />
                    <Text style={styles.noFilterText}>No brand filters are available yet</Text>
                  </View>
                ) : (
                  <View style={styles.filterOptionsGrid}>
                    {brands.map(brand => {
                      const active = filterDraft.brands.includes(brand);
                      return (
                        <TouchableOpacity
                          key={brand}
                          style={[styles.filterChip, active && styles.filterChipSelectedBlue]}
                          onPress={() => toggleDraftBrand(brand)}
                          activeOpacity={0.82}
                        >
                          <Ionicons name="ribbon-outline" size={15} color={active ? '#fff' : palette.colors.info} />
                          <Text style={[styles.filterChipText, active && styles.filterChipTextSelected]} numberOfLines={1}>{brand}</Text>
                          {active && <Ionicons name="checkmark" size={13} color="#fff" />}
                        </TouchableOpacity>
                      );
                    })}
                    {otherBrandsCount > 0 && (
                      <TouchableOpacity
                        style={[styles.filterChip, filterDraft.brands.includes(otherBrandsValue) && styles.filterChipSelectedBlue]}
                        onPress={() => toggleDraftBrand(otherBrandsValue)}
                        activeOpacity={0.82}
                      >
                        <Ionicons name="layers-outline" size={15} color={filterDraft.brands.includes(otherBrandsValue) ? '#fff' : palette.colors.info} />
                        <Text style={[styles.filterChipText, filterDraft.brands.includes(otherBrandsValue) && styles.filterChipTextSelected]}>Other brands</Text>
                        <View style={[styles.optionCount, filterDraft.brands.includes(otherBrandsValue) && styles.optionCountActive]}>
                          <Text style={[styles.optionCountText, filterDraft.brands.includes(otherBrandsValue) && styles.optionCountTextActive]}>{otherBrandsCount}</Text>
                        </View>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>

              <View style={styles.filterSection}>
                <View style={styles.filterSectionHeader}>
                  <View style={styles.filterSectionIcon}>
                    <Ionicons name="cash-outline" size={17} color={palette.colors.success} />
                  </View>
                  <View>
                    <Text style={styles.filterSectionTitle}>PRICE RANGE</Text>
                    <Text style={styles.filterSectionHint}>Prices are filtered in {currency}</Text>
                  </View>
                </View>
                <PriceRangeFilter
                  min={filterDraft.priceRange.min}
                  max={filterDraft.priceRange.max}
                  onChange={(range) => setFilterDraft(previous => ({ ...previous, priceRange: range }))}
                />
              </View>
            </KeyboardAwareFormScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.resetButton}
                onPress={() => setFilterDraft({
                  categories: [],
                  brands: [],
                  priceRange: DEFAULT_PRICE_RANGE,
                  search: '',
                  sortBy: 'relevance',
                  sortOrder: 'desc',
                })}
                accessibilityLabel="Reset filters"
                activeOpacity={0.84}
              >
                <Ionicons name="refresh" size={17} color={palette.colors.text} />
                <Text style={styles.resetButtonText}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.applyButton}
                onPress={applyFilters}
                accessibilityLabel="Apply filters"
                activeOpacity={0.86}
              >
                <LinearGradient colors={palette.gradients.cta} style={StyleSheet.absoluteFill} pointerEvents="none" />
                <Text style={styles.applyButtonText}>Show products</Text>
                <Ionicons name="arrow-forward" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          </GlassPanel>
        </View>
      </Modal>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconContainer}>
        <Ionicons name={loadError ? 'cloud-offline-outline' : 'cube-outline'} size={64} color={palette.colors.grayLight} />
      </View>
      <Text style={styles.emptyTitle}>{loadError ? "Couldn't load products" : 'No products found'}</Text>
      <Text style={styles.emptySubtitle}>
        {loadError
          ? 'Check your connection and try again'
          : hasActiveFilters || appliedSearchQuery
            ? 'Try adjusting your filters or search query'
            : 'Check back later for new products'
        }
      </Text>
      {loadError ? (
        <TouchableOpacity
          style={styles.emptyActionButton}
          onPress={() => {
            setHasMore(true);
            fetchProducts(1);
          }}
        >
          <Ionicons name="refresh" size={18} color={palette.colors.white} />
          <Text style={styles.emptyActionText}>Retry</Text>
        </TouchableOpacity>
      ) : (hasActiveFilters || appliedSearchQuery) && (
        <TouchableOpacity
          style={styles.emptyActionButton}
          onPress={() => {
            resetFilters();
          }}
        >
          <Ionicons name="refresh" size={18} color={palette.colors.white} />
          <Text style={styles.emptyActionText}>Clear Filters</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const renderFooter = () => {
    if (isLoading || products.length === 0) return null;

    if (isLoadingMore) {
      return (
        <View style={styles.loadMoreSkeleton} accessibilityLabel="Loading more products">
          <View style={styles.loadMoreSkeletonCell}><ProductCardSkeleton /></View>
          <View style={styles.loadMoreSkeletonCell}><ProductCardSkeleton /></View>
        </View>
      );
    }

    if (loadMoreError) {
      return (
        <TouchableOpacity
          style={styles.loadMoreRetry}
          onPress={retryNextPage}
          accessibilityRole="button"
          accessibilityLabel="Retry loading more products"
          activeOpacity={0.82}
        >
          <GlassBlurFill intensity={34} />
          <View style={styles.loadMoreRetryIcon}>
            <Ionicons name="refresh" size={17} color={palette.colors.primary} />
          </View>
          <View style={styles.loadMoreRetryCopy}>
            <Text style={styles.loadMoreRetryTitle}>Keep exploring</Text>
            <Text style={styles.loadMoreRetryText}>Tap to retry loading more products</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={palette.colors.primary} />
        </TouchableOpacity>
      );
    }

    if (!hasMore && products.length > LIMIT) {
      return (
        <View style={styles.catalogEnd}>
          <Ionicons name="checkmark-circle-outline" size={16} color={palette.colors.success} />
          <Text style={styles.catalogEndText}>You’ve seen all {totalProducts || products.length} products</Text>
        </View>
      );
    }

    return null;
  };

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={Platform.OS === 'android' ? [] : ['top']}>
      <FlatList
        data={isLoading ? [] : products}
        keyExtractor={(item) => item._id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={renderHeader()}
        renderItem={renderItem}
        ListFooterComponent={renderFooter()}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[palette.colors.primary]}
            tintColor={palette.colors.primary}
          />
        }
        ListEmptyComponent={isLoading ? <HomeCatalogSkeleton count={6} /> : renderEmptyState()}
        onEndReached={loadNextPage}
        onEndReachedThreshold={0.45}
        onScroll={handleCatalogScroll}
        scrollEventThrottle={200}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={true}
      />
      {renderFilterModal()}

      {/* AI FAB — matches website chat launcher */}
      <AIChatFab onPress={() => navigation.navigate('AIChat', { role: 'user' })} />
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  // Hero Header — Floating Glass card matching website navbar
  heroHeader: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: 26,
    ...shadows.lg,
  },
  heroTopBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: spacing.md },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoIconWrap: { width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center' },
  logoText: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  heroTopRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 0 },
  loginButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgStrong, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, gap: spacing.xs, borderWidth: 1, borderColor: p.glass.borderStrong },
  loginButtonText: { color: p.colors.primary, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  cartIconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgStrong, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: p.glass.borderStrong },
  bellIconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgStrong, justifyContent: 'center', alignItems: 'center', position: 'relative', borderWidth: 1, borderColor: p.glass.borderStrong },
  bellBadge: { position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: p.colors.error, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: p.colors.white },
  bellBadgeText: { color: p.colors.white, fontSize: 10, fontWeight: fontWeight.bold },
  greetingSection: { paddingBottom: spacing.md },
  greetingText: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: p.colors.text, marginBottom: spacing.xs, letterSpacing: -0.5 },
  greetingSubtext: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  // Search
  searchContainer: { flexDirection: 'row', gap: spacing.sm },
  searchInputContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: borderRadius.full, paddingHorizontal: spacing.md, height: 48, gap: spacing.sm, borderWidth: 1, borderColor: p.glass.borderSubtle },
  searchInput: { flex: 1, fontSize: fontSize.md, color: p.colors.text },
  filterButton: { backgroundColor: p.glass.bgSubtle, width: 48, height: 48, borderRadius: borderRadius.full, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: p.glass.borderSubtle },
  filterButtonActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  filterBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: p.colors.error, width: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center' },
  filterBadgeText: { color: p.colors.white, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  // Stats banner — glass
  statsBanner: { flexDirection: 'row', backgroundColor: p.glass.bg, marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: borderRadius.xl, padding: spacing.md, borderWidth: 1, borderColor: p.glass.border, ...shadows.sm, elevation: Platform.OS === 'android' ? 0 : shadows.sm.elevation, justifyContent: 'space-around', overflow: 'hidden' },
  statItem: { alignItems: 'center', flex: 1, gap: 2 },
  statText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.dark },
  statLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  statDivider: { width: 1, backgroundColor: p.colors.light },
  // Categories
  categoriesSection: { paddingTop: spacing.lg, paddingBottom: spacing.md, marginTop: spacing.sm },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  sectionEyebrow: { fontSize: 10, fontWeight: fontWeight.bold, color: p.colors.primary, letterSpacing: 1.2, marginBottom: 3 },
  sectionTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold, color: p.colors.dark, letterSpacing: -0.25 },
  sectionLink: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  viewAllCategories: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm },
  categoriesScroll: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  categoryCard: { width: 124, minHeight: 112, padding: spacing.md, borderRadius: 22, overflow: 'hidden', backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.border, ...shadows.sm, elevation: Platform.OS === 'android' ? 0 : shadows.sm.elevation },
  categoryCardActive: { borderColor: 'rgba(255,255,255,0.48)', shadowColor: '#0EA5E9', shadowOpacity: 0.24, shadowRadius: 12, elevation: 5 },
  categoryIconTile: { width: 38, height: 38, borderRadius: 13, backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  categoryIconTileActive: { backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.26)' },
  categoryCardText: { minHeight: 34, fontSize: fontSize.sm, lineHeight: 17, color: p.colors.text, fontWeight: fontWeight.bold },
  categoryCardTextActive: { color: '#fff' },
  categoryExploreRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  categoryCardHint: { fontSize: 10, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  categoryCardHintActive: { color: 'rgba(255,255,255,0.78)' },
  // Stores Banner — glass surface, brand-gradient icon tile
  storesBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: spacing.lg, marginVertical: spacing.lg, borderRadius: borderRadius.xxl, paddingVertical: spacing.md, paddingHorizontal: spacing.md, overflow: 'hidden', backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.border, ...shadows.md, elevation: Platform.OS === 'android' ? 0 : shadows.md.elevation },
  storesBannerContent: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1, minWidth: 0 },
  storesBannerIcon: { width: 48, height: 48, borderRadius: borderRadius.lg, justifyContent: 'center', alignItems: 'center', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10, elevation: 5 },
  storesBannerText: { flex: 1, minWidth: 0 },
  storesBannerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.text },
  storesBannerSub: { fontSize: fontSize.sm, color: p.colors.textSecondary },
  storesBannerArrow: { width: 34, height: 34, borderRadius: 17, backgroundColor: p.glass.bgStrong, borderWidth: 1, borderColor: p.glass.border, justifyContent: 'center', alignItems: 'center', marginLeft: spacing.sm },
  // Products section
  productsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  productsTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.dark },
  productCountContainer: { backgroundColor: p.colors.primarySubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  productCount: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  // Active filters
  activeFiltersContainer: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  activeFilterChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.colors.primaryLighter, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, marginRight: spacing.sm, gap: spacing.xs },
  activeFilterText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.medium },
  clearFiltersButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, justifyContent: 'center' },
  clearFiltersText: { fontSize: fontSize.sm, color: p.colors.error, fontWeight: fontWeight.semibold },
  // List
  // Bottom padding clears the absolute-positioned glass tab bar
  listContent: { paddingBottom: 110 },
  // Symmetric gutters: 2 × CARD_WIDTH + spacing.sm gap + 2 × spacing.lg = screen width
  row: { paddingHorizontal: spacing.lg, justifyContent: 'space-between' },
  // Empty state
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60, paddingHorizontal: spacing.xl },
  emptyIconContainer: { width: 100, height: 100, borderRadius: 50, backgroundColor: p.colors.light, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.dark, marginBottom: spacing.sm },
  emptySubtitle: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  emptyActionButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, marginTop: spacing.xl, gap: spacing.sm },
  emptyActionText: { color: p.colors.white, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  // Premium product filter sheet
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.48)', justifyContent: 'flex-end' },
  modalBackdropPress: { flex: 1 },
  modalContent: { padding: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderTopLeftRadius: 30, borderTopRightRadius: 30, maxHeight: '92%', backgroundColor: p.glass.bgStrong, borderColor: p.glass.borderStrong },
  modalHandle: { width: 42, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: spacing.sm, backgroundColor: p.glass.borderStrong },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: p.glass.borderSubtle },
  modalTitleGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1, minWidth: 0 },
  modalIconTile: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  modalTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  modalTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: p.colors.text, letterSpacing: -0.2 },
  modalSubtitle: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  modalCountBadge: { minWidth: 21, height: 21, borderRadius: 11, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  modalCountBadgeText: { fontSize: 10, color: p.colors.primary, fontWeight: fontWeight.bold },
  modalCloseButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, justifyContent: 'center', alignItems: 'center' },
  modalBody: { flexGrow: 0 },
  modalBodyContent: { padding: spacing.lg, paddingBottom: spacing.sm },
  sheetSearchBox: { height: 50, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, borderRadius: borderRadius.xl, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.border, marginBottom: spacing.lg },
  sheetSearchInput: { flex: 1, fontSize: fontSize.md, color: p.colors.text },
  filterSection: { marginBottom: spacing.xl },
  filterSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  filterSectionIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  filterSectionTitle: { fontSize: 11, fontWeight: fontWeight.bold, color: p.colors.text, letterSpacing: 1 },
  filterSectionHint: { fontSize: 11, color: p.colors.textSecondary, marginTop: 2 },
  sortGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sortTile: { minWidth: '47%', flex: 1, minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  sortTileActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  sortIconTile: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  sortIconTileActive: { backgroundColor: 'rgba(255,255,255,0.17)' },
  sortTileTitle: { fontSize: fontSize.xs, color: p.colors.text, fontWeight: fontWeight.bold },
  sortTileTitleActive: { color: '#fff' },
  sortTileHelper: { fontSize: 9, color: p.colors.textSecondary, marginTop: 2 },
  sortTileHelperActive: { color: 'rgba(255,255,255,0.72)' },
  filterOptionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filterChip: { minHeight: 42, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, borderWidth: 1, borderColor: p.glass.borderSubtle, gap: spacing.xs },
  filterChipSelected: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  filterChipSelectedBlue: { backgroundColor: p.colors.info, borderColor: p.colors.info },
  filterChipText: { maxWidth: 220, fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.medium },
  filterChipTextSelected: { color: '#fff', fontWeight: fontWeight.semibold },
  optionCount: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle },
  optionCountActive: { backgroundColor: 'rgba(255,255,255,0.2)' },
  optionCountText: { fontSize: 9, color: p.colors.primary, fontWeight: fontWeight.bold },
  optionCountTextActive: { color: '#fff' },
  noFilterBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: borderRadius.lg, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  noFilterText: { flex: 1, fontSize: fontSize.sm, color: p.colors.textSecondary },
  modalFooter: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.lg, gap: spacing.md, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  resetButton: { minWidth: 104, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm },
  resetButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  applyButton: { flex: 1, minHeight: 50, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm, ...shadows.md },
  applyButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: '#fff' },
  // Continuous catalog loading keeps each network/render batch bounded.
  loadMoreSkeleton: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  loadMoreSkeletonCell: { flex: 1, minWidth: 0 },
  loadMoreRetry: { marginHorizontal: spacing.lg, marginTop: spacing.md, minHeight: 64, overflow: 'hidden', flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: borderRadius.xl, backgroundColor: p.glass.bg, borderWidth: 1, borderColor: p.glass.border },
  loadMoreRetryIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primarySubtle, borderWidth: 1, borderColor: p.colors.primaryLighter },
  loadMoreRetryCopy: { flex: 1, minWidth: 0 },
  loadMoreRetryTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text },
  loadMoreRetryText: { marginTop: 2, fontSize: fontSize.xs, color: p.colors.textSecondary },
  catalogEnd: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  catalogEndText: { fontSize: fontSize.xs, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
});
