import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellationRefundPresentation } from '../src/utils/orderCancellationPresentation.js';
test('cancellation refund destinations and states stay bound to original checkout money', () => {
  const row = { reference: 'cancel-1', refundStatus: 'refunded', destination: 'original_card', currency: 'PKR', amountMinor: 125000 };
  assert.equal(cancellationRefundPresentation(row, 'PKR', 1250).amount, 1250);
  assert.equal(cancellationRefundPresentation(row, 'PKR', 1250).label, 'Refund completed');
  assert.equal(cancellationRefundPresentation({ ...row, currency: 'USD' }, 'PKR', 1250).valid, false);
  assert.equal(cancellationRefundPresentation({ ...row, amountMinor: 125001 }, 'PKR', 1250).valid, false);
  assert.equal(cancellationRefundPresentation({ ...row, refundStatus: 'processing' }, 'PKR', 1250).label, 'Refund in progress');
  assert.equal(cancellationRefundPresentation(null, 'PKR', 1250), null);
});
