/**
 * ContactScreen — Liquid Glass Design
 * Matches website Contact page with contact methods and form
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, Linking, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import KeyboardAwareFormScrollView from '../components/common/KeyboardAwareFormScrollView';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import { policyConfig, supportTimeline } from '../content/commercePolicies';

const getContactMethods = (palette) => [
  { icon: 'mail-outline', title: 'Email Us', value: 'support@rozare.com', desc: 'For order, account, and seller questions', color: palette.colors.primary },
  { icon: 'business-outline', title: 'Company inquiries', value: policyConfig.companyEmail, desc: 'General and business inquiries', color: palette.colors.primary },
  { icon: 'chatbubbles-outline', title: 'AI Chat', value: 'Available on platform', desc: 'Use Rozare AI for product and account help', color: palette.colors.success },
  { icon: 'location-outline', title: 'Registered business', value: policyConfig.legalName, desc: policyConfig.registeredAddress || 'Pakistan', color: palette.colors.info },
];

export default function ContactScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const contactMethods = getContactMethods(palette);

  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [sending, setSending] = useState(false);

  const handleSubmit = () => {
    if (!form.name || !form.email || !form.message) {
      Alert.alert('Missing Fields', 'Please fill in all required fields.');
      return;
    }
    setSending(true);
    const subject = encodeURIComponent(form.subject || `Rozare support request from ${form.name}`);
    const body = encodeURIComponent(`Name: ${form.name}\nEmail: ${form.email}\n\n${form.message}`);
    Linking.openURL(`mailto:support@rozare.com?subject=${subject}&body=${body}`)
      .catch(() => Alert.alert('Email app unavailable', 'Please email support@rozare.com directly.'))
      .finally(() => setSending(false));
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Contact Us"
          subtitle="We'd love to hear from you"
          icon="mail-outline"
          onBack={() => navigation.goBack()}
          rightIcon="headset-outline"
          rightLabel="Support"
          style={styles.premiumHeader}
        />

          <KeyboardAwareFormScrollView contentContainerStyle={styles.scrollContent}>
            {/* Contact Methods */}
            {contactMethods.map((m, i) => (
              <GlassPanel key={i} variant="card" style={styles.methodCard}>
                <View style={[styles.methodIcon, { backgroundColor: `${m.color}18` }]}>
                  <Ionicons name={m.icon} size={22} color={m.color} />
                </View>
                <View style={styles.methodText}>
                  <Text style={styles.methodTitle}>{m.title}</Text>
                  <Text style={styles.methodValue}>{m.value}</Text>
                  <Text style={styles.methodDesc}>{m.desc}</Text>
                </View>
              </GlassPanel>
            ))}

            <GlassPanel variant="card" style={styles.formCard}>
              <Text style={styles.formTitle}>Complaints and payment support</Text>
              <Text style={styles.ctaText}>{supportTimeline}</Text>
              <Text style={styles.ctaText}>Include your order or subscription reference. Never send passwords, full card numbers, CVV or OTPs.</Text>
              <TouchableOpacity accessibilityRole="link" onPress={() => Linking.openURL(`mailto:${policyConfig.companyEmail}`).catch(() => Alert.alert('Company email', policyConfig.companyEmail))}><Text style={styles.ctaLink}>{policyConfig.companyEmail}</Text></TouchableOpacity>
              {!!policyConfig.supportPhone && <TouchableOpacity accessibilityRole="link" onPress={() => Linking.openURL(`tel:${policyConfig.supportPhone.replace(/[^+\d]/g, '')}`).catch(() => Alert.alert('Support phone', policyConfig.supportPhone))}><Text style={styles.ctaLink}>{policyConfig.supportPhone}</Text></TouchableOpacity>}
              {policyConfig.sameOperatingAddress === false && !!policyConfig.operatingAddress && <Text style={styles.ctaText}>Operating address: {policyConfig.operatingAddress}</Text>}
              <TouchableOpacity accessibilityRole="link" onPress={() => navigation.navigate('RefundPolicy')}><Text style={styles.ctaLink}>Refund policy and processing times →</Text></TouchableOpacity>
              <TouchableOpacity accessibilityRole="link" onPress={() => navigation.navigate('CancellationPolicy')}><Text style={styles.ctaLink}>Cancellation policy →</Text></TouchableOpacity>
            </GlassPanel>
            {/* Contact Form */}
            <GlassPanel variant="card" style={styles.formCard}>
              <Text style={styles.formTitle}>Email support</Text>

              <Text style={styles.label}>Name *</Text>
              <TextInput style={styles.input} value={form.name} onChangeText={t => setForm({ ...form, name: t })} placeholder="Your name" placeholderTextColor={palette.colors.textLight} />

              <Text style={styles.label}>Email *</Text>
              <TextInput style={styles.input} value={form.email} onChangeText={t => setForm({ ...form, email: t })} placeholder="you@example.com" placeholderTextColor={palette.colors.textLight} keyboardType="email-address" autoCapitalize="none" />

              <Text style={styles.label}>Subject</Text>
              <TextInput style={styles.input} value={form.subject} onChangeText={t => setForm({ ...form, subject: t })} placeholder="What's this about?" placeholderTextColor={palette.colors.textLight} />

              <Text style={styles.label}>Message *</Text>
              <TextInput style={[styles.input, styles.textarea]} value={form.message} onChangeText={t => setForm({ ...form, message: t })} placeholder="Tell us how we can help..." placeholderTextColor={palette.colors.textLight} multiline textAlignVertical="top" />

              <TouchableOpacity style={[styles.submitBtn, sending && { opacity: 0.6 }]} onPress={handleSubmit} disabled={sending} activeOpacity={0.7}>
                <Ionicons name="send-outline" size={16} color={palette.colors.white} />
                <Text style={styles.submitText}>{sending ? 'Opening...' : 'Open Email Draft'}</Text>
              </TouchableOpacity>
            </GlassPanel>

            <GlassPanel variant="card" style={styles.ctaCard}>
              <Text style={styles.ctaText}>
                Check our FAQ for quick answers to common questions.
              </Text>
              <TouchableOpacity onPress={() => navigation.navigate('FAQ')} activeOpacity={0.7}>
                <Text style={styles.ctaLink}>Go to FAQ →</Text>
              </TouchableOpacity>
            </GlassPanel>

            <View style={{ height: 100 }} />
          </KeyboardAwareFormScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  methodCard: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  methodIcon: { width: 48, height: 48, borderRadius: borderRadius.xl, justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  methodText: { flex: 1 },
  methodTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  methodValue: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: p.colors.primary, marginTop: 2 },
  methodDesc: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 2 },
  formCard: { marginBottom: spacing.md },
  formTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.medium, color: p.colors.text, marginBottom: spacing.xs },
  input: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, fontSize: fontSize.md, color: p.colors.text, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', marginBottom: spacing.md },
  textarea: { minHeight: 120, paddingTop: spacing.md },
  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: p.colors.primary, paddingVertical: spacing.md, borderRadius: borderRadius.lg, gap: spacing.sm, marginTop: spacing.sm },
  submitText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.white },
  ctaCard: { alignItems: 'center' },
  ctaText: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.sm, textAlign: 'center' },
  ctaLink: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.primary },
});
