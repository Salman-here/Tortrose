/**
 * ProductManagementScreen - shared admin/seller product management.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
  RefreshControl, TextInput, Modal, ScrollView, ActivityIndicator, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api, { API_ENDPOINTS } from '../../config/api';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../../components/common/KeyboardAwareFormScrollView';
import {
  SellerEmptyState,
  SellerInlineError,
  SellerScreenHeader,
  SellerScreenSkeleton,
} from '../../components/seller/SellerUI';
import { spacing, fontSize, borderRadius, fontWeight, typography } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import {
  buildProductListParams,
  filterProductsByQuery,
  getManagedProductImage,
  getProductModerationReason,
  isProductHiddenByModeration,
  mergeProducts,
  normalizeProductCategories,
  normalizeProductResponse,
  validateBulkActionSelection,
} from '../../utils/productManagement';

const PAGE_LIMIT = 24;

export { filterProductsByQuery, isProductHiddenByModeration };

const getStockStatus = (stock, palette) => {
  const amount = Number(stock || 0);
  if (amount <= 0) return { label: 'Out of Stock', color: palette.colors.error };
  if (amount <= 10) return { label: 'Low Stock', color: palette.colors.warning };
  return { label: 'In Stock', color: palette.colors.success };
};

export default function ProductManagementScreen({ navigation, route }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const { currency, formatProductPrice, getCurrencySymbol } = useCurrency();

  const { isAdmin } = route.params || {};
  const [products, setProducts] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_LIMIT, totalProducts: 0, totalPages: 1, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [filtersLoading, setFiltersLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [bulkModalVisible, setBulkModalVisible] = useState(false);
  const [bulkTab, setBulkTab] = useState('discount');
  const [bulkDiscountType, setBulkDiscountType] = useState('percentage');
  const [bulkDiscountValue, setBulkDiscountValue] = useState('');
  const [bulkPriceType, setBulkPriceType] = useState('percentage');
  const [bulkPriceValue, setBulkPriceValue] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [hasStore, setHasStore] = useState(isAdmin ? true : null);
  const [loadError, setLoadError] = useState('');
  const [storeCheckError, setStoreCheckError] = useState('');
  const hasLoadedRef = useRef(false);
  const fetchProductsRef = useRef(null);
  const checkStoreRef = useRef(null);
  const fetchRequestRef = useRef(0);

  const endpoint = isAdmin ? API_ENDPOINTS.PRODUCTS.GET_ADMIN : API_ENDPOINTS.PRODUCTS.GET_SELLER;
  const moneySymbol = getCurrencySymbol();

  const handleBack = useCallback(() => {
    if (navigation.canGoBack?.()) navigation.goBack();
    else navigation.navigate('SellerDashboard');
  }, [navigation]);

  const openProductForm = useCallback((product) => {
    if (!isAdmin && hasStore === false) {
      navigation.navigate('SellerStoreSettings');
      return;
    }
    navigation.navigate('ProductForm', { ...(product ? { product } : {}), isAdmin });
  }, [hasStore, isAdmin, navigation]);

  const fetchProducts = useCallback(async ({ page = 1, append = false, silent = false } = {}) => {
    const requestId = ++fetchRequestRef.current;
    if (append) setLoadingMore(true);
    else if (!silent && !hasLoadedRef.current) setLoading(true);
    else if (!silent) setSearching(true);

    try {
      if (!append) setLoadError('');
      const res = await api.get(endpoint, {
        params: buildProductListParams({
          page,
          limit: PAGE_LIMIT,
          currency,
          searchQuery,
          selectedCategory,
        }),
      });
      if (requestId !== fetchRequestRef.current) return;
      const normalized = normalizeProductResponse(res.data);
      setProducts(prev => append ? mergeProducts(prev, normalized.products) : normalized.products);
      setCategories((previous) => normalizeProductCategories(previous, normalized.products));
      setPagination(normalized.pagination || {
        page,
        limit: PAGE_LIMIT,
        totalProducts: normalized.products.length,
        totalPages: 1,
        hasMore: false,
      });
    } catch (e) {
      if (requestId !== fetchRequestRef.current) return;
      const message = e.response?.data?.msg || 'We could not load your products. Check your connection and try again.';
      setLoadError(message);
      if (append) Alert.alert('Could not load more products', message);
    } finally {
      if (requestId !== fetchRequestRef.current) return;
      setLoading(false);
      setLoadingMore(false);
      setSearching(false);
      setRefreshing(false);
      hasLoadedRef.current = true;
    }
  }, [endpoint, currency, searchQuery, selectedCategory]);

  const fetchCategories = useCallback(async () => {
    setFiltersLoading(true);
    try {
      const response = await api.get('/api/products/get-filters');
      setCategories((previous) => normalizeProductCategories(previous, response.data?.categories));
    } catch (_) {
      // Product categories observed in seller results remain available as a safe fallback.
    } finally {
      setFiltersLoading(false);
    }
  }, []);

  const checkStore = useCallback(async () => {
    if (isAdmin) return;
    try {
      setStoreCheckError('');
      const res = await api.get(API_ENDPOINTS.STORES.MY_STORE);
      setHasStore(!!res.data?.store);
    } catch (error) {
      if (error.response?.status === 404) {
        setHasStore(false);
      } else {
        setHasStore(null);
        setStoreCheckError(error.response?.data?.msg || 'Store status could not be verified right now.');
      }
    }
  }, [isAdmin]);

  useEffect(() => {
    checkStore();
    fetchCategories();
  }, [checkStore, fetchCategories]);

  useEffect(() => {
    const timer = setTimeout(() => fetchProducts({ page: 1 }), searchQuery ? 350 : 0);
    return () => clearTimeout(timer);
  }, [fetchProducts, searchQuery, selectedCategory]);

  useEffect(() => {
    setSelectMode(false);
    setSelectedProducts([]);
  }, [searchQuery, selectedCategory]);

  useEffect(() => {
    fetchProductsRef.current = fetchProducts;
    checkStoreRef.current = checkStore;
  }, [checkStore, fetchProducts]);

  useEffect(() => navigation.addListener('focus', () => {
    if (!hasLoadedRef.current) return;
    fetchProductsRef.current?.({ page: 1, silent: true });
    checkStoreRef.current?.();
    fetchCategories();
  }), [fetchCategories, navigation]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      fetchProducts({ page: 1, silent: true }),
      checkStore(),
      fetchCategories(),
    ]);
  }, [checkStore, fetchCategories, fetchProducts]);

  const loadMore = () => {
    if (loading || loadingMore || !pagination?.hasMore) return;
    fetchProducts({ page: (pagination.page || 1) + 1, append: true, silent: true });
  };

  const deleteProduct = useCallback((id, name) => {
    Alert.alert('Delete product?', `Delete "${name || 'this product'}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setDeletingId(id);
          try {
            await api.delete(`${API_ENDPOINTS.PRODUCTS.DELETE}/${id}`);
            setProducts(prev => prev.filter(p => p._id !== id));
            setSelectedProducts(prev => prev.filter(p => p._id !== id));
            setPagination((previous) => ({
              ...previous,
              totalProducts: Math.max(0, Number(previous?.totalProducts || 0) - 1),
            }));
          } catch (e) {
            Alert.alert('Error', e.response?.data?.msg || 'Failed to delete product');
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  }, []);

  const handleSelectProduct = useCallback((product) => {
    setSelectedProducts(prev => prev.find(p => p._id === product._id)
      ? prev.filter(p => p._id !== product._id)
      : [...prev, product]);
  }, []);

  const toggleSelectAllLoaded = () => {
    if (selectedProducts.length === products.length) {
      setSelectedProducts([]);
    } else {
      setSelectedProducts(products);
    }
  };

  const exitBulkMode = () => {
    setBulkModalVisible(false);
    setSelectMode(false);
    setSelectedProducts([]);
    setBulkDiscountValue('');
    setBulkPriceValue('');
  };

  const selectedIds = [...new Set(selectedProducts.map((product) => product?._id).filter(Boolean))];

  const requireSelection = (max) => {
    const validation = validateBulkActionSelection(selectedIds, { max });
    if (validation.isValid) return validation.ids;
    Alert.alert('Selection required', validation.message);
    return null;
  };

  const handleBulkDiscount = async () => {
    const productIds = requireSelection();
    if (!productIds) return;
    const discountValue = Number(bulkDiscountValue);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      Alert.alert('Invalid discount', 'Enter a discount greater than zero.');
      return;
    }
    if (bulkDiscountType === 'percentage' && discountValue >= 100) {
      Alert.alert('Invalid discount', 'Percentage discounts must be less than 100%.');
      return;
    }
    setBulkLoading(true);
    try {
      const response = await api.post(API_ENDPOINTS.PRODUCTS.BULK_DISCOUNT, {
        productIds,
        discountType: bulkDiscountType,
        discountValue,
        currency,
      });
      exitBulkMode();
      fetchProducts({ page: 1, silent: true });
      Alert.alert('Discount applied', response.data?.msg || `Updated ${productIds.length} products.`);
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to apply discount');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkPriceUpdate = async () => {
    const productIds = requireSelection();
    if (!productIds) return;
    const priceValue = Number(bulkPriceValue);
    if (!Number.isFinite(priceValue) || (bulkPriceType === 'set' ? priceValue <= 0 : priceValue === 0)) {
      Alert.alert('Invalid price change', bulkPriceType === 'set' ? 'The new price must be greater than zero.' : 'Enter a non-zero price change.');
      return;
    }
    if (bulkPriceType === 'percentage' && priceValue <= -100) {
      Alert.alert('Invalid price change', 'A percentage decrease must be less than 100%.');
      return;
    }
    setBulkLoading(true);
    try {
      const response = await api.post(API_ENDPOINTS.PRODUCTS.BULK_PRICE_UPDATE, {
        productIds,
        updateType: bulkPriceType,
        value: priceValue,
        currency,
      });
      exitBulkMode();
      fetchProducts({ page: 1, silent: true });
      Alert.alert('Prices updated', response.data?.msg || `Updated ${productIds.length} products.`);
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to update prices');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleRemoveDiscount = async () => {
    const productIds = requireSelection();
    if (!productIds) return;
    setBulkLoading(true);
    try {
      const response = await api.post(API_ENDPOINTS.PRODUCTS.REMOVE_DISCOUNT, { productIds });
      exitBulkMode();
      fetchProducts({ page: 1, silent: true });
      Alert.alert('Discounts removed', response.data?.msg || `Updated ${productIds.length} products.`);
    } catch (e) {
      Alert.alert('Error', e.response?.data?.msg || 'Failed to remove discounts');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkDelete = () => {
    const productIds = requireSelection(250);
    if (!productIds) return;
    Alert.alert(
      'Delete selected products?',
      `This will permanently delete ${productIds.length} product${productIds.length === 1 ? '' : 's'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBulkLoading(true);
            try {
              const response = await api.post(API_ENDPOINTS.PRODUCTS.BULK_DELETE, { productIds });
              exitBulkMode();
              fetchProducts({ page: 1, silent: true });
              Alert.alert('Products deleted', response.data?.msg || `Deleted ${productIds.length} products.`);
            } catch (e) {
              Alert.alert('Error', e.response?.data?.msg || 'Failed to delete selected products');
            } finally {
              setBulkLoading(false);
            }
          },
        },
      ]
    );
  };

  const renderProduct = useCallback(({ item }) => {
    const stockStatus = getStockStatus(item.stock, palette);
    const isDeleting = deletingId === item._id;
    const isSelected = selectedProducts.some(p => p._id === item._id);
    const imageUri = getManagedProductImage(item);
    const hasDiscount = Number(item.discountedPrice || 0) > 0 && Number(item.discountedPrice) < Number(item.price);
    const isHidden = isProductHiddenByModeration(item);
    const hiddenReason = getProductModerationReason(item);

    return (
      <GlassPanel variant="card" style={[styles.productCard, isSelected && styles.productCardSelected]}>
        <TouchableOpacity
          style={styles.productCardInner}
          onPress={() => {
            if (selectMode) {
              handleSelectProduct(item);
              return;
            }
            openProductForm(item);
          }}
          onLongPress={() => {
            if (!selectMode) {
              setSelectMode(true);
              handleSelectProduct(item);
            }
          }}
          activeOpacity={0.7}
          disabled={isDeleting}
          accessibilityRole="button"
          accessibilityLabel={`${item.name || 'Untitled product'}, ${stockStatus.label}${isHidden ? ', hidden from customers' : ''}`}
          accessibilityHint={selectMode ? 'Toggles selection' : 'Opens product editor'}
          accessibilityState={{ selected: isSelected, disabled: isDeleting }}
        >
          {selectMode && (
            <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
              {isSelected && <Ionicons name="checkmark" size={14} color="white" />}
            </View>
          )}
          <View style={styles.imageContainer}>
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.productImage} contentFit="cover" accessibilityLabel={`${item.name || 'Product'} image`} />
            ) : (
              <View style={[styles.productImage, styles.imagePlaceholder]}>
                <Ionicons name="cube-outline" size={24} color={palette.colors.textSecondary} />
              </View>
            )}
          </View>
          <View style={styles.productInfo}>
            <Text style={styles.productName} numberOfLines={2}>{item.name || 'Untitled product'}</Text>
            <Text style={styles.metaText} numberOfLines={1}>{item.category || 'Uncategorized'}{item.brand ? ` - ${item.brand}` : ''}</Text>
            {isHidden && (
              <View style={styles.hiddenProductBadge}>
                <Ionicons name="eye-off-outline" size={12} color={palette.colors.error} />
                <Text style={styles.hiddenProductText}>Hidden from customers</Text>
              </View>
            )}
            <View style={styles.priceRow}>
              <Text style={styles.productPrice}>{formatProductPrice(item, { field: hasDiscount ? 'discountedPrice' : 'price' })}</Text>
              {hasDiscount && <Text style={styles.originalPrice}>{formatProductPrice(item, { field: 'price' })}</Text>}
            </View>
            <View style={[styles.stockBadge, { backgroundColor: `${stockStatus.color}20` }]}>
              <Text style={[styles.stockText, { color: stockStatus.color }]}>{stockStatus.label} - {Number(item.stock || 0)} left</Text>
            </View>
            {isHidden && <Text style={styles.hiddenReason} numberOfLines={2}>{hiddenReason}</Text>}
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionButton} onPress={() => openProductForm(item)} accessibilityRole="button" accessibilityLabel={`Edit ${item.name || 'product'}`}>
              <Ionicons name="create-outline" size={22} color={palette.colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={() => deleteProduct(item._id, item.name)} disabled={isDeleting} accessibilityRole="button" accessibilityLabel={`Delete ${item.name || 'product'}`} accessibilityState={{ disabled: isDeleting, busy: isDeleting }}>
              <Ionicons name="trash-outline" size={22} color={isDeleting ? palette.colors.textSecondary : palette.colors.error} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </GlassPanel>
    );
  }, [deletingId, deleteProduct, selectMode, selectedProducts, handleSelectProduct, palette, formatProductPrice, styles, openProductForm]);

  const renderHeader = useCallback(() => (
    <View style={styles.headerContainer}>
      {!!loadError && (
        <SellerInlineError
          compact
          title="Products could not refresh"
          message={loadError}
          onRetry={() => fetchProducts({ page: 1 })}
        />
      )}
      {!!storeCheckError && (
        <SellerInlineError
          compact
          title="Store status unavailable"
          message={storeCheckError}
          onRetry={checkStore}
        />
      )}
      {selectMode ? (
        <GlassPanel variant="floating" style={styles.bulkBar}>
          <TouchableOpacity onPress={() => { setSelectMode(false); setSelectedProducts([]); }} accessibilityRole="button" accessibilityLabel="Exit product selection">
            <Ionicons name="close" size={20} color={palette.colors.text} />
          </TouchableOpacity>
          <Text style={styles.bulkCountText}>{selectedProducts.length} selected</Text>
          <TouchableOpacity onPress={toggleSelectAllLoaded} accessibilityRole="button" accessibilityLabel={selectedProducts.length === products.length ? 'Clear selected products' : 'Select all loaded products'}>
            <Text style={styles.selectAllText}>{selectedProducts.length === products.length ? 'Clear' : 'Select loaded'}</Text>
          </TouchableOpacity>
          {selectedProducts.length > 0 && (
            <TouchableOpacity style={styles.bulkActionsBtn} onPress={() => setBulkModalVisible(true)} accessibilityRole="button" accessibilityLabel={`Open bulk actions for ${selectedProducts.length} products`}>
              <Ionicons name="flash" size={16} color="white" />
              <Text style={styles.bulkActionsBtnText}>Actions</Text>
            </TouchableOpacity>
          )}
        </GlassPanel>
      ) : (
        <>
          <View style={styles.searchContainer}>
            <Ionicons name="search" size={20} color={palette.colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search products..."
              placeholderTextColor={palette.colors.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
              accessibilityLabel="Search products"
              returnKeyType="search"
            />
            {searching && <ActivityIndicator size="small" color={palette.colors.primary} />}
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} accessibilityRole="button" accessibilityLabel="Clear product search">
                <Ionicons name="close-circle" size={20} color={palette.colors.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categoryFilters}
            accessibilityRole="tablist"
          >
            {['all', ...categories].map((category) => {
              const selected = category === selectedCategory;
              return (
                <TouchableOpacity
                  key={category}
                  style={[styles.categoryChip, selected && styles.categoryChipActive]}
                  onPress={() => setSelectedCategory(category)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  accessibilityLabel={category === 'all' ? 'All product categories' : `${category} products`}
                >
                  {category === 'all' && <Ionicons name="apps-outline" size={14} color={selected ? '#fff' : palette.colors.textSecondary} />}
                  <Text style={[styles.categoryChipText, selected && styles.categoryChipTextActive]}>
                    {category === 'all' ? 'All' : category}
                  </Text>
                </TouchableOpacity>
              );
            })}
            {filtersLoading && <ActivityIndicator size="small" color={palette.colors.primary} style={styles.filterLoader} />}
          </ScrollView>
          <View style={styles.resultsRow}>
            <Text style={styles.resultsText}>
              <Text style={styles.resultsCount}>{pagination?.totalProducts ?? products.length}</Text> products
            </Text>
            <TouchableOpacity style={styles.selectModeBtn} onPress={() => setSelectMode(true)} disabled={products.length === 0} accessibilityRole="button" accessibilityLabel="Select products for bulk actions" accessibilityState={{ disabled: products.length === 0 }}>
              <Ionicons name="checkmark-circle-outline" size={16} color={products.length ? palette.colors.primary : palette.colors.textSecondary} />
              <Text style={[styles.selectModeBtnText, products.length === 0 && { color: palette.colors.textSecondary }]}>Select</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  ), [categories, checkStore, fetchProducts, filtersLoading, loadError, pagination?.totalProducts, palette, products.length, searchQuery, searching, selectedCategory, selectedProducts.length, selectMode, storeCheckError, styles]);

  const renderFooter = () => {
    if (loadingMore) {
      return (
        <View style={styles.footerLoader}>
          <ActivityIndicator color={palette.colors.primary} />
          <Text style={styles.footerText}>Loading more products...</Text>
        </View>
      );
    }
    if (!pagination?.hasMore || products.length === 0) return <View style={{ height: 20 }} />;
    return (
      <TouchableOpacity style={styles.loadMoreBtn} onPress={loadMore} activeOpacity={0.8}>
        <Text style={styles.loadMoreText}>Load more</Text>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <SellerScreenSkeleton
        navigation={navigation}
        title="Products"
        subtitle="Loading your catalog and inventory"
        icon="cube-outline"
        variant="list"
        rows={6}
      />
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView
        style={styles.safeArea}
        edges={Platform.OS === 'android' ? [] : ['top']}
      >
      <SellerScreenHeader
        navigation={navigation}
        title="Products"
        subtitle={`${pagination?.totalProducts ?? products.length} listings | inventory, pricing and visibility`}
        icon="cube-outline"
        onBack={handleBack}
        rightIcon={hasStore === false && !isAdmin ? 'storefront-outline' : 'add'}
        rightLabel={hasStore === false && !isAdmin ? 'Set up' : 'Add'}
        onRightPress={() => openProductForm()}
      />
      {!isAdmin && hasStore === false && (
        <GlassPanel variant="card" style={styles.storeWarning}>
          <View style={styles.warningRow}>
            <Ionicons name="alert-circle" size={22} color={palette.colors.warning} />
            <Text style={styles.warningTitle}>Store Required</Text>
          </View>
          <Text style={styles.warningText}>Create your store before adding products.</Text>
          <TouchableOpacity style={styles.warningButton} onPress={() => navigation.navigate('SellerStoreSettings')}>
            <Text style={styles.warningButtonText}>Go to Store Settings</Text>
          </TouchableOpacity>
        </GlassPanel>
      )}

      <FlatList
        data={products}
        renderItem={renderProduct}
        keyExtractor={i => i._id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={renderHeader()}
        ListFooterComponent={renderFooter()}
        ListEmptyComponent={loadError
          ? null
          : searchQuery || selectedCategory !== 'all'
            ? (
              <SellerEmptyState
                icon="search-outline"
                title="No matching products"
                message="Try a different search or category filter."
                actionLabel="Clear filters"
                onAction={() => { setSearchQuery(''); setSelectedCategory('all'); }}
              />
            )
            : (
              <SellerEmptyState
                icon="cube-outline"
                title="Your catalog is ready for its first product"
                message="Add a complete listing with clear images, inventory, pricing, and buyer-protection details."
                actionLabel={hasStore !== false || isAdmin ? 'Add product' : undefined}
                onAction={hasStore !== false || isAdmin ? () => openProductForm() : undefined}
              />
            )}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.45}
        showsVerticalScrollIndicator={false}
      />

      {!selectMode && (hasStore !== false || isAdmin) && (
        <TouchableOpacity style={styles.fab} onPress={() => openProductForm()} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Add product">
          <Ionicons name="add" size={28} color="white" />
        </TouchableOpacity>
      )}

      <Modal visible={bulkModalVisible} transparent animationType="slide" onRequestClose={() => setBulkModalVisible(false)} accessibilityViewIsModal>
        <TouchableOpacity style={styles.bulkModalOverlay} activeOpacity={1} onPress={() => setBulkModalVisible(false)} accessibilityRole="button" accessibilityLabel="Close bulk actions" />
        <GlassPanel variant="strong" style={styles.bulkModalSheet}>
          <View style={styles.bulkModalTitleRow}>
            <Text style={styles.bulkModalTitle}>Bulk Actions - {selectedProducts.length} products</Text>
            <TouchableOpacity onPress={() => setBulkModalVisible(false)} accessibilityRole="button" accessibilityLabel="Close bulk actions">
              <Ionicons name="close" size={22} color={palette.colors.text} />
            </TouchableOpacity>
          </View>
          <View style={styles.bulkTabRow}>
            {[
              { key: 'discount', label: 'Discount', icon: 'pricetag-outline' },
              { key: 'price', label: 'Price', icon: 'cash-outline' },
              { key: 'remove', label: 'Remove', icon: 'close-circle-outline' },
              { key: 'delete', label: 'Delete', icon: 'trash-outline' },
            ].map(tab => (
              <TouchableOpacity key={tab.key} style={[styles.bulkTab, bulkTab === tab.key && styles.bulkTabActive]} onPress={() => setBulkTab(tab.key)} accessibilityRole="tab" accessibilityState={{ selected: bulkTab === tab.key }} accessibilityLabel={`${tab.label} bulk action`}>
                <Ionicons name={tab.icon} size={16} color={bulkTab === tab.key ? 'white' : palette.colors.textSecondary} />
                <Text style={[styles.bulkTabText, bulkTab === tab.key && { color: 'white' }]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <KeyboardAwareFormScrollView bottomOffset={32}>
            {bulkTab === 'discount' && (
              <View style={styles.bulkContent}>
                <Text style={styles.label}>Discount Type</Text>
                <View style={styles.typeRow}>
                  {[{ key: 'percentage', label: '%' }, { key: 'fixed', label: moneySymbol }].map(dt => (
                    <TouchableOpacity key={dt.key} style={[styles.typeBtn, bulkDiscountType === dt.key && styles.typeBtnActive]} onPress={() => setBulkDiscountType(dt.key)}>
                      <Text style={[styles.typeBtnText, bulkDiscountType === dt.key && { color: 'white' }]}>{dt.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>Discount Value</Text>
                <TextInput
                  style={styles.input}
                  value={bulkDiscountValue}
                  onChangeText={setBulkDiscountValue}
                  keyboardType="decimal-pad"
                  placeholder={bulkDiscountType === 'percentage' ? 'e.g. 20' : 'e.g. 10.00'}
                  placeholderTextColor={palette.colors.textSecondary}
                />
                <TouchableOpacity style={[styles.submitButton, bulkLoading && { opacity: 0.6 }]} onPress={handleBulkDiscount} disabled={bulkLoading}>
                  {bulkLoading ? <ActivityIndicator color="white" /> : <Text style={styles.submitButtonText}>Apply Discount</Text>}
                </TouchableOpacity>
              </View>
            )}
            {bulkTab === 'price' && (
              <View style={styles.bulkContent}>
                <Text style={styles.label}>Update Type</Text>
                <View style={styles.typeRow}>
                  {[{ key: 'percentage', label: '%' }, { key: 'fixed', label: moneySymbol }, { key: 'set', label: 'Set' }].map(pt => (
                    <TouchableOpacity key={pt.key} style={[styles.typeBtn, bulkPriceType === pt.key && styles.typeBtnActive]} onPress={() => setBulkPriceType(pt.key)}>
                      <Text style={[styles.typeBtnText, bulkPriceType === pt.key && { color: 'white' }]}>{pt.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.label}>{bulkPriceType === 'set' ? `New Price (${currency})` : 'Change Value'}</Text>
                <TextInput
                  style={styles.input}
                  value={bulkPriceValue}
                  onChangeText={setBulkPriceValue}
                  keyboardType="decimal-pad"
                  placeholder={bulkPriceType === 'percentage' ? 'e.g. 10 or -10' : bulkPriceType === 'fixed' ? 'e.g. 5 or -5' : 'e.g. 99.99'}
                  placeholderTextColor={palette.colors.textSecondary}
                />
                <TouchableOpacity style={[styles.submitButton, bulkLoading && { opacity: 0.6 }]} onPress={handleBulkPriceUpdate} disabled={bulkLoading}>
                  {bulkLoading ? <ActivityIndicator color="white" /> : <Text style={styles.submitButtonText}>Update Prices</Text>}
                </TouchableOpacity>
              </View>
            )}
            {bulkTab === 'remove' && (
              <View style={styles.bulkContentCentered}>
                <Ionicons name="close-circle-outline" size={34} color={palette.colors.warning} style={{ marginBottom: spacing.md }} />
                <Text style={[styles.label, { textAlign: 'center' }]}>Remove Discounts</Text>
                <Text style={styles.bulkHelp}>This removes discounts from selected products and keeps their original prices.</Text>
                <TouchableOpacity style={[styles.submitButton, { backgroundColor: palette.colors.warning }, bulkLoading && { opacity: 0.6 }]} onPress={handleRemoveDiscount} disabled={bulkLoading}>
                  {bulkLoading ? <ActivityIndicator color="white" /> : <Text style={styles.submitButtonText}>Remove Discounts</Text>}
                </TouchableOpacity>
              </View>
            )}
            {bulkTab === 'delete' && (
              <View style={styles.bulkContentCentered}>
                <Ionicons name="trash-outline" size={34} color={palette.colors.error} style={{ marginBottom: spacing.md }} />
                <Text style={[styles.label, { textAlign: 'center' }]}>Delete Products</Text>
                <Text style={styles.bulkHelp}>This permanently deletes all selected products. This cannot be undone.</Text>
                <TouchableOpacity style={[styles.submitButton, { backgroundColor: palette.colors.error }, bulkLoading && { opacity: 0.6 }]} onPress={handleBulkDelete} disabled={bulkLoading}>
                  {bulkLoading ? <ActivityIndicator color="white" /> : <Text style={styles.submitButtonText}>Delete Selected</Text>}
                </TouchableOpacity>
              </View>
            )}
          </KeyboardAwareFormScrollView>
        </GlassPanel>
      </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  safeArea: { flex: 1 },
  headerContainer: { paddingBottom: spacing.sm },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, marginHorizontal: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.md, height: 44, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, color: p.colors.text },
  categoryFilters: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm, alignItems: 'center' },
  categoryChip: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.full, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  categoryChipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  categoryChipText: { ...typography.caption, color: p.colors.textSecondary, fontWeight: fontWeight.semibold },
  categoryChipTextActive: { color: '#fff' },
  filterLoader: { marginHorizontal: spacing.xs },
  resultsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  resultsText: { ...typography.bodySmall, color: p.colors.textSecondary },
  resultsCount: { fontWeight: fontWeight.bold, color: p.colors.text },
  selectModeBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  selectModeBtnText: { ...typography.bodySmall, color: p.colors.primary },
  bulkBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', margin: spacing.lg, padding: spacing.md, gap: spacing.md },
  bulkCountText: { ...typography.bodySemibold, color: p.colors.text },
  selectAllText: { ...typography.bodySmall, color: p.colors.primary, fontWeight: fontWeight.semibold },
  bulkActionsBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: p.colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg },
  bulkActionsBtnText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.semibold },
  list: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: spacing.md, paddingBottom: 120, flexGrow: 1 },
  productCard: { marginBottom: spacing.sm },
  productCardSelected: { borderWidth: 2, borderColor: p.colors.primary },
  productCardInner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm },
  checkboxChecked: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  imageContainer: { marginRight: spacing.md },
  productImage: { width: 64, height: 64, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.06)' },
  imagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  productInfo: { flex: 1 },
  productName: { ...typography.bodySemibold, color: p.colors.text, marginBottom: 2 },
  metaText: { ...typography.caption, color: p.colors.textSecondary, marginBottom: spacing.xs },
  hiddenProductBadge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: borderRadius.full, backgroundColor: p.colors.errorSubtle, borderWidth: 1, borderColor: `${p.colors.error}30` },
  hiddenProductText: { ...typography.caption, color: p.colors.error, fontWeight: fontWeight.bold },
  hiddenReason: { ...typography.caption, color: p.colors.error, marginTop: spacing.xs, lineHeight: 15 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs, flexWrap: 'wrap' },
  productPrice: { ...typography.bodySemibold, color: p.colors.primary },
  originalPrice: { ...typography.bodySmall, color: p.colors.textSecondary, textDecorationLine: 'line-through' },
  stockBadge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.md },
  stockText: { ...typography.caption, fontWeight: fontWeight.semibold },
  actions: { gap: spacing.sm },
  actionButton: { width: 36, height: 36, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  fab: { position: 'absolute', right: spacing.lg, bottom: 100, width: 56, height: 56, borderRadius: 28, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center', elevation: 8, shadowColor: p.colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
  storeWarning: { margin: spacing.md, padding: spacing.lg, borderWidth: 1, borderColor: `${p.colors.warning}40` },
  warningRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  warningTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: p.colors.warning },
  warningText: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.md },
  warningButton: { backgroundColor: p.colors.primary, paddingVertical: 12, paddingHorizontal: spacing.lg, borderRadius: 14, alignSelf: 'flex-start' },
  warningButtonText: { color: '#fff', fontWeight: fontWeight.bold, fontSize: fontSize.sm },
  footerLoader: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  footerText: { ...typography.bodySmall, color: p.colors.textSecondary },
  loadMoreBtn: { alignSelf: 'center', marginVertical: spacing.lg, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.xl, backgroundColor: p.colors.primary },
  loadMoreText: { color: '#fff', fontWeight: fontWeight.bold },
  bulkModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  bulkModalSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '82%', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  bulkModalTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  bulkModalTitle: { ...typography.h4, color: p.colors.text, flex: 1, marginRight: spacing.sm },
  bulkTabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  bulkTab: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.08)' },
  bulkTabActive: { backgroundColor: p.colors.primary },
  bulkTabText: { ...typography.bodySmall, color: p.colors.textSecondary },
  bulkContent: { padding: spacing.lg },
  bulkContentCentered: { padding: spacing.lg, alignItems: 'center' },
  bulkHelp: { ...typography.bodySmall, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg },
  label: { ...typography.bodySemibold, color: p.colors.text, marginBottom: spacing.sm },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', marginBottom: spacing.md },
  submitButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', backgroundColor: p.colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.md, alignSelf: 'stretch' },
  submitButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: 'white' },
  typeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  typeBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 2, borderColor: 'rgba(255,255,255,0.1)' },
  typeBtnActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  typeBtnText: { ...typography.bodySemibold, color: p.colors.textSecondary },
});
