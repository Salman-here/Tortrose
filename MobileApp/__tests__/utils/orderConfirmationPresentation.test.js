import {
  getAutomaticPaymentConfirmationLabel,
  getBuyerConfirmationMessage,
  getCancellationPaymentMessage,
  getConfirmationViaLabel,
} from '../../src/utils/orderConfirmationPresentation';

describe('truthful order confirmation copy', () => {
  it.each([
    ['safepay_payment', 'Safepay payment'],
    ['wallet_payment', 'Rozare Wallet payment'],
    ['stripe_payment', 'card payment'],
  ])('presents %s as automatic payment verification', (source, method) => {
    expect(getAutomaticPaymentConfirmationLabel(source)).toBe(`Confirmed after verified ${method}`);
    const message = getBuyerConfirmationMessage({
      confirmation: { confirmedAt: '2026-10-02T06:42:57Z', confirmedVia: source },
    });
    expect(message).toContain(method);
    expect(message).not.toContain(source);
    expect(message).not.toContain('you confirmed');
    expect(message).not.toContain('has been notified');
  });

  it('requires a recorded confirmation before producing confirmation text', () => {
    expect(getBuyerConfirmationMessage({ confirmation: { confirmedVia: 'safepay_payment' } })).toBe('');
    expect(getBuyerConfirmationMessage(null)).toBe('');
  });

  it('formats real channels and suppresses unknown internal strings', () => {
    expect(getConfirmationViaLabel('email')).toBe('email');
    expect(getConfirmationViaLabel('whatsapp')).toBe('WhatsApp');
    ['future_internal_code', '__proto__', {}, null].forEach(source => {
      expect(getConfirmationViaLabel(source)).toBe('Rozare');
      expect(getAutomaticPaymentConfirmationLabel(source)).toBe('');
    });
  });

  it('does not invent a no-charge or completed-refund claim for a cancelled order', () => {
    const message = getCancellationPaymentMessage();
    expect(message).toContain('payment and refund details');
    expect(message).not.toMatch(/nothing has been charged|refund.*completed|refunded successfully/i);
  });
});
