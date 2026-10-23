import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readBuiltAppShell } from '../server/appShell.mjs';
import { mergePublicPage, publicPageResponse, publicRenderTarget } from '../server/publicPageResponse.mjs';
import middleware, { nonIndexableQuery, publicPageFunctionUrl } from '../middleware.js';
import { productShareImage, storeShareImage } from '../src/utils/seoImage.js';

const id = '64b000000000000000000001';
const canonical = `https://rozare.com/single-product/${id}`;
const image = 'https://images.example.com/product.png';
const shell = '<!doctype html><html><head><title data-rh="true">Generic</title><meta data-rh="true" property="og:image" content="brand.png"><meta name="theme-color" content="#fff"><script type="module" src="/assets/app-real.js"></script></head><body><div id="root"></div></body></html>';
const document = (url = canonical, photo = image) => `<html><head><title>Travel Mug | Rozare</title><meta name="description" content="A travel mug."><meta name="robots" content="index, follow"><link rel="canonical" href="${url}"><meta property="og:title" content="Travel Mug | Rozare"><meta property="og:image" content="${photo}"><meta name="twitter:image" content="${photo}"><script type="application/ld+json">{"@type":"Product","name":"Travel Mug"}</script></head><body><main><h1>Travel Mug</h1><p>A travel mug.</p></main></body></html>`;
const upstream = (html = document(), status = 200) => new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('every request agent receives the public-page handler, not a generic app preview', async () => {
  for (const userAgent of ['', 'Mozilla/5.0 Chrome/140', 'WhatsApp/2.26', 'facebookexternalhit/1.1', 'Googlebot/2.1', 'UnknownLinkPreview/1.0']) {
    const response = await middleware(new Request(canonical, { headers: { 'User-Agent': userAgent } }));
    const target = new URL(response.headers.get('x-middleware-rewrite'));
    assert.equal(target.pathname, '/api/public-page');
    assert.equal(target.searchParams.get('kind'), 'product');
    assert.equal(target.searchParams.get('value'), id);
  }
});

test('store-domain product links expose the product in the first response for every agent, with one main-domain canonical', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (...args) => {
    calls.push(args);
    return Response.json({ indexable: true });
  });
  for (const userAgent of ['', 'Mozilla/5.0 Chrome/140', 'WhatsApp/2.26', 'facebookexternalhit/1.1', 'Googlebot/2.1', 'UnknownLinkPreview/1.0']) {
    const requestUrl = `https://nova-nest.rozare.com/single-product/${id}`;
    const routed = await middleware(new Request(requestUrl, { headers: { 'User-Agent': userAgent } }));
    assert.equal(routed.headers.get('location'), null);
    const target = new URL(routed.headers.get('x-middleware-rewrite'));
    assert.equal(target.origin, 'https://nova-nest.rozare.com');
    assert.equal(target.pathname, '/api/public-page');
    assert.equal(target.searchParams.get('kind'), 'product');
    assert.equal(target.searchParams.get('value'), id);
    const response = await publicPageResponse({ kind: target.searchParams.get('kind'), value: target.searchParams.get('value'),
      appShell: async () => shell, fetchImpl: async () => upstream() });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
    assert(html.includes(`rel="canonical" href="${canonical}"`));
    assert(html.includes(`property="og:image" content="${image}"`));
    assert(!html.includes('brand.png'));
  }
  assert(calls.every(call => String(call[0]).endsWith('/api/seo/store-status/nova-nest')));
});

test('store-domain product preview fixes do not bypass store visibility, product removal or private query rules', async t => {
  const requestUrl = `https://nova-nest.rozare.com/single-product/${id}`;
  const statusMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ indexable: false }, { status: 404 }));
  const blocked = await middleware(new Request(requestUrl));
  assert.equal(blocked.status, 404);
  assert.match(blocked.headers.get('x-robots-tag'), /noindex/);
  assert(!(await blocked.text()).includes('og:image'));
  statusMock.mock.mockImplementation(async () => Response.json({ indexable: true }));
  const routed = await middleware(new Request(`${requestUrl}?token=private&email=private`));
  const target = new URL(routed.headers.get('x-middleware-rewrite'));
  assert.equal(target.searchParams.get('noindex'), '1');
  assert(!target.href.includes('private'));
  const removed = await publicPageResponse({ kind: 'product', value: id, appShell: async () => shell,
    fetchImpl: async () => upstream('<html><head><title>Product unavailable</title></head><body>Product unavailable</body></html>', 404) });
  assert.equal(removed.status, 404);
  assert.match(removed.headers.get('x-robots-tag'), /noindex/);
  assert(!(await removed.text()).includes('og:image'));
});

test('store product aliases normalize casing on the same host without adding a cross-host preview hop', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ indexable: true }));
  const response = await middleware(new Request(`https://nova-nest.rozare.com/SINGLE-PRODUCT/${id.toUpperCase()}/?currency=PKR`));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), `https://nova-nest.rozare.com/single-product/${id}?currency=PKR`);
});

