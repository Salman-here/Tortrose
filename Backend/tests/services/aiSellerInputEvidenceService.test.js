'use strict';
const { assessSellerCreationInputs, amountValue } = require('../../services/aiSellerInputEvidenceService');
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const base = { name: 'Cedar Trail Cup', price: 10, stock: 10, currency: 'PKR' };
const request = user('For testing, add this to my store as Cedar Trail Cup. It is a reusable cup with a lid. [Attached product image: https://example.com/price10-stock10.png]');
const assess = messages => assessSellerCreationInputs({ ...base, messages });

test('store-wide confirmation does not approve an example as a new product price', () => {
  const messages = [request, user('price 10, stock 3'), assistant('Change your store product currency from PKR to USD? Existing product price 100 USD. You cannot change it again for 60 days. Confirm?'), user('yes')];
  expect(assess(messages)).toMatchObject({ ok: true, price: 10, stock: 3, explicitPriceCurrency: false });
  messages.push(assistant('Your store product currency is now USD.'), user('add it now'));
  expect(assess(messages)).toMatchObject({ ok: false, missing: expect.arrayContaining(['price currency after the store currency change']) });
  messages.push(user('price 10 USD, stock 3'));
  expect(assess(messages)).toMatchObject({ ok: true, price: 10, currency: 'USD', explicitPriceCurrency: true });
});

test('testing wording, image URLs, identifiers and assistant guesses cannot supply commercial facts', () => {
  expect(assess([request])).toMatchObject({ ok: false, missing: ['selling price', 'stock quantity'] });
  expect(assess([request, assistant('The price is Rs10 and stock is 10.'), user('write a short description')]).ok).toBe(false);
  expect(assess([user('Add Cedar Trail Cup to my store. Phone +12025550116. Order ORD-1788861073201. It holds 350ml.')]).ok).toBe(false);
});

test('uses the seller values across a missing-details follow-up, not the model guesses', () => {
  expect(assess([request, assistant('What price, category, brand and stock should I use?'), user('2100 rupees each, three in stock, brand Mobile AI Forge. Choose the category.')]))
    .toMatchObject({ ok: true, price: 2100, stock: 3, currency: 'PKR' });
});

test.each([
  ['two thousand rupees, six in stock', 2000, 6, 'PKR'],
  ['$29.50 each, stock 7', 29.5, 7, 'USD'],
  ['10 dollars each, stock 2', 10, 2, 'USD'],
  ['price 10 US dollars, stock 2', 10, 2, 'USD'],
  ['price 29.50$, stock 7.', 29.5, 7, 'USD'],
  ['price 20,50 EUR, stock 2', 20.5, 2, 'EUR'],
  ['price Rs2,100.50; inventory 4', 2100.5, 4, 'PKR'],
  ['do hazaar rupees; stock teen', 2000, 3, 'PKR'],
  ['price is free, out of stock', 0, 0, 'PKR'],
])('understands explicit commercial values: %s', (text, price, stock, currency) => {
  expect(assess([request, user(text)])).toMatchObject({ ok: true, price, stock, currency });
});

test('requires each missing field and retains the latest correction', () => {
  expect(assess([request, user('price Rs2100')])).toMatchObject({ ok: false, missing: ['stock quantity'] });
  expect(assess([request, user('stock 3')])).toMatchObject({ ok: false, missing: ['selling price'] });
  expect(assess([request, user('price Rs2100, stock 3'), user('actually price Rs2200, stock 4'), user('add it now')]))
    .toMatchObject({ ok: true, price: 2200, stock: 4 });
});

test('accepts ordinary two-value replies in the order of the actual question', () => {
  expect(assess([request, assistant('What price and stock should I use?'), user('2100, three')])).toMatchObject({ ok: true, price: 2100, stock: 3 });
  expect(assess([request, assistant('How many in stock, and what price?'), user('3 and 2100')])).toMatchObject({ ok: true, price: 2100, stock: 3 });
});

test('does not borrow values from an earlier different product', () => {
  expect(assess([user('Add First Bottle, price Rs5000, stock 50'), request])).toMatchObject({ ok: false });
});

