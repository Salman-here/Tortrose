// Public store slugs are DNS hostnames, not only display names. Keep platform
// infrastructure, authentication/payment surfaces, and high-risk support-style
// names unavailable so a seller cannot impersonate Rozare or a system page.
const RESERVED_STORE_SLUGS = new Set([
    'www', 'api', 'admin', 'app', 'apps', 'mail', 'email', 'smtp', 'imap',
    'pop', 'ftp', 'sftp', 'ssh', 'cdn', 'static', 'assets', 'media', 'images',
    'img', 'files', 'storage', 'status', 'health', 'uptime', 'monitor',
    'dev', 'development', 'staging', 'stage', 'test', 'testing', 'beta',
    'preview', 'demo', 'localhost', 'internal', 'intranet', 'root', 'ns1',
    'ns2', 'mx', 'dashboard', 'portal', 'console', 'manage', 'management',
    'seller', 'sellers', 'buyer', 'buyers', 'account', 'accounts', 'auth',
    'login', 'signin', 'signup', 'register', 'password', 'oauth', 'callback',
    'webhook', 'webhooks', 'checkout', 'payment', 'payments', 'billing',
    'wallet', 'shop', 'store', 'stores', 'market', 'marketplace', 'product',
    'products', 'search', 'blog', 'docs', 'help', 'support', 'contact',
    'about', 'faq', 'terms', 'privacy', 'legal', 'security', 'abuse', 'trust',
    'safety', 'careers', 'jobs', 'news', 'press', 'community', 'mobile',
    'android', 'ios', 'download', 'go', 'link', 'links', 'short', 'hello',
]);

// These names are protected only as hostnames. Sellers may still truthfully
// mention products from these brands; they simply cannot present themselves at
// a first-party-looking hostname such as amazon-12.rozare.com.
const PROTECTED_BRAND_SLUGS = new Set([
    'adidas', 'airbnb', 'alibaba', 'aliexpress', 'amazon', 'amd', 'anthropic',
    'apple', 'binance', 'chatgpt', 'coca-cola', 'daraz', 'discord', 'disney',
    'dropbox', 'ebay', 'facebook', 'fedex', 'figma', 'github', 'gmail',
    'google', 'huawei', 'instagram', 'intel', 'linkedin', 'mastercard',
    'meta', 'microsoft', 'netflix', 'nike', 'nintendo', 'nokia', 'nvidia',
    'openai', 'oppo', 'paypal', 'pepsi', 'pinterest', 'puma', 'reebok',
    'samsung', 'shein', 'shopify', 'snapchat', 'sony', 'spotify', 'stripe',
    'target', 'telegram', 'temu', 'tesla', 'tiktok', 'twitch', 'twitter',
    'uber', 'ups', 'vercel', 'visa', 'vivo', 'walmart', 'whatsapp', 'xiaomi',
    'youtube',
]);

const ROZARE_PROTECTED_PREFIX = 'rozare';
const RESERVED_PREFIX_SLUGS = new Set([
    'admin', 'api', 'app', 'apps', 'auth', 'billing', 'help', 'login', 'mail', 'payment',
    'security', 'status', 'support', 'wallet', 'webhook',
]);

const MIN_STORE_SLUG_LENGTH = 3;
const MAX_STORE_SLUG_LENGTH = 63;
const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const optionalHyphenPattern = value => String(value)
    .replace(/-/g, '')
    .split('')
    .map(escapeRegExp)
    .join('-*');

const reservedTokensPattern = [...RESERVED_STORE_SLUGS].map(escapeRegExp).join('|');
const reservedPrefixesPattern = [...RESERVED_PREFIX_SLUGS].map(escapeRegExp).join('|');
const compactBrandTokensPattern = [...PROTECTED_BRAND_SLUGS].map(optionalHyphenPattern).join('|');

// This database-safe equivalent of protectedStoreSlugReason lets every public
// catalog query exclude old rows that predate the current reservation policy.
// Runtime validation remains the source for the user-facing rejection reason.
const PROTECTED_STORE_SLUG_PATTERN = new RegExp(
    `^(?:${optionalHyphenPattern(ROZARE_PROTECTED_PREFIX)}.*|(?:${reservedTokensPattern})(?:\\d.*)?|(?:${reservedPrefixesPattern})-.*|(?:${compactBrandTokensPattern})(?:\\d.*|-.*)?)$`,
    'i',
);

