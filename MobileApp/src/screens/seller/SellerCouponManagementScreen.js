/**
 * SellerCouponManagementScreen — Full coupon CRUD + analytics
 * Liquid Glass Design
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
  Modal, ScrollView, Alert, ActivityIndicator, RefreshControl, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Feedback from '../../utils/feedback';
import api from '../../config/api';
import { useCurrency } from '../../contexts/CurrencyContext';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import Loader from '../../components/common/Loader';
import CouponBarChart, { MetricRow } from '../../components/common/CouponBarChart';
import { spacing, fontSize, fontWeight, borderRadius, shadows } from '../../styles/theme';
import { useTheme } from '../../contexts/ThemeContext';

export default function SellerCouponManagementScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currency, formatPrice, getCurrencySymbol } = useCurrency();
  const [coupons, setCoupons] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('manage');
  const [analyticsData, setAnalyticsData] = useState(null);

  const [form, setForm] = useState({
    code: '', discountType: 'percentage', discountValue: '', applicableTo: 'all',
    applicableProducts: [], maxUses: '', maxUsesPerUser: '1', minOrderAmount: '',
    maxDiscountAmount: '', expiryDate: '', description: '',
  });

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    try {
      const [couponRes, productRes, analyticsRes] = await Promise.all([
        api.get('/api/coupons/seller'),
        api.get('/api/products/get-seller-products'),
        api.get(`/api/coupons/analytics?currency=${currency}`).catch(() => ({ data: null })),
      ]);
      setCoupons(couponRes.data?.coupons || []);
      setProducts(productRes.data?.products || productRes.data || []);
      setAnalyticsData(analyticsRes.data);
    } catch (err) {
      Alert.alert('Error', 'Failed to load coupons');
    } finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchAll(); }, []);

  const resetForm = () => {
    setForm({ code: '', discountType: 'percentage', discountValue: '', applicableTo: 'all', applicableProducts: [], maxUses: '', maxUsesPerUser: '1', minOrderAmount: '', maxDiscountAmount: '', expiryDate: '', description: '' });
    setEditingCoupon(null);
  };

  const handleSave = async () => {
    if (!form.code || !form.discountValue) {
      Feedback.show({ type: 'error', text1: 'Missing Fields', text2: 'Code and discount value are required' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        currency,
        discountValue: Number(form.discountValue),
        maxUses: form.maxUses ? Number(form.maxUses) : undefined,
        maxUsesPerUser: Number(form.maxUsesPerUser) || 1,
        minOrderAmount: form.minOrderAmount ? Number(form.minOrderAmount) : 0,
        maxDiscountAmount: form.maxDiscountAmount ? Number(form.maxDiscountAmount) : undefined,
      };
      if (editingCoupon) {
        await api.put(`/api/coupons/update/${editingCoupon._id}`, payload);
        Feedback.show({ type: 'success', text1: 'Updated!', text2: 'Coupon updated successfully' });
      } else {
        await api.post('/api/coupons/create', payload);
        Feedback.show({ type: 'success', text1: 'Created!', text2: 'Coupon created successfully' });
      }
      setShowForm(false); resetForm(); fetchAll();
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to save coupon' });
    } finally { setSaving(false); }
  };

  const handleDelete = (id) => {
    Alert.alert('Delete Coupon', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await api.delete(`/api/coupons/delete/${id}`); setCoupons(prev => prev.filter(c => c._id !== id)); Feedback.show({ type: 'success', text1: 'Deleted!' }); } catch { Alert.alert('Error', 'Failed to delete'); }
      }},
    ]);
  };

  const handleToggle = async (coupon) => {
    try {
      await api.patch(`/api/coupons/toggle/${coupon._id}`);
      setCoupons(prev => prev.map(c => c._id === coupon._id ? { ...c, isActive: !c.isActive } : c));
    } catch { Alert.alert('Error', 'Failed to toggle coupon'); }
  };

  const handleEdit = (coupon) => {
    setForm({
      code: coupon.code, discountType: coupon.discountType, discountValue: String(coupon.discountValue),
      applicableTo: coupon.applicableTo || 'all', applicableProducts: coupon.applicableProducts || [],
      maxUses: coupon.maxUses ? String(coupon.maxUses) : '', maxUsesPerUser: String(coupon.maxUsesPerUser || 1),
      minOrderAmount: coupon.minOrderAmount ? String(coupon.minOrderAmount) : '',
      maxDiscountAmount: coupon.maxDiscountAmount ? String(coupon.maxDiscountAmount) : '',
      expiryDate: coupon.expiryDate ? new Date(coupon.expiryDate).toISOString().split('T')[0] : '', description: coupon.description || '',
    });
    setEditingCoupon(coupon);
    setShowForm(true);
  };

  const renderCoupon = ({ item }) => {
    const isExpired = item.expiryDate && new Date(item.expiryDate) < new Date();
    return (
      <GlassPanel variant="card" style={styles.couponCard}>
        <View style={styles.couponHeader}>
          <View style={[styles.couponBadge, { backgroundColor: item.isActive && !isExpired ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)' }]}>
            <Text style={[styles.couponCode, { color: item.isActive && !isExpired ? palette.colors.success : palette.colors.error }]}>{item.code}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <TouchableOpacity onPress={() => handleEdit(item)}><Ionicons name="create-outline" size={20} color={palette.colors.primary} /></TouchableOpacity>
            <TouchableOpacity onPress={() => handleDelete(item._id)}><Ionicons name="trash-outline" size={20} color={palette.colors.error} /></TouchableOpacity>
          </View>
        </View>
        <Text style={styles.couponDiscount}>
          {item.discountType === 'percentage' ? `${item.discountValue}% off` : `${formatPrice(item.discountValue, { sourceCurrency: item.currency || currency })} off`}
        </Text>
        {item.description ? <Text style={styles.couponDesc} numberOfLines={2}>{item.description}</Text> : null}
        <View style={styles.couponMeta}>
          <Text style={styles.metaText}>Used: {item.usedCount || 0}{item.maxUses ? `/${item.maxUses}` : ''}</Text>
          {item.expiryDate && <Text style={[styles.metaText, isExpired && { color: palette.colors.error }]}>{isExpired ? 'Expired' : `Expires: ${new Date(item.expiryDate).toLocaleDateString()}`}</Text>}
        </View>
        <View style={styles.couponFooter}>
          <Text style={styles.metaText}>{item.applicableTo === 'all' ? 'All Products' : `${item.applicableProducts?.length || 0} Products`}</Text>
          <Switch value={item.isActive} onValueChange={() => handleToggle(item)} trackColor={{ false: palette.colors.grayLighter, true: palette.colors.primaryLight }} thumbColor={item.isActive ? palette.colors.primary : palette.colors.grayLight} />
        </View>
      </GlassPanel>
    );
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading coupons..." /></GlassBackground>;

  return (
    <GlassBackground>
      {/* Header */}
      <GlassPanel variant="floating" style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={20} color={palette.colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Coupons</Text>
          <Text style={styles.headerSub}>{coupons.length} total</Text>
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={() => { resetForm(); setShowForm(true); }}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </GlassPanel>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {['manage', 'analytics'].map(tab => (
          <TouchableOpacity key={tab} style={[styles.tab, activeTab === tab && styles.tabActive]} onPress={() => setActiveTab(tab)}>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab === 'manage' ? 'Manage' : 'Analytics'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {activeTab === 'manage' ? (
        <FlatList
          data={coupons}
          renderItem={renderCoupon}
          keyExtractor={item => item._id}
          contentContainerStyle={{ padding: spacing.md, paddingBottom: 100 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
          ListEmptyComponent={
            <GlassPanel variant="card" style={{ alignItems: 'center', padding: spacing.xxl }}>
              <Ionicons name="pricetag-outline" size={48} color="rgba(255,255,255,0.3)" />
              <Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.colors.text, marginTop: spacing.md }}>No Coupons</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary, marginTop: spacing.xs }}>Create your first coupon to attract customers</Text>
            </GlassPanel>
          }
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: 100 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.colors.primary} />}
        >
          {analyticsData?.summary || analyticsData?.analytics ? (
            <>
              {/* Summary Stats */}
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
                {[
                  { label: 'Total Coupons', value: analyticsData.summary?.totalCoupons ?? coupons.length, icon: 'pricetag', color: palette.colors.primary },
                  { label: 'Total Uses', value: analyticsData.summary?.totalUses ?? 0, icon: 'people', color: palette.colors.info },
                  { label: 'Discount Given', value: formatPrice(analyticsData.summary?.totalDiscountGiven ?? 0), icon: 'trending-down', color: palette.colors.warning },
                ].map((stat, i) => (
                  <GlassPanel key={i} variant="card" style={{ flex: 1, alignItems: 'center', padding: spacing.md }}>
                    <Ionicons name={stat.icon} size={22} color={stat.color} />
                    <Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.colors.text, marginTop: spacing.xs }} numberOfLines={1}>{stat.value}</Text>
                    <Text style={{ fontSize: 10, color: palette.colors.textSecondary, textAlign: 'center' }}>{stat.label}</Text>
                  </GlassPanel>
                ))}
              </View>

              {/* Revenue impact banner */}
              <GlassPanel variant="card" style={{ padding: spacing.md, marginBottom: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(16,185,129,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="cash" size={22} color={palette.colors.success} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary }}>Revenue from coupons</Text>
                  <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text }}>
                    {formatPrice(analyticsData.summary?.totalRevenueFromCoupons ?? 0)}
                  </Text>
                  {analyticsData.summary?.topCouponCode && (
                    <Text style={{ fontSize: 11, color: palette.colors.textSecondary, marginTop: 2 }}>
                      Top performer · <Text style={{ color: palette.colors.primary, fontWeight: fontWeight.bold }}>{analyticsData.summary.topCouponCode}</Text>
                    </Text>
                  )}
                </View>
              </GlassPanel>

              {/* Per-coupon analytics cards */}
              <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.text, marginBottom: spacing.sm, marginTop: spacing.sm }}>
                Per-Coupon Performance
              </Text>
              {(analyticsData.analytics || []).length === 0 ? (
                <GlassPanel variant="card" style={{ alignItems: 'center', padding: spacing.xl }}>
                  <Ionicons name="bar-chart-outline" size={40} color={palette.colors.textSecondary} />
                  <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.text, marginTop: spacing.sm }}>No usage yet</Text>
                  <Text style={{ fontSize: fontSize.xs, color: palette.colors.textSecondary, textAlign: 'center', marginTop: 4 }}>
                    Stats will appear once buyers start applying your coupons.
                  </Text>
                </GlassPanel>
              ) : (
                (analyticsData.analytics || []).map((c) => {
                  const isExpired = c.expiryDate && new Date(c.expiryDate) < new Date();
                  const conversion = c.maxUses ? Math.round((c.usedCount / c.maxUses) * 100) : null;
                  // Simple bar chart: distribution across uses, orders, unique users, avg order
                  const chartData = [c.usedCount || 0, c.ordersGenerated || 0, c.uniqueUsers || 0, Math.round(c.avgOrderValue || 0), Math.round(c.totalDiscount || 0), Math.round(c.totalRevenue || 0)];
                  const chartLabels = ['Uses', 'Ord', 'Usr', 'Avg', 'Disc', 'Rev'];
                  return (
                    <GlassPanel key={c._id} variant="card" style={{ padding: spacing.md, marginBottom: spacing.md }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                          <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.15)' }}>
                            <Text style={{ color: palette.colors.primary, fontWeight: fontWeight.bold, letterSpacing: 1 }}>{c.code}</Text>
                          </View>
                          <Text style={{ color: palette.colors.text, fontWeight: fontWeight.semibold, fontSize: fontSize.sm }}>
                            {c.discountType === 'percentage' ? `${c.discountValue}%` : formatPrice(c.discountValue, { sourceCurrency: c.currency || currency })} off
                          </Text>
                        </View>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: c.isActive && !isExpired ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)' }}>
                          <Text style={{ fontSize: 10, fontWeight: fontWeight.bold, color: c.isActive && !isExpired ? palette.colors.success : palette.colors.error }}>
                            {isExpired ? 'EXPIRED' : c.isActive ? 'ACTIVE' : 'PAUSED'}
                          </Text>
                        </View>
                      </View>

                      <MetricRow palette={palette} items={[
                        { label: 'Uses', value: `${c.usedCount}${c.maxUses ? `/${c.maxUses}` : ''}` },
                        { label: 'Orders', value: c.ordersGenerated || 0 },
                        { label: 'Buyers', value: c.uniqueUsers || 0 },
                        { label: 'Conv.', value: conversion !== null ? `${conversion}%` : '—' },
                      ]} />

                      <View style={{ height: 1, backgroundColor: palette.glass.borderSubtle, marginVertical: spacing.sm }} />

                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.xs }}>
                        <View>
                          <Text style={{ fontSize: 10, color: palette.colors.textSecondary }}>Revenue impact</Text>
                          <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.success }}>{formatPrice(c.totalRevenue || 0)}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ fontSize: 10, color: palette.colors.textSecondary }}>Discount given</Text>
                          <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.warning }}>-{formatPrice(c.totalDiscount || 0)}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ fontSize: 10, color: palette.colors.textSecondary }}>Avg order</Text>
                          <Text style={{ fontSize: fontSize.md, fontWeight: fontWeight.bold, color: palette.colors.text }}>{formatPrice(c.avgOrderValue || 0)}</Text>
                        </View>
                      </View>

                      <CouponBarChart
                        data={chartData}
                        labels={chartLabels}
                        height={90}
                        color={palette.colors.primary}
                        textColor={palette.colors.textSecondary}
                      />
                    </GlassPanel>
                  );
                })
              )}
            </>
          ) : (
            <GlassPanel variant="card" style={{ alignItems: 'center', padding: spacing.xxl }}>
              <Ionicons name="bar-chart-outline" size={48} color="rgba(255,255,255,0.3)" />
              <Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: palette.colors.text, marginTop: spacing.md }}>No Analytics Yet</Text>
              <Text style={{ fontSize: fontSize.sm, color: palette.colors.textSecondary }}>Analytics will appear once coupons are used</Text>
            </GlassPanel>
          )}
        </ScrollView>
      )}

      {/* Create/Edit Modal */}
      <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
        <View style={styles.modalOverlay}>
          <GlassPanel variant="strong" style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingCoupon ? 'Edit Coupon' : 'Create Coupon'}</Text>
              <TouchableOpacity onPress={() => { setShowForm(false); resetForm(); }}>
                <Ionicons name="close" size={24} color={palette.colors.text} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing.xl }}>
              <Text style={styles.fieldLabel}>Coupon Code *</Text>
              <TextInput style={styles.modalInput} value={form.code} onChangeText={v => setForm(p => ({ ...p, code: v.toUpperCase() }))} placeholder="SAVE20" placeholderTextColor={palette.colors.grayLight} autoCapitalize="characters" />

              <Text style={styles.fieldLabel}>Discount Type</Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
                {['percentage', 'fixed'].map(type => (
                  <TouchableOpacity key={type} style={[styles.typeBtn, form.discountType === type && styles.typeBtnActive]} onPress={() => setForm(p => ({ ...p, discountType: type }))}>
                    <Text style={[styles.typeBtnText, form.discountType === type && styles.typeBtnTextActive]}>{type === 'percentage' ? '% Percentage' : `${getCurrencySymbol()} Fixed`}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Discount Value *</Text>
              <TextInput style={styles.modalInput} value={form.discountValue} onChangeText={v => setForm(p => ({ ...p, discountValue: v }))} placeholder="20" placeholderTextColor={palette.colors.grayLight} keyboardType="numeric" />

              <Text style={styles.fieldLabel}>Applies To</Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
                {['all', 'selected'].map(scope => (
                  <TouchableOpacity key={scope} style={[styles.typeBtn, form.applicableTo === scope && styles.typeBtnActive]} onPress={() => setForm(p => ({ ...p, applicableTo: scope }))}>
                    <Text style={[styles.typeBtnText, form.applicableTo === scope && styles.typeBtnTextActive]}>{scope === 'all' ? 'All Products' : 'Selected'}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {form.applicableTo === 'selected' && (
                <View style={{ marginBottom: spacing.md }}>
                  <Text style={[styles.fieldLabel, { marginBottom: spacing.xs }]}>Select Products ({form.applicableProducts.length})</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {products.map(p => {
                      const selected = form.applicableProducts.includes(p._id);
                      return (
                        <TouchableOpacity key={p._id} style={[styles.productChip, selected && styles.productChipSelected]}
                          onPress={() => setForm(prev => ({ ...prev, applicableProducts: selected ? prev.applicableProducts.filter(id => id !== p._id) : [...prev.applicableProducts, p._id] }))}>
                          <Text style={[styles.productChipText, selected && { color: '#fff' }]} numberOfLines={1}>{p.name}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Max Uses</Text>
                  <TextInput style={styles.modalInput} value={form.maxUses} onChangeText={v => setForm(p => ({ ...p, maxUses: v }))} placeholder="Unlimited" placeholderTextColor={palette.colors.grayLight} keyboardType="numeric" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Per User</Text>
                  <TextInput style={styles.modalInput} value={form.maxUsesPerUser} onChangeText={v => setForm(p => ({ ...p, maxUsesPerUser: v }))} placeholder="1" placeholderTextColor={palette.colors.grayLight} keyboardType="numeric" />
                </View>
              </View>

              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Min Order</Text>
                  <TextInput style={styles.modalInput} value={form.minOrderAmount} onChangeText={v => setForm(p => ({ ...p, minOrderAmount: v }))} placeholder={`${getCurrencySymbol()}0`} placeholderTextColor={palette.colors.grayLight} keyboardType="numeric" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Max Discount</Text>
                  <TextInput style={styles.modalInput} value={form.maxDiscountAmount} onChangeText={v => setForm(p => ({ ...p, maxDiscountAmount: v }))} placeholder="No limit" placeholderTextColor={palette.colors.grayLight} keyboardType="numeric" />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Expiry Date (YYYY-MM-DD)</Text>
              <TextInput style={styles.modalInput} value={form.expiryDate} onChangeText={v => setForm(p => ({ ...p, expiryDate: v }))} placeholder="2025-12-31" placeholderTextColor={palette.colors.grayLight} />

              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput style={[styles.modalInput, { height: 80, textAlignVertical: 'top' }]} value={form.description} onChangeText={v => setForm(p => ({ ...p, description: v }))} placeholder="Optional description" placeholderTextColor={palette.colors.grayLight} multiline />

              <TouchableOpacity style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleSave} disabled={saving}>
                {saving ? <ActivityIndicator color="#fff" size="small" /> : (
                  <><Ionicons name="checkmark-circle" size={20} color="#fff" /><Text style={styles.saveBtnText}>{editingCoupon ? 'Update Coupon' : 'Create Coupon'}</Text></>
                )}
              </TouchableOpacity>
            </ScrollView>
          </GlassPanel>
        </View>
      </Modal>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', marginHorizontal: spacing.md, marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md, gap: spacing.sm },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  headerSub: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  addBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center', ...shadows.md },
  tabRow: { flexDirection: 'row', marginHorizontal: spacing.md, marginVertical: spacing.md, backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: 4 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12 },
  tabActive: { backgroundColor: p.colors.primary },
  tabText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  tabTextActive: { color: '#fff' },
  couponCard: { padding: spacing.lg, marginBottom: spacing.md },
  couponHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  couponBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 8 },
  couponCode: { fontSize: fontSize.md, fontWeight: fontWeight.bold, letterSpacing: 1 },
  couponDiscount: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: 4 },
  couponDesc: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.sm },
  couponMeta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  metaText: { fontSize: fontSize.xs, color: p.colors.textSecondary },
  couponFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { maxHeight: '90%', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.lg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: 6, marginTop: spacing.sm },
  modalInput: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: p.glass.borderSubtle, marginBottom: spacing.sm },
  typeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 12, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  typeBtnActive: { backgroundColor: 'rgba(99,102,241,0.15)', borderColor: p.colors.primary },
  typeBtnText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.textSecondary },
  typeBtnTextActive: { color: p.colors.primary },
  productChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle, marginRight: spacing.sm },
  productChipSelected: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  productChipText: { fontSize: fontSize.sm, color: p.colors.text, maxWidth: 120 },
  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingVertical: 14, borderRadius: 16, marginTop: spacing.lg, ...shadows.md },
  saveBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
});
