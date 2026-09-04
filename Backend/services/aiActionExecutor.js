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

const crypto = require('crypto');
const mongoose = require('mongoose');
const Fuse = require('fuse.js');
const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Store = require('../models/Store');
const Coupon = require('../models/Coupon');
const { deleteCouponIfUnreserved } = require('./couponUsageService');
const Complaint = require('../models/Complaint');
const ShippingMethod = require('../models/ShippingMethod');
const Notification = require('../models/Notification');
const TaxConfig = require('../models/TaxConfig');
const BroadcastJob = require('../models/BroadcastJob');
const SellerSubscription = require('../models/SellerSubscription');
const SellerAdRequest = require('../models/SellerAdRequest');
const AIActionReceipt = require('../models/AIActionReceipt');
const StoreTrust = require('../models/StoreTrust');
const Cart = require('../models/Cart');
const StoreReview = require('../models/StoreReview');
const { buildSellerPaymentSummary } = require('../controllers/PaymentController');
const { generateConfirmationToken } = require('../controllers/orderConfirmationController');
const { getSellerSubscriptionStatusData } = require('../controllers/subscriptionController');
const {
  buildSubscriptionStatusMessage,
  getSubscriptionCatalog,
} = require('./subscriptionPresentationService');
const {
  buildModerationFields,
  isProductBlocked,
  notifyProductBlocked,
  publicProductFilter,
} = require('./productModerationService');
const {
  isSupportedCurrency,
  normalizeCurrency,
  convertAmount,
  convertAmountUsingTrustedRates,
  convertAmountSync,
  convertAmountWithRates,
  getExchangeRateSnapshot,
  normalizeRates,
  exchangeRatesUnavailableError,
  formatMoney,
} = require('./currencyService');
const {
  buildOrderItemMoneyAllocations,
  orderItemKey,
  sellerCurrencyMoneyPresentation,
  sellerOrderSummaryForItems,
  isSellerRevenueRecognized,
  sumCurrencyAmountsInCurrency,
  sumOrderAmountsInCurrency,
  SELLER_SETTLEMENT_VERSION,
  buildOrderSellerSettlement,
  getAccountingOrderCurrency,
  requireStoredOrderMoney,
} = require('./orderMoneyService');
const {
  getOrderItemLineSubtotal,
  priceOrderItemLines,
} = require('./orderLinePricingService');
const {
  allocateCheckoutAmountsBySource,
  assertStoredCouponTerms,
  requireSupportedCheckoutCurrency,
  validateAndPriceCoupons,
} = require('./checkoutPricingService');
const {
  roundMoney,
  applyProductPricePercentage,
  assertEffectiveProductDiscount,
  assertRepresentablePositiveProductAmount,
  assertRepresentableProductAdjustment,
  requireStoredProductEffectivePrice,
  requireStoredProductCurrency,
  requireStoredProductDiscountCurrency,
  requireStoredProductDiscountPrice,
} = require('./productPricingService');
const { normalizeSocialLinks } = require('./socialLinksService');
const { nextShortOrderId } = require('./orderPublicIdService');
const {
  plainOptions,
  validateProductSelection,
  summarizeSelectionRequest,
} = require('./productSelectionService');
const {
  assertProductCreationAllowed,
  getSellerProductCurrencyState,
  withProductCurrencyWriteLock,
} = require('./storeProductCurrencyService');
const {
  getSellerProductCreationQuota,
  getSellerFeaturedProductQuota,
  assertSellerCanCreateProducts,
  assertSellerCanFeatureProduct,
} = require('./sellerProductQuotaService');
const { runInTransaction } = require('./walletService');
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
const { multiplyMoney, percentageOfMoney, sumMoney, toMinorUnits } = require('./moneyMath');
const { commitOrderInventory } = require('./orderInventoryService');
const { cancelOrderSafely } = require('./orderCancellationService');
const { transitionOrderFulfillment } = require('./orderStatusTransitionService');
const { deleteAccountCascade } = require('./accountDeletionService');
const { buildScopedNotificationQuery } = require('./notificationAudienceService');
const {
  cancelScheduledBroadcast,
  createBroadcastJob,
} = require('./broadcastJobService');
const { resolveOrderReference } = require('./orderReferenceService');
const { canonicalizeShippingPhone } = require('./orderBuyerContactService');
const { normalizeReturnPolicy, normalizeProductReturnPolicy } = require('./returnPolicyService');
const {
  parseMoneyLikeNumber,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
  parseStrictFiniteNumber,
} = require('./numericInputService');
const {
  ensureOrderSellerFulfillment,
  getSellerFulfillment,
} = require('./orderFulfillmentService');
const { removeFulfilledOrderItemsFromCart } = require('./cartFulfillmentService');
const { changeStoreSlug } = require('./subdomainSlugMutationService');
const { validateStoreSlug } = require('../utils/storeSlug');
const {
  enqueueCodOrderBuyerConfirmationNotification,
  enqueueCodOrderSellerNotifications,
} = require('./financialNotificationOutboxService');
const { META_ADS_ADDON_CENTS } = require('./subscriptionPricingService');

// ─── Client-side tools: rendered by frontend, not executed here ───
const CLIENT_SIDE_TOOLS = new Set([
  'navigate',
  'show_style_advice',
  'suggest_outfit',
]);
// These tools change durable server state and therefore need a deterministic
// per-chat execution slot. place_order and the two bulk money operations own
// stronger transaction-coupled idempotency contracts and are intentionally
// handled inside their implementations instead.
const AI_MUTATING_TOOLS_WITH_OUTER_RECEIPT = new Set([
  'cancel_order',
  'submit_complaint',
  'add_to_wishlist',
  'remove_from_wishlist',
  'add_address',
  'update_profile',
  'mark_notifications_read',
  'add_to_cart',
  'remove_from_cart',
  'clear_cart',
  'add_product',
  'bulk_add_products',
  'edit_product',
  'delete_product',
  'feature_product',
  'remove_discount',
  'update_order_status',
  'update_store',
  'apply_for_verification',
  'update_shipping',
  'create_coupon',
  'update_coupon',
  'delete_coupon',
  'toggle_coupon',
  'submit_seller_ads_request',
  'delete_user',
  'block_user',
  'change_user_role',
  'update_complaint',
  'approve_verification',
  'reject_verification',
  'remove_verification',
  'update_tax_config',
  'send_broadcast',
  'cancel_broadcast',
]);
const AI_DURABLE_MUTATING_TOOLS = new Set([
  ...AI_MUTATING_TOOLS_WITH_OUTER_RECEIPT,
  'bulk_discount',
  'bulk_price_update',
]);
const DEFAULT_PRODUCT_IMAGE_URL = 'https://rozare.com/favicon-512.png';
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
  trustRequestedCurrency = false,
} = {}) {
  const valueCurrency = detectExplicitCurrencyInText(value);
  if (valueCurrency) return valueCurrency;

  const explicitUserCurrency = detectExplicitCurrencyInText(lastUserText);
  if (explicitUserCurrency) return explicitUserCurrency;

  const preferred = normalizeCurrency(fallbackCurrency || preferredCurrency);
  if (!requestedCurrency) return preferred;

  const requestedAlias = detectExplicitCurrencyInText(requestedCurrency);
  if (trustRequestedCurrency && requestedAlias) return requestedAlias;
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
  return {
    amount: parseMoneyLikeNumber(value),
    currency,
  };
}

function normalizeMoneyAmount(value, { allowCurrencyText = false, nonNegative = false } = {}) {
  const parsed = allowCurrencyText
    ? parseMoneyLikeNumber(value)
    : parseStrictFiniteNumber(value);
  if (parsed === null || (nonNegative && parsed < 0)) return null;
  try {
    const rounded = roundMoney(parsed);
    return rounded !== parsed ? null : rounded;
  } catch (_) {
    return null;
  }
}

const normalizeNonNegativeMoneyAmount = (value, options = {}) => (
  normalizeMoneyAmount(value, { ...options, nonNegative: true })
);

function requireAIDerivedMoney(value, label = 'financial amount', { allowMissing = true } = {}) {
  // Aggregate reporting buckets may explicitly define missing as zero. Order
  // construction disables that compatibility mode because each shipping line
  // must exist. Any present value must already be exact, non-negative cents.
  const isMissing = value === null || value === undefined;
  const amount = isMissing && allowMissing ? 0 : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    const error = new Error(`The derived ${label} is invalid.`);
    error.code = 'AI_FINANCIAL_DATA_INVALID';
    error.status = 409;
    error.statusCode = 409;
    throw error;
  }
  try {
    if (roundMoney(amount) !== amount) {
      const error = new Error(`The derived ${label} is not exact to cents.`);
      error.code = 'AI_FINANCIAL_DATA_INVALID';
      error.status = 409;
      error.statusCode = 409;
      throw error;
    }
  } catch (error) {
    if (error?.code === 'AI_FINANCIAL_DATA_INVALID') throw error;
    const invalid = new Error(`The derived ${label} is outside the safe money range.`);
    invalid.code = 'AI_FINANCIAL_DATA_INVALID';
    invalid.status = 409;
    invalid.statusCode = 409;
    throw invalid;
  }
  return amount;
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

async function sellerCanCreateProducts(userId, requestedCount = 1) {
  try {
    return getSellerProductCreationQuota(userId, { requestedCount });
  } catch (e) {
    console.error('sellerCanCreateProducts error:', e);
    return { allowed: false, current: 0, max: 15, remaining: 0, reason: 'error' };
  }
}

async function sellerCanFeatureProduct(userId, excludeProductId = null) {
  try {
    return getSellerFeaturedProductQuota(userId, {
      excludeProductId: toId(excludeProductId),
    });
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
      currency: requireStoredProductCurrency(product, 'USD'),
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
    currency: requireStoredProductCurrency(product, 'USD'),
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
    _comparablePrice: await convertAmount(requireStoredProductEffectivePrice(product), requireStoredProductCurrency(product, 'USD'), currency),
  })));
}

