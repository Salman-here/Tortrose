import { cancellationRefundPresentation, cancellationSuccessCopy, hasPendingCancellationRefund, startCancellationRefundRefresh } from '../../src/utils/orderCancellationPresentation';

test('a store-only cancellation does not claim the whole purchase was cancelled', () => {
  expect(cancellationSuccessCopy('seller-a')).toEqual({
    title: 'Store items cancelled', message: 'Only this store’s unshipped items were cancelled. Other store shipments are unchanged.',
  });
  expect(cancellationSuccessCopy().title).toBe('Order cancelled');
});
test('card/Wallet cancellation refunds use verified original-currency minor units', () => {
  const row = { reference: 'cancel-1', refundStatus: 'refunded', destination: 'wallet', currency: 'USD', amountMinor: 1200 };
  expect(cancellationRefundPresentation(row, 'USD', 12)).toMatchObject({ valid: true, amount: 12, destination: 'Rozare Wallet', label: 'Refund completed' });
  expect(cancellationRefundPresentation({ ...row, amountMinor: '1200' }, 'USD', 12).valid).toBe(false);
  expect(cancellationRefundPresentation({ ...row, currency: 'PKR' }, 'USD', 12).valid).toBe(false);
});

test('polling only follows unresolved cancellation references', () => {
  expect(hasPendingCancellationRefund({ sellerGroups: [{ cancellation: { reference: 'c', refundStatus: 'pending' } }] })).toBe(true);
  for (const refundStatus of ['refunded', 'manual_review', 'not_required']) {
    expect(hasPendingCancellationRefund({ sellerFulfillment: [{ cancellation: { reference: 'c', refundStatus } }] })).toBe(false);
  }
});

test('native Raast cancellation history retains a support-review refund instead of claiming a card refund', () => {
  const result = cancellationRefundPresentation({ reference: 'cancel-1', refundStatus: 'manual_review', destination: 'original_card', currency: 'PKR', amountMinor: 125000, paymentRail: 'raast' }, 'PKR', 1250);
  expect(result.destination).toBe('original raast payment');
  expect(result.message).toContain('no bank refund has been confirmed');
});

test('quiet refresh is single-flight and stops cleanly', async () => {
  const queue = new Map(); let n = 0, active = false, resolve;
  const timers = { setTimeout(fn) { queue.set(++n, fn); return n; }, clearTimeout(key) { queue.delete(key); } };
  const request = jest.fn(() => new Promise(done => { resolve = done; }));
  const fire = () => { const [key, fn] = queue.entries().next().value; queue.delete(key); return fn(); };
  const stop = startCancellationRefundRefresh(request, () => active, 5000, timers);
  await fire(); expect(request).not.toHaveBeenCalled();
  active = true; const inFlight = fire(); expect(request).toHaveBeenCalledTimes(1); expect(queue.size).toBe(0);
  stop(); resolve(); await inFlight; expect(queue.size).toBe(0);
});

test('native older cancellation rail uses its same order evidence without changing the historical allocation', () => {
  const row = { reference: 'cancel-legacy', refundStatus: 'pending', destination: 'original_card', currency: 'PKR',
    paymentRail: 'unknown', policyVersion: 1, amountMinor: 6380, grossAmountMinor: 10000, deductionMinor: 3620 };
  const original = JSON.stringify(row);
  const result = cancellationRefundPresentation(row, 'PKR', 100, { currency: 'PKR', safepayPaymentRail: 'raast' });
  expect(result).toMatchObject({ valid: true, paymentRail: 'raast', destination: 'original raast payment', amount: 63.8, deduction: 36.2 });
  expect(result.message).toContain('no bank refund has been confirmed');
  expect(JSON.stringify(row)).toBe(original);
  expect(cancellationRefundPresentation({ ...row, paymentRail: 'card' }, 'PKR', 100, { currency: 'PKR', safepayPaymentRail: 'raast' }).valid).toBe(false);
});
