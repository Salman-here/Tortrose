/**
 * DocsScreen — Mobile parity for /docs (Liquid Glass)
 * Searchable, collapsible documentation sections for shoppers and sellers.
 */

import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, TextInput, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SECTIONS = [
  {
    id: 'what-is-rozare',
    title: 'What is Rozare?',
    icon: 'sparkles-outline',
    body: 'Rozare is an AI-powered marketplace where shoppers discover products and sellers manage stores through dashboard tools, AI chat, and WhatsApp.',
  },
  {
    id: 'ai-shopping',
    title: 'AI-Powered Shopping',
    icon: 'chatbubbles-outline',
    body: 'Tap the AI Assistant to find products, compare options, place orders, track shipments, or get styling advice. The assistant remembers context across the conversation.',
  },
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: 'flash-outline',
    body: 'Sign up with email or Google, browse categories on Home, add items to Cart or Wishlist, and check out securely. Track everything from your Dashboard.',
  },
  {
    id: 'shopping-guide',
    title: 'Shopping Guide',
    icon: 'bag-handle-outline',
    body: 'Use search, category chips, or AI to discover products. Open any product to see images, variants, reviews, store trust score, return policy, and estimated delivery.',
  },
  {
    id: 'cart-wishlist',
    title: 'Cart & Wishlist',
    icon: 'heart-outline',
    body: 'Tap the heart on a product to save it. Cart syncs across devices once you sign in. Apply coupon codes at checkout for instant discounts.',
  },
  {
    id: 'become-seller',
    title: 'Become a Seller',
    icon: 'storefront-outline',
    body: 'Open Become a Seller, verify your email and WhatsApp number, complete business details, and your store goes live with a 15-day free trial of every feature.',
  },
  {
    id: 'product-management',
    title: 'Product Management',
    icon: 'cube-outline',
    body: 'Add up to 1,000 products. Use AI to improve descriptions and auto-generate up to 15 tags. Bulk-update prices and discounts from the Products screen.',
  },
  {
    id: 'whatsapp',
    title: 'Manage Store via WhatsApp',
    icon: 'logo-whatsapp',
    body: 'Connect your WhatsApp number in Seller WhatsApp Settings. Then chat with the Rozare AI on WhatsApp to add products, update stock, manage orders, and get instant new-order notifications.',
  },
  {
    id: 'subscription',
    title: 'Subscription Plans',
    icon: 'diamond-outline',
    body: 'New sellers get a 15-day free trial. Rozare Starter ($5.99/mo) includes unlimited seller AI chat and a 30-day free intro when eligible. Rozare Elite ($12.99/mo) adds advanced tools, 12 featured products, Rozare-run TikTok ads, and a 45-day free intro when eligible. Meta ads can be added to Elite for $4/mo.',
  },
  {
    id: 'payments',
    title: 'Payments & Checkout',
    icon: 'card-outline',
    body: 'Secure card payments run through Stripe. Cash on Delivery is available only when every seller in the cart allows COD. Sellers can require advance online payment from Store Settings, which makes mixed carts card-only if any seller requires advance payment.',
  },
  {
    id: 'shipping',
    title: 'Shipping & Delivery',
    icon: 'airplane-outline',
    body: 'Each seller defines their shipping methods and delivery windows. You\'ll see costs and ETA before confirming. Track orders from your Dashboard.',
  },
  {
    id: 'orders-returns',
    title: 'Orders, Returns & Refunds',
    icon: 'refresh-outline',
    body: 'View all orders in your Dashboard. Open any order to download an invoice, request a return within the policy window, or contact the seller via the AI assistant.',
  },
  {
    id: 'coupons',
    title: 'Coupons & Discounts',
    icon: 'pricetag-outline',
    body: 'Sellers can publish coupon codes redeemable at checkout. Some coupons are scoped to specific products or categories.',
  },
  {
    id: 'trust',
    title: 'Trust & Safety',
    icon: 'shield-checkmark-outline',
    body: 'Trust a store you\'ve had a great experience with. Verified stores show a badge after admin review. Submit a complaint anytime from the AI assistant.',
  },
  {
    id: 'subdomain',
    title: 'Custom Subdomain',
    icon: 'globe-outline',
    body: 'Sellers can claim a yourstore.rozare.com subdomain in Subdomain Management and share it as a branded storefront while their store is active.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: 'notifications-outline',
    body: 'Push notifications for orders, replies, promotions, and complaints. Customize categories in Notification Preferences.',
  },
  {
    id: 'support',
    title: 'Help & Support',
    icon: 'help-circle-outline',
    body: 'Reach us via Contact Support, ask the AI assistant, or check the FAQ for common questions.',
  },
];