test('accepts an explicit approval of displayed price and stock, not a generic follow-up yes', () => {
  expect(assess([request, assistant('Price Rs2100, stock 3. Shall I publish this?'), user('yes, please')])).toMatchObject({ ok: true, price: 2100, stock: 3 });
  expect(assess([request, assistant('Price Rs2100, stock 3. Shall I publish this?'), user('yeah that looks good to me, go ahead')])).toMatchObject({ ok: true, price: 2100, stock: 3 });
  expect(assess([request, assistant('Price Rs2100, stock 3. Shall I publish this?'), user('yes but change the price')]).ok).toBe(false);
  expect(assess([request, assistant('Price Rs10, stock 10. What else can I help with?'), user('yes')]).ok).toBe(false);
});

test('binds uploaded rows to the named product and preserves their currency', () => {
  const rows = [{ name: 'Other Cup', price: 10, stock: 10, currency: 'USD' }, { name: 'Cedar Trail Cup', price: 29.5, stock: 4, currency: 'USD' }];
  const message = user(`Import these products.\nParsed product rows JSON:\n${JSON.stringify(rows, null, 2)}`);
  expect(assess([message])).toMatchObject({ ok: true, price: 29.5, stock: 4, currency: 'USD' });
  expect(assess([message, assistant('Which rows should I add?'), user('Add only Cedar Trail Cup now')])).toMatchObject({ ok: true, price: 29.5, stock: 4, currency: 'USD' });
  expect(assess([user('Import these USD products: ' + JSON.stringify([{ name: 'Cedar Trail Cup', price: 29.5, stock: 4 }]))])).toMatchObject({ ok: true, price: 29.5, stock: 4, currency: 'USD' });
  const unicode = user('Import these products.\nParsed product rows JSON:\n' + JSON.stringify([{ name: 'کپ', price: 100, stock: 2, currency: 'PKR' }, { name: 'بوتل', price: 200, stock: 3, currency: 'PKR' }]));
  expect(assessSellerCreationInputs({ ...base, name: 'بوتل', messages: [unicode] })).toMatchObject({ ok: true, price: 200, stock: 3 });
});

test('binds ordinary multi-product lists to each named row', () => {
  const messages = [user('Add these products. All prices in USD.\nCedar Trail Cup, price 12, stock 3\nAlpine Bottle, price 25, stock 8')];
  expect(assessSellerCreationInputs({ ...base, messages, productNames: ['Cedar Trail Cup', 'Alpine Bottle'] })).toMatchObject({ ok: true, price: 12, stock: 3, currency: 'USD' });
  expect(assessSellerCreationInputs({ ...base, name: 'Alpine Bottle', messages, productNames: ['Cedar Trail Cup', 'Alpine Bottle'] })).toMatchObject({ ok: true, price: 25, stock: 8, currency: 'USD' });
});

test('rejects invented sale prices and computes an explicitly requested percentage discount', () => {
  const messages = [request, user('price Rs2000, stock 3')];
  expect(assessSellerCreationInputs({ ...base, discountedPrice: 1000, messages }).missing).toContain('sale price');
  expect(assess([...messages, user('use 10% off')])).toMatchObject({ ok: true, price: 2000, stock: 3, discountedPrice: 1800 });
  expect(assess([request, user('price Rs2000, stock 3, sale price Rs1800')])).toMatchObject({ ok: true, price: 2000, discountedPrice: 1800 });
  expect(assess([...messages, user('use 10% off'), user('actually no discount')])).toMatchObject({ ok: true, discountedPrice: 0 });
  expect(assess([...messages, user('use 100% off')]).ok).toBe(false);
});

test('number words are parsed conservatively', () => {
  expect(amountValue('one thousand and twenty five')).toBe(1025);
  expect(amountValue('2.1k')).toBe(2100);
  expect(amountValue('a reasonable amount')).toBeNull();
});

test('available money and filenames are not stock declarations', () => {
  expect(assess([request, user('Price Rs2100. I have Rs100 available.')]).missing).toContain('stock quantity');
  expect(assess([request, user('Price Rs2100. Use the filename stock3.png.')]).missing).toContain('stock quantity');
  expect(assess([request, user('Price is one of the details I will give later. Stock 3.')]).ok).toBe(false);
  expect(assess([request, user('Price Rs2100. Stock is one of my concerns.')]).ok).toBe(false);
  expect(assess([request, user('The price so high, stock 3.')]).ok).toBe(false);
  expect(assess([request, user('What price do you recommend? Stock 3.')]).ok).toBe(false);
});
