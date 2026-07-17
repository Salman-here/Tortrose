/**
 * AI Action Executor — Server-Side Tool Execution
 * ─────────────────────────────────────────────────
 * Executes AI tool calls directly on the server using Mongoose models.
 * This allows the AI chat controller to run a tool-execution loop:
 *   1. AI decides to call a tool
 *   2. This service executes it (no round-trip to frontend)
 *   3. Result is fed back to the AI for a natural language response
 *
 * Security: Role validation is done in the chat controller BEFORE calling
 * this service (via ALLOWED_TOOLS_BY_ROLE). This service trusts the caller.
 */

'use strict';

const mongoose = require('mongoose');
const Fuse = require('fuse.js');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const Coupon = require('../models/Coupon');
const Complaint = require('../models/Complaint');
const ShippingMethod = require('../models/ShippingMethod');
const Notification = require('../models/Notification');
const TaxConfig = require('../models/TaxConfig');
const BroadcastJob = require('../models/BroadcastJob');
const SellerSubscription = require('../models/SellerSubscription');
const SellerAdRequest = require('../models/SellerAdRequest');
const StoreTrust = require('../models/StoreTrust');
const Cart = require('../models/Cart');
const StoreReview = require('../models/StoreReview');
const WhatsAppConfig = require('../models/WhatsAppConfig');
const { buildSellerPaymentSummary } = require('../controllers/PaymentController');
const { sendEmail } = require('../controllers/mailController');
const { buyerOrderConfirmationRequestEmail, newOrderSellerEmail } = require('../utils/emailTemplates');
const { generateConfirmationToken } = require('../controllers/orderConfirmationController');
const { enqueueOrderConfirmation } = require('./whatsapp/queue');
const { notifySeller } = require('./whatsapp/sellerNotificationService');
const { configKeyFor } = require('./whatsapp/gatewayMode');
const sellerTemplates = require('./whatsapp/sellerMessageTemplates');
const {
  buildModerationFields,
  isProductBlocked,
  notifyProductBlocked,
  publicProductFilter,
} = require('./productModerationService');
const { normalizeCurrency, convertAmount, convertAmountSync, formatMoney } = require('./currencyService');
const {
  roundMoney,
  getProductCurrency,
  getProductEffectivePrice,
} = require('./productPricingService');
const { normalizeSocialLinks } = require('./socialLinksService');
const { assertProductCreationAllowed } = require('./storeProductCurrencyService');
const {
  sanitizeProductName,
  sanitizeProductDescription,
} = require('./productTextService');
const {
  activeStoreQuery,
  applyActiveSellerProductFilter,
  getActiveSellerIds,
  isProductSellerPubliclyActive,
} = require('./publicCatalogService');
const { storeAllowsCashOnDelivery } = require('./storePaymentPolicyService');
const { normalizeReturnPolicy, normalizeProductReturnPolicy } = require('./returnPolicyService');
const {
  ensureOrderSellerFulfillment,
  getBuyerCancellationBlock,
  getSellerFulfillment,
  setAllSellerFulfillmentStatus,
  setSellerFulfillmentStatus,
  syncAggregateDeliveryState,
} = require('./orderFulfillmentService');

// ─── Client-side tools: rendered by frontend, not executed here ───
const CLIENT_SIDE_TOOLS = new Set([
  'navigate',
  'show_style_advice',
  'suggest_outfit',
]);
const DEFAULT_PRODUCT_IMAGE_URL = 'https://rozare.com/favicon-512.png';
const META_ADS_ADDON_CENTS = 400;
const AD_PRODUCT_SELECT = 'name image images category price discountedPrice currency priceCurrency isFeatured seller';

function isClientSideTool(name) {
  return CLIENT_SIDE_TOOLS.has(name);
}

// ─── Helpers ───
function toId(v) {
  if (!v) return null;
  if (typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)) return v;
  return null;
}

function safeLimit(v, def = 10, max = 50) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

