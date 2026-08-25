'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const WhatsAppPendingMessage = require('../../models/WhatsAppPendingMessage');
const {
  _claimNextDueJob: claimNextDueJob,
  _finishClaimedJob: finishClaimedJob,
  _terminalizeExhaustedStaleLeases: terminalizeExhaustedStaleLeases,
  enqueueGenericTextNotification,
  findGenericTextNotificationJob,
} = require('../../services/whatsapp/queue');

let mongoServer;

const createJob = overrides => WhatsAppPendingMessage.create({
  order: new mongoose.Types.ObjectId(),
  orderId: `ORD-WA-${new mongoose.Types.ObjectId()}`,
  confirmationToken: 'a'.repeat(64),
  messageType: 'custom_info',
  messageBody: 'A durable buyer notification.',
  phone: '923001234567',
  status: 'queued',
  attempts: 0,
  nextAttemptAt: new Date(0),
  ...overrides,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await WhatsAppPendingMessage.init();
}, 60000);

afterEach(async () => {
  await WhatsAppPendingMessage.deleteMany({});
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
}, 60000);

describe('buyer WhatsApp queue leases', () => {
  test('generic current-user text is durable, order-independent, and converges under concurrent enqueue', async () => {
    const input = {
      phone: '+92 300 1234567',
      message: 'A durable Wallet or admin payment-risk alert.',
      dedupeKey: 'outbox:generic-risk-alert',
      recipientLabel: 'Risk recipient',
    };
    const [first, second] = await Promise.all([
      enqueueGenericTextNotification(input),
      enqueueGenericTextNotification(input),
    ]);
    expect(String(first._id)).toBe(String(second._id));
    expect(await WhatsAppPendingMessage.countDocuments({
      dedupeKey: input.dedupeKey,
    })).toBe(1);
    const stored = await findGenericTextNotificationJob(input.dedupeKey);
    expect(stored).toMatchObject({
      order: null,
      orderId: '',
      confirmationToken: 'n/a',
      messageType: 'generic_info',
      messageBody: input.message,
      phone: '923001234567',
      buyerName: 'Risk recipient',
      status: 'queued',
    });
  });

  test('generic child replay fails closed on different content, destination, or ownership', async () => {
    const input = {
      phone: '+92 300 1234567',
      message: 'The exact immutable payment-risk snapshot.',
      dedupeKey: 'outbox:generic-risk-integrity',
    };
    const original = await enqueueGenericTextNotification(input);
    await expect(enqueueGenericTextNotification({
      ...input,
      message: 'Different money or outcome text.',
    })).resolves.toBeNull();
    await expect(enqueueGenericTextNotification({
      ...input,
      phone: '+92 300 9999999',
    })).resolves.toBeNull();
    expect(await WhatsAppPendingMessage.countDocuments({ dedupeKey: input.dedupeKey })).toBe(1);
    expect((await WhatsAppPendingMessage.findById(original._id).lean()).messageBody).toBe(input.message);

    await createJob({ dedupeKey: 'outbox:order-owned-child' });
    await expect(enqueueGenericTextNotification({
      ...input,
      dedupeKey: 'outbox:order-owned-child',
    })).resolves.toBeNull();

    await expect(WhatsAppPendingMessage.create({
      order: null,
      orderId: 'ORD-FALSE-OWNER',
      confirmationToken: 'n/a',
      messageType: 'generic_info',
      messageBody: input.message,
      phone: '923001234567',
    })).rejects.toThrow(/cannot claim an order owner/i);
  });

  test('only one worker claims a due job and the attempt is counted at claim time', async () => {
    await createJob();
    const now = new Date('2026-08-24T10:00:00.000Z');
    const claims = await Promise.all([
      claimNextDueJob({ now, leaseMs: 5000, workerId: 'worker-a' }),
      claimNextDueJob({ now, leaseMs: 5000, workerId: 'worker-b' }),
    ]);

    const claimed = claims.find(Boolean);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claimed).toEqual(expect.objectContaining({
      status: 'sending',
      attempts: 1,
      leaseOwner: expect.stringMatching(/^worker-/),
      leaseExpiresAt: new Date('2026-08-24T10:00:05.000Z'),
    }));
    expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('a restarted worker reclaims an expired sending lease with the next attempt', async () => {
    const original = await createJob({
      status: 'sending',
      attempts: 1,
      leaseToken: 'old-worker-token',
      leaseOwner: 'old-worker',
      leaseExpiresAt: new Date('2026-08-24T09:59:00.000Z'),
    });
    const now = new Date('2026-08-24T10:00:00.000Z');

    const reclaimed = await claimNextDueJob({
      now,
      leaseMs: 5000,
      workerId: 'restarted-worker',
    });

    expect(String(reclaimed._id)).toBe(String(original._id));
    expect(reclaimed).toEqual(expect.objectContaining({
      status: 'sending',
      attempts: 2,
      leaseOwner: 'restarted-worker',
      leaseExpiresAt: new Date('2026-08-24T10:00:05.000Z'),
    }));
    expect(reclaimed.leaseToken).not.toBe('old-worker-token');
    await expect(claimNextDueJob({
      now,
      leaseMs: 5000,
      workerId: 'competing-worker',
    })).resolves.toBeNull();
  });

  test('a worker that lost its lease cannot overwrite the replacement worker', async () => {
    const original = await createJob();
    const claimed = await claimNextDueJob({
      now: new Date('2026-08-24T10:00:00.000Z'),
      leaseMs: 5000,
      workerId: 'winning-worker',
    });

    await expect(finishClaimedJob({
      _id: original._id,
      leaseToken: 'stale-worker-token',
    }, {
      status: 'failed',
      lastError: 'A stale provider result.',
    })).resolves.toBeNull();
    let stored = await WhatsAppPendingMessage.findById(original._id).lean();
    expect(stored).toEqual(expect.objectContaining({
      status: 'sending',
      leaseToken: claimed.leaseToken,
      leaseOwner: 'winning-worker',
    }));

    await expect(finishClaimedJob(claimed, {
      status: 'sent',
      summaryMessageId: 'provider-message-1',
      sentAt: new Date('2026-08-24T10:00:01.000Z'),
    })).resolves.toEqual(expect.objectContaining({ status: 'sent' }));
    stored = await WhatsAppPendingMessage.findById(original._id).lean();
    expect(stored).toEqual(expect.objectContaining({
      status: 'sent',
      leaseToken: null,
      leaseOwner: '',
    }));
    expect(stored.summaryMessageId).toBe('provider-message-1');
  });

  test('an expired final lease becomes terminal instead of remaining stuck sending', async () => {
    const original = await createJob({
      status: 'sending',
      attempts: 3,
      leaseToken: 'final-attempt-token',
      leaseOwner: 'crashed-worker',
      leaseExpiresAt: new Date('2026-08-24T09:59:00.000Z'),
    });

    await terminalizeExhaustedStaleLeases({
      now: new Date('2026-08-24T10:00:00.000Z'),
      leaseMs: 5000,
    });

    const failed = await WhatsAppPendingMessage.findById(original._id).lean();
    expect(failed).toEqual(expect.objectContaining({
      status: 'failed',
      attempts: 3,
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
      lastError: expect.stringContaining('provider acceptance is unknown'),
    }));
  });

  test('legacy sending rows without a lease are recovered only after the lease grace interval', async () => {
    const original = await createJob({
      status: 'sending',
      attempts: 1,
      leaseToken: null,
      leaseOwner: '',
      leaseExpiresAt: null,
    });
    await WhatsAppPendingMessage.collection.updateOne(
      { _id: original._id },
      { $set: { updatedAt: new Date('2026-08-24T09:59:00.000Z') } }
    );

    const reclaimed = await claimNextDueJob({
      now: new Date('2026-08-24T10:00:00.000Z'),
      leaseMs: 5000,
      workerId: 'post-deploy-worker',
    });
    expect(String(reclaimed._id)).toBe(String(original._id));
    expect(reclaimed.attempts).toBe(2);
    expect(reclaimed.leaseOwner).toBe('post-deploy-worker');
  });

  test('legacy due rows without an attempts field are treated as an unused first attempt', async () => {
    const original = await createJob();
    await WhatsAppPendingMessage.collection.updateOne(
      { _id: original._id },
      { $unset: { attempts: '' } }
    );

    const claimed = await claimNextDueJob({
      now: new Date('2026-08-24T10:00:00.000Z'),
      leaseMs: 5000,
      workerId: 'compatibility-worker',
    });

    expect(String(claimed._id)).toBe(String(original._id));
    expect(claimed).toEqual(expect.objectContaining({
      status: 'sending',
      attempts: 1,
      leaseOwner: 'compatibility-worker',
    }));
  });
});
