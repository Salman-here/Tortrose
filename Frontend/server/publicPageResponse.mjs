import { clearPrerenderSeoFallbacks } from '../scripts/prerender-head.mjs';

export const PUBLIC_PAGE_CACHE = 'no-store, max-age=0';
const INDEX = 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
const NOINDEX = 'noindex, nofollow, noarchive, nosnippet';
const ORIGIN = 'https://rozare.com';
const PUBLIC_KINDS = new Set(['home', 'products', 'marketplace', 'product', 'store']);

export function privateAppPage(appShell) {
  const head = [
    '<title>Your account | Rozare</title>',
    '<meta name="description" content="Sign in to Rozare to view your account and order details.">',
    '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">',
    '<meta property="og:title" content="Rozare">',
    '<meta property="og:description" content="Sign in to view this private page.">',
    '<meta name="twitter:card" content="summary">',
  ].map(managed).join('\n');
  return clearPrerenderSeoFallbacks(appShell)
    .replace(/<meta\b[^>]*(?:property|name)=["'](?:og:[^"']*|twitter:[^"']*)["'][^>]*>/gi, '')
    .replace('</head>', head + '\n</head>');
}

export function publicRenderTarget(kind, value = '') {
  if (!PUBLIC_KINDS.has(kind)) return null;
  if (kind === 'product' && !/^[a-f\d]{24}$/i.test(value)) return null;
  if (kind === 'store' && !/^[a-z\d](?:[a-z\d-]{1,61}[a-z\d])$/.test(value)) return null;
  if (kind === 'product') value = value.toLowerCase();
  const suffix = ['product', 'store'].includes(kind) ? '/' + encodeURIComponent(value) : '';
  return {
    apiPath: '/api/seo/render/' + kind + suffix,
    canonical: kind === 'store' ? `https://${value}.rozare.com/`
      : kind === 'product' ? `${ORIGIN}/single-product/${value}`
        : kind === 'home' ? `${ORIGIN}/` : `${ORIGIN}/${kind}`,
  };
}

const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(match => [match[1].toLowerCase(), match[2]]));
const managed = tag => tag.replace(/^<(title|meta|link|script)\b/i, '<$1 data-rh="true"');
const fallbackStyle = `<style>#seo-public-fallback{font-family:Inter,system-ui,sans-serif;color:#182033;background:linear-gradient(135deg,#eef5ff,#f5f1ff);min-height:100vh;line-height:1.6;padding:20px}#seo-public-fallback header,#seo-public-fallback main,#seo-public-fallback footer{max-width:1120px;margin:auto}#seo-public-fallback header{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:15px 0}#seo-public-fallback nav{display:flex;gap:16px;flex-wrap:wrap}#seo-public-fallback a{color:#3157b7}#seo-public-fallback main{padding:36px 0}#seo-public-fallback h1{font-size:clamp(1.8rem,5vw,3rem);line-height:1.15}#seo-public-fallback .lead{max-width:760px}#seo-public-fallback .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin-top:24px}#seo-public-fallback .card{display:block;padding:18px;background:#ffffffd9;border:1px solid #dbe2ee;border-radius:20px;text-decoration:none;color:inherit}#seo-public-fallback .card strong{display:block}#seo-public-fallback .card img{width:100%;aspect-ratio:4/3;object-fit:contain}#seo-public-fallback img{max-width:100%}#seo-public-fallback .price{font-weight:700}#seo-public-fallback footer{padding:24px 0;border-top:1px solid #dbe2ee}@media(prefers-color-scheme:dark){#seo-public-fallback{color:#eef2ff;background:#111827}#seo-public-fallback .card{background:#182235;border-color:#32415a}#seo-public-fallback a{color:#9dc5ff}}</style>`;

