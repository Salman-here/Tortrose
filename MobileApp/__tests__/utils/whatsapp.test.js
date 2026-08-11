import {
  buildVerifyMessage,
  getConfirmationSourceLabel,
  sanitizePhone,
} from '../../src/utils/whatsapp';

jest.mock('../../src/config/api', () => ({ get: jest.fn() }));

describe('seller WhatsApp helpers', () => {
  it('keeps explicit international numbers and uses the actual country code for local numbers', () => {
    expect(sanitizePhone('+442071234567')).toBe('442071234567');
    expect(sanitizePhone('02071234567', '+44')).toBe('442071234567');
    expect(sanitizePhone('03001234567')).toBe('');
  });

  it('formats order values in the order currency instead of hardcoded dollars', () => {
    const formatter = jest.fn((amount, { sourceCurrency }) => `${sourceCurrency} ${amount.toFixed(2)}`);
    const message = buildVerifyMessage({
      orderId: 'ORD-1',
      currency: 'GBP',
      shippingInfo: { fullName: 'A Buyer' },
      orderItems: [{ name: 'Bag', quantity: 2, price: 5 }],
      orderSummary: { totalAmount: 10 },
    }, formatter);
    expect(message).toContain('GBP 10.00');
    expect(message).not.toContain('$10.00');
  });

  it('describes buyer decision sources', () => {
    expect(getConfirmationSourceLabel({
      confirmation: { confirmedAt: '2026-08-08T10:00:00Z', confirmedVia: 'whatsapp' },
    })).toContain('Rozare WhatsApp automation');
  });
});
