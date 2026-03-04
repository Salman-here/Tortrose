/**
 * SellerShippingConfigurationScreen — Liquid Glass
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  Alert, RefreshControl, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../../config/api';
import Loader from '../../components/common/Loader';
import EmptyState from '../../components/common/EmptyState';
import GlassBackground from '../../components/common/GlassBackground';
import GlassPanel from '../../components/common/GlassPanel';
import {
  colors, spacing, fontSize, borderRadius, fontWeight, typography, glass,
} from '../../styles/theme';

export default function SellerShippingConfigurationScreen({ navigation }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [shippingMethods, setShippingMethods] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingMethod, setEditingMethod] = useState(null);
  const [formData, setFormData] = useState({ name: '', price: '', estimatedDays: '' });
  const [errors, setErrors] = useState({});

  useEffect(() => { fetchConfig(); }, []);

  const fetchConfig = async () => {
    try { const res = await api.get('/api/shipping/methods'); setShippingMethods(res.data?.methods || []); }
    catch (e) { console.error('Error:', e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const onRefresh = useCallback(() => { setRefreshing(true); fetchConfig(); }, []);
  const resetForm = useCallback(() => { setFormData({ name: '', price: '', estimatedDays: '' }); setErrors({}); setEditingMethod(null); setShowForm(false); }, []);
  const handleEdit = useCallback((method) => { setEditingMethod(method); setFormData({ name: method.name || '', price: method.price?.toString() || '', estimatedDays: method.estimatedDays?.toString() || '' }); setShowForm(true); }, []);
  
  const handleDelete = useCallback((method) => {
    Alert.alert('Delete', `Delete "${method.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await api.delete(`/api/shipping/methods/${method._id}`); setShippingMethods(prev => prev.filter(m => m._id !== method._id)); }
        catch (e) { Alert.alert('Error', 'Failed to delete'); }
      }},
    ]);
  }, []);

  const saveMethod = async () => {
    const newErrors = {};
    if (!formData.name.trim()) newErrors.name = 'Required';
    if (!formData.price || isNaN(parseFloat(formData.price))) newErrors.price = 'Required';
    if (!formData.estimatedDays || isNaN(parseInt(formData.estimatedDays))) newErrors.estimatedDays = 'Required';
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    setSaving(true);
    try {
      const data = { name: formData.name.trim(), price: parseFloat(formData.price), estimatedDays: parseInt(formData.estimatedDays) };
      if (editingMethod) {
        await api.put(`/api/shipping/methods/${editingMethod._id}`, data);
        setShippingMethods(prev => prev.map(m => m._id === editingMethod._id ? { ...m, ...data } : m));
      } else {
        const res = await api.post('/api/shipping/methods', data);
        setShippingMethods(prev => [...prev, res.data.method || data]);
      }
      resetForm();
    } catch (e) { Alert.alert('Error', e.response?.data?.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  if (loading) return <GlassBackground><Loader fullScreen message="Loading shipping methods..." /></GlassBackground>;

  return (
    <GlassBackground>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
        
        <GlassPanel variant="floating" style={styles.header}>
          <View style={styles.headerIcon}><Ionicons name="car-outline" size={28} color={colors.primary} /></View>
          <Text style={styles.headerTitle}>Shipping Configuration</Text>
          <Text style={styles.headerSubtitle}>Manage your shipping methods</Text>
        </GlassPanel>

        <View style={styles.content}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Shipping Methods</Text>
            {!showForm && (
              <TouchableOpacity style={styles.addButton} onPress={() => setShowForm(true)} activeOpacity={0.8}>
                <Ionicons name="add" size={20} color="white" /><Text style={styles.addButtonText}>Add</Text>
              </TouchableOpacity>
            )}
          </View>

          {shippingMethods.length === 0 && !showForm ? (
            <EmptyState icon="car-outline" title="No shipping methods" subtitle="Add your first shipping method" actionLabel="Add Method" onAction={() => setShowForm(true)} compact />
          ) : (
            shippingMethods.map((method, index) => (
              <GlassPanel key={method._id || index} variant="card" style={styles.methodCard}>
                <View style={styles.methodIcon}><Ionicons name="cube-outline" size={24} color={colors.primary} /></View>
                <View style={styles.methodInfo}>
                  <Text style={styles.methodName}>{method.name}</Text>
                  <View style={{ flexDirection: 'row', gap: spacing.md }}>
                    <Text style={styles.methodPrice}>${method.price?.toFixed(2)}</Text>
                    <Text style={styles.methodDays}>{method.estimatedDays} {method.estimatedDays === 1 ? 'day' : 'days'}</Text>
                  </View>
                </View>
                <TouchableOpacity style={styles.actionBtn} onPress={() => handleEdit(method)}><Ionicons name="create-outline" size={20} color={colors.primary} /></TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={() => handleDelete(method)}><Ionicons name="trash-outline" size={20} color={colors.error} /></TouchableOpacity>
              </GlassPanel>
            ))
          )}

          {showForm && (
            <GlassPanel variant="card" style={styles.formSection}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{editingMethod ? 'Edit Method' : 'Add Method'}</Text>
                <TouchableOpacity onPress={resetForm}><Ionicons name="close" size={24} color={colors.textSecondary} /></TouchableOpacity>
              </View>
              <Text style={styles.label}>Name <Text style={{ color: colors.error }}>*</Text></Text>
              <TextInput style={[styles.input, errors.name && styles.inputError]} value={formData.name}
                onChangeText={(v) => { setFormData(p => ({ ...p, name: v })); if (errors.name) setErrors(p => ({ ...p, name: null })); }}
                placeholder="e.g., Standard Shipping" placeholderTextColor={colors.textSecondary} />
              <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Price ($) *</Text>
                  <TextInput style={[styles.input, errors.price && styles.inputError]} value={formData.price}
                    onChangeText={(v) => { setFormData(p => ({ ...p, price: v })); }} placeholder="0.00" placeholderTextColor={colors.textSecondary} keyboardType="decimal-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Est. Days *</Text>
                  <TextInput style={[styles.input, errors.estimatedDays && styles.inputError]} value={formData.estimatedDays}
                    onChangeText={(v) => { setFormData(p => ({ ...p, estimatedDays: v })); }} placeholder="3" placeholderTextColor={colors.textSecondary} keyboardType="number-pad" />
                </View>
              </View>
              <TouchableOpacity style={[styles.submitButton, saving && { opacity: 0.6 }]} onPress={saveMethod} disabled={saving} activeOpacity={0.8}>
                {saving ? <ActivityIndicator color="white" /> : (
                  <><Ionicons name={editingMethod ? 'checkmark-circle' : 'add-circle'} size={22} color="white" />
                  <Text style={styles.submitButtonText}>{editingMethod ? 'Update' : 'Add'}</Text></>
                )}
              </TouchableOpacity>
            </GlassPanel>
          )}
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: spacing.xxl },
  header: { alignItems: 'center', margin: spacing.lg, padding: spacing.xl },
  headerIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  headerTitle: { ...typography.h2, color: colors.text, marginBottom: spacing.xs },
  headerSubtitle: { ...typography.body, color: colors.textSecondary },
  content: { paddingHorizontal: spacing.lg },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  sectionTitle: { ...typography.h4, color: colors.text },
  addButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: borderRadius.lg, gap: spacing.xs },
  addButtonText: { ...typography.bodySemibold, color: 'white', fontSize: fontSize.sm },
  methodCard: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, marginBottom: spacing.sm },
  methodIcon: { width: 44, height: 44, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  methodInfo: { flex: 1 },
  methodName: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.xs },
  methodPrice: { ...typography.bodySmall, color: colors.primary, fontWeight: fontWeight.semibold },
  methodDays: { ...typography.bodySmall, color: colors.textSecondary },
  actionBtn: { width: 36, height: 36, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center', marginLeft: spacing.xs },
  formSection: { padding: spacing.lg, marginTop: spacing.md },
  label: { ...typography.bodySemibold, color: colors.text, marginBottom: spacing.sm },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, fontSize: fontSize.md, color: colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  inputError: { borderColor: colors.error },
  submitButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: borderRadius.xl, paddingVertical: spacing.lg, marginTop: spacing.lg },
  submitButtonText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: 'white' },
});
