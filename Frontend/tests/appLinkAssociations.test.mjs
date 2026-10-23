import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import middleware from '../middleware.js';
import { androidAssociations, ANDROID_CERTIFICATES, ANDROID_PACKAGE } from '../server/appLinkAssociations.mjs';

test('main and storefront verification URLs return exact public Android JSON, without redirects, SPA scripts or account data', async () => {
  for (const host of ['rozare.com', 'www.rozare.com', 'nova-nest.rozare.com']) {
    const response = await middleware(new Request(`https://${host}/.well-known/assetlinks.json`));
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('location'), null); assert.match(response.headers.get('x-robots-tag'), /noindex/);
    const value = await response.json(); assert.deepEqual(value, androidAssociations);
    assert.equal(value[0].target.package_name, ANDROID_PACKAGE); assert.equal(value[0].target.namespace, 'android_app');
    assert(ANDROID_CERTIFICATES.every(fingerprint => /^(?:[A-F\d]{2}:){31}[A-F\d]{2}$/.test(fingerprint)));
    const head = await middleware(new Request(`https://${host}/.well-known/assetlinks.json`, { method: 'HEAD' }));
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
  }
});

test('native manifest claims product/store routes but not generic admin or payment callback URLs', () => {
  const { expo } = JSON.parse(readFileSync(new URL('../../MobileApp/app.json', import.meta.url), 'utf8'));
  const data = expo.android.intentFilters.flatMap(filter => { assert.equal(filter.autoVerify, true); return filter.data; });
  assert(data.some(value => value.host === '*.rozare.com' && value.path === '/'));
  assert(data.some(value => value.host === 'rozare.com' && value.pathPrefix === '/single-product/'));
  assert(!data.some(value => value.pathPrefix === '/'));
  assert(!data.some(value => /admin|safepay|checkout/.test(value.pathPrefix || value.path || '')));
  assert.equal(expo.android.package, ANDROID_PACKAGE);
  const dynamic = androidAssociations[0].relation_extensions['delegate_permission/common.handle_all_urls'].dynamic_app_link_components;
  assert.deepEqual(dynamic.at(-1), { '/': '*', exclude: true });
});

test('unknown previews do not acquire association authority and unsupported methods do not return success', async () => {
  const foreign = await middleware(new Request('https://preview.vercel.app/.well-known/assetlinks.json'));
  assert.notEqual(foreign.headers.get('content-type'), 'application/json; charset=utf-8');
  const post = await middleware(new Request('https://rozare.com/.well-known/assetlinks.json', { method: 'POST' }));
  assert.equal(post.status, 405);
});

test('www canonical routing does not redirect the Android verification file before middleware can serve JSON', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const redirect = config.redirects.find(rule => rule.has?.some(condition => condition.type === 'host' && condition.value === 'www.rozare.com'));
  assert(redirect.source.includes('(?!\\.well-known/)'));
  const pattern = new RegExp('^/' + redirect.source.slice('/:path('.length, -1) + '$');
  assert(!pattern.test('/.well-known/assetlinks.json'));
  assert(pattern.test('/single-product/64b000000000000000000001'));
  assert(pattern.test('/'));
});
