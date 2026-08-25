'use strict';

const mockEnqueueReturnSettlementNotifications = jest.fn();
jest.mock('../../services/financialNotificationOutboxService', () => ({
  enqueueReturnSettlementNotifications: (...args) => (
    mockEnqueueReturnSettlementNotifications(...args)
  ),
}));

const {
  formatReturnAmount,
  notifyBuyerReturnStatus,
} = require('../../services/returnNotificationService');

describe('return notification money formatting', () => {
  afterEach(() => mockEnqueueReturnSettlementNotifications.mockReset());

  test.each([
    ['USD', 12.34, '$12.34'],
    ['PKR', 280, 'Rs280.00 PKR'],
    ['EUR', 1.25, '€1.25 EUR'],
    ['GBP', 2, '£2.00 GBP'],
  ])('formats frozen %s totals without FX conversion', (currency, amount, expected) => {
    expect(formatReturnAmount({ currency, refund: { totalAmount: amount } })).toBe(expected);
  });

  test.each([undefined, null, '', 'usd', ' USD', 'CAD', false])(
    'rejects corrupt stored currency %p instead of labelling it USD',
    (currency) => {
      expect(() => formatReturnAmount({ currency, refund: { totalAmount: 10 } }))
        .toThrow(expect.objectContaining({ code: 'RETURN_FINANCIAL_DATA_INVALID' }));
    }
  );

  test.each([undefined, null, '', '10', true, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.001])(
    'rejects corrupt stored return total %p instead of displaying zero/rounded money',
    (totalAmount) => {
      expect(() => formatReturnAmount({ currency: 'USD', refund: { totalAmount } }))
        .toThrow(expect.objectContaining({ code: 'RETURN_FINANCIAL_DATA_INVALID' }));
    }
  );

  test('completed returned status routes only through the settlement outbox', async () => {
    const request = {
      _id: 'return-id',
      status: 'returned',
      settlement: { status: 'completed' },
      currency: 'PKR',
      refund: { totalAmount: 1880 },
    };
    const order = { _id: 'order-id' };
    mockEnqueueReturnSettlementNotifications.mockResolvedValue({ buyer: [], seller: [] });

    await expect(notifyBuyerReturnStatus(request, order)).resolves.toBe(true);
    expect(mockEnqueueReturnSettlementNotifications).toHaveBeenCalledTimes(1);
    expect(mockEnqueueReturnSettlementNotifications)
      .toHaveBeenCalledWith(request, order, { session: null });
  });

  test('returned status never claims a wallet credit before settlement completes', async () => {
    const request = {
      status: 'returned',
      settlement: { status: 'processing' },
      currency: 'PKR',
      refund: { totalAmount: 1880 },
    };

    await expect(notifyBuyerReturnStatus(request, {})).resolves.toBe(false);
    expect(mockEnqueueReturnSettlementNotifications).not.toHaveBeenCalled();
  });
});
