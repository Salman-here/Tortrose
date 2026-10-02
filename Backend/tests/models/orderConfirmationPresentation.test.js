'use strict';

const Order = require('../../models/Order');
const { getConfirmationViaLabel } = require('../../services/orderConfirmationPresentationService');

describe('order confirmation presentation virtual', () => {
  test.each([
    ['safepay_payment', 'Safepay payment'],
    ['wallet_payment', 'Rozare Wallet payment'],
    ['stripe_payment', 'card payment'],
  ])('%s records verified payment rather than inventing a manual buyer action', (source, method) => {
    const order = new Order({
      orderStatus: 'confirmed',
      isPaid: true,
      currency: 'PKR',
      orderSummary: { subtotal: 1000, shippingCost: 0, tax: 0, couponDiscount: 0, totalAmount: 1000 },
      confirmation: { confirmedAt: new Date('2026-10-02T06:42:57Z'), confirmedVia: source },
    });
    const before = order.toObject({ virtuals: false });
    expect(order.confirmationSourceLabel).toBe(`Confirmed after verified ${method}`);
    expect(order.toObject({ virtuals: false })).toEqual(before);
  });

  test('a source without a decision remains unconfirmed', () => {
    expect(new Order({ confirmation: { confirmedVia: 'safepay_payment' } }).confirmationSourceLabel).toBe('');
  });

  test('paid cancellation preserves its real actor and the previous verified payment', () => {
    const order = new Order({
      orderStatus: 'cancelled',
      confirmation: {
        confirmedAt: new Date('2026-10-02T06:42:57Z'),
        confirmedVia: 'safepay_payment',
        cancelledAt: new Date('2026-10-03T00:00:00Z'),
        cancelledByRole: 'admin',
        cancelledVia: 'admin',
      },
    });
    expect(order.confirmationSourceLabel).toBe('Cancelled by administrator (was confirmed after verified Safepay payment)');
    expect(order.confirmationSourceLabel).not.toContain('safepay_payment');
  });

  test('human channels stay human and unknown strings stay private', () => {
    const order = new Order({
      confirmation: { confirmedAt: new Date('2026-10-02T06:42:57Z'), confirmedVia: 'email' },
    });
    expect(order.confirmationSourceLabel).toBe('Confirmed by buyer via email confirmation link');
    expect(getConfirmationViaLabel('unknown_internal_code')).toBe('Rozare');
    expect(getConfirmationViaLabel('__proto__')).toBe('Rozare');
  });
});
