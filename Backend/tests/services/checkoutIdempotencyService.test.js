const { checkoutRequestFingerprint } = require('../../services/checkoutIdempotencyService');

const order = {
  currency: 'PKR',
  paymentMethod: 'stripe',
  orderItems: [
    { id: 'product-b', quantity: 2, selectedOptions: { size: 'L', finish: 'matte' } },
    { id: 'product-a', quantity: 1 },
  ],
  shippingInfo: { fullName: 'Buyer', city: 'Lahore', address: '1 Test Road' },
  shippingMethod: { name: 'standard', estimatedDays: 4 },
  sellerShipping: [{ seller: 'seller-1', shippingMethod: { name: 'standard' } }],
  appliedCoupons: [{ couponId: 'coupon-1', code: 'save10' }],
};

describe('checkout request fingerprint', () => {
  test('is stable for equivalent object key and item order', () => {
    const reordered = {
      ...order,
      shippingInfo: { address: '1 Test Road', city: 'Lahore', fullName: 'Buyer' },
      orderItems: [...order.orderItems].reverse(),
    };
    expect(checkoutRequestFingerprint(order, 'payment_sheet', 'mobile'))
      .toBe(checkoutRequestFingerprint(reordered, 'payment_sheet', 'mobile'));
  });

  test.each([
    [{ ...order, orderItems: [{ id: 'product-a', quantity: 3 }] }],
    [{ ...order, shippingInfo: { ...order.shippingInfo, city: 'Karachi' } }],
    [{ ...order, appliedCoupons: [] }],
  ])('changes when an authoritative checkout input changes', (changed) => {
    expect(checkoutRequestFingerprint(order, 'payment_sheet', 'mobile'))
      .not.toBe(checkoutRequestFingerprint(changed, 'payment_sheet', 'mobile'));
  });
});
