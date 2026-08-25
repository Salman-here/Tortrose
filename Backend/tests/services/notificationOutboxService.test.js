'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const NotificationOutbox = require('../../models/NotificationOutbox');
const {
  claimNextNotification,
  enqueueNotificationEvent,
  markNotificationDelivered,
  markNotificationDeferred,
  markNotificationFailed,
  reapExhaustedNotificationLeases,
  deferredPollDelayMs,
} = require('../../services/notificationOutboxService');
const { snapshotMajorMoney } = require('../../services/notificationMoneySnapshotService');

let mongoServer;

const runInTransaction = async work => {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const userId = () => new mongoose.Types.ObjectId();
const orderId = () => new mongoose.Types.ObjectId();

const financialEvent = (overrides = {}) => {
  const aggregateId = overrides.aggregateId || orderId();
  const recipientUser = overrides.recipientUser || userId();
  return {
    eventKey: `order:${aggregateId}:paid:v1`,
    eventType: 'order.paid',
    aggregateType: 'Order',
    aggregateId: String(aggregateId),
    occurredAt: new Date('2026-08-24T10:00:00.000Z'),
    financial: true,
    recipient: {
      kind: 'user',
      audienceRole: 'buyer',
      user: recipientUser,
      destinationPolicy: 'event_snapshot',
      email: 'buyer@example.com',
      phone: '+92 300 1234567',
    },
    channels: ['inapp', 'push', 'email', 'whatsapp'],
    templates: {
      inapp: { title: 'Payment received', body: 'Order total: {{money.order_total}}.' },
      push: { title: 'Payment received', body: 'Order total: {{money.order_total}}.' },
      email: {
        subject: 'Payment received',
        text: 'We received {{money.order_total}} for your order.',
        html: '<p>We received <strong>{{money.order_total}}</strong> for your order.</p>',
      },
      whatsapp: { message: 'Payment received: {{money.order_total}}.' },
    },
    metadata: {
      category: 'order',
      linkTo: `/user-dashboard/order/detail/${aggregateId}`,
      channelId: 'orders',
      relatedOrder: aggregateId,
      data: { type: 'order_paid', orderId: String(aggregateId) },
    },
    money: [snapshotMajorMoney({
      key: 'order_total',
      label: 'Order total',
      amount: overrides.amount ?? 1880,
      currency: overrides.currency || 'PKR',
      sourceModel: 'Order',
      sourceDocumentId: aggregateId,
      sourcePath: 'orderSummary.totalAmount',
    })],
    ...overrides.event,
  };
};

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await NotificationOutbox.syncIndexes();
}, 60000);

