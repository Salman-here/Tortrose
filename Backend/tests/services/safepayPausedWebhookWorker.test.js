'use strict';
jest.mock('../../services/safepayPaymentService', () => ({ reconcilePayment: jest.fn() }));
jest.mock('../../services/cancellationRefundService', () => ({ runCancellationRefundWorker: jest.fn(async () => {}) }));
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Event = require('../../models/SafepayWebhookEvent');
const Payment = require('../../models/SafepayPayment');
const payments = require('../../services/safepayPaymentService');
const refunds = require('../../services/cancellationRefundService');
const worker = require('../../services/safepayWebhookWorker');
const previous = { ...process.env };
let replica;
beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replica.getUri()); await Promise.all([Event.init(), Payment.init()]);
}, 60000);
afterAll(async () => { worker.stopSafepayWebhookWorker(); process.env = previous; await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => {
  await Event.deleteMany({}); await Payment.deleteMany({}); jest.clearAllMocks();
  Object.assign(process.env, { SAFEPAY_ENV: 'sandbox', SAFEPAY_WEB_ENABLED: 'false', SAFEPAY_MOBILE_ENABLED: 'false',
    SAFEPAY_SANDBOX_PUBLIC_KEY: 'sec_paused-worker', SAFEPAY_SANDBOX_SECRET_KEY: 'private-paused-worker-secret',
    SAFEPAY_SANDBOX_WEBHOOK_SECRET: 'private-paused-worker-webhook', SAFEPAY_SANDBOX_WEBHOOK_SCHEME: 'sha512-raw' });
  payments.reconcilePayment.mockResolvedValue({ status: 'paid', lastReconciledAt: new Date() });
});
async function fixture(environment = 'sandbox') {
  const payment = await Payment.create({ environment, user: new mongoose.Types.ObjectId(), purpose: 'wallet_top_up',
    reference: 'wallet:paused-worker-fixture', requestKey: 'paused-worker-fixture-key', fingerprint: 'a'.repeat(64),
    currency: 'USD', amountMinor: 200, status: 'ready', tracker: `track_paused-worker-${environment}`,
    nextReconcileAt: new Date(Date.now() + 86400000) });
  const event = await Event.create({ environment, eventId: `evt_paused-worker-${environment}`, type: 'payment.succeeded',
    fingerprint: 'b'.repeat(64), payload: { data: { tracker: payment.tracker } } });
  return { payment, event };
}
test('both paused surfaces still drain durable webhook and cancellation refund queues, without crossing environments', async () => {
  const own = await fixture(); const foreign = await fixture('production');
  await worker.runSafepayWebhookWorker(); await worker.runSafepayWebhookWorker();
  expect((await Event.findById(own.event._id)).status).toBe('processed');
  expect((await Event.findById(foreign.event._id)).status).toBe('pending');
  expect(payments.reconcilePayment).toHaveBeenCalledTimes(1);
  expect(String(payments.reconcilePayment.mock.calls[0][0])).toBe(String(own.payment._id));
  expect(refunds.runCancellationRefundWorker).toHaveBeenCalledTimes(2);
});
test('a paused worker retains transient failure for recovery and never acknowledges lost reconciliation as completed', async () => {
  const f = await fixture();
  payments.reconcilePayment.mockRejectedValueOnce(Object.assign(new Error('Provider temporarily unavailable'), { code: 'SAFEPAY_REQUEST_UNCERTAIN' }));
  await worker.runSafepayWebhookWorker();
  let event = await Event.findById(f.event._id);
  expect(event.status).toBe('pending'); expect(event.processedAt).toBeNull();
  expect(event.lastErrorCode).toBe('SAFEPAY_REQUEST_UNCERTAIN');
  await Event.updateOne({ _id: event._id }, { $set: { nextAttemptAt: new Date(0) } });
  await worker.runSafepayWebhookWorker();
  event = await Event.findById(event._id);
  expect(event.status).toBe('processed'); expect(event.attempts).toBe(2);
});
test('missing selected-environment webhook credentials stop financial work without falling back to Sandbox', async () => {
  const f = await fixture(); process.env.SAFEPAY_ENV = 'production';
  delete process.env.SAFEPAY_PRODUCTION_PUBLIC_KEY;
  await worker.runSafepayWebhookWorker();
  expect((await Event.findById(f.event._id)).status).toBe('pending');
  expect(payments.reconcilePayment).not.toHaveBeenCalled();
  expect(refunds.runCancellationRefundWorker).not.toHaveBeenCalled();
});
