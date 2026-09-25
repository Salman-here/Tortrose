'use strict';
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Event = require('../models/SafepayWebhookEvent');
const Payment = require('../models/SafepayPayment');
const { readSafepayConfig } = require('../config/safepay');
const { reconcilePayment } = require('./safepayPaymentService');
let timer = null;
let running = false;

async function processEvent(event) {
  if (event.type.startsWith('subscription.')) {
    // Rozare uses merchant-managed subscription/MIT trackers, not Safepay's
    // separate shopper-account hosted-plan product. Its charges are bound by
    // payment.succeeded tracker ids. Unowned native-plan events grant nothing.
    return 'ignored';
  }
  const data = event.payload.data;
  const tracker = typeof data.tracker === 'string' ? data.tracker : data.tracker?.token;
  if (!/^track_[a-zA-Z0-9-]{8,100}$/.test(tracker || '')) return 'ignored';
  let payment = await Payment.findOne({ environment: event.environment, tracker });
  if (!payment) {
    const metadata = data.metadata?.data || data.metadata;
    const reference = typeof metadata?.order_id === 'string' ? metadata.order_id : metadata?.order_id?.value;
    if (reference) payment = await Payment.findOne({ environment: event.environment, reference });
  }
  if (!payment) {
    // Early callbacks can beat a lost tracker-create response. A short grace
    // allows the reference recovery job to attach it without replaying create.
    if (Date.now() - new Date(event.createdAt).getTime() < 10 * 60000) {
      throw Object.assign(new Error('Payment correlation is pending.'), { code: 'SAFEPAY_EVENT_CORRELATION_PENDING' });
    }
    return 'ignored';
  }
  const reconciled = await reconcilePayment(payment._id);
  if (!reconciled.lastReconciledAt || (reconciled.lastErrorCode && !['manual_review', 'failed', 'cancelled', 'refunded'].includes(reconciled.status))) {
    throw Object.assign(new Error('Payment reconciliation is pending.'), { code: 'SAFEPAY_EVENT_RECONCILE_PENDING' });
  }
  return reconciled.riskPending || reconciled.status === 'manual_review' ? 'manual_review' : 'processed';
}

async function runSafepayWebhookWorker() {
  if (running || mongoose.connection.readyState !== 1 || process.env.SAFEPAY_MOBILE_ENABLED !== 'true') return;
  running = true;
  try {
    const config = readSafepayConfig(process.env, { requireWebhook: true });
    await Promise.all([Event.init(), Payment.init()]);
    for (let count = 0; count < 20; count++) {
      const leaseToken = crypto.randomUUID();
      const at = new Date();
      const event = await Event.findOneAndUpdate({ environment: config.environment,
        $or: [{ status: 'pending', nextAttemptAt: { $lte: at } }, { status: 'processing', leaseUntil: { $lt: at } }] },
      { $set: { status: 'processing', leaseToken, leaseUntil: new Date(at.getTime() + 120000) }, $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: 1 } }).select('+payload');
      if (!event) break;
      try {
        const status = await processEvent(event);
        await Event.updateOne({ _id: event._id, leaseToken }, { $set: { status, processedAt: new Date(), leaseUntil: null, leaseToken: '', lastErrorCode: '' } });
      } catch (error) {
        await Event.updateOne({ _id: event._id, leaseToken }, { $set: { status: 'pending', leaseUntil: null, leaseToken: '',
          lastErrorCode: error.code || 'SAFEPAY_EVENT_FAILED', nextAttemptAt: new Date(Date.now() + Math.min(600000, 10000 * 2 ** Math.min(event.attempts, 6))) } });
      }
    }
    const pending = await Payment.find({ environment: config.environment, status: { $in: ['creating', 'ready', 'cancel_requested', 'refund_pending'] },
      nextReconcileAt: { $lte: new Date() } }).sort({ nextReconcileAt: 1 }).limit(10).select('_id');
    for (const payment of pending) {
      try { await reconcilePayment(payment._id); } catch (_) { /* Durable retry state is recorded by the reconciler. */ }
    }
  } catch (error) {
    console.error('[safepay-worker] deferred:', error.code || 'SAFEPAY_WORKER_UNAVAILABLE');
  } finally { running = false; }
}
function startSafepayWebhookWorker() {
  if (timer || process.env.SAFEPAY_MOBILE_ENABLED !== 'true') return;
  timer = setInterval(runSafepayWebhookWorker, 10000);
  timer.unref?.();
  runSafepayWebhookWorker().catch(() => {});
}
function stopSafepayWebhookWorker() { if (timer) clearInterval(timer); timer = null; }
module.exports = { processEvent, runSafepayWebhookWorker, startSafepayWebhookWorker, stopSafepayWebhookWorker };
