import { cancellationRefundPresentation, hasPendingCancellationRefund, startCancellationRefundRefresh } from '../../src/utils/orderCancellationPresentation';
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
