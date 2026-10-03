import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getSafetyRefundPresentation } from '../src/utils/safepaySafetyRefundPresentation.js';
const order = () => ({ paymentMethod: 'safepay', orderStatus: 'cancelled', awaitingPayment: true, currency: 'PKR',
  paymentResult: { failureCode: 'SAFEPAY_SAFETY_REFUND_PENDING' }, orderSummary: { totalAmount: 1000 },
  safepaySafetyRefund: { available: true, status: 'refunded', currency: 'PKR', capturedMinor: 100000, refundedMinor: 100000,
    capturedAt: '2026-10-03T06:58:25.000Z', refundedAt: '2026-10-03T06:58:27.000Z', destination: 'original_card' } });
test('a completed card refund is distinct from an unpaid order or Wallet credit', () => {
  const result = getSafetyRefundPresentation(order());
  assert.equal(result.label, 'Refunded'); assert.equal(result.refundedMinor, 100000);
  assert.match(result.message, /original card/);
  assert.equal(getSafetyRefundPresentation({ ...order(), paymentMethod: 'wallet' }), null);
});
test('pending refunds and missing or malformed evidence never claim completion', () => {
  const value = order(); value.safepaySafetyRefund.status = 'refund_pending'; value.safepaySafetyRefund.refundedMinor = 0; value.safepaySafetyRefund.refundedAt = null;
  assert.equal(getSafetyRefundPresentation(value).label, 'Refund pending');
  for (const changed of [{ capturedMinor: '100000' }, { currency: 'USD' }, { refundedMinor: 99999 }, { capturedAt: true }]) {
    const value = order(); Object.assign(value.safepaySafetyRefund, changed);
    assert.equal(getSafetyRefundPresentation(value).available, false);
  }
  assert.equal(getSafetyRefundPresentation({ ...order(), safepaySafetyRefund: undefined }).available, false);
});
test('buyer details skip inapplicable product-return calls for unfulfilled checkout and wire refund labels', () => {
  const source = readFileSync(new URL('../src/components/layout/UserOrderDetail.jsx', import.meta.url), 'utf8');
  assert.match(source, /order\.awaitingPayment !== true && <BuyerReturnsPanel/);
  assert.match(source, /getSafetyRefundPresentation\(order\)/);
  assert.match(source, /Confirmed refund/);
});
test('web and native use the same strict original-card presentation contract', () => {
  assert.equal(readFileSync(new URL('../src/utils/safepaySafetyRefundPresentation.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../MobileApp/src/utils/safepaySafetyRefundPresentation.js', import.meta.url), 'utf8'));
});
