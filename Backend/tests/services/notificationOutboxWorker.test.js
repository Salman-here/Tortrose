'use strict';

const mockClaimNextNotification = jest.fn();
const mockMarkNotificationDelivered = jest.fn();
const mockMarkNotificationDeferred = jest.fn();
const mockMarkNotificationFailed = jest.fn();
const mockMarkNotificationSkipped = jest.fn();
const mockReapExhaustedNotificationLeases = jest.fn();

jest.mock('../../services/notificationOutboxDeliveryService', () => ({
  deliverNotificationRecord: jest.fn(),
}));

jest.mock('../../services/notificationOutboxService', () => ({
  claimNextNotification: mockClaimNextNotification,
  markNotificationDelivered: mockMarkNotificationDelivered,
  markNotificationDeferred: mockMarkNotificationDeferred,
  markNotificationFailed: mockMarkNotificationFailed,
  markNotificationSkipped: mockMarkNotificationSkipped,
  reapExhaustedNotificationLeases: mockReapExhaustedNotificationLeases,
}));

const {
  createOperationalRecoveryGate,
  processNotificationOutboxBatch,
  processNotificationOutboxRecord,
} = require('../../services/notificationOutboxWorker');

describe('notification outbox worker timing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('records provider completion time rather than claim-start time', async () => {
    const startedAt = new Date('2026-08-24T10:00:00.000Z');
    const completedAt = new Date('2026-08-24T10:00:07.000Z');
    const clock = jest.fn()
      .mockReturnValueOnce(completedAt);
    const record = { _id: 'outbox-1', leaseToken: 'lease-1' };
    const deliver = jest.fn().mockResolvedValue({
      outcome: 'delivered',
      providerMessageId: 'provider-1',
    });

    await processNotificationOutboxRecord(record, { deliver, now: clock });

    expect(clock).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationDelivered).toHaveBeenCalledWith({
      id: 'outbox-1',
      leaseToken: 'lease-1',
      providerMessageId: 'provider-1',
      at: completedAt,
    });
    expect(mockMarkNotificationDelivered.mock.calls[0][0].at).not.toEqual(startedAt);
  });

  test('releases a pending durable child without recording a provider failure', async () => {
    const completedAt = new Date('2026-08-24T10:00:07.000Z');
    const record = {
      _id: 'outbox-child-parent',
      leaseToken: 'lease-child-parent',
      attempts: 1,
      deferredCount: 0,
    };
    const deliver = jest.fn().mockResolvedValue({
      outcome: 'deferred',
      code: 'BUYER_WHATSAPP_JOB_PENDING',
      reason: 'The durable buyer WhatsApp job is still queued.',
    });

    await processNotificationOutboxRecord(record, {
      deliver,
      now: () => completedAt,
    });

    expect(mockMarkNotificationDeferred).toHaveBeenCalledWith({
      record,
      leaseToken: 'lease-child-parent',
      code: 'BUYER_WHATSAPP_JOB_PENDING',
      reason: 'The durable buyer WhatsApp job is still queued.',
      at: completedAt,
    });
    expect(mockMarkNotificationFailed).not.toHaveBeenCalled();
    expect(mockMarkNotificationDelivered).not.toHaveBeenCalled();
  });

  test('uses a fresh completion timestamp after a batch claim', async () => {
    const claimAt = new Date('2026-08-24T10:00:00.000Z');
    const completedAt = new Date('2026-08-24T10:00:05.000Z');
    const clock = jest.fn()
      .mockReturnValueOnce(claimAt)
      .mockReturnValueOnce(claimAt)
      .mockReturnValueOnce(completedAt)
      .mockReturnValueOnce(completedAt);
    const record = { _id: 'outbox-2', leaseToken: 'lease-2' };
    mockClaimNextNotification
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce(null);
    const deliver = jest.fn().mockResolvedValue({ outcome: 'delivered' });

    await processNotificationOutboxBatch({
      workerId: 'worker-1',
      batchSize: 2,
      deliver,
      now: clock,
    });

    expect(mockClaimNextNotification).toHaveBeenNthCalledWith(1, {
      workerId: 'worker-1',
      now: claimAt,
      leaseMs: 60000,
    });
    expect(mockMarkNotificationDelivered).toHaveBeenCalledWith(expect.objectContaining({
      id: 'outbox-2',
      at: completedAt,
    }));
  });

  test('bounds marker recovery and runs it at most once per configured interval', async () => {
    let current = 1_000;
    const recover = jest.fn(async ({ limit }) => [{ recovered: true, limit }]);
    const recoverIfDue = createOperationalRecoveryGate({
      recover,
      intervalMs: 10_000,
      batchSize: 25,
      now: () => current,
    });

    await expect(recoverIfDue()).resolves.toMatchObject({ ran: true });
    current = 10_999;
    await expect(recoverIfDue()).resolves.toEqual({ ran: false, results: [] });
    current = 11_000;
    await expect(recoverIfDue()).resolves.toMatchObject({ ran: true });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenNthCalledWith(1, { limit: 25 });
    expect(recover).toHaveBeenNthCalledWith(2, { limit: 25 });
  });
});
