/**
 * AboutScreen — Liquid Glass Design
 * Matches website About page
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

const stats = [
  { value: '15 Days', label: 'Free Trial' },
  { value: '2 Plans', label: 'Starter & Elite' },
  { value: 'AI + Dashboard', label: 'Store Management' },
  { value: 'Web + WhatsApp', label: 'Seller Workflows' },
];

const values = [
  { icon: 'shield-checkmark-outline', title: 'Trust & Safety', desc: 'Stores can earn trust signals and verified badges, helping shoppers choose with more confidence.' },
  { icon: 'flash-outline', title: 'Fast & Seamless', desc: 'Buyers can browse, compare, save, and checkout while sellers manage products, orders, and promotions from one place.' },
  { icon: 'globe-outline', title: 'Flexible Commerce', desc: 'Multi-currency browsing, seller-managed shipping, and custom storefronts support growing online businesses.' },
  { icon: 'heart-outline', title: 'Community First', desc: 'Built for independent sellers and conscious shoppers who value quality over quantity.' },
];

export default function AboutScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="About Us"
          subtitle="Our Story"
          icon="information-circle-outline"
          onBack={() => navigation.goBack()}
          rightIcon="heart-outline"
          rightLabel="Rozare"
          style={styles.premiumHeader}
        />

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          {/* Hero */}
          <Text style={styles.heroTitle}>About Rozare</Text>
          <Text style={styles.heroDesc}>
            An AI-powered marketplace built for independent sellers, brands, and thoughtful shoppers who value clear information, flexible tools, and trust.
          </Text>

          {/* Mission */}
          <GlassPanel variant="card" style={styles.missionCard}>
            <Text style={styles.missionTitle}>Our Mission</Text>
            <Text style={styles.missionText}>
              To empower independent sellers with storefronts, AI-assisted workflows, and practical dashboard tools, while giving shoppers a clearer way to discover products, compare stores, and buy with confidence.
            </Text>
          </GlassPanel>

          {/* Stats */}
          <View style={styles.statsGrid}>
            {stats.map((s, i) => (
              <GlassPanel key={i} variant="card" style={styles.statCard}>
                <Text style={styles.statValue}>{s.value}</Text>
                <Text style={styles.statLabel}>{s.label}</Text>
              </GlassPanel>
            ))}
          </View>

          {/* Values */}
          <Text style={styles.sectionTitle}>What We Stand For</Text>
          {values.map((v, i) => (
            <GlassPanel key={i} variant="card" style={styles.valueCard}>
              <View style={styles.valueIconWrap}>
                <Ionicons name={v.icon} size={20} color={palette.colors.primary} />
              </View>
              <View style={styles.valueText}>
                <Text style={styles.valueTitle}>{v.title}</Text>
                <Text style={styles.valueDesc}>{v.desc}</Text>
              </View>
            </GlassPanel>
          ))}

          {/* CTA */}
          <GlassPanel variant="card" style={styles.ctaCard}>
            <Text style={styles.ctaTitle}>Ready to join Rozare?</Text>
            <Text style={styles.ctaDesc}>Start shopping or become a seller today.</Text>
            <View style={styles.ctaButtons}>
              <TouchableOpacity style={styles.ctaPrimary} onPress={() => navigation.navigate('MainTabs')} activeOpacity={0.7}>
                <Text style={styles.ctaPrimaryText}>Browse Products</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.ctaSecondary} onPress={() => navigation.navigate('BecomeSeller')} activeOpacity={0.7}>
                <Text style={styles.ctaSecondaryText}>Become a Seller</Text>
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
  heroTitle: { fontSize: fontSize.title, fontWeight: fontWeight.bold, color: p.colors.primary, textAlign: 'center', marginBottom: spacing.sm },
  heroDesc: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: spacing.lg, paddingHorizontal: spacing.md },
  missionCard: { marginBottom: spacing.lg },
  missionTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.sm, textAlign: 'center' },
  missionText: { fontSize: fontSize.md, color: p.colors.textSecondary, lineHeight: 22, textAlign: 'center' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  statCard: { flex: 1, minWidth: '45%', alignItems: 'center', paddingVertical: spacing.lg },
  statValue: { fontSize: fontSize.xxxl, fontWeight: fontWeight.bold, color: p.colors.primary },
  statLabel: { fontSize: fontSize.xs, color: p.colors.textSecondary, marginTop: 4 },
  sectionTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, textAlign: 'center', marginBottom: spacing.md },
  valueCard: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.md },
  valueIconWrap: { width: 40, height: 40, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  valueText: { flex: 1 },
  valueTitle: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text, marginBottom: 4 },
  valueDesc: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 20 },
  ctaCard: { alignItems: 'center', marginTop: spacing.sm },
  ctaTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: p.colors.text, marginBottom: spacing.sm },
  ctaDesc: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginBottom: spacing.lg },
  ctaButtons: { flexDirection: 'row', gap: spacing.md },
  ctaPrimary: { backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg },
  ctaPrimaryText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.white },
  ctaSecondary: { backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg },
  ctaSecondaryText: { fontSize: fontSize.md, fontWeight: fontWeight.medium, color: p.colors.text },
});
