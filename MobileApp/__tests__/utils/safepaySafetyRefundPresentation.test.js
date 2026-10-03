import { readFileSync } from 'fs';
import { getSafetyRefundPresentation } from '../../src/utils/safepaySafetyRefundPresentation';
const order = () => ({ paymentMethod: 'safepay', orderStatus: 'cancelled', awaitingPayment: true, currency: 'PKR',
  paymentResult: { failureCode: 'SAFEPAY_SAFETY_REFUND_PENDING' }, orderSummary: { totalAmount: 1000 },
  safepaySafetyRefund: { available: true, status: 'refunded', currency: 'PKR', capturedMinor: 100000, refundedMinor: 100000,
    capturedAt: '2026-10-03T06:58:25.000Z', refundedAt: '2026-10-03T06:58:27.000Z', destination: 'original_card' } });
test('native refunds remain in frozen order currency and identify the original card', () => {
  expect(getSafetyRefundPresentation(order())).toMatchObject({ label: 'Refunded', currency: 'PKR', refundedMinor: 100000 });
  expect(getSafetyRefundPresentation(order()).message).toContain('original card');
});
test('native pending and malformed refund evidence cannot invent success', () => {
  const value = order(); value.safepaySafetyRefund.status = 'refund_pending'; value.safepaySafetyRefund.refundedMinor = 0; value.safepaySafetyRefund.refundedAt = null;
  expect(getSafetyRefundPresentation(value).label).toBe('Refund pending');
  const invalid = order(); invalid.safepaySafetyRefund.currency = 'USD';
  expect(getSafetyRefundPresentation(invalid).available).toBe(false);
  expect(getSafetyRefundPresentation({ ...order(), safepaySafetyRefund: undefined }).available).toBe(false);
});
test('native buyer detail/card wire refund presentation without fetching inapplicable returns', () => {
  const detail = readFileSync(require.resolve('../../src/screens/OrderDetailScreen.js'), 'utf8');
  const card = readFileSync(require.resolve('../../src/components/common/OrderCard.js'), 'utf8');
  expect(detail).toMatch(/order\.awaitingPayment !== true && <BuyerReturnsSection/);
  expect(detail).toContain('Confirmed refund:');
  expect(card).toContain('sellerView ? null : getSafetyRefundPresentation(order)');
});
