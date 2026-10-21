import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = readFileSync(new URL('../src/components/order/BuyerSellerFulfillmentGroups.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const built = buildSync({ entryPoints: [fileURLToPath(new URL('../src/components/order/BuyerSellerFulfillmentGroups.jsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(new URL('../package.json', import.meta.url)), mod, mod.exports);
const Card = mod.exports.default;
const money = amount => `Rs${amount.toFixed(2)} PKR`;
const render = value => renderToStaticMarkup(React.createElement(Card, { order: value, formatMoney: money, onCancel: () => {} }));

const single = () => ({ currency: 'PKR', buyerPresentationVersion: 1, sellerGroupingAvailable: true,
  orderItems: [
    { productId: 'p1', seller: 'seller-a', name: 'Notebook', quantity: 1, price: 475, lineSubtotal: 475, selectedOptions: { Size: 'A5', Color: 'Blue' } },
    { productId: 'p2', seller: 'seller-a', name: 'Travel Mug', quantity: 1, price: 100, lineSubtotal: 100, selectedOptions: { Size: 'Large', Color: 'Green' } },
    { productId: 'p3', seller: 'seller-a', name: 'Classic Mug', quantity: 1, price: 100, lineSubtotal: 100 },
  ],
  orderSummary: { subtotal: 675, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 675 },
  sellerGroups: [{ sellerId: 'seller-a', storeName: 'Store A', itemIndexes: [0, 1, 2], itemCount: 3, units: 3, status: 'pending', canCancel: true,
    shippingMethod: { name: 'free', price: 0, estimatedDays: 5 },
    summary: { subtotal: 675, shippingCost: 0, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 675 } }],
});

const multi = () => {
  const value = single();
  value.orderItems.push({ productId: 'p4', seller: 'seller-b', name: 'Second store mug', quantity: 2, price: 200, lineSubtotal: 400, selectedOptions: { Color: 'White' } });
  value.sellerGroups.push({ sellerId: 'seller-b', storeName: 'Store B', itemIndexes: [3], itemCount: 1, units: 2, status: 'confirmed', canCancel: true,
    shippingMethod: { name: 'standard', price: 300, estimatedDays: 3 },
    summary: { subtotal: 400, shippingCost: 300, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 700 } });
  value.orderSummary = { subtotal: 1075, shippingCost: 300, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 1375 };
  return value;
};
const summaryPart = (html, sellerId) => html.split(`data-seller-summary="${sellerId}"`)[1]?.split('</section>')[0] || '';

test('one seller hides the entire side summary and removes the empty desktop column', () => {
  const value = single(), before = JSON.stringify(value), html = render(value);
  assert.ok(!html.includes('data-seller-summary='));
  assert.ok(!html.includes('xl:grid-cols-[1fr_230px]'));
  assert.ok(!html.includes('Free shipping')); assert.ok(!html.includes('5 days'));
  for (const text of ['Notebook', 'Travel Mug', 'Classic Mug', 'A5', 'Blue', 'Green', 'Rs475.00 PKR']) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('Cancel this store') < html.indexOf('Notebook'));
  assert.equal(JSON.stringify(value), before);
});

test('multiple sellers retain separate bordered summaries and the requested free/paid shipping wording', () => {
  const value = multi(), before = JSON.stringify(value), html = render(value);
  assert.equal((html.match(/data-seller-summary=/g) || []).length, 2);
  const a = summaryPart(html, 'seller-a'), b = summaryPart(html, 'seller-b');
  assert.ok(a.includes('5 days · Free'));
  assert.ok(b.includes('standard - 3 days · Rs300.00 PKR'));
  assert.ok(a.includes('Products')); assert.ok(b.includes('Products'));
  assert.ok(a.includes('<span>Total</span>')); assert.ok(b.includes('<span>Total</span>'));
  assert.ok(!html.includes('Seller total'));
  assert.ok(a.includes('Rs675.00 PKR')); assert.ok(!a.includes('Rs700.00 PKR'));
  assert.ok(b.includes('Rs700.00 PKR')); assert.ok(!b.includes('Rs675.00 PKR'));
  assert.equal((html.match(/border:1px solid var\(--glass-border\)/g) || []).length >= 2, true);
  assert.equal(JSON.stringify(value), before);
});

test('the separate shipping strip is removed rather than duplicated below the products', () => {
  const html = render(multi());
  assert.equal((html.match(/5 days · Free/g) || []).length, 1);
  assert.equal((html.match(/standard - 3 days · Rs300.00 PKR/g) || []).length, 1);
  assert.ok(!html.includes('Free shipping'));
  assert.ok(!source.includes('Shipping details unavailable for this legacy order'));
  assert.ok(!source.includes('sm:flex-row sm:items-center sm:justify-between gap-2'));
});

test('singular days, custom method names and absent legacy estimates remain truthful', () => {
  const value = multi(); value.sellerGroups[1].shippingMethod = { name: 'DHL Courier', price: 300, estimatedDays: 1 };
  assert.ok(render(value).includes('DHL Courier - 1 day · Rs300.00 PKR'));
  value.sellerGroups[1].shippingMethod.estimatedDays = null;
  const withoutDays = render(value); assert.ok(withoutDays.includes('DHL Courier · Rs300.00 PKR')); assert.ok(!withoutDays.includes('null day'));
  value.sellerGroups[1].shippingMethod = null;
  const missing = summaryPart(render(value), 'seller-b'); assert.ok(missing.includes('Rs300.00 PKR')); assert.ok(!missing.includes('standard'));
});

test('tax, discounts and adjustments are preserved and Total uses the unchanged stored amount', () => {
  const value = multi();
  Object.assign(value.sellerGroups[0].summary, { tax: 10, couponDiscount: 5, reconciliationAdjustment: 0.01, totalAmount: 680.01 });
  Object.assign(value.orderSummary, { tax: 10, couponDiscount: 5, reconciliationAdjustment: 0.01, totalAmount: 1380.01 });
  const html = render(value);
  for (const text of ['Tax', 'Discount', 'Rounding', 'Rs680.01 PKR', 'Rs0.01 PKR']) assert.ok(html.includes(text), text);
});

test('a cancelled second store still belongs to a multi-seller order; eligibility remains unchanged', () => {
  const value = multi(); value.sellerGroups[1].status = 'cancelled'; value.sellerGroups[1].canCancel = false;
  const html = render(value); assert.equal((html.match(/data-seller-summary=/g) || []).length, 2);
  const second = html.split('data-seller-id="seller-b"')[1];
  assert.ok(second.includes('This seller portion was cancelled')); assert.ok(!second.includes('Cancel this store'));
});

test('invalid stored totals still fail closed', () => {
  const value = multi(); value.sellerGroups[0].summary.totalAmount = 1;
  const html = render(value); assert.ok(html.includes('Seller breakdown could not be verified')); assert.ok(!html.includes('data-seller-summary='));
});

test('headings, status colours and progress rendering are untouched', () => {
  const hash = (start, end) => createHash('sha256').update(source.slice(source.indexOf(start), source.indexOf(end))).digest('hex');
  assert.equal(hash('const SellerProgress =', 'export const BuyerSellerStatusChips'), 'a49a0bd96ac88d0562399ee6a9f9c7250be11e8e09e9aaf0481f4e9a8a59285a');
  assert.equal(hash('const statusSteps =', 'const readGroups ='), 'a8b74e16497ce13f700c60202182e1c772b3d4607fe087cc516ce8f5b7721107');
  assert.ok(source.includes('>Seller shipments</h2>'));
  assert.ok(source.includes('Each store controls only its own status, shipping, and products.'));
});
