'use strict';
jest.mock('../../services/sellerOperationalNotificationService', () => ({ ensureProductBlockedNotification: jest.fn() }));
const { POLICY_VERSION, APPROVED_POLICY_VERSIONS, contentSnapshot, contentHash, inspectContent, pickProductInput, publicImageUrl, publicContentClause, isContentApproved } = require('../../services/catalogContentPolicy');
const { prepareCatalogModeration, stageStoreModeration } = require('../../services/catalogModerationService');
const { stageProductModeration, publicProductFilter, isProductBlocked } = require('../../services/productModerationService');
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
    expect(stageProductModeration({ ...item, name }).fields.moderationStatus).toBe('approved');
  }
});

test('clean content passes synchronously without AI; money-only edits reuse the local decision', () => {
  const staged = stageProductModeration(item);
  expect(staged.fields.moderationStatus).toBe('approved'); expect(isProductBlocked(staged.fields)).toBe(false);
  expect(publicProductFilter().$and).toContainEqual(publicContentClause());
  const previous = { ...item, ...staged.fields, moderationStatus: 'approved', isBlocked: false, moderationReviewedAt: new Date() };
  expect(stageProductModeration({ ...previous, price: 29, stock: 5 }, { previous }).fields).toEqual({});
  const revised = stageProductModeration({ ...previous, description: 'New useful fabric description.' }, { previous });
  expect(revised.fields.catalogModeration.revision).not.toBe(staged.fields.catalogModeration.revision);
  expect(revised.fields.moderationStatus).toBe('approved');
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
    expect(publicContentClause()).toEqual({ moderationStatus: 'approved', moderationPolicyVersion: { $in: APPROVED_POLICY_VERSIONS }, moderationReviewedAt: { $type: 'date' } });
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

test('moderation makes no network calls and does not download or transform images', () => {
  const externalCall = jest.spyOn(global, 'fetch').mockImplementation(() => { throw new Error('External moderation forbidden'); });
  try {
    const result = stageProductModeration(item);
    expect(result.fields.moderationStatus).toBe('approved');
    expect(result.fields.image).toBeUndefined(); expect(result.fields.images).toBeUndefined();
    expect(externalCall).not.toHaveBeenCalled();
  } finally { externalCall.mockRestore(); }
});

test('a book/guide label cannot exempt a prohibited product phrase from local checks', () => {
  expect(stageProductModeration({ ...item, name: 'Silicone dildo with user guide' }).fields.moderationStatus).toBe('blocked');
  expect(stageProductModeration({ ...item, name: 'Personal Pleasure Device' }).fields.moderationStatus).toBe('blocked');
});
