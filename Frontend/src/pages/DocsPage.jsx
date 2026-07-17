import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

// On the docs subdomain, internal app links must hop to the main domain.
const mainHref = (path) => {
  if (typeof window === 'undefined') return path;
  const host = window.location.hostname;
  if (host.startsWith('docs.')) {
    return `${window.location.protocol}//${host.replace(/^docs\./, '')}${path}`;
  }
  return path;
};
import {
  Book, ShoppingBag, Store, Bot, Smartphone, CreditCard, Shield, Truck,
  Users, BarChart3, MessageCircle, Sparkles, ChevronRight, Search,
  Star, Zap, Globe, Lock, Heart, ArrowRight, ExternalLink, Hash,
  Package, Settings, Bell, Ticket, Eye, CheckCircle, XCircle,
  HelpCircle, Palette, TrendingUp, Award, Megaphone, FileText,
  Lightbulb, Info, AlertTriangle, Wand2, Tag, Image as ImageIcon,
  RefreshCw, Layers, Gem
} from 'lucide-react';
import { Helmet } from 'react-helmet-async';

// ─── Section Data ───
const SECTIONS = [
  { id: 'what-is-rozare', title: 'What is Rozare?', icon: Sparkles },
  { id: 'ai-powered-shopping', title: 'AI-Powered Shopping', icon: Bot },
  { id: 'getting-started', title: 'Getting Started', icon: Zap },
  { id: 'shopping-guide', title: 'Shopping Guide', icon: ShoppingBag },
  { id: 'cart-and-wishlist', title: 'Cart & Wishlist', icon: Heart },
  { id: 'become-a-seller', title: 'Become a Seller', icon: Store },
  { id: 'seller-guide', title: 'Seller Dashboard Guide', icon: Settings },
  { id: 'product-management', title: 'Product Management', icon: Package },
  { id: 'ai-for-sellers', title: 'AI for Sellers', icon: BarChart3 },
  { id: 'whatsapp-integration', title: 'Manage Store via WhatsApp', icon: Smartphone },
  { id: 'subscription-plans', title: 'Subscription Plans', icon: Award },
  { id: 'payments', title: 'Payments & Checkout', icon: CreditCard },
  { id: 'shipping', title: 'Shipping & Delivery', icon: Truck },
  { id: 'orders-returns', title: 'Orders, Returns & Refunds', icon: RefreshCw },
  { id: 'coupons-discounts', title: 'Coupons & Discounts', icon: Ticket },
  { id: 'trust-safety', title: 'Trust & Safety', icon: Shield },
  { id: 'store-verification', title: 'Store Verification', icon: CheckCircle },
  { id: 'subdomain', title: 'Custom Subdomain', icon: Globe },
  { id: 'notifications', title: 'Notifications', icon: Bell },
  { id: 'mobile-app', title: 'Rozare Mobile App', icon: Smartphone },
  { id: 'currency-multilingual', title: 'Currency & Languages', icon: Globe },
  { id: 'troubleshooting', title: 'Troubleshooting & Help', icon: HelpCircle },
  { id: 'faq', title: 'Frequently Asked Questions', icon: HelpCircle },
];

