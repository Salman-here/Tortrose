import assert from 'node:assert/strict';
import test from 'node:test';
import { clearPrerenderSeoFallbacks } from '../scripts/prerender-head.mjs';

test('page-specific prerenders do not keep a second homepage title or social preview', () => {
  const html = '<head><title data-rh="true">Home</title><meta data-rh="true" name="description" content="Home"><meta data-rh="true" property="og:title" content="Home"><meta data-rh="true" name="twitter:title" content="Home"><link data-rh="true" rel="canonical" href="https://rozare.com/"><script data-rh="true" type="application/ld+json">{"name":"Home"}</script><meta name="viewport" content="width=device-width"><script src="/assets/app.js"></script><script>window.securityCheck=true</script><link rel="stylesheet" href="/assets/app.css"></head>';
  const cleaned = clearPrerenderSeoFallbacks(html);
  assert.doesNotMatch(cleaned, /Home|canonical|data-rh/);
  for (const preserved of ['viewport', '/assets/app.js', 'window.securityCheck=true', '/assets/app.css']) assert(cleaned.includes(preserved));
});
