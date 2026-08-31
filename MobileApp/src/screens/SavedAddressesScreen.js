/**
 * SavedAddressesScreen — manage multiple shipping addresses (address book).
 * Full CRUD: add, edit, delete, set default. Liquid Glass design.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Modal, RefreshControl, ActivityIndicator, Platform, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Feedback from '../utils/feedback';
import api from '../config/api';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import KeyboardAwareFormScrollView from '../components/common/KeyboardAwareFormScrollView';
import PhoneNumberInput from '../components/common/PhoneNumberInput';
import { EmptyState } from '../components/common';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import { resolveBuyerLocation } from '../utils/buyerLocation';
import { isValidPhoneNumber } from '../utils/phoneNumber';
import { addressCountrySeed } from '../utils/addressCountrySeed';

const EMPTY_FORM = {
  label: 'Home', fullName: '', email: '', phone: '',
  address: '', city: '', state: '', stateCode: '', postalCode: '', country: '', countryCode: '',
  isDefault: false,
};

const LABEL_PRESETS = ['Home', 'Work', 'Other'];

export default function SavedAddressesScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  function FormField({ label, error, icon, multiline, ...rest }) {
    return (
      <View style={{ marginBottom: spacing.md }}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={[styles.inputWrap, error && styles.inputWrapError, multiline && { minHeight: 64, alignItems: 'flex-start' }]}>
          {icon ? <Ionicons name={icon} size={16} color={palette.colors.textSecondary} style={{ marginRight: 6, marginTop: multiline ? 4 : 0 }} /> : null}
          <TextInput
            style={[styles.input, multiline && { minHeight: 60, textAlignVertical: 'top' }]}
            placeholderTextColor={palette.colors.textLight}
            multiline={multiline}
            {...rest}
          />
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }

  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const countrySeedRequest = useRef(0);

  const fetchAddresses = useCallback(async () => {
    try {
      const res = await api.get('/api/user/addresses');
      setAddresses(res.data?.addresses || []);
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to load addresses' });
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchAddresses(); }, [fetchAddresses]);

  const openAdd = () => {
    const requestId = countrySeedRequest.current + 1;
    countrySeedRequest.current = requestId;
    const savedCountry = addresses.find(address => address.isDefault) || addresses[0] || null;
    const initialCountry = addressCountrySeed(savedCountry, null, false);
    const initialForm = { ...EMPTY_FORM, ...initialCountry };
    setEditingId(null);
    setForm(initialForm);
    setErrors({});
    setShowForm(true);

    if (initialCountry.country && initialCountry.countryCode) return;
    resolveBuyerLocation()
      .catch(() => null)
      .then((detectedLocation) => {
        if (countrySeedRequest.current !== requestId) return;
        const resolvedCountry = addressCountrySeed(savedCountry, detectedLocation, true);
        setForm(previous => {
          const countryWasChanged = previous.country !== initialForm.country
            || previous.countryCode !== initialForm.countryCode;
          return countryWasChanged ? previous : { ...previous, ...resolvedCountry };
        });
      });
  };
  const openEdit = (a) => {
    countrySeedRequest.current += 1;
    setEditingId(a._id);
    setForm({ ...a });
    setErrors({});
    setShowForm(true);
  };

  const validate = () => {
    const e = {};
    if (!form.fullName?.trim() || form.fullName.trim().length < 2) e.fullName = 'Full name required';
    if (!form.address?.trim() || form.address.trim().length < 4) e.address = 'Street address required';
    if (!form.city?.trim()) e.city = 'City required';
    if (form.phone && !isValidPhoneNumber(form.phone)) e.phone = 'Select a country and enter a valid phone number';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const payload = { ...form };
      if (editingId) {
        const res = await api.patch(`/api/user/addresses/${editingId}`, payload);
        setAddresses(res.data?.addresses || []);
        Feedback.show({ type: 'success', text1: 'Address updated' });
      } else {
        const res = await api.post('/api/user/addresses', payload);
        setAddresses(res.data?.addresses || []);
        Feedback.show({ type: 'success', text1: 'Address added' });
      }
      setShowForm(false);
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to save' });
    } finally { setSaving(false); }
  };

  const handleDelete = (a) => {
    Alert.alert('Delete Address', `Remove the "${a.label}" address?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          const res = await api.delete(`/api/user/addresses/${a._id}`);
          setAddresses(res.data?.addresses || []);
          Feedback.show({ type: 'info', text1: 'Address removed' });
        } catch (err) {
          Feedback.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to delete' });
        }
      }},
    ]);
  };

  const handleSetDefault = async (a) => {
    if (a.isDefault) return;
    try {
      const res = await api.patch(`/api/user/addresses/${a._id}/default`);
      setAddresses(res.data?.addresses || []);
      Feedback.show({ type: 'success', text1: 'Default updated' });
    } catch (err) {
      Feedback.show({ type: 'error', text1: 'Error', text2: err.response?.data?.msg || 'Failed to update' });
    }
  };

  const labelIcon = (label) => {
    const l = (label || '').toLowerCase();
    if (l === 'home') return 'home-outline';
    if (l === 'work') return 'briefcase-outline';
    return 'location-outline';
  };

  return (
    <GlassBackground>
      <SafeAreaView style={{ flex: 1 }} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Saved Addresses"
          subtitle={`${addresses.length} saved address${addresses.length === 1 ? '' : 'es'}`}
          icon="location-outline"
          onBack={() => navigation.goBack()}
          style={styles.premiumHeader}
          rightElement={(
            <TouchableOpacity style={styles.addBtn} onPress={openAdd} activeOpacity={0.85} accessibilityLabel="Add address">
              <Ionicons name="add" size={20} color="#fff" />
            </TouchableOpacity>
          )}
        />

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={palette.colors.primary} /></View>
        ) : (
          <ScrollView
            contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl }}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchAddresses(); }} colors={[palette.colors.primary]} tintColor={palette.colors.primary} />}
          >
            {addresses.length === 0 ? (
              <EmptyState
                icon="location-outline"
                accent="primary"
                title="No saved addresses"
                subtitle="Add an address to checkout faster next time."
                actionLabel="Add Address"
                onAction={openAdd}
              />
            ) : (
              addresses.map((a) => (
                <GlassPanel key={a._id} variant="card" style={styles.card}>
                  <View style={styles.cardHead}>
                    <View style={styles.labelChip}>
                      <Ionicons name={labelIcon(a.label)} size={14} color={palette.colors.primary} />
                      <Text style={styles.labelChipText}>{a.label}</Text>
                    </View>
                    {a.isDefault ? (
                      <View style={styles.defaultBadge}>
                        <Ionicons name="checkmark" size={12} color={palette.colors.success} />
                        <Text style={styles.defaultText}>Default</Text>
                      </View>
                    ) : (
                      <TouchableOpacity onPress={() => handleSetDefault(a)} style={styles.setDefaultBtn} activeOpacity={0.7}>
                        <Text style={styles.setDefaultText}>Set as default</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <Text style={styles.fullName}>{a.fullName}</Text>
                  <Text style={styles.line}>{a.address}</Text>
                  <Text style={styles.line}>{a.city}{a.state ? `, ${a.state}` : ''} {a.postalCode || ''}</Text>
                  <Text style={styles.line}>{a.country}</Text>
                  {(a.phone || a.email) && (
                    <View style={styles.contactRow}>
                      {a.phone ? <View style={styles.contactItem}><Ionicons name="call-outline" size={12} color={palette.colors.textSecondary} /><Text style={styles.contactText}>{a.phone}</Text></View> : null}
                      {a.email ? <View style={styles.contactItem}><Ionicons name="mail-outline" size={12} color={palette.colors.textSecondary} /><Text style={styles.contactText} numberOfLines={1}>{a.email}</Text></View> : null}
                    </View>
                  )}
                  <View style={styles.actions}>
                    <TouchableOpacity style={styles.actionBtn} onPress={() => openEdit(a)} activeOpacity={0.7}>
                      <Ionicons name="pencil-outline" size={16} color={palette.colors.primary} />
                      <Text style={styles.actionText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, { borderColor: palette.colors.error + '50' }]} onPress={() => handleDelete(a)} activeOpacity={0.7}>
                      <Ionicons name="trash-outline" size={16} color={palette.colors.error} />
                      <Text style={[styles.actionText, { color: palette.colors.error }]}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </GlassPanel>
              ))
            )}
          </ScrollView>
        )}

        {/* Form Modal */}
        <Modal visible={showForm} transparent animationType="slide" onRequestClose={() => setShowForm(false)}>
          <View style={styles.modalRoot}>
            <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setShowForm(false)} />
            <GlassPanel variant="strong" style={styles.modal}>
              <View style={styles.modalHandle} />
              <View style={styles.modalHead}>
                <Text style={styles.modalTitle}>{editingId ? 'Edit Address' : 'New Address'}</Text>
                <TouchableOpacity onPress={() => setShowForm(false)} style={styles.modalClose}>
                  <Ionicons name="close" size={20} color={palette.colors.text} />
                </TouchableOpacity>
              </View>
              <KeyboardAwareFormScrollView style={{ maxHeight: 460 }}>
                {/* Label preset chips */}
                <Text style={styles.fieldLabel}>Label</Text>
                <View style={styles.chipRow}>
                  {LABEL_PRESETS.map((preset) => {
                    const active = form.label === preset;
                    return (
                      <TouchableOpacity
                        key={preset}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => setForm((f) => ({ ...f, label: preset }))}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{preset}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <FormField label="Full Name" value={form.fullName} onChangeText={(v) => setForm((f) => ({ ...f, fullName: v }))} error={errors.fullName} icon="person-outline" />
                <PhoneNumberInput
                  label="Phone"
                  value={form.phone}
                  onChangeText={(value) => {
                    setForm(previous => ({ ...previous, phone: value }));
                    setErrors(previous => ({ ...previous, phone: null }));
                  }}
                  defaultCountryCode={form.phone ? form.countryCode : undefined}
                  profileCountryCode={form.countryCode}
                  profileCountry={form.country}
                  error={errors.phone}
                  testID="saved-address-phone"
                />
                <FormField label="Email" value={form.email} onChangeText={(v) => setForm((f) => ({ ...f, email: v }))} icon="mail-outline" keyboardType="email-address" autoCapitalize="none" />
                <FormField label="Street Address" value={form.address} onChangeText={(v) => setForm((f) => ({ ...f, address: v }))} error={errors.address} icon="home-outline" multiline />
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <View style={{ flex: 1 }}><FormField label="City" value={form.city} onChangeText={(v) => setForm((f) => ({ ...f, city: v }))} error={errors.city} /></View>
                  <View style={{ flex: 1 }}><FormField label="State" value={form.state} onChangeText={(v) => setForm((f) => ({ ...f, state: v }))} /></View>
                </View>
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <View style={{ flex: 1 }}><FormField label="Postal Code" value={form.postalCode} onChangeText={(v) => setForm((f) => ({ ...f, postalCode: v }))} keyboardType="number-pad" /></View>
                  <View style={{ flex: 1 }}><FormField label="Country" value={form.country} onChangeText={(v) => setForm((f) => ({ ...f, country: v }))} /></View>
                </View>

                <TouchableOpacity
                  style={styles.defaultToggle}
                  onPress={() => setForm((f) => ({ ...f, isDefault: !f.isDefault }))}
                  activeOpacity={0.7}
                >
                  <View style={[styles.checkbox, form.isDefault && styles.checkboxOn]}>
                    {form.isDefault && <Ionicons name="checkmark" size={14} color="#fff" />}
                  </View>
                  <Text style={styles.defaultToggleText}>Use as default address</Text>
                </TouchableOpacity>
              </KeyboardAwareFormScrollView>

              <TouchableOpacity
                style={[styles.saveBtn, saving && { opacity: 0.7 }]}
                onPress={handleSave}
                disabled={saving}
                activeOpacity={0.85}
              >
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>{editingId ? 'Save Changes' : 'Add Address'}</Text>}
              </TouchableOpacity>
            </GlassPanel>
          </View>
        </Modal>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  premiumHeader: { marginTop: spacing.sm },
  addBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: p.colors.primary, justifyContent: 'center', alignItems: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: { padding: spacing.lg, marginBottom: spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  labelChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(99,102,241,0.12)' },
  labelChipText: { fontSize: fontSize.xs, color: p.colors.primary, fontWeight: fontWeight.semibold },
  defaultBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(34,197,94,0.12)' },
  defaultText: { fontSize: 11, color: p.colors.success, fontWeight: fontWeight.semibold },
  setDefaultBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  setDefaultText: { fontSize: 11, color: p.colors.primary, fontWeight: fontWeight.medium },
  fullName: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: 4 },
  line: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 19 },
  contactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: p.glass.borderSubtle },
  contactItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  contactText: { fontSize: 11, color: p.colors.textSecondary },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: spacing.sm, borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)', borderRadius: 12 },
  actionText: { fontSize: fontSize.sm, color: p.colors.primary, fontWeight: fontWeight.semibold },
  modalRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modal: {
    height: '90%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  modalHandle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.35)', marginBottom: spacing.md },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg },
  modalTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  modalClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: p.glass.bgSubtle, justifyContent: 'center', alignItems: 'center' },
  fieldLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: p.colors.textSecondary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.glass.bgSubtle, borderRadius: 12, borderWidth: 1, borderColor: p.glass.borderSubtle, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
  inputWrapError: { borderColor: p.colors.error },
  input: { flex: 1, fontSize: fontSize.md, color: p.colors.text, paddingVertical: 0 },
  errorText: { fontSize: 11, color: p.colors.error, marginTop: 4 },
  chipRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  chip: { paddingHorizontal: spacing.lg, paddingVertical: 8, borderRadius: 999, backgroundColor: p.glass.bgSubtle, borderWidth: 1, borderColor: p.glass.borderSubtle },
  chipActive: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  chipText: { fontSize: fontSize.sm, color: p.colors.textSecondary, fontWeight: fontWeight.medium },
  chipTextActive: { color: '#fff', fontWeight: fontWeight.semibold },
  defaultToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm, marginBottom: spacing.sm },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: p.glass.border, justifyContent: 'center', alignItems: 'center' },
  checkboxOn: { backgroundColor: p.colors.primary, borderColor: p.colors.primary },
  defaultToggleText: { fontSize: fontSize.sm, color: p.colors.text, fontWeight: fontWeight.medium },
  saveBtn: { backgroundColor: p.colors.primary, borderRadius: 16, paddingVertical: 14, alignItems: 'center', marginTop: spacing.md },
  saveBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.bold },
});