afterEach(async () => {
  await NotificationOutbox.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('durable notification outbox enqueue contracts', () => {
  test('persists one idempotent record per event/channel/recipient with frozen PKR text', async () => {
    const input = financialEvent();
    const first = await enqueueNotificationEvent(input);
    const replay = await enqueueNotificationEvent(input);

    expect(first).toHaveLength(4);
    expect(replay.map(row => String(row._id))).toEqual(first.map(row => String(row._id)));
    expect(await NotificationOutbox.countDocuments()).toBe(4);

    const records = await NotificationOutbox.find({}).select('+contentHash +dedupeKey');
    expect(new Set(records.map(row => row.dedupeKey)).size).toBe(4);
    for (const record of records) {
      const rendered = [
        record.payload.title,
        record.payload.body,
        record.payload.subject,
        record.payload.text,
        record.payload.html,
        record.payload.message,
      ].join(' ');
      expect(rendered).toContain('Rs1,880.00 PKR');
      expect(record.money[0]).toEqual(expect.objectContaining({
        amountMinor: 188000,
        currency: 'PKR',
        sourcePath: 'orderSummary.totalAmount',
      }));
    }
  });

  test('concurrent replays converge on the same channel records', async () => {
    const input = financialEvent();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => enqueueNotificationEvent(input))
    );
    expect(await NotificationOutbox.countDocuments()).toBe(4);
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index].map(row => String(row._id)))
        .toEqual(results[0].map(row => String(row._id)));
    }
  });

  test('concurrent first-insert transactions converge without reading an aborted transaction', async () => {
    const input = financialEvent();
    let waiting = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const attempts = [0, 0];
    const transact = index => runInTransaction(async session => {
      attempts[index] += 1;
      if (attempts[index] === 1) {
        waiting += 1;
        if (waiting === 2) release();
        await gate;
      }
      return enqueueNotificationEvent({ ...input, session });
    });

    const [left, right] = await Promise.all([transact(0), transact(1)]);
    expect(await NotificationOutbox.countDocuments()).toBe(4);
    expect(right.map(row => String(row._id))).toEqual(left.map(row => String(row._id)));
  });

  test('transactional duplicate-key recovery is delegated to a fresh outer retry', async () => {
    const duplicate = new Error('simulated concurrent dedupe winner');
    duplicate.code = 11000;
    duplicate.addErrorLabel = jest.fn();
    const findOneSpy = jest.spyOn(NotificationOutbox, 'findOne');
    const updateSpy = jest.spyOn(NotificationOutbox, 'findOneAndUpdate')
      .mockImplementationOnce(() => ({
        select: () => Promise.reject(duplicate),
      }));

    try {
      await expect(enqueueNotificationEvent({
        ...financialEvent(),
        channels: ['inapp'],
        session: { inTransaction: () => true },
      })).rejects.toBe(duplicate);
      expect(duplicate.addErrorLabel).toHaveBeenCalledWith('TransientTransactionError');
      expect(findOneSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
      findOneSpy.mockRestore();
    }
  });

  test('same idempotency identity cannot be replayed with different money', async () => {
    const input = financialEvent();
    await enqueueNotificationEvent(input);
    await expect(enqueueNotificationEvent(financialEvent({
      aggregateId: input.aggregateId,
      recipientUser: input.recipient.user,
      amount: 1880.01,
    }))).rejects.toMatchObject({ code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT' });
    expect(await NotificationOutbox.countDocuments()).toBe(4);
  });

  test('same idempotency identity cannot be replayed with a different authoritative timestamp', async () => {
    const input = financialEvent();
    await enqueueNotificationEvent(input);

    await expect(enqueueNotificationEvent(financialEvent({
      aggregateId: input.aggregateId,
      recipientUser: input.recipient.user,
      event: { occurredAt: new Date('2026-08-24T10:00:01.000Z') },
    }))).rejects.toMatchObject({ code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT' });

    expect(await NotificationOutbox.countDocuments()).toBe(4);
  });

  test('financial client data cannot carry a second amount/currency interpretation', async () => {
    const input = financialEvent();
    input.metadata.data = {
      type: 'order_paid',
      displayCurrency: 'USD',
      totalAmount: 6.71,
    };
    await expect(enqueueNotificationEvent(input)).rejects.toMatchObject({
      code: 'NOTIFICATION_CLIENT_MONEY_FORBIDDEN',
    });
    expect(await NotificationOutbox.countDocuments()).toBe(0);
  });

  test('blocked-recipient bypass permits exact completed receipts only for their owned audience', async () => {
    const input = financialEvent();
    input.recipient.allowBlocked = true;
    await expect(enqueueNotificationEvent(input)).resolves.toHaveLength(4);
    expect((await NotificationOutbox.findOne({ eventType: 'order.paid' }).lean()).recipient.allowBlocked)
      .toBe(true);

    const wrongAudience = financialEvent();
    wrongAudience.recipient.allowBlocked = true;
    wrongAudience.recipient.audienceRole = 'admin';
    await expect(enqueueNotificationEvent(wrongAudience)).rejects.toMatchObject({
      code: 'NOTIFICATION_BLOCKED_RECIPIENT_EVENT_FORBIDDEN',
    });

    const mutableEvent = financialEvent();
    mutableEvent.eventType = 'order.placed';
    mutableEvent.recipient.allowBlocked = true;
    await expect(enqueueNotificationEvent(mutableEvent)).rejects.toMatchObject({
      code: 'NOTIFICATION_BLOCKED_RECIPIENT_EVENT_FORBIDDEN',
    });
  });

  test('each financial channel must render from a snapshot and every snapshot must be used', async () => {
    const missingChannelToken = financialEvent();
    missingChannelToken.templates.push.body = 'Your payment was received.';
    await expect(enqueueNotificationEvent(missingChannelToken)).rejects.toMatchObject({
      code: 'NOTIFICATION_MONEY_NOT_RENDERED',
    });

    const unusedSnapshot = financialEvent();
    unusedSnapshot.money.push(snapshotMajorMoney({
      key: 'tax',
      amount: 10,
      currency: 'PKR',
      sourceModel: 'Order',
      sourceDocumentId: unusedSnapshot.aggregateId,
      sourcePath: 'orderSummary.tax',
    }));
    await expect(enqueueNotificationEvent(unusedSnapshot)).rejects.toMatchObject({
      code: 'NOTIFICATION_MONEY_NOT_RENDERED',
    });
  });

  test('guest recipients fail closed for privileged channels and unsafe destinations', async () => {
    const input = financialEvent();
    input.recipient = {
      kind: 'guest',
      audienceRole: 'buyer',
      guestKey: `order:${input.aggregateId}`,
      destinationPolicy: 'event_snapshot',
      email: 'guest@example.com',
      phone: '+92 300 1234567',
    };
    await expect(enqueueNotificationEvent(input)).rejects.toThrow(/Guest recipients cannot receive/);

    input.channels = ['email', 'whatsapp'];
    const created = await enqueueNotificationEvent(input);
    expect(created).toHaveLength(2);
  });

  test('event-snapshot WhatsApp destinations must be explicitly international', async () => {
    const input = financialEvent();
    input.channels = ['whatsapp'];
    input.recipient.phone = '0300 1234567';

    await expect(enqueueNotificationEvent(input)).rejects.toThrow(/explicit international/i);
    expect(await NotificationOutbox.countDocuments()).toBe(0);
  });
});

describe('notification worker leases and retries', () => {
  test('only one worker can claim a due channel record', async () => {
    const input = financialEvent();
    input.channels = ['email'];
    await enqueueNotificationEvent(input);
    const now = new Date('2099-08-24T10:05:00.000Z');
    const claims = await Promise.all([
      claimNextNotification({ workerId: 'worker-a', now }),
      claimNextNotification({ workerId: 'worker-b', now }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean).attempts).toBe(1);
  });

  test('a delivered lease cannot be completed by another token', async () => {
    const input = financialEvent();
    input.channels = ['email'];
    await enqueueNotificationEvent(input);
    const record = await claimNextNotification({
      workerId: 'worker-a',
      now: new Date('2099-08-24T10:05:00.000Z'),
    });
    await expect(markNotificationDelivered({
      id: record._id,
      leaseToken: 'wrong-token',
    })).resolves.toBeNull();
    const delivered = await markNotificationDelivered({
      id: record._id,
      leaseToken: record.leaseToken,
      providerMessageId: 'provider-1',
    });
    expect(delivered).toEqual(expect.objectContaining({ status: 'delivered' }));
  });

  test('transient failures back off while definitive failures become dead', async () => {
    const input = financialEvent();
    input.channels = ['email'];
    const [created] = await enqueueNotificationEvent(input);
    let record = await claimNextNotification({
      workerId: 'worker-a',
      now: new Date('2099-08-24T10:05:00.000Z'),
    });
    const transient = new Error('provider unavailable');
    transient.code = 'PROVIDER_DOWN';
    transient.retryable = true;
    const retry = await markNotificationFailed({
      record,
      leaseToken: record.leaseToken,
      error: transient,
      at: new Date('2099-08-24T10:05:00.000Z'),
    });
    expect(retry.status).toBe('retry');
    expect(retry.nextAttemptAt).toEqual(new Date('2099-08-24T10:05:30.000Z'));

    await NotificationOutbox.updateOne({ _id: created._id }, {
      $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(0) },
    });
    record = await claimNextNotification({ workerId: 'worker-b', now: new Date() });
    const definitive = new Error('recipient mismatch');
    definitive.code = 'RECIPIENT_MISMATCH';
    definitive.retryable = false;
    const dead = await markNotificationFailed({
      record,
      leaseToken: record.leaseToken,
      error: definitive,
    });
    expect(dead.status).toBe('dead');
    expect(dead.deadAt).toBeInstanceOf(Date);
  });

  test('durable child polling preserves attempt budget and uses capped backoff', async () => {
    const input = financialEvent();
    input.channels = ['whatsapp'];
    input.maxAttempts = 1;
    await enqueueNotificationEvent(input);
    const at = new Date('2099-08-24T10:05:00.000Z');
    let record = await claimNextNotification({ workerId: 'parent-worker', now: at });
    expect(record.attempts).toBe(1);

    let deferred = await markNotificationDeferred({
      record,
      leaseToken: record.leaseToken,
      code: 'BUYER_WHATSAPP_JOB_PENDING',
      reason: 'Child is queued.',
      at,
    });
    expect(deferred).toEqual(expect.objectContaining({
      status: 'retry',
      attempts: 0,
      deferredCount: 1,
      nextAttemptAt: new Date('2099-08-24T10:05:30.000Z'),
      lastErrorCode: 'BUYER_WHATSAPP_JOB_PENDING',
    }));

    await NotificationOutbox.updateOne({ _id: deferred._id }, {
      $set: { nextAttemptAt: new Date(0), deferredCount: 100 },
    });
    record = await claimNextNotification({ workerId: 'parent-worker', now: at });
    deferred = await markNotificationDeferred({
      record,
      leaseToken: record.leaseToken,
      at,
    });
    expect(deferred.attempts).toBe(0);
    expect(deferred.deferredCount).toBe(101);
    expect(deferred.nextAttemptAt).toEqual(new Date('2099-08-24T10:10:00.000Z'));
    expect(deferredPollDelayMs(0)).toBe(30_000);
    expect(deferredPollDelayMs(100)).toBe(5 * 60_000);
  });

  test('an expired final lease is reaped instead of remaining stuck processing', async () => {
    const input = financialEvent();
    input.channels = ['email'];
    input.maxAttempts = 1;
    await enqueueNotificationEvent(input);
    const claimed = await claimNextNotification({
      workerId: 'crashed-worker',
      now: new Date('2099-08-24T10:05:00.000Z'),
      leaseMs: 5000,
    });
    expect(claimed.attempts).toBe(1);
    await reapExhaustedNotificationLeases(new Date('2099-08-24T10:05:06.000Z'));
    const reaped = await NotificationOutbox.findById(claimed._id);
    expect(reaped).toEqual(expect.objectContaining({
      status: 'dead',
      lastErrorCode: 'NOTIFICATION_LEASE_EXHAUSTED',
    }));
  });
});
