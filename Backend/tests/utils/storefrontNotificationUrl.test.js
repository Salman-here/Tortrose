'use strict';

const { storefrontNotificationUrl } = require('../../utils/storefrontNotificationUrl');

test('storefront notifications use the assigned canonical subdomain, not the store name', () => {
  expect(storefrontNotificationUrl({ storeName: 'Different display name', storeSlug: 'Atlas-Aura', moderationStatus: 'approved' }))
    .toBe('https://atlas-aura.rozare.com/');
});

test.each(['pending', 'blocked'])('a %s store does not expose its unreviewed address', moderationStatus => {
  expect(storefrontNotificationUrl({ storeSlug: 'unreviewed-name', moderationStatus })).toBe('');
});

test.each(['', undefined, 'x', 'unsafe/slug', 'https://example.com', 'login', 'rozare-support', 'amazon-official', 'a'.repeat(64)])(
  'invalid or reserved slug %p never becomes an outbound store URL', storeSlug => {
    expect(storefrontNotificationUrl({ storeSlug, moderationStatus: 'approved' })).toBe('');
  },
);

test('an assigned address does not imply the store is currently public', () => {
  expect(storefrontNotificationUrl({ storeSlug: 'atlas-aura', moderationStatus: 'approved', isActive: false }))
    .toBe('https://atlas-aura.rozare.com/');
});
