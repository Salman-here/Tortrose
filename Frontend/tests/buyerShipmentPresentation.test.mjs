import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBuyerDeliveryHeading, getBuyerShippingPresentation, getShipmentItemLabel } from '../src/utils/buyerShipmentPresentation.js';

const source = readFileSync(new URL('../src/components/order/BuyerSellerFulfillmentGroups.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const compiled = buildSync({ entryPoints: [root + 'src/components/order/BuyerSellerFulfillmentGroups.jsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(new URL('../package.json', import.meta.url)), mod, mod.exports);
const Component = mod.exports.default;
const money = amount => `PKR ${amount.toFixed(2)}`;

const order = () => ({ currency: 'PKR', sellerGroupingAvailable: true, buyerPresentationVersion: 1,
  orderItems: [{ name: 'Travel Mug', productId: 'product-a', seller: 'seller-a', image: '', quantity: 2, price: 100, lineSubtotal: 200, selectedOptions: { Color: 'Red', Size: 'Large' } }],
  orderSummary: { subtotal: 200, shippingCost: 0, tax: 10, couponDiscount: 5, reconciliationAdjustment: 0, totalAmount: 205 },
  sellerGroups: [{ sellerId: 'seller-a', storeName: 'QA Store', itemIndexes: [0], itemCount: 1, units: 2, status: 'confirmed', canCancel: true,
    shippingMethod: { name: 'free', price: 0, estimatedDays: 5 }, summary: { subtotal: 200, shippingCost: 0, tax: 10, couponDiscount: 5, reconciliationAdjustment: 0, totalAmount: 205 } }],
});
const render = (value, onCancel = () => {}) => renderToStaticMarkup(React.createElement(Component, { order: value, formatMoney: money, onCancel }));

test('buyer heading and item counts use concise single/multi-store wording', () => {
  assert.equal(getBuyerDeliveryHeading(1).title, 'Delivery details');
  assert.deepEqual(getBuyerDeliveryHeading(3), { title: 'Store deliveries', subtitle: 'Your order includes 3 stores. Track each delivery below.' });
  assert.equal(getShipmentItemLabel(1, 1), '1 item');
  assert.equal(getShipmentItemLabel(1, 3), '1 item · 3 units');
  assert.equal(getShipmentItemLabel(2, 2), '2 items');
  assert.equal(getShipmentItemLabel(2, 5), '2 items · 5 units');
});

test('shipping labels are display-only, preserve custom names and never invent free shipping or dates', () => {
  for (const [name, price, expected] of [['free', 0, 'Free shipping'], [' FREE ', 0, 'Free shipping'], ['free', 4, 'Delivery'],
    ['standard', 4, 'Standard delivery'], ['fast', 4, 'Express delivery'], ['DHL Courier', 4, 'DHL Courier'], ['__proto__', 0, '__proto__'], ['constructor', 0, 'constructor']]) {
    const input = Object.freeze({ name, price, estimatedDays: 1 });
    assert.deepEqual(getBuyerShippingPresentation(input), { name: expected, estimate: 'Estimated delivery: 1 day' });
    assert.equal(input.price, price);
  }
  assert.equal(getBuyerShippingPresentation({ name: 'standard', price: 4, estimatedDays: 5 }).estimate, 'Estimated delivery: 5 days');
  for (const days of [0, null, undefined, '5', NaN, Infinity, -1]) assert.equal(getBuyerShippingPresentation({ name: 'standard', price: 4, estimatedDays: days }).estimate, 'Delivery estimate not available');
  assert.deepEqual(getBuyerShippingPresentation(null), { name: 'Delivery details unavailable', estimate: null });
});

test('web and mobile use the identical copy helper', () => {
  assert.equal(readFileSync(new URL('../src/utils/buyerShipmentPresentation.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/buyerShipmentPresentation.js', import.meta.url), 'utf8'));
});

test('actual delivery component keeps all stored amounts/options and places cancellation after the total', () => {
  const value = order(), before = JSON.stringify(value), html = render(value);
  for (const text of ['Delivery details', 'Store total', 'Subtotal', 'Shipping', 'Tax', 'Discount', 'Free shipping', 'Estimated delivery: 5 days',
    'Color', 'Red', 'Size', 'Large', 'Item total', 'Qty 2', 'PKR 200.00', 'PKR 205.00', 'PKR 10.00', 'PKR 5.00']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('Seller total')); assert.ok(!html.includes('product line')); assert.ok(!html.includes('legacy order'));
  assert.ok(html.indexOf('Store total') < html.indexOf('Cancel this store'));
  assert.ok(html.includes('aria-label="Cancel QA Store items"'));
  assert.equal(JSON.stringify(value), before);
});

test('cancellation remains exact server eligibility and disappears when absent or unavailable', () => {
  const value = order(); value.sellerGroups[0].canCancel = false;
  assert.ok(!render(value).includes('Cancel this store'));
  value.sellerGroups[0].canCancel = 'true'; assert.ok(!render(value).includes('Cancel this store'));
  value.sellerGroups[0].canCancel = true; assert.ok(!render(value, null).includes('Cancel this store'));
});

test('two-store rendering keeps each store total, delivery method and cancellation action isolated', () => {
  const value = order();
  value.orderItems.push({ name: 'Desk Organizer', productId: 'product-b', seller: 'seller-b', quantity: 1, price: 50, lineSubtotal: 50 });
  value.sellerGroups.push({ sellerId: 'seller-b', storeName: 'Second Store', itemIndexes: [1], itemCount: 1, units: 1, status: 'shipped', canCancel: false,
    shippingMethod: { name: 'standard', price: 20, estimatedDays: 2 }, summary: { subtotal: 50, shippingCost: 20, tax: 0, couponDiscount: 0, reconciliationAdjustment: 0, totalAmount: 70 } });
  value.orderSummary = { subtotal: 250, shippingCost: 20, tax: 10, couponDiscount: 5, reconciliationAdjustment: 0, totalAmount: 275 };
  const html = render(value), first = html.split('data-seller-id="seller-a"')[1].split('</section>')[0], second = html.split('data-seller-id="seller-b"')[1].split('</section>')[0];
  assert.ok(html.includes('Your order includes 2 stores. Track each delivery below.'));
  assert.ok(first.includes('PKR 205.00')); assert.ok(!first.includes('PKR 70.00')); assert.ok(first.includes('Free shipping'));
  assert.ok(second.includes('PKR 70.00')); assert.ok(!second.includes('PKR 205.00')); assert.ok(second.includes('Standard delivery'));
  assert.ok(first.includes('Cancel QA Store items')); assert.ok(!second.includes('Cancel this store'));
});

test('rounding adjustments are still displayed rather than hidden or recalculated', () => {
  const value = order(); value.orderSummary.reconciliationAdjustment = 0.01; value.orderSummary.totalAmount = 205.01;
  value.sellerGroups[0].summary.reconciliationAdjustment = 0.01; value.sellerGroups[0].summary.totalAmount = 205.01;
  const html = render(value); assert.ok(html.includes('Rounding')); assert.ok(html.includes('PKR 0.01')); assert.ok(html.includes('PKR 205.01'));
});

test('invalid monetary presentation still fails closed instead of rendering misleading totals', () => {
  const value = order(); value.sellerGroups[0].summary.totalAmount = 999;
  const html = render(value);
  assert.ok(html.includes('Seller breakdown could not be verified')); assert.ok(!html.includes('PKR 999.00')); assert.ok(!html.includes('Cancel this store'));
});

test('progress rendering and status colours remain byte-for-byte unchanged as requested', () => {
  const hash = (start, end) => createHash('sha256').update(source.slice(source.indexOf(start), source.indexOf(end))).digest('hex');
  assert.equal(hash('const SellerProgress =', 'export const BuyerSellerStatusChips'), 'a49a0bd96ac88d0562399ee6a9f9c7250be11e8e09e9aaf0481f4e9a8a59285a');
  assert.equal(hash('const statusSteps =', 'const readGroups ='), 'a8b74e16497ce13f700c60202182e1c772b3d4607fe087cc516ce8f5b7721107');
});
