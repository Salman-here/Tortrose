import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import middleware, { storefrontSlugFromHostname } from '../middleware.js';

test('independent automation host serves static HTML without storefront API calls for users and crawlers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Independent platform must not call the store API'); };
  try {
    assert.equal(storefrontSlugFromHostname('ai-automations.rozare.com'), null);
    for (const userAgent of ['Mozilla/5.0', 'Googlebot', 'WhatsApp']) {
      const response = await middleware(new Request('https://ai-automations.rozare.com/', { headers: { 'user-agent': userAgent } }));
      assert.equal(response.headers.get('x-middleware-rewrite'), 'https://ai-automations.rozare.com/ai-automations.html');
    }
    const missing = await middleware(new Request('https://ai-automations.rozare.com/login'));
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /rozare/i);
  } finally { globalThis.fetch = originalFetch; }
});

test('landing page has its own identity, price and no marketplace assets or tracking', () => {
  const html = readFileSync(new URL('../public/ai-automations.html', import.meta.url), 'utf8');
  assert.match(html, /Buy automations — \$29/);
  assert.match(html, /AI movie creation workflows/);
  assert.match(html, /free tools/);
  assert.doesNotMatch(html.replaceAll('https://ai-automations.rozare.com/', ''), /rozare|\/src\/main|googletagmanager|tiktok|safepay/i);
});
