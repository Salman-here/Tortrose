/**
 * HomeScreen
 * Modern home screen with product browsing, search, and filters
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.6, 6.7, 6.8
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Modal,
  ScrollView,
  Animated,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import ChatBot from '../components/ChatBot';
import api from '../config/api';
import ProductCard from '../components/ProductCard';
import CurrencySelector from '../components/CurrencySelector';
import { Loader, EmptySearch, ProductGridSkeleton, PersonalizedSliders, SearchAutocomplete, PriceRangeFilter, TrustedStoresSection } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import GlassBlurFill from '../components/common/GlassBlurFill';
import AIChatFab from '../components/common/AIChatFab';
import { addSearchHistory } from '../utils/searchHistory';
import RozareLogo from '../components/common/RozareLogo';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { spacing, fontSize, borderRadius, shadows, fontWeight, typography } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function HomeScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser } = useAuth();
  const { fetchCart, unreadNotifCount } = useGlobal();
  const { currency } = useCurrency();
  const [showAI, setShowAI] = useState(false);
  
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [totalProducts, setTotalProducts] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedBrands, setSelectedBrands] = useState([]);
  const [priceRange, setPriceRange] = useState({ min: 0, max: null });
  const [showAutocomplete, setShowAutocomplete] = useState(false);

  // Animation for header — use ref to avoid re-creating on every render
  const scrollY = useRef(new Animated.Value(0)).current;

  const LIMIT = 12;

  const fetchProducts = useCallback(async (pageNum = 1, append = false) => {
    if (append) setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (selectedCategories.length > 0) {
        selectedCategories.forEach(cat => params.append('categories', cat));
      }
      if (selectedBrands.length > 0) {
        selectedBrands.forEach(brand => params.append('brands', brand));
      }
      if (searchQuery) {
        params.append('search', searchQuery);
      }
      if (priceRange.min > 0 || (priceRange.max && priceRange.max > 0)) {
        params.append('priceRange', `${priceRange.min || 0},${priceRange.max || ''}`);
      }
      params.append('currency', currency);
      params.append('page', pageNum);
      params.append('limit', LIMIT);

      const res = await api.get(`/api/products/get-products?${params.toString()}`);
      const newProducts = res.data.products || [];
      const paginationInfo = res.data.pagination;

      if (append) {
        // Dedupe across pages to avoid React duplicate-key warnings when the
        // backend pagination window overlaps (e.g. a product shifts between pages).
        setProducts(prev => {
          const seen = new Set(prev.map(p => p._id));
          const additions = newProducts.filter(p => p?._id && !seen.has(p._id));
          return [...prev, ...additions];
        });
      } else {
        // Dedupe on initial fetch too (defensive).
        const seen = new Set();
        const unique = newProducts.filter(p => {
          if (!p?._id || seen.has(p._id)) return false;
          seen.add(p._id);
          return true;
        });
        setProducts(unique);
      }

      if (paginationInfo) {
        setHasMore(paginationInfo.hasMore);
        setTotalProducts(paginationInfo.totalProducts);
        setPage(pageNum);
      } else {
        // Legacy fallback: if backend doesn't return pagination info
        setHasMore(newProducts.length === LIMIT);
        setPage(pageNum);
      }
      setLoadError(false);
    } catch (error) {
      console.error('Error fetching products:', error);
      // Stop infinite-scroll retries until the user explicitly refreshes,
      // otherwise a failing request re-triggers onEndReached forever.
      setHasMore(false);
      setLoadError(true);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [selectedCategories, selectedBrands, searchQuery, priceRange.min, priceRange.max, currency]);

  const fetchFilters = async () => {
    try {
      const res = await api.get('/api/products/get-filters');
      setCategories(res.data.categories || []);
      setBrands(res.data.brands || []);
    } catch (error) {
      console.error('Error fetching filters:', error);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, false);
  }, [fetchProducts]);

  const onEndReached = useCallback(() => {
    if (!loadingMore && !isLoading && hasMore && products.length > 0) {
      fetchProducts(page + 1, true);
    }
  }, [loadingMore, isLoading, hasMore, page, products.length, fetchProducts]);

  // Initial load and when currentUser changes
  useEffect(() => {
    setPage(1);
    setHasMore(true);
    fetchProducts(1, false);
    fetchFilters();
    if (currentUser) {
      fetchCart();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  const handleSearch = useCallback(() => {
    setIsLoading(true);
    setPage(1);
    setHasMore(true);
    setShowAutocomplete(false);
    if (searchQuery && searchQuery.trim().length >= 2) {
      addSearchHistory(searchQuery.trim());
    }
    fetchProducts(1, false);
  }, [fetchProducts, searchQuery]);

  const toggleCategory = (category) => {
    setSelectedCategories(prev =>
      prev.includes(category) ? prev.filter(c => c !== category) : [...prev, category]
    );
  };

  const toggleBrand = (brand) => {
    setSelectedBrands(prev =>
      prev.includes(brand) ? prev.filter(b => b !== brand) : [...prev, brand]
    );
  };

  const resetFilters = () => {
    setSelectedCategories([]);
    setSelectedBrands([]);
    setSearchQuery('');
    setPriceRange({ min: 0, max: null });
  };

  const applyFilters = () => {
    setShowFilters(false);
    setIsLoading(true);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, false);
  };

  const hasActiveFilters = selectedCategories.length > 0 || selectedBrands.length > 0 || priceRange.min > 0 || (priceRange.max && priceRange.max > 0);

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
    'Beauty': 'color-palette-outline',
    'Home': 'home-outline',
    'Sports': 'football-outline',
    'Books': 'book-outline',
    'Toys': 'game-controller-outline',
    'Food': 'restaurant-outline',
    'default': 'grid-outline',
  };

  const renderHeader = () => (
    <View>
      {/* Hero Header — Glass style matching website nav */}
      <GlassPanel variant="floating" style={styles.heroHeader}>
        <View style={styles.heroTopBar}>
          <RozareLogo width={104} height={24} />
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
              onFocus={() => setShowAutocomplete(true)}
              onBlur={() => setTimeout(() => setShowAutocomplete(false), 180)}
              onSubmitEditing={handleSearch}
              returnKeyType="search"
            />
            {searchQuery.length > 0 ? (
              <TouchableOpacity onPress={() => { setSearchQuery(''); handleSearch(); }} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={20} color={palette.colors.grayLight} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={async () => {
                  const { startVoiceSearch } = await import('../utils/voiceSearch');
                  const transcript = await startVoiceSearch();
                  if (transcript) {
                    setSearchQuery(transcript);
                    setTimeout(() => handleSearch(), 50);
                  }
                }}
                accessibilityLabel="Voice search"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="mic-outline" size={20} color={palette.colors.primary} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity style={[styles.filterButton, hasActiveFilters && styles.filterButtonActive]} onPress={() => setShowFilters(true)}>
            <Ionicons name="options-outline" size={22} color={palette.colors.primary} />
            {hasActiveFilters && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{selectedCategories.length + selectedBrands.length}</Text>
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
        onSelectQuery={(q) => { setSearchQuery(q); setShowAutocomplete(false); setTimeout(() => handleSearch(), 50); }}
        onSelectProduct={(p) => { setShowAutocomplete(false); navigation.navigate('ProductDetail', { productId: p._id }); }}
        onClose={() => setShowAutocomplete(false)}
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
            <Text style={styles.sectionTitle}>Categories</Text>
            <TouchableOpacity onPress={() => setShowFilters(true)}>
              <Text style={styles.sectionLink}>View All</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoriesScroll}>
            <TouchableOpacity
              style={[styles.categoryChip, selectedCategories.length === 0 && styles.categoryChipActive]}
              onPress={() => { setSelectedCategories([]); applyFilters(); }}
            >
              <Ionicons name="apps-outline" size={16} color={selectedCategories.length === 0 ? palette.colors.white : palette.colors.primary} />
              <Text style={[styles.categoryChipText, selectedCategories.length === 0 && styles.categoryChipTextActive]}>All</Text>
            </TouchableOpacity>
            {categories.map(cat => {
              const isActive = selectedCategories.includes(cat);
              return (
                <TouchableOpacity key={cat} style={[styles.categoryChip, isActive && styles.categoryChipActive]} onPress={() => { toggleCategory(cat); applyFilters(); }}>
                  <Ionicons name={categoryIcons[cat] || categoryIcons.default} size={16} color={isActive ? palette.colors.white : palette.colors.primary} />
                  <Text style={[styles.categoryChipText, isActive && styles.categoryChipTextActive]}>{cat}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Trusted Stores Slider */}
      <TrustedStoresSection navigation={navigation} />

      {/* Personalized Sliders (collapsible — matches website) */}
      {!hasActiveFilters && !searchQuery && (
        <PersonalizedSliders navigation={navigation} />
      )}

      {/* Browse Stores Banner */}
      <TouchableOpacity style={styles.storesBanner} onPress={() => navigation.navigate('Marketplace')} activeOpacity={0.9}>
        <View style={styles.storesBannerContent}>
          <View style={styles.storesBannerIcon}><Ionicons name="storefront-outline" size={28} color={palette.colors.white} /></View>
          <View style={styles.storesBannerText}>
            <Text style={styles.storesBannerTitle}>Explore Our Stores</Text>
            <Text style={styles.storesBannerSub}>Shop from independent stores</Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={22} color={palette.colors.white} />
      </TouchableOpacity>

      {/* Products Section Header */}
      <View style={styles.productsHeader}>
        <Text style={styles.productsTitle}>
          {hasActiveFilters || searchQuery ? 'Search Results' : 'All Products'}
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
              <TouchableOpacity key={cat} style={styles.activeFilterChip} onPress={() => toggleCategory(cat)}>
                <Text style={styles.activeFilterText}>{cat}</Text>
                <Ionicons name="close" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            ))}
            {selectedBrands.map(brand => (
              <TouchableOpacity key={brand} style={styles.activeFilterChip} onPress={() => toggleBrand(brand)}>
                <Text style={styles.activeFilterText}>{brand}</Text>
                <Ionicons name="close" size={14} color={palette.colors.primary} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.clearFiltersButton} onPress={resetFilters}>
              <Text style={styles.clearFiltersText}>Clear All</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}
    </View>
  );

  const renderFilterModal = () => (
    <Modal 
      visible={showFilters} 
      animationType="slide" 
      transparent={true} 
      onRequestClose={() => setShowFilters(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          {/* Modal Header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Filters</Text>
            <TouchableOpacity 
              onPress={() => setShowFilters(false)}
              style={styles.modalCloseButton}
              accessibilityLabel="Close filters"
            >
              <Ionicons name="close" size={24} color={palette.colors.dark} />
            </TouchableOpacity>
          </View>

          {/* Modal Body */}
          <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
            {/* Price Range Section */}
            <View style={styles.filterSection}>
              <View style={styles.filterSectionHeader}>
                <Ionicons name="cash-outline" size={18} color={palette.colors.success} />
                <Text style={styles.filterSectionTitle}>PRICE RANGE</Text>
              </View>
              <PriceRangeFilter
                min={priceRange.min}
                max={priceRange.max}
                onChange={(range) => setPriceRange(range)}
              />
            </View>

            {/* Categories Section */}
            <View style={styles.filterSection}>
              <View style={styles.filterSectionHeader}>
                <Ionicons name="grid-outline" size={18} color={palette.colors.primary} />
                <Text style={styles.filterSectionTitle}>CATEGORIES</Text>
              </View>
              {categories.length === 0 ? (
                <Text style={styles.noFilterText}>No categories available</Text>
              ) : (
                <View style={styles.filterOptionsGrid}>
                  {categories.map(category => (
                    <TouchableOpacity 
                      key={category} 
                      style={[
                        styles.filterChip,
                        selectedCategories.includes(category) && styles.filterChipSelected
                      ]} 
                      onPress={() => toggleCategory(category)}
                    >
                      <Text style={[
                        styles.filterChipText,
                        selectedCategories.includes(category) && styles.filterChipTextSelected
                      ]}>
                        {category}
                      </Text>
                      {selectedCategories.includes(category) && (
                        <Ionicons name="checkmark" size={14} color={palette.colors.white} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Brands Section */}
            <View style={styles.filterSection}>
              <View style={styles.filterSectionHeader}>
                <Ionicons name="pricetag-outline" size={18} color={palette.colors.secondary} />
                <Text style={styles.filterSectionTitle}>BRANDS</Text>
              </View>
              {brands.length === 0 ? (
                <Text style={styles.noFilterText}>No brands available</Text>
              ) : (
                <View style={styles.filterOptionsGrid}>
                  {brands.map(brand => (
                    <TouchableOpacity 
                      key={brand} 
                      style={[
                        styles.filterChip,
                        selectedBrands.includes(brand) && styles.filterChipSelected
                      ]} 
                      onPress={() => toggleBrand(brand)}
                    >
                      <Text style={[
                        styles.filterChipText,
                        selectedBrands.includes(brand) && styles.filterChipTextSelected
                      ]}>
                        {brand}
                      </Text>
                      {selectedBrands.includes(brand) && (
                        <Ionicons name="checkmark" size={14} color={palette.colors.white} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          </ScrollView>

          {/* Modal Footer */}
          <View style={styles.modalFooter}>
            <TouchableOpacity 
              style={styles.resetButton} 
              onPress={resetFilters}
              accessibilityLabel="Reset filters"
            >
              <Ionicons name="refresh" size={18} color={palette.colors.text} />
              <Text style={styles.resetButtonText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.applyButton} 
              onPress={applyFilters}
              accessibilityLabel="Apply filters"
            >
              <Text style={styles.applyButtonText}>Apply Filters</Text>
              <Ionicons name="checkmark" size={18} color={palette.colors.white} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconContainer}>
        <Ionicons name={loadError ? 'cloud-offline-outline' : 'cube-outline'} size={64} color={palette.colors.grayLight} />
      </View>
      <Text style={styles.emptyTitle}>{loadError ? "Couldn't load products" : 'No products found'}</Text>
      <Text style={styles.emptySubtitle}>
        {loadError
          ? 'Check your connection and try again'
          : hasActiveFilters || searchQuery
            ? 'Try adjusting your filters or search query'
            : 'Check back later for new products'
        }
      </Text>
      {loadError ? (
        <TouchableOpacity
          style={styles.emptyActionButton}
          onPress={() => {
            setIsLoading(true);
            setHasMore(true);
            fetchProducts(1, false);
          }}
        >
          <Ionicons name="refresh" size={18} color={palette.colors.white} />
          <Text style={styles.emptyActionText}>Retry</Text>
        </TouchableOpacity>
      ) : (hasActiveFilters || searchQuery) && (
        <TouchableOpacity
          style={styles.emptyActionButton}
          onPress={() => {
            resetFilters();
            setIsLoading(true);
            fetchProducts();
          }}
        >
          <Ionicons name="refresh" size={18} color={palette.colors.white} />
          <Text style={styles.emptyActionText}>Clear Filters</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // Loading state with skeleton grid
  if (isLoading && products.length === 0) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
          <StatusBar barStyle="light-content" />
          <ScrollView showsVerticalScrollIndicator={false}>
            {renderHeader()}
            <ProductGridSkeleton count={6} />
          </ScrollView>
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const renderFooter = () => {
    if (loadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator size="small" color={palette.colors.primary} />
          <Text style={styles.footerLoaderText}>Loading more products...</Text>
        </View>
      );
    }
    // Explicit pagination affordance alongside infinite scroll
    if (hasMore && products.length > 0) {
      return (
        <TouchableOpacity style={styles.loadMoreBtn} onPress={() => fetchProducts(page + 1, true)} activeOpacity={0.85}>
          <LinearGradient colors={palette.gradients.cta} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
          <Text style={styles.loadMoreText}>Load More Products</Text>
          <Ionicons name="chevron-down" size={16} color="#fff" />
        </TouchableOpacity>
      );
    }
    return null;
  };

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }}>
      <StatusBar barStyle="light-content" />
      <FlatList
        data={products}
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
        ListEmptyComponent={renderEmptyState()}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        removeClippedSubviews={true}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: false }
        )}
      />
      {renderFilterModal()}

      {/* AI FAB — matches website chat launcher */}
      <AIChatFab onPress={() => setShowAI(true)} />

      <ChatBot visible={showAI} onClose={() => setShowAI(false)} navigation={navigation} />
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
    borderRadius: 24,
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
  statsBanner: { flexDirection: 'row', backgroundColor: p.glass.bg, marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: borderRadius.xl, padding: spacing.md, borderWidth: 1, borderColor: p.glass.border, ...shadows.sm, justifyContent: 'space-around', overflow: 'hidden' },
  statItem: { alignItems: 'center', flex: 1, gap: 2 },
  statText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.dark },
  statLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  statDivider: { width: 1, backgroundColor: p.colors.light },
  // Categories
  categoriesSection: { paddingTop: spacing.lg, paddingBottom: spacing.md, marginTop: spacing.sm },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.dark },
  sectionLink: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  categoriesScroll: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.sm },
  categoryChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: p.colors.primarySubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, borderWidth: 1, borderColor: p.colors.primaryLighter },
  categoryChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  categoryChipText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  categoryChipTextActive: { color: p.colors.white },
  // Stores Banner
  storesBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: p.colors.secondary, marginHorizontal: spacing.lg, marginVertical: spacing.lg, borderRadius: borderRadius.xl, padding: spacing.lg, ...shadows.md },
  storesBannerContent: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  storesBannerIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  storesBannerText: {},
  storesBannerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.white },
  storesBannerSub: { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.8)' },
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
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: p.colors.white, borderTopLeftRadius: borderRadius.xxxl, borderTopRightRadius: borderRadius.xxxl, maxHeight: '85%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: p.colors.light },
  modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.dark },
  modalCloseButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: p.colors.light, justifyContent: 'center', alignItems: 'center' },
  modalBody: { padding: spacing.lg },
  filterSection: { marginBottom: spacing.xl },
  filterSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  filterSectionTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.textSecondary, letterSpacing: 1 },
  filterOptionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filterChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.colors.light, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, gap: spacing.xs },
  filterChipSelected: { backgroundColor: p.colors.primary },
  filterChipText: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.medium },
  filterChipTextSelected: { color: p.colors.white },
  noFilterText: { fontSize: fontSize.md, color: p.colors.textSecondary, fontStyle: 'italic' },
  modalFooter: { flexDirection: 'row', padding: spacing.lg, gap: spacing.md, borderTopWidth: 1, borderTopColor: p.colors.light },
  resetButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.light, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm },
  resetButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  applyButton: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm, ...shadows.md },
  applyButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.white },
  // Pagination footer loader
  footerLoader: { paddingVertical: spacing.xl, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  footerLoaderText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  loadMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, marginHorizontal: spacing.lg, marginTop: spacing.md, paddingVertical: spacing.md, borderRadius: borderRadius.xl, overflow: 'hidden', shadowColor: '#0EA5E9', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 6 },
  loadMoreText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
});