function sortAIProductsByPrice(products = [], sortBy = '', targetCurrency = 'USD') {
  if (!['price_low', 'price_high'].includes(sortBy)) return products;
  const direction = sortBy === 'price_low' ? 1 : -1;
  const currency = normalizeCurrency(targetCurrency);
  return products.sort((a, b) => {
    const priceA = a._comparablePrice ?? convertAmountSync(requireStoredProductEffectivePrice(a), requireStoredProductCurrency(a, 'USD'), currency);
    const priceB = b._comparablePrice ?? convertAmountSync(requireStoredProductEffectivePrice(b), requireStoredProductCurrency(b, 'USD'), currency);
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

function normalizedIdSet(values = []) {
  return new Set(
    [...(values instanceof Set ? values : values || [])]
      .map(normalizeObjectIdString)
      .filter(Boolean)
  );
}

/**
 * Resolve seller ownership for an immutable order line.
 *
 * New orders persist `orderItems.seller` as a checkout-time snapshot. Once
 * present, that snapshot is authoritative even if the product is reassigned
 * later. Only legacy lines without a seller snapshot may inherit the product's
 * current owner.
 */
function sellerOwnsOrderItem(item, sellerId, sellerProductIds = []) {
  const normalizedSellerId = normalizeObjectIdString(sellerId);
  if (!normalizedSellerId) return false;

  const snapshotSellerId = normalizeObjectIdString(item?.seller);
  if (snapshotSellerId) return snapshotSellerId === normalizedSellerId;

  return normalizedIdSet(sellerProductIds).has(normalizeObjectIdString(item?.productId));
}

function filterSellerOrderItems(order, sellerId, sellerProductIds = []) {
  const normalizedSellerId = normalizeObjectIdString(sellerId);
  const legacyProductIds = normalizedIdSet(sellerProductIds);

  return (order?.orderItems || []).filter(item => {
    const snapshotSellerId = normalizeObjectIdString(item?.seller);
    if (snapshotSellerId) return snapshotSellerId === normalizedSellerId;
    return legacyProductIds.has(normalizeObjectIdString(item?.productId));
  });
}

/**
 * Mongo scope matching snapshot-owned lines plus current-product ownership for
 * legacy lines only. The `seller: null` elemMatch is intentional: it matches a
 * missing or null snapshot without allowing an explicitly different seller.
 */
function buildSellerOrderScope(sellerId, sellerProductIds = []) {
  const normalizedSellerId = normalizeObjectIdString(sellerId);
  if (!normalizedSellerId) return { _id: null };

  const clauses = [
    { orderItems: { $elemMatch: { seller: normalizedSellerId } } },
  ];
  const legacyProductIds = [...normalizedIdSet(sellerProductIds)];
  if (legacyProductIds.length) {
    clauses.push({
      orderItems: {
        $elemMatch: {
          seller: null,
          productId: { $in: legacyProductIds },
        },
      },
    });
  }

  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function buildSellerOrderStatusScope(sellerId, status) {
  const normalizedSellerId = normalizeObjectIdString(sellerId);
  if (!normalizedSellerId) return { _id: null };
  return {
    $or: [
      { sellerFulfillment: { $elemMatch: { seller: normalizedSellerId, status } } },
      {
        $and: [
          { sellerFulfillment: { $not: { $elemMatch: { seller: normalizedSellerId } } } },
          { orderStatus: status },
        ],
      },
    ],
  };
}

function sellerOrderStatus(order, sellerId) {
  return getSellerFulfillment(order, sellerId)?.status || order?.orderStatus;
}

function parseQuantity(value, fallback = 1) {
  return parsePositiveSafeInteger(value, { fallback });
}

function requireStoredAIOrderQuantity(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    const error = new Error('A stored order item has an invalid quantity.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'ORDER_QUANTITY_INVALID';
    throw error;
  }
  return value;
}

function requireStoredAIProductStock(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    const error = new Error('A stored product has invalid stock.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'PRODUCT_STOCK_INVALID';
    throw error;
  }
  return value;
}

function requireStoredAIShippingDeliveryDays(value, fallback = 5) {
  // Pre-deliveryDays shipping rows used the checkout's historical five-day
  // estimate. Only a truly missing/null legacy field may use that sentinel;
  // every value that is present must already be a positive safe integer.
  const deliveryDays = value === null || value === undefined ? fallback : value;
  if (
    typeof deliveryDays !== 'number'
    || !Number.isSafeInteger(deliveryDays)
    || deliveryDays < 1
  ) {
    const error = new Error('A stored shipping method has invalid delivery days.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SHIPPING_DELIVERY_DAYS_INVALID';
    throw error;
  }
  return deliveryDays;
}

async function sellerNativeCurrencyMap(products = []) {
  const sellerIds = [...new Set((products || [])
    .map(product => normalizeObjectIdString(product?.seller))
    .filter(Boolean))];
  if (!sellerIds.length) return new Map();

  const stores = await Store.find({ seller: { $in: sellerIds } })
    .select('seller productCurrency')
    .lean();
  const currencies = new Map();
  for (const store of stores || []) {
    if (store.productCurrency == null || String(store.productCurrency).trim() === '') continue;
    if (typeof store.productCurrency !== 'string' || !store.productCurrency.trim() || !isSupportedCurrency(store.productCurrency)) {
      const error = new Error('A store has invalid product currency metadata.');
      error.status = 409;
      error.statusCode = 409;
      error.code = 'PRODUCT_CURRENCY_METADATA_INVALID';
      throw error;
    }
    currencies.set(
      normalizeObjectIdString(store.seller),
      normalizeCurrency(store.productCurrency),
    );
  }
  return currencies;
}

const stableAIProductCurrency = product => requireStoredProductCurrency(product, 'USD');
const aiProductWriteCurrency = (product, sellerCurrencies = new Map()) => normalizeCurrency(
  sellerCurrencies.get(normalizeObjectIdString(product?.seller))
  || requireStoredProductCurrency(product, 'USD'),
);

function requireStoredAIShippingCurrency(method, fallbackCurrency = 'USD') {
  if (!method || typeof method !== 'object') return normalizeCurrency(fallbackCurrency);
  const plain = method?.toObject ? method.toObject() : method;
  const explicit = ['currency', 'costCurrency']
    .filter(field => !(
      typeof method.$isDefault === 'function' && method.$isDefault(field)
    ))
    .filter(field => Object.prototype.hasOwnProperty.call(plain, field))
    .map(field => plain[field]);
  if (explicit.some(value => (
    typeof value !== 'string'
    || !value
    || value !== value.trim().toUpperCase()
    || !isSupportedCurrency(value)
  ))) {
    const error = new Error('A stored shipping method uses an unsupported currency.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SHIPPING_CURRENCY_METADATA_INVALID';
    throw error;
  }
  const currencies = [...new Set(explicit.map(normalizeCurrency))];
  if (currencies.length > 1) {
    const error = new Error('A stored shipping method has conflicting currency metadata.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SHIPPING_CURRENCY_METADATA_INVALID';
    throw error;
  }
  if (currencies.length === 1) return currencies[0];
  if (
    typeof fallbackCurrency !== 'string'
    || !fallbackCurrency
    || fallbackCurrency !== fallbackCurrency.trim().toUpperCase()
    || !isSupportedCurrency(fallbackCurrency)
  ) {
    const error = new Error('The shipping fallback currency is unsupported.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SHIPPING_CURRENCY_METADATA_INVALID';
    throw error;
  }
  return normalizeCurrency(fallbackCurrency);
}

function requireStoredAIShippingMethod(method, fallbackCurrency = 'USD') {
  const currency = requireStoredAIShippingCurrency(method, fallbackCurrency);
  const cost = method?.cost;
  if (
    !['free', 'standard', 'fast'].includes(method?.type)
    || typeof cost !== 'number'
    || !Number.isFinite(cost)
    || cost < 0
  ) {
    const error = new Error('A stored shipping method has an invalid cost.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SHIPPING_COST_INVALID';
    throw error;
  }
  let normalizedCost;
  try {
    normalizedCost = roundMoney(cost);
  } catch (_) {
    normalizedCost = null;
  }
  if (
    normalizedCost === null
    || normalizedCost !== cost
    || (method.type === 'free' ? cost !== 0 : cost <= 0)
  ) {
    const error = new Error('A stored shipping method has an invalid cost.');
    error.status = 409;
    error.statusCode = 409;
    error.code = 'SHIPPING_COST_INVALID';
    throw error;
  }
  if (method.costInputAmount != null) {
    const inputAmount = method.costInputAmount;
    let normalizedInputAmount = null;
    try {
      normalizedInputAmount = roundMoney(inputAmount);
    } catch (_) {}
    if (
      typeof inputAmount !== 'number'
      || !Number.isFinite(inputAmount)
      || inputAmount < 0
      || normalizedInputAmount !== inputAmount
    ) {
      const error = new Error('A stored shipping method has an invalid input amount.');
      error.status = 409;
      error.statusCode = 409;
      error.code = 'SHIPPING_COST_INVALID';
      throw error;
    }
  }
  return { currency, cost: normalizedCost };
}

function requireStoredAITaxConfig(config) {
  if (!config) return null;
  const invalid = () => {
    const error = new Error('The active tax configuration is invalid.');
    error.status = 503;
    error.statusCode = 503;
    error.code = 'TAX_CONFIG_INVALID';
    return error;
  };
  const type = config.type;
  const value = config.value;
  const currencyIsDefault = typeof config.$isDefault === 'function' && config.$isDefault('currency');
  const hasStoredCurrency = !currencyIsDefault
    && Object.prototype.hasOwnProperty.call(config, 'currency');
  const rawCurrency = hasStoredCurrency ? config.currency : 'USD';
  if (
    !['none', 'percentage', 'fixed'].includes(type)
    || typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || (type === 'none' && value !== 0)
    || (type === 'percentage' && value > 100)
    || typeof rawCurrency !== 'string'
    || !rawCurrency
    || rawCurrency !== rawCurrency.trim().toUpperCase()
    || !isSupportedCurrency(rawCurrency)
  ) throw invalid();
  try {
    if (type === 'fixed' && roundMoney(value) !== value) throw invalid();
    if (type === 'percentage' && roundMoney(value, 6) !== value) throw invalid();
    toMinorUnits(value, type === 'percentage' ? 6 : 2);
  } catch (error) {
    if (error?.code === 'TAX_CONFIG_INVALID') throw error;
    throw invalid();
  }
  return { type, value, currency: normalizeCurrency(rawCurrency) };
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

async function resolveStoreScope(args = {}, activeSellerIds = null) {
  const storeId = toId(args.storeId);
  const sellerId = toId(args.sellerId || args.seller);
  const storeSlug = String(args.storeSlug || args.slug || '').trim().toLowerCase();
  const storeName = String(args.storeName || args.store || '').trim();
  const visibleSellerIds = Array.isArray(activeSellerIds)
    ? activeSellerIds
    : await getActiveSellerIds();
  const visibleSellerIdSet = new Set(visibleSellerIds.map(normalizeObjectIdString));

  if (sellerId) {
    if (!visibleSellerIdSet.has(normalizeObjectIdString(sellerId))) return { notFound: true };
    const store = await Store.findOne(activeStoreQuery({ seller: sellerId }))
      .select('_id seller storeName storeSlug verification.isVerified')
      .lean();
    return store ? { store, filter: { seller: store.seller } } : { notFound: true };
  }

  if (storeId) {
    const store = await Store.findOne(activeStoreQuery({
      _id: storeId,
      seller: { $in: visibleSellerIds },
    }))
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

  const matches = await Store.find(activeStoreQuery({
    seller: { $in: visibleSellerIds },
    $or: storeQueries,
  }))
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

async function commitAIOrderForVisibility({
  orderId,
  userId,
  orderItems,
  removeFromCart,
  session,
}) {
  await commitOrderInventory(orderId, { session });
  if (removeFromCart) {
    await removeFulfilledOrderItemsFromCart({
      userId,
      orderItems,
      fulfillmentId: orderId,
      session,
    });
  }
  const visible = await Order.updateOne(
    { _id: orderId, inventoryCommitted: true },
    { $set: { awaitingPayment: false } },
    { session },
  );
  if (Number(visible?.matchedCount ?? visible?.n ?? 0) !== 1) {
    const error = new Error('The order could not be finalized after inventory was reserved.');
    error.code = 'AI_ORDER_FINALIZATION_CONFLICT';
    throw error;
  }
  const order = await Order.findById(orderId).session(session);
  if (!order) {
    const error = new Error('The order disappeared before notification enqueue.');
    error.code = 'AI_ORDER_NOTIFICATION_SOURCE_MISSING';
    throw error;
  }
  await enqueueCodOrderBuyerConfirmationNotification(order, { session });
  for (const sellerId of [...new Set(
    (order.sellerSettlement || [])
      .map(entry => normalizeObjectIdString(entry?.seller))
      .filter(Boolean)
  )]) {
    await enqueueCodOrderSellerNotifications(order, sellerId, { session });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════

async function executeToolCallUnprotected(toolName, args = {}, user, { propagateErrors = false } = {}) {
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
      amount == null ? requireStoredProductEffectivePrice(product) : amount,
      preferredCurrency,
      { sourceCurrency: requireStoredProductCurrency(product, 'USD') }
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
        const storeScope = await resolveStoreScope(args, activeSellerIds);
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
          const conditions = [
            buildSellerOrderScope(userId, productIds),
            { awaitingPayment: { $ne: true } },
          ];
          if (status && status !== 'all') {
            conditions.push(buildSellerOrderStatusScope(userId, status));
          }
          const filter = { $and: conditions };

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
            const sellerItems = filterSellerOrderItems(o, userId, productIds);
            const sellerMoney = sellerOrderSummaryForItems(o, userId, sellerItems);
            return {
              ...o,
              orderItems: sellerItems,
              _sellerTotal: sellerMoney.total,
              _sellerMoney: sellerMoney,
              _sellerStatus: sellerOrderStatus(o, userId),
            };
          }).filter(o => o.orderItems.length > 0);
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
              status: role === 'seller' ? o._sellerStatus : o.orderStatus,
              total: requireStoredOrderMoney(
                role === 'seller' ? o._sellerTotal : o.orderSummary?.totalAmount,
                role === 'seller' ? 'seller order total' : 'order total',
              ),
              currency: getAccountingOrderCurrency(o),
              money: role === 'seller' ? o._sellerMoney : undefined,
              buyer: role === 'seller' ? (o.user?.username || 'Guest') : undefined,
              items: (o.orderItems || []).map(i => ({
                name: i.name || i.productId?.name,
                price: i.price,
                lineSubtotal: getOrderItemLineSubtotal(i),
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

        let order = await resolveOrderReference({ reference: String(orderId) });
        let sellerProductIds = [];
        if (role === 'seller') {
          // Sellers can view orders containing THEIR products
          const myProducts = await Product.find({ seller: userId }).select('_id').lean();
          sellerProductIds = myProducts.map(p => p._id);
          if (
            order?.awaitingPayment === true
            || filterSellerOrderItems(order, userId, sellerProductIds).length === 0
          ) order = null;
          if (order) {
            await order.populate('orderItems.productId', 'name image price currency priceCurrency category seller');
            await order.populate('user', 'username email');
            order = order.toObject();
          }
        } else if (role === 'admin') {
          // Admins can view any order
          if (order) {
            await order.populate('orderItems.productId', 'name image price currency priceCurrency category');
            await order.populate('user', 'username email');
            order = order.toObject();
          }
        } else {
          // Users can only view their own orders
          if (order && toId(order.user) !== toId(userId)) order = null;
          if (order) {
            await order.populate('orderItems.productId', 'name image price currency priceCurrency category');
            order = order.toObject();
          }
        }

        if (!order) return { success: false, error: 'Order not found or access denied.' };

        // For sellers: filter items to only their products + compute seller subtotal
        let items = order.orderItems || [];
        let summary = order.orderSummary;
        if (role === 'seller') {
          items = filterSellerOrderItems(order, userId, sellerProductIds);
          if (!items.length) return { success: false, error: 'Order not found or access denied.' };
          const sellerMoney = sellerOrderSummaryForItems(order, userId, items);
          summary = { ...sellerMoney, note: 'Shows only your exact allocated share of this order' };
        }

        return {
          success: true,
          data: {
            orderId: order.orderId,
            status: role === 'seller' ? sellerOrderStatus(order, userId) : order.orderStatus,
            buyer: role === 'seller' ? (order.user?.username || 'Guest') : undefined,
            items: items.map(i => ({
              name: i.name || i.productId?.name,
              price: i.price,
              lineSubtotal: getOrderItemLineSubtotal(i),
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

        const order = await resolveOrderReference({ reference: String(orderId) });

        if (!order || toId(order.user) !== toId(userId)) {
          return { success: false, error: 'Order not found or access denied.' };
        }
        if (['delivered', 'cancelled'].includes(order.orderStatus)) {
          return { success: false, error: `Cannot cancel — order is already ${order.orderStatus}.` };
        }

        const cancelledAt = new Date();
        let cancellation;
        try {
          cancellation = await cancelOrderSafely({
            orderId: order._id,
            reason: reason
              ? `Buyer cancelled through Rozare AI: ${String(reason).slice(0, 300)}`
              : 'Buyer cancelled through Rozare AI before payment or shipment.',
            confirmationFields: {
              declinedAt: cancelledAt,
              decidedAt: cancelledAt,
              decidedVia: 'dashboard',
              confirmedVia: order.confirmation?.confirmedVia || 'dashboard',
            },
            cancellationActorRole: 'buyer',
            at: cancelledAt,
          });
        } catch (error) {
          return { success: false, error: error.message, code: error.code };
        }
        if (cancellation.status === 'payment_succeeded') {
          return {
            success: false,
            code: 'PAYMENT_ALREADY_SUCCEEDED',
            error: 'Stripe already received this payment. Waiting for secure confirmation.',
          };
        }

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

        const scopedQuery = buildScopedNotificationQuery({ userId, role });
        const [notifications, totalCount, totalUnread] = await Promise.all([
          Notification.find(scopedQuery).sort({ createdAt: -1 }).limit(safeLimit(limit, 20)).lean(),
          Notification.countDocuments(scopedQuery),
          Notification.countDocuments(buildScopedNotificationQuery({ userId, role, read: false })),
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
          buildScopedNotificationQuery({ userId, role, read: false }),
          { $set: { read: true, readAt: new Date() } }
        );
        return { success: true, message: `Marked ${result.modifiedCount} notification${result.modifiedCount !== 1 ? 's' : ''} as read.` };
      }

      case 'get_available_coupons': {
        const { storeId, productId } = args;
        const now = new Date();
        const activeSellerIds = await getActiveSellerIds();
        const activeSellerSet = new Set(activeSellerIds.map(normalizeObjectIdString));
        if (!activeSellerIds.length) {
          return { success: true, data: { coupons: [], count: 0 }, message: 'No coupons available right now.' };
        }

        let scopedSellerId = null;
        if (storeId != null) {
          const requestedStoreId = toId(String(storeId));
          if (!requestedStoreId) return { success: false, error: 'Please choose a valid store.' };

          if (activeSellerSet.has(requestedStoreId)) {
            scopedSellerId = requestedStoreId;
          } else {
            const store = await Store.findOne(activeStoreQuery({ _id: requestedStoreId }))
              .select('seller')
              .lean();
            const storeSellerId = normalizeObjectIdString(store?.seller);
            if (!storeSellerId || !activeSellerSet.has(storeSellerId)) {
              return { success: false, error: 'That store is not currently available.' };
            }
            scopedSellerId = storeSellerId;
          }
        }

        let scopedProductId = null;
        if (productId != null) {
          scopedProductId = toId(String(productId));
          if (!scopedProductId) return { success: false, error: 'Please choose a valid product.' };
          const product = await Product.findOne(applyActiveSellerProductFilter(
            publicProductFilter({ _id: scopedProductId }),
            activeSellerIds,
          )).select('_id seller').lean();
          const productSellerId = normalizeObjectIdString(product?.seller);
          if (!product || !productSellerId || !activeSellerSet.has(productSellerId)) {
            return { success: false, error: 'That product is not currently available.' };
          }
          if (scopedSellerId && scopedSellerId !== productSellerId) {
            return { success: false, error: 'That product does not belong to the selected store.' };
          }
          scopedSellerId = productSellerId;
        }

        const filter = {
          seller: scopedSellerId || { $in: activeSellerIds },
          isActive: true,
          expiryDate: { $gt: now },
          startDate: { $lte: now },
          $or: [{ maxUses: null }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }],
        };

        let coupons = await Coupon.find(filter)
          .limit(20)
          .populate('seller', 'username')
          .lean();

        if (scopedProductId) {
          coupons = coupons.filter(c =>
            c.applicableTo === 'all' ||
            (c.applicableProducts || []).some(p => normalizeObjectIdString(p) === scopedProductId)
          );
        }
        if (userId) {
          coupons = coupons.filter((coupon) => {
            const userUsageCount = (coupon.usedBy || [])
              .filter(entry => normalizeObjectIdString(entry.user) === normalizeObjectIdString(userId))
              .reduce((total, entry) => total + Math.max(0, Number(entry.count || 0)), 0);
            return userUsageCount < Number(coupon.maxUsesPerUser || 1);
          });
        }

        // Coupon discovery is a financial presentation boundary. Never turn a
        // malformed stored currency or amount into a plausible USD offer.
        // Checkout enforces this same contract again before charging.
        coupons = coupons.filter((coupon) => {
          try {
            assertStoredCouponTerms(coupon);
            requireSupportedCheckoutCurrency(
              coupon.currency,
              'USD',
              'COUPON_CURRENCY_NOT_SUPPORTED',
              { requireCanonical: true, statusCode: 409 },
            );
            return true;
          } catch (_) {
            return false;
          }
        });

        return {
          success: true,
          data: {
            coupons: coupons.map(c => ({
              couponId: c._id,
              code: c.code,
              type: c.discountType,
              value: c.discountValue,
              currency: requireSupportedCheckoutCurrency(
                c.currency,
                'USD',
                'COUPON_CURRENCY_NOT_SUPPORTED',
                { requireCanonical: true, statusCode: 409 },
              ),
              minOrder: c.minOrderAmount,
              maxDiscount: c.maxDiscountAmount,
              expires: c.expiryDate,
              seller: c.seller?.username || 'Unknown',
              sellerId: c.seller?._id || c.seller,
              applicableTo: c.applicableTo,
              applicableProductIds: (c.applicableProducts || []).map(normalizeObjectIdString).filter(Boolean),
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
            currency: requireStoredProductCurrency(product, 'USD'),
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
            currency: requireStoredProductCurrency(product, 'USD'),
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
        const availableStock = requireStoredAIProductStock(product.stock);
        if (availableStock <= 0) return { success: false, error: `"${product.name}" is out of stock.` };
        if (quantity > availableStock) return { success: false, error: `Only ${availableStock} unit${availableStock !== 1 ? 's' : ''} of "${product.name}" are available.` };

        const selection = validateProductSelection(product, { selectedColor, selectedOptions });
        if (!selection.ok) {
          return {
            success: false,
            needsSelection: true,
            error: summarizeSelectionRequest(product, selection, 'add'),
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
          const existingQuantity = requireStoredAIOrderQuantity(
            existing.qty === null || existing.qty === undefined ? 1 : existing.qty,
          );
          if (quantity > availableStock - existingQuantity) {
            return { success: false, error: `You already have ${existingQuantity} in your cart. Only ${availableStock} unit${availableStock !== 1 ? 's' : ''} are available.` };
          }
          existing.qty = existingQuantity + quantity;
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
          message: `"${product.name}" added to cart! 🛒 Cart total: ${await userMoney(
            requireStoredOrderMoney(cart.totalCartPrice, 'cart total'),
            getAccountingOrderCurrency({ currency: cart.totalCartCurrency }),
          )} (${cart.cartItems.length} item${cart.cartItems.length !== 1 ? 's' : ''})`,
        };
      }

      case 'view_cart': {
        if (!userId) return { success: false, error: 'You must be logged in to view cart.' };
        const cart = await Cart.findOne({ user: userId }).populate('cartItems.product').lean();
        if (!cart || !cart.cartItems?.length) {
          return { success: true, data: { items: [], total: 0 }, message: 'Your cart is empty. Start shopping! 🛍️' };
        }

        const activeSellerSet = new Set((await getActiveSellerIds()).map(normalizeObjectIdString));
        const visibleCartItems = cart.cartItems.filter(i => (
          i.product
          && !isProductBlocked(i.product)
          && (!normalizeObjectIdString(i.product.seller) || activeSellerSet.has(normalizeObjectIdString(i.product.seller)))
        ));
        const nativeItems = visibleCartItems.map(item => {
          const p = item.product;
          const sourceCurrency = stableAIProductCurrency(p);
          const sourcePrice = requireStoredProductEffectivePrice(p);
          return {
            _id: item._id,
            productId: p._id,
            name: p.name,
            sourcePrice,
            sourceCurrency,
            originalPrice: p.price,
            quantity: requireStoredAIOrderQuantity(
              item.qty === null || item.qty === undefined ? 1 : item.qty,
            ),
            image: p.image,
            selectedColor: item.selectedColor,
            selectedOptions: plainOptions(item.selectedOptions),
          };
        });
        const cartRateSnapshot = await getExchangeRateSnapshot();
        const items = priceOrderItemLines({
          items: nativeItems,
          targetCurrency: preferredCurrency,
          exchangeRates: cartRateSnapshot.rates,
          exchangeRatesFallback: false,
        }).map(item => ({
          ...item,
          currency: preferredCurrency,
          subtotal: item.lineSubtotal,
        }));

        const visibleCartTotal = sumMoney(items.map(item => item.subtotal));
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
          message: `Item removed from cart. ${cart.cartItems.length} item${cart.cartItems.length !== 1 ? 's' : ''} remaining — ${await userMoney(
            requireStoredOrderMoney(cart.totalCartPrice, 'cart total'),
            getAccountingOrderCurrency({ currency: cart.totalCartCurrency }),
          )}`,
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

        // AI tool loops and WhatsApp/web delivery can be retried after a lost
        // response. Refuse unsafe order creation without a durable logical-send
        // key, then reuse the original order whenever that key is replayed.
        const rawChatRequestKey = String(args._chatRequestKey || '').trim();
        if (!rawChatRequestKey) {
          return {
            success: false,
            code: 'AI_ORDER_IDEMPOTENCY_REQUIRED',
            error: 'This order could not be placed safely. Please send the confirmation again.',
          };
        }
        const aiCheckoutIdempotencyKey = `ai-${crypto.createHash('sha256')
          .update(`${userId}\0${rawChatRequestKey}`)
          .digest('hex')}`;
        const aiRequestFingerprint = aiOrderRequestFingerprint(args);

        const orderSuccessResult = async (placedOrder, reused = false) => {
          const orderCurrency = getAccountingOrderCurrency(placedOrder);
          const total = requireStoredOrderMoney(placedOrder.orderSummary?.totalAmount, 'order total');
          const itemCount = (placedOrder.orderItems || []).length;
          const estimatedDays = placedOrder.shippingMethod?.estimatedDays || 5;
          return {
            success: true,
            reused,
            data: {
              orderId: placedOrder.orderId,
              total,
              currency: orderCurrency,
              items: itemCount,
              paymentMethod: placedOrder.paymentMethod,
              estimatedDelivery: `${estimatedDays} days`,
              reused,
            },
            message: `Order ${reused ? 'already ' : ''}placed successfully! Order #${placedOrder.orderId} — ${await formatMoney(total, orderCurrency, { sourceCurrency: orderCurrency })} — ${itemCount} item${itemCount !== 1 ? 's' : ''} — Cash on Delivery — Est. delivery: ${estimatedDays} days`,
          };
        };

        const existingAIOrder = await Order.findOne({
          user: userId,
          checkoutIdempotencyKey: aiCheckoutIdempotencyKey,
        }).select('+checkoutRequestFingerprint');
        if (existingAIOrder) {
          if (
            existingAIOrder.checkoutRequestFingerprint
            && existingAIOrder.checkoutRequestFingerprint !== aiRequestFingerprint
          ) {
            return {
              success: false,
              code: 'IDEMPOTENCY_KEY_REUSED',
              error: 'This chat request key was already used for different order details. Please confirm the order again.',
            };
          }
          if (
            !existingAIOrder.inventoryCommitted
            || existingAIOrder.awaitingPayment
            || (!productId && !existingAIOrder.cartCleanupCompletedAt)
          ) {
            try {
              // Recover legacy/saved-but-uncommitted rows through the same
              // atomic visibility boundary as a fresh AI COD checkout. Stock,
              // authenticated-cart decrement, its fulfillment receipt, and the
              // order cleanup marker either all commit or all roll back.
              await runInTransaction(session => commitAIOrderForVisibility({
                orderId: existingAIOrder._id,
                userId,
                orderItems: existingAIOrder.orderItems,
                removeFromCart: !productId,
                session,
              }));
              existingAIOrder.inventoryCommitted = true;
              existingAIOrder.awaitingPayment = false;
            } catch (inventoryError) {
              await Order.deleteOne({ _id: existingAIOrder._id, inventoryCommitted: false });
              return {
                success: false,
                code: inventoryError.code || 'ORDER_STOCK_CHANGED',
                error: inventoryError.message,
              };
            }
          }
          return orderSuccessResult(existingAIOrder, true);
        }

        const orderExchangeRateSnapshot = await getExchangeRateSnapshot();
        const orderRates = normalizeRates(orderExchangeRateSnapshot?.rates);
        const hasTrustedOrderRates = Boolean(
          orderRates
          && orderExchangeRateSnapshot?.fallback !== true
        );
        // Even a same-currency non-USD checkout needs a trusted USD conversion
        // snapshot: seller settlement, returns, reversals, and withdrawals are
        // all USD-denominated. Without this guard the amount can be revalued at
        // a future exchange rate instead of the rate accepted at checkout.
        if (preferredCurrency !== 'USD' && !hasTrustedOrderRates) {
          throw exchangeRatesUnavailableError();
        }
        if (!orderRates) throw exchangeRatesUnavailableError();
        const convertForOrder = (amount, fromCurrency, toCurrency) => {
          const from = normalizeCurrency(fromCurrency);
          const to = normalizeCurrency(toCurrency);
          if (orderExchangeRateSnapshot.fallback && from !== to) {
            const error = new Error('Live exchange rates are temporarily unavailable. Please retry the order shortly.');
            error.code = 'EXCHANGE_RATES_UNAVAILABLE';
            throw error;
          }
          return convertAmountWithRates(amount, from, to, orderRates);
        };

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
              countryCode: addr.countryCode || '',
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
        let shippingPhoneSnapshot;
        try {
          shippingPhoneSnapshot = canonicalizeShippingPhone(shipping);
        } catch (phoneError) {
          return {
            success: false,
            code: phoneError.code || 'SHIPPING_PHONE_INVALID',
            error: phoneError.message,
            needsShippingInfo: true,
            data: { invalidShippingFields: ['phone'] },
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
          const availableStock = requireStoredAIProductStock(product.stock);
          if (availableStock <= 0) return { success: false, error: `"${product.name}" is out of stock.` };
          productItems = [product];
          const quantity = parseQuantity(args.quantity, 1);
          if (!quantity) return { success: false, error: 'Please provide a valid quantity of at least 1.' };
          if (quantity > availableStock) return { success: false, error: `Only ${availableStock} unit${availableStock !== 1 ? 's' : ''} of "${product.name}" are available.` };

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

          const sourceCurrency = requireStoredProductCurrency(product, 'USD');
          const sourcePrice = requireStoredProductEffectivePrice(product);
          orderItems = [{
            productId: product._id,
            id: product._id,
            name: product.name,
            image: product.image,
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
            const sourceCurrency = requireStoredProductCurrency(p, 'USD');
            const sourcePrice = requireStoredProductEffectivePrice(p);
            return {
              productId: p._id,
              id: p._id,
              name: p.name,
              image: p.image,
              sourcePrice,
              sourceCurrency,
              // Legacy cart rows could omit qty before the schema default was
              // persisted. Preserve only that nullish sentinel; present
              // corruption must reach the strict stored-quantity check below.
              quantity: item.qty === null || item.qty === undefined ? 1 : item.qty,
              selectedColor: item.selectedColor,
              selectedOptions: item.selectedOptions,
            };
          }));
        }

        if (orderItems.length === 0) return { success: false, error: 'No items to order.' };
        const sellerIds = [...new Set(productItems.map(p => normalizeObjectIdString(p.seller)).filter(Boolean))];
        const sellerStores = await Store.find({ seller: { $in: sellerIds }, isActive: true })
          .select('seller storeName logo paymentPolicy returnPolicy productCurrency')
          .lean();
        const sellerStoreById = new Map(sellerStores.map(store => [normalizeObjectIdString(store.seller), store]));
        for (const item of orderItems) {
          const product = productItems.find(
            candidate => normalizeObjectIdString(candidate._id) === normalizeObjectIdString(item.productId),
          );
          const sellerId = normalizeObjectIdString(product?.seller);
          item.sourceCurrency = requireStoredProductCurrency(product, 'USD');
        }
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
          const quantity = requireStoredAIOrderQuantity(item.quantity);
          const availableStock = requireStoredAIProductStock(product.stock);
          item.quantity = quantity;
          if (quantity > availableStock) {
            return { success: false, error: `Only ${availableStock} unit${availableStock !== 1 ? 's' : ''} of "${product.name}" are available.` };
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

        orderItems = priceOrderItemLines({
          items: orderItems,
          targetCurrency: preferredCurrency,
          exchangeRates: orderRates,
          exchangeRatesFallback: orderExchangeRateSnapshot.fallback,
        });
        const subtotal = sumMoney(orderItems.map(getOrderItemLineSubtotal));

        // Get tax
        let tax = 0;
        const taxConfig = requireStoredAITaxConfig(
          await TaxConfig.findOne({ isActive: true }).lean()
        );
        if (taxConfig && taxConfig.type !== 'none') {
          tax = taxConfig.type === 'percentage'
            ? percentageOfMoney(subtotal, taxConfig.value)
            : (() => {
              const fixedSourceTax = taxConfig.value;
              // A true zero has no FX source. Any positive source cent still
              // requires a trusted snapshot even when it would round to zero
              // after conversion into the buyer's currency.
              return fixedSourceTax > 0
                ? convertForOrder(
                  fixedSourceTax,
                  taxConfig.currency,
                  preferredCurrency
                )
                : 0;
            })();
        }

        // Get shipping method per seller. Cart checkout can contain multiple stores.
        const nativeSellerShipping = [];
        for (const sellerId of sellerIds) {
          let method = {
            key: sellerId,
            seller: sellerId,
            name: 'Standard',
            estimatedDays: 5,
            sourceAmount: 0,
            sourceCurrency: preferredCurrency,
          };
          const sellerConfig = await ShippingMethod.findOne({ seller: sellerId }).lean();
          if (sellerConfig && !Array.isArray(sellerConfig.methods)) {
            const error = new Error('A stored shipping configuration is invalid.');
            error.status = 409;
            error.statusCode = 409;
            error.code = 'SHIPPING_METHOD_INVALID';
            throw error;
          }
          if ((sellerConfig?.methods || []).some(method => (
            method?.isActive !== null
            && method?.isActive !== undefined
            && typeof method.isActive !== 'boolean'
          ))) {
            const error = new Error('A stored shipping method has an invalid active status.');
            error.status = 409;
            error.statusCode = 409;
            error.code = 'SHIPPING_METHOD_INVALID';
            throw error;
          }
          const active = sellerConfig?.methods?.find(method => method.isActive === true);
          if (active) {
            // Existing currency-less ShippingMethod rows predate native
            // shipping metadata and stored canonical USD amounts. Any present
            // unsupported/conflicting metadata is corrupt and must fail closed.
            const storedShipping = requireStoredAIShippingMethod(active, 'USD');
            method = {
              key: sellerId,
              seller: sellerId,
              name: active.type,
              sourceAmount: storedShipping.cost,
              sourceCurrency: storedShipping.currency,
              estimatedDays: requireStoredAIShippingDeliveryDays(active.deliveryDays),
            };
          }
          nativeSellerShipping.push(method);
        }
        const allocatedSellerShipping = await allocateCheckoutAmountsBySource({
          entries: nativeSellerShipping,
          orderCurrency: preferredCurrency,
          exchangeRates: orderRates,
          exchangeRatesFallback: orderExchangeRateSnapshot.fallback,
        });
        const sellerShipping = allocatedSellerShipping.map(entry => ({
          seller: entry.seller,
          shippingMethod: {
            name: entry.name,
            price: entry.targetAmount,
            estimatedDays: entry.estimatedDays,
            sourceCost: entry.sourceAmount,
            sourceCurrency: entry.sourceCurrency,
          },
        }));
        const shippingCost = sumMoney(sellerShipping.map((entry, index) => (
          requireAIDerivedMoney(
            entry.shippingMethod?.price,
            `seller shipping line ${index + 1}`,
            { allowMissing: false },
          )
        )));
        const shippingMethod = sellerShipping[0]?.shippingMethod || { name: 'Standard', price: 0, estimatedDays: 5 };
        if (sellerIds[0]) shippingMethod.seller = sellerIds[0];

        const subtotalRounded = roundMoney(subtotal);
        const shippingCostRounded = roundMoney(shippingCost);
        const taxRounded = roundMoney(tax);
        const totalAmount = sumMoney([subtotalRounded, shippingCostRounded, taxRounded]);
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
            lineSubtotal: item.lineSubtotal,
            sourcePrice: item.sourcePrice,
            sourceCurrency: item.sourceCurrency,
            sourceLineSubtotal: item.sourceLineSubtotal,
            priceOriginal: item.sourcePrice,
            priceCurrency: item.sourceCurrency,
            quantity: item.quantity,
            selectedColor: item.selectedColor || null,
            selectedOptions: item.selectedOptions || undefined,
            returnPolicySnapshotVersion: 1,
            returnPolicy,
          };
        });

        const publicOrderId = await nextShortOrderId();
        const newOrder = new Order({
          user: userId,
          currency: preferredCurrency,
          // Keep even a defensively persisted partial COD attempt hidden from
          // buyers, sellers, fulfillment, and analytics until inventory and
          // authenticated-cart cleanup have committed together.
          awaitingPayment: true,
          ...(hasTrustedOrderRates ? { exchangeRateSnapshot: {
            base: 'USD',
            rates: orderRates,
            capturedAt: new Date(orderExchangeRateSnapshot.capturedAt),
            source: orderExchangeRateSnapshot.source,
            fallback: orderExchangeRateSnapshot.fallback,
          } } : {}),
          checkoutIdempotencyKey: aiCheckoutIdempotencyKey,
          checkoutRequestFingerprint: aiRequestFingerprint,
          orderId: publicOrderId,
          orderIdVersion: 3,
          orderItems: persistedOrderItems,
          shippingInfo: {
            fullName: shipping.fullName,
            email: shipping.email,
            phone: shippingPhoneSnapshot.e164,
            phoneE164: shippingPhoneSnapshot.e164,
            address: shipping.address,
            city: shipping.city,
            state: shipping.state || '',
            postalCode: shipping.postalCode || '',
            country: shipping.country,
            countryCode: shippingPhoneSnapshot.countryCode,
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
              storeLogo: store?.logo || '',
              paymentPolicy: store?.paymentPolicy || 'online_and_cod',
              returnPolicy: normalizeReturnPolicy(store?.returnPolicy || {}),
            };
          }),
          paymentMethod: normalizedPaymentMethod,
        });

        // Freeze the exact seller USD conservation plan before the order ever
        // becomes visible. Later FX changes and rounding cannot alter how this
        // mixed-currency checkout settles across sellers.
        newOrder.sellerSettlementVersion = SELLER_SETTLEMENT_VERSION;
        newOrder.sellerSettlement = buildOrderSellerSettlement(newOrder, {
          requireOrderTotal: true,
        });

        newOrder.confirmation = {
          ...generateConfirmationToken(),
          confirmedAt: null,
          confirmedVia: null,
          declinedAt: null,
        };

        try {
          // The order insert and stock reservation are one visibility boundary.
          // A crash or transaction abort can therefore never expose a normal
          // COD order whose inventory was not committed.
          await mongoose.connection.transaction(async session => {
            await newOrder.save({ session });
            await commitAIOrderForVisibility({
              orderId: newOrder._id,
              userId,
              orderItems: persistedOrderItems,
              removeFromCart: !productId,
              session,
            });
          }, {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          });
          newOrder.inventoryCommitted = true;
          newOrder.awaitingPayment = false;
        } catch (commitError) {
          if (commitError?.code === 11000) {
            const racedOrder = await Order.findOne({
              user: userId,
              checkoutIdempotencyKey: aiCheckoutIdempotencyKey,
            }).select('+checkoutRequestFingerprint');
            if (racedOrder) {
              if (
                racedOrder.checkoutRequestFingerprint
                && racedOrder.checkoutRequestFingerprint !== aiRequestFingerprint
              ) {
                return {
                  success: false,
                  code: 'IDEMPOTENCY_KEY_REUSED',
                  error: 'This chat request key was already used for different order details. Please confirm the order again.',
                };
              }
              if (
                !racedOrder.inventoryCommitted
                || racedOrder.awaitingPayment
                || (!productId && !racedOrder.cartCleanupCompletedAt)
              ) {
                try {
                  await runInTransaction(session => commitAIOrderForVisibility({
                    orderId: racedOrder._id,
                    userId,
                    orderItems: racedOrder.orderItems,
                    removeFromCart: !productId,
                    session,
                  }));
                  racedOrder.inventoryCommitted = true;
                  racedOrder.awaitingPayment = false;
                } catch (inventoryError) {
                  await Order.deleteOne({ _id: racedOrder._id, inventoryCommitted: false });
                  return {
                    success: false,
                    code: inventoryError.code || 'ORDER_STOCK_CHANGED',
                    error: inventoryError.message,
                  };
                }
              }
              return orderSuccessResult(racedOrder, true);
            }
          }
          if (!['ORDER_STOCK_CHANGED', 'ORDER_PRODUCT_INVALID', 'ORDER_QUANTITY_INVALID'].includes(commitError?.code)) {
            throw commitError;
          }
          // Defensive cleanup for deployments that temporarily run without
          // transaction support. In a replica-set transaction the insert has
          // already rolled back and this is a no-op.
          await Order.deleteOne({ _id: newOrder._id, inventoryCommitted: false });
          return {
            success: false,
            code: commitError.code || 'ORDER_STOCK_CHANGED',
            error: commitError.message,
          };
        }
        return orderSuccessResult(newOrder);
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
        if (!userId) {
          return { success: false, code: 'COUPON_LOGIN_REQUIRED', error: 'Log in before validating a coupon against your cart.' };
        }

        const normalizedCode = String(args.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,32}$/.test(normalizedCode)) {
          return { success: false, code: 'COUPON_CODE_INVALID', error: 'Please provide a valid coupon code.' };
        }

        const requestedSellerId = args.sellerId == null ? null : toId(String(args.sellerId));
        const requestedProductId = args.productId == null ? null : toId(String(args.productId));
        if (args.sellerId != null && !requestedSellerId) {
          return { success: false, code: 'COUPON_SELLER_INVALID', error: 'Please choose a valid seller for this coupon.' };
        }
        if (args.productId != null && !requestedProductId) {
          return { success: false, code: 'COUPON_PRODUCT_INVALID', error: 'Please choose a valid cart product for this coupon.' };
        }

        // The browser/LLM cartTotal is deliberately ignored. Coupon previews use
        // the authenticated server cart and the exact same validator as checkout.
        const cart = await Cart.findOne({ user: userId }).populate('cartItems.product').lean();
        if (!cart?.cartItems?.length) {
          return { success: false, code: 'CART_EMPTY', error: 'Your cart is empty. Add products before validating a coupon.' };
        }

        const activeSellerSet = new Set((await getActiveSellerIds()).map(normalizeObjectIdString));
        const unavailableItems = cart.cartItems.filter(item => (
          !item.product
          || isProductBlocked(item.product)
          || !activeSellerSet.has(normalizeObjectIdString(item.product.seller))
        ));
        if (unavailableItems.length) {
          return {
            success: false,
            code: 'CART_ITEM_UNAVAILABLE',
            error: 'Some items in your cart are no longer available. Refresh your cart before validating coupons.',
          };
        }

        const nativeItems = cart.cartItems.map((item) => {
          const product = item.product;
          return {
            _id: item._id,
            productId: product._id,
            seller: product.seller,
            name: product.name,
            sourcePrice: requireStoredProductEffectivePrice(product),
            sourceCurrency: stableAIProductCurrency(product),
            quantity: requireStoredAIOrderQuantity(
              item.qty === null || item.qty === undefined ? 1 : item.qty,
            ),
            selectedColor: item.selectedColor,
            selectedOptions: plainOptions(item.selectedOptions),
          };
        });
        const cartSellerIds = [...new Set(nativeItems.map(item => normalizeObjectIdString(item.seller)).filter(Boolean))];
        const selectedProduct = requestedProductId
          ? nativeItems.find(item => normalizeObjectIdString(item.productId) === requestedProductId)
          : null;
        if (requestedProductId && !selectedProduct) {
          return { success: false, code: 'COUPON_PRODUCT_NOT_IN_CART', error: 'The selected product is not in your current cart.' };
        }
        const selectedSellerId = selectedProduct
          ? normalizeObjectIdString(selectedProduct.seller)
          : requestedSellerId;
        if (requestedSellerId && selectedProduct && normalizeObjectIdString(selectedProduct.seller) !== requestedSellerId) {
          return { success: false, code: 'COUPON_CONTEXT_MISMATCH', error: 'The selected product does not belong to the selected seller.' };
        }
        if (selectedSellerId && !cartSellerIds.includes(selectedSellerId)) {
          return { success: false, code: 'COUPON_SELLER_NOT_IN_CART', error: 'Your cart has no products from the selected seller.' };
        }

        const candidateCoupons = await Coupon.find({
          code: normalizedCode,
          seller: selectedSellerId || { $in: cartSellerIds },
        }).lean();
        if (!candidateCoupons.length) {
          return { success: false, code: 'COUPON_NOT_FOUND', error: `Coupon "${normalizedCode}" is not available for your current cart.` };
        }

        const rateSnapshot = await trustedSnapshotForCurrencyPairs([
          ...nativeItems.map(item => [item.sourceCurrency, preferredCurrency]),
          ...candidateCoupons.map(coupon => [requireSupportedCheckoutCurrency(
            coupon.currency,
            'USD',
            'COUPON_CURRENCY_NOT_SUPPORTED',
            { requireCanonical: true, statusCode: 409 },
          ), preferredCurrency]),
        ]);
        const orderItems = priceOrderItemLines({
          items: nativeItems,
          targetCurrency: preferredCurrency,
          exchangeRates: rateSnapshot?.rates || null,
          exchangeRatesFallback: Boolean(rateSnapshot?.fallback),
        });

        const eligible = [];
        const rejected = [];
        for (const coupon of candidateCoupons) {
          try {
            const pricing = await validateAndPriceCoupons({
              requestedCoupons: [{
                couponId: coupon._id,
                ...(requestedProductId ? { applicableProductIds: [requestedProductId] } : {}),
              }],
              orderItems,
              userId,
              orderCurrency: preferredCurrency,
              exchangeRates: rateSnapshot?.rates || null,
              exchangeRatesFallback: Boolean(rateSnapshot?.fallback),
            });
            eligible.push({ coupon, pricing });
          } catch (error) {
            rejected.push({ coupon, error });
          }
        }

        if (eligible.length > 1) {
          return {
            success: false,
            code: 'COUPON_AMBIGUOUS',
            error: `More than one seller in your cart has coupon "${normalizedCode}". Choose a seller or product before validating it.`,
          };
        }
        if (!eligible.length) {
          if (candidateCoupons.length === 1 && rejected[0]?.error) {
            return {
              success: false,
              code: rejected[0].error.code || 'COUPON_NOT_ELIGIBLE',
              error: rejected[0].error.message,
            };
          }
          return {
            success: false,
            code: 'COUPON_NOT_ELIGIBLE',
            error: `Coupon "${normalizedCode}" is not eligible for your current cart. Choose the seller or product to check a specific coupon.`,
          };
        }

        const { coupon, pricing } = eligible[0];
        const applied = pricing.appliedCoupons[0];
        const discount = applied.appliedDiscountAmount;
        return {
          success: true,
          data: {
            couponId: coupon._id,
            code: coupon.code,
            discount,
            currency: preferredCurrency,
            type: coupon.discountType,
            value: coupon.discountValue,
            couponCurrency: requireSupportedCheckoutCurrency(
              coupon.currency,
              'USD',
              'COUPON_CURRENCY_NOT_SUPPORTED',
              { requireCanonical: true, statusCode: 409 },
            ),
            applicableProductIds: applied.applicableProductIds,
          },
          message: `Coupon "${coupon.code}" is valid for your current cart and saves ${await userMoney(discount, preferredCurrency)}.`,
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
        const invalidCurrency = [
          p.priceCurrency,
          p.currency,
          p.discountedPriceCurrency,
          p.discountedCurrency,
          args.currency,
        ].find(value => !isRecognizedAIPriceCurrency(value));
        if (invalidCurrency !== undefined) {
          return { success: false, error: 'Product currency must be USD, PKR, EUR, or GBP.' };
        }
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
          requestedCurrency: p.priceCurrency || p.currency || args.currency,
          preferredCurrency: productEntryCurrency,
          lastUserText,
          trustRequestedCurrency: true,
        });
        const priceInput = parseMoneyInput(p.price, inputCurrency);
        const rawPrice = normalizeNonNegativeMoneyAmount(priceInput.amount);
        const stock = p.stock != null ? parseNonNegativeSafeInteger(p.stock) : 0;
        const discountedCurrency = resolveAIPriceCurrency({
          value: p.discountedPrice,
          requestedCurrency: p.discountedPriceCurrency || p.discountedCurrency || p.currency || args.currency,
          preferredCurrency: productEntryCurrency,
          fallbackCurrency: inputCurrency,
          lastUserText,
          trustRequestedCurrency: true,
        });
        const discountInput = p.discountedPrice !== undefined && p.discountedPrice !== null
          ? parseMoneyInput(p.discountedPrice, discountedCurrency)
          : { amount: 0, currency: inputCurrency };
        const rawDiscountedPrice = normalizeNonNegativeMoneyAmount(discountInput.amount);
        if (rawPrice === null) return { success: false, error: 'Product price must be a non-negative monetary amount.' };
        if (stock === null) return { success: false, error: 'Product stock must be a non-negative safe whole number.' };
        if (rawDiscountedPrice === null) return { success: false, error: 'Discounted price must be a non-negative monetary amount.' };
        const conversionSnapshot = await trustedSnapshotForCurrencyPairs([
          [priceInput.currency, productEntryCurrency],
          ...(rawDiscountedPrice > 0 ? [[discountInput.currency, productEntryCurrency]] : []),
        ]);
        const convertedPrice = await convertAmountUsingTrustedRates(
          rawPrice,
          priceInput.currency,
          productEntryCurrency,
          conversionSnapshot
        );
        const convertedDiscountedPrice = rawDiscountedPrice > 0
          ? await convertAmountUsingTrustedRates(
            rawDiscountedPrice,
            discountInput.currency,
            productEntryCurrency,
            conversionSnapshot
          )
          : 0;
        let price;
        let discountedPrice;
        try {
          price = assertRepresentablePositiveProductAmount({
            sourceAmount: rawPrice,
            convertedAmount: convertedPrice,
            sourceCurrency: priceInput.currency,
            targetCurrency: productEntryCurrency,
            productLabel: name || 'A product',
            field: 'price',
          });
          discountedPrice = assertRepresentablePositiveProductAmount({
            sourceAmount: rawDiscountedPrice,
            convertedAmount: convertedDiscountedPrice,
            sourceCurrency: discountInput.currency,
            targetCurrency: productEntryCurrency,
            productLabel: name || 'A product',
            field: 'discountedPrice',
          });
        } catch (error) {
          return { success: false, code: error.code, error: error.message };
        }
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
                // Raw legacy products were persisted as canonical USD. The
                // active Store currency is only the target for new writes.
                currency: requireStoredProductCurrency(duplicate, 'USD'),
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
        const product = await withProductCurrencyWriteLock(
          targetSellerId,
          productEntryCurrency,
          async session => {
            if (role === 'seller') {
              await assertSellerCanCreateProducts(targetSellerId, { session });
              if (productData.isFeatured) {
                await assertSellerCanFeatureProduct(targetSellerId, { session });
              }
            }
            const [created] = await Product.create([{
              ...productData,
              ...moderationFields,
            }], { session });
            return created;
          }
        );
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
          // The parent bulk import owns one outer receipt. Running each row
          // through a second copy of that same slot would conflict with it.
          const result = await executeToolCallUnprotected('add_product', {
            ...item,
            sellerId: targetSellerId,
            currency: item.currency || args.currency,
            _lastUserText: args._lastUserText,
            createdVia: 'import',
            confirmDuplicate: item.confirmDuplicate === true || args.confirmDuplicate === true,
          }, user, { propagateErrors: true });
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
        const allowedProductFields = ['name', 'description', 'price', 'discountedPrice', 'currency', 'priceCurrency', 'discountedPriceCurrency', 'category', 'brand', 'stock', 'image', 'imageUrl', 'images', 'tags', 'colors', 'optionGroups', 'returnPolicy', 'isFeatured'];
        const updates = {};
        for (const field of allowedProductFields) {
          if (incomingUpdates[field] !== undefined) updates[field] = incomingUpdates[field];
        }
        const invalidCurrency = [
          incomingUpdates.currency,
          incomingUpdates.priceCurrency,
          incomingUpdates.discountedPriceCurrency,
          args.currency,
        ].find(value => !isRecognizedAIPriceCurrency(value));
        if (invalidCurrency !== undefined) {
          return { success: false, error: 'Product currency must be USD, PKR, EUR, or GBP.' };
        }
        const explicitDiscountUpdate = updates.discountedPrice !== undefined;
        if (!productId && !productName) return { success: false, error: 'Please specify which product to edit (productId or productName).' };
        if (Object.keys(updates).length === 0) return { success: false, error: 'No valid product fields were provided to update.' };
        const lastUserText = cleanString(args._lastUserText);
        const rawPriceInput = updates.price;
        const rawDiscountedPriceInput = updates.discountedPrice;
        const defaultCurrencyOwnerId = role === 'seller'
          ? userId
          : toId(args.sellerId || args.seller);
        const defaultCurrencyState = defaultCurrencyOwnerId
          ? await getSellerProductCurrencyState(defaultCurrencyOwnerId)
          : null;
        const defaultProductCurrency = defaultCurrencyState?.hasStore
          ? defaultCurrencyState.activeCurrency
          : preferredCurrency;
        const inputCurrency = resolveAIPriceCurrency({
          value: updates.price ?? updates.discountedPrice,
          requestedCurrency: args.currency || incomingUpdates.currency,
          preferredCurrency: defaultProductCurrency,
          fallbackCurrency: defaultProductCurrency,
          lastUserText,
          trustRequestedCurrency: true,
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
                trustRequestedCurrency: true,
              })
              : inputCurrency;
            const parsedMoney = ['price', 'discountedPrice'].includes(numericField)
              ? parseMoneyInput(updates[numericField], fieldCurrency)
              : null;
            const numericValue = parsedMoney
              ? normalizeNonNegativeMoneyAmount(parsedMoney.amount)
              : parseNonNegativeSafeInteger(updates[numericField]);
            if (numericValue === null) {
              return { success: false, error: `${numericField} must be a non-negative ${numericField === 'stock' ? 'whole ' : ''}number.` };
            }
            updates[numericField] = numericValue;
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
        const ownerCurrencyState = existingForModeration.seller
          ? await getSellerProductCurrencyState(existingForModeration.seller)
          : null;
        // Raw currency-less legacy Product.price is canonical USD. The Store
        // currency is the write target, not the source interpretation.
        const existingCurrency = requireStoredProductCurrency(existingForModeration, 'USD');
        const nextCurrency = ownerCurrencyState?.hasStore
          ? ownerCurrencyState.activeCurrency
          : existingCurrency;
        // Re-resolve plain numeric inputs against the actual product owner's
        // active store currency. This also covers an admin editing a product by
        // id without supplying sellerId, which cannot be known before lookup.
        if (updates.price !== undefined) {
          const resolvedPriceCurrency = resolveAIPriceCurrency({
            value: rawPriceInput,
            requestedCurrency: incomingUpdates.priceCurrency || args.currency || incomingUpdates.currency,
            preferredCurrency: nextCurrency,
            fallbackCurrency: nextCurrency,
            lastUserText,
            trustRequestedCurrency: true,
          });
          updates.currency = resolvedPriceCurrency;
          updates.priceCurrency = resolvedPriceCurrency;
        }
        if (updates.discountedPrice !== undefined) {
          updates.discountedPriceCurrency = resolveAIPriceCurrency({
            value: rawDiscountedPriceInput,
            requestedCurrency: incomingUpdates.discountedPriceCurrency || args.currency || incomingUpdates.currency,
            preferredCurrency: nextCurrency,
            fallbackCurrency: nextCurrency,
            lastUserText,
            trustRequestedCurrency: true,
          });
        }
        const requestedUpdateCurrency = updates.currency || updates.priceCurrency;

        if (
          updates.price === undefined
          && (
            existingCurrency !== nextCurrency
            || (requestedUpdateCurrency && normalizeCurrency(requestedUpdateCurrency) !== nextCurrency)
          )
        ) {
          return {
            success: false,
            error: `This store saves products in ${nextCurrency}. Include a price to convert, or use Product Currency settings to change every listing safely.`,
          };
        }

        const priceSourceCurrency = normalizeCurrency(updates.priceCurrency || updates.currency || nextCurrency);
        const discountSourceCurrency = normalizeCurrency(
          updates.discountedPriceCurrency || updates.currency || nextCurrency
        );
        const existingDiscountCurrency = requireStoredProductDiscountCurrency(
          existingForModeration,
          existingCurrency,
        );
        const sourcePriceAmount = updates.price;
        const sourceDiscountAmount = updates.discountedPrice;
        const conversionSnapshot = await trustedSnapshotForCurrencyPairs([
          ...(updates.price !== undefined ? [[priceSourceCurrency, nextCurrency]] : []),
          ...(updates.discountedPrice !== undefined
            ? [[discountSourceCurrency, nextCurrency]]
            : updates.price !== undefined && existingForModeration.discountedPrice > 0
              ? [[existingDiscountCurrency, nextCurrency]]
              : []),
        ]);
        if (updates.price !== undefined) {
          const convertedPrice = await convertAmountUsingTrustedRates(
            updates.price,
            priceSourceCurrency,
            nextCurrency,
            conversionSnapshot
          );
          try {
            updates.price = assertRepresentablePositiveProductAmount({
              sourceAmount: sourcePriceAmount,
              convertedAmount: convertedPrice,
              sourceCurrency: priceSourceCurrency,
              targetCurrency: nextCurrency,
              productLabel: existingForModeration.name || 'A product',
              field: 'price',
            });
          } catch (error) {
            return { success: false, code: error.code, error: error.message };
          }
          updates.currency = nextCurrency;
          updates.priceCurrency = nextCurrency;
          updates.priceInputAmount = updates.price;
          updates.priceVersion = 2;
        }

        if (updates.discountedPrice !== undefined) {
          const convertedDiscount = updates.discountedPrice > 0
            ? await convertAmountUsingTrustedRates(
              updates.discountedPrice,
              discountSourceCurrency,
              nextCurrency,
              conversionSnapshot
            )
            : 0;
          try {
            updates.discountedPrice = assertRepresentablePositiveProductAmount({
              sourceAmount: sourceDiscountAmount,
              convertedAmount: convertedDiscount,
              sourceCurrency: discountSourceCurrency,
              targetCurrency: nextCurrency,
              productLabel: existingForModeration.name || 'A product',
              field: 'discountedPrice',
            });
          } catch (error) {
            return { success: false, code: error.code, error: error.message };
          }
          updates.discountedPriceCurrency = nextCurrency;
          updates.discountedPriceInputAmount = updates.discountedPrice;
          updates.priceVersion = 2;
        } else if (updates.price !== undefined && existingForModeration.discountedPrice > 0) {
          const convertedExistingDiscount = await convertAmountUsingTrustedRates(
            existingForModeration.discountedPrice,
            existingDiscountCurrency,
            nextCurrency,
            conversionSnapshot
          );
          let existingDiscount;
          try {
            existingDiscount = assertRepresentablePositiveProductAmount({
              sourceAmount: existingForModeration.discountedPrice,
              convertedAmount: convertedExistingDiscount,
              sourceCurrency: existingDiscountCurrency,
              targetCurrency: nextCurrency,
              productLabel: existingForModeration.name || 'A product',
              field: 'discountedPrice',
            });
          } catch (error) {
            return { success: false, code: error.code, error: error.message };
          }
          if (existingDiscount >= updates.price) {
            updates.discountedPrice = 0;
            updates.discountedPriceCurrency = nextCurrency;
            updates.discountedPriceInputAmount = 0;
          } else {
            updates.discountedPrice = existingDiscount;
            updates.discountedPriceCurrency = nextCurrency;
            updates.discountedPriceInputAmount = existingDiscount;
          }
          updates.priceVersion = 2;
        }

        const finalPrice = updates.price !== undefined ? updates.price : existingForModeration.price;
        if (updates.discountedPrice > 0 && updates.discountedPrice >= finalPrice) {
          if (explicitDiscountUpdate) return { success: false, error: 'Discounted price must be lower than the product price.' };
          updates.discountedPrice = 0;
          updates.discountedPriceInputAmount = 0;
        }
        if (
          Object.prototype.hasOwnProperty.call(updates, 'discountedPrice')
          && !Object.prototype.hasOwnProperty.call(updates, 'price')
        ) {
          // Keep the optimistic atomic write and include the already validated
          // final sibling value so the Product query validator can prove the
          // positive discount invariant in the same database operation.
          updates.price = finalPrice;
        }

        const wasBlocked = isProductBlocked(existingForModeration);
        const { fields: moderationFields } = buildModerationFields({
          ...existingForModeration,
          ...updates,
        }, {
          previouslyBlocked: wasBlocked,
        });
        Object.assign(updates, moderationFields);

        const updateProduct = async session => {
          if (
            role === 'seller'
            && updates.isFeatured === true
            && existingForModeration.isFeatured !== true
          ) {
            await assertSellerCanFeatureProduct(userId, {
              excludeProductId: existingForModeration._id,
              session,
            });
          }
          return Product.findOneAndUpdate(
            {
              ...filter,
              ...(existingForModeration.updatedAt ? { updatedAt: existingForModeration.updatedAt } : {}),
            },
            { $set: updates },
            {
              new: true,
              runValidators: true,
              sort: { updatedAt: -1, createdAt: -1 },
              ...(session ? { session } : {}),
            }
          ).select('name price discountedPrice currency priceCurrency priceInputAmount discountedPriceCurrency discountedPriceInputAmount stock category brand image images tags colors optionGroups returnPolicy isFeatured seller isBlocked blockedReason moderationStatus moderationReason').lean();
        };
        const product = existingForModeration.seller && ownerCurrencyState?.hasStore
          ? await withProductCurrencyWriteLock(existingForModeration.seller, nextCurrency, updateProduct)
          : await updateProduct(null);

        if (!product) {
          return {
            success: false,
            code: 'PRODUCT_UPDATE_CONFLICT',
            error: 'This product changed while your edit was being prepared. Refresh it and try again.',
          };
        }
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
        const updateFeatured = async session => {
          if (featured && role === 'seller' && !product.isFeatured) {
            await assertSellerCanFeatureProduct(userId, {
              excludeProductId: product._id,
              session,
            });
          }
          return Product.findOneAndUpdate(
            filter,
            { $set: { isFeatured: featured } },
            { new: true, runValidators: true, ...(session ? { session } : {}) }
          ).select('name brand price currency priceCurrency stock category isFeatured createdAt').lean();
        };
        const updated = role === 'seller'
          ? await withProductCurrencyWriteLock(
            userId,
            (await getSellerProductCurrencyState(userId)).activeCurrency,
            updateFeatured,
          )
          : await updateFeatured(null);

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
        const rawBulkDiscount = args.discountValue != null ? args.discountValue : args.discountPercent;
        const parsedBulkDiscount = parseStrictFiniteNumber(rawBulkDiscount);
        const discountValue = discountType === 'fixed'
          ? normalizeNonNegativeMoneyAmount(parsedBulkDiscount)
          : parsedBulkDiscount;
        if (discountValue === null || discountValue <= 0) return { success: false, error: 'Please specify a positive discount value.' };
        if (!['percentage', 'fixed'].includes(discountType)) return { success: false, error: 'Discount type must be percentage or fixed.' };
        if (discountType === 'percentage' && discountValue >= 100) return { success: false, error: 'Percentage product discounts must be below 100%.' };
        if (discountType === 'fixed' && !isRecognizedAIPriceCurrency(args.currency)) {
          return { success: false, error: 'Currency must be USD, PKR, EUR, or GBP.' };
        }
        const mutationReceipt = aiActionMutationReceipt('bulk_discount', args, userId);
        const filter = role === 'admin' ? {} : { seller: userId };
        if (productIds?.length) filter._id = { $in: productIds.map(toId).filter(Boolean) };
        else if (cat) filter.category = { $regex: cat, $options: 'i' };

        const products = await Product.find(filter).select('price currency priceCurrency seller updatedAt').lean();
        if (!products.length) return { success: false, error: 'No matching products found.' };
        const sellerCurrencyState = role === 'seller'
          ? await getSellerProductCurrencyState(userId)
          : null;
        const bulkSellerCurrencies = sellerCurrencyState?.hasStore
          ? new Map([[normalizeObjectIdString(userId), sellerCurrencyState.activeCurrency]])
          : await sellerNativeCurrencyMap(products);
        const productCurrencyForBulk = product => aiProductWriteCurrency(product, bulkSellerCurrencies);
        const defaultBulkCurrency = sellerCurrencyState?.hasStore
          ? sellerCurrencyState.activeCurrency
          : preferredCurrency;
        const inputCurrency = resolveAIPriceCurrency({
          value: rawBulkDiscount,
          requestedCurrency: args.currency,
          preferredCurrency: defaultBulkCurrency,
          fallbackCurrency: defaultBulkCurrency,
          lastUserText: args._lastUserText,
          trustRequestedCurrency: true,
        });
        const sourceCurrencyForProduct = product => resolveAIPriceCurrency({
          value: rawBulkDiscount,
          requestedCurrency: args.currency,
          preferredCurrency: sellerCurrencyState?.hasStore
            ? sellerCurrencyState.activeCurrency
            : productCurrencyForBulk(product),
          fallbackCurrency: sellerCurrencyState?.hasStore
            ? sellerCurrencyState.activeCurrency
            : productCurrencyForBulk(product),
          lastUserText: args._lastUserText,
          trustRequestedCurrency: true,
        });
        const conversionSnapshot = await trustedSnapshotForCurrencyPairs(products.flatMap(product => {
          const targetCurrency = productCurrencyForBulk(product);
          return [
            [requireStoredProductCurrency(product, 'USD'), targetCurrency],
            ...(discountType === 'fixed'
              ? [[sourceCurrencyForProduct(product), targetCurrency]]
              : []),
          ];
        }));

        let bulkOps;
        try {
          bulkOps = await Promise.all(products.map(async p => {
            const productCurrency = productCurrencyForBulk(p);
            const existingCurrency = requireStoredProductCurrency(p, 'USD');
            const normalizedBasePrice = await convertAmountUsingTrustedRates(
              p.price,
              existingCurrency,
              productCurrency,
              conversionSnapshot
            );
            const basePrice = assertRepresentablePositiveProductAmount({
              sourceAmount: p.price,
              convertedAmount: normalizedBasePrice,
              sourceCurrency: existingCurrency,
              targetCurrency: productCurrency,
              productLabel: p.name || `Product ${p._id}`,
              field: 'price',
            });
            const fixedDiscount = discountType === 'fixed'
              ? assertRepresentableProductAdjustment({
                sourceAmount: discountValue,
                convertedAmount: await convertAmountUsingTrustedRates(
                  discountValue,
                  sourceCurrencyForProduct(p),
                  productCurrency,
                  conversionSnapshot
                ),
                sourceCurrency: sourceCurrencyForProduct(p),
                targetCurrency: productCurrency,
                productLabel: p.name || `Product ${p._id}`,
              })
              : 0;
            const candidateDiscountedPrice = discountType === 'percentage'
              ? roundMoney(basePrice - percentageOfMoney(basePrice, discountValue))
              : Math.max(0, roundMoney(basePrice - fixedDiscount));
            const discountedPrice = assertEffectiveProductDiscount({
              regularPrice: basePrice,
              discountedPrice: candidateDiscountedPrice,
              productLabel: p.name || `Product ${p._id}`,
            });
            return {
              updateOne: {
                filter: {
                  _id: p._id,
                  ...(role === 'seller' ? { seller: userId } : {}),
                  ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
                },
                update: {
                  $set: {
                    price: basePrice,
                    currency: productCurrency,
                    priceCurrency: productCurrency,
                    priceInputAmount: basePrice,
                    discountedPrice,
                    discountedPriceCurrency: productCurrency,
                    discountedPriceInputAmount: discountedPrice,
                    priceVersion: 2,
                  },
                },
              },
            };
          }));
        } catch (error) {
          if (String(error?.code || '').startsWith('PRODUCT_')) {
            return { success: false, code: error.code, error: error.message };
          }
          throw error;
        }
        const actionResult = {
          success: true,
          message: `Applied ${discountType === 'percentage' ? `${discountValue}%` : await formatMoney(discountValue, inputCurrency, { sourceCurrency: inputCurrency })} discount to ${products.length} product${products.length !== 1 ? 's' : ''}!`,
        };
        const writeResult = await writeAIProductUpdatesAtomically(bulkOps, {
          sellerId: role === 'seller' ? userId : null,
          expectedCurrency: sellerCurrencyState?.activeCurrency,
          receipt: mutationReceipt ? { ...mutationReceipt, result: actionResult } : null,
        });

        return writeResult?.actionResult || actionResult;
      }

      case 'bulk_price_update': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productIds, category: cat } = args;
        const updateType = args.updateType || (args.isPercent ? 'percentage' : 'fixed');
        const rawBulkValue = args.value != null ? args.value : args.priceChange;
        const parsedBulkValue = parseStrictFiniteNumber(rawBulkValue);
        const value = updateType === 'percentage'
          ? parsedBulkValue
          : normalizeMoneyAmount(parsedBulkValue, { nonNegative: updateType === 'set' });
        if (value === null) return { success: false, error: 'Please specify a valid price update value.' };
        if (!['percentage', 'fixed', 'set'].includes(updateType)) return { success: false, error: 'Price update type must be percentage, fixed, or set.' };
        if (updateType === 'percentage') {
          try {
            applyProductPricePercentage(0, value);
          } catch (error) {
            return { success: false, code: error.code, error: error.message };
          }
        }
        if (updateType !== 'percentage' && !isRecognizedAIPriceCurrency(args.currency)) {
          return { success: false, error: 'Currency must be USD, PKR, EUR, or GBP.' };
        }
        const mutationReceipt = aiActionMutationReceipt('bulk_price_update', args, userId, {
          required: updateType === 'fixed' || updateType === 'percentage',
        });
        const filter = role === 'admin' ? {} : { seller: userId };
        if (productIds?.length) filter._id = { $in: productIds.map(toId).filter(Boolean) };
        else if (cat) filter.category = { $regex: cat, $options: 'i' };

        const products = await Product.find(filter)
          .select('price discountedPrice currency priceCurrency discountedPriceCurrency seller updatedAt')
          .lean();
        if (!products.length) return { success: false, error: 'No matching products found.' };
        const sellerCurrencyState = role === 'seller'
          ? await getSellerProductCurrencyState(userId)
          : null;
        const bulkSellerCurrencies = sellerCurrencyState?.hasStore
          ? new Map([[normalizeObjectIdString(userId), sellerCurrencyState.activeCurrency]])
          : await sellerNativeCurrencyMap(products);
        const productCurrencyForBulk = product => aiProductWriteCurrency(product, bulkSellerCurrencies);
        const defaultBulkCurrency = sellerCurrencyState?.hasStore
          ? sellerCurrencyState.activeCurrency
          : preferredCurrency;
        const inputCurrency = resolveAIPriceCurrency({
          value: rawBulkValue,
          requestedCurrency: args.currency,
          preferredCurrency: defaultBulkCurrency,
          fallbackCurrency: defaultBulkCurrency,
          lastUserText: args._lastUserText,
          trustRequestedCurrency: true,
        });
        const sourceCurrencyForProduct = product => resolveAIPriceCurrency({
          value: rawBulkValue,
          requestedCurrency: args.currency,
          preferredCurrency: sellerCurrencyState?.hasStore
            ? sellerCurrencyState.activeCurrency
            : productCurrencyForBulk(product),
          fallbackCurrency: sellerCurrencyState?.hasStore
            ? sellerCurrencyState.activeCurrency
            : productCurrencyForBulk(product),
          lastUserText: args._lastUserText,
          trustRequestedCurrency: true,
        });
        const conversionSnapshot = await trustedSnapshotForCurrencyPairs(products.flatMap(product => {
          const targetCurrency = productCurrencyForBulk(product);
          const existingCurrency = requireStoredProductCurrency(product, 'USD');
          return [
            [existingCurrency, targetCurrency],
            ...(requireStoredProductDiscountPrice(product) > 0
              ? [[requireStoredProductDiscountCurrency(product, existingCurrency), targetCurrency]]
              : []),
            ...(updateType !== 'percentage'
              ? [[sourceCurrencyForProduct(product), targetCurrency]]
              : []),
          ];
        }));

        let bulkOps;
        try {
          bulkOps = await Promise.all(products.map(async p => {
            const productCurrency = productCurrencyForBulk(p);
            const existingCurrency = requireStoredProductCurrency(p, 'USD');
            const normalizedBasePrice = await convertAmountUsingTrustedRates(
              p.price,
              existingCurrency,
              productCurrency,
              conversionSnapshot
            );
            const basePrice = assertRepresentablePositiveProductAmount({
              sourceAmount: p.price,
              convertedAmount: normalizedBasePrice,
              sourceCurrency: existingCurrency,
              targetCurrency: productCurrency,
              productLabel: p.name || `Product ${p._id}`,
              field: 'price',
            });
            const existingDiscountCurrency = requireStoredProductDiscountCurrency(p, existingCurrency);
            const retainedDiscount = requireStoredProductDiscountPrice(p) > 0
              ? assertRepresentablePositiveProductAmount({
                sourceAmount: p.discountedPrice,
                convertedAmount: await convertAmountUsingTrustedRates(
                  p.discountedPrice,
                  existingDiscountCurrency,
                  productCurrency,
                  conversionSnapshot
                ),
                sourceCurrency: existingDiscountCurrency,
                targetCurrency: productCurrency,
                productLabel: p.name || `Product ${p._id}`,
                field: 'discountedPrice',
              })
              : 0;
            const sourceValueCurrency = sourceCurrencyForProduct(p);
            const rawConvertedValue = updateType === 'percentage'
              ? value
              : await convertAmountUsingTrustedRates(
                value,
                sourceValueCurrency,
                productCurrency,
                conversionSnapshot
              );
            const convertedValue = updateType === 'set'
              ? assertRepresentablePositiveProductAmount({
                sourceAmount: value,
                convertedAmount: rawConvertedValue,
                sourceCurrency: sourceValueCurrency,
                targetCurrency: productCurrency,
                productLabel: p.name || `Product ${p._id}`,
                field: 'price',
              })
              : updateType === 'fixed'
                ? assertRepresentableProductAdjustment({
                  sourceAmount: value,
                  convertedAmount: rawConvertedValue,
                  sourceCurrency: sourceValueCurrency,
                  targetCurrency: productCurrency,
                  productLabel: p.name || `Product ${p._id}`,
                })
                : rawConvertedValue;
            let newPrice;
            if (updateType === 'set') newPrice = convertedValue;
            else if (updateType === 'percentage') {
              newPrice = applyProductPricePercentage(basePrice, value);
              assertRepresentableProductAdjustment({
                sourceAmount: value,
                convertedAmount: newPrice - basePrice,
                sourceCurrency: productCurrency,
                targetCurrency: productCurrency,
                productLabel: p.name || `Product ${p._id}`,
              });
            } else newPrice = basePrice + convertedValue;
            newPrice = Math.max(0, roundMoney(newPrice));
            const update = {
              price: newPrice,
              currency: productCurrency,
              priceCurrency: productCurrency,
              priceInputAmount: newPrice,
              priceVersion: 2,
              discountedPrice: retainedDiscount > 0 && retainedDiscount < newPrice
                ? retainedDiscount
                : 0,
              discountedPriceInputAmount: retainedDiscount > 0 && retainedDiscount < newPrice
                ? retainedDiscount
                : 0,
              discountedPriceCurrency: productCurrency,
            };
            return {
              updateOne: {
                filter: {
                  _id: p._id,
                  ...(role === 'seller' ? { seller: userId } : {}),
                  ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
                },
                update: { $set: update },
              },
            };
          }));
        } catch (error) {
          if (String(error?.code || '').startsWith('PRODUCT_')) {
            return { success: false, code: error.code, error: error.message };
          }
          throw error;
        }
        const actionResult = {
          success: true,
          message: `Updated prices for ${products.length} product${products.length !== 1 ? 's' : ''} (${updateType}: ${value}).`,
        };
        const writeResult = await writeAIProductUpdatesAtomically(bulkOps, {
          sellerId: role === 'seller' ? userId : null,
          expectedCurrency: sellerCurrencyState?.activeCurrency,
          receipt: mutationReceipt ? { ...mutationReceipt, result: actionResult } : null,
        });

        return writeResult?.actionResult || actionResult;
      }

      case 'remove_discount': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { productIds, category: cat } = args;
        const filter = role === 'admin' ? {} : { seller: userId };
        if (productIds?.length) filter._id = { $in: productIds.map(toId).filter(Boolean) };
        else if (cat) filter.category = { $regex: cat, $options: 'i' };

        const result = await Product.updateMany(
          filter,
          { $set: { discountedPrice: 0, discountedPriceInputAmount: 0 } },
          { runValidators: true },
        );
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

        const orders = await Order.find({
          $and: [
            buildSellerOrderScope(userId, productIds),
            { awaitingPayment: { $ne: true } },
          ],
        })
          .select('orderSummary appliedCoupons orderStatus sellerFulfillment sellerPolicies isPaid isDelivered paymentMethod createdAt orderItems sellerShipping shippingMethod currency exchangeRateSnapshot sellerSettlementVersion sellerSettlement sellerCurrencyMoneyVersion sellerCurrencyMoney')
          .lean();
        const sellerOrders = orders
          .map(order => ({
            order,
            items: filterSellerOrderItems(order, userId, productIds),
            status: sellerOrderStatus(order, userId),
          }))
          .filter(entry => entry.items.length > 0);

        // Revenue follows the same exact allocation contract as seller
        // Payments: confirmed card/Wallet sales and delivered COD portions.
        const paidSellerOrders = sellerOrders.filter(({ order }) => isSellerRevenueRecognized(order, userId));
        const revenueEntries = paidSellerOrders.map(({ order, items }) => {
          const sellerMoney = sellerOrderSummaryForItems(order, userId, items);
          const native = sellerCurrencyMoneyPresentation(order, userId, items);
          return {
            amount: native?.summary?.totalAmount ?? sellerMoney.totalAmount,
            currency: native?.currency || order.currency,
          };
        });
        const totalRevenue = await sumCurrencyAmountsInCurrency(revenueEntries, preferredCurrency);

        const statusCounts = {};
        sellerOrders.forEach(({ status }) => {
          const sellerStatus = status || 'pending';
          statusCounts[sellerStatus] = (statusCounts[sellerStatus] || 0) + 1;
        });

        // Top products by order frequency
        const productFreq = {};
        paidSellerOrders.forEach(({ items }) => {
          items.forEach(item => {
            const key = item.name || normalizeObjectIdString(item.productId);
            productFreq[key] = (productFreq[key] || 0) + item.quantity;
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
            totalOrders: sellerOrders.length,
            totalRevenue: roundMoney(totalRevenue),
            currency: preferredCurrency,
            storeViews: store?.views || 0,
            trustCount: store?.trustCount || 0,
            ordersByStatus: statusCounts,
            topProducts,
            lowStockAlerts: lowStock.map(p => ({ name: p.name, stock: p.stock })),
          },
          message: `📊 Store "${store?.storeName}": ${myProducts.length} products, ${sellerOrders.length} orders, ${await userMoney(totalRevenue, preferredCurrency)} revenue, ${store?.views || 0} views.`,
        };
      }

      case 'get_seller_payments': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const targetSellerId = role === 'admin' && args.sellerId ? toId(args.sellerId) : userId;
        if (!targetSellerId) return { success: false, error: 'Seller not found.' };

        const paymentSummary = await buildSellerPaymentSummary(targetSellerId, { displayCurrency: preferredCurrency });
        const revenue = paymentSummary.revenue || {};
        const withdrawableBalance = requireAIDerivedMoney(revenue.withdrawableBalance, 'withdrawable balance');
        const codDeliveredRevenue = requireAIDerivedMoney(revenue.codDeliveredRevenue, 'delivered COD revenue');
        const totalDeliveredRevenue = requireAIDerivedMoney(revenue.totalDeliveredRevenue, 'total delivered revenue');
        const estimatedRevenue = requireAIDerivedMoney(revenue.estimatedRevenue, 'estimated revenue');
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
          message: `Payments summary: withdrawable online balance ${await formatMoney(withdrawableBalance, preferredCurrency)}, delivered COD revenue ${await formatMoney(codDeliveredRevenue, preferredCurrency)}, total delivered revenue ${await formatMoney(totalDeliveredRevenue, preferredCurrency)}, estimated revenue ${await formatMoney(estimatedRevenue, preferredCurrency)}.`,
        };
      }

      case 'get_seller_orders': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const { status, limit } = args;

        const myProducts = await Product.find({ seller: userId }).select('_id').lean();
        const productIds = myProducts.map(p => p._id);

        const sellerScope = buildSellerOrderScope(userId, productIds);
        const conditions = [sellerScope, { awaitingPayment: { $ne: true } }];
        if (status && status !== 'all') {
          conditions.push(buildSellerOrderStatusScope(userId, status));
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
          const sellerItems = filterSellerOrderItems(o, userId, productIds);
          const sellerMoney = sellerOrderSummaryForItems(o, userId, sellerItems);
          const fulfillment = getSellerFulfillment(o, userId);
          return {
            orderId: o.orderId,
            status: fulfillment?.status || o.orderStatus,
            buyer: o.user?.username || o.guestEmail || 'Guest',
            total: sellerMoney.total,
            itemCount: sellerMoney.itemCount,
            money: sellerMoney,
            date: o.createdAt,
            paymentMethod: o.paymentMethod,
            isPaid: o.isPaid,
          };
        }).filter(order => order.itemCount > 0);

        return {
          success: true,
          data: { orders: sellerOrders, count: sellerOrders.length, totalCount },
          message: `You have ${totalCount} total order${totalCount !== 1 ? 's' : ''}${status ? ` with status "${status}"` : ''} for your store (showing ${sellerOrders.length}).`,
        };
      }

      case 'update_order_status': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        if (role !== 'seller' && role !== 'admin') {
          return { success: false, error: 'Only sellers and admins can update order status.' };
        }
        const { orderId } = args;
        const newStatus = args.newStatus || args.status;
        if (!orderId || !newStatus) return { success: false, error: 'Please provide orderId and new status.' };

        const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
        if (!validStatuses.includes(newStatus)) {
          return { success: false, error: `Invalid status. Valid: ${validStatuses.join(', ')}` };
        }

        // Verify seller owns products in this order. Admins can update any order.
        const productIds = role === 'admin'
          ? []
          : (await Product.find({ seller: userId }).select('_id').lean()).map(p => p._id.toString());

        let order = await resolveOrderReference({ reference: String(orderId) });
        if (
          order
          && role !== 'admin'
          && (
            order.awaitingPayment === true
            || filterSellerOrderItems(order, userId, productIds).length === 0
          )
        ) order = null;
        if (!order) {
          return role === 'admin'
            ? { success: false, error: 'Order not found.' }
            : { success: false, error: 'This order doesn\'t contain your products.' };
        }

        const ownsItems = role === 'admin' || filterSellerOrderItems(order, userId, productIds).length > 0;
        if (!ownsItems) return { success: false, error: 'This order doesn\'t contain your products.' };

        const sellerIds = await ensureOrderSellerFulfillment(order);
        if (newStatus === 'cancelled') {
          if (role === 'seller' && sellerIds.length > 1) {
            return {
              success: false,
              error: 'A seller cannot safely cancel only one portion of a multi-seller order yet. Contact support so stock and payment accounting remain correct.',
              code: 'PARTIAL_ORDER_CANCELLATION_UNSUPPORTED',
            };
          }
          const cancellationAt = new Date();
          const buyerAlreadyDecided = !!(
            order.confirmation?.confirmedAt
            || order.confirmation?.declinedAt
          );
          const confirmationFields = buyerAlreadyDecided ? {} : {
            declinedAt: cancellationAt,
            confirmedVia: role === 'admin' ? 'admin' : 'manual',
            decidedAt: cancellationAt,
            decidedVia: role === 'admin' ? 'admin' : 'manual',
          };
          const cancellation = await cancelOrderSafely({
            orderId: order._id,
            reason: role === 'admin'
              ? 'Order cancelled by an administrator through Rozare AI before payment or shipment.'
              : 'Single-seller order cancelled by its seller through Rozare AI before shipment.',
            confirmationFields,
            cancellationActorRole: role,
            at: cancellationAt,
          });
          if (cancellation.status === 'payment_succeeded') {
            return {
              success: false,
              error: 'Stripe already received this payment. Waiting for secure webhook confirmation.',
              code: 'PAYMENT_ALREADY_SUCCEEDED',
            };
          }
          const cancelledOrder = cancellation.order;
          return {
            success: true,
            data: {
              status: 'cancelled',
              aggregateOrderStatus: cancelledOrder.orderStatus,
            },
            message: `Order #${cancelledOrder.orderId} status updated to "cancelled"`,
          };
        }

        const { order: transitionedOrder } = await transitionOrderFulfillment({
          orderId: order._id,
          actorRole: role,
          actorId: userId,
          sellerIds,
          newStatus,
        });

        return {
          success: true,
          data: {
            status: role === 'seller' ? sellerOrderStatus(transitionedOrder, userId) : transitionedOrder.orderStatus,
            aggregateOrderStatus: transitionedOrder.orderStatus,
          },
          message: `Order #${transitionedOrder.orderId} status updated to "${newStatus}"`,
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
        let pendingSlugChange = null;
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
          if (existingStore.subdomainPurchase?.paymentRiskState === 'open') {
            return {
              success: false,
              error: 'Your purchased subdomain has an unresolved Stripe payment dispute. It cannot be changed until the dispute is resolved.',
              code: 'SUBDOMAIN_PAYMENT_RISK_OPEN',
            };
          }
          const slug = sanitizeSubdomain(normalizedUpdates.storeSlug);
          if (isPlaceholderValue(slug)) {
            return { success: false, error: 'No subdomain was provided. Ask the seller what new subdomain they want before updating.' };
          }
          const slugValidation = validateStoreSlug(slug);
          if (!slugValidation.valid) {
            return {
              success: false,
              error: slugValidation.msg,
              code: slugValidation.code,
            };
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
            // The actual write is delegated to the canonical locked CAS
            // boundary below. It re-checks paid ownership/risk after taking the
            // same resource lock used by Stripe Checkout and materializes an
            // immutable old-slug ledger before any confirmed forfeiture.
            pendingSlugChange = {
              expectedSlug: existingStore.storeSlug,
              newSlug: slug,
              confirmPurchasedForfeit: normalizedRaw.confirmSubdomainChange === true,
            };
            delete normalizedUpdates.storeSlug;
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

        if (Object.keys(normalizedUpdates).length === 0 && !pendingSlugChange) {
          return { success: false, error: 'No changes to apply.' };
        }

        let updatedStore;
        let forfeitedPurchasedOwnership = false;
        if (pendingSlugChange) {
          const result = await changeStoreSlug({
            storeId: existingStore._id,
            sellerId: userId,
            expectedSlug: pendingSlugChange.expectedSlug,
            newSlug: pendingSlugChange.newSlug,
            confirmPurchasedForfeit: pendingSlugChange.confirmPurchasedForfeit,
            additionalSet: normalizedUpdates,
            actor: {
              type: 'ai',
              id: userId,
              reason: 'Seller-confirmed subdomain change through Rozare AI',
            },
          });
          updatedStore = result.store.toObject();
          forfeitedPurchasedOwnership = result.forfeitedPurchasedOwnership;
        } else {
          updatedStore = await Store.findOneAndUpdate(
            { seller: userId },
            { $set: normalizedUpdates },
            { new: true, runValidators: true }
          ).select('storeName storeSlug description paymentPolicy lastNameChangeAt lastSlugChangeAt lastTypeChangeAt').lean();
        }

        const updatedFields = [
          ...Object.keys(normalizedUpdates).filter(k => !k.startsWith('last')),
          ...(pendingSlugChange ? ['storeSlug'] : []),
        ];

        return {
          success: true,
          message: `Store "${updatedStore.storeName}" updated successfully.`,
          data: {
            storeName: updatedStore.storeName,
            slug: updatedStore.storeSlug,
            paymentPolicy: updatedStore.paymentPolicy || 'online_and_cod',
            updatedFields,
            ...(forfeitedPurchasedOwnership ? { purchasedOwnershipForfeited: true } : {}),
            changeLimits: storeChangeLimits(updatedStore),
          },
        };
      }

      case 'get_store_analytics': {
        // Alias — same as get_seller_analytics
        return executeToolCallUnprotected('get_seller_analytics', args, user);
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
        const methods = (shipping?.methods || []).map(entry => {
          const { currency, cost } = requireStoredAIShippingMethod(entry, 'USD');
          return {
            ...entry,
            cost,
            currency,
            costCurrency: currency,
            costInputAmount: entry.costInputAmount == null
              ? cost
              : roundMoney(entry.costInputAmount),
          };
        });
        return {
          success: true,
          data: { methods },
          message: methods.length
            ? `You have ${methods.length} shipping method(s) configured.`
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

        const requestedShippingCurrency = shippingUpdates.currency ?? args.currency;
        if (requestedShippingCurrency != null && !isSupportedCurrency(requestedShippingCurrency)) {
          return { success: false, error: 'Shipping currency must be USD, PKR, EUR, or GBP.' };
        }
        let shippingCost = null;
        if (cost !== undefined && cost !== null) {
          shippingCost = normalizeNonNegativeMoneyAmount(cost);
          if (shippingCost === null) {
            return { success: false, error: 'Shipping cost must be a non-negative number.' };
          }
        }
        if (method === 'free' && shippingCost != null && shippingCost !== 0) {
          return { success: false, error: 'Free shipping must have a cost of 0.' };
        }
        if (method !== 'free' && shippingCost !== null && shippingCost <= 0) {
          return { success: false, error: 'Paid shipping must cost at least 0.01.' };
        }
        if (deliveryDays != null) {
          const numericDays = parsePositiveSafeInteger(deliveryDays);
          if (numericDays === null) {
            return { success: false, error: 'Delivery days must be a whole number of at least 1.' };
          }
          deliveryDays = numericDays;
        }
        if (isActive != null && typeof isActive !== 'boolean') {
          return { success: false, error: 'Shipping active status must be true or false.' };
        }

        let shipping = await ShippingMethod.findOne({ seller: userId });
        if (!shipping) {
          shipping = new ShippingMethod({ seller: userId, methods: [] });
        }

        const existing = shipping.methods.find(m => m.type === method);
        const existingStoredMethod = existing
          ? requireStoredAIShippingMethod(existing, 'USD')
          : null;
        const existingCurrency = existingStoredMethod?.currency || null;
        const sellerCurrencyState = await getSellerProductCurrencyState(userId);
        const shippingCurrency = normalizeCurrency(
          requestedShippingCurrency
          || existingCurrency
          || (sellerCurrencyState?.hasStore ? sellerCurrencyState.activeCurrency : null)
          || preferredCurrency
        );
        if (
          existing
          && method !== 'free'
          && requestedShippingCurrency != null
          && shippingCost == null
          && existingCurrency !== shippingCurrency
        ) {
          return { success: false, error: 'Provide the shipping cost together with its new currency.' };
        }
        if (method !== 'free' && !existing && !(shippingCost > 0)) {
          return { success: false, error: 'A paid shipping method requires a cost greater than 0.' };
        }
        if (method !== 'free' && shippingCost != null && shippingCost <= 0) {
          return { success: false, error: 'A paid shipping method requires a cost of at least 0.01.' };
        }
        if (existing) {
          if (method === 'free') {
            existing.cost = 0;
            existing.currency = shippingCurrency;
            existing.costCurrency = shippingCurrency;
            existing.costInputAmount = 0;
          } else if (shippingCost != null) {
            existing.cost = shippingCost;
            existing.currency = shippingCurrency;
            existing.costCurrency = shippingCurrency;
            existing.costInputAmount = shippingCost;
          }
          if (deliveryDays != null) existing.deliveryDays = deliveryDays;
          if (isActive != null) existing.isActive = isActive;
        } else {
          if (method !== 'free' && shippingCost === null) {
            return { success: false, error: 'Provide a positive cost for paid shipping.' };
          }
          shipping.methods.push({
            type: method,
            cost: method === 'free' ? 0 : shippingCost,
            currency: shippingCurrency,
            costCurrency: shippingCurrency,
            costInputAmount: method === 'free' ? 0 : shippingCost,
            deliveryDays: deliveryDays ?? 3,
            isActive: isActive !== false,
          });
        }
        if (!shipping.methods.some(entry => entry.isActive !== false)) {
          return { success: false, error: 'At least one shipping method must remain active.' };
        }
        await shipping.save();

        return { success: true, message: `Shipping method "${method}" updated! 🚚` };
      }

      case 'create_coupon': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const c = args.coupon || args;
        const inferredDiscountType = c.discountType || (c.discountPercent != null ? 'percentage' : 'fixed');
        const rawDiscountValue = c.discountValue ?? c.discountPercent ?? c.fixedAmount ?? c.amount;
        if (rawDiscountValue === undefined || rawDiscountValue === null || rawDiscountValue === '') {
          return { success: false, error: 'Please provide the coupon discount value, such as 10% or 500 off.' };
        }
        if (!['percentage', 'fixed'].includes(inferredDiscountType)) {
          return { success: false, error: 'Coupon discountType must be percentage or fixed.' };
        }
        const requestedCouponCurrency = c.currency ?? args.currency;
        if (requestedCouponCurrency != null && !isSupportedCurrency(requestedCouponCurrency)) {
          return { success: false, error: 'Coupon currency must be USD, PKR, EUR, or GBP.' };
        }
        // Validate the money shape before any database lookup. Currency does
        // not alter the numeric input, and malformed AI tool calls must fail
        // without waiting on Store persistence.
        const parsedDiscountValue = parseMoneyInput(
          rawDiscountValue,
          requestedCouponCurrency || preferredCurrency,
        ).amount;
        const unroundedDiscountValue = parseStrictFiniteNumber(parsedDiscountValue);
        if (unroundedDiscountValue === null || unroundedDiscountValue <= 0) {
          return { success: false, error: 'Coupon discountValue must be a positive number.' };
        }
        let discountValue = inferredDiscountType === 'fixed'
          ? normalizeNonNegativeMoneyAmount(unroundedDiscountValue)
          : unroundedDiscountValue;
        if (inferredDiscountType === 'fixed' && (!discountValue || discountValue < 0.01)) {
          return { success: false, error: 'A fixed coupon amount must be at least 0.01.' };
        }
        if (inferredDiscountType === 'percentage' && (discountValue < 0.01 || discountValue > 100)) {
          return { success: false, error: 'Percentage coupon discounts must be between 0.01% and 100%.' };
        }
        const startDate = c.startDate ? new Date(c.startDate) : new Date();
        const expiryDate = c.expiryDate ? new Date(c.expiryDate) : addDays(new Date(), 30);
        if (Number.isNaN(startDate.getTime())) return { success: false, error: 'Coupon startDate is invalid.' };
        if (Number.isNaN(expiryDate.getTime())) return { success: false, error: 'Coupon expiryDate is invalid.' };
        if (expiryDate <= new Date()) return { success: false, error: 'Coupon expiryDate must be in the future.' };
        if (startDate >= expiryDate) return { success: false, error: 'Coupon expiryDate must be after startDate.' };
        const maxUses = c.maxUses == null ? null : parsePositiveSafeInteger(c.maxUses);
        const maxUsesPerUser = c.maxUsesPerUser == null ? 1 : parsePositiveSafeInteger(c.maxUsesPerUser);
        const rawMinOrderAmount = c.minOrderAmount == null
          ? 0
          : parseStrictFiniteNumber(c.minOrderAmount);
        let minOrderAmount = rawMinOrderAmount === null
          ? null
          : normalizeNonNegativeMoneyAmount(rawMinOrderAmount);
        const rawMaxDiscountAmount = c.maxDiscountAmount ?? c.maxDiscount;
        let maxDiscountAmount = rawMaxDiscountAmount == null
          ? null
          : normalizeNonNegativeMoneyAmount(rawMaxDiscountAmount);
        if (c.maxUses != null && maxUses === null) return { success: false, error: 'maxUses must be a positive safe whole number.' };
        if (maxUsesPerUser === null) return { success: false, error: 'maxUsesPerUser must be a positive safe whole number.' };
        if (rawMinOrderAmount > 0 && minOrderAmount === null) {
          return { success: false, error: 'minOrderAmount must be zero or large enough to represent at least 0.01.' };
        }
        if (minOrderAmount === null) return { success: false, error: 'minOrderAmount must be zero or higher.' };
        if (rawMaxDiscountAmount != null && (maxDiscountAmount === null || maxDiscountAmount <= 0)) return { success: false, error: 'maxDiscountAmount must be a positive number.' };
        if (maxDiscountAmount !== null && maxDiscountAmount <= 0) {
          return { success: false, error: 'maxDiscountAmount must be at least 0.01.' };
        }
        const applicableTo = c.applicableTo === 'selected' ? 'selected' : 'all';
        const applicableProducts = Array.isArray(c.applicableProducts)
          ? c.applicableProducts.map(toId).filter(Boolean)
          : [];
        if (applicableTo === 'selected') {
          if (!applicableProducts.length) return { success: false, error: 'Please choose at least one product for a selected-product coupon.' };
          const ownedCount = await Product.countDocuments({ _id: { $in: applicableProducts }, seller: userId });
          if (ownedCount !== applicableProducts.length) return { success: false, error: 'Some selected products were not found in your store.' };
        }
        const couponCurrencyState = await assertProductCreationAllowed(userId);
        const defaultCouponCurrency = couponCurrencyState.activeCurrency;
        const inputCurrency = resolveAIPriceCurrency({
          value: rawDiscountValue,
          requestedCurrency: requestedCouponCurrency,
          preferredCurrency: defaultCouponCurrency,
          fallbackCurrency: defaultCouponCurrency,
          lastUserText: args._lastUserText,
          trustRequestedCurrency: true,
        });
        const storedCouponCurrency = couponCurrencyState.activeCurrency;
        const convertedCreateMoney = await convertAICouponMoneyEntries([
          ...(inferredDiscountType === 'fixed' ? [{
            field: 'discountValue',
            value: discountValue,
            sourceCurrency: inputCurrency,
          }] : []),
          {
            field: 'minOrderAmount',
            value: minOrderAmount,
            sourceCurrency: inputCurrency,
          },
          ...(maxDiscountAmount === null ? [] : [{
            field: 'maxDiscountAmount',
            value: maxDiscountAmount,
            sourceCurrency: inputCurrency,
          }]),
        ], storedCouponCurrency, {
          tooSmallMessage: 'A coupon amount is too small to represent in your store product currency.',
        });
        if (inferredDiscountType === 'fixed') discountValue = convertedCreateMoney.discountValue;
        minOrderAmount = convertedCreateMoney.minOrderAmount;
        if (maxDiscountAmount !== null) maxDiscountAmount = convertedCreateMoney.maxDiscountAmount;
        const code = await uniqueCouponCode(userId, { ...c, discountType: inferredDiscountType, discountValue });

        const coupon = await Coupon.create({
          seller: userId,
          code,
          discountType: inferredDiscountType,
          discountValue,
          currency: storedCouponCurrency,
          applicableTo,
          applicableProducts: applicableTo === 'selected' ? applicableProducts : [],
          maxUses,
          maxUsesPerUser,
          minOrderAmount,
          maxDiscountAmount,
          startDate,
          expiryDate,
          description: c.description || '',
        });

        return {
          success: true,
          data: { couponId: coupon._id, code: coupon.code, expiryDate: coupon.expiryDate },
          message: `Coupon "${coupon.code}" created - ${coupon.discountType === 'percentage' ? coupon.discountValue + '%' : await formatMoney(coupon.discountValue, storedCouponCurrency, { sourceCurrency: storedCouponCurrency })} off, expiring ${coupon.expiryDate.toISOString().slice(0, 10)}.`,
        };
      }

      case 'get_my_coupons': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const coupons = await Coupon.find({ seller: userId }).sort({ createdAt: -1 }).lean();
        coupons.forEach(assertStoredCouponTerms);

        return {
          success: true,
          data: {
            coupons: coupons.map(c => ({
              _id: c._id,
              code: c.code,
              type: c.discountType,
              value: c.discountValue,
              currency: requireSupportedCheckoutCurrency(
                c.currency,
                'USD',
                'COUPON_CURRENCY_NOT_SUPPORTED',
                { requireCanonical: true, statusCode: 409 },
              ),
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
        if (updates.currency === undefined && args.currency !== undefined) {
          updates.currency = args.currency;
        }
        const coupon = await resolveSellerCoupon(userId, args);
        if (!coupon) return { success: false, error: 'Please specify a valid coupon code or choose a coupon from your coupon list.' };
        if (Object.keys(updates).length === 0) return { success: false, error: 'No valid coupon fields were provided to update.' };
        assertStoredCouponTerms(coupon);
        const originalCurrency = requireSupportedCheckoutCurrency(
          coupon.currency,
          'USD',
          'COUPON_CURRENCY_NOT_SUPPORTED',
          { requireCanonical: true, statusCode: 409 },
        );
        const originalDiscountType = coupon.discountType;
        const originalMoney = {
          discountValue: coupon.discountValue,
          minOrderAmount: coupon.minOrderAmount,
          maxDiscountAmount: coupon.maxDiscountAmount,
        };
        const hasDiscountValueUpdate = Object.prototype.hasOwnProperty.call(updates, 'discountValue');
        const hasMinOrderAmountUpdate = Object.prototype.hasOwnProperty.call(updates, 'minOrderAmount');
        const hasMaxDiscountAmountUpdate = Object.prototype.hasOwnProperty.call(updates, 'maxDiscountAmount');
        if (updates.currency !== undefined) {
          const requestedCurrency = updates.currency;
          if (!isSupportedCurrency(requestedCurrency)) {
            return { success: false, error: 'Coupon currency must be USD, PKR, EUR, or GBP.' };
          }
          updates.currency = normalizeCurrency(requestedCurrency);
        }
        const targetCurrency = requireSupportedCheckoutCurrency(
          updates.currency === undefined ? originalCurrency : updates.currency,
          originalCurrency,
          'COUPON_CURRENCY_NOT_SUPPORTED',
          { requireCanonical: true, statusCode: 409 },
        );
        if (targetCurrency !== originalCurrency) {
          const productCurrencyState = await assertProductCreationAllowed(userId);
          if (targetCurrency !== productCurrencyState.activeCurrency) {
            return {
              success: false,
              code: 'COUPON_CURRENCY_STORE_MISMATCH',
              error: `Coupon currency can only be converted to your active store product currency (${productCurrencyState.activeCurrency}).`,
            };
          }
        }
        if (updates.discountType && !['percentage', 'fixed'].includes(updates.discountType)) {
          return { success: false, error: 'Coupon discountType must be percentage or fixed.' };
        }
        const finalDiscountType = updates.discountType || coupon.discountType;
        if (finalDiscountType !== originalDiscountType && !hasDiscountValueUpdate) {
          return { success: false, error: 'Provide a new discountValue when changing the coupon discountType.' };
        }
        let explicitDiscountValueCurrency = targetCurrency;
        let explicitMinOrderCurrency = targetCurrency;
        let explicitMaxDiscountCurrency = targetCurrency;
        if (updates.discountValue !== undefined) {
          const parsedValue = parseMoneyInput(
            updates.discountValue,
            targetCurrency,
          );
          explicitDiscountValueCurrency = parsedValue.currency;
          const numericValue = finalDiscountType === 'fixed'
            ? normalizeNonNegativeMoneyAmount(parsedValue.amount)
            : parseStrictFiniteNumber(parsedValue.amount);
          if (numericValue === null || numericValue <= 0) {
            return { success: false, error: 'discountValue must be a positive number.' };
          }
          updates.discountValue = numericValue;
        }
        if (updates.maxUses !== undefined && updates.maxUses !== null) {
          const numericValue = parsePositiveSafeInteger(updates.maxUses);
          if (numericValue === null) {
            return { success: false, error: 'maxUses must be a positive whole number or null.' };
          }
          updates.maxUses = numericValue;
        }
        if (updates.maxUsesPerUser !== undefined) {
          const numericValue = parsePositiveSafeInteger(updates.maxUsesPerUser);
          if (numericValue === null) {
            return { success: false, error: 'maxUsesPerUser must be a positive whole number.' };
          }
          updates.maxUsesPerUser = numericValue;
        }
        if (updates.maxDiscountAmount !== undefined && updates.maxDiscountAmount !== null) {
          const parsedValue = parseMoneyInput(updates.maxDiscountAmount, targetCurrency);
          explicitMaxDiscountCurrency = parsedValue.currency;
          const numericValue = normalizeNonNegativeMoneyAmount(parsedValue.amount);
          if (numericValue === null || numericValue <= 0) {
            return { success: false, error: 'maxDiscountAmount must be a positive number or null.' };
          }
          updates.maxDiscountAmount = numericValue;
          if (updates.maxDiscountAmount <= 0) {
            return { success: false, error: 'maxDiscountAmount must be at least 0.01.' };
          }
        }
        if (updates.minOrderAmount !== undefined && updates.minOrderAmount !== null) {
          const parsedValue = parseMoneyInput(updates.minOrderAmount, targetCurrency);
          explicitMinOrderCurrency = parsedValue.currency;
          const unroundedValue = parseStrictFiniteNumber(parsedValue.amount);
          const numericValue = normalizeNonNegativeMoneyAmount(unroundedValue);
          if (unroundedValue > 0 && numericValue === null) {
            return { success: false, error: 'minOrderAmount must be zero or large enough to represent at least 0.01.' };
          }
          if (numericValue === null) {
            return { success: false, error: 'minOrderAmount must be zero or higher.' };
          }
          updates.minOrderAmount = numericValue;
        }
        if (finalDiscountType === 'fixed') {
          const roundedFixedValue = normalizeNonNegativeMoneyAmount(updates.discountValue ?? coupon.discountValue);
          if (roundedFixedValue === null || roundedFixedValue <= 0) {
            return { success: false, error: 'A fixed coupon amount must be at least 0.01.' };
          }
          if (hasDiscountValueUpdate) updates.discountValue = roundedFixedValue;
        }

        const moneyConversions = [];
        if (finalDiscountType === 'fixed' && hasDiscountValueUpdate) {
          moneyConversions.push({
            field: 'discountValue',
            value: updates.discountValue,
            sourceCurrency: explicitDiscountValueCurrency,
          });
        }
        if (hasMinOrderAmountUpdate && updates.minOrderAmount != null) {
          moneyConversions.push({
            field: 'minOrderAmount',
            value: updates.minOrderAmount,
            sourceCurrency: explicitMinOrderCurrency,
          });
        }
        if (hasMaxDiscountAmountUpdate && updates.maxDiscountAmount != null) {
          moneyConversions.push({
            field: 'maxDiscountAmount',
            value: updates.maxDiscountAmount,
            sourceCurrency: explicitMaxDiscountCurrency,
          });
        }
        if (targetCurrency !== originalCurrency) {
          if (
            finalDiscountType === 'fixed'
            && originalDiscountType === 'fixed'
            && !hasDiscountValueUpdate
          ) {
            moneyConversions.push({
              field: 'discountValue',
              value: originalMoney.discountValue,
              sourceCurrency: originalCurrency,
            });
          }
          if (!hasMinOrderAmountUpdate) {
            moneyConversions.push({
              field: 'minOrderAmount',
              value: originalMoney.minOrderAmount,
              sourceCurrency: originalCurrency,
            });
          }
          if (!hasMaxDiscountAmountUpdate && originalMoney.maxDiscountAmount != null) {
            moneyConversions.push({
              field: 'maxDiscountAmount',
              value: originalMoney.maxDiscountAmount,
              sourceCurrency: originalCurrency,
            });
          }
        }

        const conversionsRequiringRates = moneyConversions.filter(entry => (
          Number(entry.value) !== 0
          && normalizeCurrency(entry.sourceCurrency) !== targetCurrency
        ));
        if (conversionsRequiringRates.length) {
          // Explicit source currencies and retained terms share one snapshot,
          // preventing a single coupon update from mixing FX tables.
          const exchangeRateSnapshot = await getExchangeRateSnapshot();
          for (const entry of conversionsRequiringRates) {
            const convertedValue = await convertAmountUsingTrustedRates(
              entry.value,
              entry.sourceCurrency,
              targetCurrency,
              exchangeRateSnapshot,
            );
            if (Number(entry.value) > 0 && convertedValue <= 0) {
              const error = new Error(
                'A coupon amount is too small to represent in the requested currency. Provide a larger amount explicitly.',
              );
              error.code = 'COUPON_AMOUNT_TOO_SMALL_AFTER_CONVERSION';
              throw error;
            }
            updates[entry.field] = convertedValue;
          }
        }
        if (finalDiscountType === 'fixed' && !(updates.discountValue ?? coupon.discountValue)) {
          return { success: false, error: 'A fixed coupon amount must be at least 0.01.' };
        }
        if (updates.maxDiscountAmount != null && updates.maxDiscountAmount <= 0) {
          return { success: false, error: 'maxDiscountAmount must be at least 0.01.' };
        }
        const finalDiscountValue = updates.discountValue ?? coupon.discountValue;
        if (finalDiscountType === 'percentage' && (finalDiscountValue < 0.01 || finalDiscountValue > 100)) {
          return { success: false, error: 'Percentage coupon discounts must be between 0.01% and 100%.' };
        }
        if (updates.startDate !== undefined) {
          const startDate = new Date(updates.startDate);
          if (Number.isNaN(startDate.getTime())) return { success: false, error: 'Coupon startDate is invalid.' };
          updates.startDate = startDate;
        }
        if (updates.expiryDate !== undefined) {
          const expiryDate = new Date(updates.expiryDate);
          if (Number.isNaN(expiryDate.getTime())) return { success: false, error: 'Coupon expiryDate is invalid.' };
          if (expiryDate <= new Date()) return { success: false, error: 'Coupon expiryDate must be in the future.' };
          updates.expiryDate = expiryDate;
        }
        const finalStartDate = new Date(updates.startDate || coupon.startDate);
        const finalExpiryDate = new Date(updates.expiryDate || coupon.expiryDate);
        if (finalStartDate >= finalExpiryDate) {
          return { success: false, error: 'Coupon expiryDate must be after startDate.' };
        }
        if (updates.isActive !== undefined && typeof updates.isActive !== 'boolean') {
          return { success: false, error: 'Coupon active status must be true or false.' };
        }
        if (updates.applicableTo !== undefined && !['all', 'selected'].includes(updates.applicableTo)) {
          return { success: false, error: 'Coupon applicableTo must be all or selected.' };
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
        try {
          await coupon.save();
        } catch (error) {
          if (error?.name === 'VersionError') {
            return {
              success: false,
              code: 'COUPON_UPDATE_CONFLICT',
              error: 'This coupon changed while your update was being saved. Refresh it and retry.',
            };
          }
          throw error;
        }
        return { success: true, message: `Coupon "${coupon.code}" updated.` };
      }

      case 'delete_coupon': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        const coupon = await resolveSellerCoupon(userId, args);
        if (!coupon) return { success: false, error: 'Please specify a valid coupon code or choose a coupon from your coupon list.' };
        try {
          await deleteCouponIfUnreserved({ couponId: coupon._id, sellerId: userId });
        } catch (error) {
          if (error.code === 'COUPON_HAS_ACTIVE_RESERVATIONS') {
            return { success: false, code: error.code, error: error.message };
          }
          throw error;
        }
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
        try {
          await coupon.save();
        } catch (error) {
          if (error?.name === 'VersionError') {
            return {
              success: false,
              code: 'COUPON_UPDATE_CONFLICT',
              error: 'This coupon changed while its status was being saved. Refresh it and retry.',
            };
          }
          throw error;
        }
        return { success: true, message: `Coupon "${coupon.code}" is now ${coupon.isActive ? 'active' : 'inactive'}.` };
      }

      case 'get_subscription_status': {
        if (!userId) return { success: false, error: 'Authentication required.' };
        if (role !== 'seller') {
          return {
            success: false,
            error: 'A seller account is required to view seller-specific subscription status.',
          };
        }
        const subscription = await getSellerSubscriptionStatusData(userId);

        return {
          success: true,
          data: subscription,
          message: buildSubscriptionStatusMessage(subscription),
        };
      }

      case 'get_subscription_catalog':
        return {
          success: true,
          data: getSubscriptionCatalog(),
          message: 'Current Rozare seller-subscription catalog loaded.',
        };

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

        await deleteAccountCascade(targetId);

        return {
          success: true,
          message: `User "${target.username}" was deleted. Historical order and financial evidence was retained.`,
        };
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
          Order.countDocuments({ awaitingPayment: { $ne: true } }),
          Product.countDocuments(),
          Store.countDocuments(),
          Store.countDocuments({ 'verification.status': 'pending' }),
          Complaint.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
          dateFilter.createdAt
            ? Order.countDocuments({ ...dateFilter, awaitingPayment: { $ne: true } })
            : Promise.resolve(null),
        ]);

        const revenueOrders = await Order.find({
          awaitingPayment: { $ne: true },
          orderStatus: { $ne: 'cancelled' },
        })
          .select('orderItems orderSummary appliedCoupons sellerShipping shippingMethod sellerFulfillment paymentMethod isPaid isDelivered orderStatus currency')
          .lean();
        const legacyProductIds = [...new Set(revenueOrders.flatMap(order => (
          (order.orderItems || [])
            .filter(item => !item?.seller)
            .map(item => normalizeObjectIdString(item?.productId))
            .filter(Boolean)
        )))];
        const legacyProducts = legacyProductIds.length
          ? await Product.find({ _id: { $in: legacyProductIds } }).select('_id seller').lean()
          : [];
        const productSellerById = new Map(legacyProducts.map(product => [
          normalizeObjectIdString(product._id),
          normalizeObjectIdString(product.seller),
        ]));
        const revenueEntries = [];
        for (const order of revenueOrders) {
          const allocations = buildOrderItemMoneyAllocations(order);
          (order.orderItems || []).forEach((item, index) => {
            const sellerId = normalizeObjectIdString(item?.seller)
              || productSellerById.get(normalizeObjectIdString(item?.productId))
              || '';
            const method = order.paymentMethod || 'cash_on_delivery';
            const globallyRecognized = method === 'cash_on_delivery'
              ? (order.orderStatus === 'delivered' || order.isDelivered === true)
              : (['stripe', 'wallet'].includes(method) && order.isPaid === true);
            if (!(sellerId ? isSellerRevenueRecognized(order, sellerId) : globallyRecognized)) return;
            const allocationKey = orderItemKey(item, index, allocations.itemKeys);
            if (!allocations.total.has(allocationKey)) {
              throw actionError(
                'A stored order line has no deterministic money allocation.',
                'ORDER_MONEY_INVALID',
                409,
              );
            }
            revenueEntries.push({
              order,
              amount: allocations.total.get(allocationKey),
            });
          });
        }
        const totalRevenue = await sumOrderAmountsInCurrency(revenueEntries, preferredCurrency);

        return {
          success: true,
          data: {
            users: { total: totalUsers + totalSellers + totalAdmins, customers: totalUsers, sellers: totalSellers, admins: totalAdmins },
            orders: { total: totalOrders, ...(periodOrders != null ? { inPeriod: periodOrders } : {}) },
            revenue: roundMoney(totalRevenue),
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
              total: requireStoredOrderMoney(o.orderSummary?.totalAmount, 'order total'),
              currency: getAccountingOrderCurrency(o),
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

        if (!store || (role !== 'admin' && (
          store.seller?.role !== 'seller' || store.seller?.status !== 'active'
        ))) return { success: false, error: 'Store not found.' };
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
        const current = await TaxConfig.findOne({ isActive: true }).lean();
        const storedCurrent = requireStoredAITaxConfig(current);
        const requestedType = Object.prototype.hasOwnProperty.call(args, 'type')
          ? String(args.type || '').trim()
          : (current?.type || 'none');
        const hasExplicitTaxValue = Object.prototype.hasOwnProperty.call(args, 'value');
        if (
          current
          && requestedType !== 'none'
          && requestedType !== current.type
          && !hasExplicitTaxValue
        ) {
          return {
            success: false,
            code: 'TAX_VALUE_REQUIRED_FOR_TYPE_CHANGE',
            error: 'Provide a new tax value when changing the tax type.',
          };
        }
        const update = normalizeTaxConfigUpdate(args, current, preferredCurrency);
        update.updatedBy = userId;

        if (
          current?.type === 'fixed'
          && update.type === 'fixed'
          && !hasExplicitTaxValue
          && storedCurrent.currency !== update.currency
        ) {
          const retainedSourceValue = storedCurrent.value;
          if (retainedSourceValue > 0) {
            const exchangeRateSnapshot = await getExchangeRateSnapshot();
            update.value = await convertAmountUsingTrustedRates(
              retainedSourceValue,
              storedCurrent.currency,
              update.currency,
              exchangeRateSnapshot,
            );
            if (update.value <= 0) {
              const error = new Error(
                'The retained fixed tax is too small to represent in the new currency. Provide the new value explicitly.',
              );
              error.code = 'TAX_AMOUNT_TOO_SMALL_AFTER_CONVERSION';
              throw error;
            }
          } else {
            update.value = 0;
          }
        }

        let config;
        if (current) {
          const versionFilter = current.__v === null || current.__v === undefined
            ? { $or: [{ __v: { $exists: false } }, { __v: 0 }] }
            : { __v: current.__v };
          config = await TaxConfig.findOneAndUpdate(
            { _id: current._id, isActive: true, ...versionFilter },
            { $set: update, $inc: { __v: 1 } },
            { new: true, runValidators: true }
          ).lean();
          if (!config) {
            return {
              success: false,
              code: 'TAX_CONFIG_UPDATE_CONFLICT',
              error: 'The tax configuration changed while your update was being saved. Refresh it and retry.',
            };
          }
        } else {
          try {
            config = await TaxConfig.create(update);
          } catch (error) {
            if (error?.code === 11000) {
              return {
                success: false,
                code: 'TAX_CONFIG_UPDATE_CONFLICT',
                error: 'The tax configuration changed while your update was being saved. Refresh it and retry.',
              };
            }
            throw error;
          }
        }

        const safeConfig = requireStoredAITaxConfig(
          typeof config?.toObject === 'function' ? config.toObject() : config,
        );

        return {
          success: true,
          data: config,
          message: `Tax config updated: ${safeConfig.type === 'none' ? 'taxes disabled' : `${safeConfig.type} — ${safeConfig.type === 'percentage' ? safeConfig.value + '%' : `${safeConfig.currency} ${safeConfig.value}`}`}.`,
        };
      }

      case 'get_tax_config': {
        const config = await TaxConfig.findOne({ isActive: true }).lean();
        if (!config) return { success: true, data: { type: 'none', value: 0, currency: 'USD' }, message: 'No tax configured.' };
        const safeConfig = requireStoredAITaxConfig(config);

        return {
          success: true,
          data: { ...safeConfig, isActive: config.isActive },
          message: `Tax: ${safeConfig.type === 'none' ? 'disabled' : `${safeConfig.type} — ${safeConfig.type === 'percentage' ? safeConfig.value + '%' : `${safeConfig.currency} ${safeConfig.value}`}`}.`,
        };
      }

      case 'send_broadcast': {
        if (!userId) return { success: false, error: 'Authentication required.' };
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
        const scheduleType = args.scheduleType || (args.scheduledAt ? 'one_time' : 'immediate');
        const { job: broadcast } = await createBroadcastJob({
          input: {
            title: args.title,
            body: args.body || args.message,
            category: args.category,
            audience,
            userIds,
            channels: args.channels,
            scheduleType,
            scheduledAt: args.scheduledAt,
            recurrence: args.recurrence,
            endsAt: args.endsAt,
            linkTo: args.linkTo,
          },
          createdBy: userId,
          // The AI tool queues immediate jobs for the atomic scheduler. It does
          // not dispatch in this request, so it must not claim a delivery lease.
          claimImmediate: false,
        });

        return {
          success: true,
          data: { broadcastId: broadcast._id },
          message: `Broadcast "${broadcast.title}" created and ${scheduleType === 'immediate' ? 'will be sent now' : 'scheduled'}! 📣`,
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

        const cancellation = await cancelScheduledBroadcast(broadcastId);
        if (cancellation.outcome === 'not_found') {
          return { success: false, error: 'Broadcast not found.' };
        }
        if (cancellation.outcome === 'sending') {
          return { success: false, error: 'Broadcast delivery has already started and can no longer be cancelled.' };
        }
        if (cancellation.outcome !== 'cancelled') {
          return { success: false, error: 'Broadcast is already finalized and can no longer be cancelled.' };
        }
        return { success: true, message: `Broadcast "${cancellation.job.title}" cancelled.` };
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
          seller: { $in: activeSellerIds },
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
    if (propagateErrors) throw err;
    console.error(`[aiActionExecutor] Error executing ${toolName}:`, err.message);
    return {
      success: false,
      error: `Failed to execute ${toolName}: ${err.message}`,
      ...(err.code ? { code: err.code } : {}),
    };
  }
}

function normalizeTaxConfigUpdate(args = {}, current = null, preferredCurrency = 'USD') {
  if (current) requireStoredAITaxConfig(current);
  const has = field => Object.prototype.hasOwnProperty.call(args, field);
  const type = has('type') ? String(args.type || '').trim() : (current?.type || 'none');
  if (!['none', 'percentage', 'fixed'].includes(type)) {
    const error = new Error('Tax type must be none, percentage, or fixed.');
    error.code = 'TAX_TYPE_INVALID';
    throw error;
  }

  const rawValue = has('value') ? args.value : (current?.value ?? 0);
  const numericValue = parseStrictFiniteNumber(rawValue);
  if (numericValue === null || numericValue < 0) {
    const error = new Error('Tax value must be a non-negative number.');
    error.code = 'TAX_VALUE_INVALID';
    throw error;
  }
  if (type === 'percentage' && numericValue > 100) {
    const error = new Error('Percentage tax cannot exceed 100%.');
    error.code = 'TAX_VALUE_INVALID';
    throw error;
  }
  try {
    const scale = type === 'percentage' ? 6 : 2;
    if (type !== 'none' && roundMoney(numericValue, scale) !== numericValue) {
      const error = new Error(
        type === 'percentage'
          ? 'Percentage tax supports at most 6 decimal places.'
          : 'Fixed tax must be an exact amount to cents.',
      );
      error.code = 'TAX_VALUE_PRECISION_INVALID';
      throw error;
    }
  } catch (error) {
    if (error?.code === 'TAX_VALUE_PRECISION_INVALID') throw error;
    const invalid = new Error('Tax value is outside the supported numeric range.');
    invalid.code = 'TAX_VALUE_INVALID';
    throw invalid;
  }

  let currency = 'USD';
  if (type === 'fixed') {
    const requestedCurrency = has('currency')
      ? args.currency
      : (current?.type === 'fixed' ? current.currency : preferredCurrency);
    if (!isSupportedCurrency(requestedCurrency)) {
      const error = new Error('A fixed tax requires a supported currency: USD, PKR, EUR, or GBP.');
      error.code = 'TAX_CURRENCY_INVALID';
      throw error;
    }
    currency = normalizeCurrency(requestedCurrency);
  } else if (has('currency') && args.currency != null && !isSupportedCurrency(args.currency)) {
    const error = new Error('Tax currency must be USD, PKR, EUR, or GBP.');
    error.code = 'TAX_CURRENCY_INVALID';
    throw error;
  }

  if (has('isActive') && typeof args.isActive !== 'boolean') {
    const error = new Error('Tax active status must be true or false.');
    error.code = 'TAX_ACTIVE_INVALID';
    throw error;
  }

  const storedValue = type === 'none'
    ? 0
    : numericValue;
  if (type === 'fixed' && numericValue > 0 && storedValue <= 0) {
    const error = new Error('Fixed tax must be zero or large enough to represent at least 0.01.');
    error.code = 'TAX_VALUE_TOO_SMALL';
    throw error;
  }

  return {
    type,
    value: storedValue,
    currency,
    isActive: has('isActive') ? args.isActive : (current?.isActive !== false),
  };
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (!key.startsWith('_') && value[key] !== undefined) {
        result[key] = canonicalizeForHash(value[key]);
      }
      return result;
    }, {});
  }
  return typeof value === 'string' ? value.trim() : value;
}

function canonicalizeAIActionArgsForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeAIActionArgsForHash);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      // Transport identity selects the receipt row and must not also change
      // its intent hash. Other underscore fields, especially _lastUserText,
      // are retained because they can affect currency inference.
      if (
        !['_chatRequestKey', '_chatToolOrdinal'].includes(key)
        && value[key] !== undefined
      ) {
        result[key] = canonicalizeAIActionArgsForHash(value[key]);
      }
      return result;
    }, {});
  }
  return typeof value === 'string' ? value.trim() : value;
}

function isDurableMutatingAITool(toolName) {
  return AI_DURABLE_MUTATING_TOOLS.has(String(toolName || ''));
}

function getDurableAIActionIntentKey(toolName, args = {}) {
  if (!isDurableMutatingAITool(toolName)) return null;
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      tool: String(toolName),
      args: canonicalizeAIActionArgsForHash(args),
    }))
    .digest('hex');
}

function aiOrderRequestFingerprint(args) {
  // Bind the key only to the client/model's explicit order request. Account
  // preferences can legitimately change after the first response is lost; a
  // retry must still return the already-created order and its frozen currency.
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(args)))
    .digest('hex');
}

function aiActionMutationReceipt(toolName, args, userId, { required = false } = {}) {
  const requestKey = String(args?._chatRequestKey || '').trim();
  if (!requestKey) {
    if (!required) return null;
    const error = new Error('This AI mutation requires an Idempotency-Key. Retry with the same key for the same logical request.');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'AI_ACTION_IDEMPOTENCY_REQUIRED';
    throw error;
  }
  if (requestKey.length > 240 || /[\u0000-\u001f\u007f]/.test(requestKey)) {
    const error = new Error('The AI action Idempotency-Key is invalid.');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'AI_ACTION_IDEMPOTENCY_KEY_INVALID';
    throw error;
  }
  const rawOrdinal = args?._chatToolOrdinal ?? 0;
  const toolOrdinal = Number(rawOrdinal);
  if (!Number.isSafeInteger(toolOrdinal) || toolOrdinal < 0) {
    const error = new Error('The AI tool execution slot is invalid.');
    error.status = 400;
    error.statusCode = 400;
    error.code = 'AI_ACTION_IDEMPOTENCY_SLOT_INVALID';
    throw error;
  }
  const requestFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({
      tool: String(toolName),
      args: canonicalizeAIActionArgsForHash(args || {}),
    }))
    .digest('hex');
  return {
    user: userId,
    action: String(toolName),
    requestKey,
    toolOrdinal,
    requestFingerprint,
  };
}

function isRecognizedAIPriceCurrency(value) {
  if (value === undefined || value === null || String(value).trim() === '') return true;
  return isSupportedCurrency(value) || Boolean(detectExplicitCurrencyInText(value));
}

async function trustedSnapshotForCurrencyPairs(pairs = []) {
  const needsConversion = pairs.some(([fromCurrency, toCurrency]) => (
    normalizeCurrency(fromCurrency) !== normalizeCurrency(toCurrency)
  ));
  return needsConversion ? getExchangeRateSnapshot() : null;
}

async function convertAICouponMoneyEntries(
  entries,
  targetCurrency,
  { tooSmallMessage = 'A coupon amount is too small to represent in the requested currency.' } = {},
) {
  const converted = Object.fromEntries(entries.map(entry => [entry.field, entry.value]));
  const requiringRates = entries.filter(entry => (
    entry.value > 0 && normalizeCurrency(entry.sourceCurrency) !== targetCurrency
  ));
  if (!requiringRates.length) return converted;

  // One coupon mutation is one financial decision, so every converted term
  // must use the exact same trusted rate table.
  const exchangeRateSnapshot = await getExchangeRateSnapshot();
  for (const entry of requiringRates) {
    const value = await convertAmountUsingTrustedRates(
      entry.value,
      entry.sourceCurrency,
      targetCurrency,
      exchangeRateSnapshot,
    );
    if (entry.value > 0 && value <= 0) {
      const error = new Error(tooSmallMessage);
      error.code = 'COUPON_AMOUNT_TOO_SMALL_AFTER_CONVERSION';
      error.status = 400;
      error.statusCode = 400;
      throw error;
    }
    converted[entry.field] = value;
  }
  return converted;
}

const matchedBulkCount = result => Number(
  result?.matchedCount ?? result?.nMatched ?? result?.result?.nMatched ?? 0
);

async function writeAIProductUpdatesAtomically(
  operations = [],
  { sellerId = null, expectedCurrency = null, receipt = null } = {}
) {
  if (receipt) await AIActionReceipt.init();
  const write = async session => {
    if (receipt) {
      await AIActionReceipt.create([{
        user: receipt.user,
        action: receipt.action,
        requestKey: receipt.requestKey,
        toolOrdinal: receipt.toolOrdinal,
        requestFingerprint: receipt.requestFingerprint,
        status: 'processing',
      }], { session });
    }
    const result = await Product.bulkWrite(operations, { session });
    if (matchedBulkCount(result) !== operations.length) {
      const error = new Error('One or more products changed while this update was being prepared. No prices were changed; refresh and retry.');
      error.status = 409;
      error.code = 'PRODUCT_PRICE_UPDATE_CONFLICT';
      throw error;
    }
    if (receipt) {
      const completed = await AIActionReceipt.updateOne(
        {
          user: receipt.user,
          requestKey: receipt.requestKey,
          toolOrdinal: receipt.toolOrdinal,
          requestFingerprint: receipt.requestFingerprint,
          status: 'processing',
        },
        {
          $set: {
            status: 'completed',
            result: receipt.result,
          },
        },
        { session }
      );
      if (Number(completed.matchedCount) !== 1) {
        const error = new Error('The AI action receipt changed during execution. No prices were changed.');
        error.status = 409;
        error.code = 'AI_ACTION_IDEMPOTENCY_CONFLICT';
        throw error;
      }
    }
    return { result, actionResult: receipt?.result || null, replayed: false };
  };
  try {
    return await (sellerId
      ? withProductCurrencyWriteLock(sellerId, expectedCurrency, write)
      : runInTransaction(write));
  } catch (error) {
    if (!receipt || ![11000, 11001].includes(Number(error?.code))) throw error;
    const existing = await AIActionReceipt.findOne({
      user: receipt.user,
      requestKey: receipt.requestKey,
      toolOrdinal: receipt.toolOrdinal,
    }).lean();
    if (!existing) throw error;
    if (
      existing.action !== receipt.action
      || existing.requestFingerprint !== receipt.requestFingerprint
    ) {
      const conflict = new Error('This AI request execution slot was already used for a different tool or arguments. Start a new request with a new Idempotency-Key.');
      conflict.status = 409;
      conflict.statusCode = 409;
      conflict.code = 'AI_ACTION_IDEMPOTENCY_CONFLICT';
      throw conflict;
    }
    if (existing.status !== 'completed' || !existing.result) {
      const pending = new Error('This AI action is still being committed. Retry the same request shortly.');
      pending.status = 409;
      pending.statusCode = 409;
      pending.code = 'AI_ACTION_PENDING';
      throw pending;
    }
    return { actionResult: existing.result, replayed: true };
  }
}

function aiActionExecutionFailure(toolName, error) {
  console.error(`[aiActionExecutor] Error executing ${toolName}:`, error?.message || error);
  return {
    success: false,
    error: `Failed to execute ${toolName}: ${error?.message || 'Unknown error'}`,
    ...(error?.code ? { code: error.code } : {}),
  };
}

function jsonSafeAIActionResult(result) {
  // Receipts must never retain live Mongoose documents/subdocuments (which can
  // carry parent/database references). The HTTP/SSE boundary is JSON anyway,
  // so return and persist the same deterministic wire representation.
  if (result === undefined) return null;
  return JSON.parse(JSON.stringify(result));
}

function actionReceiptConflict(existing, receipt) {
  return existing?.action !== receipt.action
    || existing?.requestFingerprint !== receipt.requestFingerprint;
}

function actionReceiptReplayOrThrow(existing, receipt) {
  if (actionReceiptConflict(existing, receipt)) {
    const conflict = new Error('This AI request execution slot was already used for a different tool or arguments. Start a new request with a new Idempotency-Key.');
    conflict.status = 409;
    conflict.statusCode = 409;
    conflict.code = 'AI_ACTION_IDEMPOTENCY_CONFLICT';
    throw conflict;
  }
  if (existing?.status === 'completed' && existing.result) {
    return existing.result;
  }
  const pending = new Error('This AI action may still be processing. Retry the same request shortly; a new mutation was not started.');
  pending.status = 409;
  pending.statusCode = 409;
  pending.code = 'AI_ACTION_PENDING';
  throw pending;
}

async function claimAIActionExecution(receipt) {
  await AIActionReceipt.init();
  try {
    await AIActionReceipt.create({
      user: receipt.user,
      action: receipt.action,
      requestKey: receipt.requestKey,
      toolOrdinal: receipt.toolOrdinal,
      requestFingerprint: receipt.requestFingerprint,
      status: 'processing',
    });
    return { claimed: true, result: null };
  } catch (error) {
    if (![11000, 11001].includes(Number(error?.code))) throw error;
    const existing = await AIActionReceipt.findOne({
      user: receipt.user,
      requestKey: receipt.requestKey,
      toolOrdinal: receipt.toolOrdinal,
    }).lean();
    if (!existing) throw error;
    return { claimed: false, result: actionReceiptReplayOrThrow(existing, receipt) };
  }
}

async function executeToolCall(toolName, args = {}, user) {
  const hasTransportExecutionSlot = Object.prototype.hasOwnProperty.call(
    args || {},
    '_chatRequestKey'
  );
  if (
    !AI_MUTATING_TOOLS_WITH_OUTER_RECEIPT.has(toolName)
    // Legacy in-process callers have no transport context. Every public chat
    // and /ai-actions adapter supplies this property (an empty value then
    // fails closed), while unit/internal read paths remain backwards compatible.
    || !hasTransportExecutionSlot
  ) {
    return executeToolCallUnprotected(toolName, args, user);
  }

  const userId = user?._id || user?.id || null;
  if (!userId) {
    return executeToolCallUnprotected(toolName, args, user);
  }

  let receipt;
  try {
    receipt = aiActionMutationReceipt(toolName, args, userId, { required: true });
  } catch (error) {
    return aiActionExecutionFailure(toolName, error);
  }

  let claimed = false;
  try {
    const claim = await claimAIActionExecution(receipt);
    if (!claim.claimed) return claim.result;
    claimed = true;

    const rawResult = await executeToolCallUnprotected(
      toolName,
      args,
      user,
      { propagateErrors: true }
    );
    const result = jsonSafeAIActionResult(rawResult);
    const completed = await AIActionReceipt.updateOne(
      {
        user: receipt.user,
        requestKey: receipt.requestKey,
        toolOrdinal: receipt.toolOrdinal,
        requestFingerprint: receipt.requestFingerprint,
        status: 'processing',
      },
      { $set: { status: 'completed', result } }
    );
    if (Number(completed.matchedCount ?? completed.n ?? 0) !== 1) {
      const error = new Error('The AI action receipt could not be completed after its mutation.');
      error.code = 'AI_ACTION_RECEIPT_COMMIT_AMBIGUOUS';
      throw error;
    }
    return result;
  } catch (error) {
    if (!claimed) return aiActionExecutionFailure(toolName, error);

    // The mutation and receipt completion are not necessarily in one database
    // transaction for these heterogeneous tools. Once execution starts, any
    // exception is ambiguous: retain the processing claim so a retry cannot
    // execute the mutation again.
    console.error(`[aiActionExecutor] Ambiguous ${toolName} execution retained for recovery:`, error?.message || error);
    const pending = new Error('This AI action may have been applied, but its result could not be confirmed. Retry the same request later; it will not be executed again automatically.');
    pending.status = 409;
    pending.statusCode = 409;
    pending.code = 'AI_ACTION_PENDING';
    return aiActionExecutionFailure(toolName, pending);
  }
}

module.exports = {
  executeToolCall,
  isClientSideTool,
  isDurableMutatingAITool,
  getDurableAIActionIntentKey,
  CLIENT_SIDE_TOOLS,
  storeChangeLimits,
  __private: {
    buildSellerOrderScope,
    buildSellerOrderStatusScope,
    filterSellerOrderItems,
    sellerOrderStatus,
    sellerOwnsOrderItem,
    detectExplicitCurrencyInText,
    isRecognizedAIPriceCurrency,
    resolveAIPriceCurrency,
    buildProductCurrencyConversionNotice,
    normalizeTaxConfigUpdate,
    normalizeMoneyAmount,
    requireAIDerivedMoney,
    parseMoneyInput,
    parseQuantity,
    requireStoredAIShippingCurrency,
    requireStoredAIShippingMethod,
    requireStoredAITaxConfig,
    stableAIProductCurrency,
  },
};