function DocsPage() {
  const [activeSection, setActiveSection] = useState('what-is-rozare');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const contentRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        });
      },
      { rootMargin: '-100px 0px -60% 0px', threshold: 0.1 }
    );
    SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const filteredSections = searchQuery
    ? SECTIONS.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : SECTIONS;

  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setIsSidebarOpen(false);
    }
  };

  // Schema.org structured data for SEO + AI search engines
  const DOCS_URL = 'https://docs.rozare.com/';
  const schemaData = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: 'Rozare Documentation - AI Shopping, Seller Dashboard & WhatsApp Store Management',
    name: 'Rozare Documentation',
    description: 'Complete buyer and seller guide for Rozare: shopping, AI chat, seller dashboard, WhatsApp store management, seller payments, withdrawals, subscriptions, coupons, shipping, orders, and trust tools.',
    inLanguage: 'en',
    url: DOCS_URL,
    image: 'https://rozare.com/og-image.png?v=4',
    datePublished: '2026-01-01',
    dateModified: new Date().toISOString().slice(0, 10),
    author: { '@type': 'Organization', name: 'Rozare', url: 'https://rozare.com' },
    publisher: {
      '@type': 'Organization',
      name: 'Rozare',
      url: 'https://rozare.com',
      logo: { '@type': 'ImageObject', url: 'https://rozare.com/rozare-logo.svg' },
    },
    about: ['AI-powered marketplace', 'Conversational commerce', 'WhatsApp store management', 'Seller payments', 'Online selling', 'Online shopping'],
    keywords: 'Rozare, AI marketplace, AI shopping, AI commerce, sell online, seller payments, Stripe payouts, WhatsApp store management, chat to sell, conversational commerce, Rozare Starter, Rozare Elite, become a seller',
    mainEntity: {
      '@type': 'FAQPage',
      mainEntity: [
        { '@type': 'Question', name: 'What is Rozare?', acceptedAnswer: { '@type': 'Answer', text: 'Rozare is an AI-powered marketplace where shoppers discover products and sellers manage stores through dashboard tools, AI chat, and WhatsApp.' } },
        { '@type': 'Question', name: 'How do I become a seller on Rozare?', acceptedAnswer: { '@type': 'Answer', text: 'Go to /become-seller, create or sign in to your account, add your store details, verify your WhatsApp number, and activate your seller account to start the 15-day free trial.' } },
        { '@type': 'Question', name: 'Can I manage my Rozare store from WhatsApp?', acceptedAnswer: { '@type': 'Answer', text: 'Yes. Connect your WhatsApp number in seller settings and chat with the Rozare AI to add products, update stock, manage orders, run analytics, and get instant new-order notifications.' } },
        { '@type': 'Question', name: 'How much does Rozare cost?', acceptedAnswer: { '@type': 'Answer', text: 'Shopping on Rozare is free. Sellers start with a 15-day free trial for core selling features and eligible Elite tools, then choose Rozare Starter ($5.99/month, with a 30-day free intro) or Rozare Elite ($12.99/month, with a 45-day free intro). Elite includes Rozare-run TikTok ads; Meta ads can be added for $4/month, making Elite + Meta $16.99/month.' } },
        { '@type': 'Question', name: 'Does Rozare have a mobile app?', acceptedAnswer: { '@type': 'Answer', text: 'Rozare includes a React Native / Expo mobile app experience for iOS and Android with shopping, selling, AI chat, and push notification support.' } },
      ],
    },
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Rozare', item: 'https://rozare.com/' },
      { '@type': 'ListItem', position: 2, name: 'Documentation', item: DOCS_URL },
    ],
  };

  return (
    <>
      <Helmet>
        <title>Rozare Docs - AI Shopping, Seller Dashboard & WhatsApp Store Management</title>
        <meta name="description" content="Complete buyer and seller guide for Rozare: shopping, AI chat, seller dashboard, WhatsApp store management, seller payments, withdrawals, subscriptions, coupons, shipping, orders, and trust tools." />
        <meta name="keywords" content="Rozare, Rozare docs, Rozare documentation, AI marketplace, AI shopping, AI commerce, conversational commerce, sell online, seller payments, Stripe payouts, WhatsApp store management, chat to sell, online marketplace, AI store assistant, Rozare Starter, Rozare Elite, become a seller, Rozare guide, Rozare help" />
        <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />
        <link rel="canonical" href={DOCS_URL} />
        <meta property="og:site_name" content="Rozare" />
        <meta property="og:type" content="article" />
        <meta property="og:title" content="Rozare Documentation - AI Shopping & Selling" />
        <meta property="og:description" content="Learn how Rozare shopping, seller dashboards, AI chat, WhatsApp store management, seller payments, withdrawals, subscriptions, coupons, shipping, and trust tools work." />
        <meta property="og:url" content={DOCS_URL} />
        <meta property="og:image" content="https://rozare.com/og-image.png?v=4" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@RozareHQ" />
        <meta name="twitter:title" content="Rozare Docs - AI Shopping & Selling" />
        <meta name="twitter:description" content="Complete guide to Rozare shopping, seller dashboard tools, AI chat, WhatsApp store management, seller payments, subscriptions, and trust tools." />
        <meta name="twitter:image" content="https://rozare.com/og-image.png?v=4" />
        <script type="application/ld+json">{JSON.stringify(schemaData)}</script>
        <script type="application/ld+json">{JSON.stringify(breadcrumbSchema)}</script>
      </Helmet>

      <div className="min-h-screen" style={{ background: 'hsl(var(--background))' }}>
        {/* Hero */}
        <div className="relative overflow-hidden py-16 md:py-24" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 8%), hsl(260, 60%, 12%), hsl(220, 70%, 8%))' }}>
          <div className="absolute inset-0 opacity-20" style={{ background: 'radial-gradient(circle at 30% 50%, hsl(220, 70%, 40%), transparent 60%), radial-gradient(circle at 70% 50%, hsl(280, 60%, 40%), transparent 60%)' }} />
          <div className="relative max-w-5xl mx-auto px-4 text-center">
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full mb-6" style={{ background: 'hsl(220, 70%, 55%, 0.15)', border: '1px solid hsl(220, 70%, 55%, 0.3)' }}>
                <Book size={16} style={{ color: 'hsl(220, 70%, 65%)' }} />
                <span className="text-sm font-medium" style={{ color: 'hsl(220, 70%, 75%)' }}>Documentation</span>
              </div>
              <h1 className="text-4xl md:text-5xl font-bold mb-4" style={{ color: 'white' }}>
                Rozare <span style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 65%), hsl(280, 60%, 65%))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Documentation</span>
              </h1>
              <p className="text-lg md:text-xl max-w-3xl mx-auto mb-8" style={{ color: 'hsl(220, 20%, 70%)' }}>
                Shop on Rozare and manage a store or brand with dashboard tools, AI chat, and WhatsApp workflows. This guide explains the marketplace end to end.
              </p>
              <div className="max-w-lg mx-auto relative">
                <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'hsl(220, 20%, 50%)' }} />
                <input
                  type="text"
                  placeholder="Search documentation..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-xl text-sm outline-none"
                  style={{ background: 'hsl(220, 30%, 15%)', border: '1px solid hsl(220, 30%, 25%)', color: 'white' }}
                />
              </div>
            </motion.div>
          </div>
        </div>

        {/* Mobile sticky topic chip bar */}
        <div className="lg:hidden sticky top-[80px] z-30 px-3 py-2"
          style={{ background: 'hsl(var(--background) / 0.85)', backdropFilter: 'blur(10px)', borderBottom: '1px solid hsl(var(--border))' }}>
          <button onClick={() => setIsSidebarOpen(o => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'hsl(var(--muted) / 0.5)', border: '1px solid hsl(var(--border))', color: 'hsl(var(--foreground))' }}>
            <span className="flex items-center gap-2 min-w-0 truncate">
              <Hash size={14} style={{ color: 'hsl(220, 70%, 65%)' }} />
              <span className="truncate">{SECTIONS.find(s => s.id === activeSection)?.title || 'Sections'}</span>
            </span>
            <ChevronRight size={16} className={`shrink-0 transition-transform ${isSidebarOpen ? 'rotate-90' : ''}`} />
          </button>
          {isSidebarOpen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              className="mt-2 max-h-[60vh] overflow-y-auto rounded-xl p-2 space-y-1"
              style={{ background: 'hsl(var(--background))', border: '1px solid hsl(var(--border))' }}>
              {filteredSections.map(({ id, title, icon: Icon }) => (
                <button key={id} onClick={() => scrollToSection(id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-all"
                  style={{
                    background: activeSection === id ? 'hsl(220, 70%, 55%, 0.1)' : 'transparent',
                    color: activeSection === id ? 'hsl(220, 70%, 65%)' : 'hsl(var(--foreground))',
                  }}>
                  <Icon size={14} />
                  <span className="truncate">{title}</span>
                </button>
              ))}
            </motion.div>
          )}
        </div>

        {/* Main Content */}
        <div className="max-w-7xl mx-auto px-4 py-8 flex flex-col lg:flex-row gap-8">
          {/* Sidebar (desktop) */}
          <aside className="hidden lg:block w-64 shrink-0">
            <div className="sticky top-24 space-y-1 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
              <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'hsl(var(--muted-foreground))' }}>On this page</p>
              {filteredSections.map(({ id, title, icon: Icon }) => (
                <button key={id} onClick={() => scrollToSection(id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition-all ${activeSection === id ? 'font-medium' : ''}`}
                  style={{
                    background: activeSection === id ? 'hsl(220, 70%, 55%, 0.1)' : 'transparent',
                    color: activeSection === id ? 'hsl(220, 70%, 65%)' : 'hsl(var(--muted-foreground))',
                    borderLeft: activeSection === id ? '2px solid hsl(220, 70%, 55%)' : '2px solid transparent',
                  }}>
                  <Icon size={14} />
                  <span className="truncate">{title}</span>
                </button>
              ))}
            </div>
          </aside>

          {/* Content */}
          <main className="flex-1 min-w-0 max-w-4xl" ref={contentRef}>
            <div className="space-y-16">

              {/* WHAT IS ROZARE */}
              <DocSection id="what-is-rozare" title="What is Rozare?" icon={Sparkles}>
                <p>
                  <strong>Rozare</strong> is a modern, AI-powered marketplace where shoppers can discover products and sellers can manage stores through the dashboard, AI chat, and WhatsApp. Instead of jumping between tools for supported tasks, you can talk to the Rozare AI in plain language and let it help.
                </p>
                <FeatureGrid features={[
                  { icon: Bot, title: 'Chat-First Experience', desc: 'Search products, place orders, add inventory, run discounts, and pull analytics — all by chatting in natural language.' },
                  { icon: Smartphone, title: 'WhatsApp Storefront', desc: 'Sellers can add products, manage orders, and receive new-order alerts directly in WhatsApp by chatting with the Rozare AI.' },
                  { icon: Globe, title: 'Multi-Vendor Marketplace', desc: 'Browse stores from independent sellers worldwide, with multi-currency pricing and trust badges on verified shops.' },
                  { icon: Shield, title: 'Trust & Verification', desc: 'Verified store badges, customer trust counts, store reviews, and a complaint system keep the marketplace safe.' },
                ]} />
                <h3>How Rozare is Different</h3>
                <p>Traditional e-commerce makes you browse, filter, compare, fill checkout forms, and manage inventory through dozens of screens. On Rozare, you just say what you want:</p>
                <CodeBlock lines={[
                  '"Find me a blue dress under $50"',
                  '"Add 20 units of stock to my white sneakers"',
                  '"How many orders did I get today and what was my revenue?"',
                  '"Create a 15% off coupon valid for 7 days"',
                  '"Place an order for this — cash on delivery"',
                ]} />
                <p>The same AI works on the web, on the mobile app, and on WhatsApp. Your conversation history syncs across them all.</p>
              </DocSection>

              {/* AI-POWERED SHOPPING */}
              <DocSection id="ai-powered-shopping" title="AI-Powered Shopping" icon={Bot}>
                <p>
                  The Rozare AI is your personal shopping companion. It is not a scripted bot — it has real, secure access to the marketplace and can <strong>execute actions on your behalf</strong>: search products, manage your cart, apply coupons, place orders, and track deliveries.
                </p>
                <h3>What the AI can do for shoppers</h3>
                <ul>
                  <li><strong>Smart product search</strong> — Understands natural language and slang. Say "something cosy for winter" or "chapal" and it finds matching items.</li>
                  <li><strong>Style & outfit advice</strong> — Personalized fashion recommendations, color suggestions, and outfit pairings.</li>
                  <li><strong>Cart management</strong> — "Add this to my cart", "Remove the shoes", "Increase quantity to 3".</li>
                  <li><strong>One-chat ordering</strong> — Confirm address and payment in chat; the AI places the order for you.</li>
                  <li><strong>Order tracking</strong> — "Where is my order?", "Show my last 5 orders", "Cancel order ORD-1234".</li>
                  <li><strong>Coupon discovery</strong> — Finds active coupons and validates them automatically against your cart.</li>
                  <li><strong>Wishlist</strong> — "Save this for later" or "Show my wishlist" through chat.</li>
                  <li><strong>Personalized recommendations</strong> — Uses your past orders and browsing to suggest things you'll love.</li>
                </ul>

                <h3>How to access the AI</h3>
                <StepList steps={[
                  'Click the chat bubble in the bottom-right corner — it follows you on every page.',
                  'Or open the full AI Chat page at /ai-chat for a wider view with conversation history.',
                  'Or chat with Rozare on WhatsApp once your number is connected.',
                  'Type or speak naturally. No commands or special syntax required.',
                ]} />

                <InfoBox type="tip" title="Pro tip">
                  The AI keeps track of conversation context. After discussing dresses, you can simply say "show me something cheaper" and it will know you mean cheaper dresses.
                </InfoBox>
              </DocSection>

              {/* GETTING STARTED */}
              <DocSection id="getting-started" title="Getting Started" icon={Zap}>
                <h3>Creating an account</h3>
                <StepList steps={[
                  'Visit rozare.com and click "Sign Up".',
                  'Enter your email and a username.',
                  'Verify your email with the 6-digit OTP sent to your inbox.',
                  'Set a secure password and you are in.',
                  'Optional: continue with Google for one-click signup.',
                ]} />

                <h3>Setting up your profile</h3>
                <ul>
                  <li><strong>Username</strong> — How you appear on the platform.</li>
                  <li><strong>Default shipping address</strong> — Saved once, auto-filled at every checkout.</li>
                  <li><strong>Currency preference</strong> — Choose USD, EUR, PKR, GBP and more — prices convert automatically.</li>
                  <li><strong>Saved addresses</strong> — Add multiple addresses (home, office, family) for fast checkout.</li>
                </ul>

                <InfoBox type="info" title="Quick start">
                  You can skip profile setup entirely and start shopping right away. The AI will ask for your shipping details only when you place your first order.
                </InfoBox>

                <h3>Browsing without an account</h3>
                <p>Guests can browse products, search the catalog, view stores, and chat with the Rozare AI for product discovery and style advice. To save a wishlist, place orders, or get personalized recommendations, you'll need to sign in. Your guest cart automatically syncs to your account when you log in.</p>
              </DocSection>

              {/* SHOPPING GUIDE */}
              <DocSection id="shopping-guide" title="Shopping Guide" icon={ShoppingBag}>
                <h3>Finding products</h3>
                <ul>
                  <li><strong>AI search</strong> — Ask the AI: "Show me wireless earbuds under $30" or "Find a birthday gift for my sister".</li>
                  <li><strong>Category filters</strong> — On the home page, use the category checkboxes (Electronics, Fashion, Home &amp; Kitchen, etc.) plus the "Other" group for custom categories.</li>
                  <li><strong>Store pages</strong> — Visit /stores to browse all stores or /stores/trusted for verified ones. Each store page has its own search bar and category filter.</li>
                  <li><strong>Direct search</strong> — The search bar at the top of the products grid filters by name, brand, description, and tags.</li>
                </ul>

                <h3>Placing an order</h3>
                <h4>Through the AI (recommended)</h4>
                <CodeBlock lines={[
                  'You: "I want to order the blue wireless earbuds"',
                  'AI: "Great choice. The XSound Pro Earbuds are $24.99. Which color?"',
                  'You: "Blue"',
                  'AI: "Cash on Delivery, or secure online checkout by card or Rozare Wallet?"',
                  'You: "Cash on Delivery"',
                  'AI: "I will ship to your saved address. Confirm to place the order."',
                  'You: "Confirm"',
                  'AI: "Order ORD-1234 placed. Estimated delivery: 5 days."',
                ]} />

                <h4>Through the website or app</h4>
                <StepList steps={[
                  'Click a product to open its detail page.',
                  'Pick variants (size, color) and click "Add to Cart".',
                  'Open the cart, review items, then go to checkout.',
                  'Confirm or edit the shipping address. Apply a coupon if you have one.',
                  'Choose Cash on Delivery, Stripe card, or Rozare Wallet. The full order uses one payment method.',
                  'Place the order. You will receive a confirmation email and notification.',
                ]} />

                <h3>Order tracking</h3>
                <ul>
                  <li><strong>Via AI</strong> — "Where is my last order?" or "Show all my orders".</li>
                  <li><strong>Via website</strong> — Visit /track-order or your dashboard.</li>
                  <li><strong>Statuses</strong> — Pending → Confirmed → Processing → Shipped → Delivered.</li>
                </ul>
              </DocSection>

              {/* CART & WISHLIST */}
              <DocSection id="cart-and-wishlist" title="Cart & Wishlist" icon={Heart}>
                <h3>Cart</h3>
                <ul>
                  <li>Add to cart from the product card, the product detail page, or the chatbot.</li>
                  <li>Increase or decrease quantity directly from the cart, the product card, or the product detail page.</li>
                  <li>Guests can build a cart locally; signing in syncs it to your account automatically.</li>
                  <li>Cart respects per-product stock limits. You'll be notified if a product runs out before checkout.</li>
                </ul>

                <h3>Wishlist</h3>
                <ul>
                  <li>Tap the heart icon on any product to save it to your wishlist.</li>
                  <li>Open your wishlist from the user dashboard or via "Show my wishlist" in chat.</li>
                  <li>Move items from wishlist to cart in one tap.</li>
                </ul>
              </DocSection>

              {/* BECOME A SELLER */}
              <DocSection id="become-a-seller" title="Become a Seller" icon={Store}>
                <p>Anyone can start selling on Rozare with a <strong>15-day free trial for core selling features and eligible Elite tools</strong>. After that, sellers choose Starter or Elite to keep the store active, with a free intro period on the selected plan.</p>

                <h3>How to sign up as a seller</h3>
                <StepList steps={[
                  'Visit /become-seller.',
                  'Create a new account or sign in to your existing Rozare account.',
                  'Add your business details, address, store name, and store description.',
                  'Verify your WhatsApp number with the OTP.',
                  'Click the final activation button to create your seller account.',
                  'Your store is created instantly and your 15-day free trial begins. You can start adding products immediately.',
                ]} />

                <h3>What you get as a seller</h3>
                <FeatureGrid features={[
                  { icon: Store, title: 'Online Storefront', desc: 'A fully customizable storefront with your own slug, optional custom subdomain, logo, banner, description, and social links.' },
                  { icon: Bot, title: 'AI Business Partner', desc: 'A built-in AI assistant that adds products, updates stock, runs analytics, manages orders, creates coupons, and gives growth advice.' },
                  { icon: CreditCard, title: 'Seller Payments', desc: 'A Payments tab for Stripe balance, COD revenue, total revenue, estimated revenue, bank details, and withdrawal requests.' },
                  { icon: BarChart3, title: 'Real-Time Analytics', desc: 'Revenue, top products, order trends, customer insights, low-stock alerts and period comparisons.' },
                  { icon: Smartphone, title: 'WhatsApp Management', desc: 'Manage key store tasks from WhatsApp by chatting with AI. Get instant alerts on every new order.' },
                  { icon: Ticket, title: 'Coupons & Discounts', desc: 'Percent or fixed-amount coupons with min order amount, max uses, expiry, and per-user limits.' },
                  { icon: Truck, title: 'Shipping Control', desc: 'Configure free, standard, and express shipping methods with custom costs and delivery windows.' },
                ]} />

                <h3>Requirements</h3>
                <ul>
                  <li>A valid email address.</li>
                  <li>An active store (created during signup) — required before listing products.</li>
                  <li>No upfront fees during the 15-day free trial.</li>
                  <li>Optional: Apply for verification once your store is live.</li>
                </ul>
              </DocSection>

              {/* SELLER DASHBOARD */}
              <DocSection id="seller-guide" title="Seller Dashboard Guide" icon={Settings}>
                <p>The seller dashboard is your command center. Open it at <code>/seller-dashboard/store-overview</code> after logging in as a seller. You can manage the store manually from the dashboard or ask the AI to handle supported tasks for you.</p>

                <h3>Dashboard tabs</h3>
                <p><strong>Ads</strong> - Elite sellers can request Rozare-run TikTok ads for their store and featured products, with admin approval for every start, stop, or product change.</p>
                <ul>
                  <li><strong>Overview</strong> — Live revenue, orders, products, store views, trust count, low-stock alerts and pending order badges.</li>
                  <li><strong>Products</strong> — Add, edit, delete, and bulk-update products. Includes bulk discount and bulk price tools.</li>
                  <li><strong>Orders</strong> — Every order containing your products. Update status, view full order detail, contact the customer.</li>
                  <li><strong>Payments</strong> — Link your bank account, track Stripe withdrawable balance, COD delivered revenue, total revenue, estimated revenue, and withdrawal requests.</li>
                  <li><strong>Coupons</strong> — Create, toggle, edit, and delete discount coupons.</li>
                  <li><strong>Analytics</strong> — Revenue charts, order trends, top products, status pie chart, growth metrics with period comparison.</li>
                  <li><strong>Store Settings</strong> — Update store name, description, logo, banner, payment options, return &amp; warranty policy, social links.</li>
                  <li><strong>Shipping</strong> — Configure shipping methods and per-method costs &amp; delivery times.</li>
                  <li><strong>Tax</strong> — View applied platform tax (set platform-wide, applied at checkout).</li>
                  <li><strong>WhatsApp</strong> — Connect and verify your WhatsApp number, choose which notifications to receive.</li>
                  <li><strong>Subdomain</strong> — Claim and manage your custom store subdomain.</li>
                  <li><strong>Subscription</strong> — View your trial status, plan, billing history, and upgrade/downgrade.</li>
                  <li><strong>Notifications</strong> — Notification settings and full notification history.</li>
                  <li><strong>Profile</strong> — Manage your personal seller profile and security settings.</li>
                </ul>

                <h3>Multi-seller orders</h3>
                <InfoBox type="important" title="Data isolation">
                  When a customer orders products from multiple sellers in one checkout, each seller only sees their own products, prices, and revenue from that order. You will never see another seller's data.
                </InfoBox>
              </DocSection>

              {/* PRODUCT MANAGEMENT */}
              <DocSection id="product-management" title="Product Management" icon={Package}>
                <p>Adding and editing products is designed to be fast — and the AI can do most of it for you.</p>

                <h3>Adding a product</h3>
                <StepList steps={[
                  'Open the Products tab and click "Add Product" (or just say "add a product" to the AI).',
                  'Fill in: product name, brand, category, price, stock, and at least one image.',
                  'Pick a category from the preset list or click "Other" to add a custom category.',
                  'Write a description (up to 2000 characters). When you are done, tap "Improve with AI" to polish it — and "Revert" to undo.',
                  'Add up to 15 tags manually, or tap "Generate Tags with AI" to auto-create them based on your product name and description.',
                  'Optional: add an offer price, color/size variants, additional images, and mark as featured.',
                  'Save. The product is live instantly in the marketplace.',
                ]} />

                <h3>AI helpers in the product form</h3>
                <FeatureGrid features={[
                  { icon: Wand2, title: 'Improve with AI', desc: 'Rewrites your description into clean, persuasive marketplace copy. Use Revert to restore the original.' },
                  { icon: Tag, title: 'Generate Tags with AI', desc: 'Creates relevant search tags from your product name and description. Disabled once the 15-tag limit is reached.' },
                  { icon: Layers, title: 'Smart Categories', desc: 'Type to filter the preset list, or pick "Other" to add a custom one — used by the marketplace filter sidebar too.' },
                  { icon: ImageIcon, title: 'Image Upload', desc: 'Upload from your device or paste an image URL. Powered by Cloudinary for fast, optimized delivery.' },
                ]} />

                <h3>Bulk operations</h3>
                <ul>
                  <li><strong>Bulk discount</strong> — Apply a percentage or fixed discount across selected products in one action.</li>
                  <li><strong>Bulk price update</strong> — Raise or lower prices on selected products by a fixed amount.</li>
                  <li>Both work via the dashboard UI or by chatting with the AI ("apply 20% discount to all my electronics").</li>
                </ul>

                <h3>Featured products</h3>
                <p>Highlight your best products on the marketplace. Starter sellers can feature up to 6 products; Elite sellers up to 12.</p>
              </DocSection>

              {/* AI FOR SELLERS */}
              <DocSection id="ai-for-sellers" title="AI for Sellers" icon={BarChart3}>
                <p>The Rozare AI doubles as your <strong>business advisor</strong>. It has secure access to your store data and can take real actions on your behalf.</p>

                <h3>What the AI can do for sellers</h3>
                <ul>
                  <li><strong>Product management</strong> — "Add a product called Summer Dress, $49.99, category Dresses, 30 in stock".</li>
                  <li><strong>Smart description generator</strong> — Rewrites raw descriptions into polished marketing copy (Elite plan; included for everyone during the 15-day trial).</li>
                  <li><strong>Bulk operations</strong> — "Apply 20% off to all my electronics" or "Raise shoe prices by $5".</li>
                  <li><strong>On-demand analytics</strong> — "What was my revenue this month?", "Top 5 selling products", "How am I doing vs last month?".</li>
                  <li><strong>Order management</strong> — "Show pending orders", "Mark ORD-1234 as shipped", "Cancel ORD-1235".</li>
                  <li><strong>Coupon creation</strong> — "Create SAVE15 — 15% off, expires in 30 days, max 100 uses".</li>
                  <li><strong>Payments knowledge</strong> — Explains Stripe payouts, COD handling, withdrawable balance, and where to request withdrawals.</li>
                  <li><strong>Growth strategies</strong> — Personalized recommendations based on your real sales data.</li>
                  <li><strong>Stock alerts</strong> — Proactively warns you about low or out-of-stock products.</li>
                  <li><strong>Store updates</strong> — "Update my store description" or "Change my return policy".</li>
                </ul>

                <h3>Dual mode: seller + buyer</h3>
                <p>Sellers can also shop on Rozare. The AI intelligently detects which mode you're in:</p>
                <CodeBlock lines={[
                  '// Seller mode (default for sellers):',
                  '"Show my products" — shows YOUR store listings',
                  '"My orders" — shows orders containing YOUR products',
                  '',
                  '// Buyer mode (auto-detected):',
                  '"Find me a laptop bag" — searches ALL marketplace products',
                  '"Add to cart" — adds to YOUR shopping cart',
                  '"Place order" — places an order as a buyer',
                ]} />

                <h3>AI usage limits</h3>
                <ul>
                  <li><strong>Guests</strong> — 5 messages per day.</li>
                  <li><strong>Buyers</strong> — 20 messages per day.</li>
                  <li><strong>Sellers</strong> — Unlimited seller AI chat on free trial, Starter, and Elite.</li>
                </ul>
              </DocSection>

              {/* WHATSAPP INTEGRATION */}
              <DocSection id="whatsapp-integration" title="Manage Your Store via WhatsApp" icon={Smartphone}>
                <p>Rozare brings key store workflows to WhatsApp. Add products, manage orders, ask for analytics, and get instant new-order notifications without opening a browser.</p>

                <h3>For sellers</h3>
                <ul>
                  <li><strong>New-order notifications</strong> — Instant WhatsApp message every time a customer places an order on one of your products.</li>
                  <li><strong>Supported AI store management</strong> — Chat with the Rozare AI on WhatsApp to add, edit, or remove products, update stock, mark orders shipped, run discounts, and more where supported by your role and store settings.</li>
                  <li><strong>Analytics on the go</strong> — "How many orders today?" or "What's my best seller this week?" — get answers in seconds on WhatsApp.</li>
                  <li><strong>Order confirmation automation</strong> — Customers can confirm Cash-on-Delivery orders right from WhatsApp.</li>
                </ul>

                <h3>For shoppers</h3>
                <ul>
                  <li>Get order status updates on WhatsApp.</li>
                  <li>Search products, get recommendations, and place orders by chatting with Rozare on WhatsApp.</li>
                </ul>

                <h3>Setting up WhatsApp</h3>
                <StepList steps={[
                  'Open Seller Dashboard → WhatsApp.',
                  'Enter your WhatsApp number with country code.',
                  'Verify with the OTP sent to your WhatsApp.',
                  'Choose which notifications you want to receive (orders, low stock, customer messages, etc.).',
                  'Done. Start chatting with the Rozare AI directly from WhatsApp.',
                ]} />

                <InfoBox type="info" title="Same AI, every channel">
                  The Rozare AI is identical whether you reach it on the website chat, the full AI page, the mobile app, or WhatsApp — same capabilities, shared conversation context.
                </InfoBox>
              </DocSection>

              {/* SUBSCRIPTION PLANS */}
              <DocSection id="subscription-plans" title="Subscription Plans" icon={Award}>
                <p>Every new seller gets a <strong>15-day free trial to launch their store</strong> with Starter features and eligible Elite tools. After the trial, choose Rozare Starter or Rozare Elite. Both plans include a generous free intro period.</p>

                <div className="grid md:grid-cols-3 gap-4 my-6">
                  <PlanCard name="Free Trial" price="15 days" features={[
                    'Core selling features unlocked',
                    'Unlimited product listings',
                    'Smart description generator with AI',
                    'Unlimited seller AI chat',
                    'Manage store via WhatsApp by chatting with AI',
                    'WhatsApp notifications for new orders',
                    '10 professional store themes',
                    'Analytics, smart tags, coupons, bulk tools',
                    'No credit card required',
                  ]} />
                  <PlanCard name="Rozare Starter" price="$5.99/mo" features={[
                    '30-day free intro period',
                    'Store visible to all customers',
                    'Unlimited product listings',
                    'Custom subdomain',
                    'Unlimited seller AI chat',
                    'Manage store via WhatsApp by chatting with AI',
                    'WhatsApp notifications for new orders',
                    'WhatsApp order confirmation automation',
                    '10 professional store themes',
                    'Featured products (6)',
                    'Bonus Elite features for 6 months',
                  ]} />
                  <PlanCard name="Rozare Elite" price="$12.99/mo" featured features={[
                    '45-day free intro period',
                    'Everything in Starter',
                    'Smart description generator with AI',
                    'Advanced analytics & growth insights',
                    'Smart tag AI generator',
                    'Coupon & discount management',
                    'Bulk discount & promotional tools',
                    'Customizable store themes',
                    'Priority support',
                    'Featured products (12)',
                    'Rozare-run TikTok ads for your store and featured products',
                    'Optional Meta ads add-on (+$4/month)',
                  ]} />
                </div>

                <InfoBox type="info" title="Elite ads">
                  Rozare Elite includes TikTok ads run by Rozare for your store and featured products. Sellers can request ads from Seller Dashboard - Ads, or ask the Rozare AI to select active featured products and submit the request. Every start, stop, or product change goes to admin approval. Meta ads can be added to Elite for $4/month, so Elite + Meta is $16.99/month after the free intro.
                </InfoBox>

                <InfoBox type="tip" title="Bonus features for Starter">
                  Rozare Starter includes bonus Elite features (advanced analytics, smart tags, coupons, bulk tools, priority support) <strong>for the first 6 months</strong>. Customizable themes stay Elite-only. Upgrade to Elite at any time to keep bonus features permanently.
                </InfoBox>

                <h3>Manage your subscription</h3>
                <ul>
                  <li>Open Seller Dashboard → Subscription.</li>
                  <li>Upgrade Starter → Elite anytime — instant access.</li>
                  <li>Downgrade Elite → Starter — takes effect at the end of your billing cycle.</li>
                  <li>Cancel anytime — your store stays active until the end of your paid period.</li>
                </ul>
              </DocSection>

              {/* PAYMENTS */}
              <DocSection id="payments" title="Payments & Checkout" icon={CreditCard}>
                <h3>Payment methods</h3>
                <ul>
                  <li><strong>Stripe</strong> — Secure card payments via Stripe (Visa, Mastercard, Amex, and more).</li>
                  <li><strong>Rozare Wallet</strong> — Pay instantly from a sufficient Wallet balance in the same currency as the order. Wallet balances are never converted automatically.</li>
                  <li><strong>Cash on Delivery (COD)</strong> — Pay when your order arrives, only when every seller in your cart allows COD.</li>
                </ul>
                <p>Sellers control COD from Seller Dashboard → Store Settings → Payment Options. Stores default to both online payment and COD. A seller can switch to online payment only, which means COD is unavailable for that seller's products.</p>
                <InfoBox type="info" title="Mixed-seller carts">
                  A checkout has one payment method for the full order. If your cart contains even one seller that accepts online payment only, Cash on Delivery is disabled for the whole checkout. Pay by Stripe card or with a sufficient same-currency Rozare Wallet balance, or remove the online-only seller items to use COD for the remaining sellers.
                </InfoBox>

                <h3>Rozare Wallet</h3>
                <ul>
                  <li>Open User Dashboard → Wallet to view balances and transaction history or add balance securely by card.</li>
                  <li>USD, PKR, EUR, and GBP balances are kept separately. An order can use only the balance matching its checkout currency.</li>
                  <li>Wallet payment is atomic: the order is confirmed and stock is committed only when the full amount is successfully debited.</li>
                  <li>Approved return refunds are credited to the Wallet only after the seller's refund funding is verified.</li>
                </ul>

                <h3>Two checkout experiences</h3>
                <ul>
                  <li><strong>AI checkout</strong> — Tell the AI to place your order; it confirms address and payment in chat.</li>
                  <li><strong>Traditional checkout</strong> — Standard form-based flow at <code>/checkout</code> with smart auto-fill from your saved address.</li>
                </ul>

                <h3>Tax &amp; shipping</h3>
                <p>Tax is calculated at checkout based on platform settings. Shipping costs come from the seller's chosen shipping method. Both are clearly displayed before you confirm.</p>

                <h3>For sellers: receiving payments</h3>
                <p>Sellers do not need to configure online payments for their stores. Rozare provides Stripe card and Wallet checkout. Sellers only choose whether COD is also allowed. Paid order revenue is tracked in Seller Dashboard - Payments.</p>
                <ul>
                  <li><strong>Online balance</strong> - Delivered Stripe- and Wallet-paid order revenue becomes withdrawable after existing withdrawals and completed return-refund debits are reserved.</li>
                  <li><strong>COD revenue</strong> - Cash on Delivery payments and shipping are handled by the seller directly. Rozare shows delivered COD revenue for reporting, but it is not withdrawn through Rozare.</li>
                  <li><strong>Estimated revenue</strong> - Delivered revenue plus pending Stripe and COD order revenue, so sellers can see what may be coming next.</li>
                  <li><strong>Withdrawals</strong> - Sellers add a bank account in the Payments tab, enter an amount, and send a withdrawal request. Admins review and mark requests approved, processing, paid, rejected, or cancelled.</li>
                </ul>
              </DocSection>

              {/* SHIPPING */}
              <DocSection id="shipping" title="Shipping & Delivery" icon={Truck}>
                <h3>Shipping methods</h3>
                <p>Each seller configures their own shipping methods. Common options:</p>
                <ul>
                  <li><strong>Free shipping</strong> — No cost, typically 5–7 days.</li>
                  <li><strong>Standard shipping</strong> — Moderate cost, 3–5 days.</li>
                  <li><strong>Express shipping</strong> — Higher cost, 1–2 days.</li>
                </ul>

                <h3>For sellers</h3>
                <StepList steps={[
                  'Open Seller Dashboard → Shipping.',
                  'Add as many shipping methods as you like.',
                  'Set cost and estimated delivery days for each.',
                  'Toggle methods on/off without deleting them.',
                  'Or just say "set up standard shipping at $5 with 3-day delivery" to the AI.',
                ]} />

                <h3>For buyers</h3>
                <p>At checkout you'll see every shipping method offered by the sellers in your cart, with cost and ETA. Pick one per seller and continue.</p>
              </DocSection>

              {/* ORDERS & RETURNS */}
              <DocSection id="orders-returns" title="Orders, Returns & Refunds" icon={RefreshCw}>
                <h3>Order lifecycle</h3>
                <div className="flex flex-wrap items-center gap-2 my-4">
                  {['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered'].map((s, i) => (
                    <React.Fragment key={s}>
                      <span className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: 'hsl(220, 70%, 55%, 0.1)', color: 'hsl(220, 70%, 65%)' }}>{s}</span>
                      {i < 4 && <ArrowRight size={14} style={{ color: 'hsl(var(--muted-foreground))' }} />}
                    </React.Fragment>
                  ))}
                </div>
                <p>You'll get a notification at every status change — in-app, by email, and via WhatsApp if connected.</p>

                <h3>Cancelling an order</h3>
                <ul>
                  <li><strong>Via AI</strong> — "Cancel my order ORD-1234".</li>
                  <li><strong>Via dashboard</strong> — Open the order and click "Cancel" while still cancellable.</li>
                  <li>Orders that are already Delivered or Cancelled cannot be cancelled again.</li>
                </ul>

                <h3>Seller-specific returns</h3>
                <ul>
                  <li>Each seller configures whether returns are allowed, the return window after delivery, and whether the resolution is a Rozare Wallet refund or replacement. Products can override the store default.</li>
                  <li>The policy is saved on each order item at checkout, so a later Store Settings change does not remove the buyer's purchased return terms.</li>
                  <li>After a seller's portion is delivered, eligible items show Request Return in the buyer's order details until that item's deadline.</li>
                  <li>For a multi-seller order, only the eligible items belonging to a seller who allows returns can be selected. Each seller receives and manages only their own request.</li>
                  <li>The buyer chooses quantities and writes a reason. Duplicate or excess return quantities are rejected server-side.</li>
                </ul>

                <h3>Return tracking and refunds</h3>
                <p>Return requests move through approval, pickup, transit to the seller, receipt, and seller review. Every seller status change sends the buyer an in-app, push, and WhatsApp update when those channels are available.</p>
                <p>When a Wallet refund is accepted, the seller funds the exact approved amount from available seller balance or by Stripe card. Rozare verifies that funding first, then credits the buyer's Wallet in the order currency and marks the return complete. A failed, cancelled, expired, or mismatched payment never credits the Wallet. Replacement-only returns complete without a money transfer.</p>

                <InfoBox type="info" title="Refund safety">
                  A return request does not itself create money. Rozare caps refunds to the selected seller's remaining item, tax, shipping, and discount allocation, prevents duplicate quantities, and uses idempotent Wallet transactions so retries cannot credit the buyer twice.
                </InfoBox>

                <h3>Complaint system</h3>
                <p>If something goes wrong, file a complaint and the Rozare team will help mediate between you and the seller. Categories include product issues, delivery problems, refund requests, and seller disputes.</p>
              </DocSection>

              {/* COUPONS */}
              <DocSection id="coupons-discounts" title="Coupons & Discounts" icon={Ticket}>
                <h3>For shoppers</h3>
                <ul>
                  <li>Ask the AI: "Are there coupons available right now?"</li>
                  <li>Apply a coupon at checkout, or say "Apply coupon SAVE20".</li>
                  <li>The AI auto-validates expiry, min order amount, and per-user usage limits.</li>
                </ul>

                <h3>For sellers</h3>
                <p>Create coupons in the Coupons tab or by chatting:</p>
                <CodeBlock lines={[
                  '"Create SUMMER20 — 20% off, expires in 30 days, max 100 uses"',
                  '"Make a $10 off coupon for orders over $50"',
                  '"Disable coupon WINTER10"',
                  '"Show me all my coupons and their usage"',
                ]} />
                <p>Coupon options: percent or fixed discount, min order amount, max discount cap, expiry date, max total uses, and per-user limits. Coupons are scoped to your store only.</p>
              </DocSection>

              {/* TRUST & SAFETY */}
              <DocSection id="trust-safety" title="Trust & Safety" icon={Shield}>
                <h3>How Rozare keeps you safe</h3>
                <ul>
                  <li><strong>Store verification</strong> — Stores can apply for verification. Verified stores get a trusted badge.</li>
                  <li><strong>Trust counts</strong> — Customers can endorse stores, and the count is shown publicly.</li>
                  <li><strong>Store reviews</strong> — Buyers can rate and review a store only after that store's portion of their order is delivered. In multi-seller orders, each store unlocks separately.</li>
                  <li><strong>Complaint system</strong> — File a complaint and the Rozare team will help resolve it.</li>
                  <li><strong>Role-based security</strong> — Server-side checks make sure buyers cannot access seller tools and sellers cannot see other sellers' data.</li>
                  <li><strong>Data isolation</strong> — In multi-seller orders, each seller sees only their own portion.</li>
                  <li><strong>Encrypted communications</strong> — All traffic is HTTPS; authentication uses JWT tokens.</li>
                </ul>
              </DocSection>

              {/* STORE VERIFICATION */}
              <DocSection id="store-verification" title="Store Verification" icon={CheckCircle}>
                <p>A verified badge builds buyer trust and improves visibility.</p>
                <h3>How to apply</h3>
                <StepList steps={[
                  'Open Seller Dashboard → Store Settings → Verification.',
                  'Or just tell the AI: "Apply for verification".',
                  'Provide your contact details and a short message about your store.',
                  'The Rozare team reviews your application.',
                  'When approved, your store gets a verified badge that shows on your store page and product cards.',
                ]} />
                <h3>Requirements</h3>
                <ul>
                  <li>Active store with at least a few products listed.</li>
                  <li>Complete store profile (name, description, logo).</li>
                  <li>Valid contact information.</li>
                  <li>No outstanding policy violations on your account.</li>
                </ul>
              </DocSection>

              {/* SUBDOMAIN */}
              <DocSection id="subdomain" title="Custom Subdomain" icon={Globe}>
                <p>Sellers can claim their own custom subdomain like <code>yourstore.rozare.com</code> for a more professional storefront.</p>
                <ul>
                  <li>Open Seller Dashboard → Subdomain.</li>
                  <li>Pick an available name and claim it.</li>
                  <li>Your store automatically becomes accessible at the new URL — no DNS work needed.</li>
                  <li>Subdomains are linked to your subscription. They are disabled in development and preview environments.</li>
                </ul>
              </DocSection>

              {/* NOTIFICATIONS */}
              <DocSection id="notifications" title="Notifications" icon={Bell}>
                <p>Stay in the loop on every channel:</p>
                <ul>
                  <li><strong>In-app</strong> — Bell icon in the top navigation shows your unread count and a dropdown of recent activity.</li>
                  <li><strong>Push notifications</strong> — Mobile app push for new orders, status updates, and customer messages.</li>
                  <li><strong>WhatsApp</strong> — Order alerts, status updates, and confirmations delivered to your WhatsApp.</li>
                  <li><strong>Email</strong> — Branded order confirmations, account, and security emails (powered by Brevo).</li>
                </ul>
                <p>Tune your preferences in Notification Settings — turn channels on or off per event type.</p>
              </DocSection>

              {/* MOBILE APP */}
              <DocSection id="mobile-app" title="Rozare Mobile App" icon={Smartphone}>
                <p>The Rozare mobile app experience (iOS &amp; Android, built with React Native / Expo) brings marketplace and seller dashboard workflows to your phone.</p>
                <h3>Mobile features</h3>
                <ul>
                  <li>Browse products, place orders, and chat with the AI from your phone.</li>
                  <li>Liquid-glass design with light and dark themes that match your system preference.</li>
                  <li>Push notifications for orders, deliveries, and chat replies.</li>
                  <li>Pull-to-refresh on every data screen.</li>
                  <li>Onboarding walkthrough on first launch.</li>
                  <li>Voice search and voice mode in chat.</li>
                  <li>Sellers get quick-action grids on the home screen, store trust controls, and bulk operations.</li>
                </ul>
              </DocSection>

              {/* CURRENCY & LANGUAGE */}
              <DocSection id="currency-multilingual" title="Currency & Languages" icon={Globe}>
                <ul>
                  <li><strong>Multi-currency</strong> — Pick your display currency from the navbar (USD, EUR, GBP, PKR and more). Prices convert automatically across the site.</li>
                  <li><strong>Conversational AI in your language</strong> — The AI understands English, modern Roman Urdu, and common product slang.</li>
                  <li><strong>Local checkout</strong> — Prices are shown in your selected currency, while secure card payments are processed through Rozare's Stripe checkout.</li>
                </ul>
              </DocSection>

              {/* TROUBLESHOOTING */}
              <DocSection id="troubleshooting" title="Troubleshooting & Help" icon={HelpCircle}>
                <h3>Common issues</h3>
                <ul>
                  <li><strong>"I can't add a product"</strong> — Check that you have an active store, that your trial or subscription is active, and that all required fields are filled.</li>
                  <li><strong>"My order isn't showing up"</strong> — Refresh, check the Orders tab, or ask the AI: "Show my recent orders". Make sure you're logged in as the right user.</li>
                  <li><strong>"I can't submit an ads request"</strong> — Ads require Rozare Elite, at least one active featured product, and no other pending ads request. Meta ads also require the $4/month Meta add-on.</li>
                  <li><strong>"I can't add more tags"</strong> — Each product is limited to 15 tags. Remove some to add new ones.</li>
                  <li><strong>"WhatsApp didn't send the OTP"</strong> — Wait 60 seconds, then resend. Confirm your number includes the country code.</li>
                  <li><strong>"My description was changed by the AI"</strong> — Use the "Revert" button to restore your original text.</li>
                </ul>

                <h3>Contact support</h3>
                <p>Visit <a href={mainHref('/contact')} style={{ color: 'hsl(220, 70%, 65%)' }}>/contact</a> to email support, or open the in-app chatbot and say "I need help with..." so the AI can guide you and collect details for supported complaint flows.</p>
              </DocSection>

              {/* FAQ */}
              <DocSection id="faq" title="Frequently Asked Questions" icon={HelpCircle}>
                <FAQItem q="Is Rozare free for shoppers?" a="Yes. Shopping is completely free. You only pay for the products you buy. There are no membership fees." />
                <FAQItem q="How much does it cost to sell on Rozare?" a="Every new seller gets a 15-day free trial for core selling features and eligible Elite tools. After that, choose Rozare Starter ($5.99/month, with a 30-day free intro) or Rozare Elite ($12.99/month, with a 45-day free intro). Elite includes Rozare-run TikTok ads; Meta ads can be added for $4/month, making Elite + Meta $16.99/month." />
                <FAQItem q="Can I manage my store from WhatsApp?" a="Yes. Once you connect your WhatsApp number in seller settings, you can chat with the Rozare AI to handle supported tasks such as adding products, updating stock, managing orders, running discounts, and checking analytics. You can also get instant notifications for new orders." />
                <FAQItem q="Does Rozare have a mobile app?" a="Rozare includes a React Native / Expo mobile app experience for iOS and Android with shopping, selling, AI chat, push notifications, voice search, and the same core marketplace workflows." />
                <FAQItem q="How does the AI know about my store?" a="The AI calls secure server-side tools that read and write only your store's data. Other sellers cannot see your data, and you cannot see theirs." />
                <FAQItem q="Is my data safe?" a="Yes. All traffic is encrypted (HTTPS). Authentication uses JWT tokens. Personal data is never sold or shared with third parties outside what's required to fulfil your order." />
                <FAQItem q="What payment methods are available?" a="Checkout supports Stripe card, Rozare Wallet, and Cash on Delivery. One order uses one payment method. COD is available only when every seller allows it; otherwise use card or a sufficient same-currency Wallet balance." />
                <FAQItem q="How do returns and refunds work?" a="Return eligibility is seller- and item-specific and opens after that seller portion is delivered. Request it from order details within the saved policy window. The seller tracks pickup and review, then funds an approved refund from seller balance or card. Only verified funding credits your Rozare Wallet and completes the return." />
                <FAQItem q="How do sellers receive Stripe payments?" a="Sellers add their bank details in Seller Dashboard - Payments. Delivered Stripe-paid order revenue becomes withdrawable, then the seller sends a withdrawal request for admin review. COD payments are handled by the seller directly." />
                <FAQItem q="What's the difference between Starter and Elite?" a="Both plans include unlimited listings, unlimited seller AI chat, a custom subdomain, WhatsApp store management, new-order WhatsApp notifications, 10 professional store themes, and the core marketplace features. Elite adds customizable store themes, the smart description generator with AI, advanced analytics, smart tag AI, coupon and bulk tools permanently, priority support, 12 featured products (vs 6), and Rozare-run TikTok ads. Meta ads can be added to Elite for $4/month." />
                <FAQItem q="What happens after my 15-day free trial ends?" a="If you don't subscribe, your store and products are temporarily hidden until you subscribe — your data is preserved. Subscribe to Starter or Elite to instantly reactivate everything, with the plan's free intro period applied when eligible." />
                <FAQItem q="Can I cancel anytime?" a="Yes. Cancel from Seller Dashboard → Subscription. Your store stays active until the end of your current billing period." />
                <FAQItem q="What's the maximum number of tags per product?" a="15 tags per product. Both manual entry and AI generation respect this limit." />
                <FAQItem q="How long can my product description be?" a="Up to 2000 characters. A live counter is shown in the form." />
                <FAQItem q="Can I sell physical and digital products?" a="Today, Rozare focuses on physical products with shipping. Digital product support may expand in the future." />
                <FAQItem q="What makes Rozare different from other marketplaces?" a="Rozare combines marketplace shopping with seller dashboard tools, AI chat, and WhatsApp workflows, so buyers can get help faster and sellers can manage supported store tasks conversationally." />
              </DocSection>

            </div>

            {/* Bottom CTA */}
            <div className="mt-20 mb-8 text-center p-8 rounded-2xl" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%, 0.1), hsl(280, 60%, 55%, 0.1))', border: '1px solid hsl(220, 70%, 55%, 0.2)' }}>
              <h2 className="text-2xl font-bold mb-3" style={{ color: 'hsl(var(--foreground))' }}>Ready to Get Started?</h2>
              <p className="mb-6" style={{ color: 'hsl(var(--muted-foreground))' }}>Join the marketplace where shoppers discover products and sellers manage stores with dashboard tools, AI chat, and WhatsApp.</p>
              <div className="flex flex-wrap justify-center gap-4">
                <a href={mainHref('/signup')} className="px-6 py-3 rounded-xl font-medium text-white transition-all hover:scale-105" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%), hsl(280, 60%, 55%))' }}>
                  Start Shopping
                </a>
                <a href={mainHref('/become-seller')} className="px-6 py-3 rounded-xl font-medium transition-all hover:scale-105" style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}>
                  Become a Seller
                </a>
              </div>
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

// ─── Helper Components ───

function DocSection({ id, title, icon: Icon, children }) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'hsl(220, 70%, 55%, 0.1)' }}>
          <Icon size={20} style={{ color: 'hsl(220, 70%, 65%)' }} />
        </div>
        <h2 className="text-2xl md:text-3xl font-bold" style={{ color: 'hsl(var(--foreground))' }}>{title}</h2>
      </div>
      <div className="prose prose-sm md:prose-base max-w-none space-y-4
        [&>p]:leading-relaxed [&>ul]:space-y-2 [&>ul>li]:leading-relaxed
        [&>h3]:text-lg [&>h3]:font-semibold [&>h3]:mt-8 [&>h3]:mb-3
        [&>h4]:text-base [&>h4]:font-medium [&>h4]:mt-6 [&>h4]:mb-2
        [&>ul]:list-disc [&>ul]:pl-5
        [&>p>code]:px-1.5 [&>p>code]:py-0.5 [&>p>code]:rounded [&>p>code]:bg-[hsl(var(--muted))] [&>p>code]:text-[0.85em]
        [&_li>code]:px-1.5 [&_li>code]:py-0.5 [&_li>code]:rounded [&_li>code]:bg-[hsl(var(--muted))] [&_li>code]:text-[0.85em]"
        style={{ color: 'hsl(var(--foreground))' }}>
        {children}
      </div>
    </section>
  );
}

function FeatureGrid({ features }) {
  return (
    <div className="grid md:grid-cols-2 gap-4 my-6">
      {features.map(({ icon: Icon, title, desc }, i) => (
        <div key={i} className="p-4 rounded-xl" style={{ background: 'hsl(var(--muted) / 0.3)', border: '1px solid hsl(var(--border))' }}>
          <div className="flex items-center gap-2 mb-2">
            <Icon size={16} style={{ color: 'hsl(220, 70%, 65%)' }} />
            <h4 className="font-semibold text-sm" style={{ color: 'hsl(var(--foreground))' }}>{title}</h4>
          </div>
          <p className="text-sm leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>{desc}</p>
        </div>
      ))}
    </div>
  );
}

function StepList({ steps }) {
  return (
    <div className="space-y-3 my-4">
      {steps.map((step, i) => (
        <div key={i} className="flex gap-3 items-start">
          <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold" style={{ background: 'hsl(220, 70%, 55%, 0.15)', color: 'hsl(220, 70%, 65%)' }}>{i + 1}</div>
          <p className="text-sm leading-relaxed pt-0.5" style={{ color: 'hsl(var(--foreground))' }}>{step}</p>
        </div>
      ))}
    </div>
  );
}

function CodeBlock({ lines }) {
  return (
    <div className="rounded-xl overflow-hidden my-4 text-sm" style={{ background: 'hsl(220, 30%, 10%)', border: '1px solid hsl(220, 30%, 20%)' }}>
      <div className="p-4 overflow-x-auto">
        {lines.map((line, i) => (
          <div key={i} className="font-mono whitespace-pre" style={{ color: line.startsWith('//') ? 'hsl(220, 20%, 50%)' : line.startsWith('"') ? 'hsl(150, 60%, 60%)' : 'hsl(220, 20%, 80%)' }}>
            {line || '\u00A0'}
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoBox({ type, title, children }) {
  const styles = {
    tip: { bg: 'hsl(150, 60%, 45%, 0.08)', border: 'hsl(150, 60%, 45%, 0.3)', Icon: Lightbulb, color: 'hsl(150, 60%, 55%)' },
    info: { bg: 'hsl(220, 70%, 55%, 0.08)', border: 'hsl(220, 70%, 55%, 0.3)', Icon: Info, color: 'hsl(220, 70%, 65%)' },
    important: { bg: 'hsl(40, 80%, 50%, 0.08)', border: 'hsl(40, 80%, 50%, 0.3)', Icon: AlertTriangle, color: 'hsl(40, 80%, 55%)' },
  };
  const s = styles[type] || styles.info;
  const Icon = s.Icon;
  return (
    <div className="rounded-xl p-4 my-4" style={{ background: s.bg, borderLeft: `3px solid ${s.border}` }}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} style={{ color: s.color }} />
        <span className="text-sm font-semibold" style={{ color: s.color }}>{title}</span>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'hsl(var(--foreground))' }}>{children}</p>
    </div>
  );
}

function PlanCard({ name, price, features, featured }) {
  return (
    <div className={`p-5 rounded-xl ${featured ? 'ring-2' : ''}`}
      style={{
        background: featured ? 'hsl(270, 60%, 55%, 0.08)' : 'hsl(var(--muted) / 0.3)',
        border: '1px solid hsl(var(--border))',
      }}>
      {featured && <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'hsl(270, 60%, 55%, 0.2)', color: 'hsl(270, 60%, 65%)' }}>Most Popular</span>}
      <h3 className="text-lg font-bold mt-2" style={{ color: 'hsl(var(--foreground))' }}>{name}</h3>
      <p className="text-2xl font-bold mb-4" style={{ color: featured ? 'hsl(270, 60%, 65%)' : 'hsl(220, 70%, 65%)' }}>{price}</p>
      <ul className="space-y-2">
        {features.map((f, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <CheckCircle size={14} className="shrink-0 mt-0.5" style={{ color: 'hsl(150, 60%, 50%)' }} />
            <span style={{ color: 'hsl(var(--muted-foreground))' }}>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b py-4" style={{ borderColor: 'hsl(var(--border))' }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between text-left gap-3">
        <span className="font-medium text-sm" style={{ color: 'hsl(var(--foreground))' }}>{q}</span>
        <ChevronRight size={16} className={`shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} style={{ color: 'hsl(var(--muted-foreground))' }} />
      </button>
      {open && (
        <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          className="text-sm mt-2 leading-relaxed" style={{ color: 'hsl(var(--muted-foreground))' }}>{a}</motion.p>
      )}
    </div>
  );
}

export default DocsPage;
