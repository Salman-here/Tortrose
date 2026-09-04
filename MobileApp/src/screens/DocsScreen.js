/**
 * DocsScreen — Mobile parity for /docs (Liquid Glass)
 * Searchable, collapsible documentation sections for shoppers and sellers.
 */

import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, LayoutAnimation, Platform, UIManager } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import GlassBackground from '../components/common/GlassBackground';
import GlassPanel from '../components/common/GlassPanel';
import PremiumBackHeader from '../components/common/PremiumBackHeader';
import { spacing, fontSize, fontWeight, borderRadius } from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';
import api, { API_ENDPOINTS } from '../config/api';

if (
  Platform.OS === 'android'
  && !globalThis.nativeFabricUIManager
  && UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SECTIONS = [
  {
    id: 'what-is-rozare',
    title: 'What is Rozare?',
    icon: 'sparkles-outline',
    body: 'Rozare is a modern, AI-powered multi-vendor marketplace. Shoppers discover and order products, while sellers manage stores through the Seller Dashboard, AI chat, the mobile app, and WhatsApp. Web and app chat history is kept separate from WhatsApp chat history.',
  },
  {
    id: 'ai-powered-shopping',
    title: 'AI-Powered Shopping',
    icon: 'chatbubbles-outline',
    body: 'The Rozare AI can search products in natural language, give style advice, manage your cart and wishlist, find and validate coupons, help place orders, and track deliveries. It understands context within the current conversation, so follow-up requests such as “show me something cheaper” continue from what you were discussing. When signed in, tap History to reopen, search, rename, or delete saved web and app conversations, and use New Chat whenever you want a fresh session.',
  },
  {
    id: 'getting-started',
    title: 'Getting Started',
    icon: 'flash-outline',
    body: 'Create an account with email and a 6-digit verification code, or continue with Google. You can save a default shipping address, multiple delivery addresses, and a preferred display currency. Guests can browse, search, and use AI product discovery; sign in to sync the cart, save a wishlist, place orders, and receive personalized help.',
  },
  {
    id: 'shopping-guide',
    title: 'Shopping Guide',
    icon: 'bag-handle-outline',
    body: 'Find products through AI search, categories, store pages, or direct catalog search. Open a product, swipe through its images, choose required variants, add it to Cart, confirm the shipping address and one shipping method per seller, apply a coupon, then pay for the full order with one method: Stripe card, Rozare Wallet, or Cash on Delivery when every seller allows COD. Track orders from Track My Order, your account, or the AI.',
  },
  {
    id: 'cart-and-wishlist',
    title: 'Cart & Wishlist',
    icon: 'heart-outline',
    body: 'Add products from cards, Product Details, or AI chat; update quantities within live stock limits. A guest cart syncs to the account after sign-in. Tap the heart to save products to the Wishlist and move them to Cart when ready.',
  },
  {
    id: 'become-a-seller',
    title: 'Become a Seller',
    icon: 'storefront-outline',
    body: 'Open Become a Seller, create or sign in to your account, add the required business and store details, and verify your WhatsApp number. Final activation creates the store immediately and starts a 15-day free trial for core selling features and eligible Elite tools. A valid email and an active store are required before listing products; store verification can be requested after launch.',
  },
  {
    id: 'seller-guide',
    title: 'Seller Dashboard Guide',
    icon: 'grid-outline',
    body: 'The Seller Dashboard is the store command center for overview metrics, products, orders, payments and withdrawals, ads, coupons, analytics, Store Settings, shipping, WhatsApp, subdomain, subscription, notifications, and seller profile. In a multi-seller order, each seller sees only their own products, prices, fulfillment, and revenue—never another seller’s data.',
  },
  {
    id: 'product-management',
    title: 'Product Management',
    icon: 'cube-outline',
    body: 'Add a product with name, brand, category, price, stock, description, and at least one image. Descriptions support up to 2,000 characters and products can include searchable tags. Optional fields include offer price, variants, extra images, featured status, and a product-specific return or warranty policy. Eligible AI tools can improve descriptions and generate a focused tag list; bulk tools can update selected prices and discounts. Starter can feature up to 6 products and Elite up to 12.',
  },
  {
    id: 'ai-for-sellers',
    title: 'AI for Sellers',
    icon: 'analytics-outline',
    body: 'The seller AI can perform supported product, stock, order, coupon, analytics, payment-help, and store-management tasks using only that seller’s data. It also recognizes buyer requests when a seller shops on Rozare. Web and app shopping chat allow 5 messages per UTC day for guests and 20 for signed-in buyers; sellers are unlimited by this daily chat quota. WhatsApp uses separate protections and conversation history.',
  },
  {
    id: 'whatsapp-integration',
    title: 'Manage Store via WhatsApp',
    icon: 'logo-whatsapp',
    body: 'Connect and verify a country-code WhatsApp number in Seller WhatsApp Settings, then choose notification preferences. Sellers can receive instant new-order alerts and use supported Rozare AI tasks such as product, stock, order, discount, and analytics management. Shoppers can receive order updates and use supported shopping assistance. COD confirmations can also be handled through WhatsApp.',
  },
  {
    id: 'subscription-plans',
    title: 'Subscription Plans',
    icon: 'diamond-outline',
    body: 'Every seller starts with a 15-day free trial, may list up to 15 products during that trial, receives core Starter access plus eligible Elite growth tools, and does not need a credit card. Paid Starter includes a public store, unlimited listings, secure payments, a custom subdomain, order management and customer insights, unlimited seller AI, WhatsApp management, new-order alerts, order-confirmation automation, and 6 featured products. Its $11.75 list price has a 15% launch discount to $9.99/month and one 30-day introductory period when the account has not used it before. Starter includes one six-month bonus period with smart descriptions, advanced analytics, smart tags, priority support, coupons, and bulk promotion tools; restarting or switching plans does not grant a fresh Starter bonus period. Paid Elite has 12 featured products, a $30.93 list price, a 30% launch discount to $21.65/month, and one 45-day introductory period when eligible. Elite keeps the growth tools permanently while active and adds custom store themes plus Rozare-run TikTok ads; Meta ads are an optional $4/month add-on. The first 100 sellers whose subscription Checkout completes with FIRST100 receive an extra 40% founder discount, locking Starter at $5.99 or Elite at $12.99 while that subscription remains uninterrupted. Starting Checkout reserves a place for 35 minutes, and the rate is claimed only after Stripe confirms completion. The founder rate survives Starter/Elite changes and renewals but is permanently forfeited if the subscription ends. Upgrades and Meta changes are immediate and may be prorated, Elite-to-Starter downgrades start at period end, and cancellation keeps access active through the current period. When access ends the public store and products are hidden but data is preserved. A Starter seller with unused bonus time has 3 days after blocking to re-subscribe before those bonus tools are permanently removed from Starter.',
  },
  {
    id: 'payments',
    title: 'Payments & Checkout',
    icon: 'card-outline',
    body: 'Checkout supports Stripe card, Rozare Wallet, and Cash on Delivery. One order uses one payment method. COD is available only when every seller allows it; otherwise use card or enough Wallet balance in the exact checkout currency. USD, PKR, EUR, and GBP Wallet balances stay separate and are never converted automatically. Delivered Stripe- and Wallet-paid seller revenue becomes withdrawable after existing withdrawals and completed return-refund debits are reserved. Delivered COD revenue is reported, but cash and shipping payment are handled directly by the seller. Withdrawal requests require saved bank details and admin review.',
  },
  {
    id: 'shipping',
    title: 'Shipping & Delivery',
    icon: 'airplane-outline',
    body: 'Each seller configures available shipping choices, costs, and delivery windows. Buyers see the applicable options and ETA before confirming and choose one method for each seller in a multi-seller cart. Sellers can enable or disable their saved methods without deleting their configuration.',
  },
  {
    id: 'orders-returns',
    title: 'Orders, Returns & Refunds',
    icon: 'refresh-outline',
    body: 'Orders move through Pending, Confirmed, Processing, Shipped, and Delivered, with cancellation only while allowed. Return eligibility is saved per item at checkout from the seller or product policy. In multi-seller orders, each seller manages only their own eligible items. Buyers select quantities and a reason, then track approval, pickup, transit, receipt, and review. An accepted Wallet refund is credited only after the seller funds the exact approved amount from seller balance or card; failed, expired, cancelled, duplicate, excess, or mismatched funding cannot create a refund. Replacement-only returns complete without a money transfer.',
  },
  {
    id: 'coupons-discounts',
    title: 'Coupons & Discounts',
    icon: 'pricetag-outline',
    body: 'Shoppers can discover and apply valid coupons at checkout. Sellers can create, edit, enable, disable, and review store-scoped percentage or fixed discounts, with product/category scope, minimum order amount, maximum discount, start and expiry dates, total-use limits, and per-user limits. Validation is enforced at checkout.',
  },
  {
    id: 'trust-safety',
    title: 'Trust & Safety',
    icon: 'shield-checkmark-outline',
    body: 'Rozare uses store verification, public trust counts, verified-purchase store reviews, complaint support, HTTPS, role checks, and seller data isolation. In a multi-seller order, each seller sees only their own portion. A store review unlocks separately when that seller’s portion is delivered.',
  },
  {
    id: 'store-verification',
    title: 'Store Verification',
    icon: 'checkmark-circle-outline',
    body: 'Apply from Seller Dashboard → Store Settings → Verification, provide valid contact details and a short message, then wait for admin review. A suitable application has an active store, listed products, a complete profile, valid contact information, and no outstanding policy violations. Approval adds a verified badge to the store and product surfaces.',
  },
  {
    id: 'subdomain',
    title: 'Custom Subdomain',
    icon: 'globe-outline',
    body: 'Sellers can claim and manage a professional yourstore.rozare.com address from Seller Dashboard → Subdomain. Availability and protected-name rules are checked before changes. The address needs no DNS setup and remains tied to the seller’s active store and applicable subscription or ownership status.',
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: 'notifications-outline',
    body: 'Rozare uses in-app notifications, mobile push, WhatsApp, and email for supported order, delivery, customer, complaint, account, and security events. Notification Settings lets you control eligible channels and categories. Messages are scoped to the intended account and role.',
  },
  {
    id: 'mobile-app',
    title: 'Rozare Mobile App',
    icon: 'phone-portrait-outline',
    body: 'The iOS and Android app brings buyer and seller workflows to the phone: product browsing, image galleries, checkout, orders, AI chat and voice, push notifications, light and dark themes, pull-to-refresh, onboarding, Seller Dashboard quick actions, trust controls, and bulk seller tools.',
  },
  {
    id: 'currency-multilingual',
    title: 'Currency & Languages',
    icon: 'language-outline',
    body: 'Choose a display currency such as USD, EUR, GBP, or PKR and Rozare converts catalog prices for display. Checkout and Wallet transactions still use one exact order currency, and Wallet balances are not converted automatically. The conversational AI understands English, modern Roman Urdu, and common product slang.',
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting & Help',
    icon: 'help-circle-outline',
    body: 'If a product cannot be added, confirm the store and subscription are active and all required fields are complete. If an order is missing, refresh and confirm the correct account. Ads require Elite, an active featured product, and no pending request; Meta ads also require the add-on. For WhatsApp OTP issues, confirm the country code and wait for the resend timer. Contact Support or ask the in-app AI when you need more help.',
  },
  {
    id: 'faq',
    title: 'Frequently Asked Questions',
    icon: 'chatbubble-ellipses-outline',
    body: 'Shopping has no membership fee. Sellers receive a 15-day trial before choosing Starter or Elite. Stores can be managed through the dashboard and supported AI or WhatsApp tools. All traffic uses HTTPS and seller tools are isolated by account. Stripe, same-currency Wallet, and eligible COD checkout are supported. If a trial or subscription ends, the store and products are hidden while the data is preserved. Product descriptions support up to 2,000 characters, and Rozare currently focuses on physical products with shipping.',
  },
];

const safeInteger = (value, fallback) => (
  Number.isSafeInteger(value) && value >= 0 ? value : fallback
);

const formatUsd = (cents, fallback) => {
  if (!Number.isSafeInteger(cents) || cents < 0) return fallback;
  const value = BigInt(cents);
  return `$${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
};

export const buildSubscriptionDocsBody = (catalog) => {
  const pricing = catalog?.pricing;
  const starter = pricing?.starter;
  const elite = pricing?.elite;
  const trialDays = safeInteger(catalog?.trial?.days, 15);
  const trialProductLimit = safeInteger(catalog?.trial?.productListingLimit, 15);
  const starterFeatured = safeInteger(catalog?.starter?.featuredProductLimit, 6);
  const eliteFeatured = safeInteger(catalog?.elite?.featuredProductLimit, 12);
  const bonusMonths = safeInteger(catalog?.starter?.bonusFeaturesMonths, 6);
  const graceDays = safeInteger(catalog?.bonusGraceDays, 3);
  const founderCode = typeof catalog?.founderPromotion?.code === 'string'
    && catalog.founderPromotion.code.trim()
    ? catalog.founderPromotion.code.trim()
    : 'FIRST100';
  const founderDiscount = safeInteger(catalog?.founderPromotion?.discountPercent, 40);
  const founderMax = safeInteger(catalog?.founderPromotion?.maxRedemptions, 100);
  const founderReservationMinutes = safeInteger(
    catalog?.founderPromotion?.checkoutReservationMinutes,
    35,
  );
  const starterList = formatUsd(starter?.listAmountCents, '$11.75');
  const starterPrice = formatUsd(starter?.standardAmountCents, '$9.99');
  const starterFounder = formatUsd(starter?.founderAmountCents, '$5.99');
  const eliteList = formatUsd(elite?.listAmountCents, '$30.93');
  const elitePrice = formatUsd(elite?.standardAmountCents, '$21.65');
  const eliteFounder = formatUsd(elite?.founderAmountCents, '$12.99');
  const metaPrice = formatUsd(pricing?.metaAdsAddonCents, '$4.00');
  const starterDiscount = safeInteger(starter?.advertisedDiscountPercent, 15);
  const eliteDiscount = safeInteger(elite?.advertisedDiscountPercent, 30);
  const starterIntro = safeInteger(starter?.freePeriodDays, 30);
  const eliteIntro = safeInteger(elite?.freePeriodDays, 45);
  const starterFeatures = Array.isArray(catalog?.features?.starter)
    ? catalog.features.starter.join(', ')
    : 'public store access, unlimited listings, secure payments, a custom subdomain, order management, unlimited seller AI, WhatsApp management and order alerts';
  const bonusFeatures = Array.isArray(catalog?.features?.bonus)
    ? catalog.features.bonus.join(', ')
    : 'smart descriptions, advanced analytics, smart tags, priority support, coupons, and bulk promotion tools';
  const eliteOnlyFeatures = Array.isArray(catalog?.features?.eliteOnly)
    ? catalog.features.eliteOnly.join(', ')
    : 'custom store themes and Rozare-run TikTok ads';

  return `Every seller starts with a ${trialDays}-day free trial, may list up to ${trialProductLimit} products during that trial, receives core Starter access plus eligible Elite growth tools, and does not need a credit card. Paid Starter includes ${starterFeatures}; it supports ${starterFeatured} featured products, has a ${starterList} list price, a ${starterDiscount}% launch discount to ${starterPrice}/month, and one ${starterIntro}-day introductory period when the account has not used it before. Its temporary growth tools are ${bonusFeatures}; they last for one ${bonusMonths}-month Starter bonus period, and restarting or switching plans does not grant a fresh period. Paid Elite supports ${eliteFeatured} featured products, has a ${eliteList} list price, a ${eliteDiscount}% launch discount to ${elitePrice}/month, and one ${eliteIntro}-day introductory period when eligible. Elite keeps the growth tools permanently while active and adds ${eliteOnlyFeatures}; Meta ads are an optional ${metaPrice}/month add-on. The first ${founderMax} sellers whose subscription Checkout completes with ${founderCode} receive an extra ${founderDiscount}% founder discount, locking Starter at ${starterFounder} or Elite at ${eliteFounder} while that subscription remains uninterrupted. Starting Checkout reserves a place for ${founderReservationMinutes} minutes, and the rate is claimed only after Stripe confirms completion. The founder rate survives plan changes and renewals but is permanently forfeited if the subscription ends. Upgrades and Meta changes are immediate and may be prorated, downgrades start at period end, and cancellation keeps access active through the current period. When access ends, the public store and products are hidden but data is preserved. A Starter seller with unused bonus time has ${graceDays} days after blocking to re-subscribe before those bonus tools are permanently removed from Starter.`;
};

export default function DocsScreen({ navigation }) {
  const { palette } = useTheme();
  const styles = buildStyles(palette);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState(SECTIONS[0].id);
  const [subscriptionCatalog, setSubscriptionCatalog] = useState(null);

  useEffect(() => {
    let active = true;
    api.get(API_ENDPOINTS.SUBSCRIPTION.CATALOG, { skipAuthSessionCleanup: true })
      .then((response) => {
        if (active && response.data?.catalog) setSubscriptionCatalog(response.data.catalog);
      })
      .catch(() => {
        // The bundled documentation remains available offline. Live catalog
        // values replace it automatically whenever the API is reachable.
      });
    return () => { active = false; };
  }, []);

  const sections = useMemo(() => SECTIONS.map(section => (
    section.id === 'subscription-plans' && subscriptionCatalog
      ? { ...section, body: buildSubscriptionDocsBody(subscriptionCatalog) }
      : section
  )), [subscriptionCatalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(
      (s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q)
    );
  }, [query, sections]);

  const toggle = (id) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenId(openId === id ? null : id);
  };

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <PremiumBackHeader
          title="Docs"
          subtitle="The complete Rozare guide"
          icon="book-outline"
          onBack={() => navigation.goBack()}
          rightIcon="compass-outline"
          rightLabel="Guide"
          style={styles.premiumHeader}
        />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <Text style={styles.heroText}>
            Shop on Rozare and manage a store or brand with dashboard tools, AI chat, and WhatsApp workflows. This guide explains the marketplace end to end.
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
  premiumHeader: { marginTop: spacing.sm },
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
