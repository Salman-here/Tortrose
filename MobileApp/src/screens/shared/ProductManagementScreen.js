/**
 * ProductManagementScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Alert,
  RefreshControl, TextInput, Modal, ScrollView, ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import { EmptyProducts, EmptySearch } from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography, glass,
} from '../../styles/theme';

export const filterProductsByQuery = (products, query) => {
  if (!query?.trim()) return products;
  const q = query.toLowerCase().trim();
  return products.filter(p => p.name?.toLowerCase().includes(q) || p.category?.toLowerCase().includes(q) || p.brand?.toLowerCase().includes(q));
};

const getStockStatus = (stock) => {
  if (stock === 0) return { label: 'Out of Stock', color: colors.error };
  if (stock <= 5) return { label: 'Low Stock', color: colors.warning };
  return { label: 'In Stock', color: colors.success };
};

export default function ProductManagementScreen({ navigation, route }) {
  const { isAdmin } = route.params || {};
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
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

  useEffect(() => { fetchProducts(); }, []);

  const fetchProducts = async () => {
    try {
      const endpoint = isAdmin ? '/api/products/get-products' : '/api/products/get-seller-products';
      const res = await api.get(endpoint);
      setProducts(res.data || []);
    } catch (e) { Alert.alert('Error', 'Failed to fetch products'); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchProducts(); }, [isAdmin]);

  const deleteProduct = useCallback((id, name) => {
    Alert.alert('Delete', `Delete "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        setDeletingId(id);
        try { await api.delete(`/api/products/delete/${id}`); setProducts(prev => prev.filter(p => p._id !== id)); }
        catch (e) { Alert.alert('Error', 'Failed to delete'); }
        finally { setDeletingId(null); }
      }},
    ]);
  }, []);

  const filteredProducts = filterProductsByQuery(products, searchQuery);

  const handleSelectProduct = useCallback((product) => {
    setSelectedProducts(prev => prev.find(p => p._id === product._id) ? prev.filter(p => p._id !== product._id) : [...prev, product]);
  }, []);

  const exitBulkMode = () => { setBulkModalVisible(false); setSelectMode(false); setSelectedProducts([]); setBulkDiscountValue(''); setBulkPriceValue(''); };

  const handleBulkDiscount = async () => {
    if (!bulkDiscountValue || isNaN(Number(bulkDiscountValue))) { Alert.alert('Error', 'Enter a valid value'); return; }
    setBulkLoading(true);
    try { await api.post('/api/products/bulk-discount', { productIds: selectedProducts.map(p => p._id), discountType: bulkDiscountType, discountValue: Number(bulkDiscountValue) }); exitBulkMode(); fetchProducts(); }
    catch (e) { Alert.alert('Error', e.response?.data?.msg || 'Failed'); }
    finally { setBulkLoading(false); }
  };

  const renderProduct = useCallback(({ item }) => {
    const stockStatus = getStockStatus(item.stock);
    const isDeleting = deletingId === item._id;
    const isSelected = selectedProducts.some(p => p._id === item._id);

    return (
      <GlassPanel variant="card" style={[styles.productCard, isSelected && styles.productCardSelected]}>
        <TouchableOpacity style={styles.productCardInner}
          onPress={() => { if (selectMode) { handleSelectProduct(item); return; } navigation.navigate('ProductForm', { product: item, isAdmin }); }}
          onLongPress={() => { if (!selectMode) { setSelectMode(true); handleSelectProduct(item); } }} activeOpacity={0.7} disabled={isDeleting}>
          {selectMode && (
            <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
              {isSelected && <Ionicons name="checkmark" size={14} color="white" />}
            </View>
          )}
          <View style={styles.imageContainer}>
            {item.images?.[0] ? (
              <Image source={{ uri: item.images[0] }} style={styles.productImage} contentFit="cover" />
            ) : (
              <View style={[styles.productImage, styles.imagePlaceholder]}><Ionicons name="cube-outline" size={24} color={colors.textSecondary} /></View>
            )}
          </View>
          <View style={styles.productInfo}>
            <Text style={styles.productName} numberOfLines={2}>{item.name}</Text>
            <View style={styles.priceRow}>
              <Text style={styles.productPrice}>${item.discountedPrice || item.price}</Text>
              {item.discountedPrice && item.discountedPrice < item.price && <Text style={styles.originalPrice}>${item.price}</Text>}
            </View>
            <View style={[styles.stockBadge, { backgroundColor: stockStatus.color + '20' }]}>
              <Text style={[styles.stockText, { color: stockStatus.color }]}>{item.stock} in stock</Text>
            </View>
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionButton} onPress={() => navigation.navigate('ProductForm', { product: item, isAdmin })}>
              <Ionicons name="create-outline" size={22} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={() => deleteProduct(item._id, item.name)} disabled={isDeleting}>
              <Ionicons name="trash-outline" size={22} color={isDeleting ? colors.textSecondary : colors.error} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </GlassPanel>
    );
  }, [navigation, isAdmin, deletingId, deleteProduct, selectMode, selectedProducts, handleSelectProduct]);

  const renderHeader = useCallback(() => (
    <View style={styles.headerContainer}>
      {selectMode ? (
        <GlassPanel variant="floating" style={styles.bulkBar}>
          <TouchableOpacity onPress={() => { setSelectMode(false); setSelectedProducts([]); }}><Ionicons name="close" size={20} color={colors.text} /></TouchableOpacity>
          <Text style={styles.bulkCountText}>{selectedProducts.length} selected</Text>
          {selectedProducts.length > 0 && (
            <TouchableOpacity style={styles.bulkActionsBtn} onPress={() => setBulkModalVisible(true)}>
              <Ionicons name="flash" size={16} color="white" /><Text style={styles.bulkActionsBtnText}>Actions</Text>
            </TouchableOpacity>
          )}
        </GlassPanel>
      ) : (
        <>
          <View style={styles.searchContainer}>
            <Ionicons name="search" size={20} color={colors.textSecondary} />
            <TextInput style={styles.searchInput} placeholder="Search products..." placeholderTextColor={colors.textSecondary} value={searchQuery} onChangeText={setSearchQuery} />
            {searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><Ionicons name="close-circle" size={20} color={colors.textSecondary} /></TouchableOpacity>}
          </View>
          <View style={styles.resultsRow}>
            <Text style={styles.resultsText}><Text style={styles.resultsCount}>{filteredProducts.length}</Text> products</Text>
            <TouchableOpacity style={styles.selectModeBtn} onPress={() => setSelectMode(true)}>
              <Ionicons name="checkmark-circle-outline" size={16} color={colors.primary} /><Text style={styles.selectModeBtnText}>Select</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  ), [searchQuery, filteredProducts.length, selectMode, selectedProducts.length]);

  if (loading) return <GlassBackground><Loader fullScreen message="Loading products..." /></GlassBackground>;

  return (
    <GlassBackground>
      <FlatList data={filteredProducts} renderItem={renderProduct} keyExtractor={i => i._id}
        contentContainerStyle={styles.list} ListHeaderComponent={renderHeader}
        ListEmptyComponent={searchQuery ? <EmptySearch query={searchQuery} onClear={() => setSearchQuery('')} /> : <EmptyProducts onAdd={() => navigation.navigate('ProductForm', { isAdmin })} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        showsVerticalScrollIndicator={false} />

      {!selectMode && (
        <TouchableOpacity style={styles.fab} onPress={() => navigation.navigate('ProductForm', { isAdmin })} activeOpacity={0.8}>
          <Ionicons name="add" size={28} color="white" />
        </TouchableOpacity>
      )}

      <Modal visible={bulkModalVisible} transparent animationType="slide" onRequestClose={() => setBulkModalVisible(false)}>
        <TouchableOpacity style={styles.bulkModalOverlay} activeOpacity={1} onPress={() => setBulkModalVisible(false)} />
        <GlassPanel variant="strong" style={styles.bulkModalSheet}>
          <View style={styles.bulkModalTitleRow}>
            <Text style={styles.bulkModalTitle}>Bulk Actions · {selectedProducts.length} products</Text>
            <TouchableOpacity onPress={() => setBulkModalVisible(false)}><Ionicons name="close" size={22} color={colors.text} /></TouchableOpacity>
          </View>
          <View style={styles.bulkTabRow}>
            {[{ key: 'discount', label: 'Discount', icon: 'pricetag-outline' }, { key: 'price', label: 'Price', icon: 'cash-outline' }].map(tab => (
              <TouchableOpacity key={tab.key} style={[styles.bulkTab, bulkTab === tab.key && styles.bulkTabActive]} onPress={() => setBulkTab(tab.key)}>
                <Ionicons name={tab.icon} size={16} color={bulkTab === tab.key ? 'white' : colors.textSecondary} />
                <Text style={[styles.bulkTabText, bulkTab === tab.key && { color: 'white' }]}>{tab.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {bulkTab === 'discount' && (
            <View style={{ padding: spacing.lg }}>
              <Text style={styles.label}>Discount Value</Text>
              <TextInput style={styles.input} value={bulkDiscountValue} onChangeText={setBulkDiscountValue} keyboardType="decimal-pad" placeholder="e.g. 10" placeholderTextColor={colors.textSecondary} />
              <TouchableOpacity style={[styles.submitButton, bulkLoading && { opacity: 0.6 }]} onPress={handleBulkDiscount} disabled={bulkLoading}>
                {bulkLoading ? <ActivityIndicator color="white" /> : <Text style={styles.submitButtonText}>Apply Discount</Text>}
              </TouchableOpacity>
            </View>
          )}
        </GlassPanel>
      </Modal>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  headerContainer: { paddingBottom: spacing.sm },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, marginHorizontal: spacing.lg, marginTop: spacing.lg, marginBottom: spacing.md, height: 44, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  searchInput: { flex: 1, marginLeft: spacing.sm, fontSize: fontSize.md, color: colors.text },
  resultsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  resultsText: { ...typography.bodySmall, color: colors.textSecondary },
  resultsCount: { fontWeight: fontWeight.bold, color: colors.text },
  selectModeBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  selectModeBtnText: { ...typography.bodySmall, color: colors.primary },
  bulkBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', margin: spacing.lg, padding: spacing.md },
  bulkCountText: { ...typography.bodySemibold, color: colors.text },
  bulkActionsBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, backgroundColor: colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg },
  bulkActionsBtnText: { ...typography.bodySmall, color: 'white', fontWeight: fontWeight.semibold },
  list: { paddingHorizontal: spacing.md, paddingBottom: 100, flexGrow: 1 },
  productCard: { marginBottom: spacing.sm },
  productCardSelected: { borderWidth: 2, borderColor: colors.primary },
  productCardInner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  imageContainer: { marginRight: spacing.md },
  productImage: { width: 60, height: 60, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.06)' },
  imagePlaceholder: { justifyContent: 'center', alignItems: 'center' },
  productInfo: { flex: 1 },
  productName: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.xs },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  productPrice: { ...typography.bodySemibold, color: colors.primary },
  originalPrice: { ...typography.bodySmall, color: colors.textSecondary, textDecorationLine: 'line-through' },
  stockBadge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: borderRadius.md },
  stockText: { ...typography.caption, fontWeight: fontWeight.semibold },
  actions: { gap: spacing.sm },
  actionButton: { width: 36, height: 36, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  fab: { position: 'absolute', right: spacing.lg, bottom: 100, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, justifyContent: 'center', alignItems: 'center', elevation: 8, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
  bulkModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  bulkModalSheet: { position: 'absolute', bottom: 0, left: 0, right: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: spacing.lg },
  bulkModalTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  bulkModalTitle: { ...typography.h4, color: colors.text },
  bulkTabRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  bulkTab: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, backgroundColor: 'rgba(255,255,255,0.08)' },
  bulkTabActive: { backgroundColor: colors.primary },
  bulkTabText: { ...typography.bodySmall, color: colors.textSecondary },
  label: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.sm },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, fontSize: fontSize.md, color: colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', marginBottom: spacing.md },
  submitButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', backgroundColor: colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.md },
  submitButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: 'white' },
});