export default function DocsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(SECTIONS[0].id);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter(
      (s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q)
    );
  }, [query]);

  const toggle = (id) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenId(openId === id ? null : id);
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <GlassPanel variant="floating" style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => navigation.goBack()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={22} color={palette.colors.text} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>Docs</Text>
            <Text style={styles.headerSubtitle}>The complete Rozare guide</Text>
          </View>
          <View style={styles.headerIcon}>
            <Ionicons name="book-outline" size={22} color={palette.colors.primary} />
          </View>
        </GlassPanel>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={styles.heroText}>
            Shop on Rozare and manage a store or brand with dashboard tools, AI chat, and WhatsApp workflows.
          </Text>

          <GlassPanel variant="card" style={styles.searchCard}>
            <Ionicons name="search-outline" size={18} color={palette.colors.textSecondary} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search documentation..."
              placeholderTextColor={palette.colors.textLight}
            />
            {query ? (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close-circle" size={18} color={palette.colors.textLight} />
              </TouchableOpacity>
            ) : null}
          </GlassPanel>

          {filtered.length === 0 ? (
            <GlassPanel variant="card" style={styles.emptyCard}>
              <Ionicons name="search-outline" size={32} color={palette.colors.textLight} />
              <Text style={styles.emptyText}>No matching topics</Text>
            </GlassPanel>
          ) : (
            filtered.map((s) => {
              const open = openId === s.id;
              return (
                <GlassPanel key={s.id} variant="card" style={styles.sectionCard}>
                  <TouchableOpacity style={styles.sectionHeader} onPress={() => toggle(s.id)} activeOpacity={0.7}>
                    <View style={styles.iconWrap}>
                      <Ionicons name={s.icon} size={18} color={palette.colors.primary} />
                    </View>
                    <Text style={styles.sectionTitle}>{s.title}</Text>
                    <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={palette.colors.textSecondary} />
                  </TouchableOpacity>
                  {open && <Text style={styles.sectionBody}>{s.body}</Text>}
                </GlassPanel>
              );
            })
          )}

          <GlassPanel variant="card" style={styles.ctaCard}>
            <Text style={styles.ctaText}>Need a hand?</Text>
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
  searchCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.md },
  searchInput: { flex: 1, fontSize: fontSize.md, color: p.colors.text, paddingVertical: spacing.xs },
  emptyCard: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  emptyText: { fontSize: fontSize.md, color: p.colors.textSecondary },
  sectionCard: { marginBottom: spacing.sm, overflow: 'hidden' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  iconWrap: { width: 36, height: 36, borderRadius: borderRadius.lg, backgroundColor: 'rgba(99,102,241,0.12)', justifyContent: 'center', alignItems: 'center' },
  sectionTitle: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.text },
  sectionBody: { fontSize: fontSize.sm, color: p.colors.textSecondary, lineHeight: 20, marginTop: spacing.md, paddingLeft: 4 },
  ctaCard: { alignItems: 'center', marginTop: spacing.md },
  ctaText: { fontSize: fontSize.md, color: p.colors.textSecondary, marginBottom: spacing.md },
  ctaBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: borderRadius.lg, gap: spacing.sm },
  ctaBtnText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: p.colors.white },
});
