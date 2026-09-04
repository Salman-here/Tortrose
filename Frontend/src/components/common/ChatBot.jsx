import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageCircle, X, Send, Bot, User, Package,
  AlertCircle, Loader2, ExternalLink, Phone, PhoneOff,
  Sparkles, Palette, Clock, ArrowRight, Volume2, VolumeX, Trash2,
  Heart, MapPin, Bell, Ticket, CheckCircle, XCircle, Search,
  ShoppingBag, BarChart3, Shield, Megaphone, Settings,
  Plus, Star, Eye, ShoppingCart, Maximize2, Store, ImagePlus, FileText, Mic, Square, Flag
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useGlobal } from '../../contexts/GlobalContext';
import {
  requireCanonicalPresentationCurrency,
  requireExactPresentationMoney,
  resolveProductPresentationCurrency,
  resolveProductPresentationMoney,
  useCurrency,
} from '../../contexts/CurrencyContext';
import { toast } from 'react-toastify';
import ReactMarkdown from 'react-markdown';
import { getAuthToken } from "../../utils/cookieHelper";
import { resilientFetch } from '../../utils/httpResilience';
import { normalizeAIRoute } from '../../utils/aiRouteGuard';
import { shouldRetainIdempotencyKey } from '../../utils/currencySafety';
import {
  clearPersistedMutationAttemptForFingerprint,
  createChatMutationFingerprint,
  createScopedMutationStorageKey,
  getOrCreatePersistedMutationAttemptForFingerprint,
} from '../../utils/persistedMutationAttempt';
import { OPEN_AI_CHAT_EVENT } from '../../utils/aiChatLauncher';
import SafetyActionsDialog from './SafetyActionsDialog';

// ─── Endpoint (our own backend — no Supabase) ───
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/';
const AI_CHAT_URL = `${API_BASE}api/ai-chat/stream`;
const PRODUCT_IMAGE_ATTACHMENT_RE = /\n?\[Attached product image: (https?:\/\/[^\]\s]+)\]/gi;
const CHAT_ATTEMPT_STORAGE_KEY = 'rozare_ai_chat_attempt_v1';
const UNRESOLVED_AI_ACTION_CODES = new Set([
  'AI_ACTION_PENDING',
  'AI_ACTION_IDEMPOTENCY_CONFLICT',
  'AI_ACTION_RECEIPT_COMMIT_AMBIGUOUS',
]);

const extractImageAttachments = (content = '', explicit = []) => {
  const seen = new Set();
  const attachments = [];
  const addAttachment = (attachment) => {
    const url = attachment?.url || attachment?.imageUrl || attachment?.src || attachment?.previewUrl;
    if (!url) return;
    const key = String(url).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push({ type: 'image', url, name: attachment?.name || 'Product image' });
  };
  if (Array.isArray(explicit)) explicit.forEach(addAttachment);
  const text = String(content || '');
  for (const match of text.matchAll(PRODUCT_IMAGE_ATTACHMENT_RE)) {
    addAttachment({ type: 'image', url: match[1], name: 'Product image' });
  }
  return attachments;
};

const stripAttachmentMetadata = (content = '') => (
  String(content || '').replace(PRODUCT_IMAGE_ATTACHMENT_RE, '').trim()
);

const sanitizeAssistantContent = (content = '') => (
  String(content || '')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim().replace(/^_+|_+$/g, '');
      return !trimmed.includes('[Tool memory:') && !/^Action note:/i.test(trimmed);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
);

const normalizeChatMessage = (message) => {
  const attachments = extractImageAttachments(message.content, message.attachments);
  const cleanContent = stripAttachmentMetadata(message.content);
  const visibleContent = message.role === 'assistant'
    ? sanitizeAssistantContent(cleanContent)
    : cleanContent;
  return {
    role: message.role,
    content: visibleContent || (attachments.length ? 'Image attached' : ''),
    ...(attachments.length ? { attachments } : {}),
    ...(Array.isArray(message.toolEvents) && message.toolEvents.length > 0 ? { toolEvents: message.toolEvents } : {}),
  };
};

const COMPLAINT_CATEGORIES = [
  { value: 'product_issue', label: 'Product Issue' },
  { value: 'order_issue', label: 'Order Issue' },
  { value: 'delivery', label: 'Delivery Problem' },
  { value: 'refund', label: 'Refund Request' },
  { value: 'seller_complaint', label: 'Seller Complaint' },
  { value: 'website_bug', label: 'Website Bug' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'other', label: 'Other' },
];

const ROLE_CHIPS = {
  user: [
    { label: '👗 Help me find an outfit', msg: "I'm looking for a new outfit, can you help me?" },
    { label: '📦 Track my orders', msg: 'Show me my recent orders and their status' },
    { label: '💝 My wishlist', msg: "Show me what's in my wishlist" },
    { label: '🎨 Style advice', msg: 'Give me some fashion advice for this season' },
    { label: '🎟️ Find coupons', msg: 'Show me available coupons I can use' },
    { label: '🏪 Browse stores', msg: 'Show me popular stores' },
  ],
  seller: [
    { label: '📊 Show analytics', msg: 'Show me my store analytics — revenue, orders, top products' },
    { label: '📦 Add a product', msg: 'I want to add a new product to my store' },
    { label: '💰 Apply discount', msg: 'Help me apply a bulk discount to my products' },
    { label: '🎟️ Create coupon', msg: 'Help me create a coupon for my store' },
    { label: '📋 Recent orders', msg: 'Show me my recent orders and their statuses' },
    { label: '🚀 Growth tips', msg: 'Give me strategies to grow my store and increase sales' },
  ],
  admin: [
    { label: '👥 User overview', msg: 'Show me a summary of all users on the platform' },
    { label: '📊 Platform stats', msg: 'Give me platform-wide analytics — users, revenue, orders' },
    { label: '🛡️ Complaints', msg: 'Show me all pending complaints' },
    { label: '📣 Send broadcast', msg: 'Help me send a broadcast notification to users' },
    { label: '🏪 Verifications', msg: 'Show me pending store verifications' },
    { label: '⚙️ Tax config', msg: 'Show me the current tax configuration' },
  ],
};

const ROLE_GREETINGS = {
  user: (name, greeting) => name
    ? `${greeting}, ${name}! 👋 I'm your personal shopping stylist. I can help you find products, manage your wishlist & addresses, track orders, and give outfit advice. What's on your mind?`
    : `${greeting}! 👋 I'm your Rozare shopping stylist. I can help you find products, give style advice, and help with orders. What can I do for you?`,
  seller: (name, greeting) => `${greeting}, ${name || 'Seller'}! 🚀 I'm your business partner. I can manage your products, run analytics, handle orders, create coupons, and give you growth strategies. What would you like to do?`,
  admin: (name, greeting) => `${greeting}, ${name || 'Admin'}! 🛡️ I'm your platform commander. Users, stores, complaints, verifications, broadcasts, tax — I can do it all. What's the priority?`,
};

const ROLE_TITLES = {
  user: { title: 'Rozare AI Stylist', subtitle: 'Personal Shopping Assistant' },
  seller: { title: 'Business Partner', subtitle: 'Store Management & Growth' },
  admin: { title: 'Platform Commander', subtitle: 'Full Admin Control' },
};

// Action icon mapping
const TOOL_ICONS = {
  search_products: Search, get_my_orders: Package, get_order_detail: Package,
  cancel_order: XCircle, get_wishlist: Heart, add_to_wishlist: Heart,
  remove_from_wishlist: Heart, get_addresses: MapPin, add_address: MapPin,
  get_notifications: Bell, mark_notifications_read: Bell,
  get_available_coupons: Ticket, validate_coupon: Ticket,
  add_product: ShoppingBag, edit_product: ShoppingBag, delete_product: Trash2,
  bulk_add_products: ShoppingBag,
  feature_product: Star,
  list_my_products: ShoppingBag, get_seller_analytics: BarChart3,
  get_seller_orders: Package, update_order_status: CheckCircle,
  get_my_store: Settings, update_store: Settings, get_store_analytics: BarChart3,
  get_all_users: User, get_admin_analytics: BarChart3,
  get_pending_verifications: Shield, approve_verification: Shield,
  send_broadcast: Megaphone, get_broadcasts: Megaphone,
  submit_complaint: AlertCircle, get_my_complaints: AlertCircle,
  get_verified_stores: Store, search_stores: Store, get_store_details: Store,
};

const formatToolDisplayName = (name = '') =>
  name.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

