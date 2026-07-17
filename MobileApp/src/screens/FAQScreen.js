/**
 * FAQScreen — Liquid Glass Design
 * Matches website FAQ page with collapsible categories
 */

import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Animated, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const faqCategories = [
  {
    category: 'Shopping',
    icon: 'bag-handle-outline',
    questions: [
      { q: 'How do I create an account?', a: 'Tap "Sign Up" from the Account tab. You can register with your email or sign in with Google for a faster setup.' },
      { q: 'How do I search for products?', a: 'Use the search bar at the top of the Home screen. You can filter results by category, price range, and more.' },
      { q: 'Can I save items for later?', a: 'Yes! Tap the heart icon on any product to add it to your Wishlist. Access your saved items anytime from the Wishlist tab.' },
    ],
  },
  {
    category: 'Payments',
    icon: 'card-outline',
    questions: [
      { q: 'What payment methods are accepted?', a: 'Checkout supports Stripe card, Rozare Wallet, and Cash on Delivery. One order uses one payment method. COD is available only when every seller allows it; otherwise use card or a sufficient Wallet balance in the checkout currency.' },
      { q: 'How does Rozare Wallet work?', a: 'Open Wallet from your Dashboard or Profile to add balance securely by card and view transactions. USD, PKR, EUR, and GBP balances stay separate and are not converted automatically.' },
      { q: 'Is my payment information secure?', a: 'Payments are processed through Stripe where available, and Rozare does not store your card details.' },
      { q: 'Are there any hidden fees?', a: 'No hidden fees. The price you see includes all applicable taxes (calculated at checkout). Shipping costs are shown before you confirm.' },
    ],
  },
  {
    category: 'Shipping',
    icon: 'airplane-outline',
    questions: [
      { q: 'How long does shipping take?', a: 'Shipping times vary by seller and destination. Each seller configures their own shipping methods with estimated delivery times shown at checkout.' },
      { q: 'Do you ship internationally?', a: 'Many sellers offer international shipping. Check the product page for available shipping destinations. Currency conversion is handled automatically.' },
      { q: 'How do I track my order?', a: 'Once shipped, you\'ll receive a notification with tracking info. You can also track orders from your Dashboard under "Orders".' },
    ],
  },
  {
    category: 'Returns',
    icon: 'refresh-outline',
    questions: [
      { q: 'What is the return policy?', a: 'Return eligibility is seller- and item-specific. The policy saved when you order controls the deadline after that seller portion is delivered. In a mixed order, one seller can allow returns even when another does not.' },
      { q: 'How do I initiate a return?', a: 'Open the delivered order, select Request Return for an eligible seller, choose item quantities, and provide the reason. You can then track approval, pickup, transit, receipt, and review.' },
      { q: 'When is a refund issued?', a: 'The seller must accept and fund the exact approved amount from seller balance or by Stripe card. Only verified funding credits your Rozare Wallet in the order currency and completes the return.' },
    ],
  },
  {
    category: 'Selling',
    icon: 'storefront-outline',
    questions: [
      { q: 'How do I become a seller?', a: 'Tap "Become a Seller" from your profile, add your store details, verify WhatsApp, and activate your seller account. Your 15-day free trial starts when the store is created.' },
      { q: 'What are the seller fees?', a: 'New sellers start with a 15-day free trial. After that, choose Rozare Starter ($5.99/month, with a 30-day free intro) or Rozare Elite ($12.99/month, with a 45-day free intro). Elite includes Rozare-run TikTok ads; Meta ads can be added for $4/month, making Elite + Meta $16.99/month.' },
      { q: 'How do I manage my store?', a: 'The Seller Dashboard gives you full manual control: manage products, track orders, view analytics, configure shipping, and customize settings. You can also use Rozare AI for supported tasks.' },
    ],
  },
  {
    category: 'Trust & Safety',
    icon: 'shield-checkmark-outline',
    questions: [
      { q: 'What is the Trust system?', a: 'Users can "trust" stores they\'ve had good experiences with. Stores with high trust scores get a verified badge, helping other shoppers make confident decisions.' },
      { q: 'How are stores verified?', a: 'Stores go through an admin verification process. Verified stores display a badge, indicating they meet our quality and reliability standards.' },
    ],
  },
];

export default function FAQScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);

  function FAQItem({ q, a }) {
    const [open, setOpen] = useState(false);

    const toggle = () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setOpen(!open);
    };

    return (
      <TouchableOpacity style={styles.faqItem} onPress={toggle} activeOpacity={0.7}>
        <View style={styles.faqHeader}>
          <Text style={styles.faqQuestion}>{q}</Text>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={palette.colors.textSecondary} />
        </View>
        {open && <Text style={styles.faqAnswer}>{a}</Text>}
      </TouchableOpacity>
    );
  }

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>FAQ</Text>
            <Text style={styles.headerSubtitle}>Help Center</Text>
          </View>
          <View style={styles.headerIcon}>
            <Ionicons name="help-circle-outline" size={22} color={palette.colors.primary} />
          </View>
        </GlassPanel>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.heroText}>Find answers to the most common questions about Rozare.</Text>

          {faqCategories.map((cat, i) => (
            <View key={i} style={styles.categoryBlock}>
              <GlassPanel variant="card" style={styles.categoryCard}>
                <View style={styles.categoryHeader}>
                  <View style={styles.categoryIconWrap}>
                    <Ionicons name={cat.icon} size={18} color={palette.colors.primary} />
                  </View>
                  <Text style={styles.categoryTitle}>{cat.category}</Text>
                </View>
                {cat.questions.map((item, j) => (
                  <FAQItem key={j} q={item.q} a={item.a} />
                ))}
              </GlassPanel>
            </View>
          ))}

          <GlassPanel variant="card" style={styles.ctaCard}>
            <Text style={styles.ctaText}>Still have questions?</Text>
            <TouchableOpacity style={styles.ctaBtn} onPress={() => navigation.navigate('Contact')} activeOpacity={0.7}>
              <Ionicons name="mail-outline" size={16} color={palette.colors.white} />
              <Text style={styles.ctaBtnText}>Contact Support</Text>
            </TouchableOpacity>
          </GlassPanel>

          <View style={{ height: 100 }} />
        </ScrollView>
      </SafeAreaView>
    </GlassBackground>
  );
}

const buildStyles = (p) => StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg, marginHorizontal: spacing.md, marginTop: spacing.sm },
  backBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  headerCenter: { flex: 1, marginLeft: spacing.md },
  headerTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: p.colors.text },
  headerSubtitle: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: 2 },
  headerIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  heroText: { fontSize: fontSize.md, color: p.colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg, paddingHorizontal: spacing.lg },
  categoryBlock: { marginBottom: spacing.md },
  categoryCard: { overflow: 'hidden' },
  categoryHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  categoryIconWrap: { width: 36, height: 36, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center', marginRight: spacing.md },
  categoryTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: p.colors.text },
  faqItem: { backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: borderRadius.lg, padding: spacing.md, marginBottom: spacing.sm },
  faqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  faqQuestion: { fontSize: fontSize.md, fontWeight: fontWeight.medium, color: p.colors.text, flex: 1, marginRight: spacing.sm },
  faqAnswer: { fontSize: fontSize.sm, color: p.colors.textSecondary, marginTop: spacing.sm, lineHeight: 20 },
  ctaCard: { alignItems: 'center', marginTop: spacing.md },
  ctaText: { fontSize: fontSize.md, color: p.colors.textSecondary, marginBottom: spacing.md },
  ctaBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg, gap: spacing.sm },
  ctaBtnText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.white },
});
