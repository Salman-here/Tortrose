const RESERVED_STORE_SLUGS = new Set([
    'www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog',
    'docs', 'help', 'cdn', 'static', 'support',
]);

const MIN_STORE_SLUG_LENGTH = 3;
const MAX_STORE_SLUG_LENGTH = 63;
const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const normalizeStoreSlug = (value) => (
    typeof value === 'string' ? value.trim().toLowerCase() : ''
);

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
    if (RESERVED_STORE_SLUGS.has(slug)) {
        return {
            valid: false,
            slug,
            code: 'RESERVED_SUBDOMAIN',
            msg: 'This subdomain is reserved by the system',
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

module.exports = {
    RESERVED_STORE_SLUGS,
    MIN_STORE_SLUG_LENGTH,
    MAX_STORE_SLUG_LENGTH,
    STORE_SLUG_PATTERN,
    normalizeStoreSlug,
    validateStoreSlug,
    slugifyStoreName,
};
