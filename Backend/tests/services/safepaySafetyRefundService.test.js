'use strict';
jest.mock('../../services/notificationOutboxService', () => ({ enqueueNotificationEvent: jest.fn(async () => {}) }));
jest.mock('../../models/User', () => ({ find: jest.fn(() => ({ select: () => ({ lean: async () => [{ _id: '6ac0a2b387eee317754b0b53' }] }) })) }));
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payment = require('../../models/SafepayPayment');
const { submit } = require('../../services/safepaySafetyRefundService');
const { enqueueNotificationEvent } = require('../../services/notificationOutboxService');
let replica;
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri()); await Payment.init(); }, 120000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop(); });
beforeEach(async () => { await Payment.deleteMany({}); jest.clearAllMocks(); });
async function fixture(rail = 'card') {
  const id = new mongoose.Types.ObjectId();
  return Payment.create({ environment: 'sandbox', purpose: 'order', reference: `safety:${id}`, requestKey: `safety:${id}`,
    fingerprint: 'a'.repeat(64), amountMinor: 10000, currency: 'PKR', tracker: `track_safety-${id}`,
    paymentRail: rail, providerIntent: rail === 'card' ? 'CYBERSOURCE' : rail === 'raast' ? 'RAAST' : '',
    status: 'refund_pending', appliedAt: null, paidAt: new Date(), capturedMinor: 10000,
    safetyRefund: { requestedAt: new Date(), reasonCode: 'ORDER_STOCK_CHANGED' } });
}
const clientFor = rail => ({ getTracker: jest.fn(async () => ({ intent: rail === 'card' ? 'CYBERSOURCE' : rail === 'raast' ? 'RAAST' : '',
  state: 'TRACKER_ENDED', mode: 'payment', purchase_totals: { quote_amount: { amount: 10000, currency: 'PKR' } } })),
  refundRemainingPayment: jest.fn(async () => {}) });
test.each(['raast', 'unknown'])('%s safety refunds enter support review with no bank mutation or submission marker', async rail => {
  const payment = await fixture(rail), client = clientFor(rail);
  await submit(payment, client); await submit(await Payment.findById(payment._id), client);
  expect(client.refundRemainingPayment).not.toHaveBeenCalled();
  expect(await Payment.findById(payment._id)).toMatchObject({ status: 'manual_review', riskPending: true, refundedMinor: 0,
    safetyRefund: { submitStartedAt: null, outcome: 'failed' } });
  expect(enqueueNotificationEvent).toHaveBeenCalledTimes(1);
  expect(enqueueNotificationEvent.mock.calls[0][0].templates.email.text).toMatch(/No automatic bank refund was submitted/);
});
test('a transient preflight timeout remains retryable without recording a POST intent', async () => {
  const payment = await fixture(), client = clientFor('card');
  client.getTracker.mockRejectedValueOnce(Object.assign(new Error('Read timeout.'), { code: 'SAFEPAY_NETWORK_UNAVAILABLE', statusCode: 503 }));
  await submit(payment, client);
  expect(await Payment.findById(payment._id)).toMatchObject({ status: 'refund_pending', safetyRefund: { submitStartedAt: null, outcome: 'not_started' } });
  expect(client.refundRemainingPayment).not.toHaveBeenCalled(); expect(enqueueNotificationEvent).not.toHaveBeenCalled();
});
test('invalid owned tracker preflight requires review rather than indefinite retry', async () => {
  const payment = await fixture(), client = clientFor('card');
  client.getTracker.mockRejectedValueOnce(Object.assign(new Error('Wrong owner.'), { code: 'SAFEPAY_TRACKER_MISMATCH', statusCode: 409 }));
  await submit(payment, client);
  expect(await Payment.findById(payment._id)).toMatchObject({ status: 'manual_review', lastErrorCode: 'SAFEPAY_TRACKER_MISMATCH', safetyRefund: { submitStartedAt: null } });
  expect(client.refundRemainingPayment).not.toHaveBeenCalled(); expect(enqueueNotificationEvent).toHaveBeenCalledTimes(1);
});
test.each([false, true])('late provider %s response cannot overwrite authoritative confirmed refund evidence', async lostResponse => {
  const payment = await fixture(), client = clientFor('card');
  client.refundRemainingPayment.mockImplementationOnce(async () => {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: 'refunded', providerState: 'TRACKER_REFUNDED', refundedMinor: 10000,
      'safetyRefund.outcome': 'confirmed', lastErrorCode: '' } });
    if (lostResponse) throw Object.assign(new Error('Response lost after capture.'), { outcomeUnknown: true });
  });
  await submit(payment, client);
  expect(await Payment.findById(payment._id)).toMatchObject({ status: 'refunded', refundedMinor: 10000, lastErrorCode: '', safetyRefund: { outcome: 'confirmed' } });
  expect(enqueueNotificationEvent).not.toHaveBeenCalled();
  await submit(await Payment.findById(payment._id), client);
  expect(client.refundRemainingPayment).toHaveBeenCalledTimes(1);
});
test('an uncertain card refund POST is never automatically submitted twice', async () => {
  const payment = await fixture(), client = clientFor('card');
  client.refundRemainingPayment.mockRejectedValueOnce(Object.assign(new Error('Response lost.'), { outcomeUnknown: true }));
  await submit(payment, client); await submit(await Payment.findById(payment._id), client);
  expect(client.refundRemainingPayment).toHaveBeenCalledTimes(1);
  expect(await Payment.findById(payment._id)).toMatchObject({ status: 'refund_pending', safetyRefund: { outcome: 'unknown' } });
  expect(enqueueNotificationEvent).toHaveBeenCalledTimes(1);
});
