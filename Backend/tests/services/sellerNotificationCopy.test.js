'use strict';

jest.mock('../../services/notificationOutboxService', () => ({
  enqueueNotificationEvent: jest.fn(async event => event),
  outboxError: (message, code) => Object.assign(new Error(message), { code }),
}));
jest.mock('../../models/Store', () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock('../../models/Product', () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock('../../models/User', () => ({}));

const operational = require('../../services/sellerOperationalNotificationService');
const moderation = require('../../services/catalogModerationNotificationService');
const lifecycle = require('../../services/subscriptionLifecycleNotificationService');
const subdomain = require('../../services/subdomainLifecycleNotificationService');
const at = new Date('2026-10-12T10:00:00.000Z');
const future = new Date('2026-10-20T10:00:00.000Z');
const store = { _id: 'store-id', seller: 'seller-id', storeName: 'Atlas Aura', storeSlug: 'atlas-aura', createdAt: at, moderationStatus: 'approved' };
const serializedTemplates = event => JSON.stringify(event.templates);

test('seller welcome does not echo a store name captured before its content decision', async () => {
  const event = await operational.enqueueSellerWelcomeNotification({ _id: 'seller-id',
    sellerWelcomeNotice: { occurredAt: at, storeName: 'Unsafe preview name' } });
  expect(serializedTemplates(event)).not.toContain('Unsafe preview name');
  expect(event.templates.email.text).toContain('Your seller account is ready.');
});

test('store creation email and WhatsApp show the canonical assigned address with seller setup guidance', async () => {
  const event = await operational.enqueueStoreCreatedNotification(store);
  expect(event.templates.email.text).toContain('Store address: https://atlas-aura.rozare.com/');
  expect(event.templates.email.html).toContain('href="https://atlas-aura.rozare.com/"');
  expect(event.templates.whatsapp.message).toContain('https://atlas-aura.rozare.com/');
  expect(serializedTemplates(event)).not.toMatch(/Store path|\/store\/|visible to every|is live/i);
  expect(event.metadata.linkTo).toBe('/seller-dashboard/store-settings');
  expect(event.metadata.data).toMatchObject({ storePresentationVersion: 1,
    storefrontUrlAtCreation: 'https://atlas-aura.rozare.com/', storeModerationStatusAtCreation: 'approved', storeNameAtCreation: 'Atlas Aura' });
});

test.each(['pending', 'blocked'])('a %s store creation avoids unreviewed names and subdomains on every channel', async moderationStatus => {
  const event = await operational.enqueueStoreCreatedNotification({ ...store, moderationStatus,
    storeName: 'Unsafe preview name', storeSlug: 'unsafe-preview-slug' });
  expect(serializedTemplates(event)).not.toMatch(/Unsafe preview name|unsafe-preview-slug/i);
  expect(serializedTemplates(event)).toMatch(/saved/i);
  expect(serializedTemplates(event)).not.toMatch(/successfully.*visible|ready for customers/i);
  expect(event.metadata.data).toMatchObject({ storePresentationVersion: 1,
    storefrontUrlAtCreation: '', storeNameAtCreation: '', storeModerationStatusAtCreation: moderationStatus });
});

test('seller store rating uses the actual storefront review section, not a nonexistent dashboard review section', async () => {
  const event = await operational.enqueueNewStoreReviewNotification({ store: { ...store, isActive: true }, buyerName: 'Sam',
    review: { _id: 'review-id', createdAt: at, rating: 5 } });
  expect(event.templates.email.text).toContain('Sam rated Atlas Aura 5 out of 5.');
  expect(event.metadata.linkTo).toBe('/store/atlas-aura#store-reviews');
  expect(event.templates.whatsapp.message).toContain('https://atlas-aura.rozare.com/#store-reviews');
  expect(event.templates.email.html).toContain('href="https://atlas-aura.rozare.com/#store-reviews"');
  expect(serializedTemplates(event)).not.toContain('store overview');
  expect(event.metadata.data).toMatchObject({ storeReviewPresentationVersion: 1,
    reviewStoreName: 'Atlas Aura', reviewStorefrontUrl: 'https://atlas-aura.rozare.com/#store-reviews' });
});

test.each(['pending', 'blocked'])('store rating for a %s storefront avoids unreviewed store content and false review-page guidance', async moderationStatus => {
  const event = await operational.enqueueNewStoreReviewNotification({ store: { ...store, isActive: true, moderationStatus,
    storeName: 'Unsafe store name', storeSlug: 'unsafe-store-name' }, buyerName: 'Sam',
    review: { _id: 'review-id', createdAt: at, rating: 5 } });
  expect(serializedTemplates(event)).toContain('Sam rated your store 5 out of 5.');
  expect(serializedTemplates(event)).not.toMatch(/Unsafe store name|unsafe-store-name|Read the review|view.*overview/i);
  expect(event.metadata.linkTo).toBe('/seller-dashboard/store-overview');
  expect(event.metadata.data).toMatchObject({ storeReviewPresentationVersion: 1,
    reviewStoreName: 'your store', reviewStorefrontUrl: '' });
});

test.each(['store', 'product'])('approved %s content does not promise public visibility or describe implementation', async kind => {
  const event = await moderation.ensureCatalogModerationNotification(kind, { _id: 'entity-id', seller: 'seller-id',
    catalogModeration: { noticeId: 'notice-id', noticeAt: at, noticeStatus: 'approved' } });
  expect(serializedTemplates(event)).toMatch(/content has been approved/);
  expect(serializedTemplates(event)).not.toMatch(/local content rules|\bAI\b|now live/i);
});

test('blocked catalog notices use safe policy reasons without exposing rejected text or internal field paths', async () => {
  const event = await moderation.ensureCatalogModerationNotification('product', { _id: 'entity-id', seller: 'seller-id',
    catalogModeration: { noticeId: 'notice-id', noticeAt: at, noticeStatus: 'blocked',
      noticeReason: 'Untrusted moderation text', violations: [{ field: 'optionGroups.0.values.1', code: 'profanity' }] } });
  expect(serializedTemplates(event)).toContain('Remove offensive or profane wording');
  expect(serializedTemplates(event)).not.toMatch(/Untrusted moderation text|optionGroups/);
});

test.each([null, 'invalid', [{ code: '__proto__' }], [{ code: 'constructor' }]])('unknown moderation reason data %p falls back safely', async violations => {
  const event = await moderation.ensureCatalogModerationNotification('store', { _id: 'entity-id', seller: 'seller-id',
    catalogModeration: { noticeId: 'notice-id', noticeAt: at, noticeStatus: 'blocked', noticeReason: 'Untrusted reason', violations } });
  expect(event.templates.email.text).toContain("does not meet Rozare's content guidelines");
  expect(event.templates.email.text).not.toMatch(/Untrusted reason|native code|\[object Object\]/);
});

test('the Safepay ending warning remains provider-safe and explains the seller action', async () => {
  const event = await lifecycle.enqueueSubscriptionEndingNotification({ _id: 'subscription-id', seller: 'seller-id',
    status: 'active', billingProvider: 'safepay', cancelledAt: at, currentPeriodEnd: future,
    safepayBilling: { contractId: 'contract-id', environment: 'sandbox', autoRenew: false }, founderOffer: { active: true } }, { now: at });
  expect(serializedTemplates(event)).toContain('2026-10-20');
  expect(serializedTemplates(event)).toContain('automatic renewal is turned off');
  expect(serializedTemplates(event)).toContain('Resume automatic renewal');
  expect(serializedTemplates(event)).not.toMatch(/Stripe|funded|persisted/);
  expect(event.metadata.data.safepayContractId).toBe('contract-id');
  expect(event.metadata.data).not.toHaveProperty('stripeSubscriptionId');
});

test('trial and bonus messages use customer-facing eligibility language', async () => {
  const trial = await lifecycle.enqueueTrialExpiringNotification({ _id: 'subscription-id', seller: 'seller-id', status: 'trial',
    trialEndDate: future, hasUsedFreePeriod: false, lifecyclePricing: { trialExpiring: {
      eventAt: future, starterFreePeriodDays: 30, starterStandardAmountMinor: 999, starterFounderAmountMinor: 599 } } });
  expect(serializedTemplates(trial)).toContain('30-day free introductory period');
  expect(serializedTemplates(trial)).toContain('If you qualify for the FIRST100 offer');
  expect(serializedTemplates(trial)).not.toContain('This seller');
  const bonus = await lifecycle.enqueueBonusLifecycleNotification({ _id: 'subscription-id', seller: 'seller-id',
    hasUsedFreePeriod: true, lifecyclePricing: { bonusExpired: { eventAt: at, eliteFreePeriodDays: 45, eliteAmountMinor: 2165 } } }, { kind: 'expired', sourceDate: at });
  expect(serializedTemplates(bonus)).toContain('core Starter features remain available while your subscription is active');
  expect(serializedTemplates(bonus)).not.toMatch(/persisted|frozen|permanently removed/);
});

test('subdomain expiry and release messages distinguish ownership from current store access', async () => {
  const current = { ...store, subdomainPurchase: { expiryNotice: { slug: 'atlas-aura', expiresAt: at },
    removalNotice: { previousSlug: 'atlas-aura', removedAt: at } } };
  const expired = await subdomain.enqueueSubdomainOwnershipExpiredNotification(current);
  expect(expired.templates.email.text).toContain('Your paid ownership of atlas-aura.rozare.com ended on 2026-10-12');
  expect(expired.templates.email.text).not.toMatch(/store.*removed/i);
  const removed = await subdomain.enqueueSubdomainRemovedNotification(current);
  expect(removed.templates.email.text).toContain('Reactivate your store, then choose an available address');
  expect(removed.templates.email.text).not.toMatch(/https:\/\/atlas-aura|reserved forever|purchase.*active/i);
});
