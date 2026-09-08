'use strict';
const { createOrderPreview, verifyOrderPreview, bindOrderPreviewToken, PREVIEW_TTL_MS } = require('../../services/aiOrderPreviewService');
const userId = 'buyer-one';
const contract = { currency: 'PKR', summary: { totalAmount: 3939.5 }, items: [{ name: 'Mug', quantity: 1, options: { Color: 'Silver', Capacity: '500ml' } }] };
beforeEach(() => { process.env.JWT_SECRET = 'disposable-preview-key'; });
const make = () => createOrderPreview({ userId, requestKey: 'preview-turn', contract, now: 1000 });
const check = (token, changes = {}) => verifyOrderPreview({ userId, requestKey: 'confirm-turn', quoteToken: token, contract, now: 2000, ...changes });

test('binds a non-authentication preview token to owner, contract and prior turn', () => {
  const token = make().quoteToken;
  expect(check(token).success).toBe(true);
  expect(check(token, { userId: 'other-buyer' }).success).toBe(false);
  expect(check(token, { requestKey: 'preview-turn' }).code).toBe('AI_ORDER_CONFIRMATION_REQUIRED');
  expect(check(token, { contract: { ...contract, currency: 'USD' } }).code).toBe('AI_ORDER_PREVIEW_CHANGED');
});
test('rejects tampering, missing quotes and expired quotes', () => {
  const token = make().quoteToken;
  expect(check(token.slice(0, -2) + 'xx').success).toBe(false);
  expect(check(undefined).code).toBe('AI_ORDER_PREVIEW_REQUIRED');
  expect(check(token, { now: 1000 + PREVIEW_TTL_MS }).code).toBe('AI_ORDER_PREVIEW_EXPIRED');
});
test('canonicalizes JSON field order without changing quoted content', () => {
  expect(check(make().quoteToken, { contract: { items: contract.items, summary: contract.summary, currency: contract.currency } }).success).toBe(true);
});

test('binds the intact signed preview from conversation data instead of a token reproduced by the model', () => {
  const quoteToken = make().quoteToken;
  const args = { productId: 'a-product', quoteToken: 'aip1.mangled.model-value' };
  const messages = [{ role: 'assistant', content: `Your total is Rs3939.50.\n[Tool memory: ${JSON.stringify({ quoteToken })}]` }];
  expect(bindOrderPreviewToken(args, messages, { userId, requestKey: 'next-confirmation' })).toEqual({ ...args, quoteToken });
  expect(bindOrderPreviewToken(args, messages, { userId: 'another-person', requestKey: 'next-confirmation' })).toEqual(args);
  expect(bindOrderPreviewToken(args, [{ ...messages[0], role: 'user' }], { userId, requestKey: 'next-confirmation' })).toEqual(args);
});

test('does not guess between multiple previews in one response', () => {
  const first = make().quoteToken;
  const second = createOrderPreview({ userId, requestKey: 'preview-turn', contract: { ...contract, currency: 'USD' }, now: 1000 }).quoteToken;
  const args = { quantity: 1 };
  expect(bindOrderPreviewToken(args, [{ role: 'assistant', content: `${first}\n${second}` }], { userId, requestKey: 'next-confirmation' })).toEqual(args);
});
