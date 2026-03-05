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
import api from '../config/api';
import ProductCard from '../components/ProductCard';
import CurrencySelector from '../components/CurrencySelector';
import { Loader, EmptySearch } from '../components/common';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import TortroseLogo from '../components/common/TortroseLogo';
import { useAuth } from '../contexts/AuthContext';
import { useGlobal } from '../contexts/GlobalContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { 
  colors, 
  spacing, 
  fontSize, 
  borderRadius, 
  shadows, 
  fontWeight,
  typography,
} from '../styles/theme';

export default function HomeScreen({ navigation }) {
  const { currentUser } = useAuth();
  const { fetchCart } = useGlobal();
  const { formatPrice } = useCurrency();
  
  const [products, setProducts] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [totalProducts, setTotalProducts] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [selectedBrands, setSelectedBrands] = useState([]);

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
      params.append('page', pageNum);
      params.append('limit', LIMIT);

      const res = await api.get(`/api/products/get-products?${params.toString()}`);
      const newProducts = res.data.products || [];
      const paginationInfo = res.data.pagination;

      if (append) {
        setProducts(prev => [...prev, ...newProducts]);
      } else {
        setProducts(newProducts);
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
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  }, [selectedCategories, selectedBrands, searchQuery]);

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
    fetchProducts(1, false);
  }, [fetchProducts]);

  const onEndReached = useCallback(() => {
    if (!loadingMore && !isLoading && hasMore) {
      fetchProducts(page + 1, true);
    }
  }, [loadingMore, isLoading, hasMore, page, fetchProducts]);

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
    fetchProducts(1, false);
  }, [fetchProducts]);

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
  };

  const applyFilters = () => {
    setShowFilters(false);
    setIsLoading(true);
    setPage(1);
    setHasMore(true);
    fetchProducts(1, false);
  };

  const hasActiveFilters = selectedCategories.length > 0 || selectedBrands.length > 0;

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
          <TortroseLogo width={140} height={32} />
          <View style={styles.heroTopRight}>
            <CurrencySelector />
            {!currentUser ? (
              <TouchableOpacity style={styles.loginButton} onPress={() => navigation.navigate('Login')}>
                <Ionicons name="person-outline" size={16} color={colors.primary} />
                <Text style={styles.loginButtonText}>Sign In</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.cartIconBtn} onPress={() => navigation.navigate('Cart')}>
                <Ionicons name="bag-outline" size={22} color={colors.primary} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Greeting */}
        <View style={styles.greetingSection}>
          <Text style={styles.greetingText}>
            {currentUser ? `Hello, ${currentUser.name?.split(' ')[0] || 'there'}! 👋` : 'Discover Amazing Deals 🛍️'}
          </Text>
          <Text style={styles.greetingSubtext}>Find the best products from verified stores</Text>
        </View>

        {/* Search Bar */}
        <View style={styles.searchContainer}>
          <View style={styles.searchInputContainer}>
            <Ionicons name="search-outline" size={20} color={colors.grayLight} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search products, brands..."
              placeholderTextColor={colors.grayLight}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={handleSearch}
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => { setSearchQuery(''); handleSearch(); }}>
                <Ionicons name="close-circle" size={20} color={colors.grayLight} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity style={[styles.filterButton, hasActiveFilters && styles.filterButtonActive]} onPress={() => setShowFilters(true)}>
            <Ionicons name="options-outline" size={22} color={colors.primary} />
            {hasActiveFilters && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{selectedCategories.length + selectedBrands.length}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </GlassPanel>

      {/* Quick Stats Banner */}
      <View style={styles.statsBanner}>
        <View style={styles.statItem}>
          <Ionicons name="shield-checkmark" size={18} color={colors.primary} />
          <Text style={styles.statText}>Verified</Text>
          <Text style={styles.statLabel}>Stores</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Ionicons name="flash" size={18} color={colors.warning} />
          <Text style={styles.statText}>Fast</Text>
          <Text style={styles.statLabel}>Delivery</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Ionicons name="lock-closed" size={18} color={colors.success} />
          <Text style={styles.statText}>Secure</Text>
          <Text style={styles.statLabel}>Payments</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statItem}>
          <Ionicons name="refresh" size={18} color={colors.info} />
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
              <Ionicons name="apps-outline" size={16} color={selectedCategories.length === 0 ? colors.white : colors.primary} />
              <Text style={[styles.categoryChipText, selectedCategories.length === 0 && styles.categoryChipTextActive]}>All</Text>
            </TouchableOpacity>
            {categories.map(cat => {
              const isActive = selectedCategories.includes(cat);
              return (
                <TouchableOpacity key={cat} style={[styles.categoryChip, isActive && styles.categoryChipActive]} onPress={() => { toggleCategory(cat); applyFilters(); }}>
                  <Ionicons name={categoryIcons[cat] || categoryIcons.default} size={16} color={isActive ? colors.white : colors.primary} />
                  <Text style={[styles.categoryChipText, isActive && styles.categoryChipTextActive]}>{cat}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Browse Stores Banner */}
      <TouchableOpacity style={styles.storesBanner} onPress={() => navigation.navigate('Stores')} activeOpacity={0.9}>
        <View style={styles.storesBannerContent}>
          <View style={styles.storesBannerIcon}><Ionicons name="storefront-outline" size={28} color={colors.white} /></View>
          <View style={styles.storesBannerText}>
            <Text style={styles.storesBannerTitle}>Explore Our Stores</Text>
            <Text style={styles.storesBannerSub}>Shop from verified sellers</Text>
          </View>
        </View>
        <Ionicons name="chevron-forward" size={22} color={colors.white} />
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
                <Ionicons name="close" size={14} color={colors.primary} />
              </TouchableOpacity>
            ))}
            {selectedBrands.map(brand => (
              <TouchableOpacity key={brand} style={styles.activeFilterChip} onPress={() => toggleBrand(brand)}>
                <Text style={styles.activeFilterText}>{brand}</Text>
                <Ionicons name="close" size={14} color={colors.primary} />
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
              <Ionicons name="close" size={24} color={colors.dark} />
            </TouchableOpacity>
          </View>

          {/* Modal Body */}
          <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
            {/* Categories Section */}
            <View style={styles.filterSection}>
              <View style={styles.filterSectionHeader}>
                <Ionicons name="grid-outline" size={18} color={colors.primary} />
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
                        <Ionicons name="checkmark" size={14} color={colors.white} />
                      )}
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Brands Section */}
            <View style={styles.filterSection}>
              <View style={styles.filterSectionHeader}>
                <Ionicons name="pricetag-outline" size={18} color={colors.secondary} />
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
                        <Ionicons name="checkmark" size={14} color={colors.white} />
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
              <Ionicons name="refresh" size={18} color={colors.text} />
              <Text style={styles.resetButtonText}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.applyButton} 
              onPress={applyFilters}
              accessibilityLabel="Apply filters"
            >
              <Text style={styles.applyButtonText}>Apply Filters</Text>
              <Ionicons name="checkmark" size={18} color={colors.white} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconContainer}>
        <Ionicons name="cube-outline" size={64} color={colors.grayLight} />
      </View>
      <Text style={styles.emptyTitle}>No products found</Text>
      <Text style={styles.emptySubtitle}>
        {hasActiveFilters || searchQuery 
          ? 'Try adjusting your filters or search query'
          : 'Check back later for new products'
        }
      </Text>
      {(hasActiveFilters || searchQuery) && (
        <TouchableOpacity 
          style={styles.emptyActionButton}
          onPress={() => {
            resetFilters();
            setIsLoading(true);
            fetchProducts();
          }}
        >
          <Ionicons name="refresh" size={18} color={colors.white} />
          <Text style={styles.emptyActionText}>Clear Filters</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // Loading state with custom loader
  if (isLoading && products.length === 0) {
    return (
      <GlassBackground>
        <SafeAreaView style={{ flex: 1 }}>
        <StatusBar barStyle="light-content" />
        <Loader fullScreen size="medium" />
        </SafeAreaView>
      </GlassBackground>
    );
  }

  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={styles.footerLoader}>
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.footerLoaderText}>Loading more products...</Text>
      </View>
    );
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
        ListHeaderComponent={renderHeader}
        renderItem={renderItem}
        ListFooterComponent={renderFooter}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={renderEmptyState}
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
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Hero Header — Glass style
  heroHeader: { marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm, paddingBottom: spacing.md },
  heroTopBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: spacing.md },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  logoIconWrap: { width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center' },
  logoText: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text },
  heroTopRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  loginButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(99,102,241,0.1)', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, gap: spacing.xs },
  loginButtonText: { color: colors.primary, fontWeight: fontWeight.semibold, fontSize: fontSize.sm },
  cartIconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(99,102,241,0.1)', justifyContent: 'center', alignItems: 'center' },
  greetingSection: { paddingBottom: spacing.md },
  greetingText: { fontSize: fontSize.title, fontWeight: fontWeight.extrabold, color: colors.text, marginBottom: spacing.xs },
  greetingSubtext: { fontSize: fontSize.sm, color: colors.textSecondary },
  // Search
  searchContainer: { flexDirection: 'row', gap: spacing.sm },
  searchInputContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(99,102,241,0.08)', borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, height: 48, gap: spacing.sm, borderWidth: 1, borderColor: 'rgba(99,102,241,0.15)' },
  searchInput: { flex: 1, fontSize: fontSize.md, color: colors.text },
  filterButton: { backgroundColor: 'rgba(99,102,241,0.1)', width: 48, height: 48, borderRadius: borderRadius.xl, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(99,102,241,0.15)' },
  filterButtonActive: { backgroundColor: colors.primary },
  filterBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: colors.error, width: 18, height: 18, borderRadius: 9, justifyContent: 'center', alignItems: 'center' },
  filterBadgeText: { color: colors.white, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
  // Stats banner
  statsBanner: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.7)', marginHorizontal: spacing.md, marginTop: spacing.sm, borderRadius: borderRadius.xl, padding: spacing.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', ...shadows.sm, justifyContent: 'space-around' },
  statItem: { alignItems: 'center', flex: 1, gap: 2 },
  statText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.dark },
  statLabel: { fontSize: fontSize.xs, color: colors.textSecondary },
  statDivider: { width: 1, backgroundColor: colors.light },
  // Categories
  categoriesSection: { paddingTop: spacing.xl, paddingBottom: spacing.md, backgroundColor: colors.white, marginTop: spacing.md },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.dark },
  sectionLink: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  categoriesScroll: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.sm },
  categoryChip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: colors.primarySubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, borderWidth: 1, borderColor: colors.primaryLighter },
  categoryChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  categoryChipText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  categoryChipTextActive: { color: colors.white },
  // Stores Banner
  storesBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.secondary, marginHorizontal: spacing.lg, marginVertical: spacing.lg, borderRadius: borderRadius.xl, padding: spacing.lg, ...shadows.md },
  storesBannerContent: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  storesBannerIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  storesBannerText: {},
  storesBannerTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.white },
  storesBannerSub: { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.8)' },
  // Products section
  productsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  productsTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark },
  productCountContainer: { backgroundColor: colors.primarySubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full },
  productCount: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
  // Active filters
  activeFiltersContainer: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  activeFilterChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primaryLighter, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, marginRight: spacing.sm, gap: spacing.xs },
  activeFilterText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.medium },
  clearFiltersButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, justifyContent: 'center' },
  clearFiltersText: { fontSize: fontSize.sm, color: colors.error, fontWeight: fontWeight.semibold },
  // List
  listContent: { paddingBottom: spacing.xxl },
  row: { paddingHorizontal: spacing.sm, gap: spacing.sm },
  // Empty state
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60, paddingHorizontal: spacing.xl },
  emptyIconContainer: { width: 100, height: 100, borderRadius: 50, backgroundColor: colors.light, justifyContent: 'center', alignItems: 'center', marginBottom: spacing.lg },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark, marginBottom: spacing.sm },
  emptySubtitle: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  emptyActionButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, marginTop: spacing.xl, gap: spacing.sm },
  emptyActionText: { color: colors.white, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: colors.white, borderTopLeftRadius: borderRadius.xxxl, borderTopRightRadius: borderRadius.xxxl, maxHeight: '85%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.light },
  modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.dark },
  modalCloseButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.light, justifyContent: 'center', alignItems: 'center' },
  modalBody: { padding: spacing.lg },
  filterSection: { marginBottom: spacing.xl },
  filterSectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  filterSectionTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary, letterSpacing: 1 },
  filterOptionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  filterChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.light, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, gap: spacing.xs },
  filterChipSelected: { backgroundColor: colors.primary },
  filterChipText: { fontSize: fontSize.sm, color: colors.text, fontWeight: fontWeight.medium },
  filterChipTextSelected: { color: colors.white },
  noFilterText: { fontSize: fontSize.md, color: colors.textSecondary, fontStyle: 'italic' },
  modalFooter: { flexDirection: 'row', padding: spacing.lg, gap: spacing.md, borderTopWidth: 1, borderTopColor: colors.light },
  resetButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.light, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm },
  resetButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.text },
  applyButton: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, paddingVertical: spacing.md, borderRadius: borderRadius.xl, gap: spacing.sm, ...shadows.md },
  applyButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.white },
  // Pagination footer loader
  footerLoader: { paddingVertical: spacing.xl, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm },
  footerLoaderText: { fontSize: fontSize.sm, color: colors.textSecondary, fontWeight: fontWeight.medium },
});
