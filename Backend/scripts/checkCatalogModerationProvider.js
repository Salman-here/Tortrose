'use strict';
// Operational preflight only. No product/store/order records are written.
// An image-copy check creates a separate review asset, not a live listing.
const crypto = require('node:crypto');
const { contentSnapshot } = require('../services/catalogContentPolicy');
const { reviewCatalogContent } = require('../services/catalogModerationProvider');
const { pinCatalogImages } = require('../services/catalogModerationAssets');

async function main() {
  const fixtures = [
    { label: 'ordinary store', kind: 'store', input: { storeName: 'Family Home Goods', storeSlug: 'family-home-goods', description: 'Everyday household accessories and useful kitchen products.' }, expected: 'approved' },
    { label: 'medical product wording', kind: 'product', input: { name: 'Electric Breastfeeding Milk Pump', description: 'A breast pump for expressing milk for infant feeding.', category: 'Baby Care', brand: 'Family Care' }, expected: 'approved' },
    { label: 'sexual-goods euphemism', kind: 'product', input: { name: 'Adult Pleasure Device', description: 'An intimate adult device made for sexual stimulation.', category: 'Personal', brand: 'Generic' }, expected: 'blocked' },
  ];
  const results = [];
  for (const fixture of fixtures) {
    const result = await reviewCatalogContent(contentSnapshot(fixture.kind, fixture.input));
    results.push({ case: fixture.label, status: result.status, expected: fixture.expected, codes: result.violations.map(v => v.code) });
    if (result.status !== fixture.expected) throw Object.assign(new Error('Moderation provider preflight did not match the expected policy'), { code: 'MODERATION_PREFLIGHT_MISMATCH', results });
  }
  const response = await fetch('https://rozare.up.railway.app/api/products/get-single-product/6a931ecdfac20b9d5e05aa4a?buyerMode=global&buyerCountry=Pakistan&buyerCountryCode=PK', { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Object.assign(new Error('The public image fixture is unavailable'), { code: 'MODERATION_PREFLIGHT_IMAGE_UNAVAILABLE', results });
  const body = await response.json();
  const product = body.product || body.singleProduct;
  if (!product?.image) throw Object.assign(new Error('The public image fixture is unavailable'), { code: 'MODERATION_PREFLIGHT_IMAGE_UNAVAILABLE', results });
  const entity = { ...product, _id: '000000000000000000000001', catalogModeration: { revision: crypto.randomUUID(), assets: [] } };
  const media = await pinCatalogImages('product', entity);
  const result = await reviewCatalogContent(media.snapshot);
  results.push({ case: 'pinned public product images', status: result.status, expected: 'approved', imageCount: media.snapshot.images.length, codes: result.violations.map(v => v.code) });
  console.log(JSON.stringify({ results }, null, 2));
  if (result.status !== 'approved') process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ code: error.code || 'MODERATION_PREFLIGHT_FAILED', results: error.results || [] })); process.exitCode = 1; });
