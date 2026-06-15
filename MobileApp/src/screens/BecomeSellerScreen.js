/**
 * BecomeSellerScreen — Liquid Glass Design
 */

import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import Toast from 'react-native-toast-message';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import LocationAutocomplete from '../components/common/LocationAutocomplete';
import { spacing, fontSize, borderRadius, shadows, fontWeight } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

export default function BecomeSellerScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formStep, setFormStep] = useState(1); // 1: seller info, 2: store setup
  const [formData, setFormData] = useState({
    phoneNumber: '',
    address: '',
    city: '',
    state: '',
    stateCode: '',
    country: '',
    countryCode: '',
    businessName: '',
  });
  const [storeData, setStoreData] = useState({ storeName: '', storeDescription: '', website: '', instagram: '', facebook: '', twitter: '' });

  useEffect(() => { if (currentUser?.role === 'seller' || currentUser?.role === 'admin') navigation.replace('SellerDashboard'); }, [currentUser]);

  const handleInputChange = (name, value) => setFormData(prev => ({ ...prev, [name]: value }));

  const validateForm = () => {
    if (!formData.phoneNumber || formData.phoneNumber.trim().length < 10) { Toast.show({ type: 'error', text1: 'Invalid Phone', text2: 'At least 10 digits' }); return false; }
    if (!formData.address || formData.address.trim().length < 5) { Toast.show({ type: 'error', text1: 'Invalid Address' }); return false; }
    if (!formData.country || !formData.countryCode) { Toast.show({ type: 'error', text1: 'Select Country', text2: 'Please choose your country from the list.' }); return false; }
    if (!formData.city || formData.city.trim().length < 2) { Toast.show({ type: 'error', text1: 'Select City', text2: 'Please choose your city from the list.' }); return false; }
    return true;
  };

  const handleStep1Next = () => {
    if (!validateForm()) return;
    setFormStep(2);
  };

  const handleBecomeSeller = async (skipStore = false) => {
    setLoading(true);
    try {
      const socialLinks = {};
      if (!skipStore) {
        ['website', 'instagram', 'facebook', 'twitter'].forEach(key => {
          if (storeData[key]) socialLinks[key] = storeData[key];
        });
      }
      const payload = {
        phoneNumber: formData.phoneNumber.trim(), address: formData.address.trim(),
        city: formData.city.trim(),
        state: formData.state.trim(),
        stateCode: formData.stateCode.trim(),
        country: formData.country.trim(),
        countryCode: formData.countryCode.trim(),
        businessName: formData.businessName.trim(),
        storeName: !skipStore && storeData.storeName ? storeData.storeName.trim() : '',
        storeDescription: !skipStore && storeData.storeDescription ? storeData.storeDescription.trim() : '',
        socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
      };
      const res = await api.post('/api/user/become-seller', payload);
      if (res.data.token) await SecureStore.setItemAsync('jwtToken', res.data.token);
      Toast.show({ type: 'success', text1: '🎉 Congratulations!', text2: 'You are now a seller!' });
      if (fetchAndUpdateCurrentUser) await fetchAndUpdateCurrentUser();
      setTimeout(() => navigation.replace('SellerDashboard'), 1500);
    } catch (error) { Toast.show({ type: 'error', text1: 'Error', text2: error.response?.data?.message || 'Failed to create seller account' }); }
    finally { setLoading(false); }
  };

  if (!currentUser) {
    return (
      <GlassBackground>
        <View style={styles.center}>
          <GlassPanel variant="panel" style={{ alignItems: 'center', padding: spacing.xxl }}>
            <Ionicons name="lock-closed" size={56} color="rgba(255,255,255,0.4)" />
            <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text, marginTop: spacing.lg }}>Login Required</Text>
            <Text style={{ fontSize: fontSize.md, color: palette.colors.textSecondary, textAlign: 'center', marginVertical: spacing.md }}>Please login to become a seller</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('Login')}><Text style={styles.primaryBtnText}>Login</Text></TouchableOpacity>
          </GlassPanel>
        </View>
      </GlassBackground>
    );
  }

  const benefits = [
    { icon: 'trending-up', title: 'Grow Your Business', description: 'Create a storefront and list products' },
    { icon: 'shield-checkmark', title: 'Secure Platform', description: 'Stripe where available plus trust tools' },
    { icon: 'bar-chart', title: 'Analytics & Insights', description: 'Track your performance' },
  ];

  const features = ['Seller management dashboard', 'Product listing & inventory control', 'Order management system', 'Stripe and Cash on Delivery support', 'Sales analytics', 'Customer communication tools', 'Coupons and promotion tools', 'AI-assisted seller workflows'];

  return (
    <GlassBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}>
          {/* Header with back navigation */}
          <GlassPanel variant="floating" style={styles.header}>
            <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
              <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
            </TouchableOpacity>
            <View style={styles.headerCenter}>
              <Text style={styles.headerTitle}>Become a Seller</Text>
              <Text style={styles.headerSubtitle}>Start your store journey</Text>
            </View>
          </GlassPanel>

          {/* Hero Header */}
          <GlassPanel variant="strong" style={styles.heroPanel}>
            <View style={styles.heroIcon}><Ionicons name="storefront" size={40} color={palette.colors.primary} /></View>
            <Text style={styles.heroTitle}>Become a Seller</Text>
            <Text style={styles.heroSub}>Start with a 15-day free trial, then choose Starter or Elite to keep your store active.</Text>
            <View style={styles.freeBadge}><Ionicons name="gift-outline" size={16} color={palette.colors.warning} /><Text style={styles.freeText}>15-day free trial first. Starter and Elite include free intro periods when eligible.</Text></View>
          </GlassPanel>

          {!showForm ? (
            <>
              {/* Benefits */}
              <View style={styles.benefitsGrid}>
                {benefits.map((b, i) => (
                  <GlassPanel key={i} variant="card" style={styles.benefitCard}>
                    <View style={styles.benefitIcon}><Ionicons name={b.icon} size={24} color={palette.colors.primary} /></View>
                    <Text style={styles.benefitTitle}>{b.title}</Text>
                    <Text style={styles.benefitDesc}>{b.description}</Text>
                  </GlassPanel>
                ))}
              </View>

              {/* Features */}
              <GlassPanel variant="card" style={styles.featuresCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md }}>
                  <Ionicons name="sparkles" size={20} color={palette.colors.warning} />
                  <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text }}>What You'll Get</Text>
                </View>
                {features.map((f, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                    <Ionicons name="checkmark-circle" size={18} color={palette.colors.success} />
                    <Text style={{ fontSize: fontSize.md, color: palette.colors.text }}>{f}</Text>
                  </View>
                ))}
              </GlassPanel>

              {/* CTA */}
              <GlassPanel variant="strong" style={styles.ctaPanel}>
                <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.text, textAlign: 'center' }}>Ready to Start Selling?</Text>
                <Text style={{ fontSize: fontSize.md, color: palette.colors.textSecondary, textAlign: 'center', marginTop: spacing.sm }}>Click below to provide your details and activate your seller account!</Text>
                <TouchableOpacity style={styles.getStartedBtn} onPress={() => setShowForm(true)}>
                  <Ionicons name="storefront" size={22} color="#fff" /><Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: '#fff' }}>Get Started</Text>
                </TouchableOpacity>
              </GlassPanel>
            </>
          ) : (
            <GlassPanel variant="card" style={{ padding: spacing.lg }}>
              {formStep === 1 ? (
                <>
                  <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.primary, textAlign: 'center' }}>Seller Information</Text>
                  <Text style={{ fontSize: fontSize.md, color: palette.colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: spacing.xl }}>Step 1 of 2 — Contact details</Text>

                  {[
                    { key: 'phoneNumber', icon: 'call', label: 'Phone Number *', placeholder: '+1 234 567 8900', keyboard: 'phone-pad' },
                    { key: 'businessName', icon: 'storefront', label: 'Business Name (Optional)', placeholder: 'Your brand name' },
                    { key: 'address', icon: 'location', label: 'Address *', placeholder: 'Street address' },
                  ].map(({ key, icon, label, placeholder, keyboard }) => (
                    <View key={key} style={styles.inputGroup}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                        <Ionicons name={icon} size={16} color={palette.colors.primary} /><Text style={styles.label}>{label}</Text>
                      </View>
                      <TextInput style={styles.glassInput} placeholder={placeholder} placeholderTextColor="rgba(255,255,255,0.3)" value={formData[key]} onChangeText={v => handleInputChange(key, v)} keyboardType={keyboard || 'default'} />
                    </View>
                  ))}

                  <LocationAutocomplete
                    type="country"
                    label="Country"
                    required
                    value={formData.country}
                    code={formData.countryCode}
                    placeholder="Select country"
                    onSelect={(option) => setFormData(prev => ({
                      ...prev,
                      country: option.name,
                      countryCode: option.isoCode,
                      state: '',
                      stateCode: '',
                      city: '',
                    }))}
                    onClear={() => setFormData(prev => ({ ...prev, country: '', countryCode: '', state: '', stateCode: '', city: '' }))}
                  />
                  <LocationAutocomplete
                    type="state"
                    label="State / Province"
                    value={formData.state}
                    code={formData.stateCode}
                    countryCode={formData.countryCode}
                    countryName={formData.country}
                    placeholder="Select state"
                    disabled={!formData.countryCode && !formData.country}
                    onSelect={(option) => setFormData(prev => ({
                      ...prev,
                      state: option.name,
                      stateCode: option.isoCode,
                      city: '',
                    }))}
                    onClear={() => setFormData(prev => ({ ...prev, state: '', stateCode: '', city: '' }))}
                  />
                  <LocationAutocomplete
                    type="city"
                    label="City"
                    required
                    value={formData.city}
                    countryCode={formData.countryCode}
                    countryName={formData.country}
                    stateCode={formData.stateCode}
                    stateName={formData.state}
                    placeholder="Select city"
                    disabled={!formData.countryCode && !formData.country}
                    onSelect={(option) => setFormData(prev => ({
                      ...prev,
                      city: option.name,
                      state: prev.state || option.stateName || '',
                      stateCode: prev.stateCode || option.stateCode || '',
                    }))}
                    onClear={() => setFormData(prev => ({ ...prev, city: '' }))}
                  />

                  <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
                    <TouchableOpacity style={styles.backFormBtn} onPress={() => setShowForm(false)}><Text style={{ fontWeight: fontWeight.semibold, color: palette.colors.text }}>Back</Text></TouchableOpacity>
                    <TouchableOpacity style={styles.submitFormBtn} onPress={handleStep1Next}>
                      <Text style={{ fontWeight: fontWeight.bold, color: '#fff' }}>Next: Store Setup</Text>
                      <Ionicons name="arrow-forward" size={16} color="#fff" />
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: palette.colors.primary, textAlign: 'center' }}>Store Setup</Text>
                  <Text style={{ fontSize: fontSize.md, color: palette.colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: spacing.xl }}>Step 2 of 2 — Set up your store (optional)</Text>

                  {[
                    { key: 'storeName', icon: 'storefront', label: 'Store Name', placeholder: 'My Awesome Store' },
                    { key: 'storeDescription', icon: 'document-text', label: 'Store Description', placeholder: 'What do you sell?' },
                    { key: 'website', icon: 'globe-outline', label: 'Website (Optional)', placeholder: 'https://yourwebsite.com' },
                    { key: 'instagram', icon: 'logo-instagram', label: 'Instagram (Optional)', placeholder: '@yourbrand' },
                    { key: 'facebook', icon: 'logo-facebook', label: 'Facebook (Optional)', placeholder: 'facebook.com/yourbrand' },
                    { key: 'twitter', icon: 'logo-twitter', label: 'Twitter (Optional)', placeholder: '@yourbrand' },
                  ].map(({ key, icon, label, placeholder }) => (
                    <View key={key} style={styles.inputGroup}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                        <Ionicons name={icon} size={16} color={palette.colors.primary} /><Text style={styles.label}>{label}</Text>
                      </View>
                      <TextInput style={styles.glassInput} placeholder={placeholder} placeholderTextColor="rgba(255,255,255,0.3)" value={storeData[key]} onChangeText={v => setStoreData(prev => ({ ...prev, [key]: v }))} autoCapitalize="none" />
                    </View>
                  ))}

                  <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
                    <TouchableOpacity style={styles.backFormBtn} onPress={() => setFormStep(1)}><Text style={{ fontWeight: fontWeight.semibold, color: palette.colors.text }}>Back</Text></TouchableOpacity>
                    <TouchableOpacity style={[styles.submitFormBtn, { flex: 1 }, loading && { opacity: 0.6 }]} onPress={() => handleBecomeSeller(true)} disabled={loading}>
                      {loading ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="play-skip-forward" size={16} color="#fff" /><Text style={{ fontWeight: fontWeight.bold, color: '#fff' }}>Skip</Text></>}
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.submitFormBtn, loading && { opacity: 0.6 }]} onPress={() => handleBecomeSeller(false)} disabled={loading}>
                      {loading ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="storefront" size={18} color="#fff" /><Text style={{ fontWeight: fontWeight.bold, color: '#fff' }}>Create</Text></>}
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </GlassPanel>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  primaryBtn: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 16 },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginBottom: spacing.md },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  headerCenter: { flex: 1, marginLeft: spacing.md },
  headerTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text },
  headerSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  heroPanel: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  heroIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  heroTitle: { fontSize: 24, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center', marginBottom: spacing.sm },
  heroSub: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.md },
  freeBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: 'rgba(234,179,8,0.12)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  freeText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.warning },
  benefitsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  benefitCard: { flex: 1, minWidth: '30%', alignItems: 'center', padding: spacing.md },
  benefitIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.sm },
  benefitTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center' },
  benefitDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, textAlign: 'center', marginTop: 2 },
  featuresCard: { padding: spacing.lg, marginBottom: spacing.md },
  ctaPanel: { alignItems: 'center', padding: spacing.xl },
  getStartedBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: p.colors.primary, paddingHorizontal: spacing.xxl, paddingVertical: 16, borderRadius: 20, marginTop: spacing.lg, ...shadows.md },
  inputGroup: { marginBottom: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: 4 },
  glassInput: { backgroundColor: p.glass.bgSubtle, borderRadius: 14, padding: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: p.glass.borderSubtle },
  backFormBtn: { flex: 1, backgroundColor: p.glass.bg, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  submitFormBtn: { flex: 2, flexDirection: 'row', backgroundColor: p.colors.primary, paddingVertical: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
});
