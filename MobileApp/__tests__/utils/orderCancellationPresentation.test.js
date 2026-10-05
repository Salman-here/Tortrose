import { cancellationRefundPresentation } from '../../src/utils/orderCancellationPresentation';
test('card/Wallet cancellation refunds use verified original-currency minor units', () => {
  const row = { reference: 'cancel-1', refundStatus: 'refunded', destination: 'wallet', currency: 'USD', amountMinor: 1200 };
  expect(cancellationRefundPresentation(row, 'USD', 12)).toMatchObject({ valid: true, amount: 12, destination: 'Rozare Wallet', label: 'Refund completed' });
  expect(cancellationRefundPresentation({ ...row, amountMinor: '1200' }, 'USD', 12).valid).toBe(false);
  expect(cancellationRefundPresentation({ ...row, currency: 'PKR' }, 'USD', 12).valid).toBe(false);
});
