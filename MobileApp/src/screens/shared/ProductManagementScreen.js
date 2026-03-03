/**
 * ProductManagementScreen
 * Manage products for sellers and admins
 * 
 * Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  SafeAreaView,
  RefreshControl,
  TextInput,
  Modal,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import { EmptyProducts, EmptySearch } from '../../components/common/EmptyState';
import {
  colors,
  spacing,
  fontSize,
  borderRadius,
  shadows,
  fontWeight,
  typography,
} from '../../styles/theme';

/**
 * Filter products by search query
 * Exported for property testing
 */
export const filterProductsByQuery = (products, query) => {
  if (!query || !query.trim()) return products;
  const normalizedQuery = query.toLowerCase().trim();
  return products.filter(product =>
    product.name?.toLowerCase().includes(normalizedQuery) ||
    product.category?.toLowerCase().includes(normalizedQuery) ||
    product.brand?.toLowerCase().includes(normalizedQuery)
  );
};

/**
 * Get stock status info
 */
const getStockStatus = (stock) => {
  if (stock === 0) {
    return { label: 'Out of Stock', color: colors.error, bgColor: colors.errorLighter };
  }
  if (stock <= 5) {
    return { label: 'Low Stock', color: colors.warning, bgColor: colors.warningLighter };
  }
  return { label: 'In Stock', color: colors.success, bgColor: colors.successLighter };
};

