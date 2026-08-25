/**
 * TermsOfServiceScreen — Liquid Glass Design
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

const sections = [
  { icon: 'people-outline', title: '1. Acceptance of Terms', content: 'By accessing and using Rozare ("the Platform"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use our platform. These terms apply to all visitors, users, sellers, and others who access or use the service.' },
  { icon: 'shield-outline', title: '2. User Accounts', content: 'You are responsible for maintaining the confidentiality of your account credentials. You must be at least 18 years old to create an account. You agree to provide accurate, current, and complete information during registration. We reserve the right to suspend or terminate accounts that violate these terms.' },
  { icon: 'scale-outline', title: '3. Seller Obligations', content: 'Sellers on Rozare must provide accurate product descriptions, pricing, and availability information. Sellers are responsible for fulfilling orders in a timely manner, handling returns per our return policy, and complying with all applicable laws and regulations regarding their products and business operations.' },
  { icon: 'warning-outline', title: '4. Prohibited Activities', content: 'Users may not: sell counterfeit or illegal products; engage in fraudulent transactions; harass other users; attempt to circumvent platform fees; use automated tools to scrape data; or violate any applicable laws. Violation of these terms may result in immediate account termination.' },
  { icon: 'globe-outline', title: '5. Intellectual Property', content: 'All content on Rozare, including logos, designs, and software, is owned by Rozare or its licensors. Users retain ownership of content they upload but grant Rozare a non-exclusive license to use, display, and distribute such content in connection with the platform\'s services.' },
  { icon: 'document-text-outline', title: '6. Payments & Refunds', content: 'All payments are processed securely through our payment partners. Refund policies vary by seller and are subject to our platform-wide refund guidelines. Rozare is not liable for disputes between buyers and sellers but will facilitate resolution through our dispute resolution process.' },
  { icon: 'shield-outline', title: '7. Limitation of Liability', content: 'Rozare provides the platform "as is" without warranties of any kind. We are not liable for any indirect, incidental, special, or consequential damages. Our total liability shall not exceed the amount paid by you to us in the preceding 12 months. We do not guarantee uninterrupted or error-free service.' },
  { icon: 'create-outline', title: '8. Changes to Terms', content: 'We reserve the right to modify these terms at any time. Users will be notified of significant changes via email or platform notification. Continued use of the platform after changes constitutes acceptance of the new terms. It is your responsibility to review these terms periodically.' },
];

export default function TermsOfServiceScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Terms of Service"
          subtitle="Last updated: March 1, 2026"
          icon="document-text-outline"
          onBack={() => navigation.goBack()}
          rightIcon="shield-checkmark-outline"
          rightLabel="Legal"
          style={styles.premiumHeader}
        />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <GlassPanel variant="card" style={styles.introCard}>
            <Text style={styles.introText}>
              Welcome to Rozare. These Terms of Service govern your use of our marketplace platform. By using Rozare, you agree to these terms. Please read them carefully before creating an account or making any transactions.
            </Text>
          </GlassPanel>

          {sections.map((s, i) => (
            <GlassPanel key={i} variant="card" style={styles.sectionCard}>
              <View style={styles.sectionHeader}>
                <View style={styles.sectionIconWrap}>
                  <Ionicons name={s.icon} size={18} color={palette.colors.primary} />
                </View>
                <Text style={styles.sectionTitle}>{s.title}</Text>
              </View>
              <Text style={styles.sectionContent}>{s.content}</Text>
            </GlassPanel>
          ))}

          <GlassPanel variant="card" style={styles.ctaCard}>
            <Text style={styles.ctaText}>Questions about these terms? Contact us or read our Privacy Policy.</Text>
            <View style={styles.ctaLinks}>
              <TouchableOpacity onPress={() => navigation.navigate('Contact')} activeOpacity={0.7}>
                <Text style={styles.ctaLink}>Contact us →</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => navigation.navigate('PrivacyPolicy')} activeOpacity={0.7}>
                <Text style={styles.ctaLink}>Privacy Policy →</Text>
              </TouchableOpacity>
            </View>
          </GlassPanel>

          <View style={{ height: 100 }} />
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  premiumHeader: { marginTop: spacing.sm },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  introCard: { marginBottom: spacing.md },
  introText: { fontSize: fontSize.md, color: p.colors.text, lineHeight: 22 },
  sectionCard: { marginBottom: spacing.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionIconWrap: { width: 36, height: 36, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: p.colors.text, flex: 1 },
  sectionContent: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 20 },
  ctaCard: { alignItems: 'center' },
  ctaText: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.sm, textAlign: 'center' },
  ctaLinks: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.lg },
  ctaLink: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.primary },
});
