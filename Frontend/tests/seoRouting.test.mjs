import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crawlerRenderUrl,
  default as middleware,
  isCrawlerRequest,
  isKnownAppPath,
  isPrivatePath,
  storefrontSlugFromHostname,
} from '../middleware.js';

const requestWithAgent = userAgent => ({
  headers: new Headers({ 'user-agent': userAgent }),
});

test('recognizes search/social crawlers without classifying a normal browser', () => {
  assert.equal(isCrawlerRequest(requestWithAgent('Mozilla/5.0 Chrome/140 Safari/537.36')), false);
  assert.equal(isCrawlerRequest(requestWithAgent('Googlebot/2.1 (+http://www.google.com/bot.html)')), true);
  assert.equal(isCrawlerRequest(requestWithAgent('facebookexternalhit/1.1')), true);
  assert.equal(isCrawlerRequest(requestWithAgent('WhatsApp/2.26')), true);
});

test('extracts only seller storefront hosts', () => {
  assert.equal(storefrontSlugFromHostname('nova-nest.rozare.com'), 'nova-nest');
  assert.equal(storefrontSlugFromHostname('NOVA-NEST.ROZARE.COM:443'), 'nova-nest');
  assert.equal(storefrontSlugFromHostname('rozare.com'), null);
  assert.equal(storefrontSlugFromHostname('www.rozare.com'), null);
  assert.equal(storefrontSlugFromHostname('docs.rozare.com'), null);
  assert.equal(storefrontSlugFromHostname('app.rozare.com'), 'app');
  assert.equal(storefrontSlugFromHostname('admin.rozare.com'), 'admin');
  assert.equal(storefrontSlugFromHostname('preview.vercel.app'), null);
  assert.equal(storefrontSlugFromHostname('nested.store.rozare.com'), null);
});

test('maps canonical crawler pages to authoritative SEO renders', () => {
  assert.match(crawlerRenderUrl({ pathname: '/', storefrontSlug: null }), /\/render\/home$/);
  assert.match(crawlerRenderUrl({ pathname: '/products', storefrontSlug: null }), /\/render\/products$/);
  assert.match(crawlerRenderUrl({ pathname: '/marketplace', storefrontSlug: null }), /\/render\/marketplace$/);
  assert.match(crawlerRenderUrl({ pathname: '/store/nova-nest', storefrontSlug: null }), /\/render\/store\/nova-nest$/);
  assert.match(crawlerRenderUrl({ pathname: '/', storefrontSlug: 'nova-nest' }), /\/render\/store\/nova-nest$/);
  assert.match(crawlerRenderUrl({ pathname: '/single-product/abc123', storefrontSlug: 'nova-nest' }), /\/render\/product\/abc123$/);
  assert.equal(crawlerRenderUrl({ pathname: '/privacy', storefrontSlug: null }), null);
});

test('marks private and token-bearing routes as non-indexable', async () => {
  assert.equal(isPrivatePath('/seller-dashboard/order/123'), true);
  assert.equal(isPrivatePath('/LOGIN'), true);
  assert.equal(isPrivatePath('/orders/confirm/a-secret-token'), true);
  assert.equal(isPrivatePath('/reset-password/a-secret-token'), true);
  assert.equal(isPrivatePath('/marketplace/trusted'), true);
  assert.equal(isPrivatePath('/products'), false);
  assert.equal(isPrivatePath('/marketplace'), false);

  const response = await middleware(new Request('https://rozare.com/user-dashboard/orders'));
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
});

test('recognizes every intentional SPA route and rejects arbitrary paths', () => {
  assert.equal(isKnownAppPath('/'), true);
  assert.equal(isKnownAppPath('/privacy/'), true);
  assert.equal(isKnownAppPath('/single-product/abc123'), true);
  assert.equal(isKnownAppPath('/store/nova-nest'), true);
  assert.equal(isKnownAppPath('/seller-dashboard/order/123'), true);
  assert.equal(isKnownAppPath('/docs/getting-started'), true);
  assert.equal(isKnownAppPath('/og-image.png'), true);
  assert.equal(isKnownAppPath('/this-page-does-not-exist'), false);
  assert.equal(isKnownAppPath('/single-product/abc123/extra'), false);
});

test('returns a real noindex 404 for an unknown SPA route', async () => {
  const response = await middleware(new Request('https://rozare.com/this-page-does-not-exist'));
  assert.equal(response.status, 404);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.match(await response.text(), /Page unavailable/);
});

test('returns a real noindex 404 when the backend says a storefront is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ indexable: false }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const response = await middleware(new Request('https://blocked-shop.rozare.com/'));
    assert.equal(response.status, 404);
    assert.match(response.headers.get('x-robots-tag'), /noindex/);
    assert.match(await response.text(), /Store unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('redirects an active legacy store path to its canonical subdomain', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ indexable: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const response = await middleware(new Request('https://rozare.com/store/nova-nest?currency=PKR'));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://nova-nest.rozare.com/?currency=PKR');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('redirects a legacy store path even when it is opened from another storefront', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ indexable: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const response = await middleware(new Request('https://old-shop.rozare.com/store/nova-nest'));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://nova-nest.rozare.com/');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
