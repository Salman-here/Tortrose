'use strict';
const { messageLinkPreview } = require('../../services/whatsapp/linkPreviewPolicy');

test.each([
  'https://rozare.com/single-product/6ad0d6444966bc5a7583d639',
  'https://rozare.com/single-product/6ad0d6444966bc5a7583d639?currency=PKR',
  'https://atlas-aura-goods.rozare.com/',
  'https://atlas-aura-goods.rozare.com/single-product/6ad0d6444966bc5a7583d639',
  'https://rozare.com/store/atlas-aura-goods',
])('public catalog share keeps its preview: %s', url => expect(messageLinkPreview(`See ${url}`)).toBe(true));

test.each([
  'https://rozare.com/user-dashboard/order/detail/6ad0d6444966bc5a7583d639',
  'https://rozare.com/seller-dashboard/orders',
  'https://rozare.com/orders/confirm/private-token',
  'https://rozare.com/reset-password/private-token',
  'https://rozare.com/checkout', 'https://rozare.com/track-order',
  'https://docs.rozare.com/', 'https://rozare.com/',
  'https://atlas-aura-goods.rozare.com/?token=secret',
  'https://rozare.com/single-product/6ad0d6444966bc5a7583d639?payment_intent_client_secret=secret',
  'https://rozare.com/single-product/not-an-id',
  'http://atlas-aura-goods.rozare.com/',
])('internal/private/invalid links do not generate preview fetches: %s', url => expect(messageLinkPreview(url)).toBe(false));

test('private links take precedence and lookalike external domains are not treated as Rozare', () => {
  expect(messageLinkPreview('https://atlas-aura-goods.rozare.com/ and https://rozare.com/track-order')).toBe(false);
  expect(messageLinkPreview('https://rozare.com.evil.example/checkout')).toBeUndefined();
  expect(messageLinkPreview('No links')).toBeUndefined();
  expect(messageLinkPreview('See (https://atlas-aura-goods.rozare.com/).')).toBe(true);
});
