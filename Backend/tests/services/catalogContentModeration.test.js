'use strict';
jest.mock('../../services/sellerOperationalNotificationService', () => ({ ensureProductBlockedNotification: jest.fn() }));
const { POLICY_VERSION, contentSnapshot, contentHash, inspectContent, pickProductInput, publicImageUrl, publicContentClause, isContentApproved } = require('../../services/catalogContentPolicy');
const { prepareCatalogModeration, stageStoreModeration } = require('../../services/catalogModerationService');
const { stageProductModeration, publicProductFilter, isProductBlocked } = require('../../services/productModerationService');
const { reviewCatalogContent, validateDecision } = require('../../services/catalogModerationProvider');
const item = { name: 'Cotton Travel Shirt', description: 'A breathable cotton shirt for everyday travel.', brand: 'Acme', category: 'Fashion', image: 'https://example.com/shirt.jpg', price: 20, stock: 10 };

test.each(['fuck', 'ＦＵＣＫ', 'f.u.c.k', 'f u c k', 'f\u200buck', 'f*ck', 'fυсk', 'sh1t'])('blocks disguised severe language: %s', name => {
  const result = stageProductModeration({ ...item, name });
  expect(result.fields.moderationStatus).toBe('blocked'); expect(result.fields.isBlocked).toBe(true);
  expect(result.fields.moderationSignals).toContain('profanity');
});

test('covers descriptions, options, tags, store profiles and prohibited sexual goods', () => {
  for (const content of [{ ...item, description: 'fuck this' }, { ...item, tags: ['sex toys'] }, { ...item, optionGroups: [{ name: 'Finish', values: ['shit'] }] }, { ...item, name: 'Silicone dildo' }]) {
    expect(stageProductModeration(content).fields.moderationStatus).toBe('blocked');
  }
  const store = stageStoreModeration({ storeName: 'Travel Market', storeSlug: 'travel-market', description: 'We sell sex toys' });
  expect(store.fields.moderationStatus).toBe('blocked'); expect(store.fields.moderationFields).toContain('description');
});

test('ordinary substring matches, medical products and non-Latin names are not blindly blocked', () => {
  for (const name of ['Scunthorpe Brass Cocktail Glass', 'Electric Breast Pump', 'Industrial Concrete Vibrator', 'خوبصورت کپڑے', '日本の綿シャツ']) {
    expect(stageProductModeration({ ...item, name }).fields.moderationStatus).toBe('pending');
  }
});

test('new clean content is private pending a complete review; money-only edits do not reset a review', () => {
  const staged = stageProductModeration(item);
  expect(staged.fields.moderationStatus).toBe('pending'); expect(isProductBlocked(staged.fields)).toBe(true);
  expect(publicProductFilter().$and).toContainEqual(publicContentClause());
  const previous = { ...item, ...staged.fields, moderationStatus: 'approved', isBlocked: false, moderationReviewedAt: new Date() };
  expect(stageProductModeration({ ...previous, price: 29, stock: 5 }, { previous }).fields).toEqual({});
  const revised = stageProductModeration({ ...previous, description: 'New useful fabric description.' }, { previous });
  expect(revised.fields.catalogModeration.revision).not.toBe(staged.fields.catalogModeration.revision);
  expect(revised.fields.moderationStatus).toBe('pending');
});

