const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../config/stripe', () => ({ stripe: null, STRIPE_MODE: 'test' }));

const NotificationOutbox = require('../../models/NotificationOutbox');
const SellerSubscription = require('../../models/SellerSubscription');
const StripeSubscriptionCleanup = require('../../models/StripeSubscriptionCleanup');
const User = require('../../models/User');
const {
  ensureStripeSubscriptionCleanup,
  processPendingStripeSubscriptionCleanups,
  processStripeSubscriptionCleanupById,
} = require('../../services/stripeSubscriptionCleanupService');

let mongoServer;

const occurredAt = new Date('2026-08-24T10:00:00.000Z');

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

const createSeller = suffix => User.create({
  username: `cleanup-seller-${suffix}`,
  email: `cleanup-seller-${suffix}@example.com`,
  role: 'seller',
  isVerified: true,
});

const createAdmin = suffix => User.create({
  username: `cleanup-admin-${suffix}`,
  email: `cleanup-admin-${suffix}@example.com`,
  role: 'admin',
  status: 'active',
  isVerified: true,
});

const createCleanup = async ({
  suffix,
  seller,
  staleId = `sub_cleanup_old_${suffix}`,
  replacementId = `sub_cleanup_new_${suffix}`,
  maxAttempts,
} = {}) => ensureStripeSubscriptionCleanup({
  seller: seller._id,
  staleStripeSubscriptionId: staleId,
  replacementStripeSubscriptionId: replacementId,
  stripeCustomerId: `cus_cleanup_${suffix}`,
  reason: 'replacement_activation',
  sourceReference: `cs_cleanup_${suffix}`,
  occurredAt,
  ...(maxAttempts ? { maxAttempts } : {}),
});

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([
    NotificationOutbox.syncIndexes(),
    SellerSubscription.syncIndexes(),
    StripeSubscriptionCleanup.syncIndexes(),
    User.syncIndexes(),
  ]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([
    NotificationOutbox.deleteMany({}),
    SellerSubscription.deleteMany({}),
    StripeSubscriptionCleanup.deleteMany({}),
    User.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('durable Stripe subscription cleanup', () => {
  test('creates one immutable cleanup intent and rejects conflicting ownership evidence for the same Stripe subscription', async () => {
    const seller = await createSeller('idempotency');
    const first = await createCleanup({ suffix: 'idempotency', seller });
    const replay = await createCleanup({ suffix: 'idempotency', seller });

    expect(replay._id.toString()).toBe(first._id.toString());
    await expect(ensureStripeSubscriptionCleanup({
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_old_idempotency',
      replacementStripeSubscriptionId: 'sub_different_replacement',
      stripeCustomerId: 'cus_different_owner',
      reason: 'replacement_activation',
      sourceReference: 'cs_cleanup_idempotency',
      occurredAt,
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_CLEANUP_IDEMPOTENCY_CONFLICT' });
    await expect(ensureStripeSubscriptionCleanup({
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_old_idempotency',
      replacementStripeSubscriptionId: 'sub_different_replacement',
      stripeCustomerId: 'cus_cleanup_idempotency',
      reason: 'replacement_activation',
      sourceReference: 'cs_cleanup_idempotency',
      occurredAt,
    })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_CLEANUP_IDEMPOTENCY_CONFLICT' });
    const laterReplay = await ensureStripeSubscriptionCleanup({
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_old_idempotency',
      replacementStripeSubscriptionId: 'sub_cleanup_new_idempotency',
      stripeCustomerId: 'cus_cleanup_idempotency',
      reason: 'replacement_activation',
      sourceReference: 'cs_changed_source',
      occurredAt: new Date(occurredAt.getTime() + 60_000),
    });
    expect(laterReplay._id.toString()).toBe(first._id.toString());
    expect(laterReplay.sourceReference).toBe('cs_cleanup_idempotency');
    expect(laterReplay.occurredAt).toEqual(occurredAt);
    expect(await StripeSubscriptionCleanup.countDocuments()).toBe(1);
  });

  test('concurrent first-insert transactions converge on one immutable cleanup intent', async () => {
    const seller = await createSeller('transaction-race');
    const input = {
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_old_transaction_race',
      replacementStripeSubscriptionId: 'sub_cleanup_new_transaction_race',
      stripeCustomerId: 'cus_cleanup_transaction_race',
      reason: 'replacement_activation',
      sourceReference: 'cs_cleanup_transaction_race',
      occurredAt,
    };
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
      return ensureStripeSubscriptionCleanup(input, { session });
    });

    const [left, right] = await Promise.all([transact(0), transact(1)]);

    expect(String(right._id)).toBe(String(left._id));
    expect(await StripeSubscriptionCleanup.countDocuments()).toBe(1);
  });

  test('transactional duplicate-key recovery never queries through the aborted session', async () => {
    const seller = await createSeller('aborted-session');
    const duplicate = new Error('simulated concurrent cleanup winner');
    duplicate.code = 11000;
    duplicate.addErrorLabel = jest.fn();
    const findSpy = jest.spyOn(StripeSubscriptionCleanup, 'findOne')
      .mockReturnValue({ session: () => Promise.resolve(null) });
    const createSpy = jest.spyOn(StripeSubscriptionCleanup, 'create')
      .mockRejectedValue(duplicate);

    await expect(ensureStripeSubscriptionCleanup({
      seller: seller._id,
      staleStripeSubscriptionId: 'sub_cleanup_old_aborted_session',
      replacementStripeSubscriptionId: 'sub_cleanup_new_aborted_session',
      stripeCustomerId: 'cus_cleanup_aborted_session',
      reason: 'replacement_activation',
      sourceReference: 'cs_cleanup_aborted_session',
      occurredAt,
    }, { session: { inTransaction: () => true } })).rejects.toBe(duplicate);

    expect(duplicate.addErrorLabel).toHaveBeenCalledWith('TransientTransactionError');
    expect(findSpy).toHaveBeenCalledTimes(1);
    createSpy.mockRestore();
    findSpy.mockRestore();
  });

  test.each([true, 1_777_000_000, '2026-08-24T10:00:00.000Z']) (
    'rejects non-Date cleanup evidence timestamps without coercion (%p)',
    async invalidOccurredAt => {
      const seller = await createSeller(`invalid-date-${String(invalidOccurredAt).replace(/[^A-Za-z0-9]/g, '')}`);
      await expect(ensureStripeSubscriptionCleanup({
        seller: seller._id,
        staleStripeSubscriptionId: `sub_cleanup_old_invalid_date_${seller._id}`,
        replacementStripeSubscriptionId: `sub_cleanup_new_invalid_date_${seller._id}`,
        stripeCustomerId: `cus_cleanup_invalid_date_${seller._id}`,
        reason: 'replacement_activation',
        sourceReference: `cs_cleanup_invalid_date_${seller._id}`,
        occurredAt: invalidOccurredAt,
      })).rejects.toMatchObject({ code: 'STRIPE_SUBSCRIPTION_CLEANUP_INVALID' });
      expect(await StripeSubscriptionCleanup.countDocuments()).toBe(0);
    },
  );

  test('confirms cancellation once and a completed replay never calls Stripe twice', async () => {
    const seller = await createSeller('success');
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_success',
      stripeSubscriptionId: 'sub_cleanup_new_success',
    });
    const cleanup = await createCleanup({ suffix: 'success', seller });
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn().mockResolvedValue({
          id: 'sub_cleanup_old_success',
          customer: 'cus_cleanup_success',
          status: 'canceled',
        }),
      },
    };

    const completed = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-success',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });
    const replay = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-success-replay',
      now: new Date('2027-08-24T10:02:00.000Z'),
    });

    expect(completed).toMatchObject({ status: 'completed', attempts: 1, providerStatus: 'canceled' });
    expect(replay.status).toBe('completed');
    expect(stripeClient.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripeClient.subscriptions.cancel).toHaveBeenCalledWith(
      'sub_cleanup_old_success',
      {},
      { idempotencyKey: `subscription-cleanup:${cleanup.cleanupKey}` },
    );
  });

  test('persists an immediate four-channel admin escalation, then recovers and sends one four-channel resolution', async () => {
    const [seller] = await Promise.all([createSeller('recover'), createAdmin('recover')]);
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_recover',
      stripeSubscriptionId: 'sub_cleanup_new_recover',
    });
    const cleanup = await createCleanup({ suffix: 'recover', seller });
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn()
          .mockRejectedValueOnce(Object.assign(new Error('timeout after request write'), {
            type: 'StripeConnectionError',
            code: 'ECONNRESET',
          }))
          .mockResolvedValueOnce({
            id: 'sub_cleanup_old_recover',
            customer: 'cus_cleanup_recover',
            status: 'canceled',
          }),
      },
    };

    const failed = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-recover-first',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });
    expect(failed).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastErrorCode: 'ECONNRESET',
    });
    expect(failed.manualReview.requiredAt).toBeTruthy();
    expect(failed.manualReview.notificationEnqueuedAt).toBeTruthy();
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
    })).toBe(4);

    await StripeSubscriptionCleanup.updateOne(
      { _id: cleanup._id },
      { $set: { nextAttemptAt: new Date('2027-08-24T10:02:00.000Z') } },
    );
    const [recovered] = await processPendingStripeSubscriptionCleanups({
      stripeClient,
      workerId: 'test-recover-sweep',
      limit: 1,
      now: new Date('2027-08-24T10:02:00.000Z'),
    });

    expect(recovered).toMatchObject({ status: 'completed', attempts: 2 });
    expect(recovered.manualReview.resolvedAt).toBeTruthy();
    expect(recovered.manualReview.resolutionNotificationEnqueuedAt).toBeTruthy();
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_resolved',
    })).toBe(4);

    await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-recover-replay',
      now: new Date('2027-08-24T10:03:00.000Z'),
    });
    expect(stripeClient.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(await NotificationOutbox.countDocuments({ aggregateId: cleanup._id.toString() })).toBe(8);
  });

  test('stops after the bounded attempt count and retains terminal manual review', async () => {
    const [seller] = await Promise.all([createSeller('bounded'), createAdmin('bounded')]);
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_bounded',
      stripeSubscriptionId: 'sub_cleanup_new_bounded',
    });
    const cleanup = await createCleanup({ suffix: 'bounded', seller, maxAttempts: 2 });
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn().mockRejectedValue(Object.assign(new Error('Stripe unavailable'), {
          type: 'StripeAPIError', statusCode: 503,
        })),
      },
    };

    await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-bounded-first',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });
    await StripeSubscriptionCleanup.updateOne(
      { _id: cleanup._id },
      { $set: { nextAttemptAt: new Date('2027-08-24T10:02:00.000Z') } },
    );
    const terminal = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-bounded-second',
      now: new Date('2027-08-24T10:02:00.000Z'),
    });
    const replay = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-bounded-replay',
      now: new Date('2027-08-25T10:00:00.000Z'),
    });

    expect(terminal).toMatchObject({ status: 'manual_review', attempts: 2 });
    expect(replay).toMatchObject({ status: 'manual_review', attempts: 2 });
    expect(stripeClient.subscriptions.cancel).toHaveBeenCalledTimes(2);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
    })).toBe(4);
  });

  test('does not infer cancellation from a response whose provider status is missing', async () => {
    const [seller] = await Promise.all([createSeller('missing_status'), createAdmin('missing_status')]);
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_missing_status',
      stripeSubscriptionId: 'sub_cleanup_new_missing_status',
    });
    const cleanup = await createCleanup({ suffix: 'missing_status', seller });
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn().mockResolvedValue({
          id: 'sub_cleanup_old_missing_status',
          customer: 'cus_cleanup_missing_status',
        }),
      },
    };

    const unresolved = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-missing-status',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });

    expect(unresolved).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastErrorCode: 'STRIPE_CANCELLATION_STATUS_UNCONFIRMED',
    });
    expect(unresolved.completedAt).toBeNull();
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
    })).toBe(4);
  });

  test('does not infer cancellation from resource_missing in a potentially different Stripe account', async () => {
    const [seller] = await Promise.all([createSeller('not_found'), createAdmin('not_found')]);
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_not_found',
      stripeSubscriptionId: 'sub_cleanup_new_not_found',
    });
    const cleanup = await createCleanup({ suffix: 'not_found', seller });
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn().mockRejectedValue(Object.assign(
          new Error('No such subscription.'),
          { statusCode: 404, code: 'resource_missing' },
        )),
      },
    };

    const unresolved = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-not-found',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });

    expect(unresolved).toMatchObject({
      status: 'manual_review',
      attempts: 1,
      lastErrorCode: 'STRIPE_CANCELLATION_TARGET_NOT_FOUND',
    });
    expect(unresolved.completedAt).toBeNull();
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
    })).toBe(4);
  });

  test('sends a previously-undeliverable escalation before its later recovery resolution', async () => {
    const seller = await createSeller('orderedalerts');
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_orderedalerts',
      stripeSubscriptionId: 'sub_cleanup_new_orderedalerts',
    });
    const cleanup = await createCleanup({ suffix: 'orderedalerts', seller });
    const stripeClient = {
      subscriptions: {
        cancel: jest.fn()
          .mockRejectedValueOnce(Object.assign(new Error('temporary provider outage'), { code: 'ECONNRESET' }))
          .mockResolvedValueOnce({
            id: 'sub_cleanup_old_orderedalerts',
            customer: 'cus_cleanup_orderedalerts',
            status: 'canceled',
          }),
      },
    };

    const failed = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-ordered-alert-first',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });
    expect(failed.manualReview.notificationEnqueuedAt).toBeNull();
    expect(failed.manualReview.notificationLastError).toMatch(/administrator/i);

    const admin = await createAdmin('orderedalerts');
    await StripeSubscriptionCleanup.updateOne(
      { _id: cleanup._id },
      { $set: { nextAttemptAt: new Date('2027-08-24T10:02:00.000Z') } },
    );
    const completed = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-ordered-alert-second',
      now: new Date('2027-08-24T10:02:00.000Z'),
    });

    expect(completed.status).toBe('completed');
    expect(completed.manualReview.notificationEnqueuedAt).toBeTruthy();
    expect(completed.manualReview.resolutionNotificationEnqueuedAt).toBeTruthy();
    expect(completed.manualReview.notificationEnqueuedAt.getTime())
      .toBeLessThanOrEqual(completed.manualReview.resolutionNotificationEnqueuedAt.getTime());
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      'recipient.user': admin._id,
      eventType: 'subscription.cleanup_required',
    })).toBe(4);
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      'recipient.user': admin._id,
      eventType: 'subscription.cleanup_resolved',
    })).toBe(4);
  });

  test('never cancels a cleanup target that has become authoritative again', async () => {
    const [seller] = await Promise.all([createSeller('stale'), createAdmin('stale')]);
    await SellerSubscription.create({
      seller: seller._id,
      stripeCustomerId: 'cus_cleanup_stale',
      stripeSubscriptionId: 'sub_cleanup_old_stale',
    });
    const cleanup = await createCleanup({ suffix: 'stale', seller });
    const stripeClient = { subscriptions: { cancel: jest.fn() } };

    const stopped = await processStripeSubscriptionCleanupById(cleanup._id, {
      stripeClient,
      workerId: 'test-stale-authority',
      now: new Date('2027-08-24T10:01:00.000Z'),
    });

    expect(stopped).toMatchObject({
      status: 'manual_review',
      attempts: 1,
      lastErrorCode: 'SUBSCRIPTION_CLEANUP_TARGET_NOW_AUTHORITATIVE',
    });
    expect(stripeClient.subscriptions.cancel).not.toHaveBeenCalled();
    expect(await NotificationOutbox.countDocuments({
      aggregateId: cleanup._id.toString(),
      eventType: 'subscription.cleanup_required',
    })).toBe(4);
  });
});
