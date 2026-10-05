import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellationRefundPresentation, hasPendingCancellationRefund, startCancellationRefundRefresh } from '../src/utils/orderCancellationPresentation.js';
test('cancellation refund destinations and states stay bound to original checkout money', () => {
  const row = { reference: 'cancel-1', refundStatus: 'refunded', destination: 'original_card', currency: 'PKR', amountMinor: 125000 };
  assert.equal(cancellationRefundPresentation(row, 'PKR', 1250).amount, 1250);
  assert.equal(cancellationRefundPresentation(row, 'PKR', 1250).label, 'Refund completed');
  assert.equal(cancellationRefundPresentation({ ...row, currency: 'USD' }, 'PKR', 1250).valid, false);
  assert.equal(cancellationRefundPresentation({ ...row, amountMinor: 125001 }, 'PKR', 1250).valid, false);
  assert.equal(cancellationRefundPresentation({ ...row, refundStatus: 'processing' }, 'PKR', 1250).label, 'Refund in progress');
  assert.equal(cancellationRefundPresentation(null, 'PKR', 1250), null);
});

test('only unresolved original cancellation references need an automatic refresh', () => {
  for (const field of ['sellerFulfillment', 'sellerGroups']) {
    const order = status => ({ [field]: [{ cancellation: { reference: 'c1', refundStatus: status } }] });
    assert.equal(hasPendingCancellationRefund(order('pending')), true);
    assert.equal(hasPendingCancellationRefund(order('processing')), true);
    for (const state of ['refunded', 'manual_review', 'not_required']) assert.equal(hasPendingCancellationRefund(order(state)), false);
  }
  assert.equal(hasPendingCancellationRefund({ sellerGroups: [{ cancellation: { refundStatus: 'pending' } }] }), false);
});

test('refund refresh is single-flight, skips inactive screens and cannot reschedule after stop', async () => {
  const queue = new Map(); let n = 0, calls = 0, active = false, resolve;
  const timers = { setTimeout(fn) { queue.set(++n, fn); return n; }, clearTimeout(key) { queue.delete(key); } };
  const fire = async () => { const [key, fn] = queue.entries().next().value; queue.delete(key); return fn(); };
  const stop = startCancellationRefundRefresh(() => { calls++; return new Promise(done => { resolve = done; }); }, () => active, 5000, timers);
  await fire(); assert.equal(calls, 0); assert.equal(queue.size, 1);
  active = true; const inFlight = fire(); assert.equal(calls, 1); assert.equal(queue.size, 0);
  stop(); resolve(); await inFlight; assert.equal(queue.size, 0);
});
