import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOrderCompletionCheck, formatOrderReceiptTotal, isOrderCompletionReference, orderCompletionPresentation, orderCompletionReadError, validateOrderCompletion } from '../src/utils/orderCompletion.js';

const buyerId = '6aca1a620597224ffad3fc30';
const mongoOrderId = '6aca1a620597224ffad3fc33';
const orderId = 'ORD-1791642301045';
const context = { reference: orderId, buyerId };
const fixture = overrides => ({ version: 1, buyerId, mongoOrderId, orderId, paymentMethod: 'cash_on_delivery', paymentRail: 'unknown',
  currency: 'PKR', totalMinor: 10000, placedAt: '2026-10-10T10:30:00.000Z', orderStatus: 'pending', paymentStatus: 'unpaid',
  orderPlaced: true, isPaid: false, confirmationRequired: true, noPaymentRequired: false, hasCancelledItems: false, reviewReason: '', ...overrides });
const online = overrides => fixture({ paymentMethod: 'wallet', orderStatus: 'confirmed', paymentStatus: 'paid', isPaid: true, confirmationRequired: false, ...overrides });
const check = (receipt, expected = context) => validateOrderCompletion(receipt, expected);
const pending = overrides => online({ paymentStatus: 'pending', orderPlaced: false, isPaid: false, ...overrides });

