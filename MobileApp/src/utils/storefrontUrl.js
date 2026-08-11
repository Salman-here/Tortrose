const STORE_DOMAIN = 'rozare.com';
const RESERVED_STORE_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'mail', 'ftp', 'shop', 'store', 'blog',
  'docs', 'help', 'cdn', 'static', 'support',
]);
const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function normalizeStoreSlug(value) {
  if (typeof value !== 'string') return '';

  const raw = value.trim().toLowerCase();
  if (!raw) return '';

  // Accept a slug or a previously formatted storefront URL. This keeps every
  // seller surface on the canonical subdomain shape and safely upgrades the
  // legacy `rozare.com/store/:slug` display value.
  const withoutScheme = raw.replace(/^https?:\/\//, '');
  const withoutFragment = withoutScheme.split(/[?#]/)[0].replace(/\/$/, '');
  const [hostWithPort, ...pathParts] = withoutFragment.split('/');
  const host = hostWithPort.replace(/:\d+$/, '');
  let slug = '';

  if (host === STORE_DOMAIN || host === `www.${STORE_DOMAIN}`) {
    if (pathParts[0] !== 'store' || !pathParts[1]) return '';
    slug = pathParts[1];
  } else if (host.endsWith(`.${STORE_DOMAIN}`)) {
    const hostParts = host.split('.');
    if (hostParts.length !== 3 || pathParts.length > 0 && !pathParts[0]) return '';
    slug = hostParts[0];
  } else {
    // A raw slug cannot contain a path or resemble a different hostname.
    if (pathParts.length > 0 || host.includes('.')) return '';
    slug = host;
  }

  if (
    slug.length < 3
    || slug.length > 63
    || RESERVED_STORE_SLUGS.has(slug)
    || !STORE_SLUG_PATTERN.test(slug)
  ) return '';

  return slug;
}

export function getStorefrontHost(storeSlug) {
  const slug = normalizeStoreSlug(storeSlug);
  return slug ? `${slug}.${STORE_DOMAIN}` : '';
}

export function getStorefrontUrl(storeSlug) {
  const host = getStorefrontHost(storeSlug);
  return host ? `https://${host}` : '';
}

export { RESERVED_STORE_SLUGS, STORE_DOMAIN };