// Keep Vite's actual built scripts/styles and analytics, but replace every
// fallback SEO tag. React Helmet owns the injected tags after navigation too.
export function mergePublicPage(appShell, publicHtml, canonical) {
  const head = publicHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  const body = publicHtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (!head || !body || !appShell.includes('<div id="root"></div>')) throw Error('SEO_DOCUMENT_INVALID');
  const tags = [];
  let foundCanonical = false, foundTitle = false;
  for (const match of head.matchAll(/<title\b[^>]*>[\s\S]*?<\/title>|<meta\b[^>]*>|<link\b[^>]*>|<script\b[^>]*>[\s\S]*?<\/script>/gi)) {
    const tag = match[0], attrs = attributes(tag.split('>')[0]);
    if (/^<title\b/i.test(tag)) { foundTitle = true; tags.push(managed(tag)); }
    else if (/^<meta\b/i.test(tag) && (attrs.property?.startsWith('og:') || attrs.name?.startsWith('twitter:') || ['description', 'robots', 'googlebot'].includes(attrs.name))) {
      tags.push(managed(tag));
    } else if (attrs.rel === 'canonical') {
      if (new URL(attrs.href).href !== new URL(canonical).href) throw Error('SEO_CANONICAL_MISMATCH');
      foundCanonical = true; tags.push(managed(tag));
    } else if (attrs.type === 'application/ld+json') tags.push(managed(tag));
  }
  if (!foundCanonical || !foundTitle) throw Error('SEO_METADATA_INCOMPLETE');
  // No-JavaScript readers get real public content. With JavaScript enabled,
  // the app checks account-specific blocks before displaying a signed-in
  // shopper's details; public metadata must not flash blocked content first.
  return clearPrerenderSeoFallbacks(appShell)
    // Put real metadata before analytics/app scripts, not at the end of the
    // head. Lightweight preview clients should not need to read through those
    // scripts first. Keep the charset declaration within the first 1024 bytes.
    .replace(/<head\b([^>]*)>([\s\S]*?)<\/head>/i, (_, attrs, oldHead) => {
      const charset = oldHead.match(/<meta\b[^>]*\bcharset\s*=[^>]*>/i)?.[0] || '<meta charset="UTF-8">';
      return `<head${attrs}>\n${charset}\n${tags.join('\n')}\n${oldHead.replace(charset, '')}</head>`;
    })
    .replace('<div id="root"></div>', `<div id="root"></div><noscript><div id="seo-public-fallback">${fallbackStyle}${body}</div></noscript>`);
}

export async function publicPageResponse({ kind, value, appShell, fetchImpl = fetch, apiOrigin = 'https://rozare.up.railway.app', noindex = false }) {
  if (kind === 'private') {
    try {
      return new Response(privateAppPage(await appShell()), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': NOINDEX, 'X-Content-Type-Options': 'nosniff' },
      });
    } catch {
      return new Response('<!doctype html><title>Temporarily unavailable | Rozare</title><h1>Please try again shortly.</h1>', {
        status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': NOINDEX, 'Retry-After': '60' },
      });
    }
  }
  const target = publicRenderTarget(kind, value);
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': PUBLIC_PAGE_CACHE,
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': noindex ? 'noindex, follow' : INDEX,
  };
  if (!target) return new Response('<!doctype html><title>Page unavailable | Rozare</title><meta name="robots" content="noindex"><h1>Page unavailable</h1>', { status: 404, headers: { ...headers, 'X-Robots-Tag': NOINDEX } });
  try {
    const origin = new URL(apiOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('SEO_ORIGIN_INVALID');
    const response = await fetchImpl(new URL(target.apiPath, origin), {
      headers: { Accept: 'text/html' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (![200, 404].includes(response.status) || !response.headers.get('content-type')?.includes('text/html')) throw Error('SEO_UPSTREAM_UNAVAILABLE');
    const html = await response.text();
    if (html.length > 1000000) throw Error('SEO_DOCUMENT_TOO_LARGE');
    if (response.status === 404) return new Response(html, { status: 404, headers: { ...headers, 'X-Robots-Tag': NOINDEX } });
    return new Response(mergePublicPage(await appShell(), html, target.canonical), { status: 200, headers });
  } catch (error) {
    console.error('[public-page] Render unavailable', ['SEO_ORIGIN_INVALID', 'SEO_CANONICAL_MISMATCH', 'SEO_METADATA_INCOMPLETE', 'SEO_DOCUMENT_INVALID', 'SEO_DOCUMENT_TOO_LARGE', 'SEO_APP_SHELL_UNAVAILABLE'].includes(error.message) ? error.message : 'SEO_UPSTREAM_UNAVAILABLE');
    return new Response('<!doctype html><title>Temporarily unavailable | Rozare</title><meta name="robots" content="noindex"><h1>Temporarily unavailable</h1><p>Please try again shortly.</p>', { status: 503, headers: { ...headers, 'X-Robots-Tag': NOINDEX, 'Retry-After': '60' } });
  }
}
