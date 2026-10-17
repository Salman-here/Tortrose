'use strict';

const mockEnqueueReturnSettlementNotifications = jest.fn();
const mockEnqueueNotificationEvent = jest.fn(async input => input.channels.map(channel => ({ channel })));
jest.mock('../../services/notificationOutboxService', () => ({
  enqueueNotificationEvent: (...args) => mockEnqueueNotificationEvent(...args),
}));
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
  afterEach(() => {
    mockEnqueueReturnSettlementNotifications.mockReset();
    mockEnqueueNotificationEvent.mockClear();
  });

  test.each([
    ['requested', 'Return request received', 'awaiting the seller’s review'],
    ['approved', 'Return request approved', 'was approved'],
    ['pickup_scheduled', 'Return pickup scheduled', 'Pickup has been scheduled'],
    ['picked_up', 'Return picked up', 'marked as picked up'],
    ['in_transit_to_seller', 'Your return is on its way', 'on their way to the seller'],
    ['received_by_seller', 'Return received by seller', 'as received'],
    ['under_review', 'Return inspection in progress', 'inspecting the received items'],
    ['accepted_pending_payment', 'Return accepted — refund pending', 'has not been credited yet'],
    ['replacement_approved', 'Replacement approved', 'replacement was approved'],
    ['rejected', 'Return request declined', 'was declined'],
    ['cancelled_by_buyer', 'Return request cancelled', 'original purchase is unchanged'],
  ])('%s copy explains the real return state without prematurely claiming a refund', async (status, title, detail) => {
    const request = { _id: 'return-id', buyer: 'buyer-id', order: 'order-id', orderId: 'ORD-COPY',
      returnNumber: 'RET-COPY', status, createdAt: new Date('2026-10-12T08:00:00Z'), statusHistory: [] };
    const order = { shippingInfo: { email: 'buyer@example.com', phone: '+923001234567' } };
    await expect(notifyBuyerReturnStatus(request, order)).resolves.toBe(true);
    const [event] = mockEnqueueNotificationEvent.mock.calls[0];
    expect(event.channels).toEqual(['inapp', 'push', 'email', 'whatsapp']);
    expect(event.templates.inapp.title).toBe(title);
    expect(event.templates.inapp.body).toContain(detail);
    expect(event.templates.whatsapp.message).toContain(detail);
    expect(event.templates.email.text).not.toMatch(/was credited|refund (?:completed|issued)|sent to.*card/i);
    expect(event.metadata.linkTo).toBe('/user-dashboard/order/detail/order-id?returnId=return-id');
  });

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