export default function ProductManagementScreen({ navigation, route }) {
  const { isAdmin } = route.params || {};
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  // Bulk operations state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [bulkModalVisible, setBulkModalVisible] = useState(false);
  const [bulkTab, setBulkTab] = useState('discount'); // 'discount' | 'price' | 'remove'
  const [bulkDiscountType, setBulkDiscountType] = useState('percentage');
  const [bulkDiscountValue, setBulkDiscountValue] = useState('');
  const [bulkPriceType, setBulkPriceType] = useState('percentage');
  const [bulkPriceValue, setBulkPriceValue] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    try {
      const endpoint = isAdmin ? '/api/products/get-products' : '/api/products/get-seller-products';
      const response = await api.get(endpoint);
      setProducts(response.data || []);
    } catch (error) {
      Alert.alert('Error', 'Failed to fetch products');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchProducts();
  }, [isAdmin]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const deleteProduct = useCallback((productId, productName) => {
    Alert.alert(
      'Delete Product',
      `Are you sure you want to delete "${productName}"? This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(productId);
            try {
              await api.delete(`/api/products/delete/${productId}`);
              setProducts(prev => prev.filter(p => p._id !== productId));
              Alert.alert('Success', 'Product deleted successfully');
            } catch (error) {
              Alert.alert('Error', 'Failed to delete product');
            } finally {
              setDeletingId(null);
            }
          },
        },
      ]
    );
  }, []);

  const filteredProducts = filterProductsByQuery(products, searchQuery);

  // ─── Bulk Handlers ───────────────────────────────────────────────────────────
  const handleToggleSelectMode = useCallback(() => {
    setSelectMode(prev => !prev);
    setSelectedProducts([]);
  }, []);

  const handleSelectProduct = useCallback((product) => {
    setSelectedProducts(prev => {
      const exists = prev.find(p => p._id === product._id);
      return exists ? prev.filter(p => p._id !== product._id) : [...prev, product];
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(prev =>
      prev.length === filteredProducts.length ? [] : [...filteredProducts]
    );
  }, [filteredProducts]);

  const exitBulkMode = () => {
    setBulkModalVisible(false);
    setSelectMode(false);
    setSelectedProducts([]);
    setBulkDiscountValue('');
    setBulkPriceValue('');
  };

  const handleBulkDiscount = async () => {
    if (!bulkDiscountValue || isNaN(Number(bulkDiscountValue)) || Number(bulkDiscountValue) < 0) {
      Alert.alert('Error', 'Please enter a valid discount value');
      return;
    }
    setBulkLoading(true);
    try {
      const productIds = selectedProducts.map(p => p._id);
      const res = await api.post('/api/products/bulk-discount', {
        productIds,
        discountType: bulkDiscountType,
        discountValue: Number(bulkDiscountValue),
      });
      Alert.alert('Success', res.data.msg || 'Bulk discount applied!');
      exitBulkMode();
      fetchProducts();
    } catch (error) {
      Alert.alert('Error', error.response?.data?.msg || 'Failed to apply bulk discount');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkPriceUpdate = async () => {
    if (!bulkPriceValue || isNaN(Number(bulkPriceValue))) {
      Alert.alert('Error', 'Please enter a valid price value');
      return;
    }
    setBulkLoading(true);
    try {
      const productIds = selectedProducts.map(p => p._id);
      const res = await api.post('/api/products/bulk-price-update', {
        productIds,
        updateType: bulkPriceType,
        value: Number(bulkPriceValue),
      });
      Alert.alert('Success', res.data.msg || 'Prices updated!');
      exitBulkMode();
      fetchProducts();
    } catch (error) {
      Alert.alert('Error', error.response?.data?.msg || 'Failed to update prices');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleRemoveDiscount = async () => {
    Alert.alert(
      'Remove Discounts',
      `Remove discounts from ${selectedProducts.length} selected product(s)?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive', onPress: async () => {
            setBulkLoading(true);
            try {
              const productIds = selectedProducts.map(p => p._id);
              const res = await api.post('/api/products/remove-discount', { productIds });
              Alert.alert('Success', res.data.msg || 'Discounts removed!');
              exitBulkMode();
              fetchProducts();
            } catch (error) {
              Alert.alert('Error', error.response?.data?.msg || 'Failed to remove discounts');
            } finally {
              setBulkLoading(false);
            }
          },
        },
      ]
    );
  };
  // ─────────────────────────────────────────────────────────────────────────────

  const renderProduct = useCallback(({ item }) => {
    const stockStatus = getStockStatus(item.stock);
    const isDeleting = deletingId === item._id;
    const isSelected = selectedProducts.some(p => p._id === item._id);

    return (
      <TouchableOpacity
        style={[
          styles.productCard,
          isDeleting && styles.productCardDeleting,
          isSelected && styles.productCardSelected,
        ]}
        onPress={() => {
          if (selectMode) { handleSelectProduct(item); return; }
          navigation.navigate('ProductForm', { product: item, isAdmin });
        }}
        onLongPress={() => { if (!selectMode) { setSelectMode(true); handleSelectProduct(item); } }}
        activeOpacity={0.7}
        disabled={isDeleting}
      >
        {/* Selection Checkbox */}
        {selectMode && (
          <View style={styles.checkboxContainer}>
            <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
              {isSelected && <Ionicons name="checkmark" size={14} color={colors.white} />}
            </View>
          </View>
        )}

        {/* Product Image */}
        <View style={styles.imageContainer}>
          {item.images?.[0] ? (
            <Image
              source={{ uri: item.images[0] }}
              style={styles.productImage}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
            />
          ) : (
            <View style={[styles.productImage, styles.imagePlaceholder]}>
              <Ionicons name="cube-outline" size={24} color={colors.grayLight} />
            </View>
          )}
        </View>

        {/* Product Info */}
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={2}>{item.name}</Text>
          
          <View style={styles.priceRow}>
            <Text style={styles.productPrice}>
              ${item.discountedPrice || item.price}
            </Text>
            {item.discountedPrice && item.discountedPrice < item.price && (
              <Text style={styles.originalPrice}>${item.price}</Text>
            )}
          </View>

          <View style={styles.metaRow}>
            <View style={[styles.stockBadge, { backgroundColor: stockStatus.bgColor }]}>
              <Text style={[styles.stockText, { color: stockStatus.color }]}>
                {item.stock} in stock
              </Text>
            </View>
            {item.category && (
              <Text style={styles.categoryText} numberOfLines={1}>
                {item.category}
              </Text>
            )}
          </View>
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => navigation.navigate('ProductForm', { product: item, isAdmin })}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="create-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => deleteProduct(item._id, item.name)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            disabled={isDeleting}
          >
            <Ionicons 
              name="trash-outline" 
              size={22} 
              color={isDeleting ? colors.grayLight : colors.error} 
            />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  }, [navigation, isAdmin, deletingId, deleteProduct, selectMode, selectedProducts, handleSelectProduct]);

  const renderHeader = useCallback(() => (
    <View style={styles.headerContainer}>
      {selectMode ? (
        /* ─── Bulk Action Bar ─── */
        <View style={styles.bulkBar}>
          <TouchableOpacity style={styles.bulkCancelBtn} onPress={handleToggleSelectMode}>
            <Ionicons name="close" size={20} color={colors.textSecondary} />
            <Text style={styles.bulkCancelText}>Cancel</Text>
          </TouchableOpacity>

          <Text style={styles.bulkCountText}>
            {selectedProducts.length} selected
          </Text>

          <View style={styles.bulkBarRight}>
            <TouchableOpacity style={styles.bulkSelectAllBtn} onPress={handleSelectAll}>
              <Text style={styles.bulkSelectAllText}>
                {selectedProducts.length === filteredProducts.length ? 'Deselect All' : 'All'}
              </Text>
            </TouchableOpacity>
            {selectedProducts.length > 0 && (
              <TouchableOpacity
                style={styles.bulkActionsBtn}
                onPress={() => setBulkModalVisible(true)}
              >
                <Ionicons name="flash" size={16} color={colors.white} />
                <Text style={styles.bulkActionsBtnText}>Actions</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ) : (
        /* ─── Normal Search Bar ─── */
        <>
          <View style={[
            styles.searchContainer,
            searchQuery.length > 0 && styles.searchContainerActive,
          ]}>
            <Ionicons name="search" size={20} color={colors.gray} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search products..."
              placeholderTextColor={colors.grayLight}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={handleClearSearch} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close-circle" size={20} color={colors.gray} />
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.resultsRow}>
            <Text style={styles.resultsText}>
              {searchQuery
                ? <><Text style={styles.resultsCount}>{filteredProducts.length}</Text> results</>
                : <><Text style={styles.resultsCount}>{filteredProducts.length}</Text> products total</>
              }
            </Text>
            <TouchableOpacity style={styles.selectModeBtn} onPress={handleToggleSelectMode}>
              <Ionicons name="checkmark-circle-outline" size={16} color={colors.primary} />
              <Text style={styles.selectModeBtnText}>Select</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  ), [searchQuery, filteredProducts.length, handleClearSearch, selectMode, selectedProducts.length, handleToggleSelectMode, handleSelectAll]);

  const renderEmptyComponent = useCallback(() => {
    if (searchQuery) {
      return <EmptySearch query={searchQuery} onClear={handleClearSearch} />;
    }
    return (
      <EmptyProducts 
        onAdd={() => navigation.navigate('ProductForm', { isAdmin })} 
      />
    );
  }, [searchQuery, handleClearSearch, navigation, isAdmin]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Loader fullScreen message="Loading products..." />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={filteredProducts}
        renderItem={renderProduct}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmptyComponent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
            tintColor={colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      />

      {/* FAB — hidden in select mode */}
      {!selectMode && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => navigation.navigate('ProductForm', { isAdmin })}
          activeOpacity={0.8}
        >
          <Ionicons name="add" size={28} color={colors.white} />
        </TouchableOpacity>
      )}

      {/* ─── Bulk Operations Modal ─── */}
      <Modal
        visible={bulkModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setBulkModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.bulkModalOverlay}
          activeOpacity={1}
          onPress={() => setBulkModalVisible(false)}
        />
        <View style={styles.bulkModalSheet}>
          {/* Handle */}
          <View style={styles.bulkModalHandle} />

          {/* Title row */}
          <View style={styles.bulkModalTitleRow}>
            <Text style={styles.bulkModalTitle}>
              Bulk Actions · {selectedProducts.length} product{selectedProducts.length !== 1 ? 's' : ''}
            </Text>
            <TouchableOpacity onPress={() => setBulkModalVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Tab Row */}
          <View style={styles.bulkTabRow}>
            {[
              { key: 'discount', label: 'Discount', icon: 'pricetag-outline' },
              { key: 'price', label: 'Price', icon: 'cash-outline' },
              { key: 'remove', label: 'Remove', icon: 'trash-outline' },
            ].map(tab => (
              <TouchableOpacity
                key={tab.key}
                style={[styles.bulkTab, bulkTab === tab.key && styles.bulkTabActive]}
                onPress={() => setBulkTab(tab.key)}
              >
                <Ionicons
                  name={tab.icon}
                  size={16}
                  color={bulkTab === tab.key ? colors.primary : colors.textSecondary}
                />
                <Text style={[styles.bulkTabText, bulkTab === tab.key && styles.bulkTabTextActive]}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <ScrollView style={styles.bulkModalBody} showsVerticalScrollIndicator={false}>
            {/* ── Discount Tab ── */}
            {bulkTab === 'discount' && (
              <View>
                <Text style={styles.bulkSectionLabel}>Discount Type</Text>
                <View style={styles.bulkTypeRow}>
                  {[
                    { key: 'percentage', label: '% Percentage', icon: 'percent-outline' },
                    { key: 'fixed', label: '$ Fixed Amount', icon: 'remove-circle-outline' },
                  ].map(t => (
                    <TouchableOpacity
                      key={t.key}
                      style={[styles.bulkTypeCard, bulkDiscountType === t.key && styles.bulkTypeCardActive]}
                      onPress={() => setBulkDiscountType(t.key)}
                    >
                      <Ionicons name={t.icon} size={18} color={bulkDiscountType === t.key ? colors.primary : colors.textSecondary} />
                      <Text style={[styles.bulkTypeLabel, bulkDiscountType === t.key && styles.bulkTypeLabelActive]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.bulkSectionLabel}>
                  {bulkDiscountType === 'percentage' ? 'Discount Percentage (%)' : 'Discount Amount ($)'}
                </Text>
                <View style={styles.bulkInputRow}>
                  <View style={styles.bulkInputPrefix}>
                    <Text style={styles.bulkInputPrefixText}>{bulkDiscountType === 'percentage' ? '%' : '$'}</Text>
                  </View>
                  <TextInput
                    style={styles.bulkInput}
                    placeholder="e.g. 20"
                    placeholderTextColor={colors.grayLight}
                    keyboardType="numeric"
                    value={bulkDiscountValue}
                    onChangeText={setBulkDiscountValue}
                  />
                </View>
                <TouchableOpacity
                  style={[styles.bulkSubmitBtn, bulkLoading && styles.bulkSubmitBtnDisabled]}
                  onPress={handleBulkDiscount}
                  disabled={bulkLoading}
                >
                  {bulkLoading ? <ActivityIndicator color={colors.white} size="small" /> : (
                    <>
                      <Ionicons name="pricetag" size={18} color={colors.white} />
                      <Text style={styles.bulkSubmitBtnText}>Apply Discount</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* ── Price Tab ── */}
            {bulkTab === 'price' && (
              <View>
                <Text style={styles.bulkSectionLabel}>Update Type</Text>
                <View style={styles.bulkTypeRow}>
                  {[
                    { key: 'percentage', label: '% Change', icon: 'trending-up-outline' },
                    { key: 'fixed', label: '$ Change', icon: 'add-circle-outline' },
                    { key: 'set', label: 'Set Price', icon: 'create-outline' },
                  ].map(t => (
                    <TouchableOpacity
                      key={t.key}
                      style={[styles.bulkTypeCardSm, bulkPriceType === t.key && styles.bulkTypeCardActive]}
                      onPress={() => setBulkPriceType(t.key)}
                    >
                      <Ionicons name={t.icon} size={16} color={bulkPriceType === t.key ? colors.primary : colors.textSecondary} />
                      <Text style={[styles.bulkTypeLabel, bulkPriceType === t.key && styles.bulkTypeLabelActive, { fontSize: 12 }]}>
                        {t.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.bulkSectionLabel}>
                  {bulkPriceType === 'set' ? 'New Price ($)' : bulkPriceType === 'percentage' ? 'Percentage Change (use − for decrease)' : 'Amount Change (use − for decrease)'}
                </Text>
                <View style={styles.bulkInputRow}>
                  <View style={styles.bulkInputPrefix}>
                    <Text style={styles.bulkInputPrefixText}>{bulkPriceType === 'percentage' ? '%' : '$'}</Text>
                  </View>
                  <TextInput
                    style={styles.bulkInput}
                    placeholder={bulkPriceType === 'set' ? 'e.g. 29.99' : 'e.g. 10 or -10'}
                    placeholderTextColor={colors.grayLight}
                    keyboardType="numeric"
                    value={bulkPriceValue}
                    onChangeText={setBulkPriceValue}
                  />
                </View>
                <TouchableOpacity
                  style={[styles.bulkSubmitBtn, { backgroundColor: colors.success }, bulkLoading && styles.bulkSubmitBtnDisabled]}
                  onPress={handleBulkPriceUpdate}
                  disabled={bulkLoading}
                >
                  {bulkLoading ? <ActivityIndicator color={colors.white} size="small" /> : (
                    <>
                      <Ionicons name="cash" size={18} color={colors.white} />
                      <Text style={styles.bulkSubmitBtnText}>Update Prices</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* ── Remove Discount Tab ── */}
            {bulkTab === 'remove' && (
              <View style={styles.bulkRemoveContainer}>
                <View style={styles.bulkRemoveIconWrap}>
                  <Ionicons name="pricetag" size={40} color={colors.error} />
                </View>
                <Text style={styles.bulkRemoveTitle}>Remove Discounts</Text>
                <Text style={styles.bulkRemoveSubtitle}>
                  This will reset discounted prices for {selectedProducts.length} selected product{selectedProducts.length !== 1 ? 's' : ''} to their original prices.
                </Text>
                <TouchableOpacity
                  style={[styles.bulkSubmitBtn, { backgroundColor: colors.error }, bulkLoading && styles.bulkSubmitBtnDisabled]}
                  onPress={handleRemoveDiscount}
                  disabled={bulkLoading}
                >
                  {bulkLoading ? <ActivityIndicator color={colors.white} size="small" /> : (
                    <>
                      <Ionicons name="trash" size={18} color={colors.white} />
                      <Text style={styles.bulkSubmitBtnText}>Remove All Discounts</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Header
  headerContainer: {
    backgroundColor: colors.white,
    padding: spacing.lg,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.light,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.md,
    height: 48,
    borderWidth: 2,
    borderColor: colors.light,
  },
  searchContainerActive: {
    borderColor: colors.primary,
    backgroundColor: colors.white,
  },
  searchInput: {
    flex: 1,
    marginLeft: spacing.sm,
    fontSize: fontSize.md,
    color: colors.text,
  },
  resultsRow: {
    marginTop: spacing.md,
  },
  resultsText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
  },
  resultsCount: {
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  // List
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: 100,
    flexGrow: 1,
  },
  // Product Card
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: borderRadius.xl,
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.light,
  },
  productCardDeleting: {
    opacity: 0.5,
  },
  productCardSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}08`,
  },
  // Selection checkbox
  checkboxContainer: {
    marginRight: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.grayLight,
    backgroundColor: colors.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  imageContainer: {
    marginRight: spacing.md,
  },
  productImage: {
    width: 70,
    height: 70,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.lighter,
  },
  imagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  productInfo: {
    flex: 1,
  },
  productName: {
    ...typography.bodySemibold,
    marginBottom: spacing.xs,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  productPrice: {
    ...typography.bodySemibold,
    color: colors.primary,
  },
  originalPrice: {
    ...typography.bodySmall,
    color: colors.grayLight,
    textDecorationLine: 'line-through',
    marginLeft: spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  stockBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  stockText: {
    ...typography.caption,
    fontWeight: fontWeight.medium,
  },
  categoryText: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  // Actions
  actions: {
    flexDirection: 'column',
    gap: spacing.sm,
  },
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.lighter,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // FAB
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.lg,
  },

  // ── Bulk Header Bar ──
  bulkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  bulkCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  bulkCancelText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  bulkCountText: {
    ...typography.bodySemibold,
    color: colors.text,
  },
  bulkBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bulkSelectAllBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.md,
    backgroundColor: colors.lighter,
  },
  bulkSelectAllText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  bulkActionsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
  },
  bulkActionsBtnText: {
    ...typography.bodySmall,
    color: colors.white,
    fontWeight: fontWeight.semibold,
  },
  // Select mode toggle in normal header
  selectModeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  selectModeBtnText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },

  // ── Bulk Modal ──
  bulkModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  bulkModalSheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 40,
    maxHeight: '80%',
    ...shadows.lg,
  },
  bulkModalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.lighter,
    alignSelf: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  bulkModalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.light,
  },
  bulkModalTitle: {
    ...typography.h4,
    color: colors.text,
  },
  bulkModalBody: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  bulkTabRow: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    backgroundColor: colors.lighter,
    borderRadius: borderRadius.xl,
    padding: 4,
  },
  bulkTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
  },
  bulkTabActive: {
    backgroundColor: colors.white,
    ...shadows.sm,
  },
  bulkTabText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  bulkTabTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  bulkSectionLabel: {
    ...typography.bodySmall,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  bulkTypeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  bulkTypeCard: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: colors.light,
    backgroundColor: colors.white,
  },
  bulkTypeCardSm: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: colors.light,
    backgroundColor: colors.white,
  },
  bulkTypeCardActive: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}0D`,
  },
  bulkTypeLabel: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    fontWeight: fontWeight.medium,
  },
  bulkTypeLabelActive: {
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  bulkInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.light,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  bulkInputPrefix: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.lighter,
    borderRightWidth: 2,
    borderRightColor: colors.light,
  },
  bulkInputPrefixText: {
    ...typography.bodySemibold,
    color: colors.textSecondary,
  },
  bulkInput: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
  },
  bulkSubmitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    marginBottom: spacing.lg,
  },
  bulkSubmitBtnDisabled: {
    opacity: 0.6,
  },
  bulkSubmitBtnText: {
    ...typography.bodySemibold,
    color: colors.white,
  },
  // Remove discount tab
  bulkRemoveContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  bulkRemoveIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: `${colors.error}15`,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  bulkRemoveTitle: {
    ...typography.h3,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  bulkRemoveSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 22,
  },
});
