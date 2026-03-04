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
import { colors, spacing, fontSize, borderRadius, shadows, fontWeight, glass } from '../styles/theme';

export default function BecomeSellerScreen({ navigation }) {
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ phoneNumber: '', address: '', city: '', country: '', businessName: '' });

  useEffect(() => { if (currentUser?.role === 'seller' || currentUser?.role === 'admin') navigation.replace('SellerDashboard'); }, [currentUser]);

  const handleInputChange = (name, value) => setFormData(prev => ({ ...prev, [name]: value }));

  const validateForm = () => {
    if (!formData.phoneNumber || formData.phoneNumber.trim().length < 10) { Toast.show({ type: 'error', text1: 'Invalid Phone', text2: 'At least 10 digits' }); return false; }
    if (!formData.address || formData.address.trim().length < 5) { Toast.show({ type: 'error', text1: 'Invalid Address' }); return false; }
    if (!formData.city || formData.city.trim().length < 2) { Toast.show({ type: 'error', text1: 'Invalid City' }); return false; }
    if (!formData.country || formData.country.trim().length < 2) { Toast.show({ type: 'error', text1: 'Invalid Country' }); return false; }
    return true;
  };

  const handleBecomeSeller = async () => {
    if (!validateForm()) return;
    setLoading(true);
    try {
      const res = await api.post('/api/user/become-seller', { phoneNumber: formData.phoneNumber.trim(), address: formData.address.trim(), city: formData.city.trim(), country: formData.country.trim(), businessName: formData.businessName.trim() });
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
            <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text, marginTop: spacing.lg }}>Login Required</Text>
            <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginVertical: spacing.md }}>Please login to become a seller</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('Login')}><Text style={styles.primaryBtnText}>Login</Text></TouchableOpacity>
          </GlassPanel>
        </View>
      </GlassBackground>
    );
  }

  const benefits = [
    { icon: 'trending-up', title: 'Grow Your Business', description: 'Reach millions of customers' },
    { icon: 'shield-checkmark', title: 'Secure Platform', description: 'Safe payments guaranteed' },
    { icon: 'bar-chart', title: 'Analytics & Insights', description: 'Track your performance' },
  ];

  const features = ['Full store management dashboard', 'Product listing & inventory control', 'Order management system', 'Secure payment processing', 'Real-time sales analytics', 'Customer communication tools', 'Marketing & promotion features', '24/7 seller support'];

  return (
    <GlassBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxxl }}>
          {/* Hero Header */}
          <GlassPanel variant="strong" style={styles.heroPanel}>
            <View style={styles.heroIcon}><Ionicons name="storefront" size={40} color={colors.primary} /></View>
            <Text style={styles.heroTitle}>Become a Seller — FREE</Text>
            <Text style={styles.heroSub}>Join thousands of successful sellers and start your e-commerce journey today</Text>
            <View style={styles.freeBadge}><Ionicons name="gift-outline" size={16} color={colors.warning} /><Text style={styles.freeText}>Create your store for FREE — No hidden costs!</Text></View>
          </GlassPanel>

          {!showForm ? (
            <>
              {/* Benefits */}
              <View style={styles.benefitsGrid}>
                {benefits.map((b, i) => (
                  <GlassPanel key={i} variant="card" style={styles.benefitCard}>
                    <View style={styles.benefitIcon}><Ionicons name={b.icon} size={24} color={colors.primary} /></View>
                    <Text style={styles.benefitTitle}>{b.title}</Text>
                    <Text style={styles.benefitDesc}>{b.description}</Text>
                  </GlassPanel>
                ))}
              </View>

              {/* Features */}
              <GlassPanel variant="card" style={styles.featuresCard}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md }}>
                  <Ionicons name="sparkles" size={20} color={colors.warning} />
                  <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text }}>What You'll Get</Text>
                </View>
                {features.map((f, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
                    <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                    <Text style={{ fontSize: fontSize.md, color: colors.text }}>{f}</Text>
                  </View>
                ))}
              </GlassPanel>

              {/* CTA */}
              <GlassPanel variant="strong" style={styles.ctaPanel}>
                <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' }}>Ready to Start Selling?</Text>
                <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.sm }}>Click below to provide your details and activate your seller account!</Text>
                <TouchableOpacity style={styles.getStartedBtn} onPress={() => setShowForm(true)}>
                  <Ionicons name="storefront" size={22} color="#fff" /><Text style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: '#fff' }}>Get Started</Text>
                </TouchableOpacity>
              </GlassPanel>
            </>
          ) : (
            <GlassPanel variant="card" style={{ padding: spacing.lg }}>
              <Text style={{ fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.primary, textAlign: 'center' }}>Seller Information</Text>
              <Text style={{ fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: spacing.xl }}>Please provide your contact details</Text>

              {[
                { key: 'phoneNumber', icon: 'call', label: 'Phone Number *', placeholder: '+1 234 567 8900', keyboard: 'phone-pad' },
                { key: 'businessName', icon: 'storefront', label: 'Business Name (Optional)', placeholder: 'Your brand name' },
                { key: 'address', icon: 'location', label: 'Address *', placeholder: 'Street address' },
              ].map(({ key, icon, label, placeholder, keyboard }) => (
                <View key={key} style={styles.inputGroup}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                    <Ionicons name={icon} size={16} color={colors.primary} /><Text style={styles.label}>{label}</Text>
                  </View>
                  <TextInput style={styles.glassInput} placeholder={placeholder} placeholderTextColor="rgba(255,255,255,0.3)" value={formData[key]} onChangeText={v => handleInputChange(key, v)} keyboardType={keyboard || 'default'} />
                </View>
              ))}

              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                {[{ key: 'city', label: 'City *', placeholder: 'Your city' }, { key: 'country', label: 'Country *', placeholder: 'Your country' }].map(({ key, label, placeholder }) => (
                  <View key={key} style={[styles.inputGroup, { flex: 1 }]}>
                    <Text style={styles.label}>{label}</Text>
                    <TextInput style={styles.glassInput} placeholder={placeholder} placeholderTextColor="rgba(255,255,255,0.3)" value={formData[key]} onChangeText={v => handleInputChange(key, v)} />
                  </View>
                ))}
              </View>

              <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
                <TouchableOpacity style={styles.backFormBtn} onPress={() => setShowForm(false)}><Text style={{ fontWeight: fontWeight.semibold, color: colors.text }}>Back</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.submitFormBtn, loading && { opacity: 0.6 }]} onPress={handleBecomeSeller} disabled={loading}>
                  {loading ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons name="storefront" size={18} color="#fff" /><Text style={{ fontWeight: fontWeight.bold, color: '#fff' }}>Activate Account</Text></>}
                </TouchableOpacity>
              </View>
            </GlassPanel>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  primaryBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: 16 },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  heroPanel: { alignItems: 'center', padding: spacing.xl, marginBottom: spacing.md },
  heroIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.md },
  heroTitle: { fontSize: 24, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center', marginBottom: spacing.sm },
  heroSub: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.md },
  freeBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: 'rgba(234,179,8,0.12)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  freeText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.warning },
  benefitsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  benefitCard: { flex: 1, minWidth: '30%', alignItems: 'center', padding: spacing.md },
  benefitIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: spacing.sm },
  benefitTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.text, textAlign: 'center' },
  benefitDesc: { fontSize: fontSize.xs, color: colors.textSecondary, textAlign: 'center', marginTop: 2 },
  featuresCard: { padding: spacing.lg, marginBottom: spacing.md },
  ctaPanel: { alignItems: 'center', padding: spacing.xl },
  getStartedBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: colors.primary, paddingHorizontal: spacing.xxl, paddingVertical: 16, borderRadius: 20, marginTop: spacing.lg, ...shadows.md },
  inputGroup: { marginBottom: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.text, marginBottom: 4 },
  glassInput: { backgroundColor: glass.bgSubtle, borderRadius: 14, padding: spacing.md, fontSize: fontSize.md, color: colors.text, borderWidth: 1, borderColor: glass.borderSubtle },
  backFormBtn: { flex: 1, backgroundColor: glass.bg, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  submitFormBtn: { flex: 2, flexDirection: 'row', backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
});