const summarizeToolEventsForPrompt = (toolEvents = []) => {
  const lines = [];
  for (const event of toolEvents || []) {
    if (event?.type !== 'tool_result') continue;
    const result = event.result || {};
    const data = result.data || {};
    if (event.tool === 'add_product' && result.success && result.blocked && data.productId) {
      lines.push(`[Tool memory: add_product saved but blocked. productId=${data.productId}; name="${data.name || ''}"; reason="${data.moderationReason || result.message || ''}". Tell the seller it is blocked and ask them to edit the real product details; do not add it again.]`);
    } else if (event.tool === 'add_product' && result.success && data.productId) {
      lines.push(`[Tool memory: add_product succeeded. productId=${data.productId}; name="${data.name || ''}"; brand="${data.brand || ''}"; price=${data.price ?? ''}; tags=${JSON.stringify(data.tags || [])}; colors=${JSON.stringify(data.colors || [])}. Use this productId for follow-up edits; do not add it again unless explicitly asked for a duplicate.]`);
    } else if (event.tool === 'bulk_add_products' && result.success && Array.isArray(data.products)) {
      const products = data.products.slice(0, 12).map(p => `${p.productId || p._id}:${p.name}; brand=${p.brand || ''}; price=${p.price ?? ''}; stock=${p.stock ?? ''}`);
      lines.push(`[Tool memory: bulk_add_products imported ${data.added ?? data.products.length} products. Internal product lookup: ${products.join(' | ')}. Use these ids internally only; do not show or ask the seller for product IDs.]`);
    } else if (event.tool === 'edit_product' && result.success && (data._id || data.productId)) {
      lines.push(`[Tool memory: edit_product succeeded. productId=${data._id || data.productId}; name="${data.name || ''}".]`);
    } else if (event.tool === 'feature_product' && result.success && (data.productId || data._id)) {
      lines.push(`[Tool memory: feature_product succeeded. productId=${data.productId || data._id}; name="${data.name || ''}"; isFeatured=${data.isFeatured === true}.]`);
    } else if (event.tool === 'delete_product' && result.success && Array.isArray(data.deleted)) {
      lines.push(`[Tool memory: delete_product succeeded. Deleted products: ${data.deleted.map(p => `${p.productId || p._id}:${p.name}`).join(', ')}.]`);
    } else if (event.tool === 'list_my_products' && result.success && Array.isArray(data.products)) {
      const products = data.products.slice(0, 10).map(p => `${p._id || p.productId}:${p.name}; brand=${p.brand || ''}; price=${p.price ?? ''}; stock=${p.stock ?? ''}; featured=${p.isFeatured === true}; blocked=${p.blocked === true || p.isBlocked === true || p.moderationStatus === 'blocked'}; createdAt=${p.createdAt || ''}`);
      lines.push(`[Tool memory: list_my_products returned ${data.total ?? data.products.length} products. Internal product lookup: ${products.join(' | ')}. Use these ids internally only; do not show or ask the seller for product IDs.]`);
    } else if (event.tool === 'search_products' && result.success && Array.isArray(data.products)) {
      const products = data.products.slice(0, 12).map(p => `${p._id || p.productId}:${p.name}; store=${p.storeName || ''}; slug=${p.storeSlug || ''}; price=${p.discountedPrice || p.price || ''}; stock=${p.stock ?? ''}; colors=${JSON.stringify(p.colors || [])}; options=${JSON.stringify(p.optionGroups || [])}`);
      lines.push(`[Tool memory: search_products returned ${data.count ?? data.products.length} products. Internal product lookup for shopper follow-ups: ${products.join(' | ')}. Use these ids internally only; do not show raw product IDs.]`);
    } else if (event.tool === 'get_product_detail' && result.success && data._id) {
      lines.push(`[Tool memory: get_product_detail productId=${data._id}; name="${data.name || ''}"; store="${data.storeName || ''}"; stock=${data.stock ?? ''}; colors=${JSON.stringify(data.colors || [])}; options=${JSON.stringify(data.optionGroups || [])}.]`);
    } else if (event.tool === 'search_stores' && result.success && Array.isArray(data.stores)) {
      const stores = data.stores.slice(0, 8).map(s => `${s._id}:${s.storeName}; slug=${s.storeSlug || s.slug || ''}; matches=${(s.matchingProducts || []).map(p => p.name).join(', ')}`);
      lines.push(`[Tool memory: search_stores returned stores: ${stores.join(' | ')}. Use storeSlug/storeId internally when searching products from a chosen store.]`);
    } else if (event.tool === 'add_product' && result.duplicate) {
      const existing = data.existingProduct || {};
      lines.push(`[Tool memory: add_product duplicate blocked. Existing productId=${existing.productId || ''}; name="${existing.name || ''}". Ask for explicit duplicate confirmation before creating another listing.]`);
    } else if (result.success === false) {
      lines.push(`[Tool memory: ${event.tool} failed: ${result.error || result.message || 'unknown error'}. Do not claim it succeeded.]`);
    } else if (result.success === true) {
      lines.push(`[Tool memory: ${event.tool} succeeded in the previous assistant turn. Do not repeat it unless the current user explicitly asks to run it again.]`);
    }
    if (lines.length >= 6) break;
  }
  return lines.join('\n');
};

// ─── Voice Waveform ───
const VoiceWaveform = ({ isActive }) => (
  <div className="flex items-center justify-center gap-[3px] h-16">
    {[...Array(12)].map((_, i) => (
      <motion.div key={i} className="w-[3px] rounded-full"
        style={{ background: `hsl(${220 + i * 10}, 70%, ${55 + Math.sin(i) * 10}%)` }}
        animate={isActive ? { height: [8, 20 + Math.random() * 40, 12, 30 + Math.random() * 30, 8] } : { height: 8 }}
        transition={isActive ? { duration: 0.8 + Math.random() * 0.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 } : { duration: 0.3 }}
      />
    ))}
  </div>
);