const normalizeStoreSlug = (value) => (
    typeof value === 'string' ? value.trim().toLowerCase() : ''
);

const compactStoreSlug = value => normalizeStoreSlug(value).replace(/-/g, '');

// Reserve an exact protected token and obvious impersonation variants such as
// admin-portal, admin12, amazon-official, and amazon2. Ordinary words that only
// begin with the same letters (for example "appletree") remain available.
const matchesProtectedToken = (slug, token) => (
    slug === token
    || slug.startsWith(`${token}-`)
    || new RegExp(`^${token}\\d`).test(slug)
);

const matchesReservedSystemToken = (slug, token) => (
    slug === token
    || new RegExp(`^${token}\\d`).test(slug)
    || (RESERVED_PREFIX_SLUGS.has(token) && slug.startsWith(`${token}-`))
);

const protectedStoreSlugReason = value => {
    const slug = normalizeStoreSlug(value);
    if (!slug) return null;
    const compact = compactStoreSlug(slug);

    // Protect Rozare more strictly than third-party names. Removing hyphens
    // closes simple lookalikes such as ro-zare and every "rozare..." suffix.
    if (compact.startsWith(ROZARE_PROTECTED_PREFIX)) return 'platform';

    for (const token of RESERVED_STORE_SLUGS) {
        if (matchesReservedSystemToken(slug, token)) return 'system';
    }
    for (const brand of PROTECTED_BRAND_SLUGS) {
        if (matchesProtectedToken(slug, brand)) return 'brand';
        // Also close simple visual evasion such as a-ma-zon-official while
        // keeping unrelated words such as appletree available.
        if (new RegExp(`^${optionalHyphenPattern(brand)}(?:\\d.*|-.*)?$`).test(slug)) return 'brand';
    }
    return null;
};

const isProtectedStoreSlug = value => Boolean(protectedStoreSlugReason(value));

const validateStoreSlug = (value) => {
    const slug = normalizeStoreSlug(value);
    if (slug.length < MIN_STORE_SLUG_LENGTH || slug.length > MAX_STORE_SLUG_LENGTH) {
        return {
            valid: false,
            slug,
            code: 'INVALID_SUBDOMAIN_LENGTH',
            msg: `Subdomain must be between ${MIN_STORE_SLUG_LENGTH} and ${MAX_STORE_SLUG_LENGTH} characters long`,
        };
    }
    if (!STORE_SLUG_PATTERN.test(slug)) {
        return {
            valid: false,
            slug,
            code: 'INVALID_SUBDOMAIN_FORMAT',
            msg: 'Subdomain can only contain lowercase letters, numbers, and interior hyphens',
        };
    }
    const protectedReason = protectedStoreSlugReason(slug);
    if (protectedReason) {
        return {
            valid: false,
            slug,
            code: protectedReason === 'brand' ? 'PROTECTED_BRAND_SUBDOMAIN' : 'RESERVED_SUBDOMAIN',
            msg: protectedReason === 'brand'
                ? 'This subdomain is protected and cannot be used for a seller store'
                : 'This subdomain is reserved by Rozare',
        };
    }
    return { valid: true, slug };
};

const slugifyStoreName = (value) => {
    const base = String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_STORE_SLUG_LENGTH)
        .replace(/-+$/g, '');
    return base.length >= MIN_STORE_SLUG_LENGTH ? base : '';
};

const safeGeneratedStoreSlugBase = (storeName, fallbackKey) => {
    const generated = slugifyStoreName(storeName);
    if (validateStoreSlug(generated).valid) return generated;

    const safeKey = String(fallbackKey || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(-16);
    const fallback = safeKey ? `merchant-${safeKey}` : 'merchant-new';
    return validateStoreSlug(fallback).valid ? fallback : 'merchant-new';
};

module.exports = {
    RESERVED_STORE_SLUGS,
    PROTECTED_BRAND_SLUGS,
    MIN_STORE_SLUG_LENGTH,
    MAX_STORE_SLUG_LENGTH,
    STORE_SLUG_PATTERN,
    PROTECTED_STORE_SLUG_PATTERN,
    normalizeStoreSlug,
    protectedStoreSlugReason,
    isProtectedStoreSlug,
    validateStoreSlug,
    slugifyStoreName,
    safeGeneratedStoreSlugBase,
};
