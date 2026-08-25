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
  appliedCoupons: [{ couponId: 'coupon-1', code: 'save10', applicableProductIds: ['product-b', 'product-a'] }],
  buyerLocation: { country: 'Pakistan', city: 'Lahore' },
  instructions: 'Leave at reception',
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
    [{ ...order, appliedCoupons: [{ ...order.appliedCoupons[0], applicableProductIds: ['product-a'] }] }],
    [{ ...order, buyerLocation: { ...order.buyerLocation, city: 'Karachi' } }],
    [{ ...order, instructions: 'Call on arrival' }],
  ])('changes when an authoritative checkout input changes', (changed) => {
    expect(checkoutRequestFingerprint(order, 'payment_sheet', 'mobile'))
      .not.toBe(checkoutRequestFingerprint(changed, 'payment_sheet', 'mobile'));
  });

  test('normalizes coupon scope order because product scope is a set', () => {
    const reorderedScope = {
      ...order,
      appliedCoupons: [{
        ...order.appliedCoupons[0],
        applicableProductIds: [...order.appliedCoupons[0].applicableProductIds].reverse(),
      }],
    };

    expect(checkoutRequestFingerprint(order, 'payment_sheet', 'mobile'))
      .toBe(checkoutRequestFingerprint(reorderedScope, 'payment_sheet', 'mobile'));
  });

  test('normalizes shipping email case and whitespace like guest identity scope', () => {
    const first = {
      ...order,
      shippingInfo: { ...order.shippingInfo, email: ' First.Guest@Example.com ' },
    };
    const retry = {
      ...order,
      shippingInfo: { ...order.shippingInfo, email: 'first.guest@example.com' },
    };

    expect(checkoutRequestFingerprint(first, 'checkout_session', 'web'))
      .toBe(checkoutRequestFingerprint(retry, 'checkout_session', 'web'));
  });

  test('normalizes equivalent domestic and E.164 phone spellings for safe checkout retries', () => {
    const first = {
      ...order,
      shippingInfo: {
        ...order.shippingInfo,
        phone: '0300 1234567',
        country: 'Pakistan',
        countryCode: 'PK',
      },
    };
    const retry = {
      ...order,
      shippingInfo: {
        ...order.shippingInfo,
        phone: '+92 (300) 123-4567',
        country: 'Pakistan',
        countryCode: 'PK',
      },
    };

    expect(checkoutRequestFingerprint(first, 'checkout_session', 'web'))
      .toBe(checkoutRequestFingerprint(retry, 'checkout_session', 'web'));
  });

  test('does not throw before checkout validation on malformed collection fields', () => {
    expect(() => checkoutRequestFingerprint({
      ...order,
      orderItems: {},
      appliedCoupons: [{ ...order.appliedCoupons[0], applicableProductIds: 'product-a' }],
      sellerShipping: {},
    }, 'payment_sheet', 'mobile')).not.toThrow();
  });

  test('uses resolved account currency when the client omits currency', () => {
    const withoutCurrency = { ...order };
    delete withoutCurrency.currency;

    const pkrFingerprint = checkoutRequestFingerprint(
      withoutCurrency,
      'checkout_session',
      'web',
      { resolvedCurrency: 'PKR' },
    );
    const usdFingerprint = checkoutRequestFingerprint(
      withoutCurrency,
      'checkout_session',
      'web',
      { resolvedCurrency: 'USD' },
    );

    expect(pkrFingerprint).not.toBe(usdFingerprint);
    expect(pkrFingerprint).toBe(checkoutRequestFingerprint(
      { ...withoutCurrency, currency: 'PKR' },
      'checkout_session',
      'web',
    ));
  });
});