test('metadata is replaced once while the real app bundle, safe head tags and public content remain', () => {
  const html = mergePublicPage(shell, document(), canonical);
  assert.equal((html.match(/<title\b/g) || []).length, 1);
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.equal((html.match(/property="og:image"/g) || []).length, 1);
  assert(html.includes(`content="${image}"`));
  assert(!html.includes('brand.png'));
  assert(html.includes('/assets/app-real.js'));
  assert(html.includes('name="theme-color"'));
  assert(html.includes('<h1>Travel Mug</h1>'));
  assert(html.includes('<script data-rh="true" type="application/ld+json">'));
  assert(html.includes('id="seo-public-fallback"'));
  assert(html.includes('<div id="root"></div><noscript>'));
});

test('a manual-share client can read title and image metadata before scripts, with charset preserved at the start', () => {
  const longShell = shell.replace('<head>', '<head><meta charset="UTF-8">').replace('<script type="module"', `<script>${'x'.repeat(20000)}</script><script type="module"`);
  const html = mergePublicPage(longShell, document(), canonical);
  assert.equal((html.match(/charset="UTF-8"/g) || []).length, 1);
  assert(html.indexOf('charset="UTF-8"') < 1024);
  assert(html.indexOf('property="og:image"') < 2000);
  assert(html.indexOf('property="og:image"') < html.indexOf('<script>'));
  assert(html.includes('x'.repeat(20000)));
  assert(html.includes('/assets/app-real.js'));
  assert(html.includes('name="theme-color"'));
});

test('the built app shell is resolved relative to the packaged module, not a monorepo launcher directory', async () => {
  // A deployment build supplies this file. Source-only test runs may not have it.
  let html;
  try { html = await readBuiltAppShell(); } catch (error) { assert.equal(error.message, 'SEO_APP_SHELL_UNAVAILABLE'); return; }
  assert(html.includes('<div id="root"></div>'));
  assert(html.includes('/assets/'));
  const source = readFileSync(new URL('../server/appShell.mjs', import.meta.url), 'utf8');
  assert(source.includes("new URL('../dist/index.html', import.meta.url)"));
});

test('the handler sends no cookies or account credentials upstream and never caches a positive listing', async () => {
  const calls = [];
  const response = await publicPageResponse({ kind: 'product', value: id, appShell: async () => shell, fetchImpl: async (...args) => { calls.push(args); return upstream(); } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.equal(String(calls[0][0]), `https://rozare.up.railway.app/api/seo/render/product/${id}`);
  assert.deepEqual(calls[0][1].headers, { Accept: 'text/html' });
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].redirect, 'error');
});

test('a listing that disappears after a positive response returns a real noindex 404 on the next request', async () => {
  let calls = 0;
  const args = { kind: 'product', value: id, appShell: async () => shell, fetchImpl: async () => ++calls === 1 ? upstream() : upstream('<html><head><title>Product unavailable</title></head><body><h1>Product unavailable</h1></body></html>', 404) };
  assert.equal((await publicPageResponse(args)).status, 200);
  const removed = await publicPageResponse(args);
  assert.equal(removed.status, 404);
  assert.match(removed.headers.get('x-robots-tag'), /noindex/);
  assert(!((await removed.text()).includes('Travel Mug')));
  assert.equal(calls, 2);
});

test('upstream errors, bad canonical data and missing app assets fail temporarily, never as a fake success', async t => {
  t.mock.method(console, 'error', () => {});
  for (const fetchImpl of [
    async () => upstream('unavailable', 503),
    async () => { throw Error('private diagnostic must not be exposed'); },
    async () => upstream(document('https://wrong.example/product')),
    async () => upstream('<html><head><title>Incomplete</title></head><body>Incomplete</body></html>'),
  ]) {
    const response = await publicPageResponse({ kind: 'product', value: id, appShell: async () => shell, fetchImpl });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert(!((await response.text()).includes('private diagnostic')));
  }
  const missingAsset = await publicPageResponse({ kind: 'product', value: id, appShell: async () => { throw Error('ENOENT'); }, fetchImpl: async () => upstream() });
  assert.equal(missingAsset.status, 503);
});

test('request parameters cannot become arbitrary fetch destinations or file paths', async () => {
  for (const [kind, value] of [['other', id], ['product', '../../secret'], ['store', 'shop/../../secret'], ['store', 'https://other.example']]) {
    assert.equal(publicRenderTarget(kind, value), null);
    const response = await publicPageResponse({ kind, value, appShell: async () => { throw Error('must not read'); }, fetchImpl: async () => { throw Error('must not fetch'); } });
    assert.equal(response.status, 404);
  }
  assert.equal(publicRenderTarget('product', id.toUpperCase()).canonical, canonical);
});

