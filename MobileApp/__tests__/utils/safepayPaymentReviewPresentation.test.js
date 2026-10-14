import { getPaymentReviewPresentation } from '../../src/utils/safepayPaymentReviewPresentation';
import { normalizeSafepayStatus } from '../../src/utils/safepayCheckout';
const order = { _id: '64b000000000000000000004', currency: 'PKR', safepayPaymentReview: { version: 1,
  orderId: '64b000000000000000000004', currency: 'PKR', status: 'lost', lostMinor: 101, authority: 'admin_reviewed_provider_evidence' } };
test('native review status distinguishes pending, won, lost and corrupt money', () => {
  expect(getPaymentReviewPresentation(order).label).toBe('Payment reversed');
  expect(getPaymentReviewPresentation({ ...order, safepayPaymentReview: { ...order.safepayPaymentReview, status: 'won' } }).label).toBe('Payment confirmed');
  expect(getPaymentReviewPresentation({ ...order, safepayPaymentReview: { ...order.safepayPaymentReview, status: 'pending', fundingSource: 'card_funded_wallet' } }).message).toContain('Wallet purchase');
  expect(getPaymentReviewPresentation({ ...order, safepayPaymentReview: { ...order.safepayPaymentReview, lostMinor: '101' } }).status).toBe('unavailable');
});
test('native status polling never offers a new or resumed payment for a recorded reversal', () => {
  const payment = { paymentMethod: 'safepay', paymentFlow: 'safepay_hosted', paymentId: '64b000000000000000000002',
    purpose: 'order', environment: 'sandbox', currency: 'PKR', amountMinor: 100000, status: 'reversed', capturedMinor: 100000, paymentRail: 'card' };
  expect(normalizeSafepayStatus(payment, payment.paymentId).status).toBe('reversed');
  expect(normalizeSafepayStatus(payment, payment.paymentId).isPaid).toBe(false);
});
