/**
 * ChatBot - Mobile AI Assistant
 * Role-aware with tool calling, rate limits, contextual chips, TTS, and embedded dashboard mode
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, FlatList, Modal,
  KeyboardAvoidingView, Platform, Alert, ActivityIndicator, ScrollView, Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Speech from 'expo-speech';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import api from '../config/api';
import { useAuth } from '../contexts/AuthContext';
import { useCurrency } from '../contexts/CurrencyContext';
import {
  spacing, fontSize, borderRadius, fontWeight,
} from '../styles/theme';
import { useTheme } from '../contexts/ThemeContext';

// Uses our own backend (no Supabase) - the /api/ai-chat/once endpoint handles
// non-streaming tool execution loop server-side and returns the final response.
const AI_CHAT_ONCE_URL = null; // Set dynamically from api.defaults.baseURL below

const sanitizeAssistantText = (text = '') => String(text || '')
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.startsWith('[Tool memory:')) return false;
    if (/^Action note:/i.test(trimmed)) return false;
    if (/^tool memory:/i.test(trimmed)) return false;
    return true;
  })
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const ROLE_CHIPS = {
  user: [
    { label: 'Find outfit', msg: "I'm looking for a new outfit, can you help me?" },
    { label: 'Track order', msg: 'Track my recent order' },
    { label: 'Style advice', msg: 'Give me some fashion advice for this season' },
    { label: 'Browse stores', msg: 'Show me popular stores' },
  ],
  seller: [
    { label: 'Analytics', msg: 'Show me my store analytics - revenue, orders, top products' },
    { label: 'Add product', msg: 'I want to add a new product to my store' },
    { label: 'Discount', msg: 'Help me apply a bulk discount to my products' },
    { label: 'Orders', msg: 'Show me my recent orders and their statuses' },
    { label: 'Growth tips', msg: 'Give me strategies to grow my store and increase sales' },
  ],
  admin: [
    { label: 'Users', msg: 'Show me a summary of all users on the platform' },
    { label: 'Stats', msg: 'Give me platform-wide analytics - users, revenue, orders' },
    { label: 'Complaints', msg: 'Show me all pending complaints' },
    { label: 'Verifications', msg: 'Show me pending store verifications' },
    { label: 'Tax config', msg: 'Show me the current tax configuration' },
  ],
};

const ROLE_GREETINGS = {
  user: (name, g) => name
    ? `${g}, ${name}! I'm your personal shopping stylist. I can help you find outfits, give style advice, track orders, and more!`
    : `${g}! I'm your personal shopping stylist. How can I help you today?`,
  seller: (name, g) => `${g}, ${name || 'Seller'}! I'm your business assistant. I can manage products, analyze performance, handle orders, and suggest growth strategies.`,
  admin: (name, g) => `${g}, ${name || 'Admin'}! I'm your platform command center. I can manage users, analytics, complaints, verifications, and more.`,
};

const ROLE_TITLES = {
  user: { title: 'AI Stylist', subtitle: 'Personal Shopping Assistant' },
  seller: { title: 'Business Assistant', subtitle: 'Store Management & Growth' },
  admin: { title: 'Platform Commander', subtitle: 'Full Admin Control' },
};

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const SUPPORTED_DOCUMENT_TYPES = [
  'image/*',
  'audio/*',
  'text/*',
  'application/json',
  'text/csv',
  'text/tab-separated-values',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

const inferMimeType = (name = '', fallback = 'application/octet-stream') => {
  const ext = String(name || '').split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', json: 'application/json',
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', '3gp': 'audio/3gpp',
  };
  return map[ext] || fallback;
};

const formatBytes = (bytes = 0) => {
  const value = Number(bytes || 0);
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const formatRecordingTime = (seconds = 0) => {
  const total = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
};

const buildAttachmentFromAsset = (asset = {}, fallbackType = 'file') => {
  const uri = asset.uri || asset.url || '';
  const name = asset.name || asset.fileName || asset.filename || `${fallbackType}-${Date.now()}`;
  const type = asset.mimeType || asset.type || inferMimeType(name, fallbackType === 'image' ? 'image/jpeg' : 'application/octet-stream');
  const id = `${name}-${asset.size || asset.fileSize || 0}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    uri,
    url: uri,
    name,
    type,
    mimeType: type,
    size: asset.size || asset.fileSize || 0,
    file: asset.file,
    previewUrl: type.startsWith('image/') ? uri : '',
  };
};

const getAttachmentDisplayType = (attachment = {}) => {
  const type = attachment.type || attachment.mimeType || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
};

const buildUploadPart = (attachment = {}) => {
  if (Platform.OS === 'web' && attachment.file) return attachment.file;
  const uri = attachment.uri || attachment.url || attachment.previewUrl;
  if (!uri) return null;
  const name = attachment.name || `attachment-${Date.now()}`;
  const type = attachment.mimeType || attachment.type || inferMimeType(name);
  return { uri, name, type };
};

// ─── Execute tool calls via backend API ───
const summarizeToolResultsForPrompt = (toolResults = []) => {
  const lines = [];
  for (const event of toolResults || []) {
    const result = event.result || {};
    const data = result.data || {};
    if (event.name === 'add_product' && result.success && data.productId) {
      lines.push(`[Tool memory: add_product succeeded. productId=${data.productId}; name="${data.name || ''}"; brand="${data.brand || ''}"; price=${data.price ?? ''}; tags=${JSON.stringify(data.tags || [])}; colors=${JSON.stringify(data.colors || [])}. Use this productId for follow-up edits; do not add it again unless explicitly asked for a duplicate.]`);
    } else if (event.name === 'edit_product' && result.success && (data._id || data.productId)) {
      lines.push(`[Tool memory: edit_product succeeded. productId=${data._id || data.productId}; name="${data.name || ''}".]`);
    } else if (event.name === 'feature_product' && result.success && (data.productId || data._id)) {
      lines.push(`[Tool memory: feature_product succeeded. productId=${data.productId || data._id}; name="${data.name || ''}"; isFeatured=${data.isFeatured === true}.]`);
    } else if (event.name === 'delete_product' && result.success && Array.isArray(data.deleted)) {
      lines.push(`[Tool memory: delete_product succeeded. Deleted products: ${data.deleted.map(p => `${p.productId || p._id}:${p.name}`).join(', ')}.]`);
    } else if (event.name === 'list_my_products' && result.success && Array.isArray(data.products)) {
      const products = data.products.slice(0, 10).map(p => `${p._id || p.productId}:${p.name}; brand=${p.brand || ''}; price=${p.price ?? ''}; stock=${p.stock ?? ''}; featured=${p.isFeatured === true}; createdAt=${p.createdAt || ''}`);
      lines.push(`[Tool memory: list_my_products returned ${data.total ?? data.products.length} products. Internal product lookup: ${products.join(' | ')}. Use these ids internally only; do not show or ask the seller for product IDs.]`);
    } else if (event.name === 'search_products' && result.success && Array.isArray(data.products)) {
      const products = data.products.slice(0, 12).map(p => `${p._id || p.productId}:${p.name}; store=${p.storeName || ''}; slug=${p.storeSlug || ''}; price=${p.discountedPrice || p.price || ''}; stock=${p.stock ?? ''}; colors=${JSON.stringify(p.colors || [])}; options=${JSON.stringify(p.optionGroups || [])}`);
      lines.push(`[Tool memory: search_products returned ${data.count ?? data.products.length} products. Internal product lookup for shopper follow-ups: ${products.join(' | ')}. Use these ids internally only; do not show raw product IDs.]`);
    } else if (event.name === 'get_product_detail' && result.success && data._id) {
      lines.push(`[Tool memory: get_product_detail productId=${data._id}; name="${data.name || ''}"; store="${data.storeName || ''}"; stock=${data.stock ?? ''}; colors=${JSON.stringify(data.colors || [])}; options=${JSON.stringify(data.optionGroups || [])}.]`);
    } else if (event.name === 'search_stores' && result.success && Array.isArray(data.stores)) {
      const stores = data.stores.slice(0, 8).map(s => `${s._id}:${s.storeName}; slug=${s.storeSlug || s.slug || ''}; matches=${(s.matchingProducts || []).map(p => p.name).join(', ')}`);
      lines.push(`[Tool memory: search_stores returned stores: ${stores.join(' | ')}. Use storeSlug/storeId internally when searching products from a chosen store.]`);
    } else if (event.name === 'add_product' && result.duplicate) {
      const existing = data.existingProduct || {};
      lines.push(`[Tool memory: add_product duplicate blocked. Existing productId=${existing.productId || ''}; name="${existing.name || ''}". Ask for explicit duplicate confirmation before creating another listing.]`);
    } else if (result.success === false) {
      lines.push(`[Tool memory: ${event.name} failed: ${result.error || result.message || 'unknown error'}. Do not claim it succeeded.]`);
    }
    if (lines.length >= 6) break;
  }
  return lines.join('\n');
};

async function executeToolCall(name, args) {
  const apiUrl = '';
  try {
    switch (name) {
      case 'search_products': {
        let url = `/api/ai-actions/search-products?`;
        if (args.query) url += `query=${encodeURIComponent(args.query)}&`;
        if (args.category) url += `category=${encodeURIComponent(args.category)}&`;
        if (args.maxPrice) url += `maxPrice=${args.maxPrice}&`;
        if (args.minPrice) url += `minPrice=${args.minPrice}&`;
        url += 'limit=5';
        const res = await api.get(url);
        return { products: res.data.products || [] };
      }
      case 'navigate': return { navigated: true, label: args.label, route: args.route };
      case 'show_style_advice': return { styleAdvice: args };
      case 'suggest_outfit': return { outfitSuggestion: args };
      case 'get_my_orders': {
        const res = await api.get(`/api/order/user-orders${args.status ? `?status=${args.status}` : ''}`);
        return { orders: (res.data.orders || []).slice(0, 5).map(o => ({ orderId: o.orderId, status: o.orderStatus, total: o.orderSummary?.totalAmount, date: o.createdAt })) };
      }
      case 'get_order_detail': { const res = await api.get(`/api/ai-actions/order-detail?orderId=${args.orderId}`); return res.data; }
      case 'cancel_order': { const res = await api.post('/api/ai-actions/cancel-order', { orderId: args.orderId }); return res.data; }
      case 'submit_complaint': { const res = await api.post('/api/chatbot/complaint', args); return res.data; }
      case 'get_my_complaints': { const res = await api.get('/api/chatbot/my-complaints'); return { complaints: (res.data.complaints || []).slice(0, 10).map(c => ({ subject: c.subject, category: c.category, status: c.status, date: c.createdAt })) }; }
      case 'add_product': { const res = await api.post('/api/ai-actions/add-product', { product: args }); return res.data; }
      case 'edit_product': { const res = await api.post('/api/ai-actions/edit-product', args); return res.data; }
      case 'delete_product': { const res = await api.post('/api/ai-actions/delete-product', args); return res.data; }
      case 'feature_product': { const res = await api.post('/api/ai-actions/feature-product', args); return res.data; }
      case 'list_my_products': {
        let url = '/api/ai-actions/my-products?';
        if (args.search) url += `search=${encodeURIComponent(args.search)}&`;
        if (args.category) url += `category=${encodeURIComponent(args.category)}&`;
        if (args.limit) url += `limit=${args.limit}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'bulk_discount': { const res = await api.post('/api/ai-actions/bulk-discount', args); return res.data; }
      case 'bulk_price_update': { const res = await api.post('/api/ai-actions/bulk-price-update', args); return res.data; }
      case 'remove_discount': { const res = await api.post('/api/ai-actions/remove-discount', args); return res.data; }
      case 'get_seller_analytics': { const res = await api.get('/api/ai-actions/seller-analytics'); return res.data; }
      case 'get_seller_orders': {
        let url = '/api/ai-actions/seller-orders?';
        if (args.status) url += `status=${args.status}&`;
        if (args.limit) url += `limit=${args.limit}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'update_order_status': { const res = await api.post('/api/ai-actions/update-order-status', args); return res.data; }
      case 'get_my_store': { const res = await api.get('/api/ai-actions/my-store'); return res.data; }
      case 'update_store': { const res = await api.post('/api/ai-actions/update-store', args); return res.data; }
      case 'get_store_analytics': { const res = await api.get('/api/ai-actions/store-analytics'); return res.data; }
      case 'apply_for_verification': { const res = await api.post('/api/ai-actions/apply-verification', {}); return res.data; }
      case 'get_shipping_methods': { const res = await api.get('/api/ai-actions/shipping-methods'); return res.data; }
      case 'update_shipping': { const res = await api.post('/api/ai-actions/update-shipping', args); return res.data; }
      case 'get_all_users': {
        let url = '/api/ai-actions/all-users?';
        if (args.search) url += `search=${encodeURIComponent(args.search)}&`;
        if (args.role) url += `role=${args.role}&`;
        if (args.limit) url += `limit=${args.limit}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'delete_user': { const res = await api.post('/api/ai-actions/delete-user', args); return res.data; }
      case 'block_user': { const res = await api.post('/api/ai-actions/block-user', args); return res.data; }
      case 'change_user_role': { const res = await api.post('/api/ai-actions/change-user-role', args); return res.data; }
      case 'get_admin_analytics': { const res = await api.get('/api/ai-actions/admin-analytics'); return res.data; }
      case 'get_all_orders': {
        let url = '/api/ai-actions/all-orders?';
        if (args.status) url += `status=${args.status}&`;
        if (args.limit) url += `limit=${args.limit}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'get_all_complaints': {
        let url = '/api/ai-actions/all-complaints?';
        if (args.category) url += `category=${args.category}&`;
        if (args.status) url += `status=${args.status}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'update_complaint': { const res = await api.post('/api/ai-actions/update-complaint', args); return res.data; }
      case 'get_pending_verifications': { const res = await api.get('/api/ai-actions/pending-verifications'); return res.data; }
      case 'approve_verification': { const res = await api.post('/api/ai-actions/approve-verification', args); return res.data; }
      case 'reject_verification': { const res = await api.post('/api/ai-actions/reject-verification', args); return res.data; }
      case 'remove_verification': { const res = await api.post('/api/ai-actions/remove-verification', args); return res.data; }
      case 'get_all_stores': { const res = await api.get(`/api/ai-actions/all-stores${args.limit ? `?limit=${args.limit}` : ''}`); return res.data; }
      case 'update_tax_config': { const res = await api.post('/api/ai-actions/update-tax', args); return res.data; }
      case 'get_tax_config': { const res = await api.get('/api/ai-actions/tax-config'); return res.data; }

      // ─── User-side parity ───
      case 'get_wishlist': { const res = await api.get('/api/ai-actions/wishlist'); return res.data; }
      case 'add_to_wishlist': { const res = await api.post('/api/ai-actions/add-to-wishlist', { productId: args.productId }); return res.data; }
      case 'remove_from_wishlist': { const res = await api.post('/api/ai-actions/remove-from-wishlist', { productId: args.productId }); return res.data; }
      case 'get_addresses': { const res = await api.get('/api/ai-actions/addresses'); return res.data; }
      case 'add_address': { const res = await api.post('/api/ai-actions/add-address', { address: args.address }); return res.data; }
      case 'update_profile': { const res = await api.post('/api/ai-actions/update-profile', { updates: args.updates }); return res.data; }
      case 'get_notifications': { const res = await api.get('/api/ai-actions/notifications'); return res.data; }
      case 'mark_notifications_read': { const res = await api.post('/api/ai-actions/mark-notifications-read', {}); return res.data; }
      case 'get_available_coupons': {
        let url = '/api/ai-actions/available-coupons?';
        if (args.storeId) url += `storeId=${args.storeId}&`;
        if (args.productId) url += `productId=${args.productId}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'validate_coupon': { const res = await api.post('/api/ai-actions/validate-coupon', { code: args.code, cartTotal: args.cartTotal }); return res.data; }
      case 'search_stores': {
        let url = '/api/ai-actions/search-stores?';
        if (args.query) url += `query=${encodeURIComponent(args.query)}&`;
        if (args.limit) url += `limit=${args.limit}`;
        const res = await api.get(url);
        return res.data;
      }
      case 'get_verified_stores': { const res = await api.get('/api/ai-actions/verified-stores'); return res.data; }
      case 'get_store_details': {
        let url = '/api/ai-actions/store-details?';
        if (args.storeId) url += `storeId=${args.storeId}&`;
        if (args.slug) url += `slug=${encodeURIComponent(args.slug)}`;
        const res = await api.get(url);
        return res.data;
      }

      // ─── Seller-side coupon parity ───
      case 'create_coupon': { const res = await api.post('/api/ai-actions/create-coupon', { coupon: args.coupon }); return res.data; }
      case 'get_my_coupons': { const res = await api.get('/api/ai-actions/my-coupons'); return res.data; }
      case 'update_coupon': { const res = await api.post('/api/ai-actions/update-coupon', args); return res.data; }
      case 'delete_coupon': { const res = await api.post('/api/ai-actions/delete-coupon', args); return res.data; }
      case 'toggle_coupon': { const res = await api.post('/api/ai-actions/toggle-coupon', args); return res.data; }
      case 'get_subscription_status': { const res = await api.get('/api/ai-actions/subscription-status'); return res.data; }

      // ─── Admin broadcast & subscriptions parity ───
      case 'send_broadcast': { const res = await api.post('/api/ai-actions/send-broadcast', args); return res.data; }
      case 'get_broadcasts': { const res = await api.get('/api/ai-actions/broadcasts'); return res.data; }
      case 'cancel_broadcast': { const res = await api.post('/api/ai-actions/cancel-broadcast', args); return res.data; }
      case 'get_all_subscriptions': { const res = await api.get('/api/ai-actions/all-subscriptions'); return res.data; }

      default: return {};
    }
  } catch (e) {
    return { error: e.response?.data?.msg || `Failed: ${name}` };
  }
}

// ─── Non-streaming AI call via our backend ───
// Uses /api/ai-chat/once which handles the tool execution loop server-side
// and returns the final response with tool results included.
async function callAI(messages, attachments = []) {
  const uploadAttachments = (Array.isArray(attachments) ? attachments : [])
    .map(buildUploadPart)
    .filter(Boolean);

  if (uploadAttachments.length) {
    const form = new FormData();
    form.append('messages', JSON.stringify(messages));
    uploadAttachments.forEach((part, index) => {
      if (Platform.OS === 'web' && typeof File !== 'undefined' && part instanceof File) {
        form.append('attachments', part, part.name || attachments[index]?.name || `attachment-${index + 1}`);
      } else {
        form.append('attachments', part);
      }
    });
    const resp = await api.post('/api/ai-chat/once', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return resp.data;
  }

  const resp = await api.post('/api/ai-chat/once', { messages });
  return resp.data;
}

// ─── Main Component ───
export default function ChatBot({ embedded = false, dashboardRole = null, visible = true, onClose, navigation }) {
  const { currentUser } = useAuth();
  const { palette } = useTheme();
  const { formatPrice } = useCurrency();
  const c = palette.colors;
  const styles = makeStyles(palette);
  const effectiveRole = dashboardRole || currentUser?.role || 'user';
  const roleInfo = ROLE_TITLES[effectiveRole] || ROLE_TITLES.user;

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [contextualChips, setContextualChips] = useState([]);
  const [rateLimit, setRateLimit] = useState({ used: 0, limit: -1, remaining: -1 });
  const [userContext, setUserContext] = useState(null);

  const audioRecorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder, 250);
  const flatListRef = useRef(null);

  const addPendingAttachments = useCallback((items = []) => {
    const nextItems = (Array.isArray(items) ? items : [items]).filter(item => item?.uri || item?.file);
    if (!nextItems.length) return;

    const accepted = [];
    const tooLarge = [];
    nextItems.forEach((item) => {
      if (item.size && item.size > MAX_ATTACHMENT_BYTES) tooLarge.push(item.name || 'Attachment');
      else accepted.push(item);
    });

    if (tooLarge.length) {
      Alert.alert('Attachment too large', `${tooLarge.slice(0, 3).join(', ')} is over 15MB. Please choose a smaller file.`);
    }

    if (!accepted.length) return;
    setPendingAttachments((prev) => {
      const available = Math.max(0, MAX_ATTACHMENTS - prev.length);
      const merged = [...prev, ...accepted.slice(0, available)];
      if (accepted.length > available) {
        Alert.alert('Attachment limit', `You can send up to ${MAX_ATTACHMENTS} files at once.`);
      }
      return merged;
    });
  }, []);

  const removePendingAttachment = useCallback((id) => {
    setPendingAttachments(prev => prev.filter(item => item.id !== id));
  }, []);

  const pickImages = useCallback(async () => {
    if (loading) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Please allow photo access to attach product images.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.85,
      });
      if (result.canceled) return;
      const attachments = (result.assets || []).map(asset => buildAttachmentFromAsset(asset, 'image'));
      addPendingAttachments(attachments);
    } catch (error) {
      Alert.alert('Image upload', error.message || 'Could not attach image.');
    }
  }, [addPendingAttachments, loading]);

  const pickFiles = useCallback(async () => {
    if (loading) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: SUPPORTED_DOCUMENT_TYPES,
        multiple: true,
        copyToCacheDirectory: true,
        base64: false,
      });
      if (result.canceled) return;
      const attachments = (result.assets || []).map(asset => buildAttachmentFromAsset(asset, 'file'));
      addPendingAttachments(attachments);
    } catch (error) {
      Alert.alert('File upload', error.message || 'Could not attach file.');
    }
  }, [addPendingAttachments, loading]);

  const stopVoiceRecording = useCallback(async () => {
    if (recordingBusy || !recorderState.isRecording) return;
    setRecordingBusy(true);
    try {
      await audioRecorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = audioRecorder.uri || audioRecorder.getStatus?.()?.url;
      if (!uri) {
        Alert.alert('Voice note', 'No voice audio was captured.');
        return;
      }
      const ext = String(uri).split('?')[0].split('.').pop()?.toLowerCase() || (Platform.OS === 'android' ? '3gp' : 'm4a');
      const name = `voice-note-${Date.now()}.${ext}`;
      addPendingAttachments([buildAttachmentFromAsset({
        uri,
        name,
        mimeType: inferMimeType(name, 'audio/mp4'),
        fileSize: 0,
      }, 'audio')]);
    } catch (error) {
      Alert.alert('Voice note', error.message || 'Could not stop recording.');
    } finally {
      setRecordingBusy(false);
    }
  }, [addPendingAttachments, audioRecorder, recorderState.isRecording, recordingBusy]);

  const startVoiceRecording = useCallback(async () => {
    if (loading || recordingBusy) return;
    if (recorderState.isRecording) {
      await stopVoiceRecording();
      return;
    }
    setRecordingBusy(true);
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Please allow microphone access to send voice notes.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
    } catch (error) {
      Alert.alert('Voice note', error.message || 'Could not start recording.');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    } finally {
      setRecordingBusy(false);
    }
  }, [audioRecorder, loading, recorderState.isRecording, recordingBusy, stopVoiceRecording]);

  // Rate limit
  const checkRateLimit = useCallback(async () => {
    try {
      const res = await api.get('/api/ai-actions/rate-limit');
      setRateLimit(res.data);
      return res.data;
    } catch { return { used: 0, limit: -1, remaining: -1 }; }
  }, []);

  const incrementRateLimit = useCallback(async () => {
    try {
      const res = await api.post('/api/ai-actions/rate-limit/increment');
      setRateLimit(res.data);
      return res.data;
    } catch (err) {
      if (err.response?.status === 429) {
        Alert.alert('Limit Reached', 'Daily message limit reached. Resets at midnight.');
        return null;
      }
      return { used: 0, limit: -1, remaining: -1 };
    }
  }, []);

  // Init
  useEffect(() => {
    if (visible && messages.length === 0) {
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      const name = currentUser?.username || currentUser?.name?.split(' ')[0] || '';
      const greetFn = ROLE_GREETINGS[effectiveRole] || ROLE_GREETINGS.user;
      setMessages([{ id: '0', role: 'assistant', content: greetFn(name, greeting) }]);
      setContextualChips(ROLE_CHIPS[effectiveRole] || ROLE_CHIPS.user);
    }
    if (visible) {
      checkRateLimit();
      if (currentUser && !userContext) fetchUserContext();
    }
  }, [visible, currentUser, effectiveRole]);

  const fetchUserContext = async () => {
    try {
      const res = await api.get('/api/chatbot/user-context');
      setUserContext(res.data);
    } catch {}
  };

  // TTS
  const speak = useCallback((text) => {
    if (!ttsEnabled) return;
    const clean = text.replace(/[*#_`~\[\]()>]/g, '').replace(/\n+/g, '. ').trim();
    if (!clean) return;
    Speech.speak(clean, { rate: 1.0, pitch: 1.0 });
  }, [ttsEnabled]);

  // Send
  const sendMessage = async (text, attachments = pendingAttachments) => {
    const attachmentsToSend = Array.isArray(attachments) ? attachments : [];
    const msgText = (text || input).trim();
    if ((!msgText && attachmentsToSend.length === 0) || loading || recorderState.isRecording) return;

    if (rateLimit.remaining === 0 && rateLimit.limit !== -1) {
      Alert.alert('Limit', !currentUser ? 'Please log in for more messages!' : 'Daily message limit reached.');
      return;
    }

    const rl = await incrementRateLimit();
    if (!rl) return;

    const visibleContent = msgText || (
      attachmentsToSend.length > 1
        ? `${attachmentsToSend.length} files attached`
        : `${getAttachmentDisplayType(attachmentsToSend[0]) === 'image' ? 'Image' : getAttachmentDisplayType(attachmentsToSend[0]) === 'audio' ? 'Voice note' : 'File'} attached`
    );
    const displayAttachments = attachmentsToSend.map(attachment => ({
      id: attachment.id,
      type: getAttachmentDisplayType(attachment),
      url: attachment.previewUrl || attachment.url || attachment.uri || '',
      name: attachment.name || 'Attachment',
      size: attachment.size || 0,
    }));
    const userMsg = {
      id: Date.now().toString(),
      role: 'user',
      content: visibleContent,
      ...(displayAttachments.length ? { attachments: displayAttachments } : {}),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setPendingAttachments([]);
    setLoading(true);

    const aiMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const toolMemory = summarizeToolResultsForPrompt(m.toolResults);
        return {
          role: m.role,
          content: toolMemory ? `${m.content}\n\n${toolMemory}` : m.content,
        };
      });
    aiMessages.push({ role: 'user', content: visibleContent });

    try {
      // The backend /api/ai-chat/once handles the ENTIRE tool execution loop
      // server-side and returns: { message, toolResults, clientActions, role }
      const response = await callAI(aiMessages, attachmentsToSend);
      const assistantContent = sanitizeAssistantText(response.message?.content || "Sorry, I couldn't process that.");
      const toolResults = (response.toolResults || []).map(tr => ({
        name: tr.tool,
        result: tr.result,
      }));
      const clientActions = response.clientActions || [];

      // Handle client-side actions (navigate, style advice, outfit suggestions)
      for (const ca of clientActions) {
        if (ca.action === 'navigate' && ca.args?.route) {
          if (navigation) {
            // Best-effort in-app navigation by route name match
            try {
              const route = String(ca.args.route).replace(/^\//, '');
              const map = {
                '': 'Home', 'home': 'Home', 'cart': 'Cart', 'wishlist': 'Wishlist',
                'orders': 'Orders', 'profile': 'Profile', 'settings': 'Settings',
                'notifications': 'Notifications', 'stores': 'Stores',
              };
              const target = map[route.toLowerCase()];
              if (target) navigation.navigate(target);
            } catch {}
          }
          toolResults.push({ name: 'navigate', result: { navigated: true, label: ca.args.label || ca.args.route } });
        } else if (ca.action === 'show_style_advice') {
          toolResults.push({ name: 'show_style_advice', result: { styleAdvice: ca.args } });
        } else if (ca.action === 'suggest_outfit') {
          toolResults.push({ name: 'suggest_outfit', result: { outfitSuggestion: ca.args } });
        }
      }

      // Update contextual chips based on tool results
      for (const tr of toolResults) {
        if (tr.name === 'search_products' && tr.result?.data?.products?.length > 0) {
          setContextualChips([
            { label: 'More like this', msg: `Show me more products similar to ${tr.result.data.products[0].name}` },
            { label: 'Cheaper options', msg: 'Show me cheaper alternatives' },
          ]);
        } else if (['get_seller_analytics', 'get_admin_analytics'].includes(tr.name)) {
          setContextualChips([
            { label: 'More details', msg: 'Give me a deeper breakdown of the analytics' },
            { label: 'Growth tips', msg: 'Based on this data, what should I do to grow?' },
          ]);
        }
      }

      const assistantMsg = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: assistantContent,
        toolResults,
      };
      setMessages(prev => [...prev, assistantMsg]);
      if (ttsEnabled && assistantContent) speak(assistantContent);
    } catch (err) {
      const errorMsg = err.message?.includes('Rate limit') ? 'Too many requests - please try again shortly!'
        : 'Sorry, please try again!';
      setMessages(prev => [...prev, { id: (Date.now() + 1).toString(), role: 'assistant', content: errorMsg }]);
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    api.delete('/api/chatbot/history').catch(() => {});
  };

  // ─── Render ───
  const renderAttachmentPreview = (attachment, compact = false) => {
    const type = getAttachmentDisplayType(attachment);
    if (type === 'image' && attachment.url) {
      return (
        <Image
          source={{ uri: attachment.url }}
          style={compact ? styles.pendingImage : styles.messageImage}
          resizeMode="cover"
        />
      );
    }
    return (
      <View style={compact ? styles.pendingFile : styles.messageFile}>
        <Ionicons
          name={type === 'audio' ? 'mic' : 'document-text-outline'}
          size={compact ? 16 : 18}
          color={compact ? c.primary : c.textSecondary}
        />
        <View style={{ flex: 1 }}>
          <Text style={compact ? styles.pendingFileName : styles.messageFileName} numberOfLines={1}>
            {attachment.name || (type === 'audio' ? 'Voice note' : 'Attached file')}
          </Text>
          {!!attachment.size && (
            <Text style={compact ? styles.pendingFileMeta : styles.messageFileMeta}>{formatBytes(attachment.size)}</Text>
          )}
        </View>
      </View>
    );
  };

  const renderMessage = ({ item }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.msgRow, isUser && styles.msgRowUser]}>
        {!isUser && (
          <View style={styles.botAvatar}>
            <Ionicons name="sparkles" size={12} color="#fff" />
          </View>
        )}
        <View style={[styles.msgBubble, isUser ? styles.userBubble : styles.botBubble]}>
          <Text style={[styles.msgText, isUser && { color: '#fff' }]}>{isUser ? item.content : sanitizeAssistantText(item.content)}</Text>
          {!!item.attachments?.length && (
            <View style={styles.messageAttachments}>
              {item.attachments.map((attachment, index) => (
                <View key={attachment.id || `${attachment.name || 'attachment'}-${index}`}>
                  {renderAttachmentPreview(attachment)}
                </View>
              ))}
            </View>
          )}
          {/* Tool results */}
          {item.toolResults?.map((tr, i) => (
            <View key={i}>
              {tr.name === 'search_products' && (tr.result?.data?.products || tr.result?.products)?.length > 0 && (
                <View style={styles.productResults}>
                  {(tr.result?.data?.products || tr.result?.products).map((p, pi) => (
                    <TouchableOpacity key={pi} style={styles.productItem}
                      onPress={() => navigation?.navigate('ProductDetail', { productId: p._id })}>
                      <View style={styles.productDot} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.productName} numberOfLines={1}>{p.name}</Text>
                        <Text style={styles.productPrice}>{formatPrice(p.discountedPrice || p.price || 0, { sourceCurrency: p.currency || p.priceCurrency || 'USD' })}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color={c.textLight} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {tr.name === 'send_product_image' && tr.result?.data?.imageUrl && (
                <View style={styles.productResults}>
                  <Image
                    source={{ uri: tr.result.data.imageUrl }}
                    style={{ width: '100%', height: 180, borderRadius: 12, backgroundColor: c.surfaceVariant }}
                    resizeMode="cover"
                  />
                  <Text style={[styles.productName, { marginTop: 8 }]} numberOfLines={1}>
                    {tr.result.data.caption || tr.result.data.name || 'Product image'}
                  </Text>
                </View>
              )}
              {tr.name === 'navigate' && tr.result.navigated && (
                <View style={styles.actionResult}>
                  <Ionicons name="arrow-forward-circle" size={14} color={c.primary} />
                  <Text style={styles.actionResultText}>Navigated to {tr.result.label}</Text>
                </View>
              )}
              {tr.name === 'show_style_advice' && tr.result.styleAdvice && (
                <View style={styles.styleCard}>
                  <View style={styles.styleCardHeader}>
                    <Ionicons name="color-palette" size={14} color={c.secondary} />
                    <Text style={styles.styleCardTitle}>Style Advice - {tr.result.styleAdvice.occasion}</Text>
                  </View>
                  <Text style={styles.styleCardText}>{tr.result.styleAdvice.advice}</Text>
                  {tr.result.styleAdvice.colorPalette?.length > 0 && (
                    <View style={styles.colorRow}>
                      {tr.result.styleAdvice.colorPalette.map((cl, ci) => (
                        <View key={ci} style={styles.colorSwatch}>
                          <View style={[styles.colorDot, { backgroundColor: cl.color }]} />
                          <Text style={styles.colorName}>{cl.name}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {tr.result.styleAdvice.tips?.map((tip, ti) => (
                    <View key={ti} style={styles.tipRow}>
                      <Ionicons name="sparkles" size={10} color={c.secondary} />
                      <Text style={styles.tipText}>{tip}</Text>
                    </View>
                  ))}
                </View>
              )}
              {tr.name === 'suggest_outfit' && tr.result.outfitSuggestion && (
                <View style={styles.styleCard}>
                  <View style={styles.styleCardHeader}>
                    <Ionicons name="shirt" size={14} color={c.secondary} />
                    <Text style={styles.styleCardTitle}>
                      Outfit - {tr.result.outfitSuggestion.occasion || 'Suggested'}
                    </Text>
                  </View>
                  {tr.result.outfitSuggestion.pieces?.map((pc, pi) => (
                    <View key={pi} style={styles.tipRow}>
                      <Ionicons name="ellipse" size={8} color={c.secondary} />
                      <Text style={styles.tipText}>
                        <Text style={{ fontWeight: '700' }}>{pc.type}: </Text>
                        {pc.description}
                      </Text>
                    </View>
                  ))}
                  {tr.result.outfitSuggestion.reasoning && (
                    <Text style={[styles.styleCardText, { marginTop: 8 }]}>
                      {tr.result.outfitSuggestion.reasoning}
                    </Text>
                  )}
                </View>
              )}
              {!['search_products', 'send_product_image', 'navigate', 'show_style_advice', 'suggest_outfit', 'get_my_orders', 'get_order_detail', 'get_my_complaints'].includes(tr.name) && (tr.result?.msg || tr.result?.message || tr.result?.error) && (
                <View style={[styles.actionResult, {
                  backgroundColor: tr.result?.success === false ? c.errorSubtle : c.successSubtle,
                  borderColor: tr.result?.success === false ? c.error : c.successLighter,
                }]}>
                  <Ionicons name={tr.result?.success === false ? 'alert-circle' : 'checkmark-circle'} size={14} color={tr.result?.success === false ? c.error : c.success} />
                  <Text style={[styles.actionResultText, { color: tr.result?.success === false ? c.error : c.success }]}>
                    {tr.result.msg || tr.result.message || tr.result.error}
                  </Text>
                </View>
              )}
            </View>
          ))}
        </View>
        {isUser && (
          <View style={styles.userAvatar}>
            <Ionicons name="person" size={12} color={c.textSecondary} />
          </View>
        )}
      </View>
    );
  };

  if (!visible) return null;

  const content = (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={embedded ? 0 : 90}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="sparkles" size={18} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>{roleInfo.title}</Text>
          <View style={styles.headerSubRow}>
            <Text style={styles.headerSubtitle}>{roleInfo.subtitle}</Text>
            {rateLimit.limit > 0 && (
              <View style={[styles.rateBadge, rateLimit.remaining <= 3 && { backgroundColor: c.errorSubtle }]}>
                <Text style={[styles.rateBadgeText, rateLimit.remaining <= 3 && { color: c.error }]}>{rateLimit.remaining} left</Text>
              </View>
            )}
          </View>
        </View>
        <TouchableOpacity onPress={() => setTtsEnabled(!ttsEnabled)} style={styles.headerBtn} accessibilityLabel="Toggle voice">
          <Ionicons name={ttsEnabled ? 'volume-high' : 'volume-mute'} size={16} color={ttsEnabled ? c.primary : c.textLight} />
        </TouchableOpacity>
        <TouchableOpacity onPress={clearChat} style={styles.headerBtn} accessibilityLabel="Clear chat">
          <Ionicons name="trash-outline" size={16} color={c.textLight} />
        </TouchableOpacity>
        {!embedded && onClose && (
          <TouchableOpacity onPress={onClose} style={styles.headerBtn} accessibilityLabel="Close">
            <Ionicons name="close" size={18} color={c.textLight} />
          </TouchableOpacity>
        )}
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
        showsVerticalScrollIndicator={false}
        ListFooterComponent={loading ? (
          <View style={styles.typingRow}>
            <View style={styles.botAvatar}><Ionicons name="sparkles" size={12} color="#fff" /></View>
            <View style={styles.typingBubble}>
              <ActivityIndicator size="small" color={c.primary} />
              <Text style={styles.typingText}>AI is thinking...</Text>
            </View>
          </View>
        ) : null}
      />

      {/* Contextual Chips */}
      {contextualChips.length > 0 && !loading && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsContainer}>
          {contextualChips.map((chip, i) => (
            <TouchableOpacity key={i} onPress={() => sendMessage(chip.msg)} style={styles.chip}>
              <Text style={styles.chipText}>{chip.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {!!pendingAttachments.length && (
        <View style={styles.pendingTray}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingList}>
            {pendingAttachments.map((attachment) => (
              <View key={attachment.id} style={styles.pendingItem}>
                {renderAttachmentPreview(attachment, true)}
                <TouchableOpacity
                  onPress={() => removePendingAttachment(attachment.id)}
                  style={styles.pendingRemove}
                  accessibilityLabel={`Remove ${attachment.name || 'attachment'}`}
                >
                  <Ionicons name="close" size={12} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {recorderState.isRecording && (
        <View style={styles.recordingBar}>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingText}>
            Recording voice note {formatRecordingTime(Math.floor((recorderState.durationMillis || 0) / 1000))}
          </Text>
          <TouchableOpacity onPress={stopVoiceRecording} disabled={recordingBusy} style={styles.stopRecordingBtn}>
            <Text style={styles.stopRecordingText}>Stop</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Input */}
      <View style={styles.inputContainer}>
        <TouchableOpacity
          onPress={pickImages}
          disabled={loading || recorderState.isRecording}
          style={[styles.composerBtn, (loading || recorderState.isRecording) && { opacity: 0.45 }]}
          accessibilityLabel="Attach product image"
        >
          <Ionicons name="image-outline" size={18} color={c.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={pickFiles}
          disabled={loading || recorderState.isRecording}
          style={[styles.composerBtn, (loading || recorderState.isRecording) && { opacity: 0.45 }]}
          accessibilityLabel="Attach product file"
        >
          <Ionicons name="attach" size={19} color={c.primary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={recorderState.isRecording ? stopVoiceRecording : startVoiceRecording}
          disabled={loading || recordingBusy}
          style={[
            styles.composerBtn,
            recorderState.isRecording && styles.recordingComposerBtn,
            (loading || recordingBusy) && { opacity: 0.45 },
          ]}
          accessibilityLabel={recorderState.isRecording ? 'Stop voice recording' : 'Record voice note'}
        >
          <Ionicons name={recorderState.isRecording ? 'stop' : 'mic-outline'} size={18} color={recorderState.isRecording ? '#fff' : c.primary} />
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={recorderState.isRecording ? 'Recording voice note...' : effectiveRole === 'seller' ? 'Ask your business assistant...' : effectiveRole === 'admin' ? 'Command the platform...' : 'Ask your stylist...'}
          placeholderTextColor={c.textLight}
          returnKeyType="send"
          onSubmitEditing={() => sendMessage()}
          editable={!loading && !recorderState.isRecording}
          multiline={false}
        />
        <TouchableOpacity
          onPress={() => sendMessage()}
          disabled={(!input.trim() && pendingAttachments.length === 0) || loading || recorderState.isRecording}
          style={[styles.sendBtn, ((!input.trim() && pendingAttachments.length === 0) || loading || recorderState.isRecording) && { opacity: 0.4 }]}
          accessibilityLabel="Send message"
        >
          <Ionicons name="send" size={16} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );

  // Embedded mode (in dashboard)
  if (embedded) {
    return <View style={styles.embeddedContainer}>{content}</View>;
  }

  // Floating modal mode
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>{content}</View>
      </View>
    </Modal>
  );
}

const makeStyles = (palette) => {
  const c = palette.colors;
  const g = palette.glass;
  return StyleSheet.create({
    // Embedded
    embeddedContainer: { flex: 1, borderRadius: borderRadius.xl, overflow: 'hidden', backgroundColor: c.surface },

    // Modal
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
    modalContent: { height: '85%', backgroundColor: c.surface, borderTopLeftRadius: borderRadius.xxl, borderTopRightRadius: borderRadius.xxl, overflow: 'hidden' },

    // Header
    header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, backgroundColor: c.primarySubtle },
    headerIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center', marginRight: spacing.sm },
    headerTitle: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: c.text },
    headerSubRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    headerSubtitle: { fontSize: 10, color: c.textSecondary },
    rateBadge: { backgroundColor: c.primarySubtle, paddingHorizontal: 6, paddingVertical: 1, borderRadius: borderRadius.full },
    rateBadgeText: { fontSize: 9, fontWeight: fontWeight.semibold, color: c.primary },
    headerBtn: { width: 32, height: 32, borderRadius: 10, backgroundColor: g.bgSubtle, justifyContent: 'center', alignItems: 'center', marginLeft: spacing.xs },

    // Messages
    messageList: { padding: spacing.md, paddingBottom: spacing.lg },
    msgRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: spacing.sm, gap: spacing.xs },
    msgRowUser: { justifyContent: 'flex-end' },
    botAvatar: { width: 24, height: 24, borderRadius: 8, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
    userAvatar: { width: 24, height: 24, borderRadius: 8, backgroundColor: g.bgSubtle, justifyContent: 'center', alignItems: 'center' },
    msgBubble: { maxWidth: '78%', borderRadius: borderRadius.xl, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2 },
    userBubble: { backgroundColor: c.primary, borderBottomRightRadius: borderRadius.xs },
    botBubble: { backgroundColor: g.bgSubtle, borderBottomLeftRadius: borderRadius.xs, borderWidth: 1, borderColor: g.borderSubtle },
    msgText: { fontSize: fontSize.sm, lineHeight: 20, color: c.text },
    messageAttachments: { marginTop: spacing.sm, gap: spacing.xs },
    messageImage: { width: 190, height: 150, borderRadius: borderRadius.lg, backgroundColor: c.surfaceVariant },
    messageFile: { minWidth: 170, maxWidth: 220, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, padding: spacing.sm, borderRadius: borderRadius.md, backgroundColor: 'rgba(255,255,255,0.22)' },
    messageFileName: { fontSize: 11, fontWeight: fontWeight.semibold, color: c.text },
    messageFileMeta: { fontSize: 9, color: c.textLight, marginTop: 1 },

    // Tool results
    productResults: { marginTop: spacing.sm, gap: spacing.xs },
    productItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: borderRadius.md, backgroundColor: g.bgSubtle },
    productDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary },
    productName: { fontSize: 11, fontWeight: fontWeight.medium, color: c.text },
    productPrice: { fontSize: 10, fontWeight: fontWeight.semibold, color: c.primary },
    actionResult: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs, padding: spacing.sm, borderRadius: borderRadius.md, backgroundColor: c.primarySubtle, borderWidth: 1, borderColor: c.primaryLighter },
    actionResultText: { fontSize: 11, fontWeight: fontWeight.medium, color: c.primary },

    // Style card
    styleCard: { marginTop: spacing.sm, borderRadius: borderRadius.lg, overflow: 'hidden', backgroundColor: c.secondarySubtle, borderWidth: 1, borderColor: c.secondaryLighter },
    styleCardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, padding: spacing.sm, backgroundColor: c.secondarySubtle },
    styleCardTitle: { fontSize: 11, fontWeight: fontWeight.semibold, color: c.text },
    styleCardText: { fontSize: 11, color: c.text, padding: spacing.sm, lineHeight: 18 },
    colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
    colorSwatch: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    colorDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: c.border },
    colorName: { fontSize: 9, color: c.textSecondary },
    tipRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, paddingHorizontal: spacing.sm, paddingBottom: 4 },
    tipText: { fontSize: 10, color: c.textSecondary, flex: 1 },

    // Typing
    typingRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs, marginBottom: spacing.sm },
    typingBubble: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: borderRadius.xl, backgroundColor: g.bgSubtle },
    typingText: { fontSize: 11, color: c.textSecondary },

    // Chips
    chipsContainer: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.xs },
    chip: { backgroundColor: c.primarySubtle, borderWidth: 1, borderColor: c.primaryLighter, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: borderRadius.full },
    chipText: { fontSize: 11, fontWeight: fontWeight.medium, color: c.primary },
    pendingTray: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, backgroundColor: c.surface },
    pendingList: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, gap: spacing.sm },
    pendingItem: { position: 'relative' },
    pendingImage: { width: 56, height: 56, borderRadius: borderRadius.md, backgroundColor: c.surfaceVariant },
    pendingFile: { width: 150, height: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: borderRadius.md, backgroundColor: c.primarySubtle, borderWidth: 1, borderColor: c.primaryLighter },
    pendingFileName: { fontSize: 10, fontWeight: fontWeight.semibold, color: c.text },
    pendingFileMeta: { fontSize: 8, color: c.textSecondary, marginTop: 1 },
    pendingRemove: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: c.error, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.surface },
    recordingBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, backgroundColor: c.errorSubtle },
    recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.error },
    recordingText: { flex: 1, fontSize: 11, fontWeight: fontWeight.medium, color: c.error },
    stopRecordingBtn: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: borderRadius.full, backgroundColor: c.error },
    stopRecordingText: { fontSize: 10, fontWeight: fontWeight.bold, color: '#fff' },

    // Input
    inputContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, gap: spacing.sm, backgroundColor: c.surface },
    composerBtn: { width: 34, height: 34, borderRadius: 11, backgroundColor: c.primarySubtle, borderWidth: 1, borderColor: c.primaryLighter, justifyContent: 'center', alignItems: 'center' },
    recordingComposerBtn: { backgroundColor: c.error, borderColor: c.error },
    input: { flex: 1, backgroundColor: g.bgSubtle, borderRadius: borderRadius.lg, paddingHorizontal: spacing.md, paddingVertical: Platform.OS === 'ios' ? spacing.sm + 2 : spacing.sm, fontSize: fontSize.sm, color: c.text, borderWidth: 1, borderColor: g.borderSubtle },
    sendBtn: { width: 36, height: 36, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
  });
};