// ─── Style Advice Card ───
const StyleAdviceCard = ({ data }) => (
  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl overflow-hidden mt-2"
    style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
    <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'linear-gradient(135deg, hsl(280, 60%, 50%, 0.15), hsl(320, 50%, 55%, 0.1))' }}>
      <Palette size={14} style={{ color: 'hsl(280, 60%, 60%)' }} />
      <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Style Advice — {data.occasion}</span>
    </div>
    <div className="p-3 space-y-2">
      <p className="text-xs leading-relaxed" style={{ color: 'hsl(var(--foreground))' }}>{data.advice}</p>
      {data.colorPalette?.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-medium" style={{ color: 'hsl(var(--muted-foreground))' }}>Colors:</span>
          {data.colorPalette.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <div className="w-4 h-4 rounded-full border border-white/20" style={{ background: c.color }} />
              <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{c.name}</span>
            </div>
          ))}
        </div>
      )}
      {data.tips?.length > 0 && (
        <div className="space-y-1 mt-1">
          {data.tips.map((tip, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <Sparkles size={10} className="mt-0.5 shrink-0" style={{ color: 'hsl(280, 60%, 60%)' }} />
              <span className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{tip}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  </motion.div>
);

// ─── Outfit Card ───
const OutfitCard = ({ data, onSearchPiece }) => (
  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl overflow-hidden mt-2"
    style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
    <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%, 0.15), hsl(170, 60%, 45%, 0.1))' }}>
      <Sparkles size={14} style={{ color: 'hsl(220, 70%, 55%)' }} />
      <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>Outfit Idea — {data.occasion}</span>
    </div>
    <div className="p-3 space-y-2">
      {data.pieces?.map((piece, i) => (
        <div key={i} className="flex items-center gap-2 p-2 rounded-xl" style={{ background: 'hsl(var(--muted) / 0.3)' }}>
          <div className="w-3 h-3 rounded-full shrink-0" style={{ background: piece.color }} />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium" style={{ color: 'hsl(var(--foreground))' }}>{piece.type}</p>
            <p className="text-[10px]" style={{ color: 'hsl(var(--muted-foreground))' }}>{piece.description}</p>
          </div>
          {piece.searchQuery && (
            <button onClick={() => onSearchPiece(piece.searchQuery)} className="text-[10px] px-2 py-1 rounded-lg shrink-0"
              style={{ background: 'hsl(220, 70%, 55%, 0.15)', color: 'hsl(220, 70%, 55%)' }}>Find</button>
          )}
        </div>
      ))}
      <p className="text-[10px] italic mt-1" style={{ color: 'hsl(var(--muted-foreground))' }}>💡 {data.reasoning}</p>
    </div>
  </motion.div>
);

// ─── Navigation Card ───
const NavigationCard = ({ label }) => (
  <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
    className="flex items-center gap-2 p-2 rounded-xl mt-1"
    style={{ background: 'hsl(220, 70%, 55%, 0.1)', border: '1px solid hsl(220, 70%, 55%, 0.2)' }}>
    <ArrowRight size={12} style={{ color: 'hsl(220, 70%, 55%)' }} />
    <span className="text-[11px] font-medium" style={{ color: 'hsl(220, 70%, 55%)' }}>Navigated to {label}</span>
  </motion.div>
);

// ─── Action Result Card ───
const ActionResultCard = ({ result, actionName, icon: Icon = Package, color = 'hsl(150, 60%, 45%)' }) => {
  const bgColor = color.replace('hsl(', 'hsla(').replace(')', ', 0.1)');
  const borderColor = color.replace('hsl(', 'hsla(').replace(')', ', 0.2)');
  const isBlocked = result?.blocked || result?.requiresConfirmation;
  const isSuccess = result?.success !== false && !isBlocked;
  const StatusIcon = isSuccess ? CheckCircle : isBlocked ? AlertCircle : XCircle;
  const statusLabel = isSuccess ? 'Action completed' : isBlocked ? 'Action needs review' : 'Action failed';
  const detail = result?.message || result?.error || `${formatToolDisplayName(actionName)} completed`;
  return (
    <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-2 p-2.5 rounded-xl mt-1"
      style={{ background: bgColor, border: `1px solid ${borderColor}` }}>
      <Icon size={14} style={{ color }} className="shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-[10px] font-semibold uppercase tracking-wide flex items-center gap-1" style={{ color }}>
          <StatusIcon size={11} className="shrink-0" />
          <span>{statusLabel} - {formatToolDisplayName(actionName)}</span>
        </span>
        <span className="text-[11px] font-medium block mt-0.5" style={{ color: 'hsl(var(--foreground))' }}>
          {detail}
        </span>
      </div>
    </motion.div>
  );
};

// ─── Data List Card ───
const DataListCard = ({ title, items, renderItem, icon: Icon = Package, color = 'hsl(220, 70%, 55%)', emptyText = 'No items' }) => {
  const bgColor = color.replace('hsl(', 'hsla(').replace(')', ', 0.15)');
  const bgColor2 = color.replace('hsl(', 'hsla(').replace(')', ', 0.05)');
  return (
    <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl overflow-hidden mt-2"
      style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}>
      <div className="px-3 py-2 flex items-center gap-2" style={{ background: `linear-gradient(135deg, ${bgColor}, ${bgColor2})` }}>
        <Icon size={14} style={{ color }} />
        <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{title}</span>
        <span className="text-[10px] ml-auto" style={{ color: 'hsl(var(--muted-foreground))' }}>{items.length} item{items.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="p-2 space-y-1.5 max-h-64 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-[11px] text-center py-3" style={{ color: 'hsl(var(--muted-foreground))' }}>{emptyText}</p>
        ) : (
          items.slice(0, 10).map((item, i) => <div key={i}>{renderItem(item, i)}</div>)
        )}
      </div>
    </motion.div>
  );
};

