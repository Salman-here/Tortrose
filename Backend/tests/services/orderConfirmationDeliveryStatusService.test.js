'use strict';

const mockOutboxFind = jest.fn();
const mockOrderUpdateOne = jest.fn();

jest.mock('../../models/NotificationOutbox', () => ({
  find: mockOutboxFind,
}));

jest.mock('../../models/Order', () => ({
  updateOne: mockOrderUpdateOne,
}));

const {
  syncOrderConfirmationDeliveryStatus,
  terminalDeliveryStatus,
  withAuthoritativeOrderConfirmationDelivery,
} = require('../../services/orderConfirmationDeliveryStatusService');

const confirmationRecord = overrides => ({
  aggregateType: 'Order',
  aggregateId: '68b2795c9c75471896928201',
  eventType: 'order.confirmation_requested',
  channel: 'email',
  recipient: { audienceRole: 'buyer' },
  status: 'delivered',
  deliveredAt: new Date('2026-08-30T10:00:00.000Z'),
  ...overrides,
});

describe('order confirmation delivery status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('maps only terminal buyer confirmation channel records', () => {
    expect(terminalDeliveryStatus(confirmationRecord())).toEqual({
      channel: 'email',
      sentAt: new Date('2026-08-30T10:00:00.000Z'),
      sentSuccess: true,
      error: '',
    });
    expect(terminalDeliveryStatus(confirmationRecord({ status: 'retry' }))).toBeNull();
    expect(terminalDeliveryStatus(confirmationRecord({ eventType: 'order.placed' }))).toBeNull();
    expect(terminalDeliveryStatus(confirmationRecord({ recipient: { audienceRole: 'seller' } }))).toBeNull();
  });

  test('persists delivered email status onto the matching COD order', async () => {
    mockOrderUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const record = confirmationRecord();

    await syncOrderConfirmationDeliveryStatus(record);

    expect(mockOrderUpdateOne).toHaveBeenCalledWith({
      _id: record.aggregateId,
      paymentMethod: 'cash_on_delivery',
    }, {
      $set: {
        'confirmation.emailSentAt': record.deliveredAt,
        'confirmation.emailSentSuccess': true,
        'confirmation.emailError': '',
      },
    });
  });

  test('records a terminal provider failure but leaves retrying delivery untouched', async () => {
    mockOrderUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const failedAt = new Date('2026-08-30T10:02:00.000Z');

    await syncOrderConfirmationDeliveryStatus(confirmationRecord({
      status: 'dead',
      deliveredAt: null,
      deadAt: failedAt,
      lastErrorCode: 'EMAIL_PROVIDER_REJECTED',
      lastError: 'Provider rejected the message.',
    }));
    await syncOrderConfirmationDeliveryStatus(confirmationRecord({ status: 'retry' }));

    expect(mockOrderUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockOrderUpdateOne).toHaveBeenCalledWith(expect.any(Object), {
      $set: {
        'confirmation.emailSentAt': failedAt,
        'confirmation.emailSentSuccess': false,
        'confirmation.emailError': 'EMAIL_PROVIDER_REJECTED: Provider rejected the message.',
      },
    });
  });

  test('does not overwrite the WhatsApp child queue provider timestamp', async () => {
    const childSentAt = new Date('2026-08-30T09:59:30.000Z');
    const parentDeliveredAt = new Date('2026-08-30T10:01:00.000Z');
    const lean = jest.fn().mockResolvedValue([
      confirmationRecord({ channel: 'whatsapp', deliveredAt: parentDeliveredAt }),
    ]);
    mockOutboxFind.mockReturnValue({
      sort: jest.fn(() => ({ lean })),
    });

    const result = await withAuthoritativeOrderConfirmationDelivery({
      _id: '68b2795c9c75471896928201',
      paymentMethod: 'cash_on_delivery',
      confirmation: {
        whatsappSentAt: childSentAt,
        whatsappSentSuccess: true,
        whatsappError: '',
      },
    });

    expect(result.confirmation.whatsappSentAt).toEqual(childSentAt);
  });

  test('overlays authoritative historical email and WhatsApp outcomes for order detail', async () => {
    const emailDeliveredAt = new Date('2026-08-30T10:00:00.000Z');
    const whatsappDeliveredAt = new Date('2026-08-30T10:01:00.000Z');
    const lean = jest.fn().mockResolvedValue([
      confirmationRecord({ deliveredAt: emailDeliveredAt }),
      confirmationRecord({ channel: 'whatsapp', deliveredAt: whatsappDeliveredAt }),
    ]);
    const sort = jest.fn(() => ({ lean }));
    mockOutboxFind.mockReturnValue({ sort });
    const order = {
      _id: '68b2795c9c75471896928201',
      paymentMethod: 'cash_on_delivery',
      confirmation: {
        token: 'unchanged-token',
        emailSentSuccess: null,
        whatsappSentSuccess: null,
      },
    };

    const result = await withAuthoritativeOrderConfirmationDelivery(order);

    expect(mockOutboxFind).toHaveBeenCalledWith({
      aggregateType: 'Order',
      aggregateId: order._id,
      eventType: 'order.confirmation_requested',
      channel: { $in: ['email', 'whatsapp'] },
      'recipient.audienceRole': 'buyer',
    });
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(result.confirmation).toEqual(expect.objectContaining({
      token: 'unchanged-token',
      emailSentAt: emailDeliveredAt,
      emailSentSuccess: true,
      emailError: '',
      whatsappSentAt: whatsappDeliveredAt,
      whatsappSentSuccess: true,
      whatsappError: '',
    }));
    expect(order.confirmation.emailSentSuccess).toBeNull();
  });
});