function safePage(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function isTruthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

const STORE_CHANGE_COOLDOWN_DAYS = { storeName: 7, storeSlug: 30, sellerType: 30 };
const STORE_FIELD_LABELS = { storeName: 'store name', storeSlug: 'subdomain', sellerType: 'store type' };
const RESERVED_SUBDOMAINS = new Set(['www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog', 'docs', 'help', 'cdn', 'static', 'support']);

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cooldownStatus(field, lastAt) {
  const cooldownDays = STORE_CHANGE_COOLDOWN_DAYS[field];
  if (!cooldownDays) return { canChange: true, cooldownDays };
  if (!lastAt) return { canChange: true, cooldownDays, lastChangedAt: null, nextAllowedAt: null, daysRemaining: 0 };

  const lastChangedAt = new Date(lastAt);
  const nextAllowedAt = new Date(lastChangedAt.getTime() + cooldownDays * 86400000);
  const now = new Date();
  if (now >= nextAllowedAt) {
    return {
      canChange: true,
      cooldownDays,
      lastChangedAt: lastChangedAt.toISOString(),
      nextAllowedAt: nextAllowedAt.toISOString(),
      daysRemaining: 0,
    };
  }

  return {
    canChange: false,
    cooldownDays,
    lastChangedAt: lastChangedAt.toISOString(),
    nextAllowedAt: nextAllowedAt.toISOString(),
    daysRemaining: Math.max(1, Math.ceil((nextAllowedAt - now) / 86400000)),
  };
}

function storeChangeLimits(store) {
  return {
    storeName: cooldownStatus('storeName', store?.lastNameChangeAt),
    subdomain: cooldownStatus('storeSlug', store?.lastSlugChangeAt),
    sellerType: cooldownStatus('sellerType', store?.lastTypeChangeAt),
  };
}

function sanitizeSubdomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.rozare\.com$/i, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isPlaceholderValue(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return false;
  return [
    'your new store name',
    'new store name',
    'store name',
    'your store name',
    'your new subdomain',
    'new subdomain',
    'subdomain',
    'your-new-store-name',
    'new-store-name',
    'your-new-subdomain',
    'new-subdomain',
    'example',
    'example-store',
  ].includes(v);
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function cleanAIText(value, options = {}) {
  const { singleLine = false, maxLength = 5000 } = options;
  let text = cleanString(value);
  if (!text) return '';

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[*_`]+/g, '')
    .replace(/^[\s#>~.-]+/, '')
    .trim();

  const leadingLabel = /^(?:product\s*name|product\s*title|name|title|brand|category|store\s*name|store\s*description|description|about\s*us|price|stock)\s*[:\-\u2013\u2014]\s*/i;
  for (let i = 0; i < 3 && leadingLabel.test(text); i += 1) {
    text = text.replace(leadingLabel, '').trim();
  }

  // Drop generated heading fragments such as "Adi Beauty Store - About Us" before the real copy.
  text = text.replace(/^[A-Za-z0-9][A-Za-z0-9 '&.,]{1,80}\s[-\u2013\u2014]\sAbout Us\s+/i, '').trim();

  if (singleLine) {
    text = text.replace(/\s+/g, ' ');
  } else {
    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ');
  }

  text = text.replace(/^[:\-\u2013\u2014\s]+/, '').trim();
  return maxLength ? text.slice(0, maxLength).trim() : text;
}

function cleanAIField(value, options = {}) {
  return cleanAIText(value, { ...options, singleLine: true, maxLength: options.maxLength || 160 });
}

function cleanAIParagraph(value, options = {}) {
  return cleanAIText(value, { ...options, singleLine: false, maxLength: options.maxLength || 5000 });
}

function inferCurrencyFromText(value, fallbackCurrency = 'USD') {
  const raw = String(value ?? '').trim();
  const upper = raw.toUpperCase();
  if (/\b(PKR|PKR\.|RS|RS\.|RUPEES?|PAKISTANI\s+RUPEES?)\b/.test(upper)) return 'PKR';
  if (/\b(USD|US\$|DOLLARS?|US\s+DOLLARS?)\b/.test(upper) || /\$/.test(raw)) return 'USD';
  if (/\b(EUR|EUROS?)\b/.test(upper) || /€/.test(raw)) return 'EUR';
  if (/\b(GBP|POUNDS?|BRITISH\s+POUNDS?)\b/.test(upper) || /£/.test(raw)) return 'GBP';
  return normalizeCurrency(fallbackCurrency);
}

function detectExplicitCurrencyInText(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/\b(PKR|PKR\.|RS|RS\.|RUPEES?|PAKISTANI\s+RUPEES?)\b/.test(upper)) return 'PKR';
  if (/\b(USD|US\$|DOLLARS?|US\s+DOLLARS?)\b/.test(upper) || /\$/.test(raw)) return 'USD';
  if (/\b(EUR|EUROS?)\b/.test(upper) || /\u20ac/.test(raw)) return 'EUR';
  if (/\b(GBP|POUNDS?|BRITISH\s+POUNDS?)\b/.test(upper) || /\u00a3/.test(raw)) return 'GBP';
  return null;
}

function resolveAIPriceCurrency({
  value,
  requestedCurrency,
  preferredCurrency = 'USD',
  lastUserText = '',
  fallbackCurrency = null,
} = {}) {
  const valueCurrency = detectExplicitCurrencyInText(value);
  if (valueCurrency) return valueCurrency;

  const explicitUserCurrency = detectExplicitCurrencyInText(lastUserText);
  if (explicitUserCurrency) return explicitUserCurrency;

  const preferred = normalizeCurrency(fallbackCurrency || preferredCurrency);
  if (!requestedCurrency) return preferred;

  const requestedAlias = detectExplicitCurrencyInText(requestedCurrency);
  if (requestedAlias && !(requestedAlias === 'USD' && preferred !== 'USD')) return requestedAlias;

  const requested = normalizeCurrency(requestedCurrency);
  const rawRequested = String(requestedCurrency || '').trim();

  // Models can emit USD by habit for plain numbers. Keep the seller's currency
  // unless USD was actually stated or USD is already the seller preference.
  if (requested === 'USD' && preferred !== 'USD') return preferred;

  if (rawRequested && requested) return requested;
  return preferred;
}

function parseMoneyInput(value, fallbackCurrency = 'USD') {
  const currency = inferCurrencyFromText(value, fallbackCurrency);
  if (typeof value === 'number') return { amount: value, currency };
  const raw = String(value ?? '').replace(/,/g, '');
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return {
    amount: match ? Number(match[0]) : Number(value),
    currency,
  };
}

async function formatMoneyWithCode(amount, currency) {
  const normalizedCurrency = normalizeCurrency(currency);
  const formatted = await formatMoney(amount, normalizedCurrency, { sourceCurrency: normalizedCurrency });
  return formatted.includes(normalizedCurrency) ? formatted : `${formatted} ${normalizedCurrency}`;
}

async function buildProductCurrencyConversionNotice({
  sourceAmount,
  sourceCurrency,
  savedAmount,
  productCurrency,
} = {}) {
  const fromCurrency = normalizeCurrency(sourceCurrency);
  const toCurrency = normalizeCurrency(productCurrency);
  if (fromCurrency === toCurrency) return '';

  const sourceText = await formatMoneyWithCode(sourceAmount, fromCurrency);
  const savedText = await formatMoneyWithCode(savedAmount, toCurrency);
  return `Your selected product currency is ${toCurrency}, so I can't save this product in ${fromCurrency}. I converted ${sourceText} to ${savedText} and saved that as the product price. `;
}

const COMMON_COLOR_WORDS = new Set([
  'black', 'white', 'red', 'yellow', 'blue', 'green', 'orange', 'purple',
  'pink', 'brown', 'gray', 'grey', 'silver', 'gold', 'golden', 'navy',
  'maroon', 'beige', 'cream', 'ivory', 'teal', 'cyan', 'magenta', 'violet',
  'indigo', 'lime', 'olive', 'tan', 'coral', 'turquoise',
]);
const COLOR_SHADE_WORDS = new Set(['light', 'dark', 'navy', 'baby', 'sky', 'royal', 'hot', 'forest']);

function splitDelimitedString(value, { splitSpacesForColors = false } = {}) {
  const raw = cleanString(value);
  if (!raw) return [];
  if (/[,\n;|/]/.test(raw)) {
    return raw.split(/[,\n;|/]+/).map(cleanString).filter(Boolean);
  }
  if (splitSpacesForColors) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every(w => COMMON_COLOR_WORDS.has(w.toLowerCase()))) {
      if (words.length === 2 && COLOR_SHADE_WORDS.has(words[0].toLowerCase())) return [raw];
      return words;
    }
  }
  return [raw];
}

function normalizeStringArray(value, options = {}) {
  const values = Array.isArray(value) ? value.flatMap(v => splitDelimitedString(v, options)) : splitDelimitedString(value, options);
  const seen = new Set();
  return values
    .map(v => cleanAIField(v, { maxLength: 50 }).replace(/^#/, ''))
    .filter(v => v && v.length <= 50)
    .filter(v => {
      const key = v.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeTags(value, fallbackSource = {}) {
  const provided = normalizeStringArray(value);
  if (provided.length) return provided.slice(0, 12);

  const seed = [
    fallbackSource.brand,
    fallbackSource.category,
    fallbackSource.name,
    fallbackSource.description,
    ...(fallbackSource.colors || []),
  ].filter(Boolean).join(' ');
  const words = seed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && w.length <= 24);
  const blocked = new Set(['this', 'that', 'with', 'from', 'best', 'your', 'product', 'available']);
  const tags = [];
  for (const word of words) {
    if (blocked.has(word) || tags.includes(word)) continue;
    tags.push(word);
    if (tags.length >= 8) break;
  }
  if (/\bkid|child|toy|play\b/i.test(seed) && !tags.includes('kids')) tags.push('kids');
  return tags.slice(0, 12);
}

function normalizeImageList(value) {
  const candidates = [];
  const add = (entry) => {
    if (!entry) return;
    if (typeof entry === 'string') {
      const urls = entry.match(/https?:\/\/\S+/g);
      if (urls?.length) candidates.push(...urls);
      else candidates.push(...splitDelimitedString(entry));
      return;
    }
    if (typeof entry === 'object') {
      add(entry.url || entry.image || entry.imageUrl || entry.src);
    }
  };
  if (Array.isArray(value)) value.forEach(add);
  else add(value);

  const seen = new Set();
  return candidates
    .map(cleanString)
    .filter(url => /^https?:\/\//i.test(url))
    .filter(url => {
      const key = url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(url => ({ url }));
}

function normalizeOptionGroups(value) {
  const rawGroups = Array.isArray(value)
    ? value
    : (value && typeof value === 'object'
      ? Object.entries(value).map(([name, values]) => ({ name, values }))
      : []);

  const seen = new Set();
  return rawGroups.map(group => {
    const name = cleanAIField(group?.name, { maxLength: 80 });
    const values = normalizeStringArray(group?.values);
    if (!name || values.length === 0) return null;
    const key = name.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    const defaultValue = cleanString(group?.default);
    return {
      name,
      values,
      default: values.includes(defaultValue) ? defaultValue : values[0],
    };
  }).filter(Boolean);
}

function addColorOptionGroup(optionGroups, colors) {
  if (!colors.length) return optionGroups;
  const hasColorGroup = optionGroups.some(group => group.name.toLowerCase() === 'color');
  if (hasColorGroup) return optionGroups;
  return [
    ...optionGroups,
    { name: 'Color', values: colors, default: colors[0] },
  ];
}

function buildProductImageFields(productInput) {
  const primaryImages = normalizeImageList(productInput.image || productInput.imageUrl);
  const primaryImage = primaryImages[0]?.url || '';
  const normalizedImages = normalizeImageList(productInput.images || productInput.imageUrls);
  const allImages = normalizeImageList([
    ...primaryImages,
    ...normalizedImages,
  ]);
  return {
    image: primaryImage || allImages[0]?.url || DEFAULT_PRODUCT_IMAGE_URL,
    images: allImages,
  };
}

const FEATURED_LIMITS = { free_trial: 6, starter: 6, elite: 12 };
const TRIAL_PRODUCT_LIMIT = 15;

async function sellerCanCreateProducts(userId, requestedCount = 1) {
  try {
    const sub = await SellerSubscription.findOne({ seller: userId }).select('status').lean();
    if (!sub || sub.status !== 'trial') {
      return { allowed: true, current: 0, max: null, remaining: null };
    }

    const current = await Product.countDocuments({ seller: userId });
    const remaining = Math.max(0, TRIAL_PRODUCT_LIMIT - current);
    return {
      allowed: requestedCount <= remaining,
      current,
      max: TRIAL_PRODUCT_LIMIT,
      remaining,
      reason: requestedCount <= remaining ? null : 'trial_limit_reached',
    };
  } catch (e) {
    console.error('sellerCanCreateProducts error:', e);
    return { allowed: false, current: 0, max: TRIAL_PRODUCT_LIMIT, remaining: 0, reason: 'error' };
  }
}

async function sellerCanFeatureProduct(userId, excludeProductId = null) {
  try {
    const sub = await SellerSubscription.findOne({ seller: userId }).lean();
    let plan = 'free_trial';
    let entitled = false;

    if (!sub) {
      entitled = true;
    } else if (sub.status === 'trial') {
      plan = 'free_trial';
      entitled = true;
    } else if (sub.plan === 'elite' && ['active', 'free_period'].includes(sub.status)) {
      plan = 'elite';
      entitled = true;
    } else if (['active', 'free_period'].includes(sub.status)) {
      plan = sub.plan || 'starter';
      entitled = true;
    } else if (sub.bonusFeaturesActive && (!sub.bonusExpiryDate || new Date() < sub.bonusExpiryDate)) {
      plan = sub.plan || 'starter';
      entitled = true;
    } else {
      plan = sub.plan || 'free_trial';
    }

    if (!entitled) return { allowed: false, current: 0, max: 0, plan, reason: 'not_entitled' };

    const max = FEATURED_LIMITS[plan] || FEATURED_LIMITS.free_trial;
    const query = { seller: userId, isFeatured: true };
    const safeExcludeId = toId(excludeProductId);
    if (safeExcludeId) query._id = { $ne: safeExcludeId };
    const current = await Product.countDocuments(query);

    if (current >= max) return { allowed: false, current, max, plan, reason: 'limit_reached' };
    return { allowed: true, current, max, plan };
  } catch (e) {
    console.error('sellerCanFeatureProduct error:', e);
    return { allowed: false, current: 0, max: 0, plan: 'free_trial', reason: 'error' };
  }
}

function isEliteSubscription(sub) {
  return sub?.plan === 'elite' && ['active', 'free_period'].includes(sub?.status);
}

function cleanAdProductIds(productIds = []) {
  const source = Array.isArray(productIds) ? productIds : [productIds];
  return [...new Set(source
    .map(normalizeObjectIdString)
    .filter(id => mongoose.Types.ObjectId.isValid(id)))];
}

function normalizeLookupText(value) {
  return cleanAIField(value, { maxLength: 180 }).toLowerCase();
}

function serializeAdRequest(request) {
  if (!request) return null;
  const doc = request.toObject ? request.toObject() : request;
  return {
    _id: normalizeObjectIdString(doc._id),
    requestType: doc.requestType,
    status: doc.status,
    active: Boolean(doc.active),
    channels: doc.channels || { tiktok: true, meta: false },
    sellerNote: doc.sellerNote || '',
    adminNote: doc.adminNote || '',
    createdAt: doc.createdAt,
    reviewedAt: doc.reviewedAt,
    products: (doc.products || []).map(product => ({
      _id: normalizeObjectIdString(product?._id || product),
      name: product?.name || '',
      category: product?.category || '',
      image: product?.image || product?.images?.[0]?.url || '',
    })).filter(product => product._id),
  };
}

async function getSellerAdsState(userId) {
  const [subscription, store, featuredProducts, activeRequest, pendingRequests, recentRequests] = await Promise.all([
    SellerSubscription.findOne({ seller: userId }).lean(),
    Store.findOne({ seller: userId }).select('_id storeName storeSlug logo').lean(),
    Product.find({
      seller: userId,
      isFeatured: true,
      isBlocked: { $ne: true },
      moderationStatus: { $ne: 'blocked' },
    })
      .select(AD_PRODUCT_SELECT)
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(),
    SellerAdRequest.findOne({ seller: userId, status: 'approved', active: true })
      .populate('products', AD_PRODUCT_SELECT)
      .sort({ updatedAt: -1 })
      .lean(),
    SellerAdRequest.find({ seller: userId, status: 'pending' })
      .populate('products', AD_PRODUCT_SELECT)
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
    SellerAdRequest.find({ seller: userId })
      .populate('products', AD_PRODUCT_SELECT)
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  return {
    subscription: {
      plan: subscription?.plan || 'free_trial',
      status: subscription?.status || 'trial',
      planName: subscription?.planName || 'Free Trial',
      metaAdsIncluded: Boolean(subscription?.metaAdsIncluded),
    },
    isElite: isEliteSubscription(subscription),
    metaAdsAddonCents: META_ADS_ADDON_CENTS,
    store,
    featuredProducts: featuredProducts.map(product => ({
      _id: normalizeObjectIdString(product._id),
      name: product.name,
      category: product.category,
      image: product.image || product.images?.[0]?.url || '',
      price: product.price,
      discountedPrice: product.discountedPrice,
      currency: getProductCurrency(product),
    })),
    activeRequest: serializeAdRequest(activeRequest),
    pendingRequests: pendingRequests.map(serializeAdRequest),
    recentRequests: recentRequests.map(serializeAdRequest),
  };
}

function resolveAdProductIdsFromState(args, state) {
  let productIds = cleanAdProductIds([
    ...(Array.isArray(args.productIds) ? args.productIds : []),
    ...(args.productId ? [args.productId] : []),
  ]);
  const featuredById = new Map(state.featuredProducts.map(product => [product._id, product]));
  productIds = productIds.filter(id => featuredById.has(id));

  const names = [
    ...(Array.isArray(args.productNames) ? args.productNames : []),
    ...(args.productName ? [args.productName] : []),
  ].map(normalizeLookupText).filter(Boolean);

  if (names.length) {
    for (const name of names) {
      const exact = state.featuredProducts.find(product => normalizeLookupText(product.name) === name);
      const loose = exact || state.featuredProducts.find(product => {
        const productName = normalizeLookupText(product.name);
        return productName.includes(name) || name.includes(productName);
      });
      if (loose) productIds.push(loose._id);
    }
  }

  if (!productIds.length && (args.selectAllFeatured === true || names.length === 0)) {
    productIds = state.featuredProducts.map(product => product._id);
  }

  return [...new Set(productIds)].filter(id => featuredById.has(id));
}

function productLookupBaseFilter(role, userId, args = {}) {
  const filter = role === 'admin' ? {} : { seller: userId };
  const targetSellerId = role === 'admin' ? toId(args.sellerId || args.seller) : null;
  if (targetSellerId) filter.seller = targetSellerId;
  return filter;
}

async function resolveProductCandidates({ role, userId, args = {}, productId, productIds, productName, productNames, excludeProductId, keepProductId }) {
  const filter = productLookupBaseFilter(role, userId, args);
  const productCandidateSelect = 'name brand price stock category isFeatured isBlocked blockedReason moderationStatus moderationReason createdAt updatedAt tags description';
  const ids = [
    ...(Array.isArray(productIds) ? productIds : []),
    ...(productId ? [productId] : []),
  ].map(toId).filter(Boolean);

  const excludedIds = new Set([excludeProductId, keepProductId, args.excludeProductId, args.keepProductId]
    .map(toId)
    .filter(Boolean)
    .map(String));

  if (ids.length) {
    filter._id = { $in: ids, ...(excludedIds.size ? { $nin: [...excludedIds] } : {}) };
    return Product.find(filter).sort({ updatedAt: -1, createdAt: -1 }).select(productCandidateSelect).lean();
  }

  const names = [
    ...(Array.isArray(productNames) ? productNames : []),
    ...(productName ? [productName] : []),
    ...(args.name ? [args.name] : []),
  ].map(name => cleanAIField(name, { maxLength: 140 })).filter(Boolean);

  if (!names.length) return [];

  const exactFilter = {
    ...filter,
    $or: names.map(name => ({ name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' } })),
  };
  if (excludedIds.size) exactFilter._id = { $nin: [...excludedIds] };
  let products = await Product.find(exactFilter).sort({ updatedAt: -1, createdAt: -1 }).select(productCandidateSelect).lean();

  if (!products.length) {
    const looseFilter = {
      ...filter,
      $or: names.map(name => ({ name: { $regex: escapeRegExp(name), $options: 'i' } })),
    };
    if (excludedIds.size) looseFilter._id = { $nin: [...excludedIds] };
    products = await Product.find(looseFilter).sort({ updatedAt: -1, createdAt: -1 }).limit(10).select(productCandidateSelect).lean();
  }

  if (!products.length) {
    const poolFilter = { ...filter };
    if (excludedIds.size) poolFilter._id = { $nin: [...excludedIds] };
    const pool = await Product.find(poolFilter)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(300)
      .select(productCandidateSelect)
      .lean();
    products = fuzzyProductMatches(pool, names.join(' '), 10);
  }

  return products;
}

function formatProductCandidate(product) {
  return {
    productId: product._id,
    name: product.name,
    brand: product.brand,
    price: product.price,
    currency: getProductCurrency(product),
    priceCurrency: product.priceCurrency,
    stock: product.stock,
    category: product.category,
    isFeatured: !!product.isFeatured,
    blocked: isProductBlocked(product),
    moderationReason: product.moderationReason || product.blockedReason || '',
    createdAt: product.createdAt,
  };
}

async function attachAIComparablePrices(products = [], targetCurrency = 'USD') {
  const currency = normalizeCurrency(targetCurrency);
  return Promise.all((products || []).map(async product => ({
    ...product,
    _comparablePrice: await convertAmount(getProductEffectivePrice(product), getProductCurrency(product), currency),
  })));
}

function sortAIProductsByPrice(products = [], sortBy = '', targetCurrency = 'USD') {
  if (!['price_low', 'price_high'].includes(sortBy)) return products;
  const direction = sortBy === 'price_low' ? 1 : -1;
  const currency = normalizeCurrency(targetCurrency);
  return products.sort((a, b) => {
    const priceA = a._comparablePrice ?? convertAmountSync(getProductEffectivePrice(a), getProductCurrency(a), currency);
    const priceB = b._comparablePrice ?? convertAmountSync(getProductEffectivePrice(b), getProductCurrency(b), currency);
    return (priceA - priceB) * direction;
  });
}

function filterAIProductsByPriceBounds(products = [], bounds = {}) {
  const { min = null, max = null } = bounds || {};
  if (min === null && max === null) return products;
  return products.filter(product => {
    const price = Number(product._comparablePrice);
    if (!Number.isFinite(price)) return true;
    if (min !== null && price < min) return false;
    if (max !== null && price > max) return false;
    return true;
  });
}

// ─── Smart Search: Synonym/Multilingual Expansion ───
function compactSearchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function productSearchText(product) {
  return [
    product.name,
    product.brand,
    product.category,
    product.description,
    ...(Array.isArray(product.tags) ? product.tags : []),
  ].filter(Boolean).join(' ');
}

function fuzzyProductMatches(products, query, limit = 20) {
  const cleanedQuery = cleanString(query);
  if (!cleanedQuery || !products?.length) return [];

  const compactQuery = compactSearchText(cleanedQuery);
  const queryParts = cleanedQuery
    .toLowerCase()
    .split(/\s+/)
    .map(compactSearchText)
    .filter(part => part.length >= 2);

  const exactish = products.filter(product => {
    const text = compactSearchText(productSearchText(product));
    return compactQuery && (
      text.includes(compactQuery) ||
      queryParts.every(part => text.includes(part))
    );
  });

  const fuse = new Fuse(products, {
    includeScore: true,
    threshold: 0.52,
    ignoreLocation: true,
    minMatchCharLength: 2,
    keys: [
      { name: 'name', weight: 0.55 },
      { name: 'brand', weight: 0.18 },
      { name: 'category', weight: 0.12 },
      { name: 'tags', weight: 0.1 },
      { name: 'description', weight: 0.05 },
    ],
  });

  const ranked = fuse.search(cleanedQuery)
    .filter(result => result.score == null || result.score <= 0.55)
    .map(result => result.item);

  const seen = new Set();
  return [...exactish, ...ranked]
    .filter(product => {
      const key = String(product._id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function baseCouponCode(coupon = {}) {
  const explicit = cleanString(coupon.code).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (explicit) return explicit.slice(0, 32);
  const value = Number(coupon.discountValue ?? coupon.discountPercent ?? coupon.fixedAmount ?? coupon.amount);
  if (coupon.discountType === 'percentage' || coupon.discountPercent != null) return `SAVE${Math.round(value || 10)}`;
  return `DEAL${Math.round(value || 10)}`;
}

async function uniqueCouponCode(userId, coupon) {
  const base = baseCouponCode(coupon) || 'SAVE10';
  let candidate = base;
  let suffix = 2;
  while (await Coupon.exists({ seller: userId, code: candidate })) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function resolveSellerCoupon(userId, args = {}) {
  const couponId = toId(args.couponId || args.id);
  if (couponId) return Coupon.findOne({ _id: couponId, seller: userId });

  const couponCode = cleanString(args.couponCode || args.code || args.couponId).toUpperCase();
  if (!couponCode) return null;
  return Coupon.findOne({ seller: userId, code: couponCode });
}

const SYNONYM_MAP = {
  // Multilingual (Urdu/Hindi → English)
  chapal: ['sandals', 'slippers', 'flip flops', 'slides'],
  joota: ['shoes', 'sneakers', 'footwear', 'boots'],
  juta: ['shoes', 'sneakers', 'footwear'],
  kapray: ['clothes', 'clothing', 'apparel', 'garments'],
  kurta: ['kurta', 'tunic', 'ethnic wear', 'traditional'],
  dupatta: ['dupatta', 'scarf', 'shawl', 'stole'],
  shalwar: ['shalwar', 'trousers', 'pants', 'bottoms'],
  kamiz: ['kameez', 'shirt', 'top', 'tunic'],
  ghari: ['watch', 'watches', 'wristwatch', 'timepiece'],
  basta: ['bag', 'bags', 'backpack', 'handbag'],
  topi: ['cap', 'hat', 'beanie', 'headwear'],
  chasma: ['glasses', 'sunglasses', 'eyewear', 'shades'],

  // Common slang/alternate spellings
  airpods: ['airpods', 'wireless earbuds', 'bluetooth earphones', 'tws earbuds', 'ear buds'],
  'air pods': ['airpods', 'wireless earbuds', 'bluetooth earphones', 'tws earbuds', 'ear buds'],
  earphones: ['earphones', 'earbuds', 'headphones', 'wireless earbuds', 'in-ear'],
  headphones: ['headphones', 'earphones', 'over-ear', 'wireless headphones', 'bluetooth headphones'],
  sneakers: ['sneakers', 'running shoes', 'trainers', 'sport shoes', 'athletic shoes'],
  tshirt: ['t-shirt', 'tee', 'top', 'casual shirt'],
  't-shirt': ['t-shirt', 'tee', 'top', 'casual shirt'],
  hoodie: ['hoodie', 'sweatshirt', 'pullover', 'hooded'],
  jeans: ['jeans', 'denim', 'pants', 'trousers'],
  jacket: ['jacket', 'coat', 'blazer', 'outerwear'],
  perfume: ['perfume', 'fragrance', 'cologne', 'eau de toilette', 'scent'],
  lipstick: ['lipstick', 'lip color', 'lip gloss', 'lip tint', 'lip'],
  cream: ['cream', 'moisturizer', 'lotion', 'skincare'],
  mobile: ['mobile', 'phone', 'smartphone', 'cell phone'],
  laptop: ['laptop', 'notebook', 'computer', 'macbook'],
  charger: ['charger', 'charging cable', 'power adapter', 'usb cable'],
  powerbank: ['power bank', 'portable charger', 'battery pack'],
  'power bank': ['power bank', 'portable charger', 'battery pack'],
  wallet: ['wallet', 'purse', 'card holder', 'money clip'],
  belt: ['belt', 'waist belt', 'leather belt'],
  ring: ['ring', 'finger ring', 'band', 'jewelry'],
  necklace: ['necklace', 'chain', 'pendant', 'jewelry'],
  bracelet: ['bracelet', 'bangle', 'wristband', 'jewelry'],
};

function expandSearchTerms(query) {
  if (!query) return [];
  const lower = query.toLowerCase().trim();
  const terms = new Set([lower]);

  // Check full phrase against synonym map
  if (SYNONYM_MAP[lower]) {
    SYNONYM_MAP[lower].forEach(s => terms.add(s));
  }

  // Check each word individually
  lower.split(/\s+/).forEach(word => {
    if (SYNONYM_MAP[word]) {
      SYNONYM_MAP[word].forEach(s => terms.add(s));
    }
  });

  return [...terms];
}

function buildSmartSearchFilter(query, category) {
  const filter = {};
  if (query) {
    const searchTerms = expandSearchTerms(query);
    const orConditions = [];

    for (const term of searchTerms) {
      // Escape regex special chars
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push(
        { name: { $regex: escaped, $options: 'i' } },
        { description: { $regex: escaped, $options: 'i' } },
        { tags: { $in: [new RegExp(escaped, 'i')] } },
        { brand: { $regex: escaped, $options: 'i' } },
        { category: { $regex: escaped, $options: 'i' } },
      );
    }

    // Also try individual words from the original query for partial matching
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push({ name: { $regex: escaped, $options: 'i' } });
    }

    filter.$or = orConditions;
  }
  if (category) filter.category = { $regex: category, $options: 'i' };
  return filter;
}

function normalizeObjectIdString(value) {
  const id = value?._id || value;
  return id ? String(id) : '';
}

function plainOptions(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (typeof value.toJSON === 'function') return value.toJSON();
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeProductOptionGroups(product) {
  return (product?.optionGroups || [])
    .map(group => ({
      name: cleanAIField(group?.name, { maxLength: 80 }),
      values: normalizeStringArray(group?.values),
    }))
    .filter(group => group.name && group.values.length > 0);
}

function findCaseInsensitive(value, choices = []) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return choices.find(choice => choice.toLowerCase() === raw.toLowerCase()) || '';
}

function resolveSelectedOption(selectedOptions, groupName) {
  const opts = plainOptions(selectedOptions);
  if (Object.prototype.hasOwnProperty.call(opts, groupName)) return opts[groupName];
  const key = Object.keys(opts).find(k => k.toLowerCase() === String(groupName).toLowerCase());
  return key ? opts[key] : undefined;
}

function validateProductSelection(product, selections = {}) {
  const groups = normalizeProductOptionGroups(product);
  const legacyColors = normalizeStringArray(product?.colors);
  const selectedOptions = plainOptions(selections.selectedOptions);
  let selectedColor = String(selections.selectedColor || '').trim();
  const normalizedOptions = {};
  const missingOptions = [];
  const invalidOptions = [];
  const hasColorGroup = groups.some(group => group.name.toLowerCase() === 'color');

  for (const group of groups) {
    const rawValue = resolveSelectedOption(selectedOptions, group.name);
    const rawFromColor = group.name.toLowerCase() === 'color' && selectedColor ? selectedColor : '';
    const chosen = findCaseInsensitive(rawValue || rawFromColor, group.values);
    if (!rawValue && !rawFromColor) {
      missingOptions.push({ name: group.name, values: group.values });
      continue;
    }
    if (!chosen) {
      invalidOptions.push({ name: group.name, value: rawValue || rawFromColor, values: group.values });
      continue;
    }
    normalizedOptions[group.name] = chosen;
    if (group.name.toLowerCase() === 'color') selectedColor = chosen;
  }

  if (!hasColorGroup && legacyColors.length > 0) {
    if (!selectedColor) {
      selectedColor = String(resolveSelectedOption(selectedOptions, 'Color') || resolveSelectedOption(selectedOptions, 'color') || '').trim();
    }
    const chosenColor = findCaseInsensitive(selectedColor, legacyColors);
    if (!selectedColor) {
      missingOptions.push({ name: 'Color', values: legacyColors });
    } else if (!chosenColor) {
      invalidOptions.push({ name: 'Color', value: selectedColor, values: legacyColors });
    } else {
      selectedColor = chosenColor;
    }
  }

  return {
    ok: missingOptions.length === 0 && invalidOptions.length === 0,
    selectedColor: selectedColor || null,
    selectedOptions: Object.keys(normalizedOptions).length > 0 ? normalizedOptions : undefined,
    missingOptions,
    invalidOptions,
    requiredOptions: groups.map(group => ({ name: group.name, values: group.values })),
    availableColors: legacyColors,
  };
}

function summarizeSelectionRequest(product, selection) {
  const parts = [];
  for (const opt of selection.missingOptions || []) {
    parts.push(`${opt.name}: ${opt.values.join(', ')}`);
  }
  for (const opt of selection.invalidOptions || []) {
    parts.push(`${opt.name} must be one of: ${opt.values.join(', ')}`);
  }
  return `"${product?.name || 'This product'}" needs a selection before checkout. ${parts.join(' | ')}`;
}

function parseQuantity(value, fallback = 1) {
  const n = Number.parseInt(value ?? fallback, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function shippingMissingFields(shipping = {}) {
  const required = ['fullName', 'email', 'phone', 'address', 'city', 'state', 'postalCode', 'country'];
  return required.filter(field => !String(shipping[field] || '').trim());
}

async function hydrateStoresForProducts(products = []) {
  const sellerIds = [...new Set(products.map(p => normalizeObjectIdString(p.seller)).filter(Boolean))];
  if (!sellerIds.length) return products;
  const stores = await Store.find(activeStoreQuery({ seller: { $in: sellerIds } }))
    .select('seller storeName storeSlug verification.isVerified trustCount')
    .lean();
  const storeBySeller = new Map(stores.map(store => [normalizeObjectIdString(store.seller), store]));
  return products.map(product => {
    const store = storeBySeller.get(normalizeObjectIdString(product.seller));
    return {
      ...product,
      storeName: store?.storeName,
      storeSlug: store?.storeSlug,
      isVerifiedStore: store?.verification?.isVerified || false,
      storeTrustCount: store?.trustCount || 0,
    };
  });
}

async function resolveStoreScope(args = {}) {
  const storeId = toId(args.storeId);
  const sellerId = toId(args.sellerId || args.seller);
  const storeSlug = String(args.storeSlug || args.slug || '').trim().toLowerCase();
  const storeName = String(args.storeName || args.store || '').trim();

  if (sellerId) {
    const store = await Store.findOne(activeStoreQuery({ seller: sellerId }))
      .select('_id seller storeName storeSlug verification.isVerified')
      .lean();
    return store ? { store, filter: { seller: store.seller } } : { notFound: true };
  }

  if (storeId) {
    const store = await Store.findOne(activeStoreQuery({ _id: storeId }))
      .select('_id seller storeName storeSlug verification.isVerified')
      .lean();
    return store ? { store, filter: { seller: store.seller } } : { notFound: true };
  }

  if (!storeSlug && !storeName) return { filter: {} };

  const storeQueries = [];
  if (storeSlug) storeQueries.push({ storeSlug });
  if (storeName) {
    const safeName = escapeRegExp(storeName);
    storeQueries.push({ storeName: { $regex: `^${safeName}$`, $options: 'i' } });
    storeQueries.push({ storeName: { $regex: safeName, $options: 'i' } });
    storeQueries.push({ storeSlug: { $regex: safeName.replace(/\s+/g, '-'), $options: 'i' } });
  }

  const matches = await Store.find(activeStoreQuery({ $or: storeQueries }))
    .limit(5)
    .select('_id seller storeName storeSlug verification.isVerified')
    .lean();

  if (!matches.length) return { notFound: true };

  const exact = matches.find(store =>
    (storeSlug && store.storeSlug === storeSlug) ||
    (storeName && store.storeName.toLowerCase() === storeName.toLowerCase())
  );
  if (exact) return { store: exact, filter: { seller: exact.seller } };
  if (matches.length === 1) return { store: matches[0], filter: { seller: matches[0].seller } };

  return { ambiguous: true, matches };
}

async function notifyCodOrder(newOrder, productItems = []) {
  try {
    const confirmUrl = `${process.env.FRONTEND_URL || 'https://rozare.com'}/orders/confirm/${newOrder.confirmation.token}`;
    const emailData = buyerOrderConfirmationRequestEmail(newOrder, confirmUrl);
    await sendEmail({ to: newOrder.shippingInfo.email, ...emailData });
    newOrder.confirmation.emailSentAt = new Date();
    newOrder.confirmation.emailSentSuccess = true;
    await newOrder.save();
  } catch (emailErr) {
    console.error('[aiActionExecutor] buyer order email failed:', emailErr.message);
    newOrder.confirmation.emailSentAt = new Date();
    newOrder.confirmation.emailSentSuccess = false;
    newOrder.confirmation.emailError = emailErr.message || 'Unknown email error';
    await newOrder.save().catch(() => null);
  }

  const sellerIds = [...new Set(productItems.map(p => normalizeObjectIdString(p.seller)).filter(Boolean))];
  for (const sellerId of sellerIds) {
    try {
      const seller = await User.findById(sellerId).select('username email').lean();
      if (seller?.email) {
        const sellerEmailData = newOrderSellerEmail(newOrder, seller.username);
        await sendEmail({ to: seller.email, ...sellerEmailData });
      }
      notifySeller(sellerId, 'new_order', sellerTemplates.new_order(newOrder)).catch(e =>
        console.error('[aiActionExecutor] seller WhatsApp order notification failed:', e.message)
      );
    } catch (err) {
      console.error('[aiActionExecutor] seller order notification failed:', err.message);
    }
  }

  try {
    // Buyer order confirmation is a core checkout feature — always send it when
    // the WhatsApp gateway is connected, regardless of any seller subscription.
    const cfg = await WhatsAppConfig.findOne({ singletonKey: configKeyFor('main') }).lean();
    if (cfg?.status === 'connected') {
      enqueueOrderConfirmation(newOrder).catch(err =>
        console.error('[aiActionExecutor] WhatsApp order confirmation enqueue failed:', err.message)
      );
    } else {
      await Order.updateOne({ _id: newOrder._id }, {
        $set: {
          'confirmation.whatsappSentAt': new Date(),
          'confirmation.whatsappSentSuccess': false,
          'confirmation.whatsappError': cfg ? `WhatsApp status: ${cfg.status} (not connected)` : 'WhatsApp not configured',
        },
      });
    }
  } catch (err) {
    console.error('[aiActionExecutor] WhatsApp confirmation check failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════

async function executeToolCall(toolName, args = {}, user) {
  const userId = user?._id || user?.id || null;
  const role = user?.role || 'guest';

  try {
    let preferredCurrency = normalizeCurrency(user?.currency || 'USD');
    if (userId && !user?.currency) {
      const account = await User.findById(userId).select('currency').lean();
      preferredCurrency = normalizeCurrency(account?.currency || preferredCurrency);
    }
    const userMoney = (amount, sourceCurrency = 'USD') => formatMoney(amount, preferredCurrency, { sourceCurrency });
    const productMoney = (product, amount = null) => formatMoney(
      amount == null ? getProductEffectivePrice(product) : amount,
      preferredCurrency,
      { sourceCurrency: getProductCurrency(product, preferredCurrency) }
    );

    switch (toolName) {

      // ─────────────────────────────────────────────
      //  USER / SHARED TOOLS
      // ─────────────────────────────────────────────

      case 'search_products': {
        const { query, category, minPrice, maxPrice, sortBy, brand, limit } = args;
        const hasMinPrice = minPrice !== undefined && minPrice !== null && minPrice !== '';
        const hasMaxPrice = maxPrice !== undefined && maxPrice !== null && maxPrice !== '';
        const requestedCurrency = normalizeCurrency(args.currency || preferredCurrency);
        const priceBounds = { min: null, max: null };
        if (hasMinPrice) {
          const parsed = parseMoneyInput(minPrice, requestedCurrency);
          if (Number.isFinite(parsed.amount)) priceBounds.min = await convertAmount(parsed.amount, parsed.currency, requestedCurrency);
        }
        if (hasMaxPrice) {
          const parsed = parseMoneyInput(maxPrice, requestedCurrency);
          if (Number.isFinite(parsed.amount)) priceBounds.max = await convertAmount(parsed.amount, parsed.currency, requestedCurrency);
        }
        const needsComparablePrices = hasMinPrice || hasMaxPrice || ['price_low', 'price_high'].includes(sortBy);
        const fetchLimit = needsComparablePrices ? 300 : safeLimit(limit, 20, 50);
        const applyPriceBounds = async () => {};
        const finalizeProductSearch = async (items) => {
          let next = await attachAIComparablePrices(items, requestedCurrency);
          next = filterAIProductsByPriceBounds(next, priceBounds);
          next = sortAIProductsByPrice(next, sortBy, requestedCurrency);
          return next.slice(0, safeLimit(limit, 20, 50));
        };

        const activeSellerIds = await getActiveSellerIds();

        // Use smart search with synonym expansion
        let filter = applyActiveSellerProductFilter(
          publicProductFilter(buildSmartSearchFilter(query, category)),
          activeSellerIds
        );
        const storeScope = await resolveStoreScope(args);
        if (storeScope.notFound) {
          return {
            success: false,
            error: `I couldn't find that store${args.storeName ? ` ("${args.storeName}")` : args.storeSlug ? ` (${args.storeSlug})` : ''}. Try the exact store name or ask me to search stores first.`,
            data: { storeNotFound: true },
          };
        }
        if (storeScope.ambiguous) {
          return {
            success: false,
            error: `I found a few stores that match. Please choose one: ${storeScope.matches.map(s => `${s.storeName} (@${s.storeSlug})`).join(', ')}`,
            data: {
              needsStoreSelection: true,
              stores: storeScope.matches.map(s => ({
                _id: s._id,
                storeName: s.storeName,
                storeSlug: s.storeSlug,
                isVerified: s.verification?.isVerified || false,
              })),
            },
          };
        }
        Object.assign(filter, storeScope.filter || {});
        if (brand) filter.brand = { $regex: escapeRegExp(brand), $options: 'i' };
        if (isTruthy(args.inStockOnly) || isTruthy(args.availableOnly)) filter.stock = { $gt: 0 };
        await applyPriceBounds(filter);

        let sort = { createdAt: -1 };
        if (sortBy === 'popular') sort = { rating: -1 };
        else if (sortBy === 'newest') sort = { createdAt: -1 };
        else if (sortBy === 'best_rated') sort = { rating: -1, numReviews: -1 };
        else if (sortBy === 'trending') sort = { numReviews: -1, rating: -1 };

        let products = await Product.find(filter)
          .sort(sort)
          .limit(fetchLimit)
          .select('name price discountedPrice currency priceCurrency category brand image rating numReviews stock colors optionGroups seller isFeatured tags createdAt')
          .lean();
        products = await hydrateStoresForProducts(products);
        products = await finalizeProductSearch(products);

        if (products.length === 0 && query) {
          const fuzzyFilter = applyActiveSellerProductFilter(
            publicProductFilter({ ...(storeScope.filter || {}) }),
            activeSellerIds
          );
          if (category) fuzzyFilter.category = { $regex: escapeRegExp(category), $options: 'i' };
          if (brand) fuzzyFilter.brand = { $regex: escapeRegExp(brand), $options: 'i' };
          if (isTruthy(args.inStockOnly) || isTruthy(args.availableOnly)) fuzzyFilter.stock = { $gt: 0 };
          await applyPriceBounds(fuzzyFilter);

          const fuzzyPool = await Product.find(fuzzyFilter)
            .sort({ rating: -1, numReviews: -1, createdAt: -1 })
            .limit(300)
            .select('name price discountedPrice currency priceCurrency category brand image rating numReviews stock colors optionGroups seller isFeatured tags description createdAt')
            .lean();
          products = fuzzyProductMatches(fuzzyPool, query, safeLimit(limit, 20, 50));
          products = await hydrateStoresForProducts(products);
          products = await finalizeProductSearch(products);
        }

        // If no results and we have a query, try a broader fallback: sort by popularity
        if (products.length === 0 && query) {
          // Fallback: return popular/recent products when search yields nothing
          const fallbackFilter = applyActiveSellerProductFilter(
            publicProductFilter({ ...(storeScope.filter || {}) }),
            activeSellerIds
          );
          if (category) fallbackFilter.category = { $regex: category, $options: 'i' };
          if (brand) fallbackFilter.brand = { $regex: escapeRegExp(brand), $options: 'i' };
          if (isTruthy(args.inStockOnly) || isTruthy(args.availableOnly)) fallbackFilter.stock = { $gt: 0 };
          await applyPriceBounds(fallbackFilter);
          products = await Product.find(fallbackFilter)
            .sort({ rating: -1, numReviews: -1, createdAt: -1 })
            .limit(300)
            .select('name price discountedPrice currency priceCurrency category brand image rating numReviews stock colors optionGroups seller isFeatured tags createdAt')
            .lean();
          products = await hydrateStoresForProducts(products);
          products = await finalizeProductSearch(products).then(items => items.slice(0, 12));

          if (products.length > 0) {
            return {
              success: true,
              data: { products, count: products.length, fallback: true, store: storeScope.store || null },
              message: `No exact matches for "${query}"${storeScope.store ? ` in ${storeScope.store.storeName}` : ''}, but here are ${products.length} popular product${products.length !== 1 ? 's' : ''} you might like:`,
            };
          }
        }

        return {
          success: true,
          data: { products, count: products.length, store: storeScope.store || null },
          message: products.length > 0
            ? `Found ${products.length} product${products.length !== 1 ? 's' : ''}${query ? ` matching "${query}"` : ''}${storeScope.store ? ` from ${storeScope.store.storeName}` : ''}`
            : `No products found${query ? ` for "${query}"` : ''}${storeScope.store ? ` in ${storeScope.store.storeName}` : ''}. Try different keywords, a broader category, or another store.`,
        };
      }

      case 'get_my_orders': {
        if (!userId) return { success: false, error: 'You must be logged in to view orders.' };
        const { status, limit } = args;

        // ROLE-AWARE: If seller, show orders containing THEIR products (not personal purchases)
        let orders, totalCount;
        if (role === 'seller') {
          const myProducts = await Product.find({ seller: userId }).select('_id').lean();
          const productIds = myProducts.map(p => p._id);
          const filter = { 'orderItems.productId': { $in: productIds } };
          if (status && status !== 'all') filter.orderStatus = status;

          // Get TOTAL count first (no limit) for accurate reporting
          totalCount = await Order.countDocuments(filter);

          orders = await Order.find(filter)
            .sort({ createdAt: -1 })
            .limit(safeLimit(limit, 20))
            .populate('user', 'username email')
            .populate('orderItems.productId', 'name image price currency priceCurrency seller')
            .lean();

          // CRITICAL: Filter order items to only show THIS seller's products + recalculate seller-specific total
          orders = orders.map(o => {
            const sellerItems = (o.orderItems || []).filter(i =>
              productIds.some(pid => pid.toString() === (i.productId?._id || i.productId)?.toString())
            );
            const sellerTotal = sellerItems.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
            return { ...o, orderItems: sellerItems, _sellerTotal: sellerTotal };
          });
        } else {
          // Regular user: show their OWN orders only
          const filter = { user: userId };
          if (status && status !== 'all') filter.orderStatus = status;

          totalCount = await Order.countDocuments(filter);

          orders = await Order.find(filter)
            .sort({ createdAt: -1 })
            .limit(safeLimit(limit, 15))
            .populate('orderItems.productId', 'name image price currency priceCurrency')
            .lean();
        }

        return {
          success: true,
          data: {
            orders: orders.map(o => ({
              _id: o._id,
              orderId: o.orderId,
              status: o.orderStatus,
              total: role === 'seller' ? (o._sellerTotal || 0) : (o.orderSummary?.totalAmount || 0),
              buyer: role === 'seller' ? (o.user?.username || 'Guest') : undefined,
              items: (o.orderItems || []).map(i => ({
                name: i.name || i.productId?.name,
                price: i.price,
                quantity: i.quantity,
                image: i.image || i.productId?.image,
              })),
              date: o.createdAt,
              isPaid: o.isPaid,
            })),
            count: orders.length,
            totalCount,
          },
          message: `Found ${totalCount} total order${totalCount !== 1 ? 's' : ''}${status ? ` with status "${status}"` : ''}${role === 'seller' ? ' for your store' : ''} (showing ${orders.length})`,
        };
      }

      case 'get_order_detail': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { orderId } = args;
        if (!orderId) return { success: false, error: 'Please provide an order ID.' };

        let order;
        if (role === 'seller') {
          // Sellers can view orders containing THEIR products
          const myProducts = await Product.find({ seller: userId }).select('_id').lean();
          const productIds = myProducts.map(p => p._id.toString());
          order = await Order.findOne({
            $or: [{ _id: toId(orderId) }, { orderId: orderId }],
            'orderItems.productId': { $in: myProducts.map(p => p._id) },
          })
            .populate('orderItems.productId', 'name image price currency priceCurrency category seller')
            .populate('user', 'username email')
            .lean();
        } else if (role === 'admin') {
          // Admins can view any order
          order = await Order.findOne({
            $or: [{ _id: toId(orderId) }, { orderId: orderId }],
          })
            .populate('orderItems.productId', 'name image price currency priceCurrency category')
            .populate('user', 'username email')
            .lean();
        } else {
          // Users can only view their own orders
          order = await Order.findOne({
            $or: [
              { _id: toId(orderId), user: userId },
              { orderId: orderId, user: userId },
            ],
          })
            .populate('orderItems.productId', 'name image price currency priceCurrency category')
            .lean();
        }

        if (!order) return { success: false, error: 'Order not found or access denied.' };

        // For sellers: filter items to only their products + compute seller subtotal
        let items = order.orderItems || [];
        let summary = order.orderSummary;
        if (role === 'seller') {
          const myProductIds = (await Product.find({ seller: userId }).select('_id').lean()).map(p => p._id.toString());
          items = items.filter(i =>
            myProductIds.includes((i.productId?._id || i.productId)?.toString())
          );
          const sellerSubtotal = items.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
          summary = { subtotal: sellerSubtotal, totalAmount: sellerSubtotal, note: 'Shows only your products from this order' };
        }

        return {
          success: true,
          data: {
            orderId: order.orderId,
            status: order.orderStatus,
            buyer: role === 'seller' ? (order.user?.username || 'Guest') : undefined,
            items: items.map(i => ({
              name: i.name || i.productId?.name,
              price: i.price,
              quantity: i.quantity,
              image: i.image || i.productId?.image,
            })),
            summary,
            shipping: role !== 'seller' ? order.shippingInfo : { city: order.shippingInfo?.city, country: order.shippingInfo?.country },
            paymentMethod: order.paymentMethod,
            isPaid: order.isPaid,
            isDelivered: order.isDelivered,
            date: order.createdAt,
          },
          message: `Order #${order.orderId} — ${order.orderStatus}${role === 'seller' ? ' (your products only)' : ''}`,
        };
      }

      case 'cancel_order': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { orderId, reason } = args;
        if (!orderId) return { success: false, error: 'Please provide an order ID to cancel.' };

        const order = await Order.findOne({
          $or: [
            { _id: toId(orderId), user: userId },
            { orderId: orderId, user: userId },
          ],
        });

        if (!order) return { success: false, error: 'Order not found or access denied.' };
        if (['delivered', 'cancelled'].includes(order.orderStatus)) {
          return { success: false, error: `Cannot cancel — order is already ${order.orderStatus}.` };
        }

        const cancellationBlock = getBuyerCancellationBlock(order);
        if (cancellationBlock) {
          return { success: false, error: cancellationBlock.message, code: cancellationBlock.code };
        }

        order.orderStatus = 'cancelled';
        await ensureOrderSellerFulfillment(order);
        setAllSellerFulfillmentStatus(order, 'cancelled');
        syncAggregateDeliveryState(order);
        if (reason) order.instructions = (order.instructions || '') + ` [Cancelled: ${reason}]`;
        await order.save();

        return { success: true, message: `Order #${order.orderId} has been cancelled successfully.` };
      }

      case 'submit_complaint': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { category, subject, message, orderId, productId } = args;
        if (!category || !subject || !message) {
          return { success: false, error: 'Please provide category, subject, and message for the complaint.' };
        }

        const complaint = await Complaint.create({
          user: userId,
          category,
          subject,
          message,
          ...(orderId ? { relatedOrder: toId(orderId) } : {}),
          ...(productId ? { relatedProduct: toId(productId) } : {}),
        });

        return {
          success: true,
          data: { complaintId: complaint._id, status: complaint.status },
          message: `Complaint submitted successfully (ID: ${complaint._id}). We'll look into it.`,
        };
      }

      case 'get_my_complaints': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { status } = args;
        const filter = { user: userId };
        if (status) filter.status = status;

        const [complaints, totalCount] = await Promise.all([
          Complaint.find(filter).sort({ createdAt: -1 }).limit(20).lean(),
          Complaint.countDocuments(filter),
        ]);

        return {
          success: true,
          data: {
            complaints: complaints.map(c => ({
              _id: c._id,
              subject: c.subject,
              category: c.category,
              status: c.status,
              priority: c.priority,
              adminResponse: c.adminResponse || '',
              date: c.createdAt,
            })),
            count: complaints.length,
            totalCount,
          },
          message: `You have ${totalCount} complaint${totalCount !== 1 ? 's' : ''}${status ? ` with status "${status}"` : ''} (showing ${complaints.length})`,
        };
      }

      case 'get_wishlist': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const activeSellerIds = await getActiveSellerIds();
        const user = await User.findById(userId)
          .populate({
            path: 'wishlist',
            match: applyActiveSellerProductFilter(publicProductFilter(), activeSellerIds),
            select: 'name price discountedPrice image category rating stock seller',
          })
          .lean();

        const items = (user?.wishlist || []).filter(Boolean).map(p => ({
          _id: p._id,
          name: p.name,
          price: p.price,
          discountedPrice: p.discountedPrice,
          image: p.image,
          category: p.category,
          inStock: p.stock > 0,
        }));

        return {
          success: true,
          data: { items, count: items.length },
          message: items.length > 0
            ? `Your wishlist has ${items.length} item${items.length !== 1 ? 's' : ''}: ${items.map(i => i.name).join(', ')}`
            : 'Your wishlist is empty.',
        };
      }

      case 'add_to_wishlist': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productId } = args;
        if (!productId) return { success: false, error: 'Please provide a product ID.' };

        const product = await Product.findOne(publicProductFilter({ _id: toId(productId) })).select('name seller').lean();
        if (!product) return { success: false, error: 'Product not found.' };
        if (!(await isProductSellerPubliclyActive(product.seller))) {
          return { success: false, error: 'Product not found.' };
        }

        await User.findByIdAndUpdate(userId, { $addToSet: { wishlist: productId } });
        return { success: true, message: `"${product.name}" added to your wishlist! ❤️` };
      }

      case 'remove_from_wishlist': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productId } = args;
        if (!productId) return { success: false, error: 'Please provide a product ID.' };

        await User.findByIdAndUpdate(userId, { $pull: { wishlist: productId } });
        return { success: true, message: 'Item removed from your wishlist.' };
      }

      case 'get_addresses': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const user = await User.findById(userId).select('savedAddresses savedShippingInfo').lean();

        return {
          success: true,
          data: {
            addresses: user?.savedAddresses || [],
            defaultAddress: user?.savedShippingInfo || null,
          },
          message: `You have ${(user?.savedAddresses || []).length} saved address(es).`,
        };
      }

      case 'add_address': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const addr = args.address || args;
        if (!addr.fullName || !addr.address || !addr.city) {
          return { success: false, error: 'Please provide at least fullName, address, and city.' };
        }

        await User.findByIdAndUpdate(userId, { $push: { savedAddresses: addr } });
        return { success: true, message: `New address "${addr.label || 'Home'}" added successfully!` };
      }

      case 'update_profile': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const updates = args.updates || args;
        const allowed = {};
        if (updates.username) allowed.username = updates.username;
        if (updates.name) allowed.username = updates.name;
        if (updates.phone) allowed['sellerInfo.phoneNumber'] = updates.phone;
        if (updates.currency) allowed.currency = updates.currency;

        if (Object.keys(allowed).length === 0) {
          return { success: false, error: 'No valid fields to update. You can update: name, phone, currency.' };
        }

        await User.findByIdAndUpdate(userId, { $set: allowed });
        return { success: true, message: 'Profile updated successfully! ✨' };
      }

      case 'get_notifications': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { limit } = args;

        const [notifications, totalCount, totalUnread] = await Promise.all([
          Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(safeLimit(limit, 20)).lean(),
          Notification.countDocuments({ user: userId }),
          Notification.countDocuments({ user: userId, read: false }),
        ]);

        return {
          success: true,
          data: {
            notifications: notifications.map(n => ({
              _id: n._id,
              title: n.title,
              body: n.body,
              category: n.category,
              read: n.read,
              date: n.createdAt,
            })),
            unreadCount: totalUnread,
            totalCount,
            showing: notifications.length,
          },
          message: `${totalUnread} unread notification${totalUnread !== 1 ? 's' : ''} out of ${totalCount} total (showing ${notifications.length}).`,
        };
      }

      case 'mark_notifications_read': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const result = await Notification.updateMany(
          { user: userId, read: false },
          { $set: { read: true, readAt: new Date() } }
        );
        return { success: true, message: `Marked ${result.modifiedCount} notification${result.modifiedCount !== 1 ? 's' : ''} as read.` };
      }

      case 'get_available_coupons': {
        const { storeId, productId } = args;
        const now = new Date();
        const filter = {
          isActive: true,
          expiryDate: { $gt: now },
          startDate: { $lte: now },
          $or: [{ maxUses: null }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }],
        };
        if (storeId) filter.seller = toId(storeId);

        let coupons = await Coupon.find(filter)
          .limit(20)
          .populate('seller', 'username')
          .lean();

        if (productId) {
          coupons = coupons.filter(c =>
            c.applicableTo === 'all' ||
            (c.applicableProducts || []).some(p => p.toString() === productId)
          );
        }

        return {
          success: true,
          data: {
            coupons: coupons.map(c => ({
              code: c.code,
              type: c.discountType,
              value: c.discountValue,
              minOrder: c.minOrderAmount,
              maxDiscount: c.maxDiscountAmount,
              expires: c.expiryDate,
              seller: c.seller?.username || 'Unknown',
              description: c.description,
            })),
            count: coupons.length,
          },
          message: coupons.length > 0
            ? `Found ${coupons.length} available coupon${coupons.length !== 1 ? 's' : ''}!`
            : 'No coupons available right now.',
        };
      }

      case 'get_product_detail': {
        const { productId } = args;
        if (!productId) return { success: false, error: 'Please provide a product ID.' };

        const product = await Product.findOne(publicProductFilter({ _id: toId(productId) }))
          .populate('seller', 'username')
          .lean();
        if (!product) return { success: false, error: 'Product not found.' };
        if (!(await isProductSellerPubliclyActive(product.seller?._id || product.seller))) {
          return { success: false, error: 'Product not found.' };
        }

        const store = await Store.findOne(activeStoreQuery({ seller: product.seller?._id })).select('storeName storeSlug verification.isVerified').lean();

        return {
          success: true,
          data: {
            _id: product._id,
            name: product.name,
            description: product.description,
            price: product.price,
            discountedPrice: product.discountedPrice,
            currency: getProductCurrency(product),
            priceCurrency: product.priceCurrency,
            category: product.category,
            brand: product.brand,
            stock: product.stock,
            image: product.image,
            images: product.images,
            rating: product.rating,
            numReviews: product.numReviews,
            colors: product.colors,
            optionGroups: product.optionGroups,
            tags: product.tags,
            seller: product.seller?.username,
            storeName: store?.storeName,
            storeSlug: store?.storeSlug,
            isVerifiedStore: store?.verification?.isVerified || false,
            returnPolicy: product.returnPolicy,
          },
          message: `${product.name} — ${await productMoney(product)} | ${product.stock > 0 ? `${product.stock} in stock` : 'Out of stock'} | ⭐ ${product.rating?.toFixed(1) || 'N/A'} (${product.numReviews} reviews)`,
        };
      }

      case 'send_product_image': {
        const { productId, caption } = args;
        if (!productId) return { success: false, error: 'Please provide a product ID.' };

        const product = await Product.findOne(publicProductFilter({ _id: toId(productId) }))
          .select('name image images price discountedPrice currency priceCurrency stock seller')
          .lean();
        if (!product) return { success: false, error: 'Product not found.' };
        if (!(await isProductSellerPubliclyActive(product.seller))) {
          return { success: false, error: 'Product not found.' };
        }

        const imageUrl = product.image || product.images?.[0]?.url || product.images?.[0];
        if (!imageUrl) return { success: false, error: `No image is available for "${product.name}".` };

        return {
          success: true,
          blocked: isProductBlocked(product),
          data: {
            productId: product._id,
            name: product.name,
            imageUrl,
            caption: caption || product.name,
            price: product.discountedPrice || product.price,
            currency: getProductCurrency(product),
            priceCurrency: product.priceCurrency,
            stock: product.stock,
          },
          message: `Image ready for "${product.name}".`,
        };
      }

      case 'get_my_profile': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const user = await User.findById(userId)
          .select('username email role currency avatar savedShippingInfo savedAddresses sellerInfo createdAt wishlist')
          .lean();
        if (!user) return { success: false, error: 'User not found.' };

        return {
          success: true,
          data: {
            username: user.username,
            email: user.email,
            role: user.role,
            currency: user.currency,
            avatar: user.avatar,
            phone: user.sellerInfo?.phoneNumber || '',
            defaultAddress: user.savedShippingInfo || null,
            savedAddressCount: (user.savedAddresses || []).length,
            wishlistCount: (user.wishlist || []).length,
            memberSince: user.createdAt,
          },
          message: `Profile: ${user.username} (${user.email}) — ${user.role} — ${(user.savedAddresses || []).length} addresses, ${(user.wishlist || []).length} wishlist items.`,
        };
      }

      case 'add_to_cart': {
        if (!userId) return { success: false, error: 'You must be logged in to add items to cart.' };
        const { productId, selectedColor, selectedOptions } = args;
        if (!productId) return { success: false, error: 'Please provide a productId.' };
        const quantity = parseQuantity(args.quantity, 1);
        if (!quantity) return { success: false, error: 'Please provide a valid quantity of at least 1.' };

        const product = await Product.findOne(publicProductFilter({ _id: toId(productId) })).select('name price discountedPrice currency priceCurrency stock image colors optionGroups seller').lean();
        if (!product) return { success: false, error: 'Product not found.' };
        if (!(await isProductSellerPubliclyActive(product.seller))) {
          return { success: false, error: 'Product not found.' };
        }
        if (product.stock <= 0) return { success: false, error: `"${product.name}" is out of stock.` };
        if (quantity > product.stock) return { success: false, error: `Only ${product.stock} unit${product.stock !== 1 ? 's' : ''} of "${product.name}" are available.` };

        const selection = validateProductSelection(product, { selectedColor, selectedOptions });
        if (!selection.ok) {
          return {
            success: false,
            needsSelection: true,
            error: summarizeSelectionRequest(product, selection),
            data: {
              productId: product._id,
              name: product.name,
              requiredOptions: selection.requiredOptions,
              availableColors: selection.availableColors,
              missingOptions: selection.missingOptions,
              invalidOptions: selection.invalidOptions,
            },
          };
        }

        let cart = await Cart.findOne({ user: userId });
        if (!cart) {
          cart = new Cart({ user: userId, cartItems: [] });
        }

        // Check if already in cart
        const normalizedSelectedOptions = selection.selectedOptions || undefined;
        const normalizedSelectedColor = selection.selectedColor || null;
        const optKey = normalizedSelectedOptions ? Object.keys(normalizedSelectedOptions).sort().map(k => `${k}:${normalizedSelectedOptions[k]}`).join('|') : '';
        const existing = cart.cartItems.find(item =>
          normalizeObjectIdString(item.product) === String(productId) &&
          (item.selectedColor || null) === normalizedSelectedColor &&
          (item.selectedOptions ? Object.keys(item.selectedOptions.toJSON?.() || item.selectedOptions).sort().map(k => `${k}:${(item.selectedOptions.toJSON?.() || item.selectedOptions)[k]}`).join('|') : '') === optKey
        );
        if (existing) {
          const nextQty = (existing.qty || 1) + quantity;
          if (nextQty > product.stock) {
            return { success: false, error: `You already have ${existing.qty || 1} in your cart. Only ${product.stock} unit${product.stock !== 1 ? 's' : ''} are available.` };
          }
          existing.qty = nextQty;
        } else {
          cart.cartItems.push({
            product: productId,
            qty: quantity,
            selectedColor: normalizedSelectedColor,
            selectedOptions: normalizedSelectedOptions,
          });
        }
        await cart.populate('cartItems.product');
        await cart.save();

        return {
          success: true,
          data: { cartItemCount: cart.cartItems.length, totalCartPrice: cart.totalCartPrice, totalCartCurrency: cart.totalCartCurrency, productId: product._id, name: product.name, quantity },
          message: `"${product.name}" added to cart! 🛒 Cart total: ${await userMoney(cart.totalCartPrice || 0, cart.totalCartCurrency || preferredCurrency)} (${cart.cartItems.length} item${cart.cartItems.length !== 1 ? 's' : ''})`,
        };
      }

      case 'view_cart': {
        if (!userId) return { success: false, error: 'You must be logged in to view cart.' };
        const cart = await Cart.findOne({ user: userId }).populate('cartItems.product').lean();
        if (!cart || !cart.cartItems?.length) {
          return { success: true, data: { items: [], total: 0 }, message: 'Your cart is empty. Start shopping! 🛍️' };
        }

        const activeSellerSet = new Set((await getActiveSellerIds()).map(normalizeObjectIdString));
        const items = await Promise.all(cart.cartItems.filter(i => (
          i.product
          && !isProductBlocked(i.product)
          && (!normalizeObjectIdString(i.product.seller) || activeSellerSet.has(normalizeObjectIdString(i.product.seller)))
        )).map(async item => {
          const p = item.product;
          const sourceCurrency = getProductCurrency(p, preferredCurrency);
          const sourcePrice = getProductEffectivePrice(p);
          const price = await convertAmount(sourcePrice, sourceCurrency, preferredCurrency);
          return {
            _id: item._id,
            productId: p._id,
            name: p.name,
            price,
            currency: preferredCurrency,
            sourcePrice,
            sourceCurrency,
            originalPrice: p.price,
            quantity: item.qty || 1,
            image: p.image,
            selectedColor: item.selectedColor,
            selectedOptions: plainOptions(item.selectedOptions),
            subtotal: price * (item.qty || 1),
          };
        }));

        const visibleCartTotal = items.reduce((sum, item) => sum + item.subtotal, 0);
        const itemSummary = [];
        for (const item of items.slice(0, 8)) {
          itemSummary.push(`${item.name} (${await userMoney(item.price, preferredCurrency)})`);
        }

        return {
          success: true,
          data: { items, total: visibleCartTotal, currency: preferredCurrency, itemCount: items.length },
          message: `Your cart has ${items.length} item${items.length !== 1 ? 's' : ''} — Total: ${await userMoney(visibleCartTotal, preferredCurrency)}. Items: ${itemSummary.join(', ')}`,
        };
      }

      case 'remove_from_cart': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productId } = args;
        if (!productId) return { success: false, error: 'Please provide productId.' };

        const cart = await Cart.findOne({ user: userId });
        if (!cart) return { success: false, error: 'Cart is empty.' };

        const before = cart.cartItems.length;
        cart.cartItems = cart.cartItems.filter(item => !item.product.equals(toId(productId)));
        if (cart.cartItems.length === before) {
          return { success: false, error: 'Product not found in cart.' };
        }
        await cart.populate('cartItems.product');
        await cart.save();

        return {
          success: true,
          data: { cartItemCount: cart.cartItems.length, totalCartPrice: cart.totalCartPrice, totalCartCurrency: cart.totalCartCurrency },
          message: `Item removed from cart. ${cart.cartItems.length} item${cart.cartItems.length !== 1 ? 's' : ''} remaining — ${await userMoney(cart.totalCartPrice || 0, cart.totalCartCurrency || preferredCurrency)}`,
        };
      }

      case 'clear_cart': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const cart = await Cart.findOne({ user: userId });
        if (!cart || !cart.cartItems?.length) return { success: true, message: 'Cart is already empty.' };

        cart.cartItems = [];
        await cart.save();
        return { success: true, message: 'Cart cleared! 🗑️' };
      }

      case 'place_order': {
        if (!userId) return { success: false, error: 'You must be logged in to place an order.' };
        const { productId, shippingInfo, paymentMethod, selectedColor, selectedOptions } = args;
        const normalizedPaymentMethod = paymentMethod || 'cash_on_delivery';
        if (!['cash_on_delivery', 'stripe'].includes(normalizedPaymentMethod)) {
          return { success: false, error: 'Choose Cash on Delivery here, or use secure checkout for Stripe card or Rozare Wallet.' };
        }
        if (normalizedPaymentMethod === 'stripe') {
          return {
            success: false,
            needsPaymentCheckout: true,
            error: 'Stripe card and Rozare Wallet payment use the secure checkout page. I can add the product to your cart and take you there, or place the order here with Cash on Delivery when every seller allows it.',
            data: { checkoutRoute: '/checkout' },
          };
        }

        // Get user's saved address if shipping info not provided
        let shipping = shippingInfo;
        if (!shipping || !shipping.fullName) {
          const user = await User.findById(userId).select('savedShippingInfo savedAddresses username email sellerInfo').lean();
          // Try default address first, then first saved address
          if (user?.savedShippingInfo?.fullName) {
            shipping = user.savedShippingInfo;
          } else if (user?.savedAddresses?.length > 0) {
            const addr = user.savedAddresses.find(a => a.isDefault) || user.savedAddresses[0];
            shipping = {
              fullName: addr.fullName,
              email: addr.email || user.email,
              phone: addr.phone || user.sellerInfo?.phoneNumber || '',
              address: addr.address,
              city: addr.city,
              state: addr.state || '',
              postalCode: addr.postalCode || '',
              country: addr.country || 'Pakistan',
            };
          }
        }

        if (shipping && !shipping.email) shipping.email = (await User.findById(userId).select('email').lean())?.email || '';
        const missingShipping = shippingMissingFields(shipping || {});
        if (missingShipping.length > 0) {
          return {
            success: false,
            error: `Please provide the missing shipping detail${missingShipping.length !== 1 ? 's' : ''}: ${missingShipping.join(', ')}.`,
            needsShippingInfo: true,
            data: { missingShippingFields: missingShipping },
          };
        }

        // Get product(s) to order
        let orderItems = [];
        let productItems = [];
        if (productId) {
          // Single product order
          const product = await Product.findOne(publicProductFilter({ _id: toId(productId) })).lean();
          if (!product) return { success: false, error: 'Product not found.' };
          if (!(await isProductSellerPubliclyActive(product.seller))) {
            return { success: false, error: 'Product not found.' };
          }
          if (product.stock <= 0) return { success: false, error: `"${product.name}" is out of stock.` };
          productItems = [product];
          const quantity = parseQuantity(args.quantity, 1);
          if (!quantity) return { success: false, error: 'Please provide a valid quantity of at least 1.' };
          if (quantity > product.stock) return { success: false, error: `Only ${product.stock} unit${product.stock !== 1 ? 's' : ''} of "${product.name}" are available.` };

          const selection = validateProductSelection(product, { selectedColor, selectedOptions });
          if (!selection.ok) {
            return {
              success: false,
              needsSelection: true,
              error: summarizeSelectionRequest(product, selection),
              data: {
                productId: product._id,
                name: product.name,
                requiredOptions: selection.requiredOptions,
                availableColors: selection.availableColors,
                missingOptions: selection.missingOptions,
                invalidOptions: selection.invalidOptions,
              },
            };
          }

          const sourceCurrency = getProductCurrency(product, preferredCurrency);
          const sourcePrice = getProductEffectivePrice(product);
          const effectivePrice = await convertAmount(sourcePrice, sourceCurrency, preferredCurrency);
          orderItems = [{
            productId: product._id,
            id: product._id,
            name: product.name,
            image: product.image,
            price: effectivePrice,
            sourcePrice,
            sourceCurrency,
            quantity,
            selectedColor: selection.selectedColor,
            selectedOptions: selection.selectedOptions,
          }];
        } else {
          // Order from cart
          const cart = await Cart.findOne({ user: userId }).populate('cartItems.product').lean();
          if (!cart || !cart.cartItems?.length) {
            return { success: false, error: 'Cart is empty. Add products first or specify a productId.' };
          }
          const activeSellerSet = new Set((await getActiveSellerIds()).map(normalizeObjectIdString));
          const unavailableItems = cart.cartItems.filter(i => (
            !i.product
            || isProductBlocked(i.product)
            || (normalizeObjectIdString(i.product.seller) && !activeSellerSet.has(normalizeObjectIdString(i.product.seller)))
          ));
          if (unavailableItems.length) {
            return { success: false, error: 'Some items in your cart are no longer available. Please refresh your cart before placing the order.' };
          }
          productItems = cart.cartItems.filter(i => i.product).map(item => item.product);
          orderItems = await Promise.all(cart.cartItems.filter(i => i.product).map(async item => {
            const p = item.product;
            const sourceCurrency = getProductCurrency(p, preferredCurrency);
            const sourcePrice = getProductEffectivePrice(p);
            const price = await convertAmount(sourcePrice, sourceCurrency, preferredCurrency);
            return {
              productId: p._id,
              id: p._id,
              name: p.name,
              image: p.image,
              price,
              sourcePrice,
              sourceCurrency,
              quantity: item.qty || 1,
              selectedColor: item.selectedColor,
              selectedOptions: item.selectedOptions,
            };
          }));
        }

        if (orderItems.length === 0) return { success: false, error: 'No items to order.' };
        const sellerIds = [...new Set(productItems.map(p => normalizeObjectIdString(p.seller)).filter(Boolean))];
        const sellerStores = await Store.find({ seller: { $in: sellerIds }, isActive: true })
          .select('seller storeName paymentPolicy returnPolicy')
          .lean();
        const sellerStoreById = new Map(sellerStores.map(store => [normalizeObjectIdString(store.seller), store]));
        const codRestrictedStores = sellerIds
          .map(sellerId => sellerStoreById.get(sellerId))
          .filter(store => store && !storeAllowsCashOnDelivery(store));
        if (normalizedPaymentMethod === 'cash_on_delivery' && codRestrictedStores.length > 0) {
          const names = codRestrictedStores.map(store => store.storeName || 'a seller');
          return {
            success: false,
            needsPaymentCheckout: true,
            requiresAdvancePayment: true,
            error: `Cash on Delivery is not available because ${names.join(', ')} ${names.length === 1 ? 'accepts' : 'accept'} online payment only. Please use secure checkout with Stripe card or a sufficient same-currency Rozare Wallet balance.`,
            data: { checkoutRoute: '/checkout', advanceOnlySellers: names },
          };
        }

        for (const item of orderItems) {
          const product = productItems.find(p => normalizeObjectIdString(p._id) === normalizeObjectIdString(item.productId));
          if (!product) return { success: false, error: `"${item.name}" is no longer available.` };
          if ((item.quantity || 1) > product.stock) {
            return { success: false, error: `Only ${product.stock} unit${product.stock !== 1 ? 's' : ''} of "${product.name}" are available.` };
          }
          const selection = validateProductSelection(product, {
            selectedColor: item.selectedColor,
            selectedOptions: item.selectedOptions,
          });
          if (!selection.ok) {
            return {
              success: false,
              needsSelection: true,
              error: summarizeSelectionRequest(product, selection),
              data: {
                productId: product._id,
                name: product.name,
                requiredOptions: selection.requiredOptions,
                availableColors: selection.availableColors,
                missingOptions: selection.missingOptions,
                invalidOptions: selection.invalidOptions,
              },
            };
          }
          item.selectedColor = selection.selectedColor;
          item.selectedOptions = selection.selectedOptions;
        }

        const subtotal = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

        // Get tax
        let tax = 0;
        const taxConfig = await TaxConfig.findOne({ isActive: true }).lean();
        if (taxConfig && taxConfig.type !== 'none') {
          tax = taxConfig.type === 'percentage'
            ? subtotal * taxConfig.value / 100
            : await convertAmount(taxConfig.value, 'USD', preferredCurrency);
        }

        // Get shipping method per seller. Cart checkout can contain multiple stores.
        const sellerShipping = [];
        let shippingCost = 0;
        for (const sellerId of sellerIds) {
          let method = { name: 'Standard', price: 0, estimatedDays: 5 };
          const sellerConfig = await ShippingMethod.findOne({ seller: sellerId }).lean();
          const active = sellerConfig?.methods?.find(m => m.isActive);
          if (active) {
            const sellerAccount = active.currency || active.costCurrency
              ? null
              : await User.findById(sellerId).select('currency').lean();
            const shippingCurrency = normalizeCurrency(active.currency || active.costCurrency || sellerAccount?.currency || preferredCurrency);
            method = {
              name: active.type,
              price: await convertAmount(active.cost || 0, shippingCurrency, preferredCurrency),
              estimatedDays: active.deliveryDays || 5,
            };
          }
          sellerShipping.push({ seller: sellerId, shippingMethod: method });
          shippingCost += Number(method.price || 0);
        }
        const shippingMethod = sellerShipping[0]?.shippingMethod || { name: 'Standard', price: 0, estimatedDays: 5 };
        if (sellerIds[0]) shippingMethod.seller = sellerIds[0];

        const subtotalRounded = Math.round(subtotal * 100) / 100;
        const shippingCostRounded = Math.round(shippingCost * 100) / 100;
        const taxRounded = Math.round(tax * 100) / 100;
        const totalAmount = Math.round((subtotalRounded + shippingCostRounded + taxRounded) * 100) / 100;
        const persistedOrderItems = orderItems.map(item => {
          const product = productItems.find(
            candidate => normalizeObjectIdString(candidate._id) === normalizeObjectIdString(item.productId || item.id)
          );
          const sellerId = normalizeObjectIdString(product?.seller);
          const store = sellerStoreById.get(sellerId);
          const returnPolicy = product?.returnPolicy?.useStorePolicy === false
            ? normalizeReturnPolicy(product.returnPolicy)
            : normalizeReturnPolicy(store?.returnPolicy || {});

          return {
            seller: product?.seller || null,
            productId: item.productId || item.id,
            name: item.name,
            image: item.image,
            price: item.price,
            sourcePrice: item.sourcePrice,
            sourceCurrency: item.sourceCurrency,
            quantity: item.quantity,
            selectedColor: item.selectedColor || null,
            selectedOptions: item.selectedOptions || undefined,
            returnPolicySnapshotVersion: 1,
            returnPolicy,
          };
        });

        const newOrder = new Order({
          user: userId,
          currency: preferredCurrency,
          orderId: `ORD-${Date.now()}`,
          orderItems: persistedOrderItems,
          shippingInfo: {
            fullName: shipping.fullName,
            email: shipping.email,
            phone: shipping.phone || '',
            address: shipping.address,
            city: shipping.city,
            state: shipping.state || '',
            postalCode: shipping.postalCode || '',
            country: shipping.country || 'Pakistan',
          },
          shippingMethod,
          sellerShipping,
          orderSummary: {
            subtotal: subtotalRounded,
            shippingCost: shippingCostRounded,
            tax: taxRounded,
            couponDiscount: 0,
            totalAmount,
          },
          sellerFulfillment: sellerIds.map(sellerId => ({
            seller: sellerId,
            status: 'pending',
            deliveredAt: null,
            updatedAt: new Date(),
          })),
          sellerPolicies: sellerIds.map(sellerId => {
            const store = sellerStoreById.get(sellerId);
            return {
              seller: sellerId,
              store: store?._id || null,
              storeName: store?.storeName || '',
              paymentPolicy: store?.paymentPolicy || 'online_and_cod',
              returnPolicy: normalizeReturnPolicy(store?.returnPolicy || {}),
            };
          }),
          paymentMethod: normalizedPaymentMethod,
        });

        newOrder.confirmation = {
          ...generateConfirmationToken(),
          confirmedAt: null,
          confirmedVia: null,
          declinedAt: null,
        };

        await newOrder.save();

        // Decrement stock with a final guard so concurrent orders cannot oversell.
        const decremented = [];
        for (const item of orderItems) {
          const productIdToUpdate = item.productId || item.id;
          const updated = await Product.findOneAndUpdate(
            publicProductFilter({ _id: productIdToUpdate, stock: { $gte: item.quantity } }),
            { $inc: { stock: -item.quantity, totalSales: item.quantity } },
            { new: true }
          );
          if (!updated) {
            for (const prior of decremented) {
              await Product.findByIdAndUpdate(prior.productId, { $inc: { stock: prior.quantity, totalSales: -prior.quantity } });
            }
            await Order.deleteOne({ _id: newOrder._id });
            return { success: false, error: `"${item.name}" is no longer available in the requested quantity. Please refresh the product and try again.` };
          }
          decremented.push({ productId: productIdToUpdate, quantity: item.quantity });
        }
        newOrder.inventoryCommitted = true;
        await newOrder.save();
        await notifyCodOrder(newOrder, productItems);

        // Clear cart if ordering from cart
        if (!productId) {
          await Cart.findOneAndUpdate({ user: userId }, { $set: { cartItems: [] } });
        }

        return {
          success: true,
          data: {
            orderId: newOrder.orderId,
            total: totalAmount,
            currency: preferredCurrency,
            items: orderItems.length,
            paymentMethod: newOrder.paymentMethod,
            estimatedDelivery: `${shippingMethod.estimatedDays} days`,
          },
          message: `🎉 Order placed successfully! Order #${newOrder.orderId} — ${await userMoney(totalAmount)} — ${orderItems.length} item${orderItems.length !== 1 ? 's' : ''} — ${newOrder.paymentMethod === 'cash_on_delivery' ? 'Cash on Delivery' : 'Stripe'} — Est. delivery: ${shippingMethod.estimatedDays} days`,
        };
      }

      case 'get_verification_status': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const store = await Store.findOne({ seller: userId }).select('verification storeName').lean();
        if (!store) return { success: false, error: 'No store found.' };

        return {
          success: true,
          data: {
            isVerified: store.verification?.isVerified || false,
            status: store.verification?.status || 'none',
            appliedAt: store.verification?.appliedAt,
            rejectionReason: store.verification?.rejectionReason || '',
          },
          message: store.verification?.isVerified
            ? `Store "${store.storeName}" is verified! ✅🛡️`
            : store.verification?.status === 'pending'
              ? `Verification pending — submitted ${store.verification.appliedAt ? new Date(store.verification.appliedAt).toLocaleDateString() : 'recently'}.`
              : store.verification?.status === 'rejected'
                ? `Verification rejected: ${store.verification.rejectionReason || 'Does not meet requirements.'}`
                : 'Not yet applied for verification.',
        };
      }

      case 'validate_coupon': {
        const { code, cartTotal } = args;
        if (!code) return { success: false, error: 'Please provide a coupon code.' };

        const now = new Date();
        const coupon = await Coupon.findOne({
          code: code.toUpperCase().trim(),
          isActive: true,
          expiryDate: { $gt: now },
          startDate: { $lte: now },
        }).lean();

        if (!coupon) return { success: false, error: `Coupon "${code}" is invalid or expired.` };
        if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
          return { success: false, error: 'This coupon has reached its usage limit.' };
        }
        const couponCurrency = normalizeCurrency(coupon.currency || 'USD');
        const cartTotalInCouponCurrency = cartTotal
          ? await convertAmount(Number(cartTotal), preferredCurrency, couponCurrency)
          : 0;
        if (cartTotal && coupon.minOrderAmount > cartTotalInCouponCurrency) {
          return { success: false, error: `Minimum order amount is ${await userMoney(coupon.minOrderAmount, couponCurrency)}.` };
        }

        let discountInCouponCurrency = coupon.discountType === 'percentage'
          ? (cartTotal ? cartTotalInCouponCurrency * coupon.discountValue / 100 : coupon.discountValue)
          : coupon.discountValue;
        if (coupon.maxDiscountAmount && discountInCouponCurrency > coupon.maxDiscountAmount) {
          discountInCouponCurrency = coupon.maxDiscountAmount;
        }
        const discount = await convertAmount(discountInCouponCurrency, couponCurrency, preferredCurrency);

        return {
          success: true,
          data: { code: coupon.code, discount, currency: preferredCurrency, type: coupon.discountType, value: coupon.discountValue, couponCurrency },
          message: `Coupon "${coupon.code}" is valid! ${coupon.discountType === 'percentage' ? `${coupon.discountValue}% off` : `${await userMoney(coupon.discountValue, couponCurrency)} off`}`,
        };
      }

      // ─────────────────────────────────────────────
      //  SELLER TOOLS
      // ─────────────────────────────────────────────

      case 'add_product': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const targetSellerId = role === 'admin' ? toId(args.sellerId || args.seller) : userId;
        if (role === 'admin' && !targetSellerId) {
          return { success: false, error: 'Please provide sellerId so the product can be assigned to a seller.' };
        }
        const store = await Store.findOne({ seller: targetSellerId }).select('_id storeName').lean();
        if (!store) return { success: false, error: 'You need to create a store first.' };
        const productCurrencyState = await assertProductCreationAllowed(targetSellerId);
        const productEntryCurrency = productCurrencyState.activeCurrency;
        if (role === 'seller') {
          const createCheck = await sellerCanCreateProducts(targetSellerId, 1);
          if (!createCheck.allowed) {
            return {
              success: false,
              blocked: true,
              error: createCheck.reason === 'trial_limit_reached'
                ? `You have reached the maximum of ${createCheck.max} product listings during your free trial. Subscribe to add unlimited products.`
                : 'Product creation is temporarily unavailable. Please try again.',
              data: { productLimit: createCheck },
            };
          }
        }

        const p = args.product || args;
        const name = sanitizeProductName(cleanAIField(p.name, { maxLength: 140 }));
        const category = cleanAIField(p.category, { maxLength: 80 });
        const brand = cleanAIField(p.brand, { maxLength: 80 });
        const description = sanitizeProductDescription(cleanAIParagraph(p.description) || name);
        const missing = [];
        if (!name) missing.push('name');
        if (!description) missing.push('description');
        if (!p.price && p.price !== 0) missing.push('price');
        if (!category) missing.push('category');
        if (!brand) missing.push('brand');
        if (missing.length) {
          return { success: false, error: `Missing required fields: ${missing.join(', ')}`, missingFields: missing };
        }
        const lastUserText = cleanString(args._lastUserText);
        const inputCurrency = resolveAIPriceCurrency({
          value: p.price,
          requestedCurrency: p.currency || args.currency,
          preferredCurrency: productEntryCurrency,
          lastUserText,
        });
        const priceInput = parseMoneyInput(p.price, inputCurrency);
        const rawPrice = priceInput.amount;
        const stock = p.stock != null ? Number(p.stock) : 0;
        const discountedCurrency = resolveAIPriceCurrency({
          value: p.discountedPrice,
          requestedCurrency: p.discountedCurrency || p.currency || args.currency,
          preferredCurrency: productEntryCurrency,
          fallbackCurrency: inputCurrency,
          lastUserText,
        });
        const discountInput = p.discountedPrice
          ? parseMoneyInput(p.discountedPrice, discountedCurrency)
          : { amount: 0, currency: inputCurrency };
        const rawDiscountedPrice = discountInput.amount;
        if (!Number.isFinite(rawPrice) || rawPrice < 0) return { success: false, error: 'Product price must be a non-negative number.' };
        if (!Number.isFinite(stock) || stock < 0) return { success: false, error: 'Product stock must be a non-negative number.' };
        if (!Number.isFinite(rawDiscountedPrice) || rawDiscountedPrice < 0) return { success: false, error: 'Discounted price must be a non-negative number.' };
        const price = await convertAmount(rawPrice, priceInput.currency, productEntryCurrency);
        const discountedPrice = rawDiscountedPrice > 0
          ? await convertAmount(rawDiscountedPrice, discountInput.currency, productEntryCurrency)
          : 0;
        if (discountedPrice > 0 && discountedPrice >= price) return { success: false, error: 'Discounted price must be lower than the product price.' };

        const confirmDuplicate = args.confirmDuplicate === true || p.confirmDuplicate === true;
        const duplicate = await Product.findOne({
          seller: targetSellerId,
          name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' },
          brand: { $regex: `^${escapeRegExp(brand)}$`, $options: 'i' },
        }).select('_id name brand price currency priceCurrency stock category createdAt').lean();

        if (duplicate && !confirmDuplicate) {
          return {
            success: false,
            blocked: true,
            requiresConfirmation: true,
            duplicate: true,
            error: `A product named "${duplicate.name}" by ${duplicate.brand} already exists in this store. I did not add another copy. Confirm if you intentionally want a duplicate listing.`,
            data: {
              existingProduct: {
                productId: duplicate._id,
                name: duplicate.name,
                brand: duplicate.brand,
                price: duplicate.price,
                currency: getProductCurrency(duplicate, productEntryCurrency),
                stock: duplicate.stock,
                category: duplicate.category,
                createdAt: duplicate.createdAt,
              },
            },
          };
        }

        const colors = normalizeStringArray(p.colors || p.colorOptions, { splitSpacesForColors: true });
        const optionGroups = addColorOptionGroup(normalizeOptionGroups(p.optionGroups || p.options), colors);
        const { image, images } = buildProductImageFields(p);
        const tags = normalizeTags(p.tags, {
          name,
          brand,
          category,
          description,
          colors,
        });
        let isFeatured = p.isFeatured === true;
        if (isFeatured && role === 'seller') {
          const featCheck = await sellerCanFeatureProduct(userId);
          if (!featCheck.allowed) {
            return {
              success: false,
              blocked: true,
              error: featCheck.reason === 'limit_reached'
                ? `You've reached your featured product limit (${featCheck.max}). Add the product without featuring it, or unfeature another product first.`
                : 'Your current subscription does not allow featuring products right now.',
              data: { featuredStats: featCheck },
            };
          }
        }

        let productReturnPolicy;
        if (Object.keys(pickObject(p.returnPolicy)).length) {
          try {
            productReturnPolicy = normalizeProductReturnPolicy(p.returnPolicy, { strict: true });
          } catch (error) {
            return { success: false, error: error.message || 'The product return policy is invalid.' };
          }
        }

        const productData = {
          name,
          description,
          price,
          discountedPrice,
          currency: productEntryCurrency,
          priceCurrency: productEntryCurrency,
          priceInputAmount: price,
          discountedPriceCurrency: productEntryCurrency,
          discountedPriceInputAmount: discountedPrice > 0 ? discountedPrice : 0,
          priceVersion: 2,
          category,
          brand,
          stock,
          image,
          images,
          tags,
          colors,
          optionGroups,
          isFeatured,
          createdVia: p.createdVia === 'import' || args.createdVia === 'import' ? 'import' : 'ai',
          ...(productReturnPolicy ? { returnPolicy: productReturnPolicy } : {}),
          seller: targetSellerId,
        };
        const { fields: moderationFields } = buildModerationFields(productData);
        const product = await Product.create({
          ...productData,
          ...moderationFields,
        });
        if (isProductBlocked(product)) {
          await notifyProductBlocked({ sellerId: targetSellerId, product });
        }
        const conversionNotice = await buildProductCurrencyConversionNotice({
          sourceAmount: rawPrice,
          sourceCurrency: priceInput.currency,
          savedAmount: product.price,
          productCurrency: productEntryCurrency,
        });

        return {
          success: true,
          data: {
            productId: product._id,
            name: product.name,
            price: product.price,
            currency: product.currency,
            priceCurrency: product.priceCurrency,
            inputPrice: product.priceInputAmount,
            priceInputAmount: product.priceInputAmount,
            discountedPrice: product.discountedPrice,
            discountedPriceCurrency: product.discountedPriceCurrency,
            discountedPriceInputAmount: product.discountedPriceInputAmount,
            displayPrice: await formatMoney(product.price, productEntryCurrency, { sourceCurrency: productEntryCurrency }),
            stock: product.stock,
            category: product.category,
            brand: product.brand,
            image: product.image,
            images: product.images,
            tags: product.tags,
            colors: product.colors,
            optionGroups: product.optionGroups,
            isFeatured: product.isFeatured,
            createdVia: product.createdVia,
            returnPolicy: product.returnPolicy,
            blocked: isProductBlocked(product),
            moderationReason: product.moderationReason || product.blockedReason || '',
          },
          message: isProductBlocked(product)
            ? `Product "${product.name}" was saved to your Products tab, but it is blocked because ${product.blockedReason || product.moderationReason}. Customers cannot see it until you edit it with real product details.`
            : `${conversionNotice}Product "${product.name}" added to your store "${store.storeName}" at ${await formatMoneyWithCode(product.price, productEntryCurrency)}!`,
        };
      }

      case 'bulk_add_products': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const rawProducts = Array.isArray(args.products)
          ? args.products
          : Array.isArray(args.items)
            ? args.items
            : [];
        const productsToAdd = rawProducts
          .map(item => pickObject(item))
          .filter(item => Object.keys(item).length > 0)
          .slice(0, 50);

        if (!productsToAdd.length) {
          return { success: false, error: 'No products were provided for import.' };
        }

        const targetSellerId = role === 'admin' ? toId(args.sellerId || args.seller) : userId;
        if (role === 'admin' && !targetSellerId) {
          return { success: false, error: 'Please provide sellerId so the imported products can be assigned to a seller.' };
        }

        if (role === 'seller') {
          const createCheck = await sellerCanCreateProducts(targetSellerId, productsToAdd.length);
          if (!createCheck.allowed) {
            return {
              success: false,
              blocked: true,
              error: `This import contains ${productsToAdd.length} products, but your free trial has room for ${createCheck.remaining}. Import fewer products or subscribe to add unlimited products.`,
              data: { productLimit: createCheck },
            };
          }
        }

        const results = [];
        for (let index = 0; index < productsToAdd.length; index += 1) {
          const item = productsToAdd[index];
          const result = await executeToolCall('add_product', {
            ...item,
            sellerId: targetSellerId,
            currency: item.currency || args.currency,
            _lastUserText: args._lastUserText,
            createdVia: 'import',
            confirmDuplicate: item.confirmDuplicate === true || args.confirmDuplicate === true,
          }, user);
          results.push({
            index,
            success: result.success === true,
            productId: result.data?.productId || null,
            name: result.data?.name || item.name || '',
            error: result.success === true ? '' : (result.error || result.message || 'Failed to add product.'),
            blocked: result.blocked === true,
            duplicate: result.duplicate === true,
            data: result.data,
          });
        }

        const added = results.filter(r => r.success).length;
        const failed = results.length - added;

        return {
          success: added > 0 && failed === 0,
          blocked: failed > 0,
          data: {
            added,
            failed,
            total: results.length,
            results,
            products: results.filter(r => r.success).map(r => r.data).filter(Boolean),
          },
          message: failed
            ? `Imported ${added} of ${results.length} products. ${failed} row${failed !== 1 ? 's' : ''} need attention.`
            : `Imported ${added} product${added !== 1 ? 's' : ''} successfully.`,
        };
      }

      case 'edit_product': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const productId = args.productId;
        const productName = cleanAIField(args.productName, { maxLength: 140 });
        const incomingUpdates = Object.keys(pickObject(args.updates)).length ? args.updates : args;
        const allowedProductFields = ['name', 'description', 'price', 'discountedPrice', 'currency', 'priceCurrency', 'category', 'brand', 'stock', 'image', 'imageUrl', 'images', 'tags', 'colors', 'optionGroups', 'returnPolicy', 'isFeatured'];
        const updates = {};
        for (const field of allowedProductFields) {
          if (incomingUpdates[field] !== undefined) updates[field] = incomingUpdates[field];
        }
        const explicitDiscountUpdate = updates.discountedPrice !== undefined;
        if (!productId && !productName) return { success: false, error: 'Please specify which product to edit (productId or productName).' };
        if (Object.keys(updates).length === 0) return { success: false, error: 'No valid product fields were provided to update.' };
        const lastUserText = cleanString(args._lastUserText);
        const inputCurrency = resolveAIPriceCurrency({
          value: updates.price ?? updates.discountedPrice,
          requestedCurrency: args.currency || incomingUpdates.currency,
          preferredCurrency,
          lastUserText,
        });
        for (const textField of ['name', 'category', 'brand']) {
          if (updates[textField] !== undefined) {
            updates[textField] = cleanAIField(updates[textField], { maxLength: textField === 'name' ? 140 : 80 });
            if (!updates[textField]) return { success: false, error: `${textField} cannot be empty.` };
          }
        }
        if (updates.description !== undefined) {
          updates.description = sanitizeProductDescription(cleanAIParagraph(updates.description));
          if (!updates.description) return { success: false, error: 'description cannot be empty.' };
        }
        if (updates.name !== undefined) {
          updates.name = sanitizeProductName(updates.name);
          if (!updates.name) return { success: false, error: 'name cannot be empty.' };
        }
        for (const numericField of ['price', 'discountedPrice', 'stock']) {
          if (updates[numericField] !== undefined) {
            const fieldCurrency = ['price', 'discountedPrice'].includes(numericField)
              ? resolveAIPriceCurrency({
                value: updates[numericField],
                requestedCurrency: incomingUpdates[`${numericField}Currency`] || args.currency || incomingUpdates.currency,
                preferredCurrency: inputCurrency,
                fallbackCurrency: inputCurrency,
                lastUserText,
              })
              : inputCurrency;
            const parsedMoney = ['price', 'discountedPrice'].includes(numericField)
              ? parseMoneyInput(updates[numericField], fieldCurrency)
              : null;
            const numericValue = parsedMoney ? parsedMoney.amount : Number(updates[numericField]);
            if (!Number.isFinite(numericValue) || numericValue < 0) {
              return { success: false, error: `${numericField} must be a non-negative number.` };
            }
            updates[numericField] = ['price', 'discountedPrice'].includes(numericField)
              ? roundMoney(numericValue)
              : numericValue;
            if (numericField === 'price') {
              updates.priceCurrency = parsedMoney.currency;
              updates.currency = parsedMoney.currency;
              updates.priceInputAmount = updates.price;
              updates.priceVersion = 2;
            } else if (numericField === 'discountedPrice') {
              updates.discountedPriceCurrency = parsedMoney.currency;
              updates.discountedPriceInputAmount = updates.discountedPrice;
              updates.priceVersion = 2;
            }
          }
        }
        if (updates.currency !== undefined || updates.priceCurrency !== undefined) {
          const normalizedUpdateCurrency = normalizeCurrency(updates.currency || updates.priceCurrency || inputCurrency);
          updates.currency = normalizedUpdateCurrency;
          updates.priceCurrency = normalizedUpdateCurrency;
        }

        if (updates.images !== undefined || updates.image !== undefined || updates.imageUrl !== undefined) {
          const imageFields = buildProductImageFields({ ...updates, image: updates.image || updates.imageUrl });
          updates.image = imageFields.image;
          updates.images = imageFields.images;
          delete updates.imageUrl;
        }
        if (updates.tags !== undefined) updates.tags = normalizeTags(updates.tags);
        if (updates.colors !== undefined) updates.colors = normalizeStringArray(updates.colors, { splitSpacesForColors: true });
        if (updates.optionGroups !== undefined) updates.optionGroups = normalizeOptionGroups(updates.optionGroups);
        if (updates.returnPolicy !== undefined) {
          try {
            updates.returnPolicy = normalizeProductReturnPolicy(updates.returnPolicy, { strict: true });
          } catch (error) {
            return { success: false, error: error.message || 'The product return policy is invalid.' };
          }
        }

        let safeProductId = toId(productId);
        if (!safeProductId && productName) {
          const candidates = await resolveProductCandidates({ role, userId, args, productName });
          if (!candidates.length) {
            return {
              success: false,
              error: `I couldn't find a product matching "${productName}" in your store. Try a broader word like the brand, category, or ask me to list matching products first.`,
            };
          }
          if (candidates.length > 1) {
            return {
              success: false,
              blocked: true,
              requiresSelection: true,
              error: `I found ${candidates.length} products that could match "${productName}". Please choose by name, price, or latest/oldest wording before I edit anything.`,
              data: { matches: candidates.map(formatProductCandidate) },
            };
          }
          safeProductId = candidates[0]._id;
        }
        const filter = role === 'admin' ? {} : { seller: userId };
        if (safeProductId) {
          filter._id = safeProductId;
        } else {
          filter.name = { $regex: `^${escapeRegExp(productName)}$`, $options: 'i' };
        }
        if (role === 'admin' && toId(args.sellerId || args.seller)) {
          filter.seller = toId(args.sellerId || args.seller);
        }

        if (updates.colors?.length) {
          if (updates.optionGroups !== undefined) {
            updates.optionGroups = addColorOptionGroup(updates.optionGroups, updates.colors);
          } else {
            const existingProduct = await Product.findOne(filter).select('optionGroups').lean();
            updates.optionGroups = addColorOptionGroup(existingProduct?.optionGroups || [], updates.colors);
          }
        }

        if (updates.isFeatured === true && role === 'seller') {
          const existingProduct = await Product.findOne(filter).select('_id isFeatured').lean();
          if (!existingProduct) return { success: false, error: 'Product not found or you don\'t own it.' };
          if (!existingProduct.isFeatured) {
            const featCheck = await sellerCanFeatureProduct(userId, existingProduct._id);
            if (!featCheck.allowed) {
              return {
                success: false,
                blocked: true,
                error: featCheck.reason === 'limit_reached'
                  ? `You've reached your featured product limit (${featCheck.max}). Unfeature another product or upgrade your plan to feature more.`
                  : 'Your current subscription does not allow featuring products right now.',
                data: { featuredStats: featCheck },
              };
            }
          }
        }

        const existingForModeration = await Product.findOne(filter)
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean();
        if (!existingForModeration) return { success: false, error: 'Product not found or you don\'t own it.' };
        const existingCurrency = getProductCurrency(existingForModeration, preferredCurrency);
        const nextCurrency = normalizeCurrency(updates.currency || updates.priceCurrency || existingCurrency);

        if ((updates.currency !== undefined || updates.priceCurrency !== undefined) && updates.price === undefined) {
          updates.price = await convertAmount(existingForModeration.price, existingCurrency, nextCurrency);
          updates.priceInputAmount = updates.price;
          if (existingForModeration.discountedPrice > 0 && updates.discountedPrice === undefined) {
            updates.discountedPrice = await convertAmount(existingForModeration.discountedPrice, existingCurrency, nextCurrency);
            updates.discountedPriceInputAmount = updates.discountedPrice;
          }
        }

        if (updates.price !== undefined) {
          const sourceCurrency = normalizeCurrency(updates.priceCurrency || updates.currency || nextCurrency);
          updates.price = await convertAmount(updates.price, sourceCurrency, nextCurrency);
          updates.currency = nextCurrency;
          updates.priceCurrency = nextCurrency;
          updates.priceInputAmount = updates.price;
          updates.priceVersion = 2;
        }

        if (updates.discountedPrice !== undefined) {
          const sourceCurrency = normalizeCurrency(updates.discountedPriceCurrency || updates.currency || nextCurrency);
          updates.discountedPrice = updates.discountedPrice > 0
            ? await convertAmount(updates.discountedPrice, sourceCurrency, nextCurrency)
            : 0;
          updates.discountedPriceCurrency = nextCurrency;
          updates.discountedPriceInputAmount = updates.discountedPrice;
          updates.priceVersion = 2;
        } else if (updates.price !== undefined && existingForModeration.discountedPrice > 0) {
          const existingDiscount = await convertAmount(existingForModeration.discountedPrice, existingCurrency, nextCurrency);
          if (existingDiscount >= updates.price) {
            updates.discountedPrice = 0;
            updates.discountedPriceCurrency = nextCurrency;
            updates.discountedPriceInputAmount = 0;
          }
        }

        const finalPrice = updates.price !== undefined ? updates.price : existingForModeration.price;
        if (updates.discountedPrice > 0 && updates.discountedPrice >= finalPrice) {
          if (explicitDiscountUpdate) return { success: false, error: 'Discounted price must be lower than the product price.' };
          updates.discountedPrice = 0;
          updates.discountedPriceInputAmount = 0;
        }

        const wasBlocked = isProductBlocked(existingForModeration);
        const { fields: moderationFields } = buildModerationFields({
          ...existingForModeration,
          ...updates,
        });
        Object.assign(updates, moderationFields);

        const product = await Product.findOneAndUpdate(
          filter,
          { $set: updates },
          { new: true, runValidators: true, sort: { updatedAt: -1, createdAt: -1 } }
        ).select('name price discountedPrice currency priceCurrency priceInputAmount discountedPriceCurrency discountedPriceInputAmount stock category brand image images tags colors optionGroups returnPolicy isFeatured seller isBlocked blockedReason moderationStatus moderationReason').lean();

        if (!product) return { success: false, error: 'Product not found or you don\'t own it.' };
        if (isProductBlocked(product) && !wasBlocked) {
          notifyProductBlocked({ sellerId: product.seller, product }).catch(err =>
            console.error('[aiActionExecutor] product blocked notification failed:', err.message)
          );
        }
        return {
          success: true,
          data: product,
          blocked: isProductBlocked(product),
          message: isProductBlocked(product)
            ? `Product "${product.name}" was updated, but it is blocked because ${product.blockedReason || product.moderationReason}. Customers cannot see it until it has real product details.`
            : wasBlocked
              ? `Product "${product.name}" updated successfully and is available to customers again.`
              : `Product "${product.name}" updated successfully! ✅`,
        };
      }

      case 'delete_product': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productId, productIds, productName, productNames, deleteAllMatches } = args;
        const products = await resolveProductCandidates({
          role,
          userId,
          args,
          productId,
          productIds,
          productName,
          productNames,
          excludeProductId: args.excludeProductId,
          keepProductId: args.keepProductId,
        });

        if (!products.length) {
          return {
            success: false,
            error: productName || productNames?.length
              ? 'I could not find a matching product in your store. Try the product name as it appears in your dashboard.'
              : 'Please specify the product by name or let me search your products first.',
          };
        }

        const explicitIds = productId || (Array.isArray(productIds) && productIds.length > 0);
        const explicitNames = Array.isArray(productNames) && productNames.length > 1;
        if (products.length > 1 && !explicitIds && !explicitNames && deleteAllMatches !== true) {
          return {
            success: false,
            blocked: true,
            requiresSelection: true,
            error: `I found ${products.length} matching products. I did not delete anything yet. Please confirm which ones to remove by name, price, or "all matching".`,
            data: { matches: products.map(formatProductCandidate) },
          };
        }

        const deleteFilter = productLookupBaseFilter(role, userId, args);
        deleteFilter._id = { $in: products.map(p => p._id) };
        const result = await Product.deleteMany(deleteFilter);
        const deleted = products.map(formatProductCandidate);
        return {
          success: true,
          data: { deleted, deletedCount: result.deletedCount },
          message: result.deletedCount === 1
            ? `Deleted "${deleted[0].name}" from your store.`
            : `Deleted ${result.deletedCount} products: ${deleted.map(p => `"${p.name}"`).join(', ')}.`,
        };
      }

      case 'feature_product': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productId, productName } = args;
        const featured = args.featured !== false;
        const products = await resolveProductCandidates({ role, userId, args, productId, productName });

        if (!products.length) {
          return { success: false, error: 'I could not find that product in your store. Tell me the product name and I can look it up.' };
        }
        if (products.length > 1 && !productId) {
          return {
            success: false,
            blocked: true,
            requiresSelection: true,
            error: `I found ${products.length} matching products. Please tell me which one to ${featured ? 'feature' : 'unfeature'} using its name, price, or latest/oldest wording.`,
            data: { matches: products.map(formatProductCandidate) },
          };
        }

        const product = products[0];
        if (featured && role === 'seller' && !product.isFeatured) {
          const featCheck = await sellerCanFeatureProduct(userId, product._id);
          if (!featCheck.allowed) {
            return {
              success: false,
              blocked: true,
              error: featCheck.reason === 'limit_reached'
                ? `You've reached your featured product limit (${featCheck.max}). Unfeature another product or upgrade your plan to feature more.`
                : 'Your current subscription does not allow featuring products right now.',
              data: { featuredStats: featCheck },
            };
          }
        }

        const filter = productLookupBaseFilter(role, userId, args);
        filter._id = product._id;
        const updated = await Product.findOneAndUpdate(
          filter,
          { $set: { isFeatured: featured } },
          { new: true, runValidators: true }
        ).select('name brand price currency priceCurrency stock category isFeatured createdAt').lean();

        if (!updated) return { success: false, error: 'Product not found or you don\'t own it.' };
        return {
          success: true,
          data: formatProductCandidate(updated),
          message: featured
            ? `"${updated.name}" is now featured on your store/homepage.`
            : `"${updated.name}" is no longer featured.`,
        };
      }

      case 'list_my_products': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { search, category, limit, page, sortBy } = args;
        const filter = role === 'admin' ? {} : { seller: userId };
        if (category) filter.category = { $regex: category, $options: 'i' };

        let sort = { createdAt: -1 };
        if (sortBy === 'name') sort = { name: 1 };

        const skip = (safePage(page) - 1) * safeLimit(limit, 20);
        let matchingProducts = await Product.find(filter).sort(sort)
          .select('name price discountedPrice currency priceCurrency category brand stock image rating numReviews isFeatured tags colors optionGroups description isBlocked blockedReason moderationStatus moderationReason createdAt')
          .lean();
        if (search) matchingProducts = fuzzyProductMatches(matchingProducts, search, 100);
        if (['price_low', 'price_high'].includes(sortBy)) {
          matchingProducts = await attachAIComparablePrices(matchingProducts, preferredCurrency);
          matchingProducts = sortAIProductsByPrice(matchingProducts, sortBy, preferredCurrency);
        }

        const total = matchingProducts.length;
        const products = matchingProducts.slice(skip, skip + safeLimit(limit, 20));

        return {
          success: true,
          data: { products, total, page: safePage(page) },
          message: `You have ${total} product${total !== 1 ? 's' : ''}${search ? ` matching "${search}"` : ''}. Showing ${products.length}.`,
        };
      }

      case 'bulk_discount': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productIds, category: cat } = args;
        const discountType = args.discountType || (args.discountPercent != null ? 'percentage' : 'percentage');
        const discountValue = args.discountValue != null ? Number(args.discountValue) : Number(args.discountPercent);
        if (!Number.isFinite(discountValue) || discountValue <= 0) return { success: false, error: 'Please specify a positive discount value.' };
        if (!['percentage', 'fixed'].includes(discountType)) return { success: false, error: 'Discount type must be percentage or fixed.' };
        if (discountType === 'percentage' && discountValue > 100) return { success: false, error: 'Percentage discounts cannot exceed 100%.' };
        const inputCurrency = normalizeCurrency(args.currency || preferredCurrency);

        const filter = role === 'admin' ? {} : { seller: userId };
        if (productIds?.length) filter._id = { $in: productIds.map(toId).filter(Boolean) };
        else if (cat) filter.category = { $regex: cat, $options: 'i' };

        const products = await Product.find(filter).select('price currency priceCurrency').lean();
        if (!products.length) return { success: false, error: 'No matching products found.' };

        const bulkOps = await Promise.all(products.map(async p => {
          const productCurrency = getProductCurrency(p, inputCurrency);
          const fixedDiscount = discountType === 'fixed'
            ? await convertAmount(discountValue, inputCurrency, productCurrency)
            : 0;
          const discountedPrice = discountType === 'percentage'
            ? Math.round(p.price * (1 - discountValue / 100) * 100) / 100
            : Math.max(0, Math.round((p.price - fixedDiscount) * 100) / 100);
          return {
            updateOne: {
              filter: { _id: p._id },
              update: {
                $set: {
                  discountedPrice,
                  discountedPriceCurrency: productCurrency,
                  discountedPriceInputAmount: discountedPrice,
                  priceVersion: 2,
                },
              },
            },
          };
        }));
        await Product.bulkWrite(bulkOps);

        return {
          success: true,
          message: `Applied ${discountType === 'percentage' ? `${discountValue}%` : await formatMoney(discountValue, inputCurrency, { sourceCurrency: inputCurrency })} discount to ${products.length} product${products.length !== 1 ? 's' : ''}!`,
        };
      }

      case 'bulk_price_update': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productIds, category: cat } = args;
        const updateType = args.updateType || (args.isPercent ? 'percentage' : 'fixed');
        const value = args.value != null ? Number(args.value) : Number(args.priceChange);
        if (!Number.isFinite(value)) return { success: false, error: 'Please specify a valid price update value.' };
        if (!['percentage', 'fixed', 'set'].includes(updateType)) return { success: false, error: 'Price update type must be percentage, fixed, or set.' };
        const inputCurrency = normalizeCurrency(args.currency || preferredCurrency);

        const filter = role === 'admin' ? {} : { seller: userId };
        if (productIds?.length) filter._id = { $in: productIds.map(toId).filter(Boolean) };
        else if (cat) filter.category = { $regex: cat, $options: 'i' };

        const products = await Product.find(filter).select('price discountedPrice currency priceCurrency').lean();
        if (!products.length) return { success: false, error: 'No matching products found.' };

        const bulkOps = await Promise.all(products.map(async p => {
          const productCurrency = getProductCurrency(p, inputCurrency);
          const convertedValue = updateType === 'percentage'
            ? value
            : await convertAmount(value, inputCurrency, productCurrency);
          let newPrice;
          if (updateType === 'set') newPrice = convertedValue;
          else if (updateType === 'percentage') newPrice = p.price + (p.price * value / 100);
          else newPrice = p.price + convertedValue;
          newPrice = Math.max(0, Math.round(newPrice * 100) / 100);
          const update = {
            price: newPrice,
            currency: productCurrency,
            priceCurrency: productCurrency,
            priceInputAmount: newPrice,
            priceVersion: 2,
          };
          if (p.discountedPrice > 0 && p.discountedPrice >= newPrice) {
            update.discountedPrice = 0;
            update.discountedPriceInputAmount = 0;
            update.discountedPriceCurrency = productCurrency;
          }
          return {
            updateOne: {
              filter: { _id: p._id },
              update: { $set: update },
            },
          };
        }));
        await Product.bulkWrite(bulkOps);

        return {
          success: true,
          message: `Updated prices for ${products.length} product${products.length !== 1 ? 's' : ''} (${updateType}: ${value}).`,
        };
      }

      case 'remove_discount': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productIds, category: cat } = args;
        const filter = role === 'admin' ? {} : { seller: userId };
        if (productIds?.length) filter._id = { $in: productIds.map(toId).filter(Boolean) };
        else if (cat) filter.category = { $regex: cat, $options: 'i' };

        const result = await Product.updateMany(filter, { $set: { discountedPrice: 0 } });
        return {
          success: true,
          message: `Removed discounts from ${result.modifiedCount} product${result.modifiedCount !== 1 ? 's' : ''}.`,
        };
      }

      case 'get_seller_analytics': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const store = await Store.findOne({ seller: userId }).select('storeName views trustCount').lean();

        const myProducts = await Product.find({ seller: userId }).select('_id').lean();
        const productIds = myProducts.map(p => p._id);

        const orders = await Order.find({ 'orderItems.productId': { $in: productIds } })
          .select('orderSummary orderStatus createdAt orderItems currency')
          .lean();

        // CRITICAL: Calculate revenue from ONLY this seller's items, not the full order total.
        let totalRevenue = 0;
        for (const order of orders.filter(o => o.orderStatus !== 'cancelled')) {
          const sellerItemsRevenue = (order.orderItems || [])
            .filter(i => productIds.some(pid => pid.toString() === i.productId?.toString()))
            .reduce((sum, item) => sum + (item.price || 0) * (item.quantity || 1), 0);
          totalRevenue += await convertAmount(sellerItemsRevenue, order.currency || preferredCurrency, preferredCurrency);
        }

        const statusCounts = {};
        orders.forEach(o => {
          statusCounts[o.orderStatus] = (statusCounts[o.orderStatus] || 0) + 1;
        });

        // Top products by order frequency
        const productFreq = {};
        orders.forEach(o => {
          (o.orderItems || []).forEach(item => {
            if (productIds.some(pid => pid.toString() === item.productId?.toString())) {
              const key = item.name || item.productId?.toString();
              productFreq[key] = (productFreq[key] || 0) + item.quantity;
            }
          });
        });
        const topProducts = Object.entries(productFreq)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, sold]) => ({ name, sold }));

        // Low stock alerts
        const lowStock = await Product.find({ seller: userId, stock: { $lt: 5, $gt: 0 } })
          .select('name stock')
          .lean();

        return {
          success: true,
          data: {
            storeName: store?.storeName,
            totalProducts: myProducts.length,
            totalOrders: orders.length,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            currency: preferredCurrency,
            storeViews: store?.views || 0,
            trustCount: store?.trustCount || 0,
            ordersByStatus: statusCounts,
            topProducts,
            lowStockAlerts: lowStock.map(p => ({ name: p.name, stock: p.stock })),
          },
          message: `📊 Store "${store?.storeName}": ${myProducts.length} products, ${orders.length} orders, ${await userMoney(totalRevenue, preferredCurrency)} revenue, ${store?.views || 0} views.`,
        };
      }

      case 'get_seller_payments': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const targetSellerId = role === 'admin' && args.sellerId ? toId(args.sellerId) : userId;
        if (!targetSellerId) return { success: false, error: 'Seller not found.' };

        const paymentSummary = await buildSellerPaymentSummary(targetSellerId);
        const revenue = paymentSummary.revenue || {};
        return {
          success: true,
          data: {
            revenue,
            paymentAccountLinked: !!paymentSummary.paymentAccount,
            paymentAccount: paymentSummary.paymentAccount,
            recentWithdrawals: (paymentSummary.withdrawals || []).slice(0, 5).map(w => ({
              amount: w.amount,
              status: w.status,
              requestedAt: w.createdAt,
              adminNote: w.adminNote || '',
            })),
          },
          message: `Payments summary: withdrawable Stripe balance ${await formatMoney(revenue.withdrawableBalance || 0, preferredCurrency)}, delivered COD revenue ${await formatMoney(revenue.codDeliveredRevenue || 0, preferredCurrency)}, total delivered revenue ${await formatMoney(revenue.totalDeliveredRevenue || 0, preferredCurrency)}, estimated revenue ${await formatMoney(revenue.estimatedRevenue || 0, preferredCurrency)}.`,
        };
      }

      case 'get_seller_orders': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { status, limit } = args;

        const myProducts = await Product.find({ seller: userId }).select('_id').lean();
        const productIds = myProducts.map(p => p._id);

        const sellerScope = {
          $or: [
            { 'orderItems.seller': userId },
            { 'orderItems.productId': { $in: productIds } },
          ],
        };
        const conditions = [sellerScope, { awaitingPayment: { $ne: true } }];
        if (status && status !== 'all') {
          conditions.push({
            $or: [
              { sellerFulfillment: { $elemMatch: { seller: userId, status } } },
              { 'sellerFulfillment.0': { $exists: false }, orderStatus: status },
            ],
          });
        }
        const filter = { $and: conditions };

        // Get TRUE total count (no limit) for accurate reporting
        const totalCount = await Order.countDocuments(filter);

        const orders = await Order.find(filter)
          .sort({ createdAt: -1 })
          .limit(safeLimit(limit, 20))
          .populate('user', 'username email')
          .lean();

        // Filter items & compute seller-specific totals per order
        const sellerOrders = orders.map(o => {
          const sellerItems = (o.orderItems || []).filter(i =>
            toId(i.seller) === toId(userId) ||
            productIds.some(pid => pid.toString() === (i.productId?._id || i.productId)?.toString())
          );
          const sellerTotal = sellerItems.reduce((sum, i) => sum + (i.price || 0) * (i.quantity || 1), 0);
          const fulfillment = getSellerFulfillment(o, userId);
          return {
            orderId: o.orderId,
            status: fulfillment?.status || o.orderStatus,
            buyer: o.user?.username || o.guestEmail || 'Guest',
            total: sellerTotal,
            itemCount: sellerItems.length,
            date: o.createdAt,
            paymentMethod: o.paymentMethod,
            isPaid: o.isPaid,
          };
        });

        return {
          success: true,
          data: { orders: sellerOrders, count: sellerOrders.length, totalCount },
          message: `You have ${totalCount} total order${totalCount !== 1 ? 's' : ''}${status ? ` with status "${status}"` : ''} for your store (showing ${sellerOrders.length}).`,
        };
      }

      case 'update_order_status': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { orderId } = args;
        const newStatus = args.newStatus || args.status;
        if (!orderId || !newStatus) return { success: false, error: 'Please provide orderId and new status.' };

        const validStatuses = ['confirmed', 'processing', 'shipped', 'delivered'];
        if (!validStatuses.includes(newStatus)) {
          return { success: false, error: `Invalid status. Valid: ${validStatuses.join(', ')}` };
        }

        // Verify seller owns products in this order. Admins can update any order.
        const productIds = role === 'admin'
          ? []
          : (await Product.find({ seller: userId }).select('_id').lean()).map(p => p._id.toString());

        const order = await Order.findOne({
          $or: [{ _id: toId(orderId) }, { orderId: orderId }],
        });
        if (!order) return { success: false, error: 'Order not found.' };

        const ownsItems = role === 'admin' || order.orderItems.some(i => (
          toId(i.seller) === toId(userId) || productIds.includes(i.productId?.toString())
        ));
        if (!ownsItems) return { success: false, error: 'This order doesn\'t contain your products.' };

        await ensureOrderSellerFulfillment(order);
        if (role === 'admin') {
          setAllSellerFulfillmentStatus(order, newStatus);
        } else if (!setSellerFulfillmentStatus(order, userId, newStatus)) {
          return { success: false, error: 'Seller fulfillment record was not found for this order.' };
        }
        syncAggregateDeliveryState(order);
        if (order.orderStatus === 'delivered') order.isPaid = true;
        await order.save();

        return {
          success: true,
          data: {
            status: role === 'seller' ? getSellerFulfillment(order, userId)?.status : order.orderStatus,
            aggregateOrderStatus: order.orderStatus,
          },
          message: `Order #${order.orderId} status updated to "${newStatus}"`,
        };
      }

      case 'get_my_store': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const store = await Store.findOne({ seller: userId }).lean();
        if (!store) return { success: false, error: 'You don\'t have a store yet.' };

        const productCount = await Product.countDocuments({ seller: userId });
        const storeUrl = store.storeSlug ? `https://${store.storeSlug}.rozare.com/` : null;
        return {
          success: true,
          data: {
            storeName: store.storeName,
            slug: store.storeSlug,
            storeUrl,
            description: store.description,
            sellerType: store.sellerType,
            logo: store.logo,
            banner: store.banner,
            isActive: store.isActive,
            views: store.views,
            trustCount: store.trustCount,
            verification: store.verification,
            socialLinks: store.socialLinks,
            returnPolicy: store.returnPolicy,
            paymentPolicy: store.paymentPolicy || 'online_and_cod',
            productCount,
            changeLimits: storeChangeLimits(store),
            createdAt: store.createdAt,
          },
          message: `Your store "${store.storeName}" - ${store.verification?.isVerified ? 'verified' : 'not verified'} - ${productCount} products, ${store.views} views${storeUrl ? ` - ${storeUrl}` : ''}.`,
        };
      }

      case 'update_store': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const normalizedRaw = Object.keys(pickObject(args.updates)).length ? { ...args.updates } : { ...args };
        const allowedStoreFields = ['storeName', 'storeSlug', 'description', 'logo', 'banner', 'socialLinks', 'address', 'returnPolicy', 'sellerType', 'paymentPolicy'];
        const normalizedUpdates = {};
        for (const field of allowedStoreFields) {
          if (normalizedRaw[field] !== undefined) normalizedUpdates[field] = normalizedRaw[field];
        }

        const existingStore = await Store.findOne({ seller: userId });
        if (!existingStore) return { success: false, error: 'Store not found.' };

        if (existingStore.isActive === false) {
          return { success: false, error: 'Your store is blocked. Reactivate your subscription before changing store details.' };
        }

        if (normalizedUpdates.storeName !== undefined) {
          const name = cleanAIField(normalizedUpdates.storeName, { maxLength: 50 });
          if (isPlaceholderValue(name)) {
            return { success: false, error: 'No store name was provided. Ask the seller what new store name they want before updating.' };
          }
          if (name.length < 3 || name.length > 50) {
            return { success: false, error: 'Store name must be 3-50 characters.' };
          }
          if (name.toLowerCase() === existingStore.storeName.toLowerCase()) {
            delete normalizedUpdates.storeName;
          } else {
            const cd = cooldownStatus('storeName', existingStore.lastNameChangeAt);
            if (!cd.canChange) {
              return {
                success: false,
                error: `You can change your ${STORE_FIELD_LABELS.storeName} again in ${cd.daysRemaining} day(s). Store names can only be changed once every 7 days.`,
                cooldown: cd,
              };
            }
            const duplicate = await Store.findOne({ storeName: { $regex: new RegExp(`^${escapeRegExp(name)}$`, 'i') }, _id: { $ne: existingStore._id } }).select('_id').lean();
            if (duplicate) return { success: false, error: 'A store with this name already exists.' };
            normalizedUpdates.storeName = name;
            normalizedUpdates.lastNameChangeAt = new Date();
          }
        }

        if (normalizedUpdates.description !== undefined) {
          normalizedUpdates.description = cleanAIParagraph(normalizedUpdates.description, { maxLength: 3000 });
        }

        if (normalizedUpdates.returnPolicy !== undefined) {
          if (!normalizedUpdates.returnPolicy || typeof normalizedUpdates.returnPolicy !== 'object' || Array.isArray(normalizedUpdates.returnPolicy)) {
            return { success: false, error: 'Return policy must include structured settings such as returnsEnabled, returnDuration, and refundType.' };
          }
          try {
            normalizedUpdates.returnPolicy = normalizeReturnPolicy(normalizedUpdates.returnPolicy, { strict: true });
          } catch (error) {
            return { success: false, error: error.message || 'The return policy is invalid.' };
          }
        }

        if (normalizedUpdates.address !== undefined && typeof normalizedUpdates.address === 'string') {
          normalizedUpdates.address = cleanAIField(normalizedUpdates.address, { maxLength: 300 });
        }

        if (normalizedUpdates.storeSlug !== undefined) {
          const slug = sanitizeSubdomain(normalizedUpdates.storeSlug);
          if (isPlaceholderValue(slug)) {
            return { success: false, error: 'No subdomain was provided. Ask the seller what new subdomain they want before updating.' };
          }
          if (slug.length < 3 || slug.length > 63) {
            return { success: false, error: 'Subdomain must be 3-63 characters.' };
          }
          if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
            return { success: false, error: 'Subdomain can only contain lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.' };
          }
          if (RESERVED_SUBDOMAINS.has(slug)) {
            return { success: false, error: 'This subdomain is reserved by the system.' };
          }
          if (slug === existingStore.storeSlug) {
            delete normalizedUpdates.storeSlug;
          } else {
            const cd = cooldownStatus('storeSlug', existingStore.lastSlugChangeAt);
            if (!cd.canChange) {
              return {
                success: false,
                error: `You can change your ${STORE_FIELD_LABELS.storeSlug} again in ${cd.daysRemaining} day(s). Subdomains can only be changed once every 30 days.`,
                cooldown: cd,
              };
            }

            const hasPurchasedSubdomain = !!(existingStore.subdomainPurchase?.isPurchased && existingStore.subdomainPurchase?.expiresAt && new Date(existingStore.subdomainPurchase.expiresAt) > new Date());
            if (hasPurchasedSubdomain && normalizedRaw.confirmSubdomainChange !== true) {
              return {
                success: false,
                requiresConfirmation: true,
                error: `You have purchased "${existingStore.storeSlug}.rozare.com". Changing it will forfeit ownership of the old subdomain. Ask the seller to confirm before proceeding.`,
                currentSubdomain: existingStore.storeSlug,
                newSubdomain: slug,
              };
            }

            const duplicate = await Store.findOne({ storeSlug: slug, _id: { $ne: existingStore._id } }).select('_id').lean();
            if (duplicate) return { success: false, error: 'This subdomain is already taken by another store.' };
            normalizedUpdates.storeSlug = slug;
            normalizedUpdates.lastSlugChangeAt = new Date();
            if (hasPurchasedSubdomain) {
              normalizedUpdates.subdomainPurchase = {
                isPurchased: false,
                purchasedAt: null,
                expiresAt: null,
                stripePaymentId: '',
                removalScheduledAt: null,
              };
            }
          }
        }

        if (normalizedUpdates.sellerType !== undefined) {
          if (!['store', 'brand'].includes(normalizedUpdates.sellerType)) {
            delete normalizedUpdates.sellerType;
          } else if (normalizedUpdates.sellerType === (existingStore.sellerType || 'store')) {
            delete normalizedUpdates.sellerType;
          } else {
            const cd = cooldownStatus('sellerType', existingStore.lastTypeChangeAt);
            if (!cd.canChange) {
              return { success: false, error: `You can change your ${STORE_FIELD_LABELS.sellerType} again in ${cd.daysRemaining} day(s).`, cooldown: cd };
            }
            normalizedUpdates.lastTypeChangeAt = new Date();
          }
        }

        if (normalizedUpdates.paymentPolicy !== undefined) {
          const rawPaymentPolicy = String(normalizedUpdates.paymentPolicy || '').toLowerCase();
          if (['advance_only', 'online_only', 'stripe_only', 'card_only', 'advance', 'prepaid'].includes(rawPaymentPolicy)) {
            normalizedUpdates.paymentPolicy = 'advance_only';
            normalizedUpdates.paymentPolicyUpdatedAt = new Date();
          } else if (['online_and_cod', 'both', 'cod', 'cash_on_delivery', 'cod_and_online'].includes(rawPaymentPolicy)) {
            normalizedUpdates.paymentPolicy = 'online_and_cod';
            normalizedUpdates.paymentPolicyUpdatedAt = new Date();
          } else {
            delete normalizedUpdates.paymentPolicy;
          }
          if (normalizedUpdates.paymentPolicy === (existingStore.paymentPolicy || 'online_and_cod')) {
            delete normalizedUpdates.paymentPolicy;
            delete normalizedUpdates.paymentPolicyUpdatedAt;
          }
        }

        if (normalizedUpdates.socialLinks !== undefined) {
          normalizedUpdates.socialLinks = normalizeSocialLinks(normalizedUpdates.socialLinks);
        }

        if (Object.keys(normalizedUpdates).length === 0) {
          return { success: false, error: 'No changes to apply.' };
        }

        const updatedStore = await Store.findOneAndUpdate(
          { seller: userId },
          { $set: normalizedUpdates },
          { new: true, runValidators: true }
        ).select('storeName storeSlug description paymentPolicy lastNameChangeAt lastSlugChangeAt lastTypeChangeAt').lean();

        return {
          success: true,
          message: `Store "${updatedStore.storeName}" updated successfully.`,
          data: {
            storeName: updatedStore.storeName,
            slug: updatedStore.storeSlug,
            paymentPolicy: updatedStore.paymentPolicy || 'online_and_cod',
            updatedFields: Object.keys(normalizedUpdates).filter(k => !k.startsWith('last')),
            changeLimits: storeChangeLimits(updatedStore),
          },
        };
      }

      case 'get_store_analytics': {
        // Alias — same as get_seller_analytics
        return executeToolCall('get_seller_analytics', args, user);
      }

      case 'apply_for_verification': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const store = await Store.findOne({ seller: userId });
        if (!store) return { success: false, error: 'Create a store first.' };

        if (store.verification?.isVerified) return { success: false, error: 'Your store is already verified! 🎉' };
        if (store.verification?.status === 'pending') return { success: false, error: 'Verification already pending — we\'re reviewing it.' };

        store.verification = {
          ...store.verification,
          status: 'pending',
          appliedAt: new Date(),
          applicationMessage: args.message || '',
          contactEmail: args.contactEmail || '',
          contactPhone: args.contactPhone || '',
        };
        await store.save();

        return { success: true, message: 'Verification application submitted! We\'ll review it soon. 🛡️' };
      }

      case 'get_shipping_methods': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const shipping = await ShippingMethod.findOne({ seller: userId }).lean();
        return {
          success: true,
          data: { methods: shipping?.methods || [] },
          message: shipping?.methods?.length
            ? `You have ${shipping.methods.length} shipping method(s) configured.`
            : 'No shipping methods configured yet.',
        };
      }

      case 'update_shipping': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const shippingUpdates = Object.keys(pickObject(args.updates)).length ? args.updates : args;
        let { method, cost, deliveryDays, isActive } = shippingUpdates;
        if (!method && args.methodId) method = args.methodId;
        if (!method) return { success: false, error: 'Please specify a shipping method type (free, standard, fast).' };
        if (!['free', 'standard', 'fast'].includes(method)) return { success: false, error: 'Shipping method must be free, standard, or fast.' };

        let shipping = await ShippingMethod.findOne({ seller: userId });
        if (!shipping) {
          shipping = new ShippingMethod({ seller: userId, methods: [] });
        }

        const existing = shipping.methods.find(m => m.type === method);
        const shippingCurrency = normalizeCurrency(args.currency || preferredCurrency);
        const shippingCost = cost != null ? roundMoney(cost) : null;
        if (existing) {
          if (shippingCost != null) {
            existing.cost = shippingCost;
            existing.currency = shippingCurrency;
            existing.costCurrency = shippingCurrency;
            existing.costInputAmount = shippingCost;
          }
          if (deliveryDays != null) existing.deliveryDays = Number(deliveryDays);
          if (isActive != null) existing.isActive = isActive;
        } else {
          shipping.methods.push({
            type: method,
            cost: shippingCost != null ? shippingCost : 0,
            currency: shippingCurrency,
            costCurrency: shippingCurrency,
            costInputAmount: shippingCost != null ? shippingCost : 0,
            deliveryDays: Number(deliveryDays) || 3,
            isActive: isActive !== false,
          });
        }
        await shipping.save();

        return { success: true, message: `Shipping method "${method}" updated! 🚚` };
      }

      case 'create_coupon': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const c = args.coupon || args;
        const inferredDiscountType = c.discountType || (c.discountPercent != null ? 'percentage' : 'fixed');
        const rawDiscountValue = c.discountValue ?? c.discountPercent ?? c.fixedAmount ?? c.amount;
        if (!rawDiscountValue) {
          return { success: false, error: 'Please provide the coupon discount value, such as 10% or 500 off.' };
        }
        if (!['percentage', 'fixed'].includes(inferredDiscountType)) {
          return { success: false, error: 'Coupon discountType must be percentage or fixed.' };
        }
        const inputCurrency = normalizeCurrency(c.currency || args.currency || preferredCurrency);
        const rawNumericDiscountValue = Number(rawDiscountValue);
        if (!Number.isFinite(rawNumericDiscountValue) || rawNumericDiscountValue <= 0) {
          return { success: false, error: 'Coupon discountValue must be a positive number.' };
        }
        if (inferredDiscountType === 'percentage' && rawNumericDiscountValue > 100) {
          return { success: false, error: 'Percentage coupon discounts cannot exceed 100%.' };
        }
        const discountValue = rawNumericDiscountValue;
        const expiryDate = c.expiryDate ? new Date(c.expiryDate) : addDays(new Date(), 30);
        if (Number.isNaN(expiryDate.getTime())) return { success: false, error: 'Coupon expiryDate is invalid.' };
        if (expiryDate <= new Date()) return { success: false, error: 'Coupon expiryDate must be in the future.' };
        const maxUses = c.maxUses == null || c.maxUses === '' ? null : Number(c.maxUses);
        const maxUsesPerUser = c.maxUsesPerUser == null || c.maxUsesPerUser === '' ? 1 : Number(c.maxUsesPerUser);
        const rawMinOrderAmount = c.minOrderAmount == null || c.minOrderAmount === '' ? 0 : Number(c.minOrderAmount);
        const rawMaxDiscountAmount = c.maxDiscountAmount ?? c.maxDiscount;
        const rawMaxDiscountAmountNumber = rawMaxDiscountAmount == null || rawMaxDiscountAmount === '' ? null : Number(rawMaxDiscountAmount);
        if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses <= 0)) return { success: false, error: 'maxUses must be a positive number.' };
        if (!Number.isFinite(maxUsesPerUser) || maxUsesPerUser <= 0) return { success: false, error: 'maxUsesPerUser must be a positive number.' };
        if (!Number.isFinite(rawMinOrderAmount) || rawMinOrderAmount < 0) return { success: false, error: 'minOrderAmount must be zero or higher.' };
        if (rawMaxDiscountAmountNumber !== null && (!Number.isFinite(rawMaxDiscountAmountNumber) || rawMaxDiscountAmountNumber <= 0)) return { success: false, error: 'maxDiscountAmount must be a positive number.' };
        const minOrderAmount = rawMinOrderAmount;
        const maxDiscountAmount = rawMaxDiscountAmountNumber == null
          ? null
          : rawMaxDiscountAmountNumber;
        const applicableTo = c.applicableTo === 'selected' ? 'selected' : 'all';
        const applicableProducts = Array.isArray(c.applicableProducts)
          ? c.applicableProducts.map(toId).filter(Boolean)
          : [];
        if (applicableTo === 'selected') {
          if (!applicableProducts.length) return { success: false, error: 'Please choose at least one product for a selected-product coupon.' };
          const ownedCount = await Product.countDocuments({ _id: { $in: applicableProducts }, seller: userId });
          if (ownedCount !== applicableProducts.length) return { success: false, error: 'Some selected products were not found in your store.' };
        }
        const code = await uniqueCouponCode(userId, { ...c, discountType: inferredDiscountType, discountValue });

        const coupon = await Coupon.create({
          seller: userId,
          code,
          discountType: inferredDiscountType,
          discountValue,
          currency: inputCurrency,
          applicableTo,
          applicableProducts: applicableTo === 'selected' ? applicableProducts : [],
          maxUses,
          maxUsesPerUser,
          minOrderAmount,
          maxDiscountAmount,
          expiryDate,
          description: c.description || '',
        });

        return {
          success: true,
          data: { couponId: coupon._id, code: coupon.code, expiryDate: coupon.expiryDate },
          message: `Coupon "${coupon.code}" created - ${coupon.discountType === 'percentage' ? coupon.discountValue + '%' : await formatMoney(coupon.discountValue, inputCurrency, { sourceCurrency: inputCurrency })} off, expiring ${coupon.expiryDate.toISOString().slice(0, 10)}.`,
        };
      }

      case 'get_my_coupons': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const coupons = await Coupon.find({ seller: userId }).sort({ createdAt: -1 }).lean();

        return {
          success: true,
          data: {
            coupons: coupons.map(c => ({
              _id: c._id,
              code: c.code,
              type: c.discountType,
              value: c.discountValue,
              currency: c.currency || 'USD',
              isActive: c.isActive,
              usedCount: c.usedCount,
              maxUses: c.maxUses,
              expires: c.expiryDate,
            })),
            count: coupons.length,
          },
          message: `You have ${coupons.length} coupon${coupons.length !== 1 ? 's' : ''}.`,
        };
      }

      case 'update_coupon': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const incomingUpdates = Object.keys(pickObject(args.updates)).length ? args.updates : args;
        const allowedCouponFields = ['discountType', 'discountValue', 'currency', 'applicableTo', 'applicableProducts', 'maxUses', 'maxUsesPerUser', 'minOrderAmount', 'maxDiscountAmount', 'startDate', 'expiryDate', 'isActive', 'description'];
        const updates = {};
        for (const field of allowedCouponFields) {
          if (incomingUpdates[field] !== undefined) updates[field] = incomingUpdates[field];
        }
        const coupon = await resolveSellerCoupon(userId, args);
        if (!coupon) return { success: false, error: 'Please specify a valid coupon code or choose a coupon from your coupon list.' };
        if (Object.keys(updates).length === 0) return { success: false, error: 'No valid coupon fields were provided to update.' };
        if (updates.currency !== undefined || incomingUpdates.currency !== undefined || args.currency !== undefined) {
          updates.currency = normalizeCurrency(updates.currency || incomingUpdates.currency || args.currency || coupon.currency || preferredCurrency);
        }
        if (updates.discountType && !['percentage', 'fixed'].includes(updates.discountType)) {
          return { success: false, error: 'Coupon discountType must be percentage or fixed.' };
        }
        for (const numericField of ['discountValue', 'maxUses', 'maxUsesPerUser', 'maxDiscountAmount']) {
          if (updates[numericField] !== undefined && updates[numericField] !== null) {
            const numericValue = Number(updates[numericField]);
            if (!Number.isFinite(numericValue) || numericValue <= 0) {
              return { success: false, error: `${numericField} must be a positive number.` };
            }
            updates[numericField] = numericValue;
          }
        }
        for (const numericField of ['minOrderAmount']) {
          if (updates[numericField] !== undefined && updates[numericField] !== null) {
            const numericValue = Number(updates[numericField]);
            if (!Number.isFinite(numericValue) || numericValue < 0) {
              return { success: false, error: `${numericField} must be zero or higher.` };
            }
            updates[numericField] = numericValue;
          }
        }
        const finalDiscountType = updates.discountType || coupon.discountType;
        const finalDiscountValue = updates.discountValue ?? coupon.discountValue;
        if (finalDiscountType === 'percentage' && finalDiscountValue > 100) {
          return { success: false, error: 'Percentage coupon discounts cannot exceed 100%.' };
        }
        if (updates.expiryDate !== undefined) {
          const expiryDate = new Date(updates.expiryDate);
          if (Number.isNaN(expiryDate.getTime())) return { success: false, error: 'Coupon expiryDate is invalid.' };
          if (expiryDate <= new Date()) return { success: false, error: 'Coupon expiryDate must be in the future.' };
          updates.expiryDate = expiryDate;
        }
        const finalApplicableTo = updates.applicableTo || coupon.applicableTo;
        if (finalApplicableTo === 'selected' && (updates.applicableProducts !== undefined || updates.applicableTo === 'selected')) {
          const productSource = updates.applicableProducts !== undefined ? updates.applicableProducts : coupon.applicableProducts;
          const productIds = Array.isArray(productSource) ? productSource.map(item => toId(item?._id || item)).filter(Boolean) : [];
          if (!productIds.length) return { success: false, error: 'Please choose at least one product for a selected-product coupon.' };
          const ownedCount = await Product.countDocuments({ _id: { $in: productIds }, seller: userId });
          if (ownedCount !== productIds.length) return { success: false, error: 'Some selected products were not found in your store.' };
          updates.applicableProducts = productIds;
        }
        if (updates.applicableTo === 'all') updates.applicableProducts = [];

        Object.assign(coupon, updates);
        await coupon.save();
        return { success: true, message: `Coupon "${coupon.code}" updated.` };
      }

      case 'delete_coupon': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const coupon = await resolveSellerCoupon(userId, args);
        if (!coupon) return { success: false, error: 'Please specify a valid coupon code or choose a coupon from your coupon list.' };
        await coupon.deleteOne();
        return { success: true, message: `Coupon "${coupon.code}" deleted.` };
      }

      case 'toggle_coupon': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const coupon = await resolveSellerCoupon(userId, args);
        if (!coupon) return { success: false, error: 'Please specify a valid coupon code or choose a coupon from your coupon list.' };
        if (!coupon.isActive && new Date(coupon.expiryDate) <= new Date()) {
          return { success: false, error: `Coupon "${coupon.code}" is expired. Extend its expiry date before activating it.` };
        }

        coupon.isActive = !coupon.isActive;
        await coupon.save();
        return { success: true, message: `Coupon "${coupon.code}" is now ${coupon.isActive ? 'active' : 'inactive'}.` };
      }

      case 'get_subscription_status': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const sub = await SellerSubscription.findOne({ seller: userId }).lean();
        if (!sub) return { success: true, data: null, message: 'No subscription found.' };

        return {
          success: true,
          data: {
            status: sub.status,
            plan: sub.plan,
            planName: sub.planName,
            trialDaysRemaining: sub.trialDaysRemaining,
            bonusFeaturesActive: sub.bonusFeaturesActive,
            currentPeriodEnd: sub.currentPeriodEnd,
            aiMessagesUnlimited: true,
            metaAdsIncluded: Boolean(sub.metaAdsIncluded),
          },
          message: `Your subscription: ${sub.planName} (${sub.status}). ${sub.status === 'trial' ? `Trial ends in ${sub.trialDaysRemaining} days.` : ''}`,
        };
      }

      // ─────────────────────────────────────────────
      //  ADMIN TOOLS
      // ─────────────────────────────────────────────

      case 'get_seller_ads_status': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const state = await getSellerAdsState(userId);
        return {
          success: true,
          data: state,
          requiresElite: !state.isElite,
          message: state.isElite
            ? `Ads are available. You have ${state.featuredProducts.length} active featured product${state.featuredProducts.length !== 1 ? 's' : ''} available for TikTok ads.`
            : 'Subscribe to Rozare Elite to request Rozare-run TikTok ads for your store and featured products.',
        };
      }

      case 'submit_seller_ads_request': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const state = await getSellerAdsState(userId);
        if (!state.isElite) {
          return {
            success: false,
            requiresElite: true,
            error: 'Subscribe to Rozare Elite to run ads for your store and featured products.',
          };
        }

        if (state.pendingRequests.length) {
          return {
            success: false,
            error: 'You already have an ads request waiting for admin approval.',
            data: { pendingRequests: state.pendingRequests },
          };
        }

        const requestType = ['start', 'update', 'stop'].includes(args.requestType)
          ? args.requestType
          : (state.activeRequest?.active ? 'update' : 'start');
        const includeMeta = isTruthy(args.includeMeta);
        if (includeMeta && !state.subscription.metaAdsIncluded) {
          return {
            success: false,
            requiresMetaAddon: true,
            error: 'Meta ads require the Meta ads add-on on your Elite subscription. Open Seller Dashboard > Subscription and select Include Meta ads first.',
          };
        }

        if (requestType === 'stop' && !state.activeRequest?.active) {
          return { success: false, error: 'There is no active ads campaign to stop.' };
        }

        const productIds = requestType === 'stop' ? [] : resolveAdProductIdsFromState(args, state);
        if (requestType !== 'stop' && productIds.length === 0) {
          return {
            success: false,
            needsProductSelection: true,
            error: 'Select at least one active featured product for ads.',
            data: { featuredProducts: state.featuredProducts },
          };
        }

        const store = state.store?._id
          ? state.store
          : await Store.findOne({ seller: userId }).select('_id').lean();
        const products = requestType === 'stop'
          ? []
          : await Product.find({
            seller: userId,
            isFeatured: true,
            isBlocked: { $ne: true },
            moderationStatus: { $ne: 'blocked' },
            _id: { $in: productIds },
          }).select('_id name category image images').lean();

        if (requestType !== 'stop' && products.length !== productIds.length) {
          return {
            success: false,
            error: 'Only your active featured products can be selected for ads.',
            data: { featuredProducts: state.featuredProducts },
          };
        }

        const sellerNote = cleanAIParagraph(args.sellerNote || args.note || '', { maxLength: 500 });
        const request = await SellerAdRequest.create({
          seller: userId,
          store: store?._id || null,
          products: products.map(product => product._id),
          requestType,
          status: 'pending',
          active: false,
          channels: {
            tiktok: true,
            meta: includeMeta,
          },
          sellerNote,
        });

        const populated = await SellerAdRequest.findById(request._id)
          .populate('products', AD_PRODUCT_SELECT)
          .populate('store', 'storeName storeSlug logo')
          .lean();

        return {
          success: true,
          data: { request: serializeAdRequest(populated) },
          message: requestType === 'stop'
            ? 'Ads stop request sent for admin approval.'
            : `Ads request sent for admin approval with ${products.length} featured product${products.length !== 1 ? 's' : ''}${includeMeta ? ' for TikTok and Meta' : ' for TikTok'}.`,
        };
      }

      case 'get_all_users': {
        const { search, role: filterRole, status, page, limit } = args;
        const filter = {};
        if (search) {
          filter.$or = [
            { username: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
          ];
        }
        if (filterRole) filter.role = filterRole;
        if (status) filter.status = status;

        const skip = (safePage(page) - 1) * safeLimit(limit, 20);
        const [users, total] = await Promise.all([
          User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit(limit, 20))
            .select('username email role status createdAt')
            .lean(),
          User.countDocuments(filter),
        ]);

        return {
          success: true,
          data: { users, total, page: safePage(page) },
          message: `Found ${total} user${total !== 1 ? 's' : ''}${search ? ` matching "${search}"` : ''}${filterRole ? ` with role "${filterRole}"` : ''}${status ? ` with status "${status}"` : ''}. Showing ${users.length}.`,
        };
      }

      case 'delete_user': {
        const { userId: targetId } = args;
        if (!targetId) return { success: false, error: 'Please provide userId.' };

        const target = await User.findById(toId(targetId)).select('username role').lean();
        if (!target) return { success: false, error: 'User not found.' };
        if (target.role === 'admin') return { success: false, error: 'Cannot delete an admin user.' };

        // Clean up related data
        await Promise.all([
          Order.deleteMany({ user: targetId }),
          Complaint.deleteMany({ user: targetId }),
          Notification.deleteMany({ user: targetId }),
          Store.findOneAndDelete({ seller: targetId }),
          Product.deleteMany({ seller: targetId }),
          SellerSubscription.findOneAndDelete({ seller: targetId }),
          User.findByIdAndDelete(targetId),
        ]);

        return { success: true, message: `User "${target.username}" and all their data have been permanently deleted. ⚠️` };
      }

      case 'block_user': {
        const { userId: targetId, blocked } = args;
        if (!targetId) return { success: false, error: 'Please provide userId.' };

        const newStatus = blocked !== false ? 'blocked' : 'active';
        const target = await User.findByIdAndUpdate(
          toId(targetId),
          { $set: { status: newStatus } },
          { new: true }
        ).select('username status').lean();

        if (!target) return { success: false, error: 'User not found.' };
        return { success: true, message: `User "${target.username}" is now ${target.status}. ${target.status === 'blocked' ? '🚫' : '✅'}` };
      }

      case 'change_user_role': {
        const { userId: targetId, newRole } = args;
        if (!targetId || !newRole) return { success: false, error: 'Please provide userId and newRole.' };
        if (!['user', 'seller', 'admin'].includes(newRole)) {
          return { success: false, error: 'Invalid role. Must be: user, seller, or admin.' };
        }

        const target = await User.findByIdAndUpdate(
          toId(targetId),
          { $set: { role: newRole } },
          { new: true }
        ).select('username role').lean();

        if (!target) return { success: false, error: 'User not found.' };
        return { success: true, message: `User "${target.username}" role changed to "${newRole}".` };
      }

      case 'get_admin_analytics': {
        const { period } = args;
        let dateFilter = {};
        const now = new Date();
        if (period === 'today') dateFilter = { createdAt: { $gte: new Date(now.setHours(0, 0, 0, 0)) } };
        else if (period === 'week') dateFilter = { createdAt: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) } };
        else if (period === 'month') dateFilter = { createdAt: { $gte: new Date(now - 30 * 24 * 60 * 60 * 1000) } };

        const [
          totalUsers, totalSellers, totalAdmins,
          totalOrders, totalProducts, totalStores,
          pendingVerifications, openComplaints,
          periodOrders,
        ] = await Promise.all([
          User.countDocuments({ role: 'user' }),
          User.countDocuments({ role: 'seller' }),
          User.countDocuments({ role: 'admin' }),
          Order.countDocuments(),
          Product.countDocuments(),
          Store.countDocuments(),
          Store.countDocuments({ 'verification.status': 'pending' }),
          Complaint.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
          dateFilter.createdAt ? Order.countDocuments(dateFilter) : Promise.resolve(null),
        ]);

        const revenueOrders = await Order.find({ orderStatus: { $ne: 'cancelled' } })
          .select('orderSummary currency')
          .lean();
        let totalRevenue = 0;
        for (const order of revenueOrders) {
          totalRevenue += await convertAmount(order.orderSummary?.totalAmount || 0, order.currency || preferredCurrency, preferredCurrency);
        }

        return {
          success: true,
          data: {
            users: { total: totalUsers + totalSellers + totalAdmins, customers: totalUsers, sellers: totalSellers, admins: totalAdmins },
            orders: { total: totalOrders, ...(periodOrders != null ? { inPeriod: periodOrders } : {}) },
            revenue: Math.round(totalRevenue * 100) / 100,
            currency: preferredCurrency,
            products: totalProducts,
            stores: totalStores,
            pendingVerifications,
            openComplaints,
          },
          message: `📊 Platform: ${totalUsers + totalSellers + totalAdmins} users, ${totalOrders} orders, ${await userMoney(totalRevenue, preferredCurrency)} revenue, ${totalProducts} products, ${totalStores} stores, ${pendingVerifications} pending verifications, ${openComplaints} open complaints.`,
        };
      }

      case 'get_all_orders': {
        const { status, limit, page } = args;
        const filter = {};
        if (status && status !== 'all') filter.orderStatus = status;

        const skip = (safePage(page) - 1) * safeLimit(limit, 20);
        const [orders, total] = await Promise.all([
          Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit(limit, 20))
            .populate('user', 'username email')
            .lean(),
          Order.countDocuments(filter),
        ]);

        return {
          success: true,
          data: {
            orders: orders.map(o => ({
              orderId: o.orderId,
              status: o.orderStatus,
              buyer: o.user?.username || o.guestEmail || 'Guest',
              total: o.orderSummary?.totalAmount || 0,
              items: o.orderItems?.length || 0,
              date: o.createdAt,
              isPaid: o.isPaid,
            })),
            total,
            page: safePage(page),
          },
          message: `${total} order${total !== 1 ? 's' : ''}${status ? ` (${status})` : ''} — showing ${orders.length}.`,
        };
      }

      case 'get_all_complaints': {
        const { status, category: cat, page, limit } = args;
        const filter = {};
        if (status) filter.status = status;
        if (cat) filter.category = cat;

        const skip = (safePage(page) - 1) * safeLimit(limit, 20);
        const [complaints, total] = await Promise.all([
          Complaint.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit(limit, 20))
            .populate('user', 'username email')
            .lean(),
          Complaint.countDocuments(filter),
        ]);

        return {
          success: true,
          data: {
            complaints: complaints.map(c => ({
              _id: c._id,
              subject: c.subject,
              category: c.category,
              status: c.status,
              priority: c.priority,
              user: c.user?.username || 'Unknown',
              date: c.createdAt,
            })),
            total,
          },
          message: `${total} complaint${total !== 1 ? 's' : ''}${status ? ` (${status})` : ''}.`,
        };
      }

      case 'update_complaint': {
        const { complaintId, status: newStatus, priority } = args;
        const adminResp = args.adminResponse || args.response;
        if (!complaintId) return { success: false, error: 'Please provide complaintId.' };

        const update = {};
        if (newStatus) update.status = newStatus;
        if (priority) update.priority = priority;
        if (adminResp) update.adminResponse = adminResp;
        if (Object.keys(update).length === 0) return { success: false, error: 'No valid complaint updates were provided.' };

        const complaint = await Complaint.findByIdAndUpdate(
          toId(complaintId),
          { $set: update },
          { new: true }
        ).lean();

        if (!complaint) return { success: false, error: 'Complaint not found.' };
        return { success: true, message: `Complaint "${complaint.subject}" updated to "${complaint.status}". ${adminResp ? 'Response sent.' : ''}` };
      }

      case 'get_pending_verifications': {
        const stores = await Store.find({ 'verification.status': 'pending' })
          .populate('seller', 'username email')
          .lean();

        return {
          success: true,
          data: {
            stores: stores.map(s => ({
              _id: s._id,
              storeName: s.storeName,
              slug: s.storeSlug,
              seller: s.seller?.username || 'Unknown',
              sellerEmail: s.seller?.email || '',
              appliedAt: s.verification?.appliedAt,
              message: s.verification?.applicationMessage || '',
            })),
            count: stores.length,
          },
          message: `${stores.length} store${stores.length !== 1 ? 's' : ''} pending verification.`,
        };
      }

      case 'approve_verification': {
        const { storeId } = args;
        if (!storeId) return { success: false, error: 'Please provide storeId.' };

        const store = await Store.findByIdAndUpdate(toId(storeId), {
          $set: {
            'verification.isVerified': true,
            'verification.status': 'approved',
            'verification.reviewedAt': new Date(),
            'verification.reviewedBy': userId,
          },
        }, { new: true }).select('storeName').lean();

        if (!store) return { success: false, error: 'Store not found.' };
        return { success: true, message: `Store "${store.storeName}" has been verified! ✅🛡️` };
      }

      case 'reject_verification': {
        const { storeId, reason } = args;
        if (!storeId) return { success: false, error: 'Please provide storeId.' };

        const store = await Store.findByIdAndUpdate(toId(storeId), {
          $set: {
            'verification.isVerified': false,
            'verification.status': 'rejected',
            'verification.reviewedAt': new Date(),
            'verification.reviewedBy': userId,
            'verification.rejectionReason': reason || 'Does not meet requirements.',
          },
        }, { new: true }).select('storeName').lean();

        if (!store) return { success: false, error: 'Store not found.' };
        return { success: true, message: `Store "${store.storeName}" verification rejected.${reason ? ` Reason: ${reason}` : ''}` };
      }

      case 'remove_verification': {
        const { storeId } = args;
        if (!storeId) return { success: false, error: 'Please provide storeId.' };

        const store = await Store.findByIdAndUpdate(toId(storeId), {
          $set: {
            'verification.isVerified': false,
            'verification.status': 'none',
            'verification.reviewedAt': new Date(),
            'verification.reviewedBy': userId,
          },
        }, { new: true }).select('storeName').lean();

        if (!store) return { success: false, error: 'Store not found.' };
        return { success: true, message: `Verification removed from store "${store.storeName}".` };
      }

      case 'get_all_stores': {
        const { search, limit, page } = args;
        const filter = {};
        if (search) {
          filter.$or = [
            { storeName: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        const skip = (safePage(page) - 1) * safeLimit(limit, 20);
        const [stores, total] = await Promise.all([
          Store.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit(limit, 20))
            .populate('seller', 'username email status')
            .lean(),
          Store.countDocuments(filter),
        ]);

        return {
          success: true,
          data: {
            stores: stores.map(s => ({
              _id: s._id,
              storeName: s.storeName,
              slug: s.storeSlug,
              seller: s.seller?.username || 'Unknown',
              sellerStatus: s.seller?.status || 'unknown',
              isVerified: s.verification?.isVerified || false,
              views: s.views,
              trustCount: s.trustCount,
            })),
            total,
          },
          message: `${total} store${total !== 1 ? 's' : ''} on the platform.`,
        };
      }

      case 'update_tax_config': {
        const { type, value, isActive } = args;
        const update = {};
        if (type) {
          if (!['none', 'percentage', 'fixed'].includes(type)) {
            return { success: false, error: 'Tax type must be none, percentage, or fixed.' };
          }
          update.type = type;
        }
        if (value != null) {
          const numericValue = Number(value);
          if (!Number.isFinite(numericValue) || numericValue < 0) {
            return { success: false, error: 'Tax value must be a non-negative number.' };
          }
          if (type === 'percentage' && numericValue > 100) {
            return { success: false, error: 'Percentage tax cannot exceed 100%.' };
          }
          update.value = numericValue;
        }
        if (type === 'none') update.value = 0;
        if (isActive != null) update.isActive = isActive;
        update.updatedBy = userId;

        let config = await TaxConfig.findOneAndUpdate(
          { isActive: true },
          { $set: update },
          { new: true, upsert: true }
        ).lean();

        return {
          success: true,
          data: config,
          message: `Tax config updated: ${config.type === 'none' ? 'taxes disabled' : `${config.type} — ${config.type === 'percentage' ? config.value + '%' : '$' + config.value}`}.`,
        };
      }

      case 'get_tax_config': {
        const config = await TaxConfig.findOne({ isActive: true }).lean();
        if (!config) return { success: true, data: { type: 'none', value: 0 }, message: 'No tax configured.' };

        return {
          success: true,
          data: { type: config.type, value: config.value, isActive: config.isActive },
          message: `Tax: ${config.type === 'none' ? 'disabled' : `${config.type} — ${config.type === 'percentage' ? config.value + '%' : '$' + config.value}`}.`,
        };
      }

      case 'send_broadcast': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { title, category, channels, linkTo, recurrence, endsAt } = args;
        const body = args.body || args.message;
        if (!title || !body) return { success: false, error: 'Please provide title and body for the broadcast.' };
        const normalizedCategory = category || 'announcement';
        if (!['announcement', 'promo', 'order', 'system', 'seller'].includes(normalizedCategory)) {
          return { success: false, error: 'Broadcast category must be announcement, promo, order, system, or seller.' };
        }

        const validAudiences = ['all_users', 'all_sellers', 'both', 'specific'];
        const audienceInput = args.audience;
        const audienceTarget = typeof audienceInput === 'object' && audienceInput !== null
          ? audienceInput.target
          : audienceInput;
        const audienceMap = {
          all: 'both',
          users: 'all_users',
          sellers: 'all_sellers',
          custom: 'specific',
        };
        const audience = audienceMap[audienceTarget] || audienceTarget || 'all_users';
        const userIds = Array.isArray(args.userIds)
          ? args.userIds
          : Array.isArray(audienceInput?.userIds)
            ? audienceInput.userIds
            : [];
        if (!validAudiences.includes(audience)) {
          return { success: false, error: 'Audience must be all_users, all_sellers, both, or specific.' };
        }
        if (audience === 'specific' && userIds.length === 0) {
          return { success: false, error: 'Please provide userIds when sending a broadcast to a specific audience.' };
        }

        const validChannels = ['inapp', 'push', 'email', 'whatsapp'];
        const normalizedChannels = Array.isArray(channels) && channels.length ? channels : ['inapp', 'push'];
        if (normalizedChannels.some(ch => !validChannels.includes(ch))) {
          return { success: false, error: `Invalid broadcast channel. Valid channels: ${validChannels.join(', ')}.` };
        }

        let scheduleType = args.scheduleType || (args.scheduledAt ? 'one_time' : 'immediate');
        if (!['immediate', 'one_time', 'recurring'].includes(scheduleType)) {
          return { success: false, error: 'Schedule type must be immediate, one_time, or recurring.' };
        }
        let nextRunAt = new Date();
        if (scheduleType === 'one_time' || scheduleType === 'recurring') {
          if (!args.scheduledAt) return { success: false, error: 'scheduledAt is required for scheduled broadcasts.' };
          nextRunAt = new Date(args.scheduledAt);
          if (Number.isNaN(nextRunAt.getTime())) return { success: false, error: 'Invalid scheduledAt date.' };
        }

        const broadcast = await BroadcastJob.create({
          title,
          body,
          category: normalizedCategory,
          audience,
          userIds: audience === 'specific' ? userIds.map(toId).filter(Boolean) : [],
          channels: normalizedChannels,
          scheduleType,
          recurrence: scheduleType === 'recurring' ? (recurrence || 'daily') : 'none',
          nextRunAt,
          endsAt: endsAt ? new Date(endsAt) : null,
          linkTo: linkTo || '',
          createdBy: userId,
        });

        return {
          success: true,
          data: { broadcastId: broadcast._id },
          message: `Broadcast "${title}" created and ${scheduleType === 'immediate' ? 'will be sent now' : 'scheduled'}! 📣`,
        };
      }

      case 'get_broadcasts': {
        const broadcasts = await BroadcastJob.find()
          .sort({ createdAt: -1 })
          .limit(20)
          .lean();

        return {
          success: true,
          data: {
            broadcasts: broadcasts.map(b => ({
              _id: b._id,
              title: b.title,
              status: b.status,
              audience: b.audience,
              channels: b.channels,
              recipients: b.stats?.recipients || 0,
              date: b.createdAt,
            })),
            count: broadcasts.length,
          },
          message: `${broadcasts.length} broadcast${broadcasts.length !== 1 ? 's' : ''}.`,
        };
      }

      case 'cancel_broadcast': {
        const { broadcastId } = args;
        if (!broadcastId) return { success: false, error: 'Please provide broadcastId.' };

        const broadcast = await BroadcastJob.findByIdAndUpdate(
          toId(broadcastId),
          { $set: { status: 'cancelled' } },
          { new: true }
        ).lean();

        if (!broadcast) return { success: false, error: 'Broadcast not found.' };
        return { success: true, message: `Broadcast "${broadcast.title}" cancelled.` };
      }

      case 'get_all_subscriptions': {
        const { plan, status: subStatus, page, limit } = args;
        const filter = {};
        if (plan) filter.plan = plan;
        if (subStatus) filter.status = subStatus;

        const skip = (safePage(page) - 1) * safeLimit(limit, 20);
        const [subs, total] = await Promise.all([
          SellerSubscription.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit(limit, 20))
            .populate('seller', 'username email')
            .lean(),
          SellerSubscription.countDocuments(filter),
        ]);

        return {
          success: true,
          data: {
            subscriptions: subs.map(s => ({
              seller: s.seller?.username || 'Unknown',
              plan: s.plan,
              planName: s.planName,
              status: s.status,
              subscribedAt: s.subscribedAt,
            })),
            total,
          },
          message: `${total} subscription${total !== 1 ? 's' : ''}${plan ? ` (${plan})` : ''}.`,
        };
      }

      case 'get_verified_stores': {
        const stores = await Store.find(activeStoreQuery({ 'verification.isVerified': true }))
          .populate('seller', 'username')
          .select('storeName storeSlug description views trustCount verification')
          .lean();

        return {
          success: true,
          data: {
            stores: stores.map(s => ({
              _id: s._id,
              storeName: s.storeName,
              slug: s.storeSlug,
              storeUrl: s.storeSlug ? `https://${s.storeSlug}.rozare.com/` : null,
              description: s.description,
              seller: s.seller?.username || 'Unknown',
              views: s.views,
              trustCount: s.trustCount,
            })),
            count: stores.length,
          },
          message: `${stores.length} verified store${stores.length !== 1 ? 's' : ''} on the platform.`,
        };
      }

      case 'get_store_details': {
        const { storeId, slug } = args;
        if (!storeId && !slug) return { success: false, error: 'Please provide storeId or slug.' };

        const baseFilter = storeId ? { _id: toId(storeId) } : { storeSlug: slug };
        const storeFilter = role === 'admin' ? baseFilter : activeStoreQuery(baseFilter);
        const store = await Store.findOne(storeFilter)
          .populate('seller', 'username email status role')
          .lean();

        if (!store) return { success: false, error: 'Store not found.' };

        const productCount = await Product.countDocuments(publicProductFilter({ seller: store.seller?._id }));
        const productPreview = await Product.find(publicProductFilter({ seller: store.seller?._id, stock: { $gt: 0 } }))
          .sort({ isFeatured: -1, rating: -1, createdAt: -1 })
          .limit(8)
          .select('name price discountedPrice currency priceCurrency category brand image stock colors optionGroups rating numReviews isFeatured')
          .lean();
        let orderCount;
        if (role === 'admin') {
          orderCount = await Order.countDocuments({
            'orderItems.productId': {
              $in: (await Product.find({ seller: store.seller?._id }).select('_id').lean()).map(p => p._id),
            },
          });
        }

        return {
          success: true,
          data: {
            storeName: store.storeName,
            slug: store.storeSlug,
            storeUrl: store.storeSlug ? `https://${store.storeSlug}.rozare.com/` : null,
            description: store.description,
            seller: store.seller?.username,
            isVerified: store.verification?.isVerified || false,
            views: store.views,
            trustCount: store.trustCount,
            productCount,
            products: productPreview,
            createdAt: store.createdAt,
            ...(role === 'admin' ? {
              sellerEmail: store.seller?.email,
              sellerStatus: store.seller?.status,
              verificationStatus: store.verification?.status || 'none',
              orderCount,
            } : {}),
          },
          message: `Store "${store.storeName}" - ${productCount} products${role === 'admin' ? `, ${orderCount} orders` : ''}, ${store.views} views.`,
        };
      }

      case 'search_stores': {
        const { query, limit, category, brand } = args;
        if (!query) return { success: false, error: 'Please provide a search query.' };
        const safeQuery = escapeRegExp(query);
        const activeSellerIds = await getActiveSellerIds();

        const storeMatches = await Store.find(activeStoreQuery({
          $or: [
            { storeName: { $regex: safeQuery, $options: 'i' } },
            { storeSlug: { $regex: safeQuery, $options: 'i' } },
            { description: { $regex: safeQuery, $options: 'i' } },
          ],
        }))
          .limit(safeLimit(limit, 10, 20))
          .select('_id seller storeName storeSlug description views trustCount verification.isVerified')
          .lean();

        const productFilter = applyActiveSellerProductFilter(publicProductFilter(buildSmartSearchFilter(query, category)), activeSellerIds);
        if (brand) productFilter.brand = { $regex: escapeRegExp(brand), $options: 'i' };
        productFilter.stock = { $gt: 0 };
        const matchingProducts = await Product.find(productFilter)
          .sort({ rating: -1, numReviews: -1, createdAt: -1 })
          .limit(50)
          .select('seller name price discountedPrice currency priceCurrency image category brand stock')
          .lean();
        const sellerProductMap = new Map();
        for (const product of matchingProducts) {
          const sellerId = normalizeObjectIdString(product.seller);
          if (!sellerId) continue;
          if (!sellerProductMap.has(sellerId)) sellerProductMap.set(sellerId, []);
          if (sellerProductMap.get(sellerId).length < 3) {
            sellerProductMap.get(sellerId).push({
              _id: product._id,
              name: product.name,
              price: product.price,
              discountedPrice: product.discountedPrice,
              image: product.image,
              category: product.category,
              brand: product.brand,
              stock: product.stock,
            });
          }
        }

        const productStores = sellerProductMap.size
          ? await Store.find(activeStoreQuery({ seller: { $in: [...sellerProductMap.keys()] } }))
            .limit(20)
            .select('_id seller storeName storeSlug description views trustCount verification.isVerified')
            .lean()
          : [];

        const merged = new Map();
        for (const store of [...storeMatches, ...productStores]) {
          const key = normalizeObjectIdString(store._id);
          merged.set(key, {
            ...store,
            matchingProducts: sellerProductMap.get(normalizeObjectIdString(store.seller)) || [],
          });
        }

        const stores = [...merged.values()]
          .sort((a, b) => (b.matchingProducts?.length || 0) - (a.matchingProducts?.length || 0) || (b.trustCount || 0) - (a.trustCount || 0))
          .slice(0, safeLimit(limit, 10, 20));

        return {
          success: true,
          data: {
            stores: stores.map(s => ({
              _id: s._id,
              seller: s.seller,
              storeName: s.storeName,
              storeSlug: s.storeSlug,
              slug: s.storeSlug,
              storeUrl: s.storeSlug ? `https://${s.storeSlug}.rozare.com/` : null,
              description: s.description,
              views: s.views,
              trustCount: s.trustCount,
              isVerified: s.verification?.isVerified || false,
              matchingProducts: s.matchingProducts || [],
            })),
            count: stores.length,
          },
          message: `Found ${stores.length} store${stores.length !== 1 ? 's' : ''} matching "${query}" by store name or products they sell.`,
        };
      }

      // ─── Unknown tool ───
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`[aiActionExecutor] Error executing ${toolName}:`, err.message);
    return { success: false, error: `Failed to execute ${toolName}: ${err.message}` };
  }
}

module.exports = {
  executeToolCall,
  isClientSideTool,
  CLIENT_SIDE_TOOLS,
  storeChangeLimits,
  __private: {
    detectExplicitCurrencyInText,
    resolveAIPriceCurrency,
    buildProductCurrencyConversionNotice,
  },
};
