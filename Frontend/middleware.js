import { next, rewrite } from '@vercel/functions';

const CANONICAL_HOST = 'rozare.com';
const API_ORIGIN = String(process.env.SEO_API_ORIGIN || 'https://rozare.up.railway.app').replace(/\/+$/, '');
const STORE_STATUS_TIMEOUT_MS = 3500;

// Only hosts that are actually served by this deployment bypass storefront
// validation. Reserved names such as app/admin/api must not silently inherit
// the public marketplace SPA while they are unused.
const PLATFORM_SUBDOMAINS = new Set(['www', 'docs']);

const CRAWLER_MARKERS = [
  'bot', 'crawler', 'spider', 'crawling', 'google-inspectiontool', 'slurp',
  'duckduckgo', 'baiduspider', 'yandex', 'sogou', 'exabot', 'facebot',
  'facebookexternalhit', 'ia_archiver', 'ahrefs', 'semrush', 'mj12', 'dotbot',
  'blexbot', 'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot',
  'claude-web', 'perplexitybot', 'applebot', 'twitterbot', 'linkedinbot',
  'slackbot', 'whatsapp', 'telegrambot', 'discordbot',
];

const PRIVATE_EXACT_PATHS = new Set([
  '/ai-chat',
  '/checkout',
  '/forgot-password',
  '/login',
  '/marketplace/trusted',
  '/profile',
  '/seller-signup',
  '/settings/blocked-accounts',
  '/signup',
  '/success',
  '/unauthorized',
]);

const PRIVATE_PATH_PREFIXES = [
  '/admin-dashboard',
  '/auth',
  '/orders',
  '/reset-password',
  '/seller-dashboard',
  '/user-dashboard',
];

const PUBLIC_EXACT_PATHS = new Set([
  '/',
  '/about',
  '/account-deletion',
  '/become-seller',
  '/contact',
  '/docs',
  '/faq',
  '/marketplace',
  '/pages/contact-us',
  '/privacy',
  '/products',
  '/seller-signup',
  '/stores',
  '/stores/trusted',
  '/terms',
  '/track-order',
]);

const PUBLIC_FILE_PATHS = new Set([
  '/favicon-512.png',
  '/favicon.svg',
  '/llms.txt',
  '/og-image.png',
  '/rozare-logo.svg',
  '/rozare-pfp.svg',
  '/vite.svg',
]);

const NOINDEX_HEADER = 'noindex, nofollow, noarchive, nosnippet';

export const isCrawlerRequest = request => {
  const userAgent = String(request?.headers?.get?.('user-agent') || '').toLowerCase();
  return CRAWLER_MARKERS.some(marker => userAgent.includes(marker));
};

export const storefrontSlugFromHostname = value => {
  const hostname = String(value || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!hostname.endsWith(`.${CANONICAL_HOST}`)) return null;
  const prefix = hostname.slice(0, -(`.${CANONICAL_HOST}`.length));
  if (!prefix || prefix.includes('.') || PLATFORM_SUBDOMAINS.has(prefix)) return null;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(prefix) ? prefix : null;
};

export const isPrivatePath = value => {
  const pathname = (String(value || '').replace(/\/+$/, '') || '/').toLowerCase();
  if (PRIVATE_EXACT_PATHS.has(pathname)) return true;
  return PRIVATE_PATH_PREFIXES.some(prefix => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ));
};

const unavailableDocument = (status, kind = 'store') => `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${kind === 'store' ? 'Store' : 'Page'} unavailable | Rozare</title>
<meta name="description" content="This ${kind} is not publicly available on Rozare.">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
<style>body{font-family:Inter,system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#182033}.box{width:min(560px,calc(100% - 32px));padding:36px;border:1px solid #dbe2ee;border-radius:22px;background:#fff;text-align:center}a{color:#3157b7}@media(prefers-color-scheme:dark){body{background:#111827;color:#eef2ff}.box{background:#182235;border-color:#32415a}}</style>
</head><body><main class="box"><h1>${status === 503 ? 'Temporarily unavailable' : `${kind === 'store' ? 'Store' : 'Page'} unavailable`}</h1><p>${status === 503 ? 'Rozare could not verify this page right now. Please try again shortly.' : `This ${kind} does not exist or is not currently public.`}</p><p><a href="https://rozare.com/">Return to Rozare</a></p></main></body></html>`;

const unavailableResponse = (status, kind) => new Response(unavailableDocument(status, kind), {
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': NOINDEX_HEADER,
    ...(status === 503 ? { 'Retry-After': '60' } : {}),
  },
});

