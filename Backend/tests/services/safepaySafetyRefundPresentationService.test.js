const { buildSafetyRefundView, buyerOrderVisibilityFilter, isSafetyRefundCheckout } = require('../../services/safepaySafetyRefundPresentationService');
const fixture = () => {
  const order = { _id: '6ac0a2b387eee317754b0b53', user: '6ab6e12cba71edafe4fc6c5b',
    safepayPaymentId: '6ac0a2b487eee317754b0b5f', safepayEnvironment: 'sandbox', currency: 'PKR',
    paymentMethod: 'safepay', orderStatus: 'cancelled', awaitingPayment: true, isPaid: false,
    paymentResult: { failureCode: 'SAFEPAY_SAFETY_REFUND_PENDING' },
    orderItems: [{ productId: '6ab76c69f1585bb3833af7d9', price: 1000, quantity: 1, lineSubtotal: 1000 }],
    orderSummary: { subtotal: 1000, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 1000 } };
  const payment = { _id: order.safepayPaymentId, order: order._id, user: order.user, purpose: 'order', environment: 'sandbox',
    currency: 'PKR', amountMinor: 100000, capturedMinor: 100000, refundedMinor: 100000, appliedAt: null,
    paidAt: new Date('2026-10-03T06:58:25Z'), status: 'refunded', providerState: 'TRACKER_REFUNDED',
    safetyRefund: { requestedAt: new Date('2026-10-03T06:58:25Z'), outcome: 'confirmed' } };
  const events = [{ payment: payment._id, environment: 'sandbox', currency: 'PKR', cumulativeMinor: 100000,
    deltaMinor: 100000, occurredAt: new Date('2026-10-03T06:58:27Z') }];
  return { order, payment, events };
};
test('confirmed original-card refunds require exact owner-bound capture and refund evidence', () => {
  const { order, payment, events } = fixture();
  expect(buildSafetyRefundView(order, payment, events)).toMatchObject({ available: true, status: 'refunded', currency: 'PKR',
    capturedMinor: 100000, refundedMinor: 100000, destination: 'original_card' });
  expect(order.isPaid).toBe(false);
  expect(order.awaitingPayment).toBe(true);
});
test.each(['user', 'order', '_id', 'currency', 'environment', 'amountMinor', 'capturedMinor', 'refundedMinor'])('mismatched %s never produces a refund claim', field => {
  const { order, payment, events } = fixture();
  payment[field] = ['amountMinor', 'capturedMinor', 'refundedMinor'].includes(field) ? 99999 : 'mismatch';
  expect(buildSafetyRefundView(order, payment, events).available).toBe(false);
});
test('status words alone, duplicated proof and malformed primitives fail closed', () => {
  const { order, payment, events } = fixture();
  expect(buildSafetyRefundView(order, payment, []).available).toBe(false);
  expect(buildSafetyRefundView(order, payment, [...events, ...events]).available).toBe(false);
  for (const changed of [{ capturedMinor: '100000' }, { paidAt: true }, { appliedAt: new Date() }, { providerState: 'TRACKER_ENDED' }]) {
    expect(buildSafetyRefundView(order, { ...payment, ...changed }, events).available).toBe(false);
  }
});
test('a requested refund is not described as completed', () => {
  const { order, payment } = fixture();
  payment.refundedMinor = 0; payment.status = 'refund_pending'; payment.providerState = 'TRACKER_ENDED'; payment.safetyRefund.outcome = 'unknown';
  expect(buildSafetyRefundView(order, payment, [])).toMatchObject({ available: true, status: 'refund_pending', refundedMinor: 0, refundedAt: null });
});
test('buyer visibility adds only cancelled safety-refund checkouts, not ordinary abandoned payments', () => {
  const { order } = fixture();
  expect(isSafetyRefundCheckout(order)).toBe(true);
  expect(isSafetyRefundCheckout({ ...order, orderStatus: 'pending' })).toBe(false);
  expect(isSafetyRefundCheckout({ ...order, paymentResult: { failureCode: 'PAYMENT_CANCELLED' } })).toBe(false);
  expect(buyerOrderVisibilityFilter()).toEqual({ $or: [{ awaitingPayment: { $ne: true } },
    { paymentMethod: 'safepay', orderStatus: 'cancelled', awaitingPayment: true, 'paymentResult.failureCode': 'SAFEPAY_SAFETY_REFUND_PENDING' }] });
});
