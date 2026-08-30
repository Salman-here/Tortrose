'use strict';

const crypto = require('crypto');
const os = require('os');
const { deliverNotificationRecord } = require('./notificationOutboxDeliveryService');
const {
  claimNextNotification,
  markNotificationDelivered,
  markNotificationDeferred,
  markNotificationFailed,
  markNotificationSkipped,
  reapExhaustedNotificationLeases,
} = require('./notificationOutboxService');
const {
  recoverPendingSellerOperationalNotifications,
} = require('./sellerOperationalNotificationService');
const {
  syncOrderConfirmationDeliveryStatus,
} = require('./orderConfirmationDeliveryStatusService');

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_OPERATIONAL_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_OPERATIONAL_RECOVERY_BATCH_SIZE = 25;

const defaultWorkerId = () => (
  `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`.slice(0, 120)
);

const createOperationalRecoveryGate = ({
  recover,
  intervalMs,
  batchSize,
  now = () => Date.now(),
}) => {
  let nextRecoveryAt = 0;
  return async () => {
    const current = now();
    if (current < nextRecoveryAt) return { ran: false, results: [] };
    // Advance the gate before awaiting I/O. A slow scan cannot be started a
    // second time by another tick in this worker instance.
    nextRecoveryAt = current + intervalMs;
    const results = await recover({ limit: batchSize });
    return { ran: true, results: results || [] };
  };
};

async function processNotificationOutboxRecord(record, {
  deliver = deliverNotificationRecord,
  now = () => new Date(),
} = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const leaseToken = record.leaseToken;
  try {
    const result = await deliver(record);
    const completedAt = clock();
    if (result?.outcome === 'deferred') {
      return markNotificationDeferred({
        record,
        leaseToken,
        code: result.code,
        reason: result.reason,
        at: completedAt,
      });
    }
    if (result?.outcome === 'skipped') {
      const marked = await markNotificationSkipped({
        id: record._id,
        leaseToken,
        code: result.code,
        reason: result.reason,
        at: completedAt,
      });
      await syncOrderConfirmationDeliveryStatus(marked).catch(error => {
        console.error('[notification-outbox] failed to sync skipped confirmation delivery:', error.message);
      });
      return marked;
    }
    if (result?.outcome !== 'delivered') {
      const error = new Error('Notification channel returned an invalid delivery outcome.');
      error.code = 'NOTIFICATION_DELIVERY_OUTCOME_INVALID';
      error.retryable = true;
      throw error;
    }
    const marked = await markNotificationDelivered({
      id: record._id,
      leaseToken,
      providerMessageId: result.providerMessageId,
      at: completedAt,
    });
    await syncOrderConfirmationDeliveryStatus(marked).catch(error => {
      console.error('[notification-outbox] failed to sync delivered confirmation:', error.message);
    });
    return marked;
  } catch (error) {
    const marked = await markNotificationFailed({ record, leaseToken, error, at: clock() });
    await syncOrderConfirmationDeliveryStatus(marked).catch(syncError => {
      console.error('[notification-outbox] failed to sync failed confirmation delivery:', syncError.message);
    });
    return marked;
  }
}

async function processNotificationOutboxBatch({
  workerId = defaultWorkerId(),
  batchSize = DEFAULT_BATCH_SIZE,
  leaseMs = DEFAULT_LEASE_MS,
  deliver = deliverNotificationRecord,
  now = () => new Date(),
} = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('Notification outbox batch size must be between 1 and 100.');
  }
  await reapExhaustedNotificationLeases(now());
  const results = [];
  for (let index = 0; index < batchSize; index += 1) {
    const claimed = await claimNextNotification({ workerId, now: now(), leaseMs });
    if (!claimed) break;
    const result = await processNotificationOutboxRecord(claimed, { deliver, now });
    results.push(result);
  }
  return results;
}

let timer = null;
let activeTick = null;
let activeWorkerId = '';

function startNotificationOutboxWorker({
  intervalMs = Number(process.env.NOTIFICATION_OUTBOX_INTERVAL_MS || DEFAULT_INTERVAL_MS),
  batchSize = Number(process.env.NOTIFICATION_OUTBOX_BATCH_SIZE || DEFAULT_BATCH_SIZE),
  leaseMs = Number(process.env.NOTIFICATION_OUTBOX_LEASE_MS || DEFAULT_LEASE_MS),
  workerId = defaultWorkerId(),
  deliver = deliverNotificationRecord,
  recoverOperational = recoverPendingSellerOperationalNotifications,
  recoveryIntervalMs = Number(
    process.env.SELLER_OPERATIONAL_NOTIFICATION_RECOVERY_INTERVAL_MS
      || DEFAULT_OPERATIONAL_RECOVERY_INTERVAL_MS
  ),
  recoveryBatchSize = Number(
    process.env.SELLER_OPERATIONAL_NOTIFICATION_RECOVERY_BATCH_SIZE
      || DEFAULT_OPERATIONAL_RECOVERY_BATCH_SIZE
  ),
} = {}) {
  if (timer) return { started: false, workerId: activeWorkerId };
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 60_000) {
    throw new RangeError('Notification outbox interval must be between 500 and 60000 milliseconds.');
  }
  if (!Number.isSafeInteger(recoveryIntervalMs) || recoveryIntervalMs < 10_000 || recoveryIntervalMs > 3_600_000) {
    throw new RangeError('Seller operational notification recovery interval must be between 10000 and 3600000 milliseconds.');
  }
  if (!Number.isSafeInteger(recoveryBatchSize) || recoveryBatchSize < 1 || recoveryBatchSize > 100) {
    throw new RangeError('Seller operational notification recovery batch size must be between 1 and 100.');
  }

  const recoverOperationalIfDue = createOperationalRecoveryGate({
    recover: recoverOperational,
    intervalMs: recoveryIntervalMs,
    batchSize: recoveryBatchSize,
  });

  const tick = () => {
    if (activeTick) return activeTick;
    activeTick = (async () => {
      try {
        const recovery = await recoverOperationalIfDue();
        if (recovery.ran) {
          const failures = recovery.results.filter(result => result?.recovered === false);
          if (failures.length) {
            console.warn(`[notification-outbox] ${failures.length} seller operational recovery item(s) remain pending`);
          }
        }
      } catch (error) {
        console.error('[notification-outbox] seller operational recovery failed:', error.message);
      }
      return processNotificationOutboxBatch({ workerId, batchSize, leaseMs, deliver });
    })()
      .catch(error => {
        console.error('[notification-outbox] worker tick failed:', error.message);
      })
      .finally(() => {
        activeTick = null;
      });
    return activeTick;
  };

  timer = setInterval(tick, intervalMs);
  activeWorkerId = workerId;
  timer.unref?.();
  setImmediate(tick);
  return { started: true, workerId };
}

async function stopNotificationOutboxWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  if (activeTick) await activeTick;
  activeTick = null;
  activeWorkerId = '';
}

const isNotificationOutboxWorkerRunning = () => Boolean(timer);

module.exports = {
  createOperationalRecoveryGate,
  processNotificationOutboxBatch,
  processNotificationOutboxRecord,
  isNotificationOutboxWorkerRunning,
  startNotificationOutboxWorker,
  stopNotificationOutboxWorker,
};