test('COD is placed without claiming online payment, and confirmation guidance follows server state', () => {
  const receipt = check(fixture());
  assert.equal(orderCompletionPresentation(receipt).title, 'Thank you for your order!');
  assert.match(orderCompletionPresentation(receipt).message, /Confirm it.*WhatsApp or email/);
  const delivered = check(fixture({ orderStatus: 'delivered', confirmationRequired: false }));
  assert.match(orderCompletionPresentation(delivered).message, /was delivered/);
  assert.doesNotMatch(orderCompletionPresentation(delivered).message, /payment is complete|pay when/i);
});
for (const [method, rail, label] of [['wallet', 'unknown', 'Rozare Wallet'], ['safepay', 'card', 'card'], ['safepay', 'raast', 'Raast'], ['safepay', 'unknown', 'Safepay']]) {
  test(`verified ${method}/${rail} gets the common thank-you with accurate wording`, () => {
    const receipt = check(online({ paymentMethod: method, paymentRail: rail }));
    const view = orderCompletionPresentation(receipt);
    assert.equal(view.title, 'Thank you for your order!'); assert.ok(view.message.includes(label));
    assert.equal(view.detailsHref, `/user-dashboard/order/detail/${mongoOrderId}`);
  });
}
for (const method of ['wallet', 'safepay', 'stripe']) test(`completed zero-total ${method} does not claim a card or Wallet charge`, () => {
  const receipt = check(online({ paymentMethod: method, totalMinor: 0, noPaymentRequired: true, paymentStatus: 'not_required' }));
  assert.match(orderCompletionPresentation(receipt).message, /no payment was required/);
});
test('zero COD remains an unpaid placed order, with confirmation required', () => {
  const receipt = check(fixture({ totalMinor: 0 }));
  assert.equal(receipt.noPaymentRequired, false); assert.equal(receipt.isPaid, false);
  assert.match(orderCompletionPresentation(receipt).message, /Confirm it/);
});
test('cancelled lifecycle wins over partial net refunds without claiming remaining items or bank delivery', () => {
  const receipt = check(online({ orderStatus: 'cancelled', paymentStatus: 'partially_refunded', orderPlaced: false, isPaid: false, hasCancelledItems: true }));
  const view = orderCompletionPresentation(receipt);
  assert.equal(view.title, 'Order cancelled'); assert.equal(view.originalTotal, true);
  assert.doesNotMatch(view.message, /to your card|remaining items|Thank you/);
});
for (const status of ['pending', 'review_required', 'refunded', 'partially_refunded', 'cancelled']) test(`${status} evidence cannot show a fresh green success`, () => {
  const receipt = check(pending({ paymentStatus: status }));
  assert.notEqual(orderCompletionPresentation(receipt).tone, 'success');
});
test('partially cancelled paid order has neutral updated information', () => {
  const receipt = check(online({ hasCancelledItems: true }));
  const view = orderCompletionPresentation(receipt);
  assert.equal(view.title, 'Your order was updated'); assert.equal(view.originalTotal, true); assert.notEqual(view.tone, 'success');
});
test('public/Mongo reference and purchaser are bound; URL payment flags supply no authority', () => {
  assert.equal(check(online(), { reference: mongoOrderId.toUpperCase(), buyerId }).mongoOrderId, mongoOrderId);
  assert.equal(check(fixture(), { ...context, payment: 'safepay', noPaymentRequired: true }).isPaid, false);
  for (const expected of [{ ...context, reference: 'ORD-1791642301046' }, { ...context, buyerId: '6aca1a620597224ffad3fc31' }]) {
    assert.throws(() => check(online(), expected), { code: 'ORDER_RECEIPT_INVALID' });
  }
  assert.throws(() => check(online({ mongoOrderId: '6aca1a620597224ffad3fc34' }), { reference: mongoOrderId, buyerId }), { code: 'ORDER_RECEIPT_INVALID' });
  assert.throws(() => check({ payment: 'wallet', orderId, paid: true }), { code: 'ORDER_RECEIPT_INVALID' });
});
for (const [field, values] of Object.entries({
  version: [0, 2, '1'], buyerId: ['6aca1a620597224ffad3fc31', null], mongoOrderId: ['other', null],
  orderId: ['ORD-1791642301046', null], currency: ['CAD', null], totalMinor: ['10000', -1, 100.2, Infinity, Number.MAX_SAFE_INTEGER + 1],
  placedAt: [true, null, 'wrong'], paymentRail: ['other', 'raast'], paymentMethod: ['other', null], orderStatus: ['packing', null],
  paymentStatus: ['completed', null], orderPlaced: [1, 'true'], isPaid: ['false', null], confirmationRequired: ['false', null],
  noPaymentRequired: [true, 'false'], hasCancelledItems: [1, undefined], reviewReason: [null, 'x'.repeat(501)],
})) test(`malformed ${field} fails closed`, () => {
  for (const value of values) assert.throws(() => check(online({ [field]: value })), { code: 'ORDER_RECEIPT_INVALID' });
});
test('contradictory success, zero, lifecycle and currency flags cannot manufacture payment', () => {
  for (const override of [{ paymentStatus: 'paid', isPaid: false }, { orderPlaced: false }, { orderStatus: 'cancelled' },
    { confirmationRequired: true }, { paymentStatus: 'review_required' }, { paymentStatus: 'not_required' },
    { totalMinor: 0, noPaymentRequired: false, paymentStatus: 'paid' },
    { paymentMethod: 'safepay', paymentRail: 'raast', currency: 'USD' }]) assert.throws(() => check(online(override)), { code: 'ORDER_RECEIPT_INVALID' });
});
test('receipt amounts retain exact cents even at the safe integer boundary', () => {
  assert.equal(formatOrderReceiptTotal({ currency: 'USD', totalMinor: 10001 }), '$100.01');
  assert.equal(formatOrderReceiptTotal({ currency: 'USD', totalMinor: Number.MAX_SAFE_INTEGER }), '$90,071,992,547,409.91');
  assert.match(formatOrderReceiptTotal({ currency: 'EUR', totalMinor: 386 }), /3\.86/);
});
test('Back/refresh requires fresh GET evidence and does not depend on browser receipt storage', async () => {
  const oldStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem() { throw Error('Storage denied'); }, removeItem() { throw Error('Storage denied'); } };
  try {
    let reads = 0;
    for (let visit = 0; visit < 3; visit += 1) {
      const states = [];
      const request = createOrderCompletionCheck({ ...context, read: async () => { reads += 1; return fixture(); }, publish: value => states.push(value) });
      await request.run(); request.stop();
      assert.equal(states.at(-1).status, 'ready'); assert.equal(states.at(-1).receipt.orderPlaced, true);
    }
    assert.equal(reads, 3);
  } finally { if (oldStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = oldStorage; }
});
test('late old-owner/order responses cannot replace the new receipt', async () => {
  let resolveOld; const states = [];
  const first = createOrderCompletionCheck({ ...context, read: () => new Promise(resolve => { resolveOld = resolve; }), publish: value => states.push(value) });
  const old = first.run(); first.stop();
  const nextBuyer = '6aca1a620597224ffad3fc31', nextOrder = 'ORD-1791642301046';
  const second = createOrderCompletionCheck({ reference: nextOrder, buyerId: nextBuyer,
    read: async () => online({ buyerId: nextBuyer, orderId: nextOrder }), publish: value => states.push(value) });
  await second.run(); resolveOld(fixture()); await old;
  assert.equal(states.at(-1).receipt.buyerId, nextBuyer); assert.equal(states.at(-1).receipt.orderId, nextOrder);
});
test('superseded retries in the same controller cannot publish stale results', async () => {
  let firstResolve; let count = 0; const states = [];
  const request = createOrderCompletionCheck({ ...context,
    read: () => ++count === 1 ? new Promise(resolve => { firstResolve = resolve; }) : Promise.resolve(fixture()), publish: state => states.push(state) });
  const first = request.run(); await request.run();
  firstResolve(online({ paymentMethod: 'safepay', paymentRail: 'card' })); await first;
  assert.equal(states.at(-1).receipt.paymentMethod, 'cash_on_delivery');
});
test('unauthenticated/invalid reference reads never contact the endpoint', async () => {
  for (const invalidContext of [{ ...context, buyerId: '' }, { ...context, reference: 'https://evil.example' }]) {
    let calls = 0; const states = [];
    await createOrderCompletionCheck({ ...invalidContext, read: async () => { calls += 1; }, publish: state => states.push(state) }).run();
    assert.equal(calls, 0); assert.equal(states.at(-1).receipt, null);
  }
  assert.equal(isOrderCompletionReference(orderId), true); assert.equal(isOrderCompletionReference(''), false);
});
test('network and account errors are not described as COD payment failures', async () => {
  for (const error of [{ code: 'ECONNABORTED' }, { response: { status: 404 } }, { response: { status: 401 } }]) {
    const view = orderCompletionReadError(error);
    assert.doesNotMatch(view.message, /payment failed|payment not confirmed/i);
    assert.equal(view.status, error.response?.status === 401 ? 'signin' : 'unavailable');
  }
});
test('Success is owner scoped, abortable and entirely read-only, including BFCache returns', () => {
  const source = readFileSync(new URL('../src/components/layout/Success.jsx', import.meta.url), 'utf8');
  assert.match(source, /verification\.scope === scope/); assert.match(source, /check\.stop\(\); abort\.abort\(\)/);
  assert.match(source, /const scope = `\$\{buyerId\}:\$\{reference\}:\$\{retry\}`/);
  assert.match(source, /scope: requestScope/);
  assert.match(source, /pageshow/); assert.match(source, /event\.persisted/); assert.match(source, /setVerification\(\{ scope: ''/);
  assert.match(source, /axios\.get/); assert.match(source, /Authorization: `Bearer/);
  assert.match(source, /shrink-0 text-xs font-semibold text-primary underline[\s\S]*?>View Order<\/Link>/);
  assert.doesNotMatch(source, /sessionStorage|localStorage|removeItem|fetchCart|clearPersisted|axios\.(post|patch|delete)/);
});