// ─── Product Card (compact, for chat context) ───
const ProductCardInChat = ({ product, onView, onAddToCart }) => {
  const { formatPrice } = useCurrency();
  const productPrice = resolveProductPresentationMoney(product, 'price');
  const discountedPrice = resolveProductPresentationMoney(product, 'discountedPrice');
  const hasDiscount = discountedPrice > 0 && discountedPrice < productPrice;
  const displayPrice = hasDiscount ? discountedPrice : productPrice;
  const productCurrency = resolveProductPresentationCurrency(product);
  const stars = product.rating ? Math.round(product.rating) : 0;

  return (
    <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
      className="flex gap-2.5 p-2 rounded-xl transition-all hover:scale-[1.01]"
      style={{ background: 'hsl(var(--muted) / 0.3)', border: '1px solid hsl(var(--border))' }}>
      {/* Product Image */}
      <div className="w-16 h-16 rounded-lg overflow-hidden shrink-0" style={{ background: 'hsl(var(--muted) / 0.5)' }}>
        {product.image ? (
          <img src={product.image} alt={product.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ShoppingBag size={16} style={{ color: 'hsl(var(--muted-foreground))' }} />
          </div>
        )}
      </div>
      {/* Product Info */}
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>{product.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[11px] font-bold" style={{ color: 'hsl(220, 70%, 55%)' }}>{formatPrice(displayPrice, { sourceCurrency: productCurrency })}</span>
          {hasDiscount && (
            <span className="text-[9px] line-through" style={{ color: 'hsl(var(--muted-foreground))' }}>{formatPrice(product.price, { sourceCurrency: productCurrency })}</span>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          {stars > 0 && (
            <div className="flex items-center gap-0.5">
              {[...Array(5)].map((_, i) => (
                <Star key={i} size={8} fill={i < stars ? '#f59e0b' : 'transparent'} stroke={i < stars ? '#f59e0b' : '#6b7280'} />
              ))}
              <span className="text-[9px] ml-0.5" style={{ color: 'hsl(var(--muted-foreground))' }}>({product.numReviews || 0})</span>
            </div>
          )}
          {product.stock > 0 ? (
            <span className="text-[8px] px-1.5 py-0.5 rounded-full ml-auto" style={{ background: 'hsl(150, 60%, 45%, 0.15)', color: 'hsl(150, 60%, 50%)' }}>In Stock</span>
          ) : (
            <span className="text-[8px] px-1.5 py-0.5 rounded-full ml-auto" style={{ background: 'hsl(0, 60%, 45%, 0.15)', color: 'hsl(0, 60%, 55%)' }}>Out of Stock</span>
          )}
        </div>
        {/* Action buttons */}
        <div className="flex gap-1.5 mt-1.5">
          {onView && (
            <button onClick={() => onView(product._id)} className="flex items-center gap-1 text-[9px] px-2 py-1 rounded-lg transition-all hover:scale-105"
              style={{ background: 'hsl(220, 70%, 55%, 0.15)', color: 'hsl(220, 70%, 55%)' }}>
              <Eye size={9} /> View
            </button>
          )}
          {onAddToCart && product.stock > 0 && (
            <button onClick={() => onAddToCart(product._id)} className="flex items-center gap-1 text-[9px] px-2 py-1 rounded-lg transition-all hover:scale-105"
              style={{ background: 'hsl(150, 60%, 45%, 0.15)', color: 'hsl(150, 60%, 50%)' }}>
              <ShoppingCart size={9} /> Add to Cart
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
};

// ─── Product Card Grid (for search results) ───
const ProductCardGrid = ({ products, onViewProduct, onAddToCart, title }) => (
  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-2xl overflow-hidden mt-2"
    style={{ background: 'var(--glass-bg, hsl(var(--muted)/0.2))', border: '1px solid var(--glass-border, hsl(var(--border)))' }}>
    <div className="px-3 py-2 flex items-center gap-2" style={{ background: 'linear-gradient(135deg, hsl(220, 70%, 55%, 0.12), hsl(280, 60%, 55%, 0.06))' }}>
      <ShoppingBag size={14} style={{ color: 'hsl(220, 70%, 55%)' }} />
      <span className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>{title || 'Products'}</span>
      <span className="text-[10px] ml-auto" style={{ color: 'hsl(var(--muted-foreground))' }}>{products.length} found</span>
    </div>
    <div className="p-2 space-y-1.5 max-h-80 overflow-y-auto">
      {products.slice(0, 8).map((p, i) => (
        <ProductCardInChat
          key={p._id || i}
          product={p}
          onView={onViewProduct}
          onAddToCart={onAddToCart}
        />
      ))}
      {products.length > 8 && (
        <p className="text-[10px] text-center py-1" style={{ color: 'hsl(var(--muted-foreground))' }}>
          +{products.length - 8} more products...
        </p>
      )}
    </div>
  </motion.div>
);

// ═══════════════════════════════════════════════════════
//  MAIN CHATBOT COMPONENT
// ═══════════════════════════════════════════════════════

function ChatBot({ embedded = false, conversationId = null, initialMessages = null, loadingHistory = false, onConversationCreated = null, dashboardRole = null }) {
  const navigate = useNavigate();
  const { currentUser, fetchAndUpdateCurrentUser } = useAuth();
  const { fetchWishlist, fetchCart } = useGlobal();
  const chatAttemptStorageKey = createScopedMutationStorageKey(
    CHAT_ATTEMPT_STORAGE_KEY,
    currentUser?._id || currentUser?.id || 'guest'
  );
  const { formatPrice, currency } = useCurrency();

  // State
  const [isOpen, setIsOpen] = useState(embedded);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showChips, setShowChips] = useState(true);
  const [pendingTools, setPendingTools] = useState([]);
  const [activeConvoId, setActiveConvoId] = useState(conversationId);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isStartingNewChat, setIsStartingNewChat] = useState(false);
  const isUploadingProductImage = false;
  const [pendingProductImages, setPendingProductImages] = useState([]);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [reportingMessage, setReportingMessage] = useState(null);

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const hasLoadedHistory = useRef(false);
  const pendingProductImagesRef = useRef([]);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingStreamRef = useRef(null);

  // Derived
  const role = ['user', 'seller', 'admin'].includes(dashboardRole) ? dashboardRole : (currentUser?.role || 'user');
  const userName = currentUser?.username || '';
  const authToken = typeof window !== 'undefined' ? getAuthToken() : null;
  const chips = ROLE_CHIPS[role] || ROLE_CHIPS.user;
  const titles = ROLE_TITLES[role] || ROLE_TITLES.user;
  const canUploadProductAttachment = authToken && (role === 'seller' || role === 'admin');
  const canRecordVoice = Boolean(authToken)
    && typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';

  // Product and discovery surfaces can open the single global assistant with
  // contextual text while preserving the user's current conversation.
  useEffect(() => {
    const handleOpenAIChat = (event) => {
      const prompt = String(event?.detail?.prompt || '').trim();
      setIsOpen(true);
      if (prompt) setInput(prompt);
      window.requestAnimationFrame?.(() => inputRef.current?.focus());
    };

    window.addEventListener(OPEN_AI_CHAT_EVENT, handleOpenAIChat);
    return () => window.removeEventListener(OPEN_AI_CHAT_EVENT, handleOpenAIChat);
  }, []);

  // ─── Load initial messages from parent (AI Chat page) ───
  useEffect(() => {
    if (initialMessages !== null) {
      if (initialMessages.length > 0) {
        setMessages(initialMessages.map(m => ({
          ...normalizeChatMessage(m),
        })));
        setShowChips(false);
      } else {
        // New empty conversation — show greeting
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
        const greetFn = ROLE_GREETINGS[role] || ROLE_GREETINGS.user;
        setMessages([{ role: 'assistant', content: greetFn(userName, greeting) }]);
        setShowChips(true);
      }
    }
  }, [initialMessages, conversationId, role, userName]);

  // ─── Track conversationId from parent ───
  useEffect(() => {
    setActiveConvoId(conversationId);
  }, [conversationId]);

  // ─── Load chat history on open (floating mode only) ───
  useEffect(() => {
    if (isOpen && messages.length === 0 && initialMessages === null && !hasLoadedHistory.current && authToken) {
      hasLoadedHistory.current = true;
      setIsLoadingHistory(true);
      // Try to load the active conversation from the API
      resilientFetch(`${API_BASE}api/ai-chat/conversations`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
        .then(r => r.json())
        .then(data => {
          const activeId = data.activeConversationId;
          const activeConvo = data.conversations?.find(c => c._id === activeId);
          if (activeId && activeConvo && activeConvo.messageCount > 0) {
            // Load that conversation's messages
            return resilientFetch(`${API_BASE}api/ai-chat/conversations/${activeId}`, {
              headers: { Authorization: `Bearer ${authToken}` },
            }).then(r => r.json());
          }
          return null;
        })
        .then(convoData => {
          if (convoData && convoData.messages?.length > 0) {
            setMessages(convoData.messages.map(m => ({
              ...normalizeChatMessage(m),
            })));
            setActiveConvoId(convoData._id);
            setShowChips(false);
          } else {
            // No history — show greeting
            const hour = new Date().getHours();
            const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
            const greetFn = ROLE_GREETINGS[role] || ROLE_GREETINGS.user;
            setMessages([{ role: 'assistant', content: greetFn(userName, greeting) }]);
            setShowChips(true);
          }
        })
        .catch(() => {
          // Fallback greeting
          const hour = new Date().getHours();
          const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
          const greetFn = ROLE_GREETINGS[role] || ROLE_GREETINGS.user;
          setMessages([{ role: 'assistant', content: greetFn(userName, greeting) }]);
          setShowChips(true);
        })
        .finally(() => setIsLoadingHistory(false));
    } else if (isOpen && messages.length === 0 && initialMessages === null && !authToken) {
      // Guest — just show greeting
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      const greetFn = ROLE_GREETINGS[role] || ROLE_GREETINGS.user;
      setMessages([{ role: 'assistant', content: greetFn(userName, greeting) }]);
      setShowChips(true);
    }
  }, [isOpen, messages.length, initialMessages, authToken, role, userName]);

  // ─── Auto-scroll ───
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingTools]);

  // ─── Focus input on open ───
  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 300);
  }, [isOpen]);

  useEffect(() => {
    pendingProductImagesRef.current = pendingProductImages;
  }, [pendingProductImages]);

  useEffect(() => () => {
    pendingProductImagesRef.current.forEach(image => {
      if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
    });
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    recordingStreamRef.current?.getTracks?.().forEach(track => track.stop());
  }, []);

  useEffect(() => {
    if (!isRecordingVoice) {
      setRecordingSeconds(0);
      return undefined;
    }
    const timer = window.setInterval(() => setRecordingSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRecordingVoice]);

  // ─── Handle client-side actions from the server ───
  const handleClientAction = useCallback((action, args) => {
    switch (action) {
      case 'navigate':
        if (args.route) {
          const route = normalizeAIRoute(args.route);
          setTimeout(() => navigate(route), 400);
          return { type: 'navigation', label: args.label || route };
        }
        break;
      case 'show_style_advice':
        return { type: 'style_advice', data: args };
      case 'suggest_outfit':
        return { type: 'outfit', data: args };
      default:
        return null;
    }
    return null;
  }, [navigate]);

  const handleProductImageUpload = useCallback(async (event) => {
    const files = Array.from(event.target.files || []).filter(Boolean);
    if (!files.length) return;

    try {
      const tooLarge = files.find(file => file.size > 15 * 1024 * 1024);
      if (tooLarge) {
        throw new Error(`${tooLarge.name} is larger than 15MB`);
      }
      const nextImages = files.map(file => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: file.type?.startsWith('image/') ? URL.createObjectURL(file) : '',
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
      }));
      setPendingProductImages(prev => {
        const combined = [...prev, ...nextImages];
        const kept = combined.slice(0, 8);
        combined.slice(8).forEach(image => {
          if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
        });
        return kept;
      });
      toast.success(`${nextImages.length} file${nextImages.length > 1 ? 's' : ''} attached. Add product details or send when ready.`);
      setTimeout(() => inputRef.current?.focus(), 0);
    } catch (error) {
      toast.error(error.message || 'Failed to attach image');
    } finally {
      if (event.target) event.target.value = '';
    }
  }, []);

  // ─── Send message (SSE streaming with server-side tool execution) ───
  const stopRecordingStream = useCallback(() => {
    recordingStreamRef.current?.getTracks?.().forEach(track => track.stop());
    recordingStreamRef.current = null;
  }, []);

  const startVoiceRecording = useCallback(async () => {
    if (!canRecordVoice) {
      toast.error('Voice recording is not available in this browser.');
      return;
    }
    if (isLoading || isRecordingVoice) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ].find(type => MediaRecorder.isTypeSupported?.(type));
      const recorder = new MediaRecorder(stream, preferredMime ? { mimeType: preferredMime } : undefined);

      recordingChunksRef.current = [];
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) recordingChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const mimeType = recorder.mimeType || preferredMime || 'audio/webm';
        const blob = new Blob(recordingChunksRef.current, { type: mimeType });
        recordingChunksRef.current = [];
        stopRecordingStream();
        setIsRecordingVoice(false);

        if (!blob.size) {
          toast.error('No voice audio was captured.');
          return;
        }
        if (blob.size > 15 * 1024 * 1024) {
          toast.error('Voice note is larger than 15MB. Please record a shorter note.');
          return;
        }

        const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
        const file = new File([blob], `voice-note-${Date.now()}.${extension}`, { type: mimeType });
        const voiceAttachment = {
          id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
          file,
          previewUrl: '',
          name: file.name,
          size: file.size,
          type: file.type || 'audio/webm',
        };

        setPendingProductImages(prev => {
          const combined = [...prev, voiceAttachment];
          const kept = combined.slice(0, 8);
          combined.slice(8).forEach(item => {
            if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
          });
          return kept;
        });
        toast.success('Voice note attached. Send when ready.');
      };

      recorder.start();
      setIsRecordingVoice(true);
    } catch (error) {
      stopRecordingStream();
      setIsRecordingVoice(false);
      toast.error(error?.message || 'Could not start voice recording.');
    }
  }, [canRecordVoice, isLoading, isRecordingVoice, stopRecordingStream]);

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.stop();
    } else {
      stopRecordingStream();
      setIsRecordingVoice(false);
    }
  }, [stopRecordingStream]);

  const formatRecordingTime = (seconds = 0) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };

  const sendMessage = useCallback(async (text, attachments = []) => {
    const trimmedText = String(text || '').trim();
    const pendingAttachments = Array.isArray(attachments) ? attachments : (attachments ? [attachments] : []);
    if ((!trimmedText && pendingAttachments.length === 0) || isLoading || isStartingNewChat) return;

    const displayAttachments = pendingAttachments.map(attachment => ({
      type: attachment.type?.startsWith('image/') ? 'image' : attachment.type?.startsWith('audio/') ? 'audio' : 'file',
      url: attachment.previewUrl || attachment.url || '',
      name: attachment.name || 'Attachment',
    }));

    const visibleContent = trimmedText || (
      pendingAttachments.length > 1
        ? `${pendingAttachments.length} files attached`
        : `${pendingAttachments[0]?.type?.startsWith('image/') ? 'Image' : pendingAttachments[0]?.type?.startsWith('audio/') ? 'Voice note' : 'File'} attached`
    );
    const apiUserMsg = {
      role: 'user',
      content: visibleContent,
      ...(displayAttachments.length ? { attachments: displayAttachments } : {}),
    };
    const userMsg = {
      role: 'user',
      content: visibleContent,
      ...(displayAttachments.length ? { attachments: displayAttachments } : {}),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingProductImages(prev => {
      prev.forEach(attachment => {
        if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
      return [];
    });
    setShowChips(false);
    setIsLoading(true);
    setPendingTools([]);

    // Build conversation history for the API (only user/assistant text messages)
    const apiMessages = [...messages, apiUserMsg]
      .filter(m => (
        (m.role === 'user' || m.role === 'assistant')
        && (m.content || (Array.isArray(m.toolEvents) && m.toolEvents.length > 0))
      ))
      .map(m => {
        const toolMemory = summarizeToolEventsForPrompt(m.toolEvents);
        const attachmentMemory = (m.attachments || [])
          .filter(attachment => attachment?.type === 'image' && /^https?:\/\//i.test(attachment.url || ''))
          .map(attachment => `[Attached product image: ${attachment.url}]`)
          .join('\n');
        const baseContent = m.role === 'assistant'
          ? sanitizeAssistantContent(stripAttachmentMetadata(m.content))
          : stripAttachmentMetadata(m.content);
        const content = attachmentMemory
          ? `${baseContent || 'Image attached'}\n\n${attachmentMemory}`
          : baseContent;
        const promptContent = [content, toolMemory].filter(Boolean).join('\n\n');
        return {
          role: m.role,
          content: promptContent,
        };
      });

    // Add assistant placeholder for streaming
    setMessages(prev => [...prev, { role: 'assistant', content: '', isStreaming: true, toolEvents: [] }]);

    const requestCurrency = String(currency || 'USD').trim().toUpperCase();
    const fingerprint = createChatMutationFingerprint({
      actorId: currentUser?._id || currentUser?.id || 'guest',
      currency: requestCurrency,
      text: visibleContent,
      attachments: pendingAttachments,
    });
    let attemptKey = '';

    try {
      // This resolves only after the independent fingerprint record has been
      // persisted and read back. Never start the network mutation earlier.
      const attempt = await getOrCreatePersistedMutationAttemptForFingerprint({
        storage: localStorage,
        storageKey: chatAttemptStorageKey,
        fingerprint,
        keyPrefix: 'chat-send',
        randomUUID: globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
      });
      const requestKey = attempt.key;
      attemptKey = requestKey;
      const hasFileAttachments = pendingAttachments.some(attachment => attachment?.file);
      const requestBody = hasFileAttachments ? new FormData() : null;
      if (requestBody) {
        requestBody.append('messages', JSON.stringify(apiMessages));
        requestBody.append('requestKey', requestKey);
        requestBody.append('currency', requestCurrency);
        if (activeConvoId) requestBody.append('conversationId', activeConvoId);
        pendingAttachments.forEach(attachment => {
          if (attachment?.file) requestBody.append('attachments', attachment.file, attachment.name || attachment.file.name);
        });
      }

      const resp = await fetch(AI_CHAT_URL, {
        method: 'POST',
        headers: requestBody
          ? {
            Accept: 'text/event-stream',
            'Idempotency-Key': requestKey,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          }
          : {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'Idempotency-Key': requestKey,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
        body: requestBody || JSON.stringify({
          messages: apiMessages,
          requestKey,
          currency: requestCurrency,
          ...(activeConvoId ? { conversationId: activeConvoId } : {}),
        }),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        const requestError = new Error(errData.error || `Request failed (${resp.status})`);
        requestError.status = resp.status;
        throw requestError;
      }

      if (!resp.body) throw new Error('No response body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamCompleted = false;
      let streamHadError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          let line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') {
            streamCompleted = true;
            continue;
          }

          try {
            const parsed = JSON.parse(jsonStr);

            // Error event
            if (parsed.error) {
              streamHadError = true;
              setMessages(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.isStreaming) {
                  last.content = parsed.error;
                  last.isStreaming = false;
                  last.isError = true;
                }
                return copy;
              });
              continue;
            }

            // Standard text delta
            if (parsed.choices?.[0]?.delta?.content) {
              const chunk = parsed.choices[0].delta.content;
              setMessages(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.isStreaming) last.content = sanitizeAssistantContent(`${last.content || ''}${chunk}`);
                return copy;
              });
              continue;
            }

            // Tool start event (server is executing a tool)
            if (parsed.type === 'tool_start') {
              setPendingTools(prev => [...prev, { tool: parsed.tool, status: 'running', id: parsed.id }]);
              continue;
            }

            // Tool result event
            if (parsed.type === 'tool_result') {
              if (UNRESOLVED_AI_ACTION_CODES.has(parsed.result?.code)) {
                // A 200 SSE connection does not prove the underlying mutation
                // committed. Retain this logical request key even when an old
                // backend does not yet emit a request-level retry event.
                streamHadError = true;
              }
              setPendingTools(prev =>
                prev.map(t => t.id === parsed.id ? { ...t, status: 'done', result: parsed.result } : t)
              );
              if (parsed.result?.success === true) {
                if (['add_to_wishlist', 'remove_from_wishlist'].includes(parsed.tool)) {
                  void fetchWishlist();
                }
                if (['add_to_cart', 'remove_from_cart', 'clear_cart', 'place_order'].includes(parsed.tool)) {
                  void fetchCart();
                }
                if (parsed.tool === 'update_profile') {
                  void fetchAndUpdateCurrentUser();
                }
              }
              // Add tool result to the current assistant message
              setMessages(prev => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last?.isStreaming) {
                  if (!last.toolEvents) last.toolEvents = [];
                  last.toolEvents.push({
                    type: 'tool_result',
                    tool: parsed.tool,
                    result: parsed.result,
                  });
                }
                return copy;
              });
              continue;
            }

            // Conversation ID tracking (server sends this after saving)
            if (parsed.type === 'conversation_id' && parsed.conversationId) {
              setActiveConvoId(parsed.conversationId);
              if (onConversationCreated) onConversationCreated(parsed.conversationId);
              continue;
            }

            // Client action event (navigate, style advice, outfit)
            if (parsed.type === 'client_action') {
              const actionResult = handleClientAction(parsed.action, parsed.args);
              if (actionResult) {
                setMessages(prev => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last?.isStreaming) {
                    if (!last.toolEvents) last.toolEvents = [];
                    last.toolEvents.push(actionResult);
                  }
                  return copy;
                });
              }
              continue;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Finalize streaming message
      setMessages(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.isStreaming) last.isStreaming = false;
        return copy;
      });
      if (streamCompleted && !streamHadError) {
        await clearPersistedMutationAttemptForFingerprint(
          localStorage,
          chatAttemptStorageKey,
          fingerprint,
          attemptKey,
        );
      }

    } catch (err) {
      if (!shouldRetainIdempotencyKey(err?.status)) {
        await clearPersistedMutationAttemptForFingerprint(
          localStorage,
          chatAttemptStorageKey,
          fingerprint,
          attemptKey,
        );
      }
      console.error('Chat error:', err);
      setMessages(prev => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last?.isStreaming) {
          last.content = last.content || err.message || 'Something went wrong. Please try again.';
          last.isStreaming = false;
          last.isError = !last.content || last.content === err.message;
        } else {
          copy.push({ role: 'assistant', content: err.message || 'Something went wrong.', isError: true });
        }
        return copy;
      });
    } finally {
      setIsLoading(false);
      setPendingTools([]);
    }
  }, [messages, isLoading, isStartingNewChat, authToken, activeConvoId, handleClientAction, currentUser?._id, currentUser?.id, currency, chatAttemptStorageKey, onConversationCreated, fetchWishlist, fetchCart, fetchAndUpdateCurrentUser]);

  // ─── Clear chat (start a brand-new conversation) ───
  const clearChat = async () => {
    if (isLoading || isStartingNewChat) return;
    setIsStartingNewChat(true);
    setMessages([]);
    setShowChips(true);
    setPendingTools([]);
    setActiveConvoId(null);
    hasLoadedHistory.current = true; // don't re-load history into this new session

    // For logged-in users, create a fresh conversation on the server so the next
    // message doesn't accidentally append to the previously-active conversation.
    try {
      if (authToken) {
        const resp = await fetch(`${API_BASE}api/ai-chat/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ title: 'New Chat' }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data?._id) {
            setActiveConvoId(data._id);
            if (onConversationCreated) onConversationCreated(data._id);
          }
        }
      }
    } catch (e) {
      console.error('Failed to start new conversation:', e);
    } finally {
      setIsStartingNewChat(false);
    }

    // Re-trigger greeting
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const greetFn = ROLE_GREETINGS[role] || ROLE_GREETINGS.user;
    setMessages([{ role: 'assistant', content: greetFn(userName, greeting) }]);
    setShowChips(true);
  };

  // ─── Render a message ───
  const renderMessage = (msg, idx) => {
    const isAssistant = msg.role === 'assistant';
    const isUser = msg.role === 'user';
    const imageAttachments = isUser ? extractImageAttachments(msg.content, msg.attachments) : [];
    const fileAttachments = isUser
      ? (msg.attachments || []).filter(attachment => attachment?.type && attachment.type !== 'image')
      : [];
    const visibleUserContent = isUser
      ? (stripAttachmentMetadata(msg.content) || (imageAttachments.length ? 'Image attached' : ''))
      : sanitizeAssistantContent(msg.content);

    return (
      <motion.div
        key={idx}
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}
      >
        {isAssistant && (
          <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 shadow-md"
            style={{ background: 'linear-gradient(135deg, #14B8A6, #0EA5E9, #6366F1)' }}>
            <Bot size={15} className="text-white" />
          </div>
        )}

        <div className={`max-w-[85%] sm:max-w-[80%] ${isUser ? 'order-first' : ''}`}>
          <div className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
            isUser ? 'rounded-br-md shadow-md' : 'rounded-bl-md'
          }`} style={{
            background: isUser
              ? 'linear-gradient(135deg, #14B8A6, #0EA5E9, #6366F1)'
              : msg.isError
                ? 'hsl(var(--destructive) / 0.1)'
                : 'hsl(var(--muted) / 0.55)',
            color: isUser ? 'white' : 'hsl(var(--foreground))',
            border: msg.isError
              ? '1px solid hsl(var(--destructive) / 0.3)'
              : isUser ? 'none' : '1px solid hsl(var(--border) / 0.6)',
          }}>
            {msg.isStreaming && !msg.content ? (
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-xs opacity-70">Thinking...</span>
              </div>
            ) : isAssistant ? (
              <div className="prose prose-sm prose-invert max-w-none [&>p]:mb-1 [&>p:last-child]:mb-0 [&>ul]:mb-1 [&>ol]:mb-1 [&_li]:text-sm">
                <ReactMarkdown
                  components={{
                    a: ({ node: _node, ...props }) => (
                      <a {...props} className="text-blue-400 underline" target="_blank" rel="noopener noreferrer" />
                    ),
                    p: ({ node: _node, ...props }) => <p {...props} className="mb-1" />,
                  }}
                >
                  {visibleUserContent || ''}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="space-y-2">
                {imageAttachments.map((attachment, attachmentIdx) => (
                  <div
                    key={`${attachment.url}-${attachmentIdx}`}
                    className="rounded-xl overflow-hidden"
                    style={{ background: 'rgba(255,255,255,0.10)' }}
                  >
                    <img
                      src={attachment.url}
                      alt={attachment.name || 'Attached product image'}
                      className="w-full max-h-56 object-cover"
                      loading="lazy"
                    />
                  </div>
                ))}
                {fileAttachments.map((attachment, attachmentIdx) => (
                  <div
                    key={`${attachment.name || 'file'}-${attachmentIdx}`}
                    className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs"
                    style={{ background: 'rgba(255,255,255,0.12)' }}
                  >
                    {attachment.type === 'audio' ? <Mic size={14} className="shrink-0" /> : <FileText size={14} className="shrink-0" />}
                    <span className="truncate">{attachment.name || (attachment.type === 'audio' ? 'Voice note' : 'Attached file')}</span>
                  </div>
                ))}
                {visibleUserContent && <p>{visibleUserContent}</p>}
              </div>
            )}
            {msg.isStreaming && msg.content && (
              <span className="inline-block w-1.5 h-4 ml-0.5 rounded-sm animate-pulse"
                style={{ background: 'hsl(var(--foreground))' }} />
            )}
          </div>

          {/* Tool Events: actions executed, navigation, style cards, PRODUCT CARDS */}
          {msg.toolEvents?.map((event, i) => {
            if (event.type === 'navigation') {
              return <NavigationCard key={i} label={event.label} />;
            }
            if (event.type === 'style_advice') {
              return <StyleAdviceCard key={i} data={event.data} />;
            }
            if (event.type === 'outfit') {
              return <OutfitCard key={i} data={event.data} onSearchPiece={(q) => sendMessage(`Search for: ${q}`)} />;
            }
            if (event.type === 'tool_result') {
              const result = event.result;
              const toolName = event.tool;

              // ── Product cards for search_products, list_my_products, get_wishlist ──
              const products = result?.data?.products || result?.data?.items;
              if (products?.length > 0 && (toolName === 'search_products' || toolName === 'list_my_products' || toolName === 'get_wishlist')) {
                return (
                  <ProductCardGrid
                    key={i}
                    products={products}
                    title={result?.message || `${products.length} products`}
                    onViewProduct={(id) => navigate(`/single-product/${id}`)}
                    onAddToCart={(id) => sendMessage(`Add product ${id} to my cart`)}
                  />
                );
              }

              // ── Single product detail card ──
              const stores = result?.data?.stores;
              if (stores?.length > 0 && (toolName === 'search_stores' || toolName === 'get_verified_stores')) {
                return (
                  <DataListCard
                    key={i}
                    title={result?.message || `${stores.length} stores`}
                    items={stores}
                    icon={Store}
                    color="hsl(190, 70%, 45%)"
                    renderItem={(store) => (
                      <button
                        type="button"
                        onClick={() => navigate(`/store/${store.slug || store.storeSlug}`)}
                        className="w-full flex items-center justify-between gap-2 p-2 rounded-lg text-left transition-all hover:scale-[1.01]"
                        style={{ background: 'hsl(var(--muted) / 0.35)', color: 'hsl(var(--foreground))' }}
                      >
                        <span className="min-w-0">
                          <span className="block text-[11px] font-semibold truncate">{store.storeName}</span>
                          <span className="block text-[10px] truncate" style={{ color: 'hsl(var(--muted-foreground))' }}>
                            {store.slug || store.storeSlug}
                          </span>
                        </span>
                        <ArrowRight size={12} className="shrink-0" />
                      </button>
                    )}
                  />
                );
              }

              if (toolName === 'get_product_detail' && result?.data?._id) {
                return (
                  <div key={i} className="mt-2">
                    <ProductCardInChat
                      product={result.data}
                      onView={(id) => navigate(`/single-product/${id}`)}
                      onAddToCart={(id) => sendMessage(`Add product ${id} to my cart`)}
                    />
                  </div>
                );
              }

              // ── Cart items with images ──
              if (toolName === 'send_product_image' && result?.data?.imageUrl) {
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-2 rounded-xl overflow-hidden"
                    style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)' }}
                  >
                    <img
                      src={result.data.imageUrl}
                      alt={result.data.name || 'Product image'}
                      className="w-full max-h-64 object-cover"
                      loading="lazy"
                    />
                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold truncate" style={{ color: 'hsl(var(--foreground))' }}>
                        {result.data.caption || result.data.name || 'Product image'}
                      </span>
                      {result.data.price != null && (
                        <span className="text-xs font-bold shrink-0" style={{ color: 'hsl(220, 70%, 55%)' }}>
                          {formatPrice(result.data.price, { sourceCurrency: result.data.currency || result.data.priceCurrency || 'USD' })}
                        </span>
                      )}
                    </div>
                  </motion.div>
                );
              }

              if (toolName === 'view_cart' && result?.data?.items?.length > 0) {
                return (
                  <ProductCardGrid
                    key={i}
                    products={result.data.items.map(item => ({
                      _id: item.productId,
                      name: item.name,
                      price: item.originalPrice || item.price,
                      discountedPrice: item.price,
                      currency: item.currency || result.data.currency,
                      image: item.image,
                      stock: 1,
                    }))}
                    title={`Cart — ${result.data.items.length} items — ${formatPrice(
                      requireExactPresentationMoney(result.data.total, 'AI cart total'),
                      {
                        sourceCurrency: requireCanonicalPresentationCurrency(
                          result.data.currency,
                          'AI cart currency',
                        ),
                      },
                    )}`}
                    onViewProduct={(id) => navigate(`/single-product/${id}`)}
                  />
                );
              }

              // ── Default: action result card ──
              const ToolIcon = TOOL_ICONS[toolName] || Package;
              const isBlocked = result?.blocked || result?.requiresConfirmation;
              const isSuccess = result?.success !== false && !isBlocked;
              const color = isSuccess
                ? 'hsl(150, 60%, 45%)'
                : isBlocked
                  ? 'hsl(38, 92%, 48%)'
                  : 'hsl(0, 60%, 55%)';
              return (
                <ActionResultCard
                  key={i}
                  result={result}
                  actionName={toolName}
                  icon={ToolIcon}
                  color={color}
                />
              );
            }
            return null;
          })}
          {isAssistant && !msg.isStreaming && !msg.isError && Boolean(visibleUserContent) && (
            <button
              type="button"
              onClick={() => setReportingMessage(msg)}
              className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] font-semibold transition-colors hover:bg-white/10"
              style={{ color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border) / .7)' }}
              aria-label="Report this AI response"
            >
              <Flag size={11} /> Report response
            </button>
          )}
        </div>

        {isUser && (
          <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: 'hsl(var(--muted))', border: '1px solid hsl(var(--border))' }}>
            <User size={15} style={{ color: 'hsl(var(--foreground))' }} />
          </div>
        )}
      </motion.div>
    );
  };

  // ─── Brand gradient (matches Rozare logo: teal → sky → indigo) ───
  const BRAND_GRADIENT = 'linear-gradient(135deg, #14B8A6 0%, #0EA5E9 50%, #6366F1 100%)';
  const BRAND_GRADIENT_SOFT = 'linear-gradient(135deg, rgba(20,184,166,0.12), rgba(14,165,233,0.10), rgba(99,102,241,0.10))';

  // ─── Chat Window ───
  const chatWindow = (
    <motion.div
      initial={embedded ? false : { opacity: 0, y: 20, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      className={`flex flex-col overflow-hidden ${
        embedded
          ? 'h-full w-full rounded-none sm:rounded-2xl'
          : 'h-[100dvh] w-screen rounded-none sm:h-[640px] sm:w-[400px] sm:max-w-[calc(100vw-2rem)] sm:rounded-3xl'
      }`}
      style={{
        background: 'hsl(var(--background))',
        border: '1px solid hsl(var(--border))',
        boxShadow: embedded ? 'none' : '0 25px 60px -15px rgba(15,23,42,0.35), 0 0 0 1px rgba(255,255,255,0.04)',
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 sm:py-3.5 flex items-center gap-3 relative overflow-hidden"
        style={{ background: BRAND_GRADIENT, color: 'white' }}
      >
        {/* Decorative orb */}
        <div
          className="absolute -top-10 -right-10 w-32 h-32 rounded-full opacity-25 pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(255,255,255,0.6), transparent 70%)' }}
        />
        <div
          className="w-10 h-10 rounded-2xl flex items-center justify-center backdrop-blur-sm shrink-0 relative"
          style={{ background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.25)' }}
        >
          <Bot size={20} />
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white"
            style={{ background: '#22c55e' }}
            title="Online"
          />
        </div>
        <div className="flex-1 min-w-0 relative">
          <h3 className="text-sm font-bold tracking-tight leading-tight truncate">{titles.title}</h3>
          <p className="text-[11px] opacity-90 leading-tight truncate flex items-center gap-1">
            <Sparkles size={10} className="opacity-90" />
            {titles.subtitle}
          </p>
        </div>
        <button
          onClick={clearChat}
          disabled={isLoading || isStartingNewChat}
          className="p-2 rounded-xl hover:bg-white/20 active:bg-white/30 transition-colors relative disabled:opacity-50"
          title="New chat"
          aria-label="New chat"
        >
          <Plus size={16} />
        </button>
        {!embedded && (
          <>
            <button
              onClick={() => { setIsOpen(false); navigate('/ai-chat'); }}
              className="inline-flex p-2 rounded-xl hover:bg-white/20 active:bg-white/30 transition-colors relative"
              title="Open full chat"
              aria-label="Open full chat"
            >
              <Maximize2 size={15} />
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 rounded-xl hover:bg-white/20 active:bg-white/30 transition-colors relative"
              aria-label="Close chat"
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 space-y-3"
        style={{ scrollBehavior: 'smooth', background: 'hsl(var(--background))' }}
      >
        {(isLoadingHistory || loadingHistory) ? (
          <div className="space-y-3 pt-2">
            {[0, 1, 2].map(i => (
              <div key={i} className={`flex gap-2 ${i % 2 === 1 ? 'justify-end' : ''}`}>
                {i % 2 === 0 && <div className="w-7 h-7 rounded-full shrink-0 animate-pulse" style={{ background: 'hsl(var(--muted) / 0.5)' }} />}
                <div className="space-y-1.5" style={{ maxWidth: '70%' }}>
                  <div className="h-3 w-40 rounded-full animate-pulse" style={{ background: 'hsl(var(--muted) / 0.5)' }} />
                  <div className="h-3 w-56 rounded-full animate-pulse" style={{ background: 'hsl(var(--muted) / 0.4)' }} />
                  <div className="h-3 w-24 rounded-full animate-pulse" style={{ background: 'hsl(var(--muted) / 0.3)' }} />
                </div>
              </div>
            ))}
          </div>
        ) : messages.map(renderMessage)}

        {/* Pending tool executions */}
        {pendingTools.filter(t => t.status === 'running').map((t, i) => (
          <motion.div
            key={`pending-${i}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 p-2.5 rounded-xl ml-9"
            style={{ background: BRAND_GRADIENT_SOFT, border: '1px solid rgba(14,165,233,0.18)' }}
          >
            <Loader2 size={12} className="animate-spin" style={{ color: '#0EA5E9' }} />
            <span className="text-[11px] font-medium" style={{ color: '#0EA5E9' }}>
              Running action: {formatToolDisplayName(t.tool)}
            </span>
          </motion.div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Quick Chips */}
      <AnimatePresence>
        {showChips && messages.length <= 1 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="px-3 sm:px-4 pb-2"
          >
            <p
              className="text-[10px] font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5"
              style={{ color: 'hsl(var(--muted-foreground))' }}
            >
              <Sparkles size={10} /> Suggested
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {chips.slice(0, 4).map((chip, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(chip.msg)}
                  className="text-[11px] px-3 py-1.5 rounded-full transition-all hover:scale-[1.03] active:scale-95 font-medium"
                  style={{
                    background: 'hsl(var(--muted) / 0.6)',
                    color: 'hsl(var(--foreground))',
                    border: '1px solid hsl(var(--border))',
                  }}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input */}
      <div
        className="p-3 sm:p-4 border-t"
        style={{
          borderColor: 'hsl(var(--border))',
          background: 'hsl(var(--background))',
          paddingBottom: embedded ? undefined : 'max(0.75rem, env(safe-area-inset-bottom))',
        }}
      >
        {pendingProductImages.length > 0 && (
          <div
            className="mb-2 rounded-2xl p-2"
            style={{ background: 'hsl(var(--muted) / 0.45)', border: '1px solid hsl(var(--border))' }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold" style={{ color: 'hsl(var(--foreground))' }}>
                {pendingProductImages.length} file{pendingProductImages.length > 1 ? 's' : ''} ready
              </p>
              <button
                type="button"
                onClick={() => setPendingProductImages(prev => {
                  prev.forEach(image => {
                    if (image?.previewUrl) URL.revokeObjectURL(image.previewUrl);
                  });
                  return [];
                })}
                className="h-7 px-2 rounded-lg text-[11px] transition-all hover:scale-[1.02] active:scale-95"
                style={{ background: 'hsl(var(--background) / 0.7)', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
              >
                Remove all
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {pendingProductImages.map(image => (
                <div key={image.id || image.previewUrl} className="relative">
                  {image.previewUrl ? (
                    <img
                      src={image.previewUrl}
                      alt={image.name || 'Selected product image'}
                      className="h-16 w-full rounded-xl object-cover"
                    />
                  ) : (
                    <div
                      className="h-16 w-full rounded-xl flex flex-col items-center justify-center px-1 text-center"
                      style={{ background: 'hsl(var(--background) / 0.7)', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
                    >
                      {image.type?.startsWith('audio/') ? <Mic size={16} /> : <FileText size={16} />}
                      <span className="text-[9px] leading-tight mt-1 line-clamp-2">{image.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setPendingProductImages(prev => prev.filter(item => {
                      const keep = (item.id || item.previewUrl) !== (image.id || image.previewUrl);
                      if (!keep && item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
                      return keep;
                    }))}
                    className="absolute -right-1 -top-1 h-6 w-6 rounded-full flex items-center justify-center shadow-sm"
                    style={{ background: 'hsl(var(--background))', color: 'hsl(var(--muted-foreground))', border: '1px solid hsl(var(--border))' }}
                    aria-label="Remove attached image"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {isRecordingVoice && (
          <div
            className="mb-2 rounded-2xl px-3 py-2 flex items-center justify-between gap-3"
            style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)', color: 'hsl(0, 72%, 55%)' }}
          >
            <span className="inline-flex items-center gap-2 text-xs font-semibold">
              <span className="h-2.5 w-2.5 rounded-full animate-pulse" style={{ background: 'hsl(0, 72%, 55%)' }} />
              Recording voice note
            </span>
            <span className="text-xs font-mono">{formatRecordingTime(recordingSeconds)}</span>
          </div>
        )}
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(input, pendingProductImages); }}
          className="flex gap-2 items-end"
        >
          <div
            className="flex-1 flex items-center gap-2 rounded-2xl px-3 py-2 transition-all focus-within:ring-2"
            style={{
              background: 'hsl(var(--muted) / 0.45)',
              border: '1px solid hsl(var(--border))',
              '--tw-ring-color': 'rgba(14,165,233,0.35)',
            }}
          >
            {canUploadProductAttachment && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.json,.csv,.tsv,.txt,.xlsx,.xls,.pdf,.docx,audio/*,.ogg,.opus,.mp3,.m4a,.wav,.webm,.flac"
                  multiple
                  className="hidden"
                  onChange={handleProductImageUpload}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading || isStartingNewChat || isUploadingProductImage}
                  className="h-8 w-8 shrink-0 rounded-xl flex items-center justify-center transition-all disabled:opacity-40 hover:scale-[1.04] active:scale-95"
                  style={{
                    background: 'hsl(var(--background) / 0.7)',
                    color: 'hsl(var(--muted-foreground))',
                    border: '1px solid hsl(var(--border))',
                  }}
                  title="Upload product image or file"
                  aria-label="Upload product image or file"
                >
                  {isUploadingProductImage ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
                </button>
              </>
            )}
            {canRecordVoice && (
              <button
                type="button"
                onClick={isRecordingVoice ? stopVoiceRecording : startVoiceRecording}
                disabled={(isLoading || isStartingNewChat) && !isRecordingVoice}
                className="h-8 w-8 shrink-0 rounded-xl flex items-center justify-center transition-all disabled:opacity-40 hover:scale-[1.04] active:scale-95"
                style={{
                  background: isRecordingVoice ? 'rgba(239,68,68,0.14)' : 'hsl(var(--background) / 0.7)',
                  color: isRecordingVoice ? 'hsl(0, 72%, 55%)' : 'hsl(var(--muted-foreground))',
                  border: isRecordingVoice ? '1px solid rgba(239,68,68,0.32)' : '1px solid hsl(var(--border))',
                }}
                title={isRecordingVoice ? 'Stop voice recording' : 'Record voice note'}
                aria-label={isRecordingVoice ? 'Stop voice recording' : 'Record voice note'}
              >
                {isRecordingVoice ? <Square size={14} fill="currentColor" /> : <Mic size={15} />}
              </button>
            )}
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={isRecordingVoice ? 'Recording voice note...' : isStartingNewChat ? 'Starting a new chat...' : isLoading ? 'AI is thinking...' : 'Ask Rozare anything...'}
              disabled={isLoading || isStartingNewChat || isUploadingProductImage || isRecordingVoice}
              className="flex-1 bg-transparent text-sm outline-none min-w-0 placeholder:opacity-60"
              style={{ color: 'hsl(var(--foreground))' }}
            />
          </div>
          <button
            type="submit"
            disabled={isLoading || isStartingNewChat || isUploadingProductImage || isRecordingVoice || (!input.trim() && pendingProductImages.length === 0)}
            className="h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center transition-all disabled:opacity-40 hover:scale-[1.04] active:scale-95"
            style={{
              background: BRAND_GRADIENT,
              color: 'white',
              boxShadow: '0 6px 18px -4px rgba(14,165,233,0.5)',
            }}
            aria-label="Send message"
          >
            {(isLoading || isStartingNewChat) ? <Loader2 size={18} className="animate-spin" /> : <Send size={17} />}
          </button>
        </form>
        <p
          className="text-[10px] text-center mt-2 opacity-60"
          style={{ color: 'hsl(var(--muted-foreground))' }}
        >
          Powered by Rozare AI · Actions are role-secured
        </p>
      </div>
      <SafetyActionsDialog
        open={Boolean(reportingMessage)}
        onClose={() => setReportingMessage(null)}
        initialMode="report"
        report={reportingMessage ? {
          kind: 'ai_response',
          content: sanitizeAssistantContent(reportingMessage.content),
          ...((reportingMessage._id || reportingMessage.id) && activeConvoId
            ? { conversationId: activeConvoId, messageId: reportingMessage._id || reportingMessage.id }
            : {}),
        } : null}
      />
    </motion.div>
  );

  // ─── Embedded mode ───
  if (embedded) return chatWindow;

  // ─── Floating mode ───
  return (
    <>
      {/* Mobile backdrop when open */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsOpen(false)}
            className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-40 sm:hidden"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Chat panel: full-screen sheet on mobile, floating card on desktop */}
      <div
        className={`fixed z-50 ${
          isOpen
            ? 'inset-0 sm:inset-auto sm:bottom-5 sm:right-5'
            : 'bottom-4 right-4 sm:bottom-5 sm:right-5'
        }`}
      >
        <AnimatePresence>{isOpen && chatWindow}</AnimatePresence>

        {!isOpen && (
          <motion.button
            initial={{ scale: 0, rotate: -45 }}
            animate={{ scale: 1, rotate: 0 }}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            onClick={() => setIsOpen(true)}
            className="group relative h-14 w-14 sm:h-15 sm:w-15 rounded-full flex items-center justify-center"
            style={{
              background: BRAND_GRADIENT,
              color: 'white',
              boxShadow: '0 12px 32px -8px rgba(14,165,233,0.55), 0 0 0 1px rgba(255,255,255,0.15)',
            }}
            aria-label="Open Rozare AI chat"
          >
            {/* Pulse ring */}
            <span
              className="absolute inset-0 rounded-full animate-ping opacity-30"
              style={{ background: BRAND_GRADIENT }}
            />
            <MessageCircle size={24} className="relative" />
            {/* Sparkle badge */}
            <span
              className="absolute -top-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border-2 border-white"
              style={{ background: '#f59e0b' }}
            >
              <Sparkles size={9} className="text-white" />
            </span>
          </motion.button>
        )}
      </div>
    </>
  );
}

export default ChatBot;
