'use strict';
const { sanitizeCommerceReply, isCartReplacementRequest, catalogLookupBeforeClarification, hasUnfinishedActionPromise } = require('../../services/aiConversationPolicy');

test('hides database identifiers from prose while retaining working product links and public order numbers', () => {
  const internal = '6a9b63fe12c509a47fe03649';
  expect(sanitizeCommerceReply(`Aurora mug\n- **Product ID:** ${internal}\n\nPrice: Rs100\n[View product](https://rozare.com/single-product/${internal})\nOrder ORD-1788599783647`))
    .toBe(`Aurora mug\n\nPrice: Rs100\n[View product](https://rozare.com/single-product/${internal})\nOrder ORD-1788599783647`);
  expect(sanitizeCommerceReply(`The item is ${internal}.`)).not.toContain(internal);
});

test.each(['make it silver instead, still just one mug', 'change the size to medium', 'switch that one to black', 'iski jagah silver kar do'])('recognizes a cart change rather than an addition: %s', text => {
  expect(isCartReplacementRequest(text)).toBe(true);
});
test.each(['add another black mug', 'I want an extra mug', 'remove the black mug instead of the silver one', 'find a travel mug'])('does not treat an explicit addition/removal/search as a variant change: %s', text => {
  expect(isCartReplacementRequest(text)).toBe(false);
});

test('requires a seller lookup before asking for exact spelling, but never repeats an attempted lookup', () => {
  const draft = 'Please provide the exact product name or a more specific description.';
  expect(catalogLookupBeforeClarification(draft, 'find my lunch jarr stock', 'seller', [])).toBe('list_my_products');
  expect(catalogLookupBeforeClarification(draft, 'find me a mug to buy', 'seller', [])).toBe('search_products');
  expect(catalogLookupBeforeClarification(draft, 'find my lunch jarr stock', 'seller', [{ tool: 'list_my_products', result: { success: true } }])).toBeNull();
  expect(catalogLookupBeforeClarification('Which color and capacity?', 'add the mug', 'user', [])).toBeNull();
});

test.each(["I'll add that mug now.", 'Got it! Adding the Black 500ml mug to your cart now. Just a moment!', 'Let me update the stock.'])('detects an unfinished action promise: %s', text => {
  expect(hasUnfinishedActionPromise(text)).toBe(true);
});

test.each(["I've added one Black mug to your cart.", 'Which color would you like?', 'The mug has 22 in stock.'])('keeps completed results and genuine questions: %s', text => {
  expect(hasUnfinishedActionPromise(text)).toBe(false);
});

test.each([
  'Main aapki cart mein mug ko black color mein update kar rahi hoon. Ek minute dijiye, main yeh kar deti hoon.',
  'Main ab cart update kar deta hoon.',
  'Main cart ko update kar dunga.',
  'میں آپ کا کارٹ اپڈیٹ کر رہا ہوں۔',
  'मैं कार्ट अपडेट कर रही हूँ।',
])('detects an unfinished Roman Urdu or Urdu/Hindi action promise: %s', text => {
  expect(hasUnfinishedActionPromise(text)).toBe(true);
});

test.each([
  'Maine aapka cart update kar diya hai. Ab ek black mug hai.',
  'Purple available nahi hai. Black ya Silver, kaunsa chahiye?',
  'میں نے آپ کا کارٹ اپڈیٹ کر دیا ہے۔',
])('keeps Urdu results and actual selection questions: %s', text => {
  expect(hasUnfinishedActionPromise(text)).toBe(false);
});
