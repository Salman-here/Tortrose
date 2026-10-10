import { getOrderPaymentLabel, getOriginalPaymentRefundCopy, getSafepayCheckoutLabel } from '../../src/utils/paymentPresentation';

test('native preserves provider/rail distinction and PKR-only Raast eligibility', () => {
  const order = { paymentMethod: 'safepay', currency: 'PKR' };
  expect(getOrderPaymentLabel(order)).toBe('Safepay');
  expect(getOrderPaymentLabel({ ...order, safepayPaymentRail: 'card' })).toBe('Card (Safepay)');
  expect(getOrderPaymentLabel({ ...order, safepayPaymentRail: 'raast' })).toBe('Raast (Safepay)');
  expect(getOrderPaymentLabel({ ...order, safepayPaymentRail: 'raast', currency: 'USD' })).toBe('Safepay');
  expect(getSafepayCheckoutLabel('PKR')).toContain('Raast');
  expect(getSafepayCheckoutLabel('USD')).not.toContain('Raast');
});

test('native pending Raast refunds require review without inventing an original-card refund', () => {
  const copy = getOriginalPaymentRefundCopy({ paymentRail: 'raast', currency: 'PKR' }, 'manual_review');
  expect(copy).toContain('support review');
  expect(copy).toContain('no bank refund has been confirmed');
  expect(copy).not.toContain('original card');
});