test('private/search query data is never copied to the internal render URL or canonical metadata', () => {
  const url = new URL(`${canonical}?orderId=private&email=private&token=private`);
  const target = publicPageFunctionUrl({ url });
  assert.equal(target.searchParams.get('noindex'), '1');
  assert(!target.href.includes('private'));
  assert(nonIndexableQuery(new URLSearchParams('search=mug')));
  assert(!nonIndexableQuery(new URLSearchParams('currency=PKR&utm_source=whatsapp')));
});

test('private app pages and preview deployments remain noindex', async () => {
  for (const path of ['/checkout', '/user-dashboard/orders', '/seller-dashboard/payments', '/orders/confirm/private', '/safepay/return', '/login']) {
    const response = await middleware(new Request('https://rozare.com' + path));
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    const target = new URL(response.headers.get('x-middleware-rewrite'));
    assert.equal(target.search, '?kind=private');
    assert(!target.href.includes('confirm/private'));
  }
  assert.match((await middleware(new Request('https://preview.vercel.app/'))).headers.get('x-robots-tag'), /noindex/);
});

test('static page aliases redirect once to lowercase, slashless canonical URLs', async () => {
  for (const [from, to] of [['/ABOUT/', '/about'], ['/products/', '/products'], ['/PRIVACY', '/privacy'], [`/single-product/${id.toUpperCase()}/`, `/single-product/${id}`]]) {
    const response = await middleware(new Request('https://rozare.com' + from));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://rozare.com' + to);
  }
});

test('unknown documentation paths are 404 rather than copies of the documentation home', async () => {
  const response = await middleware(new Request('https://docs.rozare.com/nonexistent-guide'));
  assert.equal(response.status, 404);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await middleware(new Request('https://docs.rozare.com/favicon.svg'))).headers.get('x-middleware-next'), '1');
});

test('the documentation root explicitly serves its own prerender rather than the existing homepage index file', async () => {
  const response = await middleware(new Request('https://docs.rozare.com/'));
  assert.equal(response.headers.get('x-middleware-rewrite'), 'https://docs.rozare.com/docs-prerendered.html');
});

test('an unreadable store-status response is temporary unavailability, not a false permanent removal', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ unexpected: true }));
  const response = await middleware(new Request('https://active-shop.rozare.com/'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '60');
});

test('private SPA navigation uses the same indexing rules, and the catalog has a single main heading', () => {
  const guard = readFileSync(new URL('../src/components/common/PrivatePageSEO.jsx', import.meta.url), 'utf8');
  assert(guard.includes('isPrivatePath(pathname)'));
  assert(guard.includes('noindex'));
  const catalog = readFileSync(new URL('../src/components/Products.jsx', import.meta.url), 'utf8');
  assert(/<h2[^>]*>Filters<\/h2>/.test(catalog));
  assert(/<h1[^>]*>All Products<\/h1>/.test(catalog));
});

test('product images use the product gallery, and stores prefer their own logo', () => {
  assert.equal(productShareImage({ image, images: [{ url: 'https://images.example.com/other.png' }] }), image);
  assert.equal(productShareImage({ image: ' ', images: ['https://images.example.com/gallery.png'] }), 'https://images.example.com/gallery.png');
  assert.equal(productShareImage({ image: 'javascript:alert(1)' }), false);
  assert.equal(productShareImage({ image: 'https://user:password@images.example.com/private.png' }), false);
  assert.equal(storeShareImage({ logo: '/store-logo.png', banner: image }), 'https://rozare.com/store-logo.png');
  assert.equal(storeShareImage({ logo: ' ', banner: image }), false);
});

test('private pages serve the actual app without preview images, account data, private URLs or upstream requests', async () => {
  let calls = 0;
  const response = await publicPageResponse({ kind: 'private', appShell: async () => shell,
    fetchImpl: async () => { calls++; throw Error('must not fetch private data'); } });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert(!html.includes('og:image'));
  assert(!html.includes('twitter:image'));
  assert(!html.includes('brand.png'));
  assert(html.includes('/assets/app-real.js'));
  assert(html.includes('<div id="root"></div>'));
  // Helmet must take ownership on hydration/navigation; an unmanaged private
  // robots/title tag must not linger after the buyer opens a public product.
  assert(html.includes('<title data-rh="true">Your account | Rozare</title>'));
  assert(html.includes('<meta data-rh="true" name="robots"'));
});

test('public pages with no genuine image still render, without restoring the generic app image', () => {
  const noImage = document().replace(/<meta[^>]*(?:og:image|twitter:image)[^>]*>/g, '');
  const html = mergePublicPage(shell, noImage, canonical);
  assert(html.includes('Travel Mug'));
  assert(!html.includes('brand.png'));
  assert(!html.includes('og:image'));
});