const storeIsIndexable = async slug => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STORE_STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_ORIGIN}/api/seo/store-status/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 404) return false;
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.indexable === true;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const safeDecodePathPart = value => {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return null;
  }
};

const productIdFromPath = pathname => {
  const match = String(pathname || '').match(/^\/single-product\/([^/]+)\/?$/i);
  return match ? safeDecodePathPart(match[1]) : null;
};

const storeSlugFromPath = pathname => {
  const match = String(pathname || '').match(/^\/store\/([^/]+)\/?$/i);
  const decoded = match ? safeDecodePathPart(match[1]) : null;
  return decoded ? decoded.toLowerCase() : null;
};

export const isKnownAppPath = value => {
  const pathname = String(value || '').replace(/\/+$/, '') || '/';
  const normalizedPath = pathname.toLowerCase();
  if (PUBLIC_EXACT_PATHS.has(normalizedPath) || PUBLIC_FILE_PATHS.has(normalizedPath)) return true;
  if (normalizedPath.startsWith('/docs/')) return true;
  if (isPrivatePath(normalizedPath)) return true;
  return Boolean(productIdFromPath(pathname) || storeSlugFromPath(pathname));
};

export const crawlerRenderUrl = ({ pathname, storefrontSlug }) => {
  const productId = productIdFromPath(pathname);
  if (productId) return `${API_ORIGIN}/api/seo/render/product/${encodeURIComponent(productId)}`;

  if (storefrontSlug && (pathname === '/' || pathname === '')) {
    return `${API_ORIGIN}/api/seo/render/store/${encodeURIComponent(storefrontSlug)}`;
  }

  const pathStoreSlug = storeSlugFromPath(pathname);
  if (pathStoreSlug) return `${API_ORIGIN}/api/seo/render/store/${encodeURIComponent(pathStoreSlug)}`;
  if (pathname === '/') return `${API_ORIGIN}/api/seo/render/home`;
  if (pathname === '/products' || pathname === '/products/') return `${API_ORIGIN}/api/seo/render/products`;
  if (pathname === '/marketplace' || pathname === '/marketplace/') return `${API_ORIGIN}/api/seo/render/marketplace`;
  return null;
};

export const config = {
  matcher: '/((?!assets/|favicon\\.ico|robots\\.txt|sitemap(?:-[^/]+)?\\.xml|manifest\\.json|sw\\.js).*)',
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();

  if (hostname === `www.${CANONICAL_HOST}`) {
    const target = new URL(request.url);
    target.hostname = CANONICAL_HOST;
    return Response.redirect(target, 308);
  }

  const storefrontSlug = storefrontSlugFromHostname(hostname);
  const isRozareSubdomain = hostname.endsWith(`.${CANONICAL_HOST}`);

  // Actual platform hosts (docs/app/admin/etc.) own their routing. Preview and
  // third-party hosts are also intentionally excluded from production SEO.
  if (isRozareSubdomain && !storefrontSlug) return next();
  if (hostname !== CANONICAL_HOST && !storefrontSlug) return next();

  if (storefrontSlug) {
    const indexable = await storeIsIndexable(storefrontSlug);
    if (indexable === false) return unavailableResponse(404, 'store');
    if (indexable === null) return unavailableResponse(503, 'store');
  }

  const pathStoreSlug = storeSlugFromPath(url.pathname);
  if (pathStoreSlug) {
    const indexable = pathStoreSlug === storefrontSlug
      ? true
      : await storeIsIndexable(pathStoreSlug);
    if (indexable === false) return unavailableResponse(404, 'store');
    if (indexable === null) return unavailableResponse(503, 'store');
    const target = new URL(`https://${pathStoreSlug}.${CANONICAL_HOST}/`);
    target.search = url.search;
    return Response.redirect(target, 308);
  }

  // Account, checkout, confirmation-token, and dashboard pages must remain
  // crawlable at the HTTP layer so search engines can observe this directive,
  // but they must never enter the public index.
  if (isPrivatePath(url.pathname)) {
    return next({ headers: { 'X-Robots-Tag': NOINDEX_HEADER } });
  }

  // Vite's SPA fallback otherwise turns every typo into an indexable 200 page,
  // which Search Console reports as a soft 404. Unknown routes now carry the
  // truthful HTTP status for users and crawlers alike.
  if (!isKnownAppPath(url.pathname)) return unavailableResponse(404, 'page');

  if (!isCrawlerRequest(request)) return next();
  const renderUrl = crawlerRenderUrl({ pathname: url.pathname, storefrontSlug });
  return renderUrl ? rewrite(new URL(renderUrl)) : next();
}