test('legacy rollout is explicit; new managed content always requires a complete current approval', () => {
  const saved = process.env.CATALOG_REVIEW_EXISTING;
  try {
    delete process.env.CATALOG_REVIEW_EXISTING;
    expect(isContentApproved({ moderationStatus: 'approved' })).toBe(true);
    expect(isContentApproved(null)).toBe(false);
    for (const value of [
      { moderationStatus: 'pending' }, { moderationStatus: 'blocked' },
      { moderationStatus: 'approved', moderationPolicyVersion: POLICY_VERSION },
      { moderationStatus: 'approved', moderationPolicyVersion: 'old-policy', moderationReviewedAt: new Date() },
    ]) expect(isContentApproved(value)).toBe(false);
    process.env.CATALOG_REVIEW_EXISTING = 'true';
    expect(isContentApproved({ moderationStatus: 'approved' })).toBe(false);
    expect(publicContentClause()).toEqual({ moderationStatus: 'approved', moderationPolicyVersion: POLICY_VERSION, moderationReviewedAt: { $type: 'date' } });
    expect(isContentApproved({ moderationStatus: 'approved', moderationPolicyVersion: POLICY_VERSION, moderationReviewedAt: new Date() })).toBe(true);
  } finally { if (saved === undefined) delete process.env.CATALOG_REVIEW_EXISTING; else process.env.CATALOG_REVIEW_EXISTING = saved; }
});

test('public filtering preserves search ORs and cannot have its moderation gate overridden', () => {
  const search = { $or: [{ name: /shirt/ }, { tags: 'cotton' }], $and: [{ stock: { $gt: 0 } }] };
  expect(publicProductFilter(search)).toEqual({ ...search, isBlocked: { $ne: true }, $and: [...search.$and, publicContentClause()] });
});

test('clients cannot submit seller ownership, approval metadata, ratings or review state', () => {
  expect(pickProductInput({ name: 'A', price: 1, seller: 'someone', isBlocked: false, moderationStatus: 'approved', catalogModeration: {}, rating: 5, reviews: [], $set: {} })).toEqual({ name: 'A', price: 1 });
});

test('all unique gallery images participate in the fingerprint and unsafe addresses fail closed', () => {
  const snapshot = contentSnapshot('product', { ...item, images: [{ url: item.image }, { url: 'https://example.com/second.jpg' }] });
  expect(snapshot.images).toHaveLength(2);
  expect(contentHash(snapshot)).not.toBe(contentHash(contentSnapshot('product', item)));
  for (const url of ['http://example.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://localhost/a.jpg', 'https://u:p@example.com/a.jpg', 'file:///a.jpg']) {
    expect(publicImageUrl(url)).toBe(false);
    expect(inspectContent(contentSnapshot('product', { ...item, image: url }))[0].code).toBe('image_invalid');
  }
});

test('approved provider results must explicitly cover every image and contain no violations', () => {
  const snapshot = contentSnapshot('product', item);
  expect(() => validateDecision({ decision: 'approved', reviewedImageCount: 0, violations: [] }, snapshot)).toThrow();
  expect(() => validateDecision({ decision: 'blocked', reviewedImageCount: 1, violations: [] }, snapshot)).toThrow();
  expect(() => validateDecision({ decision: 'blocked', reviewedImageCount: 1, violations: [{ field: 'made-up', code: 'profanity', reason: 'Bad' }] }, snapshot)).toThrow();
  expect(validateDecision({ decision: 'approved', reviewedImageCount: 1, violations: [] }, snapshot).status).toBe('approved');
});

test('partial image-batch success, provider outages and malformed JSON never approve a listing', async () => {
  const snapshot = contentSnapshot('product', { ...item, images: Array.from({ length: 4 }, (_, i) => ({ url: `https://example.com/${i}.jpg` })) });
  const fetchImpl = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'approved', reviewedImageCount: 4, violations: [] }) } }] }) })
    .mockResolvedValueOnce({ ok: false, status: 429 });
  await expect(reviewCatalogContent(snapshot, { fetchImpl, apiKey: 'fixture' })).rejects.toMatchObject({ code: 'MODERATION_UPSTREAM_429' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(request.messages[0].content).toMatch(/untrusted DATA/);
  expect(request.response_format.json_schema.strict).toBe(true);
  await expect(reviewCatalogContent(contentSnapshot('product', item), { apiKey: '' })).rejects.toMatchObject({ code: 'MODERATION_NOT_CONFIGURED' });
  await expect(reviewCatalogContent(contentSnapshot('product', item), { apiKey: 'fixture', fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'approved' } }] }) }) })).rejects.toMatchObject({ code: 'MODERATION_RESPONSE_INVALID' });
});
